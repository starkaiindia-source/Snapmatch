/* ============================================================================
   GET  /api/admin/subscription?uid=...   one account's entitlement and history
   POST /api/admin/subscription           assign, change, extend or revoke a plan
   ----------------------------------------------------------------------------
   The one place a plan reaches an account without a payment.

   ----------------------------------------------------------------------------
   WHAT IT IS FOR

   Two real situations, and both need a person:

     · A shop paid, the money arrived, and the plan did not switch on — or it
       paid some way this system never saw, like a transfer to the business's
       own UPI id. An administrator checks the bank statement and activates the
       plan the money was for.
     · The owner wants an account to have access: a partner, a tester, a
       supplier. That is Lifetime, and this route is the only thing in the
       codebase that can grant it.

   ----------------------------------------------------------------------------
   NOTHING HERE IS A PAYMENT, AND NOTHING HERE PRETENDS TO BE ONE

   An assignment writes the entitlement, a subscription record marked
   `admin_manual`, and an audit entry. It never writes to payments/, so the
   revenue figures count money Razorpay took and nothing else. The reference an
   administrator types — a UTR, a ticket number — is stored as THEIR note about
   what they checked. It is not verified by this system and is never described
   as if it were.

   ----------------------------------------------------------------------------
   WHO MAY CALL IT

   `subscriptions.write`, held by super_admin and admin. Not support, not
   analyst, and not a customer — checked here, on the server, on every request,
   against the verified ID token. The button in the admin UI is drawn from the
   same permission, but a hidden button was never the control: a request sent
   by hand from a console reaches this function and is refused by it.

   The target is a uid, and it has to be an account that exists. Granting a
   plan to an address that might one day sign in is granting it to whoever
   registers that address first.

   ----------------------------------------------------------------------------
   AUDITED IN THE SAME TRANSACTION

   api/_lib/store.js writes the audit entry inside the transaction that changes
   the entitlement. There is no window in which an account holds a plan an
   administrator gave it and the log does not say who.
   ========================================================================== */
'use strict';

const { requirePermission } = require('../_lib/admin-auth');
const { PERMISSIONS, can } = require('../_schema/roles');
const { ok, bad, json, fail, notAllowed } = require('../_lib/http');
const { db, auth } = require('../_lib/firebase');
const { USERS } = require('../_schema/collections');
const { assignableCatalogue, getAssignablePlan } = require('../_lib/plans');
const { resolveEntitlement } = require('../_schema/entitlement');
const { assignPlanManually, revokeSubscription } = require('../_lib/store');
const audit = require('../_services/audit-service');
const v = require('../_lib/validate');

const ACTIONS = ['assign', 'revoke'];
const MODES = ['replace', 'extend'];

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') return await read(req, res);
    if (req.method === 'POST') return await change(req, res);
    return notAllowed(res);
  } catch (err) {
    /* A refusal from the store is a decision, not a fault: an unknown plan, a
       plan that cannot be extended, nothing to revoke. Each has its own status
       and a sentence an administrator can act on. */
    if (err && err.refusal) {
      const status = err.refusal === 'unknown-plan' ? 400 : 409;
      return json(res, status, { error: err.refusal, detail: err.message });
    }
    return fail(res, err, 'admin-subscription');
  }
};

/* --------------------------------------------------------------------- GET */

async function read(req, res) {
  /* Reading a subscription is billing.read — the support role can do this,
     and that is deliberate: it is how a customer's question gets answered.
     Only the POST below needs the write permission. */
  const admin = await requirePermission(req, res, PERMISSIONS.BILLING_READ);
  if (!admin) return;

  const uid = v.uid((req.query || {}).uid);
  if (!uid) return bad(res, 'a valid uid is required');

  const now = Date.now();
  const snap = await db().collection(USERS).doc(uid).get();
  const entitlement = resolveEntitlement(snap.exists ? snap.data() : null, now);
  const history = await entitlementHistory(uid);
  const canWrite = can(admin.role, PERMISSIONS.SUBSCRIPTIONS_WRITE);

  return ok(res, {
    uid,
    entitlement,
    history,
    canWrite,
    /* Offered only to a caller who may use them. A role that cannot assign a
       plan is not shown the list of plans it cannot assign. */
    plans: canWrite ? assignableCatalogue() : [],
    serverTime: now
  });
}

/** What administrators have done to this account's entitlement, newest first. */
async function entitlementHistory(uid) {
  const entries = await audit.list({ targetId: uid, limit: 100 });
  return entries
    .filter(e => audit.SUBSCRIPTION_ACTIONS.indexOf(e.action) > -1)
    .map(e => ({
      entryId: e.entryId,
      at: e.at,
      action: e.action,
      actorUid: e.actorUid,
      actorRole: e.actorRole,
      detail: e.detail || {}
    }));
}

/* -------------------------------------------------------------------- POST */

async function change(req, res) {
  const admin = await requirePermission(req, res, PERMISSIONS.SUBSCRIPTIONS_WRITE);
  if (!admin) return;                                    /* 401 / 403 already sent */

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const action = v.oneOf(body.action, ACTIONS, null);
  if (!action) return bad(res, 'action must be one of: ' + ACTIONS.join(', '));

  const uid = v.uid(body.uid);
  if (!uid) return bad(res, 'a valid uid is required');

  /* The account must exist in Firebase Authentication. This is also where the
     email in the audit entry comes from — Firebase's record of the account,
     never a value the request supplied. */
  let target;
  try {
    target = await auth().getUser(uid);
  } catch (err) {
    if (err && err.code === 'auth/user-not-found') {
      return json(res, 404, { error: 'no such account' });
    }
    throw err;
  }

  const reason = v.searchTerm(body.reason, 200);
  const reference = v.searchTerm(body.reference, 120);
  const now = Date.now();
  const actor = { uid: admin.uid, email: admin.email, name: admin.name, role: admin.role };
  const who = { email: target.email || null, displayName: target.displayName || null };

  if (action === 'revoke') {
    const result = await revokeSubscription({ uid, admin: actor, target: who, reason, now });
    return ok(res, {
      ok: true,
      action: result.action,
      alreadyRevoked: result.alreadyRevoked,
      previous: result.previous,
      entitlement: result.entitlement,
      serverTime: now
    });
  }

  const plan = getAssignablePlan(body.planId);
  if (!plan) {
    return bad(res, 'planId must be one of: ' +
      assignableCatalogue().map(p => p.id).join(', '));
  }
  const mode = v.oneOf(body.mode, MODES, 'replace');

  const result = await assignPlanManually({
    uid, planId: plan.id, mode, admin: actor, target: who, reason, reference, now
  });

  return ok(res, {
    ok: true,
    action: result.action,
    subscriptionId: result.subscriptionId,
    previous: result.previous,
    entitlement: result.entitlement,
    /* Said in the response, so nobody reading it in the network tab or a log
       mistakes this for a sale. */
    paymentRecorded: false,
    serverTime: now
  });
}
