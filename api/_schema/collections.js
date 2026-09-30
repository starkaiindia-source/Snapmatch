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

/* ------------------------------------------ instagram compatibility intelligence

   Instagram is a SOURCE of compatibility claims, never an authority. Nothing
   in these collections is read by the customer site; a claim reaches the
   production fitment data (groupDetails / groups / modelGroups) only through an
   administrator's approval in review-service.js. All internal. */

/** instagramSources/{ig_<username>} — a page/profile and its access verdict. */
const INSTAGRAM_SOURCES = 'instagramSources';

/** instagramImportJobs/{jobId} — one import; items/{itemKey} under it is the
    resumable work queue. */
const INSTAGRAM_IMPORT_JOBS = 'instagramImportJobs';
const INSTAGRAM_JOB_ITEMS = 'items';

/** instagramContent/{contentKey} — one post/reel as collected, with hashes. */
const INSTAGRAM_CONTENT = 'instagramContent';

/** instagramExtractions/{contentKey}__v{n} — one processing VERSION of a
    content item. A changed post gets a new version; the old one is kept. */
const INSTAGRAM_EXTRACTIONS = 'instagramExtractions';

/** compatibilityCandidates/{candidateId} — the admin review queue. Model
    match candidates live on each document (sourceMatch / compatibleMatch),
    so there is one queue, not two that can disagree. */
const COMPATIBILITY_CANDIDATES = 'compatibilityCandidates';

/** compatibilityEvidence/{evidenceId} — every source statement, including the
    ones that turned out to be duplicates or conflicts. */
const COMPATIBILITY_EVIDENCE = 'compatibilityEvidence';

/** approvedCompatibilities/{relKey} — the approved ledger: why a production
    fitment exists, who approved it, and what exactly was written. */
const APPROVED_COMPATIBILITIES = 'approvedCompatibilities';

/** instagramMediaCache/{hash} — OCR / video / AI results by content hash, so
    the same media is never sent to a paid service twice. */
const INSTAGRAM_MEDIA_CACHE = 'instagramMediaCache';

/** instagramUsageDaily/{YYYY-MM-DD} — API, OCR and AI call counters, the
    input to the daily caps. */
const INSTAGRAM_USAGE_DAILY = 'instagramUsageDaily';

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
  INSTAGRAM_SOURCES, INSTAGRAM_IMPORT_JOBS, INSTAGRAM_JOB_ITEMS, INSTAGRAM_CONTENT,
  INSTAGRAM_EXTRACTIONS, COMPATIBILITY_CANDIDATES, COMPATIBILITY_EVIDENCE,
  APPROVED_COMPATIBILITIES, INSTAGRAM_MEDIA_CACHE, INSTAGRAM_USAGE_DAILY,
  ADMIN_AUDIT_LOG, RATE_LIMITS,
  MODELS, BRANDS, GROUPS, GROUP_DETAILS, MODEL_GROUPS, DEVICE_GROUPS,
  ALIASES, CATALOG
};
