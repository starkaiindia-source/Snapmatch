/* ============================================================================
   Mobile Parts Finder · api/_lib/pagination.js
   ----------------------------------------------------------------------------
   Cursors, and the limits that stop a page becoming a database dump.

   ----------------------------------------------------------------------------
   WHY CURSORS AND NOT PAGE NUMBERS

   Firestore has no OFFSET that skips for free: `.offset(500)` still reads and
   bills the 500 documents it skipped. Page 20 of an offset-paged table costs
   twenty times page 1 and gets slower as the business grows, which is exactly
   backwards.

   A cursor resumes from the last row of the previous page, so every page costs
   the same. The trade is that you cannot jump to page 20 — and an admin table
   with search and filters does not need to, because the way you find one user
   among ten thousand is to search for them.

   ----------------------------------------------------------------------------
   THE CURSOR IS OPAQUE, AND IT IS NOT A SECRET

   It encodes the sort values of the last row — a timestamp and a document id.
   Base64url so it survives a query string, and validated on the way back in,
   because a client that hands back a mangled cursor should get a 400 rather
   than a stack trace from deep inside the SDK.

   It is NOT signed. Anyone can decode it and read a timestamp, which tells
   them nothing they could not learn by asking for the next page anyway. What
   protects the data is that the route requires an admin token.
   ========================================================================== */
'use strict';

/** A page nobody asked to size. */
const DEFAULT_LIMIT = 25;

/**
 * The hard ceiling on any admin page.
 *
 * 100 is a UI page, not an export. Nothing in the admin area may ask for the
 * whole users collection in one request — that is a slow query, a large
 * response and a browser holding every customer's phone number in memory, all
 * to render 25 rows. Bulk export, when it exists, is a server-side job with
 * its own authorisation, not a very large page.
 */
const MAX_LIMIT = 100;

function parseLimit(raw, fallback = DEFAULT_LIMIT) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/**
 * Encodes the sort position of the last row on a page.
 * @param {Array<string|number|null>} values the orderBy values, in order
 */
function encodeCursor(values) {
  if (!Array.isArray(values) || !values.length) return null;
  const json = JSON.stringify(values);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * @returns {Array|null} null for absent or unreadable — the caller treats both
 *          as "start from the beginning" rather than failing the request, since
 *          a stale cursor from a bookmarked page is a normal thing to receive.
 */
function decodeCursor(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const values = JSON.parse(json);
    if (!Array.isArray(values) || values.length === 0 || values.length > 4) return null;
    /* Only primitives may appear in a cursor. An object here would be handed
       straight to startAfter, and Firestore would either throw or produce a
       query nobody intended. */
    const clean = values.every(v =>
      v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
    return clean ? values : null;
  } catch {
    return null;
  }
}

/**
 * Runs a Firestore query one row longer than the page, to answer "is there
 * more?" without a second count query.
 *
 * @param {FirebaseFirestore.Query} query  already ordered, already limited to
 *                                         limit + 1 by the caller
 * @param {number} limit
 * @param {(doc) => Array} cursorValues    the orderBy values for a document
 */
function pageFrom(snapshot, limit, cursorValues) {
  const docs = snapshot.docs;
  const hasMore = docs.length > limit;
  const rows = hasMore ? docs.slice(0, limit) : docs;
  const last = rows.length ? rows[rows.length - 1] : null;

  return {
    docs: rows,
    hasMore,
    nextCursor: last && hasMore ? encodeCursor(cursorValues(last)) : null
  };
}

module.exports = { DEFAULT_LIMIT, MAX_LIMIT, parseLimit, encodeCursor, decodeCursor, pageFrom };
