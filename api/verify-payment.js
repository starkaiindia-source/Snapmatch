/* ============================================================================
   POST /api/verify-payment
   ----------------------------------------------------------------------------
   Step 2. The only door through which a subscription becomes active from the
   browser's side.

   Checkout hands the page three values. On their own they prove nothing — any
   of them can be typed into a console. What proves the payment is the
   signature, an HMAC over "order_id|payment_id" keyed with the Razorpay
   secret, which exists only on this side. So the order of checks is:

     1. the caller is a signed-in Firebase user
     2. the signature is genuine
     3. the order was one WE created, for THIS uid
     4. the captured amount equals the catalogue price for that plan
     5. only then does access get granted

   Step 3 is what stops the substitution attack: sign in as yourself, pay ₹99
   for your own monthly order, then post that valid pair against someone else's
   yearly order. The signature is real, so steps 1 and 2 both pass; the uid on
   the stored order is what refuses it.

   Step 4 is checked against Razorpay's own record of the payment, fetched here
   rather than taken from the request, because the request's copy is written by
   the browser.
   ========================================================================== */
'use strict';

const Razorpay = require('razorpay');
const { getPlan, amountMatches } = require('./_lib/plans');
const { verifyCheckoutSignature } = require('./_lib/razorpay-signature');
const { getOrder, activateSubscription, recordFailure } = require('./_lib/store');
const { ok, bad, forbidden, fail, requireMethod, requireUser, body } = require('./_lib/http');

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature
    } = body(req);

    if (!orderId || !paymentId || !signature) {
      return bad(res, 'missing payment fields');
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) return fail(res, new Error('RAZORPAY_KEY_SECRET missing'), 'config');

    /* ---- 2. is the signature genuine? ---------------------------------- */
    if (!verifyCheckoutSignature({ orderId, paymentId, signature, secret: keySecret })) {
      await recordFailure({
        orderId, paymentId, uid: user.uid,
        reason: 'signature verification failed', now: Date.now()
      });
      return forbidden(res, 'payment verification failed');
    }

    /* ---- 3. is this our order, and is it this user's? ------------------ */
    const order = await getOrder(orderId);
    if (!order) return bad(res, 'unknown order');
    if (order.uid !== user.uid) {
      console.warn('[billing:verify] uid mismatch', { orderId, expected: order.uid, got: user.uid });
      return forbidden(res, 'order does not belong to this account');
    }

    const plan = getPlan(order.planId);
    if (!plan) return bad(res, 'plan no longer available');

    /* ---- 4. did Razorpay actually capture the right amount? ------------ */
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: keySecret
    });
    const payment = await razorpay.payments.fetch(paymentId);

    if (payment.order_id !== orderId) {
      return forbidden(res, 'payment does not belong to this order');
    }
    if (payment.status !== 'captured' && payment.status !== 'authorized') {
      await recordFailure({
        orderId, paymentId, uid: user.uid,
        reason: `payment status ${payment.status}`, now: Date.now()
      });
      return bad(res, 'payment not completed', { status: payment.status });
    }
    if (!amountMatches(plan, payment.amount, payment.currency)) {
      console.warn('[billing:verify] amount mismatch', {
        orderId, paid: payment.amount, expected: plan.amountPaise
      });
      return forbidden(res, 'amount mismatch');
    }

    /* ---- 5. grant access (idempotent) ---------------------------------- */
    const result = await activateSubscription({
      uid: user.uid,
      email: user.email,
      displayName: user.name,
      /* Reached only past the signature check above. */
      signatureVerified: true,
      plan,
      orderId,
      paymentId,
      amountPaise: payment.amount,
      currency: payment.currency,
      now: Date.now(),
      source: 'checkout'
    });

    return ok(res, {
      ok: true,
      alreadyProcessed: result.alreadyProcessed,
      planId: result.planId,
      startedAt: result.startedAt,
      expiresAt: result.expiresAt,
      status: 'active'
    });
  } catch (err) {
    return fail(res, err, 'verify-payment');
  }
};
