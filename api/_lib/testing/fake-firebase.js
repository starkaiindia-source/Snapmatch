/* ============================================================================
   api/_lib/testing/fake-firebase.js — Firestore AND Authentication, in memory
   ----------------------------------------------------------------------------
   The in-memory Firestore next door (./fake-firestore), plus the half it does
   not have: ID tokens and accounts. Together they stand in for the whole of
   ./firebase, so a test can drive a REAL route handler end to end — token in,
   Firestore read, entitlement resolved, response out — rather than a mock of
   the one function it happens to be looking at.

   That matters for billing. The subscription bug this was written after did
   not live in any single function: every one of them did its job, and a shop
   that had paid was still shown the paywall. A per-function stub cannot see a
   fault that sits between layers.

   What the authentication half is faithful about:

     · verifyIdToken throws an `auth/...` code for a token it does not know, so
       "a bad token" and "no token" are different inputs — as they are live,
       and as the access route now treats them
     · getUser / getUsers / getUserByEmail answer from the registered accounts,
       and `auth/user-not-found` for anyone else

   Not shipped: nothing under api/*.js requires this file, and the directory is
   in .vercelignore.
   ========================================================================== */
'use strict';

const path = require('path');
const { createFakeFirestore } = require('./fake-firestore');

function create() {
  const firestore = createFakeFirestore();
  const tokens = new Map();            /* token -> decoded claims */
  const accounts = new Map();          /* uid -> auth record */

  function authError(code) {
    return Object.assign(new Error(code), { code });
  }
  const record = a => ({ ...a, metadata: {}, providerData: [{ providerId: 'google.com' }] });

  const auth = {
    async verifyIdToken(token) {
      if (!tokens.has(token)) throw authError('auth/argument-error');
      return { ...tokens.get(token) };
    },
    async getUser(uid) {
      if (!accounts.has(uid)) throw authError('auth/user-not-found');
      return record(accounts.get(uid));
    },
    async getUsers(identifiers) {
      return {
        users: identifiers.map(i => accounts.get(i.uid)).filter(Boolean).map(record),
        notFound: identifiers.filter(i => !accounts.has(i.uid))
      };
    },
    async getUserByEmail(email) {
      for (const a of accounts.values()) if (a.email === email) return record(a);
      throw authError('auth/user-not-found');
    }
  };

  const exportsObject = {
    db: () => firestore.db,
    auth: () => auth,
    app: () => ({}),
    projectId: () => 'test-project',
    admin: { firestore: { FieldValue: firestore.FieldValue } }
  };

  return {
    exports: exportsObject,
    firestore,

    /** Replaces ../firebase for everything loaded after this call. */
    install() {
      const firebasePath = require.resolve(path.join(__dirname, '..', 'firebase'));
      require.cache[firebasePath] = {
        id: firebasePath, filename: firebasePath, loaded: true, exports: exportsObject
      };
    },

    /** Registers an account and returns the ID token that signs in as it. */
    account({ uid, email, name, emailVerified = true, claims = {} }) {
      accounts.set(uid, { uid, email: email || null, displayName: name || null, customClaims: claims });
      const token = 'tok-' + uid;
      tokens.set(token, {
        uid, email: email || undefined, email_verified: emailVerified, name: name || undefined, ...claims
      });
      return token;
    },

    seed(collection, id, data) { firestore.seed(collection + '/' + id, data); },
    read(collection, id) {
      const data = firestore.read(collection + '/' + id);
      return data === undefined ? null : data;
    },
    all(collection) { return firestore.all(collection); }
  };
}

/**
 * Runs a Vercel-style handler and resolves with what it sent.
 * @returns {Promise<{status:number, body:any, headers:object}>}
 */
function invoke(handler, { method = 'GET', url = '/', query = {}, token, body } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      status(code) { this.statusCode = code; return this; },
      setHeader(k, v) { this.headers[k] = v; },
      end(payload) {
        let parsed = null;
        try { parsed = payload ? JSON.parse(payload) : null; } catch { parsed = payload; }
        resolve({ status: this.statusCode, body: parsed, headers: this.headers });
      }
    };
    const req = {
      method, url, query,
      headers: token ? { authorization: 'Bearer ' + token } : {},
      body
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

module.exports = { create, invoke };
