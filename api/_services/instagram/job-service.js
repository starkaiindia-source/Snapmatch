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
const taxonomy = require('../taxonomy-service');
const aiService = require('../ai-service');

const COUNT_KEYS = [
  'postsFound', 'imagesFound', 'carouselsFound', 'videosFound',
  'processed', 'unchanged', 'failed',
  'captionsProcessed', 'imagesOcrd', 'framesProcessed', 'transcripts',
  'modelReferences', 'matched', 'unmatched', 'ambiguous',
  'relationships', 'readyForApproval', 'needsReview', 'pendingReview',
  'duplicates', 'conflicts', 'rejected', 'approved', 'appliedToProduction'
];
const USAGE_KEYS = ['graphCalls', 'ocrCalls', 'aiCalls', 'videoCalls', 'cacheHits'];

function zero(keys) { const o = {}; keys.forEach(k => { o[k] = 0; }); return o; }

const jobs = () => fsx.db().collection(C.INSTAGRAM_IMPORT_JOBS);
const items = jobId => jobs().doc(jobId).collection(C.INSTAGRAM_JOB_ITEMS);

/* ================================================================= create */

/**
 * @returns {Promise<{ok:true, job:object}|{ok:false, status:number, error:string}>}
 */
async function createJob({ admin, profileUrl, postUrl, maxItems, mode, manualText, now, deps = {} }) {
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
  const usage = createUsage(cfg, clock(), job);
  await usage.load();
  const cache = createCache();
  const graph = deps.graph || createGraphClient(Object.assign({}, cfg.graph, {
    fetchImpl: deps.fetchImpl, onCall: kind => usage.record(kind)
  }));
  const ai = deps.ai || aiService;
  const media = deps.media || createMediaProcessor({ cfg, ai, fetchImpl: deps.fetchImpl, cache, usage });
  const env = { cfg, clock, graph, media, ai, cache, usage, prodCache: new Map(), matchCache: new Map(), aliasCache: new Map() };

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
        const failed = await items(job.jobId).where('status', '==', 'failed').limit(1).get();
        job.status = failed.empty ? 'completed' : 'completed_with_errors';
        job.statusReason = failed.empty ? null : 'Some items failed after every retry. Use "Retry failed" or "View errors".';
        job.finishedAt = clock();
        stop = 'finished';
        break;
      }
      job.status = 'processing';
      const item = next.docs[0].data();
      const outcome = await processItemSafely(job, item, env, errors);
      steps++;
      if (outcome === 'deferred') {
        job.status = 'quota_exhausted';
        job.statusReason = 'A daily OCR / AI / video cap was reached. Resume the job tomorrow, or raise the cap.';
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
    const inc = zero(['postsFound', 'imagesFound', 'carouselsFound', 'videosFound']);
    for (const m of page.media) {
      if (job.discovery.found >= job.maxItems) break;
      if (job.postShortcode && m.shortcode !== job.postShortcode) continue;
      const mediaIds = [m.mediaId].concat(m.children.map(c => c.mediaId));
      batch.set(items(job.jobId).doc(m.mediaId), {
        itemKey: m.mediaId, order: job.discovery.found, status: 'queued', attempts: 0,
        mediaId: m.mediaId, contentKey: S.contentKeyFor({ mediaId: m.mediaId }), manual: false,
        permalink: m.permalink, shortcode: m.shortcode,
        contentType: m.contentType, mediaType: m.mediaType, productType: m.productType,
        caption: String(m.caption || '').slice(0, 5000), captionHash: S.captionHash(m.caption),
        signature: S.contentSignature({ caption: m.caption, mediaType: m.mediaType, mediaIds }),
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
    const exhausted = !page.nextCursor || job.discovery.pages >= cfg.maxDiscoveryPages;
    if (job.discovery.found >= job.maxItems || exhausted || (job.postShortcode && job.discovery.found > 0)) {
      job.discovery.done = true;
      job.status = 'processing';
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
    return job.status === 'unable_to_collect' ? 'unable' : null;
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
    if (final) await jobs().doc(job.jobId).update({ 'counts.failed': FV.increment(1), updatedAt: now });
    return final ? 'failed' : 'retry';
  }
}

/**
 * One content item, end to end. Throws on an unexpected failure (the caller
 * counts the attempt); returns 'deferred' when a daily cap stopped it.
 */
async function processItem(job, item, env) {
  const { cfg, media, clock } = env;
  const db = fsx.db();
  const FV = fsx.FieldValue();
  const now = clock();
  const itemRef = items(job.jobId).doc(item.itemKey);
  const jobRef = jobs().doc(job.jobId);

  await itemRef.set({ status: 'processing', attempts: (item.attempts || 0) + 1, updatedAt: now }, { merge: true });

  /* ---- change detection, before anything that costs money ---- */
  const contentRef = db.collection(C.INSTAGRAM_CONTENT).doc(item.contentKey);
  const priorSnap = await contentRef.get();
  const prior = priorSnap.exists ? priorSnap.data() : null;
  if (prior && prior.signature === item.signature && prior.processingVersion === S.PROCESSING_VERSION && prior.latestVersion) {
    await itemRef.set({
      status: 'skipped_unchanged', processedAt: now, updatedAt: now,
      result: { version: prior.latestVersion, note: 'identical content already processed by this processing version — no OCR or AI call made' }
    }, { merge: true });
    await contentRef.set({ lastSeenAt: now, lastSeenJobId: job.jobId }, { merge: true });
    await jobRef.update({ 'counts.unchanged': FV.increment(1), 'counts.processed': FV.increment(1), updatedAt: now });
    return { outcome: 'unchanged' };
  }

  /* ---- a repost: same caption under another content key ---- */
  let duplicateOf = null;
  if (S.normaliseCaption(item.caption).length >= 40) {
    const same = await db.collection(C.INSTAGRAM_CONTENT).where('captionHash', '==', item.captionHash).limit(3).get();
    const other = same.docs.find(d => d.id !== item.contentKey);
    if (other) duplicateOf = other.id;
  }

  /* ---- text out of every medium ---- */
  const segments = [];
  const mediaItems = [];
  const inc = zero(['captionsProcessed', 'imagesOcrd', 'framesProcessed', 'transcripts']);
  let deferredReason = null;

  if (item.caption && item.caption.trim()) {
    segments.push({ source: item.manual ? 'manual' : 'caption', ref: null, text: item.caption, confidence: null });
    inc.captionsProcessed++;
  }

  const image = async (mediaId, url) => {
    const r = await media.ocrImage({ mediaId, mediaUrl: url });
    mediaItems.push({
      mediaId, kind: 'image', ocrStatus: r.status, reason: r.reason || null, engine: r.engine || null,
      bytesHash: r.bytesHash || null, cached: !!r.cached, ocrConfidence: r.confidence == null ? null : r.confidence,
      textChars: r.text ? r.text.length : 0, previewUrl: url || null, previewUrlExpires: true
    });
    if (r.status === 'deferred') deferredReason = r.reason;
    if (r.status === 'ok' && r.text && r.text.trim()) {
      segments.push({ source: 'ocr', ref: mediaId, text: r.text, confidence: r.confidence == null ? null : r.confidence });
      inc.imagesOcrd++;
    }
  };
  const video = async (mediaId, url, thumb) => {
    const r = await media.analyzeVideo({ mediaId, mediaUrl: url, thumbnailUrl: thumb });
    mediaItems.push({
      mediaId, kind: 'video', ocrStatus: r.status, reason: r.reason || null, engine: r.engine || null,
      cached: !!r.cached, keyFrames: (r.frames || []).length, sampledFrames: r.sampledFrames || null,
      transcript: !!(r.transcript && r.transcript.text), previewUrl: thumb || null, previewUrlExpires: true
    });
    if (r.status === 'deferred') deferredReason = r.reason;
    (r.frames || []).forEach(f => {
      segments.push({ source: 'frame', ref: `${mediaId}@${f.timeMs}ms`, text: f.text, confidence: f.confidence == null ? null : f.confidence });
    });
    inc.framesProcessed += (r.frames || []).length;
    if (r.transcript && r.transcript.text && r.transcript.text.trim()) {
      segments.push({ source: 'transcript', ref: mediaId, text: r.transcript.text, confidence: null });
      inc.transcripts++;
    }
  };

  if (item.contentType === 'image') await image(item.mediaId, item.mediaUrl);
  else if (item.contentType === 'video' || item.contentType === 'reel') await video(item.mediaId, item.mediaUrl, item.thumbnailUrl);
  else if (item.contentType === 'carousel') {
    /* Each child is read on its own; the analysis below is over all of them. */
    for (const child of (item.children || []).slice(0, cfg.maxCarouselChildren)) {
      if (child.mediaType === 'VIDEO') await video(child.mediaId, child.mediaUrl, child.thumbnailUrl);
      else await image(child.mediaId, child.mediaUrl);
      if (deferredReason) break;
    }
  }

  if (deferredReason) {
    /* Not a failure, and not an attempt: the item waits for tomorrow's cap. */
    await itemRef.set({ status: 'queued', attempts: item.attempts || 0, lastError: deferredReason, updatedAt: clock() }, { merge: true });
    return { outcome: 'deferred' };
  }

  /* ---- extraction + matching ---- */
  const det = extractor.extractDeterministic(segments);
  await prefetchAliases(det, env);
  const resolve = (text, brandHint) => resolveCached(text, brandHint, env);
  const refs = det.references.map(r => Object.assign({}, r, { match: resolve(r.text, r.brandHint) }));
  const rulesRels = det.relationships.map(r => Object.assign({}, r, {
    sourceMatch: resolve(r.sourceText, r.sourceBrandHint),
    compatibleMatch: resolve(r.compatibleText, r.compatibleBrandHint)
  }));

  const aiResult = await maybeAi({ det, refs, segments, env });
  const relationships = mergeAi(rulesRels, aiResult.valid, segments, det.brandHint, env);

  /* ---- versioning: a changed post is a new version, never an overwrite ---- */
  const version = (prior && prior.latestVersion ? prior.latestVersion : 0) +
    (prior && prior.signature === item.signature && prior.processingVersion === S.PROCESSING_VERSION ? 0 : 1);
  const extractionId = S.extractionIdFor(item.contentKey, version);

  const content = {
    contentKey: item.contentKey, mediaId: item.mediaId, permalink: item.permalink,
    contentType: item.contentType, publishedAt: item.publishedAt || null,
    collectionMethod: job.collectionMethod || (item.manual ? 'manual_admin_entry' : null)
  };
  const built = buildCandidates({
    relationships, aiRejected: aiResult.rejected, references: refs, segments,
    ctx: { job, content, extractionId, version, now: clock(), aiModel: aiResult.model }
  });

  await dedupeAndConflicts(built.candidates, env);

  /* ---- persist ---- */
  const t = clock();
  const bytesHashes = mediaItems.map(m => m.bytesHash).filter(Boolean).sort();
  const versions = (prior && Array.isArray(prior.versions) ? prior.versions : []).filter(x => x.version !== version);
  versions.push({ version, signature: item.signature, captionHash: item.captionHash, processingVersion: S.PROCESSING_VERSION, processedAt: t, jobId: job.jobId });

  const writes = [];
  writes.push([contentRef, {
    contentKey: item.contentKey, sourceKey: job.sourceKey, username: job.username,
    mediaId: item.mediaId || null, shortcode: item.shortcode || null, permalink: item.permalink || null,
    contentType: item.contentType, mediaType: item.mediaType || null, productType: item.productType || null,
    publishedAt: item.publishedAt || null,
    caption: String(item.caption || '').slice(0, 5000), captionHash: item.captionHash,
    signature: item.signature,
    contentHash: S.sha256(item.captionHash + '|' + bytesHashes.join(',')),
    hashtags: det.hashtags,
    collectionMethod: content.collectionMethod,
    collectedAt: prior && prior.collectedAt ? prior.collectedAt : t,
    lastSeenAt: t, lastSeenJobId: job.jobId,
    mediaItems, mediaUrlOmitted: !!item.mediaUrlOmitted,
    duplicateOf, duplicateStatus: duplicateOf ? 'same_caption_as:' + duplicateOf : 'unique',
    latestVersion: version, processingVersion: S.PROCESSING_VERSION,
    versions: versions.slice(-20),
    processingStatus: 'processed', updatedAt: t
  }, { merge: true }]);

  writes.push([db.collection(C.INSTAGRAM_EXTRACTIONS).doc(extractionId), {
    extractionId, contentKey: item.contentKey, sourceKey: job.sourceKey, username: job.username, jobId: job.jobId,
    version, processingVersion: S.PROCESSING_VERSION, extractedAt: t,
    contentType: item.contentType, permalink: item.permalink || null,
    texts: {
      caption: String(item.caption || '').slice(0, 5000),
      ocr: segments.filter(s => s.source === 'ocr').map(s => ({ ref: s.ref, text: s.text.slice(0, 4000), confidence: s.confidence })),
      frames: segments.filter(s => s.source === 'frame').slice(0, 30).map(s => ({ ref: s.ref, text: s.text.slice(0, 2000), confidence: s.confidence })),
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
    ai: aiResult.info,
    warnings: det.warnings,
    candidateIds: built.candidates.map(c => c.candidateId).slice(0, 300),
    stats: built.stats
  }]);

  built.candidates.forEach(c => writes.push([db.collection(C.COMPATIBILITY_CANDIDATES).doc(c.candidateId), c]));
  built.evidence.forEach(e => {
    const cand = built.candidates.find(c => c.candidateId === e.candidateId);
    writes.push([db.collection(C.COMPATIBILITY_EVIDENCE).doc(e.evidenceId), Object.assign(e, {
      candidateStatus: cand ? cand.status : null, duplicateOf: cand ? cand.duplicateOf : null
    })]);
  });
  (env.pendingUpdates || []).forEach(u => writes.push([db.collection(C.COMPATIBILITY_CANDIDATES).doc(u.id), u.patch, { merge: true }]));
  env.pendingUpdates = [];

  /* the previous version's open candidates are superseded, not deleted */
  if (prior && prior.latestVersion && version > prior.latestVersion) {
    const old = await db.collection(C.COMPATIBILITY_CANDIDATES).where('contentKey', '==', item.contentKey)
      .where('status', '==', 'pending').limit(200).get();
    old.docs.filter(d => (d.data().contentVersion || 0) < version).forEach(d => {
      writes.push([d.ref, {
        status: 'superseded', reviewSection: 'closed', updatedAt: t,
        history: FV.arrayUnion({ at: t, by: 'system', action: 'superseded', note: `content changed; see version ${version}` })
      }, { merge: true }]);
    });
  }

  const counts = tallies(built.candidates, refs);
  const jobPatch = { updatedAt: t, 'counts.processed': FV.increment(1) };
  Object.assign(counts, inc);
  Object.keys(counts).forEach(k => { if (counts[k]) jobPatch['counts.' + k] = FV.increment(counts[k]); });
  writes.push([jobRef, jobPatch, 'update']);
  writes.push([itemRef, {
    status: 'done', processedAt: t, updatedAt: t, lastError: null,
    result: { version, extractionId, candidates: built.candidates.length, references: refs.length,
              relationships: built.stats.relationships, aiUsed: aiResult.info.used, duplicateOf }
  }, { merge: true }]);

  await commitInBatches(writes);
  return { outcome: 'done' };
}

function tallies(candidates, refs) {
  const nonHashtag = refs.filter(r => !r.fromHashtag);
  const t = {
    modelReferences: nonHashtag.length,
    matched: nonHashtag.filter(r => r.match.status === 'matched').length,
    unmatched: nonHashtag.filter(r => r.match.status === 'unmatched').length,
    ambiguous: nonHashtag.filter(r => r.match.status === 'ambiguous').length,
    /* every relationship detected, duplicates included; AI claims that failed
       validation are counted under "rejected", not here */
    relationships: candidates.filter(c => c.kind === 'relationship' && !(c.status === 'rejected' && c.reviewer === 'system')).length,
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
      resumedAt: now, resumedBy: admin.uid
    });
    return { ok: true, job };
  });
  if (!result.ok) return result;
  /* Anything left mid-processing by a crashed tick goes back to the queue. */
  const stuck = await items(jobId).where('status', '==', 'processing').limit(400).get();
  if (!stuck.empty) {
    const batch = db.batch();
    stuck.docs.forEach(d => batch.set(d.ref, { status: 'queued', updatedAt: now }, { merge: true }));
    await batch.commit();
  }
  return { ok: true, requeued: stuck.size };
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
        lastError: i.lastError || null, result: i.result || null, mediaUrlOmitted: !!i.mediaUrlOmitted
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
    processingVersion: j.processingVersion
  };
}

/* ================================================================ usage */

function createUsage(cfg, now, job) {
  const day = S.usageDay(now);
  const ref = () => fsx.db().collection(C.INSTAGRAM_USAGE_DAILY).doc(day);
  const caps = { graph: cfg.dailyGraphCalls, ocr: cfg.dailyOcrCalls, ai: cfg.dailyAiCalls, video: cfg.dailyVideoCalls };
  const field = { graph: 'graphCalls', ocr: 'ocrCalls', ai: 'aiCalls', video: 'videoCalls', cacheHit: 'cacheHits' };
  let stored = {};
  const local = { graph: 0, ocr: 0, ai: 0, video: 0, cacheHit: 0 };
  return {
    async load() {
      try { const s = await ref().get(); stored = s.exists ? s.data() : {}; } catch { stored = {}; }
    },
    allow(kind) {
      if (!(kind in caps)) return true;
      return (Number(stored[field[kind]]) || 0) + local[kind] < caps[kind];
    },
    record(kind, n = 1) { if (kind in local) local[kind] += n; },
    async flush(jobRef) {
      const FV = fsx.FieldValue();
      const dayPatch = { day, updatedAt: Date.now() };
      const jobPatch = {};
      Object.keys(local).forEach(k => {
        if (!local[k]) return;
        dayPatch[field[k]] = FV.increment(local[k]);
        jobPatch['usage.' + field[k]] = FV.increment(local[k]);
      });
      if (Object.keys(jobPatch).length) {
        await ref().set(dayPatch, { merge: true });
        await jobRef.update(jobPatch);
      }
      Object.keys(local).forEach(k => { local[k] = 0; });
    },
    snapshot() { return { day, stored, local: Object.assign({}, local), caps }; }
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
  COUNT_KEYS, createJob, tick, resume, retryFailed, cancel, getJob, listJobs, publicJob,
  createUsage, createCache,
  /* exported for tests */
  _internal: { processItem, dedupeAndConflicts, mergeAi, discoverStep }
};
