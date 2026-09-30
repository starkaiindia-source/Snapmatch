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
    relKey: e.relKey, status: e.status, categoryId: e.categoryId,
    sourceModelId: e.sourceModelId, compatibleModelId: e.compatibleModelId,
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
  console.log('  applied (the build must keep these) :', by('applied').length);
  console.log('  pending a new group (worklist)      :', by('approved_pending_build').length);
  console.log('  already true in production          :', by('pre_existing').length);
  console.log('  written to                          :', path.relative(process.cwd(), OUT));
  by('approved_pending_build').forEach(e => console.log(`    ${e.categoryId}: ${e.sourceModelId} <-> ${e.compatibleModelId}`));
  console.log();
}

main().catch(e => { console.error('\n  export failed:', e.message, '\n'); process.exit(1); });
