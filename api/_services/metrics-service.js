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

   Summing with sum(): the same for revenue. Adding up payments by downloading
   them works at fifty payments and falls over at fifty thousand.

   The growth SERIES is different — it needs one number per day, not one total.
   Firestore cannot GROUP BY, so this reads the createdAt field only
   (`.select()`, which cuts the payload though not the read count) over the
   requested window, with a hard cap. Past the cap the series is reported
   `truncated: true` rather than silently wrong. The upgrade path is the daily
   rollup documents that analytics-service already maintains going forward.
   ========================================================================== */
'use strict';

const { db, admin } = require('../_lib/firebase');
const { USERS, PAYMENTS, SUBSCRIPTIONS, ANALYTICS_EVENTS, ANALYTICS_DAILY } =
  require('../_schema/collections');

const AggregateField = admin.firestore.AggregateField;

const DAY_MS = 24 * 3600 * 1000;

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
    console.warn('[metrics] count failed', label, err && (err.code || err.message));
    return null;
  }
}

/** sum() with the same fallback. @returns {Promise<number|null>} */
async function sumOf(query, field, label) {
  try {
    const snap = await query.aggregate({ total: AggregateField.sum(field) }).get();
    const total = snap.data().total;
    return Number.isFinite(total) ? total : 0;
  } catch (err) {
    console.warn('[metrics] sum failed', label, err && (err.code || err.message));
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
    activeStatus, monthly, yearly, totalUsers, expired, cancelled, pending
  ] = await Promise.all([
    countOf(users.where('activeSubscriptionStatus', '==', 'active'), 'subs.active'),
    countOf(users.where('currentPlanId', '==', 'monthly')
      .where('activeSubscriptionStatus', '==', 'active'), 'subs.monthly'),
    countOf(users.where('currentPlanId', '==', 'yearly')
      .where('activeSubscriptionStatus', '==', 'active'), 'subs.yearly'),
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

  return {
    totalActive: stillRunning != null ? stillRunning : activeStatus,
    flaggedActive: activeStatus,
    monthly,
    yearly,
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
async function revenueMetrics(now) {
  const store = db();
  const captured = store.collection(PAYMENTS).where('status', '==', 'captured');
  const b = boundaries(now);

  const [
    lifetime, today, week, month,
    monthlyPlan, yearlyPlan,
    successCount, failedCount, payingUsers
  ] = await Promise.all([
    sumOf(captured, 'amount', 'revenue.lifetime'),
    sumOf(captured.where('createdAt', '>=', b.today), 'amount', 'revenue.today'),
    sumOf(captured.where('createdAt', '>=', b.week), 'amount', 'revenue.week'),
    sumOf(captured.where('createdAt', '>=', b.month), 'amount', 'revenue.month'),
    sumOf(captured.where('planId', '==', 'monthly'), 'amount', 'revenue.monthlyPlan'),
    sumOf(captured.where('planId', '==', 'yearly'), 'amount', 'revenue.yearlyPlan'),
    countOf(captured, 'revenue.successCount'),
    countOf(store.collection(PAYMENTS).where('status', '==', 'failed'), 'revenue.failedCount'),
    countDistinctPayers()
  ]);

  const arppu = lifetime != null && payingUsers ? Math.round(lifetime / payingUsers) : null;

  return {
    currency: 'INR',
    todayPaise: today,
    thisWeekPaise: week,
    thisMonthPaise: month,
    lifetimePaise: lifetime,
    monthlyPlanPaise: monthlyPlan,
    yearlyPlanPaise: yearlyPlan,
    averageRevenuePerPayingUserPaise: arppu,
    successfulPayments: successCount,
    failedPayments: failedCount,
    /* Razorpay reports authorised-but-not-captured separately; nothing in this
       codebase writes that state, so it is honestly null rather than 0. */
    pendingPayments: null,
    payingUsers
  };
}

/**
 * How many DISTINCT accounts have ever paid.
 *
 * Firestore has no COUNT(DISTINCT), so this reads the uid field of captured
 * payments — projected, capped — and counts the set. At the scale where the
 * cap bites, the figure moves to a maintained counter; until then this is
 * exact and costs one read per payment, of which there are hundreds, not
 * millions.
 */
async function countDistinctPayers() {
  try {
    const snap = await db().collection(PAYMENTS)
      .where('status', '==', 'captured')
      .select('uid')
      .limit(SERIES_SCAN_CAP)
      .get();
    const uids = new Set();
    snap.docs.forEach(d => { const u = d.data().uid; if (u) uids.add(u); });
    return uids.size;
  } catch (err) {
    console.warn('[metrics] distinct payers failed', err && (err.code || err.message));
    return null;
  }
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
    console.warn('[metrics] series failed', collection, field, err && (err.code || err.message));
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
    console.warn('[metrics] rollups unavailable', err && (err.code || err.message));
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

  const [users, subscriptions, revenue, userGrowth, subscriptionGrowth, activity, tops] =
    await Promise.all([
      userMetrics(now),
      subscriptionMetrics(now),
      includeRevenue ? revenueMetrics(now) : Promise.resolve(null),
      dailySeries({ collection: USERS, field: 'createdAt', from, to: now }),
      dailySeries({
        collection: SUBSCRIPTIONS, field: 'startedAt', from, to: now,
        where: [['status', '==', 'active']]
      }),
      activityMetrics(now, growthDays),
      topLists(now, growthDays)
    ]);

  const revenueGrowth = includeRevenue
    ? await dailySeries({
        collection: PAYMENTS, field: 'createdAt', from, to: now,
        valueField: 'amount', where: [['status', '==', 'captured']]
      })
    : null;

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
  userMetrics, subscriptionMetrics, revenueMetrics,
  activityMetrics, topLists, dailySeries, rollUpSeries,
  boundaries, startOfDay, startOfWeek, startOfMonth, dayKey,
  DAY_MS, SERIES_SCAN_CAP
};
