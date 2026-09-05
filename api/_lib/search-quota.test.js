/* ============================================================================
   api/_lib/search-quota.test.js
   ----------------------------------------------------------------------------
   The daily search counter — the thing the reported bug was about.

   "A FREE USER MUST NEVER RECEIVE A FOURTH MAIN SEARCH RESULT IN THE SAME DAY."
   That is one assertion, and most of this file is the ways round it: two tabs
   at once, a stale day, signing out and back in, a paid account that should
   not be metered at all.

   Firestore is stubbed. The stub is a real transaction though — read the
   document, run the callback, keep what it writes — so the read-modify-write
   under test is the read-modify-write that runs in production.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/* ------------------------------------------------------------- the stub

   Swapped into the module cache BEFORE the service is required, so the
   service's own `require('../_lib/firebase')` resolves to this. */

const store = new Map();

function docRef(collection, id) {
  const key = collection + '/' + id;
  return {
    __key: key,
    get: async () => ({
      exists: store.has(key),
      data: () => store.get(key)
    })
  };
}

const fakeDb = () => ({
  collection: name => ({ doc: id => docRef(name, id) }),
  runTransaction: async fn => {
    const writes = [];
    const tx = {
      get: ref => ref.get(),
      set: (ref, data, opts) => { writes.push([ref.__key, data, opts]); }
    };
    const result = await fn(tx);
    /* Applied only after the callback returns, like a real transaction: a
       refusal that writes nothing must leave the document untouched. */
    writes.forEach(([key, data, opts]) => {
      const prior = (opts && opts.merge && store.get(key)) || {};
      store.set(key, Object.assign({}, prior, data));
    });
    return result;
  }
});

const firebasePath = require.resolve('./firebase');
require.cache[firebasePath] = {
  id: firebasePath,
  filename: firebasePath,
  loaded: true,
  exports: {
    db: fakeDb,
    auth: () => { throw new Error('auth is not stubbed'); },
    app: () => { throw new Error('app is not stubbed'); },
    admin: { firestore: { FieldValue: { increment: n => n, serverTimestamp: () => 0 } } }
  }
};

const entitlements = require(path.join(__dirname, '..', '_services', 'entitlement-service'));
const { FREE_DAILY_SEARCHES, dayKeyFor } = require('../_schema/entitlement');

const HOUR = 3600 * 1000;
/* 12:00 IST, comfortably inside one Indian day. */
const NOW = Date.parse('2026-09-05T06:30:00Z');

function seedUser(uid, fields) {
  store.set('users/' + uid, Object.assign({ uid }, fields));
}

test.beforeEach(() => store.clear());

/* ------------------------------------------------- the reported bug */

test('the fourth search of the day is refused', async () => {
  seedUser('free1', {});

  for (let n = 1; n <= FREE_DAILY_SEARCHES; n++) {
    const r = await entitlements.consumeSearch('free1', NOW);
    assert.equal(r.allowed, true, `search ${n} should be allowed`);
    assert.equal(r.access.dailySearchesRemaining, FREE_DAILY_SEARCHES - n);
  }

  const fourth = await entitlements.consumeSearch('free1', NOW);
  assert.equal(fourth.allowed, false, 'THE FOURTH SEARCH MUST BE REFUSED');
  assert.equal(fourth.access.dailySearchesRemaining, 0);
});

test('a refusal writes nothing, so it cannot inflate the counter', async () => {
  seedUser('free2', { freeSearchDay: dayKeyFor(NOW), freeSearchCount: 3 });

  await entitlements.consumeSearch('free2', NOW);
  await entitlements.consumeSearch('free2', NOW);
  await entitlements.consumeSearch('free2', NOW);

  assert.equal(store.get('users/free2').freeSearchCount, 3,
    'a blocked attempt must not increment anything');
});

test('the fifth, tenth and hundredth are refused too', async () => {
  seedUser('free3', {});
  for (let n = 0; n < 3; n++) await entitlements.consumeSearch('free3', NOW);

  for (let n = 0; n < 100; n++) {
    const r = await entitlements.consumeSearch('free3', NOW);
    assert.equal(r.allowed, false);
  }
});

/* ------------------------------------------------------------ the rollover */

test('a new calendar day restores the full allowance', async () => {
  seedUser('free4', { freeSearchDay: dayKeyFor(NOW), freeSearchCount: 3 });
  assert.equal((await entitlements.consumeSearch('free4', NOW)).allowed, false);

  const tomorrow = NOW + 24 * HOUR;
  const r = await entitlements.consumeSearch('free4', tomorrow);
  assert.equal(r.allowed, true, 'the next day starts fresh');
  assert.equal(r.access.dailySearchesRemaining, FREE_DAILY_SEARCHES - 1);
});

test('a stale stored day is treated as zero used, not carried over', async () => {
  seedUser('free5', { freeSearchDay: '2020-01-01', freeSearchCount: 999 });
  const access = await entitlements.readAccess('free5', NOW);
  assert.equal(access.dailySearchesRemaining, FREE_DAILY_SEARCHES);
});

test('the counter rolls at midnight IST, not midnight UTC', async () => {
  const justBefore = Date.parse('2026-09-05T18:29:59Z');
  const justAfter = Date.parse('2026-09-05T18:30:01Z');

  seedUser('free6', {});
  for (let n = 0; n < 3; n++) await entitlements.consumeSearch('free6', justBefore);
  assert.equal((await entitlements.consumeSearch('free6', justBefore)).allowed, false);

  assert.equal((await entitlements.consumeSearch('free6', justAfter)).allowed, true,
    'a minute later, in a new Indian day, the allowance is back');
});

/* ------------------------------------------------------------------- paid */

test('a paid account is never metered', async () => {
  seedUser('paid1', {
    activeSubscriptionStatus: 'active',
    currentPlanId: 'monthly',
    subscriptionExpiresAt: NOW + 30 * 24 * HOUR
  });

  for (let n = 0; n < 100; n++) {
    const r = await entitlements.consumeSearch('paid1', NOW);
    assert.equal(r.allowed, true, `paid search ${n + 1} should be allowed`);
  }
  /* And no counter was written for them at all. */
  assert.equal(store.get('users/paid1').freeSearchCount, undefined);
});

test('a yearly plan is metered exactly as little as a monthly one', async () => {
  seedUser('paid2', {
    activeSubscriptionStatus: 'active',
    currentPlanId: 'yearly',
    subscriptionExpiresAt: NOW + 300 * 24 * HOUR
  });
  for (let n = 0; n < 20; n++) {
    assert.equal((await entitlements.consumeSearch('paid2', NOW)).allowed, true);
  }
});

test('a subscription that lapses mid-session starts metering', async () => {
  seedUser('lapsing', {
    activeSubscriptionStatus: 'active',
    subscriptionExpiresAt: NOW + HOUR
  });
  assert.equal((await entitlements.consumeSearch('lapsing', NOW)).allowed, true);

  const later = NOW + 2 * HOUR;                 /* the subscription has ended */
  for (let n = 0; n < 3; n++) await entitlements.consumeSearch('lapsing', later);
  assert.equal((await entitlements.consumeSearch('lapsing', later)).allowed, false);
});

/* -------------------------------------------------- one account, one counter */

test('two accounts do not share a counter', async () => {
  seedUser('userA', {});
  seedUser('userB', {});

  for (let n = 0; n < 3; n++) await entitlements.consumeSearch('userA', NOW);
  assert.equal((await entitlements.consumeSearch('userA', NOW)).allowed, false);

  /* B signs in on the same device. Their allowance is their own. */
  const b = await entitlements.consumeSearch('userB', NOW);
  assert.equal(b.allowed, true);
  assert.equal(b.access.dailySearchesRemaining, 2);
});

test('a free account does not inherit a paid account s access', async () => {
  seedUser('paidUser', {
    activeSubscriptionStatus: 'active',
    subscriptionExpiresAt: NOW + 30 * 24 * HOUR
  });
  seedUser('freeUser', {});

  assert.equal((await entitlements.readAccess('paidUser', NOW)).paid, true);
  assert.equal((await entitlements.readAccess('freeUser', NOW)).paid, false);
});

test('the counter survives a sign-out, because it is not in the browser', async () => {
  seedUser('persist', {});
  for (let n = 0; n < 3; n++) await entitlements.consumeSearch('persist', NOW);

  /* Signing out and back in changes nothing here: the count is a field on the
     user document, and there is no client state involved to clear. */
  const after = await entitlements.readAccess('persist', NOW);
  assert.equal(after.dailySearchesRemaining, 0);
  assert.equal((await entitlements.consumeSearch('persist', NOW)).allowed, false);
});

/* --------------------------------------------------------------- signed out */

test('a signed-out visitor has no searches and is told to sign in', async () => {
  const access = await entitlements.readAccess(null, NOW);
  assert.equal(access.signedIn, false);
  assert.equal(access.paid, false);
  assert.equal(access.dailySearchesRemaining, 0);
  assert.match(access.reason, /sign-in/i);
});

test('an account with no profile document still gets its three searches', async () => {
  /* Signed in, but /api/profile-sync has not run yet. They are a real user and
     must not be locked out by a missing record. */
  const r = await entitlements.consumeSearch('brandnew', NOW);
  assert.equal(r.allowed, true);
  assert.equal(r.access.dailySearchesRemaining, 2);
});
