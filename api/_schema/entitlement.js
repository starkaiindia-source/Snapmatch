/* ============================================================================
   Mobile Parts Finder · api/_schema/entitlement.js
   ----------------------------------------------------------------------------
   What a given account is allowed to see and do. Two tiers, one definition.

   ----------------------------------------------------------------------------
   TWO TIERS, AND ONLY TWO

     free   signed in, no running subscription
     paid   an active Monthly (₹99) or Yearly (₹799) subscription

   The two plans are deliberately identical in what they unlock. Yearly is
   cheaper per month and that is the whole difference — any feature gap between
   them would be a third tier wearing a discount.

   A signed-out visitor is `free` as well. There is no separate anonymous tier:
   the caps are the same, and the only thing being signed out changes is that
   there is no account to count daily searches against, so the header search is
   refused outright rather than metered.

   ----------------------------------------------------------------------------
   THE CAPS

     header searches   3 per calendar day, per ACCOUNT
     group filter      paid only
     group member list depends on the size of the group:

         group size        free sees      why
         ─────────────     ──────────     ────────────────────────────────────
         1 – 5             all of them    a small group is the free sample;
                                          hiding one of three is petty and
                                          teaches nobody what the product does
         6 – 50            first 5        enough to prove the data is real
         51 and above      first 10       a big group is the thing worth
                                          paying for, and ten is a taste

   ----------------------------------------------------------------------------
   THIS FILE IS PURE

   No I/O, no Firestore, no clock of its own — `now` is always passed in. It is
   required by the routes that enforce the caps AND by the tests that prove
   them, so it must be callable without a service account.

   The CLIENT does not import this. It renders what the server sends. Any cap
   restated in the browser is a convenience for drawing a lock icon, never the
   thing that withholds a row — see api/access.js, which slices the list before
   it is serialised.
   ========================================================================== */
'use strict';

const { deriveSubscriptionState } = require('./user-profile');

const TIERS = { FREE: 'free', PAID: 'paid' };

/** Header searches a free account may run per calendar day. */
const FREE_DAILY_SEARCHES = 3;

/** Group sizes at which the free member allowance changes. */
const SMALL_GROUP_MAX = 5;      /* at or below: the whole group is free */
const MEDIUM_GROUP_MAX = 50;    /* above SMALL, up to here: 5 members */
const FREE_MEMBERS_MEDIUM = 5;
const FREE_MEMBERS_LARGE = 10;  /* above MEDIUM_GROUP_MAX */

/**
 * The business runs in India, so "calendar day" means a day in India.
 *
 * Using UTC would roll the allowance over at 05:30 local — a shop that opens
 * at 09:00 would find its three searches already half-spent on a day that had
 * not started. The offset is fixed (+05:30, no daylight saving), so this is
 * arithmetic rather than a timezone database.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** The day key a timestamp falls in, as YYYY-MM-DD in India. */
function dayKeyFor(now) {
  return new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** When the current allowance resets, as an epoch millisecond value. */
function resetsAt(now) {
  const shifted = now + IST_OFFSET_MS;
  const dayStart = Math.floor(shifted / 86400000) * 86400000;
  return dayStart + 86400000 - IST_OFFSET_MS;
}

/**
 * The tier for a stored profile, checked against the SERVER clock.
 *
 * Delegates to deriveSubscriptionState so there is exactly one definition of
 * "is this subscription running" — the admin dashboard, the account screen and
 * this all agree by construction rather than by having been written to match.
 *
 * @returns {'free'|'paid'}
 */
function tierFor(profile, now) {
  return deriveSubscriptionState(profile, now) === 'subscription_active'
    ? TIERS.PAID
    : TIERS.FREE;
}

/**
 * How many members of a group a tier may see.
 *
 * @param {number} memberCount  the real size of the group
 * @param {'free'|'paid'} tier
 * @returns {number} Infinity for paid — the caller slices with it, and
 *          `list.slice(0, Infinity)` is the whole list.
 */
function visibleMemberLimit(memberCount, tier) {
  if (tier === TIERS.PAID) return Infinity;

  const n = Number(memberCount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= SMALL_GROUP_MAX) return n;                    /* all of a small group */
  if (n <= MEDIUM_GROUP_MAX) return FREE_MEMBERS_MEDIUM;
  return FREE_MEMBERS_LARGE;
}

/** Everything the client needs to draw the right UI, and nothing more. */
function describe(tier, searchesUsed, now) {
  const paid = tier === TIERS.PAID;
  const used = Math.max(0, Number(searchesUsed) || 0);

  return {
    tier,
    paid,
    /* Null rather than a number for a paid account: there is no limit, and
       sending `remaining: 999` invites a UI that counts down from 999. */
    dailySearchLimit: paid ? null : FREE_DAILY_SEARCHES,
    dailySearchesUsed: paid ? null : Math.min(used, FREE_DAILY_SEARCHES),
    dailySearchesRemaining: paid ? null : Math.max(0, FREE_DAILY_SEARCHES - used),
    searchResetsAt: paid ? null : resetsAt(now),
    groupFilter: paid,
    /* Restated so the client can label a lock ("5 of 30 shown") without
       re-deriving the rule and drifting from it. It is a LABEL: the server has
       already removed the rows. */
    freeMemberRule: paid ? null : {
      smallGroupMax: SMALL_GROUP_MAX,
      mediumGroupMax: MEDIUM_GROUP_MAX,
      membersMedium: FREE_MEMBERS_MEDIUM,
      membersLarge: FREE_MEMBERS_LARGE
    }
  };
}

module.exports = {
  TIERS,
  FREE_DAILY_SEARCHES,
  SMALL_GROUP_MAX, MEDIUM_GROUP_MAX, FREE_MEMBERS_MEDIUM, FREE_MEMBERS_LARGE,
  IST_OFFSET_MS,
  dayKeyFor, resetsAt, tierFor, visibleMemberLimit, describe
};
