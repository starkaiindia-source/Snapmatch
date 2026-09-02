/* ============================================================================
   Mobile Parts Finder · scripts/import-firestore.js
   ----------------------------------------------------------------------------
   One-time (re-runnable) importer for the built dataset.

   YOU run this — it needs credentials for your own Firebase project, which
   stay on your machine. Two ways to authenticate, pick either:

     A) gcloud / Firebase CLI application-default credentials
          firebase login
          gcloud auth application-default login
          node scripts/import-firestore.js --project mobilepartsfinder

     B) a service-account key file you download from
        Firebase console -> Project settings -> Service accounts
          set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\key.json
          node scripts/import-firestore.js --project mobilepartsfinder

   Never commit the key file. .gitignore already excludes *.serviceaccount.json.

   Flags
     --project <id>   Firebase project id                 (required)
     --dry            parse and report, write nothing
     --only <a,b>     subset: models,groups,modelGroups,brands,meta
     --concurrency N  parallel batches, default 4

   Writes (see firestore.rules for who may read what)
     /catalog/meta            dataset version + counts
     /brands/{id}
     /models/{id}             public catalogue
     /groups/{id}             public preview  (no part no., no member list)
     /groupDetails/{id}       paid: partNo, memberIds, memberNames
     /modelGroups/{id}        paid: model -> group ids per category

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
const BUILD = path.join(__dirname, '..', 'data', 'build');
const BATCH = 450;                       /* Firestore hard limit is 500 */

if (!PROJECT && !DRY) {
  console.error('\n  --project <firebase-project-id> is required (or use --dry).\n');
  process.exit(1);
}
const want = name => !ONLY.length || ONLY.indexOf(name) > -1;

/* ------------------------------------------------------------- read input */
function readNdjson(file) {
  const p = path.join(BUILD, file);
  if (!fs.existsSync(p)) throw new Error('missing ' + p + ' — run: node scripts/build-dataset.js');
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
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

  if (want('groups')) {
    const groups = readNdjson('groups.ndjson');
    /* public preview — safe for anyone to read */
    total += await writeAll('groups', groups, g => ({
      groupNo: g.groupNo, serialNo: g.serialNo,
      categoryId: g.categoryId, categoryName: g.categoryName,
      masterModelId: g.masterModelId, masterModelName: g.masterModelName,
      masterBrandId: g.masterBrandId,
      memberCount: g.memberCount,
      searchTokens: g.searchTokens
    }));
    /* paid detail — gated by firestore.rules */
    total += await writeAll('groupDetails', groups, g => ({
      groupNo: g.groupNo, categoryId: g.categoryId,
      partNo: g.partNo, drawingName: g.drawingName,
      memberIds: g.memberIds, memberNames: g.memberNames,
      memberCount: g.memberCount
    }));
  }

  if (want('modelGroups')) total += await writeAll('modelGroups', readNdjson('modelGroups.ndjson'));

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
