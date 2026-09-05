/* ============================================================================
   Mobile Parts Finder · api/_services/analytics-service.js
   ----------------------------------------------------------------------------
   Recording what happens on the site, and rolling it up so the dashboard never
   has to read the history back.

   ----------------------------------------------------------------------------
   WHAT GETS RECORDED, AND WHAT DOES NOT

   Meaningful events only. Not every click, not every keystroke, not scroll
   depth. A search, an opened model, a plan selected, a payment: things that
   answer a business question. The list is in _schema/analytics-event.js and it
   is an allowlist — a browser cannot invent an event type, which is what keeps
   the collection queryable and keeps its size proportional to real use.

   Debouncing belongs in the browser and it lives in src/data/analytics.js:
   typing "samsung galaxy" sends ONE model_search after the typing stops, not
   fourteen. That is a deliberate split — the client knows when a search is
   finished and the server does not.

   ----------------------------------------------------------------------------
   TWO WRITES PER EVENT, AND WHY THE SECOND ONE MATTERS

     1. the event document, for a detailed trail
     2. one counter increment on analyticsDaily/{YYYY-MM-DD}

   The rollup is what makes "top ten searched models this month" a read of
   thirty small documents instead of a scan of every event ever recorded. It is
   maintained AS EVENTS ARRIVE, so it is never stale and never needs a nightly
   job — and the day document is the natural shard, so a busy day does not
   contend with a quiet one.

   Firestore caps a single document at roughly one write per second sustained.
   The rollup uses FieldValue.increment, which is a commutative operation the
   server merges, so concurrent increments do not lose each other — but a very
   high traffic day would still contend. When that day comes the fix is to
   shard the counter across ten documents per day; the read side already sums
   what it is given, so that change is confined to this file.

   ----------------------------------------------------------------------------
   THE ROLLUP IS BEST-EFFORT AND THE EVENT IS NOT

   If the counter write fails, the event is still recorded and the number can
   be recomputed from it. If the event write fails, the request fails. That
   ordering is deliberate: the raw log is the source, the rollup is a cache.
   ========================================================================== */
'use strict';

const { db, admin } = require('../_lib/firebase');
const { ANALYTICS_EVENTS, ANALYTICS_DAILY, VISITOR_SESSIONS } =
  require('../_schema/collections');
const {
  buildEvent, isKnownEventType, dayKey, EVENT_TYPE_LIST
} = require('../_schema/analytics-event');

const FieldValue = admin.firestore.FieldValue;

/**
 * The most events one request may carry.
 *
 * The browser batches, so a batch is normal; a batch of five hundred is a loop
 * that has got away from someone. Twenty is comfortably more than a page visit
 * generates and small enough that a rejected batch costs nothing.
 */
const MAX_BATCH = 20;

/* ----------------------------------------------------------- top-list keys

   Which metadata field becomes a "top ten" for each event type, and under
   which rollup field. Only these are counted by value — everything else is
   counted by type alone, because a top-ten of `matchedResultCount` is not a
   business question anyone has. */
const TOP_LIST_FIELDS = {
  model_search: [['searchQuery', 'topSearchTerms']],
  search_zero_result: [['searchQuery', 'zeroResultTerms']],
  model_opened: [['modelId', 'topModels'], ['brandId', 'topBrands']],
  brand_selected: [['brandId', 'topBrands']],
  category_selected: [['categoryId', 'topCategories']],
  compatibility_group_opened: [['categoryId', 'topCategories']]
};

/**
 * A Firestore field name cannot contain a dot, a slash, or start with two
 * underscores, and a search term can contain all of those. The key is
 * sanitised for storage and the original is not needed — a top-ten label of
 * "samsung galaxy m21" survives this untouched, which is the case that matters.
 */
function counterKey(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60);
}

/**
 * Records one batch of events.
 *
 * @param {object} args
 * @param {Array} args.events    raw, from the request body
 * @param {string|null} args.userId    from a verified ID token, or null
 * @param {string|null} args.sessionId opaque, from the browser
 * @param {string} args.source
 * @param {number} args.now
 * @returns {Promise<{accepted:number, rejected:number, rejectedTypes:string[]}>}
 */
async function recordEvents({ events, userId, sessionId, source, now }) {
  const list = Array.isArray(events) ? events.slice(0, MAX_BATCH) : [];
  const rejectedTypes = [];

  const valid = list.filter(e => {
    const type = e && e.eventType;
    if (isKnownEventType(type)) return true;
    /* Named in the response so a frontend sending a typo finds out, and
       recorded nowhere — an unknown type must not create a collection entry a
       caller chose the name of. */
    if (type && rejectedTypes.indexOf(String(type).slice(0, 40)) < 0) {
      rejectedTypes.push(String(type).slice(0, 40));
    }
    return false;
  });

  if (!valid.length) {
    return { accepted: 0, rejected: list.length, rejectedTypes };
  }

  const store = db();
  const batch = store.batch();
  const dailyCounters = {};

  valid.forEach(raw => {
    const doc = buildEvent({
      userId,
      sessionId,
      eventType: raw.eventType,
      source,
      metadata: raw.metadata,
      now
    });

    /* Firestore generates the id. A client-supplied event id would let a
       caller overwrite an event that is already recorded. */
    batch.set(store.collection(ANALYTICS_EVENTS).doc(), doc);
    accumulate(dailyCounters, doc);
  });

  await batch.commit();

  /* Best-effort, and after the events are safely written. A failed rollup is a
     number that can be recomputed; a failed event is data that is gone. */
  await Promise.all(Object.entries(dailyCounters).map(([day, bucket]) =>
    store.collection(ANALYTICS_DAILY).doc(day)
      .set(toIncrements(day, bucket, now), { merge: true })
      .catch(err => console.warn('[analytics] rollup failed', day, err && err.message))
  ));

  if (sessionId) {
    await touchSession({ sessionId, userId, now, eventCount: valid.length })
      .catch(err => console.warn('[analytics] session touch failed', err && err.message));
  }

  return { accepted: valid.length, rejected: list.length - valid.length, rejectedTypes };
}

/* --------------------------------------------------------------- counting

   Two passes, deliberately.

   FieldValue.increment is a write instruction, not a number: once created, its
   operand cannot be read back, so a batch of six searches for the same term
   cannot accumulate into one by inspecting what is already there. So the first
   pass counts in plain integers, and the second turns each total into ONE
   increment.

   That also means one merge operation per key per batch rather than one per
   event, which is what keeps a busy day's rollup document from contending with
   itself. */

/** Pass one: plain integers, keyed by day. */
function accumulate(into, doc) {
  const day = doc.day;
  if (!into[day]) into[day] = { total: 0, byType: {}, lists: {} };
  const bucket = into[day];

  bucket.total += 1;
  bucket.byType[doc.eventType] = (bucket.byType[doc.eventType] || 0) + 1;

  (TOP_LIST_FIELDS[doc.eventType] || []).forEach(([field, target]) => {
    const value = doc.metadata && doc.metadata[field];
    if (!value) return;
    const key = counterKey(value);
    if (!key) return;
    if (!bucket.lists[target]) bucket.lists[target] = {};
    bucket.lists[target][key] = (bucket.lists[target][key] || 0) + 1;
  });
}

/** Pass two: one FieldValue.increment per key. */
function toIncrements(day, bucket, now) {
  const payload = {
    date: day,
    totalEvents: FieldValue.increment(bucket.total),
    updatedAt: now,
    byType: {}
  };

  Object.entries(bucket.byType).forEach(([type, n]) => {
    payload.byType[type] = FieldValue.increment(n);
  });

  Object.entries(bucket.lists).forEach(([target, counts]) => {
    payload[target] = {};
    Object.entries(counts).forEach(([key, n]) => {
      payload[target][key] = FieldValue.increment(n);
    });
  });

  return payload;
}

/**
 * A visitor session.
 *
 * An anonymous visitor gets a row with a random id and a count. When they
 * later sign in, `userId` is stamped on the session going forward — the
 * session is ASSOCIATED, not merged into a profile, and nothing in the admin
 * UI reads a signed-in user's pre-sign-in browsing as part of their record.
 *
 * The session id is generated by the browser and is not derived from anything
 * about the device. There is no fingerprinting here and there will not be.
 */
async function touchSession({ sessionId, userId, now, eventCount }) {
  const ref = db().collection(VISITOR_SESSIONS).doc(sessionId);
  const patch = {
    sessionId,
    lastSeenAt: now,
    eventCount: FieldValue.increment(eventCount || 1),
    updatedAt: now,
    /* A TTL policy on this field expires anonymous sessions. A visit record
       nobody will ever query is a record that should not be kept. */
    expiresAt: new Date(now + 90 * 24 * 3600 * 1000)
  };
  if (userId) {
    patch.userId = userId;
    patch.authenticatedAt = FieldValue.serverTimestamp();
  }
  await ref.set(patch, { merge: true });
  /* firstSeenAt is written once and never again — a returning session must not
     restamp when it began. set with merge cannot express "only if absent", so
     it is a create attempt whose failure is the normal case. */
  await ref.create({ firstSeenAt: now }).catch(() => {});
}

/* ------------------------------------------------------------------ reading */

/**
 * A page of raw events, newest first. For the admin activity view and for one
 * user's timeline.
 *
 * @param {object} args
 * @param {string} [args.userId]   restrict to one account
 * @param {string} [args.eventType]
 * @param {number} [args.from]
 * @param {number} [args.to]
 * @param {number} [args.limit]
 */
async function listEvents({ userId, eventType, from, to, limit = 50 }) {
  let q = db().collection(ANALYTICS_EVENTS);
  if (userId) q = q.where('userId', '==', userId);
  if (eventType) q = q.where('eventType', '==', eventType);
  if (from != null) q = q.where('timestamp', '>=', from);
  if (to != null) q = q.where('timestamp', '<=', to);

  try {
    const snap = await q.orderBy('timestamp', 'desc').limit(Math.min(200, limit)).get();
    return snap.docs.map(d => ({
      eventId: d.id,
      ...d.data()
    }));
  } catch (err) {
    /* A missing composite index is a deployment step. The timeline degrades to
       empty with a warning rather than failing the whole user-detail page. */
    console.warn('[analytics] listEvents failed', err && (err.code || err.message));
    return [];
  }
}

module.exports = {
  MAX_BATCH, EVENT_TYPE_LIST, TOP_LIST_FIELDS,
  recordEvents, listEvents, touchSession, counterKey, dayKey
};
