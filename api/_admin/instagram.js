/* ============================================================================
   GET  /api/admin/instagram?view=…     read: overview, sources, jobs, job,
                                        extractions, content, review, candidate,
                                        history, models, group, evidence_preview,
                                        groups, changes, categories
   POST /api/admin/instagram {action}   write: analyze, continue, tick, resume,
                                        and Compatibility Management:
                                        group_add_model, group_remove_model,
                                        group_set_master, group_merge,
                                        group_create, group_delete,
                                        category_create, category_rename,
                                        category_delete, undo_change,
                                        retry_failed, cancel, add_evidence,
                                        verify_providers,
                                        approve, approve_all_valid, reject,
                                        select_model, change_category,
                                        mark_duplicate, reopen, ignore_source,
                                        unignore_source, send_to_missing_models,
                                        and the group-proposal actions:
                                        approve_proposal, proposal_select_model,
                                        proposal_member_decision,
                                        proposal_add_model, proposal_set_master,
                                        proposal_set_target, proposal_refresh
   ----------------------------------------------------------------------------
   The Instagram Compatibility Data Intelligence API. A section of the one
   admin function (api/admin.js), not a function of its own — the project is
   at Vercel Hobby's 12-function limit.

   ----------------------------------------------------------------------------
   PERMISSIONS, PER ACTION

     instagram.read     every GET
     instagram.import   analyze, continue, tick, resume, retry_failed, cancel,
                        add_evidence, verify_providers (it spends a few tokens
                        on real calls)
     compat.review      reject, select_model, change_category, mark_duplicate,
                        reopen, ignore_source, unignore_source, send_to_missing,
                        and every proposal_* edit
     compat.approve     approve, approve_all_valid, approve_proposal, undo_change
                        — the only actions that can write production
                        compatibility data

   COMPATIBILITY MANAGEMENT (group_* and category_*) needs compat.approve:
   every one of them changes the live compatibility data.

   EVERYTHING HERE WRITES TO MOBILE PARTS FINDER ONLY. The one database handle
   (api/_services/instagram/firestore.js) refuses a credential that belongs to
   another project; there is no code path from this file to the Dashboard or
   to ProGlide (api/_schema/projects.js).

   AUTOMATIC APPLICATION is not an action anyone can send. A scan applies the
   lists that pass every check only when the administrator who started it
   holds compat.approve — decided in job-service.createJob from the verified
   role, never from the request body.

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
const management = require('../_services/compat/management');
const categoryService = require('../_services/compat/category-service');
const { ProjectBoundaryError } = require('../_schema/projects');
const taxonomy = require('../_services/taxonomy-service');
const providerCheck = require('../_services/instagram/provider-check');
const { PRICES_AS_OF } = require('../_services/instagram/ai-providers');

const READ = PERMISSIONS.INSTAGRAM_READ;
const IMPORT = PERMISSIONS.INSTAGRAM_IMPORT;
const REVIEW = PERMISSIONS.COMPAT_REVIEW;
const APPROVE = PERMISSIONS.COMPAT_APPROVE;

const ACTION_PERMISSION = {
  analyze: IMPORT, continue: IMPORT, tick: IMPORT, resume: IMPORT, retry_failed: IMPORT, cancel: IMPORT, add_evidence: IMPORT,
  verify_providers: IMPORT,
  approve: APPROVE, approve_all_valid: APPROVE, approve_proposal: APPROVE, undo_change: APPROVE,
  group_add_model: APPROVE, group_remove_model: APPROVE, group_set_master: APPROVE, group_merge: APPROVE,
  group_create: APPROVE, group_delete: APPROVE,
  category_create: APPROVE, category_rename: APPROVE, category_delete: APPROVE,
  reject: REVIEW, select_model: REVIEW, change_category: REVIEW, mark_duplicate: REVIEW,
  reopen: REVIEW, ignore_source: REVIEW, unignore_source: REVIEW, send_to_missing_models: REVIEW,
  proposal_select_model: REVIEW, proposal_member_decision: REVIEW, proposal_add_model: REVIEW,
  proposal_set_master: REVIEW, proposal_set_target: REVIEW, proposal_refresh: REVIEW
};

/* A group id as this project issues them: a two- or three-character category
   prefix and a number. Never a path. */
function groupIdOf(value) {
  const s = v.string(value, 16).toLowerCase();
  return /^[a-z][a-z0-9]{1,2}-\d{1,6}$/.test(s) ? s : '';
}

/* A list entry's key: "m:<model id>" once resolved, "t:<normalised text>"
   while it is not. Never a path, never interpolated. */
function memberKey(value) {
  const s = v.string(value, 200);
  return /^[mt]:[A-Za-z0-9 ._+()-]{1,180}$/.test(s) ? s : '';
}

const EVIDENCE_MAX_BYTES = 3 * 1024 * 1024;
const EVIDENCE_PREVIEW_MAX = 220 * 1024;

/* Screenshots an admin attaches. The bytes must BE an image of a type the
   readers accept — the declared type is not taken on trust. */
function evidenceImages(list) {
  if (!Array.isArray(list)) return { images: [] };
  const images = [];
  for (const raw of list.slice(0, 4)) {
    if (!raw || typeof raw.data !== 'string' || !/^[A-Za-z0-9+/=\r\n]+$/.test(raw.data)) return { error: 'An attached image is not valid base64.' };
    const bytes = Buffer.from(raw.data, 'base64');
    if (!bytes.length || bytes.length > EVIDENCE_MAX_BYTES) return { error: 'An attached image is empty or larger than 3 MB.' };
    const mimeType = bytes[0] === 0xFF && bytes[1] === 0xD8 ? 'image/jpeg'
      : bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) ? 'image/png'
      : bytes.slice(0, 4).toString('latin1') === 'RIFF' && bytes.slice(8, 12).toString('latin1') === 'WEBP' ? 'image/webp'
      : null;
    if (!mimeType) return { error: 'Attach JPEG, PNG or WebP screenshots.' };
    const preview = typeof raw.preview === 'string' && raw.preview.length <= EVIDENCE_PREVIEW_MAX &&
      /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(raw.preview) ? raw.preview : null;
    images.push({ bytes, mimeType, preview, note: v.string(raw.note, 200) });
  }
  return { images };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') return await read(req, res);
    if (req.method === 'POST') return await write(req, res);
    return notAllowed(res);
  } catch (err) {
    if (err instanceof review.ReviewError) {
      return json(res, err.status || 409, { error: err.message, code: err.code, groupsA: err.groupsA, groupsB: err.groupsB, blocked: err.blocked });
    }
    if (err instanceof management.ManagementError || err instanceof categoryService.CategoryError) {
      return json(res, err.status || 409, { error: err.message, code: err.code, blocked: err.blocked });
    }
    /* a credential for another project: said plainly, and nothing was written */
    if (err instanceof ProjectBoundaryError) return json(res, 500, { error: err.message, code: err.code });
    return fail(res, err, 'admin-instagram');
  }
};

/* =================================================================== read */

async function read(req, res) {
  const admin = await requirePermission(req, res, READ);
  if (!admin) return;
  const q = req.query || {};
  const view = v.oneOf(q.view, ['overview', 'sources', 'jobs', 'job', 'extractions', 'content', 'review', 'candidate', 'history', 'models', 'group', 'evidence_preview', 'groups', 'changes', 'categories'], 'overview');
  const db = fsx.db();
  /* the categories created at run time are categories for everything below */
  await categoryService.load();

  if (view === 'categories') {
    return ok(res, { categories: await categoryService.list(), creatable: taxonomy.CREATABLE_CATEGORIES.map(c => c.name), serverTime: Date.now() });
  }

  if (view === 'overview') {
    const [jobs, counts] = await Promise.all([
      jobService.listJobs({ limit: 5 }).catch(() => ({ jobs: [] })),
      review.sectionCounts().catch(() => ({}))
    ]);
    const tax = taxonomy.taxonomy();
    return ok(res, {
      integration: configMod.status(),
      catalogue: { models: tax.entries.length, categories: Array.from(tax.categories.values()).map(c => ({
        id: c.id, name: c.name, groupCount: c.groupCount || 0, kind: c.dynamic ? 'run_time' : 'site' })) },
      /* would a scan started by THIS person apply what passes automatically? */
      autoApply: !!(configMod.load().autoApply && require('../_schema/roles').can(admin.role, APPROVE)),
      recentJobs: jobs.jobs, sectionCounts: counts, sections: S.REVIEW_SECTIONS,
      extractionFilters: S.EXTRACTION_FILTERS, pricesAsOf: PRICES_AS_OF,
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
    /* `filter`, one of the tabs. "relevant" is the default: an ignored
       repair post is kept, and shown only when someone asks for it. Each tab
       is ONE indexed query on the tags stored with the extraction; with a
       job or a source selected the tab narrows that job's rows in memory. */
    const filter = v.oneOf(q.filter, S.EXTRACTION_FILTERS.map(f => f.id), 'relevant');
    const limit = v.integer(q.limit, { min: 1, max: 100, fallback: 30 });
    let query = db.collection(C.INSTAGRAM_EXTRACTIONS);
    const jobId = q.jobId ? v.docId(q.jobId, 80) : '';
    const sourceKey = q.sourceKey ? v.docId(q.sourceKey, 60) : '';
    const scoped = !!(jobId || sourceKey);
    if (jobId) query = query.where('jobId', '==', jobId);
    else if (sourceKey) query = query.where('sourceKey', '==', sourceKey);
    else query = query.where('filters', 'array-contains', filter);
    let snap;
    let indexMissing = false;
    try {
      snap = await query.orderBy('extractedAt', 'desc').limit(scoped ? 300 : limit).get();
    } catch (err) {
      /* The tab index (filters + extractedAt) is not deployed yet. The page
         still works: the most recent extractions, narrowed in memory, and a
         note saying why older matches may be missing. */
      if (scoped || !(err && (err.code === 9 || /index/i.test(String(err.message))))) throw err;
      indexMissing = true;
      snap = await db.collection(C.INSTAGRAM_EXTRACTIONS).orderBy('extractedAt', 'desc').limit(300).get();
    }
    let rows = snap.docs.map(d => d.data());
    if (indexMissing) rows = rows.filter(r => (r.filters || []).indexOf(filter) > -1);
    const counts = {};
    if (scoped) {
      S.EXTRACTION_FILTERS.forEach(f => { counts[f.id] = rows.filter(r => (r.filters || []).indexOf(f.id) > -1).length; });
      rows = rows.filter(r => (r.filters || []).indexOf(filter) > -1);
    }
    return ok(res, {
      extractions: rows.slice(0, limit), filter, filters: S.EXTRACTION_FILTERS,
      counts: scoped ? counts : null, approximate: (scoped || indexMissing) && snap.size >= 300,
      indexMissing, serverTime: Date.now()
    });
  }

  if (view === 'groups') {
    /* THE FINAL GROUPS, as the live compatibility data holds them — not what
       any post said. One category at a time, by group number; or the groups a
       model is in; or the ones Instagram Intelligence changed last. Each row
       costs two reads (the group and its member list): a page, never a scan. */
    const limit = v.integer(q.limit, { min: 1, max: 100, fallback: 40 });
    const categoryId = taxonomy.isKnownCategory(q.categoryId) ? q.categoryId : null;
    const term = v.searchTerm(q.q, 80);
    let groupIds = [];
    let model = null;
    let next = null;
    if (term && term.length >= 2) {
      const m = taxonomy.matchModel(term);
      model = { query: term, status: m.status, modelId: m.modelId || null, modelName: m.modelName || null };
      if (m.status === 'matched') {
        const mg = await db.collection(C.MODEL_GROUPS).doc(m.modelId).get();
        const byCat = mg.exists ? (mg.data().byCategory || {}) : {};
        Object.keys(byCat).forEach(cat => { if (!categoryId || cat === categoryId) (byCat[cat] || []).forEach(g => groupIds.push(String(g))); });
      }
    } else if (q.changed === '1') {
      const snap = await db.collection(C.GROUPS).orderBy('lastChange.at', 'desc').limit(limit).get();
      groupIds = snap.docs.map(d => d.id);
    } else {
      if (!categoryId) return bad(res, 'categoryId is required');
      const after = v.string(q.after, 20);
      let query = db.collection(C.GROUPS).where('categoryId', '==', categoryId);
      if (/^[A-Z][A-Z0-9]{1,2}-\d{1,6}$/.test(after)) query = query.where('groupNo', '>', after);
      const snap = await query.orderBy('groupNo', 'asc').limit(limit + 1).get();
      groupIds = snap.docs.slice(0, limit).map(d => d.id);
      if (snap.size > limit) next = snap.docs[limit - 1].data().groupNo;
    }
    const groups = (await Promise.all(groupIds.slice(0, limit).map(id => review.getGroup(id))))
      /* a group merged into another is not a group any more: it is listed
         under the group it became */
      .filter(g => g && !g.mergedInto);
    return ok(res, {
      groups: groups.map(g => ({
        groupId: g.groupId, groupNo: g.groupNo, partCode: g.partCode, categoryId: g.categoryId,
        masterModelId: g.masterModelId, masterModelName: g.masterModelName,
        memberCount: g.memberCount,
        members: (g.memberIds || []).slice(0, 300).map((id, i) => ({ id, name: (g.memberNames || [])[i] || id })),
        lastChange: g.lastChange || null,
        /* a group created at run time is in the live data now; the public
           search lists it after the next catalogue build */
        awaitingBuild: !!g.createdBy && !g.serialNo,
        onPublicSite: taxonomy.isSiteCategory(g.categoryId)
      })),
      categoryId, model, next, serverTime: Date.now()
    });
  }

  if (view === 'changes') {
    /* What Instagram Intelligence did, what it decided and has not landed
       yet, and what it would not do on its own. */
    const limit = v.integer(q.limit, { min: 1, max: 100, fallback: 40 });
    const ledger = db.collection(C.APPROVED_COMPATIBILITIES);
    const [recent, queued, attention] = await Promise.all([
      ledger.orderBy('approvedAt', 'desc').limit(limit).get(),
      ledger.where('status', '==', 'approved_pending_build').limit(60).get(),
      db.collection(C.COMPATIBILITY_CANDIDATES).where('autoApply.status', '==', 'attention').where('status', '==', 'pending').limit(60).get()
    ]);
    const entry = e => ({
      relKey: e.relKey, kind: e.kind || 'same_part', status: e.status, categoryId: e.categoryId,
      approvedAt: e.approvedAt || null, automatic: !!e.automatic, approvedBy: e.approvedBy || null,
      sources: (e.sources || []).slice(0, 5), proposalId: e.proposalId || null,
      added: e.appliedChange ? { groupId: e.appliedChange.groupId, modelName: e.appliedChange.addedModelName,
                                 previousMemberCount: e.appliedChange.previousMemberCount, newMemberCount: e.appliedChange.newMemberCount } : null,
      created: e.createdGroup ? { groupId: e.createdGroup.groupId, groupNo: e.createdGroup.groupNo, masterModelName: e.createdGroup.masterModelName,
                                  masterReason: e.createdGroup.masterReason || null, memberNames: (e.createdGroup.memberNames || []).slice(0, 60) } : null,
      merge: e.kind === 'merge_groups' ? { into: e.survivor, from: { groupId: e.absorbed.groupId, groupNo: e.absorbed.groupNo, masterModelName: e.absorbed.masterModelName,
                                                                     memberCount: e.absorbed.memberCount },
                                           listedModelNames: (e.listedModelNames || []).slice(0, 30), live: !!e.live,
                                           overlap: e.overlap == null ? null : e.overlap, coverage: e.coverage == null ? null : e.coverage } : null,
      removed: e.kind === 'remove_model' ? { groupId: e.groupId, modelName: e.removedModelName } : null,
      master: e.kind === 'set_master' ? { groupId: e.groupId, modelName: e.masterModelName, previousName: e.previousMasterName || null } : null,
      deleted: e.kind === 'delete_group' ? { groupNo: e.groupNo, masterModelName: e.masterModelName || null, memberCount: (e.memberIds || []).length } : null,
      note: e.productionNote || null
    });
    return ok(res, {
      recent: recent.docs.map(d => entry(d.data())),
      queued: queued.docs.map(d => entry(d.data())).filter(e => e.kind === 'merge_groups'),
      attention: attention.docs.map(d => d.data()).map(c => ({
        candidateId: c.candidateId, sourceUsername: c.sourceUsername || null, permalink: c.sourcePost && c.sourcePost.permalink || null,
        categoryId: c.categoryId || null, productName: c.productName || c.unmappedCategoryText || null,
        proposedAction: c.proposedAction, counts: c.counts || {}, reasons: (c.autoApply && c.autoApply.reasons) || [],
        at: c.autoApply && c.autoApply.at || c.createdAt || null, models: (c.sourceModels || []).slice(0, 12),
        jobId: c.jobId || null, reviewSection: c.reviewSection || null
      })),
      serverTime: Date.now()
    });
  }

  if (view === 'group') {
    const groupId = v.docId(q.groupId, 60);
    if (!groupId) return bad(res, 'groupId is required');
    const group = await review.getGroup(groupId);
    if (!group) return json(res, 404, { error: 'no such group' });
    return ok(res, { group });
  }

  if (view === 'evidence_preview') {
    const id = v.string(q.id, 40);
    if (!/^[a-f0-9]{8,32}$/.test(id)) return bad(res, 'id is required');
    const preview = await jobService.evidencePreview(id);
    if (!preview) return json(res, 404, { error: 'no preview stored for that evidence' });
    return ok(res, { preview });
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
  /* the categories created at run time are categories for every action */
  await categoryService.load();
  const rec = (a, targetType, targetId, detail) => audit.record({
    actorUid: admin.uid, actorRole: admin.role, action: a, targetType, targetId, detail, now
  });

  if (action === 'analyze') {
    const result = await jobService.createJob({
      admin,
      profileUrl: v.string(body.profileUrl, 500),
      postUrl: v.string(body.postUrl, 500) || null,
      maxItems: v.integer(body.maxItems, { min: 1, max: 2000, fallback: null }),
      /* scan the page for free first, and wait for Continue */
      scanFirst: body.scanFirst === true,
      mode: v.oneOf(body.mode, ['api', 'manual'], 'api'),
      manualText: typeof body.manualText === 'string' ? body.manualText.slice(0, 5000) : '',
      /* "Analyse anyway": only together with ONE post URL */
      force: body.force === true,
      now
    });
    if (!result.ok) return json(res, result.status, { error: result.error });
    rec(audit.ACTIONS.INSTAGRAM_IMPORT_STARTED, 'instagram_job', result.job.jobId, {
      sourceUrl: result.job.postUrl || result.job.profileUrl, mode: result.job.mode,
      status: result.job.status, maxItems: result.job.maxItems, forceDeep: result.job.forceDeep,
      scanFirst: result.job.scanFirst, autoApply: result.job.autoApply
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

  if (action.indexOf('group_') === 0 || action.indexOf('category_') === 0) {
    await categoryService.load();
    const groupId = groupIdOf(body.groupId);
    const modelId = v.docId(body.modelId, 120);
    const groupTarget = out => ['compatibility_group', out.groupId];

    if (action === 'group_add_model' || action === 'group_remove_model' || action === 'group_set_master') {
      if (!groupId) return bad(res, 'groupId is required');
      if (!modelId) return bad(res, 'modelId is required');
      const fn = { group_add_model: management.addModel, group_remove_model: management.removeModel, group_set_master: management.setMaster }[action];
      const out = await fn({ groupId, modelId, admin, now });
      rec({ group_add_model: audit.ACTIONS.COMPAT_GROUP_MODEL_ADDED, group_remove_model: audit.ACTIONS.COMPAT_GROUP_MODEL_REMOVED,
            group_set_master: audit.ACTIONS.COMPAT_GROUP_MASTER_CHANGED }[action], ...groupTarget(out), {
        categoryId: out.categoryId, modelId, modelName: out.addedModelName || out.removedModelName || out.masterModelName || '',
        previousMaster: out.previousMasterName || '', previousMemberCount: out.previousMemberCount || 0, newMemberCount: out.newMemberCount || 0
      });
      return ok(res, out);
    }
    if (action === 'group_merge') {
      const into = groupIdOf(body.intoGroupId), from = groupIdOf(body.fromGroupId);
      if (!into || !from) return bad(res, 'intoGroupId and fromGroupId are required');
      const out = await management.mergeGroups({ intoGroupId: into, fromGroupId: from, admin, now });
      rec(audit.ACTIONS.COMPAT_GROUPS_MERGED, 'compatibility_group', into, {
        categoryId: out.categoryId, merged: from, moved: out.movedModelIds.length,
        previousMemberCount: out.previousMemberCount, newMemberCount: out.newMemberCount
      });
      return ok(res, out);
    }
    if (action === 'group_create') {
      const categoryId = v.docId(body.categoryId, 40);
      const memberIds = Array.isArray(body.memberIds) ? body.memberIds.slice(0, 300).map(x => v.docId(x, 120)).filter(Boolean) : [];
      if (!categoryId || !modelId && !v.docId(body.masterModelId, 120)) return bad(res, 'categoryId and masterModelId are required');
      const out = await management.createGroup({ categoryId, masterModelId: v.docId(body.masterModelId, 120) || modelId, memberIds, admin, now });
      rec(audit.ACTIONS.COMPAT_GROUP_CREATED, 'compatibility_group', out.groupId, {
        categoryId, groupNo: out.groupNo, master: out.masterModelName, memberCount: out.memberCount
      });
      return ok(res, out);
    }
    if (action === 'group_delete') {
      if (!groupId) return bad(res, 'groupId is required');
      /* deliberate: the request must name the group it means to delete twice */
      if (groupIdOf(body.confirm) !== groupId) return bad(res, 'Type the group number to confirm deleting it.');
      const out = await management.deleteGroup({ groupId, admin, now });
      rec(audit.ACTIONS.COMPAT_GROUP_DELETED, 'compatibility_group', groupId, {
        categoryId: out.categoryId, groupNo: out.groupNo, master: out.masterModelName || '', memberCount: out.memberCount
      });
      return ok(res, out);
    }
    if (action === 'category_create') {
      const out = await categoryService.create({ name: v.string(body.name, 60), admin, now });
      rec(audit.ACTIONS.COMPAT_CATEGORY_CREATED, 'compatibility_category', out.id, { name: out.name, code: out.code, from: 'admin' });
      return ok(res, { ok: true, category: out });
    }
    const categoryId = v.docId(body.categoryId, 40);
    if (!categoryId) return bad(res, 'categoryId is required');
    if (action === 'category_rename') {
      const out = await categoryService.rename({ categoryId, name: v.string(body.name, 60), admin, now });
      rec(audit.ACTIONS.COMPAT_CATEGORY_RENAMED, 'compatibility_category', categoryId, { name: out.name, previousName: out.previousName });
      return ok(res, Object.assign({ ok: true }, out));
    }
    const out = await categoryService.remove({ categoryId, admin, now });
    rec(audit.ACTIONS.COMPAT_CATEGORY_DELETED, 'compatibility_category', categoryId, { name: out.name });
    return ok(res, Object.assign({ ok: true }, out));
  }

  if (action === 'undo_change') {
    const candidateId = v.docId(body.candidateId, 200);
    if (!candidateId) return bad(res, 'candidateId is required');
    const out = await review.undoProposal({ candidateId, admin, now });
    rec(audit.ACTIONS.COMPAT_CHANGE_UNDONE, 'compatibility_group', out.groupId || candidateId, {
      candidateId, removed: out.removedModelIds.join(', ').slice(0, 200), removedCount: out.removedModelIds.length,
      deletedGroup: out.deletedGroup || '', restoredGroups: (out.restoredGroups || []).join(', '), cancelledMerges: out.cancelledMerges.length
    });
    return ok(res, out);
  }

  if (action === 'continue') {
    const jobId = v.docId(body.jobId, 80);
    if (!jobId) return bad(res, 'jobId is required');
    const out = await jobService.continueJob({ jobId, admin, now });
    if (!out.ok) return json(res, out.status || 409, { error: out.error });
    rec(audit.ACTIONS.INSTAGRAM_JOB_CONTINUED, 'instagram_job', jobId, { autoApply: !!out.job.autoApply, postsFound: (out.job.counts || {}).postsFound || 0 });
    return ok(res, { ok: true, job: jobService.publicJob(out.job) });
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

  if (action === 'verify_providers') {
    /* Real calls with the configured keys — the only honest answer to "is it
       working?". The report says which key is set and whether its provider
       accepted it, and never anything about the key itself. */
    const report = await providerCheck.verifyProviders();
    rec(audit.ACTIONS.INSTAGRAM_PROVIDERS_VERIFIED, 'instagram_integration', 'providers', {
      gemini: report.providers.gemini.status, claude: report.providers.claude.status,
      instagram: report.providers.instagram.status, ready: report.ready
    });
    return ok(res, report);
  }

  if (action === 'add_evidence') {
    const contentKey = v.docId(body.contentKey, 120);
    if (!contentKey) return bad(res, 'contentKey is required');
    const parsed = evidenceImages(body.images);
    if (parsed.error) return bad(res, parsed.error);
    const out = await jobService.addEvidence({
      contentKey, admin, images: parsed.images,
      text: typeof body.text === 'string' ? body.text.slice(0, 8000) : '', now
    });
    if (!out.ok) return json(res, out.status || 409, { error: out.error });
    rec(audit.ACTIONS.INSTAGRAM_EVIDENCE_ADDED, 'instagram_content', contentKey, {
      jobId: out.jobId, images: out.added.filter(a => a.kind === 'image').length,
      text: out.added.some(a => a.kind === 'text'), unread: out.added.filter(a => a.status !== 'read').length,
      relevance: out.relevance || '', proposals: out.proposals
    });
    return ok(res, out);
  }

  if (action === 'approve_proposal') {
    const candidateId = v.docId(body.candidateId, 200);
    if (!candidateId) return bad(res, 'candidateId is required');
    let out;
    try {
      out = await review.approveProposal({
        candidateId, admin, acknowledgeLowConfidence: body.acknowledgeLowConfidence === true,
        expectedAdd: body.expectedAdd == null ? null : v.integer(body.expectedAdd, { min: 0, max: 500, fallback: null }), now
      });
    } catch (err) {
      if (err instanceof review.ReviewError && err.code === 'category-conflict') {
        rec(audit.ACTIONS.COMPAT_PROPOSAL_BLOCKED, 'compat_candidate', candidateId, {
          reason: 'model already assigned to another group in this category',
          blocked: (err.blocked || []).length,
          models: (err.blocked || []).slice(0, 5).map(b => b.modelId + '@' + b.existingGroupId).join(' ')
        });
      }
      throw err;
    }
    rec(audit.ACTIONS.COMPAT_PROPOSAL_APPROVED, 'compat_candidate', candidateId, {
      outcome: out.outcome, groupId: out.change ? out.change.groupId : '',
      added: out.change ? out.change.addedModelIds.length : 0,
      previousMemberCount: out.change ? out.change.previousMemberCount : null,
      newMemberCount: out.change ? out.change.newMemberCount : null,
      reassignRequests: (out.requests || []).length
    });
    return ok(res, out);
  }

  if (action.indexOf('proposal_') === 0) {
    const candidateId = v.docId(body.candidateId, 200);
    if (!candidateId) return bad(res, 'candidateId is required');
    let out;
    if (action === 'proposal_select_model') {
      const key = memberKey(body.memberKey), modelId = v.docId(body.modelId, 120);
      if (!key || !modelId) return bad(res, 'memberKey and modelId are required');
      out = await review.proposalSelectModel({ candidateId, memberKey: key, modelId, rememberAlias: body.rememberAlias === true, admin, now });
      if (out.alias && out.alias.learned) rec(audit.ACTIONS.COMPAT_ALIAS_LEARNED, 'alias', out.alias.key, { canonicalId: out.newModelId, candidateId });
    } else if (action === 'proposal_member_decision') {
      const key = memberKey(body.memberKey);
      if (!key) return bad(res, 'memberKey is required');
      out = await review.proposalMemberDecision({ candidateId, memberKey: key,
        decision: body.decision === null ? null : v.oneOf(body.decision, S.MEMBER_DECISIONS, 'invalid'), admin, now });
    } else if (action === 'proposal_add_model') {
      const modelId = v.docId(body.modelId, 120);
      if (!modelId) return bad(res, 'modelId is required');
      out = await review.proposalAddModel({ candidateId, modelId, admin, now });
    } else if (action === 'proposal_set_master') {
      const modelId = v.docId(body.modelId, 120);
      if (!modelId) return bad(res, 'modelId is required');
      out = await review.proposalSetMaster({ candidateId, modelId, admin, now });
    } else if (action === 'proposal_set_target') {
      out = await review.proposalSetTarget({ candidateId,
        groupId: body.groupId === 'new' ? 'new' : (body.groupId ? v.docId(body.groupId, 60) || null : null), admin, now });
    } else {
      out = await review.proposalRefresh({ candidateId, admin, now });
    }
    rec(audit.ACTIONS.COMPAT_PROPOSAL_EDITED, 'compat_candidate', candidateId, {
      edit: action.replace('proposal_', ''), memberKey: v.string(body.memberKey, 120),
      newValue: v.string(body.modelId || body.groupId || body.decision || '', 120),
      proposedAction: out.proposedAction, targetGroupId: out.targetGroupId || ''
    });
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
    const change = body.kind === 'group_proposal' ? review.proposalChangeCategory : review.changeCategory;
    const out = await change({ candidateId, categoryId: v.docId(body.categoryId, 60), admin, now });
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
