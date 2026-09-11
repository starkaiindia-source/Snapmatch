/* ============================================================================
   Mobile Parts Finder · scripts/archive-gsmarena.js
   ----------------------------------------------------------------------------
   Archives the existing GSMArena-backed record for one or more models BEFORE
   any TechSpecs data replaces it.

       node scripts/archive-gsmarena.js apple-iphone-15
       node scripts/archive-gsmarena.js --batch batch-001 apple-iphone-15

   Writes data/archive/gsmarena/<batch>/<modelId>.json holding the complete
   original record plus archive metadata, and appends to a manifest.

   ARCHIVE FIRST, REPLACE SECOND. Nothing here deletes or mutates
   data/build/models.ndjson — the live catalogue is left exactly as it was.
   The archive is the rollback path, so it stores the whole original object
   rather than a chosen subset of fields.

   This touches ONLY the All Mobile Models dataset. The Compatibility Device
   Finder reads groups.ndjson / modelGroups.ndjson, neither of which this
   script opens.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODELS = path.join(ROOT, 'data', 'build', 'models.ndjson');
const ARCHIVE_ROOT = path.join(ROOT, 'data', 'archive', 'gsmarena');

const args = process.argv.slice(2);
const batchIdx = args.indexOf('--batch');
const BATCH = batchIdx > -1 ? args[batchIdx + 1] : 'batch-001';
/* skip the value that follows --batch, but only when --batch was actually given:
   with batchIdx === -1, batchIdx + 1 is 0 and would swallow the first model id */
const ids = args.filter((a, i) => !a.startsWith('--') && !(batchIdx > -1 && i === batchIdx + 1));

if (!ids.length) {
  console.error('usage: node scripts/archive-gsmarena.js [--batch <name>] <modelId> [modelId...]');
  process.exit(1);
}

/* ------------------------------------------------------------------ read */
const byId = new Map();
fs.readFileSync(MODELS, 'utf8').split(/\r?\n/).forEach(line => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  byId.set(m.id, m);
});

const dir = path.join(ARCHIVE_ROOT, BATCH);
fs.mkdirSync(dir, { recursive: true });

const manifestPath = path.join(ARCHIVE_ROOT, 'manifest.json');
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : { batches: {} };

let ok = 0, missing = 0;

for (const id of ids) {
  const original = byId.get(id);
  if (!original) {
    console.error(`  MISSING  ${id} — not in models.ndjson, nothing archived`);
    missing++;
    continue;
  }

  const record = {
    archive: {
      archivedAt: new Date().toISOString(),
      migrationBatch: BATCH,
      source: 'gsmarena_archive',
      reason: 'Superseded by TechSpecs API data on the All Mobile Models page',
      archiveVersion: 1
    },
    /* the identifiers the live record must keep pointing at */
    recordId: original.id,
    brand: original.brand,
    brandId: original.brandId,
    modelName: original.name,
    modelNumber: original.modelNumber || null,
    /* the GSMArena provenance, kept so the image can always be recovered */
    gsmarena: {
      url: original.gsmarenaUrl || null,
      imageUrl: original.image || null,
      sourceSheet: original.sourceSheet || null
    },
    /* every original field, verbatim — this is the rollback payload */
    originalState: original
  };

  const out = path.join(dir, `${id}.json`);
  fs.writeFileSync(out, JSON.stringify(record, null, 1), 'utf8');

  /* verify what landed on disk before reporting success */
  const back = JSON.parse(fs.readFileSync(out, 'utf8'));
  const same = JSON.stringify(back.originalState) === JSON.stringify(original);
  if (!same) {
    console.error(`  FAILED   ${id} — archive read-back did not match the original`);
    process.exitCode = 1;
    continue;
  }

  manifest.batches[BATCH] = manifest.batches[BATCH] || { createdAt: new Date().toISOString(), models: [] };
  if (!manifest.batches[BATCH].models.includes(id)) manifest.batches[BATCH].models.push(id);

  console.log(`  archived ${id}  ->  data/archive/gsmarena/${BATCH}/${id}.json`);
  console.log(`           image kept: ${record.gsmarena.imageUrl || '(none)'}`);
  ok++;
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1), 'utf8');

console.log(`\n  batch ${BATCH}: ${ok} archived, ${missing} missing`);
console.log('  models.ndjson untouched — archive is additive.');
