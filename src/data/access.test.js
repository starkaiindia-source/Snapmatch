/* ============================================================================
   src/data/access.test.js
   ----------------------------------------------------------------------------
   The browser's entitlement cache, against the one failure that made a paying
   subscriber look like a free account.

   WHAT HAPPENED, IN PRODUCTION, ON 2 OCTOBER 2026

   A shop paid ₹799 for the yearly plan. The webhook activated it, users/{uid}
   said `active / yearly / expires 2027`, and the server answered `paid` for
   that uid. The site still sent the shop to the Plans page.

   The page asks /api/access as soon as the catalogue has loaded. Firebase
   restores a signed-in session a moment LATER — it has an SDK to download and
   IndexedDB to read. access.js decided whether to attach the ID token from
   `SM.fb.user()` at the instant of the call, found nobody yet, and sent the
   request with no Authorization header. The server answered that question
   correctly: an anonymous caller is free. The browser then kept that answer
   as THE answer for the subscriber who appeared a second later, and nothing
   asked again.

   Each test loads the REAL access.js into a sandbox whose Firebase resolves
   when the test says so, and whose /api/access behaves as the server does:
   no token is the signed-out free view, a good token is that account's tier.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ACCESS = fs.readFileSync(path.join(__dirname, 'access.js'), 'utf8');

const FREE_ANON = { tier: 'free', paid: false, signedIn: false, dailySearchesRemaining: 0, groupAccess: false };
const FREE_USER = { tier: 'free', paid: false, signedIn: true, dailySearchesRemaining: 3, groupAccess: false };
const PAID_USER = { tier: 'paid', paid: true, signedIn: true, dailySearchesRemaining: null, groupAccess: true };

const tick = () => new Promise(r => setImmediate(r));
async function settle(n = 6) { for (let i = 0; i < n; i++) await tick(); }

/**
 * @param {object} o
 * @param {boolean} [o.localSession]  this browser remembers a signed-in account
 * @param {Record<string,object>} [o.tiers]  token -> the access the server gives it
 * @param {string[]} [o.rejectTokens] tokens the server cannot verify (401)
 */
function load(o = {}) {
  const calls = [];
  const tiers = o.tiers || {};
  const rejected = new Set(o.rejectTokens || []);

  let phase = 'loading';
  let user = null;
  let token = null;
  let sdkStarted = 0;
  const waiters = [];
  const listeners = [];

  const fb = {
    isConfigured: () => true,
    phase: () => phase,
    user: () => user,
    whenResolved() {
      if (phase !== 'loading') return Promise.resolve(user);
      sdkStarted++;
      return new Promise(resolve => waiters.push(resolve));
    },
    idToken(force) {
      if (force && o.refreshedToken) token = o.refreshedToken;
      return Promise.resolve(user ? token : null);
    },
    onChange(fn) { listeners.push(fn); if (user) fn(user); return () => {}; }
  };

  /* What Firebase does when it finishes restoring: the phase leaves 'loading',
     everything waiting on it is released, and the listeners are told. */
  function resolveAuth(nextUser, nextToken) {
    user = nextUser;
    token = nextToken || null;
    phase = nextUser ? 'authenticated' : 'unauthenticated';
    waiters.splice(0).forEach(fn => fn(user));
    listeners.forEach(fn => fn(user));
  }

  function fetchStub(url, init = {}) {
    const headers = init.headers || {};
    const bearer = /^Bearer (.+)$/.exec(headers.Authorization || '');
    calls.push({ url, method: init.method || 'GET', token: bearer ? bearer[1] : null });

    const reply = (status, body) => Promise.resolve({
      ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body)
    });

    if (bearer && rejected.has(bearer[1])) return reply(401, { error: 'token expired' });
    const access = bearer ? (tiers[bearer[1]] || FREE_USER) : FREE_ANON;

    if (String(url).indexOf('/api/device-parts') === 0) {
      const group = access.paid
        ? { groupId: 'sg-1', members: [{ id: 'a', name: 'A' }], memberCount: 1, requiresPlan: false }
        : { groupId: 'sg-1', members: [], memberCount: 1, requiresPlan: true };
      return reply(200, String(url).indexOf('modelId=') > -1
        ? { device: { modelId: 'm1', categories: [{ categoryId: 'c', groups: [group] }] }, access }
        : { group, access });
    }
    if (init.method === 'POST') {
      if (!bearer) return reply(401, { error: 'sign-in required', access: FREE_ANON });
      return reply(200, { allowed: true, access });
    }
    return reply(200, access);
  }

  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    setTimeout, clearTimeout, Promise, Object, Error, String, JSON, Array, Number, Boolean,
    encodeURIComponent,
    fetch: fetchStub
  };
  sandbox.window = sandbox;
  sandbox.SM = {
    debug: { log() {}, warn() {} },
    fb,
    session: { get: () => ({ signedIn: !!o.localSession }) }
  };
  vm.createContext(sandbox);
  vm.runInContext(ACCESS, sandbox);

  return { access: sandbox.SM.access, calls, resolveAuth, sdkStarts: () => sdkStarted };
}

const SHOP = { uid: 'uid-paid-shop' };

/* ------------------------------------------------- the production failure */

test('a subscriber whose session restores AFTER the page asks is still paid', async () => {
  const t = load({ localSession: true, tiers: { 'tok-paid': PAID_USER } });

  /* Boot: the catalogue is in, Firebase is not. This is the call app.js makes
     right after mounting the shell. */
  const asked = t.access.refresh();
  await settle();

  /* Nothing may be decided, and nothing anonymous may be sent, while a
     session this browser remembers is still being restored. */
  assert.equal(t.calls.length, 0, 'the access request must wait for the session it expects');
  assert.equal(t.access.isFree(), false, 'an unanswered question is not a denial');

  t.resolveAuth(SHOP, 'tok-paid');
  await asked;
  await settle();

  assert.equal(t.calls[0].token, 'tok-paid', 'the request must carry the ID token');
  assert.equal(t.calls.length, 1, 'one question, asked once, as the right account');
  assert.equal(t.access.isPaid(), true);
  assert.equal(t.access.isFree(), false);
});

test('an anonymous answer is never kept for an account that signs in while it is in flight', async () => {
  /* No local hint, so the request legitimately goes out anonymous — and then
     Firebase turns up a user before or after the answer lands. Either way the
     signed-out answer must not become that account's tier. */
  const t = load({ localSession: false, tiers: { 'tok-paid': PAID_USER } });

  const asked = t.access.refresh();
  t.resolveAuth(SHOP, 'tok-paid');
  await asked;
  await settle();

  assert.equal(t.access.isPaid(), true, 'the account must be re-asked as itself');
  assert.equal(t.access.isFree(), false);
  assert.ok(t.calls.some(c => c.token === 'tok-paid'));
});

test('a session that appears later replaces a signed-out answer already held', async () => {
  const t = load({ localSession: false, tiers: { 'tok-paid': PAID_USER } });

  await t.access.refresh();
  await settle();
  assert.equal(t.access.get().signedIn, false, 'a visitor with no session gets the free view');

  t.resolveAuth(SHOP, 'tok-paid');
  await settle();

  assert.equal(t.access.isPaid(), true);
});

test('a visitor with no session is answered at once, without loading the sign-in SDK', async () => {
  const t = load({ localSession: false });

  await t.access.refresh();

  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].token, null);
  assert.equal(t.sdkStarts(), 0, 'most visits never sign in and must not pay for it');
  assert.equal(t.access.isFree(), true);
});

test('a group opened during boot waits for the session too', async () => {
  /* /group/<id> typed into the address bar: the member request is issued by
     the router on the first frame, before Firebase has answered. */
  const t = load({ localSession: true, tiers: { 'tok-paid': PAID_USER } });

  const asked = t.access.groupMembers('sg-1');
  await settle();
  assert.equal(t.calls.length, 0);

  t.resolveAuth(SHOP, 'tok-paid');
  const group = await asked;

  assert.equal(group.requiresPlan, false);
  assert.equal(group.members.length, 1);
});

test('a device lookup answered as signed-out is not cached for the account', async () => {
  const t = load({ localSession: false, tiers: { 'tok-paid': PAID_USER } });

  const before = await t.access.deviceGroups('m1');
  assert.equal(before.categories[0].groups[0].requiresPlan, true);

  t.resolveAuth(SHOP, 'tok-paid');
  await settle();

  const after = await t.access.deviceGroups('m1');
  assert.equal(after.categories[0].groups[0].requiresPlan, false,
    'the signed-out copy must not be served to the subscriber');
});

/* ------------------------------------------------------- a token the server
   cannot verify is not a verdict on the account */

test('a rejected token is refreshed and retried, not read as "free"', async () => {
  const t = load({
    localSession: true,
    tiers: { 'tok-fresh': PAID_USER },
    rejectTokens: ['tok-stale'],
    refreshedToken: 'tok-fresh'
  });
  t.resolveAuth(SHOP, 'tok-stale');

  await t.access.refresh();
  await settle();

  assert.deepEqual(t.calls.filter(c => c.method === 'GET').map(c => c.token), ['tok-stale', 'tok-fresh']);
  assert.equal(t.access.isPaid(), true);
});

test('when the token cannot be made good the account is unknown, never free', async () => {
  const t = load({ localSession: true, rejectTokens: ['tok-stale'] });
  t.resolveAuth(SHOP, 'tok-stale');

  await t.access.refresh();
  await settle();

  assert.equal(t.access.get(), null);
  assert.equal(t.access.isFree(), false, 'a failed check must not paywall a subscriber');
  assert.equal(t.access.isPaid(), false, 'and it must not unlock anything either');
});

/* ------------------------------------------------------------ still a paywall */

test('a signed-in account with no plan is free, and is told so', async () => {
  const t = load({ localSession: true, tiers: { 'tok-free': FREE_USER } });
  t.resolveAuth({ uid: 'uid-free' }, 'tok-free');

  await t.access.refresh();

  assert.equal(t.access.isFree(), true);
  assert.equal(t.access.isPaid(), false);
  assert.equal(t.access.remaining(), 3);

  const group = await t.access.groupMembers('sg-1');
  assert.equal(group.requiresPlan, true);
  assert.equal(group.members.length, 0);
});

test('signing out drops the subscriber\'s answer', async () => {
  const t = load({ localSession: true, tiers: { 'tok-paid': PAID_USER } });
  t.resolveAuth(SHOP, 'tok-paid');
  await t.access.refresh();
  assert.equal(t.access.isPaid(), true);

  t.resolveAuth(null, null);
  await settle();

  assert.equal(t.access.isPaid(), false, 'the next person at the counter inherits nothing');
});

test('a paid search needs no round trip, and a free one is metered by the server', async () => {
  const paid = load({ localSession: true, tiers: { 'tok-paid': PAID_USER } });
  paid.resolveAuth(SHOP, 'tok-paid');
  await paid.access.refresh();
  const before = paid.calls.length;
  const r = await paid.access.consumeSearch();
  assert.equal(r.allowed, true);
  assert.equal(paid.calls.length, before);

  const free = load({ localSession: true, tiers: { 'tok-free': FREE_USER } });
  free.resolveAuth({ uid: 'uid-free' }, 'tok-free');
  await free.access.refresh();
  const f = await free.access.consumeSearch();
  assert.equal(f.allowed, true);
  assert.equal(free.calls.filter(c => c.method === 'POST').length, 1);
});
