/* ============================================================================
   POST /api/events
   ----------------------------------------------------------------------------
   Analytics ingest. The one route in this codebase an unauthenticated browser
   may write through, which is why almost all of it is about limits.

   ----------------------------------------------------------------------------
   WHY IT ACCEPTS ANONYMOUS CALLERS AT ALL

   Visitor analytics that only covers signed-in users measures the wrong thing:
   the interesting question is what people do BEFORE they sign in, and where
   the funnel loses them. A route that required a token could not answer it.

   ----------------------------------------------------------------------------
   WHAT STOPS IT BEING A PUBLIC DATABASE

     · the event type must be on the allowlist in _schema/analytics-event.js
     · metadata is filtered field by field against that type's schema
     · free-text fields go through a PII redaction pass
     · at most 20 events per request
     · a per-session rate limit, and a per-uid one for signed-in callers
     · the timestamp is the SERVER's, so a client cannot backdate anything
     · the event id is generated here, so a client cannot overwrite an event

   ----------------------------------------------------------------------------
   IDENTITY IS OPTIONAL AND VERIFIED WHEN PRESENT

   An Authorization header is used if it is there and IGNORED if it does not
   verify — the event is still recorded, just anonymously. A failed token must
   not lose the event; it is analytics, not access control.

   The session id is a random string the browser made up for itself. It is not
   derived from anything about the device, and there is no fingerprinting here.

   ----------------------------------------------------------------------------
   IT ALWAYS ANSWERS 200 WHEN IT CAN

   A rejected batch reports what it dropped rather than failing, because a
   failed analytics call must never surface as an error in front of a shop
   owner trying to look up a part.
   ========================================================================== */
'use strict';

const { ok, bad, fail, unavailable, requireMethod, body } = require('./_lib/http');
const { auth } = require('./_lib/firebase');
const { adminConfigured } = require('./_lib/config');
const { consume } = require('./_lib/rate-limit');
const analytics = require('./_services/analytics-service');
const v = require('./_lib/validate');

/** Per session, per minute. A page visit generates a handful. */
const SESSION_LIMIT = 60;

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    /* No service account means no Firestore, which means nothing can be
       recorded. That is a deployment that is not finished, not a fault — and
       a 500 per beacon would fill the function log with stack traces for a
       missing environment variable.

       Checked FIRST, before the body is read: on a local run without a key
       this is every request, and it should cost nothing. */
    if (!adminConfigured()) {
      return unavailable(res, 'analytics-unconfigured', {
        missing: ['FIREBASE_SERVICE_ACCOUNT'],
        /* The client drops a failed batch either way — see
           src/data/analytics.js — so nothing is retried and nothing surfaces
           to the visitor. */
        accepted: 0
      });
    }

    const payload = body(req);
    const events = Array.isArray(payload.events) ? payload.events : null;
    if (!events || !events.length) return bad(res, 'events must be a non-empty array');

    /* A session id shaped like the client generates. Anything else is dropped
       to null rather than stored — a caller-controlled string that becomes a
       document id needs to be a document id we would have chosen. */
    const sessionId = /^[A-Za-z0-9_-]{12,64}$/.test(String(payload.sessionId || ''))
      ? String(payload.sessionId)
      : null;

    const userId = await resolveUser(req);
    const now = Date.now();

    const limit = await consume({
      key: 'events:' + (userId || sessionId || clientBucket(req)),
      limit: SESSION_LIMIT,
      now
    });
    if (!limit.allowed) {
      /* 429 with the reset time. The client backs off; it does not retry in a
         loop, which is what turned a limit into an outage last time anyone
         built one of these without a reset header. */
      res.setHeader('Retry-After', Math.ceil((limit.resetAt - now) / 1000));
      return ok(res, { accepted: 0, rejected: events.length, rateLimited: true,
                       resetAt: limit.resetAt });
    }

    const result = await analytics.recordEvents({
      events,
      userId,
      sessionId,
      source: v.oneOf(payload.source, ['web', 'chatbot'], 'web'),
      now
    });

    return ok(res, result);
  } catch (err) {
    return fail(res, err, 'events');
  }
};

/**
 * The uid when a valid token is present, null otherwise.
 *
 * checkRevoked is deliberately OFF here, unlike every billing route. It costs
 * a lookup per call, and this route grants nothing — the worst a revoked token
 * achieves is attributing an event to an account that has just signed out.
 */
async function resolveUser(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  if (!match) return null;
  try {
    const decoded = await auth().verifyIdToken(match[1], false);
    return decoded.uid;
  } catch {
    /* An expired or malformed token means "anonymous", not "error". */
    return null;
  }
}

/**
 * A last-resort rate-limit bucket for a caller with neither a session id nor a
 * token.
 *
 * Vercel's forwarded client address, hashed to a short opaque key. The address
 * itself is never stored — not in the bucket id, not in an event. It exists
 * only so one machine cannot bypass the limit by omitting its session id.
 */
function clientBucket(req) {
  const address = String(
    req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown'
  ).split(',')[0].trim();

  let hash = 5381;
  for (let i = 0; i < address.length; i++) {
    hash = ((hash << 5) + hash + address.charCodeAt(i)) >>> 0;
  }
  return 'anon' + hash.toString(36);
}
