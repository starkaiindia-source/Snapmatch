/* ============================================================================
   Mobile Parts Finder · api/_lib/firebase.js
   ----------------------------------------------------------------------------
   Firebase Admin, initialised once per warm serverless instance.

   Admin credentials bypass Firestore security rules entirely. That is the
   point — billing documents are deliberately unwritable by any client, so only
   this runtime may create them — but it also means the service-account key is
   the single most dangerous secret in the project. It lives in the Vercel
   environment and nowhere else: never in the repo, never in a build artifact,
   never sent to the browser.

   The module caches the app on globalThis rather than in a module variable
   because Vercel can re-evaluate a module inside a reused instance, and
   initializeApp throws on a duplicate name.
   ========================================================================== */
'use strict';

const admin = require('firebase-admin');

const CACHE_KEY = '__mpf_firebase_admin__';

/**
 * Reads the service account from the environment.
 * Accepts either a raw JSON blob or a base64 copy of it — pasting multi-line
 * JSON into a dashboard field mangles the private key's newlines often enough
 * that the base64 form is worth supporting.
 */
function credentialsFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

  let json = raw;
  if (!json && b64) json = Buffer.from(b64, 'base64').toString('utf8');
  if (!json) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT (or _B64) is not set. Billing cannot run without it.'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
  }

  /* A key pasted through a form usually arrives with literal \n sequences
     instead of newlines, which fails deep inside the JWT signer with a
     misleading error. Normalise it here where the cause is obvious. */
  if (typeof parsed.private_key === 'string') {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  return parsed;
}

/** @returns {import('firebase-admin').app.App} */
function app() {
  if (globalThis[CACHE_KEY]) return globalThis[CACHE_KEY];

  const serviceAccount = credentialsFromEnv();
  const instance = admin.apps.length
    ? admin.app()
    : admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id
      });

  globalThis[CACHE_KEY] = instance;
  return instance;
}

/**
 * The Firestore handle. Settings are applied ONCE, on the way out of the very
 * first call, and the instance is cached from then on.
 *
 * THIS FUNCTION USED TO CALL settings() EVERY TIME, AND THAT WAS THE BUG.
 *
 * `Firestore.settings()` may only be called before the instance has done any
 * work; afterwards it throws
 *
 *     Firestore has already been initialized. You can only call settings()
 *     once, and only before calling any other methods on a Firestore object.
 *
 * Ten call sites call db(), so the second one in any request threw — and on a
 * warm serverless instance, where a previous request had already used
 * Firestore, the FIRST one did. It surfaced as three different bug reports
 * that were all this:
 *
 *   · create-order reads the profile and then records the pending order, two
 *     db() calls in one request. The second always threw, the outer catch
 *     turned it into a 500, and the browser said "Something went wrong
 *     starting the payment". Razorpay was never reached.
 *   · profile-sync calls db() once, so it worked on a cold start and threw on
 *     every warm instance after it — "Saved on this device, but not to your
 *     account", intermittently, which is what made it look like a rules or
 *     token problem.
 *   · and because the profile could never be saved, plan selection kept
 *     finding it incomplete and kept asking for the same details again.
 *
 * The cache lives on globalThis for the same reason the app does: Vercel can
 * re-evaluate a module inside a reused instance, and a module-scoped variable
 * would reset while the underlying Firestore object did not.
 */
const DB_KEY = '__mpf_firestore__';

function db() {
  if (globalThis[DB_KEY]) return globalThis[DB_KEY];

  const d = app().firestore();
  try {
    d.settings({ ignoreUndefinedProperties: true });
  } catch (err) {
    /* Already started — by an earlier module evaluation holding its own
       reference, say. The setting is not worth failing a request over; an
       undefined field is a bug to fix at the call site, not here. */
    console.warn('[firebase] firestore settings not applied:', err && err.message);
  }
  globalThis[DB_KEY] = d;
  return d;
}

function auth() {
  return app().auth();
}

module.exports = { app, db, auth, admin };
