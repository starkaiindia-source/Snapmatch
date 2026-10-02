/* ============================================================================
   Mobile Parts Finder · api/_services/compat/management.js
   ----------------------------------------------------------------------------
   COMPATIBILITY MANAGEMENT — Mobile Parts Finder's own.

   The compatibility groups of this project are its own master data. This file
   is the write side of that: what an administrator may do to a group by hand,
   and the two writers Instagram Intelligence shares with them (a merge, and
   the creation of a group).

     category  →  group  →  master model  →  compatible models

   ----------------------------------------------------------------------------
   THE RULES EVERY FUNCTION HOLDS, INSIDE ITS TRANSACTION

     · one category + one model = at most ONE group. A model that already has
       a group in the category is never added to a second one; the answer is
       to merge the groups or to move the model, and both are operations here.
     · a model is a record of the catalogue (All Brands & Models). Nothing
       here creates one, and nothing here deletes one: removing a model from a
       group, or deleting a group, removes a RELATIONSHIP.
     · a group always has a master, and the master is one of its own members.
     · every change is written to the ledger (approvedCompatibilities) in the
       same transaction, identified by the DEVICES it concerns — so the
       catalogue build replays it over the baseline in the order it happened
       (scripts/build-dataset.js) and the next import does not undo it.

   ----------------------------------------------------------------------------
   THREE COLLECTIONS, ALWAYS TOGETHER

     groups/{id}          master, category, part code, member count
     groupDetails/{id}    the member list
     modelGroups/{model}  byCategory[category] = [group id] — the index the
                          one-group rule and the public lookup both read

   A MERGE keeps the absorbed group's two documents, marked `mergedInto`, and
   moves its members: a part page that still asks for the old group id is
   answered with the group it became (entitlement-service follows the mark),
   and the catalogue build drops the absorbed group for good.

   Writes go only to THIS project (api/_services/instagram/firestore.js holds
   the boundary).
   ========================================================================== */
'use strict';

const C = require('../../_schema/collections');
const S = require('../../_schema/instagram');
const fsx = require('../instagram/firestore');
const taxonomy = require('../taxonomy-service');

class ManagementError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.name = 'ManagementError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra || {});
  }
}

/* a Firestore transaction takes 500 writes; a change that would need more is
   refused rather than half-applied */
const MAX_WRITES = 450;

const refs = db => ({
  group: id => db.collection(C.GROUPS).doc(id),
  detail: id => db.collection(C.GROUP_DETAILS).doc(id),
  model: id => db.collection(C.MODEL_GROUPS).doc(id),
  ledger: id => db.collection(C.APPROVED_COMPATIBILITIES).doc(id)
});

function groupsIn(doc, categoryId) {
  if (!doc) return [];
  const map = doc.byCategory && typeof doc.byCategory === 'object' ? doc.byCategory : doc;
  return Array.isArray(map[categoryId]) ? map[categoryId].map(String) : [];
}

function record(modelId) {
  const r = taxonomy.modelById(modelId);
  if (!r) throw new ManagementError(400, 'unknown-model', `${modelId} is not in All Brands & Models. A model is never created here.`);
  return r;
}

/** One group, read inside a transaction, or a refusal. A merged-away group is not a group. */
async function readGroup(tx, r, groupId, { allowMerged = false } = {}) {
  const [gSnap, gdSnap] = await Promise.all([tx.get(r.group(groupId)), tx.get(r.detail(groupId))]);
  if (!gSnap.exists || !gdSnap.exists) throw new ManagementError(404, 'no-such-group', `There is no group ${String(groupId).toUpperCase()}.`);
  const g = gSnap.data(), gd = gdSnap.data();
  if (!allowMerged && (g.mergedInto || gd.mergedInto)) {
    throw new ManagementError(409, 'merged', `${g.groupNo || groupId} was merged into ${String(g.mergedInto || gd.mergedInto).toUpperCase()}. Edit that group.`);
  }
  const memberIds = Array.isArray(gd.memberIds) ? gd.memberIds.map(String) : [];
  const memberNames = memberIds.map((id, i) => (Array.isArray(gd.memberNames) && gd.memberNames[i]) || (taxonomy.modelById(id) || {}).modelName || id);
  return { groupId, g, gd, memberIds, memberNames, categoryId: g.categoryId || gd.categoryId, groupNo: g.groupNo || gd.groupNo || String(groupId).toUpperCase() };
}

function stamp(type, admin, now, extra) {
  return Object.assign({ source: admin.system ? 'instagram-intelligence' : 'admin', type, by: admin.uid, at: now }, extra || {});
}

function opId(kind, now, parts) {
  return `op__${kind}__${now}_${S.sha256(parts.join('|')).slice(0, 16)}`;
}

function ledgerBase(kind, categoryId, admin, now) {
  return {
    kind, categoryId, status: 'applied', productionOutcome: 'applied', appliedAt: now,
    approvedBy: admin.uid, approvedByEmail: admin.email || null, approvedAt: now,
    automatic: !!admin.system, onBehalfOf: admin.onBehalfOf || null,
    sources: [], evidence: [], createdAt: now, updatedAt: now
  };
}

/* ================================================================== merge */

/**
 * The writes of one merge. Shared by an administrator's merge and by the one
 * Instagram Intelligence decides. Reads are the caller's: everything is passed
 * in, so this only writes.
 *
 * @param {object} tx
 * @param {object} a
 * @param {object} a.survivor   readGroup() of the group that stays
 * @param {object} a.absorbed   readGroup() of the group that is merged into it
 * @param {string[]} a.baseIds  the survivor's member ids BEFORE this merge (after any additions made in the same transaction)
 * @param {string[]} a.baseNames
 * @returns {{memberIds:string[], memberNames:string[], moved:string[], entry:object, key:string}}
 */
function writeMerge(tx, { db, survivor, absorbed, baseIds, baseNames, admin, now, ledgerExtra }) {
  const r = refs(db);
  const moved = absorbed.memberIds.filter(id => baseIds.indexOf(id) < 0);
  const memberIds = baseIds.concat(moved);
  const memberNames = baseNames.concat(moved.map(id => absorbed.memberNames[absorbed.memberIds.indexOf(id)]));
  const survivorAnchor = survivor.g.masterModelId && survivor.memberIds.indexOf(survivor.g.masterModelId) > -1 ? survivor.g.masterModelId : survivor.memberIds[0];
  const absorbedAnchor = absorbed.g.masterModelId && absorbed.memberIds.indexOf(absorbed.g.masterModelId) > -1 ? absorbed.g.masterModelId : absorbed.memberIds[0];
  const key = S.mergeKeyFor(survivor.categoryId, survivorAnchor, absorbedAnchor);

  /* the absorbed group is kept, and says where it went */
  const gone = { mergedInto: survivor.groupId, mergedAt: now, mergedBy: admin.uid };
  tx.set(r.group(absorbed.groupId), gone, { merge: true });
  tx.set(r.detail(absorbed.groupId), gone, { merge: true });
  absorbed.memberIds.forEach(id => tx.set(r.model(id), { id, byCategory: { [survivor.categoryId]: [survivor.groupId] } }, { merge: true }));

  const entry = Object.assign(ledgerBase('merge_groups', survivor.categoryId, admin, now), {
    relKey: key, productionOutcome: 'merged', live: true,
    survivor: { groupId: survivor.groupId, groupNo: survivor.groupNo, partCode: survivor.g.partCode || null,
                anchorModelId: survivorAnchor, anchorModelName: (taxonomy.modelById(survivorAnchor) || {}).modelName || null },
    absorbed: { groupId: absorbed.groupId, groupNo: absorbed.groupNo, partCode: absorbed.g.partCode || null,
                anchorModelId: absorbedAnchor, masterModelName: absorbed.g.masterModelName || null,
                memberCount: absorbed.memberIds.length,
                /* what it held, so the merge can be taken back exactly */
                memberIds: absorbed.memberIds.slice(0, 1000), memberNames: absorbed.memberNames.slice(0, 1000) },
    movedModelIds: moved,
    productionNote: 'Merged in the live compatibility data. The absorbed group is kept, marked as merged, until the catalogue build drops it.'
  }, ledgerExtra || {});
  tx.set(r.ledger(key), entry, { merge: true });
  return { memberIds, memberNames, moved, entry, key };
}

/** How many writes one merge costs, for the transaction limit. */
function mergeWrites(absorbed) { return absorbed.memberIds.length + 3; }

/**
 * An administrator merges one group into another: the same part, listed twice.
 */
async function mergeGroups({ intoGroupId, fromGroupId, admin, now }) {
  if (intoGroupId === fromGroupId) throw new ManagementError(400, 'same-group', 'A group cannot be merged into itself.');
  const db = fsx.db();
  const r = refs(db);
  return db.runTransaction(async tx => {
    const survivor = await readGroup(tx, r, intoGroupId);
    const absorbed = await readGroup(tx, r, fromGroupId);
    if (survivor.categoryId !== absorbed.categoryId) {
      throw new ManagementError(409, 'category-mismatch', `${survivor.groupNo} is ${survivor.categoryId} and ${absorbed.groupNo} is ${absorbed.categoryId}. Only groups of one category can be merged.`);
    }
    if (mergeWrites(absorbed) + 4 > MAX_WRITES) throw new ManagementError(409, 'too-large', `${absorbed.groupNo} has too many models to merge in one step.`);
    const out = writeMerge(tx, { db, survivor, absorbed, baseIds: survivor.memberIds, baseNames: survivor.memberNames, admin, now });
    const change = stamp('merged', admin, now, { mergedGroupIds: [absorbed.groupId], addedModelIds: out.moved });
    tx.set(r.detail(intoGroupId), { memberIds: out.memberIds, memberNames: out.memberNames, memberCount: out.memberIds.length, lastChange: change }, { merge: true });
    tx.set(r.group(intoGroupId), { memberCount: out.memberIds.length, lastChange: change }, { merge: true });
    return { ok: true, groupId: intoGroupId, groupNo: survivor.groupNo, mergedGroupNo: absorbed.groupNo, movedModelIds: out.moved,
             previousMemberCount: survivor.memberIds.length, newMemberCount: out.memberIds.length, categoryId: survivor.categoryId, ledgerId: out.key };
  });
}

/* ============================================================ add / remove */

async function addModel({ groupId, modelId, admin, now }) {
  const m = record(modelId);
  const db = fsx.db();
  const r = refs(db);
  const FV = fsx.FieldValue();
  return db.runTransaction(async tx => {
    const grp = await readGroup(tx, r, groupId);
    const mgSnap = await tx.get(r.model(m.modelId));
    const held = groupsIn(mgSnap.exists ? mgSnap.data() : null, grp.categoryId);
    if (grp.memberIds.indexOf(m.modelId) > -1) throw new ManagementError(409, 'already-member', `${m.modelName} is already in ${grp.groupNo}.`);
    const elsewhere = held.filter(g => g !== groupId);
    if (elsewhere.length) {
      throw new ManagementError(409, 'category-conflict',
        `BLOCKED — MODEL ALREADY ASSIGNED. ${m.modelName} is in ${elsewhere.join(', ').toUpperCase()}. A model may belong to only one group per category: merge the two groups, or remove it from that group first. Nothing was written.`,
        { blocked: [{ modelId: m.modelId, modelName: m.modelName, existingGroupId: elsewhere[0], proposedGroupId: groupId }] });
    }
    const anchorId = grp.g.masterModelId && grp.memberIds.indexOf(grp.g.masterModelId) > -1 ? grp.g.masterModelId : grp.memberIds[0];
    const anchor = taxonomy.modelById(anchorId);
    if (!anchor) throw new ManagementError(409, 'group-empty', `${grp.groupNo} has no member the change can be anchored on.`);
    const change = stamp('added', admin, now, { addedModelIds: [m.modelId] });
    const memberIds = grp.memberIds.concat([m.modelId]);
    tx.set(r.detail(groupId), { memberIds, memberNames: grp.memberNames.concat([m.modelName]), memberCount: memberIds.length, lastChange: change }, { merge: true });
    tx.set(r.group(groupId), { memberCount: memberIds.length, lastChange: change }, { merge: true });
    tx.set(r.model(m.modelId), { id: m.modelId, byCategory: { [grp.categoryId]: FV.arrayUnion(groupId) } }, { merge: true });
    const relKey = S.relKeyFor(grp.categoryId, anchor.modelId, m.modelId);
    tx.set(r.ledger(relKey), Object.assign(ledgerBase(S.RELATION_KIND, grp.categoryId, admin, now), {
      relKey, modelA: [anchor.modelId, m.modelId].sort()[0], modelB: [anchor.modelId, m.modelId].sort()[1],
      sourceModelId: anchor.modelId, sourceModelName: anchor.modelName, compatibleModelId: m.modelId, compatibleModelName: m.modelName,
      compatibilityType: 'explicit',
      appliedChange: { groupId, addedModelId: m.modelId, addedModelName: m.modelName, anchorModelId: anchor.modelId, anchorModelName: anchor.modelName,
                       previousMemberCount: grp.memberIds.length, newMemberCount: memberIds.length },
      matchMethods: { source: 'group_master', compatible: 'admin_selected' }
    }), { merge: true });
    return { ok: true, groupId, groupNo: grp.groupNo, categoryId: grp.categoryId, addedModelId: m.modelId, addedModelName: m.modelName,
             previousMemberCount: grp.memberIds.length, newMemberCount: memberIds.length };
  });
}

async function removeModel({ groupId, modelId, admin, now }) {
  const db = fsx.db();
  const r = refs(db);
  const FV = fsx.FieldValue();
  return db.runTransaction(async tx => {
    const grp = await readGroup(tx, r, groupId);
    const at = grp.memberIds.indexOf(String(modelId));
    if (at < 0) throw new ManagementError(404, 'not-a-member', `That model is not in ${grp.groupNo}.`);
    if (grp.g.masterModelId === modelId) {
      throw new ManagementError(409, 'is-master', `${grp.memberNames[at]} is the master model of ${grp.groupNo}. Choose another master first, or delete the group.`);
    }
    if (grp.memberIds.length <= 1) throw new ManagementError(409, 'last-member', `${grp.groupNo} would be empty. Delete the group instead.`);
    const anchorId = grp.g.masterModelId && grp.memberIds.indexOf(grp.g.masterModelId) > -1 ? grp.g.masterModelId : grp.memberIds.find(id => id !== modelId);
    const memberIds = grp.memberIds.filter((_, i) => i !== at);
    const memberNames = grp.memberNames.filter((_, i) => i !== at);
    const change = stamp('removed', admin, now, { removedModelIds: [modelId] });
    tx.set(r.detail(groupId), { memberIds, memberNames, memberCount: memberIds.length, lastChange: change }, { merge: true });
    tx.set(r.group(groupId), { memberCount: memberIds.length, lastChange: change }, { merge: true });
    tx.set(r.model(modelId), { byCategory: { [grp.categoryId]: FV.arrayRemove(groupId) } }, { merge: true });
    const id = opId('remove_model', now, [grp.categoryId, groupId, modelId]);
    tx.set(r.ledger(id), Object.assign(ledgerBase('remove_model', grp.categoryId, admin, now), {
      relKey: id, groupId, anchorModelId: anchorId, removedModelId: modelId, removedModelName: grp.memberNames[at],
      productionNote: 'Removed from the group by an administrator. The model itself is untouched.'
    }));
    return { ok: true, groupId, groupNo: grp.groupNo, categoryId: grp.categoryId, removedModelId: modelId, removedModelName: grp.memberNames[at],
             previousMemberCount: grp.memberIds.length, newMemberCount: memberIds.length };
  });
}

/* ================================================================== master */

async function setMaster({ groupId, modelId, admin, now }) {
  const m = record(modelId);
  const db = fsx.db();
  const r = refs(db);
  return db.runTransaction(async tx => {
    const grp = await readGroup(tx, r, groupId);
    const at = grp.memberIds.indexOf(m.modelId);
    if (at < 0) throw new ManagementError(409, 'not-a-member', `${m.modelName} is not in ${grp.groupNo}. The master must be one of the group's own models.`);
    if (grp.g.masterModelId === m.modelId) throw new ManagementError(409, 'already-master', `${m.modelName} is already the master of ${grp.groupNo}.`);
    const previous = grp.g.masterModelId || null;
    /* the master leads its own group, as in every group the build writes */
    const order = [at].concat(grp.memberIds.map((_, i) => i).filter(i => i !== at));
    const change = stamp('master_changed', admin, now, { previousMasterId: previous, masterModelId: m.modelId });
    tx.set(r.group(groupId), { masterModelId: m.modelId, masterModelName: m.modelName, masterBrandId: m.brandId || null, lastChange: change }, { merge: true });
    tx.set(r.detail(groupId), { drawingName: m.modelName, memberIds: order.map(i => grp.memberIds[i]), memberNames: order.map(i => grp.memberNames[i]), lastChange: change }, { merge: true });
    const id = opId('set_master', now, [grp.categoryId, groupId, m.modelId]);
    tx.set(r.ledger(id), Object.assign(ledgerBase('set_master', grp.categoryId, admin, now), {
      relKey: id, groupId, anchorModelId: previous || grp.memberIds[0], masterModelId: m.modelId, masterModelName: m.modelName,
      previousMasterId: previous, previousMasterName: grp.g.masterModelName || null
    }));
    return { ok: true, groupId, groupNo: grp.groupNo, categoryId: grp.categoryId, masterModelId: m.modelId, masterModelName: m.modelName,
             previousMasterId: previous, previousMasterName: grp.g.masterModelName || null };
  });
}

/* ========================================================== create / delete */

/**
 * The writes of a new group, numbered from the issued range. Shared with the
 * Instagram approval. The caller has read `issuedSnap` (catalog/issued) and
 * checked that none of the models has a group in the category.
 */
function writeNewGroup(tx, { db, categoryId, master, records, issuedSnap, admin, now, change }) {
  const FV = fsx.FieldValue();
  const r = refs(db);
  const category = taxonomy.categoryById(categoryId);
  if (!category || !category.code) throw new ManagementError(409, 'unknown-category', `The category ${categoryId} has no part-code prefix. Nothing was written.`);
  const issued = issuedSnap && issuedSnap.exists ? issuedSnap.data() : {};
  const number = Math.max(S.ISSUED_GROUP_BASE, Number(issued[categoryId]) || 0) + 1;
  const groupNo = `${category.code}-${number}`;
  const groupId = groupNo.toLowerCase();
  const partCode = `MPF-${groupNo}`;
  const ordered = records.slice().sort((a, b) => (b.modelId === master.modelId) - (a.modelId === master.modelId));
  const memberIds = ordered.map(x => x.modelId);
  const memberNames = ordered.map(x => x.modelName);

  tx.set(db.collection(C.CATALOG).doc('issued'), { [categoryId]: number, updatedAt: now }, { merge: true });
  tx.set(r.group(groupId), {
    groupNo, serialNo: null, partCode, oemPartNo: null,
    categoryId, categoryName: category.name,
    masterModelId: master.modelId, masterModelName: master.modelName, masterBrandId: master.brandId || null,
    memberCount: memberIds.length,
    searchTokens: Array.from(new Set(taxonomy.basicTokens(master.modelName).concat(taxonomy.basicTokens(partCode)))).slice(0, 60),
    createdBy: admin.uid, createdAt: now, lastChange: change
  });
  tx.set(r.detail(groupId), {
    groupNo, categoryId, partCode, oemPartNo: null, drawingName: master.modelName,
    memberIds, memberNames, memberCount: memberIds.length, lastChange: change
  });
  ordered.forEach(x => tx.set(r.model(x.modelId), { id: x.modelId, byCategory: { [categoryId]: FV.arrayUnion(groupId) } }, { merge: true }));
  return { groupId, groupNo, partCode, categoryName: category.name, categoryCode: category.code,
           masterModelId: master.modelId, masterModelName: master.modelName, memberIds, memberNames, memberCount: memberIds.length };
}

async function createGroup({ categoryId, masterModelId, memberIds, admin, now }) {
  if (!taxonomy.isKnownCategory(categoryId)) throw new ManagementError(400, 'unknown-category', 'That is not one of the categories.');
  const master = record(masterModelId);
  const ids = Array.from(new Set([master.modelId].concat((memberIds || []).map(String)))).slice(0, 300);
  const records = ids.map(record);
  const db = fsx.db();
  const r = refs(db);
  return db.runTransaction(async tx => {
    const mgSnaps = await Promise.all(ids.map(id => tx.get(r.model(id))));
    const issuedSnap = await tx.get(db.collection(C.CATALOG).doc('issued'));
    const blocked = ids.map((id, i) => ({ id, held: groupsIn(mgSnaps[i].exists ? mgSnaps[i].data() : null, categoryId) })).filter(x => x.held.length);
    if (blocked.length) {
      throw new ManagementError(409, 'category-conflict',
        'BLOCKED — MODEL ALREADY ASSIGNED. ' + blocked.slice(0, 5).map(b => `${taxonomy.modelById(b.id).modelName} is in ${b.held.join(', ').toUpperCase()}`).join('; ') +
        '. A model may belong to only one group per category. Nothing was written.',
        { blocked: blocked.map(b => ({ modelId: b.id, modelName: taxonomy.modelById(b.id).modelName, existingGroupId: b.held[0], proposedGroupId: 'new' })) });
    }
    const change = stamp('created', admin, now, { addedModelIds: ids });
    const created = writeNewGroup(tx, { db, categoryId, master, records, issuedSnap, admin, now, change });
    const id = opId('new_group', now, [categoryId].concat(ids));
    tx.set(r.ledger(id), Object.assign(ledgerBase('new_group', categoryId, admin, now), {
      relKey: id, productionOutcome: 'created', masterModelId: master.modelId, masterModelName: master.modelName,
      memberIds: created.memberIds, memberNames: created.memberNames,
      createdGroup: Object.assign({ masterReason: 'chosen by an admin' }, created),
      productionNote: 'Created in the live compatibility data by an administrator.'
    }));
    return Object.assign({ ok: true, categoryId, ledgerId: id }, created);
  });
}

/**
 * Deletes a group: the relationship goes, the models stay in the catalogue
 * and are free to be grouped again.
 */
async function deleteGroup({ groupId, admin, now }) {
  const db = fsx.db();
  const r = refs(db);
  const FV = fsx.FieldValue();
  return db.runTransaction(async tx => {
    const grp = await readGroup(tx, r, groupId);
    if (grp.memberIds.length + 4 > MAX_WRITES) throw new ManagementError(409, 'too-large', `${grp.groupNo} has too many models to delete in one step.`);
    const anchorId = grp.g.masterModelId && grp.memberIds.indexOf(grp.g.masterModelId) > -1 ? grp.g.masterModelId : grp.memberIds[0] || null;
    tx.delete(r.group(groupId));
    tx.delete(r.detail(groupId));
    grp.memberIds.forEach(id => tx.set(r.model(id), { byCategory: { [grp.categoryId]: FV.arrayRemove(groupId) } }, { merge: true }));
    const id = opId('delete_group', now, [grp.categoryId, groupId]);
    tx.set(r.ledger(id), Object.assign(ledgerBase('delete_group', grp.categoryId, admin, now), {
      relKey: id, groupId, groupNo: grp.groupNo, partCode: grp.g.partCode || null, anchorModelId: anchorId,
      masterModelName: grp.g.masterModelName || null,
      /* what it held when it was deleted — the record of the decision */
      memberIds: grp.memberIds.slice(0, 1000), memberNames: grp.memberNames.slice(0, 1000),
      productionNote: 'Deleted by an administrator. The models are untouched and no longer grouped in this category.'
    }));
    return { ok: true, groupId, groupNo: grp.groupNo, categoryId: grp.categoryId, memberCount: grp.memberIds.length,
             masterModelName: grp.g.masterModelName || null, releasedModelIds: grp.memberIds };
  });
}

module.exports = {
  ManagementError, MAX_WRITES,
  addModel, removeModel, setMaster, createGroup, deleteGroup, mergeGroups,
  /* shared with the Instagram approval transaction */
  readGroup, writeMerge, mergeWrites, writeNewGroup, refs
};
