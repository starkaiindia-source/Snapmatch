/* ============================================================================
   src/data/firestore-deadline.test.js
   ----------------------------------------------------------------------------
   THE REGRESSION TEST FOR THE INFINITE "Finishing sign-in…".

   On 2026-09-28 the live site signed users in with Google successfully and then
   stopped, for ever, on "Finishing sign-in… / Checking your Google account."
   The cause was not in the sign-in. It was one Firestore read that never came
   back:

     GET firestore.googleapis.com/v1/projects/mobilepartsfinder/…/catalog/meta
     → 403 PERMISSION_DENIED: This API method requires billing to be enabled

   The Firestore SDK does not report that. It treats a failed WebChannel as a
   transient connection problem and retries with backoff indefinitely, so the
   promise from .get() is never resolved AND never rejected — measured pending
   at 30 seconds against the live project, with no error raised.

   initializeAuthenticatedUser awaits that read, so identity never settled, so
   the account screen repainted its spinner and nothing existed that could ever
   change it. Every recovery path the app already had hung off a .catch that
   could not run.

   So: every call out of SM.store now expires. These tests hold that property
   down, because it is invisible in normal operation — it only shows up on the
   day the backend stops answering, which is the day it has to work.

   The module is a browser IIFE over `window`, so it is evaluated in a vm with a
   fabricated global. setTimeout in that sandbox is ours: it fires immediately
   and records the delay it was asked for, which is what keeps a test of a
   10-second deadline finishing in milliseconds.
   ========================================================================== */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, 'firestore.js'), 'utf8');

/**
 * Loads firestore.js against a stub Firestore whose reads behave however the
 * test asks.
 *
 * @param {object} [opts]
 * @param {'hang'|'resolve'|'reject'} [opts.behaviour='hang']
 */
function load(opts) {
  opts = opts || {};
  const behaviour = opts.behaviour || 'hang';
  const delays = [];
  const warnings = [];

  /* The whole point: a deadline of 10s is asserted on, never waited for. The
     requested delay is recorded so the test can check the NUMBER as well as
     the behaviour. */
  function setTimeoutStub(fn, ms) {
    delays.push(ms);
    return setImmediate(fn);
  }
  function clearTimeoutStub(t) { if (t) clearImmediate(t); }

  function snapshot(data) {
    return { exists: !!data, id: 'stub', data: () => data || {} };
  }

  function result() {
    if (behaviour === 'resolve') {
      return Promise.resolve(snapshot({ uid: 'u1', mobileShopName: 'S' }));
    }
    if (behaviour === 'reject') {
      const err = new Error('permission denied by rules');
      err.code = 'permission-denied';
      return Promise.reject(err);
    }
    /* The failure this file exists for: neither resolved nor rejected, ever. */
    return new Promise(() => {});
  }

  const collectionRef = {
    doc: () => docRef,
    where: () => collectionRef,
    orderBy: () => collectionRef,
    startAfter: () => collectionRef,
    limit: () => collectionRef,
    get: result
  };
  const docRef = {
    get: result,
    set: () => result(),
    collection: () => collectionRef
  };
  const db = { collection: () => collectionRef };

  const SM = {
    debug: {
      log() {},
      warn(scope, msg, detail) { warnings.push({ scope, msg, detail }); }
    },
    fb: {
      isConfigured: () => true,
      projectId: () => 'mobilepartsfinder',
      ready: () => Promise.resolve({ firestore: () => db })
    },
    countries: { byCode: () => ({}) }
  };

  const sandbox = {
    SM,
    console: { warn() {}, log() {}, error() {} },
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimeoutStub,
    Promise, Object, Error, String, Date, Math, JSON, Array,
    document: { createElement: () => ({}), head: { appendChild() {} } }
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'firestore.js' });

  return { SM: sandbox.SM, delays, warnings };
}

/** The rejection a call produced, or the string 'RESOLVED'. */
async function outcome(promise) {
  try { await promise; return 'RESOLVED'; }
  catch (err) { return err; }
}

/* -------------------------------------------------------------- the core */

test('a read that never answers rejects instead of hanging for ever', async () => {
  const { SM } = load({ behaviour: 'hang' });

  const err = await outcome(SM.store.loadProfile('uid-123'));

  assert.notEqual(err, 'RESOLVED', 'a hung read must not resolve');
  assert.equal(err.code, 'deadline-exceeded',
    'the rejection must carry the code SM.isBackendOutage recognises');
  assert.equal(err.timedOut, true);
});

test('the deadline code is one api.js already treats as an outage', () => {
  /* Checked against the real table rather than a copy of it: this is the join
     that turns a timeout into "the database refused" instead of the "check
     your connection" that was false for this incident. */
  const api = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
  const table = /var DATASTORE_CODES = \{([\s\S]*?)\};/.exec(api);
  assert.ok(table, 'DATASTORE_CODES not found in api.js');
  assert.ok(table[1].includes("'deadline-exceeded'"),
    'api.js must classify deadline-exceeded as a backend outage');
});

test('every asynchronous method is covered, not just the one that broke', async () => {
  const { SM } = load({ behaviour: 'hang' });

  /* Named explicitly rather than derived from the object under test. A test
     that walked SM.store's own keys would pass just as happily for a module
     with no deadlines at all; this one fails when a new method is added
     without one, which is the property worth holding. */
  const calls = {
    loadProfile: () => SM.store.loadProfile('u'),
    saveProfile: () => SM.store.saveProfile('u', { mobileShopName: 'S' }, null),
    deviceGroups: () => SM.store.deviceGroups('d'),
    groupDetail: () => SM.store.groupDetail('g'),
    groupDetails: () => SM.store.groupDetails(['g']),
    listGroups: () => SM.store.listGroups({}),
    group: () => SM.store.group('g'),
    recentSearches: () => SM.store.recentSearches('u', 5),
    pushSearch: () => SM.store.pushSearch('u', 'm', 'q')
  };

  for (const [name, run] of Object.entries(calls)) {
    const err = await outcome(run());
    if (name === 'recentSearches' || name === 'pushSearch') {
      /* These two swallow their own failures on purpose — search history is a
         nicety and must never block a search. So the deadline lands INSIDE
         their catch and they still resolve; simply getting here, rather than
         awaiting for ever, is the whole assertion. */
      assert.equal(err, 'RESOLVED', `${name} must absorb a timeout, not reject`);
      continue;
    }
    assert.notEqual(err, 'RESOLVED', `${name} resolved a hung read`);
    assert.equal(err.code, 'deadline-exceeded', `${name} did not time out`);
  }
});

test('check() answers with a failure report rather than hanging', async () => {
  const { SM } = load({ behaviour: 'hang' });
  const r = await SM.store.check();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'deadline-exceeded');
});

/* ------------------------------------------------------- the right numbers */

test('a read gets 10 seconds and a photo upload gets 60', async () => {
  const read = load({ behaviour: 'hang' });
  await outcome(read.SM.store.loadProfile('u'));
  assert.ok(read.delays.includes(10000),
    `a read should be given 10000ms, got ${JSON.stringify(read.delays)}`);

  /* An upload is megabytes over a shop counter's connection, not a lookup.
     Holding it to a reader's deadline would cancel legitimate slow uploads. */
  const up = load({ behaviour: 'hang' });
  await outcome(up.SM.store.uploadProfilePhoto('u', { type: 'image/png', size: 1024 }));
  assert.ok(up.delays.includes(60000),
    `an upload should be given 60000ms, got ${JSON.stringify(up.delays)}`);
});

/* ------------------------------------------- the deadline changes nothing else */

test('a read that answers in time is returned untouched', async () => {
  const { SM } = load({ behaviour: 'resolve' });
  const profile = await SM.store.loadProfile('u1');
  assert.equal(profile.uid, 'u1');
  assert.equal(profile.mobileShopName, 'S');
  assert.equal(profile.profileCompleted, false,
    'normalisation still runs through the wrapper');
});

test('a real Firestore rejection keeps its own code and is not relabelled a timeout', async () => {
  const { SM } = load({ behaviour: 'reject' });
  const err = await outcome(SM.store.loadProfile('u1'));
  assert.equal(err.code, 'permission-denied',
    'a rules refusal must stay a rules refusal — relabelling it would send the owner to the wrong fix');
});

test('the paywall still reads a refusal as "not subscribed", not as an error', async () => {
  const { SM } = load({ behaviour: 'reject' });
  /* groupDetail turns permission-denied into null on purpose: for a free
     account the rules refusing IS the paywall working. */
  assert.equal(await SM.store.groupDetail('g'), null);
  assert.equal(await SM.store.deviceGroups('d'), null);
});

test('the synchronous helpers are left alone', () => {
  const { SM } = load({ behaviour: 'hang' });
  assert.equal(SM.store.available(), true, 'available() must stay synchronous');
  assert.equal(SM.store.normaliseProfile(null), null);
  assert.equal(SM.store.normaliseProfile({ mobileShopName: 'A' }).mobileShopName, 'A');
  assert.ok(Array.isArray(SM.store.WRITABLE), 'WRITABLE must survive the wrapping');
});

test('a timeout is logged, so the cause is recoverable from the console', async () => {
  const { SM, warnings } = load({ behaviour: 'hang' });
  await outcome(SM.store.loadProfile('u'));
  assert.ok(warnings.some(w => w.scope === 'firestore' && /timed out/.test(w.msg)),
    'a timed-out read must say so in the debug log');
});
