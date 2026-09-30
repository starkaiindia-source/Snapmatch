/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/production.js
   ----------------------------------------------------------------------------
   What the PRODUCTION compatibility data already says about two models.

   Production fitments are groups: /modelGroups/{modelId}.byCategory[cat] is
   the list of group ids a device belongs to, /groupDetails/{groupId} the
   member list /api/device-parts serves. Two devices "take the same part"
   exactly when they share a group in that category. So a claim meets one of:

     same_group        already true in production        -> "Already Existing"
     one_grouped       one device has a group, the other none in that category
                       -> approval ADDS the other to that group (additive only)
     different_groups  production says they take DIFFERENT parts
                       -> a conflict; the catalogue stays authoritative
     none              neither has a group in that category
                       -> approval is recorded, but a new group needs the
                          catalogue build (it issues part codes and serials)
     unknown           the production catalogue is not in Firestore
                       -> nothing can be compared, and nothing is written

   This file only READS. The write is in review-service.approve(), inside a
   transaction that re-reads everything here.
   ========================================================================== */
'use strict';

const C = require('../../_schema/collections');
const fsx = require('./firestore');

/** Group ids of one device in one category, from a modelGroups document. */
function groupsIn(doc, categoryId) {
  if (!doc) return [];
  const map = doc.byCategory && typeof doc.byCategory === 'object' ? doc.byCategory : doc;
  const list = map[categoryId];
  return Array.isArray(list) ? list.map(String) : [];
}

function classify(groupsA, groupsB) {
  const shared = groupsA.filter(g => groupsB.indexOf(g) > -1);
  if (shared.length) return { state: 'same_group', sharedGroupIds: shared };
  if (groupsA.length && groupsB.length) return { state: 'different_groups', sharedGroupIds: [] };
  if (groupsA.length || groupsB.length) return { state: 'one_grouped', sharedGroupIds: [] };
  return { state: 'none', sharedGroupIds: [] };
}

/**
 * Non-transactional read for the import pre-check. Cached per tick: one
 * catalog/meta read and one modelGroups read per device, however many
 * candidates mention it.
 *
 * @param {{categoryId:string, modelA:string, modelB:string}} q
 * @param {Map} [cache]
 */
async function readState({ categoryId, modelA, modelB }, cache = new Map()) {
  const db = fsx.db();
  const memo = async (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };
  try {
    const imported = await memo('catalog/meta', async () => (await db.collection(C.CATALOG).doc('meta').get()).exists);
    if (!imported) {
      return { state: 'unknown', source: 'firestore', reason: 'the production catalogue is not imported into Firestore', groupsA: [], groupsB: [] };
    }
    const [a, b] = await Promise.all([modelA, modelB].map(id => memo('mg/' + id, async () => {
      const snap = await db.collection(C.MODEL_GROUPS).doc(id).get();
      return snap.exists ? snap.data() : null;
    })));
    const groupsA = groupsIn(a, categoryId);
    const groupsB = groupsIn(b, categoryId);
    return Object.assign({ source: 'firestore', groupsA, groupsB }, classify(groupsA, groupsB));
  } catch (err) {
    return { state: 'unknown', source: 'firestore', reason: 'production data could not be read: ' + (err && (err.code || err.message)), groupsA: [], groupsB: [] };
  }
}

module.exports = { readState, groupsIn, classify };
