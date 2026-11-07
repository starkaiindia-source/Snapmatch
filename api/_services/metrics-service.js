/* ============================================================================
   Mobile Parts Finder · api/_services/metrics-service.js
   ----------------------------------------------------------------------------
   The dashboard's numbers. All of them real, none of them guessed.

   ----------------------------------------------------------------------------
   THE RULE THIS FILE IS BUILT AROUND

   Every figure here is either counted from production data or reported as
   unavailable. There is no seeded chart, no plausible-looking baseline, no
   `Math.random()` anywhere in this project. A dashboard that shows an invented
   number is worse than one that shows nothing, because someone will make a
   decision on it.

   When a figure genuinely cannot be produced — no payments yet, analytics not
   yet collecting — the value is 0 or null and `available` says which. The UI
   renders "No data yet". That is the honest answer to "how much revenue this
   week" on a week with no payments, and it is also the honest answer on a week
   where nothing was recorded; the two are told apart by `available`.

   ----------------------------------------------------------------------------
   HOW IT STAYS CHEAP

   Counting with count(): Firestore's aggregation query returns a count without
   reading the documents. A "total registered users" that fetches every user
   document to call .length is the thing that makes an admin dashboard cost
   more than the site. count() bills roughly one read per thousand index
   entries, so the whole metrics panel is single-digit reads.

   Revenue is the exception: sum() over payments failed in production with
   INVALID_ARGUMENT, so the captured payments are read once (dozens of
   documents) and added up here. Past thousands of payments it moves to a
   maintained counter.

   The growth SERIES is different — it needs one number per day, not one total.
   Firestore cannot GROUP BY, so this reads the createdAt field only
   (`.select()`, which cuts the payload though not the read count) over the
   requested window, with a hard cap. Past the cap the series is reported
   `truncated: true` rather than silently wrong. The upgrade path is the daily
   rollup documents that analytics-service already maintains going forward.
   ========================================================================== */
'use strict';

const { db } = require('../_lib/firebase');
const { USERS, PAYMENTS, SUBSCRIPTIONS, ANALYTICS_EVENTS, ANALYTICS_DAILY } =
  require('../_schema/collections');

const DAY_MS = 24 * 3600 * 1000;

/* The code and Firestore's own words, which name the missing index or the bad
   argument; the code alone (3, 9) says only that something is wrong. */
const why = err => (err ? `${err.code || ''} ${String(err.details || err.message || '').slice(0, 300)}` : '');

/**
 * The most user documents a growth series will scan.
 *
 * At this size the query is still fast and the response is still small. Past
 * it the answer is honestly truncated rather than slow — an admin dashboard
 * that takes eight seconds is one nobody opens.
 */
const SERIES_SCAN_CAP = 5000;

/* --------------------------------------------------------------- counting */

/**
 * count() with a fallback.
 *
 * Aggregation queries need an index for the fields they filter on, and a
 * missing index throws FAILED_PRECONDITION. That is a deployment step
 * (`firebase deploy --only firestore:indexes`), not a reason for the whole
 * dashboard to 500 — so a failed count returns null and the tile says the
 * figure is unavailable.
 *
 * @returns {Promise<number|null>}
 */
async function countOf(query, label) {
  try {
    const snap = await query.count().get();
    return snap.data().count;
  } catch (err) {
    console.warn('[metrics] count failed', label, why(err));
    return null;
  }
}

/* -------------------------------------------------------------- boundaries

   Day boundaries are UTC everywhere. A dashboard where "today" means one thing
   in a query and another in a chart label is a dashboard whose Monday number
   changes depending on which panel you read. */

function startOfDay(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function startOfWeek(now) {
  /* Monday. India's business week, and the one every weekly report assumes. */
  const d = new Date(startOfDay(now));
  const dow = (d.getUTCDay() + 6) % 7;
  return d.getTime() - dow * DAY_MS;
}
function startOfMonth(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function boundaries(now) {
  return { today: startOfDay(now), week: startOfWeek(now), month: startOfMonth(now) };
}

/* ------------------------------------------------------------ user metrics */

async function userMetrics(now) {
  const store = db();
  const users = store.collection(USERS);
  const b = boundaries(now);
  const activeWindow = now - 30 * DAY_MS;

  const [
    total, newToday, newWeek, newMonth,
    activeToday, activeWeek, activeMonth,
    profileComplete, profileIncomplete
  ] = await Promise.all([
    countOf(users, 'users.total'),
    countOf(users.where('createdAt', '>=', b.today), 'users.newToday'),
    countOf(users.where('createdAt', '>=', b.week), 'users.newWeek'),
    countOf(users.where('createdAt', '>=', b.month), 'users.newMonth'),
    countOf(users.where('lastLoginAt', '>=', b.today), 'users.activeToday'),
    countOf(users.where('lastLoginAt', '>=', b.week), 'users.activeWeek'),
    countOf(users.where('lastLoginAt', '>=', b.month), 'users.activeMonth'),
    countOf(users.where('profileCompleted', '==', true), 'users.complete'),
    countOf(users.where('profileCompleted', '==', false), 'users.incomplete')
  ]);

  return {
    total,
    newToday, newThisWeek: newWeek, newThisMonth: newMonth,
    activeToday, activeThisWeek: activeWeek, activeThisMonth: activeMonth,
    profileComplete,
    profileIncomplete,
    /* Active means "signed in within 30 days", stated rather than implied so
       nobody has to reverse-engineer it from a number. */
    activeWindowDays: 30,
    activeWindowFrom: activeWindow
  };
}

/* ---------------------------------------------------- subscription metrics */

async function subscriptionMetrics(now) {
  const store = db();
  const users = store.collection(USERS);
  const subs = store.collection(SUBSCRIPTIONS);

  const [
    activeStatus, monthly, yearly, lifetime, totalUsers, expired, cancelled, pending
  ] = await Promise.all([
    countOf(users.where('activeSubscriptionStatus', '==', 'active'), 'subs.active'),
    countOf(users.where('currentPlanId', '==', 'monthly')
      .where('activeSubscriptionStatus', '==', 'active'), 'subs.monthly'),
    countOf(users.where('currentPlanId', '==', 'yearly')
      .where('activeSubscriptionStatus', '==', 'active'), 'subs.yearly'),
    /* Lifetime is granted by an administrator and never paid for, so it is
       counted as access and appears nowhere in the revenue figures. */
    countOf(users.where('currentPlanId', '==', 'lifetime')
      .where('activeSubscriptionStatus', '==', 'active'), 'subs.lifetime'),
    countOf(users, 'subs.totalUsers'),
    countOf(users.where('activeSubscriptionStatus', '==', 'expired'), 'subs.expired'),
    countOf(subs.where('status', '==', 'cancelled'), 'subs.cancelled'),
    countOf(subs.where('status', '==', 'pending'), 'subs.pending')
  ]);

  /* `activeStatus` counts the stored flag; a subscription whose expiry has
     passed but whose flag has not been rewritten yet is counted here and
     corrected the next time that user's status is read. The lag is bounded by
     one visit per user, and naming it beats silently reporting a number whose
     definition nobody can find. */
  const stillRunning = await countOf(
    users.where('activeSubscriptionStatus', '==', 'active')
      .where('subscriptionExpiresAt', '>', now),
    'subs.stillRunning'
  );

  /* "Free accounts" is everyone who is not currently subscribed. Derived
     rather than counted, because there is no stored flag for it and adding one
     would be a field that drifts the moment a subscription lapses. Null when
     either half is unavailable — a subtraction with a missing operand is not a
     number, it is a guess. */
  const free = totalUsers != null && activeStatus != null
    ? Math.max(0, totalUsers - activeStatus)
    : null;

  /* `stillRunning` filters on an expiry in the future, and Lifetime has no
     expiry at all — a null is not greater than now — so it would drop every
     Lifetime account out of the active total. They are added back here. */
  const running = stillRunning != null
    ? stillRunning + (lifetime || 0)
    : activeStatus;

  return {
    totalActive: running,
    flaggedActive: activeStatus,
    monthly,
    yearly,
    lifetime,
    free,
    expired,
    cancelled,
    pending
  };
}

/* --------------------------------------------------------- revenue metrics */

/**
 * Money, from the payments collection and nowhere else.
 *
 * Only `status == 'captured'` is summed. A failed payment carries the amount
 * that was refused, and counting it is how a dashboard reports revenue that
 * never arrived.
 *
 * Amounts are paise throughout — the currency the payment records store and
 * the currency Razorpay charges in. Converting to rupees happens once, in the
 * UI, at the point of display.
 */
async function revenueMetrics(now, paid) {
  const store = db();
  const b = boundaries(now);

  /* Every money figure comes from ONE read of the captured payments, added up
     here. Firestore's sum() over this collection answered INVALID_ARGUMENT in
     production (every index is deployed; it is not an index), which left six
     tiles and the revenue chart blank. Payments number in the dozens, so the
     read costs one document each and gives exact figures. */
  const [captured, failedCount] = await Promise.all([
    paid === undefined ? capturedPayments() : paid,
    countOf(store.collection(PAYMENTS).where('status', '==', 'failed'), 'revenue.failedCount')
  ]);

  const none = {
    currency: 'INR', todayPaise: null, thisWeekPaise: null, thisMonthPaise: null,
    lifetimePaise: null, monthlyPlanPaise: null, yearlyPlanPaise: null,
    averageRevenuePerPayingUserPaise: null, successfulPayments: null,
    failedPayments: failedCount, pendingPayments: null, payingUsers: null
  };
  if (!captured) return none;

  const add = keep => captured.rows.reduce((t, r) => t + (keep(r) ? r.amount : 0), 0);
  const lifetime = add(() => true);
  const payers = new Set(captured.rows.map(r => r.uid).filter(Boolean)).size;

  return {
    currency: 'INR',
    todayPaise: add(r => r.at != null && r.at >= b.today),
    thisWeekPaise: add(r => r.at != null && r.at >= b.week),
    thisMonthPaise: add(r => r.at != null && r.at >= b.month),
    lifetimePaise: lifetime,
    monthlyPlanPaise: add(r => r.planId === 'monthly'),
    yearlyPlanPaise: add(r => r.planId === 'yearly'),
    averageRevenuePerPayingUserPaise: payers ? Math.round(lifetime / payers) : null,
    successfulPayments: captured.rows.length,
    failedPayments: failedCount,
    /* Razorpay reports authorised-but-not-captured separately; nothing in this
       codebase writes that state, so it is honestly null rather than 0. */
    pendingPayments: null,
    payingUsers: payers,
    truncated: captured.truncated
  };
}

/**
 * The captured payments, as plain rows. A plain filtered read: no projection
 * and no aggregation, which are the two shapes that failed. Capped like every
 * scan here, and says so when the cap bites.
 *
 * @returns {Promise<{rows:Array<{uid:?string,amount:number,planId:?string,at:?number}>, truncated:boolean}|null>}
 */
async function capturedPayments() {
  try {
    const snap = await db().collection(PAYMENTS)
      .where('status', '==', 'captured')
      .limit(SERIES_SCAN_CAP + 1)
      .get();
    const truncated = snap.docs.length > SERIES_SCAN_CAP;
    const rows = (truncated ? snap.docs.slice(0, SERIES_SCAN_CAP) : snap.docs).map(d => {
      const x = d.data();
      return { uid: x.uid || null, amount: Number(x.amount) || 0, planId: x.planId || null, at: millis(x.createdAt) };
    });
    return { rows, truncated };
  } catch (err) {
    console.warn('[metrics] payments read failed', why(err));
    return null;
  }
}

/** Epoch ms from a stored number or a Firestore Timestamp. */
function millis(v) {
  if (v && typeof v.toMillis === 'function') return v.toMillis();
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : null;
}

/** Daily revenue from the same rows, in the shape dailySeries returns. */
function revenueSeries(captured, from, to) {
  if (!captured) return { points: [], truncated: false, available: false };
  const buckets = new Map();
  for (let day = startOfDay(from); day <= to; day += DAY_MS) buckets.set(dayKey(day), 0);
  captured.rows.forEach(r => {
    if (r.at == null || r.at < from || r.at > to) return;
    const key = dayKey(r.at);
    buckets.set(key, (buckets.get(key) || 0) + r.amount);
  });
  const points = Array.from(buckets.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, value]) => ({ date, value }));
  return { points, truncated: captured.truncated, available: true };
}

/* ------------------------------------------------------------ growth series */

/**
 * One bucket per day, from real timestamps.
 *
 * @param {object} args
 * @param {string} args.collection
 * @param {string} args.field       the timestamp field to bucket by
 * @param {number} args.from
 * @param {number} args.to
 * @param {string} [args.valueField] sum this instead of counting
 * @param {Array<[string,string,any]>} [args.where] extra equality filters
 */
async function dailySeries({ collection, field, from, to, valueField, where = [] }) {
  let q = db().collection(collection);
  where.forEach(([f, op, val]) => { q = q.where(f, op, val); });
  q = q.where(field, '>=', from).where(field, '<=', to).orderBy(field, 'asc');

  const projection = valueField ? [field, valueField] : [field];

  let snap;
  try {
    snap = await q.select.apply(q, projection).limit(SERIES_SCAN_CAP + 1).get();
  } catch (err) {
    console.warn('[metrics] series failed', collection, field, why(err));
    return { points: [], truncated: false, available: false };
  }

  const truncated = snap.docs.length > SERIES_SCAN_CAP;
  const docs = truncated ? snap.docs.slice(0, SERIES_SCAN_CAP) : snap.docs;

  /* Every day in the range gets a bucket, including the empty ones. A chart
     that skips days with no signups draws a line implying steady growth
     through a week where nothing happened. */
  const buckets = new Map();
  for (let day = startOfDay(from); day <= to; day += DAY_MS) {
    buckets.set(dayKey(day), 0);
  }

  docs.forEach(d => {
    const data = d.data();
    const at = Number(data[field]);
    if (!Number.isFinite(at)) return;
    const key = dayKey(at);
    if (!buckets.has(key)) buckets.set(key, 0);
    buckets.set(key, buckets.get(key) + (valueField ? Number(data[valueField]) || 0 : 1));
  });

  const points = Array.from(buckets.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, value]) => ({ date, value }));

  return { points, truncated, available: true };
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Rolls daily points up into weeks and months, so the dashboard gets all three
 * granularities from one scan instead of three.
 */
function rollUpSeries(points) {
  const weekly = new Map();
  const monthly = new Map();

  points.forEach(({ date, value }) => {
    const ms = Date.parse(date + 'T00:00:00Z');
    const wk = dayKey(startOfWeek(ms));
    const mo = date.slice(0, 7);
    weekly.set(wk, (weekly.get(wk) || 0) + value);
    monthly.set(mo, (monthly.get(mo) || 0) + value);
  });

  const toPoints = map => Array.from(map.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, value]) => ({ date, value }));

  return { weekly: toPoints(weekly), monthly: toPoints(monthly) };
}

/* ---------------------------------------------------------------- activity

   Website activity comes from the analytics events, and those only exist from
   the day collection was switched on. Before that the answer is "no data yet",
   which is different from zero and is reported as such. */

async function activityMetrics(now, days = 30) {
  const from = startOfDay(now) - (days - 1) * DAY_MS;
  const store = db();

  const eventCount = await countOf(
    store.collection(ANALYTICS_EVENTS).where('timestamp', '>=', from),
    'activity.total'
  );

  if (!eventCount) {
    return {
      available: false,
      reason: 'no analytics events recorded in this window yet',
      windowDays: days
    };
  }

  const [searches, modelsOpened, groupsOpened, zeroResults] = await Promise.all([
    countOf(store.collection(ANALYTICS_EVENTS)
      .where('eventType', '==', 'model_search').where('timestamp', '>=', from), 'activity.search'),
    countOf(store.collection(ANALYTICS_EVENTS)
      .where('eventType', '==', 'model_opened').where('timestamp', '>=', from), 'activity.model'),
    countOf(store.collection(ANALYTICS_EVENTS)
      .where('eventType', '==', 'compatibility_group_opened').where('timestamp', '>=', from), 'activity.group'),
    countOf(store.collection(ANALYTICS_EVENTS)
      .where('eventType', '==', 'search_zero_result').where('timestamp', '>=', from), 'activity.zero')
  ]);

  return {
    available: true,
    windowDays: days,
    totalEvents: eventCount,
    searchesPerformed: searches,
    modelsOpened,
    compatibilityGroupsOpened: groupsOpened,
    zeroResultSearches: zeroResults
  };
}

/**
 * Top search terms, brands and categories.
 *
 * Read from the daily rollup documents, which analytics-service maintains as
 * events arrive. Recomputing a top-ten by scanning every event on every
 * dashboard load is exactly the pattern that makes an analytics page cost more
 * than the feature it measures.
 */
async function topLists(now, days = 30) {
  const from = startOfDay(now) - (days - 1) * DAY_MS;
  const keys = [];
  for (let d = from; d <= now; d += DAY_MS) keys.push(dayKey(d));

  let snaps;
  try {
    snaps = await db().getAll.apply(
      db(),
      keys.map(k => db().collection(ANALYTICS_DAILY).doc(k))
    );
  } catch (err) {
    console.warn('[metrics] rollups unavailable', why(err));
    return { available: false, windowDays: days };
  }

  const merge = (into, from2) => {
    Object.keys(from2 || {}).forEach(k => { into[k] = (into[k] || 0) + Number(from2[k] || 0); });
    return into;
  };

  const searchTerms = {};
  const brands = {};
  const categories = {};
  const models = {};
  const zeroTerms = {};
  let any = false;

  snaps.forEach(s => {
    if (!s.exists) return;
    any = true;
    const d = s.data();
    merge(searchTerms, d.topSearchTerms);
    merge(brands, d.topBrands);
    merge(categories, d.topCategories);
    merge(models, d.topModels);
    merge(zeroTerms, d.zeroResultTerms);
  });

  if (!any) return { available: false, windowDays: days };

  const top = (obj, n = 10) => Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));

  return {
    available: true,
    windowDays: days,
    topSearchTerms: top(searchTerms),
    topBrands: top(brands),
    topCategories: top(categories),
    topModels: top(models),
    zeroResultTerms: top(zeroTerms)
  };
}

/* ------------------------------------------------------------- the whole lot */

/**
 * Everything the dashboard shows, in one call.
 *
 * Run in parallel because they are independent, and because six sequential
 * round trips to Firestore is the difference between a dashboard that feels
 * instant and one that does not.
 *
 * @param {object} args
 * @param {number} args.now
 * @param {number} [args.growthDays]
 * @param {boolean} [args.includeRevenue] false for a role without revenue.read
 */
async function dashboard({ now, growthDays = 30, includeRevenue = true }) {
  const from = startOfDay(now) - (growthDays - 1) * DAY_MS;

  const paid = includeRevenue ? await capturedPayments() : null;

  const [users, subscriptions, revenue, userGrowth, subscriptionGrowth, activity, tops] =
    await Promise.all([
      userMetrics(now),
      subscriptionMetrics(now),
      includeRevenue ? revenueMetrics(now, paid) : Promise.resolve(null),
      dailySeries({ collection: USERS, field: 'createdAt', from, to: now }),
      dailySeries({
        collection: SUBSCRIPTIONS, field: 'startedAt', from, to: now,
        where: [['status', '==', 'active']]
      }),
      activityMetrics(now, growthDays),
      topLists(now, growthDays)
    ]);

  const revenueGrowth = includeRevenue ? revenueSeries(paid, from, now) : null;

  return {
    generatedAt: now,
    windowDays: growthDays,
    users,
    subscriptions,
    revenue,
    growth: {
      users: { ...userGrowth, ...rollUpSeries(userGrowth.points) },
      subscriptions: { ...subscriptionGrowth, ...rollUpSeries(subscriptionGrowth.points) },
      revenuePaise: revenueGrowth
        ? { ...revenueGrowth, ...rollUpSeries(revenueGrowth.points) }
        : null
    },
    activity,
    tops
  };
}

module.exports = {
  dashboard,
  userMetrics, subscriptionMetrics, revenueMetrics, revenueSeries, capturedPayments,
  activityMetrics, topLists, dailySeries, rollUpSeries,
  boundaries, startOfDay, startOfWeek, startOfMonth, dayKey,
  DAY_MS, SERIES_SCAN_CAP
};
