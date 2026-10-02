/* ============================================================================
   api/_lib/subscription-staff.test.js
   ----------------------------------------------------------------------------
   TEST 11 — staff cannot hand out the product.

   Today the backend is owner-only: OWNER_ONLY is true in _schema/roles.js, so
   nobody but the owner reaches any admin route and a "staff tries it" test
   would pass for the wrong reason. This file switches the registry ON for its
   own process — the way the business would the day it hires support — and
   proves the subscription route still refuses everyone who should be refused.

   Each test file runs in its own process under `node --test`, so replacing the
   roles module here touches nothing else.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.FIREBASE_SERVICE_ACCOUNT = '{"project_id":"test-project"}';
delete process.env.OWNER_UID;

const { create, invoke } = require('./testing/fake-firebase');
const fake = create();
fake.install();

/* The registry path, live. Installed before admin-auth is first required, so
   it reads this copy. Everything else about the roles is the real table. */
const rolesPath = require.resolve('../_schema/roles');
const realRoles = require(rolesPath);
require.cache[rolesPath].exports = { ...realRoles, OWNER_ONLY: false };

const route = require('../_admin/subscription');
const accessRoute = require('../access');
const { resolveEntitlement } = require('../_schema/entitlement');

/** A staff account: a role on the token AND a record in the registry. */
function staff(role, { registryRole = role, disabled = false, registry = true } = {}) {
  const uid = 'uid-staff-' + role + '-' + Math.random().toString(36).slice(2, 8);
  const token = fake.account({ uid, email: uid + '@example.com', name: role, claims: { role } });
  if (registry) fake.seed('adminUsers', uid, { uid, role: registryRole, disabled });
  return { uid, token };
}

let n = 0;
function customer() {
  const uid = 'uid-customer-' + (++n);
  const token = fake.account({ uid, email: 'customer' + n + '@example.com' });
  fake.seed('users', uid, {
    uid, email: 'customer' + n + '@example.com', createdAt: Date.now(),
    subscriptionStatus: 'none', activeSubscriptionStatus: 'none'
  });
  return { uid, token };
}

const post = (token, body) => invoke(route, { method: 'POST', token, body });
const get = (token, uid) => invoke(route, { method: 'GET', query: { uid }, token });
const held = uid => resolveEntitlement(fake.read('users', uid), Date.now());

const EVERY_WRITE = uid => [
  { action: 'assign', uid, planId: 'lifetime' },
  { action: 'assign', uid, planId: 'yearly' },
  { action: 'assign', uid, planId: 'monthly' },
  { action: 'assign', uid, planId: 'monthly', mode: 'extend' },
  { action: 'revoke', uid }
];

test('TEST 11 — a support account cannot assign Lifetime, or any plan, or revoke one', async () => {
  const support = staff('support');
  const target = customer();

  for (const body of EVERY_WRITE(target.uid)) {
    const r = await post(support.token, body);
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(r.body.error, 'not authorised for this action');
  }

  assert.equal(held(target.uid).isActive, false, 'nothing was granted');
  assert.equal(fake.all('subscriptions').length, 0);
  assert.equal(fake.all('adminAuditLog').filter(e => e.targetId === target.uid).length, 0);

  /* And the customer is still a free account on the very next request. */
  const access = await invoke(accessRoute, { query: { section: 'access' }, token: target.token });
  assert.equal(access.body.paid, false);
});

test('support cannot give ITSELF a plan either', async () => {
  const support = staff('support');
  fake.seed('users', support.uid, { uid: support.uid, activeSubscriptionStatus: 'none' });

  const r = await post(support.token, { action: 'assign', uid: support.uid, planId: 'lifetime' });
  assert.equal(r.status, 403);
  assert.equal(held(support.uid).isActive, false);
});

test('support can still READ a subscription, and is offered no plans to assign', async () => {
  const support = staff('support');
  const target = customer();

  const r = await get(support.token, target.uid);
  assert.equal(r.status, 200);
  assert.equal(r.body.canWrite, false);
  assert.deepEqual(r.body.plans, [], 'a role that cannot assign is not shown what it could assign');
});

test('an analyst can neither change a subscription nor read an individual one', async () => {
  const analyst = staff('analyst');
  const target = customer();

  for (const body of EVERY_WRITE(target.uid)) {
    assert.equal((await post(analyst.token, body)).status, 403, JSON.stringify(body));
  }
  assert.equal((await get(analyst.token, target.uid)).status, 403);
  assert.equal(held(target.uid).isActive, false);
});

test('an authorised admin CAN assign Lifetime — the permission is real, not just absent', async () => {
  const admin = staff('admin');
  const target = customer();

  const r = await post(admin.token, { action: 'assign', uid: target.uid, planId: 'lifetime' });
  assert.equal(r.status, 200);
  assert.equal(r.body.entitlement.isLifetime, true);
  assert.equal(held(target.uid).isActive, true);

  /* The log names the admin who did it, not the owner. */
  const [entry] = fake.all('adminAuditLog').filter(e => e.targetId === target.uid);
  assert.equal(entry.actorUid, admin.uid);
  assert.equal(entry.actorRole, 'admin');
});

test('a token that CLAIMS admin is not an admin: the registry decides', async () => {
  const target = customer();

  /* The claim was never backed by a registry record. */
  const noRecord = staff('admin', { registry: false });
  /* The record exists and has been switched off. */
  const revoked = staff('admin', { disabled: true });
  /* The token still says admin; the registry demoted them to support. */
  const demoted = staff('admin', { registryRole: 'support' });

  for (const who of [noRecord, revoked, demoted]) {
    const r = await post(who.token, { action: 'assign', uid: target.uid, planId: 'lifetime' });
    assert.equal(r.status, 403);
  }
  assert.equal(held(target.uid).isActive, false);
});

test('a customer with no staff claim is refused before the registry is even read', async () => {
  const user = customer();
  const target = customer();
  for (const body of EVERY_WRITE(target.uid)) {
    assert.equal((await post(user.token, body)).status, 403);
  }
  assert.equal((await post(undefined, { action: 'assign', uid: target.uid, planId: 'lifetime' })).status, 401);
  assert.equal(held(target.uid).isActive, false);
});
