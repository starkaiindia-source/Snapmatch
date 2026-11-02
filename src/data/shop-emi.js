/* ============================================================================
   Mobile Parts Finder · shop-emi.js — a bill paid in monthly instalments
   ----------------------------------------------------------------------------
   One file, loaded by BOTH halves, like shop-money.js. The sheet shows what this
   works out, and the server works it out again from the bill's own balance when
   the bill is saved. Only the server's schedule is kept.

   The shop gives its customer the credit itself, so a plan is what is left of the
   bill after the down payment, spread over the months. The bill's total does not
   change: interest is a finance charge on top of the sale, recorded apart from it.

     flat       interest on the whole amount for the whole term, the way a shop
                usually quotes it: ₹10,000 at 12% for 6 months is ₹600 interest
     reducing   interest each month on what is still owed, the way a bank does

   Every amount is an integer number of paise. An instalment is rounded once, and
   the last one takes up whatever rounding left, so a schedule always adds up.

   Pure: no storage, no clock of its own, no network.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SM = root.SM || {}).shopEmi = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_MONTHS = 60;
  var MAX_RATE_BP = 6000;                  /* 60% a year */

  /** The same day of a later month, or that month's last day when it has no such day. */
  function addMonths(day, n) {
    var y = Number(day.slice(0, 4));
    var m = Number(day.slice(5, 7)) - 1 + n;
    var d = Number(day.slice(8));
    var year = y + Math.floor(m / 12);
    var month = ((m % 12) + 12) % 12;
    var last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    var pad = function (v) { return (v < 10 ? '0' : '') + v; };
    return year + '-' + pad(month + 1) + '-' + pad(Math.min(d, last));
  }

  function flatSplit(p, interest, months) {
    var emi = Math.round((p + interest) / months);
    var it = Math.round(interest / months);
    var rows = [];
    for (var i = 1; i < months; i++) rows.push({ principalPaise: emi - it, interestPaise: it });
    rows.push({ principalPaise: p - (emi - it) * (months - 1), interestPaise: interest - it * (months - 1) });
    return rows;
  }

  function reducingSplit(p, rate, months) {
    var emi = Math.round(p * rate * Math.pow(1 + rate, months) / (Math.pow(1 + rate, months) - 1));
    var rows = [];
    var left = p;
    for (var i = 1; i <= months; i++) {
      var it = Math.round(left * rate);
      var pr = i === months ? left : Math.min(left, emi - it);
      rows.push({ principalPaise: pr, interestPaise: it });
      left -= pr;
    }
    return rows;
  }

  /**
   * A plan and its schedule.
   *
   * @param {{principalPaise:number, months:number, rateBp:number, method:string, firstDue:string}} o
   *        rateBp is the yearly rate in basis points. firstDue is "2026-12-02".
   */
  function plan(o) {
    var p = o.principalPaise, n = o.months, bp = o.rateBp || 0;
    var method = o.method === 'reducing' ? 'reducing' : 'flat';
    var rows;
    if (!bp) rows = flatSplit(p, 0, n);
    else if (method === 'flat') rows = flatSplit(p, Math.round(p * bp * n / 120000), n);
    else rows = reducingSplit(p, bp / 120000, n);
    var interest = 0;
    var schedule = rows.map(function (r, i) {
      interest += r.interestPaise;
      return {
        no: i + 1, due: addMonths(o.firstDue, i), amountPaise: r.principalPaise + r.interestPaise,
        principalPaise: r.principalPaise, interestPaise: r.interestPaise
      };
    });
    return {
      principalPaise: p, months: n, rateBp: bp, method: method, firstDue: o.firstDue,
      emiPaise: schedule[0].amountPaise, interestPaise: interest, totalPaise: p + interest, schedule: schedule
    };
  }

  /**
   * The true yearly cost of a plan, in basis points: the reducing-balance rate that
   * would give the same instalments. A flat 12% is not 12%, and a customer may ask.
   */
  function effectiveBp(pl) {
    if (!pl.interestPaise) return 0;
    var owed = function (r) {
      var left = pl.principalPaise;
      pl.schedule.forEach(function (s) { left = left * (1 + r) - s.amountPaise; });
      return left;
    };
    var lo = 0, hi = 1;
    for (var i = 0; i < 60; i++) {
      var mid = (lo + hi) / 2;
      if (owed(mid) > 0) hi = mid; else lo = mid;
    }
    return Math.round(lo * 12 * 10000);
  }

  /** The instalment to collect next, or null when all are paid. */
  function nextDue(emi) {
    return (emi.schedule || []).filter(function (s) { return !s.paidAt; })[0] || null;
  }

  return {
    MAX_MONTHS: MAX_MONTHS, MAX_RATE_BP: MAX_RATE_BP,
    addMonths: addMonths, plan: plan, effectiveBp: effectiveBp, nextDue: nextDue
  };
});
