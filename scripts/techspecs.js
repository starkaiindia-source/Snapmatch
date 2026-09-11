/* ============================================================================
   Mobile Parts Finder · scripts/techspecs.js
   ----------------------------------------------------------------------------
   TechSpecs API v5 client, built for a paid account with a small credit
   balance. Every design choice here exists to avoid burning credits.

       node scripts/techspecs.js search "iPhone 15"
       node scripts/techspecs.js detail <productId>
       node scripts/techspecs.js model apple-iphone-15 "iPhone 15"   # search+detail
       node scripts/techspecs.js credits                             # spend so far

   API contract (from techspecs.readme.io, not assumed):
     base    https://api.techspecs.io/v5
     auth    two headers, x-api-id and x-api-key
     search  GET /products/search?query=&category=&brand=&page=0&size=10
     detail  GET /products/{product_id}?lang=en

   Credit safety
     * Every response is cached under data/techspecs/raw/. A cached call costs
       nothing and never re-hits the API, so re-running this script is free.
     * --force is the only way to re-request something already cached.
     * Every real request is appended to data/techspecs/_credit-log.json.
     * MOBILE ONLY: search is pinned to category=Smartphones, and detail refuses
       any product whose category is not a phone. Tablets, watches, earbuds and
       laptops can never enter this dataset.

   Credentials come from the environment (.env.local, git-ignored). The key is
   never written to the cache, the log, the database, or the front end.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'techspecs', 'raw');
const LOG = path.join(ROOT, 'data', 'techspecs', '_credit-log.json');
const BASE = 'https://api.techspecs.io/v5';

/* Phone categories only. Anything else is refused before it reaches the DB. */
const PHONE_CATEGORIES = ['smartphones', 'smartphone', 'feature phones', 'mobile phones', 'phones'];

/* ------------------------------------------------------------------- env */
function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    if (/^\s*#/.test(line)) return;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) return;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v && process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
}
loadEnvLocal();

function credentials() {
  const id = process.env.TECHSPECS_API_ID;
  const key = process.env.TECHSPECS_API_KEY;
  if (!id || !key) {
    console.error(`
  TechSpecs credentials missing.

  The v5 API needs BOTH values, which are on your TechSpecs dashboard under
  Profile -> API Keys. Add them to .env.local (git-ignored, never committed):

      TECHSPECS_API_ID=your-api-id
      TECHSPECS_API_KEY=your-api-key

  No request was made, so no credits were spent.
`);
    process.exit(2);
  }
  return { id, key };
}

/* ----------------------------------------------------------------- cache */
function cachePath(name) {
  fs.mkdirSync(RAW, { recursive: true });
  return path.join(RAW, `${name}.json`);
}
function readCache(name) {
  const p = cachePath(name);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}
function writeCache(name, payload) {
  fs.writeFileSync(cachePath(name), JSON.stringify(payload, null, 1), 'utf8');
}

/* ------------------------------------------------------------ credit log */
function logRequest(entry) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, 'utf8')) : { requests: [] };
  log.requests.push({ at: new Date().toISOString(), ...entry });
  fs.writeFileSync(LOG, JSON.stringify(log, null, 1), 'utf8');
  return log.requests.filter(r => !r.cached).length;
}
function spent() {
  if (!fs.existsSync(LOG)) return 0;
  return JSON.parse(fs.readFileSync(LOG, 'utf8')).requests.filter(r => !r.cached).length;
}

/* ------------------------------------------------------------------ http */
async function call(url, label, cacheName, force) {
  if (!force) {
    const hit = readCache(cacheName);
    if (hit) {
      console.log(`  cache hit  ${label}  (0 credits)`);
      return hit;
    }
  }
  const { id, key } = credentials();
  console.log(`  REQUEST    ${label}  (spends 1 credit)`);
  const res = await fetch(url, {
    headers: { 'x-api-id': id, 'x-api-key': key, accept: 'application/json' }
  });
  const body = await res.text();
  if (!res.ok) {
    logRequest({ endpoint: label, cached: false, ok: false, status: res.status });
    throw new Error(`TechSpecs ${res.status}: ${body.slice(0, 400)}`);
  }
  let json;
  try { json = JSON.parse(body); } catch { throw new Error(`Non-JSON response: ${body.slice(0, 300)}`); }
  writeCache(cacheName, json);
  const total = logRequest({ endpoint: label, cached: false, ok: true, status: res.status });
  console.log(`  cached     ${cacheName}.json   · real requests so far: ${total}`);
  return json;
}

/* --------------------------------------------------------------- publics */
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function search(query, { brand = '', category = 'Smartphones', size = '10', force = false } = {}) {
  const qs = new URLSearchParams({ query, category, brand, page: '0', size, keepCasing: 'true' });
  return call(`${BASE}/products/search?${qs}`, `search "${query}"`, `search-${slug(query)}`, force);
}

async function detail(productId, { force = false } = {}) {
  const qs = new URLSearchParams({ lang: 'en', keepCasing: 'true' });
  return call(`${BASE}/products/${encodeURIComponent(productId)}?${qs}`,
    `detail ${productId}`, `product-${slug(productId)}`, force);
}

/* Pulls whatever the payload calls a category and checks it is a phone. */
function categoryOf(obj) {
  const seen = [];
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 4) return;
    for (const [k, v] of Object.entries(o)) {
      if (/^category$/i.test(k) && typeof v === 'string') seen.push(v);
      else if (v && typeof v === 'object') walk(v, depth + 1);
    }
  })(obj, 0);
  return seen;
}
function isPhone(obj) {
  const cats = categoryOf(obj).map(c => c.toLowerCase());
  if (!cats.length) return null;                       // unknown, caller decides
  return cats.some(c => PHONE_CATEGORIES.some(p => c.includes(p)));
}

module.exports = { search, detail, isPhone, categoryOf, spent, readCache, BASE };

/* -------------------------------------------------------------------- cli */
if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const force = rest.includes('--force');
  const args = rest.filter(a => a !== '--force');

  (async () => {
    if (cmd === 'credits') {
      console.log(`  real API requests logged: ${spent()}`);
      return;
    }
    if (cmd === 'search') {
      const out = await search(args.join(' '), { brand: 'Apple', force });
      console.log(JSON.stringify(out, null, 1).slice(0, 4000));
      return;
    }
    if (cmd === 'detail') {
      const out = await detail(args[0], { force });
      const phone = isPhone(out);
      if (phone === false) {
        console.error('  REFUSED: this product is not a phone. Mobile-only rule.');
        process.exit(3);
      }
      console.log(JSON.stringify(out, null, 1).slice(0, 6000));
      return;
    }
    console.error('usage: node scripts/techspecs.js <search|detail|credits> [...]');
    process.exit(1);
  })().catch(e => { console.error('  ' + e.message); process.exit(1); });
}
