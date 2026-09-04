/* ============================================================================
   api/_lib/firestore-handle.test.js
   ----------------------------------------------------------------------------
   db() must hand back the same Firestore instance every time and configure it
   exactly once.

   This is a regression test for a bug that produced three unrelated-looking
   symptoms. settings() may only be called before the instance has done any
   work; db() called it on every one of ten call sites, so the second call in a
   request threw, and on a warm serverless instance the first one did. It read
   as a payment failure, a profile-save failure, and a profile that could never
   be completed.
   ========================================================================== */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const LIB = path.join(__dirname, 'firebase.js');

/** Loads api/_lib/firebase.js with firebase-admin replaced by a spy. */
function loadWithFakeAdmin() {
  Object.keys(require.cache)
    .filter(k => k.startsWith(path.join(__dirname)))
    .forEach(k => { delete require.cache[k]; });
  delete globalThis['__mpf_firebase_admin__'];
  delete globalThis['__mpf_firestore__'];

  const calls = { settings: 0, firestore: 0, initializeApp: 0 };
  let started = false;

  const firestoreInstance = {
    settings(opts) {
      calls.settings++;
      /* Mirrors @google-cloud/firestore: once the instance has run anything,
         settings() throws. */
      if (started) {
        throw new Error('Firestore has already been initialized. You can only call ' +
          'settings() once, and only before calling any other methods on a Firestore object.');
      }
    },
    collection() { started = true; return { doc: () => ({ get: async () => ({ exists: false }) }) }; }
  };

  const fakeApp = {
    firestore() { calls.firestore++; return firestoreInstance; },
    auth() { return {}; }
  };

  const fakeAdmin = {
    apps: [],
    app: () => fakeApp,
    initializeApp() { calls.initializeApp++; fakeAdmin.apps.push(fakeApp); return fakeApp; },
    credential: { cert: () => ({}) },
    firestore: { FieldValue: {} }
  };

  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'firebase-admin') return fakeAdmin;
    return origLoad.call(this, req, parent, isMain);
  };

  /* Left set for the life of the test: credentialsFromEnv() runs lazily inside
     app(), which db() reaches long after require() has returned. */
  process.env.FIREBASE_SERVICE_ACCOUNT =
    '{"project_id":"p","private_key":"k","client_email":"e"}';
  const mod = require(LIB);
  Module._load = origLoad;

  return { mod, calls, markStarted: () => { started = true; } };
}

test('settings() is applied once, however many times db() is called', () => {
  const { mod, calls } = loadWithFakeAdmin();
  for (let i = 0; i < 10; i++) mod.db();
  assert.equal(calls.settings, 1, 'settings() must run exactly once');
});

test('db() returns the same instance every time', () => {
  const { mod } = loadWithFakeAdmin();
  const a = mod.db(), b = mod.db(), c = mod.db();
  assert.equal(a, b);
  assert.equal(b, c);
});

test('a second db() after Firestore has done work does not throw', () => {
  /* The exact production sequence: create-order reads the profile, then writes
     the pending order. The read starts the instance; the write called db()
     again and the whole request died. */
  const { mod, markStarted } = loadWithFakeAdmin();
  const first = mod.db();
  first.collection('users');          // Firestore is now started
  markStarted();
  assert.doesNotThrow(() => mod.db(), 'the second db() must not throw');
});

test('a Firestore already started before the first db() is still usable', () => {
  /* The warm-instance case: a previous request used Firestore, this module was
     re-evaluated, and the very first db() call hits an started instance. It
     must warn and carry on, not throw. */
  const { mod, markStarted, calls } = loadWithFakeAdmin();
  markStarted();
  let handle;
  assert.doesNotThrow(() => { handle = mod.db(); });
  assert.ok(handle, 'db() must still return a usable handle');
  assert.equal(calls.settings, 1, 'it tried once and swallowed the refusal');
});
