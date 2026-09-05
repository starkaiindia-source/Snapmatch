/* ============================================================================
   GET /api/admin/audit
   ----------------------------------------------------------------------------
   What administrators did, newest first.

   Read-only, and there is no route that writes or deletes an entry — the
   collection is append-only through the Admin SDK and closed to every client
   in firestore.rules. An audit log an administrator can edit is a log that
   proves nothing.
   ========================================================================== */
'use strict';

const { requirePermission } = require('../_lib/admin-auth');
const { PERMISSIONS } = require('../_schema/roles');
const { ok, fail, requireMethod } = require('../_lib/http');
const audit = require('../_services/audit-service');
const v = require('../_lib/validate');

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  try {
    const admin = await requirePermission(req, res, PERMISSIONS.AUDIT_READ);
    if (!admin) return;

    const q = req.query || {};
    const entries = await audit.list({
      action: v.oneOf(q.action, audit.ACTION_LIST, null),
      actorUid: v.uid(q.actorUid) || null,
      targetId: v.string(q.targetId, 200) || null,
      limit: v.integer(q.limit, { min: 1, max: 200, fallback: 100 })
    });

    return ok(res, { entries, actions: audit.ACTION_LIST, serverTime: Date.now() });
  } catch (err) {
    return fail(res, err, 'admin-audit');
  }
};
