/* ============================================================================
   Mobile Parts Finder · api/_schema/billing-records.js
   ----------------------------------------------------------------------------
   The shape of a subscription and the shape of a payment, as the admin area
   and every future module read them.

   These records already exist and are already written by api/_lib/store.js on
   the verified-payment path. NOTHING HERE WRITES THEM. This file is the read
   contract: it names the canonical field set, maps the older field names onto
   it, and hands back one predictable object so a dashboard never has to know
   that `billingInterval` and `billingPeriod` are the same thing.

   ----------------------------------------------------------------------------
   WHY A READ CONTRACT RATHER THAN A MIGRATION

   Rewriting live billing documents to tidy their field names is a migration
   that can only lose money if it goes wrong, for a benefit that is entirely
   cosmetic. Reading both names costs one `||` per field and cannot corrupt
   anything. The older names stay; this file knows about them.

   ----------------------------------------------------------------------------
   THE CANONICAL SUBSCRIPTION / PAYMENT FIELDS

     userId              the Firebase uid — the join key for everything
     planId              'monthly' | 'yearly'
     planName            display copy from the plan catalogue
     amountPaise         what was charged, in paise, never rupees
     currency            ISO 4217
     paymentProvider     'razorpay'
     providerOrderId     Razorpay order id — the subscriptions document id
     providerPaymentId   Razorpay payment id — the payments document id
     paymentStatus       created | pending | captured | failed | refunded
     subscriptionStatus  pending | active | expired | cancelled | failed
     createdAt / paidAt / startDate / endDate

   `providerPaymentId` is the only Razorpay reference the admin UI shows. It is
   an opaque handle to a transaction in the Razorpay dashboard, which is where
   card details live and where they stay — nothing resembling a card number,
   a UPI handle or a bank account passes through this codebase at all.
   ========================================================================== */
'use strict';

/** Firestore Timestamp, epoch ms, or already-null — always epoch ms or null. */
function ms(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v === 'object' && v.seconds != null) return v.seconds * 1000;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function text(v) {
  return v != null && String(v).trim() !== '' ? String(v) : null;
}

/**
 * One subscriptions/{orderId} document, in canonical form.
 * @param {string} id   the document id, which is the Razorpay order id
 */
function toSubscriptionView(id, d) {
  const doc = d || {};
  return {
    subscriptionId: id,
    userId: text(doc.uid) || text(doc.userId),
    planId: text(doc.planId),
    planName: text(doc.planName),
    billingPeriod: text(doc.billingPeriod) || text(doc.billingInterval),
    amountPaise: Number.isFinite(Number(doc.amount)) ? Number(doc.amount) : null,
    currency: text(doc.currency) || 'INR',
    paymentProvider: 'razorpay',
    providerOrderId: text(doc.razorpayOrderId) || id,
    providerPaymentId: text(doc.razorpayPaymentId) || text(doc.paymentId),
    paymentStatus: text(doc.paymentStatus) || null,
    /* `status` on this document is the SUBSCRIPTION's status; the payment's own
       status lives on the payments record. Naming both `status` is how the two
       get confused, so the canonical form separates them. */
    subscriptionStatus: text(doc.status) || 'pending',
    failureReason: text(doc.failureReason),
    createdAt: ms(doc.createdAt),
    paidAt: ms(doc.verifiedAt),
    startDate: ms(doc.startedAt),
    endDate: ms(doc.expiresAt),
    updatedAt: ms(doc.updatedAt)
  };
}

/**
 * One payments/{paymentId} document, in canonical form.
 * @param {string} id   the document id, which is the Razorpay payment id
 */
function toPaymentView(id, d) {
  const doc = d || {};
  return {
    paymentId: id,
    userId: text(doc.uid) || text(doc.userId),
    planId: text(doc.planId),
    amountPaise: Number.isFinite(Number(doc.amount)) ? Number(doc.amount) : null,
    currency: text(doc.currency) || 'INR',
    paymentProvider: 'razorpay',
    providerOrderId: text(doc.razorpayOrderId),
    providerPaymentId: text(doc.razorpayPaymentId) || id,
    paymentStatus: text(doc.status) || 'unknown',
    failureReason: text(doc.failureReason),
    /* How this payment came to be trusted: an HMAC on the checkout callback,
       or a signed webhook delivery. Both are proofs; the field says which. */
    verifiedBy: text(doc.verifiedBy),
    signatureVerified: doc.signatureVerified === true,
    createdAt: ms(doc.createdAt),
    paidAt: ms(doc.verifiedAt),
    startDate: ms(doc.startedAt),
    endDate: ms(doc.expiresAt)
  };
}

/** A payment that actually took money. */
function isSuccessful(payment) {
  return payment && payment.paymentStatus === 'captured';
}

/**
 * Rolls a user's payments into the figures the admin table shows.
 *
 * Sums only captured payments. A failed attempt has an amount on it — the
 * amount that was refused — and counting it as revenue is a reporting bug that
 * inflates every total on the dashboard.
 */
function rollUpPayments(payments) {
  const rollup = {
    totalPaidPaise: 0,
    successfulPayments: 0,
    failedPayments: 0,
    lastPaymentAt: null,
    lastPaymentId: null,
    currency: 'INR'
  };

  (payments || []).forEach(p => {
    if (isSuccessful(p)) {
      rollup.totalPaidPaise += Number(p.amountPaise) || 0;
      rollup.successfulPayments += 1;
      if (p.currency) rollup.currency = p.currency;
      const at = p.paidAt || p.createdAt;
      if (at != null && (rollup.lastPaymentAt == null || at > rollup.lastPaymentAt)) {
        rollup.lastPaymentAt = at;
        rollup.lastPaymentId = p.providerPaymentId || p.paymentId;
      }
    } else if (p.paymentStatus === 'failed') {
      rollup.failedPayments += 1;
    }
  });

  return rollup;
}

module.exports = { ms, toSubscriptionView, toPaymentView, isSuccessful, rollUpPayments };
