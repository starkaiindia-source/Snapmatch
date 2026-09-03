/* ============================================================================
   GET /api/subscription
   ----------------------------------------------------------------------------
   The server's answer to "does this account have access right now", and the
   only answer the app is allowed to believe.

   Access is never decided in the browser. A device clock can be set forward,
   localStorage can be edited, and a JS variable can be flipped in the console —
   so the client asks this route on every load and renders whatever it says. The
   expiry check happens here, against the server clock.

   It also self-heals: readAccess writes the stored status back to `expired`
   when the date has passed, so a lapsed subscription stops describing itself
   as active for every future reader.
   ========================================================================== */
'use strict';

const { readAccess, listSubscriptions } = require('./_lib/store');
const { ok, fail, requireMethod, requireUser } = require('./_lib/http');

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const now = Date.now();
    const access = await readAccess(user.uid, now);
    const history = await listSubscriptions(user.uid, 12);

    return ok(res, {
      uid: user.uid,
      email: user.email,
      serverTime: now,          /* lets the UI count down without trusting the device */
      access,
      history: history.map(h => ({
        subscriptionId: h.razorpayOrderId,
        planId: h.planId,
        billingPeriod: h.billingPeriod,
        amount: h.amount,
        currency: h.currency,
        status: h.status,
        paymentId: h.paymentId || null,
        startedAt: h.startedAt ?? null,
        expiresAt: h.expiresAt ?? null
      }))
    });
  } catch (err) {
    return fail(res, err, 'subscription');
  }
};
