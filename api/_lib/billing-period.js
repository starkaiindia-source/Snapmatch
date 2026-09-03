/* ============================================================================
   Mobile Parts Finder · api/_lib/billing-period.js
   ----------------------------------------------------------------------------
   Where a subscription's start and expiry dates are decided.

   Two rules drive everything here:

   1. THE CLOCK IS THE SERVER'S. A device whose date is set to 2030 must not be
      able to buy a six-year subscription, so no timestamp from the client is
      ever used. Every function takes `now` explicitly and the callers pass
      Date.now() from the function runtime, which also makes this file testable
      without freezing global time.

   2. RENEWALS EXTEND, THEY DO NOT RESTART. Paying again three days before
      expiry must add a month to the END of the paid-for period, not to today —
      otherwise the subscriber silently loses the days they already bought.
      That is what `startFrom` implements.

   Calendar months, not 30-day blocks. A subscriber who pays on the 15th
   expects the next bill on the 15th. The awkward case is the 31st: adding one
   month to 31 January cannot give 31 February, so the day clamps to the last
   day of the target month and the ORIGINAL day is not remembered. That is the
   same convention Razorpay, Stripe and every bank statement use.
   ========================================================================== */
'use strict';

/**
 * Adds whole calendar months in UTC, clamping the day to the end of the target
 * month. Works entirely in UTC so a server in a different region cannot shift
 * an expiry by a day.
 *
 * @param {number} fromMs  epoch milliseconds
 * @param {number} months  whole months to add (1 = monthly, 12 = yearly)
 * @returns {number} epoch milliseconds
 */
function addMonths(fromMs, months) {
  const d = new Date(fromMs);
  const day = d.getUTCDate();

  /* Move to the 1st before shifting the month: setUTCMonth on the 31st would
     roll 31 Jan + 1 into 3 March instead of clamping to 28/29 February. */
  const shifted = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth() + months, 1,
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()
  ));

  const lastDay = new Date(Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0
  )).getUTCDate();

  shifted.setUTCDate(Math.min(day, lastDay));
  return shifted.getTime();
}

/**
 * The period a verified payment buys.
 *
 * @param {object}  args
 * @param {number}  args.now             server time, epoch ms
 * @param {number}  args.periodMonths    from the plan catalogue
 * @param {number|null} [args.currentExpiresAt]  the subscriber's existing expiry, if any
 * @returns {{ startedAt:number, expiresAt:number, extendedFromExisting:boolean }}
 */
function periodFor({ now, periodMonths, currentExpiresAt = null }) {
  if (!Number.isFinite(now)) throw new Error('now must be a timestamp');
  if (!Number.isInteger(periodMonths) || periodMonths < 1) {
    throw new Error('periodMonths must be a positive whole number');
  }

  /* Extend from the existing expiry only while it is still in the future. An
     expiry in the past is a lapsed subscription, and back-dating a renewal to
     it would hand the subscriber a period that had already run out. */
  const stillActive = Number.isFinite(currentExpiresAt) && currentExpiresAt > now;
  const startFrom = stillActive ? currentExpiresAt : now;

  return {
    startedAt: now,
    expiresAt: addMonths(startFrom, periodMonths),
    extendedFromExisting: stillActive
  };
}

/**
 * The single definition of "does this account have access right now".
 * Used by the status endpoint and by the Firestore rules' mirror of it, so
 * there is one answer rather than one per caller.
 *
 * @param {{status?:string, expiresAt?:number|null}|null} sub
 * @param {number} now
 */
function isActive(sub, now) {
  if (!sub) return false;
  if (sub.status !== 'active') return false;
  return Number.isFinite(sub.expiresAt) && sub.expiresAt > now;
}

/** Derived state for the UI: what the account looks like at `now`. */
function derive(sub, now) {
  if (!sub || !sub.status) return 'none';
  if (sub.status === 'cancelled') {
    return Number.isFinite(sub.expiresAt) && sub.expiresAt > now ? 'cancelling' : 'expired';
  }
  if (sub.status === 'pending') return 'pending';
  if (sub.status !== 'active') return sub.status;
  return Number.isFinite(sub.expiresAt) && sub.expiresAt > now ? 'active' : 'expired';
}

module.exports = { addMonths, periodFor, isActive, derive };
