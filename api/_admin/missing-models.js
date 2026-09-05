/* ============================================================================
   GET  /api/admin/missing-models     the review queue, by demand
   POST /api/admin/missing-models     move one through the workflow
   ----------------------------------------------------------------------------
   Handsets people searched for and did not find, aggregated per model rather
   than per search — see _schema/missing-model-request.js for why that
   distinction is the whole design.

   ----------------------------------------------------------------------------
   PUBLISHING IS A SEPARATE PERMISSION FROM REVIEWING

   `under_review`, `researching`, `draft_found`, `duplicate`,
   `not_a_valid_model` need missing_models.write. Moving to `published` needs
   missing_models.publish, which support and analyst roles do not have.

   That split exists because publishing is the step that changes what shops see
   on the site. Triaging a queue and altering the production catalogue are
   different acts and should not share a permission just because they share a
   page.

   The transition table refuses illegal jumps regardless of permission, so
   `new -> published` is impossible for anyone — including a super_admin, and
   including a bug.
   ========================================================================== */
'use strict';

const { requirePermission } = require('../_lib/admin-auth');
const { PERMISSIONS } = require('../_schema/roles');
const { ok, bad, json, fail, notAllowed } = require('../_lib/http');
const missing = require('../_services/missing-model-service');
const audit = require('../_services/audit-service');
const { STATUSES } = require('../_schema/missing-model-request');
const v = require('../_lib/validate');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') return await list(req, res);
    if (req.method === 'POST') return await update(req, res);
    return notAllowed(res);
  } catch (err) {
    return fail(res, err, 'admin-missing-models');
  }
};

async function list(req, res) {
  const admin = await requirePermission(req, res, PERMISSIONS.MISSING_MODELS_READ);
  if (!admin) return;

  const q = req.query || {};
  const page = await missing.listRequests({
    status: v.oneOf(q.status, STATUSES, null),
    sort: v.oneOf(q.sort, ['demand', 'newest', 'recent'], 'demand'),
    limit: q.limit,
    cursor: q.cursor
  });

  return ok(res, {
    ...page,
    statuses: STATUSES,
    serverTime: Date.now()
  });
}

async function update(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const key = v.docId(body.key, 80);
  const to = v.oneOf(body.status, STATUSES, null);
  if (!key) return bad(res, 'key is required');
  if (!to) return bad(res, 'status must be one of: ' + STATUSES.join(', '));

  /* Publishing is the step that reaches the live catalogue, so it is gated on
     its own permission rather than on "can edit this queue". */
  const permission = to === 'published'
    ? PERMISSIONS.MISSING_MODELS_PUBLISH
    : PERMISSIONS.MISSING_MODELS_WRITE;

  const admin = await requirePermission(req, res, permission);
  if (!admin) return;

  const now = Date.now();
  const result = await missing.transition({
    key,
    to,
    adminUid: admin.uid,
    notes: body.notes,
    patch: {
      candidateBrandId: body.candidateBrandId,
      candidateModelName: body.candidateModelName,
      duplicateOfModelId: body.duplicateOfModelId,
      publishedModelId: body.publishedModelId
    },
    now
  });

  if (!result.ok) {
    /* 409, not 400: the request is well formed, the record is simply not in a
       state this move is legal from. A different status code because a
       different thing went wrong, and the UI can refresh and retry. */
    return json(res, 409, { error: result.reason, from: result.from, requested: to });
  }

  audit.record({
    actorUid: admin.uid,
    actorRole: admin.role,
    action: to === 'published'
      ? audit.ACTIONS.MISSING_MODEL_PUBLISHED
      : audit.ACTIONS.MISSING_MODEL_TRANSITIONED,
    targetType: 'missing_model',
    targetId: key,
    detail: { from: result.from, to },
    now
  });

  return ok(res, { key, from: result.from, status: to, unchanged: !!result.unchanged });
}
