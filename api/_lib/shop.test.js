/* ============================================================================
   api/_lib/shop.test.js
   ----------------------------------------------------------------------------
   Quick Billing, end to end through the real route: token in, the real
   handler, the real service, an in-memory Firestore with real (optimistic,
   retrying) transactions, response out.

   The properties that matter to a shop at the counter:
     · a bill is numbered once and never shares a number, even saved twice
       at the same instant
     · a bill saved twice — double tap, retry, second tab — is ONE bill, and
       stock goes down once
     · stock never goes negative, and a bill that asks for too much changes
       nothing at all
     · voiding puts the stock back, once
     · a custom line never turns into a product
     · one shop can see and touch nothing of another's
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { create, invoke } = require('./testing/fake-firebase');

const API = path.join(__dirname, '..', 'shop.js');
const SERVICE = path.join(__dirname, '..', '_services', 'shop-service.js');

/** A fresh world: fake Firebase installed, two shops signed in, handler loaded. */
function world() {
  const fb = create();
  fb.install();
  delete require.cache[require.resolve(API)];
  delete require.cache[require.resolve(SERVICE)];
  const handler = require(API);
  const tokA = fb.account({ uid: 'shopAAAAAA', email: 'a@example.test', name: 'Shop A' });
  const tokB = fb.account({ uid: 'shopBBBBBB', email: 'b@example.test', name: 'Shop B' });
  const call = (token, section, method, body, query) =>
    invoke(handler, { method, url: '/api/shop/' + section, query: Object.assign({ section }, query || {}), token, body });
  const post = (token, section, body) => call(token, section, 'POST', body);
  const get = (token, section, query) => call(token, section, 'GET', null, query);
  return { fb, handler, tokA, tokB, post, get };
}

let seq = 0;
const cid = p => (p || 'id') + '_' + String(++seq).padStart(10, '0') + 'abcdef';

async function seedShop(w, token) {
  const cat = await w.post(token, 'category', { action: 'create', name: 'Tempered Glass' });
  assert.equal(cat.status, 200, JSON.stringify(cat.body));
  const catId = cat.body.category.id;
  const mk = async (name, pricePaise, qty) => {
    const r = await w.post(token, 'product', {
      action: 'create', productId: cid('p'), name, pricePaise, qty, shelf: 'A1', categoryId: catId
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.product;
  };
  const glass = await mk('Redmi 13C Glass', 15000, 10);
  const cover = await mk('A15 Cover', 25000, 3);
  return { catId, glass, cover };
}

const billBody = (fid, lines, extra) => Object.assign({
  action: 'finalise', finalisationId: fid, lines,
  payment: { method: 'cash', status: 'paid' }
}, extra || {});

test('signed out is refused, unknown sections are 404', async () => {
  const w = world();
  assert.equal((await w.get(null, 'state')).status, 401);
  assert.equal((await w.post('not-a-token', 'bill', billBody(cid(), []))).status, 401);
  assert.equal((await w.get(w.tokA, 'nope')).status, 404);
  assert.equal((await w.post(w.tokA, 'bill', { action: 'delete' })).status, 400, 'there is no delete');
});

test('categories: create, no duplicates in any case, suggested defaults fill only the gaps', async () => {
  const w = world();
  const a = await w.post(w.tokA, 'category', { action: 'create', name: '  Battery ' });
  assert.equal(a.status, 200);
  assert.equal(a.body.category.name, 'Battery');
  const dup = await w.post(w.tokA, 'category', { action: 'create', name: 'BATTERY' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'category-exists');

  const s = await w.post(w.tokA, 'category', { action: 'suggested' });
  assert.equal(s.status, 200);
  assert.equal(s.body.created.length, 9, 'Battery already existed');
  const again = await w.post(w.tokA, 'category', { action: 'suggested' });
  assert.equal(again.body.created.length, 0);

  const st = await w.get(w.tokA, 'state');
  assert.equal(st.body.categories.length, 10);
  assert.equal(st.body.categories[0].name, 'Battery', 'kept in creation order');
});

test('categories: rename, reorder, delete moves products and never deletes one', async () => {
  const w = world();
  const { catId, glass } = await seedShop(w, w.tokA);
  const other = (await w.post(w.tokA, 'category', { action: 'create', name: 'Other' })).body.category.id;

  const ren = await w.post(w.tokA, 'category', { action: 'rename', categoryId: catId, name: 'Glass' });
  assert.equal(ren.body.category.name, 'Glass');

  await w.post(w.tokA, 'category', { action: 'reorder', ids: [other, catId] });
  let st = await w.get(w.tokA, 'state');
  assert.deepEqual(st.body.categories.map(c => c.id), [other, catId]);

  const refused = await w.post(w.tokA, 'category', { action: 'delete', categoryId: catId });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'category-has-products');
  assert.equal(refused.body.count, 2);

  const del = await w.post(w.tokA, 'category', { action: 'delete', categoryId: catId, moveTo: other });
  assert.equal(del.status, 200);
  assert.equal(del.body.moved, 2);
  st = await w.get(w.tokA, 'state');
  assert.equal(st.body.products.length, 2, 'products survive their category');
  assert.ok(st.body.products.every(p => p.categoryId === other));
  assert.ok(st.body.products.some(p => p.id === glass.id));
});

test('product: create with photo, price, shelf, qty; repeat create returns the same product', async () => {
  const w = world();
  const cat = (await w.post(w.tokA, 'category', { action: 'create', name: 'Back Cover' })).body.category.id;
  /* a real (tiny) PNG header + padding */
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(80, 1)]).toString('base64');
  const id = cid('p');
  const body = { action: 'create', productId: id, name: 'S24 Cover', pricePaise: 49900, qty: 4, shelf: 'B2',
    categoryId: cat, image: { type: 'image/png', data: png } };
  const r = await w.post(w.tokA, 'product', body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.product.pricePaise, 49900);
  assert.equal(r.body.product.qty, 4);
  assert.equal(r.body.product.shelf, 'B2');
  assert.match(r.body.product.imageUrl, /^data:image\/png;base64,/);

  const again = await w.post(w.tokA, 'product', body);
  assert.equal(again.body.replayed, true);
  assert.equal((await w.get(w.tokA, 'state')).body.products.length, 1, 'no double product on a double tap');
  assert.equal(w.fb.storage.files.size, 1, 'and no second photo uploaded');

  const fake = await w.post(w.tokA, 'product', Object.assign({}, body, { productId: cid('p'), image: { type: 'image/png', data: Buffer.from('GIF89a' + 'x'.repeat(80)).toString('base64') } }));
  assert.equal(fake.status, 400);
  assert.equal(fake.body.error, 'image-data', 'checked by its bytes, not its label');
});

test('product: validation and a new category named in the same form', async () => {
  const w = world();
  const base = { action: 'create', productId: cid('p'), name: 'X', pricePaise: 100, qty: 1, newCategory: 'Flex Cable' };
  assert.equal((await w.post(w.tokA, 'product', Object.assign({}, base, { name: '  ' }))).body.error, 'product-name');
  assert.equal((await w.post(w.tokA, 'product', Object.assign({}, base, { pricePaise: 0 }))).body.error, 'product-price');
  assert.equal((await w.post(w.tokA, 'product', Object.assign({}, base, { pricePaise: 10.5 }))).body.error, 'product-price');
  assert.equal((await w.post(w.tokA, 'product', Object.assign({}, base, { qty: -1 }))).body.error, 'product-qty');
  assert.equal((await w.post(w.tokA, 'product', Object.assign({}, base, { newCategory: '' }))).body.error, 'product-category');

  const ok = await w.post(w.tokA, 'product', base);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.category.name, 'Flex Cable');
  const twin = await w.post(w.tokA, 'product', Object.assign({}, base, { productId: cid('p'), newCategory: 'flex cable' }));
  assert.equal(twin.body.product.categoryId, ok.body.product.categoryId, 'reuses, does not duplicate');
});

test('product: edit name, price and category; a quantity edit is logged as a movement', async () => {
  const w = world();
  const { glass } = await seedShop(w, w.tokA);
  const r = await w.post(w.tokA, 'product', {
    action: 'update', productId: glass.id, name: 'Redmi 13C 9H Glass', pricePaise: 17500, qty: 12, newCategory: 'Display'
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.product.name, 'Redmi 13C 9H Glass');
  assert.equal(r.body.product.pricePaise, 17500);
  assert.equal(r.body.product.qty, 12);
  assert.equal(r.body.category.name, 'Display');
  const m = await w.get(w.tokA, 'moves', { productId: glass.id });
  assert.deepEqual(m.body.moves.map(x => [x.reason, x.delta]), [['edit', 2], ['opening', 10]]);
});

test('stock adjust is idempotent and never goes negative', async () => {
  const w = world();
  const { cover } = await seedShop(w, w.tokA);
  const adj = cid('adj');
  const a1 = await w.post(w.tokA, 'product', { action: 'adjust', productId: cover.id, adjustId: adj, delta: 5, note: 'received' });
  const a2 = await w.post(w.tokA, 'product', { action: 'adjust', productId: cover.id, adjustId: adj, delta: 5, note: 'received' });
  assert.equal(a1.body.product.qty, 8);
  assert.equal(a2.body.replayed, true);
  assert.equal(a2.body.product.qty, 8);
  const neg = await w.post(w.tokA, 'product', { action: 'adjust', productId: cover.id, adjustId: cid('adj'), delta: -9 });
  assert.equal(neg.status, 409);
  assert.equal(neg.body.error, 'negative-stock');
});

test('bill: multi-product + custom item, totals recomputed by the server, stock deducted', async () => {
  const w = world();
  const { glass, cover } = await seedShop(w, w.tokA);
  const fid = cid('f');
  const r = await w.post(w.tokA, 'bill', billBody(fid, [
    { productId: glass.id, qty: 2, unitPaise: 15000 },
    { productId: cover.id, qty: 1, unitPaise: 22000 },        /* price changed at the counter */
    { name: 'Fitting charge', qty: 1, unitPaise: 5000 }        /* custom */
  ], {
    discount: { mode: 'amount', value: 2000 },
    tax: { rateBp: 1800, label: 'GST' },
    customer: { name: 'Ravi Kumar', mobile: '+91 98765 43210', notes: 'call when ready' },
    /* totals the browser might send are ignored */
    totalPaise: 1
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body.bill;
  assert.equal(b.number, 'QB-0001');
  assert.equal(b.subtotalPaise, 57000);
  assert.equal(b.discountPaise, 2000);
  assert.equal(b.taxPaise, 9900);
  assert.equal(b.totalPaise, 64900);
  assert.equal(b.payment.status, 'paid');
  assert.equal(b.payment.receivedPaise, 64900, 'Paid with nothing typed is paid in full');
  assert.equal(b.customer.mobile, '9876543210');
  assert.equal(b.items[1].unitPaise, 22000);
  assert.equal(b.items[1].listPaise, 25000, 'the snapshot keeps the list price too');
  assert.equal(b.items[2].custom, true);
  assert.equal(b.items[2].productId, null);

  const st = await w.get(w.tokA, 'state');
  const q = id => st.body.products.find(p => p.id === id).qty;
  assert.equal(q(glass.id), 8);
  assert.equal(q(cover.id), 2);
  assert.equal(st.body.products.length, 2, 'the custom item did not become a product');
  assert.equal(st.body.products.find(p => p.id === glass.id).soldCount, 2);
});

test('bill: the same finalisation id saved again — sequentially or at once — is one bill, one deduction', async () => {
  const w = world();
  const { glass } = await seedShop(w, w.tokA);
  const fid = cid('f');
  const body = billBody(fid, [{ productId: glass.id, qty: 3, unitPaise: 15000 }]);
  const [x, y, z] = await Promise.all([w.post(w.tokA, 'bill', body), w.post(w.tokA, 'bill', body), w.post(w.tokA, 'bill', body)]);
  for (const r of [x, y, z]) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(new Set([x, y, z].map(r => r.body.bill.number)).size, 1);
  assert.equal([x, y, z].filter(r => r.body.replayed).length, 2);

  const later = await w.post(w.tokA, 'bill', body);
  assert.equal(later.body.replayed, true);
  assert.equal(later.body.bill.number, x.body.bill.number);

  const st = await w.get(w.tokA, 'state');
  assert.equal(st.body.products.find(p => p.id === glass.id).qty, 7, 'deducted exactly once');
  const moves = (await w.get(w.tokA, 'moves', { productId: glass.id })).body.moves;
  assert.equal(moves.filter(m => m.reason === 'sale').length, 1);
  assert.equal((await w.get(w.tokA, 'bills')).body.bills.length, 1);
});

test('bill numbers: concurrent saves of different bills never collide', async () => {
  const w = world();
  const { glass } = await seedShop(w, w.tokA);
  const saves = Array.from({ length: 6 }, () =>
    w.post(w.tokA, 'bill', billBody(cid('f'), [{ productId: glass.id, qty: 1, unitPaise: 15000 }])));
  const res = await Promise.all(saves);
  res.forEach(r => assert.equal(r.status, 200, JSON.stringify(r.body)));
  const numbers = res.map(r => r.body.bill.number).sort();
  assert.deepEqual(numbers, ['QB-0001', 'QB-0002', 'QB-0003', 'QB-0004', 'QB-0005', 'QB-0006']);
  assert.ok(w.fb.firestore.stats.retries > 0, 'the contention really happened and was retried');
  const st = await w.get(w.tokA, 'state');
  assert.equal(st.body.products.find(p => p.id === glass.id).qty, 4);
  assert.equal(st.body.shop.billCount, 6);
});

test('bill: asking for more than the shelf holds fails the whole bill and changes nothing', async () => {
  const w = world();
  const { glass, cover } = await seedShop(w, w.tokA);
  const r = await w.post(w.tokA, 'bill', billBody(cid('f'), [
    { productId: glass.id, qty: 1, unitPaise: 15000 },
    { productId: cover.id, qty: 2, unitPaise: 25000 },
    { productId: cover.id, qty: 2, unitPaise: 25000 }          /* same product twice: 4 > 3 */
  ]));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'insufficient-stock');
  assert.deepEqual(r.body.shortfalls.map(s => [s.productId, s.available, s.requested]), [[cover.id, 3, 4]]);
  const st = await w.get(w.tokA, 'state');
  assert.equal(st.body.products.find(p => p.id === glass.id).qty, 10, 'nothing deducted');
  assert.equal(st.body.shop.billCount, 0, 'no number used');
});

test('bill: archived products cannot be sold; empty and malformed bills are refused', async () => {
  const w = world();
  const { glass } = await seedShop(w, w.tokA);
  await w.post(w.tokA, 'product', { action: 'archive', productId: glass.id, archived: true });
  const r = await w.post(w.tokA, 'bill', billBody(cid('f'), [{ productId: glass.id, qty: 1, unitPaise: 1 }]));
  assert.equal(r.body.error, 'product-archived');
  assert.equal((await w.post(w.tokA, 'bill', billBody(cid('f'), []))).body.error, 'bill-empty');
  assert.equal((await w.post(w.tokA, 'bill', billBody('short', [{ name: 'x', qty: 1, unitPaise: 1 }]))).body.error, 'finalisation-id');
  assert.equal((await w.post(w.tokA, 'bill', billBody(cid('f'), [{ name: 'x', qty: 1, unitPaise: 100 }],
    { discount: { mode: 'amount', value: 200 } }))).body.error, 'bill-discount-too-large');
});

test('bill: save, reopen, record a payment, search by number, name and mobile', async () => {
  const w = world();
  const { glass } = await seedShop(w, w.tokA);
  const saved = await w.post(w.tokA, 'bill', billBody(cid('f'), [{ productId: glass.id, qty: 1, unitPaise: 15000 }], {
    customer: { name: 'Meena Stores', mobile: '9000012345' }, payment: { method: 'upi', status: 'partial', receivedPaise: 5000 }
  }));
  const id = saved.body.bill.id;
  assert.equal(saved.body.bill.payment.status, 'partial');
  assert.equal(saved.body.bill.payment.balancePaise, 10000);

  const open = await w.get(w.tokA, 'bill', { id });
  assert.equal(open.status, 200);
  assert.equal(open.body.bill.items[0].name, 'Redmi 13C Glass');
  assert.equal(open.body.bill.ownerUid, undefined, 'internal fields are not sent');

  const pay = await w.post(w.tokA, 'bill', { action: 'payment', billId: id, payment: { method: 'cash', status: 'paid' } });
  assert.equal(pay.body.bill.payment.status, 'paid');
  assert.equal(pay.body.bill.history.map(h => h.action).join(','), 'created,payment');

  const byNum = await w.get(w.tokA, 'bills', { q: 'QB-0001' });
  assert.equal(byNum.body.bills.length, 1);
  assert.equal((await w.get(w.tokA, 'bills', { q: '1' })).body.bills.length, 1);
  assert.equal((await w.get(w.tokA, 'bills', { q: 'meena' })).body.bills.length, 1);
  assert.equal((await w.get(w.tokA, 'bills', { q: '900001' })).body.bills.length, 1);
  assert.equal((await w.get(w.tokA, 'bills', { q: 'ravi' })).body.bills.length, 0);
});

test('bill history pages newest first', async () => {
  const w = world();
  const { glass } = await seedShop(w, w.tokA);
  for (let i = 0; i < 7; i++) {
    await w.post(w.tokA, 'bill', billBody(cid('f'), [{ productId: glass.id, qty: 1, unitPaise: 100 }]));
  }
  const p1 = await w.get(w.tokA, 'bills', { limit: '5' });
  assert.deepEqual(p1.body.bills.map(b => b.seq), [7, 6, 5, 4, 3]);
  assert.equal(p1.body.nextCursor, 3);
  const p2 = await w.get(w.tokA, 'bills', { limit: '5', cursor: String(p1.body.nextCursor) });
  assert.deepEqual(p2.body.bills.map(b => b.seq), [2, 1]);
  assert.equal(p2.body.nextCursor, null);
});

test('void restores stock exactly once, keeps the bill, and is audited', async () => {
  const w = world();
  const { glass, cover } = await seedShop(w, w.tokA);
  const saved = await w.post(w.tokA, 'bill', billBody(cid('f'), [
    { productId: glass.id, qty: 4, unitPaise: 15000 }, { productId: cover.id, qty: 1, unitPaise: 25000 },
    { name: 'Service', qty: 1, unitPaise: 1000 }
  ]));
  const id = saved.body.bill.id;
  assert.equal((await w.post(w.tokA, 'bill', { action: 'void', billId: id })).body.error, 'void-reason');

  const [v1, v2] = await Promise.all([
    w.post(w.tokA, 'bill', { action: 'void', billId: id, reason: 'Customer returned' }),
    w.post(w.tokA, 'bill', { action: 'void', billId: id, reason: 'Customer returned' })
  ]);
  assert.equal(v1.status, 200);
  assert.equal(v2.status, 200);
  const st = await w.get(w.tokA, 'state');
  assert.equal(st.body.products.find(p => p.id === glass.id).qty, 10, 'back to the opening stock, once');
  assert.equal(st.body.products.find(p => p.id === cover.id).qty, 3);
  assert.equal(st.body.products.find(p => p.id === glass.id).soldCount, 0);

  const open = await w.get(w.tokA, 'bill', { id });
  assert.equal(open.body.bill.status, 'void');
  assert.equal(open.body.bill.voidReason, 'Customer returned');
  assert.equal(open.body.bill.number, 'QB-0001', 'still there, still numbered');
  assert.deepEqual(open.body.bill.history.map(h => h.action), ['created', 'void']);
  const moves = (await w.get(w.tokA, 'moves', { productId: glass.id })).body.moves;
  assert.deepEqual(moves.map(m => m.reason).sort(), ['opening', 'sale', 'void']);

  assert.equal((await w.post(w.tokA, 'bill', { action: 'payment', billId: id, payment: { status: 'paid' } })).body.error, 'bill-void');
});

test('isolation: one shop can read and touch nothing of another', async () => {
  const w = world();
  const a = await seedShop(w, w.tokA);
  const billA = (await w.post(w.tokA, 'bill', billBody(cid('f'), [{ productId: a.glass.id, qty: 1, unitPaise: 15000 }]))).body.bill;

  const stB = await w.get(w.tokB, 'state');
  assert.equal(stB.body.products.length, 0);
  assert.equal(stB.body.categories.length, 0);
  assert.equal((await w.get(w.tokB, 'bills')).body.bills.length, 0);
  assert.equal((await w.get(w.tokB, 'bill', { id: billA.id })).status, 404);
  assert.equal((await w.get(w.tokB, 'moves', { productId: a.glass.id })).status, 404);

  /* B tries to sell, edit, adjust, archive and void A's things */
  const sell = await w.post(w.tokB, 'bill', billBody(cid('f'), [{ productId: a.glass.id, qty: 1, unitPaise: 1 }]));
  assert.equal(sell.status, 409);
  assert.equal(sell.body.error, 'product-missing');
  assert.equal((await w.post(w.tokB, 'product', { action: 'update', productId: a.glass.id, name: 'pwned' })).status, 404);
  assert.equal((await w.post(w.tokB, 'product', { action: 'adjust', productId: a.glass.id, adjustId: cid('adj'), delta: -1 })).status, 404);
  assert.equal((await w.post(w.tokB, 'product', { action: 'archive', productId: a.glass.id, archived: true })).status, 404);
  assert.equal((await w.post(w.tokB, 'bill', { action: 'void', billId: billA.id, reason: 'x' })).status, 404);
  assert.equal((await w.post(w.tokB, 'category', { action: 'rename', categoryId: a.catId, name: 'x' })).status, 404);
  assert.equal((await w.post(w.tokB, 'category', { action: 'delete', categoryId: a.catId })).status, 404);
  /* B re-using A's finalisation id makes B's own bill, it does not replay A's */
  const reuse = await w.post(w.tokB, 'bill', billBody(billA.id, [{ name: 'Mine', qty: 1, unitPaise: 100 }]));
  assert.equal(reuse.status, 200);
  assert.equal(reuse.body.replayed, false);
  assert.equal(reuse.body.bill.number, 'QB-0001', 'B has its own counter');
  /* a uid smuggled in the body changes nothing */
  const smuggle = await w.post(w.tokB, 'category', { action: 'create', name: 'Sneaky', ownerUid: 'shopAAAAAA', uid: 'shopAAAAAA' });
  assert.equal(smuggle.status, 200);
  assert.equal((await w.get(w.tokA, 'state')).body.categories.some(c => c.name === 'Sneaky'), false);

  const stA = await w.get(w.tokA, 'state');
  assert.equal(stA.body.products.find(p => p.id === a.glass.id).name, 'Redmi 13C Glass');
  assert.equal(stA.body.products.find(p => p.id === a.glass.id).qty, 9);
  assert.equal((await w.get(w.tokA, 'bill', { id: billA.id })).body.bill.status, 'final');
});

test('a document carrying another owner is refused even under the right path', async () => {
  const w = world();
  w.fb.firestore.seed('shops/shopBBBBBB/products/planted0000001', {
    ownerUid: 'shopAAAAAA', name: 'planted', pricePaise: 1, qty: 5, active: true
  });
  const st = await w.get(w.tokB, 'state');
  assert.equal(st.body.products.length, 0);
  const sell = await w.post(w.tokB, 'bill', billBody(cid('f'), [{ productId: 'planted0000001', qty: 1, unitPaise: 1 }]));
  assert.equal(sell.body.error, 'product-missing');
});

test('a failed photo upload creates no product', async () => {
  const w = world();
  const cat = (await w.post(w.tokA, 'category', { action: 'create', name: 'Battery' })).body.category.id;
  w.fb.storage.bucket.failNext = true;
  const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(100, 2)]).toString('base64');
  const r = await w.post(w.tokA, 'product', { action: 'create', productId: cid('p'), name: 'Batt', pricePaise: 100, qty: 1,
    categoryId: cat, image: { type: 'image/jpeg', data: jpeg } });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'image-upload-failed');
  assert.equal((await w.get(w.tokA, 'state')).body.products.length, 0);
});
