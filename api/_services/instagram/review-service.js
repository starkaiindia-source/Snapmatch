/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/review-service.js
   ----------------------------------------------------------------------------
   The admin review queue, and the ONE place an Instagram claim can become a
   production fitment.

   ----------------------------------------------------------------------------
   WHAT APPROVAL WRITES — AND WHAT IT NEVER DOES

   Production fitments are groups (see production.js). Approving a claim that
   "A and B take the same part in category C" runs ONE Firestore transaction
   that re-reads everything it depends on and then does exactly one of:

     already the same group   nothing written to production; the claim is
                              recorded as "Already Existing" evidence
     one model grouped        the other model is ADDED to that group:
                                groupDetails/{g}  memberIds, memberNames, memberCount
                                groups/{g}        memberCount
                                modelGroups/{m}   byCategory[C] += g
                              and the ledger records the previous and new values
     different groups         REFUSED. Production says they take different
                              parts; merging groups is a catalogue decision
     neither grouped          approved into the ledger as pending_build — a new
                              group needs a part code and serial, which only
                              the catalogue build issues
     catalogue not imported   approved into the ledger as pending_build; nothing
                              is compared against, so nothing is written

   It never removes a member, never deletes a group, never renames a model,
   never creates a model, brand or category, and never merges two groups.
   Approval of a NEGATIVE claim is refused: acting on "not compatible" would
   mean deleting production data, which this feature does not do.

   ----------------------------------------------------------------------------
   THE BUILD MUST KNOW, OR THE NEXT IMPORT UNDOES THIS

   scripts/import-firestore.js rewrites groupDetails from the build. So the
   ledger (approvedCompatibilities) is also exported for the build
   (scripts/export-approved-compatibilities.js), build-dataset.js folds the
   applied additions back in, and import-firestore.js refuses to run if it
   would drop an applied approval. See docs/INSTAGRAM-IMPORTER.md.
   ========================================================================== */
'use strict';

const C = require('../../_schema/collections');
const S = require('../../_schema/instagram');
const fsx = require('./firestore');
const production = require('./production');
const taxonomy = require('../taxonomy-service');
const jobService = require('./job-service');

const candidates = () => fsx.db().collection(C.COMPATIBILITY_CANDIDATES);

class ReviewError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra || {});
  }
}

function hist(now, admin, action, note, extra) {
  return Object.assign({ at: now, by: admin ? admin.uid : 'system', byEmail: admin ? admin.email || null : null, action, note: note || null }, extra || {});
}

/* ================================================================ approve */

/**
 * @returns {Promise<{ok:true, outcome:string, candidateId:string, relKey:string, change?:object, note:string}>}
 * @throws {ReviewError}
 */
async function approve({ candidateId, admin, acknowledgeLowConfidence = false, now }) {
  const db = fsx.db();
  const FV = fsx.FieldValue();
  const candRef = candidates().doc(candidateId);

  const result = await db.runTransaction(async tx => {
    /* ---------------- every read first (Firestore requires it) ---------------- */
    const snap = await tx.get(candRef);
    if (!snap.exists) throw new ReviewError(404, 'not-found', 'No such candidate.');
    const c = snap.data();

    if (c.kind !== 'relationship') throw new ReviewError(409, 'not-a-relationship', 'Only a compatibility relationship can be approved. Resolve a model reference with "Select correct model".');
    if (!S.canTransitionCandidate(c.status, 'approved')) throw new ReviewError(409, 'wrong-status', `A ${c.status} candidate cannot be approved.`);
    if (c.polarity !== 'positive') throw new ReviewError(409, 'negative-claim', 'A "not compatible" claim cannot be approved: acting on it would delete production data, which this tool never does. Reject it, or change the catalogue by hand.');
    if (c.conflict && c.conflict.active) throw new ReviewError(409, 'conflict', 'This relationship is in conflict. Resolve the conflicting evidence first (reject one side).');
    const sm = c.sourceMatch || {};
    const cm = c.compatibleMatch || {};
    if (sm.status !== 'matched' || cm.status !== 'matched') throw new ReviewError(409, 'unmatched', 'Both models must be matched to catalogue records before approval.');
    if (sm.requiresVariantConfirmation || cm.requiresVariantConfirmation) {
      throw new ReviewError(409, 'variant-confirmation-required', 'A variant (4G/5G, year, region) was not in the record name. Confirm the record with "Select correct model" first.');
    }
    if (S.IMPORTABLE_TYPES.indexOf(c.compatibilityType) < 0) throw new ReviewError(409, 'not-importable', 'This statement is not a compatibility claim.');
    if (c.confidence && c.confidence.band === 'low' && !acknowledgeLowConfidence) {
      throw new ReviewError(409, 'low-confidence', 'Low-confidence candidate: approving it needs an explicit acknowledgement.');
    }

    /* foreign keys, against the catalogue itself */
    const a = taxonomy.modelById(sm.modelId);
    const b = taxonomy.modelById(cm.modelId);
    if (!a || !b) throw new ReviewError(409, 'unknown-model', 'A matched model id is not in the catalogue.');
    if (a.modelId === b.modelId) throw new ReviewError(409, 'same-model', 'Both sides are the same model.');
    if (!taxonomy.isKnownCategory(c.categoryId)) throw new ReviewError(409, 'unknown-category', 'The category is not one of the catalogue\'s categories.');
    const relKey = S.relKeyFor(c.categoryId, a.modelId, b.modelId);
    if (!relKey || relKey !== c.relKey) throw new ReviewError(409, 'stale-key', 'The candidate changed since it was loaded. Reload and try again.');

    const ledgerRef = db.collection(C.APPROVED_COMPATIBILITIES).doc(relKey);
    const ledgerSnap = await tx.get(ledgerRef);
    const metaSnap = await tx.get(db.collection(C.CATALOG).doc('meta'));
    const mgA = await tx.get(db.collection(C.MODEL_GROUPS).doc(a.modelId));
    const mgB = await tx.get(db.collection(C.MODEL_GROUPS).doc(b.modelId));
    const groupsA = production.groupsIn(mgA.exists ? mgA.data() : null, c.categoryId);
    const groupsB = production.groupsIn(mgB.exists ? mgB.data() : null, c.categoryId);
    const state = metaSnap.exists ? production.classify(groupsA, groupsB).state : 'unknown';

    let groupId = null, anchor = null, add = null, gdSnap = null, gSnap = null;
    if (state === 'one_grouped') {
      const grouped = groupsA.length ? { model: a, groups: groupsA } : { model: b, groups: groupsB };
      anchor = grouped.model;
      add = grouped.model === a ? b : a;
      if (grouped.groups.length > 1) {
        throw new ReviewError(409, 'multiple-groups', `${anchor.modelName} is in ${grouped.groups.length} groups for this category, so which one ${add.modelName} joins is a catalogue decision.`);
      }
      groupId = grouped.groups[0];
      gdSnap = await tx.get(db.collection(C.GROUP_DETAILS).doc(groupId));
      gSnap = await tx.get(db.collection(C.GROUPS).doc(groupId));
      if (!gdSnap.exists) throw new ReviewError(409, 'group-missing', `modelGroups points at ${groupId}, which has no groupDetails document. Nothing was written.`);
    }

    /* ---------------------------- decide, then write ---------------------------- */
    const evidenceEntry = {
      candidateId, sourceKey: c.sourceKey, sourceUsername: c.sourceUsername || null,
      permalink: c.sourcePost && c.sourcePost.permalink || null,
      evidenceText: String(c.extractedText || '').slice(0, 500), approvedAt: now
    };
    const approval = {
      reviewer: admin.uid, reviewedAt: now, approvedBy: admin.uid, approvedByEmail: admin.email || null,
      approvedAt: now, updatedAt: now, ledgerId: relKey, reviewSection: 'closed'
    };

    if (ledgerSnap.exists && ['applied', 'approved_pending_build', 'pre_existing'].indexOf(ledgerSnap.data().status) > -1) {
      tx.set(candRef, Object.assign({}, approval, {
        status: 'duplicate', duplicateReason: 'already_approved', duplicateOf: (ledgerSnap.data().candidateIds || [])[0] || null,
        reviewSection: 'duplicates',
        history: FV.arrayUnion(hist(now, admin, 'duplicate', 'approved earlier from another source; this source was added as evidence'))
      }), { merge: true });
      tx.set(ledgerRef, { evidence: FV.arrayUnion(evidenceEntry), candidateIds: FV.arrayUnion(candidateId),
                          sources: FV.arrayUnion(c.sourceKey), updatedAt: now }, { merge: true });
      return { outcome: 'already_approved', relKey, c };
    }

    if (state === 'different_groups') {
      tx.set(candRef, {
        conflict: { active: true, type: 'production', withCandidateIds: [],
          note: `At approval, production had these in different groups (${groupsA.join(', ')} vs ${groupsB.join(', ')}). Nothing was written.` },
        reviewSection: 'conflicts', updatedAt: now,
        history: FV.arrayUnion(hist(now, admin, 'approval_refused', 'production has the models in different groups'))
      }, { merge: true });
      return { outcome: 'refused_production_conflict', relKey, c, groupsA, groupsB };
    }

    const ledgerBase = {
      relKey, kind: S.RELATION_KIND, categoryId: c.categoryId,
      modelA: [a.modelId, b.modelId].sort()[0], modelB: [a.modelId, b.modelId].sort()[1],
      sourceModelId: a.modelId, sourceModelName: a.modelName,
      compatibleModelId: b.modelId, compatibleModelName: b.modelName,
      compatibilityType: c.compatibilityType,
      approvedBy: admin.uid, approvedByEmail: admin.email || null, approvedAt: now,
      candidateIds: [candidateId], evidence: [evidenceEntry], sources: [c.sourceKey],
      confidenceAtApproval: c.confidence ? c.confidence.band : null,
      matchMethods: { source: sm.method, compatible: cm.method },
      processingVersion: c.processingVersion || null,
      createdAt: now, updatedAt: now
    };

    if (state === 'same_group') {
      tx.set(ledgerRef, Object.assign(ledgerBase, { status: 'pre_existing', productionOutcome: 'already_existing',
        productionNote: 'Already true in production when approved; recorded as supporting evidence.' }));
      tx.set(candRef, Object.assign({}, approval, {
        status: 'duplicate', duplicateReason: 'already_existing', reviewSection: 'duplicates', productionOutcome: 'already_existing',
        history: FV.arrayUnion(hist(now, admin, 'duplicate', 'Already Existing in production; kept as evidence'))
      }), { merge: true });
      return { outcome: 'already_existing', relKey, c };
    }

    if (state === 'one_grouped') {
      const gd = gdSnap.data() || {};
      if (gd.categoryId && gd.categoryId !== c.categoryId) {
        throw new ReviewError(409, 'category-mismatch', `Group ${groupId} is ${gd.categoryId}, not ${c.categoryId}. Nothing was written.`);
      }
      const oldIds = Array.isArray(gd.memberIds) ? gd.memberIds.slice() : [];
      const oldNames = Array.isArray(gd.memberNames) ? gd.memberNames.slice() : [];
      if (oldIds.indexOf(add.modelId) > -1) {
        throw new ReviewError(409, 'inconsistent-production', `${add.modelName} is already a member of ${groupId} but its modelGroups entry does not say so. Fix the catalogue import; nothing was written.`);
      }
      const newIds = oldIds.concat(add.modelId);
      const newNames = oldNames.concat(add.modelName);
      const previousCount = Number(gd.memberCount) || oldIds.length;
      const change = {
        groupId, addedModelId: add.modelId, addedModelName: add.modelName,
        anchorModelId: anchor.modelId, anchorModelName: anchor.modelName,
        previousMemberCount: previousCount, newMemberCount: newIds.length,
        previousMemberIds: oldIds.slice(0, 1000)
      };
      tx.set(db.collection(C.GROUP_DETAILS).doc(groupId), {
        memberIds: newIds, memberNames: newNames, memberCount: newIds.length,
        lastChange: { source: 'instagram-approval', relKey, addedModelId: add.modelId, by: admin.uid, at: now }
      }, { merge: true });
      if (gSnap && gSnap.exists) tx.set(db.collection(C.GROUPS).doc(groupId), { memberCount: newIds.length }, { merge: true });
      tx.set(db.collection(C.MODEL_GROUPS).doc(add.modelId), {
        id: add.modelId, byCategory: { [c.categoryId]: FV.arrayUnion(groupId) }
      }, { merge: true });
      tx.set(ledgerRef, Object.assign(ledgerBase, { status: 'applied', productionOutcome: 'applied', appliedChange: change, appliedAt: now }));
      tx.set(candRef, Object.assign({}, approval, {
        status: 'approved', productionOutcome: 'applied', appliedChange: change,
        history: FV.arrayUnion(hist(now, admin, 'approved', `${add.modelName} added to ${groupId} (${previousCount} -> ${newIds.length} members)`))
      }), { merge: true });
      return { outcome: 'applied', relKey, c, change };
    }

    /* none / unknown: approved, not written to production */
    const why = state === 'unknown'
      ? 'The production catalogue is not imported into Firestore, so nothing could be compared or written.'
      : 'Neither model has a group in this category. A new group needs a part code and serial from the catalogue build.';
    tx.set(ledgerRef, Object.assign(ledgerBase, { status: 'approved_pending_build', productionOutcome: 'pending_build', productionNote: why }));
    tx.set(candRef, Object.assign({}, approval, {
      status: 'approved', productionOutcome: 'pending_build', productionNote: why,
      history: FV.arrayUnion(hist(now, admin, 'approved', 'approved; pending catalogue build — ' + why))
    }), { merge: true });
    return { outcome: 'pending_build', relKey, c, note: why };
  });

  if (result.outcome === 'refused_production_conflict') {
    throw new ReviewError(409, 'production-conflict',
      'Production has these models in different groups for this category. The catalogue stays authoritative; nothing was written.',
      { groupsA: result.groupsA, groupsB: result.groupsB });
  }

  await afterDecision(result.c, {
    approved: result.outcome === 'applied' || result.outcome === 'pending_build' ? 1 : 0,
    appliedToProduction: result.outcome === 'applied' ? 1 : 0,
    duplicates: result.outcome === 'already_existing' || result.outcome === 'already_approved' ? 1 : 0,
    pendingReview: -1
  }, 'approved', now);

  return {
    ok: true, outcome: result.outcome, candidateId, relKey: result.relKey, change: result.change || null,
    note: {
      applied: 'Approved and written to the production compatibility data.',
      pending_build: 'Approved into the ledger. Not live yet: ' + (result.note || ''),
      already_existing: 'Already Existing in production. Kept as additional evidence; nothing written.',
      already_approved: 'Already approved from another source. Kept as additional evidence.'
    }[result.outcome]
  };
}

/** Job counters and the source's reputation — explicit, auditable learning. */
async function afterDecision(c, jobInc, decision, now) {
  const db = fsx.db();
  const FV = fsx.FieldValue();
  try {
    if (c.jobId) {
      const patch = { updatedAt: now };
      Object.keys(jobInc).forEach(k => { if (jobInc[k]) patch['counts.' + k] = FV.increment(jobInc[k]); });
      await db.collection(C.INSTAGRAM_IMPORT_JOBS).doc(c.jobId).update(patch);
    }
    if (c.sourceKey && (decision === 'approved' || decision === 'rejected')) {
      await db.collection(C.INSTAGRAM_SOURCES).doc(c.sourceKey).set({
        reputation: { [decision]: FV.increment(1), updatedAt: now }
      }, { merge: true });
    }
    await db.collection(C.COMPATIBILITY_EVIDENCE).doc(c.candidateId).set({ candidateStatus: decision, updatedAt: now }, { merge: true });
  } catch (err) {
    console.warn('[instagram] counters not updated', err && err.message);
  }
}

/* ================================================================ reject */

async function reject({ candidateId, admin, reason, note, now }) {
  if (S.REJECT_REASONS.indexOf(reason) < 0) throw new ReviewError(400, 'bad-reason', 'reason must be one of: ' + S.REJECT_REASONS.join(', '));
  const FV = fsx.FieldValue();
  const c = await mutate(candidateId, (cur) => {
    if (!S.canTransitionCandidate(cur.status, 'rejected')) throw new ReviewError(409, 'wrong-status', `A ${cur.status} candidate cannot be rejected.`);
    return {
      status: 'rejected', rejectReason: reason, rejectNote: String(note || '').slice(0, 500) || null,
      reviewer: admin.uid, reviewedAt: now, reviewSection: 'rejected', updatedAt: now,
      history: FV.arrayUnion(hist(now, admin, 'rejected', reason + (note ? ': ' + String(note).slice(0, 200) : ''), { from: cur.status }))
    };
  });
  await afterDecision(c, { rejected: 1, pendingReview: -1 }, 'rejected', now);
  return { ok: true, candidateId, previousStatus: c.status };
}

/* ====================================================== edit a match */

/**
 * The admin picks the right catalogue record for one side. The record must
 * exist — this can never introduce a model — and the choice is recorded with
 * the value it replaced.
 */
async function selectModel({ candidateId, side, modelId, rememberAlias = false, admin, now }) {
  if (['source', 'compatible', 'reference'].indexOf(side) < 0) throw new ReviewError(400, 'bad-side', 'side must be source, compatible or reference');
  const record = taxonomy.modelById(modelId);
  if (!record) throw new ReviewError(400, 'unknown-model', 'That model id is not in the catalogue. The importer never creates models.');
  const db = fsx.db();
  const FV = fsx.FieldValue();
  const field = side === 'source' ? 'sourceMatch' : side === 'compatible' ? 'compatibleMatch' : 'referenceMatch';
  let previous = null;
  let aliasOutcome = null;

  const c = await mutate(candidateId, (cur) => {
    if (cur.status !== 'pending') throw new ReviewError(409, 'wrong-status', 'Only a pending candidate can be edited. Reopen it first.');
    if (side === 'reference' && cur.kind !== 'model_reference') throw new ReviewError(400, 'bad-side', 'This candidate is a relationship; choose source or compatible.');
    if (side !== 'reference' && cur.kind !== 'relationship') throw new ReviewError(400, 'bad-side', 'This candidate is a model reference; use side "reference".');
    previous = cur[field] || null;
    const other = side === 'source' ? cur.compatibleMatch : side === 'compatible' ? cur.sourceMatch : null;
    if (other && other.status === 'matched' && other.modelId === record.modelId) {
      throw new ReviewError(409, 'same-model', 'Both sides would be the same model.');
    }
    const match = {
      status: 'matched', modelId: record.modelId, modelName: record.modelName, brandId: record.brandId,
      method: 'admin_selected', strength: 'strong',
      normalizedText: previous ? previous.normalizedText || null : null,
      requiresVariantConfirmation: false, variantNote: null,
      notes: [`selected by ${admin.email || admin.uid}; previously ${previous && previous.modelId ? previous.modelName + ' (' + (previous.method || '') + ')' : (previous ? previous.status : 'none')}`],
      alternatives: previous ? previous.alternatives || [] : [], siblings: [],
      selectedBy: admin.uid, selectedAt: now
    };
    const next = Object.assign({}, cur, { [field]: match });
    const patch = { [field]: match, updatedAt: now,
      history: FV.arrayUnion(hist(now, admin, 'match_edited', `${side}: ${previous && previous.modelId || 'none'} -> ${record.modelId}`,
        { previousValue: previous && previous.modelId || null, newValue: record.modelId })) };
    if (cur.kind === 'model_reference') {
      Object.assign(patch, { status: 'resolved', reviewSection: 'closed', reviewer: admin.uid, reviewedAt: now });
    } else {
      Object.assign(patch, recompute(next));
    }
    return patch;
  });

  if (rememberAlias) aliasOutcome = await learnAlias({ c, side, record, admin, now });
  if (c.kind === 'relationship') await recheck(candidateId, now);
  return { ok: true, candidateId, side, previousModelId: previous && previous.modelId || null, newModelId: record.modelId, alias: aliasOutcome };
}

/**
 * "Remember this spelling": one /aliases document, written only on an
 * explicit admin choice, never overwriting an alias that points elsewhere.
 * This is how the system learns from review — auditable, reversible by hand,
 * and never from the AI.
 */
async function learnAlias({ c, side, record, admin, now }) {
  const text = side === 'source' ? c.sourceText : side === 'compatible' ? c.compatibleText : c.referenceText;
  if (!text) return { learned: false, reason: 'no extracted text on this side' };
  const tax = taxonomy.taxonomy();
  const brand = tax.brands.get(record.brandId);
  const clean = taxonomy.basicTokens(text).join(' ');
  const key = taxonomy.aliasKeyFor(brand ? brand.name : '', clean);
  if (!key) return { learned: false, reason: 'the text has no usable alias key' };
  const db = fsx.db();
  const ref = db.collection(C.ALIASES).doc(key);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data().canonicalId !== record.modelId) {
      return { learned: false, key, reason: `alias already points at ${snap.data().canonicalId}; not overwritten` };
    }
    /* /aliases is PUBLIC-read (firestore.rules), so the document carries the
       mapping and nothing about who made it. Who, when and from which
       candidate is in the audit log (compat.alias_learned). */
    tx.set(ref, {
      alias: clean, canonicalId: record.modelId, brandId: record.brandId,
      sourceId: 'instagram-review', confidence: 'verified',
      createdAt: snap.exists ? snap.data().createdAt || now : now, updatedAt: now,
      schemaVersion: 1
    }, { merge: true });
    return { learned: true, key };
  });
}

/* ==================================================== change category */

async function changeCategory({ candidateId, categoryId, admin, now }) {
  if (!taxonomy.isKnownCategory(categoryId)) throw new ReviewError(400, 'unknown-category', 'Not one of the catalogue\'s categories. The importer never creates categories.');
  const FV = fsx.FieldValue();
  let previous = null;
  const c = await mutate(candidateId, (cur) => {
    if (cur.status !== 'pending') throw new ReviewError(409, 'wrong-status', 'Only a pending candidate can be edited.');
    if (cur.kind !== 'relationship') throw new ReviewError(400, 'not-a-relationship', 'Only a relationship has a category.');
    previous = cur.categoryId || null;
    const next = Object.assign({}, cur, { categoryId, categoryMethod: 'admin_selected', categoryStrength: 'strong', unmappedCategoryText: null });
    return Object.assign({
      categoryId, categoryMethod: 'admin_selected', categoryStrength: 'strong', unmappedCategoryText: null, updatedAt: now,
      history: FV.arrayUnion(hist(now, admin, 'category_changed', `${previous || 'none'} -> ${categoryId}`, { previousValue: previous, newValue: categoryId }))
    }, recompute(next));
  });
  await recheck(candidateId, now);
  return { ok: true, candidateId, previousCategoryId: previous, newCategoryId: categoryId, relKey: c.relKey };
}

/** Confidence, key and section after an admin edit. */
function recompute(next) {
  const confidence = S.evaluateConfidence({
    sourceMatch: next.sourceMatch, compatibleMatch: next.compatibleMatch,
    category: next.categoryId ? { categoryId: next.categoryId, strength: next.categoryStrength || 'good' } : null,
    compatibilityType: next.compatibilityType, polarity: next.polarity,
    evidence: next.evidence, extractedByAi: next.extractedBy === 'ai'
  });
  const sm = next.sourceMatch || {}, cm = next.compatibleMatch || {};
  const relKey = sm.status === 'matched' && cm.status === 'matched' ? S.relKeyFor(next.categoryId, sm.modelId, cm.modelId) : null;
  const updated = Object.assign({}, next, { confidence, relKey, conflict: null });
  return { confidence, relKey, conflict: null, reviewSection: S.reviewSectionFor(updated) };
}

/** Re-runs duplicate and conflict detection for one edited candidate. */
async function recheck(candidateId, now) {
  const snap = await candidates().doc(candidateId).get();
  if (!snap.exists) return;
  const c = snap.data();
  if (c.status !== 'pending' || !c.relKey) return;
  const env = { clock: () => now, prodCache: new Map(), pendingUpdates: [] };
  c.history = [];
  await jobService._internal.dedupeAndConflicts([c], env);
  const FV = fsx.FieldValue();
  const batch = fsx.db().batch();
  const patch = {
    status: c.status, duplicateOf: c.duplicateOf || null, duplicateReason: c.duplicateReason || null,
    conflict: c.conflict || null, productionState: c.productionState || null,
    reviewSection: S.reviewSectionFor(c), updatedAt: now
  };
  if (c.history.length) patch.history = FV.arrayUnion(...c.history);
  batch.set(candidates().doc(candidateId), patch, { merge: true });
  env.pendingUpdates.forEach(u => batch.set(candidates().doc(u.id), u.patch, { merge: true }));
  await batch.commit();
}

/* ============================================ duplicate / reopen / missing */

async function markDuplicate({ candidateId, duplicateOf, admin, now }) {
  const FV = fsx.FieldValue();
  if (duplicateOf) {
    const other = await candidates().doc(duplicateOf).get();
    if (!other.exists) throw new ReviewError(400, 'unknown-candidate', 'duplicateOf is not a candidate id.');
  }
  const c = await mutate(candidateId, (cur) => {
    if (!S.canTransitionCandidate(cur.status, 'duplicate')) throw new ReviewError(409, 'wrong-status', `A ${cur.status} candidate cannot be marked duplicate.`);
    return {
      status: 'duplicate', duplicateOf: duplicateOf || null, duplicateReason: 'marked_by_admin',
      reviewer: admin.uid, reviewedAt: now, reviewSection: 'duplicates', updatedAt: now,
      history: FV.arrayUnion(hist(now, admin, 'duplicate', duplicateOf ? 'duplicate of ' + duplicateOf : 'marked duplicate'))
    };
  });
  await afterDecision(c, { duplicates: 1, pendingReview: -1 }, 'duplicate', now);
  return { ok: true, candidateId };
}

async function reopen({ candidateId, admin, now }) {
  const FV = fsx.FieldValue();
  const c = await mutate(candidateId, (cur) => {
    if (!S.canTransitionCandidate(cur.status, 'pending')) throw new ReviewError(409, 'wrong-status', `A ${cur.status} candidate cannot be reopened.`);
    const next = Object.assign({}, cur, { status: 'pending', rejectReason: null, duplicateOf: null, duplicateReason: null });
    return {
      status: 'pending', rejectReason: null, rejectNote: null, duplicateOf: null, duplicateReason: null,
      reviewer: null, reviewedAt: null, updatedAt: now, reviewSection: S.reviewSectionFor(next),
      history: FV.arrayUnion(hist(now, admin, 'reopened', 'from ' + cur.status, { previousValue: cur.status, newValue: 'pending' }))
    };
  });
  await afterDecision(c, { pendingReview: 1 }, 'reopened', now);
  if (c.kind === 'relationship') await recheck(candidateId, now);
  return { ok: true, candidateId, previousStatus: c.status };
}

async function sendToMissingModels({ candidateId, admin, now }) {
  const missing = require('../missing-model-service');
  const snap = await candidates().doc(candidateId).get();
  if (!snap.exists) throw new ReviewError(404, 'not-found', 'No such candidate.');
  const cur = snap.data();
  if (cur.kind !== 'model_reference' || cur.status !== 'pending') {
    throw new ReviewError(409, 'wrong-kind', 'Only a pending unmatched model reference can be sent to Missing models.');
  }
  const recorded = await missing.recordRequest({ raw: cur.referenceText, userId: null, source: 'instagram', now });
  const FV = fsx.FieldValue();
  await candidates().doc(candidateId).set({
    status: 'resolved', reviewSection: 'closed', reviewer: admin.uid, reviewedAt: now, updatedAt: now,
    missingModelKey: recorded.key || null,
    history: FV.arrayUnion(hist(now, admin, 'sent_to_missing_models', recorded.key ? 'missingModelRequests/' + recorded.key : 'not recordable'))
  }, { merge: true });
  await afterDecision(cur, { pendingReview: -1 }, 'resolved', now);
  return { ok: true, candidateId, missingModelKey: recorded.key || null, recorded: recorded.recorded };
}

/* ========================================================== sources */

async function setSourceIgnored({ sourceKey, ignored, reason, admin, now }) {
  const db = fsx.db();
  const FV = fsx.FieldValue();
  const ref = db.collection(C.INSTAGRAM_SOURCES).doc(sourceKey);
  const snap = await ref.get();
  if (!snap.exists) throw new ReviewError(404, 'not-found', 'No such source.');
  await ref.set({
    ignored, ignoreReason: ignored ? String(reason || '').slice(0, 300) || null : null,
    ignoredBy: ignored ? admin.uid : null, ignoredAt: ignored ? now : null, updatedAt: now
  }, { merge: true });

  /* Its open candidates leave (or return to) the queue. Bounded per call. */
  const from = ignored ? 'pending' : 'ignored';
  const to = ignored ? 'ignored' : 'pending';
  let moved = 0;
  for (let round = 0; round < 5; round++) {
    const page = await candidates().where('sourceKey', '==', sourceKey).where('status', '==', from).limit(400).get();
    if (page.empty) break;
    const batch = db.batch();
    page.docs.forEach(d => {
      const cur = d.data();
      const next = Object.assign({}, cur, { status: to });
      batch.set(d.ref, {
        status: to, reviewSection: S.reviewSectionFor(next), updatedAt: now,
        history: FV.arrayUnion(hist(now, admin, ignored ? 'ignored' : 'unignored', ignored ? 'source ignored' : 'source un-ignored'))
      }, { merge: true });
    });
    await batch.commit();
    moved += page.size;
    if (page.size < 400) break;
  }
  return { ok: true, sourceKey, ignored, candidatesMoved: moved };
}

/* ================================================== approve all valid */

/**
 * Every candidate in "ready" — high confidence, explicit, exact matches, no
 * variant question, no conflict — approved one by one through approve(),
 * each in its own transaction. Never touches medium or low.
 */
async function approveAllValid({ admin, jobId, limit = 25, now }) {
  let q = candidates().where('reviewSection', '==', 'ready').where('status', '==', 'pending');
  if (jobId) q = q.where('jobId', '==', jobId);
  const snap = await q.limit(Math.min(50, Math.max(1, limit))).get();
  const results = [];
  for (const d of snap.docs) {
    try {
      const r = await approve({ candidateId: d.id, admin, acknowledgeLowConfidence: false, now });
      results.push({ candidateId: d.id, ok: true, outcome: r.outcome });
    } catch (err) {
      results.push({ candidateId: d.id, ok: false, error: err.code || 'error', message: err.message });
    }
  }
  return { ok: true, attempted: results.length, results };
}

/* ============================================================ helpers */

/** Read-check-write one candidate in a transaction; returns it as it WAS. */
async function mutate(candidateId, fn) {
  const db = fsx.db();
  const ref = candidates().doc(candidateId);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ReviewError(404, 'not-found', 'No such candidate.');
    const cur = snap.data();
    const patch = fn(cur);
    tx.set(ref, patch, { merge: true });
    return cur;
  });
}

/* ============================================================ reading */

async function listCandidates({ section, status, jobId, sourceKey, categoryId, band, modelId, kind, limit = 30 } = {}) {
  let q = candidates();
  let approximate = false;
  if (jobId) q = q.where('jobId', '==', jobId);
  else if (sourceKey) q = q.where('sourceKey', '==', sourceKey);
  else if (section) q = q.where('reviewSection', '==', section);
  else if (status) q = q.where('status', '==', status);
  const extra = [
    jobId && section, (jobId || sourceKey) && section, status && (jobId || sourceKey || section), categoryId, band, modelId, kind
  ].some(Boolean);
  const fetch = extra ? 300 : Math.min(100, limit);
  const snap = await q.orderBy('createdAt', 'desc').limit(fetch).get();
  let rows = snap.docs.map(d => d.data());
  if (section && (jobId || sourceKey)) rows = rows.filter(r => r.reviewSection === section);
  if (status && (jobId || sourceKey || section)) rows = rows.filter(r => r.status === status);
  if (categoryId) rows = rows.filter(r => r.categoryId === categoryId);
  if (band) rows = rows.filter(r => r.confidence && r.confidence.band === band);
  if (kind) rows = rows.filter(r => r.kind === kind);
  if (modelId) rows = rows.filter(r => [r.sourceMatch, r.compatibleMatch, r.referenceMatch].some(m => m && m.modelId === modelId));
  if (extra) approximate = snap.size >= fetch;
  return { candidates: rows.slice(0, limit), approximate };
}

async function sectionCounts({ jobId } = {}) {
  const out = {};
  await Promise.all(S.REVIEW_SECTIONS.map(async s => {
    try {
      let q = candidates().where('reviewSection', '==', s.id);
      if (jobId) q = q.where('jobId', '==', jobId);
      const agg = await q.count().get();
      out[s.id] = agg.data().count;
    } catch (err) {
      out[s.id] = null;   /* an index still building: a dash, not a zero */
    }
  }));
  return out;
}

async function getCandidate(candidateId) {
  const db = fsx.db();
  const snap = await candidates().doc(candidateId).get();
  if (!snap.exists) return null;
  const c = snap.data();
  const [evidence, conflicts, ledger, content] = await Promise.all([
    c.relKey ? db.collection(C.COMPATIBILITY_EVIDENCE).where('relKey', '==', c.relKey).limit(50).get().then(s => s.docs.map(d => d.data())) : [],
    c.conflict && c.conflict.withCandidateIds && c.conflict.withCandidateIds.length
      ? Promise.all(c.conflict.withCandidateIds.slice(0, 10).map(id => candidates().doc(id).get().then(s => s.exists ? s.data() : null))).then(l => l.filter(Boolean))
      : [],
    c.relKey ? db.collection(C.APPROVED_COMPATIBILITIES).doc(c.relKey).get().then(s => s.exists ? s.data() : null) : null,
    db.collection(C.INSTAGRAM_CONTENT).doc(c.contentKey).get().then(s => s.exists ? s.data() : null)
  ]);
  return { candidate: c, evidence, conflicts, ledger, content: content ? {
    contentKey: content.contentKey, permalink: content.permalink, contentType: content.contentType,
    publishedAt: content.publishedAt, caption: content.caption, mediaItems: content.mediaItems || [],
    duplicateStatus: content.duplicateStatus, latestVersion: content.latestVersion, versions: content.versions || []
  } : null };
}

module.exports = {
  ReviewError,
  approve, reject, selectModel, changeCategory, markDuplicate, reopen, sendToMissingModels,
  setSourceIgnored, approveAllValid,
  listCandidates, sectionCounts, getCandidate
};
