/* ============================================================================
   Mobile Parts Finder · api/_schema/collections.js
   ----------------------------------------------------------------------------
   Every Firestore collection name, in one place, with what owns it.

   A collection name written as a string literal at ten call sites is a typo
   waiting to create an eleventh, empty collection that nothing reads and
   nobody notices. Import from here instead.

   OWNERSHIP is the column that matters. It says who may write, and it is the
   same line the security rules draw:

     public     importer writes through the Admin SDK, everyone reads
     owner      the signed-in user writes their own document
     server     ONLY the Admin SDK — no client write, ever
     internal   ONLY the Admin SDK, and no client READ either

   Anything marked `server` or `internal` is closed in firestore.rules and is
   reached exclusively through the routes under api/. That is what makes the
   admin data unreadable from a browser even by an administrator: the admin UI
   holds no Firestore handle for it, it calls /api/admin/* and the server
   decides.
   ========================================================================== */
'use strict';

/* ---------------------------------------------------------------- identity */

/** users/{uid} — the application profile. Owner-writable, server-corrected. */
const USERS = 'users';

/** adminUsers/{uid} — the role registry. internal. */
const ADMIN_USERS = 'adminUsers';

/* ----------------------------------------------------------------- billing */

/** subscriptions/{razorpayOrderId} — one per purchase attempt. server. */
const SUBSCRIPTIONS = 'subscriptions';

/** payments/{razorpayPaymentId} — the idempotency key and audit trail. server. */
const PAYMENTS = 'payments';

/* --------------------------------------------------------------- analytics */

/** analyticsEvents/{eventId} — the raw meaningful-event log. internal. */
const ANALYTICS_EVENTS = 'analyticsEvents';

/** analyticsDaily/{YYYY-MM-DD} — counters rolled up as events arrive. internal.
    Exists so a dashboard never recalculates the whole history to draw a line. */
const ANALYTICS_DAILY = 'analyticsDaily';

/** visitorSessions/{sessionId} — anonymous visit records. internal.
    A session id is a random string this server never links to a person unless
    that person signs in, and even then the link is one field, not a merge. */
const VISITOR_SESSIONS = 'visitorSessions';

/* --------------------------------------------------------------- catalogue */

/** missingModelRequests/{normalisedKey} — aggregated "not found" searches. internal. */
const MISSING_MODEL_REQUESTS = 'missingModelRequests';

/** aiTasks/{taskId} — proposed changes awaiting human approval. internal. */
const AI_TASKS = 'aiTasks';

/* --------------------------------------------------------------- operations */

/** adminAuditLog/{entryId} — who did what in the admin area. internal. */
const ADMIN_AUDIT_LOG = 'adminAuditLog';

/** rateLimits/{bucketKey} — fixed-window counters. internal. */
const RATE_LIMITS = 'rateLimits';

/* ------------------------------------------------------- existing catalogue
   Named here so a service never has to guess at the spelling, but owned by the
   importer and completely unchanged by this backend. */
const MODELS = 'models';
const BRANDS = 'brands';
const GROUPS = 'groups';
const GROUP_DETAILS = 'groupDetails';
const MODEL_GROUPS = 'modelGroups';
const DEVICE_GROUPS = 'deviceGroups';
const ALIASES = 'aliases';
const CATALOG = 'catalog';

module.exports = {
  USERS, ADMIN_USERS,
  SUBSCRIPTIONS, PAYMENTS,
  ANALYTICS_EVENTS, ANALYTICS_DAILY, VISITOR_SESSIONS,
  MISSING_MODEL_REQUESTS, AI_TASKS,
  ADMIN_AUDIT_LOG, RATE_LIMITS,
  MODELS, BRANDS, GROUPS, GROUP_DETAILS, MODEL_GROUPS, DEVICE_GROUPS,
  ALIASES, CATALOG
};
