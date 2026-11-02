/* ============================================================================
   Mobile Parts Finder · scripts/merge-dashboard-catalogue.js
   ----------------------------------------------------------------------------
   Brings the Dashboard project's newer device list — and, when the owner has
   exported them, its newer compatibility groups — into this catalogue as a
   MERGE, never a replace.

     node scripts/merge-dashboard-catalogue.js                    dry run
     node scripts/merge-dashboard-catalogue.js --compat <dir>     + the owner's
                                                                   category exports
     node scripts/merge-dashboard-catalogue.js --apply            add the models

   WHAT IT READS. Files, not a connection (api/_schema/projects.js): the
   Dashboard checkout's js/device-data.js and js/compat-data.js, and optionally
   a folder of the per-category JSON files its owner-only Compatibility export
   downloads (<category>.json — the static seed plus every group edited in that
   project since). No credential for that project is used or needed, and
   nothing is written to it.

   THE RULES OF THE MERGE
     · A device this catalogue already has is never changed. Same id, or the
       same GSMArena page under another name, is the same device: every field
       the two disagree on is listed as a conflict, every gap the other side
       could fill is listed as a suggestion, and neither is applied.
     · A device is new only when no id and no GSMArena page match. A name that
       merely looks alike ("Galaxy A5" next to "Galaxy A5 (2017)") is a
       different phone when the two source pages differ, and is reported, not
       merged. Without a source page to tell them apart it is a conflict.
     · Watches and bands are left out: this is a phone and tablet parts
       catalogue.
     · Groups are only REPORTED: new groups, devices a group of ours lacks, and
       every disagreement. A group change in production goes through
       Compatibility Management, which writes the ledger the next build replays
       — a group written here would be undone by that build. With no exported
       ledger (data/raw/approved-compatibilities.json) the comparison is
       against the baseline build and the report says so.

   --apply adds the new models, and only them:
     data/raw/added_models.json   the rows, in the workbook's shape, read by
                                  scripts/build-dataset.js on every full build
     data/build/models.ndjson     appended; no existing line changes
     data/build/brands.ndjson     model counts; new brands appended
     data/build/meta.json         counts and a new version
     data/build/search-index.json and assets/search-index.json
   Then: node scripts/build-runtime-bundle.js && node scripts/build-seo.js

   The report goes to data/raw/dashboard-merge-report.{json,md} (git-ignored:
   it names group members, which are the paid half of the catalogue).
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { applyApprovedOverlay, modelFromRow, slug, loose, CATEGORIES } = require('./build-dataset');

const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf('--' + name); return i > -1 ? argv[i + 1] : def; };
const has = name => argv.indexOf('--' + name) > -1;

const FROM = flag('from', 'C:/Dev/DashBoard');
const COMPAT_DIR = flag('compat', null);
const APPLY = has('apply');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'data', 'build');
const RAW = path.join(ROOT, 'data', 'raw');
const ADDED = path.join(RAW, 'added_models.json');
const LEDGER = path.join(RAW, 'approved-compatibilities.json');
const REPORT = path.join(RAW, 'dashboard-merge-report');

/* the device types a phone-and-tablet parts catalogue carries */
const KEEP_TYPES = new Set(['Smartphone', 'Tablet']);
/* the fields compared on a device both sides have */
const FIELDS = ['releaseDate', 'sizeInch', 'heightMm', 'widthMm', 'screenCm2', 'bodyRatio', 'batteryMah', 'image', 'gsmarenaUrl'];

/* ------------------------------------------------------------------ input */
/* `window.X = <json>;` assignments, parsed as JSON — the files are data and
   are never executed. */
function readWindowJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = {};
  const marks = [];
  const re = /window\.([A-Z_]+)\s*=\s*/g;
  let m;
  while ((m = re.exec(text))) marks.push({ name: m[1], start: m.index, body: re.lastIndex });
  marks.forEach((k, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    out[k.name] = JSON.parse(text.slice(k.body, end).trim().replace(/;$/, ''));
  });
  return out;
}

function readNdjson(file) {
  return fs.readFileSync(path.join(BUILD, file), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}
const writeNdjson = (file, rows) => fs.writeFileSync(path.join(BUILD, file), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

const gsmId = url => { const m = String(url || '').match(/-(\d+)\.php/); return m ? m[1] : null; };
const same = (a, b) => (typeof a === 'number' && typeof b === 'number') ? Math.abs(a - b) < 1e-9 : a === b;

/* ------------------------------------------------------------------ models */
function compareModels(seed, mpfModels) {
  const byId = new Map(mpfModels.map(m => [m.id, m]));
  const byGsm = new Map();
  const byLoose = new Map();
  mpfModels.forEach(m => {
    const g = gsmId(m.gsmarenaUrl);
    if (g && !byGsm.has(g)) byGsm.set(g, m.id);
    const k = loose(m.name);
    if (!byLoose.has(k)) byLoose.set(k, []);
    byLoose.get(k).push(m.id);
  });
  /* an added device takes the brand spelling this catalogue already shows */
  const brandName = new Map(mpfModels.map(m => [m.brandId, m.brand]));

  const out = { existing: 0, added: [], lookAlikes: [], skippedTypes: [], identityConflicts: [],
                fieldConflicts: [], gapSuggestions: [] };
  const newIds = new Map();
  const newGsm = new Map();

  seed.forEach(d => {
    const row = {
      brand: brandName.get(slug(d.b)) || d.b, sheet: brandName.get(slug(d.b)) || d.b,
      name: d.m, release: d.rd || null,
      size: d.sp && d.sp.sz, h: d.sp && d.sp.h, w: d.sp && d.sp.w,
      scr: d.sp && d.sp.sr, ratio: d.sp && d.sp.br, mah: d.sp && d.sp.bat,
      gsm: d.src || null, img: d.img || null
    };
    const theirs = modelFromRow(row);
    const g = gsmId(d.src);
    const mine = byId.get(theirs.id) || (g && byGsm.has(g) ? byId.get(byGsm.get(g)) : null);

    if (mine) {
      out.existing++;
      if (mine.id !== theirs.id) {
        out.identityConflicts.push({ kind: 'same-source-page-other-name', ours: mine.name, theirs: d.m, oursId: mine.id });
      } else if (g && gsmId(mine.gsmarenaUrl) && g !== gsmId(mine.gsmarenaUrl)) {
        out.identityConflicts.push({ kind: 'same-name-other-source-page', ours: mine.name, theirs: d.m, oursUrl: mine.gsmarenaUrl, theirsUrl: d.src });
      }
      FIELDS.forEach(f => {
        const a = mine[f], b = theirs[f];
        if (b == null || b === '' || same(a, b)) return;
        if (a == null || a === '') out.gapSuggestions.push({ id: mine.id, name: mine.name, field: f, theirs: b });
        else out.fieldConflicts.push({ id: mine.id, name: mine.name, field: f, ours: a, theirs: b });
      });
      return;
    }

    if (!KEEP_TYPES.has(d.c)) { out.skippedTypes.push({ name: d.m, type: d.c }); return; }

    const alike = (byLoose.get(loose(d.m)) || []).map(id => byId.get(id));
    if (alike.length && !g) {
      out.identityConflicts.push({ kind: 'look-alike-without-source-page', ours: alike.map(m => m.name).join(' / '), theirs: d.m });
      return;
    }
    if (newIds.has(theirs.id)) { out.identityConflicts.push({ kind: 'duplicate-in-their-list', ours: null, theirs: d.m }); return; }
    if (g && newGsm.has(g)) { out.identityConflicts.push({ kind: 'same-source-page-twice-in-their-list', ours: newGsm.get(g), theirs: d.m }); return; }
    if (alike.length) out.lookAlikes.push({ added: d.m, ours: alike.map(m => m.name), theirsUrl: d.src });
    newIds.set(theirs.id, d.m);
    if (g) newGsm.set(g, d.m);
    out.added.push({ row, model: theirs, type: d.c });
  });
  return out;
}

/* ------------------------------------------------------------------ groups */
function dashboardGroups(compat) {
  const groups = (compat.COMPAT_GROUPS || []).map(g => ({ id: g.id, cat: g.cat, master: g.master, models: g.models || [], from: 'js/compat-data.js' }));
  if (!COMPAT_DIR) return { groups, exported: [] };
  /* an owner export is the seed PLUS that project's later edits, so for its
     category it replaces the seed outright */
  const exported = [];
  fs.readdirSync(COMPAT_DIR).filter(f => f.endsWith('.json')).forEach(f => {
    const file = JSON.parse(fs.readFileSync(path.join(COMPAT_DIR, f), 'utf8'));
    const cat = file.categoryKey || slug(file.category || path.basename(f, '.json'));
    exported.push({ file: f, category: cat, groups: (file.groups || []).length, exportedAt: file.exportedAt || null });
    for (let i = groups.length - 1; i >= 0; i--) if (groups[i].cat === cat) groups.splice(i, 1);
    (file.groups || []).forEach((g, n) => {
      const master = String(g.name || g.originalDrawingName || '').trim();
      const names = (g.compatibleModels || []).map(cm => String(cm.name || cm.mobileModelName || '').trim()).filter(Boolean);
      if (master && names.indexOf(master) < 0) names.unshift(master);
      groups.push({ id: g.groupNo || g.id || `${cat}#${n + 1}`, cat, master, models: names, from: f });
    });
  });
  return { groups, exported };
}

function compareGroups(dash, mpfGroups, modelsById, removedByUs) {
  /* resolution: the strict id first (ours or one being added), then the loose
     key — but only when exactly one of our devices has it */
  const looseIds = new Map();
  modelsById.forEach(m => { const k = loose(m.name); looseIds.set(k, (looseIds.get(k) || []).concat(m.id)); });
  const resolve = name => {
    const s = slug(name);
    if (modelsById.has(s)) return { id: s, strict: true };
    const l = looseIds.get(loose(name)) || [];
    return l.length === 1 ? { id: l[0], strict: false } : null;
  };
  const holder = new Map();
  mpfGroups.forEach(g => g.memberIds.forEach(id => holder.set(g.categoryId + '|' + id, g)));
  const cats = new Set(CATEGORIES.map(c => c.id));

  const out = { compared: 0, identical: 0, newGroups: [], addedMembers: [], conflicts: [], unresolved: [], unknownCategories: {} };
  dash.forEach(g => {
    if (!cats.has(g.cat)) { out.unknownCategories[g.cat] = (out.unknownCategories[g.cat] || 0) + 1; return; }
    out.compared++;
    const members = [];
    g.models.forEach(n => {
      const r = resolve(n);
      if (!r) out.unresolved.push({ category: g.cat, group: g.id, name: n });
      else if (!members.some(x => x.id === r.id)) members.push(Object.assign({ name: n }, r));
    });
    const masterRes = resolve(g.master);
    const ours = new Map();
    members.forEach(x => { const h = holder.get(g.cat + '|' + x.id); if (h) ours.set(h.id, h); });

    if (!ours.size) {
      if (members.length < 2) return;
      const blocked = members.filter(x => removedByUs.has(g.cat + '|' + x.id));
      if (blocked.length) {
        out.conflicts.push({ kind: 'new-group-with-devices-we-removed', category: g.cat, group: g.id, devices: blocked.map(x => x.id) });
        return;
      }
      out.newGroups.push({ category: g.cat, group: g.id, master: masterRes ? masterRes.id : g.master,
                           memberIds: members.map(x => x.id), looseOnly: members.filter(x => !x.strict).map(x => x.name), from: g.from });
      return;
    }
    if (ours.size > 1) {
      out.conflicts.push({ kind: 'spans-several-of-our-groups', category: g.cat, group: g.id, ourGroups: [...ours.keys()] });
      return;
    }
    const mine = [...ours.values()][0];
    let changed = false;
    members.forEach(x => {
      if (mine.memberIds.indexOf(x.id) > -1) return;
      changed = true;
      if (holder.get(g.cat + '|' + x.id)) return;            /* in another group: covered by spans-several */
      if (removedByUs.has(g.cat + '|' + x.id)) {
        out.conflicts.push({ kind: 'device-we-removed', category: g.cat, group: g.id, ourGroup: mine.id, device: x.id });
      } else if (!x.strict) {
        out.conflicts.push({ kind: 'name-matches-only-loosely', category: g.cat, group: g.id, ourGroup: mine.id, name: x.name, device: x.id });
      } else {
        out.addedMembers.push({ category: g.cat, group: g.id, ourGroup: mine.id, partCode: mine.partCode, device: x.id });
      }
    });
    if (masterRes && mine.masterModelId && masterRes.id !== mine.masterModelId && mine.memberIds.indexOf(masterRes.id) > -1) {
      changed = true;
      out.conflicts.push({ kind: 'different-master', category: g.cat, group: g.id, ourGroup: mine.id, ourMaster: mine.masterModelId, theirMaster: masterRes.id });
    }
    if (!changed) out.identical++;
  });
  return out;
}

/* ------------------------------------------------------------------ apply */
function applyModels(added, mpfModels) {
  const have = new Set(mpfModels.map(m => m.id));
  const fresh = added.filter(a => !have.has(a.model.id));

  /* the build input, merged by id so a re-run never doubles a row */
  const rows = fs.existsSync(ADDED) ? JSON.parse(fs.readFileSync(ADDED, 'utf8')) : [];
  const rowIds = new Set(rows.map(r => slug(r.name)));
  added.forEach(a => { if (!rowIds.has(a.model.id)) rows.push(a.row); });
  fs.writeFileSync(ADDED, JSON.stringify(rows, null, 1));
  if (!fresh.length) return { appended: 0 };

  const models = mpfModels.concat(fresh.map(a => a.model));
  writeNdjson('models.ndjson', models);

  /* brands: counts recomputed, group counts kept, new brands appended — the
     same rollup scripts/build-dataset.js makes */
  const brands = readNdjson('brands.ndjson');
  const byId = new Map(brands.map(b => [b.id, b]));
  models.forEach(m => { if (!byId.has(m.brandId)) { const b = { id: m.brandId, name: m.brand, modelCount: 0, groupCount: 0 }; byId.set(b.id, b); brands.push(b); } });
  brands.forEach(b => { b.modelCount = 0; });
  models.forEach(m => { byId.get(m.brandId).modelCount++; });
  writeNdjson('brands.ndjson', brands);

  const version = Date.now();
  const generatedAt = new Date(version).toISOString();
  const metaFile = path.join(BUILD, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  meta.version = version;
  meta.generatedAt = generatedAt;
  meta.counts.models = models.length;
  meta.counts.brands = brands.length;
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));

  /* the search bundle: the same tuples, a new device has no group yet */
  const index = JSON.parse(fs.readFileSync(path.join(BUILD, 'search-index.json'), 'utf8'));
  index.version = version;
  index.generatedAt = generatedAt;
  index.brands = brands.slice().sort((a, b) => a.name.localeCompare(b.name));
  fresh.forEach(a => {
    const m = a.model;
    index.models.push([m.id, m.name, m.brandId, m.releaseYear || 0, m.sizeInch || 0, m.batteryMah || 0, 0]);
  });
  fs.writeFileSync(path.join(BUILD, 'search-index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(ROOT, 'assets', 'search-index.json'), JSON.stringify(index));
  return { appended: fresh.length, models: models.length, brands: brands.length, version };
}

/* ------------------------------------------------------------------ report */
function markdown(r) {
  const L = [];
  const list = (rows, fmt, max) => { rows.slice(0, max).forEach(x => L.push('- ' + fmt(x))); if (rows.length > max) L.push(`- … and ${rows.length - max} more (see the .json)`); };
  L.push('# Dashboard → Mobile Parts Finder merge', '', `Generated ${r.generatedAt}${r.applied ? ' — APPLIED' : ' — dry run'}`, '');
  L.push('## Sources', '', `- devices: ${r.sources.devices}`, `- groups: ${r.sources.groups}`, `- our groups compared against: ${r.sources.ours}`, '');
  L.push('## Models', '', `| | count |`, `|---|---:|`,
    `| in their list | ${r.models.theirs} |`, `| already ours (kept as is) | ${r.models.existing} |`,
    `| **new — added** | **${r.models.added.length}** |`, `| watches / bands left out | ${r.models.skippedTypes.length} |`,
    `| identity conflicts | ${r.models.identityConflicts.length} |`, `| field conflicts (ours kept) | ${r.models.fieldConflicts.length} |`,
    `| gaps they could fill (not applied) | ${r.models.gapSuggestions.length} |`, '');
  L.push('### New models by brand', '');
  Object.entries(r.models.addedByBrand).sort((a, b) => b[1] - a[1]).forEach(([b, n]) => L.push(`- ${b}: ${n}`));
  L.push('', '### New models released 2025 and later', '');
  list(r.models.added.filter(a => (a.year || 0) >= 2025), a => `${a.name} (${a.year}, ${a.type})`, 400);
  L.push('', '### Added beside a look-alike name (different GSMArena page — a different phone)', '');
  list(r.models.lookAlikes, x => `${x.added} — ours: ${x.ours.join(' / ')}`, 100);
  L.push('', '### Identity conflicts (nothing added or changed)', '');
  list(r.models.identityConflicts, x => `${x.kind}: theirs "${x.theirs}", ours "${x.ours}"`, 100);
  L.push('', '### Field conflicts by field (ours kept)', '');
  Object.entries(r.models.fieldConflictsByField).forEach(([f, n]) => L.push(`- ${f}: ${n}`));
  L.push('', 'First 60:', '');
  list(r.models.fieldConflicts, x => `${x.name} · ${x.field}: ours ${x.ours} — theirs ${x.theirs}`, 60);
  L.push('', '### Gaps they could fill, by field (NOT applied)', '');
  Object.entries(r.models.gapSuggestionsByField).forEach(([f, n]) => L.push(`- ${f}: ${n}`));
  L.push('', '## Groups', '', `| | count |`, `|---|---:|`,
    `| their groups compared | ${r.groups.compared} |`, `| identical to ours | ${r.groups.identical} |`,
    `| new groups | ${r.groups.newGroups.length} |`, `| devices our group lacks | ${r.groups.addedMembers.length} |`,
    `| conflicts | ${r.groups.conflicts.length} |`, `| names that match no device | ${r.groups.unresolved.length} |`, '');
  L.push('### New groups (not applied — enter in Compatibility Management)', '');
  list(r.groups.newGroups, g => `${g.category} ${g.group}: ${g.memberIds.join(', ')}${g.looseOnly.length ? ' (loose: ' + g.looseOnly.join(', ') + ')' : ''}`, 200);
  L.push('', '### Devices our group lacks (not applied — add in Compatibility Management)', '');
  list(r.groups.addedMembers, x => `${x.category} ${x.partCode || x.ourGroup}: + ${x.device} (theirs ${x.group})`, 300);
  L.push('', '### Group conflicts (ours kept)', '');
  list(r.groups.conflicts, c => `${c.kind} · ${c.category} ${c.group}` + (c.ourGroups ? ` → ours ${c.ourGroups.join(' + ')}` : '') +
    (c.ourGroup ? ` → ours ${c.ourGroup}` : '') + (c.device ? ` · ${c.device}` : '') +
    (c.ourMaster ? ` · our master ${c.ourMaster}, theirs ${c.theirMaster}` : '') + (c.devices ? ` · ${c.devices.join(', ')}` : ''), 300);
  L.push('', '### Names in their groups that match no device', '');
  list(r.groups.unresolved, u => `${u.category} ${u.group}: "${u.name}"`, 100);
  return L.join('\n') + '\n';
}

/* ------------------------------------------------------------------ run */
function main() {
  const devices = readWindowJson(path.join(FROM, 'js', 'device-data.js')).DEVICE_SEED;
  const compat = readWindowJson(path.join(FROM, 'js', 'compat-data.js'));
  if (!Array.isArray(devices)) throw new Error('no DEVICE_SEED in ' + path.join(FROM, 'js', 'device-data.js'));

  const mpfModels = readNdjson('models.ndjson');
  const models = compareModels(devices, mpfModels);

  /* our groups as production holds them: the baseline build, with the ledger
     replayed over it when it has been exported */
  const groups = readNdjson('groups.ndjson');
  const modelsById = new Map(mpfModels.concat(models.added.map(a => a.model)).map(m => [m.id, m]));
  let ours = 'data/build/groups.ndjson — the baseline; the ledger was NOT read, so edits made in production since are not seen';
  const removedByUs = new Set();
  if (fs.existsSync(LEDGER)) {
    const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    const mg = new Map(readNdjson('modelGroups.ndjson').map(r => [r.id, r.byCategory]));
    const ov = applyApprovedOverlay(ledger, groups, modelsById, mg);
    groups.push(...ov.runtimeGroups);
    (ledger.entries || []).filter(e => ['reverted', 'cancelled'].indexOf(e.status) < 0).forEach(e => {
      if (e.kind === 'remove_model' && e.removedModelId) removedByUs.add(e.categoryId + '|' + e.removedModelId);
      if (e.kind === 'delete_group') (e.memberIds || [e.anchorModelId]).forEach(id => id && removedByUs.add(e.categoryId + '|' + id));
    });
    ours = `data/build/groups.ndjson + the ledger (${(ledger.entries || []).length} entries, exported ${ledger.exportedAt || 'unknown'})`;
  }
  const dash = dashboardGroups(compat);
  const grp = compareGroups(dash.groups, groups, modelsById, removedByUs);

  const count = (rows, key) => rows.reduce((o, x) => (o[x[key]] = (o[x[key]] || 0) + 1, o), {});
  const report = {
    generatedAt: new Date().toISOString(),
    applied: false,
    sources: {
      devices: `${FROM}/js/device-data.js (${devices.length} records)`,
      groups: COMPAT_DIR
        ? `${FROM}/js/compat-data.js, replaced per category by the exports in ${COMPAT_DIR}: ` + dash.exported.map(e => `${e.category} (${e.groups})`).join(', ')
        : `${FROM}/js/compat-data.js only — the static seed. Groups edited in that project since are in its database and need the owner's category exports (--compat)`,
      ours
    },
    models: {
      theirs: devices.length,
      existing: models.existing,
      added: models.added.map(a => ({ id: a.model.id, name: a.model.name, brand: a.model.brand, year: a.model.releaseYear, type: a.type })),
      addedByBrand: count(models.added.map(a => a.model), 'brand'),
      lookAlikes: models.lookAlikes,
      skippedTypes: models.skippedTypes,
      identityConflicts: models.identityConflicts,
      fieldConflicts: models.fieldConflicts,
      fieldConflictsByField: count(models.fieldConflicts, 'field'),
      gapSuggestions: models.gapSuggestions,
      gapSuggestionsByField: count(models.gapSuggestions, 'field')
    },
    groups: grp
  };

  if (APPLY) {
    report.applied = applyModels(models.added, mpfModels);
  }

  fs.mkdirSync(RAW, { recursive: true });
  fs.writeFileSync(REPORT + '.json', JSON.stringify(report, null, 1));
  fs.writeFileSync(REPORT + '.md', markdown(report));

  console.log('\n  Dashboard → Mobile Parts Finder merge' + (APPLY ? '' : ' (dry run)'));
  console.log('  ' + '-'.repeat(52));
  console.log('  their devices        ', devices.length);
  console.log('  already ours (kept)  ', models.existing);
  console.log('  NEW models           ', models.added.length, ' (', Object.keys(report.models.addedByBrand).length, 'brands )');
  console.log('  watches/bands skipped', models.skippedTypes.length);
  console.log('  identity conflicts   ', models.identityConflicts.length);
  console.log('  field conflicts      ', models.fieldConflicts.length, '(ours kept)');
  console.log('  gap suggestions      ', models.gapSuggestions.length, '(not applied)');
  console.log('  groups compared      ', grp.compared, '· identical', grp.identical);
  console.log('  new groups           ', grp.newGroups.length);
  console.log('  members ours lack    ', grp.addedMembers.length);
  console.log('  group conflicts      ', grp.conflicts.length);
  console.log('  unresolved names     ', grp.unresolved.length);
  console.log('  ours compared against:', ours);
  if (APPLY) console.log('  applied              ', JSON.stringify(report.applied));
  console.log('  report  ->', path.relative(ROOT, REPORT + '.md'), '\n');
}

main();
