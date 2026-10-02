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
     subscriptions/manual_...         one per plan an administrator assigned
     payments/{razorpayPaymentId}     the idempotency key, and the audit trail
     adminAuditLog/{entryId}          who changed an entitlement by hand

   TWO WAYS A PLAN REACHES AN ACCOUNT, AND ONLY TWO

     activateSubscription   a payment Razorpay vouched for
     assignPlanManually     an administrator, by hand

   They write the same mirror fields on users/{uid}, which is why the
   resolver in _schema/entitlement.js needs no knowledge of either. What
   differs is the record beside it: a payment leaves a payments/ document, and
   a manual assignment NEVER does. A plan an administrator granted is not a
   sale, and a payments/ row for it would be revenue that never arrived.
   ========================================================================== */
'use strict';

const crypto = require('crypto');
const { db, admin } = require('./firebase');
const { periodFor, addMonths } = require('./billing-period');
const { getAssignablePlan, LIFETIME } = require('./plans');
const { searchFieldsFor } = require('../_schema/user-profile');
const { resolveEntitlement, SOURCES } = require('../_schema/entitlement');
const { ADMIN_AUDIT_LOG } = require('../_schema/collections');
const audit = require('../_services/audit-service');

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
        /* An all-blank address is not an address. Merging {} over a stored one
           would delete it, and a form opened without being seeded sends exactly
           that. */
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

  /* Lower-cased mirrors of the fields the admin table searches, plus a
     digits-only copy of the phone number.

     Written HERE, on the one path every profile write goes through, because a
     mirror maintained anywhere else is a mirror that goes stale the first time
     somebody writes a profile by another route. Firestore cannot lower-case at
     query time, so these fields are the only way a search for "sri balaji"
     finds "Sri Balaji Mobiles".

     Derived, never authoritative: recomputing them from the real fields is
     always correct, which is what makes scripts/backfill-user-search.js safe
     to run repeatedly over the existing records. */
  Object.assign(doc, searchFieldsFor({ ...prior, ...doc }));

  await ref.set(doc, { merge: true });
  /* What the document now holds is the one read above with this write merged
     over it — exactly what set(..., {merge:true}) does — so it is computed
     rather than read back. That read-back was a second billed read on every
     call, for a value this function already had. */
  return { created: !existed, profile: mergeDeep(prior, doc) };
}

/* set(..., {merge:true}) semantics: plain objects merge key by key, and every
   other value — string, number, array, Timestamp, FieldValue — replaces. */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
}
function mergeDeep(base, patch) {
  const out = { ...base };
  Object.keys(patch).forEach(k => {
    out[k] = isPlainObject(patch[k]) && isPlainObject(out[k])
      ? mergeDeep(out[k], patch[k])
      : patch[k];
  });
  return out;
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

    const held = resolveEntitlement(userSnap.exists ? userSnap.data() : null, now);

    /* A LIFETIME ACCOUNT THAT PAYS KEEPS LIFETIME.

       /api/create-order refuses to start a purchase for one, so this is the
       narrow case of an order opened before the grant whose payment lands
       after it. The money is real and is recorded as taken; what must not
       happen is the mirror being overwritten with a one-month plan, which
       would turn "never expires" into "expires next month" as a side effect
       of the customer paying. Nothing about their access changes, and the
       record says so for whoever refunds it. */
    if (held.isActive && held.isLifetime) {
      console.warn('[billing:activate] payment for an account that already holds Lifetime — ' +
                   'recorded, entitlement unchanged', { uid, orderId, paymentId, planId: plan.id });
      tx.set(paymentRef, {
        uid,
        planId: plan.id,
        amount: amountPaise,
        currency,
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        status: 'captured',
        signatureVerified: signatureVerified !== false,
        verifiedBy: source,
        activationSource: SOURCES.PAYMENT,
        entitlementApplied: false,
        note: 'account already holds lifetime access',
        createdAt: now,
        verifiedAt: now,
        startedAt: null,
        expiresAt: null
      });
      tx.set(subRef, {
        uid,
        razorpayPaymentId: paymentId,
        paymentId,
        paymentStatus: 'captured',
        status: 'not_applied',
        activationSource: SOURCES.PAYMENT,
        note: 'account already holds lifetime access',
        updatedAt: now,
        verifiedAt: now
      }, { merge: true });
      return {
        alreadyProcessed: false,
        entitlementApplied: false,
        startedAt: held.startedAt,
        expiresAt: null,
        planId: LIFETIME.id
      };
    }

    /* Extend from the current expiry when one is still running, so renewing
       early does not throw away days the subscriber already paid for.

       "Still running" is the resolver's answer, not the bare date. A plan an
       administrator REVOKED keeps its old expiry on the document, and reading
       the date alone would hand those withdrawn days back on top of the new
       period the moment the account paid again. */
    const currentExpiresAt = held.isActive ? held.expiresAt : null;
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
      activationSource: SOURCES.PAYMENT,
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
      activationSource: SOURCES.PAYMENT,
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
      /* How this plan came to be held, and that it is not Lifetime. Written on
         every activation so a plan an administrator assigned, or revoked, is
         cleanly replaced by a paid one rather than half-described by both. */
      subscriptionSource: SOURCES.PAYMENT,
      subscriptionLifetime: false,
      subscriptionRevokedAt: null,
      subscriptionRevokedBy: null,
      subscriptionRevokeReason: null,
      accountStatus: 'active',
      lastVerifiedAt: now,
      updatedAt: now
    }, { merge: true });

    return { alreadyProcessed: false, startedAt, expiresAt, planId: plan.id };
  }).then(result => {
    /* One line per payment that reaches here, in the function log. When a shop
       says "I paid and nothing happened", this is the first thing to look for:
       it says whether the server ever heard about the payment, and what it did. */
    console.log('[billing:activate]', {
      uid, planId: result.planId, orderId, paymentId, verifiedBy: source,
      alreadyProcessed: result.alreadyProcessed, expiresAt: result.expiresAt
    });
    return result;
  });
}

/* ------------------------------------------------------- manual assignment */

/** The audit vocabulary for an administrator's entitlement change. */
const ADMIN_ACTIONS = {
  ASSIGN_MONTHLY: audit.ACTIONS.SUBSCRIPTION_ASSIGN_MONTHLY,
  ASSIGN_YEARLY: audit.ACTIONS.SUBSCRIPTION_ASSIGN_YEARLY,
  ACTIVATE_LIFETIME: audit.ACTIONS.SUBSCRIPTION_ACTIVATE_LIFETIME,
  CHANGE_PLAN: audit.ACTIONS.SUBSCRIPTION_CHANGE_PLAN,
  EXTEND_PLAN: audit.ACTIONS.SUBSCRIPTION_EXTEND_PLAN,
  REVOKE_SUBSCRIPTION: audit.ACTIONS.SUBSCRIPTION_REVOKE
};

/** An error a route can turn into a specific status rather than a 500. */
function refusal(code, message) {
  const err = new Error(message || code);
  err.refusal = code;
  return err;
}

/** How an expiry is written into an audit entry: a date, "never", or "none". */
function expiryForAudit(ent) {
  if (ent.isLifetime) return 'never';
  return ent.expiresAt != null ? ent.expiresAt : 'none';
}

/**
 * What the audit entry for one entitlement change holds.
 *
 * The plan, the status and the expiry on BOTH sides of the change, who did it
 * and to whom. Emails are here deliberately, unlike the other entries in the
 * log: "who gave this account Lifetime" has to be answerable from the log
 * alone, long after either uid means anything to the person reading it.
 */
function entitlementAudit({ actionType, before, after, admin: actor, target, uid, reason, reference, recordId, now }) {
  return audit.entry({
    actorUid: actor.uid,
    actorRole: actor.role,
    action: ADMIN_ACTIONS[actionType],
    targetType: 'user',
    targetId: uid,
    detail: {
      actionType,
      targetEmail: (target && target.email) || '',
      adminEmail: actor.email || '',
      adminName: actor.name || '',
      previousPlan: before.planType || 'none',
      newPlan: after.planType || 'none',
      previousStatus: before.state,
      newStatus: after.state,
      previousExpiresAt: expiryForAudit(before),
      newExpiresAt: expiryForAudit(after),
      activationSource: SOURCES.ADMIN_MANUAL,
      reason: reason || '',
      reference: reference || '',
      subscriptionId: recordId || ''
    },
    now
  });
}

/**
 * Gives an account a plan because an administrator said so.
 *
 * NO PAYMENT IS RECORDED, because none was made here. An administrator who
 * has checked a bank transfer by eye and is activating the plan it paid for is
 * still not a payment this system verified — the reference they type is kept
 * as their note, on the subscription record and in the audit entry, and
 * payments/ is not touched.
 *
 * ONE TRANSACTION holds all of it: the mirror the paywall reads, the
 * subscription record, and the audit entry. Either the account has the plan
 * AND the log says who gave it, or neither happened.
 *
 * @param {object} args
 * @param {string} args.uid
 * @param {string} args.planId              'monthly' | 'yearly' | 'lifetime'
 * @param {'replace'|'extend'} [args.mode]  extend adds a period to the END of
 *        the one already running; replace starts a fresh one today. Extend is
 *        only honoured when the same plan is active, and never for Lifetime.
 * @param {{uid:string,email?:string|null,name?:string|null,role:string}} args.admin
 * @param {{email?:string|null,displayName?:string|null}} [args.target]
 * @param {string} [args.reason]
 * @param {string} [args.reference]         what the administrator checked — a UTR, a ticket
 * @param {number} args.now
 */
async function assignPlanManually({ uid, planId, mode, admin: actor, target, reason, reference, now }) {
  const plan = getAssignablePlan(planId);
  if (!plan) throw refusal('unknown-plan', 'planId must be monthly, yearly or lifetime');

  const firestore = db();
  const userRef = firestore.collection('users').doc(uid);
  const recordId = 'manual_' + now.toString(36) + '_' + crypto.randomBytes(5).toString('hex');
  const recordRef = firestore.collection('subscriptions').doc(recordId);
  const auditRef = firestore.collection(ADMIN_AUDIT_LOG).doc();
  const lifetime = plan.id === LIFETIME.id;

  return firestore.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    const prior = userSnap.exists ? userSnap.data() : null;
    const before = resolveEntitlement(prior, now);

    /* The record being replaced, read now because a transaction takes every
       read before its first write. Only stamped if it really exists: a merge
       onto a missing id would invent an empty subscription. */
    const prevRef = before.subscriptionId
      ? firestore.collection('subscriptions').doc(before.subscriptionId) : null;
    const prevSnap = prevRef ? await tx.get(prevRef) : null;

    const extending = !lifetime && mode === 'extend' && before.isActive &&
                      !before.isLifetime && before.planType === plan.id &&
                      Number.isFinite(before.expiresAt);

    /* Asked to extend something that cannot be extended. Refused rather than
       quietly treated as "replace", which would restart the period from today
       when the administrator believed they were adding to it. */
    if (mode === 'extend' && !extending) {
      throw refusal('cannot-extend',
        'only an active plan of the same type can be extended');
    }

    const startedAt = extending && Number.isFinite(before.startedAt) ? before.startedAt : now;
    const expiresAt = lifetime ? null
      : addMonths(extending ? before.expiresAt : now, plan.periodMonths);

    const actionType = lifetime ? 'ACTIVATE_LIFETIME'
      : extending ? 'EXTEND_PLAN'
      : before.isActive && before.planType !== plan.id ? 'CHANGE_PLAN'
      : plan.id === 'monthly' ? 'ASSIGN_MONTHLY' : 'ASSIGN_YEARLY';

    const mirror = {
      uid,
      /* Both status names and both plan names, for the reason given in
         activateSubscription: one reader each, and a plan written under one
         name is a plan the other reader cannot see. */
      subscriptionStatus: 'active',
      activeSubscriptionStatus: 'active',
      currentPlanId: plan.id,
      subscriptionPlan: plan.id,
      currentSubscriptionId: recordId,
      subscriptionStartedAt: startedAt,
      subscriptionExpiresAt: expiresAt,          /* null for Lifetime: no date */
      subscriptionLifetime: lifetime,
      subscriptionSource: SOURCES.ADMIN_MANUAL,
      subscriptionAssignedBy: actor.uid,
      subscriptionAssignedAt: now,
      subscriptionRevokedAt: null,
      subscriptionRevokedBy: null,
      subscriptionRevokeReason: null,
      cancelledAt: null
    };
    if (target && target.email && !(prior && prior.email)) mirror.email = target.email;
    if (!prior) {
      /* An account that signed in and never got a profile document. Written
         with the two fields the admin table sorts and filters by, so granting
         a plan does not leave a record the table cannot list. */
      mirror.createdAt = now;
      mirror.accountStatus = 'active';
    }

    const after = resolveEntitlement({ ...(prior || {}), ...mirror }, now);

    tx.set(userRef, mirror, { merge: true });

    tx.set(recordRef, {
      uid,
      email: (target && target.email) || (prior && prior.email) || null,
      planId: plan.id,
      planName: plan.name,
      billingInterval: plan.billingPeriod,
      billingPeriod: plan.billingPeriod,
      /* No amount, no order, no payment. This is an entitlement record. */
      amount: null,
      currency: plan.currency,
      razorpayOrderId: null,
      razorpayPaymentId: null,
      paymentId: null,
      paymentStatus: 'not_applicable',
      status: 'active',
      activationSource: SOURCES.ADMIN_MANUAL,
      isLifetime: lifetime,
      action: actionType,
      assignedBy: actor.uid,
      assignedByEmail: actor.email || null,
      reason: reason || null,
      reference: reference || null,
      previousPlanId: before.planType,
      previousStatus: before.state,
      previousExpiresAt: before.expiresAt,
      previousSubscriptionId: before.subscriptionId,
      startedAt,
      expiresAt,
      updatedAt: now,
      verifiedAt: null,
      createdAt: FieldValue.serverTimestamp()
    });

    if (prevSnap && prevSnap.exists) {
      /* The earlier record is kept exactly as it was — a paid order stays a
         paid order — and gains only a pointer to what replaced it. */
      tx.set(prevRef, { supersededAt: now, supersededBy: recordId }, { merge: true });
    }

    tx.set(auditRef, entitlementAudit({
      actionType, before, after, admin: actor, target, uid, reason, reference, recordId, now
    }));

    return { action: actionType, subscriptionId: recordId, previous: before, entitlement: after };
  }).then(result => {
    console.log('[billing:admin-assign]', {
      uid, planId: plan.id, action: result.action, by: actor.uid,
      expiresAt: result.entitlement.expiresAt, subscriptionId: result.subscriptionId
    });
    return result;
  });
}

/**
 * Withdraws an account's access, now.
 *
 * Not a cancellation. Cancelling stops a renewal and leaves the paid days in
 * place; this ends access on the next request, whatever date is on the record,
 * and it is the only way a Lifetime entitlement ever ends.
 *
 * Nothing is deleted. The plan, its dates and the record it came from all
 * stay, marked revoked, with who did it and why.
 */
async function revokeSubscription({ uid, admin: actor, target, reason, now }) {
  const firestore = db();
  const userRef = firestore.collection('users').doc(uid);
  const auditRef = firestore.collection(ADMIN_AUDIT_LOG).doc();

  return firestore.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    const prior = userSnap.exists ? userSnap.data() : null;
    const before = resolveEntitlement(prior, now);

    if (before.state === 'revoked') {
      /* Already done. Answered as a success so a double-click is not an
         error, and NOT logged a second time: one withdrawal, one entry. */
      return { action: 'REVOKE_SUBSCRIPTION', alreadyRevoked: true, previous: before, entitlement: before };
    }
    if (!before.isActive) {
      throw refusal('nothing-to-revoke', 'this account has no active subscription');
    }

    const currentRef = before.subscriptionId
      ? firestore.collection('subscriptions').doc(before.subscriptionId) : null;
    const currentSnap = currentRef ? await tx.get(currentRef) : null;

    const mirror = {
      subscriptionStatus: 'revoked',
      activeSubscriptionStatus: 'revoked',
      subscriptionLifetime: false,
      subscriptionRevokedAt: now,
      subscriptionRevokedBy: actor.uid,
      subscriptionRevokeReason: reason || null
    };
    const after = resolveEntitlement({ ...prior, ...mirror }, now);

    tx.set(userRef, mirror, { merge: true });

    if (currentSnap && currentSnap.exists) {
      tx.set(currentRef, {
        status: 'revoked',
        revokedAt: now,
        revokedBy: actor.uid,
        revokedByEmail: actor.email || null,
        revokeReason: reason || null,
        updatedAt: now
      }, { merge: true });
    }

    tx.set(auditRef, entitlementAudit({
      actionType: 'REVOKE_SUBSCRIPTION', before, after, admin: actor, target, uid,
      reason, reference: '', recordId: before.subscriptionId, now
    }));

    return { action: 'REVOKE_SUBSCRIPTION', alreadyRevoked: false, previous: before, entitlement: after };
  }).then(result => {
    console.log('[billing:admin-revoke]', {
      uid, by: actor.uid, alreadyRevoked: result.alreadyRevoked,
      previousPlan: result.previous.planType
    });
    return result;
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
  const u = snap.exists ? snap.data() : null;

  /* The resolver, and nothing else. This used to work the state out for
     itself from one of the two status fields; the paywall worked it out
     separately from both. Two derivations of one fact is how the account
     screen and the group page come to disagree about the same shop. */
  const ent = resolveEntitlement(u, now);

  /* Lapsed access is written back so the stored mirror stops claiming to be
     active. Without this the record would keep saying "active" for a
     subscription that ended months ago, and every reader would have to
     re-derive it. */
  if (u && ent.state === 'expired' && u.activeSubscriptionStatus === 'active') {
    await db().collection('users').doc(uid)
      .set({ activeSubscriptionStatus: 'expired', subscriptionStatus: 'expired', updatedAt: now },
            { merge: true });
  }

  return {
    state: ent.state,
    /* The one field to branch on. `expiresAt` is null for Lifetime, so "has an
       expiry in the future" is no longer the same question as "has access". */
    isActive: ent.isActive,
    isLifetime: ent.isLifetime,
    plan: ent.planType,
    planName: ent.planName,
    price: ent.price,
    billingPeriod: ent.billingPeriod,
    source: ent.activationSource,
    subscriptionId: ent.subscriptionId,
    startedAt: ent.startedAt,
    expiresAt: ent.expiresAt,
    lastVerifiedAt: u ? u.lastVerifiedAt ?? null : null
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
  assignPlanManually, revokeSubscription, ADMIN_ACTIONS,
  recordFailure, readAccess, listSubscriptions
};
