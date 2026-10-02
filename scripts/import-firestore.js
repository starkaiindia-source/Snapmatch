/* ============================================================================
   Mobile Parts Finder · scripts/import-firestore.js
   ----------------------------------------------------------------------------
   One-time (re-runnable) importer for the built dataset.

   YOU run this — it needs credentials for your own Firebase project, which
   stay on your machine. Two ways to authenticate, pick either:

     A) gcloud / Firebase CLI application-default credentials
          firebase login
          gcloud auth application-default login
          node scripts/import-firestore.js --project mobilepartsfindercom

     B) a service-account key file you download from
        Firebase console -> Project settings -> Service accounts
          set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\key.json
          node scripts/import-firestore.js --project mobilepartsfindercom

   Never commit the key file. .gitignore already excludes *.serviceaccount.json.

   Flags
     --project <id>   Firebase project id                 (required)
     --dry            parse and report, write nothing
     --only <a,b>     subset: models,groups,modelGroups,brands,meta
     --category <id>  one part category: its groups + groupDetails, only its own
                      key on each device's modelGroups doc, and catalog/meta
     --concurrency N  parallel batches, default 4
     --allow-dropping-approved
                      import even if the build lacks a fitment an admin
                      approved from Instagram (see guardApprovedFitments)

   Writes (see firestore.rules for who may read what)
     /catalog/meta            dataset version + counts
     /brands/{id}
     /models/{id}             public catalogue
     /groups/{id}             full record: part codes and member lists included
     /groupDetails/{id}       the same detail, kept for /api/device-parts
     /modelGroups/{id}        model -> group ids per category

   The importer is idempotent: re-running overwrites documents by id and never
   duplicates. It does not delete documents that vanished from the source —
   pass --prune to see what those would be (it still will not delete them).
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

/* ------------------------------------------------------------------ args */
const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf('--' + name); return i > -1 ? argv[i + 1] : def; };
const has = name => argv.indexOf('--' + name) > -1;

const PROJECT = flag('project');
const DRY = has('dry');
const PRUNE = has('prune');
const CONCURRENCY = Math.max(1, Number(flag('concurrency', 4)) || 4);
const ONLY = (flag('only', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const CATEGORY = flag('category', '') || null;
const BUILD = path.join(__dirname, '..', 'data', 'build');
const BATCH = 450;                       /* Firestore hard limit is 500 */

if (!PROJECT && !DRY) {
  console.error('\n  --project <firebase-project-id> is required (or use --dry).\n');
  process.exit(1);
}
/* --category narrows a run to the three places a category lives. Models and
   brands are skipped: adding a category's groups changes neither. */
const want = name => (!CATEGORY || ['groups', 'modelGroups', 'meta'].indexOf(name) > -1) &&
  (!ONLY.length || ONLY.indexOf(name) > -1);

/* ------------------------------------------------------------- read input */
function readNdjson(file) {
  const p = path.join(BUILD, file);
  if (!fs.existsSync(p)) throw new Error('missing ' + p + ' — run: node scripts/build-dataset.js');
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}
/* A file an older build did not write: the groups of run-time categories. */
function readOptional(file) {
  return fs.existsSync(path.join(BUILD, file)) ? readNdjson(file) : [];
}

/* -------------------------------------------------------------- firestore */
let db = null;
function connect() {
  if (DRY) return null;
  let admin;
  try { admin = require('firebase-admin'); }
  catch (e) {
    console.error('\n  firebase-admin is not installed. Run:\n    npm install firebase-admin\n');
    process.exit(1);
  }
  admin.initializeApp({ projectId: PROJECT });
  const d = admin.firestore();
  d.settings({ ignoreUndefinedProperties: true });
  return d;
}

/* Writes `rows` into `collection`, keyed by row.id, in batches.
   `shape` maps a source row to the document actually stored. */
async function writeAll(collection, rows, shape) {
  const docs = rows.map(r => ({ id: r.id, data: shape ? shape(r) : r }));
  if (DRY) {
    const sample = docs[0] ? JSON.stringify(docs[0].data).length : 0;
    console.log(`  [dry] ${collection.padEnd(14)} ${String(docs.length).padStart(6)} docs, ~${sample} B each`);
    return docs.length;
  }
  const batches = [];
  for (let i = 0; i < docs.length; i += BATCH) batches.push(docs.slice(i, i + BATCH));

  let done = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < batches.length) {
      const chunk = batches[cursor++];
      const b = db.batch();
      chunk.forEach(d => b.set(db.collection(collection).doc(String(d.id)), d.data, { merge: true }));
      await b.commit();
      done += chunk.length;
      process.stdout.write(`\r  ${collection.padEnd(14)} ${String(done).padStart(6)}/${docs.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  process.stdout.write(`\r  ${collection.padEnd(14)} ${String(done).padStart(6)}/${docs.length}  done\n`);
  return done;
}

/* ------------------------------------------------- approved fitments guard

   An administrator can approve an Instagram compatibility claim into an
   existing group (api/_services/instagram/review-service.js), which writes
   that group's groupDetails directly. This importer would overwrite it from
   the build. So before any group is written, every `applied` approval is
   checked against the build being imported; if the build would drop one, the
   import stops and says which, unless --allow-dropping-approved is given.

   The fix is almost always: export the ledger and rebuild —
     node scripts/export-approved-compatibilities.js --project <id>
     node scripts/build-dataset.js && node scripts/build-runtime-bundle.js */
async function guardApprovedFitments() {
  const snap = await db.collection('approvedCompatibilities').where('status', '==', 'applied').get();
  if (snap.empty) return;
  const groups = new Map(readNdjson('groups.ndjson').concat(readOptional('groups-runtime.ndjson')).map(g => [g.id, g]));
  const dropped = [];
  const all = Array.from(groups.values());
  const holds = (categoryId, modelId) => all.some(g => g.categoryId === categoryId && (g.memberIds || []).indexOf(modelId) > -1);
  const day = e => new Date(e.approvedAt).toISOString().slice(0, 10);
  /* A device that was added and LATER taken out again (removed by hand, or its
     group deleted) is not "dropped by this build": the removal is in the
     ledger too, and is newer. */
  const goneAt = new Map();
  snap.docs.map(d => d.data()).forEach(e => {
    const ids = e.kind === 'remove_model' ? [e.removedModelId] : e.kind === 'delete_group' ? (e.memberIds || []) : [];
    ids.forEach(id => { const k = e.categoryId + '|' + id; goneAt.set(k, Math.max(goneAt.get(k) || 0, Number(e.approvedAt) || 0)); });
  });
  const removedLater = (e, modelId) => (goneAt.get(e.categoryId + '|' + modelId) || 0) > (Number(e.approvedAt) || 0);
  snap.docs.forEach(d => {
    const e = d.data();
    if (CATEGORY && e.categoryId !== CATEGORY) return;
    if (['remove_model', 'set_master', 'delete_group', 'merge_groups'].indexOf(e.kind) > -1) return;
    /* a group created at run time: every device it was created with must
       still have a group in its category — the same one, or (after a merge)
       the one that absorbed it */
    if (e.kind === 'new_group') {
      const c = e.createdGroup || {};
      const lost = (c.memberIds || []).filter(id => !holds(e.categoryId, id) && !removedLater(e, id));
      if (lost.length) dropped.push(`${e.categoryId}: group ${c.groupNo || c.groupId} — ${lost.length} device(s) have no group in this build (created ${day(e)})`);
      return;
    }
    if (!e.appliedChange) return;
    const ch = e.appliedChange;
    /* the device must still be in a group of that category: its own, or the
       survivor of a merge the build folded in */
    if (!holds(e.categoryId, ch.addedModelId) && !removedLater(e, ch.addedModelId)) {
      dropped.push(`${e.categoryId}: ${ch.addedModelId} in ${ch.groupId} (approved ${day(e)})`);
    }
  });
  console.log(`  approved fitments: ${snap.size} applied, ${dropped.length} missing from this build`);
  if (!dropped.length) return;
  dropped.slice(0, 30).forEach(line => console.log('    - ' + line));
  if (has('allow-dropping-approved')) {
    console.log('  --allow-dropping-approved given: importing anyway. These approvals will no longer be live.');
    return;
  }
  console.error('\n  Refusing to import: this build would remove approved fitments from production.' +
    '\n  Export the ledger and rebuild first:' +
    '\n    node scripts/export-approved-compatibilities.js --project ' + PROJECT +
    '\n    node scripts/build-dataset.js && node scripts/build-runtime-bundle.js' +
    '\n  or pass --allow-dropping-approved if dropping them is intended.\n');
  process.exit(1);
}

/* -------------------------------------------- one group per category guard

   One category + one model = one group. The Instagram review queue enforces
   it on every approval; this enforces it on the other way compatibility data
   reaches production — the build. A device in two groups of one category
   would make a single search return two parts, so such a build is not
   published. Fix the master compatibility data and rebuild, or pass
   --allow-duplicate-assignments to publish it knowingly. No network: it
   reads the build on disk. */
function guardOneGroupPerCategory() {
  const { findDuplicateAssignments } = require('./build-dataset');
  const dups = findDuplicateAssignments(readNdjson('modelGroups.ndjson'))
    .filter(d => !CATEGORY || d.categoryId === CATEGORY);
  console.log(`  one group per category: ${dups.length} device(s) assigned to more than one group`);
  if (!dups.length) return;
  dups.slice(0, 30).forEach(d => console.log(`    - ${d.categoryId}: ${d.modelId} in ${d.groupIds.join(' and ')}`));
  if (has('allow-duplicate-assignments')) {
    console.log('  --allow-duplicate-assignments given: importing anyway. Those devices will return more than one part.');
    return;
  }
  console.error('\n  Refusing to import: a device may belong to only ONE group per category.' +
    '\n  Remove the duplicate assignments in the master compatibility data and rebuild,' +
    '\n  or pass --allow-duplicate-assignments to publish them knowingly.\n');
  process.exit(1);
}

/* ------------------------------------------------------------------- run */
async function main() {
  console.log('\n  Mobile Parts Finder — Firestore import');
  console.log('  ' + '-'.repeat(52));
  console.log('  project    :', PROJECT || '(dry run)');
  console.log('  source     :', BUILD);
  console.log('  mode       :', DRY ? 'DRY RUN — nothing will be written' : 'WRITE');
  console.log('  ' + '-'.repeat(52));

  const meta = JSON.parse(fs.readFileSync(path.join(BUILD, 'meta.json'), 'utf8'));
  db = connect();
  const t0 = Date.now();
  let total = 0;

  if (want('brands')) total += await writeAll('brands', readNdjson('brands.ndjson'));

  if (want('models')) {
    const models = readNdjson('models.ndjson');
    total += await writeAll('models', models, m => ({
      brand: m.brand, brandId: m.brandId, name: m.name, nameLower: m.nameLower,
      releaseDate: m.releaseDate, releaseYear: m.releaseYear,
      sizeInch: m.sizeInch, heightMm: m.heightMm, widthMm: m.widthMm,
      screenCm2: m.screenCm2, bodyRatio: m.bodyRatio, batteryMah: m.batteryMah,
      gsmarenaUrl: m.gsmarenaUrl, image: m.image
      /* `tokens` is intentionally not stored: search runs off the static
         bundle, so indexing ~40k token entries would cost writes for nothing */
    }));
  }

  if (want('groups') || want('modelGroups')) guardOneGroupPerCategory();
  if (want('groups') && !DRY) await guardApprovedFitments();

  if (want('groups')) {
    /* the site's groups, and the groups of categories created at run time —
       both are this project's compatibility data; only the first are public */
    const groups = readNdjson('groups.ndjson').concat(readOptional('groups-runtime.ndjson'))
      .filter(g => !CATEGORY || g.categoryId === CATEGORY);
    /* The whole record, readable by anyone — the owner's decision, matching
       what assets/dataset.json now ships. Keeping /groups thinner than the
       bundle would only mean the Firestore path showed less than the file
       sitting next to it, which is how the finder ended up rendering "1 more
       device — not listed" over a member list the browser already had. */
    /* NARROWED AGAIN. memberIds and memberNames are gone from /groups: they
       are the fitment list, the free/paid split meters it, and a Firestore
       rule can withhold a document but not a field — so a readable /groups
       carrying them is the whole paywall walked around with the SDK.

       They live in /groupDetails (below), which is closed to every client and
       read only by /api/device-parts through the Admin SDK, which slices to
       the caller's tier.

       The comment this replaces argued /groups should match the public bundle.
       It still does — the bundle no longer ships member lists either. */
    total += await writeAll('groups', groups, g => ({
      groupNo: g.groupNo, serialNo: g.serialNo,
      partCode: g.partCode, oemPartNo: g.oemPartNo || null,
      categoryId: g.categoryId, categoryName: g.categoryName,
      masterModelId: g.masterModelId, masterModelName: g.masterModelName,
      masterBrandId: g.masterBrandId,
      memberCount: g.memberCount,
      searchTokens: g.searchTokens
    }));
    /* Still written. /api/device-parts reads it, and narrowing /groups again
       later needs this collection to already be populated. */
    total += await writeAll('groupDetails', groups, g => ({
      groupNo: g.groupNo, categoryId: g.categoryId,
      partCode: g.partCode, oemPartNo: g.oemPartNo || null,
      drawingName: g.drawingName,
      memberIds: g.memberIds, memberNames: g.memberNames,
      memberCount: g.memberCount
    }));
  }

  if (want('modelGroups')) {
    let rows = readNdjson('modelGroups.ndjson').concat(readOptional('modelGroups-runtime.ndjson'));
    /* One key per device, merged in. The device's other categories are not in
       the payload, so the merge cannot overwrite them. */
    if (CATEGORY) rows = rows.filter(r => r.byCategory && r.byCategory[CATEGORY])
      .map(r => ({ id: r.id, byCategory: { [CATEGORY]: r.byCategory[CATEGORY] } }));
    total += await writeAll('modelGroups', rows);
  }

  if (want('meta') && !DRY) {
    await db.collection('catalog').doc('meta').set({
      ...meta, importedAt: new Date().toISOString()
    }, { merge: true });
    console.log('  catalog/meta   written');
  }

  if (PRUNE && !DRY) {
    console.log('\n  --prune is report-only; nothing is deleted.');
    const ids = new Set(readNdjson('groups.ndjson').map(g => String(g.id)));
    const snap = await db.collection('groups').select().get();
    const stale = snap.docs.map(d => d.id).filter(id => !ids.has(id));
    console.log('  groups in Firestore not present in this build:', stale.length);
    if (stale.length) console.log('  ', stale.slice(0, 20).join(', '), stale.length > 20 ? '…' : '');
  }

  console.log('  ' + '-'.repeat(52));
  console.log('  documents  :', total);
  console.log('  elapsed    :', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('  dataset    : v' + meta.version, '·',
    meta.counts.models + ' models,', meta.counts.groups + ' groups,', meta.counts.fitments + ' fitments');
  console.log();
}

main().catch(e => { console.error('\n  import failed:', e.message, '\n'); process.exit(1); });
