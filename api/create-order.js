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
const { paymentsConfigured, razorpayMode } = require('./_lib/config');
const { ok, bad, json, fail, unavailable, requireMethod, requireUser, body } = require('./_lib/http');

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const user = await requireUser(req, res);
    if (!user) return;                                   /* reply already sent */

    const plan = getPlan(body(req).planId);
    if (!plan) return bad(res, 'unknown plan');

    /* Not a crash, and it must not look like one. An unset key is a deployment
       that is not finished, so this answers 503 with a name the browser can act
       on — previously it was a 500, indistinguishable from a real fault, and
       the UI could only guess at the cause. /api/health reports the same state
       without needing a sign-in or a button press. */
    if (!paymentsConfigured()) {
      console.error(
        '[billing:create-order] payments unavailable — set RAZORPAY_KEY_ID and ' +
        'RAZORPAY_KEY_SECRET in the Vercel project environment, then redeploy'
      );
      return unavailable(res, 'payments-unconfigured', {
        missing: [
          !process.env.RAZORPAY_KEY_ID && 'RAZORPAY_KEY_ID',
          !process.env.RAZORPAY_KEY_SECRET && 'RAZORPAY_KEY_SECRET'
        ].filter(Boolean)
      });
    }
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

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

    /* Razorpay's own refusals are NOT server errors, and reporting them as one
       is what produced "Something went wrong starting the payment" for every
       cause alike — a rejected key, an unactivated live account, a currency the
       account cannot take. Those are three different things to go and fix, and
       the browser could not tell them apart because the reason never left this
       function.

       The description Razorpay returns is operator-facing text of its own
       ("Authentication failed", "Your account is not activated for live
       payments"). It carries no credential — the secret is never echoed by the
       API — so passing it through is safe, and it is the single most useful
       sentence in the whole flow. */
    let order;
    try {
      order = await razorpay.orders.create({
        amount: plan.amountPaise,
        currency: plan.currency,
        receipt,
        /* Notes travel back on the webhook, which has no Authorization header.
           They are how a webhook learns whose subscription this is — and they
           are cross-checked against our own stored order, never trusted alone. */
        notes: { uid: user.uid, planId: plan.id, email: user.email || '' }
      });
    } catch (rzpErr) {
      const detail = (rzpErr && rzpErr.error) || {};
      const status = Number(rzpErr && rzpErr.statusCode) || 0;

      console.error('[billing:create-order] Razorpay refused the order', {
        mode: razorpayMode(),
        statusCode: status,
        code: detail.code || null,
        description: detail.description || (rzpErr && rzpErr.message) || null,
        reason: detail.reason || null,
        field: detail.field || null,
        planId: plan.id,
        amountPaise: plan.amountPaise
      });

      /* 502: we are fine, the gateway refused us. A 500 would say the fault is
         in this code and send whoever reads it hunting the wrong thing. */
      return json(res, 502, {
        error: 'razorpay-refused',
        /* Razorpay's words, not ours — vague enough to be safe, specific
           enough to act on. */
        detail: detail.description || (rzpErr && rzpErr.message) || 'the payment gateway refused the order',
        code: detail.code || null,
        reason: detail.reason || null,
        field: detail.field || null,
        gatewayStatus: status || null,
        mode: razorpayMode()
      });
    }

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
      /* Derived from that same public prefix. It is here so the browser console
         says which mode a payment ran in — "it took the money" and "it took
         test money" look identical otherwise. */
      mode: razorpayMode(),
      prefill: pre.prefill
    });
  } catch (err) {
    return fail(res, err, 'create-order');
  }
};
