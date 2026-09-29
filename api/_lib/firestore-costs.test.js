/* ============================================================================
   api/_lib/firestore-costs.test.js
   ----------------------------------------------------------------------------
   Server-side Firestore operation counts, and the owner uid pin.

   The Firebase Admin module is replaced before anything requires it, so these
   run with no credentials and no network: every get(), set() and create() is
   counted against an in-memory document.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

/* ------------------------------------------------------------ fake Firestore */
const counts = { gets: 0, sets: 0, creates: 0 };
const docs = new Map();

function docRef(id) {
  return {
    get() {
      counts.gets++;
      const d = docs.get(id);
      return Promise.resolve({ exists: !!d, data: () => (d ? { ...d } : undefined) });
    },
    set(patch) {
      counts.sets++;
      docs.set(id, { ...(docs.get(id) || {}), ...patch });
      return Promise.resolve();
    },
    create(patch) {
      counts.creates++;
      if (docs.has(id)) return Promise.reject(Object.assign(new Error('exists'), { code: 6 }));
      docs.set(id, { ...patch });
      return Promise.resolve();
    }
  };
}
const fakeDb = { collection: name => ({ doc: id => docRef(name + '/' + id) }) };
const sentinel = kind => (...args) => ({ __sentinel: kind, args });
const fakeAdmin = {
  firestore: {
    FieldValue: {
      increment: sentinel('increment'),
      serverTimestamp: sentinel('serverTimestamp')
    }
  }
};

const firebasePath = require.resolve('./firebase');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: { db: () => fakeDb, auth: () => ({}), app: () => ({}), admin: fakeAdmin }
};

const store = require('./store');
const analytics = require(path.join('..', '_services', 'analytics-service'));
const roles = require('../_schema/roles');

function reset() {
  counts.gets = 0; counts.sets = 0; counts.creates = 0;
  docs.clear();
}

/* ------------------------------------------------------------ profile-sync */

test('profile-sync reads once and writes once — no read-back', async () => {
  reset();
  docs.set('users/u1', {
    uid: 'u1', mobileShopName: 'Sri Balaji Mobiles', proprietorName: 'R. Kumar',
    mobileNumber: '9876543210', country: 'India', createdAt: 1,
    address: { city: 'Coimbatore', area: 'RS Puram' }
  });

  const r = await store.syncProfile({
    uid: 'u1', email: 'shop@example.com', emailVerified: true,
    profile: { address: { flat: '12B' } }, now: 1000
  });

  assert.equal(counts.gets, 1, 'the document is read once');
  assert.equal(counts.sets, 1);
  assert.equal(r.created, false);
  /* The computed result is what the merge actually stored. */
  assert.deepEqual(r.profile.address, { city: 'Coimbatore', area: 'RS Puram', flat: '12B' });
  assert.equal(r.profile.mobileShopName, 'Sri Balaji Mobiles');
  assert.equal(r.profile.createdAt, 1, 'createdAt is never restamped');
  assert.equal(r.profile.lastLoginAt, 1000);
  assert.equal(r.profile.profileCompleted, true);
});

test('profile-sync on a new account creates it with the server-owned fields', async () => {
  reset();
  const r = await store.syncProfile({ uid: 'u2', email: 'new@example.com', now: 5 });

  assert.equal(r.created, true);
  assert.equal(counts.gets, 1);
  assert.equal(counts.sets, 1);
  assert.equal(r.profile.subscriptionStatus, 'none');
  assert.equal(r.profile.createdAt, 5);
  assert.equal(r.profile.profileCompleted, false);
});

/* ---------------------------------------------------------------- analytics */

test('the batch that opens a session stamps firstSeenAt in the same write', async () => {
  reset();
  await analytics.touchSession({ sessionId: 's1', now: 10, eventCount: 2, newSession: true });
  assert.equal(counts.sets, 1);
  assert.equal(counts.creates, 0, 'no separate create attempt');
  assert.equal(docs.get('visitorSessions/s1').firstSeenAt, 10);
});

test('later batches of a session do not touch firstSeenAt at all', async () => {
  reset();
  await analytics.touchSession({ sessionId: 's1', now: 10, eventCount: 1, newSession: true });
  await analytics.touchSession({ sessionId: 's1', now: 99, eventCount: 1, newSession: false });
  assert.equal(counts.creates, 0);
  assert.equal(docs.get('visitorSessions/s1').firstSeenAt, 10, 'the start time is kept');
});

test('an older client that sends no flag still gets a start time', async () => {
  reset();
  await analytics.touchSession({ sessionId: 's2', now: 7, eventCount: 1 });
  assert.equal(counts.creates, 1);
  assert.equal(docs.get('visitorSessions/s2').firstSeenAt, 7);
});

/* ---------------------------------------------------------------- owner uid */

test('with no OWNER_UID set, the verified email alone decides', () => {
  delete process.env.OWNER_UID;
  assert.equal(roles.ownerUid(), null);
  assert.equal(roles.isOwnerUid('anything'), true);
});

test('with OWNER_UID set, only that uid is the owner', () => {
  process.env.OWNER_UID = '  abc123  ';
  try {
    assert.equal(roles.ownerUid(), 'abc123');
    assert.equal(roles.isOwnerUid('abc123'), true);
    assert.equal(roles.isOwnerUid('someone-else'), false);
  } finally {
    delete process.env.OWNER_UID;
  }
});

test('the owner is still Stark.ai.India@gmail.com', () => {
  /* The migration brief named "star.ai.India@gmail.com". That is a different
     mailbox, and granting it the backend would hand it to whoever owns it. */
  assert.equal(roles.isOwnerEmail('stark.ai.india@gmail.com'), true);
  assert.equal(roles.isOwnerEmail('star.ai.india@gmail.com'), false);
});
