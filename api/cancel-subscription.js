/* ============================================================================
   POST /api/cancel-subscription
   ----------------------------------------------------------------------------
   Stops the subscription renewing. It does NOT revoke access: the subscriber
   paid for a period and keeps it to the end of that period, after which the
   status derives to `expired` on its own.

   Nothing is refunded here, and nothing is deleted — the billing history stays
   for reconciliation.
   ========================================================================== */
'use strict';

const { db } = require('./_lib/firebase');
const { readAccess } = require('./_lib/store');
const { ok, bad, fail, requireMethod, requireUser } = require('./_lib/http');

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const now = Date.now();
    const access = await readAccess(user.uid, now);
    if (access.state !== 'active') return bad(res, 'no active subscription');

    const firestore = db();
    await Promise.all([
      firestore.collection('users').doc(user.uid).set({
        activeSubscriptionStatus: 'cancelled',
        cancelledAt: now,
        updatedAt: now
      }, { merge: true }),
      access.subscriptionId
        ? firestore.collection('subscriptions').doc(access.subscriptionId).set({
            status: 'cancelled', cancelledAt: now, updatedAt: now
          }, { merge: true })
        : Promise.resolve()
    ]);

    return ok(res, {
      ok: true,
      state: 'cancelling',
      accessUntil: access.expiresAt
    });
  } catch (err) {
    return fail(res, err, 'cancel-subscription');
  }
};
