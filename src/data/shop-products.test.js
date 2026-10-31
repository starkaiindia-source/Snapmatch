/* ============================================================================
   src/data/shop-products.test.js
   ----------------------------------------------------------------------------
   The Products page's search, filters and column choices. The table and the
   grid both draw what filterProducts returns, so these rules are what both
   views show.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./shop-products');
const M = require('./shop-money');

const CATS = { glass: 'Tempered Glass', phones: 'Mobiles', cable: 'Cable' };
const COMPAT = { glass: true };
const ctx = {
  categoryName: id => CATS[id] || '',
  brandName: id => ({ vivo: 'Vivo', realme: 'Realme' }[id] || id),
  compatOn: id => !!COMPAT[id],
  rupees: M.parseRupees
};

const glass = {
  id: 'p1', name: 'Realme 5 Tempered Glass Clear', categoryId: 'glass', active: true, qty: 30, lowStockAt: 1,
  pricePaise: 29900, sku: 'TG-R5', shelf: 'A3', groupIds: ['sg-0167'], variants: [], master: null
};
const phone = {
  id: 'p2', name: 'vivo Y20', categoryId: 'phones', active: true, qty: 7, lowStockAt: 1, pricePaise: 899900,
  sku: '', shelf: '', groupIds: [],
  master: { id: 'vivo-y20', name: 'vivo Y20', brandId: 'vivo' },
  variants: [
    { id: 'v1', ram: '3 GB', storage: '32 GB', label: '', sku: 'Y20-32', shelf: 'M1', qty: 5 },
    { id: 'v2', ram: '4 GB', storage: '64 GB', label: '', sku: 'Y20-64', shelf: 'M2', qty: 2 }
  ]
};
const unlinked = {
  id: 'p3', name: 'Redmi 9 Glass', categoryId: 'glass', active: true, qty: 1, lowStockAt: 2, pricePaise: 24900,
  sku: 'TG-R9', shelf: 'A3', groupIds: [], variants: [], master: null
};
const cable = {
  id: 'p4', name: 'Type C Cable', categoryId: 'cable', active: true, qty: 0, lowStockAt: 1, pricePaise: 14900,
  sku: '', shelf: 'B1', groupIds: [], variants: [], master: null
};
const retired = {
  id: 'p5', name: 'Old Charger', categoryId: 'cable', active: false, qty: 4, lowStockAt: 1, pricePaise: 9900,
  sku: '', shelf: '', groupIds: [], variants: [], master: null
};
const ALL = [glass, phone, unlinked, cable, retired];

const names = (f) => P.filterProducts(ALL, Object.assign(P.blankFilter(), f), ctx).map(p => p.id).sort();

test('the default view shows active products, by name', () => {
  const list = P.filterProducts(ALL, P.blankFilter(), ctx);
  assert.deepEqual(list.map(p => p.id), ['p1', 'p3', 'p4', 'p2']);
});

test('search reaches the name, model, brand, SKU, shelf, category and variants', () => {
  assert.deepEqual(names({ q: 'tempered' }), ['p1', 'p3']);
  assert.deepEqual(names({ q: 'TG-R9' }), ['p3']);
  assert.deepEqual(names({ q: 'a3' }), ['p1', 'p3']);
  assert.deepEqual(names({ q: 'vivo' }), ['p2'], 'model and brand');
  assert.deepEqual(names({ q: 'realme clear' }), ['p1'], 'every word must match');
  assert.deepEqual(names({ q: '64 gb' }), ['p2'], 'variant storage');
  assert.deepEqual(names({ q: 'y20-32' }), ['p2'], 'variant SKU');
  assert.deepEqual(names({ q: 'm2' }), ['p2'], 'variant shelf');
  assert.deepEqual(names({ q: 'nothing like this' }), []);
});

test('the status filter keeps inactive records reachable without changing them', () => {
  assert.deepEqual(names({ status: 'inactive' }), ['p5']);
  assert.deepEqual(names({ status: 'all' }), ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.equal(retired.active, false);
});

test('stock filters read the same levels the table labels', () => {
  assert.deepEqual(names({ stock: 'in' }), ['p1', 'p2', 'p3']);
  assert.deepEqual(names({ stock: 'low' }), ['p3']);
  assert.deepEqual(names({ stock: 'out' }), ['p4']);
  assert.equal(P.stockLevel(glass), 'in');
  assert.equal(P.stockLevel(unlinked), 'low');
  assert.equal(P.stockLevel(cable), 'out');
});

test('no compatibility groups means a gap, not a category that has none', () => {
  assert.deepEqual(names({ compat: 'has' }), ['p1']);
  assert.deepEqual(names({ compat: 'none' }), ['p3'], 'Mobiles and Cable do not use groups');
});

test('category, brand, shelf and price narrow the list', () => {
  assert.deepEqual(names({ cat: 'glass' }), ['p1', 'p3']);
  assert.deepEqual(names({ brand: 'vivo' }), ['p2']);
  assert.deepEqual(names({ shelf: 'B1' }), ['p4']);
  assert.deepEqual(names({ shelf: 'M1' }), ['p2'], 'a shelf on a variant');
  assert.deepEqual(names({ min: '200', max: '300' }), ['p1', 'p3']);
  assert.deepEqual(names({ min: 'abc' }), ['p1', 'p2', 'p3', 'p4'], 'an unreadable price is ignored');
});

test('search and filters apply together', () => {
  assert.deepEqual(names({ q: 'glass', stock: 'low', compat: 'none', cat: 'glass' }), ['p3']);
  assert.deepEqual(names({ q: 'glass', stock: 'out' }), []);
});

test('the active filter count leaves out the default view and the search', () => {
  assert.equal(P.activeCount(P.blankFilter()), 0);
  assert.equal(P.activeCount(Object.assign(P.blankFilter(), { q: 'glass' })), 0);
  assert.equal(P.activeCount(Object.assign(P.blankFilter(), { stock: 'low', cat: 'glass' })), 2);
  assert.equal(P.activeCount(Object.assign(P.blankFilter(), { min: '100', max: '200' })), 1, 'a price range is one filter');
  assert.equal(P.activeCount(Object.assign(P.blankFilter(), { status: 'inactive' })), 1);
  assert.equal(P.activeCount(P.clearedFilter()), 0, 'Clear All leaves nothing narrowing the list');
});

test('filter options come from the products themselves', () => {
  const o = P.options(ALL);
  assert.deepEqual(o.brands, ['vivo']);
  assert.deepEqual(o.shelves, ['A3', 'B1', 'M1', 'M2']);
});

test('saved column choices survive junk and new columns', () => {
  assert.deepEqual(P.readColumns(null), P.defaultColumns());
  assert.deepEqual(P.readColumns('not json'), P.defaultColumns());
  assert.deepEqual(P.readColumns('[1,2]').sku, true);
  const c = P.readColumns(JSON.stringify({ sku: false, created: true, bogus: true, stock: 'no' }));
  assert.equal(c.sku, false);
  assert.equal(c.created, true);
  assert.equal(c.stock, true, 'a value of the wrong type is ignored');
  assert.equal(c.bogus, undefined);
  assert.equal(P.defaultColumns().created, false);
});
