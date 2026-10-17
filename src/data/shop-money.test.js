/* ============================================================================
   src/data/shop-money.test.js
   ----------------------------------------------------------------------------
   Quick Billing's money maths: integer paise, no floats, one rounding rule.
   The same module draws the live invoice in the browser and recomputes the
   saved bill on the server, so these are the numbers both of them print.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./shop-money');

test('rupees typed by a person become exact paise', () => {
  assert.equal(M.parseRupees('120'), 12000);
  assert.equal(M.parseRupees('120.5'), 12050);
  assert.equal(M.parseRupees('120.05'), 12005);
  assert.equal(M.parseRupees('1,250.00'), 125000);
  assert.equal(M.parseRupees('₹ 99'), 9900);
  assert.equal(M.parseRupees('0.10'), 10);
  assert.equal(M.parseRupees('.'), null);
  assert.equal(M.parseRupees(''), null);
  assert.equal(M.parseRupees('12.345'), null, 'a third decimal is a typo, not a rounding job');
  assert.equal(M.parseRupees('-5'), null);
  assert.equal(M.parseRupees('abc'), null);
  assert.equal(M.parseRupees('1e3'), null);
});

test('the classic float traps come out exact', () => {
  /* 0.1 + 0.2 and 1.15 × 3 are the two that print wrong as floats */
  const r = M.computeBill([{ unitPaise: M.parseRupees('0.10'), qty: 1 }, { unitPaise: M.parseRupees('0.20'), qty: 1 }]);
  assert.equal(r.totalPaise, 30);
  assert.equal(M.format(r.totalPaise), '0.30');
  const s = M.computeBill([{ unitPaise: M.parseRupees('1.15'), qty: 3 }]);
  assert.equal(s.totalPaise, 345);
});

test('Indian digit grouping, always two decimals', () => {
  assert.equal(M.format(0), '0.00');
  assert.equal(M.format(5), '0.05');
  assert.equal(M.format(99999), '999.99');
  assert.equal(M.format(100000), '1,000.00');
  assert.equal(M.format(12345678), '1,23,456.78');
  assert.equal(M.format(1234567890), '1,23,45,678.90');
  assert.equal(M.inr(125000), '₹1,250.00');
  assert.equal(M.toInput(125000), '1250');
  assert.equal(M.toInput(12505), '125.05');
});

test('lines, discount and no tax by default', () => {
  const r = M.computeBill(
    [{ unitPaise: 29900, qty: 2 }, { unitPaise: 15050, qty: 1 }],
    { mode: 'amount', value: 5000 }
  );
  assert.ok(r.ok);
  assert.deepEqual(r.lineTotals, [59800, 15050]);
  assert.equal(r.subtotalPaise, 74850);
  assert.equal(r.discountPaise, 5000);
  assert.equal(r.taxPaise, 0, 'no tax unless the bill asks for it');
  assert.equal(r.totalPaise, 69850);
});

test('percentage discount rounds half-up, once', () => {
  /* 10% of 999 paise is 99.9 → 100 */
  assert.equal(M.computeBill([{ unitPaise: 999, qty: 1 }], { mode: 'percent', value: 1000 }).discountPaise, 100);
  /* 12.5% of 100 paise is 12.5 → 13 */
  assert.equal(M.computeBill([{ unitPaise: 100, qty: 1 }], { mode: 'percent', value: 1250 }).discountPaise, 13);
});

test('a discount larger than the bill is refused, not clamped', () => {
  const r = M.computeBill([{ unitPaise: 1000, qty: 1 }], { mode: 'amount', value: 1001 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'discount-too-large');
});

test('exclusive tax is added on top of the discounted subtotal', () => {
  const r = M.computeBill([{ unitPaise: 100000, qty: 1 }], { mode: 'amount', value: 10000 }, { rateBp: 1800 });
  assert.equal(r.taxablePaise, 90000);
  assert.equal(r.taxPaise, 16200);
  assert.equal(r.totalPaise, 106200);
});

test('inclusive tax is carved out of the total and adds back exactly', () => {
  /* ₹118 including 18%: ₹100 + ₹18 */
  const r = M.computeBill([{ unitPaise: 11800, qty: 1 }], null, { rateBp: 1800, inclusive: true });
  assert.equal(r.totalPaise, 11800);
  assert.equal(r.taxPaise, 1800);
  /* an awkward one: the parts always sum to the total */
  for (const p of [1, 99, 101, 999, 12345, 777777]) {
    const x = M.computeBill([{ unitPaise: p, qty: 1 }], null, { rateBp: 1800, inclusive: true });
    assert.equal(x.totalPaise, p);
    assert.ok(x.taxPaise >= 0 && x.taxPaise <= p);
    assert.ok(M.isInt(x.taxPaise));
  }
});

test('received, balance and change', () => {
  const lines = [{ unitPaise: 50000, qty: 1 }];
  const paid = M.computeBill(lines, null, null, 60000);
  assert.equal(paid.changePaise, 10000);
  assert.equal(paid.balancePaise, 0);
  const part = M.computeBill(lines, null, null, 20000);
  assert.equal(part.balancePaise, 30000);
  assert.equal(part.changePaise, 0);
  assert.equal(M.statusFor(50000, 0), 'unpaid');
  assert.equal(M.statusFor(50000, 20000), 'partial');
  assert.equal(M.statusFor(50000, 50000), 'paid');
  assert.equal(M.statusFor(50000, 60000), 'paid');
  assert.equal(M.statusFor(0, 0), 'paid', 'a zero bill owes nothing');
});

test('bad lines are refused with the line that is wrong', () => {
  assert.equal(M.computeBill([{ unitPaise: 10.5, qty: 1 }]).error, 'price');
  assert.equal(M.computeBill([{ unitPaise: 100, qty: 0 }]).error, 'qty');
  assert.equal(M.computeBill([{ unitPaise: 100, qty: 1 }, { unitPaise: 100, qty: 1.5 }]).line, 1);
  assert.equal(M.computeBill([{ unitPaise: -1, qty: 1 }]).error, 'price');
  assert.equal(M.computeBill('nope').ok, false);
});

test('every intermediate stays inside exact integer range', () => {
  const big = M.computeBill(
    Array.from({ length: 10 }, () => ({ unitPaise: M.MAX_UNIT_PAISE, qty: 1 })),
    { mode: 'percent', value: 333 }, { rateBp: 2800, inclusive: true }
  );
  assert.ok(big.ok);
  assert.ok(Number.isSafeInteger(big.subtotalPaise * 10000 * 2));
  const tooBig = M.computeBill([{ unitPaise: M.MAX_UNIT_PAISE, qty: 11 }]);
  assert.equal(tooBig.error, 'total-too-large');
});

test('bill numbers are padded, never truncated', () => {
  assert.equal(M.billNumber('QB', 1), 'QB-0001');
  assert.equal(M.billNumber('QB', 9999), 'QB-9999');
  assert.equal(M.billNumber('QB', 10000), 'QB-10000');
});

test('percent input becomes basis points', () => {
  assert.equal(M.parsePercent('18'), 1800);
  assert.equal(M.parsePercent('12.5'), 1250);
  assert.equal(M.parsePercent('100'), 10000);
  assert.equal(M.parsePercent('101'), null);
  assert.equal(M.parsePercent('5.555'), null);
});
