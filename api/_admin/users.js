/* ============================================================================
   GET /api/admin/users
   ----------------------------------------------------------------------------
   The user table: search, filter, sort, one page at a time.

   REAL PRODUCTION USERS ONLY. The rows come from users/{uid} joined to Firebase
   Authentication. Nothing is seeded, nothing is invented, and a field with no
   value comes back null so the table can print an em dash rather than a
   plausible-looking placeholder.

   ----------------------------------------------------------------------------
   PAGED, ALWAYS

   There is no "all users" response and no way to ask for one — the limit is
   capped in _lib/pagination.js. An admin table that downloads the customer
   list into a browser is slow, expensive, and puts every shop's phone number
   in a tab that might be left open on a counter.

   ----------------------------------------------------------------------------
   CONTACT DETAILS ARE A SEPARATE PERMISSION

   A role with users.read but not users.read_contact gets the same rows with
   the phone number and address removed HERE, on the server, before the
   response is built. Not hidden in the UI — absent from the payload.
   ========================================================================== */
'use strict';

const { requirePermission } = require('../_lib/admin-auth');
const { PERMISSIONS, can } = require('../_schema/roles');
const { ok, fail, requireMethod } = require('../_lib/http');
const users = require('../_services/user-directory-service');

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  try {
    const admin = await requirePermission(req, res, PERMISSIONS.USERS_READ);
    if (!admin) return;                                  /* reply already sent */

    const now = Date.now();
    const plan = users.parseQuery(req.query || {}, now);
    const page = await users.listUsers(plan);

    const showContact = can(admin.role, PERMISSIONS.USERS_READ_CONTACT);
    const showRevenue = can(admin.role, PERMISSIONS.REVENUE_READ);

    return ok(res, {
      users: page.users.map(u => project(u, { showContact, showRevenue })),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      /* True when some rows were filtered after the query came back, so the
         count on this page is "what matched here", not a total. Saying so
         beats printing a number whose meaning changes with the filter. */
      approximate: page.approximate,
      /* 'page' means highest-revenue sorted THIS page rather than the whole
         base — revenue is derived from the payments collection and is not a
         field the user query can order by. The UI labels it. */
      sortScope: page.sortScope,
      query: {
        search: plan.search || null,
        filter: plan.filter,
        sort: plan.sort,
        country: plan.country || null,
        limit: plan.limit
      },
      serverTime: now
    });
  } catch (err) {
    return fail(res, err, 'admin-users');
  }
};

/**
 * Strips what this role may not see.
 *
 * Deleting the keys rather than blanking them, so a client cannot tell a
 * withheld number from an absent one and start guessing at the difference.
 */
function project(user, { showContact, showRevenue }) {
  const out = { ...user };

  if (!showContact) {
    delete out.mobileNumber;
    delete out.mobileNumberE164;
    delete out.address;
  }
  if (!showRevenue) {
    out.billing = {
      successfulPayments: user.billing.successfulPayments,
      failedPayments: user.billing.failedPayments,
      lastPaymentAt: user.billing.lastPaymentAt
    };
  }
  return out;
}
