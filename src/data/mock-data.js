/* ============================================================================
   SnapMatch · mock-data.js
   ----------------------------------------------------------------------------
   PROTOTYPE DATA ONLY. Everything here is generated in the browser from a
   deterministic seed so the UI behaves like a large database without any
   backend. When the real ProGlide database is connected, this file is the ONLY
   thing that gets replaced — src/data/api.js keeps the same shape.

   Entity shapes (kept close to what a real API would return):

     Brand   { id, name, code, color, color2, modelCount }
     Model   { id, brandId, brand, modelName, fullName, releaseDate, ... specs }
     Group   { groupId, groupNumber, serialNumber, partCode, categoryId,
               masterModelId, compatibleDeviceIds[], compatibleCount }
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  /* ---------------------------------------------------------------- random */
  function hash32(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seeded(key) { return mulberry32(hash32(key)); }
  function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
  function intIn(r, a, b) { return Math.floor(a + r() * (b - a + 1)); }
  function round(n, d) { var p = Math.pow(10, d); return Math.round(n * p) / p; }

  /* ============================== BRAND TABLE ==============================
     Centralised brand source. The UI never hardcodes a brand — the panel
     renders whatever this table contains, so adding a row here makes the
     brand appear everywhere automatically.

     Brand { id, name, slug, code, color, color2, aliases[], gsmarena,
             logo, active, sortOrder, search, modelCount, groupCount }

     `gsmarena` is the source reference slug for a future sync against the
     public brand list. `logo` stays null until a real licensed logo file is
     registered (see SM.art.registerBrand) — brands without one are reported
     in the import summary as needing manual logo review rather than being
     given fabricated artwork.
     ====================================================================== */

  /* brands that already carry models + compatibility groups in this build */
  var CORE_BRANDS = [
    { id: 'samsung',  name: 'Samsung',  code: 'SAM', color: '#1D4ED8', color2: '#38BDF8', aliases: ['Samsung Mobile', 'Galaxy'] },
    { id: 'apple',    name: 'Apple',    code: 'APL', color: '#334155', color2: '#94A3B8', aliases: ['iPhone', 'Apple Inc'] },
    { id: 'vivo',     name: 'Vivo',     code: 'VIV', color: '#1E5FD8', color2: '#22D3EE', aliases: ['Vivo Mobile'] },
    { id: 'oppo',     name: 'OPPO',     code: 'OPP', color: '#047857', color2: '#34D399', aliases: ['Oppo Mobile', 'Reno'] },
    { id: 'xiaomi',   name: 'Xiaomi',   code: 'XIA', color: '#EA580C', color2: '#FB923C', aliases: ['Mi', 'Mi Phone'] },
    { id: 'redmi',    name: 'Redmi',    code: 'RED', color: '#C2261F', color2: '#F87171', aliases: ['Xiaomi Redmi', 'Mi Redmi'] },
    { id: 'realme',   name: 'Realme',   code: 'RLM', color: '#CA8A04', color2: '#FACC15', aliases: ['Narzo'] },
    { id: 'oneplus',  name: 'OnePlus',  code: 'ONE', color: '#B91C1C', color2: '#FB7185', aliases: ['One Plus', 'Nord'] },
    { id: 'motorola', name: 'Motorola', code: 'MOT', color: '#0E7490', color2: '#67E8F9', aliases: ['Moto', 'Moto G', 'Moto Edge'] },
    { id: 'nokia',    name: 'Nokia',    code: 'NOK', color: '#1E3A8A', color2: '#60A5FA', aliases: ['HMD', 'HMD Global'] },
    { id: 'google',   name: 'Google',   code: 'GOO', color: '#1A73E8', color2: '#34A853', aliases: ['Pixel', 'Google Pixel'] },
    { id: 'huawei',   name: 'Huawei',   code: 'HUA', color: '#9F1239', color2: '#FB7185', aliases: ['Nova', 'Mate'] },
    { id: 'nothing',  name: 'Nothing',  code: 'NOT', color: '#374151', color2: '#9CA3AF', aliases: ['Nothing Phone', 'CMF'] }
  ];

  /* additional mobile brands the catalogue should cover. No models are mapped
     to these yet, so they report a zero count until stock data arrives. */
  var EXTRA_BRANDS = [
    { id: 'honor',    name: 'Honor',    code: 'HON', color: '#1D4ED8', color2: '#7DD3FC', aliases: ['Honor Magic', 'Huawei Honor'] },
    { id: 'poco',     name: 'POCO',     code: 'POC', color: '#CA8A04', color2: '#FDE047', aliases: ['Pocophone', 'Xiaomi Poco'] },
    { id: 'tecno',    name: 'Tecno',    code: 'TEC', color: '#0EA5E9', color2: '#7DD3FC', aliases: ['Tecno Mobile', 'Camon', 'Spark'] },
    { id: 'infinix',  name: 'Infinix',  code: 'INF', color: '#7C3AED', color2: '#C4B5FD', aliases: ['Infinix Mobility', 'Infinix Hot'] },
    { id: 'itel',     name: 'itel',     code: 'ITL', color: '#DC2626', color2: '#FCA5A5', aliases: ['itel Mobile'] },
    { id: 'lava',     name: 'Lava',     code: 'LAV', color: '#B91C1C', color2: '#F87171', aliases: ['Lava International', 'Agni', 'Blaze'] },
    { id: 'micromax', name: 'Micromax', code: 'MMX', color: '#0891B2', color2: '#67E8F9', aliases: ['Micromax In'] },
    { id: 'asus',     name: 'Asus',     code: 'ASU', color: '#334155', color2: '#94A3B8', aliases: ['ASUS', 'Zenfone', 'ROG Phone'] },
    { id: 'sony',     name: 'Sony',     code: 'SON', color: '#0F172A', color2: '#64748B', aliases: ['Xperia', 'Sony Xperia'] },
    { id: 'lg',       name: 'LG',       code: 'LGE', color: '#A21CAF', color2: '#F0ABFC', aliases: ['LG Electronics'] },
    { id: 'htc',      name: 'HTC',      code: 'HTC', color: '#65A30D', color2: '#BEF264', aliases: ['HTC Desire'] },
    { id: 'zte',      name: 'ZTE',      code: 'ZTE', color: '#0369A1', color2: '#7DD3FC', aliases: ['Nubia', 'ZTE Blade'] },
    { id: 'lenovo',   name: 'Lenovo',   code: 'LEN', color: '#DC2626', color2: '#FCA5A5', aliases: ['Lenovo Mobile'] },
    { id: 'tcl',      name: 'TCL',      code: 'TCL', color: '#1E40AF', color2: '#93C5FD', aliases: ['Alcatel', 'TCL Mobile'] }
  ];

  function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  /* ---------------------------------------------------------------------
     Reusable brand import / sync. Merges an incoming brand feed into an
     existing table: normalises names and slugs, skips repeats inside the
     feed, keeps rows that already exist (never clobbering their model or
     group relationships) and returns a summary of what happened.
     --------------------------------------------------------------------- */
  function syncBrands(existing, incoming) {
    var byId = Object.create(null);
    var out = [];
    var summary = {
      found: incoming.length, imported: 0, retained: 0, duplicates: 0,
      withLogo: 0, logoReview: [], failed: []
    };

    (existing || []).forEach(function (b) { byId[b.id] = b; out.push(b); });

    incoming.forEach(function (raw, i) {
      if (!raw || !raw.name) { summary.failed.push('(row ' + i + ': missing name)'); return; }
      var id = raw.id || slugify(raw.name);

      if (byId[id]) {
        /* already in the table — keep it, never overwrite its relationships */
        if (existing && existing.indexOf(byId[id]) > -1) summary.retained++;
        else summary.duplicates++;
        return;
      }
      var b = {
        id: id,
        name: String(raw.name).trim(),
        slug: raw.slug || slugify(raw.name),
        code: raw.code || String(raw.name).slice(0, 3).toUpperCase(),
        color: raw.color || '#334155',
        color2: raw.color2 || '#94A3B8',
        aliases: (raw.aliases || []).slice(),
        gsmarena: raw.gsmarena || slugify(raw.name),
        logo: raw.logo || null,
        active: raw.active !== false,
        sortOrder: raw.sortOrder != null ? raw.sortOrder : out.length + 1
      };
      b.search = (b.name + ' ' + b.slug + ' ' + b.aliases.join(' ')).toLowerCase();
      byId[id] = b; out.push(b); summary.imported++;
    });

    out.forEach(function (b) {
      if (!b.search) b.search = (b.name + ' ' + b.slug + ' ' + (b.aliases || []).join(' ')).toLowerCase();
      if (b.logo) summary.withLogo++; else summary.logoReview.push(b.name);
    });
    out.sort(function (a, b) { return a.sortOrder - b.sortOrder; });
    return { brands: out, summary: summary };
  }

  /* seed the table, then sync the wider catalogue into it */
  var brandTable = syncBrands([], CORE_BRANDS).brands;
  var brandSync = syncBrands(brandTable, CORE_BRANDS.concat(EXTRA_BRANDS));
  var BRANDS = brandSync.brands;
  var BRAND_IMPORT_SUMMARY = brandSync.summary;

  /* ------------------------------------------------------------ categories */
  /* `fit` drives how compatibility groups are generated for the category.    */
  var CATEGORIES = [
    { id: 'tempered-glass',  name: 'Tempered Glass',        short: 'Glass',    code: 'TG', color: '#0891B2', icon: 'glass',   fit: { scope: 'size',  tol: 0.045, min: 4,  max: 26 } },
    { id: 'back-cover',      name: 'Back Cover',            short: 'Cover',    code: 'BC', color: '#7C3AED', icon: 'cover',   fit: { scope: 'brand', tol: 0.02,  min: 2,  max: 8  } },
    { id: 'combo-display',   name: 'Combo Display',         short: 'Display',  code: 'CD', color: '#2563EB', icon: 'display', fit: { scope: 'brand', tol: 0.015, min: 2,  max: 10 } },
    { id: 'battery',         name: 'Battery',               short: 'Battery',  code: 'BT', color: '#059669', icon: 'battery', fit: { scope: 'brand', tol: 0.30,  min: 3,  max: 15 } },
    { id: 'middle-frame',    name: 'Middle Frame',          short: 'Frame',    code: 'MF', color: '#D97706', icon: 'frame',   fit: { scope: 'brand', tol: 0.02,  min: 2,  max: 6  } },
    { id: 'cc-board',        name: 'CC Board',              short: 'CC Board', code: 'CC', color: '#E11D48', icon: 'board',   fit: { scope: 'brand', tol: 9,     min: 4,  max: 22 } },
    { id: 'charging-board',  name: 'Charging Board',        short: 'Charging', code: 'CB', color: '#EA580C', icon: 'charge',  fit: { scope: 'brand', tol: 9,     min: 6,  max: 46 } },
    { id: 'spare-parts',     name: 'Additional Spare Parts', short: 'Spares',  code: 'SP', color: '#4F46E5', icon: 'parts',   fit: { scope: 'any',   tol: 9,     min: 28, max: 240 } }
  ];

  /* -------------------------------------------------------- model families */
  /* Each family expands into `base + number + suffix`. Sample data only.     */
  var FAMILIES = [
    // ---- Samsung
    { b: 'samsung', base: 'Galaxy S',  nums: [24, 23, 22, 21, 20], sfx: ['', '+', ' Ultra'], tier: 'flag', year: function (n) { return 2000 + n; } },
    { b: 'samsung', base: 'Galaxy A',  nums: [55, 54, 53, 35, 34, 33, 25, 24, 23, 15, 14, 13, 5, 4], pad: 2, sfx: [' 5G'], tier: 'mid', year: function (n) { return 2019 + (n % 10); } },
    { b: 'samsung', base: 'Galaxy M',  nums: [55, 53, 35, 33, 15, 14, 13, 5], pad: 2, sfx: [''], tier: 'mid', year: function (n) { return 2019 + (n % 10); } },
    { b: 'samsung', base: 'Galaxy F',  nums: [55, 54, 15, 14, 13, 5], pad: 2, sfx: [''], tier: 'mid', year: function (n) { return 2019 + (n % 10); } },
    { b: 'samsung', base: 'Galaxy C',  nums: [55], pad: 2, sfx: [''], tier: 'mid', year: function () { return 2024; } },
    { b: 'samsung', names: ['Galaxy Z Fold5', 'Galaxy Z Fold4', 'Galaxy Z Flip5', 'Galaxy Z Flip4', 'Galaxy Note 20 Ultra', 'Galaxy Note 10'], tier: 'flag', y: 2023 },
    // ---- Apple
    { b: 'apple', base: 'iPhone ', nums: [16, 15, 14], sfx: ['', ' Plus', ' Pro', ' Pro Max'], tier: 'flag', year: function (n) { return 2008 + n; } },
    { b: 'apple', base: 'iPhone ', nums: [13, 12], sfx: ['', ' mini', ' Pro', ' Pro Max'], tier: 'flag', year: function (n) { return 2008 + n; } },
    { b: 'apple', base: 'iPhone ', nums: [11], sfx: ['', ' Pro', ' Pro Max'], tier: 'flag', year: function (n) { return 2008 + n; } },
    { b: 'apple', names: ['iPhone SE (3rd generation)', 'iPhone SE (2nd generation)', 'iPhone XR', 'iPhone XS Max', 'iPhone X', 'iPhone 8 Plus', 'iPhone 8', 'iPhone 7'], tier: 'flag', y: 2019 },
    // ---- Vivo
    { b: 'vivo', base: 'V',     nums: [40, 30, 29, 27, 25, 23, 21], sfx: ['', ' Pro'], tier: 'mid', year: function (n) { return n >= 40 ? 2024 : n >= 30 ? 2023 : n >= 27 ? 2022 : 2021; } },
    { b: 'vivo', base: 'Y',     nums: [200, 100, 58, 28, 21, 17, 15], sfx: [''], tier: 'entry', year: function (n) { return n > 99 ? 2024 : 2021; } },
    { b: 'vivo', base: 'T',     nums: [3, 2, 1], sfx: ['', ' Pro'], tier: 'mid', year: function (n) { return 2021 + n; } },
    { b: 'vivo', base: 'X',     nums: [100, 90, 80], sfx: ['', ' Pro'], tier: 'flag', year: function (n) { return 2022 + Math.floor((n - 80) / 10); } },
    // ---- OPPO
    { b: 'oppo', base: 'Reno ', nums: [12, 11, 10, 8, 7], sfx: ['', ' Pro', ' Pro+'], tier: 'mid', year: function (n) { return 2018 + n / 2 | 0; } },
    { b: 'oppo', base: 'F',     nums: [27, 25, 23, 21], sfx: [''], tier: 'mid', year: function (n) { return 2010 + Math.floor(n / 2); } },
    { b: 'oppo', base: 'A',     nums: [79, 78, 59, 58, 57, 38, 17, 16], sfx: [''], tier: 'entry', year: function (n) { return n > 60 ? 2023 : 2022; } },
    { b: 'oppo', base: 'K',     nums: [12, 11, 10], sfx: [''], tier: 'mid', year: function (n) { return 2012 + n; } },
    // ---- Xiaomi
    { b: 'xiaomi', base: '',    nums: [14, 13, 12, 11], sfx: ['', ' Pro', ' Ultra'], tier: 'flag', year: function (n) { return 2010 + n; } },
    { b: 'xiaomi', names: ['Civi 4 Pro', 'Civi 3', 'Mi 11X', 'Mi 10T', 'Poco X6 Pro', 'Poco X5', 'Poco M6 Pro'], tier: 'mid', y: 2023 },
    // ---- Redmi
    { b: 'redmi', base: 'Note ', nums: [13, 12, 11, 10, 9], sfx: ['', ' Pro', ' Pro+', ' 5G'], tier: 'mid', year: function (n) { return 2011 + n; } },
    { b: 'redmi', names: ['13C', '12C', '10A', 'A3', 'A2', 'A1', '9A'], tier: 'entry', y: 2023 },
    { b: 'redmi', base: 'K',     nums: [70, 60], sfx: ['', ' Pro'], tier: 'flag', year: function (n) { return 2017 + n / 10 | 0; } },
    // ---- Realme
    { b: 'realme', base: '',     nums: [12, 11, 10, 9], sfx: ['', ' Pro', ' Pro+'], tier: 'mid', year: function (n) { return 2012 + n; } },
    { b: 'realme', base: 'Narzo ', nums: [70, 60, 50], sfx: ['', ' Pro'], tier: 'mid', year: function (n) { return 2017 + n / 10 | 0; } },
    { b: 'realme', base: 'C',    nums: [67, 55, 53, 35, 31, 21], sfx: [''], tier: 'entry', year: function (n) { return n > 50 ? 2023 : 2022; } },
    { b: 'realme', base: 'GT ',  nums: [6, 5, 3], sfx: ['', ' Pro'], tier: 'flag', year: function (n) { return 2018 + n; } },
    // ---- OnePlus
    { b: 'oneplus', base: '',    nums: [12, 11, 10, 9], sfx: ['', ' Pro', ' R'], tier: 'flag', year: function (n) { return 2012 + n; } },
    { b: 'oneplus', names: ['Nord 4', 'Nord 3', 'Nord CE4', 'Nord CE3 Lite', 'Nord CE2', 'Nord N30'], tier: 'mid', y: 2023 },
    // ---- Motorola
    { b: 'motorola', base: 'Edge ', nums: [50, 40, 30], sfx: ['', ' Pro', ' Fusion'], tier: 'flag', year: function (n) { return 2019 + n / 10 | 0; } },
    { b: 'motorola', base: 'G',   nums: [84, 74, 54, 45, 34, 32, 24, 22], sfx: [''], tier: 'mid', year: function (n) { return 2016 + Math.floor(n / 12); } },
    { b: 'motorola', base: 'E',   nums: [14, 13, 22], sfx: [''], tier: 'entry', year: function () { return 2023; } },
    // ---- Nokia
    { b: 'nokia', base: 'G',     nums: [42, 22, 21, 11], sfx: [''], tier: 'entry', year: function (n) { return 2021 + Math.floor(n / 22); } },
    { b: 'nokia', base: 'C',     nums: [32, 22, 12], sfx: [''], tier: 'entry', year: function () { return 2022; } },
    { b: 'nokia', names: ['X30 5G', 'X20', '105 (2023)', '110 4G', '150'], tier: 'entry', y: 2022 },
    // ---- Google
    { b: 'google', base: 'Pixel ', nums: [9, 8, 7, 6], sfx: ['', ' Pro', 'a'], tier: 'flag', year: function (n) { return 2015 + n; } },
    // ---- Huawei
    { b: 'huawei', base: 'P',    nums: [60, 50, 40], sfx: ['', ' Pro'], tier: 'flag', year: function (n) { return 2017 + n / 10 | 0; } },
    { b: 'huawei', base: 'Nova ', nums: [12, 11, 10], sfx: ['', ' Pro'], tier: 'mid', year: function (n) { return 2012 + n; } },
    { b: 'huawei', base: 'Mate ', nums: [60, 50], sfx: ['', ' Pro'], tier: 'flag', year: function (n) { return 2018 + n / 10 | 0; } },
    // ---- Nothing
    { b: 'nothing', names: ['Phone (2)', 'Phone (2a)', 'Phone (2a) Plus', 'Phone (1)', 'CMF Phone 1'], tier: 'mid', y: 2023 }
  ];

  /* ---------------------------------------------------------- spec helpers */
  var SCREEN_TYPES = {
    flag: ['Dynamic AMOLED 2X', 'LTPO AMOLED', 'Super Retina XDR OLED', 'LTPO OLED'],
    mid: ['Super AMOLED', 'AMOLED', 'pOLED', 'IPS LCD'],
    entry: ['IPS LCD', 'PLS LCD', 'AMOLED']
  };
  var RESOLUTIONS = [
    { w: 1080, h: 2400, r: '20:9' }, { w: 1080, h: 2340, r: '19.5:9' },
    { w: 1220, h: 2712, r: '20:9' }, { w: 1440, h: 3120, r: '19.5:9' },
    { w: 1179, h: 2556, r: '19.5:9' }, { w: 1290, h: 2796, r: '19.5:9' },
    { w: 720, h: 1600, r: '20:9' }, { w: 1264, h: 2780, r: '20:9' }
  ];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var PROTECTION = ['Corning Gorilla Glass Victus 2', 'Corning Gorilla Glass 5', 'Corning Gorilla Glass 3', 'Panda Glass', 'Ceramic Shield', 'Asahi Dragontrail'];

  function baseSize(name, tier, r) {
    if (/mini/i.test(name)) return 5.4;
    if (/SE \(/i.test(name)) return 4.7;
    if (/Fold/i.test(name)) return 7.6;
    if (/Flip/i.test(name)) return 6.7;
    if (/^1(05|10|50)/.test(name)) return 1.8;
    if (/Pro Max|Ultra/i.test(name)) return round(6.7 + r() * 0.2, 2);
    if (/ Pro| Plus|\+/i.test(name)) return round(6.6 + r() * 0.2, 2);
    if (tier === 'flag') return round(6.1 + r() * 0.5, 2);
    if (tier === 'mid') return round(6.5 + r() * 0.3, 2);
    return round(6.4 + r() * 0.3, 2);
  }

  function makeModel(brand, modelName, tier, year) {
    var full = brand.name + ' ' + modelName;
    var r = seeded('model:' + full);
    var size = baseSize(modelName, tier, r);
    var res = size < 5 ? { w: 750, h: 1334, r: '16:9' }
      : tier === 'flag' ? pick(r, RESOLUTIONS.slice(0, 6))
        : tier === 'mid' ? pick(r, RESOLUTIONS.slice(0, 3).concat(RESOLUTIONS.slice(6)))
          : pick(r, [RESOLUTIONS[6], RESOLUTIONS[1]]);
    var h = round(size * 24.2 + (r() * 3 - 1.5), 1);
    var w = round(size * 11.55 + (r() * 2 - 1), 1);
    var t = round(6.9 + r() * 2.1, 1);
    var wt = Math.round(size * 27 + r() * 22 + 10);
    var diagPx = Math.sqrt(res.w * res.w + res.h * res.h);
    return {
      id: full.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      brandId: brand.id,
      brand: brand.name,
      modelName: modelName,
      fullName: full,
      search: full.toLowerCase() + ' ' + modelName.toLowerCase().replace(/[^a-z0-9]/g, ''),
      tier: tier,
      releaseYear: year,
      releaseMonth: MONTHS[intIn(r, 0, 11)],
      releaseDate: MONTHS[intIn(r, 0, 11)] + ' ' + year,
      displaySize: size,
      screenResolution: res.w + ' x ' + res.h + ' px',
      screenRatio: res.r,
      screenType: pick(r, SCREEN_TYPES[tier] || SCREEN_TYPES.mid),
      refreshRate: (tier === 'flag' ? pick(r, [120, 144]) : tier === 'mid' ? pick(r, [90, 120]) : pick(r, [60, 90])) + ' Hz',
      ppi: Math.round(diagPx / size) + ' ppi',
      height: h + ' mm',
      width: w + ' mm',
      thickness: t + ' mm',
      weight: wt + ' g',
      protection: pick(r, PROTECTION),
      sim: pick(r, ['Dual SIM (Nano + Nano)', 'Dual SIM (Nano + eSIM)', 'Single SIM (Nano)']),
      _size: size,
      popularity: Math.round((2026 - year) * -12 + r() * 40 + (tier === 'flag' ? 30 : tier === 'mid' ? 22 : 8))
    };
  }

  /* ------------------------------------------------------------ build models */
  function buildModels() {
    var out = [], seen = Object.create(null);
    var brandMap = Object.create(null);
    BRANDS.forEach(function (b) { brandMap[b.id] = b; });

    FAMILIES.forEach(function (fam) {
      var brand = brandMap[fam.b];
      if (fam.names) {
        fam.names.forEach(function (nm, i) {
          push(brand, nm, fam.tier, fam.y - (i > 2 ? 1 : 0));
        });
        return;
      }
      fam.nums.forEach(function (n) {
        var numStr = fam.pad ? String(n).padStart(fam.pad, '0') : String(n);
        fam.sfx.forEach(function (s) {
          var nm = (fam.pre || '') + fam.base + numStr + s;
          push(brand, nm, fam.tier, fam.year(n));
        });
      });
    });

    function push(brand, nm, tier, year) {
      var m = makeModel(brand, nm, tier, Math.max(2016, Math.min(2026, year || 2023)));
      if (seen[m.id]) return;
      seen[m.id] = 1;
      out.push(m);
    }
    return out;
  }

  /* ------------------------------------------------------- identifier logic */
  var ABBR = { PRO: 'P', MAX: 'M', PLUS: 'PL', ULTRA: 'U', LITE: 'L', MINI: 'MI', FUSION: 'F', GENERATION: '', RD: '', ND: '' };
  var STRIP = /\b(galaxy|iphone|xiaomi|realme|oneplus|phone|5g|4g)\b/gi;

  function partSlug(model) {
    var s = model.modelName.replace(STRIP, ' ');
    var tokens = s.replace(/[()]/g, ' ').split(/[\s+]+/).filter(Boolean);
    var outStr = tokens.map(function (tk) {
      var up = tk.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (ABBR.hasOwnProperty(up)) return ABBR[up];
      return up;
    }).join('');
    outStr = outStr.replace(/[^A-Z0-9]/g, '');
    if (!outStr) outStr = model.brand.slice(0, 3).toUpperCase();
    return outStr.slice(0, 7);
  }
  function pad(n, len) { return String(n).padStart(len, '0'); }

  /* ------------------------------------------------------------ build groups */
  var GROUP_PLAN = [
    ['tempered-glass', 34], ['back-cover', 26], ['combo-display', 24], ['battery', 22],
    ['middle-frame', 16], ['cc-board', 16], ['charging-board', 18], ['spare-parts', 14]
  ];

  function buildGroups(models) {
    var catMap = Object.create(null);
    CATEGORIES.forEach(function (c) { catMap[c.id] = c; });

    var ranked = models.slice().sort(function (a, b) {
      return b.popularity - a.popularity || a.id.localeCompare(b.id);
    });
    var byBrand = Object.create(null);
    models.forEach(function (m) { (byBrand[m.brandId] = byBrand[m.brandId] || []).push(m); });

    var groups = [];
    var serial = 1, gnum = 1;
    var perCatSeq = Object.create(null);

    GROUP_PLAN.forEach(function (row, ci) {
      var catId = row[0], count = row[1], cat = catMap[catId];
      var offset = ci * 7;
      perCatSeq[catId] = 0;

      for (var i = 0; i < count; i++) {
        var master = ranked[(offset + i * 3) % ranked.length];
        var r = seeded('grp:' + catId + ':' + master.id);
        var pool = cat.fit.scope === 'any' ? models
          : cat.fit.scope === 'brand' ? byBrand[master.brandId]
            : models; /* size scope searches everything, filtered below */

        var candidates = pool.filter(function (m) {
          if (m.id === master.id) return false;
          if (cat.fit.tol < 9 && Math.abs(m._size - master._size) > cat.fit.tol) return false;
          return true;
        });
        /* size-scope groups (glass) favour same brand first, then cross-brand */
        if (cat.fit.scope === 'size') {
          candidates.sort(function (a, b) {
            var sa = (a.brandId === master.brandId ? 0 : 1), sb = (b.brandId === master.brandId ? 0 : 1);
            return sa - sb || a.id.localeCompare(b.id);
          });
        } else {
          candidates.sort(function (a, b) {
            return (hash32(catId + a.id) % 1000) - (hash32(catId + b.id) % 1000);
          });
        }

        var target = intIn(r, cat.fit.min, cat.fit.max);
        /* one deliberately huge group per run proves the UI scales */
        if (catId === 'spare-parts' && i === 0) target = 268;
        var members = candidates.slice(0, Math.max(0, target - 1));

        var seq = ++perCatSeq[catId];
        var brandCode = (BRANDS.filter(function (b) { return b.id === master.brandId; })[0] || {}).code || 'GEN';
        groups.push({
          groupId: 'g' + pad(gnum, 3),
          groupNumber: 'GRP-' + pad(gnum, 3),
          serialNumber: 'PG-SN-' + pad(serial, 6),
          partCode: cat.code + '-' + brandCode + '-' + partSlug(master) + '-' + pad(seq, 3),
          categoryId: catId,
          masterModelId: master.id,
          compatibleDeviceIds: [master.id].concat(members.map(function (m) { return m.id; })),
          compatibleCount: members.length + 1,
          createdOn: (2024 + (gnum % 2)) + '-' + pad(1 + (gnum % 12), 2) + '-' + pad(1 + (gnum % 27), 2)
        });
        gnum++; serial++;
      }
    });

    groups.sort(function (a, b) { return a.groupNumber.localeCompare(b.groupNumber); });
    return groups;
  }

  /* -------------------------------------------------------------- assemble */
  var models = buildModels();
  var groups = buildGroups(models);

  var modelById = Object.create(null);
  models.forEach(function (m) { modelById[m.id] = m; });

  var brandById = Object.create(null);
  BRANDS.forEach(function (b) {
    b.modelCount = models.filter(function (m) { return m.brandId === b.id; }).length;
    /* groups whose MASTER model belongs to this brand — matches how the brand
       filter in listGroups() selects, so the count always equals the result. */
    b.groupCount = groups.filter(function (g) {
      return modelById[g.masterModelId].brandId === b.id;
    }).length;
    brandById[b.id] = b;
  });

  var categoryById = Object.create(null);
  CATEGORIES.forEach(function (c) {
    c.groupCount = groups.filter(function (g) { return g.categoryId === c.id; }).length;
    categoryById[c.id] = c;
  });

  var groupById = Object.create(null);
  var groupsByModel = Object.create(null);   /* modelId -> [groupId]  (membership) */
  var totalLinks = 0;
  groups.forEach(function (g) {
    groupById[g.groupId] = g;
    totalLinks += g.compatibleCount;
    g.compatibleDeviceIds.forEach(function (id) {
      (groupsByModel[id] = groupsByModel[id] || []).push(g.groupId);
    });
  });

  /* models sorted for default browse order */
  var modelsRanked = models.slice().sort(function (a, b) {
    return b.popularity - a.popularity || a.fullName.localeCompare(b.fullName);
  });

  SM.db = {
    brands: BRANDS,
    categories: CATEGORIES,
    models: models,
    modelsRanked: modelsRanked,
    groups: groups,
    modelById: modelById,
    brandById: brandById,
    categoryById: categoryById,
    groupById: groupById,
    groupsByModel: groupsByModel,
    brandImport: BRAND_IMPORT_SUMMARY,
    syncBrands: syncBrands,          /* reusable for the next import run */
    stats: {
      models: models.length,
      brands: BRANDS.length,
      brandsWithModels: BRANDS.filter(function (b) { return b.modelCount > 0; }).length,
      groups: groups.length,
      categories: CATEGORIES.length,
      links: totalLinks
    }
  };
})(window);
