/* ============================================================================
   src/data/shop-periods.test.js
   ----------------------------------------------------------------------------
   Which day a bill belongs to, and which group it is shown in on the Bills page.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./shop-periods');

const at = (s) => Date.parse(s + '+05:30');
const NOW = at('2026-11-20T15:00:00');      /* a Friday in the third week of November */

const bill = (id, when, extra) => Object.assign({
  id, createdAt: at(when), status: 'final', paymentStatus: 'paid', totalPaise: 10000, receivedPaise: 10000, balancePaise: 0
}, extra);

const ids = g => g.rows.map(r => r.id);
const byId = (groups, id) => groups.filter(g => g.id === id)[0];

test('a day is an Indian day, whatever UTC says', () => {
  assert.equal(P.dayKey(Date.parse('2026-11-14T18:29:59Z')), '2026-11-14');
  assert.equal(P.dayKey(Date.parse('2026-11-14T18:30:00Z')), '2026-11-15', '00:00 IST is the next day');
  assert.equal(P.dayStart('2026-11-15'), Date.parse('2026-11-14T18:30:00Z'));
});

test('named periods run from their first day to their last', () => {
  assert.deepEqual(P.period('today', NOW), { from: '2026-11-20', to: '2026-11-20' });
  assert.deepEqual(P.period('yesterday', NOW), { from: '2026-11-19', to: '2026-11-19' });
  assert.deepEqual(P.period('last7', NOW), { from: '2026-11-14', to: '2026-11-20' });
  assert.deepEqual(P.period('week', NOW), { from: '2026-11-16', to: '2026-11-20' }, 'a week starts on Monday');
  assert.deepEqual(P.period('month', NOW), { from: '2026-11-01', to: '2026-11-20' });
  assert.deepEqual(P.period('lastmonth', NOW), { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(P.period('nonsense', NOW), null);
});

test('periods cross a month, a year and a leap day correctly', () => {
  const jan1 = at('2027-01-01T10:00:00');
  assert.deepEqual(P.period('yesterday', jan1), { from: '2026-12-31', to: '2026-12-31' });
  assert.deepEqual(P.period('lastmonth', jan1), { from: '2026-12-01', to: '2026-12-31' });
  assert.deepEqual(P.period('week', jan1), { from: '2026-12-28', to: '2027-01-01' });
  assert.deepEqual(P.period('lastmonth', at('2028-03-10T10:00:00')), { from: '2028-02-01', to: '2028-02-29' });
  const monday = at('2026-11-16T09:00:00');
  assert.deepEqual(P.period('week', monday), { from: '2026-11-16', to: '2026-11-16' });
});

test('every bill is in exactly one group', () => {
  const bills = [
    bill('today', '2026-11-20T09:00:00'),
    bill('yesterday', '2026-11-19T22:00:00'),
    bill('week-new', '2026-11-18T10:00:00'),
    bill('week-old', '2026-11-14T00:00:00'),
    bill('month-new', '2026-11-13T23:59:00'),
    bill('month-old', '2026-11-01T00:00:00'),
    bill('older', '2026-10-31T23:59:00')
  ];
  const groups = P.groupBills(bills, NOW);
  assert.deepEqual(groups.map(g => g.id), ['today', 'yesterday', 'week', 'month', 'older']);
  assert.deepEqual(ids(byId(groups, 'today')), ['today']);
  assert.deepEqual(ids(byId(groups, 'yesterday')), ['yesterday']);
  assert.deepEqual(ids(byId(groups, 'week')), ['week-new', 'week-old']);
  assert.deepEqual(ids(byId(groups, 'month')), ['month-new', 'month-old']);
  assert.deepEqual(ids(byId(groups, 'older')), ['older']);
  const all = groups.reduce((out, g) => out.concat(ids(g)), []);
  assert.equal(all.length, bills.length);
  assert.equal(new Set(all).size, bills.length, 'no bill appears twice');
});

test('midnight moves a bill from Today to Yesterday, not sooner', () => {
  const b = [bill('late', '2026-11-19T23:59:59'), bill('early', '2026-11-20T00:00:00')];
  const groups = P.groupBills(b, at('2026-11-20T00:00:30'));
  assert.deepEqual(ids(byId(groups, 'today')), ['early']);
  assert.deepEqual(ids(byId(groups, 'yesterday')), ['late']);
});

test('a week reaching into last month keeps those bills in This Week', () => {
  const now = at('2026-11-03T12:00:00');
  const groups = P.groupBills([bill('a', '2026-10-30T12:00:00'), bill('b', '2026-10-26T12:00:00')], now);
  assert.deepEqual(ids(byId(groups, 'week')), ['a']);
  assert.deepEqual(ids(byId(groups, 'month')), []);
  assert.deepEqual(ids(byId(groups, 'older')), ['b']);
  assert.equal(byId(groups, 'older').range, 'Before 28 Oct');
});

test('each group is newest first', () => {
  const groups = P.groupBills([
    bill('one', '2026-11-20T09:00:00'), bill('three', '2026-11-20T14:00:00'), bill('two', '2026-11-20T11:00:00')
  ], NOW);
  assert.deepEqual(ids(groups[0]), ['three', 'two', 'one']);
});

test('a void bill is listed but is not a sale', () => {
  const s = P.billStats([
    bill('paid', '2026-11-20T09:00:00'),
    bill('void', '2026-11-20T09:00:00', { status: 'void', receivedPaise: 10000 }),
    bill('part', '2026-11-20T09:00:00', { paymentStatus: 'partial', receivedPaise: 4000, balancePaise: 6000 }),
    bill('none', '2026-11-20T09:00:00', { paymentStatus: 'unpaid', receivedPaise: 0, balancePaise: 10000 })
  ]);
  assert.deepEqual(s, { bills: 3, voids: 1, salesPaise: 30000, collectedPaise: 14000, outstandingPaise: 16000 });
});

test('change handed back is not money collected', () => {
  const s = P.billStats([bill('over', '2026-11-20T09:00:00', { receivedPaise: 15000 })]);
  assert.equal(s.collectedPaise, 10000);
});

test('a row says void before it says paid', () => {
  assert.equal(P.statusOf({ status: 'void', paymentStatus: 'paid' }), 'void');
  assert.equal(P.statusOf({ status: 'final', paymentStatus: 'partial' }), 'partial');
});
