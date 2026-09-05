/* ============================================================================
   Mobile Parts Finder · api/_lib/validate.js
   ----------------------------------------------------------------------------
   Input validation for everything that arrives from outside.

   Every function here answers with a VALUE or a default, never by throwing —
   a route should read like a list of decisions, not a chain of try/catch. When
   a caller needs to reject rather than default, it compares against the
   default and answers 400 itself.

   THE RULE: a value from a request body or a query string is not data until it
   has been through one of these. Firestore is schemaless, so an unvalidated
   field is a field that gets stored exactly as sent, forever, and read back by
   a dashboard that assumed it was a number.
   ========================================================================== */
'use strict';

/** A trimmed string, capped. Anything that is not a string becomes ''. */
function string(value, max = 200) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

/** One of `values`, or the fallback. Never the raw input. */
function oneOf(value, values, fallback = null) {
  const s = typeof value === 'string' ? value : String(value == null ? '' : value);
  return values.indexOf(s) > -1 ? s : fallback;
}

/** A finite integer inside a range, or the fallback. */
function integer(value, { min = -Infinity, max = Infinity, fallback = null } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * An epoch-millisecond timestamp from a query parameter.
 *
 * Accepts a number or an ISO date. Rejects anything outside a plausible range:
 * a filter of `createdAt >= 0` is a full-collection scan wearing a date, and
 * the same is true from the other end.
 */
const EARLIEST = Date.UTC(2020, 0, 1);
const LATEST_SKEW = 366 * 24 * 3600 * 1000;   /* a year ahead, for "renews on" filters */

function timestamp(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;

  let ms = Number(value);
  if (!Number.isFinite(ms)) {
    const parsed = Date.parse(String(value));
    if (!Number.isFinite(parsed)) return fallback;
    ms = parsed;
  }
  const ceiling = Date.now() + LATEST_SKEW;
  if (ms < EARLIEST || ms > ceiling) return fallback;
  return ms;
}

/** true / false from the strings a query string actually carries. */
function boolean(value, fallback = null) {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return fallback;
}

/**
 * A Firebase uid.
 *
 * Firebase uids are 28 alphanumerics today, but that is an implementation
 * detail rather than a promise, so this checks the SHAPE that matters: no
 * slashes, no dots, nothing that could climb out of a document path. A uid
 * with a slash in it would address a subcollection.
 */
function uid(value) {
  const s = string(value, 128);
  return /^[A-Za-z0-9_-]{6,128}$/.test(s) ? s : '';
}

/** A document id, held to the same path-safety rule as a uid. */
function docId(value, max = 200) {
  const s = string(value, max);
  return /^[A-Za-z0-9_.:@+-]{1,200}$/.test(s) && s !== '.' && s !== '..' ? s : '';
}

/**
 * A user-typed search term.
 *
 * Capped hard and stripped of control characters, which are never part of a
 * phone model and are the one thing that makes a stored search term unreadable
 * in a report. It is never interpolated into anything — Firestore takes
 * parameters, not query strings — so this is about legibility rather than
 * injection.
 */
function searchTerm(value, max = 120) {
  const s = string(value, max);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 32 || code === 127) continue;
    out += s[i];
  }
  return out;
}

/** An email, lower-cased, or '' when it is not one. */
function email(value) {
  const s = string(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
}

/**
 * Digits only, for matching a stored mobile number.
 *
 * Shops type "+91 98765 43210", "098765 43210" and "9876543210" for the same
 * phone. Reducing both sides to digits is what makes a search for any of them
 * find the others.
 */
function digits(value, max = 20) {
  return string(value, 40).replace(/\D/g, '').slice(0, max);
}

module.exports = {
  string, oneOf, integer, timestamp, boolean, uid, docId, searchTerm, email, digits
};
