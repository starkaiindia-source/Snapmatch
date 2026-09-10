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

/* The business facts that are confirmed, and deliberately only those.

   There is no phone number, no GSTIN, no registration number, no street
   address, no founding date and no social profile here, because none of those
   has been confirmed. A legal page is the one place on a site where a plausible
   guess is worse than a gap: it is the page a customer, a payment provider or a
   regulator reads when something has gone wrong. */
const SUPPORT_EMAIL = 'Stark.ai.India@gmail.com';
const LOCALITY = 'Coimbatore';
const REGION = 'Tamil Nadu';
const COUNTRY = 'India';
const PLACE = LOCALITY + ', ' + REGION + ', ' + COUNTRY;

const OG_IMAGE = ORIGIN + '/assets/brand/og-image.png';

const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'dataset.json'), 'utf8'));

/* Enriched All-Mobile-Models records (Apple official + TechSpecs migration).
   A model with a file here renders the full device detail view; every other
   model keeps the original thin spec table byte for byte. Nothing in this map
   is read by the Compatibility Device Finder, which runs off groups.ndjson. */
const ACTIVE = (() => {
  const dir = path.join(ROOT, 'data', 'models-active');
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    map.set(rec.modelId, rec);
  }
  return map;
})();

/* Only the categories that HAVE data get a public page.

   A category the register carries but whose groups have not been collected
   yet (comingSoon) is a real category in the app, where the reader is told so
   to their face. Out here it would be a /categories/<id> page listing nothing,
   a link to it from every other category page, and a sitemap entry inviting a
   crawler to index the emptiness — a thin page for a part we cannot yet answer
   questions about. It joins this list the moment its export lands and its
   groupCount stops being zero; nothing here needs editing for that. */
const CATS = dataset.categories
  .filter(c => !c.comingSoon)
  .map(c => ({ id: c.id, name: c.name, groups: c.groupCount }));
/* The category count in prose, so it cannot go stale when one is added. */
const countWord = n => ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'][n] || String(n);
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

/* ------------------------------------------------------- compatibility index

   dataset.json stores the edge list one way round: a model, and the groups it
   belongs to. Every page worth publishing asks the opposite question — given
   this part, what else does it fit — so the inverse is built once, here.

   This is the product in two objects. Without it a model page can only say
   "6 groups" and point at the finder, which is what made 4,933 model pages
   near-identical to each other and, to a crawler, not worth keeping. */
const GROUP_BY_ID = {};
{
  const GC = {};
  dataset.groupCols.forEach((k, i) => { GC[k] = i; });
  dataset.groups.forEach(r => {
    GROUP_BY_ID[r[GC.id]] = {
      id: r[GC.id], no: r[GC.no], part: r[GC.part], oem: r[GC.oem],
      cat: r[GC.cat], master: r[GC.mm], count: r[GC.cnt]
    };
  });
}

const GROUP_MEMBERS = {};
Object.keys(MODEL_GROUPS).forEach(mid => {
  const byCat = MODEL_GROUPS[mid];
  Object.keys(byCat).forEach(cat => {
    (byCat[cat] || []).forEach(gid => {
      (GROUP_MEMBERS[gid] = GROUP_MEMBERS[gid] || []).push(mid);
    });
  });
});

const MODEL_BY_ID = {};
MODELS.forEach(m => { MODEL_BY_ID[m.id] = m; });

/* Brand -> its models, newest first. Release date is the order a counter wants:
   the handset that walked in this morning is more likely to be recent. Models
   the source has no date for sort last rather than being dropped. */
const MODELS_BY_BRAND = {};
MODELS.forEach(m => {
  (MODELS_BY_BRAND[m.brandId] = MODELS_BY_BRAND[m.brandId] || []).push(m);
});
Object.keys(MODELS_BY_BRAND).forEach(b => {
  MODELS_BY_BRAND[b].sort((x, y) => {
    const a = x.releaseDate || '', c = y.releaseDate || '';
    if (a && c && a !== c) return c < a ? -1 : 1;
    if (a && !c) return -1;
    if (!a && c) return 1;
    return String(x.name).localeCompare(String(y.name));
  });
});

/* The words people actually type. "Screen Guards" is the catalogue's column
   heading; "tempered glass" is the search. Headings use this, tables use the
   catalogue name, and neither is invented. */
const CAT_INTENT = {
  'screen-guards': 'tempered glass',
  'back-cover': 'back cover',
  'combo-display': 'display',
  'middle-frame': 'middle frame',
  'cc-board': 'CC board',
  battery: 'battery'
};
const intentOf = c => CAT_INTENT[c.id] || String(c.name).toLowerCase();

/** Groups this model is in, per category, each with the other models in it. */
function compatFor(modelId) {
  const byCat = MODEL_GROUPS[modelId] || {};
  return CATS.map(c => {
    const gids = byCat[c.id] || [];
    if (!gids.length) return null;
    return {
      cat: c,
      groups: gids.map(gid => ({
        g: GROUP_BY_ID[gid] || { id: gid },
        others: (GROUP_MEMBERS[gid] || [])
          .filter(id => id !== modelId)
          .map(id => MODEL_BY_ID[id])
          .filter(Boolean)
      }))
    };
  }).filter(Boolean);
}

/* A group can run to 325 members, and the member list is the thing the
   subscription sells. api/_schema/entitlement.js gives a free account the
   whole group up to five members, then five, then ten — these pages are the
   free view of the catalogue, so they publish exactly that and count the rest.

   Publishing the full list would hand every subscription's worth of data to
   anyone with curl. It would also make the pre-rendered HTML say more than the
   app shows the same visitor a second later, which is the mismatch between
   served and rendered content that Google calls cloaking. Mirroring the free
   tier fixes both at once. */
const SMALL_GROUP_MAX = 5;
const MEDIUM_GROUP_MAX = 50;
const FREE_MEMBERS_MEDIUM = 5;
const FREE_MEMBERS_LARGE = 10;

function freeMemberLimit(total) {
  const n = Number(total);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= SMALL_GROUP_MAX) return n;
  if (n <= MEDIUM_GROUP_MAX) return FREE_MEMBERS_MEDIUM;
  return FREE_MEMBERS_LARGE;
}

const linkList = list => '<ul class="seo__models">' +
  list.map(o => `<li><a href="/model/${esc(o.id)}">${esc(o.name)}</a></li>`).join('') +
  '</ul>';

/* Catalogue navigation — a brand's own models, a handset's contemporaries.
   Model names, brands and years are the free catalogue (assets/search-index.json
   ships them to every visitor), so nothing here is gated. */
function modelLinks(list, cap) {
  const shown = list.slice(0, cap || 60);
  const rest = list.length - shown.length;
  return linkList(shown) + (rest > 0
    ? `<p class="seo__more">and ${nf(rest)} more — ` +
      `<a href="/finder">open the Device Finder</a>.</p>`
    : '');
}

/**
 * A group's members, cut to the free allowance.
 *
 * @param {Array}  list      the members available to list
 * @param {number} total     the real size of the group
 * @param {number} reserved  free slots already spent — 1 on a model page,
 *                           where the model whose page it is occupies one,
 *                           exactly as it does in the app's own response.
 */
function groupMemberLinks(list, total, reserved) {
  const limit = Math.max(0, freeMemberLimit(total) - (reserved || 0));
  const shown = list.slice(0, limit);
  const rest = list.length - shown.length;
  return { html: (shown.length ? linkList(shown) : '') + (rest > 0
    ? `<p class="seo__more">${nf(rest)} further ${rest === 1 ? 'model' : 'models'} in this ` +
      `group. <a href="/plans">See the full fitment list with a plan</a>.</p>`
    : ''), shown };
}

/* Contemporaries, not just the first N alphabetically: walk outwards from this
   model's position in the brand's date-sorted list, so a 2024 handset is
   related to 2024 handsets. */
function siblingModels(m, n) {
  const list = MODELS_BY_BRAND[m.brandId] || [];
  const i = list.findIndex(x => x.id === m.id);
  if (i < 0) return list.slice(0, n);
  const out = [];
  let a = i - 1, b = i + 1;
  while (out.length < n && (a >= 0 || b < list.length)) {
    if (b < list.length) out.push(list[b++]);
    if (out.length < n && a >= 0) out.push(list[a--]);
  }
  return out;
}


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
  'button-flex': {
    h1: 'Button flex compatibility — models that share one power and volume flex',
    lede: 'A power and volume button flex fits every phone built around the same side-button ' +
          'layout. Each group below is one flex and every model it fits, from a parts supplier ' +
          'compatibility list matched to this catalogue model by model.',
    intent: 'button flex compatible models, power volume flex compatible models, mobile button flex finder'
  },
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
${p.noindex ? '' : `<link rel="canonical" href="${esc(canonical)}" />
`}<meta name="theme-color" content="#0F766E" />
<meta name="robots" content="${p.noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large'}" />

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
${appOwns(p.url) ? '' : THEME_BOOT}
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
  'src/data/access.js',
  'src/data/analytics.js',
  'src/ui/icons.js', 'src/ui/product-art.js', 'src/data/category-assets.js',
  'src/data/brand-assets.js',
  'src/data/pwa.js',
  'src/ui/components.js', 'src/app.js'
].map(s => `<script src="/${s}" defer></script>`).join('\n');


/* Which URLs the app actually renders. The same table app.js keeps in ROUTES,
   and deliberately the same answer for the bare "/": it does not own it.

   A page the app never mounts on has no use for the application bundle --
   175 KB gzipped, 537 KB parsed, only to stand down on arrival. So it does not
   get it. What such a page does need is the theme the visitor chose, and that
   is three lines. */
const APP_ROUTES = { finder: 1, models: 1, model: 1, plans: 1, account: 1, group: 1 };
const appOwns = (url) => {
  const first = String(url || '').split('/').filter(Boolean)[0];
  return !!first && !!APP_ROUTES[first];
};

const MOUNT_SWAP = `<script>
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
</script>`;

const THEME_BOOT = `<script>
/* Theme before the first paint. The app writes mpf.theme when a visitor picks
   one; this page has no app to read it back, so it reads the same key itself.
   Inline and synchronous on purpose: anything deferred repaints. */
try{var t=localStorage.getItem('mpf.theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}
</script>`;

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
    <nav aria-label="About and legal">
      <a href="/mobile-parts-finder">About</a>
      <a href="/contact">Contact</a>
      <a href="/privacy">Privacy Policy</a>
      <a href="/terms">Terms &amp; Conditions</a>
      <a href="/refund">Refund Policy</a>
    </nav>
    <p class="seo__legal">${esc(BRAND)} &middot; ${esc(PLACE)} &middot;
    <a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a></p>
  </footer>
</div>

<div id="app" class="app" hidden></div>
${appOwns(p.url) ? APP_BOOT + '\n' + MOUNT_SWAP : ''}
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

/* One organisation node, given a stable @id so every page that emits it is
   talking about the same entity rather than declaring a new one. Google has to
   decide that "Mobile Parts Finder" names a thing before it can rank the site
   for its own name, and a consistent identifier is most of that work.

   No telephone: none is published anywhere on this site, and schema that
   contradicts the pages it describes is worse than schema that is quieter.
   No sameAs, because no social profile has been verified as belonging to this
   business; an unverified one would point the entity at somebody else. */
const ORG_LD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': ORIGIN + '/#organization',
  name: BRAND,
  url: ORIGIN + '/',
  logo: ORIGIN + '/assets/brand/icon-512.png',
  email: SUPPORT_EMAIL,
  description: 'Spare-part compatibility database for mobile phone shops, accessory ' +
               'dealers and repair technicians.',
  address: {
    '@type': 'PostalAddress',
    addressLocality: LOCALITY,
    addressRegion: REGION,
    addressCountry: 'IN'
  },
  contactPoint: {
    '@type': 'ContactPoint',
    contactType: 'customer support',
    email: SUPPORT_EMAIL,
    areaServed: 'IN',
    availableLanguage: 'English'
  }
};

/* ------------------------------------------------------------------ builders */

function homepage() {
  const body = `
    <h1>Mobile Parts Finder — universal mobile accessories &amp; spare parts compatibility database</h1>
    <p class="seo__lede">Find which phone models share the same tempered glass, back cover,
    combo display, middle frame, CC board or battery. Built for mobile shop owners,
    accessory dealers, wholesalers, distributors and repair technicians who need to know
    what fits before they order.</p>

    <div class="seo__cta">
      <a class="btn btn--primary" href="/finder">Open the Device Finder</a>
      <a class="btn btn--outline" href="/models">Browse all ${nf(STATS.models)} models</a>
    </div>

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
      publisher: { '@id': ORIGIN + '/#organization' },
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
  const intent = intentOf(cat);
  const trail = [
    { name: 'Home', url: '/' },
    { name: 'Parts categories', url: '/categories' },
    { name: cat.name, url }
  ];

  /* The groups in this category, biggest first. A group that covers 40 handsets
     is the one a shop wants to know about, and it is also the most useful link
     for a crawler arriving on this page: it leads somewhere dense. */
  const groups = Object.keys(GROUP_BY_ID)
    .map(id => GROUP_BY_ID[id])
    .filter(g => g.cat === cat.id)
    .map(g => ({ g, members: (GROUP_MEMBERS[g.id] || []).map(id => MODEL_BY_ID[id]).filter(Boolean) }))
    .sort((a, b) => b.members.length - a.members.length);

  const SHOWN = 40;
  const top = groups.slice(0, SHOWN);
  const rest = groups.length - top.length;

  const groupHTML = top.map(({ g, members }) => {
    const master = MODEL_BY_ID[g.master];
    const meta = [
      g.no ? `Group <b>${esc(g.no)}</b>` : null,
      g.part ? `part code <b>${esc(g.part)}</b>` : null,
      master ? `cut from <a href="/model/${esc(master.id)}">${esc(master.name)}</a>` : null
    ].filter(Boolean).join(' · ');
    return `<div class="seo__group">
      <p class="seo__groupmeta">${meta}</p>
      ${members.length
        ? `<p>Fits ${nf(members.length)} ${members.length === 1 ? 'model' : 'models'}:</p>` +
          groupMemberLinks(members, members.length, 0).html
        : ''}
    </div>`;
  }).join('\n    ');

  const body = `
    <h1>${esc(copy.h1)}</h1>
    <p class="seo__lede">${esc(copy.lede)}</p>
    <p><strong>${nf(cat.groups)}</strong> ${esc(String(cat.name).toLowerCase())} compatibility groups are
    recorded in the catalogue.
    <a href="/finder">Search the Device Finder</a> to match a specific handset.</p>

    <h2>How ${esc(String(cat.name).toLowerCase())} compatibility works here</h2>
    <p>A compatibility group is one part and every device it fits. Each group carries a part
    code, a serial number, the master model it is cut from, and the full list of compatible
    devices. Where the source data records a manufacturer part number it is shown alongside;
    where it does not, the field is left blank rather than filled with a guess.</p>

    <h2>${esc(cat.name)} groups that cover the most models</h2>
    <p>The ${nf(top.length)} widest-fitting ${esc(intent)} groups in the catalogue, largest
    first. Each model name links to its own compatibility page.</p>
    ${groupHTML}
    ${rest > 0 ? `<p class="seo__more">${nf(rest)} further ${esc(intent)} groups are in the
    catalogue. <a href="/finder">Search a handset in the Device Finder</a> to find the group
    it belongs to.</p>` : ''}

    <h2>Other part categories</h2>
    <ul class="seo__grid">
      ${CATS.filter(c => c.id !== cat.id).map(c =>
        `<li><a href="/categories/${c.id}"><b>${esc(c.name)}</b>
        <span>${nf(c.groups)} groups</span></a></li>`).join('\n      ')}
    </ul>

    <h2>Browse ${esc(String(cat.name).toLowerCase())} by brand</h2>
    <ul class="seo__grid">
      ${BRANDS.slice(0, 16).map(b => `<li><a href="/models/${b.id}"><b>${esc(b.name)}</b>
        <span>${nf(b.models)} models</span></a></li>`).join('\n      ')}
    </ul>`;

  return {
    url,
    title: `${cat.name} Compatible Mobile Models | ${BRAND}`,
    description: `${cat.name} compatibility for ${nf(STATS.models)} phone models — ` +
      `${nf(cat.groups)} groups showing which devices share the same ${intent}. ` +
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

  const list = MODELS_BY_BRAND[b.id] || [];
  const withData = list.filter(m => (MODEL_GROUPS[m.id] || null)).length;

  /* Every model, as a real link, grouped by release year.

     This is the fix for the thing that kept 4,933 model pages out of the index:
     nothing on the site linked to any of them. They existed, they were in the
     sitemap, and they had no path in from the homepage — so they were crawled
     late, shallowly, or not at all. A brand page that lists its own models is
     the obvious route, and it is what a visitor wants from this page anyway. */
  const byYear = {};
  list.forEach(m => {
    const y = m.year || String(m.releaseDate || '').slice(0, 4) || 'Undated';
    (byYear[y] = byYear[y] || []).push(m);
  });
  const years = Object.keys(byYear).sort((x, y) => {
    if (x === 'Undated') return 1;
    if (y === 'Undated') return -1;
    return Number(y) - Number(x);
  });

  const modelIndex = years.map(y => `
      <h3>${esc(b.name)} ${y === 'Undated' ? 'models without a recorded release date' : y}</h3>
      <ul class="seo__models">${byYear[y].map(m =>
        `<li><a href="/model/${esc(m.id)}">${esc(m.name)}</a></li>`).join('')}</ul>`
  ).join('\n');

  const body = `
    <h1>${esc(b.name)} mobile models &amp; compatible parts finder</h1>
    <p class="seo__lede">${nf(b.models)} ${esc(b.name)} models are in the catalogue, with
    ${nf(b.groups)} compatibility groups where an ${esc(b.name)} device is the master model.
    Find which spare parts fit which handset before ordering.</p>

    <h2>What is recorded for each ${esc(b.name)} model</h2>
    <p>Model name, release date, display size, body dimensions, screen area and battery
    capacity, together with the compatibility groups the device belongs to across every part
    category. ${nf(withData)} of the ${nf(list.length)} ${esc(b.name)} models currently carry
    compatibility data; the rest are listed with their specifications while groups are added.
    Fields the source does not carry are shown as “-” rather than estimated.</p>

    <h2>${esc(b.name)} parts by category</h2>
    <ul class="seo__grid">
      ${CATS.map(c => `<li><a href="/categories/${c.id}"><b>${esc(c.name)}</b>
        <span>${nf(c.groups)} groups</span></a></li>`).join('\n      ')}
    </ul>

    <h2>All ${nf(list.length)} ${esc(b.name)} models</h2>
    <p>Newest first. Each one opens its own compatibility page — the parts that fit it,
    the part codes, and the other handsets that take the same part.</p>
${modelIndex}

    <p class="seo__also"><a href="/finder">Open the Device Finder</a> to match a specific
    ${esc(b.name)} handset to its compatibility groups.</p>

    <h2>Other brands</h2>
    <ul class="seo__grid">
      ${BRANDS.filter(x => x.id !== b.id).slice(0, 20).map(x =>
        `<li><a href="/models/${x.id}"><b>${esc(x.name)}</b>
        <span>${nf(x.models)} models</span></a></li>`).join('\n      ')}
    </ul>`;

  return {
    url,
    title: `${b.name} Mobile Models & Compatible Parts Finder | ${BRAND}`,
    description: `All ${nf(b.models)} ${b.name} models with compatible tempered glass, back ` +
      `cover, combo display, CC board, middle frame and battery groups. Part codes and ` +
      `fitment lists for mobile shops and repair technicians.`,
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
    <p class="seo__lede">${countWord(CATS.length)} part categories, ${nf(STATS.groups)} compatibility groups. Each
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

    <p>${esc(BRAND)} is run from ${esc(PLACE)}. Support is by email at
    <a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a>.</p>

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

/* ------------------------------------------------- enriched detail view
   The pre-rendered half of a migrated model: what a crawler indexes, and what
   a visitor reads if scripts never run. Same information as the app view, laid
   out as plain tables — no selector, because there is no script to drive one,
   so every variant is listed instead. */
const SRC_LABEL = {
  both: 'Verified', manufacturer: 'Manufacturer', techspecs: 'TechSpecs',
  crosschecked: 'Cross-checked', gsmarena: 'Archive'
};

function dvRows(sec) {
  return sec.rows.map(r =>
    /* No provenance chip: where a value came from is our bookkeeping, not the
       reader's. It stays in the record and in the source block at the foot. */
    `<tr><th scope="row">${esc(r.label)}</th><td>${esc(String(r.value))}</td></tr>`).join('');
}

function detailView(a) {
  const meta = a.sourceMeta || {};
  const axes = a.axes || {};
  const regions = axes.region || [];

  /* One row per region rather than per variant: 90 rows of the same handset in
     six colours is noise, and the region is what carries the model number. */
  const regionRows = regions.map(rg => {
    const priced = (a.variants || []).filter(v => v.region === rg.value && v.price && v.price.amount);
    const prices = [...new Set(priced.map(v =>
      `${v.storage}: ${v.price.currency === 'INR' ? '₹' : v.price.currency + ' '}${Number(v.price.amount).toLocaleString('en-IN')}`))];
    return `<tr><th scope="row">${esc(rg.label)}</th>` +
      `<td><b class="dv__mono">${esc(rg.modelNumber)}</b>` +
      `<span class="dv__alt">${esc(rg.countries || '')}</span>` +
      (prices.length ? `<span class="dv__alt">Launch price — ${esc(prices.join(' · '))}</span>` : '') +
      `</td></tr>`;
  }).join('');

  const list = (arr, key) => (arr || []).map(x => `<b class="dv__chip">${esc(x[key] || x.value)}</b>`).join('');

  return `
    <div class="dv">
      ${a.image && a.image.primary
        ? `<p class="dv__shot"><img src="${esc(a.image.primary)}" alt="${esc(a.name)}" width="200" height="266"
             loading="lazy" decoding="async" referrerpolicy="no-referrer" /></p>` : ''}
      ${a.summary ? `<p class="dv__sum">${esc(a.summary)}</p>` : ''}

      <h3>Variants</h3>
      <p class="dv__chips"><span>Colour</span>${list(axes.color, 'value')}</p>
      <p class="dv__chips"><span>RAM</span>${list(axes.ram, 'value')}</p>
      <p class="dv__chips"><span>Storage</span>${list(axes.storage, 'value')}</p>
      <p class="dv__note">${esc(String(a.variantCount || 0))} sold combinations across
        ${regions.length} markets.</p>
      <table class="seo__spec dv__table"><tbody>${regionRows}</tbody></table>

${(a.specs || []).filter(s => s.rows && s.rows.length).map(s => `
      <h3>${esc(s.title)}</h3>
      <table class="seo__spec dv__table"><tbody>${dvRows(s)}</tbody></table>`).join('')}

      <h3>Source &amp; verification</h3>
      <table class="seo__spec dv__table"><tbody>
        <tr><th scope="row">Data source</th><td>${esc(meta.primarySource || '-')}</td></tr>
        <tr><th scope="row">Manufacturer page</th><td>${meta.source1Url
          ? `<a href="${esc(meta.source1Url)}" rel="nofollow noopener">${esc(meta.source1Title || meta.source1Url)}</a>`
          : '-'}</td></tr>
        <tr><th scope="row">Image source</th><td>${esc((a.image && a.image.primarySource) || '-')}</td></tr>
        <tr><th scope="row">Verification status</th><td>${esc(meta.verificationStatus || '-')}</td></tr>
        <tr><th scope="row">Last verified</th><td>${esc(meta.lastVerified || '-')}</td></tr>
      </tbody></table>
      ${(meta.notes || []).length
        ? `<details class="dv__notes"><summary>Data notes (${meta.notes.length})</summary>
            <ul>${meta.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
    </div>`;
}

function modelPage(m) {
  const url = '/model/' + m.id;
  const brandName = BRAND_BY_ID[m.brandId] || m.brandId;
  const compat = compatFor(m.id);
  const totalGroups = compat.reduce((n, s) => n + s.groups.length, 0);

  /* Distinct models reachable from this one through any shared part. This is
     both the page's headline number and its outbound link set — the thing that
     turns 4,933 orphans into a mesh a crawler can walk. */
  const reach = [];
  const seen = {};
  compat.forEach(s => s.groups.forEach(e => {
    e.view = groupMemberLinks(e.others, e.others.length + 1, 1);
    e.others.forEach(o => { if (!seen[o.id]) { seen[o.id] = 1; reach.push(o); } });
  }));

  /* Only the names the page actually prints. A count is free — the API returns
     memberCount and lockedCount to a free caller — but a name is not, and
     structured data is served content like any other. */
  const shownModels = [];
  const shownSeen = {};
  compat.forEach(s => s.groups.forEach(e => e.view.shown.forEach(o => {
    if (!shownSeen[o.id]) { shownSeen[o.id] = 1; shownModels.push(o); }
  })));

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

  /* One block per group: what the part is called, where it is cut from, and
     every other handset that takes it. The part code is what gets read down a
     phone to a supplier, so it is the first thing on the line. */
  const groupBlock = (cat, e) => {
    const g = e.g;
    const master = MODEL_BY_ID[g.master];
    const intent = intentOf(cat);
    const meta = [
      g.no ? `Group <b>${esc(g.no)}</b>` : `Group <b>${esc(g.id)}</b>`,
      g.part ? `part code <b>${esc(g.part)}</b>` : null,
      g.oem ? `OEM ${esc(g.oem)}` : null,
      master && master.id !== m.id
        ? `cut from <a href="/model/${esc(master.id)}">${esc(master.name)}</a>`
        : (master ? 'this model is the master' : null)
    ].filter(Boolean).join(' · ');

    return `<div class="seo__group">
      <p class="seo__groupmeta">${meta}</p>
      ${e.others.length
        ? `<p>The same ${esc(intent)} also fits ` +
          `<strong>${nf(e.others.length)}</strong> other ` +
          `${e.others.length === 1 ? 'model' : 'models'}:</p>` + e.view.html
        : `<p>No other handset in the catalogue shares this ${esc(intent)} — ` +
          `it is specific to the ${esc(m.name)}.</p>`}
    </div>`;
  };

  const compatHTML = compat.map(s => `
    <h2>${esc(m.name)} ${esc(intentOf(s.cat))} compatibility</h2>
    ${s.groups.map(e => groupBlock(s.cat, e)).join('\n    ')}
    <p class="seo__also">All <a href="/categories/${s.cat.id}">${esc(String(s.cat.name).toLowerCase())} compatibility groups</a>.</p>`
  ).join('\n');

  const siblings = siblingModels(m, 18);
  const siblingHTML = siblings.length ? `
    <h2>Other ${esc(brandName)} models</h2>
    <p>Handsets released around the same time, with their own compatibility lists.</p>
    ${modelLinks(siblings, 18)}` : '';

  const summary = totalGroups
    ? `<p><strong>${esc(m.name)}</strong> appears in <strong>${totalGroups}</strong> compatibility
    ${totalGroups === 1 ? 'group' : 'groups'} across ${compat.length}
    part ${compat.length === 1 ? 'category' : 'categories'}, and shares at least one part with
    <strong>${nf(reach.length)}</strong> other ${reach.length === 1 ? 'model' : 'models'}.</p>
    <ul class="seo__grid">${compat.map(s =>
      `<li><a href="/categories/${s.cat.id}"><b>${esc(s.cat.name)}</b>` +
      `<span>${s.groups.length} ${s.groups.length === 1 ? 'group' : 'groups'}</span></a></li>`
    ).join('')}</ul>`
    : `<p>No compatibility group covers the ${esc(m.name)} yet. The handset is in the
    catalogue with the specifications below, and will be matched as groups are added.
    <a href="/finder">Search another model</a>.</p>`;

  const body = `
    <h1>${esc(m.name)} — compatible spare parts</h1>
    <p class="seo__lede">Which tempered glass, back cover, combo display, middle frame,
    CC board and battery fit the ${esc(m.name)}, and which other phone models take the
    same parts.</p>
    ${m.img ? `<p><img src="${esc(m.img)}" alt="${esc(m.name)}" width="180" height="240" loading="lazy" decoding="async" referrerpolicy="no-referrer" style="border-radius:12px;height:auto" /></p>` : ''}

    <h2>Parts that fit this model</h2>
    ${summary}
${compatHTML}
    <h2>${esc(m.name)} specifications</h2>
${ACTIVE.has(m.id) ? detailView(ACTIVE.get(m.id)) : `    <p>What the catalogue records. Fields the source does not carry are shown as “-”
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
    </tbody></table>`}
${siblingHTML}
    <p class="seo__also"><a href="/models/${esc(m.brandId)}">All ${esc(brandName)} models</a> ·
    <a href="/finder">Match another handset</a></p>`;

  /* An ItemList of the models actually listed on the page. Nothing is claimed
     that the page does not show, and no Product/Offer/Rating is emitted — the
     catalogue has no prices, no stock and no reviews to describe. */
  const jsonld = [breadcrumbLd(trail)];
  if (shownModels.length) {
    jsonld.push({
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: `Models compatible with the ${m.name}`,
      numberOfItems: shownModels.length,
      itemListElement: shownModels.map((o, i) => ({
        '@type': 'ListItem', position: i + 1, name: o.name, url: ORIGIN + '/model/' + o.id
      }))
    });
  }

  /* The description names the categories this model actually has data for and
     the size of its compatibility set. Two models in the same group still get
     different sentences, because the counts and the category mix differ. */
  const catWords = compat.map(s => intentOf(s.cat));
  const description = totalGroups
    ? `${m.name} spare parts compatibility: ${catWords.join(', ')} — ` +
      `${totalGroups} ${totalGroups === 1 ? 'group' : 'groups'} and ${nf(reach.length)} other ` +
      `${reach.length === 1 ? 'model' : 'models'} that take the same parts. ` +
      `Part codes for mobile shops, dealers and repair technicians.`
    : `${m.name} specifications and spare-part compatibility — ` +
      `brand, release date, display size, body dimensions and battery, with related ` +
      `${brandName} models in the Mobile Parts Finder catalogue.`;

  return {
    url,
    title: `${m.name} — Compatible Spare Parts & Models | ${BRAND}`,
    description,
    body,
    hasCompat: totalGroups > 0,
    breadcrumbHTML: breadcrumb(trail),
    jsonld
  };
}

/* A real 404, because the alternative was worse than it looked.

   Every unknown URL used to be answered with the homepage, at status 200. That
   is a soft 404: Google crawls a typo, a dead link or a stale URL, gets a page
   that says "200 OK" and contains the entire homepage, and has to decide what
   it just found. The whole class of them competes with the homepage for the
   homepage's own content.

   This page says not-found in the status line, in the title and in the robots
   tag, and then does the one useful thing a 404 can do — offer the routes in. */
function notFoundPage() {
  return {
    url: '/404',
    noindex: true,
    title: `Page not found | ${BRAND}`,
    description: 'That URL is not in the catalogue. Search a handset in the Device Finder, ' +
      'or browse the model list by brand.',
    breadcrumbHTML: '',
    jsonld: [],
    body: `
    <h1>That page is not in the catalogue</h1>
    <p class="seo__lede">The URL may be mistyped, or it may point at a model or group that
    is no longer listed. Nothing is broken — the catalogue is below.</p>

    <h2>Find a handset</h2>
    <p><a href="/finder">Open the Device Finder</a> and type any model name to get its
    compatibility groups, part codes and the other devices that take the same part.</p>

    <h2>Browse by brand</h2>
    <ul class="seo__grid">
      ${BRANDS.slice(0, 12).map(b => `<li><a href="/models/${b.id}"><b>${esc(b.name)}</b>
        <span>${nf(b.models)} models</span></a></li>`).join('\n      ')}
    </ul>
    <p class="seo__also"><a href="/models">All ${STATS.brands} brands</a></p>

    <h2>Browse by part</h2>
    <ul class="seo__grid">
      ${CATS.map(c => `<li><a href="/categories/${c.id}"><b>${esc(c.name)}</b>
        <span>${nf(c.groups)} groups</span></a></li>`).join('\n      ')}
    </ul>`
  };
}


/* ------------------------------------------------------- identity and legal

   Five pages that exist because a business that takes payments needs them, and
   because a search engine deciding whether a six-day-old domain is a real
   organisation looks for exactly these. Everything factual in them comes from
   the confirmed list at the top of this file or from what the code actually
   does; nothing is filled in to make a section look complete. */

function contactPage() {
  const url = '/contact';
  const trail = [{ name: 'Home', url: '/' }, { name: 'Contact', url }];
  return {
    url,
    title: `Contact ${BRAND}`,
    description: `Get in touch with ${BRAND} about compatibility data, a subscription ` +
      `or an account. Support is handled by email.`,
    breadcrumbHTML: breadcrumb(trail),
    jsonld: [ORG_LD, breadcrumbLd(trail), {
      '@context': 'https://schema.org',
      '@type': 'ContactPage',
      name: `Contact ${BRAND}`,
      url: ORIGIN + url,
      about: { '@id': ORIGIN + '/#organization' }
    }],
    body: `
    <h1>Contact ${esc(BRAND)}</h1>
    <p class="seo__lede">Support runs by email. Write with the handset, the part and what
    you expected to see, and there is enough to answer with.</p>

    <h2>Email</h2>
    <p><a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a></p>

    <h2>Where we are</h2>
    <p>${esc(PLACE)}</p>

    <h2>What to write about</h2>
    <ul>
      <li><b>A wrong or missing fitment.</b> Name the two handsets and the part. A
      correction that can be checked is worth more than a general report.</li>
      <li><b>A handset that is not in the catalogue.</b> Brand and full model name.</li>
      <li><b>Billing, a subscription or an invoice.</b> Use the same email address the
      account was created with, so it can be matched.</li>
      <li><b>Access to an account you can no longer sign in to.</b></li>
    </ul>

    <h2>Before you write about a fitment</h2>
    <p>Compatibility groups are compiled from recorded fitments, and a catalogue this
    size will contain mistakes. Checking the part against the handset before ordering in
    quantity is worth the minute it costs. See the
    <a href="/terms">terms</a> for what that means in practice.</p>`
  };
}

function privacyPage() {
  const url = '/privacy';
  const trail = [{ name: 'Home', url: '/' }, { name: 'Privacy Policy', url }];
  return {
    url,
    title: `Privacy Policy | ${BRAND}`,
    description: `What ${BRAND} collects, why, who processes it and how to have it ` +
      `removed. No cookies, no advertising trackers, no device fingerprinting.`,
    breadcrumbHTML: breadcrumb(trail),
    jsonld: [ORG_LD, breadcrumbLd(trail)],
    body: `
    <h1>Privacy Policy</h1>
    <p class="seo__lede">This describes what ${esc(BRAND)} actually collects and what it
    does with it. Where a section would be filler, it is not here.</p>

    <h2>Who this is</h2>
    <p>${esc(BRAND)}, ${esc(PLACE)}. Contact:
    <a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a>.</p>

    <h2>Browsing without an account</h2>
    <p>The catalogue is public. You can search it, open compatibility groups and read
    every device page without signing in, and nothing identifying you is collected when
    you do.</p>

    <h2>Cookies</h2>
    <p>This site sets no cookies. There is no advertising network on it, no cross-site
    tracker and no device fingerprinting: the visit identifier is a random value the
    browser generates for itself, not something derived from your screen size, fonts,
    canvas or user agent.</p>

    <h2>What is measured</h2>
    <p>Usage is counted so the catalogue can be improved. Each visit gets a random
    identifier stored in the tab's own session storage: it identifies a visit, not a
    person, and it is gone when the tab closes.</p>
    <ul>
      <li><b>Collected:</b> which pages were opened, which search terms were typed, and
      the <em>host</em> of the site you arrived from — never the full referring URL.</li>
      <li><b>Not collected:</b> page content, form values, keystrokes, scroll depth or
      mouse movement.</li>
      <li>Search terms are redacted on the server for anything that looks like a phone
      number or an email address before they are stored.</li>
    </ul>

    <h2>If you create an account</h2>
    <p>Sign-in is handled by Google. When you use it, Google passes on the email address
    and the basic profile of the account you chose. Passwords are never seen by this
    site.</p>
    <p>If you fill in a shop profile, what you enter is stored: shop name, proprietor
    name, mobile number and country. That is the profile the app shows back to you, and
    you can change or clear it whenever you like.</p>

    <h2>If you pay</h2>
    <p>Payments are processed by Razorpay. Card and bank details are entered with them and
    never reach this site. What comes back is the state of the payment and the
    subscription it belongs to.</p>

    <h2>Who else processes it</h2>
    <ul>
      <li><b>Google Firebase</b> — sign-in and the database the catalogue and profiles
      are stored in.</li>
      <li><b>Razorpay</b> — payments and subscriptions.</li>
      <li><b>Vercel</b> — hosting, which means ordinary server request logs.</li>
    </ul>
    <p>Nothing is sold, and nothing is shared with anyone else for advertising.</p>

    <h2>Your data</h2>
    <p>Write to <a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a> from the
    address the account uses to ask for a copy of what is held, a correction, or deletion
    of the account and its profile. Records tied to a completed payment may have to be
    kept where law or the payment provider requires it.</p>

    <h2>Changes</h2>
    <p>If this policy changes, the version on this page is the one that applies.</p>`
  };
}

function termsPage() {
  const url = '/terms';
  const trail = [{ name: 'Home', url: '/' }, { name: 'Terms & Conditions', url }];
  return {
    url,
    title: `Terms & Conditions | ${BRAND}`,
    description: `The terms for using ${BRAND}: what the compatibility data is, what a ` +
      `subscription covers, and the limits on both.`,
    breadcrumbHTML: breadcrumb(trail),
    jsonld: [ORG_LD, breadcrumbLd(trail)],
    body: `
    <h1>Terms &amp; Conditions</h1>
    <p class="seo__lede">Using ${esc(BRAND)} means accepting what follows. It is written
    to be read rather than to be long.</p>

    <h2>Who you are agreeing with</h2>
    <p>${esc(BRAND)}, operating from ${esc(PLACE)}. Contact:
    <a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a>.</p>

    <h2>What the service is</h2>
    <p>${esc(BRAND)} is a reference tool. It records which phone models have been observed
    to take the same spare part — tempered glass, back cover, combo display, middle frame,
    CC board, battery — and groups them so a shop can order by group rather than by
    handset. It does not sell parts, hold stock, or arrange shipping.</p>

    <h2>The data is guidance, not a guarantee</h2>
    <p>Compatibility groups are compiled from recorded fitments across thousands of
    models. A catalogue that size contains mistakes, manufacturers change parts within a
    model run without renaming it, and a group that was right last year can stop being
    right. <strong>Check the part against the handset before you order in quantity.</strong>
    ${esc(BRAND)} is not liable for stock bought, orders placed or work done on the basis
    of an entry that turns out to be wrong.</p>

    <h2>Accounts</h2>
    <p>An account is for you or your business, and you are responsible for what happens
    under it. Keep the sign-in credentials to yourself. Tell us if you think an account
    has been used by someone else.</p>

    <h2>Subscriptions</h2>
    <p>Paid plans are billed through Razorpay for the period shown at the time of purchase.
    A subscription can be cancelled from the account at any time; cancelling stops the next
    renewal and leaves the current period running to its end.
    <strong>Payments are not refundable</strong> — see the
    <a href="/refund">refund policy</a>.</p>

    <h2>What you may not do</h2>
    <ul>
      <li>Scrape, bulk-download or systematically copy the catalogue.</li>
      <li>Republish or resell the compatibility data as your own product.</li>
      <li>Share one account across businesses that are not yours.</li>
      <li>Try to get at accounts, data or parts of the service that are not yours.</li>
    </ul>
    <p>The catalogue, its structure and the site itself remain the property of
    ${esc(BRAND)}.</p>

    <h2>Availability</h2>
    <p>The service is provided as it stands. There is no uptime guarantee, and features
    may change as the catalogue grows. An account that breaks these terms can be
    suspended.</p>

    <h2>Governing law</h2>
    <p>These terms are governed by the laws of ${esc(COUNTRY)}, and disputes fall to the
    courts at ${esc(LOCALITY)}, ${esc(REGION)}.</p>

    <h2>Changes</h2>
    <p>If these terms change, the version on this page is the one that applies.</p>`
  };
}

function refundPage() {
  const url = '/refund';
  const trail = [{ name: 'Home', url: '/' }, { name: 'Refund Policy', url }];
  return {
    url,
    title: `Refund & Cancellation Policy | ${BRAND}`,
    description: `${BRAND} subscription payments are non-refundable. How cancellation ` +
      `works and how to reach support.`,
    breadcrumbHTML: breadcrumb(trail),
    jsonld: [ORG_LD, breadcrumbLd(trail)],
    body: `
    <h1>Refund &amp; Cancellation Policy</h1>
    <p class="seo__lede">Payments for ${esc(BRAND)} subscriptions are non-refundable. This
    page says so plainly so that nobody finds out afterwards.</p>

    <h2>Refunds</h2>
    <p><strong>Subscription payments are not refunded</strong>, in whole or in part, once
    they have been made. This applies to a period already started and to a renewal that has
    gone through. This is subject to applicable law and to the requirements of the payment
    provider, which take precedence where they conflict with this page.</p>

    <h2>Cancellation</h2>
    <p>A subscription can be cancelled at any time from the account. Cancelling stops the
    next renewal. The plan stays active until the end of the period already paid for, and
    that period is not refunded on a pro-rata basis.</p>

    <h2>Before you subscribe</h2>
    <p>The catalogue can be searched without paying, so what a plan adds can be seen before
    it is bought. Look first if you are unsure it fits how you work.</p>

    <h2>Something went wrong with a payment</h2>
    <p>If you were charged twice, charged after cancelling, or charged for something you did
    not buy, write to
    <a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a> from the address on the
    account, with the payment reference. A billing error is not a refund request and is
    dealt with on its own terms.</p>

    <h2>Contact</h2>
    <p>${esc(BRAND)}, ${esc(PLACE)} —
    <a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a></p>`
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
    contactPage(),
    privacyPage(),
    termsPage(),
    refundPage(),
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
    : /^\/(contact|privacy|terms|refund)$/.test(u) ? '0.3'
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
    <changefreq>${p.hasCompat ? 'monthly' : 'yearly'}</changefreq>
    <priority>${p.hasCompat ? '0.6' : '0.3'}</priority>
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

  /* ---- 404 ---- */
  fs.writeFileSync(path.join(ROOT, '404.html'), shell(notFoundPage()));

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
