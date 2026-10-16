/* ============================================================================
   api/_lib/search-quota.test.js
   ----------------------------------------------------------------------------
   The lifetime search allowance — five per account, for good.

   "THE SIXTH NEW SEARCH IS REFUSED, AND NOTHING EVER GIVES THE FIVE BACK."
   That is one assertion, and most of this file is the ways round it: two tabs
   at once, a date moving on, signing out and back in, a purchase, an expiry,
   a retried request, a paid account that should not be metered at all.

   Firestore is stubbed. The stub is a real transaction though — read the
   documents, run the callback, keep what it writes, and run it AGAIN if a
   document it read changed before it committed, which is what Firestore does
   — so the read-modify-write under test is the one that runs in production,
   including under contention.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/* ------------------------------------------------------------- the stub

   Swapped into the module cache BEFORE the service is required, so the
   service's own `require('../_lib/firebase')` resolves to this. */

const store = new Map();
const versions = new Map();
let commits = 0;

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

/* Optimistic concurrency, as Firestore's server SDK does it: remember the
   version of every document read, and at commit time run the whole callback
   again if any of them has moved. The await inside get() lets other
   transactions interleave, which is the case that matters. */
const fakeDb = () => ({
  collection: name => ({ doc: id => docRef(name, id) }),
  runTransaction: async fn => {
    for (let attempt = 0; attempt < 25; attempt++) {
      const seen = new Map();
      const writes = [];
      const tx = {
        get: async ref => {
          seen.set(ref.__key, versions.get(ref.__key) || 0);
          await new Promise(r => setImmediate(r));
          return ref.get();
        },
        set: (ref, data, opts) => { writes.push([ref.__key, data, opts]); }
      };
      const result = await fn(tx);
      const stale = Array.from(seen).some(([k, v]) => (versions.get(k) || 0) !== v);
      if (stale) continue;
      /* Applied only after the callback returns, like a real transaction: a
         refusal that writes nothing must leave the document untouched. */
      writes.forEach(([key, data, opts]) => {
        const prior = (opts && opts.merge && store.get(key)) || {};
        store.set(key, Object.assign({}, prior, data));
        versions.set(key, (versions.get(key) || 0) + 1);
      });
      if (writes.length) commits++;
      return result;
    }
    throw new Error('transaction contention');
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
const { FREE_LIFETIME_SEARCHES } = require('../_schema/entitlement');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-16T06:30:00Z');

const MODELS = ['oppo-a6', 'vivo-y20', 'oneplus-12r', 'itel-a80', 'apple-iphone-15', 'realme-5'];

function seedUser(uid, fields) {
  store.set('users/' + uid, Object.assign({ uid }, fields));
}
const usage = uid => store.get('searchUsage/' + uid);
const consume = (uid, model, at) => entitlements.consumeSearch(uid, at || NOW, model);

test.beforeEach(() => { store.clear(); versions.clear(); commits = 0; });

/* ------------------------------------------------------------ the rule */

test('a new account has five searches, and the sixth new search is refused', async () => {
  seedUser('free1', {});
  assert.equal((await entitlements.readAccess('free1', NOW)).searchesRemaining, 5);

  for (let n = 1; n <= FREE_LIFETIME_SEARCHES; n++) {
    const r = await consume('free1', MODELS[n - 1]);
    assert.equal(r.allowed, true, `search ${n} should be allowed`);
    assert.equal(r.charged, true);
    assert.equal(r.access.searchesRemaining, FREE_LIFETIME_SEARCHES - n);
  }

  const sixth = await consume('free1', MODELS[5]);
  assert.equal(sixth.allowed, false, 'THE SIXTH NEW SEARCH MUST BE REFUSED');
  assert.equal(sixth.access.searchesRemaining, 0);
  assert.equal(usage('free1').used, 5);
});

test('the first search is counted once, whatever re-asks for it', async () => {
  seedUser('once', {});
  /* One accepted search, then the same model again: a reload, Back, a double
     tap, a retried request. */
  for (let n = 0; n < 6; n++) await consume('once', 'oppo-a6');
  assert.equal(usage('once').used, 1);
  assert.deepEqual(usage('once').models, ['oppo-a6']);
  assert.equal(commits, 1, 'a repeat writes nothing at all');
});

test('a model already searched still opens after the five are spent', async () => {
  seedUser('reopen', {});
  for (let n = 0; n < 5; n++) await consume('reopen', MODELS[n]);
  const again = await consume('reopen', MODELS[2]);
  assert.equal(again.allowed, true, 'the same search, not a new one');
  assert.equal(again.charged, false);
  assert.equal((await consume('reopen', MODELS[5])).allowed, false);
});

test('a refusal writes nothing, so it cannot inflate the counter', async () => {
  seedUser('free2', {});
  for (let n = 0; n < 5; n++) await consume('free2', MODELS[n]);
  const before = commits;
  for (let n = 0; n < 20; n++) await consume('free2', 'realme-5');
  assert.equal(usage('free2').used, 5);
  assert.equal(commits, before, 'a blocked attempt must not write anything');
});

test('a request with no model id is charged every time', async () => {
  /* A browser from before this change sends {}. It cannot be de-duplicated,
     so it is metered — never waved through. */
  seedUser('legacyClient', {});
  for (let n = 0; n < 5; n++) assert.equal((await consume('legacyClient', null)).allowed, true);
  assert.equal((await consume('legacyClient', null)).allowed, false);
});

/* ------------------------------------------------------- nothing resets it */

test('the date moving on gives nothing back — not tomorrow, not next year', async () => {
  seedUser('dated', {});
  for (let n = 0; n < 5; n++) await consume('dated', MODELS[n]);

  for (const later of [NOW + DAY, NOW + 7 * DAY, NOW + 40 * DAY, NOW + 400 * DAY]) {
    assert.equal((await consume('dated', 'realme-5', later)).allowed, false);
    assert.equal((await entitlements.readAccess('dated', later)).searchesRemaining, 0);
  }
});

test('signing out and back in, or another device, changes nothing', async () => {
  seedUser('persist', {});
  for (let n = 0; n < 3; n++) await consume('persist', MODELS[n]);
  /* The count is a server document keyed by uid. There is no client state
     involved to clear, so a new session is the same account. */
  const after = await entitlements.readAccess('persist', NOW + HOUR);
  assert.equal(after.searchesRemaining, 2);
});

test('two accounts do not share a counter', async () => {
  seedUser('userA', {});
  seedUser('userB', {});
  for (let n = 0; n < 5; n++) await consume('userA', MODELS[n]);
  assert.equal((await consume('userA', 'realme-5')).allowed, false);

  const b = await consume('userB', 'realme-5');
  assert.equal(b.allowed, true);
  assert.equal(b.access.searchesRemaining, 4);
});

/* ------------------------------------------------------------- concurrency */

test('ten searches at once cannot run more than five', async () => {
  seedUser('racer', {});
  const ids = MODELS.concat(['realme-6', 'realme-7', 'realme-8', 'realme-9']);
  const results = await Promise.all(ids.map(id => consume('racer', id)));
  assert.equal(results.filter(r => r.allowed).length, 5, 'exactly five may succeed');
  assert.equal(usage('racer').used, 5);
  assert.equal(usage('racer').models.length, 5);
});

test('the same search sent twice at once is charged once', async () => {
  seedUser('double', {});
  const [a, b] = await Promise.all([consume('double', 'oppo-a6'), consume('double', 'oppo-a6')]);
  assert.equal(a.allowed && b.allowed, true);
  assert.equal(usage('double').used, 1);
});

/* ------------------------------------------------------------------- paid */

test('a paid account is never metered, and has no usage written', async () => {
  seedUser('paid1', {
    activeSubscriptionStatus: 'active',
    currentPlanId: 'monthly',
    subscriptionExpiresAt: NOW + 30 * DAY
  });
  for (let n = 0; n < 50; n++) {
    assert.equal((await consume('paid1', MODELS[n % 6])).allowed, true);
  }
  assert.equal(usage('paid1'), undefined);
});

test('buying a plan does not reset the count, and expiry meets it again', async () => {
  seedUser('buyer', {});
  for (let n = 0; n < 5; n++) await consume('buyer', MODELS[n]);
  assert.equal((await consume('buyer', 'realme-5')).allowed, false);

  /* The payment path writes the subscription — and nothing else. */
  seedUser('buyer', {
    activeSubscriptionStatus: 'active', currentPlanId: 'monthly',
    subscriptionExpiresAt: NOW + 30 * DAY
  });
  assert.equal((await consume('buyer', 'realme-5')).allowed, true, 'a subscriber searches freely');
  assert.equal(usage('buyer').used, 5, 'and the free count is untouched');

  /* A month later the plan has ended. */
  const lapsed = NOW + 31 * DAY;
  assert.equal((await consume('buyer', 'realme-6', lapsed)).allowed, false,
    'the five were spent before the purchase, and stay spent');
  assert.equal((await entitlements.readAccess('buyer', lapsed)).searchesRemaining, 0);
});

test('a revoked plan restores the restriction at once', async () => {
  seedUser('revoked', {
    activeSubscriptionStatus: 'revoked', currentPlanId: 'yearly',
    subscriptionExpiresAt: NOW + 300 * DAY
  });
  const a = await entitlements.readAccess('revoked', NOW);
  assert.equal(a.paid, false);
  assert.equal(a.searchesRemaining, 5);
});

test('a free account does not inherit a paid account s access', async () => {
  seedUser('paidUser', { activeSubscriptionStatus: 'active', subscriptionExpiresAt: NOW + 30 * DAY });
  seedUser('freeUser', {});
  assert.equal((await entitlements.readAccess('paidUser', NOW)).paid, true);
  assert.equal((await entitlements.readAccess('freeUser', NOW)).paid, false);
});

/* ------------------------------------------------------- existing accounts */

test('an account that spent three yesterday under the old meter has two left', async () => {
  seedUser('legacy3', { freeSearchDay: '2026-10-15', freeSearchCount: 3, freeSearchAt: NOW - DAY });
  assert.equal((await entitlements.readAccess('legacy3', NOW)).searchesRemaining, 2,
    'the daily count is NOT forgiven by becoming a lifetime one');

  const r = await consume('legacy3', 'oppo-a6');
  assert.equal(r.access.searchesRemaining, 1);
  assert.equal(usage('legacy3').used, 4);
  assert.deepEqual(usage('legacy3').migratedFrom, { day: '2026-10-15', count: 3 });

  await consume('legacy3', 'vivo-y20');
  assert.equal((await consume('legacy3', 'itel-a80')).allowed, false);
});

test('the old daily fields are read once and never written again', async () => {
  seedUser('legacy1', { freeSearchDay: '2026-09-01', freeSearchCount: 1 });
  await consume('legacy1', 'oppo-a6');
  const u = store.get('users/legacy1');
  assert.equal(u.freeSearchDay, '2026-09-01');
  assert.equal(u.freeSearchCount, 1);
  /* Once the usage document exists it is the only source: editing the old
     fields can no longer move the count. */
  store.set('users/legacy1', Object.assign({}, u, { freeSearchCount: 0 }));
  assert.equal((await entitlements.readAccess('legacy1', NOW)).searchesRemaining, 3);
});

test('an account with no profile document still gets its five', async () => {
  /* Signed in, but /api/profile-sync has not run yet. They are a real user and
     must not be locked out by a missing record. */
  const r = await consume('brandnew', 'oppo-a6');
  assert.equal(r.allowed, true);
  assert.equal(r.access.searchesRemaining, 4);
});

/* --------------------------------------------------------------- signed out */

test('a signed-out visitor has no searches and is told to sign in', async () => {
  const access = await entitlements.readAccess(null, NOW);
  assert.equal(access.signedIn, false);
  assert.equal(access.paid, false);
  assert.match(access.reason, /sign-in/i);
});

/* ------------------------------------------------------- group lookups */

test('an unknown group is null rather than an empty group', async () => {
  /* Falls through the local file to Firestore, finds nothing, and says so.
     An empty group object would render as "no devices recorded" over a group
     that does not exist. */
  assert.equal(await entitlements.groupForUser('no-such-group-at-all', 'paid'), null);
});

test('a group read from Firestore is sliced by tier, exactly as a local one is', async () => {
  /* Production has no api/_data/parts.json — it is git-ignored because this
     repository is public — so this is the path that actually runs live. */
  store.set('groupDetails/gd-1', {
    partCode: 'MPF-XX-0001',
    drawingName: 'Master Model',
    memberCount: 60,
    memberIds: Array.from({ length: 60 }, (_, i) => 'm' + i),
    memberNames: Array.from({ length: 60 }, (_, i) => 'Model ' + i)
  });

  const free = await entitlements.groupForUser('gd-1', 'free');
  assert.equal(free.memberCount, 60, 'the SIZE is free');
  assert.equal(free.members.length, 0, 'a free account sees no members at all');
  assert.equal(free.lockedCount, 60);
  assert.equal(free.requiresPlan, true);
  assert.equal(free.partCode, 'MPF-XX-0001');

  /* And not one name is in the payload. */
  const serialised = JSON.stringify(free);
  for (let i = 0; i < 60; i++) {
    assert.equal(serialised.includes('Model ' + i), false, `Model ${i} leaked`);
  }

  /* The same group, for a subscriber, is the whole list. */
  const paid = await entitlements.groupForUser('gd-1', 'paid');
  assert.equal(paid.members.length, 60);
  assert.equal(paid.lockedCount, 0);
  assert.equal(paid.requiresPlan, false);
});
