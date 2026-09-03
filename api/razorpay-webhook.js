/* ============================================================================
   POST /api/razorpay-webhook
   ----------------------------------------------------------------------------
   Razorpay's own report of what happened, and the reason a payment is not lost
   when the browser is closed mid-checkout.

   This route has NO Authorization header — Razorpay is the caller, not a user.
   Its only proof of authenticity is the HMAC over the raw request body, which
   is why the body parser is switched off below. Parsing the JSON and
   re-serialising it changes the bytes, the digest stops matching, and every
   delivery silently fails.

   The uid is never taken from the webhook payload alone. It is read from our
   own stored order, which was written before Checkout opened. The notes on the
   Razorpay order are only used as a fallback when that row is missing, and
   even then the order id has to match.

   Duplicate deliveries are expected: Razorpay retries until it gets a 2xx, and
   the browser has usually already verified the same payment. activateSubscription
   is keyed on the payment id, so the second and later arrivals change nothing.

   Always answer 2xx once the signature is valid, even for events we ignore. A
   non-2xx tells Razorpay to retry forever.
   ========================================================================== */
'use strict';

const { getPlan, amountMatches } = require('./_lib/plans');
const { verifyWebhookSignature } = require('./_lib/razorpay-signature');
const { getOrder, activateSubscription, recordFailure } = require('./_lib/store');
const { ok, json, fail, readRawBody } = require('./_lib/http');

const HANDLED = new Set(['payment.captured', 'payment.authorized', 'payment.failed', 'order.paid']);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      console.error('[billing:webhook] RAZORPAY_WEBHOOK_SECRET is not set');
      return json(res, 500, { error: 'webhook not configured' });
    }

    const rawBody = await readRawBody(req);
    const signature = req.headers['x-razorpay-signature'];

    if (!verifyWebhookSignature({ rawBody, signature, secret })) {
      /* 400, not 401: this is not an auth challenge and Razorpay should not
         retry a delivery it cannot sign correctly. */
      console.warn('[billing:webhook] rejected: bad signature');
      return json(res, 400, { error: 'invalid signature' });
    }

    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return json(res, 400, { error: 'invalid json' });
    }

    const type = event.event;
    if (!HANDLED.has(type)) {
      /* Acknowledge, or Razorpay keeps retrying an event we will never act on. */
      return ok(res, { received: true, ignored: type });
    }

    const payment = event.payload?.payment?.entity;
    const orderEntity = event.payload?.order?.entity;
    const orderId = payment?.order_id || orderEntity?.id;
    const now = Date.now();

    if (!orderId) return ok(res, { received: true, ignored: 'no order id' });

    if (type === 'payment.failed') {
      await recordFailure({
        orderId,
        paymentId: payment?.id || null,
        uid: payment?.notes?.uid || null,
        reason: payment?.error_description || 'payment failed',
        now
      });
      return ok(res, { received: true, recorded: 'failed' });
    }

    /* Our own record of the order is the source of truth for who it belongs
       to. The notes are a fallback for the rare case where the order row is
       missing, and they still have to line up with a real plan. */
    const order = await getOrder(orderId);
    const uid = order?.uid || payment?.notes?.uid || null;
    const planId = order?.planId || payment?.notes?.planId || null;

    if (!uid || !planId) {
      console.warn('[billing:webhook] unattributable payment', { orderId, type });
      return ok(res, { received: true, ignored: 'unattributable' });
    }

    const plan = getPlan(planId);
    if (!plan) return ok(res, { received: true, ignored: 'unknown plan' });

    if (payment && !amountMatches(plan, payment.amount, payment.currency)) {
      console.warn('[billing:webhook] amount mismatch', {
        orderId, paid: payment.amount, expected: plan.amountPaise
      });
      return ok(res, { received: true, ignored: 'amount mismatch' });
    }

    const paymentId = payment?.id;
    if (!paymentId) return ok(res, { received: true, ignored: 'no payment id' });

    const result = await activateSubscription({
      uid,
      email: order?.email || payment?.notes?.email || null,
      displayName: order?.displayName || null,
      /* The delivery itself was HMAC-verified above, so this payment is
         trusted — but by the webhook signature, not by a checkout signature.
         The record says which, because they are different proofs. */
      signatureVerified: true,
      plan,
      orderId,
      paymentId,
      amountPaise: payment.amount,
      currency: payment.currency,
      now,
      source: 'webhook'
    });

    return ok(res, {
      received: true,
      alreadyProcessed: result.alreadyProcessed,
      expiresAt: result.expiresAt
    });
  } catch (err) {
    /* A 500 makes Razorpay retry, which is what we want for a transient
       Firestore failure — the delivery should not be dropped. */
    return fail(res, err, 'webhook');
  }
};

/* Vercel must not touch the body — the signature covers the exact bytes.
   This has to come AFTER the handler assignment above: `module.exports = fn`
   replaces the whole exports object, so setting .config first would silently
   throw it away and every delivery would fail on a re-serialised body. */
module.exports.config = { api: { bodyParser: false } };
