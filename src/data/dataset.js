/* ============================================================================
   Mobile Parts Finder · dataset.js — the real catalogue
   ----------------------------------------------------------------------------
   Loads assets/dataset.json and builds SM.db from it. This replaces the sample
   generator: every model, group and fitment here came from the owner's own
   export.

   WHAT THE SOURCE ACTUALLY CONTAINS
     name · brand · release date · display size · height · width · screen area ·
     body ratio · battery · image · source URL,
     plus 3,340 compatibility groups and 12,239 fitments — every group's part
     code, serial number, master device and full member list.

   PARTIALLY
     screen type (260 devices), battery part number (288) and release status,
     read from the category exports. Null elsewhere, and the UI omits the row
     rather than filling it: a device nobody recorded is not a flat-screen one.

   WHAT IT DOES NOT
     chipset, CPU, GPU, RAM, storage, colours, cameras, OS, network, sensors,
     price, variants.

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

    /* "Flat Screen" / "Curved Screen" as the source records it. The one-word
       form the UI filters on is READ from that string, not inferred from
       anything else — a device with no recorded screen type stays null rather
       than becoming flat by default. */
    var curve = r.st ? (/curved/i.test(r.st) ? 'curved' : 'flat') : null;

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

      /* -------- carried by the category exports, for some devices --------
         260 of 4,933 have a screen type and 288 a battery part number. The
         rest are null and the UI omits the row: a blank is a fact about the
         catalogue, an invented "Flat" is a claim about someone's phone. */
      screenType: r.st || null,
      screenCurve: curve,
      batteryPartNo: r.bp || null,
      batteryPartVerified: r.bv === true,
      releaseStatus: r.rs || null,

      /* -------- absent from the source; never guessed ------------------- */
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

      /* Members ship as indexes into `models` — the same 12,239 fitments cost
         about 60 KB that way and about 330 KB as slugs. Both arrays came out
         of one build, so an index always names the row it was written for. */
      var memberIds = (g.mem || []).map(function (i) {
        var m = models[i];
        return m ? m.id : null;
      }).filter(Boolean);

      /* Field names match what the UI already reads. The export calls these
         memberIds and groupNo; renaming here rather than across the app keeps
         the change to one file and leaves every screen untouched. */
      return {
        groupId: g.id,
        groupNumber: g.no,
        /* Distinct values at last. Until now the client set all three from the
           group number, so every sheet showed "BT-0001" as its part code, its
           serial and its group — three labels over one value. */
        serialNumber: g.sn || g.no,
        partCode: g.part || null,
        /* The manufacturer's own code, where the source genuinely has one:
           286 battery groups. null everywhere else, on purpose — the column it
           came from holds "1" and "asdf" for the other five categories. */
        oemPartNo: g.oem || null,
        categoryId: g.cat,
        categoryName: cat ? cat.name : g.cat,
        masterModelId: g.mm,
        masterModelName: master ? master.fullName : g.mm,
        masterBrandId: g.mb,
        compatibleDeviceIds: memberIds,
        compatibleCount: g.cnt,
        createdOn: null,
        memberNames: memberIds.map(function (id) {
          var m = modelById[id];
          return m ? m.fullName : id;
        })
      };
    });

    var groupById = Object.create(null);
    groups.forEach(function (g) { groupById[g.groupId] = g; });

    /* device -> the groups that fit it, as ids, and the per-category counts
       the device page reads. Both come from the one map in the bundle, so a
       count can never disagree with the list it counts. */
    var groupsByModel = Object.create(null);
    var partCounts = Object.create(null);
    var mg = bundle.modelGroups || {};
    Object.keys(mg).forEach(function (modelId) {
      var byCat = mg[modelId];
      var all = [];
      var counts = Object.create(null);
      Object.keys(byCat).forEach(function (cat) {
        var ids = byCat[cat] || [];
        counts[cat] = ids.length;
        all = all.concat(ids);
      });
      groupsByModel[modelId] = all;
      partCounts[modelId] = counts;
    });

    /* Total fitments. It read g.memberCount, which this layer never sets — the
       field is called compatibleCount here — so the figure had been NaN since
       the rename. */
    var links = groups.reduce(function (s, g) { return s + (g.compatibleCount || 0); }, 0);

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
        /* Recorded for some devices and not others. Named separately so the UI
           can say "260 of 4,933" instead of either claiming the field or
           denying it. */
        partial: bundle.fieldsPartial || [],
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
      /* Absolute. A relative path resolves against the current URL, so on a
         clean route like /models/apple the browser asked for
         /models/assets/dataset.json and the catalogue never loaded. */
      loaded = fetch('/assets/dataset.json')
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
