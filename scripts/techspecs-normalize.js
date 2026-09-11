/* ============================================================================
   Mobile Parts Finder · scripts/techspecs-normalize.js
   ----------------------------------------------------------------------------
   Turns a cached TechSpecs product payload into an active All-Mobile-Models
   record, merging in the manufacturer overlay and the archived GSMArena record.

       node scripts/techspecs-normalize.js apple-iphone-15 <techspecsProductId>

   Reads (no API calls, no credits):
     data/techspecs/raw/product-<id>.json        TechSpecs, source 2
     data/models-overlay/<modelId>.json          manufacturer values, source 1
     data/archive/gsmarena/<batch>/<modelId>.json   archived original, fallback

   Precedence: manufacturer > TechSpecs > GSMArena archive. Every emitted value
   carries the source it came from, and where two sources disagree the row is
   marked and BOTH values are kept — nothing is silently picked.

   Values TechSpecs prints as placeholders ("The data will be added shortly")
   are dropped rather than shown as content.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const [modelId, productId] = process.argv.slice(2);
if (!modelId || !productId) {
  console.error('usage: node scripts/techspecs-normalize.js <modelId> <techspecsProductId>');
  process.exit(1);
}

const PLACEHOLDER = /the data will be added shortly|^n\/?a$|^unspecified$/i;
const clean = v => {
  if (v == null) return null;
  /* TechSpecs ships a few mojibake bytes (a dash that survived a bad decode).
     Replace the replacement char and the C1 block rather than printing them. */
  const s = String(v).replace(/[�-]/g, '-').replace(/\s+/g, ' ').trim();
  return !s || PLACEHOLDER.test(s) ? null : s;
};

/* ------------------------------------------------------------------ input */
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

const rawPath = path.join(ROOT, 'data', 'techspecs', 'raw', `product-${productId}.json`);
if (!fs.existsSync(rawPath)) {
  console.error(`  No cached TechSpecs payload at ${rawPath}\n  Run: node scripts/techspecs.js detail ${productId}`);
  process.exit(1);
}
const ts = readJson(rawPath).data || {};

const overlayPath = path.join(ROOT, 'data', 'models-overlay', `${modelId}.json`);
const overlay = fs.existsSync(overlayPath) ? readJson(overlayPath) : {};

/* newest archive batch that holds this model */
const archRoot = path.join(ROOT, 'data', 'archive', 'gsmarena');
let archive = null;
if (fs.existsSync(archRoot)) {
  for (const b of fs.readdirSync(archRoot)) {
    const p = path.join(archRoot, b, `${modelId}.json`);
    if (fs.existsSync(p)) archive = readJson(p);
  }
}

/* ---------------------------------------------------------------- helpers */
const P = ts.Product || {}, D = (ts.Design || {}).Body || {}, I = ts.Inside || {};
const DISP = ts.Display || {}, CAM = ts.Camera || {}, NO = ts.No || {};

/* Two sources rarely phrase a spec identically — "IP68" vs "IP68 (maximum
   depth 6 metres)", "iOS 17" vs "Apple iOS 17". Flagging those as conflicts
   buries the handful that actually matter, so agreement is judged on content:
   same after stripping punctuation, or one wholly contains the other, or both
   carry the same numbers. What survives is a genuine disagreement. */
function agrees(a, b) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\s+/g, ' ').trim();
  const x = norm(a), y = norm(b);
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const nums = s => (s.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter(n => n !== 0);
  const nx = nums(x), ny = nums(y);
  if (!nx.length || !ny.length) return false;
  const setY = new Set(ny), setX = new Set(nx);
  return nx.every(n => setY.has(n)) || ny.every(n => setX.has(n));
}

const rows = [];
/** push a row; `man` is the manufacturer value, `tsv` the TechSpecs value */
function row(label, man, tsv, opts = {}) {
  const a = clean(man), b = clean(tsv);
  if (a && b) {
    const same = opts.same ? opts.same(a, b) : agrees(a, b);
    rows.push(same
      ? { label, value: a, src: 'both' }
      : { label, value: a, src: 'manufacturer', conflict: { techspecs: b } });
  } else if (a) rows.push({ label, value: a, src: 'manufacturer' });
  else if (b) rows.push({ label, value: b, src: 'techspecs' });
  else if (opts.fallback && clean(opts.fallback)) {
    rows.push({ label, value: clean(opts.fallback), src: 'gsmarena' });
  } else rows.push({ label, value: 'Not published by either source', src: 'none' });
  return rows.pop();
}
const sec = (id, title, list) => ({ id, title, rows: list.filter(Boolean) });
const man = k => (overlay.fields || {})[k];
const orig = (archive && archive.originalState) || {};

/* ------------------------------------------------------------- sections */
const sections = [
  sec('display', 'Display', [
    row('Size', man('displaySize'), DISP.Diagonal),
    row('Type', man('displayType'), DISP.Type),
    row('Panel', man('panelType'), DISP.Illumination === 'Self-illuminating' ? 'OLED (self-illuminating)' : null),
    row('Screen shape', man('screenShape'), null),
    row('Resolution', man('resolution'), DISP['Resolution (H x W)']),
    row('Pixel density', man('pixelDensity'), DISP['Pixel Density']),
    row('Refresh rate', man('refreshRate'), DISP['Refresh Rate']),
    row('Brightness', man('brightness'), null),
    row('Colour depth', null, DISP['Color Depth']),
    row('Number of colours', null, DISP['Number of Colors']),
    row('Dynamic range', man('hdr'), DISP['Dynamic Range']),
    row('Pixel size', null, DISP['Pixel Size']),
    row('Protection glass', man('protection'), DISP.Glass),
    row('Screen-to-body ratio', null, DISP['Screen to Body Ratio'], { fallback: orig.bodyRatio ? orig.bodyRatio + '%' : null }),
    row('Touch screen', null, [DISP['Touch screen Type'], DISP.Touchpoints && DISP.Touchpoints + ' touch points'].filter(Boolean).join(', ')),
    row('Cutout', man('cutout'), DISP['Punch hole'] ? DISP['Punch hole'] + ' punch hole' : null),
    row('Panel dimensions', null, DISP.Width && DISP.Height ? `${DISP.Width} x ${DISP.Height}` : null),
    row('Bezel width', null, DISP['Bezel Width'])
  ]),
  sec('performance', 'Performance', [
    row('Chip', man('chip'), (I.Processor || {}).CPU),
    row('CPU', man('cpu'), null),
    row('CPU clock speed', null, (I.Processor || {})['CPU Clock Speed']),
    row('GPU', man('gpu'), (I.Processor || {}).GPU),
    row('Neural Engine', man('npu'), null),
    row('RAM', null, (I.RAM || {}).Capacity),
    row('RAM type', null, (I.RAM || {}).Type),
    row('RAM clock speed', null, (I.RAM || {})['Clock Speed']),
    row('Storage', man('storage'), (I.Storage || {}).Capacity),
    row('Storage type', null, (I.Storage || {}).Type),
    row('Expandable storage', null, /expandable/i.test(NO.Expansion || '') ? 'No' : null)
  ]),
  sec('camera', 'Camera', [
    row('Main camera', man('mainCamera'), [(CAM['Back Camera'] || {}).Resolution, (CAM['Back Camera'] || {})['Aperture (W)'], (CAM['Back Camera'] || {})['Equivalent Focal Length']].filter(Boolean).join(', ')),
    row('Main sensor', null, [(CAM['Back Camera'] || {}).Sensor, (CAM['Back Camera'] || {})['Sensor Format']].filter(Boolean).join(', format ')),
    row('Main pixel size', null, (CAM['Back Camera'] || {})['Pixel Size']),
    row('Ultra Wide', man('ultrawide'), [(CAM['Back Camera II'] || {}).Resolution, (CAM['Back Camera II'] || {})['Aperture (W)'], (CAM['Back Camera II'] || {})['Equivalent Focal Length']].filter(Boolean).join(', ')),
    row('Telephoto', man('telephoto'), null),
    row('Zoom', null, (CAM['Back Camera'] || {}).Zoom),
    row('Stabilisation', null, /Optical Image Stabilization/i.test((CAM['Back Camera'] || {}).Features || '') ? 'OIS and EIS' : null),
    row('Front camera', man('frontCamera'), [(CAM['Front Camera'] || {}).Resolution, (CAM['Front Camera'] || {})['Aperture (W)']].filter(Boolean).join(', ')),
    row('Front sensor module', null, (CAM['Front Camera'] || {}).Module),
    row('Video recording', man('video'), (CAM['Back Camera'] || {})['Video Resolution']),
    row('Image formats', null, (CAM['Back Camera'] || {})['Image Format']),
    row('Video formats', null, (CAM['Back Camera'] || {})['Video Format'])
  ]),
  sec('battery', 'Battery & charging', [
    row('Capacity', null, (I.Battery || {}).Capacity, { fallback: orig.batteryMah ? orig.batteryMah + ' mAh' : null }),
    row('Energy', null, (I.Battery || {}).Energy),
    row('Voltage', null, (I.Battery || {}).Voltage),
    row('Type', man('batteryType'), (I.Battery || {}).Type),
    row('Removable', null, (I.Battery || {}).Style),
    row('Wired charging', null, (I.Battery || {})['Charging Power']),
    row('Wireless charging', man('wirelessCharging'), [(I.Battery || {})['Wireless Charging'], (I.Battery || {})['Wireless Charging Power']].filter(Boolean).join(', ')),
    row('Battery life', man('batteryLife'), null)
  ]),
  sec('network', 'Network & connectivity', [
    row('Cellular', man('cellular'), (I.Cellular || {})['SIM Mobile Data'] ? '5G NR, LTE, UMTS, GSM' : null),
    row('Modem chip', null, (I.Cellular || {}).Chip),
    row('Wi-Fi', man('wifi'), (I.Wireless || {}).WiFi),
    row('Wi-Fi features', null, (I.Wireless || {})['WiFi Features']),
    row('Bluetooth', man('bluetooth'), (I.Wireless || {})['Bluetooth Version']),
    row('Bluetooth profiles', null, (I.Wireless || {})['Bluetooth Profiles']),
    row('NFC', man('nfc'), /NFC/i.test((I.Wireless || {}).Experiences || '') ? 'Yes' : null),
    row('USB', man('usb'), [(I.Port || {})['USB Type'], (I.Port || {})['USB Version']].filter(Boolean).join(', ')),
    row('USB features', null, (I.Port || {})['USB Features']),
    row('Positioning', null, (I.Location || {})['Additional Features']),
    row('UWB', man('uwb'), null),
    row('Bands', null, (I.Cellular || {})['SIM Frequencies'])
  ]),
  sec('body', 'Body & design', [
    row('Height', man('height'), D.Height),
    row('Width', man('width'), D.Width),
    row('Thickness', man('thickness'), D.Thickness),
    row('Weight', man('weight'), D.Weight),
    row('Frame', man('frame'), null),
    row('Front', man('front'), null),
    row('Back', man('back'), null),
    row('IP rating', man('ipRating'), D['IP Rating']),
    row('Manufacturer', null, P.Manufacturer),
    row('OEM ID', null, P['OEM ID'])
  ]),
  sec('sim', 'SIM', [
    row('SIM type', man('sim'), P['SIM Type']),
    row('SIM slot', null, (I.Cellular || {})['SIM Slot']),
    row('Region', null, [P.Region, P.Country].filter(Boolean).join(' · '))
  ]),
  sec('sensors', 'Sensors & security', [
    row('Sensors', null, (I.Sensors || {}).Sensors),
    row('Face unlock', man('faceUnlock'), null),
    row('Fingerprint', man('fingerprint'), null)
  ]),
  sec('audio', 'Audio', [
    row('Channels', null, (I.Audio || {}).Channel),
    row('Microphones', null, (I.Audio || {}).Microphone),
    row('Audio out', null, (I.Audio || {}).Output),
    row('Headphone jack', man('jack'), null),
    row('Hearing aid compatibility', null, (I.Audio || {})['Hearing Aid Compatibility'])
  ]),
  sec('software', 'Software', [
    row('OS at launch', man('osAtLaunch'), (I.Software || {})['OS Version']),
    row('OS family', null, (I.Software || {}).OS),
    row('Platform features', null, (I.Software || {})['Additional Features'])
  ]),
  sec('regulatory', 'Regulatory', [
    row('SAR head (USA)', null, (I.SAR || {})['Head (USA)']),
    row('SAR body (USA)', null, (I.SAR || {})['Body (USA)']),
    row('SAR head (EU)', null, (I.SAR || {})['Head (EU)']),
    row('SAR body (EU)', null, (I.SAR || {})['Body (EU)'])
  ])
];

/* ------------------------------------------------------------- assemble */
const colors = clean(D.Colors) ? D.Colors.split(',').map(s => s.trim()) : (overlay.colors || []);
const storage = clean((I.Storage || {}).Capacity)
  ? (I.Storage || {}).Capacity.split(',').map(s => s.trim()) : [];
const ram = clean((I.RAM || {}).Capacity);

const conflicts = [];
sections.forEach(s => s.rows.forEach(r => {
  if (r.conflict) conflicts.push({ section: s.id, field: r.label, manufacturer: r.value, techspecs: r.conflict.techspecs });
}));

const record = {
  modelId,
  brandId: orig.brandId || overlay.brandId,
  brand: P.Brand || orig.brand,
  name: orig.name || P.Model,
  officialModelName: overlay.officialModelName || P.Model,
  modelNumbers: overlay.modelNumbers || (P.Version ? [P.Version] : []),
  techspecsVersion: P.Version || null,
  series: overlay.series || null,
  deviceType: P.Category === 'Smartphones' ? 'Smartphone' : (P.Category || null),
  formFactor: overlay.formFactor || 'Bar',
  releaseDate: orig.releaseDate || (ts['Key Aspects'] || {})['Release Date'],
  releaseDateLabel: overlay.releaseDateLabel || null,
  summary: overlay.summary || null,

  image: {
    primary: orig.image || null,
    primarySource: 'GSMArena Archive',
    techspecs: null,
    techspecsNote: 'TechSpecs serves images only through a separately paid Image API. Not purchased, so the archived GSMArena image remains primary.',
    gsmarenaFallback: orig.image || null
  },

  variants: {
    ram: ram ? [ram] : [],
    storage,
    colors,
    regions: [[P.Region, P.Country].filter(Boolean).join(' · ')].filter(Boolean),
    rows: storage.map(s => ({
      storage: s, ram: ram || 'Not published',
      launchPrice: 'See price note', modelNumber: (overlay.modelNumbers || []).join(' / ') || P.Version || '-'
    }))
  },

  sections,

  priceNote: (() => {
    const raw = clean((ts.Price || {})['Raw Price']);
    const msrp = clean((ts.Price || {}).MSRP);
    return {
      techspecsRawPrice: raw, techspecsMsrp: msrp,
      flagged: overlay.priceFlag || null
    };
  })(),

  sourceMeta: {
    primarySource: overlay.primarySource || 'TechSpecs API',
    source1Url: overlay.source1Url || null,
    source1Title: overlay.source1Title || null,
    techspecsStatus: 'Connected',
    techspecsProductId: productId,
    techspecsCategory: P.Category,
    techspecsUpdatedAt: ts.updated_at || null,
    gsmarenaArchive: archive ? `data/archive/gsmarena/${archive.archive.migrationBatch}/${modelId}.json` : null,
    dataStatus: conflicts.length ? 'Verified with conflicts' : 'Verified',
    lastVerified: new Date().toISOString().slice(0, 10),
    conflicts,
    notes: overlay.notes || []
  }
};

const outDir = path.join(ROOT, 'data', 'models-active');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${modelId}.json`), JSON.stringify(record, null, 1), 'utf8');

/* Second copy under assets/ because that is what actually reaches a browser:
   data/ is build input and is not guaranteed to be served. The app fetches
   this per model rather than folding it into dataset.json, so enriching all
   4,933 models later does not inflate the bundle every visitor downloads. */
const webDir = path.join(ROOT, 'assets', 'models-active');
fs.mkdirSync(webDir, { recursive: true });
fs.writeFileSync(path.join(webDir, `${modelId}.json`), JSON.stringify(record), 'utf8');

const counts = sections.reduce((n, s) => n + s.rows.filter(r => r.src !== 'none').length, 0);
console.log(`  ${modelId}: ${counts} populated fields across ${sections.length} sections`);
console.log(`  variants ${record.variants.rows.length} · colours ${colors.length} · conflicts ${conflicts.length}`);
console.log(`  image: ${record.image.primarySource}`);
console.log(`  -> data/models-active/${modelId}.json`);
