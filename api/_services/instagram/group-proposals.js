/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/group-proposals.js
   ----------------------------------------------------------------------------
   A compatibility LIST, compared with the groups that already exist.

   A reel that says "this display fits these 68 models" makes ONE claim about
   ONE part. Read as pairs it is sixty-seven review cards, and every one of
   them asks the wrong question. Read as a set it has four possible answers,
   and this file works out which:

     an existing group already holds all of it      NO_CHANGE
     an existing group, plus models it lacks        UPDATE_EXISTING_GROUP
     no listed model has a group in this category   CREATE_NEW_GROUP
     the list reaches into other groups             CONFLICT_REVIEW / MERGE_REQUIRED

   ----------------------------------------------------------------------------
   THE RULE EVERYTHING HERE SERVES

       one category + one model = at most ONE group

   A search for "Samsung A14 · tempered glass" must return one part. So a
   listed model that already belongs to another group in the same category is
   never added, never moved and never duplicated: it is shown as
   "BLOCKED — MODEL ALREADY ASSIGNED" with the group that holds it, and a
   person decides. plan() computes that from production membership; the
   approval transaction (review-service.approveProposal) runs plan() AGAIN on
   membership it re-reads inside the transaction, so the rule is enforced on
   the server at the moment of writing, not when the card was drawn.

   ----------------------------------------------------------------------------
   WHICH GROUP, AND WHICH MASTER — NEVER "THE FIRST ONE IN THE LIST"

   The target is the group of the product the post names ("Vivo Y20 Combo" ->
   the group the Y20 is in); failing that, the group most of the list is
   already in; and if two groups tie, nothing is chosen and the proposal says
   so. An existing group keeps its master. A new group's master is the model
   the post names as the product; with no such line it is
   MASTER MODEL REVIEW REQUIRED, and approval waits for a person to pick one.

   ----------------------------------------------------------------------------
   READS

   One modelGroups document per distinct listed model and one groups document
   per group touched, each read once per tick (memoised) — never a collection.
   The member list of the target group is the only groupDetails read.
   ========================================================================== */
'use strict';

const C = require('../../_schema/collections');
const S = require('../../_schema/instagram');
const fsx = require('./firestore');
const taxonomy = require('../taxonomy-service');
const { slimMatch } = require('./candidate-builder');

/** A list shorter than this is a pair, and pairs keep the pairwise path. */
const MIN_SET_MEMBERS = 3;
const MAX_MEMBERS = 150;

const RANK = { strong: 3, good: 2, weak: 1, none: 0 };
const norm = t => taxonomy.basicTokens(t).join(' ');

function matchRank(m) {
  if (!m || m.status !== 'matched') return m && m.status === 'ambiguous' ? 0.5 : 0;
  return (RANK[m.strength] || 0) + (m.requiresVariantConfirmation ? 0 : 0.5);
}

/* ===================================================== consolidating sets */

/**
 * The extractor's statements -> the distinct lists a post makes.
 *
 * Entries are resolved against the catalogue and merged on the RECORD they
 * resolve to ("Y20 A", "vivo y 20a" and "Vivo Y20a" are one entry, with all
 * three spellings kept as evidence). The same list seen in another frame or
 * another carousel image is merged into one, and a list with no product title
 * of its own takes the title the post gives elsewhere.
 *
 * @param {object} det        extractor output (sets, productTitles)
 * @param {(text:string, brandHint:string|null)=>object} resolve   the matcher
 */
function consolidateSets(det, resolve) {
  const prepared = (det.sets || []).map(s => {
    const members = new Map();
    s.members.slice(0, MAX_MEMBERS * 2).forEach(m => addEntry(members, m, s.evidence, resolve));
    const headline = s.headline ? withMatch(s.headline, s.evidence, resolve) : null;
    return {
      headline, category: s.category, members,
      evidenceLines: s.evidenceLines.slice(),
      evidences: [s.evidence]
    };
  });

  const merged = [];
  prepared.forEach(p => {
    const into = merged.find(q => sameList(q, p));
    if (!into) { merged.push(p); return; }
    p.members.forEach(m => mergeEntry(into.members, m));
    if (!into.headline && p.headline) into.headline = p.headline;
    if (rankCategory(p.category) > rankCategory(into.category)) into.category = p.category;
    into.evidenceLines = into.evidenceLines.concat(p.evidenceLines).slice(0, 200);
    into.evidences = into.evidences.concat(p.evidences);
  });

  /* The product named on another image, or in the caption. Only when the
     post names exactly one — two titles would be a guess. */
  const titles = new Map();
  (det.productTitles || []).forEach(t => {
    const m = resolve(t.text, t.brandHint);
    if (S.memberIsCertain(m)) titles.set(m.modelId, Object.assign({}, t, { match: m }));
  });
  merged.forEach(set => {
    if (set.headline || titles.size !== 1) return;
    const only = Array.from(titles.values())[0];
    if (set.category.categoryId && only.categoryId && only.categoryId !== set.category.categoryId) return;
    set.headline = { text: only.text, brandHint: only.brandHint, line: only.line, match: only.match,
                     evidence: { source: only.source, ref: only.ref || null }, fromElsewhere: true };
  });

  return merged.map(set => ({
    headline: set.headline,
    category: set.category,
    members: Array.from(set.members.values()).slice(0, MAX_MEMBERS),
    truncated: set.members.size > MAX_MEMBERS,
    evidenceLines: set.evidenceLines,
    evidences: set.evidences
  }));
}

function withMatch(item, evidence, resolve) {
  return {
    text: item.text, brandHint: item.brandHint || null, line: item.line || null,
    match: resolve(item.text, item.brandHint),
    evidence: { source: evidence.source, ref: evidence.ref || null }
  };
}

function addEntry(map, item, evidence, resolve) {
  const match = resolve(item.text, item.brandHint);
  mergeEntry(map, {
    key: match.status === 'matched' ? 'm:' + match.modelId : 't:' + norm(item.text),
    text: item.text, texts: [item.text], brandHint: item.brandHint || null, match,
    evidence: [{ source: evidence.source, ref: evidence.ref || null, line: item.line || null,
                 confidence: evidence.confidence == null ? null : evidence.confidence }]
  });
}

function mergeEntry(map, entry) {
  const have = map.get(entry.key);
  if (!have) { map.set(entry.key, Object.assign({}, entry, { texts: entry.texts.slice(), evidence: entry.evidence.slice() })); return; }
  entry.texts.forEach(t => { if (have.texts.indexOf(t) < 0) have.texts.push(t); });
  have.evidence = have.evidence.concat(entry.evidence);
  if (matchRank(entry.match) > matchRank(have.match)) { have.match = entry.match; have.text = entry.text; }
}

function rankCategory(c) { return c && c.categoryId ? (RANK[c.strength] || 1) : 0; }

/** The same list twice: one product, or most of the shorter list repeated. */
function sameList(a, b) {
  const ca = a.category && a.category.categoryId, cb = b.category && b.category.categoryId;
  if (ca && cb && ca !== cb) return false;
  const ha = a.headline && a.headline.match && a.headline.match.modelId;
  const hb = b.headline && b.headline.match && b.headline.match.modelId;
  if (ha && hb) return ha === hb;
  let shared = 0;
  a.members.forEach((_, k) => { if (b.members.has(k)) shared++; });
  return shared >= 2 && shared / Math.min(a.members.size, b.members.size) >= 0.5;
}

/* ====================================================== production reads */

function memo(cache, key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}

/**
 * Which groups each model is in, for one category. Shares its memo keys with
 * production.readState, so a model read for a pairwise claim is not read
 * again for a list.
 *
 * @returns {Promise<{imported:boolean, membership:Map<string,string[]>}>}
 */
async function readMembership(categoryId, modelIds, cache = new Map()) {
  const db = fsx.db();
  const imported = await memo(cache, 'catalog/meta', async () => (await db.collection(C.CATALOG).doc('meta').get()).exists);
  const membership = new Map();
  if (!imported || !categoryId) return { imported: !!imported, membership };
  const ids = Array.from(new Set(modelIds.filter(Boolean)));
  const docs = await Promise.all(ids.map(id => memo(cache, 'mg/' + id, async () => {
    const snap = await db.collection(C.MODEL_GROUPS).doc(id).get();
    return snap.exists ? snap.data() : null;
  })));
  ids.forEach((id, i) => membership.set(id, groupsIn(docs[i], categoryId)));
  return { imported: true, membership };
}

function groupsIn(doc, categoryId) {
  if (!doc) return [];
  const map = doc.byCategory && typeof doc.byCategory === 'object' ? doc.byCategory : doc;
  const list = map[categoryId];
  return Array.isArray(list) ? list.map(String) : [];
}

/**
 * The groups a list touches. /groups carries the master and the size; only
 * the TARGET group's member list (/groupDetails) is read.
 *
 * @returns {Promise<Map<string,object>>}
 */
async function readGroups(groupIds, withMembersFor, cache = new Map()) {
  const db = fsx.db();
  const out = new Map();
  await Promise.all(Array.from(new Set(groupIds.filter(Boolean))).map(async id => {
    const g = await memo(cache, 'g/' + id, async () => {
      const snap = await db.collection(C.GROUPS).doc(id).get();
      return snap.exists ? snap.data() : null;
    });
    let detail = null;
    if (id === withMembersFor) {
      detail = await memo(cache, 'gd/' + id, async () => {
        const snap = await db.collection(C.GROUP_DETAILS).doc(id).get();
        return snap.exists ? snap.data() : null;
      });
    }
    if (!g && !detail) return;
    out.set(id, summariseGroup(id, g, detail));
  }));
  return out;
}

function summariseGroup(id, g, detail) {
  g = g || {};
  const memberIds = detail && Array.isArray(detail.memberIds) ? detail.memberIds.map(String) : null;
  return {
    groupId: id,
    groupNo: g.groupNo || (detail && detail.groupNo) || id.toUpperCase(),
    partCode: g.partCode || (detail && detail.partCode) || null,
    categoryId: g.categoryId || (detail && detail.categoryId) || null,
    masterModelId: g.masterModelId || null,
    masterModelName: g.masterModelName || (detail && detail.drawingName) || null,
    memberCount: Number(g.memberCount) || (memberIds ? memberIds.length : 0),
    memberIds,
    memberNames: detail && Array.isArray(detail.memberNames) ? detail.memberNames.map(String) : null,
    /* a group that was merged into another is kept, and says where it went */
    mergedInto: g.mergedInto || (detail && detail.mergedInto) || null,
    lastChange: g.lastChange || (detail && detail.lastChange) || null,
    createdBy: g.createdBy || null, serialNo: g.serialNo || null
  };
}

/* ================================================================== plan */

/**
 * Where a list stands against production. Pure: everything it needs is
 * passed in, so the import, an admin edit and the approval transaction all
 * run the same code on whatever membership each has just read.
 *
 * @param {object} args
 * @param {string|null} args.categoryId
 * @param {object|null} args.headline       {match} — the product the post names
 * @param {object[]} args.members           entries, each {key, match, decision?}; MUTATED:
 *                                          state, matchStatus, currentGroup* are set
 * @param {boolean} args.imported           the catalogue is in Firestore
 * @param {Map<string,string[]>} args.membership   modelId -> group ids in this category
 * @param {Map<string,object>} args.groups         groupId -> summariseGroup()
 * @param {string|null} [args.targetOverride]      a group id, or 'new' — chosen by an admin
 * @param {string|null} [args.masterOverride]      a model id — chosen by an admin
 */
function plan({ categoryId, headline, members, imported, membership, groups, targetOverride, masterOverride, masterReason, targetReason }) {
  const groupsOf = id => (id && membership.get(id)) || [];
  const setAside = m => m.decision === 'exclude' || m.decision === 'skip';
  const active = members.filter(m => !setAside(m));
  const certain = active.filter(m => S.memberIsCertain(m.match) && !m.disputed);
  const reasons = [];

  /* ---- the target group ---- */
  const tally = new Map();
  certain.forEach(m => groupsOf(m.match.modelId).forEach(g => tally.set(g, (tally.get(g) || 0) + 1)));
  const ranked = Array.from(tally.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  let target = { mode: 'new', groupId: null, reason: 'no listed model has a group in this category', candidates: [] };
  const headlineGroups = headline && S.memberIsCertain(headline.match) ? groupsOf(headline.match.modelId) : [];
  if (targetOverride === 'new') {
    target = { mode: 'new', groupId: null, reason: targetReason || 'chosen by an admin', candidates: ranked.map(r => r[0]) };
  } else if (targetOverride && (tally.has(targetOverride) || (groups && groups.has(targetOverride)))) {
    target = { mode: 'existing', groupId: targetOverride, reason: targetReason || 'chosen by an admin', candidates: ranked.map(r => r[0]) };
  } else if (headlineGroups.length === 1) {
    target = { mode: 'existing', groupId: headlineGroups[0], candidates: ranked.map(r => r[0]),
               reason: `the product the post names (${headline.match.modelName}) is in this group` };
  } else if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
    target = { mode: 'undecided', groupId: null, candidates: ranked.map(r => r[0]),
               reason: `the list overlaps ${ranked.length} existing groups and none is clearly the one it describes` };
  } else if (ranked.length) {
    target = { mode: 'existing', groupId: ranked[0][0], candidates: ranked.map(r => r[0]),
               reason: `${ranked[0][1]} of the ${certain.length} resolved models are already in this group` };
  }
  const targetGroup = target.groupId && groups ? groups.get(target.groupId) || null : null;

  /* ---- every entry against it ---- */
  members.forEach(m => {
    const match = m.match || {};
    const gs = groupsOf(match.modelId);
    m.matchStatus = S.matchStatusFor(match);
    m.currentGroupIds = gs.slice();
    const holder = gs.find(g => g !== target.groupId) || null;
    /* the holder's master: from the groups just read, else what an earlier
       run recorded for the same group (the approval transaction reads only
       the target group) */
    const known = holder && groups && groups.get(holder);
    m.currentGroupMaster = known ? known.masterModelName : (holder && m.currentGroupId === holder ? m.currentGroupMaster || null : null);
    m.currentGroupId = holder;
    if (setAside(m)) { m.state = 'excluded'; return; }
    if (match.status !== 'matched') { m.state = match.status === 'ambiguous' ? 'needs_review' : 'unmatched'; return; }
    if (!S.memberIsCertain(match)) { m.state = 'needs_review'; return; }
    /* a second reader said this entry was misread, or is not in the image:
       it waits for a person, whatever group it would otherwise fall in */
    if (m.disputed) { m.state = 'needs_review'; return; }
    if (target.groupId && gs.indexOf(target.groupId) > -1) {
      /* in the target — and, in data that already breaks the rule, elsewhere too */
      m.state = gs.length > 1 ? 'conflict' : 'existing';
      return;
    }
    m.state = gs.length ? 'conflict' : 'add';
  });

  /* ---- the other groups the list reaches into ---- */
  const otherGroups = ranked.filter(r => r[0] !== target.groupId).map(([groupId]) => {
    const g = (groups && groups.get(groupId)) || { groupId };
    const inList = certain.filter(m => groupsOf(m.match.modelId).indexOf(groupId) > -1);
    const size = Number(g.memberCount) || 0;
    return {
      groupId, groupNo: g.groupNo || groupId.toUpperCase(), partCode: g.partCode || null,
      masterModelId: g.masterModelId || null, masterModelName: g.masterModelName || null,
      memberCount: size, overlap: inList.length,
      coverage: size ? Math.round(inList.length / size * 100) / 100 : null,
      modelNames: inList.map(m => m.match.modelName).slice(0, 40)
    };
  });

  const count = st => members.filter(m => m.state === st).length;
  const counts = {
    extracted: members.length, matched: certain.length,
    existing: count('existing'), add: count('add'), conflict: count('conflict'),
    needsReview: count('needs_review'), unmatched: count('unmatched'), excluded: count('excluded'),
    /* entries whose group is merged into the target (decided automatically) */
    merge: members.filter(m => m.state === 'conflict' && m.decision === 'merge').length,
    reassignRequested: members.filter(m => m.state === 'conflict' && m.decision === 'reassign_request').length
  };
  const unresolved = members.filter(m => m.state === 'conflict' && !m.decision);

  /* ---- the master ---- */
  let proposedMaster = null;
  let masterReviewRequired = false;
  if (target.mode === 'existing') {
    proposedMaster = targetGroup && targetGroup.masterModelId
      ? { modelId: targetGroup.masterModelId, modelName: targetGroup.masterModelName, reason: 'the existing group keeps its master model' }
      : null;
  } else if (target.mode === 'new') {
    const addable = members.filter(m => m.state === 'add');
    const chosen = masterOverride && addable.find(m => m.match.modelId === masterOverride);
    const named = headline && S.memberIsCertain(headline.match) && addable.find(m => m.match.modelId === headline.match.modelId);
    if (chosen) proposedMaster = { modelId: chosen.match.modelId, modelName: chosen.match.modelName, reason: masterReason || 'chosen by an admin' };
    else if (named) proposedMaster = { modelId: named.match.modelId, modelName: named.match.modelName, reason: 'the product the post names' };
    else masterReviewRequired = true;
  }

  /* ---- the proposed action ---- */
  let action;
  if (!categoryId) {
    action = 'PRODUCT_CATEGORY_REVIEW';
    reasons.push('The product is not named, or is not one of the catalogue\'s categories. Choose the category to compare the list with existing groups.');
  } else if (!imported) {
    action = 'CONFLICT_REVIEW';
    reasons.push('The production catalogue is not in Firestore, so the list cannot be compared with existing groups. Nothing can be approved until it is imported.');
  } else if (certain.length < 2) {
    action = 'MODEL_REVIEW';
    reasons.push(`Only ${certain.length} of ${members.length} listed models resolved to a catalogue record with certainty.`);
  } else if (target.mode === 'undecided') {
    action = 'CONFLICT_REVIEW';
    reasons.push(target.reason + '. Choose the group this list describes.');
  } else if (unresolved.length) {
    const absorbs = otherGroups.filter(g => g.overlap >= 2 && g.coverage != null && g.coverage >= 0.5);
    action = absorbs.length ? 'MERGE_REQUIRED' : 'CONFLICT_REVIEW';
    reasons.push(`${unresolved.length} listed model(s) already belong to another group in this category. A model may be in only one group per category, so none of them is added.`);
    if (absorbs.length) {
      reasons.push('The list covers most of ' + absorbs.map(g => g.groupNo).join(', ') +
        ' — the post treats ' + (absorbs.length > 1 ? 'them' : 'it') + ' as the same part as the target group. A scan with Instagram Intelligence merges them; by hand, merge them in Compatibility Management.');
    }
  } else if (target.mode === 'new') {
    if (counts.add < 2) {
      action = 'MODEL_REVIEW';
      reasons.push('A new group needs at least two models resolved with certainty.');
    } else {
      action = 'CREATE_NEW_GROUP';
      reasons.push(`None of the ${counts.add} resolved models has a group in this category.`);
      if (masterReviewRequired) reasons.push('MASTER MODEL REVIEW REQUIRED: the post does not name one product model, so the master is not chosen for you.');
    }
  } else if (counts.add > 0 || counts.merge > 0) {
    action = 'UPDATE_EXISTING_GROUP';
    reasons.push(`${counts.add} model(s) can be added to ${targetGroup ? targetGroup.groupNo : target.groupId}; ${counts.existing} are already in it.`);
    if (counts.merge) reasons.push(`${counts.merge} listed model(s) are in a group this list shows to be the same part; that group is merged into this one.`);
  } else if (counts.needsReview + counts.unmatched > 0) {
    action = 'MODEL_REVIEW';
    reasons.push('Every model that resolved is already in the group. The remaining entries need a person to pick the catalogue record, or to exclude them.');
  } else {
    action = 'NO_CHANGE';
    reasons.push('The existing group already holds every listed model. Kept as supporting evidence.');
  }

  const conflictActive = !!categoryId && (unresolved.length > 0 || target.mode === 'undecided' || !imported);
  const relKey = S.setKeyFor(categoryId, target.groupId, certain.map(m => m.match.modelId));

  return {
    target: Object.assign({}, target, targetGroup ? {
      groupNo: targetGroup.groupNo, partCode: targetGroup.partCode,
      masterModelId: targetGroup.masterModelId, masterModelName: targetGroup.masterModelName,
      memberCount: targetGroup.memberCount,
      memberIds: targetGroup.memberIds ? targetGroup.memberIds.slice(0, 400) : null,
      memberNames: targetGroup.memberNames ? targetGroup.memberNames.slice(0, 400) : null
    } : {}),
    otherGroups: otherGroups.slice(0, 40),
    counts, proposedAction: action, actionReasons: reasons,
    proposedMaster, masterReviewRequired,
    duplicateCheck: counts.conflict ? 'BLOCKED' : 'PASSED',
    conflict: conflictActive ? {
      active: true, type: !imported ? 'production_unknown' : 'category', withCandidateIds: [],
      note: !imported ? reasons[0]
        : target.mode === 'undecided' ? 'CATEGORY CONFLICT — ' + target.reason + '.'
        : `CATEGORY CONFLICT — ${unresolved.length} model(s) BLOCKED: already assigned to another group in this category.`
    } : null,
    productionState: { state: !imported ? 'unknown' : target.mode, source: 'firestore', groupId: target.groupId || null },
    relKey
  };
}

/* ============================================================ automatic

   WHAT INSTAGRAM INTELLIGENCE DECIDES WHERE A PERSON USED TO

   Three decisions, each deterministic and each explained in words on the
   record it leaves:

     which group, when two tie         the one more of the list is in; then the
                                       larger; then the lower number
     what happens to a listed model    its group is MERGED into the target when
     that is in another group          the list holds at least half of that
                                       group and at least two of its models (or
                                       the group is a single model); otherwise
                                       the model is LEFT WHERE IT IS — one
                                       shared model does not make two groups one
     the master of a new group         the product the post names; else the
                                       base model the other names extend
                                       ("Realme 5" for 5s, 5i); else the
                                       shortest catalogue name — never "the
                                       first one printed"

   An entry that did not resolve to one catalogue record with certainty is
   never applied: it is reported, and the rest of the list goes ahead. */

const MERGE_MIN_COVERAGE = 0.5;
const MERGE_MIN_OVERLAP = 2;

/** May this other group be merged into the target on the strength of one list? */
function absorbs(g) {
  if (!g || g.coverage == null || !g.memberCount) return false;
  return g.coverage >= MERGE_MIN_COVERAGE && (g.overlap >= MERGE_MIN_OVERLAP || g.memberCount === 1);
}

/**
 * The master of a new group nobody named.
 * @param {object[]} addable   entries in state "add", each with a certain match
 * @returns {{modelId:string, modelName:string, reason:string}|null}
 */
function chooseMaster(addable) {
  const rows = (addable || []).filter(m => m.match && m.match.modelId && m.match.modelName).map(m => {
    const name = String(m.match.modelName).toLowerCase();
    return { modelId: m.match.modelId, modelName: m.match.modelName, name };
  });
  if (!rows.length) return null;
  rows.forEach(r => {
    /* "realme 5" is the base of "realme 5s" and "realme 5 pro", not of "realme 50" */
    r.extends = rows.filter(o => o !== r && o.name.length > r.name.length && o.name.indexOf(r.name) === 0 &&
      !/^[0-9]/.test(o.name.slice(r.name.length))).length;
  });
  rows.sort((a, b) => b.extends - a.extends || a.name.length - b.name.length || a.name.localeCompare(b.name));
  const best = rows[0];
  return {
    modelId: best.modelId, modelName: best.modelName,
    reason: best.extends
      ? `chosen automatically: the base model ${best.extends} other name(s) in the list extend`
      : 'chosen automatically: the shortest catalogue name in the list (the post names no single product model)'
  };
}

/**
 * Decides what a person used to. Pure; MUTATES `members` (decision,
 * decidedBy, skipReason) and returns the overrides to plan again with.
 *
 * @param {object} args
 * @param {object[]} args.members
 * @param {object} args.planned      plan() over the same members, with every touched group in `groups`
 * @param {number} args.now
 * @returns {{targetOverride:string|null, targetReason:string|null, masterOverride:string|null, masterReason:string|null,
 *            merges:object[], skipped:object[], changed:boolean}}
 */
function autoResolve({ members, planned, now }) {
  const by = S.SYSTEM_ACTOR.uid;
  const out = { targetOverride: null, targetReason: null, masterOverride: null, masterReason: null, merges: [], skipped: [], changed: false };

  /* two groups tie: choose one, and let the caller plan again against it */
  if (planned.target.mode === 'undecided') {
    const tied = (planned.otherGroups || []).slice().sort((a, b) =>
      b.overlap - a.overlap || (b.memberCount || 0) - (a.memberCount || 0) || String(a.groupId).localeCompare(String(b.groupId)));
    if (tied.length) {
      out.targetOverride = tied[0].groupId;
      out.targetReason = `chosen automatically: ${tied[0].overlap} of the listed models are in ${tied[0].groupNo}, the largest of the groups the list ties between`;
      out.changed = true;
    }
    return out;
  }

  const absorbable = new Map((planned.otherGroups || []).filter(absorbs).map(g => [g.groupId, g]));
  members.forEach(m => {
    if (m.state !== 'conflict' || m.decision) return;
    const others = (m.currentGroupIds || []).filter(g => g !== planned.target.groupId);
    const inTarget = planned.target.groupId && (m.currentGroupIds || []).indexOf(planned.target.groupId) > -1;
    const mergeable = !inTarget && planned.target.mode === 'existing' && others.length === 1 && absorbable.has(others[0]);
    m.decision = mergeable ? 'merge' : 'skip';
    m.decidedBy = by;
    m.decidedAt = now;
    if (!mergeable) {
      m.skipReason = inTarget
        ? 'already in the target group and in another one — the existing data breaks the one-group rule; left as it is'
        : `already in ${others.join(', ') || 'another group'}${m.currentGroupMaster ? ' (master ' + m.currentGroupMaster + ')' : ''}; this list holds too little of that group to merge it, so the model stays where it is`;
    }
    out.changed = true;
  });
  absorbable.forEach(g => {
    if (members.some(m => m.decision === 'merge' && (m.currentGroupIds || []).indexOf(g.groupId) > -1)) out.merges.push(g);
  });

  if (planned.target.mode === 'new' && planned.masterReviewRequired) {
    const master = chooseMaster(members.filter(m => m.state === 'add'));
    if (master) { out.masterOverride = master.modelId; out.masterReason = master.reason; out.changed = true; }
  }

  members.forEach(m => {
    if (m.decision === 'skip') out.skipped.push({ key: m.key, text: m.text, reason: m.skipReason });
    else if (m.state === 'unmatched') out.skipped.push({ key: m.key, text: m.text, reason: 'no catalogue record matches it — never created from a post' });
    else if (m.state === 'needs_review') out.skipped.push({ key: m.key, text: m.text,
      reason: m.disputed ? 'a second reader disputed this entry'
        : m.match && m.match.requiresVariantConfirmation ? (m.match.variantNote || 'the variant printed (4G / 5G / year) is not in the catalogue record\'s name')
        : 'it fits more than one catalogue record' });
  });
  return out;
}

/* ============================================================== documents */

function bestEvidence(evidences) {
  const order = { strong: 3, good: 2, weak: 1, none: 0 };
  return (evidences || []).slice().sort((a, b) => order[S.evidenceStrength(b)] - order[S.evidenceStrength(a)])[0] ||
    { source: 'caption', ref: null, confidence: null };
}

function slimMember(m) {
  return {
    key: m.key, text: m.text, texts: (m.texts || [m.text]).slice(0, 6),
    match: slimMatch(m.match), matchStatus: m.matchStatus || S.matchStatusFor(m.match),
    evidence: (m.evidence || []).slice(0, 6).map(e => ({
      source: e.source, ref: e.ref || null, line: e.line ? String(e.line).slice(0, 200) : null,
      confidence: e.confidence == null ? null : e.confidence
    })),
    occurrences: (m.evidence || []).length,
    state: m.state, currentGroupId: m.currentGroupId || null, currentGroupIds: m.currentGroupIds || [],
    currentGroupMaster: m.currentGroupMaster || null,
    decision: m.decision || null, decidedBy: m.decidedBy || null, decidedAt: m.decidedAt || null,
    skipReason: m.skipReason ? String(m.skipReason).slice(0, 300) : null,
    addedBy: m.addedBy || null,
    /* a second reader's view: a record it suggests, or a reading it disputes */
    disputed: !!m.disputed,
    suggestion: m.suggestion ? {
      modelId: m.suggestion.modelId || null, modelName: m.suggestion.modelName || null, by: m.suggestion.by || 'validator',
      printedText: m.suggestion.printedText || null, note: m.suggestion.note ? String(m.suggestion.note).slice(0, 200) : null
    } : null
  };
}

/**
 * A consolidated list -> the review-queue document for it.
 *
 * @param {object} args
 * @param {object} args.set        from consolidateSets()
 * @param {object} args.planned    from plan(), run over set.members
 * @param {Array}  args.segments   the source texts
 * @param {object} args.ctx        { job, content, extractionId, version, now }
 */
function buildProposal({ set, planned, segments, ctx }) {
  const category = set.category || {};
  const categoryId = category.categoryId && taxonomy.isKnownCategory(category.categoryId) ? category.categoryId : null;
  const evidence = bestEvidence(set.evidences);
  const refs = Array.from(new Set(set.evidences.map(e => e.ref || e.source)));
  const readByAi = set.evidences.every(e => e.source === 'vision');
  const confidence = S.evaluateSetConfidence({
    category: categoryId ? { categoryId, strength: category.strength } : null,
    explicit: true, evidence, matched: planned.counts.matched, total: planned.counts.extracted - planned.counts.excluded,
    supportingRefs: refs.length, readByAi
  });

  const members = set.members.map(slimMember);
  const candidateId = S.proposalIdFor(ctx.extractionId, set.members.map(m => m.text));
  const text = seg => seg.map(s => s.text).join('\n').slice(0, 2000) || null;
  const refSet = new Set(set.evidences.map(e => e.ref).filter(Boolean).map(r => String(r).split('@')[0]));

  const doc = {
    candidateId, kind: 'group_proposal',
    jobId: ctx.job.jobId, sourceKey: ctx.job.sourceKey, sourceUsername: ctx.job.username || null,
    contentKey: ctx.content.contentKey, extractionId: ctx.extractionId, contentVersion: ctx.version,
    sourcePost: {
      permalink: ctx.content.permalink || null, mediaId: ctx.content.mediaId || null,
      contentType: ctx.content.contentType || null, publishedAt: ctx.content.publishedAt || null,
      collectionMethod: ctx.content.collectionMethod || null
    },
    processingVersion: S.PROCESSING_VERSION, extractedAt: ctx.now,

    categoryId, categoryText: category.term || null,
    categoryMethod: categoryId ? category.method || null : null,
    categoryStrength: categoryId ? category.strength || null : 'none',
    unmappedCategoryText: categoryId ? null : (category.unmappedTerm || category.term || null),
    productName: set.headline ? String(set.headline.line || set.headline.text).slice(0, 160) : null,
    brandId: (set.headline && set.headline.match && set.headline.match.brandId) ||
      (members.find(m => m.match && m.match.brandId) || { match: {} }).match.brandId || null,
    headline: set.headline ? {
      text: set.headline.text, line: set.headline.line ? String(set.headline.line).slice(0, 200) : null,
      match: slimMatch(set.headline.match), matchStatus: S.matchStatusFor(set.headline.match),
      fromElsewhere: !!set.headline.fromElsewhere,
      evidence: set.headline.evidence || null
    } : null,

    members, truncated: !!set.truncated,
    sourceModels: set.members.map(m => m.text).slice(0, MAX_MEMBERS),

    target: planned.target, otherGroups: planned.otherGroups, counts: planned.counts,
    proposedAction: planned.proposedAction, actionReasons: planned.actionReasons,
    proposedMaster: planned.proposedMaster, masterReviewRequired: planned.masterReviewRequired,
    duplicateCheck: planned.duplicateCheck, conflict: planned.conflict, productionState: planned.productionState,
    targetOverride: null, masterOverride: null,
    relKey: planned.relKey,

    sourceMedia: refs.filter(r => ['caption', 'manual'].indexOf(r) < 0).slice(0, 20),
    evidence: { source: evidence.source, ref: evidence.ref || null, confidence: evidence.confidence == null ? null : evidence.confidence },
    evidenceLines: set.evidenceLines.slice(0, 12).map(l => String(l).slice(0, 300)),
    extractedText: set.evidenceLines.join('\n').slice(0, 2000),
    captionText: text(segments.filter(s => s.source === 'caption' || s.source === 'manual')),
    ocrText: text(segments.filter(s => ['ocr', 'frame', 'vision'].indexOf(s.source) > -1 &&
      (!refSet.size || refSet.has(String(s.ref || '').split('@')[0])))),
    transcriptText: text(segments.filter(s => s.source === 'transcript')),
    compatibilityType: 'explicit', polarity: 'positive',
    confidence, extractedBy: readByAi ? 'ai' : 'rules',

    status: 'pending', duplicateOf: null, duplicateReason: null,
    reviewer: null, reviewedAt: null, approvedBy: null, approvedAt: null,
    rejectReason: null, rejectNote: null, corroborations: 0,
    createdAt: ctx.now, updatedAt: ctx.now,
    history: [{ at: ctx.now, by: 'system', action: 'created',
                note: `list of ${members.length} models -> ${planned.proposedAction.replace(/_/g, ' ').toLowerCase()}` }]
  };

  if (planned.proposedAction === 'NO_CHANGE') {
    doc.status = 'duplicate';
    doc.duplicateReason = 'already_existing';
    doc.reviewer = 'system';
    doc.history.push({ at: ctx.now, by: 'system', action: 'duplicate',
      note: 'Already Existing: the group already holds every listed model. This source is kept as additional evidence.' });
  }
  doc.reviewSection = S.reviewSectionFor(doc);
  return doc;
}

/**
 * Re-reads production and recomputes a stored proposal. Called after every
 * admin edit, so the card always shows what approving would do NOW.
 *
 * @param {object} p      the stored proposal (members may have been edited)
 * @param {Map} [cache]
 * @returns {Promise<object>} the fields to write back
 */
async function refresh(p, cache = new Map()) {
  const members = (p.members || []).map(m => Object.assign({}, m));
  const ids = members.map(m => m.match && m.match.modelId).filter(Boolean);
  if (p.headline && p.headline.match && p.headline.match.modelId) ids.push(p.headline.match.modelId);
  const { imported, membership } = await readMembership(p.categoryId, ids, cache);

  const touched = new Set();
  membership.forEach(list => list.forEach(g => touched.add(g)));
  if (p.targetOverride && p.targetOverride !== 'new') touched.add(p.targetOverride);
  const first = plan({ categoryId: p.categoryId, headline: p.headline, members, imported, membership, groups: new Map(),
                       targetOverride: p.targetOverride, masterOverride: p.masterOverride,
                         masterReason: p.masterReason || null, targetReason: p.targetReason || null });
  const groups = await readGroups(Array.from(touched), first.target.groupId, cache);
  const planned = plan({ categoryId: p.categoryId, headline: p.headline, members, imported, membership, groups,
                         targetOverride: p.targetOverride, masterOverride: p.masterOverride,
                         masterReason: p.masterReason || null, targetReason: p.targetReason || null });

  const confidence = S.evaluateSetConfidence({
    category: p.categoryId ? { categoryId: p.categoryId, strength: p.categoryStrength || 'good' } : null,
    /* an entry a person set aside is no longer part of what is being judged */
    explicit: true, evidence: p.evidence, matched: planned.counts.matched, total: planned.counts.extracted - planned.counts.excluded,
    supportingRefs: (p.sourceMedia || []).length || 1, readByAi: p.extractedBy === 'ai',
    validation: p.validation ? p.validation.status : null
  });
  const next = Object.assign({}, p, planned, { members, confidence });
  return {
    members: members.map(slimMember),
    target: planned.target, otherGroups: planned.otherGroups, counts: planned.counts,
    proposedAction: planned.proposedAction, actionReasons: planned.actionReasons,
    proposedMaster: planned.proposedMaster, masterReviewRequired: planned.masterReviewRequired,
    duplicateCheck: planned.duplicateCheck, conflict: planned.conflict, productionState: planned.productionState,
    relKey: planned.relKey, confidence,
    reviewSection: S.reviewSectionFor(next)
  };
}

/**
 * Every list of a post, planned against production.
 * @returns {Promise<{proposals:object[], covered:Set<string>}>}
 *          `covered` is the lower-cased text of every model inside a proposal,
 *          so the same statement is not ALSO queued as pairs.
 */
async function buildAll({ det, resolve, segments, ctx, cache }) {
  const sets = consolidateSets(det, resolve).filter(s => s.members.length >= MIN_SET_MEMBERS);
  const proposals = [];
  const covered = new Set();
  for (const set of sets) {
    const category = set.category || {};
    const categoryId = category.categoryId && taxonomy.isKnownCategory(category.categoryId) ? category.categoryId : null;
    const ids = set.members.map(m => m.match && m.match.modelId).filter(Boolean);
    if (set.headline && set.headline.match && set.headline.match.modelId) ids.push(set.headline.match.modelId);
    const { imported, membership } = await readMembership(categoryId, ids, cache);
    const touched = new Set();
    membership.forEach(list => list.forEach(g => touched.add(g)));
    const first = plan({ categoryId, headline: set.headline, members: set.members, imported, membership, groups: new Map() });
    const groups = await readGroups(Array.from(touched), first.target.groupId, cache);
    const planned = plan({ categoryId, headline: set.headline, members: set.members, imported, membership, groups });
    proposals.push(buildProposal({ set, planned, segments, ctx }));
    set.members.forEach(m => (m.texts || [m.text]).forEach(t => covered.add(String(t).toLowerCase())));
    if (set.headline) covered.add(String(set.headline.text).toLowerCase());
  }
  return { proposals, covered };
}

module.exports = {
  MIN_SET_MEMBERS, consolidateSets, readMembership, readGroups, summariseGroup, groupsIn,
  plan, buildProposal, buildAll, refresh, slimMember,
  autoResolve, chooseMaster, absorbs, MERGE_MIN_COVERAGE, MERGE_MIN_OVERLAP
};
