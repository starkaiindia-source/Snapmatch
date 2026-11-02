/* ============================================================================
   api/_lib/shop-settings.test.js
   ----------------------------------------------------------------------------
   Quick Billing's Settings, through the real route and the real service: the
   store's details, staff working in another person's shop, and UPI by the shop's
   own Razorpay.

   Razorpay itself is a stubbed fetch here. These tests prove what this code does
   with Razorpay's answers, not that Razorpay answers this way.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { create, invoke } = require('./testing/fake-firebase');
const periods = require('../../src/data/shop-periods');

const API = path.join(__dirname, '..', 'shop.js');
const HOOK = path.join(__dirname, '..', 'razorpay-webhook.js');
const OWN = ['shop.js', 'razorpay-webhook.js', '_services/shop-service.js', '_services/shop-settings.js', '_services/entitlement-service.js']
  .map(f => path.join(__dirname, '..', f));

const KEY_SECRET = 'not-a-real-razorpay-key-secret';
const HOOK_SECRET = 'not-a-real-webhook-secret';
const KEY_ID = 'rzp_test_AbCdEf123456';
const OWNER = 'shopAAAAAA';

let seq = 0;
const cid = p => (p || 'id') + '_' + String(++seq).padStart(10, '0') + 'abcdef';
const ok = (r, label) => { assert.equal(r.status, 200, (label || '') + ' ' + JSON.stringify(r.body)); return r.body; };
const refused = (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.body)); assert.equal(r.body.error, code); };

function world() {
  process.env.SHOP_SECRETS_KEY = 'k'.repeat(44);
  const fb = create();
  fb.install();
  OWN.forEach(f => { delete require.cache[require.resolve(f)]; });
  const handler = require(API);
  const tokA = fb.account({ uid: OWNER, email: 'owner@example.test', name: 'Owner One' });
  const tokS = fb.account({ uid: 'staffSSSSS', email: 'Ravi@Example.test', name: 'Ravi Google' });
  const tokU = fb.account({ uid: 'unverifiedU', email: 'late@example.test', name: 'Late', emailVerified: false });
  const tokB = fb.account({ uid: 'shopBBBBBB', email: 'b@example.test', name: 'Shop B' });
  const call = (token, section, method, body, query) =>
    invoke(handler, { method, url: '/api/shop/' + section, query: Object.assign({ section }, query || {}), token, body });
  return {
    fb, fs: fb.firestore, tokA, tokS, tokU, tokB,
    post: (token, section, body) => call(token, section, 'POST', body),
    get: (token, section, query) => call(token, section, 'GET', null, query)
  };
}

async function withProduct(w) {
  const st = ok(await w.get(w.tokA, 'state'));
  const cat = st.categories.find(c => c.name === 'Tempered Glass');
  return ok(await w.post(w.tokA, 'product', {
    action: 'create', productId: cid('p'), name: 'Glass', pricePaise: 29900, qty: 20, categoryId: cat.id
  })).product;
}
const billBody = (product, extra) => Object.assign({
  action: 'finalise', finalisationId: cid('f'), lines: [{ productId: product.id, qty: 1, unitPaise: 29900 }],
  payment: { method: 'cash', status: 'paid' }
}, extra);

async function addRavi(w) {
  const added = ok(await w.post(w.tokA, 'settings', { action: 'staff-add', name: 'Ravi', email: ' RAVI@example.test ' }), 'add staff');
  ok(await w.post(w.tokS, 'settings', { action: 'staff-join', accept: true }), 'join');
  return added;
}

/** Razorpay, as far as these tests need it. */
function razorpay(replies) {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    const r = replies(String(url), init.method) || { status: 200, body: { items: [] } };
    return { status: r.status || 200, json: async () => r.body };
  };
  return { calls, restore() { global.fetch = real; } };
}
const qrReply = (extra) => (url, method) => {
  if (method === 'POST' && /qr_codes$/.test(url)) return { body: { id: 'qr_TestAbc123', image_url: 'https://rzp.io/i/test' } };
  if (method === 'GET' && /qr_codes\/qr_TestAbc123\/payments/.test(url)) return { body: { items: [{ id: 'pay_Test1' }] } };
  if (method === 'GET' && /qr_codes\/qr_TestAbc123$/.test(url)) return { body: Object.assign({ status: 'active', payments_amount_received: 0 }, extra) };
  return null;
};
async function connect(w, webhookSecret) {
  return ok(await w.post(w.tokA, 'settings', { action: 'razorpay', keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: webhookSecret || '' }), 'connect');
}

/* ---------------------------------------------------------- sealed secrets */
test('a sealed secret opens, and a changed or unkeyed blob does not', () => {
  const secrets = require('./shop-secrets');
  process.env.SHOP_SECRETS_KEY = 'k'.repeat(44);
  const blob = secrets.seal(KEY_SECRET);
  assert.ok(!blob.includes(KEY_SECRET));
  assert.notEqual(blob, secrets.seal(KEY_SECRET), 'each seal has its own IV');
  assert.equal(secrets.unseal(blob), KEY_SECRET);

  const parts = blob.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.equal(secrets.unseal(parts.join('.')), null);
  assert.equal(secrets.unseal('nonsense'), null);

  process.env.SHOP_SECRETS_KEY = 'z'.repeat(44);
  assert.equal(secrets.unseal(blob), null, 'another key cannot open it');
  delete process.env.SHOP_SECRETS_KEY;
  assert.equal(secrets.available(), false);
  assert.throws(() => secrets.seal('x'));
});

/* ------------------------------------------------------------------- store */
test('the store starts from the profile, and the shop can change it for its bills', async () => {
  const w = world();
  const product = await withProduct(w);
  w.fs.seed('users/' + OWNER, {
    mobileShopName: 'Profile Mobiles', mobileNumber: '9876543210', gstin: '33ABCDE1234F1Z5',
    address: { flat: '12', area: 'Anna Salai', city: 'Chennai', state: 'Tamil Nadu' }
  });
  const first = ok(await w.get(w.tokA, 'settings')).store;
  assert.equal(first.name, 'Profile Mobiles');
  assert.equal(first.address, '12, Anna Salai');
  assert.equal(first.city, 'Chennai');

  refused(await w.post(w.tokA, 'settings', { action: 'store', name: '  ' }), 400, 'store-name');
  ok(await w.post(w.tokA, 'settings', {
    action: 'store', name: 'Stark Mobiles', mobile: '9000000000', address: '5 Main Road', city: 'Madurai', state: 'Tamil Nadu',
    pincode: '625001', location: 'https://www.google.com/maps?q=9.9,78.1', gstin: ''
  }));
  const st = ok(await w.get(w.tokA, 'state')).store;
  assert.equal(st.name, 'Stark Mobiles');
  assert.equal(st.location, 'https://www.google.com/maps?q=9.9,78.1');
  assert.equal(st.gstin, '', 'a cleared field stays cleared, not refilled from the profile');
  assert.equal(w.fs.read('users/' + OWNER).mobileShopName, 'Profile Mobiles', 'the profile is left alone');

  const { bill } = ok(await w.post(w.tokA, 'bill', billBody(product)));
  const { token } = ok(await w.post(w.tokA, 'bill', { action: 'share', billId: bill.id }));
  const page = await invoke(require(API), { method: 'GET', url: '/i/' + token, query: { section: 'invoice', t: token } });
  assert.ok(String(page.body).includes('Stark Mobiles'), 'the shared invoice prints the store');
});

test('a store logo is a small image only the owner saves, and bills do not carry it', async () => {
  const w = world();
  await withProduct(w);
  await addRavi(w);
  const logo = 'data:image/jpeg;base64,' + 'QUJD'.repeat(1000);

  refused(await w.post(w.tokS, 'settings', { action: 'store-logo', data: logo }), 403, 'owner-only');
  refused(await w.post(w.tokA, 'settings', { action: 'store-logo', data: 'data:image/svg+xml;base64,QUJD' }), 400, 'logo-type');
  refused(await w.post(w.tokA, 'settings', { action: 'store-logo', data: 'javascript:alert(1)' }), 400, 'logo-type');
  refused(await w.post(w.tokA, 'settings', { action: 'store-logo', data: 'data:image/jpeg;base64,' + 'A'.repeat(130000) }), 400, 'logo-size');

  assert.equal(ok(await w.post(w.tokA, 'settings', { action: 'store-logo', data: logo })).logo, logo);
  assert.equal(ok(await w.get(w.tokA, 'settings')).logo, logo);
  assert.ok(!JSON.stringify(ok(await w.get(w.tokA, 'state'))).includes(logo));
  assert.equal(w.fs.read(`shops/${OWNER}`).store, undefined, 'the shop\'s own document stays small');

  ok(await w.post(w.tokA, 'settings', { action: 'store-logo', data: '' }));
  assert.equal(ok(await w.get(w.tokA, 'settings')).logo, '');
});

/* ------------------------------------------------------------------- staff */
test('a staff email has rules: one shop, not the owner, and a limit', async () => {
  const w = world();
  ok(await w.get(w.tokA, 'state'));
  refused(await w.post(w.tokA, 'settings', { action: 'staff-add', name: 'X', email: 'not-an-email' }), 400, 'staff-email');
  refused(await w.post(w.tokA, 'settings', { action: 'staff-add', name: '', email: 'x@example.test' }), 400, 'staff-name');
  refused(await w.post(w.tokA, 'settings', { action: 'staff-add', name: 'Me', email: 'OWNER@example.test' }), 400, 'staff-self');

  const { staff } = await addRavi(w);
  assert.equal(staff.length, 1);
  assert.equal(staff[0].email, 'ravi@example.test');
  assert.equal(staff[0].joined, false);
  assert.equal(ok(await w.get(w.tokA, 'settings')).staff[0].joined, true);
  refused(await w.post(w.tokB, 'settings', { action: 'staff-add', name: 'R', email: 'ravi@example.test' }), 409, 'staff-taken');

  for (let i = 0; i < 9; i++) ok(await w.post(w.tokA, 'settings', { action: 'staff-add', name: 'S' + i, email: `s${i}@example.test` }));
  refused(await w.post(w.tokA, 'settings', { action: 'staff-add', name: 'Too many', email: 'more@example.test' }), 409, 'staff-limit');
});

test('being added moves nobody: a person joins only by saying yes', async () => {
  const w = world();
  await withProduct(w);
  w.fs.seed('shops/staffSSSSS', { ownerUid: 'staffSSSSS', billSeq: 7 });
  ok(await w.post(w.tokA, 'settings', { action: 'store', name: 'Stark Mobiles' }));
  ok(await w.post(w.tokA, 'settings', { action: 'staff-add', name: 'Ravi', email: 'ravi@example.test' }));

  let st = ok(await w.get(w.tokS, 'state'));
  assert.equal(st.me.role, 'owner', 'still in their own shop');
  assert.equal(st.me.invite.shopName, 'Stark Mobiles');
  assert.equal(st.products.length, 0);

  /* someone else cannot answer for them */
  refused(await w.post(w.tokB, 'settings', { action: 'staff-join', accept: true }), 404, 'staff-missing');
  assert.equal(w.fs.read('shopStaff/ravi@example.test').uid, undefined);

  ok(await w.post(w.tokS, 'settings', { action: 'staff-join', accept: false }));
  assert.equal(w.fs.read('shopStaff/ravi@example.test'), undefined, 'declining ends the link');
  st = ok(await w.get(w.tokS, 'state'));
  assert.equal(st.me.invite, null);
  assert.equal(w.fs.read('shops/staffSSSSS').billSeq, 7, 'their own shop is as it was');

  ok(await w.post(w.tokA, 'settings', { action: 'staff-add', name: 'Ravi', email: 'ravi@example.test' }));
  ok(await w.post(w.tokS, 'settings', { action: 'staff-join', accept: true }));
  st = ok(await w.get(w.tokS, 'state'));
  assert.equal(st.me.role, 'staff');
  assert.equal(st.products.length, 1);
});

test('staff work in the owner\'s shop, and every bill says who made it', async () => {
  const w = world();
  const product = await withProduct(w);
  await addRavi(w);

  const st = ok(await w.get(w.tokS, 'state'));
  assert.deepEqual(st.me, { role: 'staff', name: 'Ravi', email: 'Ravi@Example.test', invite: null });
  assert.equal(st.products.length, 1, 'the owner\'s products');
  assert.equal(w.fs.read('shops/staffSSSSS'), undefined, 'no shop of their own was opened');

  const byStaff = ok(await w.post(w.tokS, 'bill', billBody(product))).bill;
  assert.equal(byStaff.staff.name, 'Ravi');
  assert.equal(byStaff.staff.role, 'staff');
  const byOwner = ok(await w.post(w.tokA, 'bill', billBody(product))).bill;
  assert.equal(byOwner.staff.name, 'Owner One');
  assert.equal(byOwner.staff.role, 'owner');

  const list = ok(await w.get(w.tokA, 'bills', { limit: 10 })).bills;
  assert.deepEqual(list.map(b => b.staffName).sort(), ['Owner One', 'Ravi']);

  let view = ok(await w.get(w.tokA, 'overview', {})).staff;
  assert.equal(view.length, 2);
  const ravi = view.find(r => r.name === 'Ravi');
  assert.equal(ravi.qty, 1);
  assert.equal(ravi.revenuePaise, 29900);

  /* a voided bill stops counting, for the person who made it */
  const voided = ok(await w.post(w.tokA, 'bill', { action: 'void', billId: byStaff.id, reason: 'mistake' })).bill;
  assert.equal(voided.history.slice(-1)[0].by, 'Owner One');
  view = ok(await w.get(w.tokA, 'overview', {})).staff;
  assert.deepEqual(view.map(r => r.name), ['Owner One']);
});

test('nothing in a request can say who is working', async () => {
  const w = world();
  const product = await withProduct(w);
  await addRavi(w);
  const forged = { uid: OWNER, email: 'owner@example.test', name: 'Owner One', role: 'owner' };
  const bill = ok(await w.post(w.tokS, 'bill', billBody(product, { actor: forged, staff: forged }))).bill;
  assert.equal(bill.staff.uid, 'staffSSSSS');
  assert.equal(bill.staff.role, 'staff');
});

test('a day saved before staff were recorded has no staff map, and still adds up', async () => {
  const w = world();
  const product = await withProduct(w);
  ok(await w.post(w.tokA, 'bill', billBody(product)));
  const day = `shops/${OWNER}/days/${periods.dayKey(Date.now())}`;
  const row = w.fs.read(day);
  assert.equal(Object.keys(row.staff).length, 1);
  delete row.staff;
  w.fs.seed(day, row);
  assert.deepEqual(ok(await w.get(w.tokA, 'overview', {})).staff, []);

  ok(await w.post(w.tokA, 'bill', billBody(product)));
  assert.equal(ok(await w.get(w.tokA, 'overview', {})).staff[0].qty, 1);
});

test('an unverified email never joins a shop', async () => {
  const w = world();
  ok(await w.get(w.tokA, 'state'));
  ok(await w.post(w.tokA, 'settings', { action: 'staff-add', name: 'Late', email: 'late@example.test' }));
  const st = ok(await w.get(w.tokU, 'state'));
  assert.equal(st.me.role, 'owner', 'it stays in its own empty shop');
  assert.equal(st.me.invite, null, 'it is not even invited');
  assert.equal(st.products.length, 0);
  refused(await w.post(w.tokU, 'settings', { action: 'staff-join', accept: true }), 404, 'staff-missing');
});

test('Settings are the owner\'s: staff are refused, and removing them takes them out', async () => {
  const w = world();
  await withProduct(w);
  await addRavi(w);

  refused(await w.get(w.tokS, 'settings'), 403, 'owner-only');
  refused(await w.post(w.tokS, 'settings', { action: 'store', name: 'Mine now' }), 403, 'owner-only');
  refused(await w.post(w.tokS, 'settings', { action: 'staff-add', name: 'Friend', email: 'friend@example.test' }), 403, 'owner-only');
  refused(await w.post(w.tokS, 'settings', { action: 'razorpay', keyId: KEY_ID, keySecret: KEY_SECRET }), 403, 'owner-only');
  refused(await w.post(w.tokS, 'settings', { action: 'razorpay-off' }), 403, 'owner-only');

  /* Shop B cannot remove Shop A's staff */
  refused(await w.post(w.tokB, 'settings', { action: 'staff-remove', email: 'ravi@example.test' }), 404, 'staff-missing');

  ok(await w.get(w.tokS, 'state'));
  const after = ok(await w.post(w.tokA, 'settings', { action: 'staff-remove', email: 'ravi@example.test' }));
  assert.equal(after.staff.length, 0);
  const st = ok(await w.get(w.tokS, 'state'));
  assert.equal(st.me.role, 'owner');
  assert.equal(st.products.length, 0, 'back in their own shop');
});

/* ---------------------------------------------------------------- razorpay */
test('keys that Razorpay refuses are not stored, and nothing is stored without the sealing key', async () => {
  const w = world();
  ok(await w.get(w.tokA, 'state'));
  refused(await w.post(w.tokA, 'settings', { action: 'razorpay', keyId: 'nope', keySecret: KEY_SECRET }), 400, 'razorpay-key-id');
  refused(await w.post(w.tokA, 'settings', { action: 'razorpay', keyId: KEY_ID, keySecret: 'x' }), 400, 'razorpay-key-secret');

  let rp = razorpay(() => ({ status: 401, body: { error: { code: 'BAD_REQUEST_ERROR' } } }));
  try {
    refused(await w.post(w.tokA, 'settings', { action: 'razorpay', keyId: KEY_ID, keySecret: KEY_SECRET }), 400, 'razorpay-keys');
  } finally { rp.restore(); }
  assert.equal(w.fs.read(`shops/${OWNER}/private/razorpay`), undefined);

  assert.equal(ok(await w.get(w.tokA, 'settings')).razorpay.ready, true);
  delete process.env.SHOP_SECRETS_KEY;
  assert.equal(ok(await w.get(w.tokA, 'settings')).razorpay.ready, false, 'the page can say so before anyone types a key');
  rp = razorpay(() => null);
  try {
    refused(await w.post(w.tokA, 'settings', { action: 'razorpay', keyId: KEY_ID, keySecret: KEY_SECRET }), 503, 'secrets-unavailable');
  } finally { rp.restore(); }
  assert.equal(rp.calls.length, 0, 'it stops before sending the key anywhere');
  assert.equal(w.fs.read(`shops/${OWNER}/private/razorpay`), undefined);
});

test('a connected key is stored sealed and never comes back to the browser', async () => {
  const w = world();
  ok(await w.get(w.tokA, 'state'));
  const rp = razorpay(() => null);
  let saved;
  try {
    saved = await connect(w, HOOK_SECRET);
  } finally { rp.restore(); }
  assert.ok(rp.calls[0].auth.startsWith('Basic '));
  assert.equal(saved.razorpay.connected, true);
  assert.equal(saved.razorpay.mode, 'test');
  assert.equal(saved.razorpay.webhook, true);

  const stored = JSON.stringify(w.fs.read(`shops/${OWNER}/private/razorpay`));
  assert.ok(!stored.includes(KEY_SECRET) && !stored.includes(HOOK_SECRET));

  const seen = [saved, ok(await w.get(w.tokA, 'settings')), ok(await w.get(w.tokA, 'state'))].map(x => JSON.stringify(x)).join('');
  assert.ok(!seen.includes(KEY_SECRET) && !seen.includes(HOOK_SECRET));
  assert.ok(!seen.includes(KEY_ID), 'not even the whole key id');
  assert.equal(ok(await w.get(w.tokA, 'state')).payments.razorpay, true);

  ok(await w.post(w.tokA, 'settings', { action: 'razorpay-off' }));
  assert.equal(w.fs.read(`shops/${OWNER}/private/razorpay`), undefined);
  assert.equal(ok(await w.get(w.tokA, 'state')).payments.razorpay, false);
});

test('a bill only takes a QR that Razorpay says was paid, for its amount, once', async () => {
  const w = world();
  const product = await withProduct(w);
  await addRavi(w);
  let paid = 0;
  const rp = razorpay((url, method) => {
    const reply = qrReply({ payments_amount_received: paid });
    return reply(url, method);
  });
  try {
    await connect(w);
    refused(await w.post(w.tokA, 'qr', { action: 'create', amountPaise: 50 }), 400, 'qr-amount-bad');
    const { qr } = ok(await w.post(w.tokS, 'qr', { action: 'create', amountPaise: 29900, fid: 'f1' }), 'staff can make a QR');
    assert.equal(qr.imageUrl, 'https://rzp.io/i/test');
    const sent = rp.calls.find(c => c.method === 'POST');
    assert.equal(sent.body.type, 'upi_qr');
    assert.equal(sent.body.usage, 'single_use');
    assert.equal(sent.body.fixed_amount, true);
    assert.equal(sent.body.payment_amount, 29900);

    const upi = qrId => ({ payment: { method: 'upi', status: 'paid', qrId } });
    assert.equal(ok(await w.get(w.tokA, 'qr', { id: qr.id })).status, 'active');
    refused(await w.post(w.tokA, 'bill', billBody(product, upi(qr.id))), 409, 'qr-unpaid');

    paid = 10000;
    assert.equal(ok(await w.get(w.tokA, 'qr', { id: qr.id })).status, 'active', 'part of the amount is not paid');
    paid = 29900;
    assert.equal(ok(await w.get(w.tokA, 'qr', { id: qr.id })).status, 'paid');

    /* the browser saying so changes nothing: this bill collects a different amount */
    const two = billBody(product, upi(qr.id));
    two.lines[0].qty = 2;
    const wrong = await w.post(w.tokA, 'bill', two);
    refused(wrong, 409, 'qr-amount');

    const body = billBody(product, upi(qr.id));
    const bill = ok(await w.post(w.tokA, 'bill', body)).bill;
    assert.deepEqual(bill.payment.razorpay, { qrId: qr.id, paymentId: 'pay_Test1' });
    assert.equal(ok(await w.post(w.tokA, 'bill', body)).replayed, true, 'the same bill sent twice is one bill');

    refused(await w.post(w.tokA, 'bill', billBody(product, upi(qr.id))), 409, 'qr-used');
    refused(await w.post(w.tokB, 'bill', { action: 'finalise', finalisationId: cid('f'), lines: [{ name: 'x', qty: 1, unitPaise: 29900 }], payment: { method: 'upi', status: 'paid', qrId: qr.id } }), 409, 'qr-unpaid');
    refused(await w.get(w.tokB, 'qr', { id: qr.id }), 404, 'qr-missing');
  } finally { rp.restore(); }
});

test('an account without QR Codes gets a payment link shown as a QR, paid the same way', async () => {
  const w = world();
  const product = await withProduct(w);
  let link = { status: 'created', amount_paid: 0, payments: [] };
  const rp = razorpay((url, method) => {
    if (/qr_codes$/.test(url)) return { status: 400, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'The requested URL was not found on the server.' } } };
    if (method === 'POST' && /payment_links$/.test(url)) return { body: { id: 'plink_TestAbc123', short_url: 'https://rzp.io/rzp/test1' } };
    if (method === 'GET' && /payment_links\/plink_TestAbc123$/.test(url)) return { body: link };
    return null;
  });
  try {
    await connect(w);
    const { qr } = ok(await w.post(w.tokA, 'qr', { action: 'create', amountPaise: 29900, fid: 'f1' }));
    assert.equal(qr.id, 'plink_TestAbc123');
    assert.equal(qr.payUrl, 'https://rzp.io/rzp/test1');
    assert.match(qr.imageUrl, /^data:image\/svg\+xml;base64,/);
    const sent = rp.calls.find(c => c.method === 'POST' && /payment_links$/.test(c.url)).body;
    assert.equal(sent.amount, 29900);
    assert.ok(sent.expire_by * 1000 - Date.now() > 15 * 60 * 1000, 'Razorpay wants at least 15 minutes');

    assert.equal(ok(await w.get(w.tokA, 'qr', { id: qr.id })).status, 'active');
    refused(await w.post(w.tokA, 'bill', billBody(product, { payment: { method: 'upi', status: 'paid', qrId: qr.id } })), 409, 'qr-unpaid');
    link = { status: 'paid', amount_paid: 29900, payments: [{ payment_id: 'pay_Link1' }] };
    assert.equal(ok(await w.get(w.tokA, 'qr', { id: qr.id })).status, 'paid');
    const bill = ok(await w.post(w.tokA, 'bill', billBody(product, { payment: { method: 'upi', status: 'paid', qrId: qr.id } }))).bill;
    assert.deepEqual(bill.payment.razorpay, { qrId: qr.id, paymentId: 'pay_Link1' });
  } finally { rp.restore(); }
});

test('a payment link QR left open is cancelled at Razorpay', async () => {
  const w = world();
  ok(await w.get(w.tokA, 'state'));
  const rp = razorpay((url, method) => {
    if (/qr_codes$/.test(url)) return { status: 404, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'The requested URL was not found on the server.' } } };
    if (method === 'POST' && /payment_links$/.test(url)) return { body: { id: 'plink_TestAbc124', short_url: 'https://rzp.io/rzp/test2' } };
    return null;
  });
  try {
    await connect(w);
    const { qr } = ok(await w.post(w.tokA, 'qr', { action: 'create', amountPaise: 10000 }));
    assert.equal(ok(await w.post(w.tokA, 'qr', { action: 'close', id: qr.id })).closed, true);
    assert.ok(rp.calls.some(c => c.method === 'POST' && /payment_links\/plink_TestAbc124\/cancel$/.test(c.url)));
  } finally { rp.restore(); }
});

test('a QR for a shop with no Razorpay is refused', async () => {
  const w = world();
  ok(await w.get(w.tokA, 'state'));
  refused(await w.post(w.tokA, 'qr', { action: 'create', amountPaise: 10000 }), 409, 'razorpay-off');
});

/* ----------------------------------------------------------------- webhook */
function deliver(shop, payload, signWith) {
  const raw = Buffer.from(JSON.stringify(payload));
  const handler = require(HOOK);
  const req = Readable.from([raw]);
  req.method = 'POST';
  req.url = '/api/razorpay-webhook?shop=' + shop;
  req.query = { shop };
  req.headers = { 'x-razorpay-signature': crypto.createHmac('sha256', signWith).update(raw).digest('hex') };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; },
      end(b) { resolve({ status: this.statusCode, body: JSON.parse(b) }); }
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('a shop\'s webhook takes only that shop\'s signature, and marks its QR paid', async () => {
  const w = world();
  ok(await w.get(w.tokA, 'state'));
  const rp = razorpay(qrReply());
  try {
    await connect(w, HOOK_SECRET);
    const { qr } = ok(await w.post(w.tokA, 'qr', { action: 'create', amountPaise: 29900 }));
    const event = amount => ({
      event: 'qr_code.credited',
      payload: { qr_code: { entity: { id: qr.id, payments_amount_received: amount } }, payment: { entity: { id: 'pay_Hook1' } } }
    });
    assert.equal((await deliver(OWNER, event(29900), 'someone-else')).status, 400);
    assert.equal(w.fs.read(`shops/${OWNER}/qrPayments/${qr.id}`).status, 'active');
    assert.equal((await deliver('shopBBBBBB', event(29900), HOOK_SECRET)).status, 404);

    assert.equal((await deliver(OWNER, event(100), HOOK_SECRET)).status, 200);
    assert.equal(w.fs.read(`shops/${OWNER}/qrPayments/${qr.id}`).status, 'active', 'too little does not count');
    assert.equal((await deliver(OWNER, { event: 'payment.captured', payload: {} }, HOOK_SECRET)).body.ignored, 'payment.captured');

    assert.equal((await deliver(OWNER, event(29900), HOOK_SECRET)).status, 200);
    const row = w.fs.read(`shops/${OWNER}/qrPayments/${qr.id}`);
    assert.equal(row.status, 'paid');
    assert.equal(row.paymentId, 'pay_Hook1');
    assert.equal(ok(await w.get(w.tokA, 'qr', { id: qr.id })).status, 'paid');
  } finally { rp.restore(); }
});

test('a shop\'s webhook marks a payment link QR paid', async () => {
  const w = world();
  ok(await w.get(w.tokA, 'state'));
  const rp = razorpay((url, method) => {
    if (/qr_codes$/.test(url)) return { status: 400, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'The requested URL was not found on the server.' } } };
    if (method === 'POST' && /payment_links$/.test(url)) return { body: { id: 'plink_TestAbc125', short_url: 'https://rzp.io/rzp/test3' } };
    return null;
  });
  try {
    await connect(w, HOOK_SECRET);
    const { qr } = ok(await w.post(w.tokA, 'qr', { action: 'create', amountPaise: 29900 }));
    const event = { event: 'payment_link.paid', payload: { payment_link: { entity: { id: qr.id, amount_paid: 29900 } }, payment: { entity: { id: 'pay_Hook2' } } } };
    assert.equal((await deliver(OWNER, event, HOOK_SECRET)).status, 200);
    const row = w.fs.read(`shops/${OWNER}/qrPayments/${qr.id}`);
    assert.equal(row.status, 'paid');
    assert.equal(row.paymentId, 'pay_Hook2');
  } finally { rp.restore(); }
});
