/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/auto-apply.js
   ----------------------------------------------------------------------------
   INSTAGRAM INTELLIGENCE

   A compatibility list that passes every check is applied to the
   compatibility data as soon as it is read — nobody approves it card by card.
   This file is the one place that decides whether a list passes, and it
   applies it through the SAME transaction a person's approval runs
   (review-service.approveProposal). There is no second write path: the
   one-group-per-category rule, the catalogue foreign keys and the ledger are
   enforced there, for a person and for this alike.

   ----------------------------------------------------------------------------
   WHAT IS APPLIED, AND WHEN IT REACHES A SHOP

     a model with no group yet   joins the group the list describes   live, now
     no listed model has a group a new group is created, under a      live, now;
                                 number from the issued range          in the public
                                                                       search after
                                                                       the next build
     the list holds most of      that group is merged into the        live, now
     another group               target; its record is kept, marked
                                 as merged, so an old link still
                                 finds the part
     the product is a part type  the category is created in the        live, now, in
     there is no category for    compatibility data, and the group     the admin panel;
     ("camera glass")            in it                                 on the public
                                                                       site once the
                                                                       category is in
                                                                       the site build
     a listed model is in a      it stays where it is, and the         never
     group the list barely       rest of the list goes ahead
     touches

   Nothing is removed and nothing is deleted here. Removing a model, deleting
   a group and moving one model between two groups stay with a person.

   ----------------------------------------------------------------------------
   WHAT STOPS A LIST — "needs attention", never a guess

     · the product is not a category, and not one of the part types a category
       may be created for
     · the reading is weak: the reader was unsure, the picture was the only
       evidence and it was unclear, or a second reader disputed it
     · fewer than two of its models are catalogue records for certain
     · anything the transaction refuses (the catalogue is not imported, a
       group has no member list, production changed underneath it)

   A stopped list is left exactly as the review queue always held it, with
   the reason on it. An entry that did not resolve is reported and skipped; it
   never stops the entries that did.

   ----------------------------------------------------------------------------
   WHO MAY TURN IT ON

   A job applies automatically only when the administrator who started it
   holds `compat.approve` — the same permission a manual approval needs — and
   INSTAGRAM_AUTO_APPLY is not "off". Both are checked on the server when the
   job is created and stored on it; the browser cannot ask for it.
   ========================================================================== */
'use strict';

const C = require('../../_schema/collections');
const S = require('../../_schema/instagram');
const fsx = require('./firestore');
const review = require('./review-service');
const audit = require('../audit-service');
const categoryService = require('../compat/category-service');

const COUNT_KEYS = ['autoApplied', 'autoGroupsUpdated', 'autoModelsAdded', 'autoGroupsCreated', 'autoGroupsMerged', 'autoMergesQueued',
                    'autoCategoriesCreated', 'autoNoChange', 'autoAttention', 'autoSkippedEntries'];

function zero() { const o = {}; COUNT_KEYS.forEach(k => { o[k] = 0; }); return o; }

/**
 * Why a list is NOT applied automatically. Pure. An empty array means it may
 * go to the transaction — which checks everything again against production.
 *
 * @param {object} p                  a group proposal
 * @param {object} [ctx]
 * @param {string} [ctx.relevance]    how the post was classified
 * @returns {string[]}
 */
function gate(p, { relevance } = {}) {
  const reasons = [];
  if (!p || p.kind !== 'group_proposal' || p.status !== 'pending') return ['not a pending list'];
  if (relevance && ['RELEVANT_COMPATIBILITY', 'PARTIALLY_RELEVANT'].indexOf(relevance) < 0) {
    reasons.push('the post mixes compatibility with repair content, or could not be read in full');
  }
  if (!p.categoryId) {
    reasons.push(p.unmappedCategoryText
      ? `the product ("${p.unmappedCategoryText}") is not one of the site's categories`
      : 'the post does not name a product the site has a category for');
  }
  const band = p.confidence && p.confidence.band;
  /* with no category the band is low BECAUSE there is no category: that reason
     has been given, and repeating it as a weak reading would be noise */
  if (band === 'low' && p.categoryId) {
    const why = ((p.confidence && p.confidence.reasons) || [])
      .filter(r => !/product category could not be mapped|which agreed|^seen in /.test(r)).slice(0, 3);
    reasons.push('the reading is not strong enough to apply without a person' + (why.length ? ': ' + why.join('; ') : ''));
  }
  if ((p.counts && p.counts.matched || 0) < 2) reasons.push('fewer than two of its models are catalogue records for certain');
  if (p.proposedAction === 'PRODUCT_CATEGORY_REVIEW' && p.categoryId) reasons.push((p.actionReasons || [])[0] || 'the product category needs a person');
  return reasons;
}

/**
 * Applies every list of one post that passes, and marks the rest.
 *
 * @param {object[]} proposals   as just written to the review queue
 * @param {object} ctx
 * @param {object} ctx.job
 * @param {string} ctx.relevance
 * @param {() => number} ctx.clock
 * @returns {Promise<{counts:object, results:object[]}>}
 */
async function run(proposals, { job, relevance, clock, createCategories = true }) {
  const counts = zero();
  const results = [];
  const db = fsx.db();
  const actor = Object.assign({}, S.SYSTEM_ACTOR, { system: true, onBehalfOf: job.createdBy || null });

  for (let p of proposals) {
    if (p.kind !== 'group_proposal' || p.status !== 'pending') continue;
    const now = clock();
    const ref = db.collection(C.COMPATIBILITY_CANDIDATES).doc(p.candidateId);

    /* A part type the data has no category for yet: the category is created
       (once — the next post about it finds it), and the list is compared with
       the groups of THAT category before anything else is decided. */
    if (!p.categoryId && p.unmappedCategoryText && createCategories) {
      try {
        const made = await categoryService.ensureForTerm(p.unmappedCategoryText, { admin: actor, now });
        if (made) {
          if (made.created) {
            counts.autoCategoriesCreated++;
            await audit.record({ actorUid: actor.uid, actorRole: 'system', action: audit.ACTIONS.COMPAT_CATEGORY_CREATED,
              targetType: 'compatibility_category', targetId: made.category.id,
              detail: { name: made.category.name, code: made.category.code, from: p.unmappedCategoryText, candidateId: p.candidateId,
                        jobId: job.jobId, onBehalfOf: actor.onBehalfOf || '' }, now });
          }
          await review.proposalChangeCategory({ candidateId: p.candidateId, categoryId: made.category.id, admin: actor, now, method: 'created_category' });
          p = (await ref.get()).data();
        }
      } catch (err) {
        console.warn('[instagram] category not created', err && err.message);
      }
    }
    const stop = async reasons => {
      counts.autoAttention++;
      await ref.set({ autoApply: { status: 'attention', at: now, reasons: reasons.slice(0, 6) }, updatedAt: now }, { merge: true });
      results.push({ candidateId: p.candidateId, outcome: 'attention', reasons });
    };

    const reasons = gate(p, { relevance });
    if (reasons.length) { await stop(reasons); continue; }

    let r;
    try {
      r = await review.approveProposal({ candidateId: p.candidateId, admin: actor, auto: true, now });
    } catch (err) {
      /* the transaction refused: nothing was written, and the reason is kept */
      await stop([String((err && err.message) || 'the change could not be applied').slice(0, 400)]);
      continue;
    }

    counts.autoApplied++;
    counts.autoSkippedEntries += (r.skipped || []).length;
    counts.autoMergesQueued += (r.merges || []).length;
    counts.autoGroupsMerged += (r.merged || []).length;
    if (r.outcome === 'applied') { counts.autoGroupsUpdated++; counts.autoModelsAdded += r.change.addedModelIds.length; }
    else if (r.outcome === 'created') { counts.autoGroupsCreated++; counts.autoModelsAdded += r.created.memberCount; }
    else if (r.outcome === 'already_existing') counts.autoNoChange++;
    results.push({ candidateId: p.candidateId, outcome: r.outcome, note: r.note });

    await audit.record({
      actorUid: actor.uid, actorRole: 'system', action: audit.ACTIONS.COMPAT_AUTO_APPLIED,
      targetType: 'compatibility_group', targetId: (r.change && r.change.groupId) || (r.created && r.created.groupId) || p.candidateId,
      /* short scalars only — the audit log does not take arrays or objects.
         The full before / after is on the proposal and in the ledger. */
      detail: {
        outcome: r.outcome, candidateId: p.candidateId, jobId: job.jobId, sourceKey: p.sourceKey, categoryId: p.categoryId,
        onBehalfOf: actor.onBehalfOf || '',
        added: (r.change ? r.change.addedModelIds : r.created ? r.created.memberIds : []).join(', ').slice(0, 200),
        previousMemberCount: r.change ? r.change.previousMemberCount : 0,
        newMemberCount: r.change ? r.change.newMemberCount : r.created ? r.created.memberCount : 0,
        createdGroup: r.created ? `${r.created.groupNo}, master ${r.created.masterModelName}` : '',
        merges: (r.merged || []).concat(r.merges || []).map(m => `${m.absorbed.groupId} into ${m.survivor.groupId}`).join('; ').slice(0, 200),
        skippedEntries: (r.skipped || []).length
      },
      now
    }).catch(err => console.warn('[instagram] audit not written', err && err.message));
  }
  return { counts, results };
}

module.exports = { gate, run, COUNT_KEYS, zero };
