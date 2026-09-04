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
  const MODEL_COLS = ['id', 'b', 'n', 'rd', 'ry', 'sz', 'h', 'w', 'cm2', 'br', 'mah',
                      'img', 'src', 'dt', 'st', 'bp', 'bv', 'rs'];
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
    deviceTypeOf(m.name),
    /* From the category exports, not the workbook. Partial by nature — 260
       devices have a screen type recorded and 288 a battery part number — and
       null everywhere else, because a device nobody recorded is not a flat
       one. */
    m.screenType || null,
    m.batteryPartNo || null,
    m.batteryPartNo ? !!m.batteryPartVerified : null,
    m.releaseStatus || null
  ]);

  /* Members are shipped as INDEXES into `models`, not as ids. The same 12,239
     fitments cost about 60 KB this way and about 330 KB as slugs, on a bundle
     that is downloaded before the first render over the 4G connections this
     audience actually uses. Both arrays come out of this one build, so the
     index cannot drift from the row it names. */
  const modelIndex = new Map(models.map((m, i) => [m.id, i]));

  /* ---- groups: THE WHOLE RECORD -------------------------------------------
     Part codes and fitment lists ship in the public bundle. That is the
     owner's decision, made explicitly, and it is worth being clear about what
     it means: anything under assets/ is one unauthenticated GET away, so the
     complete catalogue — 3,340 part codes and 12,239 fitments — is downloadable
     by anyone who opens the site, signed in or not, for ever. There is no
     taking it back for copies already fetched.

     The paid slice below is still written, so /api/device-parts keeps working
     and the decision can be reversed for FUTURE visitors by narrowing these
     columns again. Nothing else in the app depends on the split.

     `sn` is the serial number. It used to be absent, which is why every group
     sheet showed its group number three times over — as the group number, as
     the serial, and as the part code. */
  const GROUP_COLS = ['id', 'no', 'sn', 'part', 'oem', 'cat', 'mm', 'mb', 'cnt', 'mem'];
  const groupRows = groups.map(g => [
    g.id,
    g.groupNo,
    g.serialNo,
    g.partCode,
    g.oemPartNo || null,
    g.categoryId,
    g.masterModelId,
    g.masterBrandId,
    g.memberCount,
    (g.memberIds || []).map(id => modelIndex.get(id)).filter(i => i !== undefined)
  ]);

  /* Device -> which groups fit it, per category, as group ids. The client
     could rebuild this by walking every group's member list, but it is needed
     on the very first render of a device page and walking 3,340 groups to
     answer one question is work done 3,340 times too often. */
  const mgPublic = {};
  modelGroups.forEach(r => { mgPublic[r.id] = r.byCategory; });

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
                   'os', 'network', 'sensors', 'screenResolution',
                   'refreshRate', 'price', 'variants'],
    /* screenType left the absent list because the exports actually carry it —
       for 260 of 4,933 devices. Partial, and the UI omits the row where it is
       null rather than filling it in. */
    fieldsPartial: ['screenType', 'batteryPartNo', 'releaseStatus'],
    fieldsDerived: ['deviceType'],
    categories: meta.categories,
    brands: brands.map(b => [b.id, b.name, b.modelCount, b.groupCount]),
    brandCols: ['id', 'name', 'models', 'groups'],
    modelCols: MODEL_COLS,
    models: modelRows,
    groupCols: GROUP_COLS,
    groups: groupRows,
    modelGroups: mgPublic
  };

  const json = JSON.stringify(bundle);
  fs.writeFileSync(OUT, json);

  /* ---- the paid half ------------------------------------------------------
     Written where the serverless functions can require it and the CDN cannot
     serve it. api/_data is inside the function bundle; nothing under it has a
     public URL. /api/device-parts is the only way in, and it checks for an
     active subscription first. */
  const paid = {
    v: meta.version,
    generatedAt: new Date().toISOString(),
    /* groupId -> { partCode, oemPartNo, memberIds } */
    groups: Object.fromEntries(groups.map(g => [g.id, {
      partCode: g.partCode || null,
      oemPartNo: g.oemPartNo || null,
      drawingName: g.drawingName || null,
      memberIds: g.memberIds || []
    }])),
    /* deviceId -> { categoryId: [groupId] } */
    deviceGroups: Object.fromEntries(modelGroups.map(r => [r.id, r.byCategory]))
  };
  const paidDir = path.join(__dirname, '..', 'api', '_data');
  fs.mkdirSync(paidDir, { recursive: true });
  fs.writeFileSync(path.join(paidDir, 'parts.json'), JSON.stringify(paid));

  const gz = zlib.gzipSync(Buffer.from(json)).length;
  const raw = Buffer.byteLength(json);
  const kb = n => (n / 1024).toFixed(0) + ' KB';

  const counts = {};
  modelRows.forEach(r => { counts[r[13]] = (counts[r[13]] || 0) + 1; });

  console.log('\n  runtime bundle -> assets/dataset.json');
  console.log('  ' + '-'.repeat(50));
  console.log('  models     ', modelRows.length, JSON.stringify(counts));
  console.log('  groups     ', groupRows.length);
  console.log('  devices    ', Object.keys(mgPublic).length, 'with group lists');
  console.log('  brands     ', bundle.brands.length);
  console.log('  categories ', bundle.categories.length);
  console.log('  ' + '-'.repeat(50));
  const paidBytes = fs.statSync(path.join(paidDir, 'parts.json')).size;
  console.log('  raw        ', kb(raw));
  console.log('  gzipped    ', kb(gz), ' <- what the browser downloads');
  console.log('  ' + '-'.repeat(50));
  console.log('  paid slice ', kb(paidBytes), '-> api/_data/parts.json (never served)');
  console.log('  ' + '-'.repeat(50));
  console.log('  PUBLIC: part codes', groups.filter(g => g.partCode).length,
              '· OEM part numbers', groups.filter(g => g.oemPartNo).length,
              '· fitments', groups.reduce((s, g) => s + (g.memberIds || []).length, 0));
  console.log('  Everything above is in assets/dataset.json and downloadable');
  console.log('  without signing in. That is the configured behaviour.');
  console.log();
}

main();
