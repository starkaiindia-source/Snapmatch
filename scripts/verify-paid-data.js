/* ============================================================================
   Mobile Parts Finder · scripts/verify-paid-data.js
   ----------------------------------------------------------------------------
   Does Firestore actually hold everything /api/device-parts needs?

   WHY THIS EXISTS

   The paid half of the catalogue used to reach the browser through
   assets/dataset.json — a public file — and the server route that was meant
   to gate it was never called by the app, so nothing ever checked whether the
   data behind it was there. It now IS called, for every search and every
   group a subscriber opens, and it reads two Firestore collections:

       groupDetails/{groupId}   memberIds + memberNames  — the fitment list
       modelGroups/{modelId}    byCategory: {cat: [groupId]}

   api/_data/parts.json is git-ignored and therefore absent from a deployed
   function, so in production those two collections are the ONLY source. A
   group missing from groupDetails is a subscriber opening it and being told
   the group does not exist.

   Run this after any import, and after restoring billing on the Google Cloud
   project:

       node scripts/verify-paid-data.js --project mobilepartsfinder

   It reads and writes nothing. Exit code 1 means something is missing.

   Credentials come from the ambient Google application-default credentials,
   the same way scripts/import-firestore.js takes them:

       gcloud auth application-default login
       # or
       set GOOGLE_APPLICATION_CREDENTIALS=C:\\path\\to\\key.json
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf('--' + name); return i > -1 ? argv[i + 1] : def; };

const PROJECT = flag('project');
const SAMPLE = Math.max(1, Number(flag('sample', 300)) || 300);
const BUILD = path.join(__dirname, '..', 'data', 'build');

if (!PROJECT) {
  console.error('\n  --project <firebase-project-id> is required.\n');
  process.exit(1);
}

function readNdjson(file) {
  const p = path.join(BUILD, file);
  if (!fs.existsSync(p)) throw new Error('missing ' + p + ' — run: node scripts/build-dataset.js');
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/* An even spread rather than the first N: the importer writes in id order, so
   checking the first 300 would pass on a run that stopped a third of the way
   through. */
function spread(list, n) {
  if (list.length <= n) return list.slice();
  const step = list.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * step)]);
  return out;
}

async function main() {
  const admin = require('firebase-admin');
  admin.initializeApp({ projectId: PROJECT });
  const db = admin.firestore();

  const groups = readNdjson('groups.ndjson');
  const modelGroups = readNdjson('modelGroups.ndjson');

  console.log('\n  Mobile Parts Finder — paid-data verification');
  console.log('  ' + '-'.repeat(56));
  console.log('  project        :', PROJECT);
  console.log('  build has      :', groups.length, 'groups,', modelGroups.length, 'devices');
  console.log('  sampling       :', SAMPLE, 'of each');
  console.log('  ' + '-'.repeat(56));

  /* The one read that tells you whether the datastore is answering at all.
     While billing is disabled on the Cloud project every call below fails
     with the same 7 PERMISSION_DENIED, and reporting that once is more use
     than reporting it six hundred times. */
  try {
    await db.collection('catalog').doc('meta').get();
  } catch (err) {
    console.error('\n  FIRESTORE IS NOT ANSWERING.\n');
    console.error('  ' + (err && err.message));
    if (err && err.code === 7) {
      console.error('\n  Code 7 with a billing message means billing is disabled on the');
      console.error('  Google Cloud project. Nothing in the app can read or write until');
      console.error('  it is re-enabled — not sign-in, not profiles, not subscriptions.');
    }
    process.exit(1);
  }

  let missingDetails = 0, emptyDetails = 0, shortDetails = 0;
  const detailProblems = [];

  for (const g of spread(groups, SAMPLE)) {
    const snap = await db.collection('groupDetails').doc(String(g.id)).get();
    if (!snap.exists) {
      missingDetails++;
      if (detailProblems.length < 12) detailProblems.push(`groupDetails/${g.id} missing`);
      continue;
    }
    const d = snap.data() || {};
    const ids = Array.isArray(d.memberIds) ? d.memberIds : [];
    if (!ids.length) {
      emptyDetails++;
      if (detailProblems.length < 12) detailProblems.push(`groupDetails/${g.id} has no memberIds`);
    } else if (ids.length < (g.memberIds || []).length) {
      shortDetails++;
      if (detailProblems.length < 12) {
        detailProblems.push(
          `groupDetails/${g.id} has ${ids.length} of ${(g.memberIds || []).length} members`);
      }
    }
  }

  let missingDevices = 0;
  const deviceProblems = [];
  for (const r of spread(modelGroups, SAMPLE)) {
    const snap = await db.collection('modelGroups').doc(String(r.id)).get();
    const d = snap.exists ? (snap.data() || {}) : null;
    const byCat = d && d.byCategory;
    if (!byCat || !Object.keys(byCat).length) {
      missingDevices++;
      if (deviceProblems.length < 12) deviceProblems.push(`modelGroups/${r.id} missing or empty`);
    }
  }

  console.log('  groupDetails   :', SAMPLE - missingDetails - emptyDetails - shortDetails,
              'complete,', missingDetails, 'missing,', emptyDetails, 'empty,',
              shortDetails, 'short');
  console.log('  modelGroups    :', SAMPLE - missingDevices, 'present,', missingDevices, 'missing');
  console.log('  ' + '-'.repeat(56));

  const problems = detailProblems.concat(deviceProblems);
  if (!problems.length) {
    console.log('  OK — every sampled group and device is in Firestore.');
    console.log('  /api/device-parts can answer for a subscriber.\n');
    return;
  }

  console.log('  PROBLEMS (first 24):');
  problems.slice(0, 24).forEach(p => console.log('    ' + p));
  console.log('\n  Re-run the importer to fill the gaps:');
  console.log('    node scripts/import-firestore.js --project ' + PROJECT +
              ' --only groups,modelGroups\n');
  process.exitCode = 1;
}

main().catch(err => {
  console.error('\n  verification failed:', err && err.stack ? err.stack : err, '\n');
  process.exit(1);
});
