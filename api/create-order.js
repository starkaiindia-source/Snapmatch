/* ============================================================================
   POST /api/create-order
   ----------------------------------------------------------------------------
   Step 1 of the payment flow. Takes a plan id from a signed-in user and
   returns a Razorpay order plus the PUBLIC key id, which is all Checkout needs.

   The request carries a plan id and nothing else. Amount, currency and period
   are read from the server-side catalogue, so the browser has no field it can
   edit to change what it is charged. Sending `{ planId: "monthly", amount: 1 }`
   still creates a ₹99 order, because `amount` is not read.

   The order is recorded as pending before it is returned. If the browser then
   dies mid-payment, the webhook still arrives and can attribute the payment to
   a uid and a plan — without that row it would be an orphan.
   ========================================================================== */
'use strict';

const Razorpay = require('razorpay');
const { getPlan } = require('./_lib/plans');
const { recordPendingOrder, readProfile, prefillFrom } = require('./_lib/store');
const { ok, bad, json, fail, requireMethod, requireUser, body } = require('./_lib/http');

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const user = await requireUser(req, res);
    if (!user) return;                                   /* reply already sent */

    const plan = getPlan(body(req).planId);
    if (!plan) return bad(res, 'unknown plan');

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      console.error('[billing:create-order] Razorpay keys are not configured');
      return fail(res, new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing'), 'config');
    }

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const now = Date.now();

    /* `receipt` is capped at 40 characters by Razorpay, and a uid alone can be
       28, so it is truncated deliberately rather than by accident. */
    const receipt = `mpf_${plan.id}_${user.uid.slice(0, 18)}_${now.toString(36)}`.slice(0, 40);

    /* Refuse to start a payment the buyer cannot finish cleanly. Without a
       stored phone number Checkout inserts its own contact step, and a shop
       that has not told us its name is one we cannot put on an invoice. The
       response names the missing fields so the UI can open the right form and
       come straight back to this plan. */
    const profile = await readProfile(user.uid);
    const pre = prefillFrom(profile, user);
    if (!pre.complete) {
      return json(res, 409, {
        error: 'profile-incomplete',
        missing: pre.missing,
        planId: plan.id
      });
    }

    const order = await razorpay.orders.create({
      amount: plan.amountPaise,
      currency: plan.currency,
      receipt,
      /* Notes travel back on the webhook, which has no Authorization header.
         They are how a webhook learns whose subscription this is — and they
         are cross-checked against our own stored order, never trusted alone. */
      notes: { uid: user.uid, planId: plan.id, email: user.email || '' }
    });

    await recordPendingOrder({
      orderId: order.id,
      uid: user.uid,
      email: user.email,
      displayName: user.name,
      plan,
      amountPaise: plan.amountPaise,
      currency: plan.currency,
      now
    });

    return ok(res, {
      orderId: order.id,
      amount: plan.amountPaise,
      currency: plan.currency,
      planId: plan.id,
      planName: plan.name,
      /* The key ID is public by design — it identifies the merchant to
         Checkout. The SECRET never appears in any response. */
      keyId,
      prefill: pre.prefill
    });
  } catch (err) {
    return fail(res, err, 'create-order');
  }
};
