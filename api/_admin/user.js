/* ============================================================================
   GET /api/admin/user?uid=...
   ----------------------------------------------------------------------------
   Everything known about one account, and nothing more than is known.

   Profile, Firebase Authentication record, subscription history, payment
   history and an activity timeline. Where a value has never been collected the
   field is null and the UI prints an em dash. There is no fallback text that
   guesses at a city from a phone number and no default plan for an account
   that never bought one.

   ----------------------------------------------------------------------------
   THIS READ IS AUDITED

   Opening a customer's record shows their phone number and address. That is a
   legitimate support action and also exactly what misuse looks like, and the
   two are only distinguishable as a pattern over time. So every call writes an
   entry naming the admin and the uid they opened — not the data they saw.

   ----------------------------------------------------------------------------
   THE TIMELINE IS EXPANDABLE BY DESIGN

   It merges three sources: account facts (created, profile completed), billing
   records, and analytics events. A new event type added to the schema appears
   here automatically, which is the whole reason the event log is a log and not
   a set of columns on the user document.
   ========================================================================== */
'use strict';

const { requirePermission } = require('../_lib/admin-auth');
const { PERMISSIONS, can } = require('../_schema/roles');
const { ok, bad, fail, json, requireMethod } = require('../_lib/http');
const users = require('../_services/user-directory-service');
const analytics = require('../_services/analytics-service');
const audit = require('../_services/audit-service');
const v = require('../_lib/validate');

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  try {
    const admin = await requirePermission(req, res, PERMISSIONS.USERS_READ);
    if (!admin) return;

    const uid = v.uid((req.query || {}).uid);
    if (!uid) return bad(res, 'a valid uid is required');

    const now = Date.now();
    const detail = await users.getUserDetail(uid, now);
    if (!detail) return json(res, 404, { error: 'no such user' });

    /* Fire and forget. A failed audit write must not block a support agent
       from answering a customer — audit-service never throws, and the failure
       lands in the function log, which is itself a record. */
    audit.record({
      actorUid: admin.uid,
      actorRole: admin.role,
      action: audit.ACTIONS.USER_VIEWED,
      targetType: 'user',
      targetId: uid,
      now
    });

    const showContact = can(admin.role, PERMISSIONS.USERS_READ_CONTACT);
    const showBilling = can(admin.role, PERMISSIONS.BILLING_READ);
    const showRevenue = can(admin.role, PERMISSIONS.REVENUE_READ);

    const events = await analytics.listEvents({ userId: uid, limit: 100 });

    const body = { ...detail, timeline: buildTimeline(detail, events, showBilling) };

    if (!showContact) {
      delete body.mobileNumber;
      delete body.mobileNumberE164;
      delete body.address;
    }
    if (!showBilling) {
      body.payments = [];
      body.subscriptions = [];
    }
    if (!showRevenue) {
      body.billing = {
        successfulPayments: detail.billing.successfulPayments,
        failedPayments: detail.billing.failedPayments,
        lastPaymentAt: detail.billing.lastPaymentAt
      };
    }

    return ok(res, { user: body, serverTime: now });
  } catch (err) {
    return fail(res, err, 'admin-user');
  }
};

/**
 * One chronological list from three sources.
 *
 * Account facts are derived from timestamps on the profile rather than stored
 * as events, because they predate the event log — an account created two
 * months before analytics was switched on still shows its creation.
 */
function buildTimeline(user, events, includeBilling) {
  const items = [];

  if (user.createdAt) {
    items.push({ at: user.createdAt, type: 'account_created', label: 'Account created',
                 detail: { provider: user.authProvider } });
  }
  if (user.profileComplete && user.updatedAt) {
    /* The profile has no "completed at" timestamp — nothing ever recorded one.
       updatedAt is the closest honest anchor and is labelled as such rather
       than presented as the moment it happened. */
    items.push({ at: user.updatedAt, type: 'profile_complete',
                 label: 'Profile complete (as of last update)', detail: {} });
  }
  if (user.lastLoginAt) {
    items.push({ at: user.lastLoginAt, type: 'last_login', label: 'Last sign-in', detail: {} });
  }

  if (includeBilling) {
    (user.subscriptions || []).forEach(s => {
      if (s.createdAt) {
        items.push({
          at: s.createdAt, type: 'order_created',
          label: `Order created (${s.planId || 'unknown plan'})`,
          detail: { orderId: s.providerOrderId, status: s.subscriptionStatus }
        });
      }
      if (s.startDate) {
        items.push({
          at: s.startDate, type: 'subscription_activated',
          label: `Subscription activated (${s.planId || 'unknown plan'})`,
          detail: { endDate: s.endDate }
        });
      }
    });

    (user.payments || []).forEach(p => {
      items.push({
        at: p.paidAt || p.createdAt,
        type: p.paymentStatus === 'captured' ? 'payment_captured' : 'payment_' + p.paymentStatus,
        label: p.paymentStatus === 'captured'
          ? `Payment captured (${formatPaise(p.amountPaise)})`
          : `Payment ${p.paymentStatus}`,
        detail: {
          paymentId: p.providerPaymentId,
          orderId: p.providerOrderId,
          reason: p.failureReason || null,
          verifiedBy: p.verifiedBy || null
        }
      });
    });
  }

  (events || []).forEach(e => {
    items.push({
      at: e.timestamp,
      type: e.eventType,
      label: e.eventType.replace(/_/g, ' '),
      detail: e.metadata || {},
      source: e.source
    });
  });

  return items
    .filter(i => Number.isFinite(Number(i.at)))
    .sort((a, b) => b.at - a.at)
    .slice(0, 200);
}

function formatPaise(paise) {
  if (!Number.isFinite(Number(paise))) return 'unknown amount';
  return '₹' + (Number(paise) / 100).toLocaleString('en-IN');
}
