/* ============================================================================
   Mobile Parts Finder · api/_services/shop-insights.js — Quick Billing's numbers
   ----------------------------------------------------------------------------
   Pure arithmetic over one document per trading day, shops/{uid}/days/{date}.
   No I/O here: shop-service writes a day inside the same transaction as the bill
   it describes, so a day can never disagree with the bills that made it.

   WHY DAYS AND NOT BILLS

   The Overview would otherwise have to read every bill in the period on every
   visit, and the project runs on Firestore's Spark quota of 50,000 reads a day
   shared by the whole site. A year of history is at most 365 documents this way,
   however many bills it holds.

   WHAT EACH FIGURE MEANS

     gross       line totals, before the bill's discount and tax
     net         what the bills came to, after discount and tax
     collected   money received, on the day it was received: a balance paid in
                 October against a September bill counts in October
     refunded    money that had been received on a bill voided that day
     outstanding what finalised bills still owe, across all time
     voided      the total of bills voided later, kept on the bill's own day;
                 such a bill no longer counts in gross, net, bills or items

   A customer is someone with a record. Walk-in bills are counted as bills and
   never as customers, because nothing says two of them were different people or
   the same one.

   A DAY IS AN INDIAN TRADING DAY

   A bill saved at 00:30 IST on the 15th is the 15th's sale, though UTC still
   says the 14th. Vercel runs in UTC, so the date cannot come from the machine.
   ========================================================================== */
'use strict';

const { dayKey, isDay, dayStart, addDays, daysBetween } = require('../../src/data/shop-periods');

/* discV marks a day that counts its discounted bills. A day from before that has
   no such counts: discountedOf() below works them out from its bills, once. */
function emptyDay(day, ownerUid) {
  return {
    ownerUid, day,
    bills: 0, voids: 0, items: 0, walkIns: 0,
    grossPaise: 0, discountPaise: 0, taxPaise: 0, netPaise: 0, costPaise: 0,
    voidedPaise: 0, collectedPaise: 0, refundedPaise: 0,
    discV: 1, discBills: 0, discNetPaise: 0,
    methods: {}, customers: {}, newCustomers: {},
    products: {}, categories: {}, models: {}
  };
}

function bump(map, key, fields) {
  const row = map[key] || (map[key] = { n: fields.n || key, q: 0, r: 0 });
  row.q += fields.q;
  row.r += fields.r;
  if (row.q <= 0) delete map[key];
}

function eachItem(bill, sign, d) {
  (bill.items || []).forEach(it => {
    d.items += sign * it.qty;
    if (it.costPaise) d.costPaise += sign * it.costPaise * it.qty;
    if (it.productId) bump(d.products, it.productId, { n: it.name, q: sign * it.qty, r: sign * it.totalPaise });
    bump(d.categories, it.categoryName || 'Custom items', { n: it.categoryName || 'Custom items', q: sign * it.qty, r: sign * it.totalPaise });
    if (it.selectedModelId) {
      bump(d.models, it.selectedModelId, { n: it.selectedModelName || it.selectedModelId, q: sign * it.qty, r: sign * it.totalPaise });
    }
  });
}

/* Before any discount, and every discount: an offer and a bill discount are both
   money the shop chose not to charge. A bill from before offers has neither field. */
const grossOf = bill => bill.originalSubtotalPaise || bill.subtotalPaise || 0;
const discountsOf = bill => (bill.discountPaise || 0) + (bill.offerDiscountPaise || 0);

function countDiscounted(d, bill, sign) {
  if (!d.discV || !discountsOf(bill)) return;
  d.discBills += sign;
  d.discNetPaise += sign * (bill.totalPaise || 0);
}

/** What addBill would have counted, over a day's saved bills. */
function discountedOf(bills) {
  const live = bills.filter(b => b.status !== 'void' && discountsOf(b));
  return {
    discV: 1,
    discBills: live.length,
    discNetPaise: live.reduce((n, b) => n + (b.totalPaise || 0), 0)
  };
}

/** What a bill puts on the day it was made. `customer` is {id, isNew} or null. */
function addBill(d, bill, customer) {
  d.bills += 1;
  d.grossPaise += grossOf(bill);
  d.discountPaise += discountsOf(bill);
  d.taxPaise += bill.taxPaise || 0;
  d.netPaise += bill.totalPaise || 0;
  countDiscounted(d, bill, 1);
  eachItem(bill, 1, d);
  if (customer) {
    d.customers[customer.id] = (d.customers[customer.id] || 0) + (bill.totalPaise || 0);
    if (customer.isNew) d.newCustomers[customer.id] = 1;
  } else {
    d.walkIns += 1;
  }
  return d;
}

/** Money coming in today, whichever day's bill it was for. May be negative. */
function addCollected(d, method, paise) {
  d.collectedPaise += paise;
  d.methods[method] = (d.methods[method] || 0) + paise;
  return d;
}

/** Takes a voided bill back off the day it was made. */
function removeBill(d, bill) {
  d.bills = Math.max(0, d.bills - 1);
  d.voids += 1;
  d.voidedPaise += bill.totalPaise || 0;
  d.grossPaise -= grossOf(bill);
  d.discountPaise -= discountsOf(bill);
  d.taxPaise -= bill.taxPaise || 0;
  d.netPaise -= bill.totalPaise || 0;
  countDiscounted(d, bill, -1);
  eachItem(bill, -1, d);
  if (bill.customerId) {
    const left = (d.customers[bill.customerId] || 0) - (bill.totalPaise || 0);
    if (left > 0) d.customers[bill.customerId] = left;
    else { delete d.customers[bill.customerId]; delete d.newCustomers[bill.customerId]; }
  } else {
    d.walkIns = Math.max(0, d.walkIns - 1);
  }
  return d;
}

/** Everything the money tiles need, over any list of days. */
function totals(days) {
  const t = {
    bills: 0, voids: 0, items: 0, grossPaise: 0, discountPaise: 0, taxPaise: 0, netPaise: 0,
    costPaise: 0, voidedPaise: 0, collectedPaise: 0, refundedPaise: 0
  };
  days.forEach(d => Object.keys(t).forEach(k => { t[k] += d[k] || 0; }));
  t.collectedNetPaise = t.collectedPaise - t.refundedPaise;
  t.averageBillPaise = t.bills ? Math.round(t.netPaise / t.bills) : 0;
  return t;
}

/**
 * The Discounts & Offers page's Sales Overview, over a list of days.
 *
 *   salesPaise            what confirmed bills came to; a voided bill is off its day
 *   discountedSalesPaise  the part of that on bills that carried any discount
 *   discountPaise         offers and bill discounts together, each counted once
 *   collectedPaise        money received in the period, less refunds: a balance
 *                         paid today on last month's bill counts today
 */
function salesOverview(days) {
  const t = totals(days);
  const discountedBills = days.reduce((n, d) => n + (d.discBills || 0), 0);
  const discountedSalesPaise = days.reduce((n, d) => n + (d.discNetPaise || 0), 0);
  return {
    salesPaise: t.netPaise,
    bills: t.bills,
    discountedSalesPaise,
    discountPaise: t.discountPaise,
    discountedBills,
    averageDiscountPaise: discountedBills ? Math.round(t.discountPaise / discountedBills) : 0,
    contributionBp: t.netPaise > 0 ? Math.round(discountedSalesPaise * 10000 / t.netPaise) : 0,
    collectedPaise: t.collectedNetPaise
  };
}

/**
 * Who bought, over a period.
 *
 *   unique        different customers with a bill in the period
 *   newCustomers  whose first ever bill fell in the period
 *   repeat        customers who were not new, or who came back on another day
 *   avgDaily      each day's distinct customers, averaged over the calendar days
 *                 of the period: one customer with three bills on a day is one
 */
function customerMetrics(days, calendarDays) {
  const seenDays = new Map();
  const isNew = new Set();
  let dailySum = 0;
  let identifiedPaise = 0;
  days.forEach(d => {
    const ids = Object.keys(d.customers || {});
    dailySum += ids.length;
    ids.forEach(id => {
      seenDays.set(id, (seenDays.get(id) || 0) + 1);
      identifiedPaise += d.customers[id];
    });
    Object.keys(d.newCustomers || {}).forEach(id => isNew.add(id));
  });
  let repeat = 0;
  seenDays.forEach((n, id) => { if (!isNew.has(id) || n > 1) repeat++; });
  const unique = seenDays.size;
  return {
    unique,
    newCustomers: isNew.size,
    repeat,
    walkIns: days.reduce((n, d) => n + (d.walkIns || 0), 0),
    avgDailyUnique: calendarDays ? dailySum / calendarDays : 0,
    avgSpendPaise: unique ? Math.round(identifiedPaise / unique) : 0,
    returningRate: unique ? repeat / unique : null
  };
}

/** How one figure moved. `pct` is null when there is nothing to compare with. */
function change(cur, prev) {
  return { cur, prev, delta: cur - prev, pct: prev ? (cur - prev) / Math.abs(prev) : null };
}

function rollup(days, field) {
  const out = {};
  days.forEach(d => {
    const map = d[field] || {};
    Object.keys(map).forEach(k => {
      const r = out[k] || (out[k] = { id: k, name: map[k].n, qty: 0, revenuePaise: 0 });
      r.name = map[k].n;
      r.qty += map[k].q;
      r.revenuePaise += map[k].r;
    });
  });
  return Object.keys(out).map(k => out[k]).sort((a, b) => b.revenuePaise - a.revenuePaise || b.qty - a.qty);
}

/** One row per calendar day, including the days nothing happened. */
function series(byDay, from, to) {
  const rows = [];
  const firstSeen = new Set();
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const d = byDay.get(day);
    const ids = d ? Object.keys(d.customers || {}) : [];
    const fresh = d ? Object.keys(d.newCustomers || {}) : [];
    fresh.forEach(id => firstSeen.add(id));
    rows.push({
      day,
      netPaise: d ? d.netPaise : 0,
      bills: d ? d.bills : 0,
      collectedPaise: d ? d.collectedPaise - d.refundedPaise : 0,
      averageBillPaise: d && d.bills ? Math.round(d.netPaise / d.bills) : 0,
      newCustomers: fresh.length,
      repeatCustomers: ids.filter(id => !d.newCustomers[id]).length
    });
  }
  return rows;
}

/**
 * The whole Overview, from the day documents.
 *
 * @param {object[]} docs   every day document from `from` of the earliest
 *                          comparison period up to today
 * @param {{today:string, from:string, to:string}} p  the period being looked at
 */
function overview(docs, p) {
  const byDay = new Map(docs.map(d => [d.day, d]));
  const inRange = (from, to) => docs.filter(d => d.day >= from && d.day <= to);
  const { today, from, to } = p;

  const span = daysBetween(from, to);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(span - 1));

  const monthFrom = today.slice(0, 8) + '01';
  const lastMonthEnd = addDays(monthFrom, -1);
  const lastMonthFrom = lastMonthEnd.slice(0, 8) + '01';
  const dayOfMonth = Number(today.slice(8));
  /* The same stretch of last month, so a month eleven days old is not measured
     against thirty-one. */
  const lastMonthSame = dayOfMonth > Number(lastMonthEnd.slice(8))
    ? lastMonthEnd : lastMonthEnd.slice(0, 8) + today.slice(8);

  const weekday = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7;   /* Monday is 0 */
  const weekFrom = addDays(today, -weekday);
  const lastWeekFrom = addDays(weekFrom, -7);
  const lastWeekSame = addDays(today, -7);

  const period = totals(inRange(from, to));
  const previous = totals(inRange(prevFrom, prevTo));
  const thisMonth = totals(inRange(monthFrom, today));
  const lastMonth = totals(inRange(lastMonthFrom, lastMonthSame));
  const thisWeek = totals(inRange(weekFrom, today));
  const lastWeek = totals(inRange(lastWeekFrom, lastWeekSame));
  const todayTotals = totals(inRange(today, today));

  const compare = (a, b) => ({
    net: change(a.netPaise, b.netPaise),
    bills: change(a.bills, b.bills),
    average: change(a.averageBillPaise, b.averageBillPaise),
    collected: change(a.collectedNetPaise, b.collectedNetPaise)
  });

  const periodDays = inRange(from, to);
  const methods = {};
  periodDays.forEach(d => Object.keys(d.methods || {}).forEach(m => { methods[m] = (methods[m] || 0) + d.methods[m]; }));

  return {
    range: { from, to, days: span, prevFrom, prevTo },
    today: todayTotals,
    month: thisMonth,
    period,
    previous,
    compare: {
      period: compare(period, previous),
      month: compare(thisMonth, lastMonth),
      week: compare(thisWeek, lastWeek)
    },
    customers: {
      period: customerMetrics(periodDays, span),
      today: customerMetrics(inRange(today, today), 1),
      month: customerMetrics(inRange(monthFrom, today), daysBetween(monthFrom, today))
    },
    series: series(byDay, from, to),
    methods,
    products: rollup(periodDays, 'products'),
    categories: rollup(periodDays, 'categories'),
    models: rollup(periodDays, 'models')
  };
}

/** The earliest day overview() needs, so the caller reads no more than that. */
function earliestNeeded(from, to, today) {
  const span = daysBetween(from, to);
  const prevFrom = addDays(from, -span);
  const monthFrom = today.slice(0, 8) + '01';
  const lastMonthFrom = addDays(monthFrom, -1).slice(0, 8) + '01';
  const lastWeek = addDays(today, -14);
  return [prevFrom, lastMonthFrom, lastWeek].sort()[0];
}

module.exports = {
  dayKey, isDay, dayStart, addDays, daysBetween, emptyDay,
  addBill, addCollected, removeBill, totals, discountedOf, salesOverview, customerMetrics, change, overview, earliestNeeded
};
