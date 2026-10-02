/* ============================================================================
   Mobile Parts Finder · scripts/export-approved-compatibilities.js
   ----------------------------------------------------------------------------
   Pulls the approved-compatibility ledger out of Firestore so the catalogue
   BUILD knows about it.

   WHY THIS EXISTS. Approving an Instagram claim can add a model to an
   existing group in production (groupDetails / modelGroups). Those documents
   are otherwise written only by scripts/import-firestore.js, from the build —
   so without this step, the next import would quietly put the group back the
   way the build had it and the approval would be lost.

     node scripts/export-approved-compatibilities.js --project mobilepartsfindercom
       -> data/raw/approved-compatibilities.json   (git-ignored: data/raw/)

   Then build as usual; scripts/build-dataset.js folds every `applied` entry
   back into its group (additive only, and only when the group still holds
   the model the approval was anchored on):

     node scripts/build-dataset.js && node scripts/build-runtime-bundle.js

   `approved_pending_build` entries are printed as a worklist: they need a NEW
   group (a part code and serial the build issues), which is a catalogue
   decision — add them to the category export by hand if you agree.

   Credentials: the same as import-firestore.js (application-default
   credentials or GOOGLE_APPLICATION_CREDENTIALS). Read-only.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf('--' + name); return i > -1 ? argv[i + 1] : def; };
const PROJECT = flag('project');
const OUT = flag('out', path.join(__dirname, '..', 'data', 'raw', 'approved-compatibilities.json'));

if (!PROJECT) {
  console.error('\n  --project <firebase-project-id> is required.\n');
  process.exit(1);
}

async function main() {
  const admin = require('firebase-admin');
  admin.initializeApp({ projectId: PROJECT });
  const db = admin.firestore();

  const snap = await db.collection('approvedCompatibilities').get();
  const entries = snap.docs.map(d => d.data()).map(e => ({
    relKey: e.relKey, kind: e.kind || 'same_part', status: e.status, categoryId: e.categoryId,
    sourceModelId: e.sourceModelId, compatibleModelId: e.compatibleModelId,
    /* a NEW GROUP an admin approved from a compatibility list: the master and
       every member, by id and by the catalogue's own name — what to enter in
       Compatibility Management */
    newGroup: e.kind === 'new_group' ? {
      masterModelId: e.masterModelId, masterModelName: e.masterModelName,
      memberIds: e.memberIds || [], memberNames: e.memberNames || []
    } : null,
    /* a group created at run time, with the number it was issued: the build
       carries it under that number and never renumbers it */
    createdGroup: e.kind === 'new_group' && e.createdGroup ? {
      groupId: e.createdGroup.groupId, groupNo: e.createdGroup.groupNo, partCode: e.createdGroup.partCode,
      masterModelId: e.createdGroup.masterModelId, memberIds: e.createdGroup.memberIds || [],
      /* a category created at run time brings its own name and prefix */
      categoryName: e.createdGroup.categoryName || null, categoryCode: e.createdGroup.categoryCode || null
    } : null,
    /* Compatibility Management: a device taken out, a master changed, a group deleted */
    groupId: e.groupId || null, anchorModelId: e.anchorModelId || null,
    removedModelId: e.removedModelId || null, masterModelId: e.kind === 'set_master' ? e.masterModelId : undefined,
    /* two groups a list showed to be one part, each named by the device it
       is anchored on — the build folds the absorbed one into the survivor */
    survivor: e.kind === 'merge_groups' && e.survivor ? { groupId: e.survivor.groupId, anchorModelId: e.survivor.anchorModelId } : null,
    absorbed: e.kind === 'merge_groups' && e.absorbed ? { groupId: e.absorbed.groupId, anchorModelId: e.absorbed.anchorModelId, memberCount: e.absorbed.memberCount || null } : null,
    automatic: !!e.automatic,
    /* a model an admin asked to MOVE between groups: recorded, never done */
    requests: e.kind === 'master_change_request' ? (e.requests || []) : null,
    proposalId: e.proposalId || null,
    appliedChange: e.appliedChange ? {
      groupId: e.appliedChange.groupId, addedModelId: e.appliedChange.addedModelId,
      anchorModelId: e.appliedChange.anchorModelId,
      previousMemberCount: e.appliedChange.previousMemberCount, newMemberCount: e.appliedChange.newMemberCount
    } : null,
    approvedBy: e.approvedBy, approvedAt: e.approvedAt,
    sources: e.sources || [], evidenceCount: (e.evidence || []).length
  }));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ exportedAt: new Date().toISOString(), project: PROJECT, entries }, null, 2));

  const by = s => entries.filter(e => e.status === s);
  console.log('\n  Approved compatibility ledger — ' + PROJECT);
  console.log('  ' + '-'.repeat(52));
  const kinds = k => entries.filter(e => e.kind === k && e.status === 'applied').length;
  console.log('  applied (the build must keep these) :', by('applied').length);
  console.log('    devices removed / masters changed / groups deleted :', kinds('remove_model'), '/', kinds('set_master'), '/', kinds('delete_group'));
  console.log('  undone or cancelled (the build skips) :', by('reverted').length + by('cancelled').length);
  console.log('    groups created at run time        :', entries.filter(e => e.createdGroup).length);
  console.log('  merges the build will fold in       :', entries.filter(e => e.kind === 'merge_groups').length);
  entries.filter(e => e.kind === 'merge_groups').forEach(e => console.log(`    ${e.categoryId}: ${e.absorbed.groupId} into ${e.survivor.groupId}`));
  console.log('  pending a new group (worklist)      :', by('approved_pending_build').length);
  console.log('  already true in production          :', by('pre_existing').length);
  console.log('  written to                          :', path.relative(process.cwd(), OUT));
  by('approved_pending_build').filter(e => e.kind !== 'merge_groups').forEach(e => console.log(e.newGroup
    ? `    ${e.categoryId}: NEW GROUP, master ${e.newGroup.masterModelName} — ${e.newGroup.memberNames.join(', ')}`
    : `    ${e.categoryId}: ${e.sourceModelId} <-> ${e.compatibleModelId}`));
  const moves = by('approved_pending_master');
  console.log('  reassignments requested (master)    :', moves.reduce((n, e) => n + (e.requests || []).length, 0));
  moves.forEach(e => (e.requests || []).forEach(r =>
    console.log(`    ${e.categoryId}: move ${r.modelName} from ${r.fromGroupId} to ${r.toGroupId}`)));
  console.log();
}

main().catch(e => { console.error('\n  export failed:', e.message, '\n'); process.exit(1); });
