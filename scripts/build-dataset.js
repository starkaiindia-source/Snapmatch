/* ============================================================================
   Mobile Parts Finder · scripts/build-dataset.js
   ----------------------------------------------------------------------------
   ETL for the REAL production data. Reads the six category exports and the
   brand/model workbook, normalises them, and writes Firestore-ready documents
   plus a static search bundle.

     node scripts/build-dataset.js --src "C:/Users/stark/Downloads"

   Inputs
     <src>/All_Brands_Models.xlsx      22 brand sheets, 4,933 models
     <src>/battery_export.json         Battery
     <src>/back_cover_export.json      Back Cover
     <src>/cc_board_export.json        CC Board
     <src>/combo_display_export.json   Combo/Display
     <src>/middle_frame_export.json    Middle Frame
     <src>/screen_guards_export.json   Screen Guards

   Outputs (data/build/)
     models.ndjson        one canonical model per line          -> /models
     groups.ndjson        one compatibility group per line      -> /groups
     modelGroups.ndjson   model -> matching group ids by category-> /modelGroups
     brands.ndjson        brand rollups                          -> /brands
     meta.json            counts + version stamp                 -> /catalog/meta
     search-index.json    static bundle for zero-read search
     report.json          full ETL report incl. every anomaly

   Nothing is invented here. Rows that cannot be resolved are reported, never
   silently dropped or filled in.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const SRC = (() => {
  const i = args.indexOf('--src');
  return i > -1 ? args[i + 1] : 'C:/Users/stark/Downloads';
})();
const OUT = path.join(__dirname, '..', 'data', 'build');

const CATEGORIES = [
  { file: 'screen_guards_export.json', id: 'screen-guards', name: 'Screen Guards', short: 'Guard', code: 'SG', order: 1 },
  { file: 'back_cover_export.json', id: 'back-cover', name: 'Back Cover', short: 'Cover', code: 'BC', order: 2 },
  { file: 'combo_display_export.json', id: 'combo-display', name: 'Combo/Display', short: 'Display', code: 'CD', order: 3 },
  { file: 'middle_frame_export.json', id: 'middle-frame', name: 'Middle Frame', short: 'Frame', code: 'MF', order: 4 },
  { file: 'cc_board_export.json', id: 'cc-board', name: 'CC Board', short: 'CC Board', code: 'CC', order: 5 },
  { file: 'battery_export.json', id: 'battery', name: 'Battery', short: 'Battery', code: 'BT', order: 6 }
];

/* --------------------------------------------------------------- helpers */
/* "+" is meaningful in model names (Honor 30 Pro vs Honor 30 Pro+), so it is
   spelled out before slugging instead of being stripped. */
function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
/* relaxed key, used only as a fallback when a strict slug misses */
function loose(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
/* "26/10/2022" -> { iso:"2022-10-26", year:2022 } */
function parseDate(v) {
  if (!v) return { iso: null, year: null };
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return { iso: `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`, year: +m[3] };
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { iso: s.slice(0, 10), year: +m[1] };
  const y = s.match(/(19|20)\d{2}/);
  return { iso: null, year: y ? +y[0] : null };
}
/* search tokens: whole words plus a compact form, so "a11" and "galaxya11" hit */
function tokens(name, brand) {
  const t = new Set();
  loose(`${brand} ${name}`).split(' ').forEach(w => { if (w) t.add(w); });
  t.add(loose(`${brand} ${name}`).replace(/ /g, ''));
  return [...t];
}

/* ------------------------------------------------------- part numbers

   THE SOURCE `modelNo` COLUMN IS MOSTLY NOT A PART NUMBER.

   Measured across all six exports: combo-display is the string "1" 567 times,
   middle-frame "1" 675 times, cc-board "asdf" 56 times, back-cover "adsf" 26
   times, screen-guards is empty throughout. Battery is the exception — every
   one of its 288 rows carries a genuine manufacturer code (EB-BA115ABY, NT01,
   GVYZ7, B-V7).

   Showing "asdf" to a shop as a part code is worse than showing nothing: it
   gets written on a bag, read down a phone to a supplier, and ordered against.
   So a source value has to earn the name. A manufacturer code is upper-case,
   carries digits, and is not simply the device's own name — which is what the
   back-cover column mostly holds ("OnePlus 15R", "Asus ROG Phone 6").

   This keeps 287 of 3,350 and rejects the rest. Every group still gets a part
   code: ours, issued below, which is what the app is for.

   @param {string} v      the raw modelNo cell
   @param {Set<string>}   loose-keyed names of every catalogue device
   @returns {string|null} the code, or null when the cell is not one
*/
function oemPartNo(v, deviceNames) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (deviceNames.has(loose(s))) return null;        /* a device name, not a part */
  /* "EB-BA115ABY (4000 mAh)" -> "EB-BA115ABY": the capacity is an annotation,
     the code is the first token. */
  const head = s.split(/[\s(]/)[0].replace(/[,.]+$/, '');
  if (head.length < 3) return null;                  /* "1", "ab" */
  if (!/[A-Z]/.test(head)) return null;              /* "asdf", "wer42e", "mi 8 pro" */
  if (!/[0-9]/.test(head)) return null;              /* "DFAHDFH", "GHHHHHJ" */
  return s;
}

const BRAND_FIX = {
  Huwave: 'Huawei', Moto: 'Motorola', zte: 'ZTE', itel: 'itel',
  HMD: 'HMD', CoolPad: 'Coolpad', OnePlus: 'OnePlus'
};

/* --------------------------------------------------------------- read xlsx */
function readWorkbook() {
  const cached = path.join(__dirname, '..', 'data', 'raw', 'xlsx_models.json');
  if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, 'utf8'));
  throw new Error(
    'data/raw/xlsx_models.json not found.\n' +
    'Generate it once with:\n' +
    '  python scripts/dump-xlsx.py "' + SRC + '/All_Brands_Models.xlsx"'
  );
}

/* ================================================================== build */
function build() {
  const report = { source: SRC, startedAt: new Date().toISOString(), anomalies: {}, counts: {} };

  /* ---- 1. canonical models from the workbook ---- */
  const raw = readWorkbook();
  const models = new Map();      // id -> model
  const byLoose = new Map();     // loose key -> id (fallback lookup)
  const dupNames = [];

  raw.forEach(r => {
    const brand = BRAND_FIX[r.brand] || r.brand;
    const name = String(r.name).trim();
    const id = slug(name);
    if (models.has(id)) { dupNames.push(name); return; }
    const d = parseDate(r.release);
    const m = {
      id, brand, brandId: slug(brand), name,
      nameLower: name.toLowerCase(),
      tokens: tokens(name, brand),
      releaseDate: d.iso, releaseYear: d.year,
      sizeInch: num(r.size), heightMm: num(r.h), widthMm: num(r.w),
      screenCm2: num(r.scr), bodyRatio: num(r.ratio), batteryMah: num(r.mah),
      gsmarenaUrl: r.gsm || null, image: r.img || null
    };
    models.set(id, m);
    const lk = loose(name);
    if (!byLoose.has(lk)) byLoose.set(lk, id);
  });
  report.anomalies.duplicateModelRows = dupNames;
  report.counts.models = models.size;

  /* ---- 2. groups from the six category exports ---- */
  const groups = [];
  const modelGroups = new Map();  // modelId -> { categoryId: [groupId] }
  const unresolved = [];          // names present in exports but not in the workbook
  let seq = 0;

  /* Every device name in the catalogue, loose-keyed. oemPartNo uses it to spot
     a "part number" cell that is really the device's own name. */
  const deviceNames = new Set([...models.values()].map(m => loose(m.name)));

  /* Facts the exports carry PER DEVICE that the workbook does not, gathered as
     the members are walked. The workbook is still the source for anything both
     of them have — this only fills gaps, and only from the export's own rows.

     Nothing here is derived or guessed. screenType is Flat/Curved as recorded,
     batteryModelNo1 is the manufacturer's own battery code, and
     batteryModelStatus says whether the owner has verified it — which is worth
     carrying precisely because it is an admission rather than a claim. */
  const extra = new Map();        // modelId -> { screenType, batteryPartNo, ... }
  function noteModelFacts(id, cm) {
    if (!id) return;
    const e = extra.get(id) || {};
    const st = String(cm.screenType || '').trim();
    if (st && !e.screenType) e.screenType = st;
    const bp = String(cm.batteryModelNo1 || cm.batteryModelNo || '').trim();
    if (bp && !e.batteryPartNo) {
      e.batteryPartNo = bp;
      e.batteryPartVerified = cm.batteryModelStatus === 'verified';
    }
    const rs = String(cm.releaseStatus || '').trim();
    if (rs && !e.releaseStatus) e.releaseStatus = rs;
    extra.set(id, e);
  }

  function resolve(name) {
    const s = slug(name);
    if (models.has(s)) return s;
    const l = byLoose.get(loose(name));
    return l || null;
  }

  CATEGORIES.forEach(cat => {
    const file = path.join(SRC, cat.file);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    let catSeq = 0;

    (data.groups || []).forEach(g => {
      const memberIds = [];
      const memberNames = [];
      (g.compatibleModels || []).forEach(cm => {
        const nm = String(cm.mobileModelName || cm.name || '').trim();
        if (!nm) return;
        const id = resolve(nm);
        if (!id) { unresolved.push({ category: cat.id, group: g.name, model: nm }); return; }
        noteModelFacts(id, cm);
        if (memberIds.indexOf(id) === -1) { memberIds.push(id); memberNames.push(models.get(id).name); }
      });

      /* a group with no resolvable members carries no information — record it */
      if (!memberIds.length) {
        report.anomalies.emptyGroups = report.anomalies.emptyGroups || [];
        report.anomalies.emptyGroups.push({ category: cat.id, name: g.name, partNo: g.modelNo || null });
        return;
      }

      const masterId = resolve(g.name);
      if (!masterId) {
        report.anomalies.unresolvedMasters = report.anomalies.unresolvedMasters || [];
        report.anomalies.unresolvedMasters.push({ category: cat.id, name: g.name });
      }
      /* master must be part of its own group */
      if (masterId && memberIds.indexOf(masterId) === -1) {
        memberIds.unshift(masterId); memberNames.unshift(models.get(masterId).name);
      }

      catSeq++; seq++;
      const gid = `${cat.code.toLowerCase()}-${String(catSeq).padStart(4, '0')}`;
      const masterModel = masterId ? models.get(masterId) : null;

      groups.push({
        id: gid,
        groupNo: `${cat.code}-${String(catSeq).padStart(4, '0')}`,
        serialNo: `MPF-SN-${String(seq).padStart(6, '0')}`,
        categoryId: cat.id,
        categoryName: cat.name,
        /* OUR part code. Every group gets one, it is stable, and it is what a
           shop writes on the bag — MPF-BT-0001. It is issued from the category
           and the sequence, so it cannot collide and cannot go missing. */
        partCode: `MPF-${cat.code}-${String(catSeq).padStart(4, '0')}`,
        /* The manufacturer's own code, kept ONLY where the source really has
           one. null is the honest answer for 3,063 of 3,340 groups; the
           alternative is publishing "asdf" as a part number. */
        oemPartNo: oemPartNo(g.modelNo, deviceNames),
        /* Kept verbatim for the audit trail — what the export actually said,
           whatever it was. Never rendered. */
        sourcePartNo: (g.modelNo || '').trim() || null,
        drawingName: g.originalDrawingName || null,
        masterModelId: masterId,
        masterModelName: masterModel ? masterModel.name : String(g.name).trim(),
        masterBrandId: masterModel ? masterModel.brandId : null,
        memberIds,
        memberNames,
        memberCount: memberIds.length,
        /* Indexed so "MPF-BT-0001" and "EB-BA115ABY" both find the group.
           The raw source cell is deliberately NOT indexed: nobody searches for
           "asdf", and 567 groups sharing the token "1" is not an index. */
        searchTokens: [...new Set([
          ...(masterModel ? masterModel.tokens : loose(g.name).split(' ')),
          ...loose(`MPF-${cat.code}-${String(catSeq).padStart(4, '0')}`).split(' '),
          ...loose(oemPartNo(g.modelNo, deviceNames) || '').split(' ')
        ])].filter(Boolean).slice(0, 60)
      });

      memberIds.forEach(mid => {
        if (!modelGroups.has(mid)) modelGroups.set(mid, {});
        const byCat = modelGroups.get(mid);
        (byCat[cat.id] = byCat[cat.id] || []).push(gid);
      });
    });
  });

  report.anomalies.unresolvedMembers = unresolved;
  report.counts.groups = groups.length;
  report.counts.modelGroupDocs = modelGroups.size;

  /* ---- 2b. fold the per-device facts the exports carry into the models ----

     The workbook gives name, brand, date, size, dimensions and battery. The
     category exports carry three more things about the same devices, and until
     now they were read only to resolve a member name and then thrown away:

       screenType         Flat / Curved — 260 devices
       batteryModelNo1    the battery's own manufacturer code — 275 devices
       releaseStatus      available / coming_soon / cancelled — all of them

     Coverage is partial and stays partial. A device the exports never mention
     keeps a null, and the UI omits the row rather than guessing: "Flat" on a
     phone nobody recorded is a claim, not a blank. */
  let withScreenType = 0, withBatteryPart = 0, withStatus = 0;
  extra.forEach((e, id) => {
    const m = models.get(id);
    if (!m) return;
    if (e.screenType) { m.screenType = e.screenType; withScreenType++; }
    if (e.batteryPartNo) {
      m.batteryPartNo = e.batteryPartNo;
      m.batteryPartVerified = !!e.batteryPartVerified;
      withBatteryPart++;
    }
    if (e.releaseStatus) { m.releaseStatus = e.releaseStatus; withStatus++; }
  });
  report.counts.modelsWithScreenType = withScreenType;
  report.counts.modelsWithBatteryPartNo = withBatteryPart;
  report.counts.modelsWithReleaseStatus = withStatus;

  /* What the part-number column actually yielded, so the number is visible in
     the report rather than being something you have to go and measure. */
  report.counts.groupsWithOemPartNo = groups.filter(g => g.oemPartNo).length;
  report.anomalies.rejectedSourcePartNos = [...new Set(
    groups.filter(g => g.sourcePartNo && !g.oemPartNo).map(g => g.sourcePartNo)
  )].sort();

  /* ---- 3. brand rollups ---- */
  const brands = new Map();
  models.forEach(m => {
    if (!brands.has(m.brandId)) brands.set(m.brandId, { id: m.brandId, name: m.brand, modelCount: 0, groupCount: 0 });
    brands.get(m.brandId).modelCount++;
  });
  groups.forEach(g => { if (g.masterBrandId && brands.has(g.masterBrandId)) brands.get(g.masterBrandId).groupCount++; });
  report.counts.brands = brands.size;

  /* ---- 4. static search bundle (zero Firestore reads for autocomplete) ---- */
  const searchIndex = {
    version: Date.now(),
    generatedAt: new Date().toISOString(),
    categories: CATEGORIES.map(c => ({
      id: c.id, name: c.name, short: c.short, code: c.code, order: c.order,
      groupCount: groups.filter(g => g.categoryId === c.id).length
    })),
    brands: [...brands.values()].sort((a, b) => a.name.localeCompare(b.name)),
    /* compact tuples keep the payload small: [id, name, brandId, year, size, mah, catMask] */
    models: [...models.values()].map(m => {
      const mg = modelGroups.get(m.id) || {};
      let mask = 0;
      CATEGORIES.forEach((c, i) => { if (mg[c.id] && mg[c.id].length) mask |= (1 << i); });
      return [m.id, m.name, m.brandId, m.releaseYear || 0, m.sizeInch || 0, m.batteryMah || 0, mask];
    })
  };

  /* ---- 5. write ---- */
  fs.mkdirSync(OUT, { recursive: true });
  const nd = (file, rows) => {
    fs.writeFileSync(path.join(OUT, file), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    return rows.length;
  };
  nd('models.ndjson', [...models.values()]);
  nd('groups.ndjson', groups);
  nd('brands.ndjson', [...brands.values()]);
  nd('modelGroups.ndjson', [...modelGroups.entries()].map(([id, byCategory]) => ({ id, byCategory })));

  const meta = {
    version: searchIndex.version,
    generatedAt: searchIndex.generatedAt,
    counts: {
      models: models.size, groups: groups.length, brands: brands.size,
      categories: CATEGORIES.length,
      fitments: groups.reduce((n, g) => n + g.memberCount, 0)
    },
    categories: searchIndex.categories
  };
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));

  /* ---- the part-number worklist ----
     Every group whose manufacturer part number is still unknown, as a CSV that
     opens straight in Excel. This is the one output nobody can generate for
     you: the app issues its own code for every group, so nothing is broken
     without it, but a supplier recognises EB-BA115ABY and not MPF-BT-0001.

     The rejected source value is carried in its own column, so a genuine code
     wrongly thrown out is visible rather than silently lost. */
  const csv = ['partCode,groupNo,category,masterModel,devices,rejectedSourceValue'];
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  groups.filter(g => !g.oemPartNo).forEach(g => {
    csv.push([q(g.partCode), q(g.groupNo), q(g.categoryName), q(g.masterModelName),
              g.memberCount, q(g.sourcePartNo)].join(','));
  });
  fs.writeFileSync(path.join(OUT, 'missing-part-numbers.csv'), csv.join('\n') + '\n');

  fs.writeFileSync(path.join(OUT, 'search-index.json'), JSON.stringify(searchIndex));
  /* also drop it where the static host already serves files, so the client
     can fetch it with zero Firestore reads */
  const served = path.join(__dirname, '..', 'assets', 'search-index.json');
  fs.writeFileSync(served, JSON.stringify(searchIndex));

  report.finishedAt = new Date().toISOString();
  report.counts.fitments = meta.counts.fitments;
  report.anomalies.unresolvedMemberCount = unresolved.length;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  /* ---- 6. console summary ---- */
  const kb = f => (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + ' KB';
  console.log('\n  Mobile Parts Finder — dataset build\n  ' + '-'.repeat(52));
  console.log('  models          ', String(models.size).padStart(6), kb('models.ndjson'));
  console.log('  groups          ', String(groups.length).padStart(6), kb('groups.ndjson'));
  console.log('  modelGroups     ', String(modelGroups.size).padStart(6), kb('modelGroups.ndjson'));
  console.log('  brands          ', String(brands.size).padStart(6), kb('brands.ndjson'));
  console.log('  fitments        ', String(meta.counts.fitments).padStart(6));
  console.log('  search bundle   ', ' '.repeat(6), kb('search-index.json'));
  console.log('  ' + '-'.repeat(52));
  console.log('  duplicate model rows skipped :', dupNames.length);
  console.log('  part codes issued (ours)     :', groups.length);
  console.log('  genuine OEM part numbers     :', report.counts.groupsWithOemPartNo,
              '(' + report.anomalies.rejectedSourcePartNos.length + ' distinct source values rejected as placeholder)');
  console.log('  models + screen type         :', report.counts.modelsWithScreenType);
  console.log('  models + battery part number :', report.counts.modelsWithBatteryPartNo);
  console.log('  unresolved member rows       :', unresolved.length);
  console.log('  unresolved masters           :', (report.anomalies.unresolvedMasters || []).length);
  console.log('  groups with no members       :', (report.anomalies.emptyGroups || []).length);
  console.log('\n  per category:');
  CATEGORIES.forEach(c => {
    const gs = groups.filter(g => g.categoryId === c.id);
    console.log('   ', c.name.padEnd(15), String(gs.length).padStart(5), 'groups',
      String(gs.reduce((n, g) => n + g.memberCount, 0)).padStart(6), 'fitments');
  });
  console.log('\n  full report   -> data/build/report.json');
  console.log('  part worklist -> data/build/missing-part-numbers.csv (' +
              groups.filter(g => !g.oemPartNo).length + ' groups)\n');
}

build();
