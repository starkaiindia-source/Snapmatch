/* ============================================================================
   Mobile Parts Finder · scripts/upload-brand-assets.js
   ----------------------------------------------------------------------------
   Uploads brand logo files to the project’s EXISTING Firebase Storage bucket
   and writes the resulting URLs into src/data/brand-assets.js, which is the one
   place the app resolves a brand logo from.

   The brand twin of scripts/upload-category-assets.js, and it uses the same
   bucket, the same public-read convention and the same “Storage is the system
   of record, the bundled copy is the fallback” shape. No second storage system.

   YOU run this — it needs credentials for your own Firebase project, and they
   stay on your machine.

       set GOOGLE_APPLICATION_CREDENTIALS=C:\\path\\to\\serviceAccount.json
       node scripts/upload-brand-assets.js --project mobilepartsfinder

   Flags
     --project <id>   Firebase project id                      (required)
     --bucket <name>  storage bucket        (default <project>.firebasestorage.app)
     --only <ids>     comma-separated brand ids; default is every file present
     --dry            report what would be uploaded, change nothing

   WHAT GOES UP

       brand-assets/<brand-id>/logo.<ext>

     Source files are read from assets/brands/. scripts/build-brand-marks.js
     writes the CC0 ones there; drop a LICENSED logo in with the same name and
     it replaces it — that file is then what the site serves everywhere.

   WHICH BRANDS ARE WORTH UPLOADING

     Not all of them. A brand whose mark is already inlined in brand-marks.js
     renders with no request at all and recolours per theme, which a hosted
     <img> cannot. Uploading the same artwork would be a step backwards, so by
     default this script skips brands that already have an inline mark unless
     you name them with --only. Run with --dry first; it says what it will do.

   THESE OBJECTS ARE PUBLIC, DELIBERATELY

     They are manufacturer logos on a public parts catalogue, shown nominatively
     to say which brand a part fits. Signed URLs would expire inside pre-rendered,
     CDN-cached HTML and the logos would quietly stop appearing one day.
     storage.rules grants read on this prefix and no client write.

   IDEMPOTENT. Re-running overwrites the same object paths and rewrites the same
   mapping file. Nothing is duplicated and nothing is versioned into oblivion.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'brands');
const MAPPING = path.join(ROOT, 'src', 'data', 'brand-assets.js');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d; };
const has = (n) => argv.indexOf('--' + n) > -1;

const PROJECT = flag('project');
const DRY = has('dry');
const BUCKET = flag('bucket', PROJECT ? `${PROJECT}.firebasestorage.app` : null);
const ONLY = (flag('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

if (!PROJECT) {
  console.error('\n  --project is required, e.g.\n' +
    '    node scripts/upload-brand-assets.js --project mobilepartsfinder\n');
  process.exit(1);
}
if (!fs.existsSync(SRC)) {
  console.error('\n  assets/brands/ not found. Build the CC0 marks first:\n' +
    '    node scripts/build-brand-marks.js\n');
  process.exit(1);
}

const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

/* Brands that already have an inline vector. Read straight out of the generated
   file rather than duplicated here, so the two cannot drift. */
function inlinedBrandIds() {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'data', 'brand-marks.js'), 'utf8');
    const m = /SM\.brandMarks\s*=\s*(\{[\s\S]*?\});/.exec(src);
    return m ? Object.keys(JSON.parse(m[1])) : [];
  } catch (e) { return []; }
}

/* The public download URL for an object — Firebase’s own form, so it goes
   through the same CDN the console shows and needs no token when the rules
   allow public read. */
function publicUrl(bucket, objectPath) {
  return 'https://firebasestorage.googleapis.com/v0/b/' + bucket +
         '/o/' + encodeURIComponent(objectPath) + '?alt=media';
}

const inlined = inlinedBrandIds();
const files = fs.readdirSync(SRC)
  .filter((f) => MIME[path.extname(f).toLowerCase()])
  .map((f) => ({ id: path.basename(f, path.extname(f)), file: f, ext: path.extname(f).toLowerCase() }));

const chosen = files.filter((f) => (ONLY.length ? ONLY.indexOf(f.id) > -1 : inlined.indexOf(f.id) === -1));
const skipped = files.filter((f) => chosen.indexOf(f) === -1);

/* Rewrites one brand's `storage` and `bundled` in the mapping file, leaving its
   `mode` — a hand-made presentation decision — exactly as it is. A regex on a
   single line is enough because the table is generated in this fixed shape, and
   it means the file keeps its comments. */
function writeMapping(rows) {
  let src = fs.readFileSync(MAPPING, 'utf8');
  rows.forEach((r) => {
    const line = new RegExp('(^\\s*' + r.id + ':\\s*\\{)[^}]*(\\})', 'm');
    if (!line.test(src)) {
      console.warn('  ! no row for "' + r.id + '" in brand-assets.js — add one, then re-run');
      return;
    }
    src = src.replace(line, (_m, open, close) =>
      open + ' storage: ' + JSON.stringify(r.storage) +
      ', bundled: ' + JSON.stringify(r.bundled) +
      ", mode: '" + r.mode + "' " + close);
  });
  fs.writeFileSync(MAPPING, src, 'utf8');
}

function currentMode(id) {
  const src = fs.readFileSync(MAPPING, 'utf8');
  const m = new RegExp('^\\s*' + id + ':\\s*\\{[^}]*mode:\\s*\'([a-z]+)\'', 'm').exec(src);
  return m ? m[1] : 'tint';
}

async function main() {
  if (!chosen.length) {
    console.log('\n  Nothing to upload.');
    console.log('  ' + skipped.length + ' brand file(s) already render from an inline vector:');
    console.log('    ' + skipped.map((s) => s.id).join(', '));
    console.log('\n  That is the faster path — no request, and the mark recolours per theme.');
    console.log('  Upload one anyway with --only <id>, or drop a LICENSED logo into');
    console.log('  assets/brands/<id>.svg for a brand that has no mark yet:\n');
    console.log('    ' + (SM_REVIEW().join(', ') || '—') + '\n');
    return;
  }

  console.log('\n  bucket   ' + BUCKET);
  console.log('  upload   ' + chosen.map((c) => c.id).join(', '));
  if (skipped.length) console.log('  skip     ' + skipped.map((c) => c.id).join(', ') + '  (inline vector is better)');
  if (DRY) { console.log('\n  --dry: nothing written.\n'); return; }

  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: PROJECT,
      storageBucket: BUCKET
    });
  }
  const bucket = admin.storage().bucket(BUCKET);

  const rows = [];
  for (const c of chosen) {
    const local = path.join(SRC, c.file);
    const remote = `brand-assets/${c.id}/logo${c.ext}`;
    await bucket.upload(local, {
      destination: remote,
      metadata: { contentType: MIME[c.ext], cacheControl: 'public, max-age=31536000, immutable' }
    });
    try { await bucket.file(remote).makePublic(); }
    catch (e) { /* uniform bucket-level access: storage.rules already grants read */ }

    rows.push({
      id: c.id,
      storage: publicUrl(BUCKET, remote),
      bundled: '/assets/brands/' + c.file,
      mode: currentMode(c.id)
    });
    console.log('  ok       ' + remote);
  }

  writeMapping(rows);
  console.log('\n  wrote    src/data/brand-assets.js  (' + rows.length + ' brand(s))\n');
}

/* Brands with no inline mark and no file yet — the ones a licensed logo would
   actually improve. Read from the generated review list. */
function SM_REVIEW() {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'data', 'brand-marks.js'), 'utf8');
    const m = /SM\.brandMarksReview\s*=\s*(\[[^\]]*\]);/.exec(src);
    const ids = m ? JSON.parse(m[1]) : [];
    return ids.filter((id) => !files.some((f) => f.id === id));
  } catch (e) { return []; }
}

main().catch((e) => { console.error('\n  failed: ' + (e && e.message) + '\n'); process.exit(1); });
