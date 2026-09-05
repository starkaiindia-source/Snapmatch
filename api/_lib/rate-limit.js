/* ============================================================================
   Mobile Parts Finder · api/_lib/rate-limit.js
   ----------------------------------------------------------------------------
   A fixed-window counter for the routes anyone can call.

   ----------------------------------------------------------------------------
   WHAT IT IS FOR

   /api/events accepts writes from unauthenticated browsers, because that is
   what visitor analytics means. Without a limit, a loop in a console fills the
   analytics collection, and the bill and the dashboard are both wrong. The
   chatbot route is worse: it can reach an AI gateway, so an unlimited caller
   costs money per request.

   ----------------------------------------------------------------------------
   WHY FIRESTORE AND NOT MEMORY

   A serverless function has no memory between requests, and a dozen warm
   instances would each keep their own count — an in-memory limiter on Vercel
   limits nothing except during a burst that happens to land on one instance.

   A transactional increment on one document is the honest version. It costs a
   read and a write per request, which is precisely why the window is coarse
   (one document per caller per minute, not per request) and why the buckets
   carry an expiry for a TTL policy to clean up.

   ----------------------------------------------------------------------------
   IT FAILS OPEN, DELIBERATELY

   If Firestore is unreachable, the limiter allows the request. A rate limiter
   that takes the site down when it cannot count is worse than the abuse it
   prevents — and every route behind it either requires an admin token or
   writes a single small document. Fail-closed would be right for a limiter in
   front of a payment; this is not that.
   ========================================================================== */
'use strict';

const { db, admin } = require('./firebase');
const { RATE_LIMITS } = require('../_schema/collections');

const FieldValue = admin.firestore.FieldValue;

/** One minute. Coarse on purpose — see the header. */
const WINDOW_MS = 60 * 1000;

/**
 * Consumes one unit from a caller's bucket.
 *
 * @param {object} args
 * @param {string} args.key      what is being limited: 'events:<sessionId>'
 * @param {number} args.limit    units allowed per window
 * @param {number} args.now
 * @param {number} [args.windowMs]
 * @returns {Promise<{allowed:boolean, remaining:number, resetAt:number}>}
 */
async function consume({ key, limit, now, windowMs = WINDOW_MS }) {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  /* The window start is part of the document id, so a new window is a new
     document rather than a read-compare-reset dance that can race. */
  const id = `${sanitiseKey(key)}_${windowStart}`;
  const ref = db().collection(RATE_LIMITS).doc(id);

  try {
    const count = await db().runTransaction(async tx => {
      const snap = await tx.get(ref);
      const current = snap.exists ? Number(snap.data().count) || 0 : 0;
      if (current >= limit) return current + 1;      /* over: do not write */

      tx.set(ref, {
        key: sanitiseKey(key),
        windowStart,
        /* A TTL policy on this field, configured in the Firebase console,
           deletes the buckets. Without one they accumulate for ever, and
           nothing in this code reads a bucket from a past window. */
        expiresAt: new Date(windowStart + windowMs * 2),
        count: FieldValue.increment(1),
        updatedAt: now
      }, { merge: true });

      return current + 1;
    });

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetAt: windowStart + windowMs
    };
  } catch (err) {
    console.warn('[rate-limit] unavailable, allowing request', { key, message: err && err.message });
    return { allowed: true, remaining: limit, resetAt: windowStart + windowMs };
  }
}

/** A document id cannot contain a slash, and a caller-supplied key might. */
function sanitiseKey(key) {
  return String(key || 'anon').replace(/[^A-Za-z0-9_:.-]/g, '_').slice(0, 120);
}

module.exports = { consume, WINDOW_MS };
