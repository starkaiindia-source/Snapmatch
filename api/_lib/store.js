/* ============================================================================
   Mobile Parts Finder · api/_lib/store.js
   ----------------------------------------------------------------------------
   Every Firestore write that grants or records paid access.

   IDEMPOTENCY IS THE WHOLE DESIGN. The same payment reaches this module twice
   as a matter of course, not as an edge case: the browser posts it to
   /api/verify-payment the moment Checkout closes, and Razorpay posts the same
   payment to the webhook moments later. Retries and refreshes add more. If
   both paths extended the subscription, a single ₹99 payment would buy two
   months.

   So activation runs inside a transaction keyed on the Razorpay payment id:

       payments/{razorpayPaymentId}

   The document id IS the payment id, and the transaction refuses to proceed if
   it already exists. Whichever caller arrives first activates; every later
   caller reads the existing record and reports `alreadyProcessed`. That makes
   the operation safe to repeat from any direction, which is what a payment
   system needs — the webhook has no idea the browser already succeeded.

   Collections
     users/{uid}                      access mirror the app reads on load
     subscriptions/{razorpayOrderId}  one per purchase, full billing history
     payments/{razorpayPaymentId}     the idempotency key, and the audit trail
   ========================================================================== */
'use strict';

const { db, admin } = require('./firebase');
const { periodFor, derive } = require('./billing-period');

const FieldValue = admin.firestore.FieldValue;

/* ------------------------------------------------------------------- orders */

/**
 * Records an order the instant it is created, before the user pays.
 *
 * This matters for reconciliation: if the browser dies between Checkout and
 * verification, the webhook still arrives, and it needs to know which uid and
 * plan the order belonged to. Without this row the webhook would have a
 * payment it cannot attribute to anyone.
 */
async function recordPendingOrder({
  orderId, uid, email, displayName, plan, amountPaise, currency, now
}) {
  await db().collection('subscriptions').doc(orderId).set({
    razorpayOrderId: orderId,
    uid,
    email: email || null,
    displayName: displayName || null,
    planId: plan.id,
    planName: plan.name,
    billingInterval: plan.billingPeriod,
    billingPeriod: plan.billingPeriod,
    paymentStatus: 'pending',
    amount: amountPaise,
    currency,
    status: 'pending',
    paymentId: null,
    startedAt: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now
  }, { merge: true });
}

/** The order as recorded at creation time — the server's own copy, not the client's. */
async function getOrder(orderId) {
  const snap = await db().collection('subscriptions').doc(orderId).get();
  return snap.exists ? snap.data() : null;
}

/* --------------------------------------------------------------- activation */

/**
 * Turns a verified payment into access. Safe to call repeatedly with the same
 * payment id — only the first call changes anything.
 *
 * @param {object} args
 * @param {string} args.uid
 * @param {string|null} args.email
 * @param {import('./plans').Plan} args.plan
 * @param {string} args.orderId
 * @param {string} args.paymentId
 * @param {number} args.amountPaise
 * @param {string} args.currency
 * @param {number} args.now                server time
 * @param {'checkout'|'webhook'} args.source  which path verified it
 * @returns {Promise<{alreadyProcessed:boolean, startedAt:number, expiresAt:number, planId:string}>}
 */
async function activateSubscription({
  uid, email, displayName, plan, orderId, paymentId, amountPaise, currency,
  now, source, signatureVerified
}) {
  const firestore = db();
  const paymentRef = firestore.collection('payments').doc(paymentId);
  const subRef = firestore.collection('subscriptions').doc(orderId);
  const userRef = firestore.collection('users').doc(uid);

  return firestore.runTransaction(async (tx) => {
    /* Every read must happen before every write inside a Firestore
       transaction, so all three are fetched up front. */
    const [paymentSnap, userSnap] = await Promise.all([
      tx.get(paymentRef),
      tx.get(userRef)
    ]);

    if (paymentSnap.exists) {
      const prior = paymentSnap.data();
      return {
        alreadyProcessed: true,
        startedAt: prior.startedAt ?? null,
        expiresAt: prior.expiresAt ?? null,
        planId: prior.planId ?? plan.id
      };
    }

    /* Extend from the current expiry when one is still running, so renewing
       early does not throw away days the subscriber already paid for. */
    const currentExpiresAt = userSnap.exists ? userSnap.data().subscriptionExpiresAt ?? null : null;
    const { startedAt, expiresAt } = periodFor({
      now, periodMonths: plan.periodMonths, currentExpiresAt
    });

    tx.set(paymentRef, {
      uid,
      planId: plan.id,
      amount: amountPaise,
      currency,
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      status: 'captured',
      /* Records HOW this was trusted. The checkout path proves the payment
         with an HMAC the browser cannot forge; the webhook path is Razorpay
         telling us directly. Both are verified, and the field says which. */
      signatureVerified: signatureVerified !== false,
      verifiedBy: source,
      createdAt: now,
      verifiedAt: now,
      startedAt,
      expiresAt
    });

    tx.set(subRef, {
      uid,
      email: email || null,
      planId: plan.id,
      planName: plan.name,
      billingInterval: plan.billingPeriod,
      billingPeriod: plan.billingPeriod,      /* kept: earlier records use it */
      amount: amountPaise,
      currency,
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      paymentId,                              /* kept for the same reason */
      paymentStatus: 'captured',
      status: 'active',
      startedAt,
      expiresAt,
      updatedAt: now,
      verifiedAt: now,
      createdAt: FieldValue.serverTimestamp()
    }, { merge: true });

    tx.set(userRef, {
      uid,
      email: email || null,
      displayName: displayName || null,
      /* Both names are written: subscriptionStatus is what the spec asks for,
         activeSubscriptionStatus is what readAccess and the existing records
         already use. Writing one and reading the other is how a subscription
         silently stops being recognised. */
      subscriptionStatus: 'active',
      activeSubscriptionStatus: 'active',
      currentPlanId: plan.id,
      currentSubscriptionId: orderId,
      subscriptionStartedAt: startedAt,
      subscriptionExpiresAt: expiresAt,
      lastVerifiedAt: now,
      updatedAt: now
    }, { merge: true });

    return { alreadyProcessed: false, startedAt, expiresAt, planId: plan.id };
  });
}

/* ------------------------------------------------------------------ failures */

/**
 * Records a payment that did not succeed. Deliberately does NOT touch the
 * user's access: a failed attempt must never downgrade a subscription the user
 * is still validly inside, which is exactly what would happen if a renewal
 * attempt failed while the current month still had days left.
 */
async function recordFailure({ orderId, paymentId, uid, reason, now }) {
  const firestore = db();
  const writes = [];

  if (paymentId) {
    writes.push(firestore.collection('payments').doc(paymentId).set({
      uid: uid || null,
      razorpayPaymentId: paymentId,
      razorpayOrderId: orderId || null,
      status: 'failed',
      failureReason: reason || null,
      createdAt: now
    }, { merge: true }));
  }
  if (orderId) {
    writes.push(firestore.collection('subscriptions').doc(orderId).set({
      status: 'failed',
      failureReason: reason || null,
      updatedAt: now
    }, { merge: true }));
  }
  await Promise.all(writes);
}

/* -------------------------------------------------------------------- status */

/**
 * The server's answer to "does this account have access right now".
 * The client renders this; it never computes access itself, because a browser
 * clock is not evidence.
 */
async function readAccess(uid, now) {
  const snap = await db().collection('users').doc(uid).get();
  if (!snap.exists) return { state: 'none', plan: null, startedAt: null, expiresAt: null };

  const u = snap.data();
  const sub = {
    status: u.activeSubscriptionStatus,
    expiresAt: u.subscriptionExpiresAt ?? null
  };
  const state = derive(sub, now);

  /* Lapsed access is written back so the stored mirror stops claiming to be
     active. Without this the record would keep saying "active" for a
     subscription that ended months ago, and every reader would have to
     re-derive it. */
  if (state === 'expired' && u.activeSubscriptionStatus === 'active') {
    await db().collection('users').doc(uid)
      .set({ activeSubscriptionStatus: 'expired', subscriptionStatus: 'expired', updatedAt: now },
            { merge: true });
  }

  return {
    state,
    plan: u.currentPlanId || null,
    subscriptionId: u.currentSubscriptionId || null,
    startedAt: u.subscriptionStartedAt ?? null,
    expiresAt: u.subscriptionExpiresAt ?? null,
    lastVerifiedAt: u.lastVerifiedAt ?? null
  };
}

/** The subscriber's own billing history, newest first. */
async function listSubscriptions(uid, limit = 12) {
  const snap = await db().collection('subscriptions')
    .where('uid', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map(d => d.data());
}

module.exports = {
  recordPendingOrder, getOrder, activateSubscription,
  recordFailure, readAccess, listSubscriptions
};
