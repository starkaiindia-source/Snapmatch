/* ============================================================================
   GET /api/admin/session
   ----------------------------------------------------------------------------
   "Am I an administrator, and what may I do?"

   The first call the admin app makes, and the ONLY thing that decides whether
   it renders. The browser never works this out for itself — it holds a
   Firebase ID token like any signed-in customer, and what makes that token an
   admin's is a record on the server it cannot see or change.

   A normal customer calling this gets 403 and the admin app sends them back to
   the site. That redirect is a courtesy, not a control: even if they stayed,
   every other admin route would refuse them too, and the admin collections are
   closed to every client in firestore.rules regardless of role.

   The permission list in the response exists so the UI can hide what this
   person cannot use. It is presentation. Every route re-checks.
   ========================================================================== */
'use strict';

const { requireAdmin } = require('../_lib/admin-auth');
const { ok, fail, requireMethod } = require('../_lib/http');
const { report } = require('../_lib/config');
const aiService = require('../_services/ai-service');
const searchService = require('../_services/search-service');

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;                                  /* reply already sent */

    const config = report();

    return ok(res, {
      admin: {
        uid: admin.uid,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        permissions: admin.permissions,
        /* True when the token's claim disagrees with the registry. The UI
           tells the admin to sign out and back in; the registry has already
           won, so nothing is broken meanwhile. */
        claimStale: admin.claimStale
      },
      serverTime: Date.now(),
      /* Presence booleans only — no value of any environment variable leaves
         the server, here or anywhere else. */
      services: {
        firebaseAdmin: config.firebaseAdmin.configured,
        payments: config.payments.configured,
        paymentMode: config.payments.mode,
        webhook: config.payments.webhook,
        ai: aiService.status(),
        catalogue: searchService.indexStatus()
      }
    });
  } catch (err) {
    return fail(res, err, 'admin-session');
  }
};
