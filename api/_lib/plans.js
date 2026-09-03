/* ============================================================================
   Mobile Parts Finder · api/_lib/plans.js
   ----------------------------------------------------------------------------
   The plan catalogue, and the ONLY place a price is decided.

   This file is the reason a browser cannot buy a year of access for ₹1. The
   client sends a plan ID and nothing else — no amount, no currency, no period.
   Everything chargeable is looked up here, server side, and the order is
   created from these numbers. A tampered request can therefore only ask for a
   different PLAN, never a different PRICE, and an unknown plan id is rejected
   outright.

   Amounts are in paise because that is what Razorpay charges in. Storing
   rupees and multiplying at the call site is how you ship a 100x billing bug,
   so the conversion happens once, here, and `amountPaise` is what travels.

   When prices change, change them here. The front end reads its display copy
   from the same catalogue via /api/plans, so the two cannot drift apart.
   ========================================================================== */
'use strict';

/** @typedef {'monthly'|'yearly'} BillingPeriod */

/**
 * @typedef {object} Plan
 * @property {string}        id
 * @property {string}        name
 * @property {BillingPeriod} billingPeriod
 * @property {number}        amountPaise   what Razorpay is asked to charge
 * @property {string}        currency      ISO 4217
 * @property {number}        periodMonths  how far the expiry moves on success
 * @property {boolean}       active        false hides it from sale, keeps it valid for existing subscribers
 */

/** @type {Record<string, Plan>} */
const PLANS = {
  monthly: {
    id: 'monthly',
    name: 'Monthly',
    billingPeriod: 'monthly',
    amountPaise: 9900,          /* ₹99 */
    currency: 'INR',
    periodMonths: 1,
    active: true
  },
  yearly: {
    id: 'yearly',
    name: 'Yearly',
    billingPeriod: 'yearly',
    amountPaise: 79900,         /* ₹799 */
    currency: 'INR',
    periodMonths: 12,
    active: true
  }
};

/**
 * Resolves a client-supplied plan id to a real plan.
 * Returns null rather than throwing so the caller decides the status code.
 * @param {unknown} planId
 * @returns {Plan|null}
 */
function getPlan(planId) {
  if (typeof planId !== 'string') return null;
  const plan = PLANS[planId];
  if (!plan || !plan.active) return null;
  return plan;
}

/**
 * What the browser is allowed to know: names and display prices, never the
 * internal fields. Served by /api/plans so the pricing page and the charge
 * come from one source.
 */
function publicCatalogue() {
  return Object.values(PLANS)
    .filter(p => p.active)
    .map(p => ({
      id: p.id,
      name: p.name,
      billingPeriod: p.billingPeriod,
      currency: p.currency,
      amountPaise: p.amountPaise,
      amountDisplay: (p.amountPaise / 100).toLocaleString('en-IN', {
        style: 'currency', currency: p.currency, maximumFractionDigits: 0
      }),
      periodMonths: p.periodMonths
    }));
}

/**
 * Guards the webhook and the verify step: the amount Razorpay reports must be
 * exactly what this catalogue says the plan costs. A mismatch means either the
 * order was made against different pricing or someone is replaying a cheaper
 * payment against a dearer plan, and neither may activate anything.
 * @param {Plan} plan
 * @param {unknown} amountPaise
 * @param {unknown} currency
 */
function amountMatches(plan, amountPaise, currency) {
  return Number(amountPaise) === plan.amountPaise &&
    String(currency).toUpperCase() === plan.currency;
}

module.exports = { PLANS, getPlan, publicCatalogue, amountMatches };
