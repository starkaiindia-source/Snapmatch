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
    if (c.kind === 'group_proposal' && c.extractionId) {
      await db.collection(C.INSTAGRAM_EXTRACTIONS).doc(c.extractionId)
        .set({ proposalStatus: { [c.candidateId]: decision }, updatedAt: now }, { merge: true });
    }
    await syncExtraction(c.extractionId, now);
  } catch (err) {
    console.warn('[instagram] counters not updated', err && err.message);
  }
}

/**
 * Extraction Results is filtered by tags stored on each extraction. A tag
 * says what is true NOW — "existing group update pending", "conflict open" —
 * so every decision and every edit recomputes them from the extraction's own
 * candidates: one read of the extraction and one indexed query, never a scan.
 */
async function syncExtraction(extractionId, now) {
  if (!extractionId) return;
  const db = fsx.db();
  const ref = db.collection(C.INSTAGRAM_EXTRACTIONS).doc(extractionId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const x = snap.data();
  if (x.supersededBy) return;                     /* a replaced version carries no tags */
  const list = await candidates().where('extractionId', '==', extractionId).limit(150).get();
  const rows = list.docs.map(d => d.data());
  const patch = {
    filters: S.extractionFiltersFor({ relevance: x.relevance, compatSignal: !!x.compatSignal, candidates: rows, mediaItems: x.mediaItems || [] }),
    updatedAt: now
  };
  const proposals = rows.filter(r => r.kind === 'group_proposal');
  if (proposals.length) {
    const order = (x.proposals || []).map(p => p.candidateId);
    patch.proposals = proposals.sort((a, b) => order.indexOf(a.candidateId) - order.indexOf(b.candidateId)).map(S.proposalSummary);
  }
  await ref.set(patch, { merge: true });
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
  return learnAliasFor(text, record, now);
}

async function learnAliasFor(text, record, now) {
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
  /* production may have moved on while it was closed */
  if (c.kind === 'group_proposal') await proposalRefresh({ candidateId, admin, now: now + 1 });
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

/* ======================================================= group proposals

   A LIST AGAINST A GROUP

   A group proposal (group-proposals.js) is edited and approved here. Two
   things hold for every function below:

     · After any edit the proposal is recomputed against production as it is
       NOW (groupProposals.refresh), so the card never shows a plan made
       from stale membership.
     · Approval recomputes it once more INSIDE the transaction, from
       modelGroups documents read in that transaction. That is where
       "one category + one model = one group" is enforced: whatever the card
       said, a model that has a group in the category by the time of the
       write is BLOCKED, the whole approval is refused, and nothing is
       written.

   What approval writes is still additive only: models that have no group in
   the category join the target group. Moving a model out of a group, merging
   two groups and creating a group (which needs a part code and a serial) are
   changes to the master catalogue; an approved request for one is recorded
   in the ledger for it, never performed here. */

const groupProposals = require('./group-proposals');

function assertProposal(cur, { pending = true } = {}) {
  if (!cur || cur.kind !== 'group_proposal') throw new ReviewError(400, 'not-a-proposal', 'This candidate is not a group proposal.');
  if (pending && cur.status !== 'pending') throw new ReviewError(409, 'wrong-status', 'Only a pending proposal can be edited. Reopen it first.');
}

/** Read, edit in memory, recompute against production, write. */
async function editProposal(candidateId, admin, now, action, note, edit) {
  const db = fsx.db();
  const FV = fsx.FieldValue();
  const ref = candidates().doc(candidateId);
  const snap = await ref.get();
  if (!snap.exists) throw new ReviewError(404, 'not-found', 'No such candidate.');
  const cur = snap.data();
  assertProposal(cur);
  const next = JSON.parse(JSON.stringify(cur));
  const extra = edit(next) || {};
  const recomputed = await groupProposals.refresh(next);
  const patch = Object.assign({}, extra, recomputed, {
    updatedAt: now,
    history: FV.arrayUnion(hist(now, admin, action, note))
  });
  await db.runTransaction(async tx => {
    const fresh = await tx.get(ref);
    if (!fresh.exists || fresh.data().status !== 'pending' || fresh.data().updatedAt !== cur.updatedAt) {
      throw new ReviewError(409, 'stale', 'The proposal changed while you were editing it. Reload and try again.');
    }
    tx.set(ref, patch, { merge: true });
  });
  try { await syncExtraction(cur.extractionId, now); }
  catch (err) { console.warn('[instagram] extraction tags not updated', err && err.message); }
  return { before: cur, after: Object.assign({}, next, recomputed) };
}

function findMember(p, memberKey) {
  const m = (p.members || []).find(x => x.key === memberKey);
  if (!m) throw new ReviewError(400, 'unknown-member', 'That entry is not in this proposal.');
  return m;
}

function summary(p) {
  return {
    proposedAction: p.proposedAction, reviewSection: p.reviewSection, counts: p.counts,
    targetGroupId: p.target && p.target.groupId || null, masterReviewRequired: !!p.masterReviewRequired
  };
}

/** The admin picks the catalogue record for one list entry. */
async function proposalSelectModel({ candidateId, memberKey, modelId, rememberAlias = false, admin, now }) {
  const record = taxonomy.modelById(modelId);
  if (!record) throw new ReviewError(400, 'unknown-model', 'That model id is not in the catalogue. The importer never creates models.');
  let previous = null, text = null;
  const out = await editProposal(candidateId, admin, now, 'match_edited', `${memberKey} -> ${record.modelId}`, p => {
    const m = findMember(p, memberKey);
    if (p.members.some(x => x !== m && x.match && x.match.modelId === record.modelId && x.decision !== 'exclude')) {
      throw new ReviewError(409, 'same-model', `${record.modelName} is already an entry of this list.`);
    }
    previous = m.match && m.match.modelId || null;
    text = m.text;
    m.match = {
      status: 'matched', modelId: record.modelId, modelName: record.modelName, brandId: record.brandId,
      method: 'admin_selected', strength: 'strong', normalizedText: m.match ? m.match.normalizedText || null : null,
      requiresVariantConfirmation: false, variantNote: null,
      notes: [`selected by ${admin.email || admin.uid}; previously ${previous || (m.match ? m.match.status : 'none')}`],
      alternatives: m.match ? m.match.alternatives || [] : [], siblings: [],
      selectedBy: admin.uid, selectedAt: now
    };
    m.key = 'm:' + record.modelId;
  });
  const alias = rememberAlias && text ? await learnAliasFor(text, record, now) : null;
  return Object.assign({ ok: true, candidateId, memberKey: 'm:' + record.modelId, previousModelId: previous, newModelId: record.modelId, alias }, summary(out.after));
}

/** Include, exclude, or request a reassignment for one entry. */
async function proposalMemberDecision({ candidateId, memberKey, decision, admin, now }) {
  if (decision !== null && S.MEMBER_DECISIONS.indexOf(decision) < 0) {
    throw new ReviewError(400, 'bad-decision', 'decision must be one of: ' + S.MEMBER_DECISIONS.join(', ') + ', or null to clear it.');
  }
  let previous = null;
  const out = await editProposal(candidateId, admin, now, 'entry_decision', `${memberKey}: ${decision || 'cleared'}`, p => {
    const m = findMember(p, memberKey);
    if (decision === 'reassign_request' && m.state !== 'conflict') {
      throw new ReviewError(409, 'not-a-conflict', 'A reassignment can be requested only for a model that already belongs to another group.');
    }
    previous = m.decision || null;
    m.decision = decision === 'include' ? null : decision;
    m.decidedBy = decision ? admin.uid : null;
    m.decidedAt = decision ? now : null;
  });
  return Object.assign({ ok: true, candidateId, memberKey, previousDecision: previous, decision }, summary(out.after));
}

/** "Add models": a catalogue record the post did not list, added by a person. */
async function proposalAddModel({ candidateId, modelId, admin, now }) {
  const record = taxonomy.modelById(modelId);
  if (!record) throw new ReviewError(400, 'unknown-model', 'That model id is not in the catalogue. The importer never creates models.');
  const out = await editProposal(candidateId, admin, now, 'entry_added', record.modelId, p => {
    if (p.members.some(x => x.match && x.match.modelId === record.modelId)) {
      throw new ReviewError(409, 'same-model', `${record.modelName} is already an entry of this list.`);
    }
    if (p.members.length >= 150) throw new ReviewError(409, 'too-many', 'A proposal holds at most 150 entries.');
    p.members.push({
      key: 'm:' + record.modelId, text: record.modelName, texts: [record.modelName],
      match: { status: 'matched', modelId: record.modelId, modelName: record.modelName, brandId: record.brandId,
               method: 'admin_selected', strength: 'strong', normalizedText: null, requiresVariantConfirmation: false,
               variantNote: null, notes: [`added by ${admin.email || admin.uid}; not in the Instagram post`], alternatives: [], siblings: [] },
      evidence: [{ source: 'manual', ref: null, line: 'added by an admin', confidence: null }],
      occurrences: 0, decision: null, addedBy: admin.uid
    });
  });
  return Object.assign({ ok: true, candidateId, modelId: record.modelId }, summary(out.after));
}

/** The master of a NEW group. An existing group keeps the master it has. */
async function proposalSetMaster({ candidateId, modelId, admin, now }) {
  let previous = null;
  const out = await editProposal(candidateId, admin, now, 'master_selected', modelId, p => {
    if (!p.target || p.target.mode !== 'new') {
      throw new ReviewError(409, 'existing-group', 'An existing group keeps its master model. Changing it is a change to the master catalogue.');
    }
    const m = (p.members || []).find(x => x.match && x.match.modelId === modelId && x.state === 'add');
    if (!m) throw new ReviewError(400, 'not-a-member', 'The master must be one of the models this proposal would put in the group.');
    previous = p.masterOverride || (p.proposedMaster && p.proposedMaster.modelId) || null;
    p.masterOverride = modelId;
    return { masterOverride: modelId };
  });
  return Object.assign({ ok: true, candidateId, previousMasterId: previous, masterModelId: modelId }, summary(out.after));
}

/** Which group the list describes: one it already overlaps, or a new one. */
async function proposalSetTarget({ candidateId, groupId, admin, now }) {
  let previous = null;
  const out = await editProposal(candidateId, admin, now, 'target_selected', groupId || 'automatic', p => {
    const allowed = new Set((p.otherGroups || []).map(g => g.groupId));
    if (p.target && p.target.groupId) allowed.add(p.target.groupId);
    (p.target && p.target.candidates || []).forEach(g => allowed.add(g));
    if (groupId && groupId !== 'new' && !allowed.has(groupId)) {
      throw new ReviewError(400, 'unknown-group', 'Choose one of the groups this list overlaps, or a new group.');
    }
    previous = p.targetOverride || null;
    p.targetOverride = groupId || null;
    p.masterOverride = null;
    return { targetOverride: groupId || null, masterOverride: null };
  });
  return Object.assign({ ok: true, candidateId, previousTarget: previous, target: groupId || null }, summary(out.after));
}

async function proposalChangeCategory({ candidateId, categoryId, admin, now }) {
  if (!taxonomy.isKnownCategory(categoryId)) throw new ReviewError(400, 'unknown-category', 'Not one of the catalogue\'s categories. The importer never creates categories.');
  let previous = null;
  const out = await editProposal(candidateId, admin, now, 'category_changed', categoryId, p => {
    previous = p.categoryId || null;
    Object.assign(p, { categoryId, categoryMethod: 'admin_selected', categoryStrength: 'strong', unmappedCategoryText: null,
                       targetOverride: null, masterOverride: null });
    return { categoryId, categoryMethod: 'admin_selected', categoryStrength: 'strong', unmappedCategoryText: null,
             targetOverride: null, masterOverride: null };
  });
  return Object.assign({ ok: true, candidateId, previousCategoryId: previous, newCategoryId: categoryId }, summary(out.after));
}

/** Recompute against production without changing anything else. */
async function proposalRefresh({ candidateId, admin, now }) {
  const out = await editProposal(candidateId, admin, now, 'refreshed', 'recomputed against production', () => ({}));
  return Object.assign({ ok: true, candidateId }, summary(out.after));
}

/**
 * Approve a group proposal.
 *
 * @param {object} args
 * @param {number} [args.expectedAdd]   how many models the admin was shown as "ADD";
 *                                      a different number now is refused as stale
 * @throws {ReviewError} 'category-conflict' when any model is already assigned
 */
async function approveProposal({ candidateId, admin, acknowledgeLowConfidence = false, expectedAdd = null, now }) {
  const db = fsx.db();
  const FV = fsx.FieldValue();
  const ref = candidates().doc(candidateId);

  const result = await db.runTransaction(async tx => {
    /* ---------------- every read first (Firestore requires it) ---------------- */
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ReviewError(404, 'not-found', 'No such candidate.');
    const p = snap.data();
    assertProposal(p, { pending: false });
    if (!S.canTransitionCandidate(p.status, 'approved')) throw new ReviewError(409, 'wrong-status', `A ${p.status} proposal cannot be approved.`);
    if (!taxonomy.isKnownCategory(p.categoryId)) throw new ReviewError(409, 'unknown-category', 'Choose the catalogue category first.');
    if (p.confidence && p.confidence.band === 'low' && !acknowledgeLowConfidence) {
      throw new ReviewError(409, 'low-confidence', 'Low-confidence proposal: approving it needs an explicit acknowledgement.');
    }

    const members = (p.members || []).map(m => Object.assign({}, m));
    const ids = Array.from(new Set(members.map(m => m.match && m.match.modelId).filter(Boolean)));
    /* foreign keys, against the catalogue itself */
    ids.forEach(id => { if (!taxonomy.modelById(id)) throw new ReviewError(409, 'unknown-model', `${id} is not in the catalogue.`); });

    const metaSnap = await tx.get(db.collection(C.CATALOG).doc('meta'));
    if (!metaSnap.exists) throw new ReviewError(409, 'catalogue-not-imported', 'The production catalogue is not in Firestore, so the one-group-per-category rule cannot be checked. Nothing was written.');
    const mgSnaps = await Promise.all(ids.map(id => tx.get(db.collection(C.MODEL_GROUPS).doc(id))));
    const membership = new Map(ids.map((id, i) => [id, groupProposals.groupsIn(mgSnaps[i].exists ? mgSnaps[i].data() : null, p.categoryId)]));

    /* the target, decided from the membership just read */
    const first = groupProposals.plan({ categoryId: p.categoryId, headline: p.headline, members, imported: true, membership,
                                        groups: new Map(), targetOverride: p.targetOverride, masterOverride: p.masterOverride });
    const groups = new Map();
    let gdSnap = null, gSnap = null;
    if (first.target.groupId) {
      gSnap = await tx.get(db.collection(C.GROUPS).doc(first.target.groupId));
      gdSnap = await tx.get(db.collection(C.GROUP_DETAILS).doc(first.target.groupId));
      if (!gdSnap.exists) throw new ReviewError(409, 'group-missing', `${first.target.groupId} has no groupDetails document. Nothing was written.`);
      groups.set(first.target.groupId, groupProposals.summariseGroup(first.target.groupId, gSnap.exists ? gSnap.data() : null, gdSnap.data()));
    }
    const planned = groupProposals.plan({ categoryId: p.categoryId, headline: p.headline, members, imported: true, membership, groups,
                                          targetOverride: p.targetOverride, masterOverride: p.masterOverride });
    const state = Object.assign({}, planned, { members: members.map(groupProposals.slimMember) });
    const stateNext = Object.assign({}, p, state);

    /* ---------------------------- decide, then write ---------------------------- */

    /* THE RULE. Any listed model that belongs to another group in this
       category blocks the whole approval, until a person has dealt with it. */
    const blocked = members.filter(m => m.state === 'conflict' && !m.decision);
    if (blocked.length || planned.target.mode === 'undecided') {
      tx.set(ref, Object.assign({}, state, {
        reviewSection: S.reviewSectionFor(stateNext), updatedAt: now,
        history: FV.arrayUnion(hist(now, admin, 'approval_refused',
          blocked.length ? `BLOCKED — ${blocked.length} model(s) already assigned to another group in this category` : 'no target group chosen'))
      }), { merge: true });
      return { outcome: 'blocked', p, blocked: blocked.map(m => ({
        modelId: m.match.modelId, modelName: m.match.modelName, existingGroupId: m.currentGroupId || (m.currentGroupIds || [])[0] || null,
        existingGroupMaster: m.currentGroupMaster || null, proposedGroupId: planned.target.groupId || 'new'
      })), reason: planned.target.mode === 'undecided' ? planned.target.reason : null };
    }
    if (['UPDATE_EXISTING_GROUP', 'CREATE_NEW_GROUP', 'NO_CHANGE'].indexOf(planned.proposedAction) < 0) {
      throw new ReviewError(409, 'not-approvable', planned.actionReasons[0] || 'This proposal cannot be approved as it stands.');
    }
    const add = members.filter(m => m.state === 'add');
    if (expectedAdd != null && Number(expectedAdd) !== add.length) {
      tx.set(ref, Object.assign({}, state, { reviewSection: S.reviewSectionFor(stateNext), updatedAt: now }), { merge: true });
      return { outcome: 'stale', p, now: add.length };
    }

    const evidenceEntry = {
      candidateId, sourceKey: p.sourceKey, sourceUsername: p.sourceUsername || null,
      permalink: p.sourcePost && p.sourcePost.permalink || null,
      evidenceText: String(p.extractedText || '').slice(0, 500), approvedAt: now
    };
    const approval = {
      reviewer: admin.uid, reviewedAt: now, approvedBy: admin.uid, approvedByEmail: admin.email || null,
      approvedAt: now, updatedAt: now, reviewSection: 'closed', conflict: null
    };
    const requests = members.filter(m => m.state === 'conflict' && m.decision === 'reassign_request').map(m => ({
      type: 'reassign', modelId: m.match.modelId, modelName: m.match.modelName,
      fromGroupId: m.currentGroupId || (m.currentGroupIds || [])[0] || null, toGroupId: planned.target.groupId || 'new'
    }));
    const requestRef = requests.length ? db.collection(C.APPROVED_COMPATIBILITIES).doc('req__' + S.sha256(candidateId).slice(0, 32)) : null;
    if (requestRef) {
      tx.set(requestRef, {
        relKey: requestRef.id, kind: 'master_change_request', status: 'approved_pending_master', productionOutcome: 'pending_master',
        categoryId: p.categoryId, requests, proposalId: candidateId,
        productionNote: 'Moving a model between groups is a change to the master catalogue. Recorded for it; nothing was moved here.',
        approvedBy: admin.uid, approvedByEmail: admin.email || null, approvedAt: now,
        candidateIds: [candidateId], evidence: [evidenceEntry], sources: [p.sourceKey], createdAt: now, updatedAt: now
      });
    }

    /* ---- nothing to add: it was all there already ---- */
    if (planned.target.mode === 'existing' && !add.length) {
      tx.set(ref, Object.assign({}, state, approval, {
        status: requests.length ? 'approved' : 'duplicate',
        duplicateReason: requests.length ? null : 'already_existing',
        reviewSection: requests.length ? 'closed' : 'duplicates',
        productionOutcome: requests.length ? 'pending_master' : 'already_existing',
        history: FV.arrayUnion(hist(now, admin, requests.length ? 'approved' : 'duplicate',
          requests.length ? `${requests.length} reassignment request(s) recorded for the master catalogue` : 'Already Existing in production; kept as evidence'))
      }), { merge: true });
      return { outcome: requests.length ? 'pending_master' : 'already_existing', p, requests };
    }

    /* ---- a new group: recorded for the catalogue build, never invented here ---- */
    if (planned.target.mode === 'new') {
      if (planned.masterReviewRequired || !planned.proposedMaster) {
        throw new ReviewError(409, 'master-review-required', 'MASTER MODEL REVIEW REQUIRED: choose the master model of the new group first.');
      }
      const ledgerRef = db.collection(C.APPROVED_COMPATIBILITIES).doc(planned.relKey);
      const note = 'A new group needs a part code and a serial, which only the catalogue build issues. Create it in Compatibility Management; it is in the exported worklist.';
      tx.set(ledgerRef, {
        relKey: planned.relKey, kind: 'new_group', status: 'approved_pending_build', productionOutcome: 'pending_build',
        categoryId: p.categoryId, masterModelId: planned.proposedMaster.modelId, masterModelName: planned.proposedMaster.modelName,
        memberIds: add.map(m => m.match.modelId), memberNames: add.map(m => m.match.modelName),
        productionNote: note, proposalId: candidateId, confidenceAtApproval: p.confidence ? p.confidence.band : null,
        approvedBy: admin.uid, approvedByEmail: admin.email || null, approvedAt: now,
        candidateIds: [candidateId], evidence: [evidenceEntry], sources: [p.sourceKey],
        processingVersion: p.processingVersion || null, createdAt: now, updatedAt: now
      });
      tx.set(ref, Object.assign({}, state, approval, {
        status: 'approved', productionOutcome: 'pending_build', productionNote: note, ledgerId: planned.relKey,
        history: FV.arrayUnion(hist(now, admin, 'approved', `new group of ${add.length} models, master ${planned.proposedMaster.modelName}; pending the catalogue build`))
      }), { merge: true });
      return { outcome: 'pending_build', p, note, requests, master: planned.proposedMaster, memberCount: add.length };
    }

    /* ---- an existing group gains the models that have no group yet ---- */
    const groupId = planned.target.groupId;
    const gd = gdSnap.data() || {};
    if (gd.categoryId && gd.categoryId !== p.categoryId) {
      throw new ReviewError(409, 'category-mismatch', `Group ${groupId} is ${gd.categoryId}, not ${p.categoryId}. Nothing was written.`);
    }
    const oldIds = Array.isArray(gd.memberIds) ? gd.memberIds.map(String) : [];
    const oldNames = Array.isArray(gd.memberNames) ? gd.memberNames.slice() : [];
    const clash = add.find(m => oldIds.indexOf(m.match.modelId) > -1);
    if (clash) {
      throw new ReviewError(409, 'inconsistent-production', `${clash.match.modelName} is already a member of ${groupId} but its modelGroups entry does not say so. Fix the catalogue import; nothing was written.`);
    }
    const records = add.map(m => taxonomy.modelById(m.match.modelId));
    const newIds = oldIds.concat(records.map(r => r.modelId));
    const newNames = oldNames.concat(records.map(r => r.modelName));
    const previousCount = Number(gd.memberCount) || oldIds.length;
    const masterId = gSnap && gSnap.exists ? gSnap.data().masterModelId : null;
    const anchorId = masterId && oldIds.indexOf(masterId) > -1 ? masterId : oldIds[0];
    const anchor = anchorId ? taxonomy.modelById(anchorId) : null;
    if (!anchor) throw new ReviewError(409, 'group-empty', `Group ${groupId} has no member the approval can be anchored on. Nothing was written.`);

    const change = {
      groupId, groupNo: planned.target.groupNo || null,
      addedModelIds: records.map(r => r.modelId), addedModelNames: records.map(r => r.modelName),
      anchorModelId: anchor.modelId, anchorModelName: anchor.modelName,
      previousMemberCount: previousCount, newMemberCount: newIds.length,
      previousMemberIds: oldIds.slice(0, 1000)
    };
    tx.set(db.collection(C.GROUP_DETAILS).doc(groupId), {
      memberIds: newIds, memberNames: newNames, memberCount: newIds.length,
      lastChange: { source: 'instagram-proposal', candidateId, addedModelIds: change.addedModelIds, by: admin.uid, at: now }
    }, { merge: true });
    if (gSnap && gSnap.exists) tx.set(db.collection(C.GROUPS).doc(groupId), { memberCount: newIds.length }, { merge: true });
    records.forEach((r, i) => {
      tx.set(db.collection(C.MODEL_GROUPS).doc(r.modelId), { id: r.modelId, byCategory: { [p.categoryId]: FV.arrayUnion(groupId) } }, { merge: true });
      /* One ledger entry per added model, in the shape the pairwise approval
         writes — so the build overlay and the import guard cover it as is. */
      const relKey = S.relKeyFor(p.categoryId, anchor.modelId, r.modelId);
      tx.set(db.collection(C.APPROVED_COMPATIBILITIES).doc(relKey), {
        relKey, kind: S.RELATION_KIND, categoryId: p.categoryId,
        modelA: [anchor.modelId, r.modelId].sort()[0], modelB: [anchor.modelId, r.modelId].sort()[1],
        sourceModelId: anchor.modelId, sourceModelName: anchor.modelName,
        compatibleModelId: r.modelId, compatibleModelName: r.modelName,
        compatibilityType: 'explicit', status: 'applied', productionOutcome: 'applied', appliedAt: now,
        appliedChange: { groupId, addedModelId: r.modelId, addedModelName: r.modelName,
                         anchorModelId: anchor.modelId, anchorModelName: anchor.modelName,
                         previousMemberCount: previousCount + i, newMemberCount: previousCount + i + 1 },
        proposalId: candidateId, approvedBy: admin.uid, approvedByEmail: admin.email || null, approvedAt: now,
        candidateIds: FV.arrayUnion(candidateId), evidence: FV.arrayUnion(evidenceEntry), sources: FV.arrayUnion(p.sourceKey),
        confidenceAtApproval: p.confidence ? p.confidence.band : null,
        matchMethods: { source: 'group_master', compatible: add[i].match.method || null },
        processingVersion: p.processingVersion || null, createdAt: now, updatedAt: now
      }, { merge: true });
    });
    tx.set(ref, Object.assign({}, state, approval, {
      status: 'approved', productionOutcome: 'applied', appliedChange: change,
      history: FV.arrayUnion(hist(now, admin, 'approved',
        `${records.length} model(s) added to ${groupId} (${previousCount} -> ${newIds.length} members)` +
        (requests.length ? `; ${requests.length} reassignment request(s) recorded` : '')))
    }), { merge: true });
    return { outcome: 'applied', p, change, requests };
  });

  if (result.outcome === 'blocked') {
    throw new ReviewError(409, 'category-conflict', result.blocked.length
      ? 'BLOCKED — MODEL ALREADY ASSIGNED. ' + result.blocked.slice(0, 5).map(b => `${b.modelName} is in ${b.existingGroupId}`).join('; ') +
        (result.blocked.length > 5 ? `; and ${result.blocked.length - 5} more` : '') +
        '. A model may belong to only one group per category. Nothing was written.'
      : 'CATEGORY CONFLICT — ' + result.reason + '. Nothing was written.', { blocked: result.blocked });
  }
  if (result.outcome === 'stale') {
    throw new ReviewError(409, 'stale', `Production changed since this proposal was shown: it would now add ${result.now} model(s). Review it again; nothing was written.`);
  }

  const added = result.change ? result.change.addedModelIds.length : 0;
  await afterDecision(result.p, {
    approved: ['applied', 'pending_build', 'pending_master'].indexOf(result.outcome) > -1 ? 1 : 0,
    appliedToProduction: added,
    duplicates: result.outcome === 'already_existing' ? 1 : 0,
    pendingReview: -1
  }, 'approved', now);

  return {
    ok: true, outcome: result.outcome, candidateId, change: result.change || null, requests: result.requests || [],
    note: {
      applied: `Approved: ${added} model(s) added to ${result.change ? result.change.groupId : ''} in the production compatibility data.`,
      pending_build: 'Approved into the ledger. Not live yet: ' + (result.note || ''),
      pending_master: 'Approved: the reassignment request(s) are recorded for the master catalogue. Nothing was moved.',
      already_existing: 'Already Existing in production. Kept as additional evidence; nothing written.'
    }[result.outcome]
  };
}

/** One group as production has it — for "Open existing group". */
async function getGroup(groupId) {
  const map = await groupProposals.readGroups([groupId], groupId, new Map());
  return map.get(groupId) || null;
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
    duplicateStatus: content.duplicateStatus, latestVersion: content.latestVersion, versions: content.versions || [],
    relevance: content.relevance || null, relevanceReason: content.relevanceReason || null,
    manualEvidence: (content.manualEvidence || []).map(e => ({
      id: e.id, kind: e.kind, status: e.status, readBy: e.readBy || null, reason: e.reason || null,
      hasPreview: !!e.hasPreview, addedByEmail: e.addedByEmail || null, addedAt: e.addedAt || null,
      text: String(e.text || '').slice(0, 1500)
    }))
  } : null };
}

module.exports = {
  ReviewError,
  approve, reject, selectModel, changeCategory, markDuplicate, reopen, sendToMissingModels,
  setSourceIgnored, approveAllValid,
  approveProposal, proposalSelectModel, proposalMemberDecision, proposalAddModel, proposalSetMaster,
  proposalSetTarget, proposalChangeCategory, proposalRefresh, getGroup,
  listCandidates, sectionCounts, getCandidate
};
