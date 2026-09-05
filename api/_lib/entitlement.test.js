/* ============================================================================
   api/_lib/entitlement.test.js
   ----------------------------------------------------------------------------
   The free/paid split.

   Two tiers, three caps, and one property that matters more than any of them:
   a withheld device name must not be IN the response. Not hidden by CSS, not
   filtered by the client, not present-but-flagged — absent. Several of these
   tests assert exactly that, against the real catalogue.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TIERS, FREE_DAILY_SEARCHES,
  SMALL_GROUP_MAX, MEDIUM_GROUP_MAX, FREE_MEMBERS_MEDIUM, FREE_MEMBERS_LARGE,
  dayKeyFor, resetsAt, tierFor, visibleMemberLimit, describe: describeAccess
} = require('../_schema/entitlement');

const entitlements = require('../_services/entitlement-service');
const search = require('../_services/search-service');

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 5, 1, 12, 0);

/* ------------------------------------------------------------------ tiers */

test('an active subscription is paid, whichever plan it is', () => {
  /* Monthly and yearly must unlock exactly the same thing. A feature gap
     between them would be a third tier wearing a discount. */
  ['monthly', 'yearly'].forEach(planId => {
    const profile = {
      currentPlanId: planId,
      activeSubscriptionStatus: 'active',
      subscriptionExpiresAt: NOW + 30 * 24 * HOUR
    };
    assert.equal(tierFor(profile, NOW), TIERS.PAID, `${planId} should be paid`);
  });
});

test('a lapsed subscription is free, whatever the stored flag says', () => {
  const lapsed = {
    currentPlanId: 'yearly',
    activeSubscriptionStatus: 'active',   /* not rewritten yet */
    subscriptionExpiresAt: NOW - HOUR     /* but the date has passed */
  };
  assert.equal(tierFor(lapsed, NOW), TIERS.FREE);
});

test('an account that never paid is free, and so is no account at all', () => {
  assert.equal(tierFor({}, NOW), TIERS.FREE);
  assert.equal(tierFor(null, NOW), TIERS.FREE);
});

test('cancelled but still inside the paid period is paid', () => {
  /* They paid for those days. Cancelling must not take them away. */
  assert.equal(tierFor({
    activeSubscriptionStatus: 'cancelled',
    subscriptionExpiresAt: NOW + 5 * 24 * HOUR
  }, NOW), TIERS.PAID);
});

/* ------------------------------------------------- member caps, by the spec

   Edge cases 7-12 from the brief, stated as a table. */

test('the member allowance follows the size of the group', () => {
  const cases = [
    /* size, free sees */
    [1, 1], [3, 3], [5, 5],           /* <= 5: all of it, no lock at all */
    [6, 5], [10, 5], [30, 5], [50, 5],/* 6..50: the first five */
    [51, 10], [100, 10], [268, 10]    /* > 50: the first ten */
  ];
  cases.forEach(([size, expected]) => {
    assert.equal(visibleMemberLimit(size, TIERS.FREE), expected,
      `a ${size}-member group should show a free account ${expected}`);
  });
});

test('the band edges are exactly where the brief puts them', () => {
  assert.equal(SMALL_GROUP_MAX, 5);
  assert.equal(MEDIUM_GROUP_MAX, 50);
  assert.equal(FREE_MEMBERS_MEDIUM, 5);
  assert.equal(FREE_MEMBERS_LARGE, 10);

  /* Off-by-one is the whole risk here, so both sides of both edges. */
  assert.equal(visibleMemberLimit(5, TIERS.FREE), 5);
  assert.equal(visibleMemberLimit(6, TIERS.FREE), 5);
  assert.equal(visibleMemberLimit(50, TIERS.FREE), 5);
  assert.equal(visibleMemberLimit(51, TIERS.FREE), 10);
});

test('a paid account has no member cap at any size', () => {
  [1, 5, 6, 50, 51, 100, 268, 10000].forEach(size => {
    assert.equal(visibleMemberLimit(size, TIERS.PAID), Infinity);
  });
});

test('a nonsense member count does not open the gate', () => {
  [0, -1, NaN, null, undefined, 'many'].forEach(bad => {
    assert.equal(visibleMemberLimit(bad, TIERS.FREE), 0,
      `${String(bad)} must not grant members`);
  });
});

/* -------------------------------------------- the real catalogue, sliced

   Against the actual build output, not fixtures. If the data changes shape
   these fail, which is the point. */

function groupOfSize(predicate) {
  const idx = search.loadIndex();
  for (const id of Object.keys(idx.groups)) {
    const n = (idx.groups[id].memberIds || []).length;
    if (predicate(n)) return id;
  }
  return null;
}

test('a real small group is shown whole, with no lock', async () => {
  const id = groupOfSize(n => n > 0 && n <= 5);
  assert.ok(id, 'the catalogue should contain a group of five or fewer');

  const free = await entitlements.groupForUser(id, TIERS.FREE);
  assert.equal(free.members.length, free.memberCount);
  assert.equal(free.lockedCount, 0);
  assert.equal(free.locked, false);
});

test('a real medium group shows five and locks the rest', async () => {
  const id = groupOfSize(n => n > 5 && n <= 50);
  const free = await entitlements.groupForUser(id, TIERS.FREE);

  assert.equal(free.members.length, 5);
  assert.equal(free.lockedCount, free.memberCount - 5);
  assert.equal(free.locked, true);
});

test('a real large group shows ten and locks the rest', async () => {
  const id = groupOfSize(n => n > 50);
  const free = await entitlements.groupForUser(id, TIERS.FREE);

  assert.equal(free.members.length, 10);
  assert.equal(free.lockedCount, free.memberCount - 10);
  assert.equal(free.locked, true);
});

test('a paid account gets every member of a real large group', async () => {
  const id = groupOfSize(n => n > 50);
  const paid = await entitlements.groupForUser(id, TIERS.PAID);

  assert.equal(paid.members.length, paid.memberCount);
  assert.equal(paid.lockedCount, 0);
  assert.equal(paid.locked, false);
});

test('WITHHELD DEVICE NAMES ARE NOT IN THE FREE PAYLOAD', async () => {
  /* The property the whole design exists for. Hiding rows in the DOM would
     pass every other test in this file and fail this one. */
  const id = groupOfSize(n => n > 50);
  const free = await entitlements.groupForUser(id, TIERS.FREE);
  const paid = await entitlements.groupForUser(id, TIERS.PAID);

  const serialised = JSON.stringify(free);
  const withheld = paid.members.slice(free.members.length);
  assert.ok(withheld.length > 50, 'expected a substantial withheld remainder');

  withheld.forEach(m => {
    /* The master model name is public — it is in assets/dataset.json, on every
       group card, and is what the group is called. It is not withheld
       information, so it is excluded from this check. */
    if (m.name === free.masterModelName) return;
    assert.equal(serialised.includes(m.id), false, `${m.id} leaked into the free payload`);
    assert.equal(serialised.includes(m.name), false, `${m.name} leaked into the free payload`);
  });
});

test('the free payload still carries the real total, so the UI can say "10 of 88"', async () => {
  const id = groupOfSize(n => n > 50);
  const free = await entitlements.groupForUser(id, TIERS.FREE);
  const paid = await entitlements.groupForUser(id, TIERS.PAID);

  /* Counting is free; naming is not. A card that cannot say how many devices
     it covers cannot show anyone what they would be buying. */
  assert.equal(free.memberCount, paid.memberCount);
  assert.ok(free.memberCount > free.members.length);
});

test('part codes are not tier-gated', async () => {
  /* The account page advertises "Part code, serial number and group number" to
     free accounts. The paid answer is WHICH DEVICES a part fits. */
  const id = groupOfSize(n => n > 50);
  const free = await entitlements.groupForUser(id, TIERS.FREE);
  const paid = await entitlements.groupForUser(id, TIERS.PAID);
  assert.equal(free.partCode, paid.partCode);
  assert.match(free.partCode, /^MPF-/);
});

/* "an unknown group is null" moved to search-quota.test.js: the lookup now
   falls through to Firestore when the local file has no such group, and that
   needs the stubbed database rather than a real service account. */

/* ------------------------------------------------------- the daily counter */

test('the free allowance is three a day', () => {
  assert.equal(FREE_DAILY_SEARCHES, 3);
});

test('the described state counts down and then reaches zero', () => {
  /* Edge cases 1-4 from the brief. */
  [[0, 3], [1, 2], [2, 1], [3, 0], [4, 0]].forEach(([used, left]) => {
    const a = describeAccess(TIERS.FREE, used, NOW);
    assert.equal(a.dailySearchesRemaining, left, `${used} used should leave ${left}`);
    assert.equal(a.dailySearchLimit, 3);
  });
});

test('a paid account is told there is no limit, not a big one', () => {
  const a = describeAccess(TIERS.PAID, 0, NOW);
  assert.equal(a.paid, true);
  /* null, not 999 — a number invites a UI that counts down from it. */
  assert.equal(a.dailySearchLimit, null);
  assert.equal(a.dailySearchesRemaining, null);
  assert.equal(a.searchResetsAt, null);
  assert.equal(a.groupFilter, true);
  assert.equal(a.freeMemberRule, null);
});

test('the group filter is paid-only', () => {
  assert.equal(describeAccess(TIERS.FREE, 0, NOW).groupFilter, false);
  assert.equal(describeAccess(TIERS.PAID, 0, NOW).groupFilter, true);
});

test('the day rolls over at midnight in India, not at midnight UTC', () => {
  /* UTC would roll the allowance at 05:30 local — a shop opening at 09:00
     would find its three searches already spent on a day that had not
     started. */
  const midnightIST = Date.parse('2026-09-05T18:30:00Z');
  assert.equal(dayKeyFor(midnightIST), '2026-09-06');
  assert.equal(dayKeyFor(midnightIST - 1), '2026-09-05');

  /* And the reset lands exactly on that boundary. */
  assert.equal(resetsAt(midnightIST - 1), midnightIST);
});

test('the reset is always in the future and within a day', () => {
  const at = resetsAt(NOW);
  assert.ok(at > NOW);
  assert.ok(at - NOW <= 24 * HOUR);
});
