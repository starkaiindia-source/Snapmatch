/* ============================================================================
   Mobile Parts Finder · scripts/build-brand-marks.js
   ----------------------------------------------------------------------------
   Regenerates src/data/brand-marks.js — the inlined official brand vectors —
   and writes a standalone SVG per brand into assets/brands/, which is what
   scripts/upload-brand-assets.js pushes to Firebase Storage.

       npm i -D simple-icons
       node scripts/build-brand-marks.js

   Flags
     --dry   report what would change, write nothing

   WHERE THE ARTWORK COMES FROM

     Simple Icons (https://simpleicons.org), CC0-1.0 — public domain. The logos
     stay the trademarks of their owners and are used nominatively, to say which
     manufacturer a part fits. That is what a parts catalogue is for.

   BRANDS SIMPLE ICONS DOES NOT CARRY

     Listed in SM.brandMarksReview at the bottom of the generated file. They are
     NOT approximated here — a drawn-from-memory logo is a wrong logo, which is
     worse than none. They render as a full wordmark in the brand's own official
     colour until a licensed file is supplied, which is what the Firebase
     Storage tier in src/data/brand-assets.js exists for.

   IDEMPOTENT. Re-running rewrites the same files from the same package.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_JS = path.join(ROOT, 'src', 'data', 'brand-marks.js');
const OUT_SVG = path.join(ROOT, 'assets', 'brands');
const DATASET = path.join(ROOT, 'assets', 'dataset.json');

const DRY = process.argv.indexOf('--dry') > -1;

let si;
try {
  si = require('simple-icons');
} catch (e) {
  console.error('\n  simple-icons is not installed. It is a build-time dependency only:\n' +
    '    npm i -D simple-icons\n');
  process.exit(1);
}

/* Every brand in the catalogue, plus a few this project has shipped marks for
   and may sell parts for again. The dataset is the source of truth for which
   brands the site actually shows. */
const EXTRA = ['sony', 'lg', 'htc'];

const dataset = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
const catalogue = dataset.brands.map((r) => ({ id: r[0], name: r[1] }));
const wanted = catalogue.concat(EXTRA.map((id) => ({ id, name: id.toUpperCase() })));

/* Simple Icons' slug for a brand is not always our id. Match on the slug
   first, then on a normalised title, and never on a partial — "vivo" must not
   pick up "Vivaldi". */
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const bySlug = Object.create(null);
const byTitle = Object.create(null);
Object.values(si).forEach((icon) => {
  if (!icon || !icon.slug || !icon.path) return;
  bySlug[icon.slug] = icon;
  const t = norm(icon.title);
  if (!byTitle[t]) byTitle[t] = icon;
});

/* Simple Icons publishes Sony's mark in white, for use on a dark ground. Marks
   on this site sit on a pale chip, where white is invisible; a near-black
   substitution keeps the shape correct and the contrast real. Any substitution
   is recorded in the generated file rather than made silently. */
const COLOUR_OVERRIDE = { sony: '1A1A1A' };

const marks = {};
const review = [];
const adjusted = [];

wanted.forEach((b) => {
  const icon = bySlug[b.id] || byTitle[norm(b.id)] || byTitle[norm(b.name)];
  if (!icon) { review.push(b.id); return; }
  const hex = COLOUR_OVERRIDE[b.id] || icon.hex;
  marks[b.id] = { t: icon.title, h: hex, p: icon.path };
  if (COLOUR_OVERRIDE[b.id]) { marks[b.id].adj = true; adjusted.push(b.id); }
});

/* One standalone file per mark. The site does not fetch these — the inline
   vectors are what it renders — but they are the artwork the Storage uploader
   pushes, and the file the owner replaces when a licensed logo arrives.
   Written in the brand colour so a file opened on its own looks right. */
const xml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const svgFor = (m) =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" aria-label="' +
  xml(m.t) + '"><title>' + xml(m.t) + '</title>' +
  '<path fill="#' + m.h + '" d="' + m.p + '"/></svg>\n';

const siVersion = (() => {
  try { return require('simple-icons/package.json').version; } catch (e) { return null; }
})();

const banner = [
  '/* ============================================================================',
  '   Mobile Parts Finder · brand-marks.js — official brand marks, inline',
  '   ----------------------------------------------------------------------------',
  '   GENERATED. Do not edit by hand — run: node scripts/build-brand-marks.js',
  '',
  '   Vector paths for the brand logos, embedded rather than fetched. Inlining',
  '   them means a logo cannot fail to load, cannot leak a request to a third',
  '   party, and stays crisp at any size — the whole brand rail costs zero network',
  '   requests and paints with the first frame.',
  '',
  '   SOURCE AND LICENCE',
  '     Simple Icons (https://simpleicons.org), CC0-1.0 — public domain. The logos',
  '     remain the trademarks of their owners and are used nominatively, to',
  '     identify which manufacturer a part fits.',
  '',
  '   BRANDS WITHOUT A MARK',
  '     Simple Icons carries no logo for the ids in SM.brandMarksReview. They are',
  '     not approximated here: a drawn-from-memory logo is a WRONG logo, and that',
  '     is worse than none. Those brands render as a full wordmark in their own',
  '     official colour, and are the reason src/data/brand-assets.js exists — drop',
  '     a licensed file in Firebase Storage and it takes precedence over',
  '     everything in this file.',
  '',
  '   COLOUR',
  '     `h` is the brand’s own hex, and `adj` marks a substitution made because',
  '     the published colour is unusable on a pale logo chip (Sony publishes',
  '     white). src/data/brand-assets.js decides how that colour is PRESENTED per',
  '     theme; this file only records what it is.',
  '',
  '   Generated ' + new Date().toISOString(),
  '   ========================================================================== */'
].join('\n');

const body = [
  '(function (global) {',
  "  'use strict';",
  '  var SM = (global.SM = global.SM || {});',
  '',
  '  /* id: { t: title, h: hex, p: path, adj: colour was substituted } */',
  '  SM.brandMarks = ' + JSON.stringify(marks) + ';',
  '',
  '  /* No official CC0 mark available — these render a full wordmark instead. */',
  '  SM.brandMarksReview = ' + JSON.stringify(review) + ';',
  '',
  '  SM.brandMarksMeta = ' + JSON.stringify({
    source: 'simple-icons (CC0-1.0)',
    version: siVersion,
    generated: new Date().toISOString(),
    adjusted
  }) + ';',
  '})(window);',
  ''
].join('\n');

if (DRY) {
  console.log('marks   ' + Object.keys(marks).length + ': ' + Object.keys(marks).join(', '));
  console.log('review  ' + review.length + ': ' + review.join(', '));
  process.exit(0);
}

fs.mkdirSync(OUT_SVG, { recursive: true });
Object.keys(marks).forEach((id) => {
  fs.writeFileSync(path.join(OUT_SVG, id + '.svg'), svgFor(marks[id]), 'utf8');
});
fs.writeFileSync(OUT_JS, banner + '\n' + body, 'utf8');

console.log('brand marks  ' + Object.keys(marks).length + '  -> src/data/brand-marks.js');
console.log('svg files    ' + Object.keys(marks).length + '  -> assets/brands/');
console.log('no mark      ' + review.length + '  ' + review.join(', '));
