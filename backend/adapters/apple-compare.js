/* ============================================================================
   Mobile Parts Finder · backend/adapters/apple-compare.js
   ----------------------------------------------------------------------------
   Reads Apple's official iPhone comparison page and returns normalised device
   records — specifications and official colour variants, from the manufacturer.

   ----------------------------------------------------------------------------
   HOW THE PAGE IS STRUCTURED

   The comparison is a stack of rows. Each row holds one label, then one cell
   per phone, in a fixed column order:

     <div class="backport-row" data-id="...">
       <div data-type="features"     ...><div data-store-value="">Processor: Chip</div></div>
       <div data-type="featureItems" ...><div data-store-value="">A19 Pro chip</div></div>  <- column 0
       <div data-type="featureItems" ...><div data-store-value="">A19 Pro chip</div></div>  <- column 1

   No spec row names its phone, so recovering the column order is the whole
   problem. Two independent signals are combined, and a column is only accepted
   when it is certain:

     1. The price row carries Apple's own model tokens — "{IPHONE17PRO}",
        "{IPHONE17PROMAX}". Definitive, but present only for models Apple still
        sells; discontinued ones read "Available at authorised resellers".

     2. The "Image Link" row carries a product href per column
        ("/in/iphone-16-pro/"). Pro and Pro Max share one href, as do the base
        and Plus, so a repeated href resolves by position: first = Pro/base,
        second = Pro Max/Plus.

   Signal 1 confirms signal 2 on every column where both exist, which is what
   makes the href pairing trustworthy. Columns identified by neither are
   SKIPPED — never guessed at from their specs, because inferring "this must be
   the 14 Pro, it weighs 206 g" would be inventing provenance the page does not
   give. Verified with `node scripts/verify-apple-columns.js`.

   ----------------------------------------------------------------------------
   PRICES ARE NOT READ HERE

   Apple ships the price row as placeholders ($price.display.smart) that the
   browser fills from a store API, so the HTML carries no rupee figure. Rather
   than substitute a number from somewhere else, price collection is left to
   the price adapters and this adapter reports none.
   ========================================================================== */
'use strict';

const { fetchAllowed, USER_AGENT, SOURCES } = require('../sources');
const { slug } = require('../schema');

const SOURCE_ID = 'apple-compare-in';

/* --------------------------------------------------------------------- fetch */
async function fetchPage(url) {
  fetchAllowed(SOURCE_ID, url);                       /* throws if not permitted */
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

/* -------------------------------------------------------------------- parsing */
const clean = s => String(s)
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;| /g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&#x27;|&apos;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

const ROW_SPLIT = /<div class="backport-row"/;

function parseRows(html) {
  return html.split(ROW_SPLIT).slice(1).map(chunk => {
    const label = chunk.match(
      /data-type="features"[^>]*>\s*<div data-store-value="[^"]*">([\s\S]*?)<\/div>/);
    const cells = [...chunk.matchAll(
      /data-type="featureItems"[^>]*>\s*<div data-store-value="[^"]*">([\s\S]*?)<\/div>/g)]
      .map(m => clean(m[1]));
    const hrefs = [...chunk.matchAll(/data-type="featureItems"[^>]*href="([^"]+)"/g)].map(m => m[1]);
    return { label: label ? clean(label[1]) : null, cells, hrefs };
  });
}

/* --------------------------------------------------------- column resolution */

/* Apple's token for a marketing name: uppercase, separators removed. */
const tokenOf = name => name.toUpperCase().replace(/[^A-Z0-9]/g, '');

/* A product href maps to a family; position within a repeated href picks the
   member. "/in/iphone-16-pro/" appearing twice is [16 Pro, 16 Pro Max]. */
const FAMILY_MEMBERS = {
  'iphone-17-pro': ['iPhone 17 Pro', 'iPhone 17 Pro Max'],
  'iphone-16-pro': ['iPhone 16 Pro', 'iPhone 16 Pro Max'],
  'iphone-15-pro': ['iPhone 15 Pro', 'iPhone 15 Pro Max'],
  'iphone-17':     ['iPhone 17'],
  'iphone-16':     ['iPhone 16', 'iPhone 16 Plus'],
  'iphone-15':     ['iPhone 15', 'iPhone 15 Plus'],
  'iphone-17e':    ['iPhone 17e'],
  'iphone-16e':    ['iPhone 16e'],
  'iphone-air':    ['iPhone Air']
};

function familyOf(href) {
  const m = String(href).match(/\/in\/([a-z0-9-]+?)(?:\/specs)?\/?$/);
  return m ? m[1] : null;
}

/* Returns { index -> {name, evidence} } for every column we can name with
   certainty, plus a list of the columns we deliberately left unnamed. */
function resolveColumns(rows) {
  const priceRow = rows.find(r => r.label === 'dynamic-price-proxy' &&
                                  r.cells.some(c => /\{[A-Z0-9]+\}/.test(c)));
  const linkRow = rows.find(r => r.label === 'Image Link' && r.hrefs.length);
  if (!priceRow) throw new Error('price row not found — Apple changed the compare markup');

  /* signal 1: tokens */
  const byToken = {};
  priceRow.cells.forEach((c, i) => {
    const m = c.match(/\{([A-Z0-9]+)\}/);
    if (m) byToken[i] = m[1];
  });

  /* signal 2: hrefs, resolved by position within a repeated family */
  const byHref = {};
  if (linkRow) {
    const seen = {};
    linkRow.hrefs.forEach((href, i) => {
      const fam = familyOf(href);
      const members = FAMILY_MEMBERS[fam];
      if (!members) return;
      const n = seen[fam] = (seen[fam] || 0);
      if (members[n]) byHref[i] = members[n];
      seen[fam] = n + 1;
    });
  }

  const columns = {};
  const skipped = [];
  const conflicts = [];
  const width = Math.max(priceRow.cells.length, linkRow ? linkRow.hrefs.length : 0);

  for (let i = 0; i < width; i++) {
    const token = byToken[i];
    const href = byHref[i];

    if (token && href) {
      if (tokenOf(href) === token) columns[i] = { name: href, evidence: 'token+href' };
      else conflicts.push({ index: i, token, href });
      continue;
    }
    if (token) {
      /* token only: recover the name from the family table by matching tokens */
      const name = Object.values(FAMILY_MEMBERS).flat().find(n => tokenOf(n) === token);
      if (name) columns[i] = { name, evidence: 'token' };
      else skipped.push({ index: i, reason: 'token ' + token + ' not in family table' });
      continue;
    }
    if (href) { columns[i] = { name: href, evidence: 'href' }; continue; }
    skipped.push({ index: i, reason: 'no token and no product link' });
  }
  return { columns, skipped, conflicts };
}

/* ---------------------------------------------------------------- spec rows
   Apple's real row labels, read off the live page. A row missing for a phone
   yields null — never a substituted value. */
const SPEC_ROWS = {
  'Display: Screen Size':        ['display', 'sizeMetric'],
  'Display: Retina':             ['display', 'type'],
  'Display: ProMotion':          ['display', 'refresh'],
  'Display: Always-On':          ['display', 'alwaysOn'],
  'Display: Dynamic Island':     ['display', 'dynamicIsland'],
  'Durability: Ceramic Shield':  ['display', 'protection'],
  'Design: Material':            ['body', 'material'],
  'Design: Buttons':             ['body', 'buttons'],
  'Design: Camera Control':      ['body', 'cameraControl'],
  'Durability: Design':          ['body', 'backMaterial'],
  'Durability: Water Resistant': ['body', 'waterResistance'],
  'Height':                      ['body', 'heightText'],
  'Width':                       ['body', 'widthText'],
  'Depth':                       ['body', 'depthText'],
  'Weight':                      ['body', 'weightText'],
  'Processor: Chip':             ['chipset', null],
  'Processor: CPU':              ['cpu', null],
  'Processor: GPU':              ['gpu', null],
  'Processor: Engine':           ['neuralEngine', null],
  'Processor: Ray tracing':      ['other', 'rayTracing'],
  'Battery':                     ['battery', 'summary'],
  'Video playback':              ['battery', 'videoPlayback'],
  'Video playback (streamed)':   ['battery', 'videoPlaybackStreamed'],
  'Fast-charge capable':         ['battery', 'fastCharge'],
  'Front Camera: Camera Type':   ['cameraFront', 'type'],
  'Front Camera: Stabilised Video': ['cameraFront', 'stabilisation'],
  'Rear Cameras: System':        ['cameraRear', 'system'],
  'Rear Cameras: Super High Resolution': ['cameraRear', 'resolution'],
  'Rear Cameras: Macro':         ['cameraRear', 'macro'],
  'Rear Cameras: Dolby Vision':  ['cameraRear', 'video'],
  'Optical zoom':                ['cameraRear', 'zoom'],
  'Connectivity':                ['connectivity', 'summary'],
  'MagSafe: Wireless Charging':  ['connectivity', 'wirelessCharging'],
  'Apple Intelligence':          ['other', 'appleIntelligence'],
  'Peace of mind: Emergency SOS': ['other', 'emergencySos'],
  'Peace of mind: Crash Detection': ['other', 'crashDetection']
};

const isEmpty = v => !v || v === '—' || v === '-';

/* "(6.3″) Super Retina XDR display 1" -> 6.3 */
function inchesFrom(text) {
  const m = String(text || '').match(/\((\d+(?:\.\d+)?)\s*[″"']\)/);
  return m ? Number(m[1]) : null;
}
/* "204 g (7.20 ounces)" -> 204 ; "14.98 cm" -> 149.8 mm */
function gramsFrom(text) {
  const m = String(text || '').match(/([\d.]+)\s*g\b/);
  return m ? Number(m[1]) : null;
}
/* Apple states body dimensions in mm ("149.6 mm (5.89")") but the display row
   in cm ("15.93cm"), so accept either and always return mm. */
function toMm(text) {
  const t = String(text || '');
  const mm = t.match(/([\d.]+)\s*mm/);
  if (mm) return Number(mm[1]);
  const cm = t.match(/([\d.]+)\s*cm/);
  return cm ? Math.round(Number(cm[1]) * 100) / 10 : null;
}

/* ------------------------------------------------------------------ colours
   Colour cells sit in `feature-group` blocks — one group per column, in the
   same order as the spec columns. */
function parseColors(html) {
  /* Split on the group boundary rather than trying to match a balanced block:
     each group nests cell-item divs, so a lazy <\/div><\/div> match stops at the
     first colour instead of collecting them all. */
  const groups = html.split(/class="feature-group compare-column"/).slice(1);
  return groups.map(g => {
    const upTo = g.split(/class="feature-group|<\/section>/)[0];
    return [...upTo.matchAll(/<div data-store-value="[^"]*">([\s\S]*?)<\/div>/g)]
      .map(c => clean(c[1]))
      .filter(v => v && v !== '—');
  });
}

/* The colour groups are not 1:1 with the spec columns — the page emits several
   unrelated groups first. The group holding the single word "Finish" is the
   section label, so the colour list for spec column i is the i-th group after
   it. Anchoring on that label rather than on a fixed offset means an extra
   group appearing earlier in the page cannot silently shift every phone's
   colours onto its neighbour. */
function colorsByColumn(groups) {
  const finish = groups.findIndex(g => g.length === 1 && /^finish$/i.test(g[0]));
  if (finish === -1) return [];
  return groups.slice(finish + 1);
}

/* ------------------------------------------------------------------- public */
async function collect({ url = SOURCES[SOURCE_ID].baseUrl, html = null } = {}) {
  const page = html || await fetchPage(url);
  const rows = parseRows(page);
  const { columns, skipped, conflicts } = resolveColumns(rows);
  const colorGroups = colorsByColumn(parseColors(page));
  const collectedAt = new Date().toISOString();

  const devices = Object.entries(columns).map(([idx, col]) => {
    const i = Number(idx);
    const spec = {};

    rows.forEach(r => {
      const map = r.label && SPEC_ROWS[r.label];
      if (!map) return;
      const value = r.cells[i];
      if (isEmpty(value)) return;
      const [group, field] = map;
      if (field === null) spec[group] = value;
      else { spec[group] = spec[group] || {}; spec[group][field] = value; }
    });

    /* derived numerics, so the app never parses display strings itself */
    if (spec.display) spec.display.sizeInch = inchesFrom(spec.display.type);
    if (spec.body) {
      spec.body.weightG = gramsFrom(spec.body.weightText);
      spec.body.heightMm = toMm(spec.body.heightText);
      spec.body.widthMm = toMm(spec.body.widthText);
      spec.body.depthMm = toMm(spec.body.depthText);
    }

    return {
      sourceId: SOURCE_ID,
      sourceUrl: url,
      columnIndex: i,
      evidence: col.evidence,
      brand: 'Apple',
      name: 'Apple ' + col.name,
      marketingName: col.name,
      spec,
      colors: (colorGroups[i] || []).map(c => ({
        id: slug(c), name: c, marketingName: c,
        region: null, isSpecialEdition: false,
        sourceId: SOURCE_ID, sourceUrl: url
      })),
      collectedAt
    };
  });

  return { devices, skipped, conflicts, columnsNamed: devices.length };
}

module.exports = {
  SOURCE_ID, collect, parseRows, resolveColumns, parseColors, SPEC_ROWS, FAMILY_MEMBERS
};
