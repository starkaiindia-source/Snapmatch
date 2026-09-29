/* ============================================================================
   src/data/identity-reads.test.js
   ----------------------------------------------------------------------------
   What one sign-in, and one page load, cost in Firestore operations.

   The fresh Firebase project runs on the Spark plan, so these numbers are a
   budget rather than a curiosity. Each test loads the REAL firestore.js,
   api.js and auth.js into a sandbox whose Firestore counts every get() and
   set(), and whose /api/profile-sync counts every call, and asserts the count.

   What they pin down:
     · a returning shop's page load reads users/{uid} once and writes nothing
     · a reload inside the reuse window reads nothing at all
     · the two callers a sign-in wakes share ONE resolution
     · a new account is created once, server side, and only once
     · a failed read is not remembered, so Try again really does try again
     · saving a profile does not read the document back
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const AUTH = read('auth.js');
const STORE = read('firestore.js');
const API = read('api.js');

function memoryStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); }
  };
}

const DAY = 24 * 3600 * 1000;

/**
 * @param {object} o
 * @param {object|null} [o.doc]      users/{uid} as Firestore holds it; null = absent
 * @param {string} [o.failWith]      reject every get() with this code
 */
function load(o = {}) {
  const counts = { gets: 0, sets: 0, profileSync: 0, status: 0 };
  let doc = o.doc === undefined ? null : o.doc;

  const docRef = {
    get() {
      counts.gets++;
      if (o.failWith) {
        const e = new Error('refused'); e.code = o.failWith;
        return Promise.reject(e);
      }
      const snapshot = doc ? { ...doc } : null;
      return Promise.resolve({ exists: !!snapshot, data: () => snapshot });
    },
    set(patch) {
      counts.sets++;
      doc = { ...(doc || {}), ...patch };
      return Promise.resolve();
    }
  };
  const db = { collection: () => ({ doc: () => docRef }) };

  const user = { uid: 'u1', email: 'shop@example.com', displayName: 'Shop', photoURL: '' };

  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    setTimeout, clearTimeout,
    setInterval: () => 0,
    Promise, Object, Error, String, Date, Math, JSON, Array, Number, Boolean,
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    navigator: { onLine: true },
    document: { createElement: () => ({}), head: { appendChild() {} } },
    location: { hostname: 'www.mobilepartsfinder.com' },
    atob: s => Buffer.from(s, 'base64').toString('binary')
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  sandbox.SM = {
    debug: { log() {}, warn() {} },
    countries: { byCode: () => ({ name: 'India', dial: '+91' }) },
    fb: {
      isConfigured: () => true,
      projectId: () => 'mobilepartsfindercom',
      ready: () => Promise.resolve({ firestore: () => db }),
      user: () => user,
      signOut: () => Promise.resolve()
    },
    billing: {
      syncProfile() {
        counts.profileSync++;
        /* The server path: create the record if it is absent. */
        if (!doc) doc = { uid: 'u1', email: user.email, lastLoginAt: Date.now() };
        else doc = { ...doc, lastLoginAt: Date.now() };
        return Promise.resolve({ uid: 'u1', created: true, profileCompleted: false });
      },
      status() {
        counts.status++;
        return Promise.resolve({ access: {} });
      }
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(AUTH, sandbox, { filename: 'auth.js' });
  vm.runInContext(STORE, sandbox, { filename: 'firestore.js' });
  vm.runInContext(API, sandbox, { filename: 'api.js' });

  return { SM: sandbox.SM, counts, user, getDoc: () => doc };
}

const COMPLETE = {
  uid: 'u1', email: 'shop@example.com',
  mobileShopName: 'Sri Balaji Mobiles', proprietorName: 'R. Kumar',
  mobileNumber: '9876543210', country: 'India', countryCode: 'IN',
  profileCompleted: true
};

test('a returning shop costs one read and no write', async () => {
  const { SM, counts, user } = load({ doc: { ...COMPLETE, lastLoginAt: Date.now() - 60000 } });

  const r = await SM.session.initializeAuthenticatedUser(user, { reuse: true });

  assert.equal(r.complete, true);
  assert.equal(counts.gets, 1, 'users/{uid} is read exactly once');
  assert.equal(counts.sets, 0, 'nothing is written by the browser');
  assert.equal(counts.profileSync, 0,
    'a recent lastLoginAt means no server write — it used to be one per page load');
});

test('a reload inside the reuse window reads nothing', async () => {
  const { SM, counts, user } = load({ doc: { ...COMPLETE, lastLoginAt: Date.now() } });

  await SM.session.initializeAuthenticatedUser(user, { reuse: true });
  /* A reload is a fresh resolution; the tab's copy is what should answer it. */
  const again = await SM.session.initializeAuthenticatedUser(user, { reuse: true, force: true });

  assert.equal(again.complete, true);
  assert.equal(counts.gets, 1, 'the second resolution is answered from sessionStorage');
});

test('the two callers a sign-in wakes share one resolution', async () => {
  const { SM, counts, user } = load({ doc: { ...COMPLETE, lastLoginAt: Date.now() } });

  const [a, b] = await Promise.all([
    SM.session.initializeAuthenticatedUser(user),
    SM.session.initializeAuthenticatedUser(user)
  ]);

  assert.equal(a, b, 'the same answer, not two equal ones');
  assert.equal(counts.gets, 1);
  assert.equal(counts.profileSync, 0);
});

test('a stale lastLoginAt is refreshed once, in the background', async () => {
  const { SM, counts, user } = load({ doc: { ...COMPLETE, lastLoginAt: Date.now() - 2 * DAY } });

  const r = await SM.session.initializeAuthenticatedUser(user);

  assert.equal(r.complete, true, 'the sign-in does not wait for the stamp');
  await new Promise(res => setTimeout(res, 0));
  assert.equal(counts.profileSync, 1);
});

test('a new account is created once, server side, and reported as new', async () => {
  const { SM, counts, user, getDoc } = load({ doc: null });

  const r = await SM.session.initializeAuthenticatedUser(user);

  assert.equal(r.complete, false, 'a new account goes to the completion form');
  assert.equal(r.isNew, true);
  assert.equal(r.offline, undefined, 'new is not the same as unreadable');
  assert.equal(counts.profileSync, 1, 'the record is created by the server, once');
  assert.equal(counts.gets, 1, 'and there is nothing to read back');
  assert.ok(getDoc(), 'users/{uid} exists afterwards');
});

test('a refused read is an outage, and is not remembered', async () => {
  const { SM, counts, user } = load({ doc: COMPLETE, failWith: 'permission-denied' });

  const r = await SM.session.initializeAuthenticatedUser(user);
  assert.equal(r.offline, true);
  assert.equal(r.outage, true, 'permission-denied is the database refusing, not the phone');
  assert.equal(counts.gets, 1, 'permission-denied is never retried');
  assert.equal(counts.profileSync, 0, 'nothing is written against an unreadable account');

  await SM.session.initializeAuthenticatedUser(user);
  assert.equal(counts.gets, 2, 'Try again asks again');
});

test('saving a profile does not read the document back', async () => {
  const { SM, counts, user } = load({ doc: { ...COMPLETE, address: { city: 'Coimbatore', area: 'RS Puram' } } });

  const p = await SM.store.saveProfile('u1', {
    mobileShopName: 'Sri Balaji Mobiles & Service',
    address: { city: 'Coimbatore', flat: '12B' }
  }, user);

  assert.equal(counts.gets, 1, 'one read, to know whether to stamp createdAt');
  assert.equal(counts.sets, 1);
  assert.equal(p.mobileShopName, 'Sri Balaji Mobiles & Service');
  assert.deepEqual({ ...p.address }, { city: 'Coimbatore', area: 'RS Puram', flat: '12B' },
    'nested fields merge exactly as set(..., {merge:true}) merges them');
  assert.equal(p.profileCompleted, true);
});

test('signing out forgets everything the tab kept for the account', async () => {
  const { SM, counts, user } = load({ doc: { ...COMPLETE, lastLoginAt: Date.now() } });

  await SM.session.initializeAuthenticatedUser(user, { reuse: true });
  await SM.session.signOut();
  await SM.session.initializeAuthenticatedUser(user, { reuse: true });

  assert.equal(counts.gets, 2, 'after a sign-out the next account is read, never recalled');
});
