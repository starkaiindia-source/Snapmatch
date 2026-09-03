/* ============================================================================
   Mobile Parts Finder · api/_lib/http.js
   ----------------------------------------------------------------------------
   Request plumbing shared by every billing route: identity, method guards,
   JSON replies and the raw-body reader the webhook needs.

   IDENTITY IS NON-NEGOTIABLE HERE. Every route that can move money or grant
   access resolves the caller from a Firebase ID token and from nothing else.
   A uid in the request body would be a free subscription for anyone who can
   open dev tools, so `requireUser` is the only way a route learns who is
   asking, and it fails closed.
   ========================================================================== */
'use strict';

const { auth } = require('./firebase');

/* ------------------------------------------------------------------ replies */
function json(res, status, body) {
  res.status(status)
    .setHeader('Content-Type', 'application/json; charset=utf-8');
  /* Billing answers are per-user and time-sensitive; a cached "you are active"
     would outlive the subscription it describes. */
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(JSON.stringify(body));
}

const ok = (res, body) => json(res, 200, body);
const bad = (res, message, extra) => json(res, 400, { error: message, ...extra });
const unauthorised = (res, message = 'sign-in required') => json(res, 401, { error: message });
const forbidden = (res, message) => json(res, 403, { error: message });
const notAllowed = (res) => json(res, 405, { error: 'method not allowed' });

/**
 * Anything unexpected becomes a 500 with an opaque body. Internal messages can
 * name collections, plan internals or key state, and none of that belongs in a
 * browser. The detail goes to the function log instead, where it is useful.
 */
function fail(res, err, context) {
  console.error(`[billing:${context}]`, err && err.stack ? err.stack : err);
  json(res, 500, { error: 'server error', context });
}

/* ------------------------------------------------------------------- guards */
function requireMethod(req, res, method) {
  if (req.method !== method) { notAllowed(res); return false; }
  return true;
}

/**
 * Resolves the caller from `Authorization: Bearer <Firebase ID token>`.
 *
 * `checkRevoked` is on: it costs a lookup, but it means a user who has been
 * disabled, or whose session was revoked after a compromise, cannot keep
 * spending a token that has not expired yet.
 *
 * @returns {Promise<null|{uid:string,email:string|null,emailVerified:boolean,name:string|null}>}
 *          null means the reply has already been sent.
 */
async function requireUser(req, res) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  if (!match) { unauthorised(res); return null; }

  try {
    const decoded = await auth().verifyIdToken(match[1], true);
    return {
      uid: decoded.uid,
      email: decoded.email || null,
      emailVerified: !!decoded.email_verified,
      name: decoded.name || null
    };
  } catch (err) {
    /* Expired is the ordinary case — the client refreshes and retries — so it
       is not logged as an error. Anything else is worth seeing. */
    if (err && err.code !== 'auth/id-token-expired') {
      console.warn('[billing:auth]', err && err.code, err && err.message);
    }
    unauthorised(res, err && err.code === 'auth/id-token-expired'
      ? 'token expired' : 'invalid token');
    return null;
  }
}

/**
 * Reads the untouched request body.
 *
 * Only for the webhook, and only because its signature covers the exact bytes
 * Razorpay sent. Re-serialising parsed JSON changes key order and spacing, the
 * digest stops matching, and every delivery fails for no visible reason. The
 * route must also export `config.api.bodyParser = false` or the stream will
 * already have been consumed before this runs.
 *
 * @returns {Promise<Buffer>}
 */
function readRawBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Body parsed by Vercel, or an empty object — never undefined. */
function body(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

module.exports = {
  json, ok, bad, unauthorised, forbidden, notAllowed, fail,
  requireMethod, requireUser, readRawBody, body
};
