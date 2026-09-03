/* ============================================================================
   Mobile Parts Finder · scripts/poc-apple.js
   ----------------------------------------------------------------------------
   The Apple proof of concept. Runs the whole pipeline end to end for a small
   set of real devices and writes nothing to Firestore unless asked:

     collect (official source) -> canonical identity -> alias map
       -> join to the existing real compatibility data
       -> shape Firestore documents -> cost estimate -> report

   Usage
     node scripts/poc-apple.js                 collect, validate, report
     node scripts/poc-apple.js --write --project mobilepartsfinder
     node scripts/poc-apple.js --limit 10      cap the device count

   Output lands in data/build/poc-apple/ as the exact documents that would be
   written, so the schema can be reviewed before anything touches the database.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const apple = require('../backend/adapters/apple-compare');
const { SOURCES, isConfigured } = require('../backend/sources');
const {
  SCHEMA_VERSION, canonicalDeviceId, aliasKey, searchPrefixes, tokens, slug
} = require('../backend/schema');

const argv = process.argv.slice(2);
const has = f => argv.includes('--' + f);
const flag = (f, d) => { const i = argv.indexOf('--' + f); return i > -1 ? argv[i + 1] : d; };

const WRITE = has('write');
const PROJECT = flag('project');
const LIMIT = Number(flag('limit', 10));
const BUILD = path.join(__dirname, '..', 'data', 'build');
const OUT = path.join(BUILD, 'poc-apple');

/* ------------------------------------------------------------ existing data */
function readNdjson(file) {
  const p = path.join(BUILD, file);
  if (!fs.existsSync(p)) throw new Error(`missing ${p} — run: node scripts/build-dataset.js`);
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/* --------------------------------------------------------------------- main */
async function main() {
  const t0 = Date.now();
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '__apple-poc';

  console.log('\n  Mobile Parts Finder — Apple proof of concept');
  console.log('  ' + '='.repeat(66));
  console.log('  run       :', runId);
  console.log('  mode      :', WRITE ? `WRITE to ${PROJECT}` : 'DRY RUN — nothing is written');

  /* ---------------------------------------------------------- 1. collect */
  const src = SOURCES[apple.SOURCE_ID];
  console.log('\n  1. collect from the official source');
  console.log('     source    :', src.name);
  console.log('     url       :', src.baseUrl);
  console.log('     permitted :', src.allowed ? 'yes — ' + src.accessMethod : 'NO');

  const collected = await apple.collect();
  const devices = collected.devices.slice(0, LIMIT);
  console.log('     columns named:', collected.columnsNamed,
              '| conflicts:', collected.conflicts.length,
              '| taking:', devices.length);

  /* ------------------------------------------- 2. canonical identity + alias */
  console.log('\n  2. canonical identity');
  const existingModels = readNdjson('models.ndjson');
  const existingIds = new Set(existingModels.map(m => m.id));
  const byAlias = new Map();
  existingModels.forEach(m => byAlias.set(aliasKey(m.brand, m.name), m.id));

  const identified = devices.map(d => {
    const canonicalId = canonicalDeviceId(d.brand, d.name);
    const ak = aliasKey(d.brand, d.name);
    return {
      ...d,
      canonicalId,
      aliasKey: ak,
      matchesExisting: existingIds.has(canonicalId),
      matchedVia: existingIds.has(canonicalId) ? 'exact-id'
                : byAlias.has(ak) ? 'alias:' + byAlias.get(ak)
                : 'new'
    };
  });

  const matched = identified.filter(d => d.matchesExisting).length;
  console.log(`     ${matched}/${identified.length} resolved onto an existing canonical id`);
  identified.filter(d => !d.matchesExisting)
    .forEach(d => console.log('       NEW:', d.canonicalId, '(' + d.matchedVia + ')'));

  /* -------------------------------------------------- 3. compatibility join */
  console.log('\n  3. join to the real compatibility data');
  const modelGroups = new Map(readNdjson('modelGroups.ndjson').map(r => [r.id, r.byCategory]));
  const groups = new Map(readNdjson('groups.ndjson').map(g => [g.id, g]));

  let withParts = 0;
  identified.forEach(d => {
    const byCategory = modelGroups.get(d.canonicalId) || null;
    d.compatibility = byCategory;
    d.groupCount = byCategory
      ? Object.values(byCategory).reduce((s, ids) => s + ids.length, 0) : 0;
    if (d.groupCount) withParts++;
  });
  console.log(`     ${withParts}/${identified.length} devices already carry compatibility groups`);

  /* ------------------------------------------------------ 4. shape documents */
  console.log('\n  4. shape Firestore documents');
  const now = new Date().toISOString();
  const docs = { devices: [], specs: [], colorVariants: [], aliases: [], priceOffers: [] };

  identified.forEach(d => {
    const existing = existingModels.find(m => m.id === d.canonicalId);

    docs.devices.push({
      _path: `devices/${d.canonicalId}`,
      id: d.canonicalId,
      brandId: 'apple', brand: 'Apple',
      name: d.name, nameLower: d.name.toLowerCase(), slug: slug(d.name),
      aliases: Array.from(new Set([d.marketingName, d.aliasKey])),
      searchPrefixes: searchPrefixes(d.name),
      tokens: tokens(d.name),
      deviceType: 'phone',
      /* release facts come from the owner's existing dataset; the compare page
         does not state them, and a date must not be inferred */
      announcedAt: null,
      releasedAt: existing ? existing.releaseDate || null : null,
      releaseYear: existing ? existing.releaseYear || null : null,
      status: 'available',
      image: existing ? existing.image || null : null,
      images: [],
      sourceRefs: {
        apple: d.sourceUrl,
        gsmarena: existing ? existing.gsmarenaUrl || null : null
      },
      confidence: 'verified',
      lastVerifiedAt: d.collectedAt,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION
    });

    docs.specs.push({
      _path: `devices/${d.canonicalId}/specs/current`,
      chipset: d.spec.chipset || null,
      cpu: d.spec.cpu || null,
      gpu: d.spec.gpu || null,
      neuralEngine: d.spec.neuralEngine || null,
      display: {
        ...(d.spec.display || {}),
        /* dimensions the owner's dataset already measured, kept alongside */
        heightMm: existing ? existing.heightMm ?? null : null,
        widthMm: existing ? existing.widthMm ?? null : null,
        screenCm2: existing ? existing.screenCm2 ?? null : null,
        bodyRatio: existing ? existing.bodyRatio ?? null : null
      },
      body: d.spec.body || null,
      battery: {
        ...(d.spec.battery || {}),
        capacityMah: existing ? existing.batteryMah ?? null : null
      },
      cameraRear: d.spec.cameraRear || null,
      cameraFront: d.spec.cameraFront || null,
      connectivity: d.spec.connectivity || null,
      other: d.spec.other || null,
      /* fields Apple's compare page simply does not publish. Left null and
         named, so it is obvious what still needs a source rather than looking
         like the data is complete. */
      network: null, os: null, sensors: null,
      ramVariantsGb: null, storageVariantsGb: null,
      sources: [{ sourceId: d.sourceId, url: d.sourceUrl, collectedAt: d.collectedAt }],
      confidence: 'verified',
      lastVerifiedAt: d.collectedAt,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION
    });

    d.colors.forEach(c => docs.colorVariants.push({
      _path: `devices/${d.canonicalId}/colorVariants/${c.id}`,
      ...c, hexApprox: null, imageUrl: null,
      confidence: 'verified', lastVerifiedAt: d.collectedAt,
      schemaVersion: SCHEMA_VERSION
    }));

    docs.aliases.push({
      _path: `aliases/${d.aliasKey}`,
      alias: d.aliasKey, canonicalId: d.canonicalId, brandId: 'apple',
      sourceId: d.sourceId, confidence: 'verified',
      createdAt: now, schemaVersion: SCHEMA_VERSION
    });
  });

  /* --------------------------------------------------------- 5. price status */
  console.log('\n  5. price sources');
  ['amazon-in', 'flipkart'].forEach(id => {
    const s = SOURCES[id];
    console.log(`     ${s.name.padEnd(14)} ${isConfigured(id) ? 'configured' : 'NOT CONFIGURED'}` +
                ` — ${s.allowed ? s.accessMethod : 'blocked: ' + s.accessMethod}`);
    if (!isConfigured(id)) console.log(`       needs ${s.credentialEnvVar}`);
  });
  console.log('     no price documents written: a price nobody could fetch must not be invented');

  /* ------------------------------------------------------------ 6. cost model */
  const writes = docs.devices.length + docs.specs.length +
                 docs.colorVariants.length + docs.aliases.length;
  console.log('\n  6. Firestore impact for this run');
  console.log('     documents  :', writes,
              `(${docs.devices.length} devices, ${docs.specs.length} specs,` +
              ` ${docs.colorVariants.length} colours, ${docs.aliases.length} aliases)`);
  console.log('     reads      : 0  — every id is deterministic, so nothing is looked up first');
  console.log('     batches    :', Math.ceil(writes / 450), 'of 450');

  /* ----------------------------------------------------------------- output */
  fs.mkdirSync(OUT, { recursive: true });
  Object.entries(docs).forEach(([name, rows]) => {
    fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(rows, null, 2));
  });
  const report = {
    runId, generatedAt: now, dryRun: !WRITE,
    source: { id: src.id, name: src.name, url: src.baseUrl, permitted: src.allowed },
    columnsNamed: collected.columnsNamed,
    conflicts: collected.conflicts,
    skippedColumns: collected.skipped.length,
    devices: identified.map(d => ({
      canonicalId: d.canonicalId, name: d.name, evidence: d.evidence,
      matchedVia: d.matchedVia, groupCount: d.groupCount,
      colors: d.colors.length,
      specFieldsFilled: Object.keys(d.spec).length
    })),
    counts: { devices: docs.devices.length, specs: docs.specs.length,
              colorVariants: docs.colorVariants.length, aliases: docs.aliases.length },
    priceSources: ['amazon-in', 'flipkart'].map(id => ({ id, configured: isConfigured(id) }))
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  console.log('\n  written to', path.relative(process.cwd(), OUT));
  console.log('  elapsed   :', ((Date.now() - t0) / 1000).toFixed(1) + 's');

  if (WRITE) {
    if (!PROJECT) throw new Error('--write needs --project <firebase-project-id>');
    console.log('\n  --write is deliberately not implemented in the proof of concept.');
    console.log('  Review data/build/poc-apple/ first, then import with:');
    console.log('    node scripts/import-firestore.js --project', PROJECT, '--only devices');
  }
  console.log();
}

main().catch(e => { console.error('\n  PoC failed:', e.message, '\n'); process.exit(1); });
