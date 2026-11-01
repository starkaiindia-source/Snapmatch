/* ============================================================================
   Mobile Parts Finder · shop-periods.js — which day a bill belongs to
   ----------------------------------------------------------------------------
   One file, loaded by BOTH halves, like shop-money.js. The server files a bill
   under a day with this dayKey and the Bills page groups it with the same one, so
   a bill saved at 00:30 is the same day's sale in both.

   A DAY IS AN INDIAN TRADING DAY. A shop has no timezone setting, the server runs
   in UTC and a phone can be set to anything, so no date here comes from the
   device's zone. A week starts on Monday, as it does on the Overview.

   Pure: no storage, no clock of its own, no network.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SM = root.SM || {}).shopPeriods = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var PERIODS = [
    ['today', 'Today'], ['yesterday', 'Yesterday'], ['last7', 'Last 7 Days'],
    ['week', 'This Week'], ['month', 'This Month'], ['lastmonth', 'Last Month']
  ];

  /** "2026-10-31", in India, for a moment in time. */
  function dayKey(ms) { return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10); }

  function isDay(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
  }

  /** The moment an Indian trading day begins, as epoch milliseconds. */
  function dayStart(day) { return Date.parse(day + 'T00:00:00Z') - IST_OFFSET_MS; }

  function addDays(day, n) {
    return new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
  }

  function daysBetween(from, to) {
    return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS) + 1;
  }

  function weekStart(day) {
    return addDays(day, -((new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7));
  }
  function monthStart(day) { return day.slice(0, 8) + '01'; }

  /** "2 Nov" */
  function dayName(day) { return Number(day.slice(8)) + ' ' + MONTHS[Number(day.slice(5, 7)) - 1]; }
  function rangeName(from, to) { return from === to ? dayName(from) : dayName(from) + ' – ' + dayName(to); }

  /** The first and last day of a named period, or null for a name it does not know. */
  function period(id, now) {
    var today = dayKey(now);
    switch (id) {
      case 'today': return { from: today, to: today };
      case 'yesterday': { var y = addDays(today, -1); return { from: y, to: y }; }
      case 'last7': return { from: addDays(today, -6), to: today };
      case 'week': return { from: weekStart(today), to: today };
      case 'month': return { from: monthStart(today), to: today };
      case 'lastmonth': { var end = addDays(monthStart(today), -1); return { from: monthStart(end), to: end }; }
    }
    return null;
  }

  function periodName(id) {
    for (var i = 0; i < PERIODS.length; i++) if (PERIODS[i][0] === id) return PERIODS[i][1];
    return '';
  }

  /** What a bill's row says it is: void, or how far it has been paid. */
  function statusOf(bill) { return bill.status === 'void' ? 'void' : bill.paymentStatus; }

  /**
   * The figures over a list of bill summaries. A void bill is listed but counts
   * for nothing here: its money was reversed when it was voided. Collected is what
   * was received against these bills, which is not the same as their total.
   */
  function billStats(rows) {
    var s = { bills: 0, voids: 0, salesPaise: 0, collectedPaise: 0, outstandingPaise: 0 };
    rows.forEach(function (r) {
      if (r.status === 'void') { s.voids += 1; return; }
      s.bills += 1;
      s.salesPaise += r.totalPaise;
      s.collectedPaise += Math.min(r.receivedPaise || 0, r.totalPaise);
      s.outstandingPaise += r.balancePaise || 0;
    });
    return s;
  }

  function newestFirst(a, b) { return b.createdAt - a.createdAt; }

  /**
   * Bills by date, each exactly once. A bill lands in the first group it fits,
   * so This Week holds the days Today and Yesterday left, and This Month what is
   * left after that. Every group is returned, empty or not; the page decides
   * which to draw.
   */
  function groupBills(bills, now) {
    var today = dayKey(now);
    var yesterday = addDays(today, -1);
    var week = addDays(today, -6);
    var month = monthStart(today);
    var groups = [
      { id: 'today', title: 'Today', range: dayName(today), rows: [] },
      { id: 'yesterday', title: 'Yesterday', range: dayName(yesterday), rows: [] },
      { id: 'week', title: 'This Week', range: 'Last 7 Days · ' + rangeName(week, addDays(yesterday, -1)), rows: [] },
      { id: 'month', title: 'This Month', range: month < week ? rangeName(month, addDays(week, -1)) : '', rows: [] },
      { id: 'older', title: 'Older Bills', range: 'Before ' + dayName(month < week ? month : week), rows: [] }
    ];
    bills.forEach(function (b) {
      var key = dayKey(b.createdAt);
      var at = key >= today ? 0 : key === yesterday ? 1 : key >= week ? 2 : key >= month ? 3 : 4;
      groups[at].rows.push(b);
    });
    groups.forEach(function (g) {
      g.rows.sort(newestFirst);
      g.stats = billStats(g.rows);
    });
    return groups;
  }

  return {
    PERIODS: PERIODS,
    dayKey: dayKey, isDay: isDay, dayStart: dayStart, addDays: addDays, daysBetween: daysBetween,
    weekStart: weekStart, monthStart: monthStart, dayName: dayName, rangeName: rangeName,
    period: period, periodName: periodName, statusOf: statusOf, billStats: billStats, groupBills: groupBills
  };
});
