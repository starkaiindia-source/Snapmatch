/* ============================================================================
   GET  /api/admin/ai      gateway status and the approval queue
   POST /api/admin/ai      run a capability, or decide on a proposal
   ----------------------------------------------------------------------------
   The admin's window onto the Local LLM.

   ----------------------------------------------------------------------------
   NOTHING HERE PUBLISHES ANYTHING

   `action: "run"` asks the gateway for a draft and stores it as an aiTask with
   `status: 'draft'`. `action: "review"` marks a draft approved or rejected. An
   approved draft is still not applied — applying a catalogue change goes
   through the missing-models workflow and the importer, both of which are
   separate, explicit, human-driven steps.

   Three deliberate stops between "the model produced something" and "shops see
   it on the site". That is what makes the automation safe to leave running.

   ----------------------------------------------------------------------------
   WITH NO GATEWAY CONFIGURED

   `run` answers 503 with the environment variables to set. It does not
   fabricate a response, and there is no demo mode — a fake AI answer stored as
   a real draft is the fastest possible way to get invented data approved by
   someone in a hurry.
   ========================================================================== */
'use strict';

const { requirePermission } = require('../_lib/admin-auth');
const { PERMISSIONS } = require('../_schema/roles');
const { ok, bad, json, fail, unavailable, notAllowed } = require('../_lib/http');
const ai = require('../_services/ai-service');
const audit = require('../_services/audit-service');
const v = require('../_lib/validate');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') return await overview(req, res);
    if (req.method === 'POST') return await act(req, res);
    return notAllowed(res);
  } catch (err) {
    return fail(res, err, 'admin-ai');
  }
};

async function overview(req, res) {
  const admin = await requirePermission(req, res, PERMISSIONS.AI_READ);
  if (!admin) return;

  const q = req.query || {};
  const tasks = await ai.listTasks({
    status: v.oneOf(q.status, ai.TASK_STATUSES, null),
    type: v.oneOf(q.type, ai.TASK_TYPES, null),
    limit: v.integer(q.limit, { min: 1, max: 200, fallback: 50 })
  });

  return ok(res, {
    gateway: ai.status(),
    taskTypes: ai.TASK_TYPES,
    taskStatuses: ai.TASK_STATUSES,
    tasks,
    serverTime: Date.now()
  });
}

async function act(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = v.oneOf(body.action, ['run', 'review'], null);
  if (!action) return bad(res, 'action must be "run" or "review"');

  const now = Date.now();

  if (action === 'run') {
    const admin = await requirePermission(req, res, PERMISSIONS.AI_RUN);
    if (!admin) return;

    if (!ai.isConfigured()) {
      return unavailable(res, 'ai-unconfigured', { missing: ai.status().missing });
    }

    const capability = v.oneOf(body.capability, ai.CAPABILITIES.map(c => c.id), null);
    const type = v.oneOf(body.type, ai.TASK_TYPES, null);
    if (!capability) return bad(res, 'unknown capability');
    if (!type) return bad(res, 'unknown task type');

    const result = await ai.invoke({
      capability,
      systemHint: v.string(body.systemHint, 2000) || null,
      /* The input is passed through as the admin composed it. It is business
         context — catalogue facts, aggregated counts — and the route does not
         invent any: an admin asking for an insight supplies what it is about. */
      input: body.input && typeof body.input === 'object' ? body.input : {}
    });

    if (!result.ok) {
      return json(res, 502, { error: result.reason, detail: result.detail || null });
    }

    const task = await ai.createTask({
      type,
      capability,
      payload: result.output,
      sourceRef: body.sourceRef && typeof body.sourceRef === 'object' ? body.sourceRef : null,
      createdBy: admin.uid,
      prompt: v.string(body.systemHint, 500) || capability,
      now
    });

    audit.record({
      actorUid: admin.uid, actorRole: admin.role,
      action: audit.ACTIONS.AI_TASK_CREATED,
      targetType: 'ai_task', targetId: task.taskId,
      detail: { type, capability }, now
    });

    return ok(res, { task });
  }

  /* ---- review ---- */
  const admin = await requirePermission(req, res, PERMISSIONS.AI_APPROVE);
  if (!admin) return;

  const taskId = v.docId(body.taskId, 60);
  const decision = v.oneOf(body.decision, ['approved', 'rejected'], null);
  if (!taskId) return bad(res, 'taskId is required');
  if (!decision) return bad(res, 'decision must be "approved" or "rejected"');

  const result = await ai.reviewTask({
    taskId, decision, adminUid: admin.uid, notes: body.notes, now
  });
  if (!result.ok) return json(res, 409, { error: result.reason });

  audit.record({
    actorUid: admin.uid, actorRole: admin.role,
    action: decision === 'approved'
      ? audit.ACTIONS.AI_TASK_APPROVED
      : audit.ACTIONS.AI_TASK_REJECTED,
    targetType: 'ai_task', targetId: taskId,
    detail: { from: result.from, to: decision }, now
  });

  return ok(res, {
    taskId,
    status: decision,
    /* Said plainly in the response so nobody reads "approved" as "live". */
    note: decision === 'approved'
      ? 'Approved. This is not published: applying a catalogue change is a separate step.'
      : 'Rejected.'
  });
}
