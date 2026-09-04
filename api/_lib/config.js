/* ============================================================================
   Mobile Parts Finder · api/_lib/config.js
   ----------------------------------------------------------------------------
   One place that answers "is this deployment actually configured?".

   Every route used to discover a missing environment variable on its own, deep
   inside a request, and report it as a 500 — which reads identically to a
   crash. A shop owner pressing Subscribe then sees "Payment service is not
   configured yet" whether the cause is an unset key, a bad service account or a
   genuine bug, and there is no way to tell them apart from outside.

   So configuration is checked HERE, by name, and the answer is a value the
   routes and /api/health can both use.

   NOTHING IN THIS FILE READS A SECRET'S VALUE INTO A RESPONSE. It reports
   presence only. The one exception is the Razorpay key MODE — `rzp_test` vs
   `rzp_live` — which is derived from the key id's public prefix. That id is
   sent to every browser to open Checkout, so its prefix is not a secret, and
   knowing which mode is live is the single most useful thing when a payment
   behaves unexpectedly.
   ========================================================================== */
'use strict';

/** Present means set to a non-empty, non-whitespace string. */
function has(name) {
  return typeof process.env[name] === 'string' && process.env[name].trim() !== '';
}

/**
 * Razorpay: test mode, live mode, or not configured at all.
 * @returns {'test'|'live'|'unknown'|null} null when there is no key id
 */
function razorpayMode() {
  const id = (process.env.RAZORPAY_KEY_ID || '').trim();
  if (!id) return null;
  if (id.startsWith('rzp_test')) return 'test';
  if (id.startsWith('rzp_live')) return 'live';
  return 'unknown';
}

/**
 * Can a payment be started right now?
 *
 * The webhook secret is deliberately NOT required: without it Razorpay's
 * server-to-server confirmation is rejected, but the browser's own verified
 * callback still activates the subscription. Payments work; reconciliation is
 * weaker. That is a warning, not a blocker.
 */
function paymentsConfigured() {
  return has('RAZORPAY_KEY_ID') && has('RAZORPAY_KEY_SECRET');
}

/** Can the server verify an ID token and write to Firestore? */
function adminConfigured() {
  return has('FIREBASE_SERVICE_ACCOUNT') || has('FIREBASE_SERVICE_ACCOUNT_B64');
}

/** Can the browser reach Firebase at all? */
function webConfigured() {
  return has('FIREBASE_PROJECT_ID') && has('FIREBASE_API_KEY') && has('FIREBASE_APP_ID');
}

/**
 * The whole picture, as booleans.
 *
 * `missing` names the variables to go and set — the names are already public
 * in .env.example and in the docs, and naming them is what turns a dead button
 * into a five-minute fix.
 */
function report() {
  const payments = paymentsConfigured();
  const admin = adminConfigured();
  const web = webConfigured();

  const missing = [
    !has('RAZORPAY_KEY_ID') && 'RAZORPAY_KEY_ID',
    !has('RAZORPAY_KEY_SECRET') && 'RAZORPAY_KEY_SECRET',
    !admin && 'FIREBASE_SERVICE_ACCOUNT',
    !has('FIREBASE_PROJECT_ID') && 'FIREBASE_PROJECT_ID',
    !has('FIREBASE_API_KEY') && 'FIREBASE_API_KEY',
    !has('FIREBASE_APP_ID') && 'FIREBASE_APP_ID'
  ].filter(Boolean);

  const warnings = [
    !has('RAZORPAY_WEBHOOK_SECRET') &&
      'RAZORPAY_WEBHOOK_SECRET is unset — Razorpay webhooks will be rejected, so a payment ' +
      'the browser fails to report will not reconcile on its own.'
  ].filter(Boolean);

  return {
    /* ok means every route can do its job. */
    ok: payments && admin && web,
    payments: { configured: payments, mode: razorpayMode(), webhook: has('RAZORPAY_WEBHOOK_SECRET') },
    firebaseAdmin: { configured: admin },
    firebaseWeb: { configured: web },
    missing,
    warnings
  };
}

module.exports = { has, report, paymentsConfigured, adminConfigured, webConfigured, razorpayMode };
