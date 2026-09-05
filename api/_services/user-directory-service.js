/* ============================================================================
   Mobile Parts Finder · api/_services/user-directory-service.js
   ----------------------------------------------------------------------------
   The admin's view of the real user base. Search, filter, sort, paginate, and
   one user's full record.

   ----------------------------------------------------------------------------
   REAL DATA, JOINED FROM THE TWO PLACES IT LIVES

   Firestore users/{uid} is the primary list — it is the collection that can be
   ordered, filtered and paged. Firebase Authentication is then asked about the
   uids on the page, and only those, through getUsers(): ONE call for up to 100
   accounts rather than one call per row.

   That ordering matters. Doing it the other way round — list from Auth, then
   read each profile — is an N+1 pattern AND gives up every server-side filter,
   because listUsers() cannot filter by subscription status or sort by revenue.

   No sample users. No seeded records. If the collection has eleven documents,
   this returns eleven rows.

   ----------------------------------------------------------------------------
   ACCOUNTS THAT EXIST IN AUTH AND NOT IN FIRESTORE

   They are real and they must be visible: someone signed in with Google and
   closed the tab before /api/profile-sync finished. `listOrphanAuthUsers`
   finds them so the admin knows the count, and they are reported honestly as
   accounts with no profile rather than quietly dropped.

   ----------------------------------------------------------------------------
   SEARCH, AND WHY IT IS TWO STRATEGIES

   Firestore has no LIKE, no case-insensitive match and no OR across fields. So:

     · An exact-shaped term — an email, a uid, a phone number — is looked up
       DIRECTLY. Those are the searches that matter operationally ("this
       customer emailed me") and they cost one or two document reads.

     · A name fragment — "sri balaji mobile" — is a prefix range query against
       lower-cased mirror fields, which is the only substring-ish search
       Firestore can do at index speed.

   The mirror fields (mobileShopNameLower, proprietorNameLower,
   displayNameLower, emailLower, mobileDigits) are maintained by
   ensureSearchFields() on every profile write. Existing documents get theirs
   the first time an admin opens them, and scripts/backfill-user-search.js does
   the rest in one pass — see that file for why a backfill beats a migration.

   Until a document has been backfilled it is still FOUND by uid and by email
   (both exact paths, neither needing a mirror), so no user is invisible in the
   meantime.
   ========================================================================== */
'use strict';

const { db, auth } = require('../_lib/firebase');
const { USERS, PAYMENTS } = require('../_schema/collections');
const { toAdminUserView, searchFieldsFor, deriveSubscriptionState, derivePlanStatus } =
  require('../_schema/user-profile');
const { toPaymentView, toSubscriptionView, rollUpPayments } = require('../_schema/billing-records');
const { parseLimit, decodeCursor, encodeCursor } = require('../_lib/pagination');
const v = require('../_lib/validate');

/* ------------------------------------------------------------ search mirrors

   The definition lives in _schema/user-profile.js, because the write path
   (api/_lib/store.js) needs the identical one. Two copies would drift, and a
   drifted mirror is a user who cannot be found by name. */

/**
 * Writes the mirror fields if they are missing or stale.
 *
 * Called on the profile-write path and by the backfill. It is a no-op when
 * nothing changed, so it costs one comparison rather than one write on a
 * profile read.
 *
 * @returns {Promise<boolean>} whether anything was written
 */
async function ensureSearchFields(uid, profile) {
  const wanted = searchFieldsFor(profile);
  const changed = Object.keys(wanted).some(k => (profile || {})[k] !== wanted[k]);
  if (!changed) return false;
  await db().collection(USERS).doc(uid).set(wanted, { merge: true });
  return true;
}

/* ---------------------------------------------------------------- filters */

const FILTERS = [
  'all', 'new', 'active', 'inactive',
  'profile_incomplete', 'profile_complete',
  'free', 'subscription_active', 'subscription_expired',
  'plan_monthly', 'plan_yearly'
];

const SORTS = [
  'newest', 'oldest', 'recently_active', 'longest_inactive',
  'highest_revenue', 'most_payments'
];

/** "New" and "active" both need a window; 30 days is the business's month. */
const NEW_WINDOW_MS = 30 * 24 * 3600 * 1000;
const ACTIVE_WINDOW_MS = 30 * 24 * 3600 * 1000;

/**
 * Reads and validates the query string into a query plan.
 * Nothing downstream ever sees a raw request value.
 */
function parseQuery(query, now) {
  const q = query || {};
  return {
    search: v.searchTerm(q.q || q.search || '', 120),
    filter: v.oneOf(q.filter, FILTERS, 'all'),
    sort: v.oneOf(q.sort, SORTS, 'newest'),
    country: v.string(q.country, 60),
    createdFrom: v.timestamp(q.createdFrom),
    createdTo: v.timestamp(q.createdTo),
    lastLoginFrom: v.timestamp(q.lastLoginFrom),
    lastLoginTo: v.timestamp(q.lastLoginTo),
    limit: parseLimit(q.limit),
    cursor: decodeCursor(q.cursor),
    now
  };
}

/* ------------------------------------------------------------------ search

   Exact lookups first, because they are the ones that answer a support
   question in one read. */

function looksLikeEmail(term) {
  return term.indexOf('@') > -1;
}
function looksLikeUid(term) {
  /* A Firebase uid is 28 characters of mixed-case base64url. Long, no spaces,
     and — the part that distinguishes it from a shop name — no lower-case-only
     word shape: a real uid essentially always carries both cases or a digit. */
  return /^[A-Za-z0-9_-]{20,128}$/.test(term) && /[0-9]/.test(term) && /[A-Z]/.test(term);
}
function looksLikePhone(term) {
  const d = v.digits(term);
  return d.length >= 6 && /^[+0-9\s()-]+$/.test(term);
}

/**
 * The exact-match paths. Returns null when the term is not one of these
 * shapes, so the caller falls through to a prefix search.
 *
 * @returns {Promise<{docs:Array, exact:true}|null>}
 */
async function exactLookup(term) {
  const store = db();

  if (looksLikeEmail(term)) {
    const lower = term.toLowerCase();
    /* Both fields, because emailLower may not be backfilled yet on an older
       document while `email` always exists. The union is de-duplicated below. */
    const [byLower, byRaw] = await Promise.all([
      store.collection(USERS).where('emailLower', '==', lower).limit(10).get(),
      store.collection(USERS).where('email', '==', term).limit(10).get()
    ]);
    return { docs: dedupe(byLower.docs.concat(byRaw.docs)), exact: true };
  }

  if (looksLikePhone(term)) {
    const d = v.digits(term);
    const [byDigits, byRaw] = await Promise.all([
      store.collection(USERS).where('mobileDigits', '==', d).limit(10).get(),
      store.collection(USERS).where('mobileNumber', '==', term).limit(10).get()
    ]);
    const found = dedupe(byDigits.docs.concat(byRaw.docs));
    if (found.length) return { docs: found, exact: true };
    /* A number that matched nothing is not necessarily a number — "12345"
       could be a shop name. Fall through rather than reporting no results. */
  }

  if (looksLikeUid(term)) {
    const snap = await store.collection(USERS).doc(term).get();
    if (snap.exists) return { docs: [snap], exact: true };
    /* An unknown uid-shaped string might still be a shop name. Fall through. */
  }

  return null;
}

function dedupe(docs) {
  const seen = new Set();
  return docs.filter(d => (seen.has(d.id) ? false : (seen.add(d.id), true)));
}

/**
 * Prefix search across the three name fields.
 *
 * Firestore cannot OR across fields, so this is three range queries run in
 * parallel and merged. Each is bounded by `limit`, so the worst case is three
 * small index scans rather than a collection walk.
 *
 * A prefix search finds "Sri Balaji" from "sri bal". It does NOT find it from
 * "balaji" — Firestore cannot do that, and pretending otherwise with a
 * client-side contains() over the whole collection is the "download the entire
 * user database into the browser" pattern this design exists to avoid. When
 * mid-word search becomes necessary, the answer is a search index (Algolia,
 * Typesense, or Firestore's own vector/text search when it ships), not a
 * bigger download.
 */
async function prefixSearch(term, limit) {
  const store = db();
  const lower = term.toLowerCase();
  /* U+F8FF sorts above every character that appears in a name, so
     startAt(term) with endAt(term + sentinel) is a prefix match. */
  const PREFIX_SENTINEL = String.fromCharCode(0xf8ff);
  const end = lower + PREFIX_SENTINEL;

  const fields = ['mobileShopNameLower', 'proprietorNameLower', 'displayNameLower'];
  const snaps = await Promise.all(fields.map(field =>
    store.collection(USERS)
      .orderBy(field)
      .startAt(lower)
      .endAt(end)
      .limit(limit)
      .get()
      .catch(err => {
        /* A missing index is a deployment step, not a reason to fail the whole
           search — the other two fields still answer. */
        console.warn('[users] prefix search unavailable on', field, err && err.code);
        return { docs: [] };
      })
  ));

  return dedupe(snaps.flatMap(s => s.docs));
}

/* ------------------------------------------------------------------ listing */

/**
 * Applies the filter to a Firestore query where the index allows it, and
 * reports which parts still have to be applied in memory.
 *
 * The split is honest rather than convenient: a filter applied in memory only
 * sees the page it was given, so the route must know not to claim a total.
 */
function applyFilters(query, plan) {
  let q = query;
  const inMemory = [];

  switch (plan.filter) {
    case 'profile_complete':
      q = q.where('profileCompleted', '==', true);
      break;
    case 'profile_incomplete':
      q = q.where('profileCompleted', '==', false);
      break;
    case 'subscription_active':
      q = q.where('activeSubscriptionStatus', '==', 'active');
      /* Status alone is not access — the date decides, against the server
         clock. Applied in memory because Firestore cannot combine an equality
         on one field with an inequality on another AND an unrelated orderBy. */
      inMemory.push(row => deriveSubscriptionState(row, plan.now) === 'subscription_active');
      break;
    case 'subscription_expired':
      inMemory.push(row => derivePlanStatus(row, plan.now) === 'expired');
      break;
    case 'free':
      inMemory.push(row => {
        const status = derivePlanStatus(row, plan.now);
        return status === 'none';
      });
      break;
    case 'plan_monthly':
      q = q.where('currentPlanId', '==', 'monthly');
      break;
    case 'plan_yearly':
      q = q.where('currentPlanId', '==', 'yearly');
      break;
    case 'new':
      inMemory.push(row => Number(row.createdAt) >= plan.now - NEW_WINDOW_MS);
      break;
    case 'active':
      inMemory.push(row => {
        const seen = Number(row.lastLoginAt || row.lastActiveAt || row.updatedAt);
        return Number.isFinite(seen) && seen >= plan.now - ACTIVE_WINDOW_MS;
      });
      break;
    case 'inactive':
      inMemory.push(row => {
        const seen = Number(row.lastLoginAt || row.lastActiveAt || row.updatedAt);
        return !Number.isFinite(seen) || seen < plan.now - ACTIVE_WINDOW_MS;
      });
      break;
    default:
      break;
  }

  if (plan.country) q = q.where('country', '==', plan.country);

  return { query: q, inMemory };
}

/** The orderBy for each sort, and how to read a cursor position back out. */
const SORT_SPECS = {
  newest: { field: 'createdAt', direction: 'desc' },
  oldest: { field: 'createdAt', direction: 'asc' },
  recently_active: { field: 'lastLoginAt', direction: 'desc' },
  longest_inactive: { field: 'lastLoginAt', direction: 'asc' },
  /* Revenue and payment count are not stored on the user document — they are
     derived from the payments collection, and denormalising them onto the user
     would be a number that drifts. So these two sort the PAGE, and the route
     says so rather than implying a global ranking. See listUsers. */
  highest_revenue: { field: 'createdAt', direction: 'desc', pageOnly: 'billing.totalPaidPaise' },
  most_payments: { field: 'createdAt', direction: 'desc', pageOnly: 'billing.successfulPayments' }
};

/**
 * One page of users.
 *
 * @returns {Promise<{users:Array, nextCursor:string|null, hasMore:boolean,
 *                    approximate:boolean, sortScope:'global'|'page'}>}
 */
async function listUsers(plan) {
  const store = db();
  let docs;
  let hasMore = false;
  let nextCursor = null;
  let approximate = false;

  if (plan.search) {
    /* A search ignores the cursor: search results are small and the term is
       the navigation. Paging a search that returns nine rows is ceremony. */
    const exact = await exactLookup(plan.search);
    docs = exact ? exact.docs : await prefixSearch(plan.search, plan.limit);
    approximate = true;                       /* the count is "what matched", not a total */
  } else {
    const spec = SORT_SPECS[plan.sort] || SORT_SPECS.newest;
    const { query, inMemory } = applyFilters(store.collection(USERS), plan);

    let q = query.orderBy(spec.field, spec.direction);
    /* A second orderBy on the document id makes the sort total — without it,
       two users created in the same millisecond can both appear or both be
       skipped at a page boundary. */
    q = q.orderBy('__name__', spec.direction);
    if (plan.cursor) q = q.startAfter.apply(q, plan.cursor);

    /* Over-fetch when filters run in memory, so a page is not left half empty
       by rows the query could not exclude. Capped, because the point of paging
       is to not read the collection. */
    const overFetch = inMemory.length ? 4 : 1;
    const snap = await q.limit(plan.limit * overFetch + 1).get();

    let rows = snap.docs;
    if (inMemory.length) {
      rows = rows.filter(d => inMemory.every(f => f(d.data())));
      approximate = true;                     /* filtered after the fact — see header */
    }

    hasMore = snap.docs.length > plan.limit * overFetch;
    docs = rows.slice(0, plan.limit);

    const last = docs.length ? docs[docs.length - 1] : null;
    if (last && (hasMore || rows.length > plan.limit)) {
      const value = last.data()[spec.field];
      nextCursor = encodeCursor([value === undefined ? null : value, last.id]);
    }
  }

  const enriched = await enrichUsers(docs, plan.now);

  /* Date-range filters, applied last because they read the joined view — which
     is where createdAt from Auth fills in for a profile that has none. */
  const filtered = enriched.filter(u => inDateRanges(u, plan));
  if (filtered.length !== enriched.length) approximate = true;

  const spec = SORT_SPECS[plan.sort] || SORT_SPECS.newest;
  if (spec.pageOnly) {
    filtered.sort((a, b) => readPath(b, spec.pageOnly) - readPath(a, spec.pageOnly));
  }

  return {
    users: filtered,
    nextCursor,
    hasMore,
    /* True when some filtering happened after the query, so the caller must
       not present the row count as a total. Saying so beats a wrong number. */
    approximate,
    sortScope: spec.pageOnly ? 'page' : 'global'
  };
}

function readPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? 0 : o[k]), obj) || 0;
}

function inDateRanges(user, plan) {
  const created = user.createdAt;
  const login = user.lastLoginAt;
  if (plan.createdFrom != null && !(created != null && created >= plan.createdFrom)) return false;
  if (plan.createdTo != null && !(created != null && created <= plan.createdTo)) return false;
  if (plan.lastLoginFrom != null && !(login != null && login >= plan.lastLoginFrom)) return false;
  if (plan.lastLoginTo != null && !(login != null && login <= plan.lastLoginTo)) return false;
  return true;
}

/* ------------------------------------------------------------- enrichment */

/**
 * Joins a page of profile documents to Firebase Authentication and to the
 * payments rollup.
 *
 * Both joins are BATCHED. getUsers() takes up to 100 identifiers in one call,
 * and the payments rollup uses one `in` query per 30 uids — the two things
 * that stop this being N+1.
 */
async function enrichUsers(docs, now) {
  if (!docs.length) return [];

  const uids = docs.map(d => d.id);
  const [authRecords, billing] = await Promise.all([
    fetchAuthRecords(uids),
    fetchBillingRollups(uids)
  ]);

  return docs.map(d => toAdminUserView({
    uid: d.id,
    profile: d.data(),
    authRecord: authRecords.get(d.id) || null,
    billing: billing.get(d.id) || null,
    now
  }));
}

/**
 * Firebase Auth records for up to 100 uids, in one call.
 *
 * A uid present in Firestore and absent from Auth is a deleted account whose
 * profile was left behind. It is not an error — the map simply has no entry,
 * and the view falls back to the profile's own fields.
 */
async function fetchAuthRecords(uids) {
  const map = new Map();
  if (!uids.length) return map;

  const chunks = chunk(uids, 100);
  const results = await Promise.all(chunks.map(async ids => {
    try {
      return await auth().getUsers(ids.map(uid => ({ uid })));
    } catch (err) {
      console.warn('[users] auth lookup failed', err && err.message);
      return { users: [] };
    }
  }));

  results.forEach(r => (r.users || []).forEach(u => {
    map.set(u.uid, {
      email: u.email || null,
      emailVerified: !!u.emailVerified,
      displayName: u.displayName || null,
      photoURL: u.photoURL || null,
      disabled: !!u.disabled,
      providerId: (u.providerData && u.providerData[0] && u.providerData[0].providerId) || null,
      createdAt: toMs(u.metadata && u.metadata.creationTime),
      lastSignInAt: toMs(u.metadata && u.metadata.lastSignInTime),
      lastRefreshAt: toMs(u.metadata && u.metadata.lastRefreshTime)
    });
  }));

  return map;
}

function toMs(value) {
  if (!value) return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Payment totals per uid.
 *
 * One `in` query per 30 uids, which is Firestore's cap. For a 25-row page that
 * is one query, and the alternative — a query per user — is 25.
 */
async function fetchBillingRollups(uids) {
  const map = new Map();
  if (!uids.length) return map;

  const store = db();
  const chunks = chunk(uids, 30);
  const snaps = await Promise.all(chunks.map(ids =>
    store.collection(PAYMENTS).where('uid', 'in', ids).get()
      .catch(err => {
        console.warn('[users] payment rollup failed', err && err.message);
        return { docs: [] };
      })
  ));

  const byUid = new Map();
  snaps.forEach(s => s.docs.forEach(d => {
    const payment = toPaymentView(d.id, d.data());
    if (!payment.userId) return;
    if (!byUid.has(payment.userId)) byUid.set(payment.userId, []);
    byUid.get(payment.userId).push(payment);
  }));

  byUid.forEach((payments, uid) => map.set(uid, rollUpPayments(payments)));
  return map;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/* --------------------------------------------------------------- one user */

/**
 * Everything known about one account: profile, auth record, subscriptions,
 * payments — and nothing invented to fill a gap.
 *
 * @returns {Promise<object|null>} null when neither Auth nor Firestore has them
 */
async function getUserDetail(uid, now, { includePayments = true } = {}) {
  const store = db();

  const [profileSnap, authRecord] = await Promise.all([
    store.collection(USERS).doc(uid).get(),
    auth().getUser(uid).then(flattenAuth).catch(() => null)
  ]);

  const profile = profileSnap.exists ? profileSnap.data() : null;
  if (!profile && !authRecord) return null;

  let payments = [];
  let subscriptions = [];
  if (includePayments) {
    const [paySnap, subSnap] = await Promise.all([
      store.collection(PAYMENTS).where('uid', '==', uid).limit(200).get()
        .catch(() => ({ docs: [] })),
      store.collection('subscriptions').where('uid', '==', uid).limit(200).get()
        .catch(() => ({ docs: [] }))
    ]);
    payments = paySnap.docs.map(d => toPaymentView(d.id, d.data()))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    subscriptions = subSnap.docs.map(d => toSubscriptionView(d.id, d.data()))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  const view = toAdminUserView({
    uid,
    profile,
    authRecord,
    billing: rollUpPayments(payments),
    now
  });

  return {
    ...view,
    /* An account that authenticated and never got a profile document. Named
       explicitly so the admin sees a real state rather than a row of dashes
       with no explanation. */
    hasProfileRecord: !!profile,
    payments,
    subscriptions
  };
}

function flattenAuth(u) {
  return {
    email: u.email || null,
    emailVerified: !!u.emailVerified,
    displayName: u.displayName || null,
    photoURL: u.photoURL || null,
    disabled: !!u.disabled,
    providerId: (u.providerData && u.providerData[0] && u.providerData[0].providerId) || null,
    createdAt: toMs(u.metadata && u.metadata.creationTime),
    lastSignInAt: toMs(u.metadata && u.metadata.lastSignInTime),
    lastRefreshAt: toMs(u.metadata && u.metadata.lastRefreshTime)
  };
}

/**
 * Accounts in Firebase Authentication with no users/{uid} document.
 *
 * Bounded on purpose: this pages through Auth, which no dashboard should do on
 * every load. The route calls it only when asked, and reports the cap it hit.
 */
async function listOrphanAuthUsers({ max = 200, now }) {
  const orphans = [];
  let pageToken;
  let scanned = 0;

  do {
    const page = await auth().listUsers(Math.min(1000, max), pageToken);
    scanned += page.users.length;
    const uids = page.users.map(u => u.uid);
    const snaps = await Promise.all(chunk(uids, 100).map(ids =>
      Promise.all(ids.map(id => db().collection(USERS).doc(id).get()))
    ));
    const existing = new Set(snaps.flat().filter(s => s.exists).map(s => s.id));

    page.users.forEach(u => {
      if (existing.has(u.uid)) return;
      if (orphans.length >= max) return;
      orphans.push(toAdminUserView({
        uid: u.uid, profile: null, authRecord: flattenAuth(u), billing: null, now
      }));
    });

    pageToken = page.pageToken;
  } while (pageToken && orphans.length < max && scanned < 5000);

  return { orphans, scanned, truncated: !!pageToken };
}

module.exports = {
  FILTERS, SORTS,
  searchFieldsFor, ensureSearchFields,
  parseQuery, listUsers, getUserDetail, listOrphanAuthUsers,
  fetchAuthRecords, fetchBillingRollups
};
