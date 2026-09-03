/* ============================================================================
   Mobile Parts Finder · dataset.js — the real catalogue
   ----------------------------------------------------------------------------
   Loads assets/dataset.json and builds SM.db from it. This replaces the sample
   generator: every model, group and fitment here came from the owner's own
   export.

   WHAT THE SOURCE ACTUALLY CONTAINS
     name · brand · release date · display size · height · width · screen area ·
     body ratio · battery · image · source URL,
     plus 3,340 compatibility groups and 12,239 fitments.

   WHAT IT DOES NOT
     chipset, CPU, GPU, RAM, storage, colours, cameras, OS, network, sensors,
     price, variants, and whether the screen is flat or curved.

     Those are set to null and the UI omits them. They are NOT estimated,
     defaulted or filled from a lookalike model — a spec sheet that invents a
     processor is worse than one that admits the field is unknown, because the
     invented one gets quoted to a customer.

   deviceType is the one exception, and it is derived rather than invented:
   "Apple iPad 10.2 (2019)" is a tablet because the name says so. `typeDerived`
   marks it, so the UI can distinguish a fact from a reading.

   LOADING
     One fetch, ~280 KB gzipped, before the first render. Rows arrive
     positionally — an object per model would repeat sixteen key names 4,933
     times — and are rehydrated here in a single pass.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  /* Presentation only. A brand's colour is a UI token, not a claim about the
     device, so keeping it in code is not the same as inventing spec data. */
  var BRAND_COLOR = {
    apple: '#0F172A', samsung: '#1D4ED8', xiaomi: '#EA580C', oppo: '#0E7490',
    vivo: '#1E40AF', realme: '#EAB308', oneplus: '#DC2626', motorola: '#1E5FD8',
    nokia: '#0369A1', google: '#1A73E8', huawei: '#B91C1C', honor: '#0891B2',
    nothing: '#111827', tecno: '#0D9488', infinix: '#7C3AED', itel: '#DB2777',
    lava: '#C2410C', asus: '#1E3A8A', zte: '#2563EB', lenovo: '#B91C1C',
    coolpad: '#0284C7', hmd: '#047857'
  };
  var CAT_ICON = {
    'screen-guards': 'glass', 'back-cover': 'cover', 'combo-display': 'display',
    'middle-frame': 'frame', 'cc-board': 'board', 'battery': 'battery'
  };
  var CAT_COLOR = {
    'screen-guards': '#0E7490', 'back-cover': '#7C3AED', 'combo-display': '#2563EB',
    'middle-frame': '#B45309', 'cc-board': '#E11D48', 'battery': '#047857'
  };

  var MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
  function fmtDate(iso) {
    if (!iso) return null;
    var m = String(iso).match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
    if (!m) return iso;
    var month = MONTHS[Number(m[2]) - 1];
    if (!month) return iso;
    return (m[3] ? Number(m[3]) + ' ' : '') + month + ' ' + m[1];
  }

  /* Turns a positional row into the object shape the UI reads. Fields the
     source does not carry are null, uniformly — a missing key would look like
     an oversight, an explicit null reads as "not known". */
  function toModel(row, cols, brandName) {
    var r = {};
    cols.forEach(function (c, i) { r[c] = row[i]; });

    var name = r.n;
    var brand = brandName || '';
    /* The export stores the full name with the brand on the front. */
    var short = brand && name.toLowerCase().indexOf(brand.toLowerCase() + ' ') === 0
      ? name.slice(brand.length + 1) : name;

    return {
      id: r.id,
      brandId: r.b,
      brand: brand,
      modelName: short,
      fullName: name,
      search: name.toLowerCase(),
      deviceType: r.dt,
      typeDerived: true,           /* read off the name, not stated by the source */

      /* The export stores ISO dates. "20 September 2019" is what a counter
         reads; "2019-09-20" is what a database stores. */
      releaseDate: fmtDate(r.rd),
      releaseDateIso: r.rd,
      releaseYear: r.ry,
      displaySize: r.sz,
      screenCm2: r.cm2,
      bodyRatio: r.br,
      height: r.h != null ? r.h + ' mm' : null,
      width: r.w != null ? r.w + ' mm' : null,
      image: r.img,
      sourceUrl: r.src,

      /* -------- absent from the source; never guessed ------------------- */
      screenCurve: null,
      screenType: null,
      screenResolution: null,
      screenRatio: null,
      refreshRate: null,
      ppi: null,
      protection: null,
      sim: null,
      thickness: null,
      weight: null,
      tier: null,
      popularity: r.ry || 0,

      specs: {
        batteryMah: r.mah,         /* the one spec the export does carry */
        chipset: null, cpu: null, gpu: null, fabrication: null,
        ramVariantsGb: null, storageVariantsGb: null, expandable: null,
        variants: null, colors: null,
        cameraRear: null, cameraFront: null, videoMax: null,
        batteryType: null, chargingWatts: null, wirelessCharging: null,
        os: null, osVersion: null, skin: null,
        network: null, networkDetail: null, wifi: null, bluetooth: null,
        nfc: null, usb: null, headphoneJack: null, sensors: null,
        launchPriceInr: null, status: null
      }
    };
  }

  function build(bundle) {
    var brandById = Object.create(null);
    var brands = bundle.brands.map(function (row) {
      var b = {
        id: row[0], name: row[1], modelCount: row[2], groupCount: row[3],
        slug: row[0], code: row[1].slice(0, 3).toUpperCase(),
        color: BRAND_COLOR[row[0]] || '#0E7A6C',
        color2: BRAND_COLOR[row[0]] || '#12907F',
        aliases: [], logo: null, active: true,
        search: (row[1] + ' ' + row[0]).toLowerCase(),
        counts: null              /* filled below, once models are known */
      };
      brandById[b.id] = b;
      return b;
    });

    var models = bundle.models.map(function (row) {
      var brand = brandById[row[1]];
      return toModel(row, bundle.modelCols, brand ? brand.name : '');
    });

    var modelById = Object.create(null);
    models.forEach(function (m) { modelById[m.id] = m; });

    /* Brand rollups. Flat and curved are absent from the source, so they are
       absent here — the dashboard shows what is known and says nothing about
       what is not, rather than reporting a confident zero. */
    brands.forEach(function (b) {
      var mine = models.filter(function (m) { return m.brandId === b.id; });
      b.counts = {
        total: mine.length,
        phones: mine.filter(function (m) { return m.deviceType === 'phone'; }).length,
        tablets: mine.filter(function (m) { return m.deviceType === 'tablet'; }).length,
        watches: mine.filter(function (m) { return m.deviceType === 'watch'; }).length,
        flat: null, curved: null
      };
    });

    var categories = bundle.categories.map(function (c) {
      return {
        id: c.id, name: c.name, short: c.short, code: c.code, order: c.order,
        groupCount: c.groupCount,
        icon: CAT_ICON[c.id] || 'parts',
        color: CAT_COLOR[c.id] || '#0E7A6C'
      };
    });
    var categoryById = Object.create(null);
    categories.forEach(function (c) { categoryById[c.id] = c; });

    var gc = bundle.groupCols;
    var groups = bundle.groups.map(function (row) {
      var g = {};
      gc.forEach(function (c, i) { g[c] = row[i]; });
      var master = modelById[g.mm];
      var cat = categoryById[g.cat];
      /* Field names match what the UI already reads. The export calls these
         memberIds and groupNo; renaming here rather than across the app keeps
         the change to one file and leaves every screen untouched. */
      return {
        groupId: g.id,
        groupNumber: g.no,
        serialNumber: g.no,
        partCode: g.part || null,
        categoryId: g.cat,
        categoryName: cat ? cat.name : g.cat,
        masterModelId: g.mm,
        masterModelName: master ? master.fullName : g.mm,
        masterBrandId: g.mb,
        /* The member list is the paid answer and is NOT in this bundle.
           Anything under assets/ is one unauthenticated GET away, so the
           public copy carries only the count. The ids come from
           /api/device-parts, behind a subscription. */
        compatibleDeviceIds: null,
        compatibleCount: g.cnt,
        createdOn: null,
        memberNames: null
      };
    });

    var groupById = Object.create(null);
    groups.forEach(function (g) { groupById[g.groupId] = g; });

    /* device -> how many parts it has, per category. Counts are free; which
       groups they are is what the subscription buys, so the public bundle
       ships numbers and no ids. groupsByModel keeps its old shape — an array
       whose LENGTH is right — because the whole UI reads .length off it. */
    var groupsByModel = Object.create(null);
    var partCounts = bundle.modelGroupCounts || {};
    Object.keys(partCounts).forEach(function (modelId) {
      var byCat = partCounts[modelId];
      var total = 0;
      Object.keys(byCat).forEach(function (cat) { total += byCat[cat]; });
      groupsByModel[modelId] = new Array(total);
    });

    var links = groups.reduce(function (s, g) { return s + g.memberCount; }, 0);

    SM.db = {
      brands: brands,
      categories: categories,
      models: models,
      modelsRanked: models.slice().sort(function (a, b) {
        return (b.releaseYear || 0) - (a.releaseYear || 0);
      }),
      groups: groups,
      modelById: modelById,
      brandById: brandById,
      categoryById: categoryById,
      groupById: groupById,
      groupsByModel: groupsByModel,
      partCountsByCategory: partCounts,
      /* So the UI can state its own limits instead of rendering blank rows. */
      coverage: {
        present: bundle.fieldsPresent,
        absent: bundle.fieldsAbsent,
        derived: bundle.fieldsDerived,
        source: bundle.source
      },
      stats: {
        models: models.length,
        brands: brands.length,
        brandsWithModels: brands.filter(function (b) { return b.modelCount > 0; }).length,
        groups: groups.length,
        categories: categories.length,
        links: links
      }
    };
    return SM.db;
  }

  var loaded = null;

  SM.dataset = {
    /** One fetch, cached. Resolves with SM.db. */
    load: function () {
      if (loaded) return loaded;
      loaded = fetch('assets/dataset.json')
        .then(function (res) {
          if (!res.ok) throw new Error('dataset ' + res.status);
          return res.json();
        })
        .then(build)
        .catch(function (err) {
          loaded = null;
          throw err;
        });
      return loaded;
    },
    build: build
  };
})(window);
