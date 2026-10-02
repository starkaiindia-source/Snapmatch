/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/job-service.js
   ----------------------------------------------------------------------------
   Import jobs: create, discover, process, pause, resume, retry, cancel.

   ----------------------------------------------------------------------------
   THE PIPELINE, ONE CONTENT ITEM AT A TIME

     Instagram page
       -> create job                      (this file: createJob)
       -> discover content                 one Graph API page per step, cursor saved
       -> queue content                    items/{mediaId}, in discovery order
       -> change detection                 BEFORE any paid call: same caption, same
                                           media, same processing version = skip
       -> OCR / key frames / transcript    media-processor.js, cached by content hash
       -> extraction                       extractor.js — rules, then AI if needed
       -> model matching                   taxonomy-service.js — the catalogue decides
       -> candidates                       candidate-builder.js
       -> deduplication + conflicts        against earlier candidates and production
       -> review queue                     compatibilityCandidates, status pending

   ----------------------------------------------------------------------------
   BACKGROUND, RESUMABLE, AND ONLY EVER ONE WORKER AT A TIME

   A Vercel function lives seconds, so a job is advanced in TICKS: each tick
   takes a lease on the job, works until its time budget is spent, saves its
   position and lets go. The admin page drives ticks while it is open (that
   is the live progress), and scripts/instagram-worker.js drives the same
   ticks from any machine with the service account, for large imports.

   Nothing is held in memory between ticks. The discovery cursor and every
   item's status are in Firestore, so a crash at item 87 of 148 resumes at
   item 88: done items are never redone, an item left mid-processing goes
   back to the queue, and a failed item is retried up to maxAttempts.
   ========================================================================== */
'use strict';

const C = require('../../_schema/collections');
const S = require('../../_schema/instagram');
const fsx = require('./firestore');
const configMod = require('./config');
const { createGraphClient, GraphError } = require('./graph-client');
const { createMediaProcessor } = require('./media-processor');
const extractor = require('./extractor');
const { buildCandidates, slimMatch } = require('./candidate-builder');
const production = require('./production');
const relevance = require('./relevance');
const validation = require('./validation');
const { estimateCost } = require('./ai-providers');
const groupProposals = require('./group-proposals');
const taxonomy = require('../taxonomy-service');
const aiService = require('../ai-service');
const roles = require('../../_schema/roles');
const categoryService = require('../compat/category-service');

const COUNT_KEYS = [
  'postsFound', 'imagesFound', 'carouselsFound', 'videosFound',
  'processed', 'unchanged', 'failed',
  /* how each processed item was classified: see relevance.js */
  'relevant', 'ignored', 'insufficient',
  /* the cost funnel: what each stage let through */
  'cheapRejected', 'screened', 'screenRejected', 'deepAnalysed', 'videosUnderstood', 'videoUnavailable',
  'validated', 'validationFailed', 'aiDeferred', 'extracted',
  'captionsProcessed', 'imagesOcrd', 'imagesUnderstood', 'framesProcessed', 'transcripts',
  'groupProposals', 'groupUpdates', 'newGroups',
  'modelReferences', 'matched', 'unmatched', 'ambiguous',
  'relationships', 'readyForApproval', 'needsReview', 'pendingReview',
  'duplicates', 'conflicts', 'rejected', 'approved', 'appliedToProduction',
  /* the free scan: what the page holds, before anything is spent */
  'scanLikely', 'scanCheck', 'scanIrrelevant', 'scanSeen',
  /* Instagram Intelligence: what was applied without a person approving it */
  'autoApplied', 'autoGroupsUpdated', 'autoModelsAdded', 'autoGroupsCreated', 'autoGroupsMerged', 'autoMergesQueued',
  'autoCategoriesCreated', 'autoNoChange', 'autoAttention', 'autoSkippedEntries'
];
const USAGE_KEYS = [
  'graphCalls', 'ocrCalls', 'aiCalls', 'videoCalls', 'cacheHits',
  /* which model, how many tokens, and what that is estimated to have cost */
  'screenCalls', 'geminiCalls', 'claudeCalls',
  'geminiInputTokens', 'geminiOutputTokens', 'claudeInputTokens', 'claudeOutputTokens',
  'videoSeconds', 'costMicroUsd', 'costUnknownCalls'
];
/* What ONE sync has spent of its AI budget. Reset when a person resumes. */
const BUDGET_KEYS = ['aiItems', 'geminiCalls', 'claudeCalls', 'videoSeconds'];

function zero(keys) { const o = {}; keys.forEach(k => { o[k] = 0; }); return o; }

const jobs = () => fsx.db().collection(C.INSTAGRAM_IMPORT_JOBS);
const items = jobId => jobs().doc(jobId).collection(C.INSTAGRAM_JOB_ITEMS);

/* ================================================================= create */

/**
 * @returns {Promise<{ok:true, job:object}|{ok:false, status:number, error:string}>}
 */
async function createJob({ admin, profileUrl, postUrl, maxItems, mode, manualText, force, scanFirst, now, deps = {} }) {
  const cfg = deps.cfg || configMod.load();
  const db = fsx.db();
  mode = mode === 'manual' ? 'manual' : 'api';

  const profile = profileUrl ? S.parseInstagramUrl(profileUrl) : null;
  const post = postUrl ? S.parseInstagramUrl(postUrl) : null;
  if (profile && !profile.ok) return { ok: false, status: 400, error: 'Profile URL: ' + profile.reason };
  if (post && !post.ok) return { ok: false, status: 400, error: 'Post URL: ' + post.reason };
  if (profile && profile.kind !== 'profile') {
    if (!post) return { ok: false, status: 400, error: 'That is a post URL. Put it in the post field and give the profile URL too, or use a profile URL.' };
    return { ok: false, status: 400, error: 'The profile URL field holds a post URL.' };
  }
  if (post && post.kind !== 'post') return { ok: false, status: 400, error: 'The post URL field holds a profile URL.' };

  const username = (profile && profile.username) || (post && post.username) || null;
  if (!username) {
    return { ok: false, status: 400, error: 'A profile URL is needed: the Instagram API finds a post by listing its account\'s media.' };
  }
  if (post && post.username && post.username !== username) {
    return { ok: false, status: 400, error: `The post belongs to @${post.username}, not @${username}.` };
  }

  const text = typeof manualText === 'string' ? manualText.trim().slice(0, 5000) : '';
  if (mode === 'manual' && text.length < 3) {
    return { ok: false, status: 400, error: 'Manual entry needs the post text (caption or the text shown in its images).' };
  }

  const sourceKey = S.sourceKeyFor(username);
  const sourceRef = db.collection(C.INSTAGRAM_SOURCES).doc(sourceKey);
  const sourceSnap = await sourceRef.get();
  const source = sourceSnap.exists ? sourceSnap.data() : null;
  if (source && source.ignored) {
    return { ok: false, status: 409, error: `@${username} is marked "ignore" (${source.ignoreReason || 'no reason given'}). Un-ignore it under Instagram Sources first.` };
  }

  const graphReady = configMod.graphConfigured(cfg);
  const jobRef = jobs().doc();
  const limit = Math.min(cfg.maxItemsPerJob, Math.max(1, Math.round(Number(maxItems) || cfg.maxItemsPerJob)));

  const job = {
    jobId: jobRef.id,
    sourceKey, username,
    profileUrl: `https://www.instagram.com/${username}/`,
    postUrl: post ? post.canonicalUrl : null,
    postShortcode: post ? post.shortcode : null,
    mode,
    collectionMethod: mode === 'manual' ? 'manual_admin_entry' : null,
    status: 'queued',
    statusReason: null,
    maxItems: post ? 1 : limit,
    processingVersion: S.PROCESSING_VERSION,
    discovery: { cursor: null, pages: 0, found: 0, done: mode === 'manual', attempts: 0 },
    counts: zero(COUNT_KEYS),
    usage: zero(USAGE_KEYS),
    budget: zero(BUDGET_KEYS),
    /* "Analyse anyway": a person overrides the cheap filter for ONE post.
       Never for a whole page — that would be the unlimited spend the filter
       exists to prevent. */
    forceDeep: !!(force && post),
    /* Scan first: list the page and score every post for free, then WAIT for
       Continue before anything is read by a model. Only for a whole page —
       one post, or text a person typed, has nothing to summarise. */
    scanFirst: !!(scanFirst && !post && mode === 'api'),
    /* Instagram Intelligence. On only when the person starting the scan may
       approve compatibility changes themselves — decided here, on the server,
       from their role; the request cannot ask for it. */
    autoApply: !!(cfg.autoApply && roles.can(admin.role, roles.PERMISSIONS.COMPAT_APPROVE)),
    errors: [],
    lease: { owner: null, until: 0 },
    resumeAfter: null,
    createdBy: admin.uid, createdByEmail: admin.email || null,
    createdAt: now, updatedAt: now, startedAt: null, finishedAt: null, lastTickAt: null,
    cancelledBy: null
  };

  /* Honest failure up front: without credentials NOTHING can be collected,
     and the job says so rather than running and "finding" zero posts. */
  if (mode === 'api' && !graphReady) {
    job.status = 'unable_to_collect';
    job.statusReason = 'The Instagram Graph API is not configured (' +
      configMod.status(cfg).graph.missing.join(', ') + '). Nothing was collected. ' +
      'Configure the official API, or use manual entry for content you have read yourself.';
    job.finishedAt = now;
  }

  const batch = db.batch();
  batch.set(jobRef, job);
  batch.set(sourceRef, Object.assign({
    sourceKey, username,
    profileUrl: job.profileUrl,
    updatedAt: now,
    lastImportJobId: job.jobId,
    lastImportAt: now
  }, source ? {} : {
    createdAt: now, createdBy: admin.uid,
    displayName: null, accountType: 'unknown', followersCount: null, mediaCount: null,
    accessStatus: 'unknown', accessReason: null,
    ignored: false, ignoreReason: null, ignoredBy: null, ignoredAt: null,
    /* Metadata only. Never an input to confidence: see the review service. */
    reputation: { approved: 0, rejected: 0, updatedAt: null }
  }, job.status === 'unable_to_collect' ? { accessStatus: 'unable_to_collect', accessReason: job.statusReason } : {}), { merge: true });

  if (mode === 'manual') {
    const hash = S.sha256((post ? post.canonicalUrl : job.profileUrl) + '\n' + text);
    const contentKey = S.contentKeyFor({ manualHash: hash });
    batch.set(items(job.jobId).doc('manual'), {
      itemKey: 'manual', order: 0, status: 'queued', attempts: 0,
      mediaId: null, contentKey, manual: true,
      permalink: post ? post.canonicalUrl : job.profileUrl, shortcode: post ? post.shortcode : null,
      contentType: 'text', mediaType: null, productType: null,
      caption: text, captionHash: S.captionHash(text),
      signature: S.contentSignature({ caption: text, mediaType: 'TEXT', mediaIds: [] }),
      publishedAt: null, mediaUrl: null, thumbnailUrl: null, mediaUrlOmitted: false, children: [],
      enteredBy: admin.uid, createdAt: now, updatedAt: now
    });
    job.counts.postsFound = 1;
    job.discovery.found = 1;
    batch.set(jobRef, { counts: job.counts, discovery: job.discovery }, { merge: true });
  }

  await batch.commit();
  return { ok: true, job };
}

/* =================================================================== tick */

/**
 * Advances a job until its time budget is spent.
 *
 * @param {object} args
 * @param {string} args.jobId
 * @param {string} args.workerId   who holds the lease ("admin:<uid>", "worker:<host>")
 * @param {object} [args.deps]     { cfg, graph, media, ai, clock, maxSteps, fetchImpl } — tests inject
 * @returns {Promise<{ok:boolean, busy?:boolean, job:object|null, steps:number, error?:string}>}
 */
async function tick({ jobId, workerId, deps = {} }) {
  const clock = deps.clock || Date.now;
  const cfg = deps.cfg || configMod.load();
  const db = fsx.db();
  const jobRef = jobs().doc(jobId);
  const started = clock();

  /* ---- the lease: one worker per job, whatever the number of open tabs ---- */
  const leased = await db.runTransaction(async tx => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) return { ok: false, error: 'no such job' };
    const job = snap.data();
    if (['queued', 'discovering', 'processing'].indexOf(job.status) < 0) return { ok: false, job, error: 'not running' };
    if (job.lease && job.lease.owner && job.lease.owner !== workerId && job.lease.until > started) {
      return { ok: false, busy: true, job };
    }
    const patch = {
      lease: { owner: workerId, until: started + cfg.leaseMs },
      status: job.status === 'queued' ? (job.discovery && job.discovery.done ? 'processing' : 'discovering') : job.status,
      startedAt: job.startedAt || started, lastTickAt: started, updatedAt: started
    };
    tx.update(jobRef, patch);
    return { ok: true, job: Object.assign({}, job, patch) };
  });
  if (!leased.ok) return { ok: false, busy: !!leased.busy, job: leased.job || null, steps: 0, error: leased.error };

  const job = leased.job;
  /* the categories created at run time, for this instance's matcher */
  try { await categoryService.load(); } catch (err) { console.warn('[instagram] run-time categories not loaded', err && err.message); }
  const usage = createUsage(cfg, clock(), job);
  await usage.load();
  const cache = createCache();
  const graph = deps.graph || createGraphClient(Object.assign({}, cfg.graph, {
    fetchImpl: deps.fetchImpl, onCall: kind => usage.record(kind),
    /* remembered across ticks: Meta is asked for reel covers once per job */
    coverField: !(job.discovery && job.discovery.coverField === false)
  }));
  const ai = deps.ai || aiService;
  const media = deps.media || createMediaProcessor({ cfg, ai, fetchImpl: deps.fetchImpl, cache, usage, providers: deps.providers });
  const env = { cfg, clock, graph, media, ai, cache, usage, prodCache: new Map(), matchCache: new Map(), aliasCache: new Map() };
  /* what this page's earlier posts turned out to be — one read per tick, and
     only ever a one-point nudge to the cheap filter */
  try {
    const src = await db.collection(C.INSTAGRAM_SOURCES).doc(job.sourceKey).get();
    env.sourceStats = src.exists ? src.data().stats || null : null;
  } catch { env.sourceStats = null; }

  let steps = 0;
  const maxSteps = deps.maxSteps || Infinity;
  const errors = (job.errors || []).slice(-50);
  let stop = null;

  try {
    while (clock() - started < cfg.tickBudgetMs && steps < maxSteps && !stop) {
      if (!job.discovery.done) {
        stop = await discoverStep(job, env, errors);
        steps++;
        continue;
      }
      const next = await items(job.jobId).where('status', '==', 'queued').orderBy('order', 'asc').limit(1).get();
      if (next.empty) {
        /* items set aside because this sync's AI budget ran out */
        const waiting = await items(job.jobId).where('status', '==', 'deferred_ai').limit(200).get();
        if (!waiting.empty) {
          job.status = 'budget_reached';
          job.statusReason = 'AI processing budget reached — ' + waiting.size + (waiting.size >= 200 ? '+' : '') +
            ' remaining item(s) queued. Everything else was classified. Resume the job to spend another budget on them.';
          stop = 'budget';
          break;
        }
        const failed = await items(job.jobId).where('status', '==', 'failed').limit(1).get();
        job.status = failed.empty ? 'completed' : 'completed_with_errors';
        job.statusReason = failed.empty ? null : 'Some items failed after every retry. Use "Retry failed" or "View errors".';
        job.finishedAt = clock();
        await db.collection(C.INSTAGRAM_SOURCES).doc(job.sourceKey).set({
          lastScanAt: job.finishedAt, lastScanJobId: job.jobId, updatedAt: job.finishedAt,
          lastScanStatus: job.status
        }, { merge: true });
        if (failed.empty) {
          await db.collection(C.INSTAGRAM_SOURCES).doc(job.sourceKey).set({ lastSuccessfulScanAt: job.finishedAt }, { merge: true });
        }
        stop = 'finished';
        break;
      }
      job.status = 'processing';
      const item = next.docs[0].data();
      const outcome = await processItemSafely(job, item, env, errors);
      steps++;
      if (outcome === 'deferred') {
        job.status = 'quota_exhausted';
        job.statusReason = /rate limit/i.test(env.lastDeferral || '')
          ? env.lastDeferral + ' Resume the job later.'
          : 'A daily OCR / AI / video cap was reached. Resume the job tomorrow, or raise the cap.';
        stop = 'quota';
      }
    }
  } finally {
    await usage.flush(jobRef);
    const now = clock();
    await jobRef.set({
      status: job.status,
      statusReason: job.statusReason || null,
      discovery: job.discovery,
      collectionMethod: job.collectionMethod || null,
      resumeAfter: job.resumeAfter || null,
      finishedAt: job.finishedAt || null,
      errors: errors.slice(-50),
      lease: { owner: null, until: 0 },
      lastTickAt: now, updatedAt: now
    }, { merge: true });
  }

  const fresh = await jobRef.get();
  return { ok: true, job: fresh.data(), steps };
}

/* ============================================================== discovery */

async function discoverStep(job, env, errors) {
  const { cfg, graph, usage, clock } = env;
  const db = fsx.db();
  const FV = fsx.FieldValue();
  const sourceRef = db.collection(C.INSTAGRAM_SOURCES).doc(job.sourceKey);
  const now = clock();

  if (!usage.allow('graph')) {
    job.status = 'quota_exhausted';
    job.statusReason = 'The daily Instagram API call cap was reached. Resume later.';
    return 'quota';
  }

  try {
    if (!job.collectionMethod) {
      const own = await graph.ownProfile();
      job.collectionMethod = own.username && own.username === job.username ? 'graph_own_account' : 'graph_business_discovery';
      if (job.collectionMethod === 'graph_own_account') {
        await sourceRef.set({
          displayName: own.name, accountType: 'professional', followersCount: own.followersCount,
          mediaCount: own.mediaCount, accessStatus: 'collectable', accessReason: 'the business\'s own account', updatedAt: now
        }, { merge: true });
      }
    }

    const page = job.collectionMethod === 'graph_own_account'
      ? await graph.ownMediaPage({ after: job.discovery.cursor, limit: cfg.pageSize })
      : await graph.discoverPage(job.username, { after: job.discovery.cursor, limit: cfg.pageSize });

    if (page.profile) {
      await sourceRef.set({
        displayName: page.profile.name, accountType: 'professional',
        followersCount: page.profile.followersCount, mediaCount: page.profile.mediaCount,
        accessStatus: 'collectable', accessReason: 'public professional account (Business Discovery)',
        lastCollectedAt: now, updatedAt: now
      }, { merge: true });
    }

    const batch = db.batch();
    const inc = zero(['postsFound', 'imagesFound', 'carouselsFound', 'videosFound', 'scanLikely', 'scanCheck', 'scanIrrelevant', 'scanSeen']);
    const wanted = [];
    for (const m of page.media) {
      if (job.discovery.found + wanted.length >= job.maxItems) break;
      if (job.postShortcode && m.shortcode !== job.postShortcode) continue;
      wanted.push(m);
    }
    /* What each post looks like before anything is spent on it: the cheap
       filter's score, and whether this exact content was already processed. */
    const seen = new Map();
    if (job.scanFirst) {
      const priors = await Promise.all(wanted.map(m => db.collection(C.INSTAGRAM_CONTENT).doc(S.contentKeyFor({ mediaId: m.mediaId })).get()));
      wanted.forEach((m, i) => seen.set(m.mediaId, priors[i].exists ? priors[i].data() : null));
    }
    for (const m of wanted) {
      const mediaIds = [m.mediaId].concat(m.children.map(c => c.mediaId));
      const signature = S.contentSignature({ caption: m.caption, mediaType: m.mediaType, mediaIds });
      const scored = relevance.scoreCandidate({ caption: m.caption, contentType: m.contentType, sourceStats: env.sourceStats });
      const prior = seen.get(m.mediaId);
      const unchanged = !!(prior && prior.signature === signature && prior.processingVersion === S.PROCESSING_VERSION && prior.latestVersion);
      const scanClass = unchanged ? 'already_processed' : scored.tier === 'HIGH' ? 'likely_relevant' : scored.tier === 'REJECT' ? 'likely_irrelevant' : 'needs_visual_check';
      if (job.scanFirst) inc[{ already_processed: 'scanSeen', likely_relevant: 'scanLikely', likely_irrelevant: 'scanIrrelevant', needs_visual_check: 'scanCheck' }[scanClass]]++;
      batch.set(items(job.jobId).doc(m.mediaId), {
        scan: { class: scanClass, tier: scored.tier, score: scored.score,
                why: (scored.reasons || []).slice(0, 4).map(r => r.signal + (r.terms && r.terms.length ? ' (' + r.terms.slice(0, 3).join(', ') + ')' : '')),
                previous: unchanged ? prior.relevance || null : null },
        itemKey: m.mediaId, order: job.discovery.found, status: 'queued', attempts: 0,
        mediaId: m.mediaId, contentKey: S.contentKeyFor({ mediaId: m.mediaId }), manual: false,
        permalink: m.permalink, shortcode: m.shortcode,
        contentType: m.contentType, mediaType: m.mediaType, productType: m.productType,
        caption: String(m.caption || '').slice(0, 5000), captionHash: S.captionHash(m.caption),
        signature,
        publishedAt: m.timestamp, mediaUrl: m.mediaUrl, thumbnailUrl: m.thumbnailUrl,
        mediaUrlOmitted: !!m.mediaUrlOmitted, children: m.children.slice(0, 20),
        createdAt: now, updatedAt: now
      }, { merge: false });
      job.discovery.found++;
      inc.postsFound++;
      if (m.contentType === 'carousel') inc.carouselsFound++;
      else if (m.contentType === 'video' || m.contentType === 'reel') inc.videosFound++;
      else inc.imagesFound++;
    }
    job.discovery.pages++;
    job.discovery.cursor = page.nextCursor;
    job.discovery.attempts = 0;
    if (typeof graph.coverFieldSupported === 'function') job.discovery.coverField = graph.coverFieldSupported();
    const exhausted = !page.nextCursor || job.discovery.pages >= cfg.maxDiscoveryPages;
    if (job.discovery.found >= job.maxItems || exhausted || (job.postShortcode && job.discovery.found > 0)) {
      job.discovery.done = true;
      job.status = 'processing';
      if (job.scanFirst && !job.continuedAt && job.discovery.found > 0) {
        /* nothing has been read by a model yet, and nothing will be until a
           person presses Continue */
        job.status = 'scanned';
        job.statusReason = 'The page has been listed and every post scored from its caption. Nothing has been spent. Continue to start the compatibility analysis.';
      }
      if (job.postShortcode && job.discovery.found === 0) {
        job.status = 'unable_to_collect';
        job.statusReason = `The post was not among the ${job.discovery.pages * cfg.pageSize} most recent posts the API returned for @${job.username}. Nothing was collected for it.`;
        job.finishedAt = now;
      }
    }
    const patch = { updatedAt: now };
    Object.keys(inc).forEach(k => { if (inc[k]) patch['counts.' + k] = FV.increment(inc[k]); });
    batch.update(jobs().doc(job.jobId), patch);
    await batch.commit();
    return job.status === 'unable_to_collect' ? 'unable' : job.status === 'scanned' ? 'scanned' : null;
  } catch (err) {
    return discoveryFailed(job, err, env, errors, sourceRef);
  }
}

async function discoveryFailed(job, err, env, errors, sourceRef) {
  const now = env.clock();
  const kind = err instanceof GraphError ? err.kind : 'internal';
  errors.push({ at: now, itemKey: null, stage: 'discovery', kind, message: String(err && err.message).slice(0, 300) });

  if (kind === 'rate_limited') {
    job.status = 'rate_limited';
    job.resumeAfter = now + (err.retryAfterMs || 3600000);
    job.statusReason = 'Instagram\'s rate limit was reached. The job is paused, not worked around; resume after ' +
      new Date(job.resumeAfter).toISOString() + '.';
    return 'rate_limited';
  }
  if (['unconfigured', 'not_collectable', 'permission_denied'].indexOf(kind) > -1) {
    /* Content that cannot be reached is reported, not approximated. Items
       already discovered are still processed. */
    if (job.discovery.found === 0) {
      job.status = 'unable_to_collect';
      job.finishedAt = now;
    } else {
      job.discovery.done = true;
      job.status = 'processing';
    }
    job.statusReason = 'Unable to collect: ' + err.message;
    await sourceRef.set({ accessStatus: 'unable_to_collect', accessReason: String(err.message).slice(0, 400), updatedAt: now }, { merge: true });
    return job.status === 'unable_to_collect' ? 'unable' : null;
  }
  if (kind === 'token_invalid') {
    job.status = 'paused';
    job.statusReason = err.message + ' Renew INSTAGRAM_GRAPH_ACCESS_TOKEN, then resume.';
    return 'paused';
  }
  job.discovery.attempts = (job.discovery.attempts || 0) + 1;
  if (job.discovery.attempts >= env.cfg.maxAttempts) {
    job.status = 'failed';
    job.statusReason = 'Discovery failed ' + job.discovery.attempts + ' times: ' + err.message + ' Resume to try again from the same page.';
    return 'failed';
  }
  return null;
}

/* ============================================================ processing */

async function processItemSafely(job, item, env, errors) {
  const itemRef = items(job.jobId).doc(item.itemKey);
  const FV = fsx.FieldValue();
  try {
    const result = await processItem(job, item, env);
    if (result.outcome === 'deferred') env.lastDeferral = result.reason || null;
    return result.outcome;
  } catch (err) {
    const now = env.clock();
    const attempts = (item.attempts || 0) + 1;
    const final = attempts >= env.cfg.maxAttempts;
    console.error('[instagram] item failed', { jobId: job.jobId, item: item.itemKey, message: err && err.message });
    errors.push({ at: now, itemKey: item.itemKey, stage: 'processing', kind: 'error', message: String(err && err.message).slice(0, 300) });
    await itemRef.set({
      status: final ? 'failed' : 'queued', attempts,
      lastError: String(err && err.message).slice(0, 500), updatedAt: now
    }, { merge: true });
    if (final) {
      await jobs().doc(job.jobId).update({ 'counts.failed': FV.increment(1), updatedAt: now });
      await fsx.db().collection(C.INSTAGRAM_SOURCES).doc(job.sourceKey)
        .set({ stats: { errors: FV.increment(1) }, updatedAt: now }, { merge: true });
    }
    return final ? 'failed' : 'retry';
  }
}

/**
 * One content item, end to end. Throws on an unexpected failure (the caller
 * counts the attempt); returns 'deferred' when a daily cap stopped it.
 *
 *   stage 0  change detection: identical content is not read again     (free)
 *   stage 1  the cheap filter: a score from the caption, the type and
 *            the page's history — HIGH / MEDIUM / LOW / REJECT          (free)
 *   stage 2  OCR, when a provider exists                               (cheap)
 *   stage 3  a visual screen by the small model, for what neither the
 *            caption nor OCR settled                                   (cheap)
 *   stage 4  the deep read — image, or the video itself in two passes  (paid)
 *   stage 5  classification, extraction, matching, group comparison,
 *            and a second opinion only where matching left doubt
 */
async function processItem(job, item, env) {
  const { cfg, media, clock } = env;
  const db = fsx.db();
  const FV = fsx.FieldValue();
  const now = clock();
  const itemRef = items(job.jobId).doc(item.itemKey);
  const jobRef = jobs().doc(job.jobId);

  await itemRef.set({ status: 'processing', attempts: (item.attempts || 0) + 1, updatedAt: now }, { merge: true });

  /* ---- change detection, before anything that costs money ----
     "Identical" includes HOW it was read: content whose media could not be
     read last time is read again once a provider that can read it exists. */
  const contentRef = db.collection(C.INSTAGRAM_CONTENT).doc(item.contentKey);
  const priorSnap = await contentRef.get();
  const prior = priorSnap.exists ? priorSnap.data() : null;
  const providers = providerFingerprint(cfg);
  if (!job.forceDeep && prior && prior.signature === item.signature && prior.processingVersion === S.PROCESSING_VERSION && prior.latestVersion &&
      (prior.mediaComplete || prior.providers === providers)) {
    await itemRef.set({
      status: 'skipped_unchanged', processedAt: now, updatedAt: now,
      result: { version: prior.latestVersion, relevance: prior.relevance || null,
                note: 'identical content already processed by this processing version — no OCR or AI call made' }
    }, { merge: true });
    await contentRef.set({ lastSeenAt: now, lastSeenJobId: job.jobId }, { merge: true });
    await jobRef.update({ 'counts.unchanged': FV.increment(1), 'counts.processed': FV.increment(1), updatedAt: now });
    return { outcome: 'unchanged' };
  }

  /* ---- a repost: same caption under another content key ---- */
  let duplicate = null;
  if (S.normaliseCaption(item.caption).length >= 40) {
    const same = await db.collection(C.INSTAGRAM_CONTENT).where('captionHash', '==', item.captionHash).limit(3).get();
    const other = same.docs.find(d => d.id !== item.contentKey);
    if (other) duplicate = { id: other.id, textHash: other.data().textHash || null, sourceKey: other.data().sourceKey || null };
  }

  /* ---- stage 1: the cheap filter — a score from what costs nothing ---- */
  const scored = item.manual ? { score: 9, tier: 'HIGH', reasons: [{ signal: 'text entered by an admin', weight: 9 }] }
    : job.forceDeep ? { score: 9, tier: 'HIGH', reasons: [{ signal: 'deep analysis requested by an admin', weight: 9 }] }
    : relevance.scoreCandidate({ caption: item.caption, contentType: item.contentType, sourceStats: env.sourceStats });
  const tier = scored.tier;
  const gate = tier === 'REJECT' ? 'repair' : tier === 'HIGH' ? 'compat' : 'generic';
  const skipMedia = tier === 'REJECT' && !cfg.readRepairMedia;
  const SKIPPED = 'Not read: the cheap filter scored this caption as repair or technical content (' + scored.score +
    '). Nothing was spent on it. "Analyse anyway" reads it; INSTAGRAM_READ_REPAIR_MEDIA=true reads every such post.';
  const trace = [{ stage: 'INGESTED' }, { stage: 'CHEAP_FILTERED', detail: tier + ' (' + scored.score + ')' }];
  if (env.usage.beginItem) env.usage.beginItem(item.itemKey);

  /* ---- text out of every medium ---- */
  const segments = [];
  const mediaItems = [];
  const inc = zero(['captionsProcessed', 'imagesOcrd', 'imagesUnderstood', 'videosUnderstood', 'framesProcessed', 'transcripts',
                    'cheapRejected', 'screened', 'screenRejected', 'deepAnalysed', 'videoUnavailable']);
  if (skipMedia) inc.cheapRejected = 1;
  let deferredReason = null;       /* a daily cap or a provider rate limit: the job pauses */
  let budgetReason = null;         /* this sync's AI budget: the item is queued, the job goes on */
  const confidences = [];          /* what each AI reading said about itself */

  if (item.caption && item.caption.trim()) {
    segments.push({ source: item.manual ? 'manual' : 'caption', ref: null, text: item.caption, confidence: null });
    inc.captionsProcessed++;
  }

  const halted = r => {
    if (r.status === 'deferred') { deferredReason = r.reason; return true; }
    if (r.status === 'budget') { budgetReason = r.reason; return true; }
    return false;
  };

  /* AI on one image, cheapest sufficient step first:
       OCR already read a repair diagram            -> nothing more is bought
       OCR read text that is not a list             -> nothing more is bought
       the caption says compatibility, or OCR read
       something that looks like a list             -> the deep read
       otherwise (nothing read it yet)              -> a cheap screen, and the
                                                       deep read only if the
                                                       screen does not say no */
  const look = async (entry, mediaId, url, ocrText, ocrOk, isCover) => {
    if (!media.understandImage || cfg.visionProvider === 'none' || !url) return;
    const read = ocrOk && ocrText.trim();
    const ocrSays = !read ? null : relevance.looksLikeCompatibility(ocrText) ? 'list' : relevance.isRepairText(ocrText) ? 'repair' : 'other';
    if (ocrSays === 'repair' || (ocrOk && tier !== 'HIGH' && ocrSays !== 'list')) return;

    if (tier !== 'HIGH' && ocrSays !== 'list' && media.screenImage && cfg.visionProvider === 'gemini') {
      const s = await media.screenImage({ mediaId, mediaUrl: url });
      entry.screen = { status: s.status, verdict: s.verdict || null, kind: s.kind || null, reason: s.reason || null,
                       engine: s.engine || null, cached: !!s.cached, code: s.code || null };
      if (halted(s)) return;
      if (s.status === 'ok') {
        inc.screened++;
        trace.push({ stage: 'SCREENED', detail: s.verdict });
        if (s.verdict === 'LIKELY_IRRELEVANT') {
          inc.screenRejected++;
          /* the picture was looked at and is not compatibility content */
          entry.vision = { status: 'ok', contentClass: s.kind === 'repair' ? 'repair' : 'other', engine: s.engine || null, screenedOnly: true };
          if (entry.ocrStatus !== 'ok') { entry.ocrStatus = isCover ? 'partial' : 'ok'; entry.readBy = 'screen'; if (!isCover) entry.reason = null; }
          return;
        }
      } else if (s.status === 'unavailable' && s.code) {
        entry.code = s.code;
        return;                      /* no key, or a rejected one: the deep read would fail the same way */
      }
    }

    const v = await media.understandImage({ mediaId, mediaUrl: url, ocrText });
    entry.vision = {
      status: v.status, reason: v.reason || null, engine: v.engine || null, cached: !!v.cached, code: v.code || null,
      contentClass: v.contentClass || null, product: v.product || null, confidence: v.confidence == null ? null : v.confidence,
      lists: (v.lists || []).length, models: (v.lists || []).reduce((n, l) => n + l.models.length, 0)
    };
    if (v.code) entry.code = v.code;
    if (halted(v) || v.status !== 'ok') return;
    inc.deepAnalysed++;
    trace.push({ stage: 'AI_EXTRACTED', detail: v.engine || null });
    if (v.confidence != null && (v.lists || []).length) confidences.push(v.confidence);
    const segs = visionSegments(v, mediaId, ocrText);
    segs.forEach(s => segments.push(s));
    if (segs.length) inc.imagesUnderstood++;
    if (entry.ocrStatus !== 'ok') {
      /* a cover is one frame of a video: reading it does not make the video read */
      entry.ocrStatus = isCover ? 'partial' : 'ok';
      entry.readBy = 'vision';
      if (!isCover) entry.reason = null;
    }
  };

  const image = async (mediaId, url) => {
    if (skipMedia) {
      mediaItems.push({ mediaId, kind: 'image', ocrStatus: 'skipped', reason: SKIPPED, previewUrl: url || null, previewUrlExpires: true });
      return;
    }
    const r = await media.ocrImage({ mediaId, mediaUrl: url });
    const entry = {
      mediaId, kind: 'image', ocrStatus: r.status, reason: r.reason || null, engine: r.engine || null,
      bytesHash: r.bytesHash || null, cached: !!r.cached, ocrConfidence: r.confidence == null ? null : r.confidence,
      textChars: r.text ? r.text.length : 0, previewUrl: url || null, previewUrlExpires: true
    };
    mediaItems.push(entry);
    if (r.status === 'deferred') { deferredReason = r.reason; return; }
    const text = r.status === 'ok' && r.text ? r.text : '';
    if (text.trim()) {
      segments.push({ source: 'ocr', ref: mediaId, text, confidence: r.confidence == null ? null : r.confidence });
      inc.imagesOcrd++;
    }
    await look(entry, mediaId, url, text, r.status === 'ok', false);
  };

  /* Gemini reads the video itself. The cover is looked at only when there is
     no video to read — and is recorded as a cover. */
  const nativeVideo = async (mediaId, url, thumb) => {
    const v = await media.understandVideo({ mediaId, mediaUrl: url, tier });
    const entry = {
      mediaId, kind: 'video', ocrStatus: v.status === 'ok' ? 'ok' : (v.status === 'failed' ? 'failed' : 'unavailable'),
      reason: v.reason || null, engine: v.engine || null, cached: !!v.cached, code: v.code || null,
      seconds: v.seconds == null ? null : v.seconds, passes: v.passes || 0, readBy: v.status === 'ok' ? 'vision' : null,
      screen: v.screen ? { status: 'ok', verdict: v.screen.verdict, kind: v.screen.kind, reason: v.screen.reason, engine: v.screen.engine } : null,
      vision: { status: v.status, contentClass: v.contentClass || null, product: v.product || null,
                confidence: v.confidence == null ? null : v.confidence, lists: (v.lists || []).length,
                models: (v.lists || []).reduce((n, l) => n + l.models.length, 0) },
      previewUrl: thumb || null, previewUrlExpires: true
    };
    mediaItems.push(entry);
    if (halted(v)) return;
    if (v.status === 'ok') {
      if (v.screen) { inc.screened++; trace.push({ stage: 'SCREENED', detail: v.screen.verdict }); }
      if (v.screen && v.screen.verdict === 'LIKELY_IRRELEVANT') { inc.screenRejected++; return; }
      inc.deepAnalysed++;
      inc.videosUnderstood++;
      trace.push({ stage: 'AI_EXTRACTED', detail: (v.engine || '') + ' · video' });
      if (v.confidence != null && (v.lists || []).length) confidences.push(v.confidence);
      visionSegments(v, mediaId, '').forEach(s => segments.push(s));
      return;
    }
    if (v.code === 'VIDEO_MEDIA_UNAVAILABLE') { inc.videoUnavailable++; trace.push({ stage: 'VIDEO_UNAVAILABLE' }); }
    if (thumb) await look(entry, mediaId + ':cover', thumb, '', false, true);
  };

  const video = async (mediaId, url, thumb) => {
    if (skipMedia) {
      mediaItems.push({ mediaId, kind: 'video', ocrStatus: 'skipped', reason: SKIPPED, previewUrl: thumb || null, previewUrlExpires: true });
      return;
    }
    if (cfg.videoProvider === 'gemini' && media.understandVideo) return nativeVideo(mediaId, url, thumb);

    const r = await media.analyzeVideo({ mediaId, mediaUrl: url, thumbnailUrl: thumb });
    const entry = {
      mediaId, kind: 'video', ocrStatus: r.status, reason: r.reason || null, engine: r.engine || null,
      cached: !!r.cached, keyFrames: (r.frames || []).length, sampledFrames: r.sampledFrames || null,
      transcript: !!(r.transcript && r.transcript.text), previewUrl: thumb || null, previewUrlExpires: true
    };
    mediaItems.push(entry);
    if (r.status === 'deferred') { deferredReason = r.reason; return; }
    (r.frames || []).forEach(f => {
      segments.push({ source: 'frame', ref: `${mediaId}@${f.timeMs}ms`, text: f.text, confidence: f.confidence == null ? null : f.confidence });
    });
    inc.framesProcessed += (r.frames || []).length;
    if (r.transcript && r.transcript.text && r.transcript.text.trim()) {
      segments.push({ source: 'transcript', ref: mediaId, text: r.transcript.text, confidence: null });
      inc.transcripts++;
    }
    if (!url) { inc.videoUnavailable++; entry.code = 'VIDEO_MEDIA_UNAVAILABLE'; trace.push({ stage: 'VIDEO_UNAVAILABLE' }); }
    /* No frames: the cover is all there is, and it is worth a second look. */
    if (r.status !== 'ok' && thumb) {
      await look(entry, mediaId + ':cover', thumb, (r.frames || []).map(f => f.text).join('\n'), false, true);
    }
  };

  if (item.contentType === 'image') await image(item.mediaId, item.mediaUrl);
  else if (item.contentType === 'video' || item.contentType === 'reel') await video(item.mediaId, item.mediaUrl, item.thumbnailUrl);
  else if (item.contentType === 'carousel') {
    /* Each child is read on its own; the analysis below is over all of them. */
    for (const child of (item.children || []).slice(0, cfg.maxCarouselChildren)) {
      if (child.mediaType === 'VIDEO') await video(child.mediaId, child.mediaUrl, child.thumbnailUrl);
      else await image(child.mediaId, child.mediaUrl);
      if (deferredReason || budgetReason) break;
    }
  }

  if (deferredReason) {
    /* Not a failure, and not an attempt: the item waits for tomorrow's cap. */
    await itemRef.set({ status: 'queued', attempts: item.attempts || 0, lastError: deferredReason,
                        pipelineState: /rate limit/i.test(deferredReason) ? 'RATE_LIMITED' : 'QUEUED_FOR_AI', updatedAt: clock() }, { merge: true });
    return { outcome: 'deferred', reason: deferredReason };
  }
  if (budgetReason) {
    /* This sync's AI budget is spent. The item is set aside — out of the
       queue, so the rest of the page is still classified for free — and comes
       back when a person resumes the job. What was already read is cached. */
    await itemRef.set({ status: 'deferred_ai', attempts: item.attempts || 0, lastError: budgetReason,
                        pipelineState: 'QUEUED_FOR_AI', updatedAt: clock() }, { merge: true });
    await jobRef.update({ 'counts.aiDeferred': FV.increment(1), updatedAt: clock() });
    return { outcome: 'budget', reason: budgetReason };
  }

  const result = await analyseAndPersist({
    job, item, env, prior, segments, mediaItems, inc, duplicate, gate, providers,
    candidate: scored, trace, aiConfidence: confidences.length ? Math.min.apply(null, confidences) : null,
    /* an admin asked for this post to be read again: a new version */
    bump: !!job.forceDeep
  });
  return { outcome: 'done', relevance: result.relevance };
}

/** What could read media when an item was processed. A change here is a
    reason to read unread media again. */
function providerFingerprint(cfg) {
  return [cfg.ocrProvider || 'none', cfg.visionProvider || 'none', cfg.videoProvider || 'none', cfg.readRepairMedia ? 'repair' : ''].join('|');
}

/**
 * AI vision output as text segments the ordinary extractor reads — so a list
 * the model saw goes through the same rules, the same matcher and the same
 * validation as a list OCR read. One segment per list, each carrying the
 * second of the video it was readable at. The model's entries are kept
 * verbatim; its own confidence and how far OCR agrees set the segment's.
 */
function visionSegments(v, mediaId, ocrText) {
  /* a repair image is recorded as one (mediaItems[].vision.contentClass) and
     contributes no text: there is nothing in it to extract */
  if (v.contentClass === 'repair') return [];
  /* the earlier single-list shape, still accepted */
  const lists = Array.isArray(v.lists) ? v.lists
    : Array.isArray(v.models) ? [{ headline: v.headline || null, models: v.models, atSecond: 0 }] : [];
  const usable = v.contentClass === 'compatibility' ? lists.filter(l => (l.models || []).length >= 2) : [];
  const hay = ocrText && ocrText.trim() ? ocrText.toLowerCase().replace(/[^a-z0-9]/g, '') : null;
  const base = v.confidence == null ? 0.85 : Math.max(0, Math.min(1, Number(v.confidence)));

  const out = usable.map(l => {
    const models = l.models.map(m => String(m || '').trim()).filter(Boolean).slice(0, 200);
    const lines = [];
    /* the part PICTURED is evidence of the product, beside the words printed */
    if (v.product) lines.push('Product shown: ' + String(v.product).slice(0, 80));
    if (l.headline) lines.push(String(l.headline).slice(0, 160));
    lines.push('Compatible models:');
    models.forEach(m => lines.push(m.slice(0, 80)));
    let confidence = base;
    if (hay) {
      const confirmed = models.filter(m => hay.indexOf(m.toLowerCase().replace(/[^a-z0-9]/g, '')) > -1).length;
      confidence = confirmed / models.length >= 0.8 ? Math.max(base, 0.9) : Math.min(base, 0.6);
    }
    const at = Number(l.atSecond) > 0 ? Math.round(Number(l.atSecond) * 1000) : 0;
    return { source: 'vision', ref: at ? `${mediaId}@${at}ms` : mediaId, text: lines.join('\n'), confidence, aiConfidence: v.confidence == null ? null : v.confidence };
  });

  if (!out.length && (v.text || v.product)) {
    const lines = [];
    if (v.product) lines.push('Product shown: ' + String(v.product).slice(0, 80));
    lines.push.apply(lines, lists.filter(l => l.headline).map(l => String(l.headline).slice(0, 160)));
    if (v.text) lines.push(String(v.text).slice(0, 6000));
    out.push({ source: 'vision', ref: mediaId, text: lines.join('\n'), confidence: Math.min(base, 0.85) });
  }
  return out;
}

/**
 * Stage 4: everything after the text is in hand. Used by an import (the text
 * was just read) and by "add evidence" (the stored text, plus what an admin
 * supplied) — the same classification, extraction, matching and comparison.
 */
async function analyseAndPersist({ job, item, env, prior, segments, mediaItems, inc, duplicate, gate, providers, bump, candidate, trace, aiConfidence }) {
  const { clock } = env;
  trace = trace || [{ stage: 'INGESTED' }];
  const db = fsx.db();
  const FV = fsx.FieldValue();
  const itemRef = items(job.jobId).doc(item.itemKey);
  const jobRef = jobs().doc(job.jobId);
  const contentRef = db.collection(C.INSTAGRAM_CONTENT).doc(item.contentKey);

  /* What an admin supplied for this post stays part of it, on every later
     run: a screenshot's text as OCR (or vision) evidence, typed text as
     admin-entered. Each keeps its own reference, so a card can say which
     screenshot a model was read from. */
  const manualEvidence = (prior && Array.isArray(prior.manualEvidence) ? prior.manualEvidence : []);
  const have = new Set(segments.map(s => s.source + '|' + s.ref));
  const addOnce = seg => { const k = seg.source + '|' + seg.ref; if (!have.has(k)) { have.add(k); segments.push(seg); } };
  manualEvidence.forEach(e => {
    if (!e) return;
    const ref = 'evidence:' + e.id;
    if (e.text && String(e.text).trim()) {
      addOnce({ source: e.kind === 'text' ? 'manual' : (e.readBy === 'vision' ? 'vision' : 'ocr'),
                ref, text: String(e.text), confidence: e.confidence == null ? null : e.confidence });
    }
    if (e.visionText && String(e.visionText).trim()) {
      addOnce({ source: 'vision', ref, text: String(e.visionText), confidence: e.visionConfidence == null ? null : e.visionConfidence });
    }
  });

  const textHash = S.sha256(segments.map(s => S.normaliseCaption(s.text)).join('\n'));
  const duplicateOf = duplicate ? duplicate.id : null;

  /* ---- extraction + classification ---- */
  const raw = extractor.extractDeterministic(segments);
  const judged = relevance.classify({ segments, det: raw, mediaItems });
  const det = Object.assign({}, raw, { relationships: judged.relationships, sets: judged.sets });
  let verdict = judged.relevance;
  let verdictReason = judged.reason;
  /* The same page posting the same thing again is one piece of evidence, not
     two. Another PAGE saying it is corroboration, and is kept as such. */
  if (duplicate && duplicate.sourceKey === job.sourceKey && duplicate.textHash && duplicate.textHash === textHash &&
      S.isActionableRelevance(verdict)) {
    verdict = 'DUPLICATE_SOURCE';
    verdictReason = 'The same caption and the same text as another post of this page, already processed (' + duplicate.id + ').';
  }
  let actionable = S.isActionableRelevance(verdict);

  /* ---- versioning: a changed post is a new version, never an overwrite ---- */
  const version = (prior && prior.latestVersion ? prior.latestVersion : 0) +
    (!bump && prior && prior.signature === item.signature && prior.processingVersion === S.PROCESSING_VERSION ? 0 : 1);
  const extractionId = S.extractionIdFor(item.contentKey, version);
  const content = {
    contentKey: item.contentKey, mediaId: item.mediaId, permalink: item.permalink,
    contentType: item.contentType, publishedAt: item.publishedAt || null,
    collectionMethod: job.collectionMethod || (item.manual ? 'manual_admin_entry' : null)
  };

  /* ---- matching, lists against groups, pairs against pairs ----
     Only for content that makes a claim: an ignored post costs no alias
     read, no production read and no AI call. */
  let refs = [];
  let relationships = [];
  let proposals = [];
  let built = { candidates: [], evidence: [], stats: { relationships: 0, selfPairsDropped: 0, systemRejected: 0, references: 0 } };
  let aiResult = { valid: [], rejected: [], model: null, info: { used: false, asked: false, reason: 'not asked: ' + verdict.toLowerCase().replace(/_/g, ' '), model: null, cached: false } };

  /* The rules found no statement, but the post names several models and a
     product: the one case the AI is asked about content the rules passed
     over. Never for a repair post, and only when an AI is configured. */
  const secondOpinion = !actionable && (verdict === 'IRRELEVANT_GENERAL' || verdict === 'INSUFFICIENT_EVIDENCE') && env.cfg.aiMode !== 'off' &&
    env.ai.isConfigured() && extractor.shouldAskAi(env.cfg.aiMode, det, []);
  const ctx = { job, content, extractionId, version, now: clock(), aiModel: null };

  if (actionable || secondOpinion) {
    await prefetchAliases(det, env);
    const resolve = (text, brandHint) => resolveCached(text, brandHint, env);
    refs = det.references.map(r => Object.assign({}, r, { match: resolve(r.text, r.brandHint) }));
    const rulesRels = det.relationships.map(r => Object.assign({}, r, {
      sourceMatch: resolve(r.sourceText, r.sourceBrandHint),
      compatibleMatch: resolve(r.compatibleText, r.compatibleBrandHint)
    }));
    aiResult = await maybeAi({ det, refs, segments, env });
    relationships = mergeAi(rulesRels, aiResult.valid, segments, det.brandHint, env);
    ctx.aiModel = aiResult.model;
    if (!actionable && relationships.some(r => r.extractedBy === 'ai')) {
      actionable = true;
      verdict = 'PARTIALLY_RELEVANT';
      verdictReason = 'The rules found no compatibility statement; the AI proposed one, and its quote was checked against the post.';
    }
  }

  if (!actionable) {
    /* what the AI tried to claim and was refused stays visible, as rejected */
    if (aiResult.rejected.length) built = buildCandidates({ relationships: [], aiRejected: aiResult.rejected, references: [], segments, ctx });
    refs = [];
    relationships = [];
  } else {
    const resolve = (text, brandHint) => resolveCached(text, brandHint, env);
    const lists = await groupProposals.buildAll({ det, resolve, segments, ctx, cache: env.prodCache });
    proposals = lists.proposals;
    /* what a list already says is not queued again as pairs */
    const inList = t => lists.covered.has(String(t).toLowerCase());
    built = buildCandidates({
      relationships: relationships.filter(r => !(inList(r.sourceText) && inList(r.compatibleText))),
      aiRejected: aiResult.rejected,
      references: refs.filter(r => !inList(r.text)),
      segments, ctx
    });
    trace.push({ stage: 'MODEL_MATCHING', detail: refs.filter(r => r.match.status === 'matched').length + ' of ' + refs.length + ' matched' });
    if (proposals.length) trace.push({ stage: 'GROUP_MATCHING', detail: proposals.map(p => p.proposedAction).join(', ') });
    await dedupeAndConflicts(built.candidates, env);
    /* a second opinion — only for the lists matching left in doubt, and
       before duplicates are looked up: what it disputes changes the claim */
    const checked = await validateProposals(proposals, { item, env, aiConfidence, resolve });
    if (checked.validated) inc.validated = checked.validated;
    if (checked.failed) inc.validationFailed = checked.failed;
    if (checked.validated || checked.failed) trace.push({ stage: checked.failed && !checked.validated ? 'VALIDATION_FAILED' : 'VALIDATED', detail: checked.validated + ' checked' });
    await dedupeProposals(proposals, env);

    if (proposals.length && !built.candidates.some(c => c.kind === 'relationship' && c.status === 'pending') &&
        proposals.every(p => p.counts.matched < 2)) {
      verdict = 'NEEDS_REVIEW';
      verdictReason = 'A compatibility list was found, but fewer than two of its models resolved to catalogue records.';
    }
  }
  const candidates = built.candidates.concat(proposals);
  const filters = S.extractionFiltersFor({ relevance: verdict, compatSignal: judged.compatSignal, candidates, mediaItems });

  /* where this item ended up — a state for every outcome, including the ones
     where something could not be done */
  const pending = candidates.filter(c => c.status === 'pending');
  const codes = mediaItems.map(m => m.code).filter(Boolean);
  const pipelineState = pending.some(c => c.reviewSection === 'conflicts') ? 'CONFLICT_DETECTED'
    : pending.length ? 'READY_FOR_REVIEW'
    : verdict === 'INSUFFICIENT_EVIDENCE' && codes.indexOf('VIDEO_MEDIA_UNAVAILABLE') > -1 ? 'VIDEO_UNAVAILABLE'
    : verdict === 'INSUFFICIENT_EVIDENCE' && (codes.indexOf('API_KEY_MISSING') > -1 || codes.indexOf('API_KEY_INVALID') > -1) ? 'API_KEY_MISSING'
    : verdict === 'INSUFFICIENT_EVIDENCE' && mediaItems.some(m => m.ocrStatus === 'failed') ? 'RETRY_REQUIRED'
    : 'IGNORED';
  trace.push({ stage: pipelineState });
  const pipeline = { state: pipelineState, trace: trace.slice(0, 20), candidate: candidate || null, aiConfidence: aiConfidence == null ? null : aiConfidence };
  if (pending.length || candidates.some(c => c.status === 'duplicate')) inc.extracted = 1;

  /* ---- persist ---- */
  const t = clock();
  const bytesHashes = mediaItems.map(m => m.bytesHash).filter(Boolean).sort();
  const versions = (prior && Array.isArray(prior.versions) ? prior.versions : []).filter(x => x.version !== version);
  versions.push({ version, signature: item.signature, captionHash: item.captionHash, processingVersion: S.PROCESSING_VERSION,
                  processedAt: t, jobId: job.jobId, relevance: verdict });
  const mediaComplete = mediaItems.every(m => m.ocrStatus === 'ok' || m.ocrStatus === 'skipped');

  const writes = [];
  writes.push([contentRef, {
    contentKey: item.contentKey, sourceKey: job.sourceKey, username: job.username,
    mediaId: item.mediaId || null, shortcode: item.shortcode || null, permalink: item.permalink || null,
    contentType: item.contentType, mediaType: item.mediaType || null, productType: item.productType || null,
    publishedAt: item.publishedAt || null,
    caption: String(item.caption || '').slice(0, 5000), captionHash: item.captionHash,
    signature: item.signature,
    contentHash: S.sha256(item.captionHash + '|' + bytesHashes.join(',')),
    textHash,
    hashtags: det.hashtags,
    collectionMethod: content.collectionMethod,
    collectedAt: prior && prior.collectedAt ? prior.collectedAt : t,
    lastSeenAt: t, lastSeenJobId: job.jobId,
    mediaItems, mediaUrlOmitted: !!item.mediaUrlOmitted, mediaComplete, providers: providers || null,
    relevance: verdict, relevanceReason: verdictReason, captionGate: gate || null,
    pipelineState, candidateScore: candidate ? { score: candidate.score, tier: candidate.tier } : null,
    duplicateOf, duplicateStatus: duplicateOf ? 'same_caption_as:' + duplicateOf : 'unique',
    latestVersion: version, processingVersion: S.PROCESSING_VERSION,
    versions: versions.slice(-20),
    processingStatus: 'processed', updatedAt: t
  }, { merge: true }]);

  const seg = src => segments.filter(s => s.source === src);
  writes.push([db.collection(C.INSTAGRAM_EXTRACTIONS).doc(extractionId), {
    extractionId, contentKey: item.contentKey, sourceKey: job.sourceKey, username: job.username, jobId: job.jobId,
    version, processingVersion: S.PROCESSING_VERSION, extractedAt: t,
    contentType: item.contentType, permalink: item.permalink || null,
    relevance: verdict, relevanceReason: verdictReason, signals: judged.signals, captionGate: gate || null,
    pipeline,
    actionable: !!actionable, compatSignal: !!judged.compatSignal, filters,
    texts: {
      caption: String(item.caption || '').slice(0, 5000),
      ocr: seg('ocr').slice(0, 30).map(s => ({ ref: s.ref, text: s.text.slice(0, 4000), confidence: s.confidence })),
      vision: seg('vision').slice(0, 30).map(s => ({ ref: s.ref, text: s.text.slice(0, 4000), confidence: s.confidence })),
      frames: seg('frame').slice(0, 30).map(s => ({ ref: s.ref, text: s.text.slice(0, 2000), confidence: s.confidence })),
      manual: segments.filter(s => s.source === 'manual' && s.ref).slice(0, 10).map(s => ({ ref: s.ref, text: s.text.slice(0, 4000), confidence: null })),
      transcript: (segments.find(s => s.source === 'transcript') || {}).text || null
    },
    mediaItems,
    category: det.category, brandHint: det.brandHint, hashtags: det.hashtags,
    references: refs.slice(0, 100).map(r => ({ text: r.text, source: r.source, ref: r.ref || null, fromHashtag: !!r.fromHashtag, match: slimMatch(r.match) })),
    relationships: relationships.slice(0, 100).map(r => ({
      sourceText: r.sourceText, compatibleText: r.compatibleText, polarity: r.polarity,
      compatibilityType: r.compatibilityType, evidenceText: String(r.evidenceText || '').slice(0, 1000),
      extractedBy: r.extractedBy, aiAgrees: !!r.aiAgrees,
      sourceModelId: r.sourceMatch && r.sourceMatch.modelId || null,
      compatibleModelId: r.compatibleMatch && r.compatibleMatch.modelId || null,
      categoryId: r.category && r.category.categoryId || null
    })),
    proposals: proposals.map(S.proposalSummary),
    ai: aiResult.info,
    warnings: det.warnings,
    candidateIds: candidates.map(c => c.candidateId).slice(0, 300),
    stats: built.stats
  }]);

  candidates.forEach(c => writes.push([db.collection(C.COMPATIBILITY_CANDIDATES).doc(c.candidateId), c]));
  built.evidence.forEach(e => {
    const cand = built.candidates.find(c => c.candidateId === e.candidateId);
    writes.push([db.collection(C.COMPATIBILITY_EVIDENCE).doc(e.evidenceId), Object.assign(e, {
      candidateStatus: cand ? cand.status : null, duplicateOf: cand ? cand.duplicateOf : null
    })]);
  });
  proposals.filter(p => p.relKey).forEach(p => writes.push([db.collection(C.COMPATIBILITY_EVIDENCE).doc(p.candidateId), {
    evidenceId: p.candidateId, candidateId: p.candidateId, kind: 'group_proposal', relKey: p.relKey,
    polarity: 'positive', compatibilityType: 'explicit', categoryId: p.categoryId,
    sourceKey: p.sourceKey, sourceUsername: p.sourceUsername, contentKey: p.contentKey, contentVersion: p.contentVersion,
    permalink: p.sourcePost.permalink, evidenceText: p.extractedText, evidenceSource: p.evidence.source,
    evidenceRef: p.evidence.ref, evidenceConfidence: p.evidence.confidence,
    candidateStatus: p.status, duplicateOf: p.duplicateOf, createdAt: t
  }]));
  (env.pendingUpdates || []).forEach(u => writes.push([db.collection(C.COMPATIBILITY_CANDIDATES).doc(u.id), u.patch, { merge: true }]));
  env.pendingUpdates = [];

  /* the previous version's open candidates are superseded, not deleted */
  if (prior && prior.latestVersion && version > prior.latestVersion) {
    /* …and its extraction leaves every tab: the tabs list what a post says
       NOW. The document itself stays, reachable from the content's versions. */
    writes.push([db.collection(C.INSTAGRAM_EXTRACTIONS).doc(S.extractionIdFor(item.contentKey, prior.latestVersion)),
      { filters: [], supersededBy: extractionId, supersededAt: t }, { merge: true }]);
    const old = await db.collection(C.COMPATIBILITY_CANDIDATES).where('contentKey', '==', item.contentKey)
      .where('status', '==', 'pending').limit(200).get();
    old.docs.filter(d => (d.data().contentVersion || 0) < version).forEach(d => {
      writes.push([d.ref, {
        status: 'superseded', reviewSection: 'closed', updatedAt: t,
        history: FV.arrayUnion({ at: t, by: 'system', action: 'superseded', note: `content changed; see version ${version}` })
      }, { merge: true }]);
    });
  }

  /* the source's counters: one bucket per content item, MOVED when a
     re-import classifies it differently — never counted twice */
  const bucket = S.relevanceBucket(verdict);
  const was = prior ? S.relevanceBucket(prior.relevance) : null;
  const stats = {};
  if (!prior || !prior.relevance) stats.content = FV.increment(1);
  if (bucket !== was) {
    if (bucket) stats[bucket] = FV.increment(1);
    if (was) stats[was] = FV.increment(-1);
  }
  writes.push([db.collection(C.INSTAGRAM_SOURCES).doc(job.sourceKey),
    Object.assign({ lastScanAt: t, updatedAt: t }, Object.keys(stats).length ? { stats } : {}), { merge: true }]);

  const counts = tallies(candidates, refs);
  const jobPatch = { updatedAt: t, 'counts.processed': FV.increment(1) };
  Object.assign(counts, inc);
  if (bucket === 'relevant') counts.relevant = 1;
  else if (bucket === 'ignored') counts.ignored = 1;
  else if (bucket === 'needsReview') counts.insufficient = 1;
  Object.keys(counts).forEach(k => { if (counts[k]) jobPatch['counts.' + k] = FV.increment(counts[k]); });
  writes.push([jobRef, jobPatch, 'update']);
  writes.push([itemRef, {
    status: 'done', processedAt: t, updatedAt: t, lastError: null,
    pipelineState,
    result: { version, extractionId, relevance: verdict, relevanceReason: verdictReason, tier: candidate ? candidate.tier : null,
              candidates: candidates.length, references: refs.length, proposals: proposals.length,
              relationships: built.stats.relationships, aiUsed: aiResult.info.used, duplicateOf }
  }, { merge: true }]);

  await commitInBatches(writes);

  /* ---- Instagram Intelligence ----
     The lists are in the review queue exactly as before. One that passes
     every check is now applied through the same transaction a person's
     approval runs; one that does not stays where it is, with the reason. */
  let applied = null;
  if (job.autoApply && proposals.some(p => p.status === 'pending')) {
    applied = await require('./auto-apply').run(proposals, { job, relevance: verdict, clock, createCategories: env.cfg.autoCreateCategories !== false });
    const patch = { updatedAt: clock() };
    Object.keys(applied.counts).forEach(k => { if (applied.counts[k]) patch['counts.' + k] = FV.increment(applied.counts[k]); });
    if (Object.keys(patch).length > 1) await jobRef.update(patch);
    const open = applied.results.filter(r => r.outcome === 'attention').length;
    if (!open && !built.candidates.some(c => c.status === 'pending')) {
      const state = { pipelineState: 'APPROVED' };
      await itemRef.set(state, { merge: true });
      await contentRef.set(state, { merge: true });
      await db.collection(C.INSTAGRAM_EXTRACTIONS).doc(extractionId).set({ pipeline: { state: 'APPROVED' } }, { merge: true });
    }
  }
  return { relevance: verdict, extractionId, version, candidates: candidates.length, proposals: proposals.length, applied };
}

function tallies(candidates, refs) {
  const nonHashtag = refs.filter(r => !r.fromHashtag);
  const proposals = candidates.filter(c => c.kind === 'group_proposal');
  const t = {
    modelReferences: nonHashtag.length,
    matched: nonHashtag.filter(r => r.match.status === 'matched').length,
    unmatched: nonHashtag.filter(r => r.match.status === 'unmatched').length,
    ambiguous: nonHashtag.filter(r => r.match.status === 'ambiguous').length,
    /* every relationship detected, duplicates included; AI claims that failed
       validation are counted under "rejected", not here */
    relationships: candidates.filter(c => c.kind === 'relationship' && !(c.status === 'rejected' && c.reviewer === 'system')).length,
    groupProposals: proposals.length,
    groupUpdates: proposals.filter(p => p.reviewSection === 'group_updates').length,
    newGroups: proposals.filter(p => p.reviewSection === 'new_groups').length,
    readyForApproval: 0, needsReview: 0, pendingReview: 0, duplicates: 0, conflicts: 0, rejected: 0
  };
  candidates.forEach(c => {
    if (c.status === 'duplicate') t.duplicates++;
    if (c.status === 'rejected') t.rejected++;
    if (c.reviewSection === 'conflicts') t.conflicts++;
    if (c.reviewSection === 'ready') t.readyForApproval++;
    if (c.status === 'pending' && ['review', 'unmatched', 'ambiguous', 'conflicts'].indexOf(c.reviewSection) > -1) t.needsReview++;
    if (c.status === 'pending') t.pendingReview++;
  });
  return t;
}

/**
 * Claude, for the proposals that need it (validation.needsValidation) — one
 * call per doubtful list, never one per post. A proposal that needs no second
 * opinion costs nothing here; one whose call fails keeps its extraction and
 * says VALIDATION_FAILED.
 */
async function validateProposals(proposals, { item, env, aiConfidence, resolve }) {
  const out = { validated: 0, failed: 0 };
  const { cfg, media } = env;
  for (const p of proposals) {
    const need = validation.needsValidation(p, { aiConfidence, cfg });
    if (!need.needed) continue;
    if (cfg.validator !== 'anthropic' || !media.validateExtraction) {
      p.validation = { status: 'not_configured', reasons: need.reasons,
                       note: 'A second opinion was wanted, but no validator is configured (ANTHROPIC_API_KEY). The list goes to manual review as it is.' };
      continue;
    }
    const request = validation.buildRequest(p, { lowConfidence: need.lowConfidence });
    if (!request.entries.length && p.categoryId) continue;

    /* the image the list was read from, when there is one */
    const ref = String((p.sourceMedia || [])[0] || '').split('@')[0].replace(/:cover$/, '');
    const child = (item.children || []).find(c => c.mediaId === ref);
    const supplied = env.evidenceBytes && env.evidenceBytes.get(ref);
    const mediaUrl = supplied ? null
      : child && child.mediaType !== 'VIDEO' ? child.mediaUrl
      : ref === item.mediaId && item.contentType === 'image' ? item.mediaUrl
      : ref === item.mediaId && item.thumbnailUrl ? item.thumbnailUrl : null;

    const r = await media.validateExtraction({ request, mediaUrl, bytes: supplied ? supplied.bytes : null, mimeType: supplied ? supplied.mimeType : null });
    if (r.status !== 'ok') {
      /* the extraction is kept exactly as it was */
      p.validation = { status: r.status === 'budget' || r.status === 'deferred' ? 'queued' : 'failed', reasons: need.reasons,
                       note: r.reason || null, code: r.code || null };
      if (p.validation.status === 'failed') {
        out.failed++;
        p.history.push({ at: env.clock(), by: 'system', action: 'validation_failed', note: r.reason || 'the validator could not be reached' });
      }
      continue;
    }
    const summary = validation.apply(p, r.output, request, { resolve, visual: r.visual, model: r.model, cached: r.cached });
    p.validation = Object.assign(summary, { reasons: need.reasons });
    out.validated++;
    /* recompute against production with what the validator disputed set aside */
    Object.assign(p, await groupProposals.refresh(p, env.prodCache));
    p.history.push({ at: env.clock(), by: 'system', action: 'validated',
      note: `second opinion (${r.model}): ${summary.status}; ${summary.suggested} suggested, ${summary.disputed} disputed` });
  }
  return out;
}

/**
 * The same list from a second post is not a second proposal: it corroborates
 * the first, and waits behind it.
 */
async function dedupeProposals(proposals, env) {
  const db = fsx.db();
  const FV = fsx.FieldValue();
  const now = env.clock();
  env.pendingUpdates = env.pendingUpdates || [];
  const seen = new Map();
  for (const p of proposals) {
    if (p.status !== 'pending' || !p.relKey) continue;
    if (seen.has(p.relKey)) { markDuplicate(p, seen.get(p.relKey), 'same_claim_same_post', now); continue; }
    seen.set(p.relKey, p.candidateId);
    const snap = await db.collection(C.COMPATIBILITY_CANDIDATES).where('relKey', '==', p.relKey).limit(20).get();
    const existing = snap.docs.map(d => d.data())
      .filter(e => e.candidateId !== p.candidateId && e.contentKey !== p.contentKey && ['superseded', 'ignored', 'rejected'].indexOf(e.status) < 0);
    const approved = existing.find(e => e.status === 'approved');
    const pending = existing.find(e => e.status === 'pending');
    if (approved) markDuplicate(p, approved.candidateId, 'already_approved', now);
    else if (pending) {
      markDuplicate(p, pending.candidateId, 'same_claim_pending', now);
      env.pendingUpdates.push({ id: pending.candidateId, patch: {
        corroborations: FV.increment(1), updatedAt: now,
        history: FV.arrayUnion({ at: now, by: 'system', action: 'corroborated', note: `same list from @${p.sourceUsername} (${p.candidateId})` })
      } });
    }
  }
}

async function commitInBatches(writes) {
  const db = fsx.db();
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    writes.slice(i, i + 400).forEach(([ref, data, opt]) => {
      if (opt === 'update') batch.update(ref, data);
      else if (opt) batch.set(ref, data, opt);
      else batch.set(ref, data);
    });
    await batch.commit();
  }
}

/* ------------------------------------------------------------- matching */

function resolveCached(text, brandHint, env) {
  const key = String(text).toLowerCase() + '|' + (brandHint || '');
  if (!env.matchCache.has(key)) {
    env.matchCache.set(key, taxonomy.matchModel(text, {
      brandHint: brandHint || undefined,
      aliasLookup: k => env.aliasCache.get(k) || null
    }));
  }
  return env.matchCache.get(key);
}

/** One read per distinct alias key, once per tick. The alias bridge is
    level 2 of the authority order: admin-verified spellings live there. */
async function prefetchAliases(det, env) {
  const texts = new Map();
  det.references.forEach(r => texts.set(r.text, r.brandHint));
  det.relationships.forEach(r => { texts.set(r.sourceText, r.sourceBrandHint); texts.set(r.compatibleText, r.compatibleBrandHint); });
  const tax = taxonomy.taxonomy();
  const keys = new Set();
  texts.forEach((brandHint, text) => {
    const brand = brandHint && tax.brands.get(brandHint) ? tax.brands.get(brandHint).name : '';
    const clean = taxonomy.basicTokens(text).join(' ');
    [taxonomy.aliasKeyFor(brand, clean), taxonomy.aliasKeyFor('', clean)].forEach(k => { if (k && !env.aliasCache.has(k)) keys.add(k); });
  });
  const list = Array.from(keys).slice(0, 80);
  if (!list.length) return;
  const db = fsx.db();
  const snaps = await Promise.all(list.map(k => db.collection(C.ALIASES).doc(k).get().catch(() => null)));
  snaps.forEach((s, i) => env.aliasCache.set(list[i], s && s.exists ? s.data() : null));
}

/* ------------------------------------------------------------------- AI */

async function maybeAi({ det, refs, segments, env }) {
  const info = { used: false, asked: false, reason: null, model: null, cached: false };
  const out = { valid: [], rejected: [], info, model: null };
  if (!extractor.shouldAskAi(env.cfg.aiMode, det, refs)) { info.reason = 'rules were sufficient'; return out; }
  info.asked = true;
  if (!env.ai.isConfigured()) { info.reason = 'the AI would have been asked, but the AI gateway is not configured — rules only'; return out; }

  const tax = taxonomy.taxonomy();
  const candidates = new Map();
  refs.concat(det.relationships.map(r => ({ text: r.sourceText, match: null })), det.relationships.map(r => ({ text: r.compatibleText, match: null })))
    .forEach(r => {
      const m = r.match;
      if (m && m.modelId) candidates.set(m.modelId, m.modelName);
      (m && m.alternatives || []).forEach(a => a.modelId && candidates.set(a.modelId, a.modelName));
      if (!m || m.status !== 'matched') {
        taxonomy.searchModels(r.text, { limit: 5 }).forEach(x => candidates.set(x.modelId, x.modelName));
      }
    });
  const candidateModels = Array.from(candidates.entries()).slice(0, 80).map(([id, name]) => ({ id, name }));
  const categories = Array.from(tax.categories.values());
  const input = extractor.buildAiInput({ segments, candidateModels, categories });
  const hash = extractor.inputHash({ input, prompt: extractor.AI_SYSTEM_PROMPT, pv: S.PROCESSING_VERSION });

  let output = null;
  const hit = await env.cache.get('ai_' + hash);
  if (hit) {
    output = hit.output; info.cached = true; env.usage.record('cacheHit');
  } else {
    if (!env.usage.allow('ai')) { info.reason = 'the daily AI cap was reached — rules only for this item'; return out; }
    env.usage.record('ai');
    const res = await env.ai.invoke({ capability: 'extract_compatibility', systemHint: extractor.AI_SYSTEM_PROMPT, input });
    if (!res.ok) { info.reason = 'the AI call failed (' + res.reason + ') — rules only'; return out; }
    output = res.output;
    await env.cache.put('ai_' + hash, { output });
  }

  const checked = extractor.validateAiExtraction(output, {
    sourceText: input.sourceText,
    modelIds: new Set(candidateModels.map(m => m.id)),
    categoryIds: new Set(categories.map(c => c.id))
  });
  if (!checked.ok) { info.reason = checked.error; return out; }
  info.used = true;
  info.model = (env.ai.status && env.ai.status().model) || null;
  out.model = info.model;
  out.valid = checked.valid;
  out.rejected = checked.rejected;
  info.valid = checked.valid.length;
  info.rejected = checked.rejected.length;
  return out;
}

/**
 * AI relationships join the rule-based ones only where they add something.
 * Every AI model id is re-checked by the deterministic matcher on the AI's
 * own text: a catalogue match wins over the AI's choice, and the AI's id is
 * used only when no deterministic rung matched — as a WEAK match.
 */
function mergeAi(rulesRels, aiRels, segments, brandHint, env) {
  const out = rulesRels.slice();
  const pairKey = (a, b, p) => [a, b].sort().join('|') + '|' + p;
  const have = new Map();
  out.forEach(r => {
    const a = r.sourceMatch && r.sourceMatch.modelId || r.sourceText.toLowerCase();
    const b = r.compatibleMatch && r.compatibleMatch.modelId || r.compatibleText.toLowerCase();
    have.set(pairKey(a, b, r.polarity), r);
  });

  aiRels.forEach(ai => {
    const sm = aiSide(ai.sourceModelText, ai.sourceModelId, brandHint, env);
    const cm = aiSide(ai.compatibleModelText, ai.compatibleModelId, brandHint, env);
    const a = sm.modelId || ai.sourceModelText.toLowerCase();
    const b = cm.modelId || ai.compatibleModelText.toLowerCase();
    const k = pairKey(a, b, ai.polarity);
    if (have.has(k)) { have.get(k).aiAgrees = true; return; }
    const seg = findSegment(segments, ai.evidenceText);
    /* The rules read the category first, from the AI's own quote; the AI's
       category is used only when they find none — the same ladder as models. */
    const ruled = taxonomy.resolveCategory(ai.evidenceText + ' ' + (ai.categoryText || ''));
    const category = ruled.categoryId ? ruled
      : ai.categoryId && ai.categoryId !== 'UNMATCHED' && taxonomy.isKnownCategory(ai.categoryId)
        ? { categoryId: ai.categoryId, method: 'ai_classification', strength: 'weak', term: ai.categoryText || null, alternatives: [] }
        : ruled;
    const rel = {
      sourceText: ai.sourceModelText, compatibleText: ai.compatibleModelText,
      polarity: ai.polarity, compatibilityType: ai.compatibilityType,
      evidenceText: ai.evidenceText, evidenceLines: [ai.evidenceText],
      evidence: seg ? { source: seg.source, ref: seg.ref, confidence: seg.confidence } : { source: 'ai', ref: null, confidence: null },
      category, extractedBy: 'ai', sourceMatch: sm, compatibleMatch: cm
    };
    have.set(k, rel);
    out.push(rel);
  });
  return out;
}

function aiSide(text, aiId, brandHint, env) {
  const m = resolveCached(text, brandHint, env);
  const proposed = aiId && aiId !== 'UNMATCHED' ? aiId : null;
  if (m.status === 'matched') {
    if (proposed && proposed !== m.modelId) {
      return Object.assign({}, m, { notes: (m.notes || []).concat([`the AI proposed ${proposed}; the catalogue match was kept`]), aiProposedModelId: proposed });
    }
    return m;
  }
  const record = proposed ? taxonomy.modelById(proposed) : null;
  if (record) {
    return {
      status: 'matched', modelId: record.modelId, modelName: record.modelName, brandId: record.brandId,
      method: 'ai_classification', strength: 'weak', normalizedText: m.normalizedText,
      requiresVariantConfirmation: false, variantNote: null,
      notes: (m.notes || []).concat(['no deterministic method matched; this is the AI\'s classification']),
      alternatives: m.alternatives || [], siblings: [], aiProposedModelId: proposed
    };
  }
  return m;
}

function findSegment(segments, quote) {
  const q = String(quote || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return segments.find(s => String(s.text).toLowerCase().replace(/\s+/g, ' ').indexOf(q) > -1) || null;
}

/* ------------------------------------------------- duplicates + conflicts */

/**
 * Compares each new relationship with what is already known — earlier
 * candidates for the same relationship key, and production — and marks it
 * duplicate, conflict, or leaves it for review. Updates to EARLIER
 * candidates are queued on env.pendingUpdates and written with the item.
 */
async function dedupeAndConflicts(candidates, env) {
  const db = fsx.db();
  const FV = fsx.FieldValue();
  const now = env.clock();
  env.pendingUpdates = env.pendingUpdates || [];
  const inBatch = new Map();

  for (const c of candidates) {
    if (c.kind !== 'relationship' || c.status !== 'pending' || !c.relKey) continue;
    const bucket = c.relKey + '|' + c.polarity;

    /* the same relationship twice in one post ("A15" and "Samsung A15") */
    if (inBatch.has(bucket)) {
      markDuplicate(c, inBatch.get(bucket).candidateId, 'same_claim_same_post', now);
      continue;
    }
    inBatch.set(bucket, c);

    const snap = await db.collection(C.COMPATIBILITY_CANDIDATES).where('relKey', '==', c.relKey).limit(50).get();
    const existing = snap.docs.map(d => d.data())
      .filter(e => e.candidateId !== c.candidateId && ['superseded', 'ignored'].indexOf(e.status) < 0);
    const [a, b] = [c.sourceMatch.modelId, c.compatibleMatch.modelId];
    const prod = await production.readState({ categoryId: c.categoryId, modelA: a, modelB: b }, env.prodCache);
    c.productionState = { state: prod.state, source: prod.source, reason: prod.reason || null,
                          groupsSource: prod.groupsA || [], groupsCompatible: prod.groupsB || [] };

    if (c.polarity === 'positive') {
      const negatives = existing.filter(e => e.polarity === 'negative' && ['pending', 'approved', 'resolved'].indexOf(e.status) > -1);
      if (prod.state === 'same_group') {
        markDuplicate(c, null, 'already_existing', now,
          'Already Existing: production already has these models in one group for this category. This source is kept as additional evidence.');
      } else {
        const approved = existing.find(e => e.polarity === 'positive' && e.status === 'approved');
        const pending = existing.find(e => e.polarity === 'positive' && e.status === 'pending' && e.contentKey !== c.contentKey);
        if (approved) markDuplicate(c, approved.candidateId, 'already_approved', now);
        else if (pending) {
          markDuplicate(c, pending.candidateId, 'same_claim_pending', now);
          env.pendingUpdates.push({ id: pending.candidateId, patch: {
            corroborations: FV.increment(1), updatedAt: now,
            history: FV.arrayUnion({ at: now, by: 'system', action: 'corroborated', note: `same claim from @${c.sourceUsername} (${c.candidateId})` })
          } });
        }
      }
      if (prod.state === 'different_groups') {
        c.conflict = { active: true, type: 'production', withCandidateIds: [],
          note: 'Production has these models in DIFFERENT groups for this category. The catalogue stays authoritative; approving would mean merging groups, which this tool never does.' };
      }
      if (negatives.length) {
        c.conflict = { active: true, type: c.conflict ? 'production_and_source' : 'source',
          withCandidateIds: negatives.map(n => n.candidateId).slice(0, 20),
          note: (c.conflict ? c.conflict.note + ' ' : '') + `${negatives.length} other source statement(s) say these are NOT compatible.` };
        negatives.filter(n => n.status !== 'approved').forEach(n => env.pendingUpdates.push({ id: n.candidateId, patch: {
          conflict: { active: true, type: 'source', withCandidateIds: FV.arrayUnion(c.candidateId), note: 'another source says these ARE compatible' },
          updatedAt: now
        } }));
      }
    } else {
      const positives = existing.filter(e => e.polarity === 'positive' && ['pending', 'approved', 'duplicate'].indexOf(e.status) > -1);
      if (prod.state === 'same_group' || positives.length) {
        c.conflict = {
          active: true, type: prod.state === 'same_group' ? 'production' : 'source',
          withCandidateIds: positives.map(p => p.candidateId).slice(0, 20),
          note: prod.state === 'same_group'
            ? 'This source says NOT compatible; production has them in one group. Production stays as it is unless you change the catalogue.'
            : `${positives.length} other source statement(s) say these ARE compatible.`
        };
        positives.filter(p => p.status === 'pending').forEach(p => env.pendingUpdates.push({ id: p.candidateId, patch: {
          conflict: { active: true, type: 'source', withCandidateIds: FV.arrayUnion(c.candidateId), note: 'another source says these are NOT compatible' },
          reviewSection: 'conflicts', updatedAt: now
        } }));
      } else {
        /* A negative claim with nothing to contradict: kept as evidence, not
           queued — there is nothing to approve. It surfaces as a conflict the
           moment a positive claim for the same pair arrives. */
        c.status = 'resolved';
        c.history.push({ at: now, by: 'system', action: 'resolved', note: 'negative claim recorded as evidence; nothing to approve' });
      }
    }
    c.reviewSection = S.reviewSectionFor(c);
  }
}

function markDuplicate(c, duplicateOf, reason, now, note) {
  c.status = 'duplicate';
  c.duplicateOf = duplicateOf;
  c.duplicateReason = reason;
  c.reviewer = 'system';
  c.history.push({ at: now, by: 'system', action: 'duplicate', note: note || `${reason.replace(/_/g, ' ')}${duplicateOf ? ' — ' + duplicateOf : ''}` });
  c.reviewSection = S.reviewSectionFor(c);
}

/* ========================================================= admin evidence

   WHAT THE API WITHHOLDS, A PERSON CAN SUPPLY

   Meta omits a reel's video whenever its audio is copyrighted, and that is
   most reels. The compatibility list is then on a screen nobody here can
   read — but an admin can watch the reel and screenshot it. Those
   screenshots (or the list typed out) are attached to the post as evidence,
   read by the same OCR and vision, and the post is analysed again through
   exactly the same pipeline.

   This is a person reading content they are entitled to view and recording
   what it says. It is labelled as admin-supplied everywhere it appears, it
   fetches nothing from Instagram, and it is audited. */

const EVIDENCE_MAX_ITEMS = 12;
const EVIDENCE_MAX_PER_CALL = 4;

/**
 * @param {object} args
 * @param {string} args.contentKey
 * @param {Array<{bytes:Buffer, mimeType:string, preview?:string, note?:string}>} [args.images]
 * @param {string} [args.text]      the post's text, typed by the admin
 * @returns {Promise<{ok:true, jobId:string, added:object[], relevance:string, proposals:number, candidates:number}
 *          |{ok:false, status:number, error:string}>}
 */
async function addEvidence({ contentKey, admin, images, text, now, deps = {} }) {
  const cfg = deps.cfg || configMod.load();
  const clock = deps.clock || (() => Date.now());
  const db = fsx.db();
  const contentRef = db.collection(C.INSTAGRAM_CONTENT).doc(contentKey);
  const snap = await contentRef.get();
  if (!snap.exists) return { ok: false, status: 404, error: 'no such content' };
  const content = snap.data();
  const existing = Array.isArray(content.manualEvidence) ? content.manualEvidence : [];
  const list = (images || []).slice(0, EVIDENCE_MAX_PER_CALL);
  const typed = typeof text === 'string' ? text.trim().slice(0, 8000) : '';
  if (!list.length && typed.length < 3) {
    return { ok: false, status: 400, error: 'Add at least one screenshot, or the text shown in the post.' };
  }
  if (existing.length + list.length + (typed ? 1 : 0) > EVIDENCE_MAX_ITEMS) {
    return { ok: false, status: 409, error: `A post holds at most ${EVIDENCE_MAX_ITEMS} pieces of added evidence.` };
  }

  /* An import job of its own, so the run is visible, counted and audited
     like any other. It has one item and nothing to discover. */
  const jobRef = jobs().doc();
  const job = {
    jobId: jobRef.id, sourceKey: content.sourceKey, username: content.username,
    profileUrl: `https://www.instagram.com/${content.username}/`,
    postUrl: content.permalink || null, postShortcode: content.shortcode || null,
    mode: 'evidence', collectionMethod: content.collectionMethod || null, contentKey,
    status: 'processing', statusReason: null, maxItems: 1, processingVersion: S.PROCESSING_VERSION,
    discovery: { cursor: null, pages: 0, found: 1, done: true, attempts: 0 },
    counts: Object.assign(zero(COUNT_KEYS), { postsFound: 1 }), usage: zero(USAGE_KEYS), budget: zero(BUDGET_KEYS), errors: [],
    lease: { owner: null, until: 0 }, resumeAfter: null,
    createdBy: admin.uid, createdByEmail: admin.email || null,
    createdAt: now, updatedAt: now, startedAt: now, finishedAt: null, lastTickAt: now, cancelledBy: null
  };
  await jobRef.set(job);

  const usage = createUsage(cfg, now, job);
  await usage.load();
  const cache = createCache();
  const ai = deps.ai || aiService;
  const media = deps.media || createMediaProcessor({ cfg, ai, fetchImpl: deps.fetchImpl, cache, usage, providers: deps.providers });
  const env = { cfg, clock, media, ai, cache, usage, prodCache: new Map(), matchCache: new Map(), aliasCache: new Map(), evidenceBytes: new Map() };

  const added = [];
  usage.beginItem('evidence');
  for (const img of list) {
    const bytesHash = S.sha256(img.bytes);
    const id = bytesHash.slice(0, 16);
    if (existing.some(e => e.id === id) || added.some(e => e.id === id)) continue;   /* the same screenshot twice */
    const entry = {
      id, kind: 'image', bytesHash, text: '', confidence: null, engine: null, readBy: null,
      status: 'unread', reason: null, note: img.note ? String(img.note).slice(0, 200) : null, hasPreview: false,
      addedBy: admin.uid, addedByEmail: admin.email || null, addedAt: now
    };
    const ocr = await media.ocrImage({ mediaId: 'evidence:' + id, bytes: img.bytes, mimeType: img.mimeType });
    const ocrText = ocr.status === 'ok' && ocr.text ? ocr.text : '';
    if (ocrText.trim()) {
      Object.assign(entry, { text: ocrText, confidence: ocr.confidence == null ? null : ocr.confidence,
                             engine: ocr.engine || null, readBy: 'ocr', status: 'read' });
    } else {
      entry.reason = ocr.reason || (ocr.status === 'ok' ? 'No text was found in the image.' : ocr.status);
    }
    if (media.understandImage && cfg.visionProvider !== 'none') {
      const v = await media.understandImage({ mediaId: 'evidence:' + id, bytes: img.bytes, mimeType: img.mimeType, ocrText });
      if (v.status === 'ok') {
        entry.contentClass = v.contentClass || null;
        /* a screenshot may hold more than one list: all of them, as one text */
        const segs = visionSegments(v, 'evidence:' + id, ocrText);
        const seg = segs.length ? { text: segs.map(x => x.text).join('\n\n'), confidence: Math.min.apply(null, segs.map(x => x.confidence)) } : null;
        if (v.confidence != null) entry.aiConfidence = v.confidence;
        if (seg && !ocrText.trim()) {
          Object.assign(entry, { text: seg.text, confidence: seg.confidence, engine: v.engine || null, readBy: 'vision', status: 'read', reason: null });
        } else if (seg) {
          Object.assign(entry, { visionText: seg.text, visionConfidence: seg.confidence, visionEngine: v.engine || null });
        }
      } else if (!entry.text) {
        entry.reason = [entry.reason, v.reason].filter(Boolean).join(' ');
      }
    }
    env.evidenceBytes.set('evidence:' + id, { bytes: img.bytes, mimeType: img.mimeType });
    if (img.preview) {
      await cache.put('prev_' + id, { preview: img.preview });
      entry.hasPreview = true;
    }
    added.push(entry);
  }
  if (typed) {
    const id = S.sha256(typed).slice(0, 16);
    if (!existing.some(e => e.id === id)) {
      added.push({ id, kind: 'text', text: typed, confidence: null, engine: null, readBy: 'admin', status: 'read',
                   reason: null, addedBy: admin.uid, addedByEmail: admin.email || null, addedAt: now });
    }
  }

  const all = existing.concat(added);
  await contentRef.set({ manualEvidence: all, updatedAt: now }, { merge: true });

  let result = null;
  let failure = null;
  try {
    if (added.some(e => e.status === 'read')) {
      result = await reanalyse({ content: Object.assign({}, content, { manualEvidence: all }), job, env });
    }
  } catch (err) {
    failure = String(err && err.message).slice(0, 300);
    console.error('[instagram] evidence analysis failed', { contentKey, message: failure });
  } finally {
    await usage.flush(jobRef);
    const t = clock();
    await jobRef.set({
      status: failure ? 'failed' : 'completed', finishedAt: t, updatedAt: t, lastTickAt: t,
      statusReason: failure ? 'The evidence was saved, but analysing it failed: ' + failure
        : result ? null : 'Nothing in the added evidence could be read, so the post was not analysed again.',
      lease: { owner: null, until: 0 }
    }, { merge: true });
  }
  if (failure) return { ok: false, status: 500, error: 'The evidence was saved, but analysing it failed. Open the import job for details.' };

  return {
    ok: true, jobId: job.jobId, contentKey,
    added: added.map(e => ({ id: e.id, kind: e.kind, status: e.status, readBy: e.readBy, reason: e.reason, chars: (e.text || '').length })),
    analysed: !!result,
    relevance: result ? result.relevance : content.relevance || null,
    extractionId: result ? result.extractionId : null,
    proposals: result ? result.proposals : 0, candidates: result ? result.candidates : 0
  };
}

/**
 * The stored post, analysed again from the text already read out of it plus
 * the admin's evidence. No media is fetched: Instagram's media links expire,
 * and what they held is in the last extraction.
 */
async function reanalyse({ content, job, env }) {
  const db = fsx.db();
  const now = env.clock();
  const latest = content.latestVersion
    ? await db.collection(C.INSTAGRAM_EXTRACTIONS).doc(S.extractionIdFor(content.contentKey, content.latestVersion)).get()
    : null;
  const texts = latest && latest.exists ? latest.data().texts || {} : {};
  const manual = content.collectionMethod === 'manual_admin_entry';
  const mine = s => s && s.text && String(s.ref || '').indexOf('evidence:') !== 0;

  const segments = [];
  if (content.caption && String(content.caption).trim()) {
    segments.push({ source: manual ? 'manual' : 'caption', ref: null, text: content.caption, confidence: null });
  }
  [['ocr', 'ocr'], ['vision', 'vision'], ['frames', 'frame']].forEach(([field, source]) => {
    (texts[field] || []).filter(mine).forEach(s => segments.push({ source, ref: s.ref || null, text: s.text, confidence: s.confidence == null ? null : s.confidence }));
  });
  if (texts.transcript) segments.push({ source: 'transcript', ref: content.mediaId || null, text: texts.transcript, confidence: null });

  const item = {
    itemKey: 'evidence', order: 0, attempts: 1, manual,
    contentKey: content.contentKey, mediaId: content.mediaId || null, permalink: content.permalink || null,
    shortcode: content.shortcode || null, contentType: content.contentType, mediaType: content.mediaType || null,
    productType: content.productType || null, caption: content.caption || '', captionHash: content.captionHash,
    signature: content.signature, publishedAt: content.publishedAt || null, mediaUrlOmitted: !!content.mediaUrlOmitted
  };
  await items(job.jobId).doc('evidence').set(Object.assign({ status: 'processing', createdAt: now, updatedAt: now }, item));

  const mediaItems = (content.mediaItems || []).filter(m => m.kind !== 'evidence')
    .concat((content.manualEvidence || []).filter(e => e.kind === 'image').map(e => ({
      mediaId: 'evidence:' + e.id, kind: 'evidence', ocrStatus: e.status === 'read' ? 'ok' : 'unavailable',
      reason: e.reason || null, engine: e.engine || null, readBy: e.readBy || null, bytesHash: e.bytesHash || null,
      addedByEmail: e.addedByEmail || null, hasPreview: !!e.hasPreview,
      vision: e.contentClass ? { status: 'ok', contentClass: e.contentClass } : undefined
    })));

  const scores = (content.manualEvidence || []).map(e => e.aiConfidence).filter(v => v != null);
  return analyseAndPersist({
    job, item, env, prior: content, segments, mediaItems,
    inc: zero(['captionsProcessed', 'imagesOcrd', 'imagesUnderstood', 'framesProcessed', 'transcripts']),
    duplicate: null, gate: content.captionGate || null, providers: content.providers || null, bump: true,
    candidate: { score: 9, tier: 'HIGH', reasons: [{ signal: 'evidence added by an admin', weight: 9 }] },
    trace: [{ stage: 'INGESTED' }, { stage: 'CHEAP_FILTERED', detail: 'HIGH (evidence added by an admin)' }],
    aiConfidence: scores.length ? Math.min.apply(null, scores) : null
  });
}

/** One stored evidence preview, for the review card. */
async function evidencePreview(id) {
  const value = await createCache().get('prev_' + String(id).replace(/[^a-f0-9]/g, ''));
  return value && typeof value.preview === 'string' ? value.preview : null;
}

/* ======================================================= resume / retry */

async function resume({ jobId, admin, now }) {
  const db = fsx.db();
  const ref = jobs().doc(jobId);
  const result = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, status: 404, error: 'no such job' };
    const job = snap.data();
    if (S.RESUMABLE.indexOf(job.status) < 0) return { ok: false, status: 409, error: `a ${job.status.replace(/_/g, ' ')} job cannot be resumed` };
    if (job.status === 'rate_limited' && job.resumeAfter && job.resumeAfter > now) {
      return { ok: false, status: 409, error: 'Instagram asked for a pause until ' + new Date(job.resumeAfter).toISOString() + '. Resuming earlier would ignore its rate limit.' };
    }
    tx.update(ref, {
      status: job.discovery && job.discovery.done ? 'processing' : 'discovering',
      statusReason: null, lease: { owner: null, until: 0 }, resumeAfter: null, finishedAt: null,
      'discovery.attempts': 0, updatedAt: now,
      resumedAt: now, resumedBy: admin.uid,
      /* resuming is a person deciding to spend again: the sync's AI budget
         starts over. The totals in `usage` do not. */
      budget: zero(BUDGET_KEYS), budgetResets: (Number(job.budgetResets) || 0) + 1
    });
    return { ok: true, job };
  });
  if (!result.ok) return result;
  /* Anything left mid-processing by a crashed tick goes back to the queue,
     and so does everything that was waiting for an AI budget. */
  let requeued = 0;
  for (const status of ['processing', 'deferred_ai']) {
    const stuck = await items(jobId).where('status', '==', status).limit(400).get();
    if (stuck.empty) continue;
    const batch = db.batch();
    stuck.docs.forEach(d => batch.set(d.ref, { status: 'queued', updatedAt: now }, { merge: true }));
    /* "queued for AI" counts what is waiting NOW, not what ever waited */
    if (status === 'deferred_ai') batch.update(ref, { 'counts.aiDeferred': fsx.FieldValue().increment(-stuck.size) });
    await batch.commit();
    requeued += stuck.size;
  }
  return { ok: true, requeued };
}

/**
 * "Continue": a scanned job starts its analysis. The posts were listed and
 * scored for free; from here the pipeline may spend, within its budget.
 */
async function continueJob({ jobId, admin, now }) {
  const db = fsx.db();
  const ref = jobs().doc(jobId);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, status: 404, error: 'no such job' };
    const job = snap.data();
    if (job.status !== 'scanned') return { ok: false, status: 409, error: `a ${String(job.status).replace(/_/g, ' ')} job has nothing to continue` };
    tx.update(ref, {
      status: 'processing', statusReason: null, lease: { owner: null, until: 0 },
      continuedAt: now, continuedBy: admin.uid, updatedAt: now
    });
    return { ok: true, job: Object.assign({}, job, { status: 'processing' }) };
  });
}

async function retryFailed({ jobId, admin, now }) {
  const db = fsx.db();
  const FV = fsx.FieldValue();
  const ref = jobs().doc(jobId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, status: 404, error: 'no such job' };
  const job = snap.data();
  if (job.status === 'cancelled' || job.status === 'unable_to_collect') {
    return { ok: false, status: 409, error: `a ${job.status.replace(/_/g, ' ')} job cannot be retried` };
  }
  const failed = await items(jobId).where('status', '==', 'failed').limit(400).get();
  if (failed.empty) return { ok: true, requeued: 0 };
  const batch = db.batch();
  failed.docs.forEach(d => batch.set(d.ref, { status: 'queued', attempts: 0, retriedAt: now, retriedBy: admin.uid, updatedAt: now }, { merge: true }));
  batch.update(ref, {
    status: 'processing', statusReason: null, finishedAt: null, lease: { owner: null, until: 0 },
    'counts.failed': FV.increment(-failed.size), updatedAt: now
  });
  await batch.commit();
  return { ok: true, requeued: failed.size };
}

async function cancel({ jobId, admin, now }) {
  const db = fsx.db();
  const ref = jobs().doc(jobId);
  const result = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, status: 404, error: 'no such job' };
    const job = snap.data();
    if (S.TERMINAL.indexOf(job.status) > -1) return { ok: false, status: 409, error: `the job is already ${job.status.replace(/_/g, ' ')}` };
    tx.update(ref, { status: 'cancelled', statusReason: 'cancelled by an administrator', cancelledBy: admin.uid,
                     finishedAt: now, lease: { owner: null, until: 0 }, updatedAt: now });
    return { ok: true };
  });
  if (!result.ok) return result;
  const queued = await items(jobId).where('status', '==', 'queued').limit(450).get();
  if (!queued.empty) {
    const batch = db.batch();
    queued.docs.forEach(d => batch.set(d.ref, { status: 'cancelled', updatedAt: now }, { merge: true }));
    await batch.commit();
  }
  return { ok: true, cancelledItems: queued.size };
}

/* ================================================================ reading */

async function getJob(jobId, { itemLimit = 60, itemStatus = null } = {}) {
  const snap = await jobs().doc(jobId).get();
  if (!snap.exists) return null;
  let q = items(jobId);
  if (itemStatus) q = q.where('status', '==', itemStatus);
  const list = await q.orderBy('order', 'asc').limit(Math.min(200, itemLimit)).get();
  return {
    job: snap.data(),
    items: list.docs.map(d => {
      const i = d.data();
      return {
        itemKey: i.itemKey, order: i.order, status: i.status, attempts: i.attempts || 0,
        contentKey: i.contentKey, permalink: i.permalink, contentType: i.contentType,
        publishedAt: i.publishedAt || null, captionPreview: String(i.caption || '').slice(0, 160),
        lastError: i.lastError || null, result: i.result || null, mediaUrlOmitted: !!i.mediaUrlOmitted,
        pipelineState: i.pipelineState || null,
        /* the free scan's verdict, and a picture to recognise the post by
           (an Instagram CDN link; it expires, and is never stored elsewhere) */
        scan: i.scan || null,
        previewUrl: i.thumbnailUrl || (i.contentType === 'image' ? i.mediaUrl : null) ||
          ((i.children || []).find(c => c.mediaType !== 'VIDEO') || {}).mediaUrl || null
      };
    })
  };
}

async function listJobs({ sourceKey, status, from, to, limit = 50 } = {}) {
  let q = jobs();
  if (sourceKey) q = q.where('sourceKey', '==', sourceKey);
  else if (status) q = q.where('status', '==', status);
  const snap = await q.orderBy('createdAt', 'desc').limit(Math.min(200, limit * (from || to || (sourceKey && status) ? 4 : 1))).get();
  let rows = snap.docs.map(d => d.data());
  const approximate = !!(from || to || (sourceKey && status));
  if (sourceKey && status) rows = rows.filter(r => r.status === status);
  if (from) rows = rows.filter(r => r.createdAt >= from);
  if (to) rows = rows.filter(r => r.createdAt <= to);
  return { jobs: rows.slice(0, limit).map(publicJob), approximate };
}

function publicJob(j) {
  return {
    jobId: j.jobId, sourceKey: j.sourceKey, username: j.username, profileUrl: j.profileUrl, postUrl: j.postUrl,
    mode: j.mode, collectionMethod: j.collectionMethod, status: j.status, statusReason: j.statusReason,
    maxItems: j.maxItems, discovery: j.discovery, counts: j.counts, usage: j.usage,
    errorCount: (j.errors || []).length, errors: (j.errors || []).slice(-20),
    createdBy: j.createdBy, createdByEmail: j.createdByEmail, createdAt: j.createdAt, updatedAt: j.updatedAt,
    startedAt: j.startedAt, finishedAt: j.finishedAt, lastTickAt: j.lastTickAt, resumeAfter: j.resumeAfter,
    leaseActive: !!(j.lease && j.lease.owner && j.lease.until > Date.now()),
    processingVersion: j.processingVersion,
    budget: j.budget || null, forceDeep: !!j.forceDeep, contentKey: j.contentKey || null,
    scanFirst: !!j.scanFirst, autoApply: !!j.autoApply, continuedAt: j.continuedAt || null
  };
}

/* ================================================================ usage */

function createUsage(cfg, now, job) {
  const day = S.usageDay(now);
  const ref = () => fsx.db().collection(C.INSTAGRAM_USAGE_DAILY).doc(day);
  const caps = { graph: cfg.dailyGraphCalls, ocr: cfg.dailyOcrCalls, ai: cfg.dailyAiCalls, video: cfg.dailyVideoCalls };
  const field = { graph: 'graphCalls', ocr: 'ocrCalls', ai: 'aiCalls', video: 'videoCalls', cacheHit: 'cacheHits' };
  let stored = {};
  const local = zero(USAGE_KEYS);
  /* this sync's budget: what earlier ticks spent, and what this one has */
  const spent = Object.assign(zero(BUDGET_KEYS), job && job.budget ? job.budget : {});
  const mine = zero(BUDGET_KEYS);
  const used = k => (Number(spent[k]) || 0) + mine[k];
  let currentItem = null;
  const counted = new Set();
  return {
    async load() {
      try { const s = await ref().get(); stored = s.exists ? s.data() : {}; } catch { stored = {}; }
    },
    /** the DAILY caps */
    allow(kind) {
      if (!(kind in caps)) return true;
      return (Number(stored[field[kind]]) || 0) + local[field[kind]] < caps[kind];
    },
    record(kind, n = 1) { if (field[kind]) local[field[kind]] += n; },
    beginItem(key) { currentItem = key; },
    /** the budget of THIS SYNC — INSTAGRAM_MAX_*_PER_SYNC */
    budgetAllow(kind, amount) {
      if (currentItem && !counted.has(currentItem) && used('aiItems') >= cfg.maxAiItemsPerSync) return false;
      if (kind === 'gemini') return used('geminiCalls') < cfg.maxGeminiCallsPerSync;
      if (kind === 'claude') return used('claudeCalls') < cfg.maxClaudeCallsPerSync;
      if (kind === 'videoSeconds') {
        const limit = cfg.maxVideoMinutesPerSync * 60;
        return limit > 0 && used('videoSeconds') + (Number(amount) || 0) <= limit;
      }
      return true;
    },
    /** one model call: who, which model, how many tokens, what it is estimated to cost */
    recordAi({ provider, stage, model, usage: u }) {
      local.aiCalls++;
      if (currentItem && !counted.has(currentItem)) { counted.add(currentItem); mine.aiItems++; }
      const tin = u ? Number(u.inputTokens) || 0 : 0;
      const tout = u ? Number(u.outputTokens) || 0 : 0;
      if (provider === 'claude') {
        local.claudeCalls++; mine.claudeCalls++;
        local.claudeInputTokens += tin; local.claudeOutputTokens += tout;
      } else {
        local.geminiCalls++; mine.geminiCalls++;
        if (stage === 'screen' || stage === 'video_screen') local.screenCalls++;
        local.geminiInputTokens += tin; local.geminiOutputTokens += tout;
      }
      const cost = u && model ? estimateCost(model, u, cfg.prices) : null;
      /* a call whose model has no price is counted as such — never as free */
      if (cost == null) { if (u) local.costUnknownCalls++; }
      else local.costMicroUsd += cost;
    },
    addVideoSeconds(n) {
      const v = Math.max(0, Math.round(Number(n) || 0));
      local.videoSeconds += v; mine.videoSeconds += v;
    },
    async flush(jobRef) {
      const FV = fsx.FieldValue();
      const dayPatch = { day, updatedAt: Date.now() };
      const jobPatch = {};
      const srcUsage = {};
      USAGE_KEYS.forEach(k => {
        if (!local[k]) return;
        dayPatch[k] = FV.increment(local[k]);
        jobPatch['usage.' + k] = FV.increment(local[k]);
        srcUsage[k] = FV.increment(local[k]);
      });
      BUDGET_KEYS.forEach(k => { if (mine[k]) jobPatch['budget.' + k] = FV.increment(mine[k]); });
      if (Object.keys(jobPatch).length) {
        if (Object.keys(srcUsage).length) {
          await ref().set(dayPatch, { merge: true });
          /* the page's running total: what reading it has cost so far */
          if (job && job.sourceKey) {
            await fsx.db().collection(C.INSTAGRAM_SOURCES).doc(job.sourceKey).set({ usage: srcUsage }, { merge: true }).catch(() => null);
          }
        }
        await jobRef.update(jobPatch);
      }
      USAGE_KEYS.forEach(k => { local[k] = 0; });
      BUDGET_KEYS.forEach(k => { spent[k] = used(k); mine[k] = 0; });
    },
    snapshot() { return { day, stored, local: Object.assign({}, local), caps, budget: BUDGET_KEYS.reduce((o, k) => { o[k] = used(k); return o; }, {}) }; }
  };
}

function createCache() {
  const col = () => fsx.db().collection(C.INSTAGRAM_MEDIA_CACHE);
  const safe = k => String(k).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 140);
  return {
    async get(key) {
      try { const s = await col().doc(safe(key)).get(); return s.exists ? s.data().value : null; } catch { return null; }
    },
    async put(key, value) {
      try { await col().doc(safe(key)).set({ key: safe(key), value, createdAt: Date.now(), processingVersion: S.PROCESSING_VERSION }); }
      catch (err) { console.warn('[instagram] cache write failed', err && err.message); }
    }
  };
}

module.exports = {
  COUNT_KEYS, USAGE_KEYS, BUDGET_KEYS, createJob, tick, resume, continueJob, retryFailed, cancel, getJob, listJobs, publicJob,
  addEvidence, evidencePreview,
  createUsage, createCache,
  /* exported for tests */
  _internal: { processItem, analyseAndPersist, dedupeAndConflicts, dedupeProposals, mergeAi, discoverStep, visionSegments, validateProposals, providerFingerprint }
};
