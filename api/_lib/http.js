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
/* `cache` is opt-in and deliberately awkward to reach for. Billing answers are
   per-user and time-sensitive — a cached "you are active" would outlive the
   subscription it describes — so no-store is the default and a route has to
   ask for anything else. Only genuinely public, near-static responses should. */
function json(res, status, body, cache) {
  res.status(status)
    .setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache || 'no-store, max-age=0');
  res.end(JSON.stringify(body));
}

const ok = (res, body) => json(res, 200, body);
const bad = (res, message, extra) => json(res, 400, { error: message, ...extra });
const unauthorised = (res, message = 'sign-in required') => json(res, 401, { error: message });
const forbidden = (res, message) => json(res, 403, { error: message });
const notAllowed = (res) => json(res, 405, { error: 'method not allowed' });

/**
 * The route works; the deployment is not finished.
 *
 * Kept separate from `fail` on purpose. A 500 says "something broke and we do
 * not know what", and the browser can only apologise vaguely. A 503 with a
 * named reason says "this feature is switched off until an environment
 * variable is set", which is a different sentence to the user, a different
 * line in the log, and a different thing to go and do.
 */
const unavailable = (res, reason, extra) =>
  json(res, 503, { error: reason, ...extra });

/**
 * True when the failure is Firestore refusing to serve this project at all,
 * rather than anything about the request.
 *
 * The gRPC status codes below are the ones that mean "the datastore is not
 * answering": the database does not exist, billing is disabled on the Google
 * Cloud project, the quota is spent, the service is down, or the credential
 * has stopped being accepted. None of them can be fixed by the person holding
 * the phone, and none of them is a bug in the request.
 *
 * WHY THIS DISTINCTION IS WORTH A FUNCTION. A blanket 500 made the browser say
 * "Check the connection and try again", which is a false statement with a
 * useless instruction attached: the connection is fine, retrying cannot work,
 * and the shop owner reads it as their own phone being at fault. Separating
 * the two lets the account screen say what is actually true.
 *
 * Only a NUMERIC code counts. Firestore's errors carry a gRPC status number;
 * an ordinary JavaScript error carries a string or nothing, and must keep
 * falling through to the 500 it deserves.
 */
const DATASTORE_DOWN = new Set([
  4,   /* DEADLINE_EXCEEDED   */
  5,   /* NOT_FOUND           — no such database in this project */
  7,   /* PERMISSION_DENIED   — billing disabled, or the API is off */
  8,   /* RESOURCE_EXHAUSTED  — quota spent */
  9,   /* FAILED_PRECONDITION — Datastore mode, or an index is missing */
  13,  /* INTERNAL            */
  14,  /* UNAVAILABLE         */
  16   /* UNAUTHENTICATED     — the service account is no longer accepted */
]);

function datastoreDown(err) {
  return !!err && typeof err.code === 'number' && DATASTORE_DOWN.has(err.code);
}

/**
 * Anything unexpected becomes a 500 with an opaque body. Internal messages can
 * name collections, plan internals or key state, and none of that belongs in a
 * browser. The detail goes to the function log instead, where it is useful.
 *
 * The one exception is a datastore outage, which answers 503 with the name of
 * the condition and nothing else. That is not a leak — "the database is not
 * answering" says nothing a caller could exploit — and it is the difference
 * between a browser that tells a shop to check their wifi and one that tells
 * them the site is down and their details are safe.
 */
function fail(res, err, context) {
  if (datastoreDown(err)) {
    console.error(`[billing:${context}] DATASTORE UNAVAILABLE`,
                  `grpc=${err.code}`, err && err.message);
    return json(res, 503, { error: 'datastore-unavailable', context });
  }
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
    /* A missing service account throws from inside this same try, and
       reporting THAT as "invalid token" sends you hunting a token problem when
       the real fault is an unset environment variable. Configuration failures
       are re-thrown so the caller answers 500 with the real cause in the log;
       only genuine token failures become a 401. */
    if (!err || !String(err.code || '').startsWith('auth/')) throw err;

    /* Expired is the ordinary case — the client refreshes and retries — so it
       is not logged as an error. Anything else is worth seeing. */
    if (err.code !== 'auth/id-token-expired') {
      console.warn('[billing:auth]', err.code, err.message);
    }
    unauthorised(res, err.code === 'auth/id-token-expired' ? 'token expired' : 'invalid token');
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
  json, ok, bad, unauthorised, forbidden, notAllowed, unavailable, fail,
  datastoreDown,
  requireMethod, requireUser, readRawBody, body
};
