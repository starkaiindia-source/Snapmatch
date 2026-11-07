/* ============================================================================
   Mobile Parts Finder · scripts/build-web-bundle.js
   ----------------------------------------------------------------------------
   Joins the app's boot scripts into assets/app.js and its three stylesheets
   into assets/app.css, then points every page at those two files.

   WHY
     Vercel Hobby counts every request at its edge, cached or not, and pauses
     the whole team at a million a month. A page that loaded eighteen scripts
     and three stylesheets one by one cost twenty-one of them before it had
     shown anything, and a visitor opening five model pages cost a hundred.
     That is what paused the site on 3 November 2026. Two files instead of
     twenty-one, cached in the browser for fifteen minutes (vercel.json), turn
     the next page view into one request: its HTML.

   WHY NOT A HASHED FILE NAME
     8,366 pre-rendered model pages name these files. A hash in the name would
     rewrite every one of them on every change to any script. A stable name
     with a short browser cache costs at most fifteen minutes of the previous
     script after a deploy, which the network-first service worker already
     tolerates.

   The source files stay where they are and stay the thing to edit. Every
   script is an IIFE that sets its own 'use strict', so joining them changes
   nothing about how they run. api/_lib/web-bundle.test.js fails when the
   bundle is older than its sources.

       node scripts/build-web-bundle.js          build and rewrite pages
       node scripts/build-web-bundle.js --check  exit 1 if anything is stale
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* The order matters: each script reads the SM.* globals the ones before it
   set. build-seo.js writes pages from this same list. */
const BOOT_JS = [
  'src/data/debug.js', 'src/data/dataset.js', 'src/data/brand-marks.js',
  'src/data/countries.js', 'src/data/firebase.js', 'src/data/firestore.js',
  'src/data/billing.js', 'src/data/auth.js', 'src/data/api.js',
  'src/data/access.js', 'src/data/analytics.js',
  'src/ui/icons.js', 'src/ui/product-art.js', 'src/data/category-assets.js',
  'src/data/brand-assets.js', 'src/data/pwa.js',
  'src/ui/components.js', 'src/app.js'
];
const BOOT_CSS = ['assets/styles.css', 'assets/components.css', 'assets/seo.css'];

const OUT_JS = 'assets/app.js';
const OUT_CSS = 'assets/app.css';

const SCRIPT_TAGS = BOOT_JS.map(s => `<script src="/${s}" defer></script>`);
const STYLE_TAGS = BOOT_CSS.map(s => `<link rel="stylesheet" href="/${s}" />`);
const SCRIPT_TAG = `<script src="/${OUT_JS}" defer></script>`;
const STYLE_TAG = `<link rel="stylesheet" href="/${OUT_CSS}" />`;

/* Folders that hold no served page, or hold someone else's copy of one. */
const SKIP = new Set(['node_modules', '.git', '.claude', '.cloudflare', '.vercel', '.review-video', 'data', 'dist', 'scripts', 'api', 'src']);

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lf = s => s.replace(/\r\n/g, '\n');

function joined(files, comment) {
  return files.map(f => `${comment(f)}\n${read(f).replace(/^﻿/, '').replace(/\s*$/, '')}\n`).join('\n');
}

/* The models that have an enriched record in assets/models-active/. app.js
   asks for a record only for these: asking for every model cost a request
   that 404'd on all but a handful of the 8,366 pages. */
function activeModels() {
  const dir = path.join(ROOT, 'assets', 'models-active');
  const ids = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort() : [];
  return `/* === models with a record in assets/models-active === */\nwindow.SM_ACTIVE_MODELS = ${JSON.stringify(ids)};\n`;
}

function bundles() {
  return {
    [OUT_JS]: activeModels() + '\n' + joined(BOOT_JS, f => `/* === ${f} === */;`),
    [OUT_CSS]: joined(BOOT_CSS, f => `/* === ${f} === */`)
  };
}

/* The tags as they sit in a page: one per line, any indentation, either line
   ending. Only the whole run in order is replaced, so a page that loads a
   different set is left exactly as it was. */
function runOf(tags) {
  return new RegExp(tags.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\r?\\n[ \\t]*'));
}
const SCRIPT_RUN = runOf(SCRIPT_TAGS);
const STYLE_RUN = runOf(STYLE_TAGS);

function rewrite(html) {
  return html.replace(SCRIPT_RUN, SCRIPT_TAG).replace(STYLE_RUN, STYLE_TAG);
}

function pages(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) pages(path.join(dir, e.name), out);
    } else if (e.name.endsWith('.html')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function run(check) {
  const stale = [];
  for (const [file, body] of Object.entries(bundles())) {
    const at = path.join(ROOT, file);
    const now = fs.existsSync(at) ? fs.readFileSync(at, 'utf8') : null;
    /* git may check the file out with other line endings than it was built with */
    if (now !== null && lf(now) === lf(body)) continue;
    stale.push(file);
    if (!check) fs.writeFileSync(at, body);
  }
  let rewritten = 0;
  for (const page of pages()) {
    const html = fs.readFileSync(page, 'utf8');
    const next = rewrite(html);
    if (next === html) continue;
    rewritten++;
    if (check) stale.push(path.relative(ROOT, page));
    else fs.writeFileSync(page, next);
  }
  return { stale, rewritten };
}

module.exports = { BOOT_JS, BOOT_CSS, OUT_JS, OUT_CSS, SCRIPT_TAG, STYLE_TAG, bundles, rewrite };

if (require.main === module) {
  const check = process.argv.includes('--check');
  const { stale, rewritten } = run(check);
  if (check) {
    if (stale.length) {
      console.error(`stale: ${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ` and ${stale.length - 5} more` : ''}. Run node scripts/build-web-bundle.js`);
      process.exit(1);
    }
    console.log('web bundle up to date');
  } else {
    console.log(`${stale.length ? "rebuilt" : "unchanged"}: ${OUT_JS}, ${OUT_CSS}; ${rewritten} page(s) moved to them`);
  }
}
