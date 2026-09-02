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
        partNo: (g.modelNo || '').trim() || null,
        drawingName: g.originalDrawingName || null,
        masterModelId: masterId,
        masterModelName: masterModel ? masterModel.name : String(g.name).trim(),
        masterBrandId: masterModel ? masterModel.brandId : null,
        memberIds,
        memberNames,
        memberCount: memberIds.length,
        searchTokens: [...new Set([
          ...(masterModel ? masterModel.tokens : loose(g.name).split(' ')),
          ...loose(g.modelNo || '').split(' ').filter(Boolean)
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
  console.log('  unresolved member rows       :', unresolved.length);
  console.log('  unresolved masters           :', (report.anomalies.unresolvedMasters || []).length);
  console.log('  groups with no members       :', (report.anomalies.emptyGroups || []).length);
  console.log('\n  per category:');
  CATEGORIES.forEach(c => {
    const gs = groups.filter(g => g.categoryId === c.id);
    console.log('   ', c.name.padEnd(15), String(gs.length).padStart(5), 'groups',
      String(gs.reduce((n, g) => n + g.memberCount, 0)).padStart(6), 'fitments');
  });
  console.log('\n  full report -> data/build/report.json\n');
}

build();
