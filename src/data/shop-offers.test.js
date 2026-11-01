/* ============================================================================
   src/data/shop-offers.test.js
   ----------------------------------------------------------------------------
   Which offers a bill gets. The cart shows these results and the server works
   them out again when a bill is confirmed, so these are the amounts both print.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('./shop-offers');
const M = require('./shop-money');

const NOW = Date.parse('2026-11-02T12:00:00+05:30');
const HOUR = 3600 * 1000;

const offer = (id, extra) => Object.assign({
  id, name: id, kind: 'percent', percentBp: 1000, target: 'category', categoryIds: ['glass'],
  productIds: [], variants: [], minQty: 1, minBillPaise: 0, priority: 100, stackable: false,
  autoApply: true, status: 'active', startAt: null, endAt: null
}, extra);

const glass = { key: 'a', productId: 'p1', variantId: null, categoryId: 'glass', unitPaise: 29900, qty: 1 };
const phone = { key: 'b', productId: 'p2', variantId: 'v2', categoryId: 'phones', unitPaise: 1099900, qty: 1 };

const price = (offers, lines, extra) => O.applyOffers(Object.assign({ offers, lines, now: NOW }, extra));
const first = (offers, line, extra) => price(offers, [line], extra).lines[0];

test('a percentage comes off each unit, as the spec example', () => {
  const r = first([offer('ten')], Object.assign({}, glass, { qty: 2 }));
  assert.equal(r.offerPaise, 5980);
  assert.equal(r.finalUnitPaise, 26910);
  assert.equal(r.linePaise, 53820);
  assert.equal(r.applied[0].name, 'ten');
  assert.equal(r.applied[0].level, 'category');
});

test('a percentage on an odd price is rounded once, per unit', () => {
  const r = first([offer('x', { percentBp: 333 })], Object.assign({}, glass, { unitPaise: 999, qty: 3 }));
  assert.equal(r.offerPaise, 33 * 3);
});

test('a maximum discount caps the line', () => {
  const o = offer('capped', { maxPaise: 10000, target: 'product', productIds: ['p2'] });
  assert.equal(first([o], phone).offerPaise, 10000);
  assert.equal(first([offer('small', { maxPaise: 1000 })], glass).offerPaise, 1000);
});

test('fixed per unit and fixed per line are different sums', () => {
  const line = Object.assign({}, glass, { qty: 3 });
  const each = offer('each', { kind: 'fixed', amountPaise: 5000, fixedMode: 'unit' });
  const whole = offer('whole', { kind: 'fixed', amountPaise: 5000, fixedMode: 'line' });
  assert.equal(first([each], line).offerPaise, 15000);
  assert.equal(first([whole], line).offerPaise, 5000);
});

test('a price can reach zero and never go below it', () => {
  const free = offer('free', { kind: 'percent', percentBp: 10000 });
  assert.equal(first([free], glass).linePaise, 0);
  const exact = offer('exact', { kind: 'fixed', amountPaise: 29900, fixedMode: 'unit' });
  assert.equal(first([exact], glass).linePaise, 0);
});

test('a fixed amount larger than the price is not applied at all', () => {
  const big = offer('big', { kind: 'fixed', amountPaise: 50000, fixedMode: 'unit' });
  const r = first([big], glass);
  assert.equal(r.offerPaise, 0);
  assert.equal(r.options[0].why, 'too-large');
  const line = offer('line', { kind: 'fixed', amountPaise: 50000, fixedMode: 'line' });
  assert.equal(first([line], glass).offerPaise, 0);
  assert.equal(first([line], Object.assign({}, glass, { qty: 2 })).offerPaise, 50000, 'the line can carry it');
});

test('a category offer reaches whatever is in the category, and nothing else', () => {
  const newProduct = Object.assign({}, glass, { productId: 'added-later' });
  assert.equal(first([offer('c')], newProduct).offerPaise, 2990);
  assert.equal(first([offer('c')], phone).offerPaise, 0);
});

test('a variant offer reaches that variant only', () => {
  const o = offer('v', { target: 'variant', variants: [{ productId: 'p2', variantId: 'v2' }] });
  assert.equal(first([o], phone).applied[0].level, 'variant');
  assert.equal(first([o], Object.assign({}, phone, { variantId: 'v1' })).offerPaise, 0);
  assert.equal(first([o], Object.assign({}, phone, { productId: 'p3' })).offerPaise, 0);
});

test('a product offer reaches every variant of the product', () => {
  const o = offer('p', { target: 'product', productIds: ['p2'] });
  assert.equal(first([o], Object.assign({}, phone, { variantId: 'v1' })).applied[0].level, 'product');
});

test('a custom item never gets an offer', () => {
  const custom = { key: 'x', productId: null, variantId: null, categoryId: null, unitPaise: 5000, qty: 1 };
  assert.equal(first([offer('c', { categoryIds: [null] })], custom).offerPaise, 0);
});

test('the most specific offer wins and the others say why they did not', () => {
  const line = { key: 'a', productId: 'p1', variantId: 'v1', categoryId: 'glass', unitPaise: 30000, qty: 1 };
  const offers = [
    offer('category'),
    offer('product', { kind: 'fixed', amountPaise: 5000, target: 'product', productIds: ['p1'] }),
    offer('variant', { percentBp: 500, target: 'variant', variants: [{ productId: 'p1', variantId: 'v1' }] })
  ];
  const r = first(offers, line);
  assert.deepEqual(r.applied.map(a => a.id), ['variant'], 'even though the others are worth more');
  assert.equal(r.offerPaise, 1500);
  const lost = r.options.filter(o => o.why === 'lost');
  assert.equal(lost.length, 2);
  assert.equal(lost[0].beatenBy, 'variant');
});

test('within a level the priority number decides, then the larger discount', () => {
  const low = offer('low', { percentBp: 500, priority: 10 });
  const high = offer('high', { percentBp: 2000, priority: 50 });
  assert.equal(first([high, low], glass).applied[0].id, 'low');
  const a = offer('a', { percentBp: 500 });
  const b = offer('b', { percentBp: 2000 });
  assert.equal(first([a, b], glass).applied[0].id, 'b');
});

test('the shop can put the priority number ahead of the level', () => {
  const category = offer('category', { priority: 1 });
  const product = offer('product', { priority: 50, target: 'product', productIds: ['p1'] });
  assert.equal(first([category, product], glass).applied[0].id, 'product');
  assert.equal(first([category, product], glass, { settings: { order: 'priority' } }).applied[0].id, 'category');
});

test('offers never combine unless the shop says so and both may', () => {
  const a = offer('a', { stackable: true, target: 'product', productIds: ['p1'] });
  const b = offer('b', { stackable: true });
  const c = offer('c', { stackable: false, percentBp: 500 });
  assert.equal(first([a, b], glass).applied.length, 1, 'off by default');
  const on = { settings: { stacking: true } };
  const r = first([a, b, c], glass, on);
  assert.deepEqual(r.applied.map(x => x.id), ['a', 'b'], 'the one that is not stackable stays out');
  assert.equal(r.applied[1].discountPaise, 2691, 'the second comes off what the first left');
  assert.equal(r.offerPaise, 2990 + 2691);
  assert.equal(r.options.find(o => o.id === 'c').why, 'lost');
});

test('combined offers cannot take a line below zero', () => {
  const on = { settings: { stacking: true } };
  const a = offer('a', { stackable: true, percentBp: 9000, target: 'product', productIds: ['p1'] });
  const b = offer('b', { stackable: true, kind: 'fixed', amountPaise: 29900, fixedMode: 'unit' });
  const r = first([a, b], glass, on);
  assert.equal(r.linePaise, 0);
  assert.equal(r.offerPaise, 29900);
});

test('an offer applies once to a line', () => {
  const r = first([offer('same')], glass, { settings: { stacking: true } });
  assert.equal(r.applied.length, 1);
});

test('paused, expired and future offers are never applied', () => {
  assert.equal(first([offer('p', { status: 'paused' })], glass).offerPaise, 0);
  assert.equal(first([offer('e', { status: 'expired' })], glass).offerPaise, 0);
  assert.equal(first([offer('old', { endAt: NOW - HOUR })], glass).offerPaise, 0);
  assert.equal(first([offer('soon', { startAt: NOW + HOUR })], glass).offerPaise, 0);
  assert.equal(first([offer('now', { startAt: NOW - HOUR, endAt: NOW + HOUR })], glass).offerPaise, 2990);
});

test('an offer knows what it is at any moment', () => {
  assert.equal(O.offerStatus(offer('x'), NOW), 'active');
  assert.equal(O.offerStatus(offer('x', { status: 'paused' }), NOW), 'paused');
  assert.equal(O.offerStatus(offer('x', { status: 'paused', startAt: NOW + HOUR }), NOW), 'paused');
  assert.equal(O.offerStatus(offer('x', { status: 'paused', endAt: NOW - HOUR }), NOW), 'expired', 'its validity has ended');
  assert.equal(O.offerStatus(offer('x', { endAt: NOW - 1 }), NOW), 'expired');
  assert.equal(O.offerStatus(offer('x', { endAt: NOW }), NOW), 'active');
  assert.equal(O.offerStatus(offer('x', { startAt: NOW + 1 }), NOW), 'scheduled');
  assert.equal(O.offerStatus(offer('x', { status: 'archived' }), NOW), 'archived');
});

test('a removed offer is never applied', () => {
  const r = first([offer('gone', { status: 'archived' })], glass);
  assert.equal(r.offerPaise, 0);
  assert.equal(r.options.length, 0);
});

test('the six figures count what is true now', () => {
  const products = [{ id: 'p1', categoryId: 'glass' }, { id: 'p2', categoryId: 'phones' }, { id: 'p3', categoryId: 'covers' }];
  const t = O.offerTally([
    offer('running'),
    offer('same-category'),
    offer('same-product', { target: 'product', categoryIds: [], productIds: ['p1'] }),
    offer('variant', { target: 'variant', categoryIds: [], variants: [{ productId: 'p2', variantId: 'v2' }] }),
    offer('paused', { status: 'paused', categoryIds: ['covers'] }),
    offer('later', { startAt: NOW + HOUR, categoryIds: ['covers'] }),
    offer('over', { endAt: NOW - HOUR, categoryIds: ['covers'] }),
    offer('ended', { status: 'expired', categoryIds: ['covers'] })
  ], products, NOW);
  assert.deepEqual(t, { total: 8, active: 4, scheduled: 1, expired: 2, paused: 1, products: 2, categories: 1 });
});

test('an offer that is not running covers nothing', () => {
  const t = O.offerTally([offer('over', { status: 'expired', target: 'product', categoryIds: [], productIds: ['p1'] })], [{ id: 'p1', categoryId: 'glass' }], NOW);
  assert.deepEqual(t, { total: 1, active: 0, scheduled: 0, expired: 1, paused: 0, products: 0, categories: 0 });
});

test('a mixed cart: each line is priced alone, then tax on what is left', () => {
  const offers = [offer('glass'), offer('charger', { kind: 'fixed', percentBp: null, amountPaise: 5000, fixedMode: 'unit', categoryIds: ['chargers'] })];
  const lines = [
    Object.assign({}, glass, { qty: 2 }),
    { key: 'c', productId: 'p3', variantId: null, categoryId: 'covers', unitPaise: 19900, qty: 1 },
    { key: 'd', productId: 'p4', variantId: null, categoryId: 'chargers', unitPaise: 49900, qty: 1 },
    { key: 'e', productId: 'p5', variantId: null, categoryId: 'cables', unitPaise: 9900, qty: 3 }
  ];
  const total = (r) => M.computeBill(
    lines.map((l, i) => Object.assign({}, l, { offerPaise: r.lines[i].offerPaise })),
    { mode: 'amount', value: 0 }, { rateBp: 1800 }, 0);

  const all = price(offers, lines);
  assert.deepEqual(all.lines.map(l => l.offerPaise), [5980, 0, 5000, 0]);
  const t = total(all);
  assert.equal(t.originalSubtotalPaise, 59800 + 19900 + 49900 + 29700);
  assert.equal(t.offerPaise, 10980);
  assert.equal(t.subtotalPaise, 148320);
  assert.equal(t.taxPaise, 26698);
  assert.equal(t.totalPaise, 175018);

  /* cancelling the glass offer changes the glass line and nothing else */
  const cancelled = price(offers, lines.map((l, i) => (i === 0 ? Object.assign({}, l, { pick: 'none' }) : l)));
  assert.deepEqual(cancelled.lines.map(l => l.offerPaise), [0, 0, 5000, 0]);
  assert.equal(cancelled.lines[0].linePaise, 59800);
  const after = total(cancelled);
  assert.equal(after.subtotalPaise, 154300);
  assert.equal(after.taxPaise, 27774);
  assert.equal(after.totalPaise, 182074);

  /* and it can be applied again */
  const again = price(offers, lines.map((l, i) => (i === 0 ? Object.assign({}, l, { pick: 'glass' }) : l)));
  assert.deepEqual(again.lines.map(l => l.offerPaise), [5980, 0, 5000, 0]);
});

test('inclusive tax leaves the discounted total alone, so nothing is taxed twice', () => {
  const r = price([offer('glass')], [glass]);
  const t = M.computeBill([Object.assign({}, glass, { offerPaise: r.lines[0].offerPaise })], {}, { rateBp: 1800, inclusive: true }, 0);
  assert.equal(t.totalPaise, 26910);
  assert.equal(t.taxPaise, 4105);
});

test('a minimum quantity counts the same product across lines', () => {
  const o = offer('two', { minQty: 2 });
  assert.equal(first([o], glass).offerPaise, 0);
  assert.equal(first([o], glass).options[0].why, 'min-qty');
  assert.equal(first([o], Object.assign({}, glass, { qty: 2 })).offerPaise, 5980);
  const split = [glass, Object.assign({}, glass, { key: 'c' })];
  assert.equal(price([o], split).offerPaise, 5980, 'two lines of one product asked for two phones');
});

test('a minimum bill value reads the bill before any discount', () => {
  const o = offer('big', { minBillPaise: 50000 });
  assert.equal(first([o], glass).options[0].why, 'min-bill');
  const r = price([o], [glass, phone]);
  assert.equal(r.originalPaise, 1129800);
  assert.equal(r.lines[0].offerPaise, 2990);
});

test('Auto Apply off on the bill stops every automatic offer, and only that', () => {
  const r = first([offer('x')], glass, { auto: false });
  assert.equal(r.offerPaise, 0);
  assert.equal(r.options[0].why, 'bill-auto-off');
  assert.equal(r.options[0].state, 'available');
  assert.equal(r.options[0].discountPaise, 2990, 'it can still say what it would give');
});

test('an offer with Auto Apply off waits to be chosen', () => {
  const o = offer('manual', { autoApply: false });
  assert.equal(first([o], glass).offerPaise, 0);
  assert.equal(first([o], glass).options[0].why, 'offer-auto-off');
  assert.equal(first([o], Object.assign({}, glass, { pick: 'manual' })).offerPaise, 2990);
});

test('with the bill on manual the shop can still choose an offer', () => {
  const r = first([offer('x')], Object.assign({}, glass, { pick: 'x' }), { auto: false });
  assert.equal(r.offerPaise, 2990);
});

test('choosing cannot bypass the rules', () => {
  const pick = id => Object.assign({}, glass, { pick: id });
  assert.equal(first([offer('p', { status: 'paused' })], pick('p')).offerPaise, 0);
  assert.equal(first([offer('e', { endAt: NOW - 1 })], pick('e')).offerPaise, 0);
  assert.equal(first([offer('q', { minQty: 5 })], pick('q')).offerPaise, 0);
  assert.equal(first([offer('m', { minBillPaise: 9999999 })], pick('m')).offerPaise, 0);
  assert.equal(first([offer('o', { categoryIds: ['other'] })], pick('o')).offerPaise, 0);
  assert.equal(first([offer('x')], pick('made-up')).offerPaise, 2990, 'an unknown choice falls back to the rules');
});

test('choosing an offer replaces the winner, and removing leaves the line at full price', () => {
  const offers = [offer('category'), offer('product', { percentBp: 500, target: 'product', productIds: ['p1'] })];
  assert.equal(first(offers, Object.assign({}, glass, { pick: 'category' })).applied[0].id, 'category');
  const none = first(offers, Object.assign({}, glass, { pick: 'none' }));
  assert.equal(none.offerPaise, 0);
  assert.ok(none.options.every(o => o.why === 'removed'));
});

test('the money module carries an offer through to the total', () => {
  const r = price([offer('ten')], [Object.assign({}, glass, { qty: 2 })]);
  const lines = [{ unitPaise: 29900, qty: 2, offerPaise: r.lines[0].offerPaise }];
  const bill = M.computeBill(lines, { mode: 'amount', value: 1000 }, { rateBp: 1800 }, 0);
  assert.equal(bill.originalSubtotalPaise, 59800);
  assert.equal(bill.offerPaise, 5980);
  assert.equal(bill.subtotalPaise, 53820);
  assert.equal(bill.discountPaise, 1000, 'the bill discount comes off what the offers left');
  assert.equal(bill.taxablePaise, 52820);
  assert.equal(bill.taxPaise, 9508, 'tax is on the discounted amount');
  assert.equal(bill.totalPaise, 62328);
  assert.deepEqual(bill.lineTotals, [53820]);
});

test('the money module refuses an offer larger than its line', () => {
  const bad = M.computeBill([{ unitPaise: 100, qty: 1, offerPaise: 101 }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'offer');
  assert.equal(M.computeBill([{ unitPaise: 100, qty: 1, offerPaise: -1 }]).ok, false);
  assert.equal(M.computeBill([{ unitPaise: 100, qty: 1 }]).totalPaise, 100, 'no offer is no change');
});

test('offers read as a shop would say them', () => {
  const inr = M.inr;
  assert.equal(O.valueText(offer('x'), inr), '10% OFF');
  assert.equal(O.valueText(offer('x', { maxPaise: 10000 }), inr), '10% OFF (max ₹100.00)');
  assert.equal(O.valueText(offer('x', { kind: 'fixed', amountPaise: 5000, fixedMode: 'unit' }), inr), '₹50.00 OFF each');
  assert.equal(O.valueText(offer('x', { kind: 'fixed', amountPaise: 5000, fixedMode: 'line' }), inr), '₹50.00 OFF the line');
});

test('coverage follows the same reach as billing', () => {
  const p = { id: 'p1', categoryId: 'glass' };
  assert.ok(O.covers(offer('c'), p));
  assert.ok(O.covers(offer('p', { target: 'product', productIds: ['p1'] }), p));
  assert.ok(O.covers(offer('v', { target: 'variant', variants: [{ productId: 'p1', variantId: 'v' }] }), p));
  assert.equal(O.covers(offer('o', { categoryIds: ['x'] }), p), false);
});
