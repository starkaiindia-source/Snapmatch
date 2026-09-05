/* ============================================================================
   Mobile Parts Finder · api/_services/missing-model-service.js
   ----------------------------------------------------------------------------
   The queue of handsets people looked for and did not find.

   ----------------------------------------------------------------------------
   AGGREGATE, DO NOT ACCUMULATE

   Every zero-result search does NOT create a document. The normalised model
   name is the document id, so the fortieth shop looking for the same phone
   increments a counter. The queue an admin reads is therefore a list of
   MODELS ranked by demand, which is the thing worth acting on — not a list of
   searches, which is the same information buried in forty rows.

   ----------------------------------------------------------------------------
   THIS IS WHERE THE AUTOMATION PIPELINE STARTS, AND IT STARTS WITH A HUMAN

       user searches an unknown model
             |
       no result found
             |
       recordRequest()  <- here. Counted, never published.
             |
       an admin, or the AI, moves it through the workflow
             |
       draft_found -> approved -> published
                                     ^
                                     +-- only an admin action reaches this

   Nothing in this file writes to the catalogue. `publish()` records the
   DECISION to publish and the model id it produced; the actual catalogue write
   is the importer's job and happens under an admin's hand. That separation is
   the whole point — see docs/AI-ARCHITECTURE.md.
   ========================================================================== */
'use strict';

const { db, admin } = require('../_lib/firebase');
const { MISSING_MODEL_REQUESTS } = require('../_schema/collections');
const {
  STATUSES, canTransition, normaliseModelName, displayModelName,
  isRecordableQuery, buildRequest
} = require('../_schema/missing-model-request');
const { parseLimit, decodeCursor, encodeCursor } = require('../_lib/pagination');
const v = require('../_lib/validate');

const FieldValue = admin.firestore.FieldValue;

/** How many spellings of one model are worth keeping. */
const MAX_VARIANTS = 25;

/**
 * Records that someone looked for a model we do not have.
 *
 * Safe to call on every zero-result search: the write is one document, keyed
 * by the normalised name, and a repeat is an increment.
 *
 * @param {object} args
 * @param {string} args.raw        what the user typed
 * @param {string|null} args.userId
 * @param {string} args.source     'search' | 'chatbot' | 'admin'
 * @param {number} args.now
 * @returns {Promise<{recorded:boolean, key:string|null, count:number|null}>}
 */
async function recordRequest({ raw, userId, source, now }) {
  if (!isRecordableQuery(raw)) return { recorded: false, key: null, count: null };

  const key = normaliseModelName(raw);
  const variant = displayModelName(raw);
  const ref = db().collection(MISSING_MODEL_REQUESTS).doc(key);

  try {
    const count = await db().runTransaction(async tx => {
      const snap = await tx.get(ref);

      if (!snap.exists) {
        tx.set(ref, buildRequest({ raw, now, source, userId }));
        return 1;
      }

      const prior = snap.data() || {};
      const variants = Array.isArray(prior.searchVariants) ? prior.searchVariants : [];
      const patch = {
        requestCount: FieldValue.increment(1),
        lastRequestedAt: now,
        updatedAt: now
      };

      /* Keep the spellings people actually use — they are what the eventual
         alias list is built from — but stop at MAX_VARIANTS so a fuzzer cannot
         grow one document without limit. */
      if (variant && variants.indexOf(variant) < 0 && variants.length < MAX_VARIANTS) {
        patch.searchVariants = FieldValue.arrayUnion(variant);
      }
      if (userId) {
        patch.signedInRequesters = FieldValue.increment(1);
        patch.lastRequestedByUid = userId;
      }
      if (source && (prior.sources || []).indexOf(source) < 0) {
        patch.sources = FieldValue.arrayUnion(source);
      }
      /* A model that was dismissed as invalid and is now being asked for again
         goes back in the queue — the first judgement may have been wrong, and
         repeated demand is the evidence that says so. */
      if (prior.status === 'not_a_valid_model' && (Number(prior.requestCount) || 0) >= 4) {
        patch.status = 'new';
        patch.reviewNotes = 'reopened: requested again after being marked invalid';
      }

      tx.set(ref, patch, { merge: true });
      return (Number(prior.requestCount) || 0) + 1;
    });

    return { recorded: true, key, count };
  } catch (err) {
    /* A missing-model request is a nicety. Losing one must never fail the
       search the user was actually doing. */
    console.warn('[missing-models] record failed', { key, message: err && err.message });
    return { recorded: false, key, count: null };
  }
}

/* ------------------------------------------------------------------ reading */

const SORTS = { demand: 'requestCount', newest: 'firstRequestedAt', recent: 'lastRequestedAt' };

/**
 * The admin queue.
 *
 * Ordered by demand by default, because "which model should we add next" is
 * the question this page exists to answer.
 */
async function listRequests({ status, sort = 'demand', limit, cursor }) {
  const field = SORTS[sort] || SORTS.demand;
  const pageSize = parseLimit(limit);

  let q = db().collection(MISSING_MODEL_REQUESTS);
  if (status && STATUSES.indexOf(status) > -1) q = q.where('status', '==', status);
  q = q.orderBy(field, 'desc').orderBy('__name__', 'desc');

  const position = decodeCursor(cursor);
  if (position) q = q.startAfter.apply(q, position);

  const snap = await q.limit(pageSize + 1).get();
  const hasMore = snap.docs.length > pageSize;
  const docs = hasMore ? snap.docs.slice(0, pageSize) : snap.docs;
  const last = docs.length ? docs[docs.length - 1] : null;

  return {
    requests: docs.map(toView),
    hasMore,
    nextCursor: last && hasMore ? encodeCursor([last.data()[field] ?? null, last.id]) : null
  };
}

function toView(doc) {
  const d = doc.data() || {};
  return {
    key: doc.id,
    normalisedName: d.normalisedName || doc.id,
    requestedName: d.requestedName || null,
    requestCount: Number(d.requestCount) || 0,
    signedInRequesters: Number(d.signedInRequesters) || 0,
    firstRequestedAt: d.firstRequestedAt ?? null,
    lastRequestedAt: d.lastRequestedAt ?? null,
    searchVariants: Array.isArray(d.searchVariants) ? d.searchVariants : [],
    sources: Array.isArray(d.sources) ? d.sources : [],
    status: STATUSES.indexOf(d.status) > -1 ? d.status : 'new',
    candidateBrandId: d.candidateBrandId || null,
    candidateModelName: d.candidateModelName || null,
    reviewNotes: d.reviewNotes || null,
    duplicateOfModelId: d.duplicateOfModelId || null,
    publishedModelId: d.publishedModelId || null,
    reviewedByUid: d.reviewedByUid || null,
    reviewedAt: d.reviewedAt ?? null,
    updatedAt: d.updatedAt ?? null
  };
}

async function getRequest(key) {
  const snap = await db().collection(MISSING_MODEL_REQUESTS).doc(key).get();
  return snap.exists ? toView(snap) : null;
}

/* ---------------------------------------------------------------- workflow */

/**
 * Moves a request to a new status.
 *
 * The transition table in _schema/missing-model-request.js decides what is
 * legal, and it is consulted INSIDE the transaction against the status that is
 * actually stored — not against the one the client thought was stored. Two
 * admins acting at once cannot combine into a jump that neither made.
 *
 * @returns {Promise<{ok:true, from:string, to:string}|{ok:false, reason:string, from:string}>}
 */
async function transition({ key, to, adminUid, notes, patch, now }) {
  const ref = db().collection(MISSING_MODEL_REQUESTS).doc(key);

  return db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, reason: 'not found', from: null };

    const from = snap.data().status || 'new';
    if (from === to) return { ok: true, from, to, unchanged: true };
    if (!canTransition(from, to)) {
      return { ok: false, reason: `cannot move from ${from} to ${to}`, from };
    }

    const update = {
      status: to,
      reviewedByUid: adminUid,
      reviewedAt: now,
      updatedAt: now
    };
    if (notes != null) update.reviewNotes = v.string(notes, 1000) || null;

    /* Only these fields may be set alongside a transition. A free-form patch
       would let a status change also rewrite requestCount or firstRequestedAt,
       and those are facts about what users did, not editorial fields. */
    ['candidateBrandId', 'candidateModelName', 'duplicateOfModelId', 'publishedModelId']
      .forEach(field => {
        if (patch && patch[field] !== undefined) {
          update[field] = v.string(patch[field], 120) || null;
        }
      });

    tx.set(ref, update, { merge: true });
    return { ok: true, from, to };
  });
}

module.exports = {
  STATUSES, MAX_VARIANTS,
  recordRequest, listRequests, getRequest, transition,
  normaliseModelName
};
