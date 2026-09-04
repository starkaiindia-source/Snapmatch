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

/* ------------------------------------------------------------------ profile */

/* The four fields a shop must have before it can be charged. Checkout asks for
   a phone number when we do not send one, which is the extra "Contact details"
   step the buyer sees — so the number is not merely nice to have, it is what
   removes a screen from the payment flow. */
const REQUIRED_PROFILE = ['mobileShopName', 'proprietorName', 'mobileNumber', 'country'];

async function readProfile(uid) {
  const snap = await db().collection('users').doc(uid).get();
  return snap.exists ? snap.data() : null;
}

/* Shop details the OWNER may set. Everything about a subscription is absent
   from this list on purpose: those fields are the server's, written only by a
   verified payment, and accepting one here would let a signed-in browser post
   itself a plan. The list is also what /api/profile-sync accepts as input, so
   there is exactly one definition of "a field a user may write". */
const WRITABLE_PROFILE = [
  'mobileShopName', 'proprietorName', 'mobileNumber', 'mobileNumberE164',
  'country', 'countryCode', 'address', 'profilePhotoURL', 'profilePhotoPath'
];

/** True only when all four fields a payment needs are actually present. */
function profileIsComplete(doc) {
  return REQUIRED_PROFILE.every(k => {
    const v = doc && doc[k];
    return v != null && String(v).trim() !== '';
  });
}

/**
 * Keeps only writable fields, trimmed, with a length cap.
 *
 * `address` is the one non-string: the app stores it as an object of parts, so
 * it is passed through as-is after a size check rather than being stringified.
 * A cap exists at all because a document is billed by size and a 900 KB shop
 * name is not a shop name.
 */
function sanitiseProfile(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;

  WRITABLE_PROFILE.forEach(k => {
    const v = input[k];
    if (v === undefined || v === null) return;

    if (k === 'address') {
      if (typeof v === 'object') {
        const a = {};
        ['flat', 'area', 'city', 'district', 'state', 'country'].forEach(part => {
          if (typeof v[part] === 'string' && v[part].trim()) a[part] = v[part].trim().slice(0, 120);
        });
        if (Object.keys(a).length) out.address = a;
      } else if (typeof v === 'string' && v.trim()) {
        out.address = v.trim().slice(0, 240);
      }
      return;
    }

    if (typeof v !== 'string') return;
    const t = v.trim();
    /* An empty string is not a correction, it is an absent field. Writing one
       would blank a detail the shop entered on another device. */
    if (t) out[k] = t.slice(0, 200);
  });
  return out;
}

/**
 * Creates or refreshes users/{uid} for a signed-in account.
 *
 * This is what makes the profile document EXIST. Firebase Authentication
 * creating a user does not create anything in Firestore — the two are separate
 * products — so without a call like this a shop can be signed in, visible under
 * Authentication -> Users, and have no profile anywhere. That was the bug: the
 * document was only ever written when someone completed the sign-up form, and
 * any path that skipped that form left no record at all.
 *
 * Running through the Admin SDK matters twice over. It bypasses security rules,
 * so a rules mistake cannot silently swallow the write; and it is the only
 * place allowed to touch the server-owned fields, which is why the initial
 * subscriptionStatus is set here and not in the browser.
 *
 * WHAT IT WILL NOT DO
 *   · overwrite shop details with blanks — sanitiseProfile drops empty values
 *   · overwrite shop details with Google's — displayName from Google is stored
 *     under its own key, and only fills the shared one when nothing is there
 *   · restamp createdAt — written once, on the create, and never again
 *   · touch any subscription field on an existing document
 *   · invent a mobile number. A missing number stays missing; it is how the app
 *     knows to ask, and a fabricated one would end up on a real invoice.
 *
 * @returns {Promise<{created:boolean, profile:object}>}
 */
async function syncProfile({ uid, email, displayName, photoURL, emailVerified,
                             authProvider, profile, now }) {
  const ref = db().collection('users').doc(uid);
  const snap = await ref.get();
  const existed = snap.exists;
  const prior = existed ? snap.data() : {};

  const doc = {
    uid,
    lastLoginAt: now,
    updatedAt: now,
    authProvider: authProvider || prior.authProvider || 'google',
    ...sanitiseProfile(profile)
  };

  /* Identity comes from the verified ID token, never from the request body. */
  if (email) doc.email = email;
  if (typeof emailVerified === 'boolean') doc.emailVerified = emailVerified;

  /* Google's name and picture change when the user changes them there, so they
     are refreshed every sign-in — but into their own fields. The shop's own
     details are entered by hand and are never overwritten by them. */
  if (displayName) {
    doc.googleDisplayName = displayName;
    if (!prior.displayName) doc.displayName = displayName;
  }
  if (photoURL) {
    doc.googlePhotoURL = photoURL;
    /* profilePhotoURL is an upload the shop chose. Google's picture only fills
       it while there has never been one. */
    if (!prior.profilePhotoURL && !prior.profilePhotoPath) doc.profilePhotoURL = photoURL;
  }

  if (!existed) {
    doc.createdAt = now;
    doc.accountStatus = 'active';
    /* Server-owned, and set exactly once: a brand new account has no plan.
       Both names are written because readAccess reads activeSubscriptionStatus
       and the app reads subscriptionStatus — writing one and reading the other
       is how a subscription silently stops being recognised. */
    doc.subscriptionStatus = 'none';
    doc.activeSubscriptionStatus = 'none';
    doc.subscriptionPlan = null;
    doc.currentPlanId = null;
    doc.subscriptionStartedAt = null;
    doc.subscriptionExpiresAt = null;
  } else if (!prior.accountStatus) {
    doc.accountStatus = 'active';
  }

  /* Recomputed from the merged result rather than trusted from the request: a
     client claiming profileCompleted on a record with no phone number would
     otherwise walk straight into a Checkout that cannot prefill it. */
  doc.profileCompleted = profileIsComplete({ ...prior, ...doc });

  await ref.set(doc, { merge: true });
  const after = await ref.get();
  return { created: !existed, profile: after.data() || doc };
}

/**
 * What Razorpay Checkout needs to skip its contact step, plus an honest
 * verdict on whether the profile is complete.
 *
 * The verdict is computed here, on the server, from the stored document —
 * not from anything the browser sent — because it decides whether a payment
 * may start at all.
 */
function prefillFrom(profile, user) {
  const missing = REQUIRED_PROFILE.filter(k => {
    const v = profile && profile[k];
    return v == null || String(v).trim() === '';
  });
  return {
    complete: missing.length === 0,
    missing,
    prefill: {
      name: (profile && (profile.proprietorName || profile.mobileShopName)) || user.name || '',
      email: user.email || (profile && profile.email) || '',
      /* E.164 where we have it — Checkout matches the number to a saved
         Razorpay account far more reliably in that form. */
      contact: (profile && (profile.mobileNumberE164 || profile.mobileNumber)) || ''
    }
  };
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
      /* Same value as currentPlanId, under the name the account screen reads.
         Two readers, two names, one write — the alternative is a subscription
         that is active in one place and absent in the other. */
      subscriptionPlan: plan.id,
      currentSubscriptionId: orderId,
      subscriptionStartedAt: startedAt,
      subscriptionExpiresAt: expiresAt,
      accountStatus: 'active',
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
    plan: u.currentPlanId || u.subscriptionPlan || null,
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
  readProfile,
  prefillFrom,
  syncProfile,
  sanitiseProfile,
  profileIsComplete,
  REQUIRED_PROFILE,
  WRITABLE_PROFILE,
  recordPendingOrder, getOrder, activateSubscription,
  recordFailure, readAccess, listSubscriptions
};
