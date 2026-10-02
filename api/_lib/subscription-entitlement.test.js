/* ============================================================================
   api/_lib/subscription-entitlement.test.js
   ----------------------------------------------------------------------------
   The entitlement, end to end: a plan reaches an account, and the account can
   then search, see results, open a group and read the devices in it — or it
   cannot, and gets none of them.

   Driven through the REAL route handlers against an in-memory Firebase
   (./testing/fake-firebase), because the failure this file was written after did
   not live in any one function. On 2 October 2026 a shop paid ₹799, every
   function involved did its job, and the shop was still asked to pay again.

   The plans, stated once, because every test below depends on them:

     ₹99    Monthly    sold      one month
     ₹799   Yearly     sold      twelve months
     —      Lifetime   NOT sold  no expiry; an administrator assigns it by hand

   The numbered scenarios are the acceptance list for the fix.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/* A deployment that is switched on, with no real credential anywhere. */
process.env.FIREBASE_SERVICE_ACCOUNT = '{"project_id":"test-project"}';
process.env.RAZORPAY_KEY_ID = 'rzp_test_entitlementTests';
process.env.RAZORPAY_KEY_SECRET = 'not-a-real-secret';
delete process.env.OWNER_UID;

const { create, invoke } = require('./testing/fake-firebase');
const fake = create();
fake.install();

const accessRoute = require('../access');
const adminRoute = require('../admin');
const subscriptionRoute = require('../subscription');
const cancelRoute = require('../cancel-subscription');
const createOrderRoute = require('../create-order');
const store = require('./store');
const { addMonths } = require('./billing-period');
const { PLANS, getPlan, publicCatalogue, assignableCatalogue } = require('./plans');
const { resolveEntitlement } = require('../_schema/entitlement');
const { OWNER_EMAIL, ROLES, PERMISSIONS, can } = require('../_schema/roles');

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

/* -------------------------------------------------------------- the catalogue
   One device, one group, four devices in the group. Synthetic ids, so the
   service reads the stub and not the real api/_data/parts.json. */
const MODEL = 'zz-ent-model';
const GROUP = 'zz-ent-battery-1';
fake.seed('modelGroups', MODEL, { id: MODEL, byCategory: { battery: [GROUP] } });
fake.seed('groupDetails', GROUP, {
  partCode: 'MPF-BT-ENT1', drawingName: 'Entitlement Test Master', memberCount: 4,
  memberIds: ['zz-ent-a', 'zz-ent-b', 'zz-ent-c', 'zz-ent-d'],
  memberNames: ['Ent Device A', 'Ent Device B', 'Ent Device C', 'Ent Device D']
});

/* ------------------------------------------------------------------- people */
const OWNER = fake.account({ uid: 'uid-owner-0000', email: OWNER_EMAIL, name: 'Owner' });
const ADMIN = { uid: 'uid-owner-0000', email: OWNER_EMAIL, name: 'Owner', role: ROLES.SUPER_ADMIN };

let n = 0;
/** A fresh signed-in shop with a profile document, and its token. */
function shop(profile = {}) {
  const uid = 'uid-shop-' + String(++n).padStart(4, '0');
  const email = 'shop' + n + '@example.com';
  const token = fake.account({ uid, email, name: 'Shop ' + n });
  fake.seed('users', uid, {
    uid, email, createdAt: Date.now() - 30 * DAY, accountStatus: 'active',
    mobileShopName: 'Shop ' + n, proprietorName: 'Owner ' + n,
    mobileNumber: '9000000000', country: 'India',
    subscriptionStatus: 'none', activeSubscriptionStatus: 'none',
    ...profile
  });
  return { uid, email, token };
}

/** A plan as a verified payment leaves it on the profile. */
function paidPlan(planId, { startedAgo = HOUR, expiresIn } = {}) {
  const startedAt = Date.now() - startedAgo;
  return {
    subscriptionStatus: 'active', activeSubscriptionStatus: 'active',
    currentPlanId: planId, subscriptionPlan: planId,
    currentSubscriptionId: 'order_' + planId + '_seed',
    subscriptionStartedAt: startedAt,
    subscriptionExpiresAt: expiresIn !== undefined
      ? Date.now() + expiresIn
      : addMonths(startedAt, PLANS[planId].periodMonths),
    subscriptionSource: 'payment'
  };
}

/**
 * What an account actually gets, asked the way the browser asks it.
 *
 *   paid          GET  /api/access
 *   search        POST /api/access           — running a model search
 *   results       GET  /api/device-parts?modelId   — the groups that fit, with devices
 *   group         GET  /api/device-parts?groupId   — opening one group
 */
async function experience(token) {
  const access = await invoke(accessRoute, { query: { section: 'access' }, token });
  const search = await invoke(accessRoute, { method: 'POST', query: { section: 'access' }, token, body: {} });
  const results = await invoke(accessRoute, { query: { section: 'device-parts', modelId: MODEL }, token });
  const group = await invoke(accessRoute, { query: { section: 'device-parts', groupId: GROUP }, token });

  const firstGroup = results.body.device.categories[0].groups[0];
  return {
    access: access.body,
    paid: access.body.paid === true,
    searchStatus: search.status,
    searchUnlimited: search.status === 200 && search.body.access.dailySearchLimit === null,
    resultsShowDevices: firstGroup.members.length,
    groupOpens: group.body.group.requiresPlan === false,
    groupDevices: group.body.group.members.length,
    serialised: JSON.stringify([results.body, group.body])
  };
}

function assertFullAccess(x, label) {
  assert.equal(x.paid, true, label + ': the account is paid');
  assert.equal(x.searchUnlimited, true, label + ': search runs, unmetered');
  assert.equal(x.resultsShowDevices, 4, label + ': results carry the devices');
  assert.equal(x.groupOpens, true, label + ': the group opens');
  assert.equal(x.groupDevices, 4, label + ': the group lists every device');
}

function assertBlocked(x, label) {
  assert.equal(x.paid, false, label + ': the account is not paid');
  assert.equal(x.searchUnlimited, false, label + ': search is not unlimited');
  assert.equal(x.resultsShowDevices, 0, label + ': results carry no devices');
  assert.equal(x.groupOpens, false, label + ': the group does not open');
  assert.equal(x.groupDevices, 0, label + ': no device is listed');
  /* Not hidden — absent. The names must not be in the payload at all. */
  assert.equal(x.serialised.includes('Ent Device'), false, label + ': a device name leaked');
}

const adminPost = (token, body) =>
  invoke(adminRoute, { method: 'POST', query: { section: 'subscription' }, token, body });
const adminGet = (token, uid) =>
  invoke(adminRoute, { method: 'GET', query: { section: 'subscription', uid }, token });

const auditFor = uid => fake.all('adminAuditLog')
  .filter(e => e.targetId === uid && String(e.action).startsWith('subscription.'))
  .sort((a, b) => a.at - b.at);

/* ===================================================================== plans */

test('₹99 is Monthly and ₹799 is Yearly, and nothing else is for sale', () => {
  assert.equal(PLANS.monthly.amountPaise, 9900);
  assert.equal(PLANS.monthly.billingPeriod, 'monthly');
  assert.equal(PLANS.monthly.periodMonths, 1);

  assert.equal(PLANS.yearly.amountPaise, 79900);
  assert.equal(PLANS.yearly.billingPeriod, 'yearly');
  assert.equal(PLANS.yearly.periodMonths, 12);

  assert.deepEqual(publicCatalogue().map(p => p.id), ['monthly', 'yearly']);
});

test('Lifetime is not purchasable: no price, no plan id a customer can order', () => {
  assert.equal(getPlan('lifetime'), null, 'the purchase path must not know the id');
  assert.equal(publicCatalogue().some(p => p.id === 'lifetime'), false,
    '/api/plans must not list it');
  assert.equal(Object.prototype.hasOwnProperty.call(PLANS, 'lifetime'), false);

  /* It IS offered to an administrator, marked as such and with no amount. */
  const lifetime = assignableCatalogue().find(p => p.id === 'lifetime');
  assert.ok(lifetime);
  assert.equal(lifetime.adminOnly, true);
  assert.equal(lifetime.amountPaise, null);
  assert.deepEqual(assignableCatalogue().map(p => p.label),
    ['₹99 — Monthly', '₹799 — Yearly', 'Lifetime — Admin Only']);
});

test('a customer who asks to buy Lifetime is told there is no such plan', async () => {
  const s = shop();
  const r = await invoke(createOrderRoute, { method: 'POST', token: s.token, body: { planId: 'lifetime' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'unknown plan');
  assert.equal(fake.all('subscriptions').filter(d => d.uid === s.uid).length, 0);
});

/* ============================================================== the resolver */

test('the resolver names the plan, its price, its period and where it came from', () => {
  const now = Date.now();

  const yearly = resolveEntitlement(paidPlan('yearly'), now);
  assert.deepEqual(
    { isActive: yearly.isActive, planType: yearly.planType, price: yearly.price,
      billingPeriod: yearly.billingPeriod, activationSource: yearly.activationSource,
      isLifetime: yearly.isLifetime },
    { isActive: true, planType: 'yearly', price: 799,
      billingPeriod: 'yearly', activationSource: 'payment', isLifetime: false });

  const monthly = resolveEntitlement(paidPlan('monthly'), now);
  assert.equal(monthly.price, 99);
  assert.equal(monthly.billingPeriod, 'monthly');
});

test('a plan written before the source was recorded is read as a payment', () => {
  /* Every subscription that existed before this change was a verified
     payment — there was no other way to get one. */
  const legacy = paidPlan('yearly');
  delete legacy.subscriptionSource;
  assert.equal(resolveEntitlement(legacy, Date.now()).activationSource, 'payment');
});

test('nothing a browser could write grants access on its own', () => {
  /* The fields that DO decide access are closed in firestore.rules. These are
     the new ones; none of them may be enough without those. */
  const now = Date.now();
  [
    { subscriptionLifetime: true },
    { subscriptionSource: 'admin_manual' },
    { subscriptionLifetime: true, subscriptionSource: 'admin_manual', subscriptionExpiresAt: now + 365 * DAY },
    { subscriptionExpiresAt: now + 365 * DAY }
  ].forEach(profile => {
    assert.equal(resolveEntitlement(profile, now).isActive, false, JSON.stringify(profile));
  });
});

/* ====================================================== 1–7: who gets what */

test('TEST 1 — active ₹99 Monthly: search, results, groups and group details all work', async () => {
  const s = shop(paidPlan('monthly'));
  const x = await experience(s.token);
  assertFullAccess(x, 'monthly');
  assert.equal(x.access.entitlement.planType, 'monthly');
  assert.equal(x.access.entitlement.price, 99);
});

test('TEST 2 — active ₹799 Yearly: search, results, groups and group details all work', async () => {
  const s = shop(paidPlan('yearly'));
  const x = await experience(s.token);
  assertFullAccess(x, 'yearly');
  assert.equal(x.access.entitlement.planType, 'yearly');
  assert.equal(x.access.entitlement.price, 799);
  assert.equal(x.access.entitlement.activationSource, 'payment');
});

test('TEST 3 — active Lifetime: everything works, and there is no expiry', async () => {
  const s = shop();
  await store.assignPlanManually({ uid: s.uid, planId: 'lifetime', admin: ADMIN, target: s, now: Date.now() });

  const x = await experience(s.token);
  assertFullAccess(x, 'lifetime');
  assert.equal(x.access.entitlement.isLifetime, true);
  assert.equal(x.access.entitlement.expiresAt, null);

  /* "Never" means never: the same record, fifty years on. */
  const later = resolveEntitlement(fake.read('users', s.uid), Date.now() + 50 * 365 * DAY);
  assert.equal(later.isActive, true);
  assert.equal(later.isLifetime, true);
});

test('TEST 4 — no subscription: groups are closed, and search is metered then refused', async () => {
  const s = shop();
  assertBlocked(await experience(s.token), 'no plan');

  /* experience() spent one of the three free searches. Two more run; the
     next is refused with the status the app turns into the Plans page. */
  const search = () => invoke(accessRoute, { method: 'POST', query: { section: 'access' }, token: s.token, body: {} });
  assert.equal((await search()).status, 200);
  assert.equal((await search()).status, 200);
  const refused = await search();
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, 'daily-search-limit');
  assert.equal(refused.body.access.paid, false);
});

test('a signed-out visitor cannot search at all, and sees no devices', async () => {
  const search = await invoke(accessRoute, { method: 'POST', query: { section: 'access' }, body: {} });
  assert.equal(search.status, 401);

  const group = await invoke(accessRoute, { query: { section: 'device-parts', groupId: GROUP } });
  assert.equal(group.body.group.requiresPlan, true);
  assert.equal(group.body.group.members.length, 0);
});

test('TEST 5 — expired ₹99: blocked', async () => {
  const s = shop(paidPlan('monthly', { startedAgo: 40 * DAY, expiresIn: -9 * DAY }));
  const x = await experience(s.token);
  assertBlocked(x, 'expired monthly');
  assert.equal(x.access.entitlement.state, 'expired');
});

test('TEST 6 — expired ₹799: blocked', async () => {
  const s = shop(paidPlan('yearly', { startedAgo: 400 * DAY, expiresIn: -35 * DAY }));
  const x = await experience(s.token);
  assertBlocked(x, 'expired yearly');
  assert.equal(x.access.entitlement.state, 'expired');
});

test('TEST 7 — revoked Lifetime: blocked', async () => {
  const s = shop();
  await store.assignPlanManually({ uid: s.uid, planId: 'lifetime', admin: ADMIN, target: s, now: Date.now() });
  assertFullAccess(await experience(s.token), 'before the revoke');

  await store.revokeSubscription({ uid: s.uid, admin: ADMIN, target: s, reason: 'test', now: Date.now() });

  const x = await experience(s.token);
  assertBlocked(x, 'revoked lifetime');
  assert.equal(x.access.entitlement.state, 'revoked');
  assert.equal(x.access.entitlement.isLifetime, false);
});

test('cancelled but still inside the paid period keeps access — those days were paid for', async () => {
  const s = shop({ ...paidPlan('monthly'), activeSubscriptionStatus: 'cancelled' });
  assertFullAccess(await experience(s.token), 'cancelling');
});

/* ================================================== the token that is not good */

test('a token the server cannot verify is a 401, never "this account is free"', async () => {
  /* The other way a subscriber was shown a paywall: the request carried a
     token, verification failed, and the reply was a 200 describing a
     signed-out visitor. Refused instead, so the browser refreshes and retries. */
  const bad = 'tok-nobody-issued-this';

  const access = await invoke(accessRoute, { query: { section: 'access' }, token: bad });
  assert.equal(access.status, 401);
  assert.equal(access.body.paid, undefined);
  assert.equal(access.body.retry, 'refresh-token');

  const group = await invoke(accessRoute, { query: { section: 'device-parts', groupId: GROUP }, token: bad });
  assert.equal(group.status, 401);
  assert.equal(group.body.group, undefined, 'no free slice is sent in place of an answer');

  const search = await invoke(accessRoute, { method: 'POST', query: { section: 'access' }, token: bad, body: {} });
  assert.equal(search.status, 401);
});

test('no token at all is still the signed-out free view', async () => {
  const access = await invoke(accessRoute, { query: { section: 'access' } });
  assert.equal(access.status, 200);
  assert.equal(access.body.signedIn, false);
  assert.equal(access.body.paid, false);
});

/* ============================================ 16: a real ₹799 payment, verified */

test('TEST 16 — a verified ₹799 payment activates Yearly, and the shop can use what it bought', async () => {
  const s = shop();
  const now = Date.now();
  const plan = getPlan('yearly');

  /* What /api/create-order records, then what the webhook does when Razorpay
     reports the payment captured. */
  await store.recordPendingOrder({
    orderId: 'order_T16', uid: s.uid, email: s.email, displayName: 'Shop',
    plan, amountPaise: plan.amountPaise, currency: 'INR', now: now - 60000
  });
  const result = await store.activateSubscription({
    uid: s.uid, email: s.email, displayName: 'Shop', plan,
    orderId: 'order_T16', paymentId: 'pay_T16', amountPaise: 79900, currency: 'INR',
    now, source: 'webhook', signatureVerified: true
  });

  assert.equal(result.alreadyProcessed, false);
  assert.equal(result.planId, 'yearly');
  assert.equal(result.expiresAt, addMonths(now, 12), 'twelve calendar months from the payment');

  const ent = resolveEntitlement(fake.read('users', s.uid), Date.now());
  assert.deepEqual(
    { isActive: ent.isActive, state: ent.state, planType: ent.planType, price: ent.price,
      billingPeriod: ent.billingPeriod, activationSource: ent.activationSource,
      startedAt: ent.startedAt, expiresAt: ent.expiresAt, isLifetime: ent.isLifetime },
    { isActive: true, state: 'active', planType: 'yearly', price: 799,
      billingPeriod: 'yearly', activationSource: 'payment',
      startedAt: now, expiresAt: addMonths(now, 12), isLifetime: false });

  /* The payment is on record, once, as a payment. */
  const payment = fake.read('payments', 'pay_T16');
  assert.equal(payment.status, 'captured');
  assert.equal(payment.amount, 79900);
  assert.equal(payment.uid, s.uid, 'tied to the Firebase uid, not to an email');
  assert.equal(payment.activationSource, 'payment');

  /* And the shop is not asked to pay again. */
  assertFullAccess(await experience(s.token), 'after the ₹799 payment');

  /* The account screen's own endpoint agrees with the paywall. */
  const status = await invoke(subscriptionRoute, { token: s.token });
  assert.equal(status.body.access.state, 'active');
  assert.equal(status.body.access.isActive, true);
  assert.equal(status.body.access.plan, 'yearly');
  assert.equal(status.body.access.source, 'payment');
});

test('the same payment arriving twice — webhook, then the browser — buys one year, not two', async () => {
  const s = shop();
  const now = Date.now();
  const plan = getPlan('yearly');
  const args = {
    uid: s.uid, email: s.email, plan, orderId: 'order_dup', paymentId: 'pay_dup',
    amountPaise: 79900, currency: 'INR', signatureVerified: true
  };

  const first = await store.activateSubscription({ ...args, now, source: 'webhook' });
  const second = await store.activateSubscription({ ...args, now: now + 4000, source: 'checkout' });

  assert.equal(first.alreadyProcessed, false);
  assert.equal(second.alreadyProcessed, true);
  assert.equal(second.expiresAt, first.expiresAt);
  assert.equal(fake.read('users', s.uid).subscriptionExpiresAt, addMonths(now, 12));
  assert.equal(fake.all('payments').filter(p => p.uid === s.uid).length, 1);
});

test('a ₹99 payment is one month and is never turned into a year', async () => {
  const s = shop();
  const now = Date.now();
  await store.activateSubscription({
    uid: s.uid, email: s.email, plan: getPlan('monthly'), orderId: 'order_m1', paymentId: 'pay_m1',
    amountPaise: 9900, currency: 'INR', now, source: 'webhook', signatureVerified: true
  });
  const ent = resolveEntitlement(fake.read('users', s.uid), now);
  assert.equal(ent.planType, 'monthly');
  assert.equal(ent.price, 99);
  assert.equal(ent.expiresAt, addMonths(now, 1));
});

/* ============================================= 8–10: an administrator assigns */

test('TEST 8 — admin assigns ₹99 Monthly: access is immediate, and no payment is invented', async () => {
  const s = shop();
  assertBlocked(await experience(s.token), 'before');

  const r = await adminPost(OWNER, { action: 'assign', uid: s.uid, planId: 'monthly', reason: 'support' });
  assert.equal(r.status, 200);
  assert.equal(r.body.action, 'ASSIGN_MONTHLY');
  assert.equal(r.body.paymentRecorded, false);

  const ent = r.body.entitlement;
  assert.equal(ent.isActive, true);
  assert.equal(ent.planType, 'monthly');
  assert.equal(ent.price, 99);
  assert.equal(ent.billingPeriod, 'monthly');
  assert.equal(ent.activationSource, 'admin_manual');
  assert.equal(ent.expiresAt, addMonths(ent.startedAt, 1));

  /* The very next request from the customer is a subscriber's. */
  assertFullAccess(await experience(s.token), 'after the assignment');

  assert.equal(fake.all('payments').filter(p => p.uid === s.uid).length, 0,
    'a manual assignment must not create a payment');

  const record = fake.read('subscriptions', r.body.subscriptionId);
  assert.equal(record.activationSource, 'admin_manual');
  assert.equal(record.paymentStatus, 'not_applicable');
  assert.equal(record.amount, null);
  assert.equal(record.razorpayPaymentId, null);
});

test('TEST 9 — admin assigns ₹799 Yearly: access is immediate, twelve months, marked manual', async () => {
  const s = shop();
  const r = await adminPost(OWNER, {
    action: 'assign', uid: s.uid, planId: 'yearly',
    reason: 'paid by bank transfer', reference: 'UTR-CHECKED-BY-HAND'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.action, 'ASSIGN_YEARLY');

  const ent = r.body.entitlement;
  assert.equal(ent.planType, 'yearly');
  assert.equal(ent.price, 799);
  assert.equal(ent.activationSource, 'admin_manual', 'never reported as a payment');
  assert.equal(ent.expiresAt, addMonths(ent.startedAt, 12));

  assertFullAccess(await experience(s.token), 'after the assignment');
  assert.equal(fake.all('payments').filter(p => p.uid === s.uid).length, 0);

  /* What the administrator checked is kept as THEIR note. */
  const record = fake.read('subscriptions', r.body.subscriptionId);
  assert.equal(record.reference, 'UTR-CHECKED-BY-HAND');
  assert.equal(record.assignedBy, ADMIN.uid);
});

test('TEST 10 — admin assigns Lifetime: access is immediate and the expiry is "never"', async () => {
  const s = shop();
  const r = await adminPost(OWNER, { action: 'assign', uid: s.uid, planId: 'lifetime' });
  assert.equal(r.status, 200);
  assert.equal(r.body.action, 'ACTIVATE_LIFETIME');
  assert.equal(r.body.paymentRecorded, false);

  const ent = r.body.entitlement;
  assert.deepEqual(
    { planType: ent.planType, isActive: ent.isActive, isLifetime: ent.isLifetime,
      expiresAt: ent.expiresAt, activationSource: ent.activationSource, price: ent.price },
    { planType: 'lifetime', isActive: true, isLifetime: true,
      expiresAt: null, activationSource: 'admin_manual', price: null });

  assertFullAccess(await experience(s.token), 'lifetime');

  const profile = fake.read('users', s.uid);
  assert.equal(profile.subscriptionExpiresAt, null);
  assert.equal(profile.subscriptionLifetime, true);

  const record = fake.read('subscriptions', r.body.subscriptionId);
  assert.equal(record.paymentStatus, 'not_applicable');
  assert.equal(record.amount, null);
  assert.equal(record.expiresAt, null);
  assert.equal(fake.all('payments').filter(p => p.uid === s.uid).length, 0);

  /* The audit entry says "never", not a date. */
  const [entry] = auditFor(s.uid);
  assert.equal(entry.action, 'subscription.activate_lifetime');
  assert.equal(entry.detail.newExpiresAt, 'never');

  /* And the account screen's endpoint can say so too. */
  const status = await invoke(subscriptionRoute, { token: s.token });
  assert.equal(status.body.access.isLifetime, true);
  assert.equal(status.body.access.isActive, true);
  assert.equal(status.body.access.expiresAt, null);
});

/* ======================================== 12: a customer calling the admin API */

test('TEST 12 — a normal user calling the admin subscription API is refused, and nothing is written', async () => {
  const attacker = shop();
  const victim = shop();
  const before = JSON.stringify([fake.read('users', attacker.uid), fake.read('users', victim.uid)]);
  const auditBefore = fake.all('adminAuditLog').length;

  /* Granting themselves Lifetime, then a paid plan, then revoking someone
     else — the three things worth trying. */
  for (const body of [
    { action: 'assign', uid: attacker.uid, planId: 'lifetime' },
    { action: 'assign', uid: attacker.uid, planId: 'yearly' },
    { action: 'assign', uid: attacker.uid, planId: 'monthly', mode: 'extend' },
    { action: 'revoke', uid: victim.uid }
  ]) {
    const r = await adminPost(attacker.token, body);
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(r.body.entitlement, undefined);
  }

  /* Reading somebody's entitlement through the admin API is refused as well. */
  assert.equal((await adminGet(attacker.token, victim.uid)).status, 403);

  assert.equal(JSON.stringify([fake.read('users', attacker.uid), fake.read('users', victim.uid)]), before);
  assert.equal(fake.all('adminAuditLog').length, auditBefore);
  assertBlocked(await experience(attacker.token), 'the attacker');
});

test('with no token, or a token nobody issued, the admin API answers 401', async () => {
  const s = shop();
  assert.equal((await adminPost(undefined, { action: 'assign', uid: s.uid, planId: 'lifetime' })).status, 401);
  assert.equal((await adminPost('tok-forged', { action: 'assign', uid: s.uid, planId: 'lifetime' })).status, 401);
  assert.equal(resolveEntitlement(fake.read('users', s.uid), Date.now()).isActive, false);
});

test('an account that looks like the owner but has not verified the address is not the owner', async () => {
  const s = shop();
  const lookalike = fake.account({
    uid: 'uid-lookalike', email: OWNER_EMAIL, name: 'Not The Owner', emailVerified: false
  });
  const r = await adminPost(lookalike, { action: 'assign', uid: s.uid, planId: 'lifetime' });
  assert.equal(r.status, 403);
  assert.equal(resolveEntitlement(fake.read('users', s.uid), Date.now()).isActive, false);
});

test('TEST 11 (the table) — no staff role below admin may change a subscription', () => {
  /* The route-level half, with the registry switched on, is in
     subscription-staff.test.js. This is the rule it enforces. */
  assert.equal(can(ROLES.SUPER_ADMIN, PERMISSIONS.SUBSCRIPTIONS_WRITE), true);
  assert.equal(can(ROLES.ADMIN, PERMISSIONS.SUBSCRIPTIONS_WRITE), true);
  assert.equal(can(ROLES.SUPPORT, PERMISSIONS.SUBSCRIPTIONS_WRITE), false);
  assert.equal(can(ROLES.ANALYST, PERMISSIONS.SUBSCRIPTIONS_WRITE), false);
  assert.equal(can(ROLES.USER, PERMISSIONS.SUBSCRIPTIONS_WRITE), false);
  /* Support can still READ a subscription, to answer a customer. */
  assert.equal(can(ROLES.SUPPORT, PERMISSIONS.BILLING_READ), true);
});

test('the admin API refuses a request it cannot make sense of', async () => {
  const s = shop();
  assert.equal((await adminPost(OWNER, { action: 'gift', uid: s.uid, planId: 'yearly' })).status, 400);
  assert.equal((await adminPost(OWNER, { action: 'assign', uid: s.uid, planId: 'platinum' })).status, 400);
  assert.equal((await adminPost(OWNER, { action: 'assign', uid: '../users/x', planId: 'yearly' })).status, 400);
  /* A uid that is well formed and belongs to nobody. */
  assert.equal((await adminPost(OWNER, { action: 'assign', uid: 'uid-does-not-exist', planId: 'yearly' })).status, 404);
  assert.equal(auditFor(s.uid).length, 0);
});

/* ================================================ 13–15: change, upgrade, revoke */

test('TEST 13 — admin changes ₹99 → ₹799: the entitlement moves and the history says so', async () => {
  const s = shop();
  const first = await adminPost(OWNER, { action: 'assign', uid: s.uid, planId: 'monthly' });
  const second = await adminPost(OWNER, { action: 'assign', uid: s.uid, planId: 'yearly', reason: 'upgrade' });

  assert.equal(second.body.action, 'CHANGE_PLAN');
  assert.equal(second.body.previous.planType, 'monthly');
  assert.equal(second.body.entitlement.planType, 'yearly');
  assert.equal(second.body.entitlement.price, 799);
  assert.equal(second.body.entitlement.expiresAt, addMonths(second.body.entitlement.startedAt, 12));

  /* One entitlement, not two overlapping ones: the profile points at the new
     record, and the old record is kept and marked as replaced. */
  const profile = fake.read('users', s.uid);
  assert.equal(profile.currentSubscriptionId, second.body.subscriptionId);
  const old = fake.read('subscriptions', first.body.subscriptionId);
  assert.equal(old.planId, 'monthly', 'the earlier record is preserved');
  assert.equal(old.supersededBy, second.body.subscriptionId);

  const log = auditFor(s.uid);
  assert.deepEqual(log.map(e => e.detail.actionType), ['ASSIGN_MONTHLY', 'CHANGE_PLAN']);
  const change = log[1];
  assert.equal(change.action, 'subscription.change_plan');
  assert.equal(change.actorUid, ADMIN.uid);
  assert.equal(change.targetId, s.uid);
  assert.deepEqual(
    { targetEmail: change.detail.targetEmail, adminEmail: change.detail.adminEmail,
      previousPlan: change.detail.previousPlan, newPlan: change.detail.newPlan,
      previousStatus: change.detail.previousStatus, newStatus: change.detail.newStatus,
      activationSource: change.detail.activationSource, reason: change.detail.reason },
    { targetEmail: s.email, adminEmail: OWNER_EMAIL,
      previousPlan: 'monthly', newPlan: 'yearly',
      previousStatus: 'active', newStatus: 'active',
      activationSource: 'admin_manual', reason: 'upgrade' });
  assert.equal(change.detail.previousExpiresAt, first.body.entitlement.expiresAt);
  assert.equal(change.detail.newExpiresAt, second.body.entitlement.expiresAt);
  assert.equal(typeof change.at, 'number');

  assertFullAccess(await experience(s.token), 'after the change');
});

test('TEST 14 — admin changes a PAID ₹799 → Lifetime: Lifetime is on, no payment is created, history kept', async () => {
  const s = shop();
  const now = Date.now();
  await store.activateSubscription({
    uid: s.uid, email: s.email, plan: getPlan('yearly'), orderId: 'order_T14', paymentId: 'pay_T14',
    amountPaise: 79900, currency: 'INR', now, source: 'webhook', signatureVerified: true
  });
  const paymentsBefore = fake.all('payments').filter(p => p.uid === s.uid);
  assert.equal(paymentsBefore.length, 1);

  const r = await adminPost(OWNER, { action: 'assign', uid: s.uid, planId: 'lifetime', reason: 'partner' });
  assert.equal(r.status, 200);
  assert.equal(r.body.action, 'ACTIVATE_LIFETIME');
  assert.equal(r.body.previous.planType, 'yearly');
  assert.equal(r.body.previous.activationSource, 'payment');
  assert.equal(r.body.entitlement.isLifetime, true);
  assert.equal(r.body.entitlement.expiresAt, null);

  /* Exactly the payment that was really made, untouched. */
  const paymentsAfter = fake.all('payments').filter(p => p.uid === s.uid);
  assert.deepEqual(paymentsAfter, paymentsBefore);

  /* The paid order is still a paid order. */
  const order = fake.read('subscriptions', 'order_T14');
  assert.equal(order.paymentStatus, 'captured');
  assert.equal(order.status, 'active');
  assert.equal(order.supersededBy, r.body.subscriptionId);

  const [entry] = auditFor(s.uid);
  assert.equal(entry.detail.actionType, 'ACTIVATE_LIFETIME');
  assert.equal(entry.detail.previousPlan, 'yearly');
  assert.equal(entry.detail.newPlan, 'lifetime');
  assert.equal(entry.detail.newExpiresAt, 'never');

  assertFullAccess(await experience(s.token), 'lifetime after yearly');
});

test('TEST 15 — admin revokes access: the next request is blocked', async () => {
  const s = shop();
  await adminPost(OWNER, { action: 'assign', uid: s.uid, planId: 'yearly' });
  assertFullAccess(await experience(s.token), 'before');

  const r = await adminPost(OWNER, { action: 'revoke', uid: s.uid, reason: 'chargeback' });
  assert.equal(r.status, 200);
  assert.equal(r.body.action, 'REVOKE_SUBSCRIPTION');
  assert.equal(r.body.entitlement.isActive, false);
  assert.equal(r.body.entitlement.state, 'revoked');

  /* No sign-out, no token refresh, no waiting: the same token, refused. */
  assertBlocked(await experience(s.token), 'after the revoke');

  const status = await invoke(subscriptionRoute, { token: s.token });
  assert.equal(status.body.access.isActive, false);
  assert.equal(status.body.access.state, 'revoked');

  const log = auditFor(s.uid);
  assert.equal(log[log.length - 1].action, 'subscription.revoke');
  assert.equal(log[log.length - 1].detail.previousStatus, 'active');
  assert.equal(log[log.length - 1].detail.newStatus, 'revoked');
  assert.equal(log[log.length - 1].detail.reason, 'chargeback');

  /* Nothing is deleted: the record survives, marked. */
  const record = fake.read('subscriptions', fake.read('users', s.uid).currentSubscriptionId);
  assert.equal(record.status, 'revoked');
  assert.equal(record.planId, 'yearly');
});

test('revoking twice is one revocation, logged once', async () => {
  const s = shop();
  await adminPost(OWNER, { action: 'assign', uid: s.uid, planId: 'monthly' });
  await adminPost(OWNER, { action: 'revoke', uid: s.uid });
  const again = await adminPost(OWNER, { action: 'revoke', uid: s.uid });

  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyRevoked, true);
  assert.equal(auditFor(s.uid).filter(e => e.action === 'subscription.revoke').length, 1);
});

test('there is nothing to revoke on an account that has no plan', async () => {
  const s = shop();
  const r = await adminPost(OWNER, { action: 'revoke', uid: s.uid });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'nothing-to-revoke');
  assert.equal(auditFor(s.uid).length, 0);
});

/* ============================================================ the transitions */

test('every plan transition leaves one coherent entitlement', async () => {
  const assign = (uid, planId, extra) => adminPost(OWNER, { action: 'assign', uid, planId, ...extra });

  /* none → monthly, none → yearly: covered by tests 8 and 9. */

  /* yearly → monthly */
  let s = shop();
  await assign(s.uid, 'yearly');
  let r = await assign(s.uid, 'monthly');
  assert.equal(r.body.action, 'CHANGE_PLAN');
  assert.equal(r.body.entitlement.planType, 'monthly');
  assert.equal(r.body.entitlement.expiresAt, addMonths(r.body.entitlement.startedAt, 1));

  /* monthly → lifetime */
  s = shop();
  await assign(s.uid, 'monthly');
  r = await assign(s.uid, 'lifetime');
  assert.equal(r.body.entitlement.isLifetime, true);
  assert.equal(fake.read('users', s.uid).subscriptionExpiresAt, null, 'the old expiry is gone');

  /* lifetime → monthly: an administrator may take Lifetime down to a term. */
  r = await assign(s.uid, 'monthly');
  assert.equal(r.body.action, 'CHANGE_PLAN');
  assert.equal(r.body.entitlement.isLifetime, false);
  assert.equal(r.body.entitlement.expiresAt, addMonths(r.body.entitlement.startedAt, 1));
  assert.equal(fake.read('users', s.uid).subscriptionLifetime, false);

  /* expired → new plan: a fresh period from today, not from the old expiry. */
  s = shop(paidPlan('monthly', { startedAgo: 60 * DAY, expiresIn: -29 * DAY }));
  r = await assign(s.uid, 'yearly');
  assert.equal(r.body.action, 'ASSIGN_YEARLY');
  assert.equal(r.body.previous.state, 'expired');
  assert.equal(r.body.entitlement.expiresAt, addMonths(r.body.entitlement.startedAt, 12));
  assert.ok(r.body.entitlement.startedAt > Date.now() - 5000);
  assertFullAccess(await experience(s.token), 'expired → yearly');

  /* revoked → assigned again */
  s = shop();
  await assign(s.uid, 'lifetime');
  await adminPost(OWNER, { action: 'revoke', uid: s.uid });
  r = await assign(s.uid, 'lifetime');
  assert.equal(r.body.entitlement.isActive, true);
  assert.equal(fake.read('users', s.uid).subscriptionRevokedAt, null);
});

test('extending adds a period to the end of the one running, and is refused when it cannot', async () => {
  const s = shop();
  const first = await adminPost(OWNER, { action: 'assign', uid: s.uid, planId: 'monthly' });

  const extended = await adminPost(OWNER, { action: 'assign', uid: s.uid, planId: 'monthly', mode: 'extend' });
  assert.equal(extended.body.action, 'EXTEND_PLAN');
  assert.equal(extended.body.entitlement.expiresAt, addMonths(first.body.entitlement.expiresAt, 1));
  assert.equal(extended.body.entitlement.startedAt, first.body.entitlement.startedAt);

  /* A different plan cannot be "extended" — that would silently be a change. */
  const wrong = await adminPost(OWNER, { action: 'assign', uid: s.uid, planId: 'yearly', mode: 'extend' });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.error, 'cannot-extend');
  assert.equal(fake.read('users', s.uid).currentPlanId, 'monthly', 'nothing changed');

  /* Nor can an account with nothing running. */
  const none = shop();
  const r = await adminPost(OWNER, { action: 'assign', uid: none.uid, planId: 'monthly', mode: 'extend' });
  assert.equal(r.status, 409);
  assert.equal(resolveEntitlement(fake.read('users', none.uid), Date.now()).isActive, false);
});

test('a customer renewing early keeps the days already paid for', async () => {
  const s = shop();
  const now = Date.now();
  const pay = (paymentId, at) => store.activateSubscription({
    uid: s.uid, email: s.email, plan: getPlan('monthly'), orderId: 'order_' + paymentId, paymentId,
    amountPaise: 9900, currency: 'INR', now: at, source: 'webhook', signatureVerified: true
  });
  const first = await pay('pay_r1', now);
  const second = await pay('pay_r2', now + 10 * DAY);
  assert.equal(second.expiresAt, addMonths(first.expiresAt, 1));
});

test('paying after a revoke starts a fresh period — the withdrawn days do not come back', async () => {
  const s = shop();
  const assigned = await adminPost(OWNER, { action: 'assign', uid: s.uid, planId: 'yearly' });
  await adminPost(OWNER, { action: 'revoke', uid: s.uid });

  const now = Date.now();
  const r = await store.activateSubscription({
    uid: s.uid, email: s.email, plan: getPlan('monthly'), orderId: 'order_after', paymentId: 'pay_after',
    amountPaise: 9900, currency: 'INR', now, source: 'webhook', signatureVerified: true
  });
  assert.equal(r.expiresAt, addMonths(now, 1));
  assert.ok(r.expiresAt < assigned.body.entitlement.expiresAt, 'not stacked on the revoked year');

  const ent = resolveEntitlement(fake.read('users', s.uid), now);
  assert.equal(ent.isActive, true);
  assert.equal(ent.activationSource, 'payment');
});

/* ================================================ Lifetime and the purchase path */

test('an account with Lifetime cannot be charged for a plan', async () => {
  const s = shop();
  await adminPost(OWNER, { action: 'assign', uid: s.uid, planId: 'lifetime' });

  const r = await invoke(createOrderRoute, { method: 'POST', token: s.token, body: { planId: 'monthly' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'already-lifetime');
  assert.equal(fake.all('subscriptions').filter(d => d.uid === s.uid && d.status === 'pending').length, 0);
});

test('a payment that lands on a Lifetime account is recorded and does not downgrade it', async () => {
  const s = shop();
  await adminPost(OWNER, { action: 'assign', uid: s.uid, planId: 'lifetime' });

  const r = await store.activateSubscription({
    uid: s.uid, email: s.email, plan: getPlan('monthly'), orderId: 'order_late', paymentId: 'pay_late',
    amountPaise: 9900, currency: 'INR', now: Date.now(), source: 'webhook', signatureVerified: true
  });
  assert.equal(r.entitlementApplied, false);

  const ent = resolveEntitlement(fake.read('users', s.uid), Date.now());
  assert.equal(ent.isLifetime, true, 'still Lifetime');
  assert.equal(ent.expiresAt, null);

  /* The money is on record so it can be refunded. */
  const payment = fake.read('payments', 'pay_late');
  assert.equal(payment.status, 'captured');
  assert.equal(payment.entitlementApplied, false);
});

test('Lifetime has no renewal to cancel', async () => {
  const s = shop();
  await adminPost(OWNER, { action: 'assign', uid: s.uid, planId: 'lifetime' });

  const r = await invoke(cancelRoute, { method: 'POST', token: s.token });
  assert.equal(r.status, 400);
  assert.equal(resolveEntitlement(fake.read('users', s.uid), Date.now()).isActive, true);
});

/* ===================================================== the admin read endpoint */

test('the admin read shows the entitlement, the plans on offer and the history', async () => {
  const s = shop();
  await adminPost(OWNER, { action: 'assign', uid: s.uid, planId: 'monthly', reason: 'first' });
  /* Two actions by a person are never in the same millisecond; two in a test
     can be, and the log is ordered by its timestamp. */
  await new Promise(resolve => setTimeout(resolve, 5));
  await adminPost(OWNER, { action: 'assign', uid: s.uid, planId: 'yearly', reason: 'second' });

  const r = await adminGet(OWNER, s.uid);
  assert.equal(r.status, 200);
  assert.equal(r.body.canWrite, true);
  assert.equal(r.body.entitlement.planType, 'yearly');
  assert.deepEqual(r.body.plans.map(p => p.label),
    ['₹99 — Monthly', '₹799 — Yearly', 'Lifetime — Admin Only']);
  assert.deepEqual(r.body.history.map(h => h.detail.actionType), ['CHANGE_PLAN', 'ASSIGN_MONTHLY'],
    'newest first');
});

test('an account with no profile document can still be given a plan, and stays listable', async () => {
  /* Signed in once and closed the tab before the profile was written. */
  const uid = 'uid-no-profile-01';
  const token = fake.account({ uid, email: 'noprofile@example.com', name: 'No Profile' });

  const r = await adminPost(OWNER, { action: 'assign', uid, planId: 'yearly' });
  assert.equal(r.status, 200);

  const profile = fake.read('users', uid);
  assert.equal(profile.email, 'noprofile@example.com');
  assert.equal(typeof profile.createdAt, 'number', 'the admin table sorts by this');
  assert.equal((await invoke(accessRoute, { query: { section: 'access' }, token })).body.paid, true);
});

/* =============================================================== no bypasses */

test('no customer is hard-coded anywhere in the code', () => {
  /* A subscriber must have access because the flow works, never because the
     account is named. So nothing that runs may carry a customer's identity:
     not a mailbox, and not a payment reference.

     Searched for by SHAPE. This repository is public, and a test that spelled
     out the account it was written after would publish that shop's address
     and its bank reference in the act of forbidding them.

       · a personal mailbox that is not the owner's — the one address the code
         legitimately knows, because it decides who the administrator is
       · anything shaped like a UPI app's transaction id

     Test files are skipped: they hold made-up shops at example.com and the
     owner's address in a dozen deliberate misspellings. */
  const ROOT = path.join(__dirname, '..', '..');
  const roots = ['api', 'src', 'scripts', 'admin', 'plans', 'finder'].map(d => path.join(ROOT, d));
  const owner = OWNER_EMAIL.toLowerCase();
  const MAILBOX = /[a-z0-9._%+-]+@(?:gmail|googlemail|yahoo|outlook|hotmail|icloud|rediffmail|proton(?:mail)?)\.[a-z]+(?:\.[a-z]+)?/gi;
  const UPI_TRANSACTION = /\bT\d{18,}\b/;
  const hits = [];

  function check(full) {
    const text = fs.readFileSync(full, 'utf8');
    (text.match(MAILBOX) || []).forEach(address => {
      if (address.toLowerCase() !== owner) hits.push(path.relative(ROOT, full) + ': a mailbox');
    });
    if (UPI_TRANSACTION.test(text)) hits.push(path.relative(ROOT, full) + ': a transaction id');
  }
  function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '_data') walk(full);
        return;
      }
      if (/\.test\.js$/.test(entry.name)) return;
      if (/\.(js|html|json|css)$/.test(entry.name)) check(full);
    });
  }
  assert.ok(roots.every(fs.existsSync), 'the directories being searched exist');
  roots.forEach(walk);
  ['firestore.rules', 'vercel.json', 'sw.js'].forEach(f => check(path.join(ROOT, f)));

  assert.deepEqual(hits, []);
});

test('the paywall is not decided by an email address anywhere', () => {
  /* The entitlement is keyed on the Firebase uid. An email compare in any of
     these files would be a bypass waiting for the right address. */
  ['../access.js', '../_services/entitlement-service.js', '../_schema/entitlement.js']
    .forEach(file => {
      const text = fs.readFileSync(path.join(__dirname, file), 'utf8');
      assert.equal(/@gmail\.com|\.email\s*===|email\s*==\s*['"]/.test(text), false, file);
    });
});
