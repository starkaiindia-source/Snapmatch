/* ============================================================================
   api/_lib/shop-upgrade.test.js
   ----------------------------------------------------------------------------
   Quick Billing with the catalogue behind it: standard categories, master
   devices, variants, compatibility groups, customers and the Overview, through
   the real route and the real service, over the in-memory Firestore whose
   transactions retry the way the live ones do.

   The compatibility data is seeded in the shapes Compatibility Management writes
   (groups, groupDetails, modelGroups). The model ids are real catalogue ids,
   because the service checks them against the catalogue. The group ids are in a
   range the real catalogue does not use, so a local copy of the paid data cannot
   answer for them.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { create, invoke } = require('./testing/fake-firebase');
const insights = require('../_services/shop-insights');

const API = path.join(__dirname, '..', 'shop.js');
const SERVICE = path.join(__dirname, '..', '_services', 'shop-service.js');
const ENTITLEMENT = path.join(__dirname, '..', '_services', 'entitlement-service.js');

const GLASS = 'sg-9001';
const GLASS_TWO = 'sg-9002';
const COVER = 'bc-9001';
const OLD_GLASS = 'sg-9003';

function group(fs, id, categoryId, master, members, extra) {
  fs.seed('groups/' + id, Object.assign({
    categoryId, masterModelId: master, masterModelName: master, memberCount: members.length,
    partCode: 'MPF-' + id.toUpperCase(), groupNo: id.toUpperCase()
  }, extra || {}));
  fs.seed('groupDetails/' + id, Object.assign({
    memberIds: members, memberNames: members, memberCount: members.length, drawingName: master
  }, extra || {}));
}

function world() {
  const fb = create();
  fb.install();
  [API, SERVICE, ENTITLEMENT].forEach(f => { delete require.cache[require.resolve(f)]; });
  const handler = require(API);
  const tokA = fb.account({ uid: 'shopAAAAAA', email: 'a@example.test', name: 'Shop A' });
  const tokB = fb.account({ uid: 'shopBBBBBB', email: 'b@example.test', name: 'Shop B' });
  const fs = fb.firestore;

  group(fs, GLASS, 'screen-guards', 'realme-5', ['realme-5', 'vivo-y20']);
  group(fs, GLASS_TWO, 'screen-guards', 'vivo-y20', ['vivo-y20', 'realme-5']);
  group(fs, COVER, 'back-cover', 'realme-5', ['realme-5']);
  group(fs, OLD_GLASS, 'screen-guards', 'vivo-y20', ['vivo-y20'], { mergedInto: GLASS });
  fs.seed('modelGroups/realme-5', { id: 'realme-5', byCategory: { 'screen-guards': [GLASS, GLASS_TWO], 'back-cover': [COVER] } });
  fs.seed('modelGroups/vivo-y20', { id: 'vivo-y20', byCategory: { 'screen-guards': [GLASS, GLASS_TWO] } });

  const call = (token, section, method, body, query) =>
    invoke(handler, { method, url: '/api/shop/' + section, query: Object.assign({ section }, query || {}), token, body });
  const post = (token, section, body) => call(token, section, 'POST', body);
  const get = (token, section, query) => call(token, section, 'GET', null, query);
  return { fb, fs, tokA, tokB, post, get };
}

let seq = 0;
const cid = p => (p || 'id') + '_' + String(++seq).padStart(10, '0') + 'abcdef';
const ok = (r, label) => { assert.equal(r.status, 200, (label || '') + ' ' + JSON.stringify(r.body)); return r.body; };

async function categories(w, token) {
  const st = ok(await w.get(token, 'state'));
  const byName = {};
  st.categories.forEach(c => { byName[c.name] = c; });
  return { list: st.categories, byName };
}

async function addProduct(w, token, categoryId, extra) {
  return ok(await w.post(token, 'product', Object.assign({
    action: 'create', productId: cid('p'), name: 'A product', pricePaise: 29900, qty: 30, categoryId
  }, extra || {})), 'add product').product;
}

const billBody = (lines, extra) => Object.assign({
  action: 'finalise', finalisationId: cid('f'), lines, payment: { method: 'cash', status: 'paid' }
}, extra || {});

/* -------------------------------------------------------- TEST 1 categories */
test('1: a new shop gets the standard categories in the required order, once', async () => {
  const w = world();
  const first = await categories(w, w.tokA);
  assert.deepEqual(first.list.map(c => c.name), [
    'Mobiles', 'Tempered Glass', 'Back Cover', 'Smart Watch', 'Earbuds', 'Charger', 'Cable',
    'Combo Display', 'Battery', 'Middle Frame', 'CC Board', 'Service Spares'
  ]);
  assert.deepEqual(first.list.map(c => c.order), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  const again = await categories(w, w.tokA);
  assert.equal(again.list.length, 12, 'opening twice adds nothing');

  assert.equal(first.byName.Mobiles.compat.enabled, false);
  assert.equal(first.byName.Mobiles.deviceKind, 'phone');
  assert.equal(first.byName['Smart Watch'].deviceKind, 'watch');
  assert.equal(first.byName['Tempered Glass'].compat.enabled, true);
  assert.equal(first.byName['Tempered Glass'].compat.partCategory, 'screen-guards');
  ['Back Cover', 'Combo Display', 'Battery', 'Middle Frame', 'CC Board'].forEach(n => {
    assert.equal(first.byName[n].compat.enabled, true, n);
  });
});

test('1: two tabs opening a new shop at once make no twins', async () => {
  const w = world();
  await Promise.all([w.get(w.tokA, 'state'), w.get(w.tokA, 'state'), w.get(w.tokA, 'state')]);
  assert.equal((await categories(w, w.tokA)).list.length, 12);
});

test('1: an existing shop keeps its products and custom categories, and gains the missing standards', async () => {
  const w = world();
  const uid = 'shopAAAAAA';
  w.fs.seed(`shops/${uid}`, { ownerUid: uid, billSeq: 0 });
  w.fs.seed(`shops/${uid}/categories/oldglass`, { ownerUid: uid, name: 'Tempered Glass', nameKey: 'tempered glass', order: 1 });
  w.fs.seed(`shops/${uid}/categories/oldcustom`, { ownerUid: uid, name: 'Gift Boxes', nameKey: 'gift boxes', order: 2 });
  w.fs.seed(`shops/${uid}/products/p1`, { ownerUid: uid, name: 'Old Glass', pricePaise: 100, qty: 3, categoryId: 'oldglass' });

  const { list, byName } = await categories(w, w.tokA);
  assert.equal(list.length, 13, 'twelve standard and one custom');
  assert.equal(byName['Tempered Glass'].id, 'oldglass', 'the same category, not a twin');
  assert.equal(byName['Tempered Glass'].order, 2);
  assert.equal(byName['Gift Boxes'].order, 13, 'custom categories follow the standard ones');
  const st = ok(await w.get(w.tokA, 'state'));
  assert.equal(st.products[0].categoryId, 'oldglass', 'the product did not move');
});

test('1: a shop can reorder, and opening again does not undo it', async () => {
  const w = world();
  const { list } = await categories(w, w.tokA);
  ok(await w.post(w.tokA, 'category', { action: 'update', categoryId: list[8].id, order: 1 }));
  const after = await categories(w, w.tokA);
  assert.equal(after.list[0].name, 'Battery');
  assert.equal(after.list.length, 12);
  assert.deepEqual(after.list.map(c => c.order), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

/* ----------------------------------------------- category compatibility */
test('category settings: a custom category can turn compatibility on', async () => {
  const w = world();
  await categories(w, w.tokA);
  const c = ok(await w.post(w.tokA, 'category', {
    action: 'create', name: 'Camera Glass', description: 'Lens protectors', compatEnabled: true, partCategory: 'screen-guards'
  })).category;
  assert.equal(c.compat.enabled, true);
  assert.equal(c.description, 'Lens protectors');
  assert.equal((await w.post(w.tokA, 'category', { action: 'create', name: 'Bad', compatEnabled: true, partCategory: 'not-a-category' })).status, 400);
  assert.equal((await w.post(w.tokA, 'category', { action: 'create', name: 'Bad2', deviceKind: 'toaster' })).status, 400);
});

test('category settings: turning compatibility off keeps the links and stops the matches', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const glass = await addProduct(w, w.tokA, byName['Tempered Glass'].id, { groupIds: [GLASS] });
  assert.equal(ok(await w.get(w.tokA, 'compat', { modelId: 'vivo-y20' })).matches.length, 1);

  ok(await w.post(w.tokA, 'category', { action: 'update', categoryId: byName['Tempered Glass'].id, compatEnabled: false }));
  assert.equal(ok(await w.get(w.tokA, 'compat', { modelId: 'vivo-y20' })).matches.length, 0);
  const st = ok(await w.get(w.tokA, 'state'));
  assert.deepEqual(st.products.find(p => p.id === glass.id).groupIds, [GLASS], 'the link is still there');

  ok(await w.post(w.tokA, 'category', { action: 'update', categoryId: byName['Tempered Glass'].id, compatEnabled: true, partCategory: 'screen-guards' }));
  assert.equal(ok(await w.get(w.tokA, 'compat', { modelId: 'vivo-y20' })).matches.length, 1);
});

/* ------------------------------------------------------- TEST 2 master */
test('2: a mobile refers to the master device and does not copy or change it', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const before = w.fs.paths('').filter(p => !p.startsWith('shops/')).length;
  const p = await addProduct(w, w.tokA, byName.Mobiles.id, {
    name: 'Realme 5', master: { id: 'realme-5', name: 'tampered name', kind: 'phone', image: 'https://fdn2.gsmarena.com/vv/bigpic/realme-5.jpg' }
  });
  assert.equal(p.master.id, 'realme-5');
  assert.equal(p.master.name, 'Realme 5', 'the name comes from the catalogue, not the request');
  assert.equal(p.master.image, 'https://fdn2.gsmarena.com/vv/bigpic/realme-5.jpg');
  assert.equal(w.fs.paths('').filter(x => !x.startsWith('shops/')).length, before, 'nothing written outside the shop');
});

test('2: an unknown model, a wrong kind, or a foreign image host is refused or dropped', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const mk = extra => w.post(w.tokA, 'product', Object.assign({ action: 'create', productId: cid('p'), name: 'X', pricePaise: 100, qty: 1 }, extra));
  assert.equal((await mk({ categoryId: byName.Mobiles.id, master: { id: 'no-such-phone' } })).body.error, 'master-unknown');
  assert.equal((await mk({ categoryId: byName.Mobiles.id, master: { id: 'realme-5', kind: 'watch' } })).body.error, 'master-kind');
  assert.equal((await mk({ categoryId: byName.Battery.id, master: { id: 'realme-5' } })).body.error, 'master-category');
  const p = ok(await mk({ categoryId: byName.Mobiles.id, master: { id: 'realme-5', image: 'https://evil.example/x.jpg' } })).product;
  assert.equal(p.master.image, null);
});

/* ----------------------------------------------------- TEST 3 variants */
const twoVariants = () => [
  { id: 'v_6128', ram: '6 GB', storage: '128 GB', pricePaise: 1200000, costPaise: 1100000, qty: 4, shelf: 'A1', sku: 'R5-6-128' },
  { id: 'v_8256', ram: '8 GB', storage: '256 GB', pricePaise: 1500000, costPaise: 1350000, qty: 2, shelf: 'A2', sku: 'R5-8-256' }
];

test('3: variants keep separate prices and stock, and selling one leaves the other alone', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = await addProduct(w, w.tokA, byName.Mobiles.id, { name: 'Realme 5', pricePaise: undefined, qty: undefined, variants: twoVariants(), master: { id: 'realme-5' } });
  assert.equal(p.qty, 6, 'the product shows the total');
  assert.equal(p.pricePaise, 1200000, 'and the lowest price');
  assert.equal(p.variants.length, 2);

  const r = ok(await w.post(w.tokA, 'bill', billBody([{ productId: p.id, variantId: 'v_8256', qty: 1, unitPaise: 1500000 }])));
  assert.equal(r.bill.items[0].variantLabel, '8 GB / 256 GB');
  assert.equal(r.bill.items[0].sku, 'R5-8-256');
  assert.equal(r.bill.items[0].shelf, 'A2');
  assert.equal(r.bill.items[0].costPaise, 1350000);

  const after = ok(await w.get(w.tokA, 'state')).products.find(x => x.id === p.id);
  assert.equal(after.variants.find(v => v.id === 'v_8256').qty, 1);
  assert.equal(after.variants.find(v => v.id === 'v_6128').qty, 4, 'the other variant is untouched');
  assert.equal(after.qty, 5);
});

test('3: a variant product needs a variant, and a variant cannot be oversold', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = await addProduct(w, w.tokA, byName.Mobiles.id, { pricePaise: undefined, qty: undefined, variants: twoVariants() });
  assert.equal((await w.post(w.tokA, 'bill', billBody([{ productId: p.id, qty: 1, unitPaise: 100 }]))).body.error, 'variant-required');
  assert.equal((await w.post(w.tokA, 'bill', billBody([{ productId: p.id, variantId: 'v_nope', qty: 1, unitPaise: 100 }]))).body.error, 'variant-missing');
  const over = await w.post(w.tokA, 'bill', billBody([{ productId: p.id, variantId: 'v_8256', qty: 3, unitPaise: 100 }]));
  assert.equal(over.status, 409);
  assert.equal(over.body.error, 'insufficient-stock');
  assert.equal(over.body.shortfalls[0].available, 2);
});

test('3: duplicate variants are refused, and a variant holding stock cannot be deleted', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const dup = twoVariants(); dup[1].ram = '6 GB'; dup[1].storage = '128 GB';
  const r = await w.post(w.tokA, 'product', { action: 'create', productId: cid('p'), name: 'X', categoryId: byName.Mobiles.id, variants: dup });
  assert.equal(r.body.error, 'variant-duplicate');

  const p = await addProduct(w, w.tokA, byName.Mobiles.id, { pricePaise: undefined, qty: undefined, variants: twoVariants() });
  const del = await w.post(w.tokA, 'product', { action: 'update', productId: p.id, variants: twoVariants().slice(0, 1) });
  assert.equal(del.status, 409);
  assert.equal(del.body.error, 'variant-has-stock');
});

test('3: editing a variant quantity is a logged movement, and a void puts the variant back', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = await addProduct(w, w.tokA, byName.Mobiles.id, { pricePaise: undefined, qty: undefined, variants: twoVariants() });
  const edited = twoVariants(); edited[0].qty = 9;
  const up = ok(await w.post(w.tokA, 'product', { action: 'update', productId: p.id, variants: edited })).product;
  assert.equal(up.qty, 11);
  const moves = ok(await w.get(w.tokA, 'moves', { productId: p.id })).moves;
  assert.ok(moves.some(m => m.reason === 'edit' && m.delta === 5 && m.variantLabel === '6 GB / 128 GB'));

  const bill = ok(await w.post(w.tokA, 'bill', billBody([{ productId: p.id, variantId: 'v_6128', qty: 2, unitPaise: 1200000 }]))).bill;
  ok(await w.post(w.tokA, 'bill', { action: 'void', billId: bill.id, reason: 'returned' }));
  const back = ok(await w.get(w.tokA, 'state')).products.find(x => x.id === p.id);
  assert.equal(back.variants.find(v => v.id === 'v_6128').qty, 9);
});

/* --------------------------------------------- TEST 4, 5 compatibility links */
test('4: a tempered glass links to several existing groups, and nothing is created', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const before = w.fs.paths('groups/').length;
  const p = await addProduct(w, w.tokA, byName['Tempered Glass'].id, { groupIds: [GLASS, GLASS_TWO] });
  assert.deepEqual(p.groupIds.slice().sort(), [GLASS, GLASS_TWO].sort());
  assert.equal(w.fs.paths('groups/').length, before);
});

test('4: a bad, a wrong-category or a merged group is handled', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const mk = (catName, groupIds) => w.post(w.tokA, 'product', { action: 'create', productId: cid('p'), name: 'X', pricePaise: 100, qty: 1, categoryId: byName[catName].id, groupIds });
  assert.equal((await mk('Tempered Glass', ['sg-7777'])).body.error, 'group-unknown');
  assert.equal((await mk('Tempered Glass', ['<script>'])).body.error, 'group-unknown');
  assert.equal((await mk('Tempered Glass', [COVER])).body.error, 'group-category', 'a back cover group on a glass');
  assert.equal((await mk('Mobiles', [GLASS])).body.error, 'group-category-off');
  const merged = ok(await mk('Tempered Glass', [OLD_GLASS])).product;
  assert.deepEqual(merged.groupIds, [GLASS], 'linked as the group it became');
});

test('5: searching a model finds its existing groups, cut to the plan', async () => {
  const w = world();
  await categories(w, w.tokA);
  const r = ok(await w.get(w.tokA, 'model-groups', { modelId: 'vivo-y20', partCategory: 'screen-guards' }));
  assert.equal(r.categories.length, 1);
  assert.deepEqual(r.categories[0].groups.map(g => g.groupId).sort(), [GLASS, GLASS_TWO].sort());
  assert.equal(w.fs.paths('groups/').length, 4, 'no group was made by searching');
});

test('paywall: a free shop sees a group count and no member list', async () => {
  const w = world();
  await categories(w, w.tokA);
  const g = ok(await w.get(w.tokA, 'group', { id: GLASS })).group;
  assert.equal(g.memberCount, 2);
  assert.deepEqual(g.members, [], 'free: no member names');
  assert.equal(g.requiresPlan, true);
});

test('paywall: a paying shop sees the members', async () => {
  const w = world();
  await categories(w, w.tokA);
  w.fs.seed('users/shopAAAAAA', {
    subscriptionStatus: 'active', currentPlanId: 'yearly', subscriptionExpiresAt: Date.now() + 86400000
  });
  const g = ok(await w.get(w.tokA, 'group', { id: GLASS })).group;
  assert.equal(g.members.length, 2);
  assert.equal(g.requiresPlan, false);
});

/* --------------------------------------------- TEST 6, 7, 8 billing by model */
async function realme5Glass(w, token) {
  const { byName } = await categories(w, token);
  return addProduct(w, token, byName['Tempered Glass'].id, {
    name: 'Realme 5 Tempered Glass Clear', qty: 30, pricePaise: 29900, groupIds: [GLASS, GLASS_TWO], sku: 'TG-R5'
  });
}

test('6 and 8: searching a compatible model returns the real product, once', async () => {
  const w = world();
  const glass = await realme5Glass(w, w.tokA);
  const r = ok(await w.get(w.tokA, 'compat', { modelId: 'vivo-y20' }));
  assert.equal(r.model.name, 'vivo Y20');
  assert.equal(r.matches.length, 1, 'two matching groups, one result');
  assert.equal(r.matches[0].productId, glass.id);
  assert.equal(r.matches[0].groupIds.length, 2);
});

test('6: a phone with no shared group finds nothing, whatever the product is called', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  await addProduct(w, w.tokA, byName['Tempered Glass'].id, { name: 'Vivo Y20 Glass', groupIds: [] });
  assert.equal(ok(await w.get(w.tokA, 'compat', { modelId: 'vivo-y20' })).matches.length, 0);
  assert.equal(ok(await w.get(w.tokA, 'compat', { modelId: 'apple-iphone-se-2022' })).matches.length, 0);
});

test('6: a link to a group that was merged still matches, and archived products do not', async () => {
  const w = world();
  const uid = 'shopAAAAAA';
  const { byName } = await categories(w, w.tokA);
  w.fs.seed(`shops/${uid}/products/oldlink`, {
    ownerUid: uid, name: 'Linked before the merge', pricePaise: 100, qty: 1, active: true,
    categoryId: byName['Tempered Glass'].id, groupIds: [OLD_GLASS]
  });
  const found = ok(await w.get(w.tokA, 'compat', { modelId: 'vivo-y20' })).matches;
  assert.deepEqual(found.map(m => m.productId), ['oldlink']);
  assert.equal(found[0].groupId, GLASS, 'reported as the group it became');
  ok(await w.post(w.tokA, 'product', { action: 'archive', productId: 'oldlink', archived: true }));
  assert.equal(ok(await w.get(w.tokA, 'compat', { modelId: 'vivo-y20' })).matches.length, 0);
});

test('7: selling for Vivo Y20 deducts the Realme 5 glass and records both', async () => {
  const w = world();
  const glass = await realme5Glass(w, w.tokA);
  const paths = w.fs.paths('shops/shopAAAAAA/products/').length;
  const r = ok(await w.post(w.tokA, 'bill', billBody([{
    productId: glass.id, qty: 2, unitPaise: 29900, selectedModelId: 'vivo-y20', groupId: GLASS
  }])));
  const item = r.bill.items[0];
  assert.equal(item.name, 'Realme 5 Tempered Glass Clear', 'the product sold');
  assert.equal(item.selectedModelId, 'vivo-y20');
  assert.equal(item.selectedModelName, 'vivo Y20', 'the phone asked about');
  assert.equal(item.groupId, GLASS);

  const st = ok(await w.get(w.tokA, 'state'));
  assert.equal(st.products.length, 1, 'no product appeared for the Vivo');
  assert.equal(st.products[0].qty, 28);
  assert.ok(w.fs.paths('shops/shopAAAAAA/products/').length > paths, 'one movement was logged');
  const moves = ok(await w.get(w.tokA, 'moves', { productId: glass.id })).moves;
  assert.ok(moves.some(m => m.reason === 'sale' && m.delta === -2));
});

test('7: a group the product is not linked to is not recorded on the bill', async () => {
  const w = world();
  const glass = await realme5Glass(w, w.tokA);
  const r = ok(await w.post(w.tokA, 'bill', billBody([{ productId: glass.id, qty: 1, unitPaise: 29900, selectedModelId: 'vivo-y20', groupId: COVER }])));
  assert.equal(r.bill.items[0].groupId, null);
  const unknown = ok(await w.post(w.tokA, 'bill', billBody([{ productId: glass.id, qty: 1, unitPaise: 29900, selectedModelId: 'not-a-real-phone' }])));
  assert.equal(unknown.bill.items[0].selectedModelId, null);
});

/* ------------------------------------------------- TEST 9, 10 stock safety */
test('9: more than the stock cannot be sold, and nothing changes when it fails', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = await addProduct(w, w.tokA, byName.Cable.id, { qty: 2 });
  const r = await w.post(w.tokA, 'bill', billBody([{ productId: p.id, qty: 3, unitPaise: 29900 }]));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'insufficient-stock');
  const st = ok(await w.get(w.tokA, 'state'));
  assert.equal(st.products[0].qty, 2);
  assert.equal(st.shop.billCount, 0);
});

test('10: concurrent bills cannot sell the same stock twice', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = await addProduct(w, w.tokA, byName.Cable.id, { qty: 3 });
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    w.post(w.tokA, 'bill', billBody([{ productId: p.id, qty: 1, unitPaise: 29900 }]))));
  const won = results.filter(r => r.status === 200);
  assert.equal(won.length, 3, 'exactly the stock on the shelf was sold');
  assert.ok(results.filter(r => r.status !== 200).every(r => r.status === 409));
  assert.equal(new Set(won.map(r => r.body.bill.number)).size, 3, 'every bill has its own number');
  const st = ok(await w.get(w.tokA, 'state'));
  assert.equal(st.products[0].qty, 0);
});

test('10: concurrent bills on two variants of one product both land', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = await addProduct(w, w.tokA, byName.Mobiles.id, { pricePaise: undefined, qty: undefined, variants: twoVariants() });
  await Promise.all([
    w.post(w.tokA, 'bill', billBody([{ productId: p.id, variantId: 'v_6128', qty: 1, unitPaise: 100 }])),
    w.post(w.tokA, 'bill', billBody([{ productId: p.id, variantId: 'v_8256', qty: 1, unitPaise: 100 }]))
  ]);
  const after = ok(await w.get(w.tokA, 'state')).products[0];
  assert.deepEqual(after.variants.map(v => v.qty).sort(), [1, 3]);
  assert.equal(after.qty, 4);
});

test('duplicate submission: the same bill sent twice is one bill and one deduction', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = await addProduct(w, w.tokA, byName.Cable.id, { qty: 5 });
  const body = billBody([{ productId: p.id, qty: 2, unitPaise: 29900 }], { customer: { name: 'Asha', mobile: '9876543210' } });
  const [a, b] = await Promise.all([w.post(w.tokA, 'bill', body), w.post(w.tokA, 'bill', body)]);
  assert.equal(a.body.bill.id, b.body.bill.id);
  assert.equal(ok(await w.get(w.tokA, 'state')).products[0].qty, 3);
  const c = ok(await w.get(w.tokA, 'customers', {})).customers[0];
  assert.equal(c.billCount, 1, 'and the customer has one bill');
  const o = ok(await w.get(w.tokA, 'overview', {}));
  assert.equal(o.today.bills, 1);
});

/* ------------------------------------------- TEST 11, 12, 13 customers */
test('11: a bill with a new number creates one customer, and the same number finds them', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = await addProduct(w, w.tokA, byName.Cable.id, {});
  const one = ok(await w.post(w.tokA, 'bill', billBody([{ productId: p.id, qty: 1, unitPaise: 10000 }], { customer: { name: 'Asha', mobile: '+91 98765 43210' } })));
  assert.equal(one.customer.mobile, '9876543210');
  const two = ok(await w.post(w.tokA, 'bill', billBody([{ productId: p.id, qty: 1, unitPaise: 20000 }], { customer: { name: 'Asha K', mobile: '98765-43210' } })));
  assert.equal(two.customer.id, one.customer.id, 'one customer, however the number was typed');
  const list = ok(await w.get(w.tokA, 'customers', {})).customers;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Asha', 'their record keeps its name');
  assert.equal(list[0].billCount, 2);
  assert.equal(list[0].totalPaise, 30000);
  assert.equal(ok(await w.get(w.tokA, 'state')).shop.customerCount, 1);
});

test('11: two tills creating the same customer at once make one', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = await addProduct(w, w.tokA, byName.Cable.id, {});
  await Promise.all([1, 2, 3].map(() => w.post(w.tokA, 'bill', billBody([{ productId: p.id, qty: 1, unitPaise: 100 }], { customer: { name: 'Ravi', mobile: '9000000001' } }))));
  const list = ok(await w.get(w.tokA, 'customers', {})).customers;
  assert.equal(list.length, 1);
  assert.equal(list[0].billCount, 3);
});

test('11: selecting a customer by id links the bill, and a stale id is refused', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = await addProduct(w, w.tokA, byName.Cable.id, {});
  const c = ok(await w.post(w.tokA, 'customer', { action: 'create', name: 'Meena', mobile: '9000000002' })).customer;
  const r = ok(await w.post(w.tokA, 'bill', billBody([{ productId: p.id, qty: 1, unitPaise: 100 }], { customer: { id: c.id } })));
  assert.equal(r.bill.customerId, c.id);
  assert.equal(r.bill.customer.name, 'Meena', 'the bill carries the name');
  assert.equal((await w.post(w.tokA, 'bill', billBody([{ productId: p.id, qty: 1, unitPaise: 100 }], { customer: { id: 'missing12345' } }))).body.error, 'customer-missing');
  assert.equal((await w.post(w.tokA, 'customer', { action: 'create', name: 'Copy', mobile: '9000000002' })).body.error, 'customer-exists');
});

test('12: the profile shows the right bills, totals, visits and what they bought', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = await addProduct(w, w.tokA, byName.Cable.id, { name: 'USB Cable', qty: 20 });
  const who = { name: 'Asha', mobile: '9876543210' };
  const a = ok(await w.post(w.tokA, 'bill', billBody([{ productId: p.id, qty: 2, unitPaise: 10000 }], { customer: who })));
  ok(await w.post(w.tokA, 'bill', billBody([{ productId: p.id, qty: 1, unitPaise: 30000 }], { customer: who, payment: { method: 'upi', status: 'partial', receivedPaise: 10000 } })));
  const voided = ok(await w.post(w.tokA, 'bill', billBody([{ productId: p.id, qty: 1, unitPaise: 50000 }], { customer: who })));
  ok(await w.post(w.tokA, 'bill', { action: 'void', billId: voided.bill.id, reason: 'mistake' }));

  const prof = ok(await w.get(w.tokA, 'customer', { id: a.customer.id }));
  assert.equal(prof.customer.billCount, 2, 'the voided bill is not a purchase');
  assert.equal(prof.customer.totalPaise, 50000);
  assert.equal(prof.customer.paidPaise, 30000);
  assert.equal(prof.customer.outstandingPaise, 20000);
  assert.equal(prof.customer.averageBillPaise, 25000);
  assert.equal(prof.bills.length, 3, 'the history still lists it, marked void');
  assert.equal(prof.bills.filter(b => b.status === 'void').length, 1);
  assert.equal(prof.insights.visits, 1, 'three bills on one day is one visit');
  assert.equal(prof.insights.topProducts[0].name, 'USB Cable');
  assert.equal(prof.insights.topProducts[0].qty, 3);

  const second = prof.bills.find(b => b.balancePaise);
  ok(await w.post(w.tokA, 'bill', { action: 'payment', billId: second.id, payment: { method: 'cash', status: 'paid', receivedPaise: 30000 } }));
  const paid = ok(await w.get(w.tokA, 'customer', { id: a.customer.id }));
  assert.equal(paid.customer.outstandingPaise, 0);
  assert.equal(paid.payments.length, 1);
});

test('13: a walk-in bill reaches no customer, and a typed name alone stays a walk-in', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = await addProduct(w, w.tokA, byName.Cable.id, {});
  const guest = ok(await w.post(w.tokA, 'bill', billBody([{ productId: p.id, qty: 1, unitPaise: 100 }])));
  assert.equal(guest.bill.customerId, null);
  const named = ok(await w.post(w.tokA, 'bill', billBody([{ productId: p.id, qty: 1, unitPaise: 100 }], { customer: { name: 'Asha' } })));
  assert.equal(named.bill.customerId, null);
  assert.equal(named.bill.customer.name, 'Asha', 'the name stays on the bill');
  assert.equal(ok(await w.get(w.tokA, 'customers', {})).customers.length, 0);
  assert.equal(ok(await w.get(w.tokA, 'overview', {})).customers.today.walkIns, 2);
});

test('customers: filters and paging', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = await addProduct(w, w.tokA, byName.Cable.id, { qty: 100 });
  for (let i = 0; i < 7; i++) {
    const who = { name: 'Customer ' + i, mobile: '900000010' + i };
    ok(await w.post(w.tokA, 'bill', billBody([{ productId: p.id, qty: 1, unitPaise: 1000 * (i + 1) }], { customer: who, payment: { method: 'cash', status: i === 0 ? 'unpaid' : 'paid' } })));
    if (i === 1) ok(await w.post(w.tokA, 'bill', billBody([{ productId: p.id, qty: 1, unitPaise: 100 }], { customer: who })));
  }
  const top = ok(await w.get(w.tokA, 'customers', { filter: 'top', limit: 5 }));
  assert.equal(top.customers.length, 5);
  assert.equal(top.customers[0].name, 'Customer 6');
  assert.ok(top.nextCursor);
  const rest = ok(await w.get(w.tokA, 'customers', { filter: 'top', limit: 5, cursor: top.nextCursor }));
  assert.equal(rest.customers.length, 2);
  assert.equal(new Set(top.customers.concat(rest.customers).map(c => c.id)).size, 7, 'no one twice, no one lost');
  assert.deepEqual(ok(await w.get(w.tokA, 'customers', { filter: 'repeat' })).customers.map(c => c.name), ['Customer 1']);
  assert.deepEqual(ok(await w.get(w.tokA, 'customers', { filter: 'outstanding' })).customers.map(c => c.name), ['Customer 0']);
  assert.equal(ok(await w.get(w.tokA, 'customers', { filter: 'new' })).customers.length, 7);
  assert.deepEqual(ok(await w.get(w.tokA, 'customers', { q: 'customer 3' })).customers.map(c => c.name), ['Customer 3']);
  assert.deepEqual(ok(await w.get(w.tokA, 'customers', { q: '9000000104' })).customers.map(c => c.name), ['Customer 4']);
});

test('customers: editing a number cannot take one already in use', async () => {
  const w = world();
  await categories(w, w.tokA);
  const a = ok(await w.post(w.tokA, 'customer', { action: 'create', name: 'A', mobile: '9000000003' })).customer;
  const b = ok(await w.post(w.tokA, 'customer', { action: 'create', name: 'B', customerId: cid('c') })).customer;
  assert.equal((await w.post(w.tokA, 'customer', { action: 'update', customerId: b.id, mobile: a.mobile })).body.error, 'customer-mobile-taken');
  const up = ok(await w.post(w.tokA, 'customer', { action: 'update', customerId: b.id, address: 'Salem', whatsapp: '9000000004' })).customer;
  assert.equal(up.address, 'Salem');
  assert.equal((await w.post(w.tokA, 'customer', { action: 'create', name: '' })).body.error, 'customer-name');
});

/* ------------------------------------------------------ TEST 14 dashboard */
test('14: the Overview matches the bills, by the documented rules', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const a = await addProduct(w, w.tokA, byName.Cable.id, { name: 'Cable', qty: 50, pricePaise: 10000, costPaise: 6000 });
  const b = await realme5Glass(w, w.tokA);
  const who = { name: 'Asha', mobile: '9876543210' };

  /* one customer, two bills on the day; a partly paid one; a walk-in; one voided */
  ok(await w.post(w.tokA, 'bill', billBody([{ productId: a.id, qty: 2, unitPaise: 10000 }], { customer: who, discount: { mode: 'amount', value: 1000 } })));
  ok(await w.post(w.tokA, 'bill', billBody([{ productId: b.id, qty: 1, unitPaise: 29900, selectedModelId: 'vivo-y20', groupId: GLASS }], { customer: who, payment: { method: 'upi', status: 'partial', receivedPaise: 9900 } })));
  ok(await w.post(w.tokA, 'bill', billBody([{ productId: a.id, qty: 1, unitPaise: 10000 }])));
  const gone = ok(await w.post(w.tokA, 'bill', billBody([{ productId: a.id, qty: 5, unitPaise: 10000 }])));
  ok(await w.post(w.tokA, 'bill', { action: 'void', billId: gone.bill.id, reason: 'mistake' }));

  const o = ok(await w.get(w.tokA, 'overview', {}));
  const t = o.today;
  assert.equal(t.bills, 3, 'a voided bill is not a sale');
  assert.equal(t.voids, 1);
  assert.equal(t.grossPaise, 20000 + 29900 + 10000);
  assert.equal(t.discountPaise, 1000);
  assert.equal(t.netPaise, 19000 + 29900 + 10000);
  assert.equal(t.averageBillPaise, Math.round(58900 / 3));
  assert.equal(t.voidedPaise, 50000);
  /* collected today: 19000 + 9900 + 10000, plus the voided 50000 taken and handed back */
  assert.equal(t.collectedPaise, 19000 + 9900 + 10000 + 50000);
  assert.equal(t.refundedPaise, 50000);
  assert.equal(t.collectedNetPaise, 19000 + 9900 + 10000);
  assert.equal(o.shop.outstandingPaise, 20000, 'the balance on the part-paid bill');
  assert.equal(o.shop.customerCount, 1);

  assert.equal(o.customers.today.unique, 1, 'two bills, one customer');
  assert.equal(o.customers.today.newCustomers, 1);
  assert.equal(o.customers.today.walkIns, 1);
  assert.equal(o.customers.period.avgSpendPaise, 19000 + 29900);

  assert.equal(o.products[0].name, 'Cable', 'best seller by revenue');
  assert.equal(o.products.find(p => p.id === a.id).qty, 3, 'the voided five are gone');
  assert.deepEqual(o.models.map(m => [m.name, m.qty]), [['vivo Y20', 1]], 'the phone asked about, not the product');
  assert.equal(o.methods.upi, 9900);
  assert.equal(o.series.length, 30);
  assert.equal(o.series[29].bills, 3);
});

test('14: money paid later counts on the day it arrived, and outstanding falls', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const a = await addProduct(w, w.tokA, byName.Cable.id, {});
  const bill = ok(await w.post(w.tokA, 'bill', billBody([{ productId: a.id, qty: 1, unitPaise: 10000 }], { payment: { method: 'cash', status: 'unpaid' } }))).bill;
  let o = ok(await w.get(w.tokA, 'overview', {}));
  assert.equal(o.today.collectedPaise, 0);
  assert.equal(o.shop.outstandingPaise, 10000);
  ok(await w.post(w.tokA, 'bill', { action: 'payment', billId: bill.id, payment: { method: 'upi', status: 'paid', receivedPaise: 10000 } }));
  o = ok(await w.get(w.tokA, 'overview', {}));
  assert.equal(o.today.collectedPaise, 10000);
  assert.equal(o.shop.outstandingPaise, 0);
});

test('14: change handed back is not collected', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const a = await addProduct(w, w.tokA, byName.Cable.id, {});
  ok(await w.post(w.tokA, 'bill', billBody([{ productId: a.id, qty: 1, unitPaise: 10000 }], { payment: { method: 'cash', status: 'paid', receivedPaise: 50000 } })));
  assert.equal(ok(await w.get(w.tokA, 'overview', {})).today.collectedPaise, 10000);
});

test('14: the period rules, on known days', () => {
  const uid = 'u';
  const day = (d, net, cust) => {
    const x = insights.emptyDay(d, uid);
    insights.addBill(x, { subtotalPaise: net, discountPaise: 0, taxPaise: 0, totalPaise: net, items: [] }, cust);
    return x;
  };
  const docs = [
    day('2026-09-20', 5000, { id: 'a', isNew: true }),     /* last month */
    day('2026-10-02', 10000, { id: 'a', isNew: false }),   /* this month, repeat */
    day('2026-10-02', 0, null),
    day('2026-10-20', 20000, { id: 'b', isNew: true }),
    day('2026-10-21', 30000, { id: 'b', isNew: false })    /* came back another day */
  ].reduce((map, d) => {
    if (!map.has(d.day)) map.set(d.day, d);
    else { const m = map.get(d.day); m.bills += d.bills; m.netPaise += d.netPaise; m.walkIns += d.walkIns; }
    return map;
  }, new Map());
  const o = insights.overview(Array.from(docs.values()), { today: '2026-10-31', from: '2026-10-01', to: '2026-10-31' });
  assert.equal(o.period.netPaise, 60000);
  assert.equal(o.range.prevFrom, '2026-08-31');
  assert.equal(o.range.prevTo, '2026-09-30');
  assert.equal(o.previous.netPaise, 5000);
  assert.equal(o.compare.period.net.delta, 55000);
  assert.equal(o.compare.period.net.pct, 11);
  assert.equal(o.customers.period.unique, 2);
  assert.equal(o.customers.period.newCustomers, 1);
  assert.equal(o.customers.period.repeat, 2, 'a returned, and b came back');
  assert.equal(o.customers.period.returningRate, 1);
  assert.equal(o.customers.period.avgDailyUnique, 3 / 31);
  assert.equal(insights.change(100, 0).pct, null, 'no percentage against nothing');
  assert.equal(insights.change(0, 0).delta, 0);
});

test('14: a day is an Indian trading day', () => {
  /* 18:30 UTC on the 14th is 00:00 IST on the 15th */
  assert.equal(insights.dayKey(Date.UTC(2026, 9, 14, 18, 29, 59)), '2026-10-14');
  assert.equal(insights.dayKey(Date.UTC(2026, 9, 14, 18, 30, 0)), '2026-10-15');
  assert.equal(insights.dayStart('2026-10-15'), Date.UTC(2026, 9, 14, 18, 30, 0));
});

test('backfill: bills from before this upgrade become customers and day figures, once', async () => {
  const w = world();
  const uid = 'shopAAAAAA';
  const at = Date.now() - 3 * 86400000;
  const old = (id, seqNo, total, cust, extra) => w.fs.seed(`shops/${uid}/bills/${id}`, Object.assign({
    ownerUid: uid, number: 'QB-000' + seqNo, seq: seqNo, status: 'final', createdAt: at,
    items: [{ productId: 'p1', name: 'Old', qty: 1, unitPaise: total, totalPaise: total, categoryName: 'Cables' }],
    subtotalPaise: total, discountPaise: 0, taxPaise: 0, totalPaise: total,
    payment: { method: 'cash', status: 'paid', receivedPaise: total, balancePaise: 0, changePaise: 0 },
    customer: cust, customerMobile: cust.mobile, customerKey: cust.name.toLowerCase()
  }, extra || {}));
  w.fs.seed(`shops/${uid}`, { ownerUid: uid, billSeq: 4 });
  old('b1', 1, 10000, { name: 'Asha', mobile: '9876543210' });
  old('b2', 2, 20000, { name: 'Asha', mobile: '9876543210' });
  old('b3', 3, 5000, { name: 'Just a name', mobile: '' });
  old('b4', 4, 7000, { name: 'Gone', mobile: '9000000009' }, { status: 'void' });

  ok(await w.get(w.tokA, 'state'));
  ok(await w.get(w.tokA, 'state'));

  const list = ok(await w.get(w.tokA, 'customers', {})).customers;
  assert.deepEqual(list.map(c => [c.name, c.billCount, c.totalPaise]), [['Asha', 2, 30000]]);
  const prof = ok(await w.get(w.tokA, 'customer', { id: list[0].id }));
  assert.equal(prof.bills.length, 2, 'the bills now point at the customer');
  const key = insights.dayKey(at);
  const o = ok(await w.get(w.tokA, 'overview', { from: key, to: key }));
  assert.equal(o.period.bills, 3);
  assert.equal(o.period.netPaise, 35000);
  assert.equal(o.period.voids, 1);
  assert.equal(o.customers.period.walkIns, 1);
  assert.equal(w.fs.read(`shops/${uid}/bills/b1`).totalPaise, 10000, 'the money on the bill is untouched');
});

/* ---------------------------------------------------- TEST 15 isolation */
test('15: one shop cannot reach another shop\'s customers, days or compatibility stock', async () => {
  const w = world();
  const glass = await realme5Glass(w, w.tokA);
  const paid = ok(await w.post(w.tokA, 'bill', billBody([{ productId: glass.id, qty: 1, unitPaise: 29900 }], { customer: { name: 'Private', mobile: '9876543210' } })));

  await categories(w, w.tokB);
  assert.equal(ok(await w.get(w.tokB, 'compat', { modelId: 'vivo-y20' })).matches.length, 0);
  assert.equal(ok(await w.get(w.tokB, 'customers', {})).customers.length, 0);
  assert.equal(ok(await w.get(w.tokB, 'customers', { q: '9876543210' })).customers.length, 0);
  assert.equal((await w.get(w.tokB, 'customer', { id: paid.customer.id })).status, 404);
  assert.equal(ok(await w.get(w.tokB, 'overview', {})).today.bills, 0);
  assert.equal((await w.post(w.tokB, 'customer', { action: 'update', customerId: paid.customer.id, name: 'x' })).status, 404);
  const steal = await w.post(w.tokB, 'bill', billBody([{ name: 'Mine', qty: 1, unitPaise: 100 }], { customer: { id: paid.customer.id } }));
  assert.equal(steal.body.error, 'customer-missing', 'a customer id from another shop means nothing here');
  assert.equal((await w.get(null, 'customers')).status, 401);
  assert.equal((await w.get(null, 'overview')).status, 401);
  assert.equal((await w.get(null, 'compat', { modelId: 'vivo-y20' })).status, 401);
});

/* --------------------------------------------- TEST 16 invoice snapshots */
test('16: later changes to a product or a group do not rewrite a saved bill', async () => {
  const w = world();
  const glass = await realme5Glass(w, w.tokA);
  const bill = ok(await w.post(w.tokA, 'bill', billBody([{ productId: glass.id, qty: 1, unitPaise: 29900, selectedModelId: 'vivo-y20', groupId: GLASS }]))).bill;
  const before = JSON.stringify(bill.items);

  ok(await w.post(w.tokA, 'product', { action: 'update', productId: glass.id, name: 'Renamed', pricePaise: 99900, sku: 'NEW', groupIds: [] }));
  w.fs.seed('groups/' + GLASS, { categoryId: 'screen-guards', mergedInto: GLASS_TWO });

  const again = ok(await w.get(w.tokA, 'bill', { id: bill.id })).bill;
  assert.equal(JSON.stringify(again.items), before);
  assert.equal(again.items[0].name, 'Realme 5 Tempered Glass Clear');
  assert.equal(again.items[0].unitPaise, 29900);
});

/* ------------------------------------------- bill list, for the drill-down */
test('bills can be listed for a time range', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = await addProduct(w, w.tokA, byName.Cable.id, {});
  ok(await w.post(w.tokA, 'bill', billBody([{ productId: p.id, qty: 1, unitPaise: 100 }])));
  const today = insights.dayKey(Date.now());
  const from = insights.dayStart(today);
  const to = from + 86400000;
  assert.equal(ok(await w.get(w.tokA, 'bills', { from, to })).bills.length, 1);
  assert.equal(ok(await w.get(w.tokA, 'bills', { from: from - 86400000, to: from })).bills.length, 0);
});

/* ================================================== stock changed in the table */

test('a stock count from the table is an adjustment, not a sale', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = ok(await w.post(w.tokA, 'product', {
    action: 'create', productId: cid('p'), name: 'Counted Glass', categoryId: byName['Tempered Glass'].id, pricePaise: 29900, qty: 30
  })).product;

  const adjustId = cid('a');
  const body = { action: 'adjust', productId: p.id, adjustId, delta: -2, expectedQty: 30, note: 'Stock count' };
  assert.equal(ok(await w.post(w.tokA, 'product', body)).product.qty, 28);
  assert.equal(ok(await w.post(w.tokA, 'product', body)).product.qty, 28, 'a repeat is not applied twice');

  const moves = ok(await w.get(w.tokA, 'moves', { productId: p.id })).moves;
  assert.equal(moves.filter(m => m.reason === 'adjust').length, 1);
  assert.equal(moves.filter(m => m.reason === 'sale').length, 0);
  assert.equal(moves[0].qtyAfter, 28);
});

test('a stock count is refused when a sale moved the stock first', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = ok(await w.post(w.tokA, 'product', {
    action: 'create', productId: cid('p'), name: 'Raced Glass', categoryId: byName['Tempered Glass'].id, pricePaise: 29900, qty: 10
  })).product;
  ok(await w.post(w.tokA, 'bill', {
    action: 'finalise', finalisationId: cid('f'), lines: [{ productId: p.id, qty: 3, unitPaise: 29900 }],
    payment: { method: 'cash', status: 'paid' }
  }));

  const r = await w.post(w.tokA, 'product', {
    action: 'adjust', productId: p.id, adjustId: cid('a'), delta: 5, expectedQty: 10, note: 'Stock count'
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'stock-changed');
  assert.equal(r.body.available, 7);

  const st = ok(await w.get(w.tokA, 'state'));
  assert.equal(st.products.find(x => x.id === p.id).qty, 7, 'the sale stands and nothing was added');
});

test('a stock count moves one variant and leaves the others', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = ok(await w.post(w.tokA, 'product', {
    action: 'create', productId: cid('p'), name: 'vivo Y20', categoryId: byName.Mobiles.id, sku: 'Y20',
    master: { id: 'vivo-y20', kind: 'phone' },
    variants: [
      { id: 'var_small', ram: '3 GB', storage: '32 GB', pricePaise: 899900, qty: 5 },
      { id: 'var_large', ram: '4 GB', storage: '64 GB', pricePaise: 1099900, qty: 2 }
    ]
  })).product;

  const after = ok(await w.post(w.tokA, 'product', {
    action: 'adjust', productId: p.id, adjustId: cid('a'), delta: 4, expectedQty: 2, variantId: 'var_large', note: 'Stock count'
  })).product;
  assert.deepEqual(after.variants.map(v => v.qty), [5, 6]);
  assert.equal(after.qty, 11);
  assert.equal(after.master.id, 'vivo-y20', 'the device link is untouched');

  const wrong = await w.post(w.tokA, 'product', {
    action: 'adjust', productId: p.id, adjustId: cid('a'), delta: 1, expectedQty: 2, variantId: 'var_large', note: 'Stock count'
  });
  assert.equal(wrong.status, 409, 'the figure is checked against that variant');
  assert.equal(wrong.body.available, 6);
});

test('another shop cannot change a stock count', async () => {
  const w = world();
  const { byName } = await categories(w, w.tokA);
  const p = ok(await w.post(w.tokA, 'product', {
    action: 'create', productId: cid('p'), name: 'Private Glass', categoryId: byName['Tempered Glass'].id, pricePaise: 100, qty: 4
  })).product;
  await categories(w, w.tokB);
  const r = await w.post(w.tokB, 'product', { action: 'adjust', productId: p.id, adjustId: cid('a'), delta: 1, expectedQty: 4 });
  assert.equal(r.status, 404);
  const st = ok(await w.get(w.tokA, 'state'));
  assert.equal(st.products.find(x => x.id === p.id).qty, 4);
});
