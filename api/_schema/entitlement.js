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
     group member list PAID ONLY — a free account sees NO members, at any
                       group size

   THE MEMBER LIST USED TO HAVE A FREE SAMPLE — the whole of a group of five,
   then the first five, then the first ten. That is gone, by an explicit
   owner decision: opening a group and reading which devices a part fits is
   the thing the subscription sells, and a free account may not do it at all.

   What a free account still gets, because it is what makes the free tier
   worth having and gives nothing away:

     · 3 searches a day
     · the group's IDENTITY — group number, serial, part code, category,
       master model
     · `memberCount`, the real size of the group

   "This part fits 325 devices" is the advertisement. The 325 names are the
   product. A free caller receives the first sentence and not one row of the
   second — not truncated in the browser, not hidden with CSS: the names are
   never put into the response at all.

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

/* The free member allowance. Zero, at every group size.

   The three constants below are kept rather than deleted because
   describe() still reports the rule to the client and the admin screens
   still name it; a single number here is what the whole policy now is, and
   keeping the shape means restoring a sample later is one edit in one file
   rather than a reconstruction. */
const FREE_MEMBERS = 0;

/* Retained for the tests and the admin copy that name the old tiers. They no
   longer decide anything — visibleMemberLimit ignores group size entirely. */
const SMALL_GROUP_MAX = 5;
const MEDIUM_GROUP_MAX = 50;
const FREE_MEMBERS_MEDIUM = FREE_MEMBERS;
const FREE_MEMBERS_LARGE = FREE_MEMBERS;

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
  /* Free sees none of them, whatever the group size. `memberCount` is still
     taken so every caller keeps its shape and the signature can carry a
     sample again without a hunt through the call sites. */
  return FREE_MEMBERS;
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
    /* May this account OPEN a compatibility group and read the devices in it?
       One boolean, decided here, so the router, the group page, the match card
       and the device page cannot each arrive at their own answer. It is a
       LABEL for drawing the lock: the server has already withheld the rows. */
    groupAccess: paid,
    /* Restated so the client can word the paywall without re-deriving the
       rule. `members: 0` is the whole rule now. */
    freeMemberRule: paid ? null : {
      members: FREE_MEMBERS,
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
  FREE_MEMBERS,
  SMALL_GROUP_MAX, MEDIUM_GROUP_MAX, FREE_MEMBERS_MEDIUM, FREE_MEMBERS_LARGE,
  IST_OFFSET_MS,
  dayKeyFor, resetsAt, tierFor, visibleMemberLimit, describe
};
