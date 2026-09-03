/* ============================================================================
   Mobile Parts Finder · scripts/build-runtime-bundle.js
   ----------------------------------------------------------------------------
   Packs data/build/*.ndjson into the single file the browser loads.

   WHY NOT JUST SHIP THE NDJSON
     The build output is 4.4 MB across five files. Loading that on every visit
     would cost seconds on the 4G connections this audience actually uses, so
     the bundle drops what the UI never reads and stores the rest positionally.

   POSITIONAL ROWS
     A model as an object repeats its sixteen key names 4,933 times — roughly
     700 KB of the payload is the word "releaseYear". Rows are arrays instead,
     with the column order declared once in the header. The client rehydrates
     them into objects at boot, which is a single pass over the data and costs
     less than the bytes saved take to arrive.

   WHAT IS DELIBERATELY ABSENT
     There is no chipset, RAM, colour, camera or screen-curvature data in the
     source, so none of it is here. It is not filled in, not estimated, and not
     defaulted — a spec sheet that quietly invents a processor is worse than
     one that says the field is unknown.

     deviceType IS derived, from the model name, and that is a different thing:
     "Apple iPad 10.2 (2019)" is a tablet because it says so. The derivation is
     recorded per row so the UI can tell the difference between a fact from the
     source and one read off a name.

   Run after scripts/build-dataset.js:
       node scripts/build-runtime-bundle.js
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BUILD = path.join(__dirname, '..', 'data', 'build');
const OUT = path.join(__dirname, '..', 'assets', 'dataset.json');

const read = f => fs.readFileSync(path.join(BUILD, f), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

/* --------------------------------------------------------------- deviceType
   Read off the model name, which is the only evidence the source carries.
   Ordered most specific first: "Galaxy Watch" must not be caught by a looser
   phone rule, and "iPad mini" must not match a "mini" phone pattern. */
function deviceTypeOf(name) {
  const n = String(name);
  if (/\b(watch|band\s*\d|fit\s*\d|smartband)\b/i.test(n)) return 'watch';
  if (/\b(ipad|galaxy tab|matepad|mediapad|tab\s*[a-z]?\d|tablet|pad\s*\d)\b/i.test(n)) return 'tablet';
  if (/\bpad\b/i.test(n) && !/\bpadfone\b/i.test(n)) return 'tablet';
  return 'phone';
}

function main() {
  const models = read('models.ndjson');
  const groups = read('groups.ndjson');
  const modelGroups = read('modelGroups.ndjson');
  const brands = read('brands.ndjson');
  const meta = JSON.parse(fs.readFileSync(path.join(BUILD, 'meta.json'), 'utf8'));

  /* ---- models -------------------------------------------------------------
     `tokens` is dropped: search runs off the name, and shipping a pre-split
     token list for 4,933 models added ~600 KB for something computed in
     microseconds. nameLower is dropped for the same reason. */
  const MODEL_COLS = ['id', 'b', 'n', 'rd', 'ry', 'sz', 'h', 'w', 'cm2', 'br', 'mah', 'img', 'src', 'dt'];
  const modelRows = models.map(m => [
    m.id,
    m.brandId,
    m.name,
    m.releaseDate || null,
    m.releaseYear ?? null,
    m.sizeInch ?? null,
    m.heightMm ?? null,
    m.widthMm ?? null,
    m.screenCm2 ?? null,
    m.bodyRatio ?? null,
    m.batteryMah ?? null,
    m.image || null,
    m.gsmarenaUrl || null,
    deviceTypeOf(m.name)
  ]);

  /* ---- groups -------------------------------------------------------------
     memberNames is dropped — it duplicates names the client already has by id,
     and it was the single largest field in the build at ~900 KB. */
  const GROUP_COLS = ['id', 'no', 'cat', 'mm', 'mb', 'cnt', 'part', 'mem'];
  const groupRows = groups.map(g => [
    g.id,
    g.groupNo,
    g.categoryId,
    g.masterModelId,
    g.masterBrandId,
    g.memberCount,
    g.partNo || null,
    g.memberIds || []
  ]);

  /* ---- model -> groups by category ---------------------------------------- */
  const mgObj = {};
  modelGroups.forEach(r => { mgObj[r.id] = r.byCategory; });

  const bundle = {
    v: meta.version,
    generatedAt: new Date().toISOString(),
    source: 'data/build — owner-supplied export',
    /* Named so the UI can say what it does and does not know. */
    fieldsPresent: ['name', 'brand', 'releaseDate', 'displaySize', 'height', 'width',
                    'screenArea', 'bodyRatio', 'battery', 'image', 'sourceUrl'],
    /* Every field the UI can render but this export cannot fill. The UI reads
       this list to decide which filters, columns and spec cards to leave out,
       so a name missing here shows up as an empty column rather than as a
       hidden one. */
    fieldsAbsent: ['chipset', 'cpu', 'gpu', 'ram', 'storage', 'colours', 'cameras',
                   'os', 'network', 'sensors', 'screenCurve', 'screenResolution',
                   'screenType', 'refreshRate', 'price', 'variants'],
    fieldsDerived: ['deviceType'],
    categories: meta.categories,
    brands: brands.map(b => [b.id, b.name, b.modelCount, b.groupCount]),
    brandCols: ['id', 'name', 'models', 'groups'],
    modelCols: MODEL_COLS,
    models: modelRows,
    groupCols: GROUP_COLS,
    groups: groupRows,
    modelGroups: mgObj
  };

  const json = JSON.stringify(bundle);
  fs.writeFileSync(OUT, json);

  const gz = zlib.gzipSync(Buffer.from(json)).length;
  const raw = Buffer.byteLength(json);
  const kb = n => (n / 1024).toFixed(0) + ' KB';

  const counts = {};
  modelRows.forEach(r => { counts[r[13]] = (counts[r[13]] || 0) + 1; });

  console.log('\n  runtime bundle -> assets/dataset.json');
  console.log('  ' + '-'.repeat(50));
  console.log('  models     ', modelRows.length, JSON.stringify(counts));
  console.log('  groups     ', groupRows.length);
  console.log('  fitments   ', groupRows.reduce((s, g) => s + g[7].length, 0));
  console.log('  brands     ', bundle.brands.length);
  console.log('  categories ', bundle.categories.length);
  console.log('  ' + '-'.repeat(50));
  console.log('  raw        ', kb(raw));
  console.log('  gzipped    ', kb(gz), ' <- what the browser downloads');
  console.log();
}

main();
