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

/* ================================================== ONE PROJECT, BOTH HALVES

   A Firebase deployment has two independent halves and each is configured from
   a different variable:

     the BROWSER  gets FIREBASE_PROJECT_ID from /api/firebase-config, and signs
                  users in against that project
     the SERVER   gets its project from the service account's own project_id,
                  and verifies the ID tokens that arrive

   Verification only works when they are the SAME project. A token minted by
   project A is not a token project B will accept, and it is refused with a
   flat 401.

   THIS IS WHAT A HALF-FINISHED FIREBASE MIGRATION LOOKS LIKE. Changing the
   project means changing both, in two places, and updating one is a single
   forgotten paste away. The symptom is maximally confusing: Google sign-in
   works perfectly, the user is real, and then every authenticated call fails —
   profile sync, subscription status, checkout, the lot — as if the account
   were signed out. Nothing in that picture points at the environment.

   So the two are compared here, and a mismatch is a hard failure rather than a
   warning, because no authenticated request can succeed while it stands.

   Only the project id is read out of the service account. It is the same
   identifier already published to every browser by /api/firebase-config, and
   nothing else from the key is touched or reported. */
function serviceAccountProjectId() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

  let text = raw;
  try {
    if (!text && b64) text = Buffer.from(b64, 'base64').toString('utf8');
    if (!text) return null;
    const parsed = JSON.parse(text);
    const id = parsed && parsed.project_id;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch {
    /* Unparseable is a different fault, already reported by the routes that
       actually load the credential. Reporting it as a mismatch would name the
       wrong cause. */
    return null;
  }
}

/**
 * The project both halves must agree on.
 * @returns {{web:string|null, admin:string|null, match:boolean|null}}
 *          match is null when either side is unknown — unknown is not a
 *          mismatch, and claiming one would send someone to fix a variable
 *          that is fine.
 */
function projectAlignment() {
  const web = (process.env.FIREBASE_PROJECT_ID || '').trim() || null;
  const admin = serviceAccountProjectId();
  return { web, admin, match: web && admin ? web === admin : null };
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
  const project = projectAlignment();

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
      'the browser fails to report will not reconcile on its own.',
    project.match === false &&
      `FIREBASE_PROJECT_ID is "${project.web}" but the service account belongs to ` +
      `"${project.admin}". The browser signs users in to one Firebase project and the ` +
      'server verifies their tokens against another, so every authenticated request ' +
      'will fail with 401 while sign-in itself appears to work. Set both to the same ' +
      'project.'
  ].filter(Boolean);

  return {
    /* ok means every route can do its job. A project mismatch means none of
       the authenticated ones can, however complete the variable list looks. */
    ok: payments && admin && web && project.match !== false,
    payments: { configured: payments, mode: razorpayMode(), webhook: has('RAZORPAY_WEBHOOK_SECRET') },
    firebaseAdmin: { configured: admin },
    firebaseWeb: { configured: web },
    /* Published on purpose: the project id is already in every browser via
       /api/firebase-config, and seeing the two side by side is what makes a
       half-finished migration diagnosable with curl. */
    firebaseProject: project,
    missing,
    warnings
  };
}

module.exports = {
  has, report, paymentsConfigured, adminConfigured, webConfigured, razorpayMode,
  projectAlignment, serviceAccountProjectId
};
