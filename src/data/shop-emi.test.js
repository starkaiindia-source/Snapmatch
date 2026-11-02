/* ============================================================================
   src/data/shop-emi.test.js
   ----------------------------------------------------------------------------
   What an instalment plan comes to. The sheet shows these amounts and the server
   works them out again when the bill is saved.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./shop-emi');

const base = { principalPaise: 1000000, months: 6, rateBp: 1200, method: 'flat', firstDue: '2026-12-02' };
const sum = (p, k) => p.schedule.reduce((n, s) => n + s[k], 0);

test('flat interest is on the whole amount for the whole term', () => {
  const p = E.plan(base);
  assert.equal(p.interestPaise, 60000, '₹10,000 at 12% for 6 months is ₹600');
  assert.equal(p.totalPaise, 1060000);
  assert.equal(p.emiPaise, 176667);
  assert.equal(p.schedule.length, 6);
});

test('reducing interest is on what is still owed', () => {
  const p = E.plan(Object.assign({}, base, { method: 'reducing' }));
  assert.equal(p.emiPaise, 172548, 'the standard EMI formula');
  assert.equal(p.schedule[0].interestPaise, 10000, '1% of ₹10,000 in the first month');
  assert.ok(p.schedule[5].interestPaise < p.schedule[0].interestPaise);
  assert.ok(p.interestPaise < E.plan(base).interestPaise, 'cheaper than flat at the same rate');
});

test('a schedule always adds up, whatever the rounding', () => {
  [['flat', 1200], ['reducing', 1800], ['flat', 0], ['reducing', 999]].forEach(([method, rateBp]) => {
    [1, 3, 7, 11, 24].forEach(months => {
      const p = E.plan({ principalPaise: 100001, months, rateBp, method, firstDue: '2026-01-31' });
      assert.equal(sum(p, 'principalPaise'), 100001, method + ' ' + months);
      assert.equal(sum(p, 'interestPaise'), p.interestPaise);
      assert.equal(sum(p, 'amountPaise'), p.totalPaise);
      assert.ok(p.schedule.every(s => s.principalPaise >= 0 && s.interestPaise >= 0));
    });
  });
});

test('no interest splits the amount evenly', () => {
  const p = E.plan(Object.assign({}, base, { rateBp: 0, principalPaise: 600000 }));
  assert.equal(p.interestPaise, 0);
  assert.ok(p.schedule.every(s => s.amountPaise === 100000));
  assert.equal(E.effectiveBp(p), 0);
});

test('due dates fall on the same day each month, or the last day of a short one', () => {
  const p = E.plan(Object.assign({}, base, { firstDue: '2026-01-31', months: 4 }));
  assert.deepEqual(p.schedule.map(s => s.due), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.equal(E.addMonths('2026-11-15', 2), '2027-01-15', 'across a year');
  assert.equal(E.addMonths('2028-01-31', 1), '2028-02-29', 'a leap year');
});

test('a flat rate costs about twice what it says', () => {
  const eff = E.effectiveBp(E.plan(base));
  assert.ok(eff > 2000 && eff < 2100, String(eff));
  const same = E.effectiveBp(E.plan(Object.assign({}, base, { method: 'reducing' })));
  assert.ok(Math.abs(same - 1200) <= 2, String(same));
});

test('the next instalment is the first one not paid', () => {
  const p = E.plan(base);
  assert.equal(E.nextDue(p).no, 1);
  p.schedule[0].paidAt = 1;
  assert.equal(E.nextDue(p).no, 2);
  p.schedule.forEach(s => { s.paidAt = 1; });
  assert.equal(E.nextDue(p), null);
});
