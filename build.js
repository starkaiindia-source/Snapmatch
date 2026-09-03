/* ============================================================================
   Mobile Parts Finder · build.js
   Inlines the CSS and JS sources into two single-file bundles:
     dist/mobile-parts-finder.html          — full standalone page (open directly)
     dist/mobile-parts-finder.artifact.html — body-fragment build for publishing
   No minifier, no dependencies: run `node build.js`.
   ========================================================================== */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const CSS = ['assets/styles.css', 'assets/components.css'];
const JS = [
  'src/data/dataset.js',
  'src/data/brand-marks.js',
  'src/data/countries.js',
  'src/data/firebase.js',
  'src/data/billing.js',
  'src/data/auth.js',
  'src/data/api.js',
  'src/ui/icons.js',
  'src/ui/product-art.js',
  'src/ui/components.js',
  'src/app.js'
];

const FONTS = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700;12..96,800&family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap';

const css = CSS.map((f) => `/* === ${f} === */\n${read(f)}`).join('\n\n');
const js = JS.map((f) => `/* === ${f} === */\n${read(f)}`).join('\n\n');

const head = `<title>Mobile Parts Finder</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="${FONTS}" rel="stylesheet" />
<style>
${css}
</style>`;

const bodyContent = `<div id="app" class="app"></div>
<script>
${js}
</script>`;

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

fs.writeFileSync(
  path.join(root, 'dist/mobile-parts-finder.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0F766E" />
${head}
</head>
<body>
${bodyContent}
</body>
</html>
`
);

/* Artifact build: no doctype/html/head/body wrappers — those are added at
   publish time. Everything else is identical. */
fs.writeFileSync(
  path.join(root, 'dist/mobile-parts-finder.artifact.html'),
  `${head}
${bodyContent}
`
);

const kb = (p) => (fs.statSync(path.join(root, p)).size / 1024).toFixed(0) + ' KB';
console.log('built dist/mobile-parts-finder.html          ' + kb('dist/mobile-parts-finder.html'));
console.log('built dist/mobile-parts-finder.artifact.html ' + kb('dist/mobile-parts-finder.artifact.html'));
