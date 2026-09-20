/* ============================================================================
   Mobile Parts Finder · api/_services/entitlement-service.js
   ----------------------------------------------------------------------------
   Reads a user's tier, meters their free searches, and hands out exactly as
   much of a compatibility group as they are allowed to see.

   ----------------------------------------------------------------------------
   THE COUNTER LIVES IN FIRESTORE, KEYED BY UID

   Not in localStorage, not in a cookie, not in a JWT claim. Those are all
   things the person being limited can edit. `users/{uid}` carries two fields:

       freeSearchDay    'YYYY-MM-DD' in India — see _schema/entitlement
       freeSearchCount  how many have been spent on that day

   Both are server-owned and refused to clients by firestore.rules, so a
   browser cannot write itself a fresh allowance. Clearing site data, opening
   an incognito window, signing out and back in, or editing anything the page
   holds changes nothing: the count follows the ACCOUNT.

   THE ROLLOVER IS A COMPARISON, NOT A JOB. There is no nightly task to reset
   anything. `freeSearchDay` is compared to today on every consume, and a
   stored day that is not today means the count starts again at zero. A user
   who does not search for a month has their allowance waiting, and nothing had
   to run in the meantime.

   ----------------------------------------------------------------------------
   THE MEMBER LIST IS SLICED BEFORE IT IS SERIALISED

   `groupForUser` returns the members a tier may see and NOT the rest. The
   withheld names never enter the response, so they cannot be read out of the
   network tab, recovered from a JavaScript variable, or revealed by editing
   the DOM. `lockedCount` is a number, which is what lets the UI say "25 more"
   without knowing which 25.

   That is the difference between this and hiding rows with CSS, and it is the
   whole reason the paid half of the catalogue moved out of the public bundle.
   ========================================================================== */
'use strict';

const { db, admin } = require('../_lib/firebase');
const { USERS, GROUP_DETAILS, DEVICE_GROUPS, MODEL_GROUPS } = require('../_schema/collections');
const {
  TIERS, FREE_DAILY_SEARCHES, dayKeyFor, resetsAt,
  tierFor, visibleMemberLimit, describe
} = require('../_schema/entitlement');
const search = require('./search-service');

const FieldValue = admin.firestore.FieldValue;

/**
 * The tier and the current search state for one account.
 *
 * @param {string|null} uid   null for a signed-out visitor
 * @param {number} now
 * @returns {Promise<object>} the shape described by entitlement.describe()
 */
async function readAccess(uid, now) {
  if (!uid) {
    /* Signed out. Free caps apply, and the header search is refused outright
       rather than metered — there is no account to count against, and
       metering by device would be a limit that clearing cookies resets. */
    return Object.assign(describe(TIERS.FREE, FREE_DAILY_SEARCHES, now), {
      signedIn: false,
      dailySearchesRemaining: 0,
      reason: 'sign-in required to search'
    });
  }

  const snap = await db().collection(USERS).doc(uid).get();
  const profile = snap.exists ? snap.data() : null;
  const tier = tierFor(profile, now);

  const today = dayKeyFor(now);
  const storedDay = profile && profile.freeSearchDay;
  /* A stored day that is not today has already expired — report zero used
     rather than the stale number, so the UI shows a full allowance before the
     first search of the day rewrites the field. */
  const used = storedDay === today ? Number(profile.freeSearchCount) || 0 : 0;

  return Object.assign(describe(tier, used, now), { signedIn: true });
}

/**
 * Spends one free search, or reports that there are none left.
 *
 * Runs in a transaction because the read and the write must not be separable:
 * two tabs pressing enter together would otherwise both read "2 used" and both
 * write "3", spending one credit twice.
 *
 * A PAID account is not metered at all — no read-modify-write, no document
 * touched. Metering a subscriber costs a write per search for a number nobody
 * will ever look at.
 *
 * @returns {Promise<{allowed:boolean, access:object}>}
 */
async function consumeSearch(uid, now) {
  const ref = db().collection(USERS).doc(uid);

  const result = await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    const profile = snap.exists ? snap.data() : null;
    const tier = tierFor(profile, now);

    if (tier === TIERS.PAID) return { allowed: true, tier, used: null };

    const today = dayKeyFor(now);
    const storedDay = profile && profile.freeSearchDay;
    const used = storedDay === today ? Number(profile.freeSearchCount) || 0 : 0;

    if (used >= FREE_DAILY_SEARCHES) {
      /* Refused, and nothing is written. A blocked attempt must not extend the
         window or inflate a counter the user cannot see. */
      return { allowed: false, tier, used };
    }

    tx.set(ref, {
      freeSearchDay: today,
      /* Written as a plain number rather than an increment: when the stored
         day is stale this has to RESET to 1, and increment() cannot express
         "start again". The transaction makes the read-then-write safe. */
      freeSearchCount: used + 1,
      freeSearchAt: now
    }, { merge: true });

    return { allowed: true, tier, used: used + 1 };
  });

  const access = Object.assign(
    describe(result.tier, result.used == null ? 0 : result.used, now),
    { signedIn: true }
  );
  return { allowed: result.allowed, access };
}

/* ------------------------------------------------------------ group access */

/* ---------------------------------------------------- where members come from

   Firestore `groupDetails`, read through the Admin SDK.

   NOT from api/_data/parts.json. That file is git-ignored on purpose — this
   repository is public and the file is the fitment list the subscription sells
   — so it is never in a deployed function, and requiring it in production was
   a MODULE_NOT_FOUND that turned every group sheet into a 500.

   groupDetails is the right source anyway: the importer already writes it, the
   importer's own comment says it is "kept for /api/device-parts", and it is
   closed to every client in firestore.rules. One source, already in
   production, already protected.

   Cached per warm instance. A group's member list does not change between
   deployments, so re-reading it for every sheet open would be a Firestore read
   per click for a constant. */
const memberCache = new Map();
const MEMBER_CACHE_MAX = 500;

async function readGroupDetail(groupId) {
  if (memberCache.has(groupId)) return memberCache.get(groupId);

  /* The local file first when it exists — a local run then needs no service
     account to open a group sheet. Absent in production, which is the point. */
  const local = search.groupDetail(groupId);
  if (local && local.members && local.members.length) {
    cacheMember(groupId, local);
    return local;
  }

  const snap = await db().collection(GROUP_DETAILS).doc(groupId).get();
  if (!snap.exists) { cacheMember(groupId, null); return null; }

  const d = snap.data() || {};
  const ids = Array.isArray(d.memberIds) ? d.memberIds : [];
  const names = Array.isArray(d.memberNames) ? d.memberNames : [];

  const detail = {
    groupId,
    partCode: d.partCode || null,
    oemPartNo: d.oemPartNo || null,
    masterModelName: d.drawingName || null,
    memberCount: Number(d.memberCount) || ids.length,
    members: ids.map((id, i) => ({ id, name: names[i] || id }))
  };
  cacheMember(groupId, detail);
  return detail;
}

function cacheMember(groupId, value) {
  /* A crude cap rather than an LRU. There are 3,340 groups and a warm instance
     sees a handful; this only exists so a scripted walk of every group cannot
     grow the heap without limit. */
  if (memberCache.size >= MEMBER_CACHE_MAX) memberCache.clear();
  memberCache.set(groupId, value);
}

/**
 * One compatibility group, cut to what this tier may see.
 *
 * @param {string} groupId
 * @param {'free'|'paid'} tier
 * @returns {Promise<object|null>} null when there is no such group
 */
async function groupForUser(groupId, tier) {
  const group = await readGroupDetail(groupId);
  if (!group) return null;

  const total = group.memberCount;
  const limit = visibleMemberLimit(total, tier);
  const visible = limit === Infinity ? group.members : group.members.slice(0, limit);

  return {
    groupId: group.groupId,
    /* NOT tier-gated. The free tier already advertises "Part code, serial
       number and group number" on the account page, and the paid answer is
       WHICH DEVICES a part fits — not what the part is called. Withdrawing an
       advertised free feature while adding a paywall would be a different
       change from the one that was asked for. */
    partCode: group.partCode,
    oemPartNo: group.oemPartNo,
    masterModelName: group.masterModelName,
    memberCount: total,
    /* Empty for a free caller. visibleMemberLimit returns 0 for `free`, so
       this is `[]` and the names are never serialised — there is no truncated
       list in the payload, nothing in the network tab, and nothing in a
       JavaScript variable for a console to widen. */
    members: visible,
    /* A number, not a list. The withheld names are not in this object at all,
       so there is nothing in the response to recover them from. */
    lockedCount: Math.max(0, total - visible.length),
    locked: visible.length < total,
    /* The flag the browser draws the paywall from. Explicit rather than
       inferred from `members.length === 0`, which is also true of a group that
       genuinely has no members recorded — two very different sentences to put
       in front of a shop. */
    requiresPlan: tier !== TIERS.PAID,
    tier
  };
}

/**
 * The device -> {categoryId: [groupId]} map for one device, from whichever
 * collection holds it. Returns null when the device is in neither.
 */
async function readDeviceGroupDoc(modelId) {
  const firestore = db();

  const mg = await firestore.collection(MODEL_GROUPS).doc(modelId).get();
  if (mg.exists) {
    const d = mg.data() || {};
    /* The importer's shape. `byCategory` is the map; `id` is the device. */
    if (d.byCategory && typeof d.byCategory === 'object') return d.byCategory;
    /* A document written flat by some other route still works. */
    const flat = { ...d };
    delete flat.id;
    if (Object.keys(flat).length) return flat;
  }

  const dg = await firestore.collection(DEVICE_GROUPS).doc(modelId).get();
  if (dg.exists) {
    const d = dg.data() || {};
    return d.byCategory && typeof d.byCategory === 'object' ? d.byCategory : d;
  }
  return null;
}

/**
 * Every group that fits a device, each cut to the tier's allowance.
 * Used by the device page, which shows one group per part category.
 */
async function deviceGroupsForUser(modelId, tier) {
  /* Which groups fit this device, per category. The local file when it is
     there, Firestore otherwise — same reason as readGroupDetail above. */
  let byCategory = null;

  const local = search.compatibilityFor(modelId);
  if (local && local.categories.length) {
    byCategory = local.categories.map(c => ({
      categoryId: c.categoryId,
      categoryName: c.categoryName,
      groupIds: c.groups.map(g => g.groupId)
    }));
  } else {
    /* WHICH COLLECTION, AND WHY BOTH.

       scripts/import-firestore.js writes this map to `modelGroups`, as
       documents shaped { id, byCategory: { <categoryId>: [groupId, …] } }.
       This function read `deviceGroups` and treated the document's OWN keys as
       category ids — a collection the importer has never written and a shape
       it has never produced. Every ?modelId= request therefore answered
       404 "no such model", for every device in the catalogue.

       It went unnoticed because nothing called it: the front end read the
       whole fitment list out of the public bundle instead, which is the hole
       this change closes. Routing the browser through here makes the bug
       load-bearing, so both the real collection and the shape the code
       expected are accepted, newest first. */
    const d = await readDeviceGroupDoc(modelId);
    if (!d) return null;
    byCategory = Object.keys(d).map(categoryId => ({
      categoryId,
      categoryName: categoryId,
      groupIds: Array.isArray(d[categoryId]) ? d[categoryId] : []
    }));
  }

  const categories = await Promise.all(byCategory.map(async cat => ({
    categoryId: cat.categoryId,
    categoryName: cat.categoryName,
    groups: (await Promise.all(cat.groupIds.map(id => groupForUser(id, tier))))
      .filter(Boolean)
  })));

  return { modelId, categories, tier };
}

module.exports = { readAccess, consumeSearch, groupForUser, deviceGroupsForUser };
