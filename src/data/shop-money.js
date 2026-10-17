/* ============================================================================
   Mobile Parts Finder · shop-money.js — Quick Billing's money maths
   ----------------------------------------------------------------------------
   One file, loaded by BOTH halves: the browser draws the live invoice with it
   and api/_services/shop-service.js recomputes every saved bill with it. Two
   implementations of "what does this bill come to" is two answers the first
   time they disagree, and the one printed on the customer's receipt would be
   the one the server did not store.

   EVERY AMOUNT IS AN INTEGER NUMBER OF PAISE

     0.1 + 0.2 is 0.30000000000000004 in JavaScript, and a till that adds
     prices as rupee floats prints ₹1,199.9999 or drifts a paisa per line.
     Nothing in here holds a fractional rupee: input is parsed from the text
     the shop typed straight into paise, arithmetic is integer, and percentages
     are basis points (1800 = 18%) so that the one division that has to happen
     is rounded once, half-up, in a named place.

     The ceilings below keep every intermediate product under 2^53, which is
     where integer arithmetic on JavaScript numbers stops being exact.

   NO TAX UNLESS ASKED FOR

     A bill carries tax only when it says so: `tax.rateBp` above zero. There
     is no default rate and no shop-wide setting that can quietly add one.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SM = root.SM || {}).shopMoney = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ₹1,00,00,000 for one item — far above anything a parts shop sells, and
     low enough that price × quantity × basis points stays exact. */
  var MAX_UNIT_PAISE = 1000000000;
  /* ₹100 crore for one bill. subtotal × 10000 × 2 — the largest product the
     inclusive-tax rounding forms — is then 2e15, inside 2^53 ≈ 9e15. */
  var MAX_BILL_PAISE = 10000000000;
  var MAX_QTY = 9999;
  var MAX_LINES = 200;
  var MAX_RATE_BP = 10000;                 /* 100% */
  var PAYMENT_METHODS = ['cash', 'upi', 'card', 'other'];
  var PAYMENT_STATUSES = ['unpaid', 'partial', 'paid'];

  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

  /**
   * Rupees as typed → paise, or null when the text is not an amount.
   *
   * Accepts "120", "120.5", "1,250.00", "₹ 99". Refuses more than two decimal
   * places rather than rounding them away: "12.345" is a typo, and a till that
   * silently charges ₹12.35 for it has made a decision nobody asked it to.
   */
  function parseRupees(text) {
    if (typeof text === 'number') text = String(text);
    if (typeof text !== 'string') return null;
    var s = text.replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
    if (!/^\d{1,9}(\.\d{0,2})?$/.test(s)) return null;
    var parts = s.split('.');
    var paise = Number(parts[0]) * 100 + Number(((parts[1] || '') + '00').slice(0, 2));
    return paise <= MAX_UNIT_PAISE ? paise : null;
  }

  /** "18", "18.5", "12.25" → basis points (1800, 1850, 1225), or null. */
  function parsePercent(text) {
    if (typeof text === 'number') text = String(text);
    if (typeof text !== 'string') return null;
    var s = text.replace(/[%\s]/g, '');
    if (!/^\d{1,3}(\.\d{0,2})?$/.test(s)) return null;
    var parts = s.split('.');
    var bp = Number(parts[0]) * 100 + Number(((parts[1] || '') + '00').slice(0, 2));
    return bp <= MAX_RATE_BP ? bp : null;
  }

  /** a × bp / 10000, rounded half-up. The only division money ever needs. */
  function pctOf(paise, bp) {
    return Math.floor((paise * bp + 5000) / 10000);
  }

  /** Indian grouping, always two decimals: 125000 → "1,250.00". */
  function format(paise) {
    var n = isInt(paise) ? paise : 0;
    var neg = n < 0;
    if (neg) n = -n;
    var rupees = String(Math.floor(n / 100));
    var p = String(n % 100);
    if (p.length < 2) p = '0' + p;
    /* 12345678 → 1,23,45,678: the last three digits, then pairs. */
    var head = rupees.slice(0, -3), tail = rupees.slice(-3);
    if (head) head = head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',';
    return (neg ? '-' : '') + head + tail + '.' + p;
  }

  /** "₹1,250.00" */
  function inr(paise) { return '₹' + format(paise); }

  /** Paise → the plain text an input field should hold: 125000 → "1250", 12550 → "125.50". */
  function toInput(paise) {
    if (!isInt(paise)) return '';
    var r = Math.floor(paise / 100), p = paise % 100;
    return p ? r + '.' + (p < 10 ? '0' + p : String(p)) : String(r);
  }

  /**
   * The whole bill, from its lines and its adjustments.
   *
   * @param {Array<{unitPaise:number, qty:number}>} lines
   * @param {{mode?:'amount'|'percent', value?:number}} [discount]
   *        amount: paise off the subtotal; percent: basis points of it.
   *        Never more than the subtotal.
   * @param {{rateBp?:number, inclusive?:boolean}} [tax]
   *        exclusive (default): added on top of the discounted subtotal.
   *        inclusive: the prices already contain it; the tax shown is the part
   *        of the total that is tax, and the total does not move.
   * @param {number} [receivedPaise]
   * @returns {{ok:boolean, error?:string, line?:number, lineTotals:number[],
   *   subtotalPaise:number, discountPaise:number, taxablePaise:number,
   *   taxPaise:number, totalPaise:number, receivedPaise:number,
   *   balancePaise:number, changePaise:number}}
   */
  function computeBill(lines, discount, tax, receivedPaise) {
    var out = {
      ok: true, lineTotals: [], subtotalPaise: 0, discountPaise: 0, taxablePaise: 0,
      taxPaise: 0, totalPaise: 0, receivedPaise: 0, balancePaise: 0, changePaise: 0
    };
    var fail = function (error, line) {
      out.ok = false; out.error = error;
      if (line != null) out.line = line;
      return out;
    };

    if (!Array.isArray(lines)) return fail('lines');
    if (lines.length > MAX_LINES) return fail('too-many-lines');
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i] || {};
      if (!isInt(l.unitPaise) || l.unitPaise < 0 || l.unitPaise > MAX_UNIT_PAISE) return fail('price', i);
      if (!isInt(l.qty) || l.qty < 1 || l.qty > MAX_QTY) return fail('qty', i);
      var t = l.unitPaise * l.qty;
      out.lineTotals.push(t);
      out.subtotalPaise += t;
      if (out.subtotalPaise > MAX_BILL_PAISE) return fail('total-too-large', i);
    }

    var d = discount || {};
    var dv = d.value == null ? 0 : d.value;
    if (!isInt(dv) || dv < 0) return fail('discount');
    if (d.mode === 'percent') {
      if (dv > MAX_RATE_BP) return fail('discount');
      out.discountPaise = pctOf(out.subtotalPaise, dv);
    } else {
      out.discountPaise = dv;
    }
    if (out.discountPaise > out.subtotalPaise) return fail('discount-too-large');
    out.taxablePaise = out.subtotalPaise - out.discountPaise;

    var x = tax || {};
    var bp = x.rateBp == null ? 0 : x.rateBp;
    if (!isInt(bp) || bp < 0 || bp > MAX_RATE_BP) return fail('tax');
    if (bp > 0 && x.inclusive) {
      /* The pre-tax amount is taxable × 10000 / (10000 + bp), rounded half-up;
         the tax is whatever is left, so the two always add back to the total. */
      var base = Math.floor((out.taxablePaise * 10000 * 2 + (10000 + bp)) / ((10000 + bp) * 2));
      out.taxPaise = out.taxablePaise - base;
      out.totalPaise = out.taxablePaise;
    } else {
      out.taxPaise = bp > 0 ? pctOf(out.taxablePaise, bp) : 0;
      out.totalPaise = out.taxablePaise + out.taxPaise;
    }

    var r = receivedPaise == null ? 0 : receivedPaise;
    if (!isInt(r) || r < 0 || r > MAX_BILL_PAISE * 2) return fail('received');
    out.receivedPaise = r;
    out.balancePaise = Math.max(0, out.totalPaise - r);
    out.changePaise = Math.max(0, r - out.totalPaise);
    return out;
  }

  /** What the amount received says the bill's payment status is. */
  function statusFor(totalPaise, receivedPaise) {
    if (!receivedPaise) return totalPaise === 0 ? 'paid' : 'unpaid';
    return receivedPaise >= totalPaise ? 'paid' : 'partial';
  }

  /** "QB-0007" — at least four digits, more when the counter needs them. */
  function billNumber(prefix, seq) {
    var s = String(seq);
    while (s.length < 4) s = '0' + s;
    return (prefix || 'QB') + '-' + s;
  }

  return {
    MAX_UNIT_PAISE: MAX_UNIT_PAISE, MAX_BILL_PAISE: MAX_BILL_PAISE, MAX_QTY: MAX_QTY, MAX_LINES: MAX_LINES, MAX_RATE_BP: MAX_RATE_BP,
    PAYMENT_METHODS: PAYMENT_METHODS, PAYMENT_STATUSES: PAYMENT_STATUSES,
    isInt: isInt, parseRupees: parseRupees, parsePercent: parsePercent, pctOf: pctOf,
    format: format, inr: inr, toInput: toInput,
    computeBill: computeBill, statusFor: statusFor, billNumber: billNumber
  };
});
