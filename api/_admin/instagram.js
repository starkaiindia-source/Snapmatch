/* ============================================================================
   GET  /api/admin/instagram?view=…     read: overview, sources, jobs, job,
                                        extractions, content, review, candidate,
                                        history, models
   POST /api/admin/instagram {action}   write: analyze, tick, resume,
                                        retry_failed, cancel, approve,
                                        approve_all_valid, reject, select_model,
                                        change_category, mark_duplicate, reopen,
                                        ignore_source, unignore_source,
                                        send_to_missing_models
   ----------------------------------------------------------------------------
   The Instagram Compatibility Data Intelligence API. A section of the one
   admin function (api/admin.js), not a function of its own — the project is
   at Vercel Hobby's 12-function limit.

   ----------------------------------------------------------------------------
   PERMISSIONS, PER ACTION

     instagram.read     every GET
     instagram.import   analyze, tick, resume, retry_failed, cancel
     compat.review      reject, select_model, change_category, mark_duplicate,
                        reopen, ignore_source, unignore_source, send_to_missing
     compat.approve     approve, approve_all_valid — the only actions that can
                        write production compatibility data

   Each is checked here, server-side, on every request, through the same
   requirePermission() every other admin route uses. While OWNER_ONLY is true
   only the owner's Google account passes it at all.

   No credential ever leaves this file: the Graph token, the Vision key, the
   AI gateway token and the service account are read by the services from the
   environment, and /overview reports only whether each is SET.
   ========================================================================== */
'use strict';

const { requirePermission } = require('../_lib/admin-auth');
const { PERMISSIONS } = require('../_schema/roles');
const { ok, bad, json, fail, notAllowed } = require('../_lib/http');
const audit = require('../_services/audit-service');
const v = require('../_lib/validate');
const S = require('../_schema/instagram');
const C = require('../_schema/collections');
const fsx = require('../_services/instagram/firestore');
const configMod = require('../_services/instagram/config');
const jobService = require('../_services/instagram/job-service');
const review = require('../_services/instagram/review-service');
const taxonomy = require('../_services/taxonomy-service');

const READ = PERMISSIONS.INSTAGRAM_READ;
const IMPORT = PERMISSIONS.INSTAGRAM_IMPORT;
const REVIEW = PERMISSIONS.COMPAT_REVIEW;
const APPROVE = PERMISSIONS.COMPAT_APPROVE;

const ACTION_PERMISSION = {
  analyze: IMPORT, tick: IMPORT, resume: IMPORT, retry_failed: IMPORT, cancel: IMPORT,
  approve: APPROVE, approve_all_valid: APPROVE,
  reject: REVIEW, select_model: REVIEW, change_category: REVIEW, mark_duplicate: REVIEW,
  reopen: REVIEW, ignore_source: REVIEW, unignore_source: REVIEW, send_to_missing_models: REVIEW
};

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') return await read(req, res);
    if (req.method === 'POST') return await write(req, res);
    return notAllowed(res);
  } catch (err) {
    if (err instanceof review.ReviewError) {
      return json(res, err.status || 409, { error: err.message, code: err.code, groupsA: err.groupsA, groupsB: err.groupsB });
    }
    return fail(res, err, 'admin-instagram');
  }
};

/* =================================================================== read */

async function read(req, res) {
  const admin = await requirePermission(req, res, READ);
  if (!admin) return;
  const q = req.query || {};
  const view = v.oneOf(q.view, ['overview', 'sources', 'jobs', 'job', 'extractions', 'content', 'review', 'candidate', 'history', 'models'], 'overview');
  const db = fsx.db();

  if (view === 'overview') {
    const [jobs, counts] = await Promise.all([
      jobService.listJobs({ limit: 5 }).catch(() => ({ jobs: [] })),
      review.sectionCounts().catch(() => ({}))
    ]);
    const tax = taxonomy.taxonomy();
    return ok(res, {
      integration: configMod.status(),
      catalogue: { models: tax.entries.length, categories: Array.from(tax.categories.values()).map(c => ({ id: c.id, name: c.name })) },
      recentJobs: jobs.jobs, sectionCounts: counts, sections: S.REVIEW_SECTIONS,
      rejectReasons: S.REJECT_REASONS, serverTime: Date.now()
    });
  }

  if (view === 'sources') {
    const snap = await db.collection(C.INSTAGRAM_SOURCES).orderBy('updatedAt', 'desc').limit(v.integer(q.limit, { min: 1, max: 200, fallback: 100 })).get();
    return ok(res, { sources: snap.docs.map(d => d.data()), serverTime: Date.now() });
  }

  if (view === 'jobs' || view === 'history') {
    const out = await jobService.listJobs({
      sourceKey: q.sourceKey ? v.docId(q.sourceKey, 60) || null : null,
      status: v.oneOf(q.status, S.JOB_STATUSES, null),
      from: v.timestamp(q.from), to: v.timestamp(q.to),
      limit: v.integer(q.limit, { min: 1, max: 100, fallback: 50 })
    });
    let candidateSearch = null;
    if (view === 'history' && (q.categoryId || q.modelQuery || q.band || q.reviewStatus)) {
      const model = q.modelQuery ? taxonomy.matchModel(v.searchTerm(q.modelQuery, 80)) : null;
      candidateSearch = await review.listCandidates({
        sourceKey: q.sourceKey ? v.docId(q.sourceKey, 60) || null : null,
        categoryId: taxonomy.isKnownCategory(q.categoryId) ? q.categoryId : null,
        band: v.oneOf(q.band, ['high', 'medium', 'low'], null),
        status: v.oneOf(q.reviewStatus, S.CANDIDATE_STATUSES, null),
        modelId: model && model.modelId ? model.modelId : null,
        limit: 60
      });
      candidateSearch.model = model ? { query: q.modelQuery, status: model.status, modelId: model.modelId, modelName: model.modelName } : null;
    }
    return ok(res, Object.assign(out, { candidateSearch, statuses: S.JOB_STATUSES, serverTime: Date.now() }));
  }

  if (view === 'job') {
    const jobId = v.docId(q.jobId, 80);
    if (!jobId) return bad(res, 'jobId is required');
    const detail = await jobService.getJob(jobId, {
      itemLimit: v.integer(q.itemLimit, { min: 1, max: 200, fallback: 80 }),
      itemStatus: v.oneOf(q.itemStatus, S.ITEM_STATUSES, null)
    });
    if (!detail) return json(res, 404, { error: 'no such job' });
    return ok(res, { job: jobService.publicJob(detail.job), items: detail.items, serverTime: Date.now() });
  }

  if (view === 'extractions') {
    let query = db.collection(C.INSTAGRAM_EXTRACTIONS);
    const jobId = q.jobId ? v.docId(q.jobId, 80) : '';
    const sourceKey = q.sourceKey ? v.docId(q.sourceKey, 60) : '';
    if (jobId) query = query.where('jobId', '==', jobId);
    else if (sourceKey) query = query.where('sourceKey', '==', sourceKey);
    const snap = await query.orderBy('extractedAt', 'desc').limit(v.integer(q.limit, { min: 1, max: 100, fallback: 30 })).get();
    return ok(res, { extractions: snap.docs.map(d => d.data()), serverTime: Date.now() });
  }

  if (view === 'content') {
    const contentKey = v.docId(q.contentKey, 120);
    if (!contentKey) return bad(res, 'contentKey is required');
    const snap = await db.collection(C.INSTAGRAM_CONTENT).doc(contentKey).get();
    if (!snap.exists) return json(res, 404, { error: 'no such content' });
    const ex = await db.collection(C.INSTAGRAM_EXTRACTIONS).where('contentKey', '==', contentKey).limit(20).get();
    return ok(res, { content: snap.data(), extractions: ex.docs.map(d => d.data()).sort((a, b) => b.version - a.version) });
  }

  if (view === 'review') {
    /* `queue`, never `section`: vercel.json and api/admin.js already use the
       `section` query parameter to pick THIS admin section, and a second one
       would be merged into it and route the request somewhere else. */
    const section = v.oneOf(q.queue, S.REVIEW_SECTION_IDS, 'ready');
    const jobId = q.jobId ? v.docId(q.jobId, 80) || null : null;
    const [list, counts] = await Promise.all([
      review.listCandidates({
        section, jobId,
        categoryId: taxonomy.isKnownCategory(q.categoryId) ? q.categoryId : null,
        band: v.oneOf(q.band, ['high', 'medium', 'low'], null),
        limit: v.integer(q.limit, { min: 1, max: 100, fallback: 30 })
      }),
      review.sectionCounts({ jobId })
    ]);
    return ok(res, Object.assign(list, { section, sectionCounts: counts, sections: S.REVIEW_SECTIONS, rejectReasons: S.REJECT_REASONS, serverTime: Date.now() }));
  }

  if (view === 'candidate') {
    const id = v.docId(q.candidateId, 200);
    if (!id) return bad(res, 'candidateId is required');
    const detail = await review.getCandidate(id);
    if (!detail) return json(res, 404, { error: 'no such candidate' });
    return ok(res, detail);
  }

  /* models: the picker behind "Select correct model". Catalogue only. */
  const term = v.searchTerm(q.q, 80);
  if (term.length < 2) return ok(res, { models: [] });
  return ok(res, { models: taxonomy.searchModels(term, { limit: 15, brandHint: q.brandId ? v.docId(q.brandId, 40) || undefined : undefined }) });
}

/* ================================================================== write */

async function write(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = v.oneOf(body.action, Object.keys(ACTION_PERMISSION), null);
  if (!action) return bad(res, 'unknown action');

  const admin = await requirePermission(req, res, ACTION_PERMISSION[action]);
  if (!admin) return;
  const now = Date.now();
  const rec = (a, targetType, targetId, detail) => audit.record({
    actorUid: admin.uid, actorRole: admin.role, action: a, targetType, targetId, detail, now
  });

  if (action === 'analyze') {
    const result = await jobService.createJob({
      admin,
      profileUrl: v.string(body.profileUrl, 500),
      postUrl: v.string(body.postUrl, 500) || null,
      maxItems: v.integer(body.maxItems, { min: 1, max: 500, fallback: null }),
      mode: v.oneOf(body.mode, ['api', 'manual'], 'api'),
      manualText: typeof body.manualText === 'string' ? body.manualText.slice(0, 5000) : '',
      now
    });
    if (!result.ok) return json(res, result.status, { error: result.error });
    rec(audit.ACTIONS.INSTAGRAM_IMPORT_STARTED, 'instagram_job', result.job.jobId, {
      sourceUrl: result.job.postUrl || result.job.profileUrl, mode: result.job.mode,
      status: result.job.status, maxItems: result.job.maxItems
    });
    return ok(res, { job: jobService.publicJob(result.job) });
  }

  if (action === 'tick') {
    const jobId = v.docId(body.jobId, 80);
    if (!jobId) return bad(res, 'jobId is required');
    const out = await jobService.tick({ jobId, workerId: 'admin:' + admin.uid });
    if (!out.job) return json(res, 404, { error: out.error || 'no such job' });
    return ok(res, { job: jobService.publicJob(out.job), busy: !!out.busy, steps: out.steps, note: out.error || null });
  }

  if (action === 'resume' || action === 'retry_failed' || action === 'cancel') {
    const jobId = v.docId(body.jobId, 80);
    if (!jobId) return bad(res, 'jobId is required');
    const fn = { resume: jobService.resume, retry_failed: jobService.retryFailed, cancel: jobService.cancel }[action];
    const out = await fn({ jobId, admin, now });
    if (!out.ok) return json(res, out.status || 409, { error: out.error });
    rec({ resume: audit.ACTIONS.INSTAGRAM_JOB_RESUMED, retry_failed: audit.ACTIONS.INSTAGRAM_JOB_RETRIED, cancel: audit.ACTIONS.INSTAGRAM_JOB_CANCELLED }[action],
      'instagram_job', jobId, { requeued: out.requeued || 0, cancelledItems: out.cancelledItems || 0 });
    return ok(res, out);
  }

  if (action === 'approve') {
    const candidateId = v.docId(body.candidateId, 200);
    if (!candidateId) return bad(res, 'candidateId is required');
    const out = await review.approve({ candidateId, admin, acknowledgeLowConfidence: body.acknowledgeLowConfidence === true, now });
    rec(audit.ACTIONS.COMPAT_APPROVED, 'compat_candidate', candidateId, {
      relKey: out.relKey, outcome: out.outcome,
      groupId: out.change ? out.change.groupId : '',
      addedModelId: out.change ? out.change.addedModelId : '',
      previousMemberCount: out.change ? out.change.previousMemberCount : null,
      newMemberCount: out.change ? out.change.newMemberCount : null
    });
    return ok(res, out);
  }

  if (action === 'approve_all_valid') {
    const out = await review.approveAllValid({ admin, jobId: body.jobId ? v.docId(body.jobId, 80) || null : null, limit: v.integer(body.limit, { min: 1, max: 50, fallback: 25 }), now });
    out.results.filter(r => r.ok).forEach(r => rec(audit.ACTIONS.COMPAT_APPROVED, 'compat_candidate', r.candidateId, { outcome: r.outcome, bulk: true }));
    return ok(res, out);
  }

  if (action === 'reject') {
    const candidateId = v.docId(body.candidateId, 200);
    if (!candidateId) return bad(res, 'candidateId is required');
    const out = await review.reject({ candidateId, admin, reason: v.oneOf(body.reason, S.REJECT_REASONS, null), note: v.string(body.note, 500), now });
    rec(audit.ACTIONS.COMPAT_REJECTED, 'compat_candidate', candidateId, { reason: body.reason, previousStatus: out.previousStatus, newStatus: 'rejected' });
    return ok(res, out);
  }

  if (action === 'select_model') {
    const candidateId = v.docId(body.candidateId, 200);
    const modelId = v.docId(body.modelId, 120);
    if (!candidateId || !modelId) return bad(res, 'candidateId and modelId are required');
    const out = await review.selectModel({
      candidateId, side: v.oneOf(body.side, ['source', 'compatible', 'reference'], null), modelId,
      rememberAlias: body.rememberAlias === true, admin, now
    });
    rec(audit.ACTIONS.COMPAT_MATCH_EDITED, 'compat_candidate', candidateId, {
      side: out.side, previousValue: out.previousModelId || '', newValue: out.newModelId
    });
    if (out.alias && out.alias.learned) rec(audit.ACTIONS.COMPAT_ALIAS_LEARNED, 'alias', out.alias.key, { canonicalId: out.newModelId, candidateId });
    return ok(res, out);
  }

  if (action === 'change_category') {
    const candidateId = v.docId(body.candidateId, 200);
    if (!candidateId) return bad(res, 'candidateId is required');
    const out = await review.changeCategory({ candidateId, categoryId: v.docId(body.categoryId, 60), admin, now });
    rec(audit.ACTIONS.COMPAT_CATEGORY_CHANGED, 'compat_candidate', candidateId, { previousValue: out.previousCategoryId || '', newValue: out.newCategoryId });
    return ok(res, out);
  }

  if (action === 'mark_duplicate') {
    const candidateId = v.docId(body.candidateId, 200);
    if (!candidateId) return bad(res, 'candidateId is required');
    const out = await review.markDuplicate({ candidateId, duplicateOf: body.duplicateOf ? v.docId(body.duplicateOf, 200) || null : null, admin, now });
    rec(audit.ACTIONS.COMPAT_MARKED_DUPLICATE, 'compat_candidate', candidateId, { duplicateOf: body.duplicateOf || '' });
    return ok(res, out);
  }

  if (action === 'reopen') {
    const candidateId = v.docId(body.candidateId, 200);
    if (!candidateId) return bad(res, 'candidateId is required');
    const out = await review.reopen({ candidateId, admin, now });
    rec(audit.ACTIONS.COMPAT_REOPENED, 'compat_candidate', candidateId, { previousValue: out.previousStatus, newValue: 'pending' });
    return ok(res, out);
  }

  if (action === 'ignore_source' || action === 'unignore_source') {
    const sourceKey = v.docId(body.sourceKey, 60);
    if (!sourceKey) return bad(res, 'sourceKey is required');
    const ignored = action === 'ignore_source';
    const out = await review.setSourceIgnored({ sourceKey, ignored, reason: v.string(body.reason, 300), admin, now });
    rec(ignored ? audit.ACTIONS.INSTAGRAM_SOURCE_IGNORED : audit.ACTIONS.INSTAGRAM_SOURCE_UNIGNORED, 'instagram_source', sourceKey,
      { candidatesMoved: out.candidatesMoved, reason: v.string(body.reason, 200) });
    return ok(res, out);
  }

  /* send_to_missing_models */
  const candidateId = v.docId(body.candidateId, 200);
  if (!candidateId) return bad(res, 'candidateId is required');
  const out = await review.sendToMissingModels({ candidateId, admin, now });
  rec(audit.ACTIONS.COMPAT_SENT_TO_MISSING, 'compat_candidate', candidateId, { missingModelKey: out.missingModelKey || '' });
  return ok(res, out);
}
