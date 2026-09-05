/* ============================================================================
   Mobile Parts Finder · scripts/build-seo.js
   ----------------------------------------------------------------------------
   Generates everything a search engine needs and a single-page app cannot
   produce on its own:

     robots.txt                      what may be crawled, and where the sitemap is
     sitemap.xml                     every indexable URL, absolute and canonical
     site.webmanifest                installable-app metadata
     <route>/index.html              a real, pre-rendered page per SEO route

     node scripts/build-seo.js

   WHY PRE-RENDER AT ALL

     Googlebot renders JavaScript, so an SPA can be indexed. Facebook, X,
     WhatsApp, LinkedIn and Slack do not — they read the HTML as served. A site
     whose <title> and og:image are written by JavaScript shares as a blank card
     with the wrong name, on every platform, every time.

     So the pages that matter are written to disk as real HTML with their own
     title, description, canonical, Open Graph and JSON-LD. The app then boots
     over the top and takes the page from there.

   WHAT IS PRE-RENDERED IS WHAT THE PAGE ACTUALLY SAYS

     The static content is a summary of the same catalogue the app renders from,
     drawn from assets/dataset.json — the brand's real model count, the
     category's real group count, real links to real pages. It is not a
     keyword page written for a crawler and hidden from people. Serving one
     thing to Googlebot and another to a visitor is cloaking, and it is both
     against the rules and easy to detect.

   NO RANKING IS PROMISED BY ANY OF THIS

     Crawlability and indexability are what a site controls. Position is not.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ORIGIN = 'https://www.mobilepartsfinder.com';
const BRAND = 'Mobile Parts Finder';
const OG_IMAGE = ORIGIN + '/assets/brand/og-image.png';

const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'dataset.json'), 'utf8'));

const CATS = dataset.categories.map(c => ({ id: c.id, name: c.name, groups: c.groupCount }));
const BRANDS = dataset.brands.map(r => ({ id: r[0], name: r[1], models: r[2], groups: r[3] }))
  .filter(b => b.models > 0)
  .sort((a, b) => b.models - a.models);

const STATS = {
  models: dataset.models.length,
  groups: dataset.groups.length,
  brands: BRANDS.length,
  fitments: dataset.groups.reduce((n, r) => n + (r[dataset.groupCols.indexOf('cnt')] || 0), 0)
};

/* The model rows are positional to keep the bundle small; decode them once. */
const MC = {};
dataset.modelCols.forEach((k, i) => { MC[k] = i; });
const MODELS = dataset.models.map(r => ({
  id: r[MC.id], brandId: r[MC.b], name: r[MC.n],
  releaseDate: r[MC.rd], year: r[MC.ry],
  size: r[MC.sz], h: r[MC.h], w: r[MC.w], cm2: r[MC.cm2], ratio: r[MC.br],
  mah: r[MC.mah], img: r[MC.img], src: r[MC.src], type: r[MC.dt],
  screenType: r[MC.st], batteryPart: r[MC.bp], batteryVerified: r[MC.bv]
}));
const MODEL_GROUPS = dataset.modelGroups || {};
const BRAND_BY_ID = {};
dataset.brands.forEach(r => { BRAND_BY_ID[r[0]] = r[1]; });
const CAT_BY_ID = {};
dataset.categories.forEach(c => { CAT_BY_ID[c.id] = c.name; });

const nf = n => Number(n).toLocaleString('en-IN');
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ------------------------------------------------------------------- pages

   Each entry becomes one real HTML file and one sitemap row. `body` returns the
   visible content — the same thing a person sees before the app boots, and the
   only thing a crawler that does not run scripts will ever see. It has to be
   worth reading on its own. */

const CATEGORY_COPY = {
  'screen-guards': {
    slug: 'universal-tempered-glass',
    h1: 'Universal tempered glass — which models share one size',
    lede: 'Tempered glass fits by dimensions, not by brand. When two phones share a ' +
          'screen size and body, one glass covers both. These are the compatibility ' +
          'groups that let a counter stock fewer lines and still cover more phones.',
    intent: 'universal tempered glass, tempered glass compatible models, mobile tempered glass finder'
  },
  'back-cover': {
    slug: 'universal-back-cover',
    h1: 'Universal back cover — compatible model groups',
    lede: 'A back cover cut for one body fits every phone built on it. Each group ' +
          'below lists the models a single cover covers, so a dealer can order by ' +
          'group rather than by handset.',
    intent: 'universal back cover, back cover compatible models, mobile back cover finder'
  },
  'combo-display': {
    slug: 'combo-display',
    h1: 'Combo display compatibility — models that take the same panel',
    lede: 'Combo and folder displays are shared across far more handsets than their ' +
          'model names suggest. Each group is one panel and every device it fits.',
    intent: 'combo display compatible models, mobile display compatibility, display compatible models'
  },
  'middle-frame': {
    slug: 'middle-frame',
    h1: 'Middle frame compatibility — shared chassis groups',
    lede: 'A middle frame follows the chassis, so handsets from one production run ' +
          'often share it. These groups show which.',
    intent: 'middle frame compatible models, mobile middle frame finder'
  },
  'cc-board': {
    slug: 'cc-board',
    h1: 'CC board compatibility — charging boards by compatible model',
    lede: 'Charging connector boards are shared across variants of the same handset ' +
          'and often across siblings in a series. Each group lists every model that ' +
          'takes the same board.',
    intent: 'cc board compatible models, mobile cc board finder, universal cc board'
  },
  'battery': {
    slug: 'battery',
    h1: 'Battery compatibility — models sharing one battery',
    lede: 'Batteries carry a manufacturer part number, and one battery serves several ' +
          'handsets. Where the catalogue has the manufacturer code it is shown ' +
          'alongside the models it fits.',
    intent: 'battery compatible models, mobile battery finder, phone battery compatibility'
  }
};

function head(p) {
  const canonical = ORIGIN + p.url;
  const jsonld = JSON.stringify(p.jsonld, null, 2);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.description)}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta name="theme-color" content="#0F766E" />
<meta name="robots" content="index, follow, max-image-preview:large" />

<meta property="og:type" content="website" />
<meta property="og:site_name" content="${esc(BRAND)}" />
<meta property="og:title" content="${esc(p.title)}" />
<meta property="og:description" content="${esc(p.description)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:image" content="${esc(OG_IMAGE)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(p.title)}" />
<meta name="twitter:description" content="${esc(p.description)}" />
<meta name="twitter:image" content="${esc(OG_IMAGE)}" />

<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/assets/brand/icon-180.png" />
<link rel="manifest" href="/site.webmanifest" />

<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700;12..96,800&family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/assets/styles.css" />
<link rel="stylesheet" href="/assets/components.css" />
<link rel="stylesheet" href="/assets/seo.css" />
<script type="application/ld+json">
${jsonld}
</script>
</head>
<body>`;
}

/* The app boots over the top of the static content. Until it does — and for a
   crawler that never runs it — what is above stays on the page and is the real
   answer, not a placeholder.

   Absolute paths, because a relative one resolves against the current URL and
   on /models/apple the browser would ask for /models/src/... and load nothing.

   `defer` because these must not block parsing of the pre-rendered content
   that is the whole point of the file; it preserves execution order, which is
   what the SM.* globals depend on. */
const APP_BOOT = [
  'src/data/debug.js', 'src/data/dataset.js', 'src/data/brand-marks.js',
  'src/data/countries.js', 'src/data/firebase.js', 'src/data/firestore.js',
  'src/data/billing.js', 'src/data/auth.js', 'src/data/api.js',
  /* Kept in step with index.html and with build.js. Three lists that name the
     same scripts is two lists that can be forgotten — and a script missing
     from HERE is missing from every pre-rendered page while working perfectly
     on the SPA shell, which is the hardest version of that bug to notice. */
  'src/data/analytics.js',
  'src/ui/icons.js', 'src/ui/product-art.js', 'src/data/category-assets.js',
  'src/ui/components.js', 'src/app.js'
].map(s => `<script src="/${s}" defer></script>`).join('\n');

function shell(p) {
  return head(p) +
`
<div class="seo" id="seoContent">
  <header class="seo__bar">
    <a class="seo__brand" href="/">
      <img src="/assets/brand/logo.svg" width="34" height="34" alt="Mobile Parts Finder logo" />
      <span>Mobile Parts <b>Finder</b></span>
    </a>
    <nav class="seo__nav" aria-label="Main">
      <a href="/finder">Device Finder</a>
      <a href="/models">All mobile models</a>
      <a href="/plans">Plans</a>
    </nav>
  </header>

  ${p.breadcrumbHTML || ''}
  <main class="seo__main">
${p.body}
  </main>

  <footer class="seo__foot">
    <p><strong>${esc(BRAND)}</strong> — spare-part compatibility for mobile shops,
    accessory dealers, wholesalers, distributors and repair technicians.
    ${nf(STATS.models)} phone models, ${nf(STATS.groups)} compatibility groups,
    ${nf(STATS.fitments)} recorded fitments across ${STATS.brands} brands.</p>
    <nav aria-label="Parts categories">
      ${CATS.map(c => `<a href="/categories/${c.id}">${esc(c.name)}</a>`).join('\n      ')}
    </nav>
    <nav aria-label="Brands">
      ${BRANDS.slice(0, 12).map(b => `<a href="/models/${b.id}">${esc(b.name)}</a>`).join('\n      ')}
      <a href="/models">All brands</a>
    </nav>
  </footer>
</div>

<div id="app" class="app" hidden></div>
${APP_BOOT}
<script>
/* The static content above is what a crawler reads and what a visitor sees
   first. Once the app has mounted it takes over the page; if the app never
   loads — a script blocked, a slow connection — this stays, which is a better
   failure than a blank screen. */
(function () {
  var seo = document.getElementById('seoContent');
  var app = document.getElementById('app');
  var seen = new MutationObserver(function () {
    if (app.childNodes.length) {
      app.hidden = false;
      if (seo) seo.remove();
      seen.disconnect();
    }
  });
  seen.observe(app, { childList: true });
})();
</script>
</body>
</html>
`;
}

function breadcrumb(trail) {
  return `<nav class="seo__crumbs" aria-label="Breadcrumb"><ol>` +
    trail.map((t, i) => `<li>${i < trail.length - 1
      ? `<a href="${esc(t.url)}">${esc(t.name)}</a>`
      : `<span aria-current="page">${esc(t.name)}</span>`}</li>`).join('') +
    `</ol></nav>`;
}

function breadcrumbLd(trail) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({
      '@type': 'ListItem', position: i + 1, name: t.name, item: ORIGIN + t.url
    }))
  };
}

const ORG_LD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: BRAND,
  url: ORIGIN + '/',
  logo: ORIGIN + '/assets/brand/icon-512.png',
  description: 'Spare-part compatibility database for mobile phone shops, accessory ' +
               'dealers and repair technicians.'
};

/* ------------------------------------------------------------------ builders */

function homepage() {
  const body = `
    <h1>Mobile Parts Finder — universal mobile accessories &amp; spare parts compatibility database</h1>
    <p class="seo__lede">Find which phone models share the same tempered glass, back cover,
    combo display, middle frame, CC board or battery. Built for mobile shop owners,
    accessory dealers, wholesalers, distributors and repair technicians who need to know
    what fits before they order.</p>

    <ul class="seo__stats">
      <li><b>${nf(STATS.models)}</b><span>phone models</span></li>
      <li><b>${nf(STATS.groups)}</b><span>compatibility groups</span></li>
      <li><b>${nf(STATS.fitments)}</b><span>recorded fitments</span></li>
      <li><b>${STATS.brands}</b><span>brands</span></li>
    </ul>

    <h2>Find compatible mobile models</h2>
    <p>Type a handset into the Device Finder and it returns every compatibility group that
    handset belongs to — the part code, the master model the group is cut from, and every
    other device that takes the same part.
    <a href="/finder">Open the Device Finder</a>.</p>

    <h2>Universal tempered glass compatibility</h2>
    <p>Tempered glass fits by dimensions rather than by brand, so one screen protector
    routinely covers several handsets. ${nf(CATS.find(c => c.id === 'screen-guards').groups)}
    screen-guard groups are listed.
    <a href="/universal-tempered-glass">Universal tempered glass compatible models</a>.</p>

    <h2>Back cover compatibility</h2>
    <p>A cover cut for one body fits every phone built on it.
    ${nf(CATS.find(c => c.id === 'back-cover').groups)} back-cover groups.
    <a href="/universal-back-cover">Universal back cover compatible models</a>.</p>

    <h2>CC board compatibility finder</h2>
    <p>Charging connector boards are shared across variants and siblings in a series.
    ${nf(CATS.find(c => c.id === 'cc-board').groups)} CC board groups.
    <a href="/categories/cc-board">CC board compatible models</a>.</p>

    <h2>Mobile spare parts database</h2>
    <p>Every part category in the catalogue, with the number of compatibility groups
    recorded in each.</p>
    <ul class="seo__grid">
      ${CATS.map(c => `<li><a href="/categories/${c.id}"><b>${esc(c.name)}</b>
        <span>${nf(c.groups)} groups</span></a></li>`).join('\n      ')}
    </ul>

    <h2>Browse by brand</h2>
    <ul class="seo__grid">
      ${BRANDS.map(b => `<li><a href="/models/${b.id}"><b>${esc(b.name)}</b>
        <span>${nf(b.models)} models</span></a></li>`).join('\n      ')}
    </ul>

    <h2>Who this is for</h2>
    <p>Mobile shop owners and accessory dealers deciding which lines to stock; wholesalers
    and distributors matching an order to the handsets it covers; repair technicians
    identifying a part before opening a device. The catalogue answers one question —
    <em>what else does this fit</em> — and it answers it from recorded fitments rather than
    from guesswork.</p>`;

  return {
    url: '/',
    title: 'Mobile Parts Finder — Universal Tempered Glass & Mobile Spare Parts Compatibility Database',
    description: 'Find compatible mobile models for tempered glass, back cover, combo display, ' +
      'CC board, middle frame and battery. ' + nf(STATS.models) + ' phone models and ' +
      nf(STATS.groups) + ' compatibility groups for mobile shops, accessory dealers and repair technicians.',
    body,
    jsonld: [ORG_LD, {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: BRAND,
      url: ORIGIN + '/',
      /* Declared because /models really does accept ?q= and return matching
         devices. Claiming a search action a site cannot honour is the kind of
         structured data that gets a site's rich results turned off. */
      potentialAction: {
        '@type': 'SearchAction',
        target: { '@type': 'EntryPoint', urlTemplate: ORIGIN + '/models?q={search_term_string}' },
        'query-input': 'required name=search_term_string'
      }
    }]
  };
}

function categoryPage(cat) {
  const copy = CATEGORY_COPY[cat.id];
  const url = '/categories/' + cat.id;
  const trail = [
    { name: 'Home', url: '/' },
    { name: 'Parts categories', url: '/categories' },
    { name: cat.name, url }
  ];
  const body = `
    <h1>${esc(copy.h1)}</h1>
    <p class="seo__lede">${esc(copy.lede)}</p>
    <p><strong>${nf(cat.groups)}</strong> ${esc(cat.name.toLowerCase())} compatibility groups are
    recorded in the catalogue.
    <a href="/finder">Search the Device Finder</a> to match a specific handset.</p>

    <h2>How ${esc(cat.name.toLowerCase())} compatibility works here</h2>
    <p>A compatibility group is one part and every device it fits. Each group carries a part
    code, a serial number, the master model it is cut from, and the full list of compatible
    devices. Where the source data records a manufacturer part number it is shown alongside;
    where it does not, the field is left blank rather than filled with a guess.</p>

    <h2>Other part categories</h2>
    <ul class="seo__grid">
      ${CATS.filter(c => c.id !== cat.id).map(c =>
        `<li><a href="/categories/${c.id}"><b>${esc(c.name)}</b>
        <span>${nf(c.groups)} groups</span></a></li>`).join('\n      ')}
    </ul>

    <h2>Browse ${esc(cat.name.toLowerCase())} by brand</h2>
    <ul class="seo__grid">
      ${BRANDS.slice(0, 16).map(b => `<li><a href="/models/${b.id}"><b>${esc(b.name)}</b>
        <span>${nf(b.models)} models</span></a></li>`).join('\n      ')}
    </ul>`;

  return {
    url,
    title: `${cat.name} Compatible Mobile Models | ${BRAND}`,
    description: `${cat.name} compatibility for ${nf(STATS.models)} phone models — ` +
      `${nf(cat.groups)} groups showing which devices share the same part. ` +
      `For mobile shops, accessory dealers and repair technicians.`,
    body,
    breadcrumbHTML: breadcrumb(trail),
    jsonld: [breadcrumbLd(trail)]
  };
}

/* The two categories people search for by the words "universal tempered glass"
   and "universal back cover" get that URL as well as the category one. They are
   not duplicates: each carries its own copy and each points at the other, and
   the canonical on both is itself. */
function aliasPage(cat, slug, title, description) {
  const base = categoryPage(cat);
  const url = '/' + slug;
  const trail = [{ name: 'Home', url: '/' }, { name: cat.name, url }];
  return Object.assign({}, base, {
    url, title, description,
    breadcrumbHTML: breadcrumb(trail),
    jsonld: [breadcrumbLd(trail)],
    body: base.body + `
    <p class="seo__also">Also listed under
    <a href="/categories/${cat.id}">${esc(cat.name)} in the parts categories</a>.</p>`
  });
}

function brandPage(b) {
  const url = '/models/' + b.id;
  const trail = [
    { name: 'Home', url: '/' },
    { name: 'All mobile models', url: '/models' },
    { name: b.name, url }
  ];
  const body = `
    <h1>${esc(b.name)} mobile models &amp; compatible parts finder</h1>
    <p class="seo__lede">${nf(b.models)} ${esc(b.name)} models are in the catalogue, with
    ${nf(b.groups)} compatibility groups where an ${esc(b.name)} device is the master model.
    Find which spare parts fit which handset before ordering.</p>

    <h2>What is recorded for each ${esc(b.name)} model</h2>
    <p>Model name, release date, display size, body dimensions, screen area and battery
    capacity, together with the compatibility groups the device belongs to across every part
    category. Fields the source does not carry are shown as “-” rather than estimated.</p>

    <h2>${esc(b.name)} parts by category</h2>
    <ul class="seo__grid">
      ${CATS.map(c => `<li><a href="/categories/${c.id}"><b>${esc(c.name)}</b>
        <span>${nf(c.groups)} groups</span></a></li>`).join('\n      ')}
    </ul>

    <p><a href="/finder">Open the Device Finder</a> to match a specific ${esc(b.name)}
    handset to its compatibility groups.</p>

    <h2>Other brands</h2>
    <ul class="seo__grid">
      ${BRANDS.filter(x => x.id !== b.id).slice(0, 20).map(x =>
        `<li><a href="/models/${x.id}"><b>${esc(x.name)}</b>
        <span>${nf(x.models)} models</span></a></li>`).join('\n      ')}
    </ul>`;

  return {
    url,
    title: `${b.name} Mobile Models & Compatible Parts Finder | ${BRAND}`,
    description: `${nf(b.models)} ${b.name} models with compatible tempered glass, back cover, ` +
      `combo display, CC board, middle frame and battery groups. ` +
      `Spare-part compatibility for mobile shops and repair technicians.`,
    body,
    breadcrumbHTML: breadcrumb(trail),
    jsonld: [breadcrumbLd(trail)]
  };
}

function modelsIndex() {
  const url = '/models';
  const trail = [{ name: 'Home', url: '/' }, { name: 'All mobile models', url }];
  return {
    url,
    title: `All Mobile Models — ${nf(STATS.models)} Phones by Brand | ${BRAND}`,
    description: `Browse ${nf(STATS.models)} phone models across ${STATS.brands} brands with ` +
      `dimensions, display size, battery and the spare parts that fit each one.`,
    breadcrumbHTML: breadcrumb(trail),
    jsonld: [breadcrumbLd(trail)],
    body: `
    <h1>All mobile models — ${nf(STATS.models)} phones across ${STATS.brands} brands</h1>
    <p class="seo__lede">The full device catalogue, organised by brand. Each model carries its
    release date, display size, body dimensions and battery capacity, plus the compatibility
    groups it belongs to.</p>
    <ul class="seo__grid">
      ${BRANDS.map(b => `<li><a href="/models/${b.id}"><b>${esc(b.name)}</b>
        <span>${nf(b.models)} models</span></a></li>`).join('\n      ')}
    </ul>`
  };
}

function categoriesIndex() {
  const url = '/categories';
  const trail = [{ name: 'Home', url: '/' }, { name: 'Parts categories', url }];
  return {
    url,
    title: `Mobile Spare Parts Categories — Compatibility Groups | ${BRAND}`,
    description: `Tempered glass, back cover, combo display, middle frame, CC board and ` +
      `battery compatibility — ${nf(STATS.groups)} groups showing which phones share each part.`,
    breadcrumbHTML: breadcrumb(trail),
    jsonld: [breadcrumbLd(trail)],
    body: `
    <h1>Mobile spare parts categories</h1>
    <p class="seo__lede">Six part categories, ${nf(STATS.groups)} compatibility groups. Each
    group is one part and every device it fits.</p>
    <ul class="seo__grid">
      ${CATS.map(c => `<li><a href="/categories/${c.id}"><b>${esc(c.name)}</b>
        <span>${nf(c.groups)} groups</span></a></li>`).join('\n      ')}
    </ul>`
  };
}

function finderPage() {
  const url = '/finder';
  const trail = [{ name: 'Home', url: '/' }, { name: 'Device Finder', url }];
  return {
    url,
    title: `Mobile Compatibility Finder — Match a Phone to Its Parts | ${BRAND}`,
    description: `Type any of ${nf(STATS.models)} phone models and get every compatibility ` +
      `group it belongs to: the part code, the master model and every other device that fits.`,
    breadcrumbHTML: breadcrumb(trail),
    jsonld: [breadcrumbLd(trail)],
    body: `
    <h1>Mobile compatibility finder</h1>
    <p class="seo__lede">Search ${nf(STATS.models)} phone models and get every compatibility
    group the handset belongs to — across tempered glass, back cover, combo display, middle
    frame, CC board and battery.</p>
    <h2>What a result contains</h2>
    <p>The part code, the group number and serial number, the master model the part is cut
    from, and the complete list of other devices that take the same part. Where the catalogue
    records a manufacturer part number, that is shown too.</p>
    <ul class="seo__grid">
      ${CATS.map(c => `<li><a href="/categories/${c.id}"><b>${esc(c.name)}</b>
        <span>${nf(c.groups)} groups</span></a></li>`).join('\n      ')}
    </ul>`
  };
}

function plansPage() {
  const url = '/plans';
  const trail = [{ name: 'Home', url: '/' }, { name: 'Plans', url }];
  return {
    url,
    title: `Plans — ${BRAND} for Mobile Shops`,
    description: `Monthly and yearly plans for Mobile Parts Finder. The catalogue is open to ` +
      `use; a plan supports keeping it current.`,
    breadcrumbHTML: breadcrumb(trail),
    jsonld: [breadcrumbLd(trail)],
    body: `
    <h1>Plans</h1>
    <p class="seo__lede">Mobile Parts Finder is built for the counter — look up a model, get the
    group, read the part code to a supplier.</p>
    <h2>Monthly and yearly</h2>
    <p>₹99 per month, or ₹799 per year. The whole catalogue —
    ${nf(STATS.groups)} compatibility groups and ${nf(STATS.fitments)} fitments — is open to
    use, and a plan supports keeping it current.</p>`
  };
}

function brandLandingPage() {
  const url = '/mobile-parts-finder';
  const trail = [{ name: 'Home', url: '/' }, { name: 'About', url }];
  return {
    url,
    title: `Mobile Parts Finder — Spare Parts Compatibility Database for Mobile Shops`,
    description: `What Mobile Parts Finder does, who it is for, and how compatibility groups ` +
      `let a shop stock fewer lines while covering more handsets.`,
    breadcrumbHTML: breadcrumb(trail),
    jsonld: [ORG_LD, breadcrumbLd(trail)],
    body: `
    <h1>Mobile Parts Finder</h1>
    <p class="seo__lede">A spare-part compatibility database for mobile phone shops, accessory
    dealers, wholesalers, distributors and repair technicians.</p>

    <h2>The problem it solves</h2>
    <p>A back cover cut for one handset fits every phone built on the same body. A tempered
    glass fits by dimensions. A charging board is shared across a whole series. Knowing which
    is the difference between stocking six lines and stocking sixty — but that knowledge
    usually lives in one person's head.</p>

    <h2>How it works</h2>
    <p>Every part in the catalogue belongs to a <em>compatibility group</em>: one part, one
    master model, and every device recorded as taking the same part. Search a handset and you
    get its groups. Open a group and you get the full fitment list and a part code you can
    read to a supplier.</p>

    <h2>What is in it</h2>
    <p>${nf(STATS.models)} phone models across ${STATS.brands} brands, ${nf(STATS.groups)}
    compatibility groups and ${nf(STATS.fitments)} recorded fitments, covering tempered glass,
    back cover, combo display, middle frame, CC board and battery.</p>

    <h2>What is not in it</h2>
    <p>Processor, RAM, storage, camera and network specifications are not carried, and are
    shown as “-” rather than estimated. A spec sheet that invents a value is worse than one
    that says the field is unknown, because the invented one gets quoted to a customer.</p>

    <ul class="seo__grid">
      ${CATS.map(c => `<li><a href="/categories/${c.id}"><b>${esc(c.name)}</b>
        <span>${nf(c.groups)} groups</span></a></li>`).join('\n      ')}
    </ul>`
  };
}

/* ------------------------------------------------------------ model pages

   4,933 of them, so every byte is multiplied by five thousand. They get a
   trimmed shell: the same head and breadcrumb, but a two-link footer instead of
   the full brand and category directories. That is the difference between a
   49 MB deploy and a 22 MB one, and it costs a reader nothing.

   The share image stays the site's own card rather than the device photo. The
   photo is GSMArena's file on GSMArena's servers, and an og:image would hotlink
   their bandwidth to every share of every model page.

   Structured data is BreadcrumbList only. Product schema wants a price and an
   availability this catalogue does not have, and inventing them to earn a rich
   result is the kind of markup that gets a site's rich results switched off. */

function modelHead(p) {
  const canonical = ORIGIN + p.url;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.description)}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta name="theme-color" content="#0F766E" />
<meta name="robots" content="index, follow, max-image-preview:large" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${esc(BRAND)}" />
<meta property="og:title" content="${esc(p.title)}" />
<meta property="og:description" content="${esc(p.description)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:image" content="${esc(OG_IMAGE)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(p.title)}" />
<meta name="twitter:description" content="${esc(p.description)}" />
<meta name="twitter:image" content="${esc(OG_IMAGE)}" />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/assets/brand/icon-180.png" />
<link rel="manifest" href="/site.webmanifest" />
<link rel="stylesheet" href="/assets/styles.css" />
<link rel="stylesheet" href="/assets/components.css" />
<link rel="stylesheet" href="/assets/seo.css" />
<script type="application/ld+json">${JSON.stringify(p.jsonld)}</script>
</head>
<body>
<div class="seo" id="seoContent">
<header class="seo__bar"><a class="seo__brand" href="/"><img src="/assets/brand/logo.svg" width="34" height="34" alt="Mobile Parts Finder logo" /><span>Mobile Parts <b>Finder</b></span></a>
<nav class="seo__nav" aria-label="Main"><a href="/finder">Device Finder</a><a href="/models">All models</a></nav></header>
${p.breadcrumbHTML}
<main class="seo__main">
${p.body}
</main>
<footer class="seo__foot"><p><strong>${esc(BRAND)}</strong> — spare-part compatibility for mobile shops, dealers and repair technicians. <a href="/">Home</a> · <a href="/finder">Device Finder</a> · <a href="/models">All brands</a></p></footer>
</div>
<div id="app" class="app" hidden></div>
${APP_BOOT}
<script>(function(){var s=document.getElementById('seoContent'),a=document.getElementById('app');var o=new MutationObserver(function(){if(a.childNodes.length){a.hidden=false;if(s)s.remove();o.disconnect();}});o.observe(a,{childList:true});})();</script>
</body>
</html>
`;
}

/* "2020-05-01" is what a database stores; "1 May 2020" is what a person reads. */
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return iso || null;
  return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1];
}

/** A spec row, or a hyphen. On this catalogue the gap is the point. */
function specRow(label, value) {
  const has = value != null && value !== '';
  return `<tr><th scope="row">${esc(label)}</th><td${has ? '' : ' class="c-none"'}>${has ? esc(value) : '-'}</td></tr>`;
}

function modelPage(m) {
  const url = '/model/' + m.id;
  const brandName = BRAND_BY_ID[m.brandId] || m.brandId;
  const groups = MODEL_GROUPS[m.id] || {};
  const cats = Object.keys(groups).filter(k => (groups[k] || []).length);
  const totalGroups = cats.reduce((n, k) => n + groups[k].length, 0);

  /* The model name usually already starts with the brand; saying it twice reads
     badly in a breadcrumb that is mostly the model name. */
  const short = m.name.toLowerCase().indexOf(brandName.toLowerCase() + ' ') === 0
    ? m.name.slice(brandName.length + 1) : m.name;

  const trail = [
    { name: 'Home', url: '/' },
    { name: 'All mobile models', url: '/models' },
    { name: brandName, url: '/models/' + m.brandId },
    { name: short, url }
  ];

  const partsList = cats.length
    ? '<ul class="seo__grid">' + cats.map(k =>
        `<li><a href="/categories/${k}"><b>${esc(CAT_BY_ID[k] || k)}</b>` +
        `<span>${groups[k].length} ${groups[k].length === 1 ? 'group' : 'groups'}</span></a></li>`
      ).join('') + '</ul>'
    : '<p>No compatibility group covers this model yet. It is in the catalogue and will be ' +
      'matched as groups are added.</p>';

  const body = `
    <h1>${esc(m.name)} — compatible spare parts</h1>
    <p class="seo__lede">Which tempered glass, back cover, combo display, middle frame,
    CC board and battery fit the ${esc(m.name)}, and which other phone models take the
    same parts.</p>
    ${m.img ? `<p><img src="${esc(m.img)}" alt="${esc(m.name)}" width="180" loading="lazy" referrerpolicy="no-referrer" style="border-radius:12px" /></p>` : ''}

    <h2>Parts that fit this model</h2>
    ${totalGroups ? `<p>${esc(m.name)} appears in <strong>${totalGroups}</strong> compatibility
    ${totalGroups === 1 ? 'group' : 'groups'} across ${cats.length}
    part ${cats.length === 1 ? 'category' : 'categories'}.
    <a href="/finder">Open the Device Finder</a> for the full fitment list and part codes.</p>` : ''}
    ${partsList}

    <h2>${esc(m.name)} specifications</h2>
    <p>What the catalogue records. Fields the source does not carry are shown as “-”
    rather than estimated.</p>
    <table class="seo__spec"><tbody>
      ${specRow('Brand', brandName)}
      ${specRow('Device type', m.type)}
      ${specRow('Released', fmtDate(m.releaseDate))}
      ${specRow('Display size', m.size ? m.size + ' inches' : null)}
      ${specRow('Screen type', m.screenType)}
      ${specRow('Height', m.h ? m.h + ' mm' : null)}
      ${specRow('Width', m.w ? m.w + ' mm' : null)}
      ${specRow('Screen area', m.cm2 ? m.cm2 + ' cm²' : null)}
      ${specRow('Body-to-screen ratio', m.ratio ? m.ratio + '%' : null)}
      ${specRow('Battery', m.mah ? nf(m.mah) + ' mAh' : null)}
      ${specRow('Battery part number', m.batteryPart
          ? m.batteryPart + (m.batteryVerified ? ' (verified)' : ' (unverified)') : null)}
    </tbody></table>

    <p><a href="/models/${esc(m.brandId)}">All ${esc(brandName)} models</a> ·
    <a href="/finder">Match another handset</a></p>`;

  return {
    url,
    title: `${m.name} — Compatible Spare Parts & Models | ${BRAND}`,
    description: `Compatible tempered glass, back cover, combo display, CC board, middle ` +
      `frame and battery for the ${m.name}` +
      (totalGroups ? ` — ${totalGroups} compatibility ${totalGroups === 1 ? 'group' : 'groups'}` : '') +
      `, with the other models that take the same parts.`,
    body,
    breadcrumbHTML: breadcrumb(trail),
    jsonld: [breadcrumbLd(trail)]
  };
}

/* --------------------------------------------------------------------- run */

function main() {
  const pages = [
    homepage(),
    finderPage(),
    modelsIndex(),
    categoriesIndex(),
    brandLandingPage(),
    plansPage(),
    ...CATS.map(categoryPage),
    aliasPage(CATS.find(c => c.id === 'screen-guards'), 'universal-tempered-glass',
      `Universal Tempered Glass Compatible Mobile Models | ${BRAND}`,
      'Which phone models share the same tempered glass. Compatibility groups by screen ' +
      'size and body dimensions, for mobile shops and accessory dealers.'),
    aliasPage(CATS.find(c => c.id === 'back-cover'), 'universal-back-cover',
      `Universal Back Cover Compatible Models | ${BRAND}`,
      'Which phone models take the same back cover. Compatibility groups by body, for ' +
      'mobile accessory dealers, wholesalers and repair shops.'),
    ...BRANDS.map(brandPage)
  ];

  let written = 0;
  pages.forEach(p => {
    const dir = p.url === '/' ? ROOT : path.join(ROOT, p.url.replace(/^\//, ''));
    fs.mkdirSync(dir, { recursive: true });
    const file = p.url === '/' ? path.join(ROOT, 'index.html') : path.join(dir, 'index.html');
    fs.writeFileSync(file, shell(p));
    written++;
  });

  /* ---- one page per device ---- */
  const modelDir = path.join(ROOT, 'model');
  fs.rmSync(modelDir, { recursive: true, force: true });   /* drop pages for models that left the catalogue */
  let modelBytes = 0;
  const modelPages = MODELS.map(modelPage);
  modelPages.forEach(p => {
    const dir = path.join(ROOT, p.url.replace(/^\//, ''));
    fs.mkdirSync(dir, { recursive: true });
    const html = modelHead(p);
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    modelBytes += Buffer.byteLength(html);
    written++;
  });

  /* ---- sitemap: absolute, canonical, no private or duplicate routes ---- */
  const today = new Date().toISOString().slice(0, 10);
  const priority = u => u === '/' ? '1.0'
    : /^\/(universal-|categories\/|finder|models$|mobile-parts-finder)/.test(u) ? '0.9'
    : u.startsWith('/models/') ? '0.7' : '0.6';

  const urls = pages
    .filter(p => p.url !== '/plans')      /* a pricing page is not search content */
    .map(p => `  <url>
    <loc>${ORIGIN}${p.url === '/' ? '/' : p.url}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${p.url === '/' ? 'daily' : 'weekly'}</changefreq>
    <priority>${priority(p.url)}</priority>
  </url>`).join('\n');

  /* Split, and indexed. One file would still be legal — the cap is 50,000 URLs —
     but Search Console reports coverage per sitemap, and "pages" and "devices"
     failing for different reasons is worth being able to see separately. */
  fs.writeFileSync(path.join(ROOT, 'sitemap-pages.xml'),
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`);

  fs.writeFileSync(path.join(ROOT, 'sitemap-models.xml'),
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${modelPages.map(p => `  <url>
    <loc>${ORIGIN}${p.url}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>`).join('\n')}
</urlset>
`);

  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'),
`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${ORIGIN}/sitemap-pages.xml</loc><lastmod>${today}</lastmod></sitemap>
  <sitemap><loc>${ORIGIN}/sitemap-models.xml</loc><lastmod>${today}</lastmod></sitemap>
</sitemapindex>
`);

  /* ---- robots: crawl everything public, keep scripts and styles open ---- */
  fs.writeFileSync(path.join(ROOT, 'robots.txt'),
`# ${BRAND}
# Everything public is crawlable, including CSS and JavaScript — blocking those
# stops Google rendering the page and is a common way to hurt a site by accident.

User-agent: *
Allow: /

# Private or non-content routes. Nothing here is useful in a search result.
# /admin is tidiness rather than security: it is protected by a server-side
# role check on every request, and every admin collection is closed to clients
# in firestore.rules. A crawler that ignored this line would get a sign-in page.
Disallow: /account
Disallow: /admin
Disallow: /api/
Disallow: /__/

# sitemap.xml is an index. It fans out to the pages and the device catalogue,
# so Search Console reports coverage for the two separately.
Sitemap: ${ORIGIN}/sitemap.xml
`);

  /* ---- manifest ---- */
  fs.writeFileSync(path.join(ROOT, 'site.webmanifest'), JSON.stringify({
    name: BRAND,
    short_name: 'Parts Finder',
    description: 'Spare-part compatibility for mobile shops, dealers and repair technicians.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0B1F1D',
    theme_color: '#0F766E',
    icons: [
      { src: '/assets/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/assets/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/assets/brand/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  }, null, 2) + '\n');

  console.log('\n  Mobile Parts Finder — SEO build');
  console.log('  ' + '-'.repeat(56));
  console.log('  pages pre-rendered   ', written);
  console.log('    homepage            1');
  console.log('    landing / index     5');
  console.log('    categories         ', CATS.length + 2, '(2 with a keyword URL as well)');
  console.log('    brands             ', BRANDS.length);
  console.log('    device pages       ', modelPages.length,
              '(' + (modelBytes / 1048576).toFixed(1) + ' MB)');
  console.log('  sitemap URLs         ', (pages.length - 1) + modelPages.length);
  console.log('  ' + '-'.repeat(56));
  console.log('  sitemap.xml, robots.txt, site.webmanifest written');
  console.log('  canonical origin     ', ORIGIN);
  console.log();
}

main();
