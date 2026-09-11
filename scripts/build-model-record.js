/* ============================================================================
   Mobile Parts Finder · scripts/build-model-record.js
   ----------------------------------------------------------------------------
   Builds one All-Mobile-Models active record from three inputs, none of which
   is allowed to invent a value:

     1  data/models-overlay/<modelId>.json     manufacturer + cross-checked
     2  data/techspecs/raw/product-*.json      TechSpecs, one file per A-number
     3  data/archive/gsmarena/<batch>/<id>.json  archived original, image fallback

       node scripts/build-model-record.js apple-iphone-14 <tsId> [<tsId> ...]

   Why a variant MATRIX and not a variant list
   -------------------------------------------
   A phone is not one product. The iPhone 14 is five hardware SKUs (one A-number
   per market) x three storage sizes x six finishes. Flattening that into three
   loose lists loses the only thing a parts desk actually needs: which model
   number the handset in front of them carries. So the record stores the axes
   AND the enumerated combinations, each combination carrying its own model
   number and its own price where one is verified.

   Prices are attached per (region, storage). A combination with no verified
   price says so; it never inherits a price from another storage tier or
   another market.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const [modelId, ...tsIds] = process.argv.slice(2);
if (!modelId) {
  console.error('usage: node scripts/build-model-record.js <modelId> [techspecsId...]');
  process.exit(1);
}

const PLACEHOLDER = /the data will be added shortly|^n\/?a$|^unspecified$|^$/i;
const clean = v => {
  if (v == null) return null;
  const s = String(v).replace(/[�-]/g, '-').replace(/\s+/g, ' ').trim();
  return !s || PLACEHOLDER.test(s) ? null : s;
};
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

/* "20.0 W" -> "20 W wired". A plain substring swap, not a regex: an escaped
   word-boundary in this file was already mangled into a literal backspace byte
   once by a shell heredoc, and the regex then silently stopped matching. */
const wattFmt = w => {
  const c = clean(w);
  return c ? c.split('.0 ').join(' ') + ' wired' : null;
};


/* ------------------------------------------------------------------ inputs */
const overlay = readJson(path.join(ROOT, 'data', 'models-overlay', `${modelId}.json`));
const F = overlay.fields || {};

const ts = tsIds.map(id => {
  const p = path.join(ROOT, 'data', 'techspecs', 'raw', `product-${id}.json`);
  if (!fs.existsSync(p)) { console.error(`  missing cached payload: ${p}`); process.exit(1); }
  return readJson(p).data;
});
/* The primary TechSpecs record is the one matching the overlay's primary
   region, so band lists and dimensions come from the SKU most users hold. */
const primaryRegion = (overlay.regions || []).find(r => r.primary) || (overlay.regions || [])[0];
const T = ts.find(d => d.Product && d.Product.Version === (primaryRegion || {}).modelNumber) || ts[0] || {};

let archive = null;
const archRoot = path.join(ROOT, 'data', 'archive', 'gsmarena');
if (fs.existsSync(archRoot)) {
  for (const b of fs.readdirSync(archRoot)) {
    const p = path.join(archRoot, b, `${modelId}.json`);
    if (fs.existsSync(p)) archive = readJson(p);
  }
}
const orig = (archive && archive.originalState) || {};

/* --------------------------------------------------------------- spec rows */
const D = (T.Design || {}).Body || {}, I = T.Inside || {}, DISP = T.Display || {}, CAM = T.Camera || {};

/* Agreement is judged on content, not wording: "IP68" and "IP68 (maximum depth
   6 metres)" are the same fact. Only genuine disagreements are flagged, so the
   flag keeps its meaning. */
function agrees(a, b) {
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\s+/g, ' ').trim();
  const x = norm(a), y = norm(b);
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const nums = s => (s.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter(n => n !== 0);
  const nx = nums(x), ny = nums(y);
  if (!nx.length || !ny.length) return false;
  const sy = new Set(ny), sx = new Set(nx);
  return nx.every(n => sy.has(n)) || ny.every(n => sx.has(n));
}

/** label -> value row. `man` wins; `tsv` fills gaps and flags disagreements. */
function R(label, man, tsv) {
  const a = clean(man), b = clean(tsv);
  if (a && b) return agrees(a, b)
    ? { label, value: a, src: 'both' }
    : { label, value: a, src: 'manufacturer', conflict: b };
  if (a) return { label, value: a, src: 'manufacturer' };
  if (b) return { label, value: b, src: 'techspecs' };
  return null;
}
/** a row whose value came from a cross-checked third-party source */
function X(label, value) {
  const v = clean(value);
  return v ? { label, value: v, src: 'crosschecked' } : null;
}
const section = (id, title, rows) => ({ id, title, rows: rows.filter(Boolean) });

const cam1 = CAM['Back Camera'] || {}, cam2 = CAM['Back Camera II'] || {}, front = CAM['Front Camera'] || {};
const ports = I.Ports || I.Port || {};

/* Deliberately excluded from the page: subpixel layout, LCD mode, colour
   depth, pixel size, bezel width, punch-hole count, microphone count, SAR.
   They are in the raw payload and stay there; none of them helps someone
   identify a handset or order a part for it. */
const specs = [
  section('general', 'General', [
    R('Brand', overlay.brand || orig.brand || 'Apple', (T.Product || {}).Brand),
    R('Model', overlay.commercialName || orig.name, (T.Product || {}).Model),
    { label: 'Model numbers', value: (overlay.regions || []).map(r => r.modelNumber).join(', '), src: 'both' },
    R('Device type', overlay.deviceType, (T.Product || {}).Category === 'Smartphones' ? 'Smartphone' : null),
    R('Form factor', overlay.formFactor, null),
    R('Announced', overlay.announcementDate, null),
    R('Released', overlay.releaseDate, orig.releaseDate),
    R('Launch region', overlay.launchCountry, null)
  ]),
  section('body', 'Body', [
    R('Height', F.heightMm, D.Height),
    R('Width', F.widthMm, D.Width),
    R('Thickness', F.thicknessMm, D.Thickness),
    R('Weight', F.weightG, D.Weight),
    R('Front', F.frontMaterial, null),
    R('Back', F.backMaterial, null),
    R('Frame', F.frameMaterial, null),
    R('Water / dust resistance', F.ipRating, D['IP Rating']),
    { label: 'Colours', value: (overlay.colors || []).map(c => c.name).join(', '), src: 'manufacturer' }
  ]),
  section('display', 'Display', [
    R('Size', F.displaySize, DISP.Diagonal),
    R('Type', F.displayType, DISP.Type),
    R('Panel technology', F.panelTechnology, null),
    R('Resolution', F.resolution, DISP['Resolution (H x W)']),
    /* Width and height as their own rows: a parts desk matches panels on the
       pixel dimensions, and reading them out of a combined string is exactly
       the kind of step that gets a digit wrong. Split from the value already
       recorded, never computed from something else. */
    ...(() => {
      const m = /(\d{3,5})\s*[x×]\s*(\d{3,5})/.exec(clean(F.resolution) || clean(DISP['Resolution (H x W)']) || '');
      if (!m) return [];
      const a = Number(m[1]), b = Number(m[2]);
      const w = Math.min(a, b), h = Math.max(a, b);
      return [
        { label: 'Resolution width', value: w + ' pixels', src: 'both' },
        { label: 'Resolution height', value: h + ' pixels', src: 'both' }
      ];
    })(),
    R('Pixel density', F.pixelDensity, DISP['Pixel Density']),
    R('Refresh rate', F.refreshRate, DISP['Refresh Rate']),
    R('Screen-to-body ratio', null, DISP['Screen to Body Ratio']),
    R('Brightness', F.brightness, null),
    R('Protection', F.protection, DISP.Glass),
    R('Screen shape', F.screenShape, null)
  ]),
  section('performance', 'Performance', [
    R('Chipset', F.chipset, (I.Processor || {}).CPU),
    R('CPU', F.cpuConfig, null),
    R('CPU clock speed', null, (I.Processor || {})['CPU Clock Speed']),
    R('GPU', F.gpu, (I.Processor || {}).GPU),
    R('Neural engine', F.npu, null)
  ]),
  section('memory', 'Memory', [
    R('RAM', null, (I.RAM || {}).Capacity),
    R('RAM type', null, (I.RAM || {}).Type),
    { label: 'Storage options', value: ((I.Storage || {}).Capacity_Array || []).join(', ') || clean((I.Storage || {}).Capacity), src: 'techspecs' },
    { label: 'Expandable storage', value: /expandable/i.test(((T.No || {}).Expansion) || '') ? 'No' : 'Not stated', src: 'techspecs' }
  ]),
  section('camera', 'Camera', [
    R('Rear camera', F.rearMain, [cam1.Resolution, cam1['Aperture (W)'], cam1['Equivalent Focal Length']].filter(Boolean).join(', ')),
    R('Ultra wide', F.rearUltrawide, [cam2.Resolution, cam2['Aperture (W)'], cam2['Equivalent Focal Length']].filter(Boolean).join(', ')),
    R('Zoom', F.rearZoom, cam1.Zoom),
    R('Stabilisation', null, /Optical Image Stabiliz/i.test(cam1.Features || '') ? 'Optical (OIS) and electronic (EIS)' : null),
    R('Autofocus', null, cam1.Focus),
    R('Camera features', F.cameraFeatures, null),
    R('Front camera', F.frontCamera, [front.Resolution, front['Aperture (W)']].filter(Boolean).join(', ')),
    R('Video recording', F.videoRecording, cam1['Video Resolution'])
  ]),
  section('battery', 'Battery', [
    R('Capacity', null, (I.Battery || {}).Capacity, orig.batteryMah ? orig.batteryMah + ' mAh' : null),
    R('Type', null, (I.Battery || {}).Type),
    R('Removable', null, (I.Battery || {}).Style),
    R('Wired charging', null, (I.Battery || {})['Charging Power']),
    R('Fast charging', F.fastCharging, null),
    R('Wireless charging', F.wirelessCharging, [(I.Battery || {})['Wireless Charging'], (I.Battery || {})['Wireless Charging Power']].filter(Boolean).join(', ')),
    R('Reverse charging', F.reverseCharging, null)
  ]),
  section('connectivity', 'Network & connectivity', [
    R('4G LTE', null, /LTE/.test((I.Cellular || {})['SIM Frequencies'] || '') ? 'Yes' : null),
    R('5G', F.network5g, /NR /.test((I.Cellular || {})['SIM Frequencies'] || '') ? 'Yes (5G NR)' : null),
    R('Wi-Fi', F.wifi, (I.Wireless || {}).WiFi),
    R('Bluetooth', F.bluetooth, (I.Wireless || {})['Bluetooth Version']),
    R('NFC', F.nfc, /NFC/i.test((I.Wireless || {}).Experiences || '') ? 'Yes' : null),
    R('GPS', null, (I.Location || {})['Additional Features']),
    R('USB', F.usbPort, [ports['USB Type'], ports['USB Version']].filter(Boolean).join(', ')),
    R('USB OTG', F.usbOtg, /On-The-Go/i.test(ports['USB Features'] || '') ? 'Yes' : 'No')
  ]),
  /* SIM is its own section, not a line in connectivity: which trays and eSIMs
     a unit has is market-specific and is one of the first things a counter
     checks. */
  section('sim', 'SIM', [
    R('SIM configuration', F.simConfig, null),
    R('SIM type', null, (T.Product || {})['SIM Type'] ? (T.Product || {})['SIM Type'] + ' SIM' : null),
    R('SIM slot', null, (I.Cellular || {})['SIM Slot']),
    R('eSIM', F.esim, /e-?SIM/i.test((I.Cellular || {})['SIM Slot'] || '') ? 'Yes' : null)
  ]),
  section('audio', 'Audio', [
    R('Speakers', F.stereoSpeakers ? 'Stereo speakers' : null, (I.Audio || {}).Channel ? (I.Audio || {}).Channel + ' speakers' : null),
    R('3.5 mm headphone jack', F.headphoneJack, null),
    R('Audio features', F.audioFeatures, null)
  ]),
  section('software', 'Software', [
    R('Operating system', F.os, (I.Software || {}).OS ? String((I.Software || {}).OS).split('/')[0].trim() : null),
    R('OS version at launch', F.osVersionAtLaunch, (I.Software || {})['OS Version']),
    R('User interface', F.uiSkin, null)
  ]),
  section('other', 'Other details', [
    R('Biometrics', F.faceUnlock, null),
    R('Fingerprint sensor', F.fingerprint, null),
    R('Sensors', null, (I.Sensors || {}).Sensors),
    R('OEM identifier', null, (T.Product || {})['OEM ID'])
  ])
];

/* ----------------------------------------------------------- variant matrix */
const colors = overlay.colors || [];
const regions = overlay.regions || [];
const storages = ((I.Storage || {}).Capacity_Array) ||
  (clean((I.Storage || {}).Capacity) || '').split(',').map(s => s.trim()).filter(Boolean);
const rams = ((I.RAM || {}).Capacity_Array) || [clean((I.RAM || {}).Capacity)].filter(Boolean);
const ramType = clean((I.RAM || {}).Type);

const priceFor = (regionCode, storage) =>
  (overlay.prices || []).find(p => p.region === regionCode && p.storage === storage) || null;

const variants = [];
regions.forEach(rg => storages.forEach(st => rams.forEach(ram => colors.forEach(c => {
  const p = priceFor(rg.code, st);
  variants.push({
    id: [modelId, rg.code, ram, st, c.name].join('|').replace(/\s+/g, ''),
    region: rg.code, regionLabel: rg.label, countries: rg.countries,
    modelNumber: rg.modelNumber, regionNote: rg.note || null,
    ram, ramType, storage: st, color: c.name, colorNote: c.note || null,
    price: p && p.amount ? { amount: p.amount, currency: p.currency, market: p.market, status: p.status }
      : { amount: null, currency: p ? p.currency : null, market: p ? p.market : null,
          status: p ? p.status : 'not-found', note: p ? p.note : null }
  });
}))));

/* ------------------------------------------------------------------ record */
const conflicts = [];
specs.forEach(s => s.rows.forEach(r => {
  if (r.conflict) conflicts.push({ section: s.id, field: r.label, value: r.value, techspecs: r.conflict });
}));
(overlay.prices || []).forEach(p => {
  if (p.status === 'conflict') {
    conflicts.push({ section: 'price', field: `Launch price ${p.storage} (${p.market})`,
      value: 'Not shown - sources disagree', techspecs: JSON.stringify(p.conflict) });
  }
});

const record = {
  modelId,
  brandId: overlay.brandId || orig.brandId,
  brand: overlay.brand || orig.brand || (T.Product || {}).Brand,
  name: orig.name || overlay.officialModelName,
  officialModelName: overlay.officialModelName,
  commercialName: overlay.commercialName,
  summary: overlay.summary || null,
  series: overlay.series || null,
  deviceType: overlay.deviceType || null,
  formFactor: overlay.formFactor || null,
  releaseDate: overlay.releaseDate || orig.releaseDate || null,
  releaseDateLabel: overlay.releaseDateLabel || null,
  announcementDate: overlay.announcementDate || null,

  image: {
    primary: orig.image || null,
    primarySource: 'GSMArena Archive',
    /* Real per-colour photographs, keyed by the exact colour name. Empty until
       a source that actually has them is wired up: the picker falls back to the
       default shot rather than tinting it, because a recoloured picture of a
       Midnight handset is a fabricated product image. */
    byColor: overlay.colorImages || {},
    techspecs: null,
    techspecsNote: 'TechSpecs serves images only through a separately paid Image API, which was not purchased. The archived GSMArena image remains primary.',
    gsmarenaFallback: orig.image || null
  },

  /* axes drive the selector; variants are the valid combinations it may reach */
  axes: {
    color: colors.map(c => ({ value: c.name, note: c.note || null })),
    ram: rams.map(v => ({ value: v, note: ramType })),
    storage: storages.map(v => ({ value: v, note: null })),
    region: regions.map(r => ({ value: r.code, label: r.label, modelNumber: r.modelNumber,
                                countries: r.countries, note: r.note || null }))
  },
  variants,
  variantCount: variants.length,

  /* Banner highlights: the four facts that identify a handset at a glance.
     Deliberately not connector or ingress ratings — those do not help someone
     recognise the device, and the banner is not the spec sheet. */
  highlights: [
    clean(F.displaySize), clean(F.displayType), clean(F.chipset),
    (() => {
      const mp = s => { const m = /(\d+(?:\.\d+)?)\s*MP/i.exec(clean(s) || ''); return m ? m[1] : null; };
      const n = [F.rearMain, F.rearUltrawide, F.rearTelephoto, F.rearMacro].filter(x => mp(x)).length;
      const first = mp(F.rearMain) || mp(cam1.Resolution);
      if (!first) return null;
      const word = { 1: 'single', 2: 'dual', 3: 'triple', 4: 'quad' }[n] || '';
      return first + 'MP ' + (word ? word + ' camera' : 'camera');
    })()
  ].filter(Boolean),

  /* The five specifications the banner carries as one divided row. RAM and
     storage are deliberately absent: they vary per variant, so they belong to
     the variant picker and the Memory table, not to a fixed banner row. */
  primarySpecs: (() => {
    const mp = s => { const m = /(\d+(?:\.\d+)?)\s*MP/i.exec(clean(s) || ''); return m ? m[1] + ' MP' : null; };
    const lenses = [mp(F.rearMain) || mp(cam1.Resolution), mp(F.rearUltrawide) || mp(cam2.Resolution),
                    mp(F.rearTelephoto), mp(F.rearMacro)].filter(Boolean);
    const word = { 1: 'Single', 2: 'Dual', 3: 'Triple', 4: 'Quad' }[lenses.length] || null;
    const watt = clean((I.Battery || {})['Charging Power']);
    return [
      { key: 'display', icon: 'display', label: 'Display',
        value: clean(F.displaySize), sub: clean(F.displayType) },
      { key: 'processor', icon: 'cpu', label: 'Processor',
        value: clean(F.chipset), sub: clean(F.gpu) },
      { key: 'front', icon: 'camera', label: 'Front camera',
        value: mp(F.frontCamera) || mp(front.Resolution),
        sub: (() => { const m = /f\/[\d.]+/i.exec(clean(F.frontCamera) || ''); return m ? m[0] : null; })() },
      { key: 'rear', icon: 'camera', label: 'Rear camera',
        value: lenses.join(' + ') || null, sub: word ? word + ' camera' : null },
      { key: 'battery', icon: 'battery', label: 'Battery',
        value: clean((I.Battery || {}).Capacity),
        sub: wattFmt(watt) }
    ].filter(q => q.value);
  })(),

  /* The sixth banner slot: the most useful fact this model has that is NOT
     already one of the five headline specs. Priority order, first hit wins, so
     a phone with no IP rating shows its refresh rate instead and the slot is
     never padded with something meaningless. Nothing is invented - a model
     with none of these simply leaves the slot empty. */
  additionalSpec: (() => {
    const pick = [
      ['shield', 'Water resistance', F.ipRating, null],
      ['display', 'Refresh rate', F.refreshRate, null],
      ['charge', 'Wireless charging', F.wirelessCharging, null],
      ['signal', '5G', F.network5g, null],
      ['display', 'Resolution', F.resolution, clean(F.pixelDensity)],
      ['shield', 'Biometrics', F.faceUnlock, null],
      ['simcard', 'SIM', F.simConfig, null],
      ['board', 'NFC', F.nfc, null]
    ];
    for (const [ic, label, value, sub] of pick) {
      const v = clean(value);
      if (v) {
        /* Long manufacturer phrasings are trimmed to the fact itself; the full
           string stays in the spec table below. */
        const short = v.split(' (')[0].split(';')[0].trim();
        return { key: 'extra', icon: ic, label, value: short, sub: sub || null };
      }
    }
    return null;
  })(),

  /* Overview cards. The PRIMARY value is the number someone scans for; the
     secondary line is the qualifier. So the battery card reads 3279 mAh with
     20W underneath, not the other way round, and the camera card carries the
     megapixels rather than the full lens description — the detail belongs in
     the Camera section. Roles are read from the overlay's standard keys, so
     this works for any brand without naming one. */
  quickSpecs: (() => {
    const mp = s => { const m = /(\d+(?:\.\d+)?)\s*MP/i.exec(clean(s) || ''); return m ? m[1] + ' MP' : null; };
    const lenses = [
      ['Main', mp(F.rearMain) || mp(cam1.Resolution)],
      ['Ultra Wide', mp(F.rearUltrawide) || mp(cam2.Resolution)],
      ['Telephoto', mp(F.rearTelephoto)],
      ['Macro', mp(F.rearMacro)]
    ].filter(x => x[1]);
    const watt = clean((I.Battery || {})['Charging Power']);
    return [
      { label: 'Display', icon: 'display', value: clean(F.displaySize), sub: clean(F.displayType) },
      { label: 'Processor', icon: 'cpu', value: clean(F.chipset), sub: clean(F.gpu) },
      { label: 'Rear camera', icon: 'camera',
        value: lenses.map(l => l[1]).join(' + ') || null,
        sub: lenses.map(l => l[0]).join(' + ') || null },
      { label: 'Battery', icon: 'battery', value: clean((I.Battery || {}).Capacity),
        sub: wattFmt(watt) },
      { label: 'RAM', icon: 'layers', value: rams[0] || null, sub: ramType },
      { label: 'Storage', icon: 'board', value: storages.join(' / ') || null,
        sub: clean(F.expandable) || 'Not expandable' }
    ].filter(q => q.value);
  })(),

  specs,

  sourceMeta: {
    primarySource: overlay.primarySource || 'TechSpecs API',
    source1Url: overlay.source1Url || null,
    source1Title: overlay.source1Title || null,
    modelNumberSource: overlay.modelNumberSource || null,
    techspecsProductIds: tsIds,
    techspecsRecordCount: ts.length,
    gsmarenaArchive: archive ? `data/archive/gsmarena/${archive.archive.migrationBatch}/${modelId}.json` : null,
    verificationStatus: conflicts.length ? 'Cross-checked, with noted conflicts' : 'Cross-checked',
    lastVerified: new Date().toISOString().slice(0, 10),
    conflicts,
    notes: overlay.notes || []
  }
};

for (const dir of [path.join(ROOT, 'data', 'models-active'), path.join(ROOT, 'assets', 'models-active')]) {
  fs.mkdirSync(dir, { recursive: true });
  const pretty = dir.includes('data');
  fs.writeFileSync(path.join(dir, `${modelId}.json`),
    JSON.stringify(record, null, pretty ? 1 : 0), 'utf8');
}

const rowCount = specs.reduce((n, s) => n + s.rows.length, 0);
console.log(`  ${modelId}`);
console.log(`  spec rows   ${rowCount} across ${specs.length} sections`);
console.log(`  variants    ${variants.length}  (${regions.length} regions x ${storages.length} storage x ${rams.length} RAM x ${colors.length} colours)`);
console.log(`  priced      ${variants.filter(v => v.price.amount).length}`);
console.log(`  conflicts   ${conflicts.length}`);
console.log(`  image       ${record.image.primarySource}`);
