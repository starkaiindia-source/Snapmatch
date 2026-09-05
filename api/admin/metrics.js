/* ============================================================================
   GET /api/admin/metrics
   ----------------------------------------------------------------------------
   The dashboard's numbers.

   Every figure is counted from production data or reported as unavailable.
   Where there is nothing to count the answer is 0 or null and the UI says
   "No data yet" — which is a different statement from zero, and the two are
   told apart rather than blurred.

   Revenue is behind revenue.read, so a support role gets the same response
   with the revenue block absent. Absent, not zeroed: a zero would read as "no
   money came in".
   ========================================================================== */
'use strict';

const { requireAdmin } = require('../_lib/admin-auth');
const { PERMISSIONS, can } = require('../_schema/roles');
const { ok, forbidden, fail, requireMethod } = require('../_lib/http');
const metrics = require('../_services/metrics-service');
const v = require('../_lib/validate');

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    /* The dashboard needs one of these two to show anything at all. A role
       with neither has no business on this page. */
    const maySeeUsers = can(admin.role, PERMISSIONS.USERS_READ);
    const maySeeAnalytics = can(admin.role, PERMISSIONS.ANALYTICS_READ);
    if (!maySeeUsers && !maySeeAnalytics) {
      return forbidden(res, 'not authorised for this action');
    }

    const now = Date.now();
    const growthDays = v.integer((req.query || {}).days, { min: 7, max: 180, fallback: 30 });

    const data = await metrics.dashboard({
      now,
      growthDays,
      includeRevenue: can(admin.role, PERMISSIONS.REVENUE_READ)
    });

    return ok(res, data);
  } catch (err) {
    return fail(res, err, 'admin-metrics');
  }
};
