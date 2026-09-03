/* ============================================================================
   Mobile Parts Finder · api/_lib/razorpay-signature.js
   ----------------------------------------------------------------------------
   The two signature checks that stand between a browser and a free
   subscription. Pure crypto, no network, no SDK — which is what makes them
   testable without a Razorpay account (see razorpay-signature.test.js).

   CHECKOUT VERIFICATION
     After Razorpay Checkout succeeds it hands the browser three values. Only
     the signature proves they came from Razorpay rather than from the console:

       HMAC_SHA256(razorpay_order_id + "|" + razorpay_payment_id, KEY_SECRET)

     The secret never leaves the server, so a browser cannot forge this.

   WEBHOOK VERIFICATION
     Razorpay signs the RAW request body with a separate webhook secret:

       HMAC_SHA256(rawBody, WEBHOOK_SECRET)

     It must be the raw bytes. Parsing the JSON and re-serialising it changes
     key order and whitespace, the digest no longer matches, and every webhook
     starts failing for no visible reason — which is why the webhook route
     disables Vercel's body parser and reads the stream itself.

   Both comparisons are timing-safe. A plain === leaks how many leading bytes
   were correct, which is enough to reconstruct a signature byte by byte.
   ========================================================================== */
'use strict';

const crypto = require('crypto');

/**
 * Constant-time compare of two hex digests.
 * Length is checked first because timingSafeEqual throws on a mismatch, and
 * that throw would itself be an oracle.
 * @param {string} a
 * @param {string} b
 */
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let bufA, bufB;
  try {
    bufA = Buffer.from(a, 'hex');
    bufB = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * @param {string} payload
 * @param {string} secret
 * @returns {string} hex digest
 */
function hmacHex(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * Verifies a Checkout success payload.
 *
 * @param {object} args
 * @param {string} args.orderId    razorpay_order_id
 * @param {string} args.paymentId  razorpay_payment_id
 * @param {string} args.signature  razorpay_signature
 * @param {string} args.secret     RAZORPAY_KEY_SECRET
 * @returns {boolean}
 */
function verifyCheckoutSignature({ orderId, paymentId, signature, secret }) {
  if (!orderId || !paymentId || !signature || !secret) return false;
  return safeEqualHex(hmacHex(`${orderId}|${paymentId}`, secret), signature);
}

/**
 * Verifies a webhook delivery.
 *
 * @param {object} args
 * @param {string|Buffer} args.rawBody   the request body EXACTLY as received
 * @param {string} args.signature        x-razorpay-signature header
 * @param {string} args.secret           RAZORPAY_WEBHOOK_SECRET
 * @returns {boolean}
 */
function verifyWebhookSignature({ rawBody, signature, secret }) {
  if (!rawBody || !signature || !secret) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  return safeEqualHex(hmacHex(body, secret), signature);
}

module.exports = { verifyCheckoutSignature, verifyWebhookSignature, hmacHex, safeEqualHex };
