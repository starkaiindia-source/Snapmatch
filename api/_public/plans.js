/* ============================================================================
   GET /api/plans
   ----------------------------------------------------------------------------
   The pricing the page displays, from the same catalogue that decides what
   Razorpay charges. Two copies of a price drift; one does not.

   Public and unauthenticated on purpose — a signed-out visitor has to be able
   to see what a plan costs before deciding to sign in.
   ========================================================================== */
'use strict';

const { publicCatalogue } = require('../_lib/plans');
const { ok, fail, requireMethod } = require('../_lib/http');

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;
  try {
    return ok(res, { plans: publicCatalogue() });
  } catch (err) {
    return fail(res, err, 'plans');
  }
};
