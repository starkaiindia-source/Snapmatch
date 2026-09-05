/* ============================================================================
   Mobile Parts Finder · api/_services/audit-service.js
   ----------------------------------------------------------------------------
   A record of what administrators did.

   ----------------------------------------------------------------------------
   WHAT IS LOGGED

   Actions that CHANGE something, and reads of the most sensitive data. Not
   every page view — an audit log nobody can read through is an audit log
   nobody reads.

   Specifically:
     · granting or revoking an admin role
     · changing a user's account status
     · moving a missing-model request through the workflow, and publishing one
     · approving or rejecting an AI-proposed change
     · opening an individual user's full record, which includes their phone
       number and address

   That last one is in the list on purpose. Reading one customer's contact
   details is a legitimate support action and also the exact shape of misuse,
   and the difference between the two is visible only in the pattern. Logging
   it costs one small write and makes the pattern visible.

   ----------------------------------------------------------------------------
   THE LOG DOES NOT CONTAIN WHAT IT IS ABOUT

   An entry records WHO, WHAT, WHICH RECORD and WHEN. It does not copy the data
   that was read into itself — an audit trail of profile reads that embeds the
   profiles is a second, less protected copy of every customer's phone number.

   ----------------------------------------------------------------------------
   APPEND ONLY

   No update path, no delete path, and `allow write: if false` in the rules so
   not even a signed-in super_admin can edit one from a browser. The Admin SDK
   writes; nothing rewrites.
   ========================================================================== */
'use strict';

const { db } = require('../_lib/firebase');
const { ADMIN_AUDIT_LOG } = require('../_schema/collections');
const v = require('../_lib/validate');

/** The action vocabulary. A closed list, for the same reason event types are. */
const ACTIONS = {
  ADMIN_GRANTED: 'admin.granted',
  ADMIN_REVOKED: 'admin.revoked',
  USER_VIEWED: 'user.viewed',
  USER_STATUS_CHANGED: 'user.status_changed',
  MISSING_MODEL_TRANSITIONED: 'missing_model.transitioned',
  MISSING_MODEL_PUBLISHED: 'missing_model.published',
  AI_TASK_CREATED: 'ai_task.created',
  AI_TASK_APPROVED: 'ai_task.approved',
  AI_TASK_REJECTED: 'ai_task.rejected',
  EXPORT_REQUESTED: 'export.requested'
};

const ACTION_LIST = Object.values(ACTIONS);

/**
 * Appends one entry.
 *
 * NEVER throws. An audit write that fails must not fail the action it is
 * describing — a support agent should not be blocked from helping a customer
 * because the log is unavailable. The failure is logged to the function log,
 * which is itself a record.
 *
 * @param {object} args
 * @param {string} args.actorUid
 * @param {string} args.actorRole
 * @param {string} args.action        from ACTIONS
 * @param {string} [args.targetType]  'user' | 'admin' | 'missing_model' | 'ai_task'
 * @param {string} [args.targetId]
 * @param {object} [args.detail]      small, structured, no PII
 * @param {number} args.now
 */
async function record({ actorUid, actorRole, action, targetType, targetId, detail, now }) {
  if (ACTION_LIST.indexOf(action) < 0) {
    console.warn('[audit] unknown action, not recorded', action);
    return;
  }

  try {
    await db().collection(ADMIN_AUDIT_LOG).doc().set({
      actorUid: v.uid(actorUid) || null,
      actorRole: v.string(actorRole, 40) || null,
      action,
      targetType: v.string(targetType, 40) || null,
      targetId: v.string(targetId, 200) || null,
      detail: sanitiseDetail(detail),
      at: now
    });
  } catch (err) {
    console.error('[audit] FAILED to record', { action, targetId, message: err && err.message });
  }
}

/**
 * Detail is a handful of short scalars and nothing else.
 *
 * Not a place to stash the record that was changed: see the header. Objects
 * and arrays are dropped rather than serialised, because "let me just JSON this
 * in for debugging" is how a phone number ends up in an audit row.
 */
function sanitiseDetail(detail) {
  if (!detail || typeof detail !== 'object') return {};
  const out = {};
  Object.keys(detail).slice(0, 12).forEach(key => {
    const value = detail[key];
    const name = v.string(key, 40);
    if (!name) return;
    if (typeof value === 'number' && Number.isFinite(value)) out[name] = value;
    else if (typeof value === 'boolean') out[name] = value;
    else if (typeof value === 'string') out[name] = v.string(value, 200);
  });
  return out;
}

/** Newest first. Read by the admin audit page, which is super_admin-only. */
async function list({ action, actorUid, targetId, limit = 50 }) {
  let q = db().collection(ADMIN_AUDIT_LOG);
  if (action && ACTION_LIST.indexOf(action) > -1) q = q.where('action', '==', action);
  if (actorUid) q = q.where('actorUid', '==', actorUid);
  if (targetId) q = q.where('targetId', '==', targetId);

  try {
    const snap = await q.orderBy('at', 'desc').limit(Math.min(200, limit)).get();
    return snap.docs.map(d => ({ entryId: d.id, ...d.data() }));
  } catch (err) {
    console.warn('[audit] list failed', err && (err.code || err.message));
    return [];
  }
}

module.exports = { ACTIONS, ACTION_LIST, record, list };
