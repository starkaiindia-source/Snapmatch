/* === src/data/debug.js === */;
/* ============================================================================
   Mobile Parts Finder · debug.js — diagnostics you can turn on from a phone
   ----------------------------------------------------------------------------
   Sign-in fails differently on a shop owner's Android than it does on a
   developer's laptop, and "it sends me back to the login page" is all the
   detail a bug report ever carries. This is how the rest of the detail gets
   collected: the auth and payment paths log every step through SM.debug, and
   the log is written only when someone asks for it.

   TURNING IT ON
     Add ?debug=1 to the URL, or run  localStorage['mpf.debug'] = '1'
     Off again: ?debug=0, or remove the key.
     The choice sticks, so it survives the redirect to Google and back — which
     is the whole point, since the interesting part happens on the return trip.

   WHAT IT MUST NEVER LOG
     ID tokens, the Razorpay key secret, webhook secrets, session cookies.
     Nothing here reads them, and nothing that calls it passes them. A uid, an
     email and an error code are enough to follow a sign-in from end to end,
     and none of the three is a credential.

   SM.debug.tail() returns the entries as an array so they can be read off a
   phone that has no console — the ring buffer is kept whether logging is on or
   off, so a failure that has already happened can still be inspected.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  var KEY = 'mpf.debug';
  var RING = 200;
  var ring = [];

  function readFlag() {
    try {
      var q = String(global.location.search || '');
      if (/[?&]debug=1/.test(q)) { localStorage.setItem(KEY, '1'); return true; }
      if (/[?&]debug=0/.test(q)) { localStorage.removeItem(KEY); return false; }
      return localStorage.getItem(KEY) === '1';
    } catch (e) { return false; }        /* private mode: stay quiet */
  }

  var on = readFlag();

  /* Timestamps are relative to page load. Wall-clock time tells you nothing
     about a race; "auth resolved 2,400 ms after boot" tells you everything. */
  var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
  function since() {
    var t = (global.performance && performance.now) ? performance.now() : Date.now();
    return Math.round(t - t0);
  }

  function record(scope, msg, data) {
    var entry = { t: since(), scope: scope, msg: msg };
    if (data !== undefined) entry.data = data;
    ring.push(entry);
    if (ring.length > RING) ring.shift();
    return entry;
  }

  SM.debug = {
    get enabled() { return on; },

    /** Normal step in a flow. Silent unless debugging is on. */
    log: function (scope, msg, data) {
      var e = record(scope, msg, data);
      if (on) console.log('[' + scope + ' +' + e.t + 'ms]', msg, data === undefined ? '' : data);
    },

    /** Something went wrong. ALWAYS printed — a real failure is not noise. */
    warn: function (scope, msg, data) {
      var e = record(scope, msg, data);
      console.warn('[' + scope + ' +' + e.t + 'ms]', msg, data === undefined ? '' : data);
    },

    /** Everything recorded this page load, oldest first. */
    tail: function (n) { return ring.slice(-(n || RING)); },

    /** One block of text to paste into a bug report. */
    dump: function () {
      return ring.map(function (e) {
        return '+' + e.t + 'ms [' + e.scope + '] ' + e.msg +
          (e.data === undefined ? '' : ' ' + JSON.stringify(e.data));
      }).join('\n');
    },

    set: function (v) {
      on = !!v;
      try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); }
      catch (e) { /* private mode */ }
      return on;
    }
  };

  if (on) console.log('[debug] Mobile Parts Finder diagnostics on — SM.debug.dump() to copy the log');
})(window);

/* === src/data/dataset.js === */;
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
    'middle-frame': 'frame', 'cc-board': 'board', 'battery': 'battery',
    'button-flex': 'board', 'sim-tray': 'frame'
  };
  /* The accent a selected category is outlined in. White badge text sits on
     it, so every value here clears 4.5:1 against white. */
  var CAT_COLOR = {
    'screen-guards': '#0E7490', 'back-cover': '#7C3AED', 'combo-display': '#2563EB',
    'middle-frame': '#B45309', 'cc-board': '#E11D48', 'battery': '#047857',
    'button-flex': '#C2410C', 'sim-tray': '#4F46E5'
  };

  var MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

  /* How much of a release date the source actually knows.

     The workbook stores every date as dd/mm/yyyy, and a phone it only knows as
     "2011, March" went in as 01/03/2011. Measured over the 4,822 dated models,
     1,564 fall on the 1st against roughly 100 on any other day, so a 1st is a
     month the export padded and not a day anybody recorded. Printing
     "1 March 2011" would state a day nobody knows; "March 2011" is true either
     way, including for the few phones really released on a 1st. */
  function releasePrecision(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
    if (!m) return null;
    return m[3] && m[3] !== '01' ? 'day' : 'month';
  }

  function fmtDate(iso) {
    if (!iso) return null;
    var m = String(iso).match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
    if (!m) return iso;
    var month = MONTHS[Number(m[2]) - 1];
    if (!month) return iso;
    return (releasePrecision(iso) === 'day' ? Number(m[3]) + ' ' : '') + month + ' ' + m[1];
  }

  /* One model whose year is a forecast: the source says "Exp. release 2026, Q1".
     The year still sorts and filters it, but a card must not say it came out. */
  var RELEASE_NOT_CONFIRMED = { 'hmd-ivalo-xe': 1 };

  /** The release date as a card prints it, at the precision the source has:
      "15 September 2026", "March 2025", "2017", or null when nothing is known. */
  function releaseLabel(m) {
    if (!m) return null;
    if (m.releaseDate) return m.releaseDate;
    if (RELEASE_NOT_CONFIRMED[m.id]) return null;
    return m.releaseYear ? String(m.releaseYear) : null;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /**
   * True when this model came out in the last calendar month, counting back
   * from the visitor's own date: on 30 October the window opens on 30 September,
   * and on 31 March it opens on the last day of February.
   *
   * ISO strings compare correctly as text, so no Date is built from the release
   * date. new Date('2026-10-15') is midnight UTC, which is the previous evening
   * anywhere west of Greenwich and would move a model across the boundary.
   *
   * Only a date recorded to the day qualifies. A month-only date cannot prove
   * the model is inside the window, and a model marked cancelled or coming soon
   * has not been released at all.
   */
  function isNewRelease(m, now) {
    var iso = m && m.releaseDateIso;
    if (releasePrecision(iso) !== 'day') return false;
    if (m.releaseStatus === 'cancelled' || m.releaseStatus === 'coming_soon') return false;

    var d = now || new Date();
    var y = d.getFullYear(), mo = d.getMonth(), day = d.getDate();
    var fromY = mo === 0 ? y - 1 : y;
    var fromM = mo === 0 ? 11 : mo - 1;
    var fromD = Math.min(day, new Date(fromY, fromM + 1, 0).getDate());

    var rel = String(iso).slice(0, 10);
    return rel >= fromY + '-' + pad2(fromM + 1) + '-' + pad2(fromD) &&
           rel <= y + '-' + pad2(mo + 1) + '-' + pad2(day);
  }

  /* Image URLs that are in the export but are not a picture of the model.

     GSMArena serves one generic silhouette, smartphone.jpg, for handsets it has
     no photograph of, and 15 models across eight brands point at it. Realme X9
     Pro points at the Oppo Reno5 Pro+, and Cubot X1 (added from the device
     list merged in November 2026) at the Oukitel BT80. All are dropped here, where the record
     is read, so every screen falls back the same way and the catalogue itself
     stays as the owner exported it.

     The rest of the 313 URLs that more than one model shares are left alone:
     they are sibling variants of one handset (vivo Y03 and Y03t) sharing a
     press shot, which is what the source intends. */
  var NOT_A_MODEL_PHOTO = /\/smartphone\.jpg$/i;
  var WRONG_MODEL_PHOTO = { 'realme-x9-pro': 1, 'cubot-x1': 1 };

  function modelImage(id, url) {
    if (!url || NOT_A_MODEL_PHOTO.test(url) || WRONG_MODEL_PHOTO[id]) return null;
    return url;
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
      /* The same name with the spaces out, so "redminote13" finds it. */
      compact: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
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
      /* The same two measurements as numbers, for the specification tables —
         which put the unit in the column heading and must not parse it back
         out of a display string. */
      heightMm: typeof r.h === 'number' ? r.h : null,
      widthMm: typeof r.w === 'number' ? r.w : null,
      image: modelImage(r.id, r.img),
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
        /* A category the register carries but whose groups have not been
           collected yet. It is a real category — id, order, picture, a place
           in the grid — with nothing behind it, and the UI offers it as such
           rather than opening an empty result. Never guessed: only the
           bundle says so. */
        comingSoon: c.comingSoon === true,
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
      /* NULL, not [], when the bundle carries no member list.

         The two mean different things and hydrate() in src/data/api.js reads
         the difference: null is "withheld, ask the server", [] is "this group
         genuinely has no members". An empty array is truthy, so defaulting to
         one made `locked: !g.compatibleDeviceIds` false for every group and
         painted "No devices recorded in this group" over a list that was
         simply not in the file.

         `mem` is absent from every group now — it is the paid answer and
         reaches a browser only through /api/device-parts, sliced to the
         caller's tier. See scripts/build-runtime-bundle.js. */
      var memberIds = g.mem
        ? g.mem.map(function (i) {
            var m = models[i];
            return m ? m.id : null;
          }).filter(Boolean)
        : null;

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
        memberNames: memberIds
          ? memberIds.map(function (id) {
              var m = modelById[id];
              return m ? m.fullName : id;
            })
          : null
      };
    });

    var groupById = Object.create(null);
    groups.forEach(function (g) { groupById[g.groupId] = g; });

    /* --------------------------------------------- device -> part categories

       COUNTS, NOT LISTS, AND THAT IS THE PAYWALL.

       `bundle.modelCats` is device -> { categoryId: howManyGroups }. It used
       to be `bundle.modelGroups`, device -> { categoryId: [groupId, …] }, and
       the block below used to invert it into `membersByGroup` — every group's
       complete member list, rebuilt in the browser, for everyone, signed in or
       not. Withholding the member list from the `groups` array achieved
       nothing while this map shipped: all 3,384 groups were recoverable from
       it, and so was every one of the 12,345 fitments the subscription sells.

       So the bundle carries the counts and the counts alone. They are what a
       free account is entitled to — "this phone has a back cover and a battery
       listed" — and a count cannot be turned back into a list.

       WHERE THE LISTS COME FROM NOW. /api/device-parts, which reads the
       caller's subscription from Firestore before it answers and returns no
       members at all to a free account. See api/_services/entitlement-service.

       groupsByModel and membersByGroup stay declared, and stay EMPTY. Every
       reader of them already writes `|| []`, so an empty map degrades to "no
       members known locally" — which is the truth — rather than throwing. */
    var groupsByModel = Object.create(null);
    var membersByGroup = Object.create(null);
    var partCounts = Object.create(null);
    var groupCountByModel = Object.create(null);

    /* `modelGroups` is the OLD key. A browser holding a bundle from before
       this change still has it, and reading the counts out of it keeps that
       browser's category chips working until the new file arrives. What is
       NOT done with it, ever again, is building a member list. */
    var mc = bundle.modelCats || null;
    var legacy = !mc && bundle.modelGroups ? bundle.modelGroups : null;
    var src = mc || legacy || {};

    Object.keys(src).forEach(function (modelId) {
      var byCat = src[modelId] || {};
      var counts = Object.create(null);
      var total = 0;
      Object.keys(byCat).forEach(function (cat) {
        var v = byCat[cat];
        var n = typeof v === 'number' ? v : (v && v.length) || 0;
        if (n > 0) { counts[cat] = n; total += n; }
      });
      partCounts[modelId] = counts;
      groupCountByModel[modelId] = total;
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
      /* Both empty — see the block above. Kept so `db.groupsByModel[x] || []`
         at every existing call site keeps meaning "nothing known here". */
      groupsByModel: groupsByModel,
      membersByGroup: membersByGroup,
      partCountsByCategory: partCounts,
      /* How many groups fit a device, in total. The one figure the old
         `groupsByModel[id].length` was actually used for at most call sites,
         and the only part of it that was ever free. */
      groupCountByModel: groupCountByModel,
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
    build: build,
    releaseLabel: releaseLabel,
    isNewRelease: isNewRelease
  };
})(window);

/* === src/data/brand-marks.js === */;
/* ============================================================================
   Mobile Parts Finder · brand-marks.js — official brand marks, inline
   ----------------------------------------------------------------------------
   GENERATED. Do not edit by hand — run: node scripts/build-brand-marks.js

   Vector paths for the brand logos, embedded rather than fetched. Inlining
   them means a logo cannot fail to load, cannot leak a request to a third
   party, and stays crisp at any size — the whole brand rail costs zero network
   requests and paints with the first frame.

   SOURCE AND LICENCE
     Simple Icons (https://simpleicons.org), CC0-1.0 — public domain. The logos
     remain the trademarks of their owners and are used nominatively, to
     identify which manufacturer a part fits.

   BRANDS WITHOUT A MARK
     Simple Icons carries no logo for the ids in SM.brandMarksReview. They are
     not approximated here: a drawn-from-memory logo is a WRONG logo, and that
     is worse than none. Those brands render as a full wordmark in their own
     official colour, and are the reason src/data/brand-assets.js exists — drop
     a licensed file in Firebase Storage and it takes precedence over
     everything in this file.

   COLOUR
     `h` is the brand’s own hex, and `adj` marks a substitution made because
     the published colour is unusable on a pale logo chip (Sony publishes
     white). src/data/brand-assets.js decides how that colour is PRESENTED per
     theme; this file only records what it is.

   Generated 2026-09-05T09:10:39.877Z
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  /* id: { t: title, h: hex, p: path, adj: colour was substituted } */
  SM.brandMarks = {"apple":{"t":"Apple","h":"000000","p":"M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"},"asus":{"t":"ASUS","h":"000000","p":"M23.904 10.788V9.522h-4.656c-.972 0-1.41.6-1.482 1.182v.018-1.2h-1.368v1.266h1.362zm-6.144.456l-1.368-.078v1.458c0 .456-.228.594-1.02.594H14.28c-.654 0-.93-.186-.93-.594v-1.596l-1.386-.102v1.812h-.03c-.078-.528-.276-1.14-1.596-1.23L6 11.22c0 .666.474 1.062 1.218 1.14l3.024.306c.24.018.414.09.414.288 0 .216-.18.24-.456.24H5.946V11.22l-1.386-.09v3.348h5.646c1.26 0 1.662-.654 1.722-1.2h.03c.156.864.912 1.2 2.19 1.2h1.41c1.494 0 2.202-.456 2.202-1.524zm4.398.258l-4.338-.258c0 .666.438 1.11 1.182 1.17l3.09.24c.24.018.384.078.384.276 0 .186-.168.258-.516.258h-4.212v1.29h4.302c1.356 0 1.95-.474 1.95-1.554 0-.972-.534-1.338-1.842-1.422zm-10.194-1.98h1.386v1.266h-1.386zM3.798 11.07l-1.506-.15L0 14.478h1.686zm7.914-1.548h-4.23c-.984 0-1.416.612-1.518 1.2v-1.2H3.618c-.33 0-.486.102-.642.33l-.648.936h9.384Z"},"google":{"t":"Google","h":"4285F4","p":"M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"},"honor":{"t":"Honor","h":"000000","p":"M2.601 9.753v1.823H.807V9.753H0v4.498h.807v-1.874h1.794v1.874h.807V9.753h-.807Zm18.671.801h.898c.369 0 .667.297.667.662a.665.665 0 0 1-.667.663h-.898v-1.325Zm-.806-.801v4.498h.806v-2.002l1.68 2.002H24l-1.376-1.64a1.462 1.462 0 0 0-.444-2.858h-1.716.002Zm-7.63-.014v2.807l-1.959-2.807h-.644v4.498h.807v-2.82l1.968 2.82h.633V9.739h-.805Zm-7.532 2.26c0-.832.68-1.506 1.517-1.506A1.51 1.51 0 0 1 8.337 12c0 .832-.679 1.506-1.516 1.506-.403 0-.789-.159-1.073-.441A1.504 1.504 0 0 1 5.304 12v-.001ZM4.497 12c0 .933.566 1.774 1.434 2.132.869.357 1.868.16 2.533-.5.664-.66.863-1.653.503-2.515a2.324 2.324 0 0 0-2.146-1.425 2.316 2.316 0 0 0-2.323 2.307L4.497 12Zm11.04-.001a1.513 1.513 0 0 1 1.518-1.506c.838 0 1.516.675 1.516 1.507a1.513 1.513 0 0 1-1.518 1.506c-.402 0-.788-.159-1.072-.441a1.5 1.5 0 0 1-.444-1.066ZM14.73 12c0 .933.566 1.774 1.434 2.132.868.357 1.868.16 2.532-.5.665-.66.864-1.653.504-2.515a2.325 2.325 0 0 0-2.147-1.425 2.316 2.316 0 0 0-2.323 2.307V12Z"},"huawei":{"t":"Huawei","h":"FF0000","p":"M3.67 6.14S1.82 7.91 1.72 9.78v.35c.08 1.51 1.22 2.4 1.22 2.4 1.83 1.79 6.26 4.04 7.3 4.55 0 0 .06.03.1-.01l.02-.04v-.04C7.52 10.8 3.67 6.14 3.67 6.14zM9.65 18.6c-.02-.08-.1-.08-.1-.08l-7.38.26c.8 1.43 2.15 2.53 3.56 2.2.96-.25 3.16-1.78 3.88-2.3.06-.05.04-.09.04-.09zm.08-.78C6.49 15.63.21 12.28.21 12.28c-.15.46-.2.9-.21 1.3v.07c0 1.07.4 1.82.4 1.82.8 1.69 2.34 2.2 2.34 2.2.7.3 1.4.31 1.4.31.12.02 4.4 0 5.54 0 .05 0 .08-.05.08-.05v-.06c0-.03-.03-.05-.03-.05zM9.06 3.19a3.42 3.42 0 00-2.57 3.15v.41c.03.6.16 1.05.16 1.05.66 2.9 3.86 7.65 4.55 8.65.05.05.1.03.1.03a.1.1 0 00.06-.1c1.06-10.6-1.11-13.42-1.11-13.42-.32.02-1.19.23-1.19.23zm8.299 2.27s-.49-1.8-2.44-2.28c0 0-.57-.14-1.17-.22 0 0-2.18 2.81-1.12 13.43.01.07.06.08.06.08.07.03.1-.03.1-.03.72-1.03 3.9-5.76 4.55-8.64 0 0 .36-1.4.02-2.34zm-2.92 13.07s-.07 0-.09.05c0 0-.01.07.03.1.7.51 2.85 2 3.88 2.3 0 0 .16.05.43.06h.14c.69-.02 1.9-.37 3-2.26l-7.4-.25zm7.83-8.41c.14-2.06-1.94-3.97-1.94-3.98 0 0-3.85 4.66-6.67 10.8 0 0-.03.08.02.13l.04.01h.06c1.06-.53 5.46-2.77 7.28-4.54 0 0 1.15-.93 1.21-2.42zm1.52 2.14s-6.28 3.37-9.52 5.55c0 0-.05.04-.03.11 0 0 .03.06.07.06 1.16 0 5.56 0 5.67-.02 0 0 .57-.02 1.27-.29 0 0 1.56-.5 2.37-2.27 0 0 .73-1.45.17-3.14z"},"lenovo":{"t":"Lenovo","h":"E2231A","p":"M21.044 12.288c0 .5-.343.867-.815.867-.464 0-.827-.38-.827-.867 0-.51.343-.868.815-.868.464 0 .827.381.827.868zm-14.305-.92a.787.787 0 0 0-.651.307.991.991 0 0 0-.172.738l1.479-.614a.708.708 0 0 0-.656-.43zm6.963.052c-.472 0-.816.358-.816.868 0 .486.364.867.828.867.472 0 .815-.368.815-.867 0-.487-.363-.868-.827-.868zM24 7.997v8.006H0V7.997h24zM5.01 13.05H3.088V9.825H2.23v4.003h2.78v-.777zm1.137-.094l2.163-.897a1.667 1.667 0 0 0-.37-.86c-.284-.33-.704-.505-1.216-.505-.931 0-1.633.686-1.633 1.593 0 .93.704 1.593 1.726 1.593.572 0 1.158-.272 1.432-.589l-.535-.411c-.357.264-.56.326-.885.326-.292 0-.52-.09-.682-.25zm5.57-1.039c0-.709-.507-1.223-1.252-1.223a1.28 1.28 0 0 0-1.005.494v-.442h-.846v3.081h.846v-1.753c0-.316.245-.651.698-.651.35 0 .712.243.712.651v1.753h.847v-1.91zm3.647.37c0-.904-.725-1.593-1.65-1.593-.933 0-1.663.7-1.663 1.593 0 .903.726 1.592 1.651 1.592.932 0 1.662-.7 1.662-1.592zm2.066 1.54l1.268-3.081h-.967l-.765 2.099-.765-2.1h-.966l1.268 3.081h.927zm4.449-1.54c0-.904-.725-1.593-1.65-1.593-.932 0-1.662.7-1.662 1.593 0 .903.725 1.592 1.65 1.592.932 0 1.662-.7 1.662-1.592z"},"motorola":{"t":"Motorola","h":"E1140A","p":"M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12C24.002 5.375 18.632.002 12.007 0H12zm7.327 18.065s-.581-2.627-1.528-4.197c-.514-.857-1.308-1.553-2.368-1.532-.745 0-1.399.423-2.2 1.553-.469.77-.882 1.573-1.235 2.403 0 0-.29-.675-.63-1.343a8.038 8.038 0 0 0-.605-1.049c-.804-1.13-1.455-1.539-2.2-1.553-1.049-.021-1.854.675-2.364 1.528-.948 1.574-1.528 4.197-1.528 4.197h-.864l4.606-15.12 3.56 11.804.024.021.024-.021 3.56-11.804 4.61 15.113h-.862z"},"nokia":{"t":"Nokia","h":"005AFF","p":"M16.59 9.348v5.304h.796V9.348Zm-8.497-.09c-1.55 0-2.752 1.127-2.752 2.742 0 1.687 1.202 2.742 2.752 2.742 1.55 0 2.754-1.055 2.751-2.742a2.72 2.72 0 0 0-2.751-2.742ZM10.05 12c0 1.195-.876 1.987-1.957 1.987-1.082 0-1.958-.792-1.958-1.987 0-1.174.876-1.987 1.958-1.987 1.08 0 1.957.813 1.957 1.987zM0 9.176v5.476h.812v-3.619l4.218 3.79v-1.135zM11.442 12l2.952 2.652h1.184L12.622 12l2.956-2.652h-1.184ZM24 14.652h-.875l-.64-1.175h-2.898l-.64 1.175h-.875l1.06-1.958h2.937l-1.465-2.72.432-.798Z"},"oneplus":{"t":"OnePlus","h":"F5010C","p":"M0 3.74V24h20.26V12.428h-2.256v9.317H2.254V5.995h9.318V3.742zM18.004 0v3.74h-3.758v2.256h3.758v3.758h2.255V5.996H24V3.74h-3.758V0zm-6.45 18.756V8.862H9.562c0 .682-.228 1.189-.577 1.504-.367.297-.91.437-1.556.437h-.245v1.625h2.133v6.31h2.237z"},"oppo":{"t":"OPPO","h":"2D683D","p":"M2.85 12.786h-.001C1.639 12.774.858 12.2.858 11.321s.781-1.452 1.99-1.465c1.21.013 1.992.588 1.992 1.465s-.782 1.453-1.99 1.465zm.034-3.638h-.073C1.156 9.175 0 10.068 0 11.32s1.156 2.147 2.811 2.174h.073c1.655-.027 2.811-.921 2.811-2.174S4.54 9.175 2.885 9.148zm18.27 3.638c-1.21-.012-1.992-.587-1.992-1.465s.782-1.452 1.991-1.465c1.21.013 1.991.588 1.991 1.465s-.781 1.453-1.99 1.465zm.035-3.638h-.073c-1.655.027-2.811.92-2.811 2.173s1.156 2.147 2.81 2.174h.074C22.844 13.468 24 12.574 24 11.32s-1.156-2.146-2.811-2.173zm-6.126 3.638c-1.21-.012-1.99-.587-1.99-1.465s.78-1.452 1.99-1.465c1.21.013 1.991.588 1.991 1.465s-.781 1.453-1.99 1.465zm.036-3.638h-.073c-.789.013-1.464.222-1.955.574v-.37h-.857v5.5h.857v-1.931c.49.351 1.166.56 1.954.574h.074c1.655-.027 2.81-.921 2.81-2.174s-1.155-2.146-2.81-2.173zm-6.144 3.638c-1.21-.012-1.99-.587-1.99-1.465s.78-1.452 1.99-1.465c1.21.013 1.991.588 1.991 1.465s-.781 1.453-1.99 1.465zm.037-3.638H8.92c-.789.013-1.464.222-1.955.574v-.37h-.856v5.5h.856v-1.931c.491.351 1.166.56 1.955.574a3.728 3.728 0 0 0 .073 0c1.655-.027 2.811-.921 2.811-2.174s-1.156-2.146-2.81-2.173z"},"samsung":{"t":"Samsung","h":"1428A0","p":"M19.8166 10.2808l.0459 2.6934h-.023l-.7793-2.6934h-1.2837v3.3925h.8481l-.0458-2.785h.023l.8366 2.785h1.2264v-3.3925zm-16.149 0l-.6418 3.427h.9284l.4699-3.1175h.0229l.4585 3.1174h.9169l-.6304-3.4269zm5.1805 0l-.424 2.6132h-.023l-.424-2.6132H6.5788l-.0688 3.427h.8596l.023-3.0832h.0114l.573 3.0831h.8711l.5731-3.083h.023l.0228 3.083h.8596l-.0802-3.4269zm-7.2664 2.4527c.0343.0802.0229.1949.0114.2522-.0229.1146-.1031.2292-.3324.2292-.2177 0-.3438-.126-.3438-.3095v-.3323H0v.2636c0 .7679.6074.9971 1.2493.9971.6189 0 1.1346-.2178 1.2149-.7794.0458-.298.0114-.4928 0-.5616-.1605-.722-1.467-.9283-1.5588-1.3295-.0114-.0688-.0114-.1375 0-.1834.023-.1146.1032-.2292.3095-.2292.2063 0 .321.126.321.3095v.2063h.8595v-.2407c0-.745-.6762-.8596-1.1576-.8596-.6074 0-1.1117.2063-1.2034.7564-.023.149-.0344.2866.0114.4585.1376.7106 1.364.9169 1.5358 1.3524m11.152 0c.0343.0803.0228.1834.0114.2522-.023.1146-.1032.2292-.3324.2292-.2178 0-.3438-.126-.3438-.3095v-.3323h-.917v.2636c0 .7564.596.9857 1.2379.9857.6189 0 1.1232-.2063 1.2034-.7794.0459-.298.0115-.4814 0-.5616-.1375-.7106-1.4327-.9284-1.5243-1.318-.0115-.0688-.0115-.1376 0-.1835.0229-.1146.1031-.2292.3094-.2292.1948 0 .321.126.321.3095v.2063h.848v-.2407c0-.745-.6647-.8596-1.146-.8596-.6075 0-1.1004.1948-1.192.7564-.023.149-.023.2866.0114.4585.1376.7106 1.341.9054 1.513 1.3524m2.8882.4585c.2407 0 .3094-.1605.3323-.2522.0115-.0343.0115-.0917.0115-.126v-2.533h.871v2.4642c0 .0688 0 .1948-.0114.2292-.0573.6419-.5616.8482-1.192.8482-.6303 0-1.1346-.2063-1.192-.8482 0-.0344-.0114-.1604-.0114-.2292v-2.4642h.871v2.533c0 .0458 0 .0916.0115.126 0 .0917.0688.2522.3095.2522m7.1518-.0344c.2522 0 .3324-.1605.3553-.2522.0115-.0343.0115-.0917.0115-.126v-.4929h-.3553v-.5043H24v.917c0 .0687 0 .1145-.0115.2292-.0573.6303-.596.8481-1.2034.8481-.6075 0-1.1461-.2178-1.2034-.8481-.0115-.1147-.0115-.1605-.0115-.2293v-1.444c0-.0574.0115-.172.0115-.2293.0802-.6419.596-.8482 1.2034-.8482s1.1347.2063 1.2034.8482c.0115.1031.0115.2292.0115.2292v.1146h-.8596v-.1948s0-.0803-.0115-.1261c-.0114-.0802-.0802-.2521-.3438-.2521-.2521 0-.321.1604-.3438.2521-.0115.0458-.0115.1032-.0115.1605v1.5702c0 .0458 0 .0916.0115.126 0 .0917.0917.2522.3323.2522"},"vivo":{"t":"vivo","h":"415FFF","p":"M19.604 14.101c-1.159 0-1.262-.95-1.262-1.24 0-.29.103-1.242 1.262-1.242h2.062c1.16 0 1.263.951 1.263 1.242 0 .29-.104 1.24-1.263 1.24m-2.062-3.527c-2.142 0-2.333 1.752-2.333 2.287 0 .535.19 2.286 2.333 2.286h2.062c2.143 0 2.334-1.751 2.334-2.286 0-.535-.19-2.287-2.334-2.287m-5.477.107c-.286 0-.345.05-.456.213-.11.164-2.022 3.082-2.022 3.082-.06.09-.126.126-.206.126-.08 0-.145-.036-.206-.126 0 0-1.912-2.918-2.022-3.082-.11-.164-.17-.213-.456-.213h-.668c-.154 0-.224.12-.127.267l2.283 3.467c.354.521.614.732 1.196.732s.842-.21 1.196-.732l2.284-3.467c.096-.146.026-.267-.128-.267m-8.876.284c0-.203.08-.284.283-.284h.505c.203 0 .283.08.283.283v3.9c0 .202-.08.283-.283.283h-.505c-.203 0-.283-.08-.283-.283zm-1.769-.285c-.287 0-.346.05-.456.213-.11.164-2.022 3.082-2.022 3.082-.061.09-.126.126-.206.126-.08 0-.145-.036-.206-.126 0 0-1.912-2.918-2.023-3.082-.11-.164-.169-.213-.455-.213H.175c-.171 0-.224.12-.127.267l2.283 3.467c.355.521.615.732 1.197.732.582 0 .842-.21 1.196-.732l2.283-3.467c.097-.146.044-.267-.127-.267m1.055-.893c-.165-.164-.165-.295 0-.46l.351-.351c.165-.165.296-.165.46 0l.352.351c.165.165.165.296 0 .46l-.352.352c-.164.165-.295.165-.46 0z"},"xiaomi":{"t":"Xiaomi","h":"FF6900","p":"M12 0C8.016 0 4.756.255 2.493 2.516.23 4.776 0 8.033 0 12.012c0 3.98.23 7.235 2.494 9.497C4.757 23.77 8.017 24 12 24c3.983 0 7.243-.23 9.506-2.491C23.77 19.247 24 15.99 24 12.012c0-3.984-.233-7.243-2.502-9.504C19.234.252 15.978 0 12 0zM4.906 7.405h5.624c1.47 0 3.007.068 3.764.827.746.746.827 2.233.83 3.676v4.54a.15.15 0 0 1-.152.147h-1.947a.15.15 0 0 1-.152-.148V11.83c-.002-.806-.048-1.634-.464-2.051-.358-.36-1.026-.441-1.72-.458H7.158a.15.15 0 0 0-.151.147v6.98a.15.15 0 0 1-.152.148H4.906a.15.15 0 0 1-.15-.148V7.554a.15.15 0 0 1 .15-.149zm12.131 0h1.949a.15.15 0 0 1 .15.15v8.892a.15.15 0 0 1-.15.148h-1.949a.15.15 0 0 1-.151-.148V7.554a.15.15 0 0 1 .151-.149zM8.92 10.948h2.046c.083 0 .15.066.15.147v5.352a.15.15 0 0 1-.15.148H8.92a.15.15 0 0 1-.152-.148v-5.352a.15.15 0 0 1 .152-.147Z"},"sony":{"t":"Sony","h":"1A1A1A","p":"M8.5505 9.8881c.921 0 1.6574.2303 2.2209.7423.3848.3485.5999.8454.5939 1.3665a1.9081 1.9081 0 0 1-.5939 1.3726c-.5272.4848-1.3483.7423-2.221.7423-.8725 0-1.6785-.2575-2.2148-.7423-.3908-.3485-.609-.8484-.603-1.3726 0-.518.2182-1.015.603-1.3665.5-.4545 1.3847-.7423 2.2149-.7423zm.003 3.6692c.4606 0 .8878-.1606 1.1878-.4575.2999-.2999.4332-.6605.4332-1.1029 0-.4242-.1484-.821-.4333-1.1029-.2938-.2908-.7332-.4545-1.1877-.4545s-.8938.1637-1.1907.4545c-.2848.2818-.4333.6787-.4333 1.103-.006.409.1485.806.4333 1.1029.2969.2939.7332.4575 1.1907.4575zm-4.8418-1.9665c.1605.0424.315.094.4666.1636a1.352 1.352 0 0 1 .3787.2576c.197.206.309.4817.306.7665a.9643.9643 0 0 1-.3787.7788 2.0662 2.0662 0 0 1-.709.3485 3.7231 3.7231 0 0 1-1.1938.1697c-.352 0-.5467-.0406-.8138-.0962l-.077-.016c-.294-.0666-.5817-.1575-.8575-.2787a.0695.0695 0 0 0-.0424-.0121c-.0454 0-.0818.0394-.0818.0848v.203H.1212v-1.4786h.5242a.7559.7559 0 0 0 .1363.418c.2121.2607.4394.3607.6575.4395.3666.1212.7514.1848 1.1362.1969.5526 0 .8756-.134.9455-.163l.009-.0037.0062-.0023c.0616-.0226.3119-.1143.3119-.3916 0-.2743-.2338-.334-.387-.373l-.022-.0058c-.1708-.046-.562-.0872-.9897-.1323l-.1526-.016c-.4848-.0515-.9696-.1273-1.1968-.1758-.4977-.1097-.6942-.2917-.816-.4045l-.0082-.0076A1.0192 1.0192 0 0 1 0 11.1608c0-.497.3394-.797.7575-.9817.4454-.2.9756-.288 1.4392-.288.8211.0031 1.4877.2697 1.727.394.097.0515.1455-.0121.1455-.0606v-.1484h.5272v1.2876h-.4727a.9056.9056 0 0 0-.2939-.4909 1.289 1.289 0 0 0-.297-.1787c-.3968-.1667-.821-.2515-1.2513-.2455-.4423 0-.8665.085-1.0786.2153-.1333.0818-.2.1848-.2.306 0 .1727.1454.2424.2182.2636.1967.0597.6328.103.972.1369.0736.0073.1426.0142.2036.0206.3272.0334 1.012.1243 1.315.2zm18.1673-.9966v-.4787H24v.4696h-.4757c-.1727 0-.2424.0334-.3727.1788l-1.4271 1.63a.098.098 0 0 0-.0182.0698v.7423a1.106 1.106 0 0 0 .0121.103.1496.1496 0 0 0 .1.0909.9368.9368 0 0 0 .1303.009h.4848v.4698h-2.5724v-.4697h.4606a.9343.9343 0 0 0 .1302-.0091.1627.1627 0 0 0 .1031-.091.5626.5626 0 0 0 .009-.1v-.7422c0-.0242 0-.0242-.0333-.0636a606.7592 606.7592 0 0 0-1.4119-1.6028c-.0758-.0788-.2061-.2061-.406-.2061h-.4576v-.4696h2.5876v.4696h-.3121c-.0697 0-.1182.0697-.0576.1455 0 0 .8696 1.0392.8787 1.0513.0091.0122.0152.0122.0273.003.0121-.009.8938-1.0453.8999-1.0543a.0912.0912 0 0 0-.0182-.1273.1095.1095 0 0 0-.0606-.0182zm-6.284-.0031h.4848c.2212 0 .2606.0848.2636.2909l.0273 1.5664-2.5815-2.324H11.944v.4697h.412c.297 0 .3182.1636.3182.309v2.2138c.0004.1285.0009.295-.1818.295h-.506v.4667h2.1634v-.4697h-.5273c-.212 0-.2211-.097-.2242-.303v-1.8816l2.9724 2.6511h.7575l-.0394-2.9966c.003-.218.0182-.2908.2424-.2908h.4726v-.4697H15.595Z","adj":true},"lg":{"t":"LG","h":"A50034","p":"M14.522 14.078h3.27v1.33h-4.847v-6.83h1.577v5.5zm6.74-1.274h1.284v1.195c-.236.09-.698.18-1.137.18-1.42 0-1.893-.721-1.893-2.186 0-1.398.45-2.221 1.869-2.221.791 0 1.24.248 1.612.722l.982-.903c-.6-.855-1.646-1.114-2.629-1.114-2.208 0-3.368 1.205-3.368 3.504 0 2.288 1.047 3.528 3.358 3.528 1.06 0 2.096-.27 2.66-.665V11.53h-2.739v1.274zM5.291 6.709a5.29 5.29 0 1 1 0 10.582 5.291 5.291 0 1 1 0-10.582m3.16 8.457a4.445 4.445 0 0 0 1.31-3.161v-.242l-.22.001H6.596v.494h2.662l-.001.015a3.985 3.985 0 0 1-3.965 3.708 3.95 3.95 0 0 1-2.811-1.165 3.952 3.952 0 0 1-1.164-2.811c0-1.061.414-2.059 1.164-2.81a3.951 3.951 0 0 1 2.81-1.164l.252.003v-.495l-.251-.003a4.475 4.475 0 0 0-4.47 4.469c0 1.194.465 2.316 1.309 3.161a4.444 4.444 0 0 0 3.16 1.31 4.444 4.444 0 0 0 3.162-1.31m-2.91-1.297V9.644H5.04v4.72h1.556v-.495H5.543zm-1.265-3.552a.676.676 0 1 0-.675.674.676.676 0 0 0 .675-.674"},"htc":{"t":"HTC","h":"A5CF4C","p":"M22 14.75h-2.8c-.7-.05-1.15-.5-1.2-1.15v-1.15c.05-.65.6-1.25 1.2-1.25H24V9.95h-4.85c-.65.05-1.25.25-1.7.7-.4.4-.65 1.1-.7 1.75 0 .35-.05.85 0 1.15.05.75.3 1.3.7 1.7.4.45 1.05.7 1.7.7H24V14.7c0 .05-1.3.05-2 .05M8.5 10v1.25h2.95v4.7h1.25v-4.7h2.95V10Zm-1.3 2.35c0-.65-.25-1.25-.7-1.7-.5-.5-1.2-.7-1.7-.7H2.35c-.55 0-.95.2-1.15.35V8H0v8h1.25v-3.6c.05-.65.55-1.15 1.15-1.2.5-.05 1.95-.05 2.4 0 .65.05 1.1.55 1.15 1.2V16H7.2z"}};

  /* No official CC0 mark available — these render a full wordmark instead. */
  SM.brandMarksReview = ["coolpad","hmd","infinix","itel","lava","nothing","realme","tecno","zte"];

  SM.brandMarksMeta = {"source":"simple-icons (CC0-1.0)","version":null,"generated":"2026-09-05T09:10:39.879Z","adjusted":["sony"]};
})(window);

/* === src/data/countries.js === */;
/* ============================================================================
   Mobile Parts Finder · countries.js
   Full ISO-3166 country list with dialling codes. Flags are derived from the
   ISO alpha-2 code (regional indicator letters), so no image assets and no
   per-country hardcoding.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  /* code:name:dial — packed to keep the payload small */
  var PACKED =
    'AF:Afghanistan:93,AL:Albania:355,DZ:Algeria:213,AD:Andorra:376,AO:Angola:244,' +
    'AG:Antigua and Barbuda:1268,AR:Argentina:54,AM:Armenia:374,AU:Australia:61,AT:Austria:43,' +
    'AZ:Azerbaijan:994,BS:Bahamas:1242,BH:Bahrain:973,BD:Bangladesh:880,BB:Barbados:1246,' +
    'BY:Belarus:375,BE:Belgium:32,BZ:Belize:501,BJ:Benin:229,BT:Bhutan:975,BO:Bolivia:591,' +
    'BA:Bosnia and Herzegovina:387,BW:Botswana:267,BR:Brazil:55,BN:Brunei:673,BG:Bulgaria:359,' +
    'BF:Burkina Faso:226,BI:Burundi:257,KH:Cambodia:855,CM:Cameroon:237,CA:Canada:1,' +
    'CV:Cape Verde:238,CF:Central African Republic:236,TD:Chad:235,CL:Chile:56,CN:China:86,' +
    'CO:Colombia:57,KM:Comoros:269,CG:Congo:242,CD:Congo (DRC):243,CR:Costa Rica:506,' +
    'CI:Cote d Ivoire:225,HR:Croatia:385,CU:Cuba:53,CY:Cyprus:357,CZ:Czechia:420,DK:Denmark:45,' +
    'DJ:Djibouti:253,DM:Dominica:1767,DO:Dominican Republic:1809,EC:Ecuador:593,EG:Egypt:20,' +
    'SV:El Salvador:503,GQ:Equatorial Guinea:240,ER:Eritrea:291,EE:Estonia:372,SZ:Eswatini:268,' +
    'ET:Ethiopia:251,FJ:Fiji:679,FI:Finland:358,FR:France:33,GA:Gabon:241,GM:Gambia:220,' +
    'GE:Georgia:995,DE:Germany:49,GH:Ghana:233,GR:Greece:30,GD:Grenada:1473,GT:Guatemala:502,' +
    'GN:Guinea:224,GW:Guinea-Bissau:245,GY:Guyana:592,HT:Haiti:509,HN:Honduras:504,' +
    'HK:Hong Kong:852,HU:Hungary:36,IS:Iceland:354,IN:India:91,ID:Indonesia:62,IR:Iran:98,' +
    'IQ:Iraq:964,IE:Ireland:353,IL:Israel:972,IT:Italy:39,JM:Jamaica:1876,JP:Japan:81,' +
    'JO:Jordan:962,KZ:Kazakhstan:7,KE:Kenya:254,KI:Kiribati:686,KW:Kuwait:965,' +
    'KG:Kyrgyzstan:996,LA:Laos:856,LV:Latvia:371,LB:Lebanon:961,LS:Lesotho:266,LR:Liberia:231,' +
    'LY:Libya:218,LI:Liechtenstein:423,LT:Lithuania:370,LU:Luxembourg:352,MO:Macau:853,' +
    'MG:Madagascar:261,MW:Malawi:265,MY:Malaysia:60,MV:Maldives:960,ML:Mali:223,MT:Malta:356,' +
    'MH:Marshall Islands:692,MR:Mauritania:222,MU:Mauritius:230,MX:Mexico:52,' +
    'FM:Micronesia:691,MD:Moldova:373,MC:Monaco:377,MN:Mongolia:976,ME:Montenegro:382,' +
    'MA:Morocco:212,MZ:Mozambique:258,MM:Myanmar:95,NA:Namibia:264,NR:Nauru:674,NP:Nepal:977,' +
    'NL:Netherlands:31,NZ:New Zealand:64,NI:Nicaragua:505,NE:Niger:227,NG:Nigeria:234,' +
    'KP:North Korea:850,MK:North Macedonia:389,NO:Norway:47,OM:Oman:968,PK:Pakistan:92,' +
    'PW:Palau:680,PS:Palestine:970,PA:Panama:507,PG:Papua New Guinea:675,PY:Paraguay:595,' +
    'PE:Peru:51,PH:Philippines:63,PL:Poland:48,PT:Portugal:351,QA:Qatar:974,RO:Romania:40,' +
    'RU:Russia:7,RW:Rwanda:250,KN:Saint Kitts and Nevis:1869,LC:Saint Lucia:1758,' +
    'VC:Saint Vincent and the Grenadines:1784,WS:Samoa:685,SM:San Marino:378,' +
    'ST:Sao Tome and Principe:239,SA:Saudi Arabia:966,SN:Senegal:221,RS:Serbia:381,' +
    'SC:Seychelles:248,SL:Sierra Leone:232,SG:Singapore:65,SK:Slovakia:421,SI:Slovenia:386,' +
    'SB:Solomon Islands:677,SO:Somalia:252,ZA:South Africa:27,KR:South Korea:82,' +
    'SS:South Sudan:211,ES:Spain:34,LK:Sri Lanka:94,SD:Sudan:249,SR:Suriname:597,' +
    'SE:Sweden:46,CH:Switzerland:41,SY:Syria:963,TW:Taiwan:886,TJ:Tajikistan:992,' +
    'TZ:Tanzania:255,TH:Thailand:66,TL:Timor-Leste:670,TG:Togo:228,TO:Tonga:676,' +
    'TT:Trinidad and Tobago:1868,TN:Tunisia:216,TR:Turkiye:90,TM:Turkmenistan:993,' +
    'TV:Tuvalu:688,UG:Uganda:256,UA:Ukraine:380,AE:United Arab Emirates:971,' +
    'GB:United Kingdom:44,US:United States:1,UY:Uruguay:598,UZ:Uzbekistan:998,' +
    'VU:Vanuatu:678,VA:Vatican City:379,VE:Venezuela:58,VN:Vietnam:84,YE:Yemen:967,' +
    'ZM:Zambia:260,ZW:Zimbabwe:263';

  function flagOf(code) {
    return String.fromCodePoint.apply(String, code.toUpperCase().split('').map(function (c) {
      return 0x1F1E6 + c.charCodeAt(0) - 65;
    }));
  }

  var LIST = PACKED.split(',').map(function (row) {
    var p = row.split(':');
    return {
      code: p[0],
      name: p[1],
      dial: '+' + p[2],
      flag: flagOf(p[0]),
      search: (p[0] + ' ' + p[1] + ' +' + p[2]).toLowerCase()
    };
  }).sort(function (a, b) { return a.name.localeCompare(b.name); });

  var BY_CODE = Object.create(null);
  LIST.forEach(function (c) { BY_CODE[c.code] = c; });

  /* ------------------------------------------------------- phone validation

     A mobile number is only valid RELATIVE TO A COUNTRY. This used to be one
     regex — six to fourteen digits, country ignored — which is wrong in both
     directions: it accepted 8608979020 as a United States number and it had no
     opinion at all about Singapore's eight digits or the UAE's nine.

     libphonenumber-js carries Google's own per-country metadata, so the rules
     come from the same source every telecom uses rather than from a list of
     digit counts someone guessed and nobody maintains.

     IT IS LOADED LAZILY AND IS NEVER REQUIRED. Most visits never open the
     sign-up form, it is ~175 KB, and — more importantly — a sign-up must not
     become impossible because a CDN is slow or blocked. Until it arrives, and
     for ever if it never does, the fallback below applies the only rule that
     holds everywhere: E.164 allows at most 15 digits including the country
     code, and no national number is shorter than four. That is permissive on
     purpose. Refusing a real shop's real number is a worse failure than
     accepting a typo the payment gateway will reject a moment later. */

  var LIB_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/libphonenumber-js/1.11.4/libphonenumber-js.min.js';
  var libLoad = null;
  var lib = null;
  var libListeners = [];

  function digitsOf(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

  function loadValidator() {
    if (lib) return Promise.resolve(lib);
    if (libLoad) return libLoad;
    if (typeof document === 'undefined') return Promise.resolve(null);

    libLoad = new Promise(function (resolve) {
      var el = document.createElement('script');
      el.src = LIB_SRC;
      el.async = true;
      el.onload = function () {
        lib = global.libphonenumber || null;
        resolve(lib);
        /* Validation just got stricter than it was a moment ago, so anything
           showing a validity state needs to look again. */
        var waiting = libListeners; libListeners = [];
        waiting.forEach(function (fn) { try { fn(lib); } catch (e) { /* never break a form */ } });
      };
      el.onerror = function () {
        libLoad = null;                       /* a later attempt may succeed */
        resolve(null);                        /* NOT a rejection: the fallback stands */
      };
      document.head.appendChild(el);
    });
    return libLoad;
  }

  SM.countries = {
    all: LIST,
    byCode: function (code) { return BY_CODE[code] || null; },
    search: function (q) {
      q = (q || '').toLowerCase().trim();
      if (!q) return LIST;
      var starts = [], has = [];
      LIST.forEach(function (c) {
        var n = c.name.toLowerCase();
        if (n.indexOf(q) === 0) starts.push(c);
        else if (c.search.indexOf(q) > -1) has.push(c);
      });
      return starts.concat(has);
    },

    /** Starts the metadata download. Safe to call repeatedly. */
    preloadValidator: loadValidator,

    /** Called once the metadata lands, so a form can re-check what it drew. */
    onValidatorReady: function (fn) {
      if (lib) { fn(lib); return; }
      libListeners.push(fn);
      loadValidator();
    },

    /** True once the real per-country rules are in force. */
    validatorReady: function () { return !!lib; },

    /**
     * Is this a valid mobile number for that country?
     *
     * @param {string} countryCode ISO alpha-2, e.g. "IN"
     * @param {string} input       what the user typed, in national form
     */
    validNumber: function (countryCode, input) {
      var digits = digitsOf(input);
      if (!digits) return false;

      if (lib && countryCode && BY_CODE[countryCode]) {
        try {
          var parsed = lib.parsePhoneNumberFromString(digits, countryCode);
          return !!(parsed && parsed.isValid());
        } catch (e) {
          /* Unknown region or malformed input — fall through to the length
             check rather than failing the form on a library edge case. */
        }
      }
      return digits.length >= 4 && digits.length <= 15;
    },

    /**
     * The number in E.164, or '' when it cannot be formed.
     * Falls back to dial code + digits, which is what E.164 is.
     */
    toE164: function (countryCode, input) {
      var digits = digitsOf(input);
      if (!digits) return '';

      if (lib && countryCode && BY_CODE[countryCode]) {
        try {
          var parsed = lib.parsePhoneNumberFromString(digits, countryCode);
          if (parsed && parsed.number) return parsed.number;
        } catch (e) { /* fall through */ }
      }
      var c = BY_CODE[countryCode];
      return c && c.dial ? '+' + digitsOf(c.dial) + digits : '';
    },

    /** Digits only, as typed — what gets stored as the national number. */
    nationalDigits: digitsOf
  };
})(window);

/* === src/data/firebase.js === */;
/* ============================================================================
   Mobile Parts Finder · firebase.js — real Firebase Authentication
   ----------------------------------------------------------------------------
   Identity for the billing system. Every call to /api/* that can move money or
   grant access carries a Firebase ID token from here, and the server decides
   who the caller is by verifying it. A uid sent in a request body would be a
   free subscription for anyone who can open dev tools, so this is the only way
   the app names a user.

   CONFIGURATION
     Nothing is hardcoded here. The config comes from /api/firebase-config,
     which reads it from the Vercel environment:

       FIREBASE_PROJECT_ID       mobilepartsfindercom
       FIREBASE_API_KEY
       FIREBASE_APP_ID
       FIREBASE_MESSAGING_SENDER_ID    (optional)
       FIREBASE_STORAGE_BUCKET         (derived from the project id if unset)
       FIREBASE_MEASUREMENT_ID         (optional)

     Values come from
       Firebase console -> Project settings -> General -> Your apps -> SDK setup

     They are PUBLIC by design: they identify the project to the browser and
     the SDK cannot reach it without them. What protects the data is Firestore
     rules and the authorised-domain list, not secrecy. The service-account
     key — the dangerous one — stays on the server and never appears here.

     Also add www.mobilepartsfinder.com under
       Authentication -> Settings -> Authorised domains
     or the Google popup closes immediately with auth/unauthorized-domain.

   SIGN-IN USES A POPUP, INCLUDING ON PHONES
     The redirect flow keeps its pending state in storage belonging to
     `authDomain` — a different origin from the site — and mobile browsers
     partition or discard that. The user picked their Google account, came
     back, and the app found no session: the bounce-to-login bug. A popup never
     leaves the page, so nothing has to survive the trip. Redirect remains the
     fallback for browsers that cannot open one, and its result is now awaited
     during initialisation rather than raced.

     To make redirect same-origin as well, set FIREBASE_AUTH_DOMAIN to the
     site's own host. vercel.json proxies /__/auth/* to the Firebase auth
     domain, which is what makes that work. It is optional; the popup path does
     not need it.

   UNCONFIGURED IS A STATE, NOT A CRASH
     With the config blank, isConfigured() returns false and the UI says so
     plainly. It does not fall back to a fake sign-in: a pretend identity would
     let the app show a subscription that no payment backs.

   The SDK is loaded on first use rather than on page load — most visits never
   sign in, and it is ~200 KB they should not have to pay for.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  /* ------------------------------------------------------------------ config
     Fetched from /api/firebase-config, which reads it from the Vercel
     environment. Nothing is hardcoded here.

     Being plain about what this is: the Firebase web config is NOT a secret.
     Every value in it ships to every visitor by design — the SDK cannot reach
     the project without it, and `apiKey` is a project identifier rather than a
     credential. Keeping it in the environment means one place to change and
     nothing to edit in source; what actually protects the data is Firestore
     Security Rules and the authorised-domain list.

     The genuinely dangerous credential is the service-account key the billing
     functions use. That never leaves the server. */
  var config = null;
  var configLoad = null;
  var configState = { checked: false, configured: false, missing: [] };

  function loadConfig() {
    if (configLoad) return configLoad;
    configLoad = fetch('/api/firebase-config')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        configState.checked = true;
        configState.configured = !!d.configured;
        configState.missing = d.missing || [];
        if (d.configured) config = d.config;
        return config;
      })
      .catch(function (err) {
        /* A failed fetch is "not configured", not a crash: the rest of the
           site — catalogue, search, browsing — works without Firebase, and
           should not go down because sign-in is unavailable. */
        configState.checked = true;
        configState.configured = false;
        configState.missing = ['/api/firebase-config unreachable'];
        console.warn('[firebase] config unavailable:', err && err.message);
        return null;
      });
    return configLoad;
  }

  var SDK_VERSION = '10.14.1';
  var SDK = [
    'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/firebase-auth-compat.js'
  ];

  var loading = null;
  var listeners = [];
  var currentUser = null;

  /* ------------------------------------------------------------- auth phase

     Three states, and every screen must respect them:

        'loading'         Firebase has not answered yet. NOT the same as signed
                          out, and treating it as signed out is the entire
                          mobile bug: the page painted the sign-in form while a
                          perfectly good session was still being restored, and
                          the user read that as "it sent me back to login".
        'authenticated'   a user is present
        'unauthenticated' Firebase has answered, and there is nobody

     Nothing may make a protected-route decision while this says 'loading'. */
  var phase = 'loading';
  var phaseWaiters = [];

  function setPhase(next) {
    if (phase === next) return;
    phase = next;
    SM.debug.log('auth', 'phase -> ' + next, currentUser ? { uid: currentUser.uid } : undefined);
    var waiting = phaseWaiters;
    phaseWaiters = [];
    waiting.forEach(function (fn) { try { fn(currentUser); } catch (e) { /* never break auth */ } });
  }

  /* Nothing is announced — not the phase, not a listener callback — until
     initialisation has checked for a pending redirect result.

     Without this hold, a compat SDK that reports "no user" before it has
     processed the return from Google publishes a signed-out state one tick
     before the real one, and every screen listening has already repainted as
     signed out. On a phone that IS the bug: choose the account, come back,
     read "Sign in to Mobile Parts Finder". */
  var initSettled = false;

  /* The Google sign-in currently open, if any. Module scope on purpose: it has
     to outlive every re-render of every button that can start one. See
     SM.fb.signIn for why a second concurrent attempt is what Google answers
     with a 401. */
  var signInFlight = null;

  /* Result of the redirect sign-in that brought this page load into existence,
     if there was one. Kept so the app can tell "came back from Google with a
     user" apart from "was already signed in" — and so a redirect that failed
     can say why instead of silently looking like a sign-out. */
  var redirectOutcome = { checked: false, user: null, error: null };

  /* Synchronous, so every existing caller keeps working. It answers from the
     config already fetched at boot; before that it is honestly false. */
  function isConfigured() {
    return !!(config && config.apiKey && config.projectId);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  /* Loads the SDK once and wires the auth listener. Repeat calls share the
     same promise, so two buttons pressed together do not load it twice. */
  function ready() {
    if (loading) return loading;

    /* One place initialises Firebase, once. Config first, then the SDK, then
       initializeApp — and only if no app exists, because a second
       initializeApp with the same name throws. */
    loading = loadConfig().then(function (cfg) {
      if (!cfg) {
        var e = new Error('firebase-not-configured');
        e.code = 'unconfigured';
        e.missing = configState.missing;
        throw e;
      }
      SM.debug.log('auth', 'config loaded', { projectId: cfg.projectId, authDomain: cfg.authDomain });
      return SDK.reduce(function (chain, src) {
        return chain.then(function () { return loadScript(src); });
      }, Promise.resolve());
    }).then(function () {
      var fb = global.firebase;
      if (!fb) throw new Error('firebase sdk did not load');
      /* Exactly one app, ever. A second initializeApp with the same name
         throws, and two apps would mean two auth states disagreeing. */
      if (!fb.apps.length) fb.initializeApp(config);

      /* Survive a tab close, not just a reload — a shop signs in once at the
         counter and expects to stay signed in. */
      var persisted = Promise.resolve();
      try {
        persisted = fb.auth().setPersistence(fb.auth.Auth.Persistence.LOCAL)
          .catch(function (err) {
            /* Some privacy modes refuse IndexedDB. Session persistence still
               carries the user through this visit, which is far better than
               failing the sign-in outright. */
            SM.debug.warn('auth', 'LOCAL persistence refused, falling back', { code: err && err.code });
            return fb.auth().setPersistence(fb.auth.Auth.Persistence.SESSION).catch(function () {});
          });
      } catch (e) { /* older SDK: persistence is already LOCAL by default */ }

      function announce() {
        setPhase(currentUser ? 'authenticated' : 'unauthenticated');
        listeners.forEach(function (fn) {
          try { fn(currentUser); } catch (e) { /* a listener must not break auth */ }
        });
      }

      /* Resolves the first time Firebase reports an auth state — the moment
         "signed in as X" or "nobody" stops being a guess. */
      var sawFirstState = null;
      var firstState = new Promise(function (resolve) { sawFirstState = resolve; });

      fb.auth().onAuthStateChanged(function (user) {
        currentUser = user || null;
        sawFirstState();
        /* Held, not dropped: the value is kept and announced below the moment
           initialisation finishes. */
        if (initSettled) announce();
      });

      /* A redirect sign-in finishes HERE, on the next page load, not in the
         call that started it — and it is AWAITED, which the previous version
         did not do.

         That omission is what made the phone bounce back to the sign-in page:
         boot raced getRedirectResult, painted "signed out" first because that
         is what the auth state said at that instant, and the arriving user
         never repainted the screen the person was looking at. Waiting for it
         costs one promise and removes the race entirely. */
      return persisted.then(function () {
        return fb.auth().getRedirectResult().then(function (result) {
          redirectOutcome.checked = true;
          redirectOutcome.user = (result && result.user) || null;
          if (redirectOutcome.user) {
            SM.debug.log('auth', 'returned from Google redirect', { uid: redirectOutcome.user.uid });
          } else {
            SM.debug.log('auth', 'no pending redirect result');
          }
        }, function (err) {
          redirectOutcome.checked = true;
          redirectOutcome.error = err || null;
          if (err && err.code && err.code !== 'auth/no-auth-event') {
            SM.debug.warn('auth', 'redirect result failed', { code: err.code, message: err.message });
          }
        });
      }).then(function () {
        /* Both conditions, not one. getRedirectResult already waits on the
           SDK's own initialisation, so the first auth state has normally
           arrived by here — but "normally" is not a guarantee to build a
           sign-in on, and announcing one tick early is the whole bug. The
           timeout is only so a listener that never fires cannot hang ready()
           for ever; whenResolved has its own, longer floor. */
        return Promise.race([
          firstState,
          new Promise(function (r) { setTimeout(r, 8000); })
        ]);
      }).then(function () {
        /* Whatever the auth state is now, it is the real one: any redirect has
           been consumed and currentUser already reflects it. */
        initSettled = true;
        announce();
        return fb;
      });
    }).catch(function (err) {
      loading = null;                       /* let a later attempt retry */
      /* An SDK that never loaded is not "still loading". Leaving the phase at
         'loading' would hang every screen waiting on it for ever. */
      initSettled = true;
      setPhase('unauthenticated');
      SM.debug.warn('auth', 'initialisation failed', { code: err && err.code, message: err && err.message });
      throw err;
    });

    return loading;
  }

  SM.fb = {
    isConfigured: isConfigured,
    /* Read-only view for diagnostics. Never the source of truth — `config` is. */
    configState: configState,
    projectId: function () { return config ? config.projectId : null; },
    loadConfig: loadConfig,
    app: function () { return global.firebase && global.firebase.apps[0]; },
    ready: ready,

    /**
     * Google sign-in.
     *
     * POPUP FIRST, ON EVERY DEVICE. This used to force a redirect on anything
     * with a coarse pointer and a narrow screen, and that is what broke sign-in
     * on phones.
     *
     * The reason is not the redirect itself, it is where the redirect state is
     * kept. `authDomain` is mobilepartsfindercom.firebaseapp.com while the site
     * is on mobilepartsfinder.com, so the SDK parks the pending sign-in in
     * storage belonging to a THIRD-PARTY origin. Mobile Chrome, Safari and
     * anything with third-party storage partitioning discard it. The user picks
     * their Google account, comes back, getRedirectResult() finds nothing, and
     * the app can only conclude they are signed out — which is exactly the
     * reported bug: choose the account, land back on the sign-in page.
     *
     * A popup never leaves the page, so nothing has to survive a navigation and
     * no third-party storage is involved. It opens reliably here because it is
     * called straight out of the button's click handler, which is what browsers
     * require. Redirect stays as the fallback for the cases where a popup
     * genuinely cannot open, and it works properly now that the result is
     * awaited during initialisation.
     *
     * A redirect resolves to null — the real result arrives via
     * getRedirectResult after the page reloads.
     */
    signIn: function () {
      /* ------------------------------------------------ ONE ATTEMPT AT A TIME

         This is the fix for the intermittent 401 from
         accounts.google.com/signin/oauth/v3/consent — "the server cannot
         process the request because it is malformed".

         Nothing here used to stop a second sign-in starting while the first
         was still open. The button's own disabled flag was the only guard, and
         it lives in markup that this screen re-renders: a re-render, a tab
         switch between Sign in and Create account, or simply a double tap on a
         slow phone put a fresh enabled button on screen with a popup already
         waiting behind it.

         What happened next is the bug. The second signInWithPopup made the
         SDK abort the first, and the first rejected with
         auth/cancelled-popup-request — which the old code treated as
         "popups do not work here" and answered by calling signInWithRedirect.
         So the browser navigated the whole page to Google's consent screen
         while a popup was ALREADY there negotiating the same flow, with the
         same client id, from the same session. Two OAuth handshakes, two sets
         of state and nonce, one of them stale by the time Google read it.
         Google rejects that as malformed: 401. It is intermittent because it
         needs the two requests to overlap, which is exactly why it hit the
         owner account hardest — the one that signs in most often, most
         impatiently, and usually already has a Google session to skip through.

         So: one in-flight attempt, shared by every caller. A second press gets
         the SAME promise and starts nothing. The guard is here rather than in
         the UI because it has to survive re-renders, and because there is more
         than one button that reaches it. */
      if (signInFlight) {
        SM.debug.log('auth', 'sign-in already in flight — joining the existing attempt');
        return signInFlight;
      }

      signInFlight = ready().then(function (fb) {
        var provider = new fb.auth.GoogleAuthProvider();
        /* select_account, not consent: the account chooser is what a shared
           counter machine needs, and it is what lets Google show every account
           already signed in to this browser. */
        provider.setCustomParameters({ prompt: 'select_account' });

        SM.debug.log('auth', 'sign-in requested', {
          strategy: 'popup',
          coarse: !!(global.matchMedia && global.matchMedia('(pointer:coarse)').matches),
          width: global.innerWidth
        });

        return fb.auth().signInWithPopup(provider).then(function (result) {
          SM.debug.log('auth', 'popup sign-in succeeded', { uid: result.user && result.user.uid });
          return result.user;
        }, function (err) {
          var code = err && err.code;

          /* The user shut the window. That is an answer, not a fault, and
             falling back to a redirect would drag them somewhere they just
             declined to go. */
          if (code === 'auth/popup-closed-by-user' ||
              code === 'auth/user-cancelled') throw err;

          /* auth/cancelled-popup-request is NOT in the list below any more,
             and that omission is deliberate.

             It does not mean "popups do not work here". It means another
             sign-in request superseded this one — so another attempt is still
             running, and the correct response is to let it finish and say
             nothing. Answering it with a redirect is what put a page-level
             OAuth handshake on top of a live popup one and produced the 401.
             The in-flight guard above should make it unreachable; it is
             handled explicitly anyway, because "should be unreachable" is not
             a reason to leave a trapdoor open. */
          if (code === 'auth/cancelled-popup-request') {
            SM.debug.log('auth', 'popup superseded by another request — deferring to it');
            var superseded = new Error('sign-in already in progress');
            superseded.code = 'auth/cancelled-popup-request';
            throw superseded;
          }

          /* Genuinely popup-shaped failures. Anything else — an unauthorised
             domain, a disabled provider, no network — would fail identically
             after a redirect, and retrying via redirect would replace a clear
             error with a mysterious round trip. */
          if (code === 'auth/popup-blocked' ||
              code === 'auth/operation-not-supported-in-this-environment' ||
              code === 'auth/web-storage-unsupported') {
            SM.debug.warn('auth', 'popup unavailable, falling back to redirect', { code: code });
            return fb.auth().signInWithRedirect(provider).then(function () { return null; });
          }
          SM.debug.warn('auth', 'sign-in failed', { code: code, message: err && err.message });
          throw err;
        });
      });

      /* Released on both paths, so a failed attempt does not lock the button
         out for the life of the page. A redirect resolves to null and the page
         is on its way to Google; releasing there costs nothing because the
         document is about to be replaced. */
      var release = function () { signInFlight = null; };
      signInFlight.then(release, release);
      return signInFlight;
    },

    /** True while a Google sign-in is open. The UI reads it to stay disabled
        across a re-render instead of trusting a DOM flag it just threw away. */
    signInPending: function () { return !!signInFlight; },

    signOut: function () {
      return ready().then(function (fb) { return fb.auth().signOut(); });
    },

    user: function () { return currentUser; },

    /* ------------------------------------------------------------ the owner

       Whether the account signed in right now is the one that owns this
       business and its backend.

       WHAT THIS IS FOR, AND WHAT IT IS NOT

       It decides whether to DRAW the Admin Panel link. That is all it does,
       and it is all a browser is allowed to decide: the panel itself, and
       every /api/admin/* route behind it, re-checks the same address against
       the `email` claim on the verified Firebase ID token — server side, on
       every request, in api/_lib/admin-auth.js.

       So editing this function in the console, or flipping a variable, or
       setting a localStorage key, produces exactly one thing: a button that
       leads to a page which refuses you. There is no state here that unlocks
       anything, because nothing here is asked.

       The address is duplicated between this file and OWNER_EMAIL in
       api/_schema/roles.js. That is deliberate rather than careless — the
       alternative is publishing the owner's email to every visitor through
       /api/firebase-config, and a link that appears one render late while a
       round trip resolves. A test asserts the two stay identical.

       Normalised on both sides: Google returns the address in whatever case
       the account was created with, and Stark.ai.India@gmail.com is the same
       mailbox as stark.ai.india@gmail.com. */
    OWNER_EMAIL: 'Stark.ai.India@gmail.com',

    isOwner: function () {
      var user = currentUser;
      if (!user || !user.email) return false;
      /* emailVerified as well as the address, matching the server. Google
         sign-in always sets it, so this costs the owner nothing. */
      if (user.emailVerified !== true) return false;
      return String(user.email).trim().toLowerCase() ===
             String(SM.fb.OWNER_EMAIL).trim().toLowerCase();
    },

    /**
     * A fresh ID token for the Authorization header.
     *
     * `getIdToken(false)` returns the cached token and refreshes it only when
     * it is close to expiring, so this is cheap to call before every request —
     * which is the point. Holding one token for the life of the page means a
     * long session starts failing with 401s an hour in.
     *
     * @param {boolean} [force]  mint a new token even though the cached one
     *        has not expired. For the one retry after the server has refused a
     *        token — asking for the same cached one again would be refused
     *        again, and the caller would conclude something false about the
     *        account.
     */
    idToken: function (force) {
      return ready().then(function (fb) {
        var u = fb.auth().currentUser;
        if (u) return u.getIdToken(!!force);

        /* currentUser is null until auth has resolved, and restoring a session
           from IndexedDB — or finishing a redirect — takes a moment. The local
           profile says "signed in" the instant the page loads, so a subscriber
           who presses Subscribe straight away would otherwise get a null token
           and a "could not start payment" for a session that is perfectly
           valid. Wait for the real answer instead of guessing. */
        return SM.fb.whenResolved().then(function (user) {
          return user ? user.getIdToken(!!force) : null;
        });
      });
    },

    /** Fires on sign-in, sign-out and token refresh. Returns an unsubscribe. */
    onChange: function (fn) {
      listeners.push(fn);
      if (currentUser) fn(currentUser);
      return function () {
        var i = listeners.indexOf(fn);
        if (i > -1) listeners.splice(i, 1);
      };
    },

    /* ------------------------------------------------------------ auth phase

       What every guard and every screen should ask before deciding anything.
       'loading' is a real answer and means "do not decide yet" — it is not a
       quieter way of saying signed out. */
    phase: function () { return phase; },

    /**
     * Resolves once Firebase has definitively answered, with the user or null.
     *
     * Everything that must not run against a half-restored session waits here:
     * route guards, the account screen, the first profile read. Repeat calls
     * after resolution return immediately, so it is cheap to await anywhere.
     *
     * The timeout is a floor, not a normal path. If the SDK never answers at
     * all — offline behind a captive portal, a blocked gstatic.com — the app
     * must still become usable rather than sit on a spinner for ever. Treating
     * that as signed out is honest: no token can be obtained, so nothing that
     * needs one could work anyway.
     */
    whenResolved: function (timeoutMs) {
      if (phase !== 'loading') return Promise.resolve(currentUser);

      /* Kick initialisation off if nobody has. Its failure path sets the phase,
         so a rejection here still settles the wait below. */
      ready().catch(function () { /* setPhase already ran */ });

      return new Promise(function (resolve) {
        var settled = false;
        var done = function (u) { if (!settled) { settled = true; resolve(u || null); } };
        phaseWaiters.push(done);
        setTimeout(function () {
          if (settled) return;
          SM.debug.warn('auth', 'auth never resolved, treating as signed out', { after: timeoutMs || 12000 });
          setPhase('unauthenticated');
          done(null);
        }, timeoutMs || 12000);
      });
    },

    /**
     * How this page load got its user, when it got one from Google.
     * `{ checked, user, error }` — `checked` is false until initialisation has
     * looked. Used to tell "just came back from the account chooser" apart from
     * "was already signed in", which are the same state and different journeys.
     */
    redirectResult: function () { return redirectOutcome; },

    /** Wakes the SDK so a returning session is restored without a click. */
    restore: function () {
      return this.whenResolved().catch(function () { return null; });
    }
  };
})(window);

/* === src/data/firestore.js === */;
/* ============================================================================
   Mobile Parts Finder · firestore.js — the Firestore read layer
   ----------------------------------------------------------------------------
   The repository between the UI and Cloud Firestore. Screens never touch the
   SDK; they call SM.store, and this decides where an answer comes from.

   ----------------------------------------------------------------------------
   WHAT COMES FROM WHERE, AND WHY

   The catalogue — 4,933 devices, 3,340 groups, brands, categories — is served
   as one CDN file and NOT read from Firestore. That is a deliberate split, not
   leftover mock data:

     · it is the same real export, byte for byte, that the importer writes to
       Firestore; nothing about it is invented
     · browsing and search touch thousands of records. As Firestore reads that
       is thousands of billed operations per session and a network round trip
       per keystroke; as one 211 KB cached file it is zero reads and instant
     · it is public data. Reads that need no permission gain nothing from
       going through a permission system

   Firestore owns what the CDN cannot: anything per-user, anything writable,
   and anything paid.

     users/{uid}                    the signed-in shop's own profile
     subscriptions, payments        billing history, written only by the server
     groupDetails/{groupId}         PAID — part number and member list
     deviceGroups/{deviceId}        PAID — which groups a device belongs to

   The paid collections are closed to unsubscribed clients by the rules in
   firestore.rules, so this layer cannot read them for a visitor even if a bug
   asked it to. The paywall is in the database, not in this file.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  var FIRESTORE_SDK = 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js';
  var dbLoad = null;

  /* ====================================================== EVERY READ EXPIRES

     THE BUG THIS EXISTS TO KILL: "Finishing sign-in..." for ever.

     A Firestore call can fail in a way the SDK never reports. When the Google
     Cloud project itself refuses the API — billing switched off, the API
     disabled, the database deleted — firestore.googleapis.com answers

         403 PERMISSION_DENIED: This API method requires billing to be enabled

     to every single request. The SDK does not surface that. It classifies a
     failed WebChannel as a transient connection problem and retries with
     backoff, for ever, and the promise returned by .get() NEVER SETTLES. Not
     resolved, not rejected: pending until the tab is closed.

     Measured on the live site, 2026-09-28, while billing was disabled on the
     project: catalog/meta — a document the rules let anyone read — was still
     pending after 30 seconds with no error of any kind.

     Everything downstream of such a call is therefore unreachable. That is the
     whole production failure: sign-in with Google genuinely SUCCEEDED, the
     Firebase user was real, and then initializeAuthenticatedUser awaited
     loadProfile() and stopped. identitySettled stayed false, so the account
     screen repainted "Finishing sign-in... / Checking your Google account."
     and had nothing left that could ever change it. Every recovery path the
     app already has — the offline branch, the outage message, the retry —
     hangs off a .catch that could not run, because nothing ever rejected.

     A deadline turns that back into an ordinary error. 'deadline-exceeded' is
     already one of the codes SM.isBackendOutage treats as "the database
     refused, not your phone" (src/data/api.js), so a timeout lands in the
     outage wording that was written for exactly this incident rather than in
     "check your connection", which was false for it.

     This does NOT paper over an outage. Nothing is faked, no read is answered
     from nowhere: a call that cannot complete now says so, in bounded time, to
     a caller that knows what to do about it. */
  var DEADLINE_MS = 10000;

  /* Uploading a photo is not a lookup — it is megabytes over whatever
     connection a counter in a shop has. Holding it to a reader's deadline
     would cancel legitimate slow uploads. */
  var DEADLINE_UPLOAD_MS = 60000;

  /* ====================================================== RETRY, BUT BRIEFLY

     Firebase's own guidance is to retry DEADLINE_EXCEEDED with exponential
     backoff, and that is right for the failure it describes: a slow round
     trip, a dropped connection, a moment of backend pressure. A second
     attempt costs a second and usually works.

     WHAT MUST NOT BE RETRIED, and why it is worth being strict about:

       permission-denied   the rules said no. Asking again asks the same
                           question and gets the same answer, and hiding it
                           behind three attempts turns a configuration fault
                           into a mystery slow failure. It needs a person, not
                           a retry.
       not-found           an answer, not a failure.
       unauthenticated     the token is wrong. A retry cannot mint a better one.
       resource-exhausted  the quota is spent. Retrying is what spent it.

     And the budget is small on purpose. Every attempt is time somebody spends
     looking at a spinner, and the total has to stay inside the identity gate's
     ceiling or the gate fires first and the retries were pointless. Three
     attempts at 6s, 4s and 3s with 0.5s and 1s between them is 14.5s worst
     case, against a 22s gate.

     It is honestly a small loss for a PERMANENTLY dead backend — the reader
     waits 14.5s for the error rather than 6s. That is the price of recovering
     automatically from the transient case, which is the common one. */
  var TRANSIENT = {
    'deadline-exceeded': 1,
    'unavailable': 1,
    'internal': 1,
    'aborted': 1
  };

  /* Only the read the sign-in blocks on. Retrying a browse query would spend a
     reader's time on a page they can simply reload. */
  var RETRY_PLAN = {
    loadProfile: { deadlines: [6000, 4000, 3000], backoff: [500, 1000] }
  };

  function withRetry(name, invoke, plan) {
    var attempt = 0;

    function run() {
      /* A FRESH call each time. Re-awaiting the same promise would re-await
         the same hang. */
      return deadline(invoke(), name + ' (attempt ' + (attempt + 1) + ')',
                      plan.deadlines[attempt])
        .catch(function (err) {
          var code = err && err.code;
          var isLast = attempt >= plan.deadlines.length - 1;
          if (isLast || !TRANSIENT[code]) throw err;

          var wait = plan.backoff[Math.min(attempt, plan.backoff.length - 1)];
          attempt++;
          SM.debug.warn('firestore', name + ' failed, retrying', {
            code: code, nextAttempt: attempt + 1, afterMs: wait
          });
          return new Promise(function (r) { setTimeout(r, wait); }).then(run);
        });
    }

    return run();
  }

  function deadline(promise, label, ms) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        SM.debug.warn('firestore', label + ' timed out', { after: ms });
        /* Shaped like a Firestore rejection, because that is what every caller
           is already written to read. */
        var err = new Error('firestore ' + label + ' did not answer within ' + ms + 'ms');
        err.code = 'deadline-exceeded';
        err.timedOut = true;
        reject(err);
      }, ms);

      promise.then(function (v) {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(v);
      }, function (e) {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(e);
      });
    });
  }

  /* Loads the Firestore SDK on first use. Most visits never sign in and never
     need it, so it is not part of the boot payload. */
  function store() {
    if (dbLoad) return dbLoad;
    dbLoad = SM.fb.ready().then(function (fb) {
      if (fb.firestore) return fb.firestore();
      return new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = FIRESTORE_SDK;
        s.async = true;
        s.onload = function () { resolve(global.firebase.firestore()); };
        s.onerror = function () { reject(new Error('firestore sdk failed to load')); };
        document.head.appendChild(s);
      });
    }).catch(function (err) {
      dbLoad = null;              /* let a later attempt retry */
      throw err;
    });
    return dbLoad;
  }

  /* Firestore hands back Timestamps; the UI wants epoch milliseconds. Doing it
     here means no screen has to know Firestore's types exist. */
  function ms(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (v.seconds != null) return v.seconds * 1000;
    return null;
  }

  /* What set(doc, {merge:true}) leaves behind: plain objects merge key by
     key, everything else — strings, numbers, arrays, Timestamps — replaces. */
  function isPlainObject(v) {
    return !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
  }
  function mergeDeep(base, patch) {
    var out = Object.assign({}, base);
    Object.keys(patch).forEach(function (k) {
      out[k] = isPlainObject(patch[k]) && isPlainObject(out[k])
        ? mergeDeep(out[k], patch[k])
        : patch[k];
    });
    return out;
  }

  /* ------------------------------------------------ this device's profile copy

     localStorage, keyed by uid, stamped with when it was read — so a new tab,
     or tomorrow morning's first visit, does not have to read users/{uid} to
     draw the same shop it drew last time. It was per-tab at first; shops open
     the site in a new tab constantly, and every one of those was a read.

     It is a copy of what Firestore said, never a source: nothing is written
     here that did not come back from the database or go into it. It holds the
     same non-secret shop details mpf.profiles.v1 has always held on this
     device, and nothing about access — the server decides that on every paid
     request. One slot only, tied to one uid: another account never reads it,
     and signing out deletes it. */
  var PROFILE_CACHE_KEY = 'mpf.profile.cache.v1';
  var profileCache = {
    get: function (uid, maxAgeMs) {
      try {
        var c = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || 'null');
        if (!c || c.uid !== uid || !c.profile) return null;
        var age = Date.now() - c.at;
        if (!(age >= 0 && age < maxAgeMs)) return null;
        return { profile: c.profile, ageMs: age };
      } catch (e) { return null; }
    },
    put: function (uid, profile) {
      try {
        localStorage.setItem(PROFILE_CACHE_KEY,
          JSON.stringify({ uid: uid, at: Date.now(), profile: profile }));
      } catch (e) { /* private mode: every load simply reads */ }
    },
    drop: function () {
      try {
        localStorage.removeItem(PROFILE_CACHE_KEY);
        /* The per-tab copy the first version of this kept. */
        sessionStorage.removeItem(PROFILE_CACHE_KEY);
      } catch (e) { /* private mode */ }
    }
  };

  SM.store = {
    available: function () { return SM.fb.isConfigured(); },

    /** Forgets this device's copy of the profile — on sign-out, and whenever
        the server may have changed the document behind the browser's back. */
    forgetProfile: function () { profileCache.drop(); },

    /**
     * Starts fetching the Firestore SDK without reading anything.
     *
     * The first profile read pays for the SDK download on top of the read. A
     * caller that knows a read is coming — "Continue with Google" pressed, a
     * signed-in page loading — calls this first, so the download overlaps the
     * account chooser or the catalogue download instead of following it. No
     * document is touched, so it costs nothing in Firestore.
     */
    warm: function () {
      return store().then(function () { return true; }, function () { return false; });
    },

    /* ------------------------------------------------------------- profile */

    /* ------------------------------------------------------- profile identity

       users/{uid} is the ONE record for a Google account. The Firebase UID is
       the document id, so the same Gmail on a second device reads the same
       document — identity follows the account, never the browser.

       loadProfile is what the app asks after every sign-in. localStorage is a
       cache in front of it, never the source: a profile that only ever lived
       in a browser is a new user on every other device, which is exactly the
       bug this replaces. */

    /* Old documents used shopName/proprietor/mobile; newer ones use the
       mobileShopName/proprietorName/mobileNumber names the checkout reads.
       Both are accepted so existing records keep working, and nothing is
       rewritten just for having the older shape. */
    normaliseProfile: function (d) {
      if (!d) return null;
      var shop = d.mobileShopName || d.shopName || '';
      var prop = d.proprietorName || d.proprietor || '';
      var mob  = d.mobileNumber || d.mobile || '';
      return {
        uid: d.uid || null,
        email: d.email || '',
        googleDisplayName: d.googleDisplayName || d.googleName || '',
        googlePhotoURL: d.googlePhotoURL || '',
        profilePhotoURL: d.profilePhotoURL || d.photo || '',
        profilePhotoPath: d.profilePhotoPath || null,
        mobileShopName: shop,
        proprietorName: prop,
        mobileNumber: mob,
        mobileNumberE164: d.mobileNumberE164 || '',
        country: d.country || d.countryName || '',
        countryCode: d.countryCode || '',
        address: d.address || null,
        /* Recomputed from the fields rather than trusted, so a stale
           profileCompleted:true on a record missing a number cannot wave an
           incomplete profile through to checkout. */
        profileCompleted: !!(shop && prop && mob),
        displayName: d.displayName || d.googleDisplayName || d.googleName || '',
        authProvider: d.authProvider || 'google',
        accountStatus: d.accountStatus || 'active',
        /* Server-owned, read-only here. The client renders these; it never
           writes them, and the rules would reject it if it tried. */
        subscriptionStatus: d.subscriptionStatus || d.activeSubscriptionStatus || 'none',
        subscriptionPlan: d.subscriptionPlan || d.currentPlanId || null,
        currentPlanId: d.currentPlanId || d.subscriptionPlan || null,
        subscriptionStartedAt: ms(d.subscriptionStartedAt),
        subscriptionExpiresAt: ms(d.subscriptionExpiresAt),
        createdAt: ms(d.createdAt),
        updatedAt: ms(d.updatedAt),
        lastLoginAt: ms(d.lastLoginAt)
      };
    },

    /**
     * The authoritative profile for a UID, or null if this account is new.
     *
     * `opts.maxAgeMs` lets a caller accept this tab's own recent copy instead
     * of a document read. Boot passes it, so moving between the app and the
     * pre-rendered pages — each a full page load — costs one read per session
     * rather than one per page. Every other caller omits it and reads fresh,
     * and a fresh read refreshes the copy. Only a profile that EXISTS is kept:
     * "no document" is the new-account answer, and caching it would hide the
     * profile the sign-up form is about to create.
     */
    loadProfile: function (uid, opts) {
      var self = this;
      var maxAge = opts && opts.maxAgeMs;
      if (maxAge) {
        var hit = profileCache.get(uid, maxAge);
        if (hit) {
          SM.debug.log('profile', 'users/' + uid + ' from this tab’s copy', { ageMs: hit.ageMs });
          return Promise.resolve(hit.profile);
        }
      }
      return store().then(function (db) {
        return db.collection('users').doc(uid).get();
      }).then(function (snap) {
        SM.debug.log('profile', 'read users/' + uid,
                     { exists: snap.exists, complete: snap.exists ? !!snap.data().profileCompleted : false });
        var p = snap.exists ? self.normaliseProfile(snap.data()) : null;
        if (p) profileCache.put(uid, p); else profileCache.drop(uid);
        return p;
      }, function (err) {
        SM.debug.warn('profile', 'read users/' + uid + ' FAILED',
                      { code: err && err.code, message: err && err.message });
        throw err;
      });
    },

    /* Fields the CLIENT is allowed to write. Deliberately identical to
       WRITABLE_PROFILE in api/_lib/store.js: two lists that drift apart is how
       a field ends up saved on one path and dropped on the other.

       Nothing about a subscription appears here. Those fields belong to the
       server, the security rules reject them from a browser, and a client that
       could grant itself a plan is the whole attack the billing design exists
       to prevent. */
    WRITABLE: ['mobileShopName', 'proprietorName', 'mobileNumber', 'mobileNumberE164',
               'country', 'countryCode', 'address', 'profilePhotoURL', 'profilePhotoPath'],

    /**
     * Creates or updates users/{uid}.
     *
     * merge:true and an explicit field list, so writing a profile can never
     * blank a subscription the server owns, and an absent field stays absent
     * rather than being written as an empty string. A missing mobile number is
     * a real state — it means "ask this user for it" — and inventing one would
     * put a fabricated number on a real invoice.
     */
    saveProfile: function (uid, patch, googleUser) {
      var doc = { uid: uid, updatedAt: Date.now() };
      this.WRITABLE.forEach(function (k) {
        var v = patch[k];
        if (v === undefined || v === null) return;
        /* An empty string is not a correction, it is an absent field. Writing
           one would blank a detail the shop entered on another device — and a
           form that opened without being seeded sends nothing BUT empties. */
        if (typeof v === 'string' && v.trim() === '') return;
        /* Same for an address object whose parts are all blank: {} over a
           stored address is a deletion nobody asked for. */
        if (k === 'address' && typeof v === 'object') {
          var hasAny = Object.keys(v).some(function (part) {
            return typeof v[part] === 'string' && v[part].trim() !== '';
          });
          if (!hasAny) return;
        }
        doc[k] = v;
      });

      if (googleUser) {
        doc.email = googleUser.email || '';
        doc.authProvider = 'google';
        /* Google's name and picture go in their own fields. The shop's own
           details are typed by hand and must never be overwritten by them. */
        if (googleUser.displayName) doc.googleDisplayName = googleUser.displayName;
        if (googleUser.photoURL) doc.googlePhotoURL = googleUser.photoURL;
      }
      doc.profileCompleted = !!(doc.mobileShopName && doc.proprietorName && doc.mobileNumber);

      var self = this;
      return store().then(function (db) {
        var ref = db.collection('users').doc(uid);
        return ref.get().then(function (snap) {
          /* createdAt is written once and never again — an update must not
             restamp the day the shop joined. */
          if (!snap.exists) doc.createdAt = Date.now();
          SM.debug.log('profile', snap.exists ? 'updating users/' + uid : 'creating users/' + uid,
                       { fields: Object.keys(doc) });
          /* The stored result is the document read above with this write
             merged over it, which is exactly what set(..., {merge:true}) does —
             so it is computed here instead of paying a second read for it. */
          var merged = mergeDeep(snap.exists ? snap.data() : {}, doc);
          return ref.set(doc, { merge: true }).then(function () { return merged; });
        });
      }).then(function (stored) {
        SM.debug.log('profile', 'firestore write ok', { uid: uid });
        var p = self.normaliseProfile(stored);
        profileCache.put(uid, p);
        return p;
      }, function (err) {
        /* Loud on purpose. A rejected profile write is how a shop ends up
           signed in with no record anywhere, and it used to happen silently. */
        SM.debug.warn('profile', 'firestore write FAILED', {
          uid: uid, code: err && err.code, message: err && err.message
        });
        throw err;
      });
    },

    /* -------------------------------------------------------------- storage

       The profile photo, and nothing else. Firestore stores the URL; the bytes
       go to Storage, because a base64 image inside a document counts against
       the 1 MB document limit and is re-downloaded on every profile read.

       Uploads land in users/{uid}/profile/, which is the path the Storage
       rules key ownership on — a shop can write inside its own folder and
       nowhere else. */
    uploadProfilePhoto: function (uid, file) {
      if (!file) return Promise.reject(new Error('no file'));
      if (!/^image\//.test(file.type)) {
        return Promise.reject(new Error('That file is not an image'));
      }
      if (file.size > 5 * 1024 * 1024) {
        return Promise.reject(new Error('Image is larger than 5 MB'));
      }

      return SM.fb.ready().then(function (fb) {
        if (fb.storage) return fb;
        return new Promise(function (resolve, reject) {
          var el = document.createElement('script');
          el.src = 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage-compat.js';
          el.async = true;
          el.onload = function () { resolve(global.firebase); };
          el.onerror = function () { reject(new Error('storage sdk failed to load')); };
          document.head.appendChild(el);
        });
      }).then(function (fb) {
        /* One file per shop, overwritten on change. Keeping every upload would
           accumulate orphans nothing ever points at. */
        var ext = (file.type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '');
        var path = 'users/' + uid + '/profile/photo.' + ext;
        var ref = fb.storage().ref(path);
        return ref.put(file, { contentType: file.type })
          .then(function () { return ref.getDownloadURL(); })
          .then(function (url) { return { url: url, path: path }; });
      });
    },

    /* ---------------------------------------------------------------- paid */

    /**
     * Which groups a device belongs to, per category — the paid answer.
     * Rules refuse this without an active subscription, so a rejection here is
     * the paywall working rather than an error to paper over.
     *
     * @returns {Promise<{byCategory:Object}|null>} null when not subscribed
     */
    deviceGroups: function (deviceId) {
      return store().then(function (db) {
        return db.collection('deviceGroups').doc(deviceId).get();
      }).then(function (snap) {
        return snap.exists ? snap.data() : null;
      }).catch(function (err) {
        if (err && err.code === 'permission-denied') return null;
        throw err;
      });
    },

    /**
     * Part number and full member list for one group. Paid, same as above.
     * @returns {Promise<object|null>} null when not subscribed
     */
    groupDetail: function (groupId) {
      return store().then(function (db) {
        return db.collection('groupDetails').doc(groupId).get();
      }).then(function (snap) {
        return snap.exists ? snap.data() : null;
      }).catch(function (err) {
        if (err && err.code === 'permission-denied') return null;
        throw err;
      });
    },

    /** Several groups at once, for a device page that lists all its parts. */
    groupDetails: function (groupIds) {
      if (!groupIds || !groupIds.length) return Promise.resolve([]);
      return store().then(function (db) {
        /* Firestore has no multi-get in the compat SDK, and `in` caps at 30,
           so this fans out. Callers pass a device's groups — single digits —
           not the whole catalogue. */
        return Promise.all(groupIds.slice(0, 60).map(function (id) {
          return db.collection('groupDetails').doc(id).get()
            .then(function (s) { return s.exists ? Object.assign({ id: id }, s.data()) : null; })
            .catch(function (e) {
              if (e && e.code === 'permission-denied') return null;
              throw e;
            });
        }));
      }).then(function (rows) { return rows.filter(Boolean); });
    },

    /* ------------------------------------------------------------ catalogue

       Compatibility groups, read straight from Firestore and paged with a
       cursor. A page costs `limit` document reads — twelve, not the 3,340 a
       whole-collection fetch would bill — and the composite indexes deployed
       from firestore.indexes.json are what make the filters cheap:

         categoryId + groupNo
         masterBrandId + groupNo
         categoryId + masterBrandId + groupNo

       Cursors rather than offsets, because Firestore has no OFFSET that skips
       for free: page 10 of an offset query still reads pages 1-9. startAfter
       resumes exactly where the last page stopped.

       Only the PUBLIC preview lives in /groups — no part number, no member
       list — so this query is readable by a signed-out visitor and cannot leak
       the paid half whatever it asks for. */
    listGroups: function (opts) {
      opts = opts || {};
      return store().then(function (db) {
        var q = db.collection('groups');

        if (opts.categoryId && opts.categoryId !== 'all') q = q.where('categoryId', '==', opts.categoryId);
        if (opts.brandId && opts.brandId !== 'all') q = q.where('masterBrandId', '==', opts.brandId);

        /* Sorting has to line up with an index that exists, so an unknown sort
           falls back to groupNo rather than throwing FAILED_PRECONDITION at a
           reader who just opened the page. */
        if (opts.sort === 'most') q = q.orderBy('memberCount', 'desc').orderBy('groupNo');
        else if (opts.sort === 'least') q = q.orderBy('memberCount', 'asc').orderBy('groupNo');
        else q = q.orderBy('groupNo');

        if (opts.cursor) q = q.startAfter(opts.cursor);
        return q.limit((opts.limit || 12) + 1).get();
      }).then(function (snap) {
        var docs = snap.docs;
        var limit = opts.limit || 12;
        /* One extra row is fetched purely to answer "is there more?" without a
           second count query, and dropped before returning. */
        var hasMore = docs.length > limit;
        var page = hasMore ? docs.slice(0, limit) : docs;

        return {
          items: page.map(function (d) {
            var g = d.data();
            return {
              groupId: d.id,
              groupNumber: g.groupNo,
              serialNumber: g.serialNo || g.groupNo,
              categoryId: g.categoryId,
              categoryName: g.categoryName,
              masterModelId: g.masterModelId,
              masterModelName: g.masterModelName,
              masterBrandId: g.masterBrandId,
              compatibleCount: g.memberCount,
              /* Read through rather than nulled. These used to be hard-coded
                 null here because the collection genuinely did not carry them;
                 it does now, and returning null for a field that is present is
                 how the finder showed "not listed" over data it had. Still
                 defaulted, so a document written by the older importer — which
                 had no part code — reads as absent rather than undefined. */
              partCode: g.partCode || null,
              oemPartNo: g.oemPartNo || null,
              compatibleDeviceIds: g.memberIds || null,
              memberNames: g.memberNames || null,
              createdOn: null
            };
          }),
          cursor: page.length ? page[page.length - 1] : null,
          hasMore: hasMore
        };
      });
    },

    /* One group's public preview. */
    group: function (groupId) {
      return store().then(function (db) {
        return db.collection('groups').doc(groupId).get();
      }).then(function (snap) { return snap.exists ? snap.data() : null; });
    },

    /* ------------------------------------------------------------- history */

    /** The shop's own recent searches. Owner-only by rule. */
    /* This one, pushSearch and check all promise never to throw, and they mean
       it — so each puts the deadline INSIDE its own catch. The blanket wrapper
       at the foot of this file would sit outside it and turn a timeout into
       exactly the rejection these methods exist to absorb. They are listed in
       SELF_BOUNDED there. */
    recentSearches: function (uid, limit) {
      return deadline(store().then(function (db) {
        return db.collection('users').doc(uid).collection('recent')
          .orderBy('at', 'desc').limit(limit || 10).get();
      }).then(function (snap) {
        return snap.docs.map(function (d) {
          var x = d.data();
          return { id: d.id, modelId: x.modelId, query: x.query, at: ms(x.at) };
        });
      }), 'recentSearches', DEADLINE_MS)
        .catch(function () { return []; });   /* history is a nicety, never a blocker */
    },

    pushSearch: function (uid, modelId, query) {
      return deadline(store().then(function (db) {
        return db.collection('users').doc(uid).collection('recent').doc(modelId).set({
          modelId: modelId, query: query || '', at: Date.now()
        });
      }), 'pushSearch', DEADLINE_MS)
        .catch(function () { /* losing a history row must not break a search */ });
    },

    /* -------------------------------------------------------------- health */

    /**
     * One cheap read that proves the whole chain: config -> SDK -> project ->
     * rules. Used by the diagnostics rather than guessing from a blank screen.
     */
    check: function () {
      return deadline(store().then(function (db) {
        return db.collection('catalog').doc('meta').get();
      }).then(function (snap) {
        return {
          ok: true,
          projectId: SM.fb.projectId(),
          catalogMeta: snap.exists ? snap.data() : null,
          imported: snap.exists
        };
      }), 'check', DEADLINE_MS)
        .catch(function (err) {
          /* A diagnostics call that throws is a diagnostics call nobody can
             use while the thing it diagnoses is broken. A timeout is a RESULT
             here — and the most informative one this function can return,
             because a backend that never answers is precisely what it is for. */
          return { ok: false, code: err && err.code, message: err && err.message };
        });
    }
  };

  /* ------------------------------------------------- the deadline, applied

     Wrapping the object rather than each method is deliberate. A per-call-site
     timeout is one someone forgets to add to the next method, and the method
     they forget is the one that strands a screen — which is precisely how this
     outage reached production with recovery code already written for it. Here
     there is nothing to remember: every asynchronous door out of this module
     goes through the same clock.

     `available` and `normaliseProfile` are pure and synchronous, and a
     non-thenable return is passed through untouched, so a future synchronous
     helper needs no maintenance here either. */
  (function applyDeadlines() {
    var SYNC = { available: 1, normaliseProfile: 1, forgetProfile: 1 };

    /* Already bounded, inside their own catch. Wrapping them again would put a
       rejection outside the handler that exists to absorb it, and these three
       promise their callers that they never throw. */
    var SELF_BOUNDED = { recentSearches: 1, pushSearch: 1, check: 1, warm: 1 };

    var LONGER = { uploadProfilePhoto: DEADLINE_UPLOAD_MS };

    Object.keys(SM.store).forEach(function (name) {
      var fn = SM.store[name];
      if (typeof fn !== 'function' || SYNC[name] || SELF_BOUNDED[name]) return;

      SM.store[name] = function () {
        var self = this === undefined ? SM.store : SM.store;
        var args = arguments;

        /* A method that throws synchronously must still reject rather than
           explode in the caller's stack — callers here only ever .catch. */
        var invoke = function () {
          try { return fn.apply(self, args); }
          catch (e) { return Promise.reject(e); }
        };

        var plan = RETRY_PLAN[name];
        if (plan) return withRetry(name, invoke, plan);

        var out = invoke();
        if (!out || typeof out.then !== 'function') return out;
        return deadline(out, name, LONGER[name] || DEADLINE_MS);
      };
    });
  })();
})(window);

/* === src/data/billing.js === */;
/* ============================================================================
   Mobile Parts Finder · billing.js — the browser half of the payment flow
   ----------------------------------------------------------------------------
   Talks to /api/*, opens Razorpay Checkout, and reports progress. What it
   deliberately does NOT do is decide anything.

   THE RULE THIS FILE EXISTS TO ENFORCE

     A subscription becomes active because the SERVER said so, never because
     Checkout's success callback fired. That callback runs in the page, and
     anything running in the page can be run by hand from the console. So the
     handler does not unlock anything — it posts the payment to
     /api/verify-payment and waits. The signature is checked there, against a
     secret this file has never seen, and access follows from that answer alone.

   WHY THE STATUS IS RE-FETCHED AFTERWARDS

     Even the verify response is not treated as the final word on access.
     `status()` re-reads /api/subscription, so what the UI shows is always the
     server's current record — including the case where the webhook activated
     the subscription first and the browser's own verify call arrived second.

   PAYMENT CANNOT ONLY SUCCEED

     Checkout has three exits and all three are handled: success, an explicit
     failure event, and the user dismissing the modal. That last one used to be
     the bug in every integration — the promise simply never settles and the
     button spins forever — so `ondismiss` resolves with a cancelled state.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  var CHECKOUT_SDK = 'https://checkout.razorpay.com/v1/checkout.js';
  var checkoutLoading = null;

  function loadCheckout() {
    if (global.Razorpay) return Promise.resolve();
    if (checkoutLoading) return checkoutLoading;
    checkoutLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = CHECKOUT_SDK;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('checkout-unavailable')); };
      document.head.appendChild(s);
    }).catch(function (e) { checkoutLoading = null; throw e; });
    return checkoutLoading;
  }

  /* ------------------------------------------------------- nothing waits for ever

     A fetch() has no timeout of its own. A request that is accepted and then
     never answered — a serverless function wedged on a database that has
     stopped replying, a captive portal that swallows the connection - leaves
     its promise pending indefinitely, and every await behind it with it.

     That is the same shape of failure as the Firestore hang in
     src/data/firestore.js, and it strands the same screens: /api/profile-sync
     is awaited on the sign-in path and /api/admin/session is awaited by the
     account screen's role gate. Either one hanging is another permanent
     "Finishing sign-in...".

     AbortController is what actually cancels the request rather than merely
     stopping waiting on it, so a timed-out call does not leave a connection
     open behind the error. */
  var API_TIMEOUT_MS = 15000;

  function timedFetch(path, init, ms) {
    init = init || {};
    var ctrl = null;
    try { ctrl = new AbortController(); } catch (e) { /* very old browser */ }
    if (ctrl) init.signal = ctrl.signal;

    var timer = null;
    var limit = ms || API_TIMEOUT_MS;

    return new Promise(function (resolve, reject) {
      var settled = false;
      timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        if (ctrl) { try { ctrl.abort(); } catch (e) { /* already gone */ } }
        SM.debug.warn('api', path + ' timed out', { after: limit });
        var err = new Error('request-timeout');
        err.code = 'deadline-exceeded';
        err.timedOut = true;
        /* 504-shaped so SM.isBackendOutage reads it as the site's fault, which
           is what a request the site accepted and never answered is. */
        err.status = 504;
        reject(err);
      }, limit);

      fetch(path, init).then(function (res) {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(res);
      }, function (e) {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(e);
      });
    });
  }

  /* Every authenticated call goes through here so the token is always fresh
     and a 401 always means the same thing. */
  function apiFetch(path, options) {
    options = options || {};
    return SM.fb.idToken().then(function (token) {
      if (!token) throw new Error('signin-required');
      return timedFetch(path, {
        method: options.method || 'GET',
        headers: Object.assign({
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        }, options.headers || {}),
        body: options.body ? JSON.stringify(options.body) : undefined
      }, options.timeoutMs);
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || ('http ' + res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  SM.billing = {
    /** Public pricing. No auth — a signed-out visitor must see the price. */
    plans: function () {
      return timedFetch('/api/plans').then(function (r) { return r.json(); });
    },

    /**
     * Is this deployment actually configured? Booleans only — no value of any
     * environment variable is returned, here or by the route.
     *
     * It exists because "Payment service is not configured yet" was a guess
     * made from an HTTP 500, and a 500 is equally consistent with a crash.
     * Now the browser can ask directly, and so can anyone with curl.
     */
    health: function () {
      return timedFetch('/api/health').then(function (r) { return r.json(); })
        .catch(function () { return { ok: false, unreachable: true }; });
    },

    /**
     * Who the SERVER thinks the caller is, and what it will let them do.
     *
     * Resolves { admin: { uid, email, name, role, permissions, claimStale } }
     * and rejects with status 401/403 for everyone else — api/_lib/admin-auth
     * verifies the Firebase ID token and consults api/_schema/roles.js, which
     * is where the role actually lives. The account screen uses it to decide
     * whether to draw the Admin Panel link, so that link reflects a server
     * decision instead of a comparison the browser made about itself.
     *
     * It grants nothing. /admin and every /api/admin/* route re-check the same
     * token on every request; this only stops the UI guessing.
     */
    adminSession: function (options) {
      return apiFetch('/api/admin/session', options);
    },

    /**
     * Makes users/{uid} exist and stamps lastLoginAt. Called after every
     * sign-in and every restored session.
     *
     * The browser also writes its own profile directly to Firestore, and still
     * should — that is what keeps the account screen instant. But a write the
     * client owns is a write that can silently not happen, and a shop signed in
     * with no record anywhere is precisely the state this fixes. Running it
     * through the server means security rules cannot swallow it, and the
     * server-owned fields get set by the only party allowed to set them.
     *
     * @param {object} [payload] optional { photoURL, profile } — shop details
     *        only; anything else in `profile` is dropped server side.
     */
    syncProfile: function (payload) {
      return apiFetch('/api/profile-sync', { method: 'POST', body: payload || {} });
    },

    /** The server's record of this account's access. The only source of truth. */
    status: function () {
      return apiFetch('/api/subscription');
    },

    cancel: function () {
      return apiFetch('/api/cancel-subscription', { method: 'POST' });
    },

    /**
     * Runs the whole purchase.
     *
     * @param {string} planId
     * @param {(stage:string, detail?:object) => void} [onStage]
     *        creating-order | opening-checkout | verifying |
     *        active | failed | cancelled
     * @returns {Promise<{state:string, [key:string]:any}>}
     *          Resolves for a cancellation too — a dismissed modal is an
     *          outcome, not an exception.
     */
    subscribe: function (planId, onStage) {
      var stage = function (name, detail) {
        SM.debug.log('billing', 'stage ' + name, detail);
        if (onStage) onStage(name, detail);
      };

      return SM.fb.idToken().then(function (token) {
        if (!token) throw new Error('signin-required');

        stage('creating-order', { planId: planId });
        return Promise.all([
          apiFetch('/api/create-order', { method: 'POST', body: { planId: planId } })
            .catch(function (err) {
              SM.debug.warn('billing', 'create-order rejected',
                            { status: err.status, error: err.message, data: err.data });
              throw err;
            }),
          loadCheckout()
        ]);
      }).then(function (results) {
        var order = results[0];
        /* `mode` comes from the public key id's prefix. Worth logging: a test
           payment and a live one look identical on screen. */
        SM.debug.log('billing', 'order created',
                     { orderId: order.orderId, amount: order.amount, mode: order.mode });

        return new Promise(function (resolve, reject) {
          var settled = false;
          var finish = function (v) { if (!settled) { settled = true; resolve(v); } };

          var rzp = new global.Razorpay({
            key: order.keyId,              /* public key id, never the secret */
            amount: order.amount,
            currency: order.currency,
            order_id: order.orderId,
            name: 'Mobile Parts Finder',
            description: order.planName + ' subscription',
            prefill: order.prefill || {},
            theme: { color: '#0E7A6C' },

            /* Success here means Checkout finished — NOT that access is
               granted. That is decided by the server, below. */
            handler: function (response) {
              stage('verifying');
              apiFetch('/api/verify-payment', {
                method: 'POST',
                body: {
                  razorpay_order_id: response.razorpay_order_id,
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_signature: response.razorpay_signature
                }
              }).then(function (verified) {
                stage('active', verified);
                finish({ state: 'active', ...verified });
              }).catch(function (err) {
                /* The money may well have left the account — the webhook will
                   reconcile it — so this says "could not confirm", not
                   "payment failed". */
                stage('failed', { reason: err.message, recoverable: true });
                finish({
                  state: 'verification-failed',
                  reason: err.message,
                  paymentId: response.razorpay_payment_id
                });
              });
            },

            modal: {
              /* Without this the promise never settles when the user closes
                 the sheet, and the button spins for ever. */
              ondismiss: function () {
                stage('cancelled');
                finish({ state: 'cancelled' });
              }
            }
          });

          rzp.on('payment.failed', function (resp) {
            var d = (resp && resp.error) || {};
            stage('failed', { reason: d.description, code: d.code });
            finish({ state: 'failed', reason: d.description || 'payment failed', code: d.code || null });
          });

          stage('opening-checkout');
          rzp.open();
        });
      });
    }
  };
})(window);

/* === src/data/auth.js === */;
/* ============================================================================
   Mobile Parts Finder · auth.js — Google Sign-In + shop profile store
   ----------------------------------------------------------------------------
   GOING LIVE
     Set GOOGLE_CLIENT_ID below to an OAuth 2.0 Web client ID from
     Google Cloud Console (APIs & Services -> Credentials), with the deployed
     origin added under "Authorised JavaScript origins", e.g.
        https://www.mobilepartsfinder.com
     The moment that constant is filled in, SM.auth.signIn() loads Google
     Identity Services and opens the real account chooser showing the Google
     accounts already signed in on the device. Nothing else needs changing.

   WITHOUT A CLIENT ID
     There is no way to reach the device's Google accounts, so signIn() opens
     a clearly-labelled demo chooser instead. It never presents itself as
     Google's own UI.

   TOKEN VERIFICATION
     GIS returns a signed JWT credential. A production build must send that
     credential to a backend and verify its signature, `aud` and `iss` against
     Google's public keys before trusting it — see SM.auth.verifyEndpoint.
     Profiles are stored locally here because this build has no server.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  /* ---------------------------------------------------------------- storage
     The rebrand renamed every key snapmatch.* -> mpf.*. Carry anything saved
     under an old key across once so a returning browser keeps its theme,
     recent searches, shop profile and subscription. auth.js loads before
     api.js and app.js, so this runs before the first read. Safe to delete a
     release or two from now. */
  (function migrateStorageKeys() {
    var moved = {
      'snapmatch.theme':       'mpf.theme',
      'snapmatch.recent.v1':   'mpf.recent.v1',
      'snapmatch.profiles.v1': 'mpf.profiles.v1',
      'snapmatch.session.v2':  'mpf.session.v2'
    };
    try {
      Object.keys(moved).forEach(function (old) {
        var v = localStorage.getItem(old);
        if (v === null) return;
        if (localStorage.getItem(moved[old]) === null) localStorage.setItem(moved[old], v);
        localStorage.removeItem(old);
      });
    } catch (e) { /* private mode */ }
  }());

  var GOOGLE_CLIENT_ID = '';                 /* <-- paste the client ID here */
  var VERIFY_ENDPOINT = '';                  /* <-- backend token verifier    */
  var GSI_SRC = 'https://accounts.google.com/gsi/client';

  /* The stand-in account chooser is a DEVELOPMENT aid. It exists so the account
     screens can be built before an OAuth client ID is issued — but on a public
     host it would let any visitor sign in as a made-up shop and, with no
     payment backend wired up, activate a subscription for nothing.

     So it is confined to localhost. On a real domain an unconfigured sign-in
     says so and does nothing, which is the honest failure. */
  function isLocalHost() {
    var h = global.location && global.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || /\.local$/.test(h || '');
  }
  SM.isLocalHost = isLocalHost;

  var PROFILE_KEY = 'mpf.profiles.v1';

  function readStore() {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function writeStore(s) {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
  }

  /* base64url JWT payload -> object (display only; never a substitute for
     server-side signature verification) */
  function decodeJwt(tok) {
    try {
      var p = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(atob(p).split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join('')));
    } catch (e) { return null; }
  }

  /* True when a provider's error text is a pasted HTTP response rather than a
     sentence — a URL, a status line, or a JSON body. Firebase forwards these
     verbatim, and they have been landing on the account page as a wall of
     quoted Google error JSON. Nobody who reads that page can act on it, and a
     message nobody can act on is worse than a short one, because it reads as
     the site being broken in a way that is somehow the reader's problem. */
  function rawProviderNoise(msg) {
    if (!msg) return false;
    return /https?:\/\//.test(msg) || /http status/i.test(msg) ||
           /"error"\s*:/.test(msg) || /UNAUTHENTICATED|PERMISSION_DENIED/.test(msg);
  }

  var gsiLoading = null;
  function loadGsi() {
    if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve(true);
    if (gsiLoading) return gsiLoading;
    gsiLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = GSI_SRC; s.async = true; s.defer = true;
      s.onload = function () { resolve(true); };
      s.onerror = function () { reject(new Error('Could not reach Google Sign-In.')); };
      document.head.appendChild(s);
    });
    return gsiLoading;
  }

  SM.auth = {
    configured: function () { return !!GOOGLE_CLIENT_ID; },
    clientId: GOOGLE_CLIENT_ID,
    verifyEndpoint: VERIFY_ENDPOINT,

    /* Opens the real Google account chooser when configured.
       Resolves with { sub, email, name, picture } or rejects:
         code 'unconfigured' | 'cancelled' | 'network' | 'failed'          */
    signInWithGoogle: function () {
      /* Firebase Authentication is the real path and takes precedence the
         moment it is configured. It hands back a verified ID token, which is
         what every billing endpoint requires — the GIS path below only ever
         produced claims this app decoded for itself, which proves nothing to
         a server. */
      if (SM.fb && SM.fb.isConfigured()) {
        return SM.fb.signIn().then(function (user) {
          /* A redirect sign-in resolves to null: the browser is on its way to
             Google and the result lands on the next page load. Anything that
             looks like a failure here would be wrong. */
          if (!user) {
            var pending = new Error('redirecting to Google');
            pending.code = 'redirecting';
            throw pending;
          }
          return {
            sub: user.uid,
            email: user.email || '',
            name: user.displayName || '',
            picture: user.photoURL || '',
            emailVerified: !!user.emailVerified
          };
        }, function (err) {
          var code = err && err.code;
          var host = (global.location && global.location.hostname) || 'this domain';

          /* Name the domain. "This domain is not on the authorised list" is
             true and useless — the fix is one paste into one console field, and
             whoever reads this needs to know WHICH host to paste. It bites
             hardest on Vercel preview URLs, which change with every deployment
             and are never on the list. */
          var message =
            code === 'auth/popup-closed-by-user' || code === 'auth/user-cancelled'
              ? 'Sign-in cancelled'
          : code === 'auth/unauthorized-domain'
              ? 'Google sign-in is not allowed from ' + host + '. Add it under ' +
                'Firebase console → Authentication → Settings → Authorised domains, ' +
                'or open the site on its own domain instead of this preview URL.'
          : code === 'auth/operation-not-allowed'
              ? 'Google sign-in is switched off for this Firebase project. Enable ' +
                'the Google provider under Authentication → Sign-in method.'
          : code === 'auth/network-request-failed'
              ? 'Could not reach Google. Check the connection and try again.'
          /* Google accepted the person and then refused the SITE. Firebase's
             own message for this is a pasted HTTP response — a URL, a status
             code and a JSON body — which went straight onto the page in front
             of shop owners who can do nothing with it, and does not say the one
             thing that matters: nothing is wrong with their Google account, so
             retrying and re-retrying cannot help.

             It means the project's Google OAuth client is no longer usable —
             its secret was rotated or the client was deleted in Google Cloud,
             leaving Firebase holding a credential Google now rejects. Only the
             owner can fix that, in the console. The raw response stays in the
             debug log for whoever is doing it. */
          : code === 'auth/invalid-credential' || code === 'auth/internal-error'
              ? 'Google sign-in is not working on this site at the moment — the ' +
                'problem is with the site, not your Google account. The owner ' +
                'needs to reconnect Google sign-in in the Firebase console.'
          : rawProviderNoise(err && err.message)
              ? 'Google sign-in failed. Please try again.'
          : (err && err.message) || 'Google sign-in failed.';

          /* Whatever is shown, the untouched original is still recoverable. */
          SM.debug.warn('auth', 'google sign-in failed', {
            code: code || null, raw: (err && err.message) || null
          });

          var e = new Error(message);
          e.code =
            /* Another attempt superseded this one and is still running. The
               caller must say nothing at all: an error message here would
               appear over a Google popup that is open and working. */
            code === 'auth/cancelled-popup-request' ? 'superseded'
          : (code === 'auth/popup-closed-by-user' || code === 'auth/user-cancelled') ? 'cancelled'
          : 'failed';
          e.authCode = code || null;
          throw e;
        });
      }

      if (!GOOGLE_CLIENT_ID) {
        var e = new Error('Google Sign-In is not configured yet.');
        e.code = 'unconfigured';
        return Promise.reject(e);
      }
      return loadGsi().then(function () {
        return new Promise(function (resolve, reject) {
          var settled = false;
          google.accounts.id.initialize({
            client_id: GOOGLE_CLIENT_ID,
            auto_select: false,
            cancel_on_tap_outside: true,
            callback: function (res) {
              settled = true;
              var claims = decodeJwt(res.credential);
              if (!claims || !claims.sub) {
                var er = new Error('Google returned an unreadable response.');
                er.code = 'failed'; reject(er); return;
              }
              /* production: POST res.credential to VERIFY_ENDPOINT and let the
                 server confirm the signature before trusting these claims */
              resolve({
                sub: claims.sub, email: claims.email, name: claims.name || '',
                picture: claims.picture || '', credential: res.credential
              });
            }
          });
          google.accounts.id.prompt(function (n) {
            if (settled) return;
            if (n.isNotDisplayed && n.isNotDisplayed()) {
              var e1 = new Error('Google could not show the account chooser.');
              e1.code = 'failed'; reject(e1);
            } else if (n.isSkippedMoment && n.isSkippedMoment()) {
              var e2 = new Error('Sign-in cancelled.');
              e2.code = 'cancelled'; reject(e2);
            }
          });
        });
      }, function () {
        var e = new Error('Could not reach Google Sign-In. Check your connection.');
        e.code = 'network';
        return Promise.reject(e);
      });
    },

    /* profile store — swap these three for backend calls when a server exists */
    findProfile: function (sub) { return readStore()[sub] || null; },
    saveProfile: function (sub, profile) {
      var s = readStore();
      s[sub] = Object.assign({}, s[sub], profile, { sub: sub, updatedAt: Date.now() });
      writeStore(s);
      return s[sub];
    },
    allProfiles: function () { return readStore(); },

    /* Drops one account's copy. Signing out calls it, so a shop's details do
       not stay behind on a counter machine for whoever uses it next. */
    forgetProfile: function (sub) {
      if (!sub) return;
      var s = readStore();
      if (!Object.prototype.hasOwnProperty.call(s, sub)) return;
      delete s[sub];
      writeStore(s);
    }
  };
})(window);

/* === src/data/api.js === */;
/* ============================================================================
   Mobile Parts Finder · api.js  —  the integration seam
   ----------------------------------------------------------------------------
   Every screen talks to the app ONLY through SM.api. Each method returns a
   Promise and resolves after a small simulated delay, so all loading states in
   the UI are real. To connect a live backend later, replace the
   bodies of these methods with fetch() calls that return the same shapes —
   no component needs to change.

     GET  /stats                                   -> stats()
     GET  /brands                                  -> listBrands()
     GET  /models?brand=&q=&page=&pageSize=        -> listModels()
     GET  /models/:id                              -> getModel()
     GET  /models/suggest?q=                       -> suggestModels()
     GET  /groups?q=&brand=&category=&sort=&page=  -> listGroups()
     GET  /groups/:id                              -> getGroup()
     GET  /match?model=&category=                  -> findMatches()

   NOTE: there is no server, no database, no auth provider and no payment
   gateway in this build. Session + subscription live in localStorage only.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});
  /* The catalogue arrives over the network now, so this alias is bound before
     it exists. Every module that caches SM.db registers a rebind here and boot
     runs them once the dataset has loaded — cheaper and far less invasive than
     turning several hundred `db.x` reads into `SM.db.x`. */
  var db = SM.db;
  (SM.__rebind = SM.__rebind || []).push(function () { db = SM.db; });

  var LAT = { instant: 0, fast: 90, normal: 190, slow: 380 };
  function respond(value, ms) {
    return new Promise(function (res) { setTimeout(function () { res(value); }, ms); });
  }
  function norm(s) { return (s || '').toLowerCase().trim(); }
  function page(list, p, size) {
    p = p || 1; size = size || 24;
    var start = (p - 1) * size;
    return {
      items: list.slice(start, start + size),
      total: list.length,
      page: p,
      pageSize: size,
      pages: Math.max(1, Math.ceil(list.length / size)),
      hasMore: start + size < list.length
    };
  }
  function hydrate(g) {
    return {
      group: g,
      category: db.categoryById[g.categoryId],
      master: db.modelById[g.masterModelId],
      /* The member list is the paid answer and is absent from the public
         catalogue, so this is null for a visitor and filled from
         /api/device-parts for a subscriber. `deviceCount` is always real,
         which lets the UI say "fits 12 devices" without giving the twelve away. */
      devices: g.compatibleDeviceIds
        ? g.compatibleDeviceIds.map(function (id) { return db.modelById[id]; })
        : null,
      deviceCount: g.compatibleCount,
      locked: !g.compatibleDeviceIds
    };
  }

  /* One group as /api/device-parts returned it, in the shape the cards expect.

     The server sends membership and nothing about presentation; the number,
     serial, category and master come from the loaded catalogue, which is
     public and already in memory. A group the local bundle has never heard of
     -- added in the console since the last build -- is dropped rather than
     rendered as undefined, the same way hydrateRemote handles it.

     `devices` is resolved against db.modelById first so the cards get real
     photographs and brands. A member the catalogue does not carry falls back
     to the name the server sent, which is better than a blank row. */
  function rowFromServerGroup(sg) {
    if (!sg || !sg.groupId) return null;
    var g = db.groupById[sg.groupId];
    if (!g) {
      SM.debug.warn('api', 'server returned a group the catalogue does not have',
                    { groupId: sg.groupId });
      return null;
    }
    var cat = db.categoryById[g.categoryId];
    var master = db.modelById[g.masterModelId];
    if (!cat || !master) return null;

    var members = Array.isArray(sg.members) ? sg.members : [];
    var devices = members.length
      ? members.map(function (m) {
          var id = m && (m.id || m);
          return db.modelById[id] || {
            id: id,
            fullName: (m && m.name) || id,
            modelName: (m && m.name) || id,
            brandId: null,
            search: String((m && m.name) || id).toLowerCase()
          };
        })
      : null;

    return {
      group: g,
      category: cat,
      master: master,
      devices: devices,
      deviceCount: Number(sg.memberCount) || g.compatibleCount || 0,
      /* The server's own verdict, not a guess from an empty array: a group
         with no members recorded and a group withheld from a free account are
         different things and get different words on screen. */
      locked: !!sg.requiresPlan || !!sg.locked,
      requiresPlan: !!sg.requiresPlan,
      lockedCount: Number(sg.lockedCount) || 0,
      /* A free result's handful of names — the same preview the home feed
         shows. Resolved like devices; empty for a subscriber, who has them all. */
      preview: Array.isArray(sg.preview)
        ? sg.preview.map(function (m) {
            var id = m && (m.id || m);
            return db.modelById[id] || {
              id: id, fullName: (m && m.name) || id, modelName: (m && m.name) || id,
              brandId: null, search: String((m && m.name) || id).toLowerCase()
            };
          })
        : [],
      partCode: sg.partCode || g.partCode || null,
      oemPartNo: sg.oemPartNo || g.oemPartNo || null
    };
  }

  /* A group read from Firestore, put into the shape the cards expect.

     The two sources carry the same fields — the CDN bundle is built from the
     same export the importer writes — so hydrate() does the work. What this
     adds is the guard: a group whose category or master model is not in the
     loaded catalogue would hydrate to undefined and crash the renderer. That
     happens legitimately, for a group added in the console since the bundle
     was last built, so it is dropped with a warning rather than taking the
     page down with it. */
  function hydrateRemote(g) {
    if (!g || !db.categoryById[g.categoryId] || !db.modelById[g.masterModelId]) {
      SM.debug.warn('groups', 'skipping a group the local catalogue does not know', {
        groupId: g && g.groupId, categoryId: g && g.categoryId, masterModelId: g && g.masterModelId
      });
      return null;
    }
    /* Both sources are built from the same export, so where the bundle already
       holds this group its record is the complete one — part codes, member
       list and all. Firestore's values win field by field where it has them,
       which is what lets a group edited in the console show up without a
       rebuild, and the bundle fills anything an older document is missing. */
    var local = db.groupById[g.groupId];
    if (local) {
      var merged = {};
      Object.keys(local).forEach(function (k) { merged[k] = local[k]; });
      Object.keys(g).forEach(function (k) { if (g[k] != null) merged[k] = g[k]; });
      return hydrate(merged);
    }
    return hydrate(g);
  }

  /* ======================================================================
     GROUP FEED ORDER
     ----------------------------------------------------------------------
     The catalogue used to come out in group-number order, which is the order
     it was imported in — so the first screenful was SG-0001 to SG-0006, all
     six of them Huawei screen guards. Nothing was random; it was sorted by
     the one field that correlates with nothing a shop is looking for, which
     reads exactly like a database dump.

     Two things fix that, and both are deterministic — a reload must not
     reshuffle the page:

       TRENDING   groups whose newest member phone came out in the last year,
                  newest first. Recency is a property of the DEVICES in a
                  group, not of the group row, so it is derived from release
                  dates.

       MIXED      everything else, round-robined across categories so a
                  scroll passes a guard, a cover, a board, a battery, rather
                  than 709 covers before the first board.

     COST. The index over 3,340 groups is built once, lazily, on the first
     feed that needs it; each distinct filter combination is ordered once and
     cached. Paging is then a slice. Nothing re-sorts per render.
     ====================================================================== */

  var DAY = 864e5;
  var TREND_RECENT = 182 * DAY;   /* ~6 months — tier 1 */
  var TREND_WINDOW = 365 * DAY;   /* ~12 months — tier 2 */

  /* Release dates are dirty: 111 models carry none and 19 carry impossible
     ones like "2019-04-46". Date.UTC would roll that into May rather than
     refuse it, so the components are checked back out of the date they
     produced. A date that does not survive the round trip is treated as
     absent — never guessed at, and never a reason for the page to throw. */
  function parseReleaseTs(iso) {
    if (!iso) return 0;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (!m) return 0;
    var y = +m[1], mo = +m[2], d = +m[3];
    var t = Date.UTC(y, mo - 1, d);
    var dt = new Date(t);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return 0;
    return t;
  }

  /* groupId -> newest release date among the devices that group fits.
     A group is as current as the newest phone in it: one 2026 handset makes
     the group worth surfacing even if its other members are from 2019.

     Membership comes from db.groupsByModel, which the catalogue already
     ships and the device pages already read. It is used here only to pick a
     DATE — no member is named, listed or counted from it, so the paid
     fitment list stays exactly as withheld as it was. */
  var recencyIndex = null;
  function groupRecency() {
    if (recencyIndex) return recencyIndex;
    var byGroup = Object.create(null);
    var gbm = db.groupsByModel || {};
    Object.keys(gbm).forEach(function (modelId) {
      var m = db.modelById[modelId];
      var ts = m ? parseReleaseTs(m.releaseDateIso) : 0;
      if (!ts) return;
      var ids = gbm[modelId] || [];
      for (var i = 0; i < ids.length; i++) {
        if (!byGroup[ids[i]] || ts > byGroup[ids[i]]) byGroup[ids[i]] = ts;
      }
    });
    /* The master model counts even where the membership map does not list it. */
    db.groups.forEach(function (g) {
      var m = db.modelById[g.masterModelId];
      var ts = m ? parseReleaseTs(m.releaseDateIso) : 0;
      if (ts && (!byGroup[g.groupId] || ts > byGroup[g.groupId])) byGroup[g.groupId] = ts;
    });
    recencyIndex = byGroup;
    return byGroup;
  }

  /* 1 = last ~6 months, 2 = 6-12 months, 0 = not trending.
     A date in the future lands in tier 1 on purpose: a handset announced for
     next month is the most current thing in the catalogue, and dropping it
     out of "latest" for being too new would be the wrong way round. */
  function trendTier(ts, now) {
    if (!ts) return 0;
    if (ts >= now - TREND_RECENT) return 1;
    if (ts >= now - TREND_WINDOW) return 2;
    return 0;
  }

  /* Round-robin across categories. Each bucket arrives already ordered, and
     a stable partition keeps it that way, so the result is one deterministic
     interleave rather than a shuffle that happens to look varied. */
  function mixByCategory(list) {
    var pos = Object.create(null);
    (db.categories || []).forEach(function (c, i) { pos[c.id] = i; });

    var buckets = Object.create(null), ids = [];
    list.forEach(function (g) {
      if (!buckets[g.categoryId]) { buckets[g.categoryId] = []; ids.push(g.categoryId); }
      buckets[g.categoryId].push(g);
    });
    ids.sort(function (a, b) {
      var ia = pos[a] == null ? 1e6 : pos[a], ib = pos[b] == null ? 1e6 : pos[b];
      return ia - ib || (a < b ? -1 : a > b ? 1 : 0);
    });

    var out = [];
    for (var i = 0; ; i++) {
      var any = false;
      for (var k = 0; k < ids.length; k++) {
        var b = buckets[ids[k]];
        if (i < b.length) { out.push(b[i]); any = true; }
      }
      if (!any) break;
    }
    return out;
  }

  function cmpNumber(a, b) {
    return a.groupNumber < b.groupNumber ? -1 : a.groupNumber > b.groupNumber ? 1 : 0;
  }

  /* How long the two carousels may be. Caps, not targets — with a narrow
     filter there may be three, and three is the right answer then. SUGGEST_MAX
     is even because that carousel is two rows deep and a dangling odd card
     leaves a hole in the bottom row. */
  var TRENDING_MAX = 18;
  var SUGGEST_MAX = 24;

  /* The ordered feed for one filter combination: the trending head, the rest
     in mixed order, and the total the header counts. Memoised, because the
     same combination is asked for again on every page of "show more". */
  var feedCache = Object.create(null);
  var feedKeys = [];
  var FEED_CACHE_MAX = 24;

  function orderedFeed(list, opts, key) {
    if (key && feedCache[key]) return feedCache[key];

    var rec = groupRecency();
    var now = Date.now();
    var want = opts.trending == null ? 0 : Math.max(0, opts.trending | 0);

    /* THE RANKING, used by every section.

       Compatibility count leads. A guard that fits 325 handsets is the single
       most useful row in the catalogue to a counter — it is the part you stock
       — and a two-device group is not more useful for having a newer phone in
       it. Recency breaks ties, and the group number breaks what is left, so
       the order is total and a reload cannot move anything. */
    function cmpValue(a, b) {
      var ca = a.compatibleCount || 0, cb = b.compatibleCount || 0;
      if (cb !== ca) return cb - ca;
      var ta = rec[a.groupId] || 0, tb = rec[b.groupId] || 0;
      if (tb !== ta) return tb - ta;
      return cmpNumber(a, b);
    }

    /* TRENDING is the same ranking inside the recency WINDOW: only groups with
       a phone from the last year are eligible, and the strongest of those lead.
       Recency is what makes the section trending; strength is what orders it.
       SUGGEST is the same ranking with no window at all — the strongest groups
       in the catalogue, whatever age. That is the whole difference between the
       two, and it is why a group never needs to appear in both. */
    var trending = [];
    if (want) {
      trending = list
        .filter(function (g) { return trendTier(rec[g.groupId] || 0, now); })
        .sort(cmpValue)
        .slice(0, want);
    }

    var taken = Object.create(null);
    trending.forEach(function (g) { taken[g.groupId] = 1; });

    var suggestWant = opts.suggest == null ? 0 : Math.max(0, opts.suggest | 0);
    var suggest = [];
    if (suggestWant) {
      suggest = list
        .filter(function (g) { return !taken[g.groupId]; })
        .sort(cmpValue)
        .slice(0, suggestWant);
      suggest.forEach(function (g) { taken[g.groupId] = 1; });
    }

    var rest = (want || suggestWant)
      ? list.filter(function (g) { return !taken[g.groupId]; })
      : list.slice();

    var sort = opts.sort || 'mixed';
    if (sort === 'most') rest.sort(function (a, b) { return b.compatibleCount - a.compatibleCount || cmpNumber(a, b); });
    else if (sort === 'least') rest.sort(function (a, b) { return a.compatibleCount - b.compatibleCount || cmpNumber(a, b); });
    else if (sort === 'az') rest.sort(function (a, b) {
      var na = (db.modelById[a.masterModelId] || {}).fullName || '';
      var nb = (db.modelById[b.masterModelId] || {}).fullName || '';
      return na.localeCompare(nb) || cmpNumber(a, b);
    });
    else if (sort === 'default') rest.sort(cmpNumber);
    else {
      /* 'mixed', the default: the ranking above WITHIN each category, then the
         categories interleaved, so a scroll passes a guard, a cover, a board,
         a battery rather than 709 covers before the first board — and inside
         each of those, the strongest group of its kind comes first. */
      rest.sort(cmpValue);
      rest = mixByCategory(rest);
    }

    var out = { trending: trending, suggest: suggest, rest: rest, total: list.length };
    if (key) {
      feedCache[key] = out;
      feedKeys.push(key);
      while (feedKeys.length > FEED_CACHE_MAX) delete feedCache[feedKeys.shift()];
    }
    return out;
  }

  /* The CDN-catalogue path: used when Firestore is unreachable, and always for
     free-text search, which Firestore cannot do without a token index. */
  function localListGroups(opts) {

    opts = opts || {};
    var q = norm(opts.q);
    var list = db.groups.filter(function (g) {
      if (opts.categoryId && opts.categoryId !== 'all' && g.categoryId !== opts.categoryId) return false;
      if (opts.brandId && opts.brandId !== 'all' && db.modelById[g.masterModelId].brandId !== opts.brandId) return false;
      if (opts.minCount && g.compatibleCount < opts.minCount) return false;
      if (q) {
        var cat = db.categoryById[g.categoryId];
        var hit = norm(g.groupNumber).indexOf(q) > -1 ||
          norm(g.partCode).indexOf(q) > -1 ||
          norm(g.serialNumber).indexOf(q) > -1 ||
          /* the part name is on screen above every card; typing it should find
             them rather than nothing */
          (cat && norm(cat.name).indexOf(q) > -1) ||
          norm(db.modelById[g.masterModelId].fullName).indexOf(q) > -1;
        /* Group text only. Matching on member names needs the member list,
           which the public catalogue does not carry — and leaking it one
           query at a time is still leaking it. */
        if (!hit && g.compatibleDeviceIds) {
          hit = g.compatibleDeviceIds.some(function (id) {
            return norm(db.modelById[id].fullName).indexOf(q) > -1;
          });
        }
        if (!hit) return false;
      }
      return true;
    });

    /* Ordering, the trending split and the mixed feed all happen in one
       memoised pass — see ORDERING above. Only the first page carries the
       trending row: "show more" is asking for more of the rest. */
    var feed = orderedFeed(list, opts, feedKeyFor(opts));

    var res = page(feed.rest, opts.page, opts.pageSize || 12);
    res.items = res.items.map(hydrate);
    /* The header counts everything the filter matches, trending included —
       dividing the display into two sections must not change the total. */
    res.total = feed.total;
    res.restTotal = feed.rest.length;
    res.trending = (opts.page || 1) === 1 ? feed.trending.map(hydrate) : [];
    res.suggest = (opts.page || 1) === 1 ? feed.suggest.map(hydrate) : [];
    res.hasMore = (opts.page || 1) * (opts.pageSize || 12) < feed.rest.length;
    return respond(res, LAT.normal);
  }

  /* One cache entry per filter combination. Everything that changes the order
     is in the key; nothing that does not is. */
  function feedKeyFor(o) {
    return [o.categoryId || 'all', o.brandId || 'all', o.sort || 'mixed',
            o.trending | 0, o.suggest | 0, o.minCount || 0, norm(o.q)].join('|');
  }

  /* ---------------------------------------------------------------- models
     THE NEWEST HANDSETS, and a spread of them.

     Ranked on the release date the importer stored — the same field Trending
     uses — so the strip refreshes itself as an import lands rather than
     needing a list kept by hand. A model with no usable date cannot be called
     new and is left out; it is still in /models with everything else.

     BALANCED, because strict date order is not what this section is for. The
     catalogue arrives in waves, so the twelve newest handsets are routinely
     eight Vivos and four Oppos — true, and useless as a look at what is new.
     Each brand offers its newest remaining phone in turn, so twelve cards are
     twelve brands where there are twelve to give. Inside a brand it is still
     strictly newest first, and the tie-break is the id, so the order is total.

     Only models the catalogue actually has parts for: this sits on the parts
     page and its one action is "find the parts", which has to lead somewhere. */
  var newModelCache = Object.create(null);

  function newModels(opts) {
    opts = opts || {};
    var cat = opts.categoryId && opts.categoryId !== 'all' ? opts.categoryId : null;
    var brand = opts.brandId && opts.brandId !== 'all' ? opts.brandId : null;
    var want = Math.max(1, (opts.limit | 0) || 12);
    var key = [cat || 'all', brand || 'all', want].join('|');
    if (newModelCache[key]) return newModelCache[key];

    var counts = db.partCountsByCategory || {};
    var pool = db.models.filter(function (m) {
      if (brand && m.brandId !== brand) return false;
      if (!parseReleaseTs(m.releaseDateIso)) return false;
      return groupCountFor(m.id, cat, counts) > 0;
    }).sort(function (a, b) {
      var ta = parseReleaseTs(a.releaseDateIso), tb = parseReleaseTs(b.releaseDateIso);
      if (tb !== ta) return tb - ta;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    /* Round-robin the date-ordered pool by brand. A stable partition keeps
       each brand's list newest-first, so every pick is still the newest thing
       that brand has left. */
    var byBrand = Object.create(null), order = [];
    pool.forEach(function (m) {
      if (!byBrand[m.brandId]) { byBrand[m.brandId] = []; order.push(m.brandId); }
      byBrand[m.brandId].push(m);
    });

    var out = [];
    for (var i = 0; out.length < want; i++) {
      var any = false;
      for (var k = 0; k < order.length && out.length < want; k++) {
        var list = byBrand[order[k]];
        if (i < list.length) { out.push(list[i]); any = true; }
      }
      if (!any) break;
    }

    newModelCache[key] = out;
    return out;
  }

  function groupCountFor(modelId, cat, counts) {
    if (cat) return (counts[modelId] && counts[modelId][cat]) || 0;
    /* The bundle ships counts, not ids — see src/data/dataset.js. */
    return (db.groupCountByModel && db.groupCountByModel[modelId]) || 0;
  }

  /* How many groups match, from the in-memory catalogue. Used so the header
     can say "3,340 groups" without paying for a Firestore aggregation. */
  function countGroups(opts) {
    return db.groups.filter(function (g) {
      if (opts.categoryId && opts.categoryId !== 'all' && g.categoryId !== opts.categoryId) return false;
      if (opts.brandId && opts.brandId !== 'all' && g.masterBrandId !== opts.brandId) return false;
      return true;
    }).length;
  }

  /* ------------------------------------------------------------------ read */
  var api = {
    stats: function () { return respond(db.stats, LAT.instant); },

    listBrands: function () { return respond(db.brands.slice(), LAT.fast); },

    getBrand: function (id) { return respond(db.brandById[id] || null, LAT.fast); },

    /* A name matches when it holds the whole query, or every word of it in any
       order ("a55 galaxy"), or the query with its spaces taken out
       ("redminote13"). `instant` is for a caller filtering what is already in
       memory, where the simulated round trip would only add a delay per
       keystroke. */
    listModels: function (opts) {
      opts = opts || {};
      var q = norm(opts.q);
      var words = q ? q.split(/\s+/) : [];
      var compact = q.replace(/[^a-z0-9]/g, '');
      var list = db.modelsRanked.filter(function (m) {
        if (opts.brandId && opts.brandId !== 'all' && m.brandId !== opts.brandId) return false;
        if (!q || m.search.indexOf(q) > -1) return true;
        if (compact && m.compact && m.compact.indexOf(compact) > -1) return true;
        return words.every(function (w) { return m.search.indexOf(w) > -1; });
      });
      if (opts.sort === 'az') list = list.slice().sort(function (a, b) { return a.fullName.localeCompare(b.fullName); });
      if (opts.sort === 'newest') list = list.slice().sort(function (a, b) { return b.releaseYear - a.releaseYear || a.fullName.localeCompare(b.fullName); });
      return respond(page(list, opts.page, opts.pageSize || 24), opts.instant ? LAT.instant : LAT.normal);
    },

    getModel: function (id) {
      var m = db.modelById[id];
      if (!m) return respond(null, LAT.fast);
      /* The public catalogue ships counts per category and withholds the group
         ids, so `groupCountByModel` is the only figure available here — and
         the only one that was ever free. */
      var counts = db.partCountsByCategory && db.partCountsByCategory[m.id];
      /* Empty in the public catalogue, which is what makes every count below
         fall back to `counts`. Never drop this line on the grounds that the
         map is empty: without it the .filter() below is a ReferenceError, and
         that took down every /model/<id> page from 20 September 2026. */
      var gids = db.groupsByModel[id] || [];
      return respond({
        model: m,
        groupCount: (db.groupCountByModel && db.groupCountByModel[m.id]) || 0,
        categories: db.categories.map(function (c) {
          /* Groups this model sits in for this category. Derived from the same
             membership index the rest of the app uses - there is no second
             compatibility engine here. */
          var mine = gids.filter(function (gid) {
            var g = db.groupById[gid];
            return g && g.categoryId === c.id;
          });
          return {
            category: c,
            count: counts ? (counts[c.id] || 0) : mine.length,
            /* How many DISTINCT handsets those groups cover, this model
               included - the number a counter wants ("this cover fits 6
               phones"), not a count of product records. Zero when the public
               catalogue withholds membership, so the caller can hide it. */
            modelCount: mine.reduce(function (n, gid) {
              var g = db.groupById[gid];
              return n + ((g && g.compatibleCount) || 0);
            }, 0)
          };
        })
      }, LAT.fast);
    },

    /* live search suggestions — kept deliberately quick */
    suggestModels: function (q, limit) {
      q = norm(q);
      if (!q) return respond([], LAT.instant);
      var compact = q.replace(/[^a-z0-9]/g, '');
      var starts = [], contains = [];
      for (var i = 0; i < db.modelsRanked.length; i++) {
        var m = db.modelsRanked[i];
        var f = norm(m.fullName), n = norm(m.modelName);
        if (f.indexOf(q) === 0 || n.indexOf(q) === 0) starts.push(m);
        else if (f.indexOf(q) > -1 || m.search.indexOf(compact) > -1) contains.push(m);
        if (starts.length >= (limit || 8)) break;
      }
      return respond(starts.concat(contains).slice(0, limit || 8), LAT.fast);
    },

    /* Reads from Firestore when it is available, and from the CDN catalogue
       when it is not — same records either way, since the bundle is built from
       the same export the importer writes.

       Firestore is the source of truth: a group edited in the console shows up
       on the next page load without rebuilding anything. It is paged with a
       cursor, so a page costs twelve document reads rather than the 3,340 a
       whole-collection read would bill.

       Free-text search stays local. Firestore cannot do substring matching, so
       "pura 80" would need either a token index per query or reading the
       collection to filter it — the first is a schema for one feature, the
       second is 3,340 reads per keystroke. */
    listGroups: function (opts) {
      opts = opts || {};
      var q = norm(opts.q);

      /* The Firestore path is switched OFF.
         /groups is closed to clients in firestore.rules, because the documents
         there carry memberIds — the fitment list the free/paid split meters —
         and a rule cannot withhold one field of a document.

         The local catalogue serves the identical public data (identity, codes,
         category, master, member count) and pages it the same way, so nothing
         is lost. Skipping the call rather than letting it fail keeps a
         permission-denied warning off every finder load.

         Reopening it: narrow the /groups write in scripts/import-firestore.js
         (done), re-import so the stored documents are thin, reopen the rule,
         then delete this flag. */
      var FIRESTORE_GROUPS_OPEN = false;

      if (FIRESTORE_GROUPS_OPEN && !q && SM.store && SM.store.available()) {
        return SM.store.listGroups({
          categoryId: opts.categoryId,
          brandId: opts.brandId,
          sort: opts.sort,
          limit: opts.pageSize || 12,
          cursor: opts.cursor || null
        }).then(function (r) {
          return {
            /* HYDRATED, like every other path. The Firestore branch used to
               return raw group records straight to the UI while the catalogue
               branch returned {group, category, master, devices} — so C.plate
               read `master.brandId` off undefined and the whole results list
               threw. It happens on any finder view with no search text, which
               is the default one. Same records, same shape, one renderer. */
            items: r.items.map(hydrateRemote).filter(Boolean),
            cursor: r.cursor,
            hasMore: r.hasMore,
            /* The total comes from the catalogue counts rather than a COUNT
               query — Firestore bills aggregation too, and the figure is the
               same. */
            total: countGroups(opts),
            source: 'firestore'
          };
        }).catch(function (err) {
          /* Offline or a rules change should degrade to the local catalogue,
             not to an empty page. */
          console.warn('[groups] firestore read failed, using catalogue:', err && err.code);
          return localListGroups(opts);
        });
      }
      return localListGroups(opts);
    },

    listGroupsLocal: function (opts) { return localListGroups(opts); },

    /* How long the two carousels may be. Exposed rather than buried in the
       renderer so their length is a data decision, not a number typed into a
       template — and SUGGEST_MAX is even, because that row is two deep. */
    trendingMax: function () { return TRENDING_MAX; },
    suggestMax: function () { return SUGGEST_MAX; },

    /* The newest handsets in the catalogue, spread across brands. */
    newModels: function (opts) { return respond(newModels(opts), LAT.fast); },


    getGroup: function (groupId) {
      var g = db.groupById[groupId];
      return respond(g ? hydrate(g) : null, LAT.fast);
    },

    /* ------------------------------- the core Device Finder lookup: ASK THE
       SERVER

       model (+ optional category) -> the groups that fit it.

       THIS USED TO BE A LOCAL MAP READ. db.groupsByModel came out of
       assets/dataset.json, which is a public file, and inverting it gave
       anybody every group's full member list -- so the paywall the rest of
       this file describes was decorative. The bundle now ships per-category
       counts only and this asks /api/device-parts, which reads the caller's
       subscription from Firestore before it answers:

         subscriber  every group, every member
         free        every group's IDENTITY and size, and no members at all
         signed out  the same as free

       The withheld names are not in the response. There is nothing here to
       filter, hide or unhide -- the rows do not arrive.

       The group's display fields still come from the local catalogue, because
       they are public and already loaded: number, serial, part code, category,
       master model. The server supplies which groups, and who is in them.

       @returns {Promise<Array>} rows in the shape hydrate() produces. The
       array carries `.unavailable = true` when the server could not answer,
       which the caller MUST render differently from an empty result: "we
       could not load this" and "this device has no parts" are opposite
       statements and only one of them is ever true at a time. */
    findMatches: function (opts) {
      opts = opts || {};
      var order = {};
      db.categories.forEach(function (c, i) { order[c.id] = i; });

      var wanted = opts.categoryId && opts.categoryId !== 'all' ? opts.categoryId : null;

      if (!SM.access || !SM.access.deviceGroups) {
        var none = [];
        none.unavailable = true;
        return Promise.resolve(none);
      }

      return SM.access.deviceGroups(opts.modelId).then(function (device) {
        if (device && device.unavailable) {
          var out0 = [];
          out0.unavailable = true;
          return out0;
        }
        if (!device || !device.categories) return [];

        var rows = [];
        device.categories.forEach(function (cat) {
          if (wanted && cat.categoryId !== wanted) return;
          (cat.groups || []).forEach(function (sg) {
            var row = rowFromServerGroup(sg);
            if (row) rows.push(row);
          });
        });

        /* canonical part order first (glass, cover, display, ...), then no. */
        rows.sort(function (a, b) {
          return (order[a.group.categoryId] - order[b.group.categoryId]) ||
            String(a.group.groupNumber).localeCompare(String(b.group.groupNumber));
        });
        return rows;
      });
    },

    /* per-category availability for the selected model (drives the chips) */
    /* How many parts exist per category for one device.
       Counts are free — "this phone has a back cover and a battery listed" is
       what makes the product worth paying for. WHICH groups they are is the
       paid answer, so this reads the count map the public catalogue ships and
       falls back to counting real memberships when the full data is loaded. */
    categoryAvailability: function (modelId) {
      var byCat = Object.create(null);
      var counts = db.partCountsByCategory && db.partCountsByCategory[modelId];

      /* One source now. The membership scan that used to stand behind this
         counted a map the bundle no longer ships, so it could only ever have
         returned zero — and a silent zero reads as "no parts for this device",
         which is the opposite of what the chips are for. */
      if (counts) byCat = counts;
      return respond(db.categories.map(function (c) {
        return { category: c, count: byCat[c.id] || 0 };
      }), LAT.fast);
    }
  };

  /* Group card previews are no longer built here. The device names on a
     home-feed card come from /api/device-parts?previews= through
     SM.access.previews — a handful per group, chosen on the server, the same
     for every caller — because the public bundle carries no member lists to
     build them from. The local helpers that read db.membersByGroup (always
     empty since the fitment list left the bundle) were removed with it. */

  SM.api = api;

  /* ==========================================================================
     Session + subscription.

     The session is DERIVED, never stored as a status. Only the signed-in
     Google `sub` is persisted; everything the UI shows is recomputed from the
     stored profile each time, so the account state is always correct:

        no signed-in identity           -> guest
        identity, no subscription       -> free
        identity, subscription running  -> pro
        identity, subscription lapsed   -> expired

     Because the derivation reads the clock, expiry happens on its own — there
     is no state for anyone to flip by hand.
     ========================================================================== */
  var SESSION_KEY = 'mpf.session.v2';
  var DAY = 86400000;
  var PLAN_DAYS = { monthly: 30, yearly: 365 };

  function readSub() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch (e) { return null; }
  }
  function writeSub(sub) {
    try {
      if (sub) localStorage.setItem(SESSION_KEY, JSON.stringify(sub));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* private mode */ }
  }
  function fmtDate(d) {
    var mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getDate() + ' ' + mo[d.getMonth()] + ' ' + d.getFullYear();
  }

  /* What the ACCOUNT SCREEN says about this account, from the copy of the
     server's answer this browser holds. It draws a badge and a plan card; it
     grants nothing — what the shop may open is decided per request, on the
     server, by /api/access and /api/device-parts.

     Lifetime has no expiry date, so "has an expiry in the future" is not the
     test for it: the server says `lifetime`, and that is what is read. */
  function deriveStatus(profile) {
    if (!profile) return 'guest';
    var s = profile.subscription;
    if (!s) return 'free';
    if (s.lifetime) return 'pro';
    if (!s.expiresAt) return 'free';
    return Date.now() < s.expiresAt ? 'pro' : 'expired';
  }

  var GUEST = { status: 'guest', signedIn: false, name: '', email: '', profile: null, sub: null, subscription: null };

  function buildSession() {
    var sub = readSub();
    var profile = sub ? SM.auth.findProfile(sub) : null;
    if (!profile) return Object.assign({}, GUEST);

    var s = profile.subscription || null;
    var view = {
      status: deriveStatus(profile), signedIn: true, sub: sub, profile: profile,
      name: profile.shopName || profile.googleName || 'My shop',
      shopName: profile.shopName || '',
      proprietor: profile.proprietor || '',
      email: profile.email || '',
      picture: profile.picture || '',
      photo: profile.photo || '',
      /* The dial code is missing whenever the profile came back from Firestore
         rather than from the sign-up form, and concatenating it blindly put a
         leading space in front of every returning user's number. */
      mobile: profile.mobile
        ? (profile.dial ? profile.dial + ' ' + profile.mobile : String(profile.mobile))
        : '',
      since: profile.createdAt ? fmtDate(new Date(profile.createdAt)) : '',
      subscription: null, plan: null, renewsOn: null
    };
    if (s && s.lifetime) {
      /* No term, no meter, no renewal: there is no end date to count down to.
         Granted by the business, never bought, and only it can withdraw it. */
      view.plan = 'lifetime';
      view.subscription = {
        plan: 'lifetime',
        lifetime: true,
        source: s.source || 'admin_manual',
        startedAt: s.startedAt || null, expiresAt: null,
        cancelledAt: null,
        startLabel: s.startedAt ? fmtDate(new Date(s.startedAt)) : '',
        endLabel: 'Never',
        daysLeft: null, daysTotal: null, pctLeft: 100,
        active: true,
        willRenew: false
      };
    } else if (s && s.expiresAt) {
      var total = Math.max(1, s.expiresAt - s.startedAt);
      var left = s.expiresAt - Date.now();
      view.plan = s.plan;
      view.subscription = {
        plan: s.plan,
        lifetime: false,
        source: s.source || 'payment',
        startedAt: s.startedAt, expiresAt: s.expiresAt,
        cancelledAt: s.cancelledAt || null,
        startLabel: fmtDate(new Date(s.startedAt)),
        endLabel: fmtDate(new Date(s.expiresAt)),
        daysLeft: Math.max(0, Math.ceil(left / DAY)),
        daysTotal: Math.round(total / DAY),
        pctLeft: Math.max(0, Math.min(100, (left / total) * 100)),
        active: left > 0,
        willRenew: !s.cancelledAt
      };
      view.renewsOn = view.subscription.endLabel;
    }
    return view;
  }

  var current = buildSession();
  var listeners = [];
  function emit() { listeners.forEach(function (fn) { fn(current); }); }
  function refresh() { current = buildSession(); emit(); return current; }

  /* Completes a sign-in once the profile question is settled. Writes the
     registration to Firestore when there is one, so the record exists for
     every other device before the user goes anywhere near checkout. */
  /* ---------------------------------------------------- canonical identity

     ONE place decides who the signed-in user is. Sign-in, session restore and
     a page reload all come through here, so the Sign in page and the Create
     account page cannot drift into different answers.

     users/{uid} is the truth. The local copy exists so the account screen can
     paint before the network answers — it is a cache, and a cache that
     disagrees with the server is wrong by definition.

     This is the bug it fixes: a profile written on one device before the
     Firestore layer existed lived only in that browser. The desktop kept
     showing it forever because nothing ever compared it with the server, so
     one Google account appeared as two different shops. The cache now carries
     the uid it belongs to and is overwritten by whatever users/{uid} says.

     @param {object} fbUser  the Firebase user, already resolved
     @returns {Promise<{profile:object|null, complete:boolean, isNew:boolean}>}
  */
  /* ------------------------------------------------ one resolution per account

     Sign-in reaches this from two places at once: the auth listener repaints
     the account screen, which resolves identity, and the popup's own promise
     resolves it again. Each call used to run the whole thing — a server
     profile-sync (two reads and a write) and a browser profile read — so one
     tap on "Continue with Google" cost twice what it needed to. Every caller
     now shares the resolution already running, or already finished, for the
     same account.

     A failed resolution is NOT kept. "Try again" has to actually ask again,
     and remembering an outage would turn a thirty-second blip into a broken
     account for the rest of the page's life. */
  var resolution = { uid: null, promise: null };

  function forgetResolution() { resolution = { uid: null, promise: null }; }

  /* When this device last had the server's subscription answer, per account.
     The answer itself lives in the session profile (mpf.profiles.v1); this is
     only when it was fetched. */
  var SERVER_SYNC_KEY = 'mpf.subsync.v1';
  function serverSyncFresh(uid, maxAgeMs) {
    try {
      var s = JSON.parse(localStorage.getItem(SERVER_SYNC_KEY) || 'null');
      var age = s && s.uid === uid ? Date.now() - s.at : -1;
      return age >= 0 && age < maxAgeMs;
    } catch (e) { return false; }
  }
  function markServerSync(uid) {
    try { localStorage.setItem(SERVER_SYNC_KEY, JSON.stringify({ uid: uid, at: Date.now() })); }
    catch (e) { /* private mode: every load asks */ }
  }
  function forgetServerSync() {
    try {
      localStorage.removeItem(SERVER_SYNC_KEY);
      sessionStorage.removeItem(SERVER_SYNC_KEY);   /* the first version's copy */
    } catch (e) { /* private mode */ }
  }

  /* How stale lastLoginAt may get before a sign-in refreshes it. It is an
     admin-facing "last seen", not an audit log, and stamping it on every page
     load was a Firestore write per page per signed-in shop. */
  var LOGIN_STAMP_MS = 24 * 3600 * 1000;

  /* A page load inside this window reuses this device's copy of the profile
     instead of reading users/{uid} again. The profile changes when the shop
     edits it — and an edit made HERE updates the copy — so the only thing the
     window delays is an edit made on another device showing up on this one.
     Six hours bounds that to within a working day, for at most a few reads a
     day per shop instead of one per page. */
  var PROFILE_REUSE_MS = 6 * 3600 * 1000;

  /* The same for the subscription answer. Shorter, because it changes when a
     payment lands — and a payment made on THIS device refreshes it at once
     (subscribe() and cancel() always ask). Expiry needs no read at all: the
     session re-derives it from expiresAt against the clock. */
  var SUBSCRIPTION_REUSE_MS = 30 * 60 * 1000;

  function initializeAuthenticatedUser(fbUser, opts) {
    if (!fbUser) {
      SM.debug.log('identity', 'no user to initialise');
      return Promise.resolve({ profile: null, complete: false, isNew: false });
    }
    var force = !!(opts && opts.force);
    if (!force && resolution.uid === fbUser.uid && resolution.promise) {
      SM.debug.log('identity', 'joining the resolution already under way', { uid: fbUser.uid });
      return resolution.promise;
    }

    var p = resolveAccount(fbUser, opts || {}).then(function (r) {
      if (r && r.offline && resolution.promise === p) forgetResolution();
      return r;
    });
    resolution = { uid: fbUser.uid, promise: p };
    return p;
  }

  /* The profile-sync call, reported rather than thrown: the caller decides
     whether its failure matters. */
  function serverSync(fbUser) {
    if (!SM.billing) return Promise.resolve(null);
    return SM.billing.syncProfile({ photoURL: fbUser.photoURL || null })
      .then(function (r) {
        SM.debug.log('identity', 'profile-sync ' + (r.created ? 'created' : 'updated'),
                     { uid: r.uid, complete: r.profileCompleted, missing: r.missing });
        return r;
      })
      .catch(function (err) {
        SM.debug.warn('identity', 'profile-sync failed', {
          status: err && err.status, error: err && err.message
        });
        return null;
      });
  }

  function resolveAccount(fbUser, opts) {
    var uid = fbUser.uid;
    SM.debug.log('identity', 'initialising', { uid: uid, email: fbUser.email || null });

    if (!SM.store || !SM.store.available()) {
      SM.debug.warn('identity', 'firestore unavailable — profile cannot be resolved');
      return Promise.resolve({ profile: null, complete: false, isNew: false, offline: true });
    }

    /* READ FIRST, WRITE ONLY WHEN THERE IS SOMETHING TO WRITE.

       This used to call /api/profile-sync before every read, on every page
       load: two server reads and a write of lastLoginAt/updatedAt, whether or
       not anything had changed, for every signed-in shop on every page. Now
       the profile is read once, and the server is asked to write only when

         · there is no document — a genuinely new account. The sync is what
           makes users/{uid} exist, with the server-owned fields (opening
           subscriptionStatus, accountStatus) written by the only party allowed
           to write them. It is awaited, so the sign-up form that follows is
           completing a record that already exists.
         · lastLoginAt is more than a day old, or absent — a returning shop.
           Fired and not awaited: nothing on screen depends on it.

       The Google account's email is re-sent in that same sync, so a changed
       address still reaches the record within a day. */
    return SM.store.loadProfile(uid, opts.reuse ? { maxAgeMs: PROFILE_REUSE_MS } : null).then(function (remote) {
      if (!remote) {
        /* No record yet. Create it server side, then report a new account —
           there are no shop details to read back, so there is no second read. */
        return serverSync(fbUser).then(function () { return null; });
      }
      var stamp = remote.lastLoginAt || 0;
      if (!stamp || Date.now() - stamp > LOGIN_STAMP_MS) {
        serverSync(fbUser).then(function (r) {
          if (r && SM.store.forgetProfile) SM.store.forgetProfile();
        });
      }
      return remote;
    }).then(function (remote) {
      var cached = SM.auth.findProfile(uid);

      /* A cached profile belonging to a different account must never be shown.
         Signing in as someone else on a shared counter machine would otherwise
         display the previous shop's details. */
      if (cached && cached.uid && cached.uid !== uid) cached = null;

      if (remote) {
        /* The dial code is not stored — countryCode is — so it is looked up
           again here. Without it the account page shows a bare number for
           every user whose profile came back from Firestore rather than from
           the form they filled in on this device. */
        var rc = SM.countries.byCode(remote.countryCode) || {};
        SM.auth.saveProfile(uid, {
          uid: uid,
          email: remote.email || fbUser.email,
          googleName: remote.googleDisplayName || fbUser.displayName || '',
          picture: remote.profilePhotoURL || fbUser.photoURL || '',
          shopName: remote.mobileShopName,
          proprietor: remote.proprietorName,
          mobile: remote.mobileNumber,
          dial: rc.dial || null,
          country: remote.countryCode,
          countryName: remote.country,
          address: remote.address,
          /* The day the shop joined, as Firestore records it. Without carrying
             it across, the account page showed no "member since" for anyone
             whose profile was loaded rather than created on this device. */
          createdAt: remote.createdAt || null
        });
      } else if (cached) {
        /* Firestore has nothing and this browser does: the profile predates
           the server layer. Push it up so every other device gets it, rather
           than making the shop type it all again. Only ever an upload of real
           data the user already entered — nothing is invented. */
        if (cached.shopName && cached.proprietor) {
          SM.debug.log('identity', 'migrating a local-only profile to Firestore', { uid: uid });
          SM.store.saveProfile(uid, {
            mobileShopName: cached.shopName,
            proprietorName: cached.proprietor,
            mobileNumber: cached.mobile || '',
            country: cached.countryName || '',
            countryCode: cached.country || '',
            address: cached.address || null
          }, fbUser).catch(function (e) {
            SM.debug.warn('identity', 'local profile migration failed', { code: e && e.code });
          });
        }
      }

      writeSub(uid);
      refresh();

      var p = remote || cached;
      var complete = !!(p && (p.profileCompleted ||
        ((p.mobileShopName || p.shopName) && (p.proprietorName || p.proprietor) && (p.mobileNumber || p.mobile))));
      SM.debug.log('identity', 'resolved', {
        uid: uid, source: remote ? 'firestore' : (cached ? 'local-cache' : 'none'), complete: complete
      });
      return { profile: p || null, complete: complete, isNew: !remote && !cached };
    }).catch(function (err) {
      SM.debug.warn('identity', 'profile load failed', { code: err && err.code, message: err && err.message });
      refresh();
      return {
        profile: SM.auth.findProfile(uid) || null, complete: false, isNew: false,
        offline: true,
        /* Carried through so the account screen can say whether the database
           refused or the phone did. Without it every read failure read as
           "check your connection", which was false for the one that was
           actually happening. */
        outage: SM.isBackendOutage(err),
        reason: (err && err.code) || (err && err.message) || null
      };
    });
  }
  SM.session_initializeAuthenticatedUser = initializeAuthenticatedUser;

  /* ------------------------------------------------------- outage, not you

     Firestore can fail for two completely different reasons, and the account
     screen has to be able to tell them apart because the sentence it shows is
     different in each case.

       the READER is offline    — their phone has no signal. Retrying works.
       the DATABASE is refusing — the project's billing is disabled, the quota
                                  is spent, the database does not exist, the
                                  service is down. Retrying cannot work, and
                                  nothing about their phone is wrong.

     The second one is what this deployment actually hit: Firestore answered
     every request, from the browser AND from the Admin SDK, with
     `7 PERMISSION_DENIED — This API method requires billing to be enabled`.
     The browser reported that as "Check the connection and try again", so a
     shop owner sat re-entering their shop details into a form that could never
     have saved them, on a connection that was working perfectly.

     TELLING THEM APART

       · a SERVER reply of any kind proves the connection works, so an HTTP 5xx
         is the site's fault by definition. 503 datastore-unavailable says so
         outright — see api/_lib/http.js.
       · the Firestore SDK's own codes below all mean the backend answered and
         refused. `unavailable` is the one billing produces, after the SDK has
         retried the 403 to exhaustion.
       · navigator.onLine breaks the remaining tie. It is unreliable as proof
         that a connection WORKS, but a browser saying it is offline is worth
         believing, and that is the only direction it is used in here. */
  var DATASTORE_CODES = {
    'unavailable': 1, 'permission-denied': 1, 'resource-exhausted': 1,
    'failed-precondition': 1, 'internal': 1, 'not-found': 1,
    'unauthenticated': 1, 'deadline-exceeded': 1
  };

  /** A Firestore SDK rejection that means the backend refused, not the phone. */
  function firestoreOutage(err) {
    return !!(err && err.code && DATASTORE_CODES[String(err.code)]);
  }

  /** An /api/* rejection that means the server answered and broke. */
  function serverOutage(err) {
    return !!(err && typeof err.status === 'number' && err.status >= 500);
  }

  function browserOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }
  SM.isBackendOutage = function (err) {
    return !browserOffline() && (firestoreOutage(err) || serverOutage(err));
  };

  /* ------------------------------------------------- registration, persisted

     Writes the new shop's profile and RESOLVES ONLY WHEN FIRESTORE HAS IT.

     This is the bug the account-creation flow was built on. Both writes used to
     be fired and forgotten — `.catch()` on each, nothing awaited — and the
     caller returned "Account created — welcome" a fixed 190 ms later whether
     either had landed or not. A rejected write (a rules change, an offline
     moment, an unauthorised domain) left a shop that existed in localStorage
     and nowhere else: complete on that screen, absent on every other device,
     and asked to sign up again the next time.

     Two paths, because they fail for different reasons and rarely together:
     the server write goes through the Admin SDK so no security rule can refuse
     it, and the direct write needs no backend. EITHER landing is a real
     profile. Only if BOTH fail is this a failure, and then it says so instead
     of pretending.

     @returns {Promise<object|null>} the stored profile, read back from Firestore
  */
  function persistRegistration(identity, registration) {
    var c = SM.countries.byCode(registration.country) || {};
    var digits = String(registration.mobile || '').replace(/\D/g, '');
    var shop = {
      mobileShopName: registration.shopName,
      proprietorName: registration.proprietor,
      /* Exactly what the user typed. An absent number stays absent — it is how
         checkout knows to ask — and inventing one would put a fabricated
         number on a real invoice. */
      mobileNumber: registration.mobile,
      mobileNumberE164: c.dial && digits ? '+' + String(c.dial).replace(/\D/g, '') + digits : '',
      country: c.name || registration.countryName,
      countryCode: registration.country,
      address: registration.address || null
    };

    var serverOk = false, clientOk = false;
    /* Set when a path failed in a way that is the SITE's fault rather than the
       reader's connection — see SM.isBackendOutage above. */
    var serverDown = false, clientDown = false;
    var reasons = [];

    /* The server first, and the browser only if the server could not.

       Both used to run every time, in parallel, so one registration cost two
       writes of the same document and five reads (the server's read and
       read-back, the browser's read and read-back, and the final read below).
       The server path is the better one — rules cannot refuse it and it owns
       the server fields — so it goes alone, and the direct write remains
       exactly what it was meant to be: the way through when the API is down. */
    var viaServer = SM.billing
      ? SM.billing.syncProfile({ photoURL: identity.picture || null, profile: shop })
          .then(function (r) {
            serverOk = true;
            SM.debug.log('signup', 'profile written server side', { uid: r.uid, complete: r.profileCompleted });
            return r;
          }, function (e) {
            if (serverOutage(e)) serverDown = true;
            reasons.push('server: ' + ((e && e.message) || 'unreachable'));
            SM.debug.warn('signup', 'server profile write failed',
                          { status: e && e.status, error: e && e.message });
            return null;
          })
      : Promise.resolve(null);

    var viaClient = viaServer.then(function () {
      if (serverOk) return null;
      if (!(SM.store && SM.store.available() && SM.fb.user())) return null;
      return SM.store.saveProfile(identity.sub, shop, SM.fb.user())
        .then(function (p) {
          clientOk = true;
          SM.debug.log('signup', 'profile written from the browser', { uid: identity.sub });
          return p;
        }, function (e) {
          if (firestoreOutage(e)) clientDown = true;
          reasons.push('client: ' + ((e && e.code) || (e && e.message) || 'failed'));
          SM.debug.warn('signup', 'direct profile write failed', { code: e && e.code });
          return null;
        });
    });

    return viaClient.then(function (clientProfile) {
      if (!serverOk && !clientOk) {
        var err = new Error('profile-save-failed');
        err.code = 'profile-save-failed';
        err.reasons = reasons;
        /* Both halves failed. `outage` says whether that was the database
           refusing or the reader's connection dropping, so the account screen
           can stop telling people to check a connection that is fine. */
        err.outage = !browserOffline() && (serverDown || clientDown);
        throw err;
      }
      /* The profile is about to be different, so whatever this page resolved
         for the account before it is out of date. */
      forgetResolution();

      /* The direct write already returns the stored document. */
      if (clientProfile) return clientProfile;

      /* Read it back rather than trusting the write. What the account screen
         shows is then the document as Firestore actually holds it. */
      return SM.store.loadProfile(identity.sub).catch(function (e) {
        SM.debug.warn('signup', 'profile saved but could not be read back', { code: e && e.code });
        return null;
      });
    });
  }

  /* Completes a sign-in once the profile question is settled.

     Always returns a promise. For a registration it settles only after
     Firestore has the record — the local cache is written afterwards, from
     what came back, so the cache can never be ahead of the server. */
  function finishSignIn(identity, registration, profile) {
    var existing = profile || SM.auth.findProfile(identity.sub);

    if (!registration) {
      if (identity.email && existing && existing.email !== identity.email) {
        SM.auth.saveProfile(identity.sub, { email: identity.email });
      }
      writeSub(identity.sub);
      refresh();
      return respond({
        session: current, isNew: !existing,
        restored: !!(existing && existing.subscription)
      }, LAT.normal);
    }

    return persistRegistration(identity, registration).then(function (stored) {
      /* Cache AFTER the server confirmed, and prefer the stored document's own
         values over the form's. */
      SM.auth.saveProfile(identity.sub, {
        uid: identity.sub,
        email: (stored && stored.email) || identity.email,
        googleName: identity.name,
        picture: (stored && stored.profilePhotoURL) || identity.picture,
        shopName: (stored && stored.mobileShopName) || registration.shopName,
        proprietor: (stored && stored.proprietorName) || registration.proprietor,
        mobile: (stored && stored.mobileNumber) || registration.mobile,
        country: (stored && stored.countryCode) || registration.country,
        countryName: (stored && stored.country) || registration.countryName,
        dial: registration.dial,
        address: (stored && stored.address) || registration.address || null,
        createdAt: (stored && stored.createdAt) || Date.now(),
        subscription: null
      });

      writeSub(identity.sub);
      refresh();
      return { session: current, isNew: !existing, profile: stored, saved: true };
    });
  }

  /* keep the derived state honest while the tab stays open */
  setInterval(function () {
    var was = current.status;
    var now = buildSession();
    if (now.status !== was) { current = now; emit(); }
  }, 30000);

  SM.session = {
    get: function () { return current; },
    refresh: refresh,
    isPro: function () { return current.status === 'pro'; },
    canSubscribe: function () { return current.signedIn; },
    onChange: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },

    /* Known identity -> restores the profile and whatever subscription it
       holds, re-derived against the clock.
       New identity   -> reports needsRegistration; nothing is written until
       the profile is completed, so one Google account can never end up with
       two records. */
    /* Firestore decides who this is, not the browser.
       users/{uid} is read FIRST, so the same Google account on a second device
       finds the same profile instead of looking like a new shop. The local
       copy is refreshed from it and used only as a cache afterwards. */
    /* The one identity entry point. Every screen and both auth pages use it. */
    /* opts.reuse  accept this tab's recent copy of the profile (boot only)
       opts.force  ignore any resolution already made for this account */
    initializeAuthenticatedUser: function (fbUser, opts) { return initializeAuthenticatedUser(fbUser, opts); },

    signInWithGoogle: function (identity, registration) {
      /* Identity resolution read this document moments ago; its copy is
         reused rather than read a second time on the way into the form. */
      var remote = (SM.store && SM.store.available())
        ? SM.store.loadProfile(identity.sub, { maxAgeMs: PROFILE_REUSE_MS }).catch(function (e) {
            console.warn('[auth] profile read failed', e && e.code);
            return null;                      /* fall back to the local copy */
          })
        : Promise.resolve(null);

      return remote.then(function (profile) {
        /* Mirror the stored profile down so every screen sees it immediately. */
        if (profile) {
          SM.auth.saveProfile(identity.sub, {
            email: profile.email || identity.email,
            googleName: profile.googleDisplayName || identity.name,
            picture: profile.profilePhotoURL || identity.picture,
            shopName: profile.mobileShopName,
            proprietor: profile.proprietorName,
            mobile: profile.mobileNumber,
            country: profile.countryCode,
            countryName: profile.country,
            address: profile.address
          });
        }

        /* Incomplete counts as needing registration — but the form is
           pre-filled from whatever the record already holds, and the missing
           fields are never invented. */
        if ((!profile || !profile.profileCompleted) && !registration) {
          return respond({
            needsRegistration: true,
            identity: identity,
            existing: profile || null
          }, LAT.normal);
        }

        return finishSignIn(identity, registration, profile);
      });
    },

    _legacySignIn: function (identity, registration) {
      var existing = SM.auth.findProfile(identity.sub);
      if (!existing && !registration) {
        return respond({ needsRegistration: true, identity: identity }, LAT.normal);
      }
      if (!existing) {
        SM.auth.saveProfile(identity.sub, Object.assign({
          email: identity.email, googleName: identity.name, picture: identity.picture,
          createdAt: Date.now(), subscription: null
        }, registration));
      } else if (identity.email && existing.email !== identity.email) {
        SM.auth.saveProfile(identity.sub, { email: identity.email });
      }
      writeSub(identity.sub);
      refresh();
      return respond({
        session: current, isNew: !existing,
        restored: !!(existing && existing.subscription)
      }, LAT.normal);
    },

    /* Signing out has to end the Firebase session too. Clearing only the local
       record leaves a live ID token behind, so the next billing call would
       still authenticate as the user who just signed out. */
    /* Everything this browser holds for the signed-in account, dropped —
       without touching Firebase. For when Firebase has already said nobody is
       signed in and the local copy is simply out of date. */
    forgetLocal: function () {
      if (current.sub && SM.auth.forgetProfile) SM.auth.forgetProfile(current.sub);
      writeSub(null);
      forgetResolution();
      forgetServerSync();
      if (SM.store && SM.store.forgetProfile) SM.store.forgetProfile();
      refresh();
      return current;
    },

    signOut: function () {
      /* Nothing resolved or copied for this account may outlive it — the
         shop details included, on a machine the next person will use. */
      if (current.sub && SM.auth.forgetProfile) SM.auth.forgetProfile(current.sub);
      writeSub(null);
      forgetResolution();
      forgetServerSync();
      if (SM.store && SM.store.forgetProfile) SM.store.forgetProfile();
      var done = (SM.fb && SM.fb.isConfigured())
        ? SM.fb.signOut().catch(function () { /* already gone is fine */ })
        : Promise.resolve();
      return done.then(function () { refresh(); return current; });
    },

    updateProfile: function (patch) {
      if (!current.sub) return respond({ error: 'not-signed-in' }, LAT.fast);
      SM.auth.saveProfile(current.sub, patch);
      refresh();
      return respond({ ok: true, session: current }, LAT.normal);
    },

    /* True once Firebase Auth and the billing API are wired up. Until then the
       local sample path below runs instead, and the UI says so — a pretend
       subscription is fine for a prototype and unacceptable once real money is
       involved, so the two are kept strictly apart. */
    hasPaymentBackend: function () {
      return !!(SM.fb && SM.fb.isConfigured() && SM.billing);
    },

    /* Pulls the SERVER's record of access into the session.
       The expiry is decided by the server clock, so a device set forward
       cannot extend a subscription, and localStorage becomes a cache of the
       server's answer rather than the answer itself. */
    /* `opts.reuse` (or an explicit `opts.maxAgeMs`): boot passes it so a page
       load within SUBSCRIPTION_REUSE_MS of the last answer reuses it — the
       local session already holds that answer. Payment and cancellation call
       this with no options and always ask. The server enforces access on
       every paid request regardless, so a copy some minutes old can only ever
       affect what the account page SAYS. */
    syncFromServer: function (opts) {
      if (!this.hasPaymentBackend() || !current.signedIn) return Promise.resolve(current);
      var uid = current.sub;
      var maxAge = opts && (opts.maxAgeMs || (opts.reuse ? SUBSCRIPTION_REUSE_MS : 0));
      if (maxAge && serverSyncFresh(uid, maxAge)) {
        SM.debug.log('billing', 'subscription status reused from this tab', { uid: uid });
        return Promise.resolve(current);
      }
      return SM.billing.status().then(function (data) {
        markServerSync(uid);
        var a = data.access || {};
        /* Is there a plan to show at all? Lifetime has no expiry, so the date
           alone no longer answers that. And a plan an administrator REVOKED
           still carries its old expiry: the server says it grants nothing, and
           the account screen must not draw it as running. */
        var lifetime = a.isLifetime === true;
        var held = (lifetime || !!a.expiresAt) && a.state !== 'revoked' && a.state !== 'none';
        SM.auth.saveProfile(current.sub, {
          subscription: held ? {
            plan: a.plan,
            startedAt: a.startedAt,
            expiresAt: lifetime ? null : a.expiresAt,
            lifetime: lifetime,
            source: a.source || null,
            cancelledAt: a.state === 'cancelling' ? Date.now() : null,
            serverState: a.state
          } : null
        });
        refresh();
        return current;
      }).catch(function () { return current; });   /* offline keeps the cache */
    },

    /* Real purchase when the backend is configured; the sample path otherwise.
       Nothing is activated here on the client's say-so — subscribe() resolves
       only after /api/verify-payment has confirmed the signature server side,
       and the state is then re-read from the server. */
    subscribe: function (planId, onStage) {
      /* Every exit from this method carries `ok`. It used to resolve
         `{ error: ... }` for the two refusals below, and the caller tests
         `r.ok === false` — so a missing payment backend fell through the
         failure branch and toasted "Plan active". Refusing to start a payment
         and reporting success is the worst possible pair. */
      if (!current.signedIn) {
        return respond({ ok: false, result: { state: 'signin-required' } }, LAT.fast);
      }

      if (this.hasPaymentBackend()) {
        var self = this;
        return SM.billing.subscribe(planId, onStage).then(function (result) {
          if (result.state !== 'active') return { ok: false, result: result };
          return self.syncFromServer().then(function () {
            return { ok: true, session: current, result: result };
          });
        });
      }

      /* No gateway reachable. Nothing is granted — there is no sample
         activation any more. A subscription that no payment backs is worse
         than an error, because it looks like it worked. */
      SM.debug.warn('billing', 'subscribe refused — no payment backend', {
        firebase: !!(SM.fb && SM.fb.isConfigured()), billing: !!SM.billing
      });
      return respond({ ok: false, result: { state: 'unavailable' } }, LAT.fast);
    },

    /* Cancelling stops the renewal; access runs to the paid-for expiry date
       and the state flips to expired on its own after that.

       It goes to the SERVER. This used to write cancelledAt into localStorage
       and nothing else, so the screen said cancelled while the subscription
       record was untouched — and /api/cancel-subscription, which does the real
       thing, was never called by anything. A cancellation the server does not
       know about is not a cancellation. */
    cancel: function () {
      if (!current.sub || !current.subscription) {
        return respond({ ok: false, error: 'no-subscription' }, LAT.fast);
      }

      var self = this;
      if (!this.hasPaymentBackend()) {
        SM.debug.warn('billing', 'cancel refused — no backend to cancel against');
        return respond({ ok: false, error: 'payments-unavailable' }, LAT.fast);
      }

      return SM.billing.cancel().then(function (r) {
        SM.debug.log('billing', 'cancelled server side', { state: r && r.state, until: r && r.accessUntil });
        /* Re-read rather than assume: the answer the UI shows must be the
           server's record, not this call's optimism. */
        return self.syncFromServer().then(function () {
          return { ok: true, session: current, accessUntil: r && r.accessUntil };
        });
      }, function (err) {
        SM.debug.warn('billing', 'cancel failed', { status: err && err.status, error: err && err.message });
        return { ok: false, error: (err && err.message) || 'cancel-failed' };
      });
    },

    /* developer helper, deliberately not exposed in the UI — run
       SM.session.__expireNow() in the console to exercise the expired state */
    __expireNow: function () {
      if (!current.sub || !current.profile.subscription) return 'no subscription';
      var s = current.profile.subscription;
      SM.auth.saveProfile(current.sub, {
        subscription: Object.assign({}, s, {
          startedAt: Date.now() - 31 * DAY, expiresAt: Date.now() - DAY
        })
      });
      refresh();
      return current.status;
    }
  };


  /* The catalogue is open to everyone, so these lists no longer say
     "unlocked" about anything. A plan card that sells access the app already
     gives away is the one piece of copy that must not be left stale — a shop
     paying ₹99 for "every compatibility group unlocked" would be paying for
     what it already has.

     What a plan is FOR, now, is a decision for the owner rather than for this
     file. Until it is made these say only what is true today. */
  SM.PLANS = [
    {
      id: 'monthly', name: 'Monthly', price: 99, per: 'month', cadence: '₹99 billed every month',
      note: 'Best for trying Mobile Parts Finder in your shop.',
      feats: ['The whole catalogue — 3,340 groups, 12,239 fitments',
              'Unlimited Device Finder searches',
              'Works on counter phone, tablet & PC',
              'Supports the catalogue being kept up to date',
              'Cancel any time — your paid days still run']
    },
    {
      id: 'yearly', name: 'Yearly', price: 799, per: 'year', cadence: '₹799 billed once a year', badge: 'Save ₹389',
      note: 'Works out to ₹67 a month — two months free.',
      feats: ['Everything in Monthly',
              'Two months free vs paying monthly',
              'Priority access to new part categories',
              'Bulk part-code export (coming soon)',
              'Shop staff logins (coming soon)']
    }
  ];
})(window);

/* === src/data/access.js === */;
/* ============================================================================
   Mobile Parts Finder · access.js — the browser's view of what it may do
   ----------------------------------------------------------------------------
   One place the whole app asks "is this account free or paid, and how many
   of its five lifetime free searches are left".

   ----------------------------------------------------------------------------
   THIS FILE DECIDES NOTHING

   It caches an answer the SERVER gave and hands it to whatever is drawing a
   button. Every limit it reports is also enforced in api/access.js, on data
   the browser never receives:

     · a free search is spent by POSTing to the server, which counts it against
       the uid in Firestore. Editing `state.access` here does not create a
       credit, because the credit is not stored here.
     · a group's member list arrives already cut to the tier. The withheld
       names are not in the response, so there is no variable to change and no
       DOM node to unhide.
     · the tier comes from the stored subscription, read server side.

   So the worst an edit in the console achieves is a wrong-looking counter and
   a search that comes back 429 anyway.

   ----------------------------------------------------------------------------
   IT FOLLOWS THE ACCOUNT, NOT THE DEVICE

   `reset()` runs on every sign-in and sign-out, so signing out and signing in
   as somebody else does not inherit the previous account's counter or its
   tier. Nothing about entitlement is kept in localStorage for the same reason
   the server does not trust one: it is the thing being limited.

   ----------------------------------------------------------------------------
   AN ANSWER BELONGS TO WHOEVER ASKED

   The server answers the caller it can see. A request with no ID token is a
   signed-out visitor, and the truthful answer to that is "free" — so a request
   sent one moment before Firebase finishes restoring a session comes back
   free for a shop that has paid.

   That is exactly what happened to a yearly subscriber on 2 October 2026. The
   page asked as soon as the catalogue loaded, `SM.fb.user()` was still null
   because the auth SDK was still reading IndexedDB, the request went out with
   no Authorization header, and the signed-out answer was then kept as that
   subscriber's tier for the rest of the page. Opening a group sent them to
   the Plans page they had already paid on.

   Three rules close it, and each holds without the other two:

     1. A request WAITS for the session this browser expects. If the local
        session says someone is signed in, nothing is sent until Firebase has
        said who. A visitor with no session is not made to wait, and is not
        made to download the sign-in SDK to be told they are a visitor.
     2. An answer is kept only if the account that ASKED is still the account
        on the page when it lands. Anything else is dropped and asked again.
     3. A change of account — a session restored, a sign-in, a sign-out —
        throws the held answer away and asks as the new one.

   And a token the server could not verify (401) is not a verdict on the
   account. It is refreshed once and retried; if that fails too the state
   stays UNKNOWN, which gates nothing and unlocks nothing.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  /* What we last heard from the server. `null` means "not asked yet", which is
     NOT the same as "free" — a screen that treats an unanswered question as a
     denial paints a paywall over a subscriber's page for as long as the
     request takes. */
  var state = null;
  var inFlight = null;
  var listeners = [];
  /* modelId -> the in-flight or settled promise for its group list. */
  var deviceCache = Object.create(null);
  /* groupId -> {memberCount, preview}. Public and identical for everyone, so
     it is NOT dropped by reset(): a change of account changes nothing in it. */
  var previewCache = Object.create(null);
  var PREVIEW_BATCH = 48;
  /* Bumped by reset(). An answer that was asked for before the last reset is
     an answer about the previous account, wherever it is in its round trip. */
  var epoch = 0;
  /* The uid the auth listener last acted on. `undefined` until it has heard
     anything at all, so the first announcement — including "nobody" — counts. */
  var watchedUid;

  function emit() {
    listeners.forEach(function (fn) {
      try { fn(state); } catch (e) { /* a listener must not break access */ }
    });
  }

  var PLAIN = { 'Content-Type': 'application/json' };

  /** The uid Firebase has on the page right now, or null. */
  function currentUid() {
    var u = SM.fb && SM.fb.user ? SM.fb.user() : null;
    return u ? u.uid : null;
  }

  /* Does this browser remember being signed in? A HINT, read from the local
     session, and it decides one thing only: whether to wait for Firebase
     before asking. It grants nothing — what comes back is still decided by
     the server from the token, or the absence of one. */
  function sessionExpected() {
    try { return !!(SM.session && SM.session.get().signedIn); }
    catch (e) { return false; }
  }

  /**
   * Who a request is about to be sent as, and the headers that say so.
   *
   * @param {boolean} [forceToken]  mint a new ID token rather than reuse the
   *        cached one — the retry after the server refused the last one
   * @returns {Promise<{uid:string|null, headers:object}>}
   */
  function caller(forceToken) {
    var anonymous = { uid: null, headers: PLAIN };
    if (!SM.fb) return Promise.resolve(anonymous);

    var settled;
    if (SM.fb.phase && SM.fb.phase() === 'loading') {
      /* Firebase has not answered yet. With no remembered session this is
         almost certainly a visitor, and they get the free view now; if a user
         does turn up, the auth listener below asks again as them. */
      if (!sessionExpected()) return Promise.resolve(anonymous);
      settled = SM.fb.whenResolved();
    } else {
      settled = Promise.resolve(SM.fb.user ? SM.fb.user() : null);
    }

    return settled.then(function (user) {
      if (!user) return anonymous;
      return SM.fb.idToken(!!forceToken).then(function (token) {
        /* Signed in but no token could be had. Sent as the account anyway, so
           the answer is still filed against the right uid. */
        if (!token) return { uid: user.uid, headers: PLAIN };
        return {
          uid: user.uid,
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
        };
      });
    }, function () { return anonymous; });
  }

  /**
   * One request to the entitlement API, sent as whoever is signed in.
   *
   * A 401 on a request that carried a token means the server could not verify
   * it — expired between the cache and the wire, a clock that is out, a
   * session revoked elsewhere. A new token is minted and the request repeated
   * ONCE. It is never read as "this account is free".
   *
   * @returns {Promise<{res:Response, data:object|null, who:{uid:string|null}}>}
   */
  function call(path, init, retried) {
    return caller(retried).then(function (who) {
      var options = { headers: who.headers };
      if (init && init.method) options.method = init.method;
      if (init && init.body) options.body = init.body;

      return fetch(path, options).then(function (res) {
        if (res.status === 401 && who.uid && !retried) {
          SM.debug.warn('access', 'token refused, refreshing it and retrying', { path: path });
          return call(path, init, true);
        }
        return res.json().catch(function () { return null; }).then(function (data) {
          return { res: res, data: data, who: who };
        });
      });
    });
  }

  /**
   * Keeps an answer, if it is an answer about the account on the page.
   *
   * @returns {boolean} whether it was kept
   */
  function accept(next, who, ticket) {
    if (!next || typeof next.tier !== 'string') return false;
    /* reset() ran while this was in flight: it describes the previous account. */
    if (ticket !== epoch) return false;
    /* The account changed while this was in flight — most often a session
       restored a moment after an anonymous request left. */
    if (who.uid !== currentUid()) return false;
    /* A token went out and the server still answered as if nobody was there.
       That is the server failing to recognise the caller, not a tier. */
    if (who.uid && next.signedIn === false) return false;
    state = next;
    emit();
    return true;
  }

  var access = {
    /** The last known answer, or null before the first one arrives. */
    get: function () { return state; },

    /** True only when the server has SAID so. Unknown is not paid. */
    isPaid: function () { return !!(state && state.paid); },

    /**
     * Not paid, as far as the server is concerned.
     *
     * Includes a signed-out visitor: they are certainly not a subscriber, and
     * the paid features should be gated for them too. Requiring `signedIn`
     * here let anyone see the whole group filter simply by signing out, which
     * is the opposite of a restriction.
     *
     * Still false before the first answer arrives — an unanswered question is
     * not a denial, and treating it as one paywalls a subscriber for as long
     * as the request takes.
     */
    isFree: function () { return !!(state && !state.paid); },

    /** Signed in AND not paid — the account that has a search allowance. */
    isMeteredAccount: function () { return !!(state && state.signedIn && !state.paid); },

    /** Free searches left for the life of the account, or null for a paid
        account / unknown. */
    remaining: function () {
      return state && !state.paid && typeof state.searchesRemaining === 'number'
        ? state.searchesRemaining : null;
    },

    /**
     * The server's answer, once there is one.
     *
     * For a decision that must not be made on a guess — opening a group sends
     * a free account to Plans and a visitor to Sign in, and doing either to a
     * subscriber whose answer simply has not landed yet would be the
     * "paid but asked to pay again" fault over again. Asks if nothing is held
     * or in flight; resolves with null if the server cannot be reached, which
     * the caller treats as "unknown", never as "free".
     */
    whenKnown: function () {
      if (state) return Promise.resolve(state);
      return access.refresh().then(function () { return state; });
    },

    onChange: function (fn) {
      listeners.push(fn);
      if (state) fn(state);
      return function () {
        var i = listeners.indexOf(fn);
        if (i > -1) listeners.splice(i, 1);
      };
    },

    /**
     * Asks the server. Repeat calls while one is in flight share it, so a page
     * that paints three panels does not send three requests.
     */
    refresh: function () {
      if (inFlight) return inFlight;
      var ticket = epoch;

      var mine = call('/api/access').then(function (r) {
        if (inFlight === mine) inFlight = null;
        if (ticket !== epoch) return state;            /* superseded by reset() */

        if (r.who.uid !== currentUid()) {
          /* Asked as one identity, answered for another. Ask again as the
             account that is actually here. */
          SM.debug.log('access', 'identity changed while asking — asking again');
          return access.refresh();
        }
        if (!accept(r.data, r.who, ticket) && r.who.uid) {
          SM.debug.warn('access', 'no usable answer for this account',
                        { status: r.res.status });
        }
        return state;
      }).catch(function (err) {
        if (inFlight === mine) inFlight = null;
        /* Unreachable is not "free". Leaving the last known answer in place
           means a dropped request does not paywall a subscriber mid-session. */
        SM.debug.warn('access', 'refresh failed', { message: err && err.message });
        return state;
      });
      inFlight = mine;
      return inFlight;
    },

    /**
     * Spends one of the five lifetime free searches.
     *
     * The credit is spent HERE, once, when a search is actually run — never
     * while typing. Autocomplete does not call this.
     *
     * The model is sent with it, and that is what makes it one search rather
     * than one per request: the server charges a model once per account, so a
     * reload, a retried request or a second tap on the same suggestion costs
     * nothing. A NEW model past the fifth is refused with 429.
     *
     * @param {string} modelId
     * @returns {Promise<{allowed:boolean, access:object|null, limitReached:boolean}>}
     *          Resolves for a refusal too: being out of searches is an outcome
     *          the caller renders, not an exception it has to catch.
     */
    consumeSearch: function (modelId) {
      /* A paid account is not metered and does not need a round trip. The
         server agrees independently, so this is a saved request rather than a
         decision — a browser that lied about being paid would still be metered
         by the next thing it asked for. */
      if (access.isPaid()) return Promise.resolve({ allowed: true, access: state, limitReached: false });

      var ticket = epoch;
      var payload = JSON.stringify(modelId ? { modelId: modelId } : {});
      return call('/api/access', { method: 'POST', body: payload }).then(function (r) {
        var data = r.data || {};
        accept(data.access, r.who, ticket);
        return {
          allowed: r.res.ok,
          access: state,
          limitReached: r.res.status === 429,
          needsSignIn: r.res.status === 401
        };
      }).catch(function (err) {
        /* FAILS CLOSED. The server could not be reached, so the search cannot
           be metered — and a search that cannot be metered must not run.

           Allowing it would make "turn the network off after the page loads"
           an unlimited-search bypass, which is exactly the kind of hole the
           limit exists to close. The catalogue is cached, so the page would
           otherwise happily keep answering.

           The cost is that a genuine outage stops free searching. Paid
           accounts are unaffected: isPaid() returns above without a request. */
        SM.debug.warn('access', 'consume failed, refusing the search', { message: err && err.message });
        return { allowed: false, access: state, limitReached: false, offline: true };
      });
    },

    /**
     * Spends one of the five on opening a group. A group already opened costs
     * nothing again. Resolves like consumeSearch, refusals included.
     */
    openGroup: function (groupId) {
      if (access.isPaid()) return Promise.resolve({ allowed: true, access: state, limitReached: false });
      var ticket = epoch;
      return call('/api/access', { method: 'POST', body: JSON.stringify({ groupId: groupId }) }).then(function (r) {
        var data = r.data || {};
        accept(data.access, r.who, ticket);
        return { allowed: r.res.ok, access: state, limitReached: r.res.status === 429, needsSignIn: r.res.status === 401 };
      }).catch(function (err) {
        SM.debug.warn('access', 'open group failed, refusing it', { message: err && err.message });
        return { allowed: false, access: state, limitReached: false, offline: true };
      });
    },

    /**
     * A group's members, cut to this account's tier by the server.
     *
     * @returns {Promise<{members:Array, memberCount:number, lockedCount:number,
     *                    locked:boolean, partCode:string|null}|null>}
     */
    groupMembers: function (groupId) {
      var ticket = epoch;
      return call('/api/device-parts?groupId=' + encodeURIComponent(groupId)).then(function (r) {
        if (!r.res.ok || !r.data) return null;
        accept(r.data.access, r.who, ticket);
        return r.data.group || null;
      }).catch(function (err) {
        SM.debug.warn('access', 'group members unavailable', { groupId: groupId, message: err && err.message });
        return null;
      });
    },

    /**
     * Every group that fits one device, per category, cut to this account's
     * tier by the server.
     *
     * THIS REPLACED A LOCAL LOOKUP. The map of device -> groups used to be in
     * assets/dataset.json, which is one unauthenticated GET, and inverting it
     * handed anybody the full member list of all 3,384 groups. The bundle now
     * carries per-category COUNTS only, and the ids — with the members, for a
     * subscriber — come from here.
     *
     * Cached per model for the life of the page: opening a group, going back,
     * and opening it again is one request, not three. The cache is dropped by
     * reset(), which runs on every sign-in and sign-out, so a free account
     * cannot read a subscriber's answer out of it after a handover at the
     * counter.
     *
     * @returns {Promise<{categories:Array}|{unavailable:true}|null>}
     *          null  — the server has no such device
     *          unavailable — it could not answer; NOT the same as "no parts",
     *          and the caller must not render one as the other.
     */
    deviceGroups: function (modelId) {
      if (!modelId) return Promise.resolve(null);
      if (deviceCache[modelId]) return deviceCache[modelId];

      var ticket = epoch;
      var cache = deviceCache;
      var req = call('/api/device-parts?modelId=' + encodeURIComponent(modelId)).then(function (r) {
        var data = r.data;
        accept(data && data.access, r.who, ticket);
        /* Answered for an identity that is no longer the one on the page. The
           member lists in it were cut to THAT caller's tier, so it must not
           stay in the cache to be served to this one. */
        if (r.who.uid !== currentUid() && cache[modelId] === req) delete cache[modelId];
        if (r.res.status === 404) return null;
        if (!r.res.ok) {
          /* Forget it, so a retry after the outage is a real request rather
             than the cached failure. */
          if (cache[modelId] === req) delete cache[modelId];
          SM.debug.warn('access', 'device parts unavailable',
                        { modelId: modelId, status: r.res.status, error: data && data.error });
          return { unavailable: true, status: r.res.status };
        }
        return (data && data.device) || null;
      }).catch(function (err) {
        if (cache[modelId] === req) delete cache[modelId];
        SM.debug.warn('access', 'device parts request failed',
                      { modelId: modelId, message: err && err.message });
        return { unavailable: true, status: 0 };
      });

      deviceCache[modelId] = req;
      return req;
    },

    /**
     * The free preview of some groups — a handful of device names each, the
     * same for every caller. For the home feed's cards.
     *
     * Sent WITHOUT a token on purpose: the answer is public and identical for
     * everyone, so it is cacheable at the edge, and attaching an identity
     * would only make each shop's copy a separate cache entry.
     *
     * @param {string[]} groupIds
     * @returns {Promise<Object<string,{memberCount:number,preview:Array}>>}
     *          only the groups that came back; an outage is an empty object,
     *          and the cards simply draw without names.
     */
    previews: function (groupIds) {
      var want = [];
      var out = {};
      (groupIds || []).forEach(function (id) {
        if (!id) return;
        if (previewCache[id]) out[id] = previewCache[id];
        else if (want.indexOf(id) === -1) want.push(id);
      });
      if (!want.length) return Promise.resolve(out);
      /* Sorted, so the same page of the feed is the same URL — and the same
         edge-cache entry — for everybody who loads it. */
      want.sort();
      var batches = [];
      for (var i = 0; i < want.length; i += PREVIEW_BATCH) batches.push(want.slice(i, i + PREVIEW_BATCH));
      return Promise.all(batches.map(function (ids) {
        return fetch('/api/device-parts?previews=' + ids.map(encodeURIComponent).join(','))
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) {
            var got = (data && data.previews) || {};
            Object.keys(got).forEach(function (id) { previewCache[id] = got[id]; out[id] = got[id]; });
          })
          .catch(function (err) {
            SM.debug.warn('access', 'previews unavailable', { message: err && err.message });
          });
      })).then(function () { return out; });
    },

    /** The preview already fetched for one group, or null. Synchronous, for a
        card that is being painted from what is already known. */
    previewOf: function (groupId) { return previewCache[groupId] || null; },

    /** Drops one device's cached answer, so a retry is a real request. */
    forgetDevice: function (modelId) {
      if (modelId) delete deviceCache[modelId];
    },

    /** Forgets everything. Called on sign-in and sign-out — see the header. */
    reset: function () {
      state = null;
      inFlight = null;
      /* Every request already on its way was asked as the previous account. */
      epoch++;
      /* The per-device answers were cut to the PREVIOUS account's tier. Keeping
         them across a sign-out would leave a subscriber's member lists in
         memory for whoever signs in next on a shared counter machine. */
      deviceCache = Object.create(null);
      emit();
    }
  };

  /* ------------------------------------------------ the account, whoever it is

     Rule 3 from the header. Firebase announces every change of account here —
     a session restored after the page loaded, a sign-in, a sign-out — and the
     answer this module holds is about whoever was there before.

     Registering costs nothing: onChange only records the listener, it does not
     load the SDK. A token refresh for the SAME account announces the same uid
     and is ignored, so this fires once per change of person, not once an
     hour. */
  if (SM.fb && SM.fb.onChange) {
    SM.fb.onChange(function (user) {
      var uid = user ? user.uid : null;
      if (uid === watchedUid) return;
      var first = watchedUid === undefined;
      watchedUid = uid;

      if (first && state === null) {
        /* Firebase's first word, and nothing is held yet. A request already in
           flight either waited for this session and is about to be sent as it,
           or left anonymously and will be refused by rule 2 when it lands —
           there is nothing to throw away. All that is needed is that a
           signed-in account has a question outstanding at all. */
        if (uid && !inFlight) access.refresh();
        return;
      }
      /* The first word being "nobody" changes nothing that was asked
         anonymously — that answer is already the right one. */
      if (first && !uid && !state.signedIn) return;

      SM.debug.log('access', 'account changed — asking again', { signedIn: !!uid });
      access.reset();
      access.refresh();
    });
  }

  SM.access = access;
})(window);

/* === src/data/analytics.js === */;
/* ============================================================================
   Mobile Parts Finder · analytics.js — the visitor analytics collector
   ----------------------------------------------------------------------------
   Records meaningful events and posts them to /api/events in batches.

   ----------------------------------------------------------------------------
   THE RULE THIS FILE OBEYS ABOVE ALL OTHERS: IT CANNOT BREAK THE SITE

   Analytics is the least important thing on this page. A shop owner looking up
   a part must never see a slower page, a failed search or a console full of
   errors because a tracking call went wrong. So:

     · every public method is wrapped and swallows its own errors
     · nothing is awaited by any caller — track() returns immediately
     · a failed POST is dropped, not retried into a loop
     · with the endpoint unreachable the queue is capped and then discarded
     · no event is sent from a page that has not finished loading

   If this whole file were deleted the site would work identically. That is the
   design, not a happy accident.

   ----------------------------------------------------------------------------
   WHAT IT SENDS, AND WHAT IT REFUSES TO

   Only the event types the server allowlists, and only the metadata fields
   each type declares — the server drops anything else, and this end does not
   bother sending it.

   NO fingerprinting. The session id is `crypto.randomUUID()` — a random string
   this browser generates for itself and stores in sessionStorage. It is not
   derived from the screen size, the fonts, the canvas, the user agent or
   anything else about the device, and it is deliberately per-TAB-session
   rather than permanent: it identifies a visit, not a person.

   NO page content, no form values, no keystrokes, no scroll depth, no mouse
   movement. A search TERM is sent, because "what are shops looking for" is the
   business question the whole catalogue exists to answer — and it is redacted
   server-side for anything resembling a phone number or an email.

   ----------------------------------------------------------------------------
   WHY IT BATCHES

   Typing "samsung galaxy m21" fires a search on every keystroke. Sending
   eighteen events for one search would cost eighteen requests, eighteen
   Firestore writes and a top-search-terms list full of "sam", "sams",
   "samsu". So a search is debounced here — the browser knows when typing has
   stopped and the server does not — and everything else rides along in the
   same flush.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  var ENDPOINT = '/api/events';
  var SESSION_KEY = 'mpf.analytics.session';
  var VISITED_KEY = 'mpf.analytics.visited';
  /* Set once this tab session has counted its visit and sent its first batch. */
  var VISIT_COUNTED_KEY = 'mpf.analytics.visitCounted';
  var SESSION_OPENED_KEY = 'mpf.analytics.sessionOpened';

  /* How long a batch waits for company before being sent.

     Every batch costs Firestore writes beyond its events — a rate-limit
     counter, the day's rollup, the session row — so the fewer batches, the
     cheaper each event. Fifteen seconds gathers a whole burst of browsing into
     one. A visitor who leaves sooner is still covered: pagehide and a hidden
     tab both flush on a beacon (see start()). */
  var FLUSH_MS = 15000;

  /* A search is only recorded once the typing stops. */
  var SEARCH_DEBOUNCE_MS = 900;

  /* The most events held while offline before the oldest are dropped. A queue
     that grows without limit is a memory leak on a page left open all day. */
  var MAX_QUEUE = 40;

  var queue = [];
  var flushTimer = null;
  var searchTimer = null;
  var enabled = true;
  var started = false;

  /* --------------------------------------------------------------- session

     A random id per browsing session, in sessionStorage so it ends when the
     tab does. Nothing about the device goes into it. */
  function sessionId() {
    try {
      var existing = sessionStorage.getItem(SESSION_KEY);
      if (existing) return existing;

      var id = (global.crypto && global.crypto.randomUUID)
        ? global.crypto.randomUUID().replace(/-/g, '')
        : randomFallback();
      sessionStorage.setItem(SESSION_KEY, id);
      return id;
    } catch (e) {
      /* Private mode refuses storage. The visit is then simply anonymous with
         no session at all, which is a fine outcome and not an error. */
      return null;
    }
  }

  function randomFallback() {
    var out = '';
    var alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    if (global.crypto && global.crypto.getRandomValues) {
      var bytes = new Uint8Array(24);
      global.crypto.getRandomValues(bytes);
      for (var i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
      return out;
    }
    /* No crypto at all: an old browser. Math.random is not a security
       primitive and this is not a security decision — a session id only needs
       to be unlikely to collide. */
    for (var j = 0; j < 24; j++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
  }

  /* ---------------------------------------------------------------- sending */

  function flush(useBeacon) {
    if (!queue.length || !enabled) return;

    var events = queue.splice(0, queue.length);

    /* The first batch of a session says so, which lets the server stamp when
       the session began in the same write that records it — instead of a
       second "create if absent" write attempted on every batch. */
    var opened = false;
    try {
      opened = sessionStorage.getItem(SESSION_OPENED_KEY) !== '1';
      if (opened) sessionStorage.setItem(SESSION_OPENED_KEY, '1');
    } catch (e) { /* private mode: no session id either, so nothing to stamp */ }

    var payload = JSON.stringify({
      events: events,
      sessionId: sessionId(),
      newSession: opened,
      source: 'web'
    });

    /* On the way out of the page, sendBeacon is the only thing that survives
       the navigation. It cannot carry an Authorization header, so those events
       arrive anonymous — which is the right trade against losing them. */
    if (useBeacon && global.navigator && navigator.sendBeacon) {
      try {
        navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }));
        return;
      } catch (e) { /* fall through to fetch */ }
    }

    tokenHeader().then(function (headers) {
      return fetch(ENDPOINT, {
        method: 'POST',
        headers: headers,
        body: payload,
        keepalive: true
      });
    }).catch(function () {
      /* Dropped on purpose. Re-queueing a failed batch is how a broken
         endpoint turns into a request loop that makes the site slower the
         longer it stays broken. */
    });
  }

  /**
   * The Authorization header when a user is signed in.
   *
   * Attribution is a nicety: an event with no token is recorded anonymously
   * and still counted. So a token that takes a moment must not delay the
   * batch, and a token that fails must not lose it.
   */
  function tokenHeader() {
    var plain = { 'Content-Type': 'application/json' };
    if (!SM.fb || !SM.fb.isConfigured || !SM.fb.isConfigured()) {
      return Promise.resolve(plain);
    }
    if (!SM.fb.user || !SM.fb.user()) return Promise.resolve(plain);

    return SM.fb.idToken().then(function (token) {
      if (!token) return plain;
      return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
    }, function () { return plain; });
  }

  function schedule() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flush(false);
    }, FLUSH_MS);
  }

  /* ------------------------------------------------------------------- api */

  var analytics = {
    /**
     * Records one event. Returns immediately and never throws.
     *
     * @param {string} eventType must be on the server's allowlist
     * @param {object} [metadata] only the fields that type declares survive
     */
    track: function (eventType, metadata) {
      try {
        if (!enabled || !started || typeof eventType !== 'string') return;

        queue.push({ eventType: eventType, metadata: metadata || {} });
        /* Oldest first: a queue that has overflowed is one where the recent
           events are the interesting ones. */
        while (queue.length > MAX_QUEUE) queue.shift();

        schedule();
      } catch (e) { /* analytics must never surface */ }
    },

    /**
     * A search, debounced until the typing stops.
     *
     * @param {string} query
     * @param {object} detail { searchType, matchedResultCount, categoryId, brandId }
     */
    trackSearch: function (query, detail) {
      try {
        if (!enabled || !started) return;
        var q = String(query || '').trim();
        if (q.length < 2) return;

        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          var d = detail || {};
          var count = Number(d.matchedResultCount);

          analytics.track('model_search', {
            searchQuery: q,
            searchType: d.searchType || 'free_text',
            matchedResultCount: Number.isFinite(count) ? count : 0,
            categoryId: d.categoryId,
            brandId: d.brandId
          });

          /* A search that found nothing is the one that feeds the
             missing-model queue, so it is its own event rather than a flag on
             the one above — the server queries by type. */
          if (Number.isFinite(count) && count === 0) {
            analytics.track('search_zero_result', {
              searchQuery: q,
              searchType: d.searchType || 'free_text',
              categoryId: d.categoryId
            });
          }
        }, SEARCH_DEBOUNCE_MS);
      } catch (e) { /* never surface */ }
    },

    /** Sends whatever is queued now rather than waiting for the timer. */
    flush: function () {
      try { clearTimeout(flushTimer); flushTimer = null; flush(false); }
      catch (e) { /* never surface */ }
    },

    /** The current session id, or null when storage is unavailable. */
    sessionId: sessionId,

    /**
     * Switches collection off for this browser.
     *
     * Not wired to a UI control yet — it is here so that when a preference or
     * a consent banner is added, the off switch already exists and is one line
     * to call rather than a refactor.
     */
    disable: function () { enabled = false; queue.length = 0; },
    enabled: function () { return enabled; },

    /**
     * Called once, after the app has mounted.
     *
     * Deliberately not on script load: an event sent while the page is still
     * assembling competes with the requests that draw it, and the first visit
     * event should mean "someone is looking at this", not "a script parsed".
     */
    start: function () {
      try {
        if (started) return;
        started = true;

        /* first_visit against return_visit is decided by one flag in
           localStorage — not by a device fingerprint, and not by anything that
           would identify this browser anywhere else. */
        var returning = false;
        try {
          returning = localStorage.getItem(VISITED_KEY) === '1';
          localStorage.setItem(VISITED_KEY, '1');
        } catch (e) { /* private mode: every visit reads as a first visit */ }

        var referrerHost = '';
        try {
          if (document.referrer) {
            var url = new URL(document.referrer);
            /* The host only, and never our own — a full referrer URL can carry
               a search term or a token from the site someone came from. */
            if (url.host !== location.host) referrerHost = url.host;
          }
        } catch (e) { /* unparseable referrer */ }

        /* A VISIT is a tab session, not a page load. This used to fire on
           every start() — every full page load of the app — so moving between
           the finder and a pre-rendered model page counted one person as a new
           "return visit" each time, and paid a Firestore write for each. */
        var counted = false;
        try { counted = sessionStorage.getItem(VISIT_COUNTED_KEY) === '1'; } catch (e) { /* private mode */ }
        if (!counted) {
          try { sessionStorage.setItem(VISIT_COUNTED_KEY, '1'); } catch (e) { /* private mode */ }
          analytics.track(returning ? 'return_visit' : 'first_visit', {
            landingPath: location.pathname,
            referrerHost: referrerHost
          });
        }

        /* Anything still queued when the tab closes goes out on a beacon. */
        global.addEventListener('pagehide', function () { flush(true); });
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'hidden') flush(true);
        });
      } catch (e) { /* never surface */ }
    }
  };

  SM.analytics = analytics;
})(window);

/* === src/ui/icons.js === */;
/* ============================================================================
   Mobile Parts Finder · icons.js — inline stroke icon set + the brand mark
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  var P = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3M21 21v.01M12 7v3a2 2 0 0 1-2 2H7M3 12h.01M12 3h.01M12 16v.01M16 12h1M21 12v.01M12 21v-1"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronUp: '<path d="m6 15 6-6 6 6"/>',
    chevronRight: '<path d="m9 6 6 6-6 6"/>',
    chevronLeft: '<path d="m15 6-6 6 6 6"/>',
    arrowRight: '<path d="M4 12h15"/><path d="m13 6 6 6-6 6"/>',
    check: '<path d="m4 12.5 5 5L20 6.5"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>',
    filter: '<path d="M3 5h18M6 12h12M10 19h4"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h9M17 18h3"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="15" cy="18" r="2"/>',
    chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M9 16v-5M14 16V8M19 16v-3"/>',
    list: '<rect x="3" y="4" width="6" height="6" rx="1.5"/><rect x="3" y="14" width="6" height="6" rx="1.5"/><path d="M13 6h8M13 9h5M13 16h8M13 19h5"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
    grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
    phone: '<rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M10.5 5.5h3"/>',
    user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20c.9-3.6 3.7-5.4 7.2-5.4s6.3 1.8 7.2 5.4"/>',
    crown: '<path d="M3.5 8.5 7 12l5-6.5 5 6.5 3.5-3.5-1.6 9.5H5.1L3.5 8.5Z"/>',
    lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
    unlock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 7.5-2"/>',
    bolt: '<path d="M13.5 2.5 5 13.2h5.4L9.8 21.5 19 10.6h-5.5l0-8.1Z"/>',
    sparkle: '<path d="M12 3.2 13.9 9 20 10.9 13.9 12.8 12 18.6 10.1 12.8 4 10.9 10.1 9 12 3.2Z"/><path d="M18.6 3v3.2M17 4.6h3.2"/>',
    copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 5.5h-9a2.5 2.5 0 0 0-2.5 2.5v9"/>',
    /* install: a tray taking a downward arrow — the shape every browser uses
       for "put this on your device", so it needs no label to be understood */
    install: '<path d="M12 3.5v11"/><path d="m7.8 10.4 4.2 4.2 4.2-4.2"/><path d="M4.5 16.5v2.2a1.8 1.8 0 0 0 1.8 1.8h11.4a1.8 1.8 0 0 0 1.8-1.8v-2.2"/>',
    /* The three-node share glyph — two nodes right, one left, joined. The
       tray-and-arrow drawn here before is the SYSTEM share on iOS but reads as
       upload or export everywhere else, which is what it was being mistaken
       for. This one means share and nothing else. */
    share: '<circle cx="18" cy="5.6" r="2.6"/><circle cx="18" cy="18.4" r="2.6"/><circle cx="6" cy="12" r="2.6"/><path d="m8.3 10.8 7.4-3.9"/><path d="m8.3 13.2 7.4 3.9"/>',
    mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.2"/><path d="m3.6 7 8.4 6 8.4-6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/>',
    moon: '<path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.2M12 7.9v.1"/>',
    alert: '<path d="M12 3.5 21 19.5H3L12 3.5Z"/><path d="M12 9.5v4M12 16.6v.1"/>',
    inbox: '<path d="M3.5 13.5h4l1.5 3h6l1.5-3h4"/><path d="M5.4 5h13.2l2 8.5v4a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2v-4L5.4 5Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    /* --- Quick Billing: additive, same 24x24 stroke grid --- */
    /* a till receipt with a torn foot — the bottom tab's POS mark */
    receipt: '<path d="M6 2.8h12a1 1 0 0 1 1 1v17.4l-2.4-1.5-2.3 1.5-2.3-1.5-2.3 1.5-2.3-1.5L5 21.2V3.8a1 1 0 0 1 1-1Z"/><path d="M8.6 7.6h6.8M8.6 11h6.8M8.6 14.4h4"/>',
    printer: '<path d="M7 9V3.5h10V9"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14.5h10v6H7z"/><path d="M17.2 11.8h.1"/>',
    box: '<path d="m12 3 8 4.2v9.6L12 21l-8-4.2V7.2L12 3Z"/><path d="m4 7.2 8 4.3 8-4.3M12 11.5V21"/>',
    trash: '<path d="M4.5 6.5h15"/><path d="M9.5 6.5V4.2h5v2.3"/><path d="M6.5 6.5 7.4 20h9.2l.9-13.5"/><path d="M10.3 10.5v6M13.7 10.5v6"/>',
    edit: '<path d="M4 20h4.2L19.4 8.8a2 2 0 0 0 0-2.8l-1.4-1.4a2 2 0 0 0-2.8 0L4 15.8V20Z"/><path d="m13.6 6.2 4.2 4.2"/>',
    /* Grid-density pair: the icon IS the layout it switches to, so the two
       read as a choice between shapes rather than needing a "2"/"3" label. */
    cols2: '<rect x="3.5" y="4" width="7" height="16" rx="1.4"/><rect x="13.5" y="4" width="7" height="16" rx="1.4"/>',
    cols3: '<rect x="3" y="4" width="5" height="16" rx="1.2"/><rect x="9.5" y="4" width="5" height="16" rx="1.2"/><rect x="16" y="4" width="5" height="16" rx="1.2"/>',
    logout: '<path d="M9.5 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.5"/><path d="M15 8.5 18.5 12 15 15.5M18 12H9.5"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/>',
    history: '<path d="M3.6 9.5A8.5 8.5 0 1 1 3 12"/><path d="M3.2 4.6v5h5"/><path d="M12 7.6V12l3.2 1.9"/>',
    linkOut: '<path d="M9 5H5.5A1.5 1.5 0 0 0 4 6.5v12A1.5 1.5 0 0 0 5.5 20h12a1.5 1.5 0 0 0 1.5-1.5V15"/><path d="M14 4h6v6"/><path d="m20 4-8.5 8.5"/>',
    shop: '<path d="M4 9.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19V9.5"/><path d="M3 9.5 5 4h14l2 5.5a3 3 0 0 1-5.4 1.8A3 3 0 0 1 12 12a3 3 0 0 1-3.6-.7A3 3 0 0 1 3 9.5Z"/>',
    tag: '<path d="M4 11.5V5a1 1 0 0 1 1-1h6.5L20 12.5 12.5 20 4 11.5Z"/><circle cx="8.2" cy="8.2" r="1.3"/>',
    /* --- part categories --- */
    glass: '<rect x="5.5" y="2.5" width="13" height="19" rx="3"/><path d="m8 17 8-11"/><path d="M8 11.5 12.5 5"/>',
    cover: '<rect x="5.5" y="2.5" width="13" height="19" rx="3"/><circle cx="9.6" cy="7" r="1.6"/><circle cx="9.6" cy="11" r="1.6"/>',
    display: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M4 7.5h16"/><path d="M8 17.5h8"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 2.8v4M16 2.8v4"/>',
    signal: '<path d="M4 20v-4M9 20v-8M14 20v-12M19 20V4"/>',
    /* Added for the model detail spec sheet. Additive only - no existing
       glyph is altered, and all three follow the same 24x24 stroke grid. */
    simcard: '<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><rect x="8.5" y="11" width="7" height="6" rx="1"/><path d="M8.5 14h7"/>',
    speaker: '<rect x="3" y="9" width="4" height="6" rx="1"/><path d="M7 9l5-4v14l-5-4"/><path d="M16 9.5a3.5 3.5 0 0 1 0 5"/><path d="M18.5 7a7 7 0 0 1 0 10"/>',
    software: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9z"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>',
    cpu: '<rect x="5.5" y="5.5" width="13" height="13" rx="2.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/>',
    camera: '<path d="M3.5 8.5a2 2 0 0 1 2-2h1.7l1.3-2h7l1.3 2h1.7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.6"/>',
    ruler: '<rect x="2.5" y="7.5" width="19" height="9" rx="2"/><path d="M7 7.5v3M11 7.5v4.5M15 7.5v3M19 7.5v4.5"/>',
    shield: '<path d="M12 2.8l7.5 3v5.6c0 4.4-3 8.2-7.5 9.8-4.5-1.6-7.5-5.4-7.5-9.8V5.8z"/><path d="M9 12l2.2 2.2L15.4 10"/>',
    battery: '<rect x="3" y="7" width="16" height="10" rx="2.5"/><path d="M21 10.5v3"/><path d="M6.5 10.5v3M10 10.5v3"/>',
    frame: '<rect x="5" y="2.5" width="14" height="19" rx="3.5"/><rect x="8" y="6" width="8" height="12" rx="1.5"/>',
    board: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M9 9h6v6H9z"/><path d="M9 2.5v1.5M15 2.5v1.5M9 20v1.5M15 20v1.5M2.5 9H4M2.5 15H4M20 9h1.5M20 15h1.5"/>',
    charge: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M13 8.2 9.8 12.6h3.1L12.2 16l3.4-4.6h-3.2L13 8.2Z"/>',
    parts: '<circle cx="7" cy="7" r="3"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><path d="M4 20.5h7l-3.5-6-3.5 6Z"/><circle cx="17" cy="17" r="3.5"/>'
  };

  /* width/height are ATTRIBUTES, not CSS, so every existing rule that sizes an
     icon — .btn svg, .pill svg, .tab svg and the rest — still wins. They exist
     only as the default for the places that size nothing.

     Without them an <svg> carrying a viewBox and no dimensions is a replaced
     element with no intrinsic size: `max-width:100%` in styles.css caps its
     width to the container and the aspect ratio takes the height with it, so
     one 24x24 glyph rendered as a 306x306 disc. That is the giant arc that was
     appearing under "Add shop address" on the Create account page — the check
     icon in #regHint, which nothing had a size rule for — and the same bug had
     already been patched one selector at a time in .authwait. Fixed here, at
     the source, so the next unsized call site cannot repeat it. */
  SM.icon = function (name, cls) {
    var d = P[name] || P.info;
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
      (cls ? ' class="' + cls + '"' : '') + '>' + d + '</svg>';
  };

  /* ---- Mobile Parts Finder mark: a magnifier closing on a phone part.
     The lens holds the part; the amber body keeps the brand accent.        */
  SM.logoMark = function (size, cls) {
    size = size || 36;
    var uid = 'mpf' + Math.random().toString(36).slice(2, 8);
    return '' +
      '<svg class="' + (cls || 'logo__mark') + '" width="' + size + '" height="' + size + '" viewBox="0 0 48 48" role="img" aria-label="Mobile Parts Finder">' +
      '<defs>' +
      '<linearGradient id="' + uid + '" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0%" stop-color="#0F766E"/><stop offset="55%" stop-color="#12A08C"/><stop offset="100%" stop-color="#10D0A8"/>' +
      '</linearGradient>' +
      '<linearGradient id="' + uid + 'b" x1="0" y1="1" x2="1" y2="0">' +
      '<stop offset="0%" stop-color="#FF8A3D"/><stop offset="100%" stop-color="#FFC46B"/>' +
      '</linearGradient>' +
      '</defs>' +
      '<rect width="48" height="48" rx="14" fill="url(#' + uid + ')"/>' +
      /* lens glass */
      '<circle cx="20.5" cy="20.5" r="11.6" fill="#fff" fill-opacity=".18"/>' +
      /* the part being found */
      '<rect x="16.6" y="13.2" width="7.8" height="14.6" rx="2.2" fill="url(#' + uid + 'b)"/>' +
      '<path d="M18.5 15.4h4" stroke="#8A4A12" stroke-opacity=".55" stroke-width="1.1" stroke-linecap="round"/>' +
      /* lens ring + handle */
      '<circle cx="20.5" cy="20.5" r="11.6" fill="none" stroke="#fff" stroke-width="3.2"/>' +
      '<path d="M29.4 29.4 37 37" stroke="#fff" stroke-width="4.6" stroke-linecap="round"/>' +
      '</svg>';
  };

  /* Two-letter monogram on the brand's own gradient. Previously Apple used the
     U+F8FF private-use glyph, which renders as a blank box off Apple platforms. */
  /* ------------------------------------------------------------ brand marks
     ONE resolution path for every brand mark on the site, in priority order:

       1. a licensed file the owner registered   SM.art.registerBrand(id, url)
       2. the inlined official vector mark       SM.brandMarks (CC0, bundled)
       3. a typeset wordmark                     no official mark exists

     Every call site goes through here — the brand rail, the finder panel, the
     models grid, the search dropdown — so a brand looks the same everywhere and
     a newly registered logo appears in all of them at once. SM.art.brand()
     delegates to this rather than duplicating the order.

     The wordmark is reached ONLY for a brand with no official mark, never as a
     stand-in for one that failed to load: a wrong logo is worse than a name. */
  SM.brandFiles = SM.brandFiles || {};

  /* HTML-escape. Brand names are catalogue data, and a name with an ampersand
     in it must not be able to close an attribute. */
  function be(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  /* The chip's paint job, decided once in src/data/brand-assets.js and applied
     here as a class plus one custom property. Every treatment is defined for
     BOTH themes in assets/styles.css, so a logo can never come out invisible in
     one of them. `--bmk` is the brand's own official colour and is the only
     value the three treatments are derived from. */
  function chipAttrs(brand, kind, klass) {
    var A = SM.brandAssets;
    var mode = A ? A.mode(brand.id) : 'tint';
    var hex = A ? A.hex(brand) : String(brand.color || '#0E7A6C').replace(/^#/, '');
    return {
      cls: 'blogo blogo--' + kind + ' blogo--' + mode + (klass ? ' ' + klass : ''),
      style: '--bmk:#' + hex
    };
  }

  SM.brandLogo = function (brand, cls) {
    var b = brand || {};
    var name = String(b.name || '');
    var klass = cls || '';

    var file = SM.brandFiles[b.id];
    if (file) {
      /* The id and class ride on the element rather than being interpolated
         into the handler — nesting quotes inside an inline onerror is how you
         ship a broken attribute that only fails when the image 404s. */
      var a = chipAttrs(b, 'img', klass);
      return '<span class="' + a.cls + '" style="' + a.style + '">' +
        '<img src="' + be(file) + '" alt="' + be(name) + '" loading="lazy" decoding="async" ' +
        'data-brand="' + be(b.id) + '" data-cls="' + be(klass) + '" ' +
        'onerror="SM.brandImgFailed(this)" /></span>';
    }

    var mark = SM.brandMarks && SM.brandMarks[b.id];
    if (mark) {
      /* No width/height on the <svg>: the CSS box is the bounding box, and the
         default preserveAspectRatio="xMidYMid meet" contains the mark inside it.
         A wide mark stays wide, a square one stays square, and nothing is ever
         stretched to fill. `fill` comes from the treatment, not from the path,
         so the same vector reads correctly in both themes. */
      var m = chipAttrs(b, 'mark', klass);
      return '<span class="' + m.cls + '" style="' + m.style + '">' +
        '<svg viewBox="0 0 24 24" role="img" aria-label="' + be(name) + '">' +
        '<path d="' + mark.p + '"/></svg></span>';
    }

    return SM.brandWordmark(b, klass);
  };

  /* A registered logo file failed to load. Fall back to the wordmark rather
     than leaving a broken image — but keep it out of the mark registry, so a
     transient network failure does not permanently demote the brand.

     A brand whose file came from Firebase Storage gets one retry against the
     copy deployed with the site before it gives up: that is the SAME logo, so
     a slow bucket costs a request, not a downgrade. */
  SM.brandImgFailed = function (img) {
    var id = img.getAttribute('data-brand');
    var cls = img.getAttribute('data-cls') || '';
    var fb = SM.brandFileFallbacks && SM.brandFileFallbacks[id];
    if (fb && !img.dataset.fb && img.getAttribute('src') !== fb) {
      img.dataset.fb = '1';
      img.src = fb;
      return;
    }
    var brand = (SM.db && SM.db.brandById && SM.db.brandById[id]) || { id: id, name: id };
    var span = img.parentNode;
    if (span && span.parentNode) span.outerHTML = SM.brandWordmark(brand, cls);
  };

  /* A brand's actual name, set as a proper wordmark — not a two-letter monogram,
     which reads as a logo we invented, and not 8px of body text, which reads as
     a bug. Several of these brands' real logos ARE wordmarks, so a well-set name
     in the brand's own colour is an honest representation rather than a
     stand-in for artwork we do not have.

     Drawn as SVG text rather than HTML so it behaves exactly like a vector mark:
     the viewBox is sized to the name, the browser scales it to the chip's
     bounding box, and it is therefore as large as the box allows at every size
     the chip is used at — 28px in a dropdown, 56px on a model card — with no
     per-size font-size table to keep in step. */
  SM.brandWordmark = function (brand, cls) {
    var b = brand || {};
    var name = String(b.name || '');
    if (!name) return '';

    /* Advance width per character in the display face at font-size 26, bold and
       slightly tightened. Only an estimate — textLength pins the final width
       exactly, so an estimate a little out costs a hair of tracking, not a
       clipped or floating wordmark. */
    var W = Math.max(30, Math.round(name.length * 15.4));
    var a = chipAttrs(b, 'word', cls || '');
    return '<span class="' + a.cls + '" style="' + a.style + '" title="' + be(name) + '">' +
      '<svg viewBox="0 0 ' + W + ' 34" role="img" aria-label="' + be(name) + '">' +
      '<text x="' + (W / 2) + '" y="26" text-anchor="middle" ' +
      'textLength="' + (W - 4) + '" lengthAdjust="spacingAndGlyphs">' + be(name) + '</text>' +
      '</svg></span>';
  };
})(window);

/* === src/ui/product-art.js === */;
/* ============================================================================
   Mobile Parts Finder · product-art.js
   ----------------------------------------------------------------------------
   ONE centralised visual mapping, reused everywhere a category or a brand is
   shown. Nothing else hardcodes an image path.

       categoryId  ->  product render   SM.art.category('battery')
       brandId     ->  brand logo       SM.art.brand(brand)

   Category renders are drawn as vector product cutouts (transparent ground,
   soft shading) and mounted once as an SVG sprite, so a card only costs a
   <use> reference. Swapping in photographed renders later means registering a
   path in SM.art.registerCategory — no component changes.

   Brand logos: SM.art.registerBrand(id, url) points a brand at a real logo
   file; until one is registered the existing monogram chip is used. No
   trademarked artwork is redrawn or approximated here.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  /* ------------------------------------------------------------- gradients */
  var DEFS =
    '<linearGradient id="agGlass" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#EAF6FB"/><stop offset="45%" stop-color="#CFE6F0"/>' +
    '<stop offset="100%" stop-color="#EDF7FA"/></linearGradient>' +

    '<linearGradient id="agShine" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#fff" stop-opacity=".9"/>' +
    '<stop offset="100%" stop-color="#fff" stop-opacity="0"/></linearGradient>' +

    '<linearGradient id="agCover" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#3F5B7A"/><stop offset="52%" stop-color="#22364C"/>' +
    '<stop offset="100%" stop-color="#4A6786"/></linearGradient>' +

    '<linearGradient id="agScreen" x1="0" y1="0" x2="0.6" y2="1">' +
    '<stop offset="0%" stop-color="#1B2733"/><stop offset="55%" stop-color="#0C1219"/>' +
    '<stop offset="100%" stop-color="#16212C"/></linearGradient>' +

    '<linearGradient id="agGlow" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#4EC8F5" stop-opacity=".55"/>' +
    '<stop offset="60%" stop-color="#1E6FA8" stop-opacity=".12"/>' +
    '<stop offset="100%" stop-color="#0B1219" stop-opacity="0"/></linearGradient>' +

    /* black li-ion pouch, matching a real replacement cell */
    '<linearGradient id="agCell" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0%" stop-color="#12181D"/><stop offset="18%" stop-color="#39434B"/>' +
    '<stop offset="45%" stop-color="#1B2228"/><stop offset="100%" stop-color="#0C1114"/></linearGradient>' +

    '<linearGradient id="agMetal" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#D7DEE4"/><stop offset="40%" stop-color="#98A6B2"/>' +
    '<stop offset="70%" stop-color="#C9D3DA"/><stop offset="100%" stop-color="#8B99A6"/></linearGradient>' +

    /* dark matte PCB with gold pads, as on real charging / CC boards */
    '<linearGradient id="agPcb" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#25292E"/><stop offset="55%" stop-color="#14181C"/>' +
    '<stop offset="100%" stop-color="#22272C"/></linearGradient>' +

    '<linearGradient id="agGold" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="#F2D188"/><stop offset="100%" stop-color="#C79A3C"/></linearGradient>' +

    '<linearGradient id="agKapton" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#F5A65A"/><stop offset="100%" stop-color="#D97A25"/></linearGradient>' +

    '<radialGradient id="agShadow" cx="0.5" cy="0.5" r="0.5">' +
    '<stop offset="0%" stop-color="#0A1512" stop-opacity=".30"/>' +
    '<stop offset="100%" stop-color="#0A1512" stop-opacity="0"/></radialGradient>';

  var SHADOW = '<ellipse cx="24" cy="43.6" rx="15" ry="2.6" fill="url(#agShadow)"/>';

  /* --------------------------------------------------------------- symbols */
  /* Every symbol is a 48×48 product cutout on a transparent ground. */
  var SYMBOLS = {

    /* two screen-protector sheets, fanned and tilted, with a heavy glossy
       edge and a bright sweep — reads as glass, not as a phone */
    'tempered-glass':
      SHADOW +
      '<g transform="rotate(-15 24 24)">' +
      '<rect x="9.5" y="8" width="19" height="32" rx="3" fill="#CFE2EA" stroke="#8FA7B3" stroke-width="1.2" opacity=".75"/>' +
      '<rect x="16" y="6" width="20" height="34" rx="3.2" fill="url(#agGlass)" stroke="#161C22" stroke-width="2.3"/>' +
      '<rect x="18.4" y="8.4" width="15.2" height="29.2" rx="1.8" fill="#fff" fill-opacity=".5"/>' +
      '<circle cx="26" cy="11.4" r="1.7" fill="#141A20" fill-opacity=".62"/>' +
      '<path d="M19 36.6 32.4 10.2h3L22 36.6Z" fill="#fff" fill-opacity=".85"/>' +
      '<path d="M16.9 30.6 23.4 17.6" stroke="#fff" stroke-opacity=".95" stroke-width="1.7" stroke-linecap="round"/>' +
      '</g>',

    /* moulded shell seen at an angle: visible side wall gives it depth, and
       the oversized camera island identifies it instantly */
    'back-cover':
      SHADOW +
      '<g transform="rotate(-12 24 24)">' +
      '<path d="M33 7.5c2 0 3.4 1.5 3.4 3.4v26.6c0 1.9-1.4 3.4-3.4 3.4l3.6-2.4c1-.7 1.6-1.7 1.6-3V12.4c0-1.2-.6-2.3-1.6-3Z" fill="#16222E"/>' +
      '<rect x="13" y="7.5" width="20.4" height="33.4" rx="4.4" fill="url(#agCover)"/>' +
      '<rect x="14.4" y="8.9" width="17.6" height="30.6" rx="3.4" fill="#fff" fill-opacity=".08"/>' +
      '<rect x="15.8" y="10.6" width="12.6" height="14.4" rx="3.4" fill="#0E1720"/>' +
      '<circle cx="19.9" cy="14.6" r="2.7" fill="#05090D"/><circle cx="19.9" cy="14" r="1.15" fill="#4E86AE"/>' +
      '<circle cx="19.9" cy="21" r="2.7" fill="#05090D"/><circle cx="19.9" cy="20.4" r="1.15" fill="#4E86AE"/>' +
      '<circle cx="25.2" cy="17.8" r="1.7" fill="#05090D"/>' +
      '<rect x="24.4" y="11.6" width="2.4" height="2.4" rx="1.2" fill="#F5E2AE"/>' +
      '<path d="M14.9 12.4v24" stroke="#fff" stroke-opacity=".32" stroke-width="1.2" stroke-linecap="round"/>' +
      '</g>',

    /* display assembly: the large kapton flex ribbon folding out of the panel
       is the identifying feature, so it gets real size here */
    'combo-display':
      SHADOW +
      '<path d="M30 28c5.6.6 9.4 3 11.4 7.2.7 1.5.2 2.9-1.3 3.5-1.5.6-2.8 0-3.6-1.5-1.3-2.5-3.6-3.9-7-4.2Z" fill="url(#agKapton)"/>' +
      '<rect x="36.8" y="35.4" width="6.6" height="4.4" rx="1.2" fill="#8C4E12"/>' +
      '<path d="M38.2 36.6v2M39.8 36.6v2M41.4 36.6v2" stroke="#F3C68C" stroke-width=".8" stroke-linecap="round"/>' +
      '<g transform="rotate(-8 24 24)">' +
      '<rect x="9" y="5" width="24" height="35" rx="3.2" fill="url(#agScreen)"/>' +
      '<rect x="10.6" y="6.6" width="20.8" height="31.8" rx="2" fill="#04070B"/>' +
      '<rect x="10.6" y="6.6" width="20.8" height="31.8" rx="2" fill="url(#agGlow)"/>' +
      '<circle cx="21" cy="10" r="1.4" fill="#04070A"/>' +
      '<path d="M11.8 35 17.6 8" stroke="#fff" stroke-opacity=".2" stroke-width="2.6" stroke-linecap="round"/>' +
      '</g>',

    /* pouch cell with an unmistakable 3-pin connector on a kapton tab */
    'battery':
      SHADOW +
      '<g transform="rotate(-10 24 24)">' +
      '<path d="M27 8.6h5.6a1.4 1.4 0 0 1 1.4 1.4v2.6h-7Z" fill="url(#agKapton)"/>' +
      '<rect x="30.4" y="5.2" width="8" height="5.2" rx="1.3" fill="#F2F6F8" stroke="#8C9BA7" stroke-width=".8"/>' +
      '<path d="M32.2 6.6v2.4M34.4 6.6v2.4M36.6 6.6v2.4" stroke="#6B7C89" stroke-width="1" stroke-linecap="round"/>' +
      '<rect x="10.6" y="11" width="22" height="29.4" rx="2.4" fill="url(#agCell)" stroke="#05080A" stroke-width=".9"/>' +
      '<path d="M13.4 19.6h16.6" stroke="#8A97A1" stroke-opacity=".7" stroke-width=".9"/>' +
      '<path d="M13.4 16h11.6M13.4 23.4h16M13.4 26.2h13.4M13.4 29h8.6" stroke="#E3EAEF" stroke-opacity=".8" stroke-width="1.1" stroke-linecap="round"/>' +
      '<path d="M12.4 13.2v25" stroke="#fff" stroke-opacity=".35" stroke-width="1.5" stroke-linecap="round"/>' +
      '</g>',

    /* chassis: a genuinely hollow machined frame — the open middle is what
       separates it from a solid phone shape */
    'middle-frame':
      SHADOW +
      '<g transform="rotate(-12 24 24)">' +
      '<path d="M14.4 5.4h19.2a3.2 3.2 0 0 1 3.2 3.2v30.8a3.2 3.2 0 0 1-3.2 3.2H14.4a3.2 3.2 0 0 1-3.2-3.2V8.6a3.2 3.2 0 0 1 3.2-3.2Zm.8 5a1.2 1.2 0 0 0-1.2 1.2v25a1.2 1.2 0 0 0 1.2 1.2h17.6a1.2 1.2 0 0 0 1.2-1.2v-25a1.2 1.2 0 0 0-1.2-1.2Z" fill="url(#agMetal)" fill-rule="evenodd" stroke="#6F7E8A" stroke-width=".7" stroke-linejoin="round"/>' +
      '<rect x="14" y="19.6" width="20" height="2" rx="1" fill="url(#agMetal)" stroke="#7A8894" stroke-width=".4"/>' +
      '<rect x="14" y="28.4" width="20" height="2" rx="1" fill="url(#agMetal)" stroke="#7A8894" stroke-width=".4"/>' +
      '<rect x="36.6" y="14" width="2.2" height="5" rx="1.1" fill="#8A98A4"/>' +
      '<rect x="36.6" y="21" width="2.2" height="8" rx="1.1" fill="#8A98A4"/>' +
      '<rect x="9.2" y="16" width="2.2" height="6" rx="1.1" fill="#8A98A4"/>' +
      '<path d="M12.6 9.6v29" stroke="#fff" stroke-opacity=".7" stroke-width="1.2" stroke-linecap="round"/>' +
      '</g>',

    /* CC board: small PCB, IC, gold contact pads */
    'cc-board':
      SHADOW +
      '<rect x="7.5" y="14" width="33" height="20.4" rx="2.2" fill="url(#agPcb)"/>' +
      '<rect x="8.9" y="15.4" width="30.2" height="17.6" rx="1.6" fill="#fff" fill-opacity=".07"/>' +
      '<rect x="17.4" y="18.6" width="13.4" height="9.6" rx="1.2" fill="#1B2026"/>' +
      '<rect x="19" y="20.2" width="10.2" height="3" rx=".6" fill="#3A434C"/>' +
      '<path d="M17.4 21.2h-2.6M17.4 23.6h-2.6M17.4 26h-2.6M30.8 21.2h2.6M30.8 23.6h2.6M30.8 26h2.6" stroke="#C9CFD5" stroke-width=".9" stroke-linecap="round"/>' +
      '<rect x="11" y="30.4" width="3.4" height="3.6" rx=".5" fill="url(#agGold)"/>' +
      '<rect x="16" y="30.4" width="3.4" height="3.6" rx=".5" fill="url(#agGold)"/>' +
      '<rect x="21" y="30.4" width="3.4" height="3.6" rx=".5" fill="url(#agGold)"/>' +
      '<rect x="26" y="30.4" width="3.4" height="3.6" rx=".5" fill="url(#agGold)"/>' +
      '<rect x="33.4" y="17" width="4" height="2.6" rx=".6" fill="#D8C089"/>' +
      '<circle cx="12.6" cy="18.6" r="1.5" fill="#0E1F18"/>',

    /* charging board: PCB strip with USB-C receptacle */
    'charging-board':
      SHADOW +
      '<rect x="9" y="11.5" width="30" height="25" rx="2.2" fill="url(#agPcb)"/>' +
      '<rect x="10.4" y="12.9" width="27.2" height="22.2" rx="1.6" fill="#fff" fill-opacity=".07"/>' +
      '<rect x="16.6" y="27.8" width="14.8" height="6.4" rx="3.2" fill="url(#agMetal)" stroke="#6E7E8B" stroke-width=".7"/>' +
      '<rect x="19" y="29.9" width="10" height="2.2" rx="1.1" fill="#2B343C"/>' +
      '<rect x="12.4" y="13.8" width="3.2" height="3.4" rx=".5" fill="url(#agGold)"/>' +
      '<rect x="17.2" y="13.8" width="3.2" height="3.4" rx=".5" fill="url(#agGold)"/>' +
      '<rect x="22" y="13.8" width="3.2" height="3.4" rx=".5" fill="url(#agGold)"/>' +
      '<rect x="26.8" y="13.8" width="3.2" height="3.4" rx=".5" fill="url(#agGold)"/>' +
      '<rect x="13" y="20.4" width="8.6" height="4.4" rx="1" fill="#1B2026"/>' +
      '<circle cx="33.4" cy="22.6" r="2.4" fill="#0E1F18"/><circle cx="33.4" cy="22.6" r="1" fill="#4C5A63"/>' +
      '<circle cx="26.6" cy="21.6" r="1.4" fill="#8A5A24"/>',

    /* assorted spares: speaker, screw, flex cable */
    'spare-parts':
      SHADOW +
      '<path d="M9 33.6c5-6.4 12-9.4 20.4-8.6l.5 3.6c-7.2-.7-13 1.7-17.4 7.1Z" fill="url(#agKapton)"/>' +
      '<rect x="27.4" y="23.2" width="5.6" height="4" rx="1" fill="#8C4E12"/>' +
      '<rect x="7.5" y="8" width="18" height="12.4" rx="2" fill="#2B333B"/>' +
      '<rect x="9.2" y="9.7" width="14.6" height="9" rx="1.2" fill="#495661"/>' +
      '<path d="M11 12h11M11 14.2h11M11 16.4h11" stroke="#2B333B" stroke-width="1" stroke-linecap="round"/>' +
      '<circle cx="34.5" cy="13.5" r="6" fill="url(#agMetal)" stroke="#7B8994" stroke-width=".8"/>' +
      '<path d="M34.5 10.2v6.6M31.2 13.5h6.6" stroke="#5E6C77" stroke-width="1.5" stroke-linecap="round"/>' +
      '<circle cx="16.5" cy="33.5" r="4.6" fill="url(#agMetal)" stroke="#7B8994" stroke-width=".8"/>' +
      '<circle cx="16.5" cy="33.5" r="1.8" fill="#6E7C87"/>',

    /* all categories: a fanned collection — glass, cover, battery, board */
    'all':
      SHADOW +
      '<g transform="rotate(-26 24 24)">' +
      '<rect x="5.5" y="10" width="15" height="26" rx="2.6" fill="url(#agGlass)" stroke="#161C22" stroke-width="1.7"/>' +
      '<path d="M8 32.6 16.4 13.4" stroke="#fff" stroke-opacity=".9" stroke-width="1.5" stroke-linecap="round"/>' +
      '</g>' +
      '<g transform="rotate(-7 24 24)">' +
      '<rect x="14.6" y="7" width="15.4" height="27" rx="3.2" fill="url(#agCover)"/>' +
      '<rect x="16.4" y="9" width="7.6" height="9.4" rx="2.2" fill="#0E1720"/>' +
      '<circle cx="18.8" cy="11.6" r="1.6" fill="#05090D"/><circle cx="18.8" cy="15.6" r="1.6" fill="#05090D"/>' +
      '</g>' +
      '<g transform="rotate(13 24 24)">' +
      '<rect x="25.6" y="9.4" width="13.6" height="23" rx="2" fill="url(#agCell)" stroke="#748796" stroke-width=".8"/>' +
      '<rect x="27.2" y="16.6" width="10.4" height="8" rx="1.1" fill="#123243" fill-opacity=".92"/>' +
      '<path d="M27.2 11.4v19" stroke="#fff" stroke-opacity=".8" stroke-width="1.3" stroke-linecap="round"/>' +
      '</g>' +
      '<g transform="rotate(9 24 24)">' +
      '<rect x="17" y="30.4" width="19" height="10.6" rx="1.8" fill="url(#agPcb)"/>' +
      '<rect x="22.6" y="33" width="8" height="5.2" rx="1" fill="#1B2026"/>' +
      '<rect x="18.6" y="38.4" width="2.8" height="2.2" rx=".4" fill="url(#agGold)"/>' +
      '<rect x="22.6" y="38.4" width="2.8" height="2.2" rx=".4" fill="url(#agGold)"/>' +
      '<rect x="26.6" y="38.4" width="2.8" height="2.2" rx=".4" fill="url(#agGold)"/>' +
      '</g>'
  };

  /* ------------------------------------------------------------- registries */
  var catImages = Object.create(null);   /* categoryId -> image url (optional) */
  var brandLogos = Object.create(null);  /* brandId    -> logo url  (optional) */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  var failedPhotos = Object.create(null);

  SM.art = {
    /* inject the sprite once */
    mount: function () {
      if (document.getElementById('sm-art-sprite')) return;
      var svg = '<svg id="sm-art-sprite" aria-hidden="true" focusable="false" ' +
        'style="position:absolute;width:0;height:0;overflow:hidden"><defs>' + DEFS + '</defs>' +
        Object.keys(SYMBOLS).map(function (k) {
          return '<symbol id="art-' + k + '" viewBox="0 0 48 48">' + SYMBOLS[k] + '</symbol>';
        }).join('') + '</svg>';
      var holder = document.createElement('div');
      holder.innerHTML = svg;
      document.body.appendChild(holder.firstChild);
    },

    /* swap a drawn render for a photographed one, without touching components */
    /* Points a category at its official picture.
       `fallbackUrl` is the SAME official logo, deployed with the site — used
       when the primary does not load, so a network problem shows the right
       part rather than a drawn icon of a different one. */
    registerCategory: function (id, url, fallbackUrl) {
      catImages[id] = { url: url, fallback: fallbackUrl || null };
    },
    /* Points a brand at its licensed logo file.
       `fallbackUrl` is the SAME logo deployed with the site, tried once if the
       primary does not load — so a slow or misconfigured bucket costs a request
       rather than demoting the brand to a wordmark. */
    registerBrand: function (id, url, fallbackUrl) {
      SM.brandFiles[id] = url;
      SM.brandFileFallbacks = SM.brandFileFallbacks || {};
      if (fallbackUrl && fallbackUrl !== url) SM.brandFileFallbacks[id] = fallbackUrl;
    },

    /* categoryId -> product render, wrapped in a light product thumbnail */
    /* THE one place a category picture is resolved. Every surface — the finder
       rail, the category tiles, group cards, group sheets, category headers,
       search results — already comes through here, so registering an official
       logo once makes all of them correct at the same moment. No component
       chooses its own icon, and the same category cannot end up showing two
       different pictures in two places.

       Spellings resolve through SM.categoryAssets, so "screen-guards",
       "Screen Guard" and "tempered glass" all land on the same asset. */
    /* @param {object} [opts]  { cutout: true } serves the transparent copy of
       the master where one exists — the phone rail, whose cards sit on the
       green hero. It is the SAME artwork with the background flood-filled out,
       and it degrades through the same chain: cutout, then the original, then
       the drawn symbol. Everywhere else is unaffected and still gets the
       original on its white chip. */
    category: function (categoryId, cls, label, opts) {
      var key = categoryId;
      if (!catImages[key] && SM.categoryAssets) {
        key = SM.categoryAssets.resolve(categoryId) || categoryId;
      }
      var id = SYMBOLS[categoryId] ? categoryId : (categoryId === 'all' ? 'all' : 'spare-parts');
      var entry = catImages[key];
      var inner;

      var cut = (opts && opts.cutout && SM.categoryAssets && SM.categoryAssets.cutout)
        ? SM.categoryAssets.cutout(key) : null;

      if (entry || cut) {
        /* Two steps down, and the first step is the identical official file
           served from this site. The drawn symbol appears only when both are
           unreachable — a generic icon must never quietly stand in for a
           specific part, because that is worse than showing nothing. */
        var primary = cut || (entry && entry.url);
        var second = cut ? ((entry && (entry.bundledOrUrl || entry.fallback || entry.url)) || null)
                         : (entry && entry.fallback);
        var onerr = second
          ? 'if(this.dataset.fb){this.replaceWith(SM.art.svgOnly(\'' + esc(id) + '\'))}' +
            'else{this.dataset.fb=1;this.src=\'' + esc(second) + '\'}'
          : 'this.replaceWith(SM.art.svgOnly(\'' + esc(id) + '\'))';
        /* EAGER where the picture is positioned absolutely with an auto
           height, which is every focus-fitted box. Such an image is 0px tall
           until it loads, a zero-area box never intersects anything, and a
           lazy image that never intersects never loads — so it stays 0px
           forever. The tiles get away with it only because the group cards
           warm the same URLs into cache first; the rail's cutouts are used
           nowhere else, so nothing warms them and the strip came up empty.
           Seven images in the hero is not what `loading=lazy` is for. */
        var load = (opts && opts.eager) ? 'eager' : 'lazy';
        inner = '<img class="pimg" src="' + esc(primary) + '" alt="' + esc(label || '') + '" ' +
          'loading="' + load + '" decoding="async" onerror="' + onerr + '" />';
      } else {
        inner = this.svgMarkup(id);
      }
      /* Where the part sits inside its canvas, so a tile can fit the PART
         rather than the white it stands in. Harmless everywhere else: only
         .pthumb--tile reads these, and a category with no measurement simply
         gets none and keeps plain contain behaviour. */
      var vars = (SM.categoryAssets && SM.categoryAssets.focusVars) ? SM.categoryAssets.focusVars(key) : '';
      return '<span class="pthumb ' + (cls || '') + '"' + (vars ? ' style="' + vars + '"' : '') + '>' +
        inner + '</span>';
    },

    svgMarkup: function (id) {
      return '<svg class="pimg" viewBox="0 0 48 48" role="img" aria-hidden="true"><use href="#art-' + id + '"></use></svg>';
    },
    /* DOM node version used by the <img> onerror fallback */
    svgOnly: function (id) {
      var d = document.createElement('div');
      d.innerHTML = SM.art.svgMarkup(id);
      return d.firstChild;
    },

    /* Draws the DEVICE, not its brand.
       There is no product photography in the sample data, and a stock photo of
       the wrong handset is worse than a drawing — so each device is rendered
       from its own numbers: true aspect ratio from the screen resolution, a
       corner radius by tier, the camera treatment its brand and year actually
       use, and the finish the viewer picked. Every model therefore looks
       different from its siblings, which is the whole point of showing a
       device image instead of repeating one brand logo down a grid.

       A tablet and a watch get their own silhouette; running them through the
       phone proportions makes an iPad look like a very tall phone.

       @param {object} m            the device
       @param {number} [colourIdx]  which finish
       @param {string} [cls]        extra classes on the wrapper
       @param {boolean} [flat]      draw without the wrapper (grid thumbnails) */
    device: function (m, colourIdx, cls) {
      var sp = m.specs || {};
      var col = (sp.colors && sp.colors[colourIdx || 0]) || { n: 'Black', h: '#15171A' };
      var type = m.deviceType || 'phone';

      var res = String(m.screenResolution || '').match(/(\d+)\s*x\s*(\d+)/);
      var pw = res ? Number(res[1]) : 1080;
      var ph = res ? Number(res[2]) : 2340;
      var ratio = ph / pw;
      if (type === 'tablet') ratio = 1.42;          /* tablets are far squarer */
      if (type === 'watch') ratio = 1.18;           /* and a watch is nearly square */

      var W = 150;
      var H = Math.round(W * ratio);
      var pad = type === 'watch' ? 8 : 6;
      var radius = type === 'watch' ? 34 : type === 'tablet' ? 12 : (m.tier === 'flag' ? 22 : 18);

      /* A pale finish needs an outline or it disappears against the light chip. */
      var lum = parseInt(col.h.slice(1, 3), 16) * 0.299 +
                parseInt(col.h.slice(3, 5), 16) * 0.587 +
                parseInt(col.h.slice(5, 7), 16) * 0.114;
      var outline = lum > 190 ? ' stroke="rgba(0,0,0,.22)" stroke-width="1"' : '';

      var uid = 'dg' + Math.random().toString(36).slice(2, 8);
      var camera = type !== 'phone' ? ''
        : (m.brandId === 'apple' && m.releaseYear >= 2022)
          ? '<rect x="' + (W / 2 - 17) + '" y="' + (pad + 6) + '" width="34" height="11" rx="5.5" fill="#05090A"/>'
          : '<circle cx="' + (W / 2) + '" cy="' + (pad + 12) + '" r="4.4" fill="#05090A"/>';

      /* the strap makes a watch read as a watch at thumbnail size */
      var strap = type !== 'watch' ? '' :
        '<rect x="' + (W * 0.3) + '" y="' + (-H * 0.16) + '" width="' + (W * 0.4) + '" height="' + (H * 0.2) +
        '" rx="6" fill="' + esc(col.h) + '" opacity=".75"/>' +
        '<rect x="' + (W * 0.3) + '" y="' + (H * 0.96) + '" width="' + (W * 0.4) + '" height="' + (H * 0.2) +
        '" rx="6" fill="' + esc(col.h) + '" opacity=".75"/>';

      var vb = type === 'watch'
        ? ('0 ' + (-H * 0.18) + ' ' + W + ' ' + (H * 1.36))
        : ('0 0 ' + W + ' ' + H);

      return '<svg class="dvc ' + (cls || '') + '" viewBox="' + vb + '" role="img" ' +
        'aria-label="' + esc(m.fullName) + ' in ' + esc(col.n) + '">' +
        '<defs><linearGradient id="' + uid + '" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#fff" stop-opacity=".28"/>' +
        '<stop offset=".45" stop-color="#fff" stop-opacity=".04"/>' +
        '<stop offset="1" stop-color="#000" stop-opacity=".18"/></linearGradient></defs>' +
        strap +
        '<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="' + radius + '" fill="' + esc(col.h) + '"' + outline + '/>' +
        '<rect x="' + pad + '" y="' + pad + '" width="' + (W - pad * 2) + '" height="' + (H - pad * 2) +
        '" rx="' + Math.max(2, radius - 5) + '" fill="#0B1211"/>' +
        '<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="' + radius + '" fill="url(#' + uid + ')"/>' +
        camera +
        '</svg>';
    },

    /* ------------------------------------------------------------- photo

       The manufacturer's own photograph of THIS handset, from the image URL
       the import stored on the model. 4,873 of the 4,933 devices have one.

       device() above draws a handset from its numbers, which is the right
       answer for a grid of sixty thumbnails and the wrong one for the page
       about a single phone: a drawing of a Coolpad C35 and a drawing of a
       Redmi 13 differ only in corner radius. So the real photograph leads
       here, and the drawing stays as the fallback for the sixty devices with
       no image and for a URL that fails to load.

       No width or height is imposed. A tablet is not a tall phone and a watch
       is neither; the container bounds the image and object-fit:contain keeps
       whatever ratio the file actually has.

       @param {object} m          the device
       @param {object} [opts]     {src, colourIdx, cls, eager, alt, fallback}
                                  fallback: HTML to show instead of the drawing,
                                  already carrying the dphoto__art class
    */
    photo: function (m, opts) {
      opts = opts || {};
      var url = opts.src || m.image || null;
      if (url && failedPhotos[url]) url = null;
      var cls = opts.cls ? ' ' + opts.cls : '';
      var alt = opts.alt || m.fullName || '';
      /* The drawing ships with every photo rather than being swapped in by a
         second render pass: onerror fires long after the HTML is written, and
         the fallback has to already be in the DOM for CSS to reveal it. */
      var art = opts.fallback || SM.art.device(m, opts.colourIdx || 0, 'dphoto__art');
      if (!url) return '<span class="dphoto dphoto--art' + cls + '">' + art + '</span>';
      return '<span class="dphoto' + cls + '">' +
        '<img class="dphoto__img" src="' + esc(url) + '" alt="' + esc(alt) + '" ' +
          'loading="' + (opts.eager ? 'eager' : 'lazy') + '" decoding="async" ' +
          /* The image host is a third party; sending it this site's URLs on
             every device page is a referrer leak with nothing to gain. */
          'referrerpolicy="no-referrer" ' +
          'onload="this.closest(&quot;.dphoto&quot;).classList.add(&quot;is-loaded&quot;)" ' +
          'onerror="SM.art.photoFailed(this)" />' +
        art + '</span>';
    },

    /* Remembered for the session, so a dead URL is asked for once and not again
       on every filter change that happens to redraw the card. */
    photoFailed: function (img) {
      failedPhotos[img.getAttribute('src')] = 1;
      var box = img.closest('.dphoto');
      if (box) box.classList.add('is-failed');
    },

    /* Delegates to SM.brandLogo, which owns the file -> vector -> wordmark
       order. Kept as an alias because callers and docs already use it. */
    brand: function (brand, cls) { return SM.brandLogo(brand, cls); }
  };
})(window);

/* === src/data/category-assets.js === */;
/* ============================================================================
   Mobile Parts Finder · category-assets.js — the official category logos
   ----------------------------------------------------------------------------
   GENERATED. Do not edit by hand.

       python scripts/build-category-assets.py --src "<folder of masters>"
       node scripts/upload-category-assets.js --project mobilepartsfindercom

   ONE MAPPING, EVERY SURFACE

     Category logos are resolved here and nowhere else. Registering them into
     SM.art means every existing call site — the finder rail, the category
     tiles, group cards, group sheets, category headers, search results — shows
     the same official picture for the same category, because they all already
     go through SM.art.category(). No component picks its own icon.

   ALIASES

     The same category is spelled several ways across the source data and the
     SEO pages: "screen-guards", "screen guard", "tempered glass". They all
     resolve to one asset, so a naming variation can never produce a different
     logo for the same part.

   TWO URLS PER CATEGORY, AND WHY

     storage  Firebase Storage — the system of record, and what the site loads.
     bundled  the identical file deployed with the site.

     The bundled copy is the fallback, and it is the SAME OFFICIAL LOGO, not a
     generic stand-in. If Storage is slow, blocked or misconfigured the category
     still shows its own picture rather than a drawn icon that means something
     else.

   Generated 2026-09-04T19:53:23.052Z

   2026-09-29 — every `storage` URL was cleared by hand, on purpose. They all
   pointed into the RETIRED Firebase project's bucket
   (mobilepartsfinder.firebasestorage.app), which answers 404, so every logo
   was a failed request before the bundled copy took over. With storage null
   the bundled file is the primary — the state the generator itself writes for
   a category not uploaded yet — and the logos cost no Storage operations at
   all. Running the uploader against the new project
   (`--project mobilepartsfindercom`) regenerates this file with that bucket's
   URLs, if Storage is ever wanted as the system of record again.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  var ASSETS = {
    'screen-guards': {
      label: "Screen Guards",
      storage: null,
      bundled: "/assets/categories/screen-guards.png",
      focus: { iw: 1.2516, il: -0.1258, it: 0.0417 }
    },
    /* storage is null while the bucket still holds the OLD photograph. The
       master was re-shot (black cover -> pink cover) and the bundled copy is
       the new one; pointing at Storage would serve the retired picture as the
       primary and the new one only if Storage failed, which is backwards.
       Re-run the uploader and this row gets its URL back. */
    'back-cover': {
      label: "Back Cover",
      storage: null,
      bundled: "/assets/categories/back-cover.png",
      focus: { iw: 1.221, il: -0.1105, it: 0.0421 }
    },
    'combo-display': {
      label: "Combo/Display",
      storage: null,
      bundled: "/assets/categories/combo-display.png",
      focus: { iw: 1.221, il: -0.1105, it: 0.0457 }
    },
    'middle-frame': {
      label: "Middle Frame",
      storage: null,
      bundled: "/assets/categories/middle-frame.png",
      focus: { iw: 1.2412, il: -0.1182, it: 0.0345 }
    },
    'cc-board': {
      label: "CC Board",
      storage: null,
      bundled: "/assets/categories/cc-board.png",
      focus: { iw: 1.0478, il: -0.0219, it: 0.1853 }
    },
    'battery': {
      label: "Battery",
      storage: null,
      bundled: "/assets/categories/battery.png",
      focus: { iw: 1.2947, il: -0.1448, it: 0.0183 }
    },
    /* Not uploaded yet, so storage is null and the bundled copy IS the
       primary. A URL for an object that does not exist would cost every
       visitor a 404 before falling back to the file sitting beside it. */
    'button-flex': {
      label: "Button Flex",
      storage: null,
      bundled: "/assets/categories/button-flex.png",
      focus: { iw: 1.2836, il: -0.207, it: 0.0186 }
    },
    'sim-tray': {
      label: "SIM Tray",
      storage: null,
      bundled: "/assets/categories/sim-tray.png",
      focus: { iw: 1.2361, il: -0.1181, it: 0.0383 }
    }
  };

  /* Spellings that mean the same category. The app's own ids are the keys of
     ASSETS above; these are the variants that appear in source data, URLs and
     copy. Normalised the same way on both sides, so case and punctuation do not
     matter. */
  var ALIASES = {
    'screen-guards': ['screen', 'screens', 'screen guard', 'screen guards', 'screenguard',
                      'tempered glass', 'temperedglass', 'glass', 'universal tempered glass',
                      'sg'],
    'back-cover':    ['back cover', 'backcover', 'cover', 'universal back cover', 'bc'],
    'combo-display': ['combo display', 'combodisplay', 'combo/display', 'display', 'combo',
                      'folder', 'lcd', 'cd'],
    'middle-frame':  ['middle frame', 'middleframe', 'frame', 'mid frame', 'mf'],
    'cc-board':      ['cc board', 'ccboard', 'charging board', 'charging connector board',
                      'connector board', 'cc'],
    'battery':       ['battery', 'batteries', 'bt'],
    'button-flex':   ['button flex', 'buttonflex', 'power flex', 'volume flex',
                      'power volume flex', 'on off flex', 'switch flex', 'bf'],
    'sim-tray':      ['sim tray', 'simtray', 'sim holder', 'sim slot', 'sim card tray',
                      'tray', 'st']
  };

  /* Categories with a transparent-background copy of their master, for the
     phone's category rail — where the cards sit on the green hero and a white
     rectangle around every part reads as a sticker stuck onto it.

     GENERATED by scripts/build-category-cutouts.py, which flood-fills only the
     white CONNECTED TO THE EDGE, so white enclosed by the product (a glass
     sheet, a battery label, the inside of a frame) survives. A category whose
     cutout would have clipped the part is not listed here and keeps the
     original — the desktop tiles use the originals regardless, where a white
     card is deliberate. */
  var CUTOUTS = ["back-cover", "battery", "button-flex", "cc-board", "combo-display", "middle-frame", "screen-guards", "sim-tray"];

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  var LOOKUP = Object.create(null);
  Object.keys(ASSETS).forEach(function (id) {
    LOOKUP[norm(id)] = id;
    LOOKUP[norm(ASSETS[id].label)] = id;
    (ALIASES[id] || []).forEach(function (a) { LOOKUP[norm(a)] = id; });
  });

  SM.categoryAssets = {
    /** Canonical category id for any spelling, or null. */
    resolve: function (nameOrId) {
      return LOOKUP[norm(nameOrId)] || null;
    },

    /** { storage, bundled, label, focus } for a category, or null. */
    get: function (nameOrId) {
      var id = this.resolve(nameOrId);
      return id ? ASSETS[id] : null;
    },

    /**
     * Where the PART sits inside its canvas, as CSS custom properties.
     *
     * The masters are square canvases with the part standing in a lot of
     * white — a back cover is 45% of its own picture. `object-fit: contain`
     * fits the CANVAS, so the part renders at 45% of the tile however large
     * the tile is; enlarging the card alone cannot change that. These three
     * numbers scale and offset the image so the PART fills the tile instead,
     * with the width set and the height left auto so it cannot be distorted.
     *
     * Measured by scripts/build-category-focus.py for the tile's aspect
     * ratio. Only .pthumb--tile consumes them, so every other surface keeps
     * plain contain behaviour.
     */
    /** The transparent copy for this category, or null when there is none. */
    cutout: function (nameOrId) {
      var id = this.resolve(nameOrId);
      return (id && CUTOUTS.indexOf(id) > -1)
        ? '/assets/categories/cutout/' + id + '.png' : null;
    },

    focusVars: function (nameOrId) {
      var e = this.get(nameOrId);
      var f = e && e.focus;
      if (!f) return '';
      return '--iw:' + (f.iw * 100) + '%;--il:' + (f.il * 100) + '%;--it:' + (f.it * 100) + '%';
    },

    /** Every category that has an official logo. */
    ids: function () { return Object.keys(ASSETS); },

    /**
     * Registers every logo with SM.art, which is what the whole UI already
     * calls. One call, and every surface is correct at once.
     */
    install: function () {
      if (!SM.art || !SM.art.registerCategory) return false;
      Object.keys(ASSETS).forEach(function (id) {
        var e = ASSETS[id];
        /* Two copies where there are two: Storage first, the deployed file as
           the second chance. One copy where there is only one — a category
           whose logo has not been uploaded serves the file deployed beside it
           and has no second chance to offer, so none is registered. Naming the
           same URL twice would only buy a pointless retry of a request that
           has already failed. */
        SM.art.registerCategory(id, e.storage || e.bundled, e.storage ? e.bundled : null);
      });
      return true;
    }
  };
})(window);

/* === src/data/brand-assets.js === */;
/* ============================================================================
   Mobile Parts Finder · brand-assets.js — brand logo files and how they’re shown
   ----------------------------------------------------------------------------
   The brand twin of category-assets.js. One place decides, for every brand,
   WHICH picture is its logo and HOW that logo is presented. No component picks
   a colour, a background or a file path of its own.

   THREE TIERS, IN THIS ORDER  (resolved by SM.brandLogo in src/ui/icons.js)

     1. a licensed logo FILE        this file’s `storage`, else `bundled`
     2. the inlined official vector SM.brandMarks — CC0, zero requests
     3. a typeset wordmark          the brand’s own name, set properly

   Tier 2 is deliberately preferred over shipping the same artwork as a file:
   an inline vector costs no request, paints with the first frame and can be
   RECOLOURED per theme, which an <img> cannot. So `storage` is populated only
   where it adds something tier 2 cannot — a brand Simple Icons does not carry,
   or a licensed logo the owner wants to override a CC0 one with.

   FIREBASE STORAGE

     Objects live at  brand-assets/<brand-id>/logo.<ext>  in the project’s
     EXISTING bucket, alongside category-assets/. Public read, no client write —
     see storage.rules. Upload with:

         node scripts/upload-brand-assets.js --project mobilepartsfindercom

     which fills in the `storage` URLs below. Until then a brand with no file
     simply falls through to tier 2 or tier 3 — never to a broken image.

   PRESENTATION  (`mode`)

     Brand colours are published against white, so painting them straight onto a
     dark page misrepresents the brand and sinks the dark marks. Rather than one
     white chip for everyone — which looks like a sticker sheet — each brand gets
     one of three treatments, and each treatment is defined for BOTH themes in
     assets/styles.css. Three, not twenty-two: a rail of saturated colour blocks
     is not a product, it is a bag of sweets.

       'tint'   pale wash of the brand’s own colour, mark in that colour.
                The default, and what most brands should be.
       'solid'  the brand colour fills the chip and the mark reverses to white.
                Reserved for identities that ARE a colour block.
       'mono'   neutral chip, mark in the theme’s ink. For monochrome
                identities, which would otherwise vanish in one theme or the
                other — a black Apple mark on a black page.

     The colour itself is never written here. It comes from the brand’s official
     hex in SM.brandMarks, or from the catalogue’s own brand colour when there is
     no mark — one source of truth either way.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  /* id: { storage, bundled, mode }
     `storage`  Firebase Storage URL, written by scripts/upload-brand-assets.js.
     `bundled`  the same file deployed with the site — the fallback if Storage
                is slow, blocked or misconfigured, so a brand never degrades to
                a broken image.
     Both null means: no licensed file yet, use the inline vector or wordmark. */
  var ASSETS = {
    apple:    { storage: null, bundled: null, mode: 'mono'  },
    asus:     { storage: null, bundled: null, mode: 'mono'  },
    coolpad:  { storage: null, bundled: null, mode: 'tint'  },
    google:   { storage: null, bundled: null, mode: 'tint'  },
    hmd:      { storage: null, bundled: null, mode: 'tint'  },
    honor:    { storage: null, bundled: null, mode: 'mono'  },
    huawei:   { storage: null, bundled: null, mode: 'solid' },
    infinix:  { storage: null, bundled: null, mode: 'tint'  },
    itel:     { storage: null, bundled: null, mode: 'tint'  },
    lava:     { storage: null, bundled: null, mode: 'tint'  },
    lenovo:   { storage: null, bundled: null, mode: 'tint'  },
    motorola: { storage: null, bundled: null, mode: 'tint'  },
    nokia:    { storage: null, bundled: null, mode: 'solid' },
    nothing:  { storage: null, bundled: null, mode: 'mono'  },
    oneplus:  { storage: null, bundled: null, mode: 'solid' },
    oppo:     { storage: null, bundled: null, mode: 'tint'  },
    realme:   { storage: null, bundled: null, mode: 'tint'  },
    samsung:  { storage: null, bundled: null, mode: 'tint'  },
    tecno:    { storage: null, bundled: null, mode: 'tint'  },
    vivo:     { storage: null, bundled: null, mode: 'tint'  },
    xiaomi:   { storage: null, bundled: null, mode: 'tint'  },
    zte:      { storage: null, bundled: null, mode: 'tint'  },

    /* shipped marks for brands the catalogue may carry again */
    sony:     { storage: null, bundled: null, mode: 'mono'  },
    lg:       { storage: null, bundled: null, mode: 'tint'  },
    htc:      { storage: null, bundled: null, mode: 'tint'  }
  };

  var DEFAULT_MODE = 'tint';

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  var LOOKUP = Object.create(null);
  Object.keys(ASSETS).forEach(function (id) { LOOKUP[norm(id)] = id; });

  SM.brandAssets = {
    /** Canonical brand id for any spelling, or null. */
    resolve: function (idOrName) {
      return LOOKUP[norm(idOrName)] || null;
    },

    /** { storage, bundled, mode } for a brand, or null when unknown. */
    get: function (idOrName) {
      var id = this.resolve(idOrName);
      return id ? ASSETS[id] : null;
    },

    /** How this brand’s chip is painted: 'tint' | 'solid' | 'mono'. */
    mode: function (idOrName) {
      var e = this.get(idOrName);
      return (e && e.mode) || DEFAULT_MODE;
    },

    /**
     * The brand’s own colour, as a hex WITHOUT the leading hash — the official
     * mark’s hex when there is a mark, else the catalogue’s brand colour. The
     * three treatments in assets/styles.css are all derived from this one
     * value, so a brand can never be half one colour and half another.
     */
    hex: function (brand) {
      var b = brand || {};
      var mark = SM.brandMarks && SM.brandMarks[b.id];
      if (mark && mark.h) return String(mark.h).replace(/^#/, '');
      return String(b.color || '#0E7A6C').replace(/^#/, '');
    },

    /** Every brand that has a licensed logo file to load. */
    withFile: function () {
      return Object.keys(ASSETS).filter(function (id) {
        return !!(ASSETS[id].storage || ASSETS[id].bundled);
      });
    },

    /**
     * Registers the licensed files with SM.art, which every logo call site
     * already goes through. Brands without a file are left alone so they keep
     * their inline vector — registering an <img> for artwork we already have
     * inline would trade a first-frame paint for a network request.
     */
    install: function () {
      if (!SM.art || !SM.art.registerBrand) return false;
      var n = 0;
      Object.keys(ASSETS).forEach(function (id) {
        var url = ASSETS[id].storage || ASSETS[id].bundled;
        if (!url) return;
        SM.art.registerBrand(id, url, ASSETS[id].bundled);
        n++;
      });
      return n;
    }
  };
})(window);

/* === src/data/pwa.js === */;
/* ============================================================================
   Mobile Parts Finder · pwa.js — installing the app, and sharing it
   ----------------------------------------------------------------------------
   ONE PLACE that knows whether this browser can install the site, whether it
   already has, and how to share a link. The header, the sign-in flow and the
   sheets all read it; none of them touch a browser API themselves.

   THE INSTALL PROMPT IS NOT OURS TO SUMMON

     Chrome fires `beforeinstallprompt` when IT decides the site qualifies, and
     the deferred event can be used exactly once, only from a real user
     gesture. So: catch it, keep it, and show the button only while it is
     actually in hand. Every other browser — Firefox, and every iOS browser,
     which are all Safari underneath — never fires it, and there is no way to
     ask. Those get instructions instead of a button that cannot work.

     Nothing here fakes a prompt, and nothing pretends to be browser chrome.
     A dialog that imitates the system one is how a site teaches people to
     trust dialogs that imitate the system one.

   ALREADY INSTALLED

     display-mode: standalone (and navigator.standalone, which is how iOS says
     the same thing) means the app IS the window this is running in. Offering
     to install it there is offering something already had.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  var deferred = null;          /* the BeforeInstallPromptEvent, while it lasts */
  var installed = false;        /* appinstalled has fired this session */
  var listeners = [];

  var SHARE_URL = 'https://www.mobilepartsfinder.com/';
  var SHARE_TITLE = 'Mobile Parts Finder';
  var SHARE_TEXT = 'Find which spare parts fit any phone — compatibility groups ' +
                   'for 4,900+ mobile models, with the master model and part code for each.';

  function emit() {
    listeners.forEach(function (fn) {
      try { fn(); } catch (e) { /* a listener must not break the next one */ }
    });
  }

  /* Running as an installed app rather than in a browser tab. */
  function standalone() {
    try {
      if (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches) return true;
      if (global.matchMedia && global.matchMedia('(display-mode: window-controls-overlay)').matches) return true;
    } catch (e) { /* older browsers */ }
    return !!(global.navigator && global.navigator.standalone);   /* iOS */
  }

  /* iOS has no install prompt at all — Safari's own Share ▸ Add to Home Screen
     is the only route, and every browser on iOS is Safari underneath, so
     "Chrome on iPhone" cannot install either. Worth telling people rather than
     leaving them with a button that does nothing. */
  function isIOS() {
    var ua = (global.navigator && global.navigator.userAgent) || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    /* iPadOS 13+ reports itself as a Mac; a touch-capable "Mac" is an iPad. */
    return /Macintosh/.test(ua) && (global.navigator.maxTouchPoints || 0) > 1;
  }

  SM.pwa = {
    /** A real, unused install prompt is in hand. */
    canInstall: function () { return !!deferred && !installed && !standalone(); },

    /** The app is already installed, or we are running inside it. */
    isInstalled: function () { return installed || standalone(); },

    isStandalone: standalone,
    isIOS: isIOS,

    /** True where the browser could install but has not offered yet, or never
        will — the case that needs instructions rather than a button. */
    needsManualInstall: function () {
      return !this.isInstalled() && !deferred && isIOS();
    },

    /**
     * Fires the browser's own install prompt. MUST be called from a user
     * gesture — Chrome rejects it otherwise, and the deferred event is then
     * spent either way, so it is cleared whatever the answer.
     *
     * Resolves 'accepted' | 'dismissed' | 'unavailable'.
     */
    install: function () {
      if (!deferred) return Promise.resolve('unavailable');
      var evt = deferred;
      deferred = null;                       /* single use, by specification */
      emit();
      var done = evt.prompt();
      return Promise.resolve(done).then(function () {
        return evt.userChoice;
      }).then(function (choice) {
        var outcome = (choice && choice.outcome) || 'dismissed';
        SM.debug.log('pwa', 'install prompt answered', { outcome: outcome });
        return outcome;
      }, function (err) {
        SM.debug.warn('pwa', 'install prompt failed', { message: err && err.message });
        return 'unavailable';
      });
    },

    /** The phone's own share sheet is available. */
    canShareNatively: function () {
      return !!(global.navigator && typeof global.navigator.share === 'function');
    },

    shareData: function () {
      return { title: SHARE_TITLE, text: SHARE_TEXT, url: SHARE_URL };
    },

    /**
     * Hands the link to the system share sheet.
     * Resolves 'shared' | 'dismissed' | 'unavailable' — the caller opens its
     * own fallback for 'unavailable' and does nothing for 'dismissed', since
     * a share the user backed out of is not an error to report.
     */
    share: function () {
      if (!this.canShareNatively()) return Promise.resolve('unavailable');
      return global.navigator.share(this.shareData()).then(function () {
        return 'shared';
      }, function (err) {
        /* AbortError is the user closing the sheet — an outcome, not a fault. */
        if (err && err.name === 'AbortError') return 'dismissed';
        SM.debug.warn('pwa', 'native share failed', { name: err && err.name });
        return 'unavailable';
      });
    },

    /** Re-render hook for anything that draws an install or share control. */
    onChange: function (fn) {
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i > -1) listeners.splice(i, 1);
      };
    },

    /**
     * Registers the service worker and starts listening. Called once at boot.
     *
     * The worker is what makes the site installable at all — Chrome will not
     * offer to install a site with no fetch handler — and it is deliberately
     * network-first, so it cannot serve a stale build. See sw.js.
     */
    init: function () {
      global.addEventListener('beforeinstallprompt', function (e) {
        /* Chrome would otherwise show its own mini-infobar; taking the event
           means the site decides where the offer appears. */
        e.preventDefault();
        deferred = e;
        SM.debug.log('pwa', 'install prompt available');
        emit();
      });

      global.addEventListener('appinstalled', function () {
        installed = true;
        deferred = null;
        SM.debug.log('pwa', 'app installed');
        try { localStorage.setItem('mpf.pwa.installed', '1'); } catch (e) { /* private mode */ }
        emit();
      });

      /* Leaving the browser tab for the installed window counts as installed
         for this session too, so the button does not linger. */
      try {
        if (global.matchMedia) {
          global.matchMedia('(display-mode: standalone)').addEventListener('change', emit);
        }
      } catch (e) { /* Safari < 14 has no addEventListener here */ }

      if (!('serviceWorker' in global.navigator)) return;
      /* file:// and the single-file dist build have no origin to scope to. */
      if (global.location.protocol !== 'https:' && global.location.hostname !== 'localhost') return;

      global.addEventListener('load', function () {
        /* updateViaCache:'none' — the browser caches sw.js like any other
           script, and a cached worker keeps serving its own old shell after a
           deploy has replaced it. Revalidating the worker script itself is the
           difference between shipping a fix and shipping it to people who
           already have the site. */
        global.navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(function (reg) {
          SM.debug.log('pwa', 'service worker registered', { scope: reg.scope });
        }, function (err) {
          /* Not fatal: the site works, it simply cannot be installed. */
          SM.debug.warn('pwa', 'service worker registration failed', { message: err && err.message });
        });
      });
    }
  };
})(window);

/* === src/ui/components.js === */;
/* ============================================================================
   Mobile Parts Finder · components.js
   Reusable render functions. Every one takes plain data and returns an HTML
   string — no framework, no duplicated markup across pages.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});
  var icon = SM.icon;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function mark(text, q) {
    if (!q) return esc(text);
    var i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  }
  function nf(n) { return Number(n).toLocaleString('en-IN'); }

  var C = {};
  C.esc = esc;
  C.mark = mark;
  C.nf = nf;

  /* ------------------------------------------------------------- skeletons */
  C.skelPlate = function () {
    return '<div class="skelplate" aria-hidden="true">' +
      '<div class="skel" style="height:14px;width:62%"></div>' +
      '<div class="skel" style="height:26px;width:80%"></div>' +
      '<div class="skel" style="height:44px;width:100%"></div>' +
      '<div style="display:flex;gap:6px"><div class="skel" style="height:22px;width:88px"></div><div class="skel" style="height:22px;width:104px"></div><div class="skel" style="height:22px;width:70px"></div></div>' +
      '</div>';
  };
  C.skelPlates = function (n) {
    var out = '';
    for (var i = 0; i < (n || 6); i++) out += C.skelPlate();
    return '<div class="gridcards">' + out + '</div>';
  };
  C.skelRows = function (n) {
    var out = '';
    for (var i = 0; i < (n || 8); i++) out += '<div class="skel" style="height:66px;border-radius:15px"></div>';
    return '<div class="modelgrid">' + out + '</div>';
  };

  /* ------------------------------------------------------------- states */
  C.state = function (o) {
    return '<div class="state">' +
      '<div class="state__art ' + (o.brand ? 'state__art--brand' : '') + '">' + icon(o.icon || 'search') + '</div>' +
      '<h3>' + esc(o.title) + '</h3>' +
      (o.text ? '<p>' + esc(o.text) + '</p>' : '') +
      (o.action || '') +
      '</div>';
  };

  /* ------------------------------------------------------------- search UI */
  C.suggestion = function (m, q, cursor, opts) {
    opts = opts || {};
    var b = SM.db.brandById[m.brandId];
    return '<button class="sug' + (cursor ? ' is-cursor' : '') + '" data-act="pick-model" data-id="' + m.id + '" type="button">' +
      /* history items are marked with a clock so they read as past searches */
      (opts.recent ? '<span class="sug__hist">' + icon('history') + '</span>' : SM.brandLogo(b)) +
      '<span class="sug__body">' +
      '<span class="sug__name">' + mark(m.fullName, q) + '</span>' +
      '<span class="sug__meta">' +
        [ esc(b.name),
          m.displaySize ? esc(m.displaySize) + '&Prime;' + (m.screenType ? ' ' + esc(m.screenType) : '') : null,
          m.releaseYear ? esc(String(m.releaseYear)) : null
        ].filter(Boolean).join(' <i></i> ') + '</span>' +
      '</span>' +
      '<span class="sug__go">' + icon('arrowRight') + '</span>' +
      '</button>';
  };

  /* ------------------------------------------------------- category pieces */
  C.categoryCard = function (cat, count, opts) {
    opts = opts || {};
    var off = opts.dim && !count;
    return '<button type="button" class="cat' + (opts.active ? ' is-on' : '') + (off ? ' is-off' : '') + '" ' +
      'data-act="' + (opts.act || 'pick-cat') + '" data-id="' + cat.id + '" style="--c:' + cat.color + '"' + (off ? ' disabled' : '') + '>' +
      '<span class="cat__tick">' + icon('checkCircle') + '</span>' +
      SM.art.category(cat.id, 'pthumb--cat', cat.name) +
      '<span class="cat__name">' + esc(cat.name) + '</span>' +
      '<span class="cat__n">' + (count == null ? cat.groupCount + ' groups' : count ? count + (count === 1 ? ' group' : ' groups') : 'No group yet') + '</span>' +
      '</button>';
  };


  /* WHICH MODELS A GROUP COVERS, BY NAME — free, on the card.

     The card used to say "19 devices in this Guard group" and stop there:
     a number with no phone in it. It now names a handful of them, as the same
     thin outlined chips the result page's compact view uses — the master
     first, with its crown, then the preview the server chose for this group,
     then "+13 more" for the rest.

     The names come from /api/device-parts?previews= (SM.access.previews),
     never from the public bundle, and there are previewSize() of them at most
     — about three in ten of the group, and always fewer than all of it. The
     card is drawn before that answer when it is slow, with an empty slot that
     C.fillPreviews fills in place.

     Spans, not buttons: the whole card is the control (it opens the group),
     and a button inside a button is two targets where a hand sees one. */
  C.groupPreview = function (row) {
    var g = row.group, master = row.master;
    var got = SM.access && SM.access.previewOf ? SM.access.previewOf(g.groupId) : null;
    if (!got) {
      return '<div class="pchips pchips--wait" data-gprev="' + esc(g.groupId) + '" aria-hidden="true"></div>';
    }
    var list = [], seen = Object.create(null);
    var add = function (m) {
      if (!m || seen[m.id]) return;
      seen[m.id] = 1;
      list.push(m);
    };
    add(master);
    (got.preview || []).forEach(function (p) {
      add(SM.db.modelById[p.id] || { id: p.id, fullName: p.name || p.id });
    });
    var total = Number(got.memberCount) || g.compatibleCount || 0;
    var more = Math.max(0, total - list.length);
    /* data-more is the count the server's preview leaves out. C.fitPreviews
       adds to it whatever does not fit the card's three rows, so the number
       on "+N more" is always the number of names the reader cannot see. */
    return '<div class="pchips" data-more="' + more + '" aria-label="Some of the devices in this group">' +
      list.map(function (m) {
        var isMaster = master && m.id === master.id;
        return '<span class="mchip mchip--static' + (isMaster ? ' is-master' : '') + '">' +
          (isMaster ? '<span class="mchip__flag">' + icon('crown') + '<span class="sr">Master model: </span></span>' : '') +
          '<span class="mchip__n">' + esc(m.fullName) + '</span></span>';
      }).join('') +
      (more ? '<span class="mchip mchip--more">' + icon('lock') + '+' + more + ' more</span>' : '') +
      '</div>';
  };

  /* EVERY CARD THE SAME HEIGHT.

     The names sit in a box exactly three chip-rows tall, so a card's height
     no longer depends on how many names its group has or how long they are —
     a row of cards lines up, and a carousel is a row of equal tiles rather
     than a skyline. Names that do not fit the three rows are hidden from the
     end (never the master, which leads) and counted into "+N more", so the
     number stays true.

     Measured, because chip widths depend on the names, the font and the card
     width. A box is refitted only when its width has changed, so a page of
     new cards costs a pass over the new cards and a resize one pass over all.

     @param {Element} [root]
     @param {boolean} [force]  refit even at an unchanged width (fonts loaded) */
  C.fitPreviews = function (root, force) {
    var scope = root || document;
    Array.prototype.forEach.call(scope.querySelectorAll('.pchips[data-more]'), function (box) {
      var w = String(box.clientWidth);
      if (!w || w === '0' || (!force && box.getAttribute('data-fitw') === w)) return;
      box.setAttribute('data-fitw', w);

      var base = Number(box.getAttribute('data-more')) || 0;
      var names = box.querySelectorAll('.mchip--static');
      var more = box.querySelector('.mchip--more');
      var cut = 0;
      var setMore = function () {
        var n = base + cut;
        if (!n) { if (more) more.hidden = true; return; }
        if (!more) {
          more = document.createElement('span');
          more.className = 'mchip mchip--more';
          box.appendChild(more);
        }
        more.hidden = false;
        more.innerHTML = icon('lock') + '+' + n + ' more';
      };
      for (var i = 0; i < names.length; i++) names[i].hidden = false;
      setMore();
      for (var j = names.length - 1; j > 0 && box.scrollHeight > box.clientHeight + 1; j--) {
        names[j].hidden = true;
        cut++;
        setMore();
      }
    });
  };

  /* Fills the slots of cards that were drawn before their previews arrived.
     Only the empty slots are touched, so nothing already on screen moves. */
  C.fillPreviews = function (root) {
    var scope = root || document;
    Array.prototype.forEach.call(scope.querySelectorAll('[data-gprev]'), function (el) {
      var id = el.getAttribute('data-gprev');
      var g = SM.db.groupById[id];
      if (!g || !(SM.access && SM.access.previewOf(id))) return;
      var master = SM.db.modelById[g.masterModelId];
      if (!master) return;
      el.outerHTML = C.groupPreview({ group: g, master: master });
    });
    C.fitPreviews(scope);
  };

  C.plate = function (row, opts) {
    opts = opts || {};
    var g = row.group, cat = row.category, master = row.master;
    var b = SM.db.brandById[master.brandId];

    return '<article class="plate" style="--c:' + cat.color + '" data-act="open-group" data-id="' + g.groupId + '" ' +
      'tabindex="0" role="button" aria-label="Open group ' + esc(g.groupNumber) + ' — ' + esc(master.fullName) + '">' +
      /* Our part code leads: it is what a shop writes down. The manufacturer's
         code takes its place where the catalogue has one, because that is the
         string a supplier recognises. */
      '<div class="plate__strip">' +
      '<span>' + esc(g.groupNumber) + '</span><span class="sep">/</span>' +
      '<span>' + esc(g.oemPartNo || g.partCode || '—') + '</span>' +
      '<span class="plate__catbadge">' + esc(cat.short) + '</span>' +
      '</div>' +
      '<div class="plate__body">' +
      /* the category render carries the visual identity — which part this is */
      '<div class="plate__master">' + SM.art.category(cat.id, 'pthumb--plate', cat.name) +
      '<div class="grow">' +
      '<span class="masterflag">' + icon('crown') + 'Master model</span>' +
      '<h3 class="plate__mname">' + esc(master.fullName) + '</h3>' +
      /* screenType is recorded for 260 of 4,933 devices, so the separators are
         built from what is actually there. Printing "6.4″ <i></i>  <i></i> 2020"
         left a floating divider with nothing on either side of it. */
      '<div class="plate__mmeta">' +
      [ master.displaySize ? esc(master.displaySize) + '&Prime;' : null,
        master.screenType ? esc(master.screenType) : null,
        master.releaseYear ? esc(String(master.releaseYear)) : null
      ].filter(Boolean).join(' <i></i> ') + '</div>' +
      '</div></div>' +

      '<div class="fitline">' +
      '<span class="fitline__n">' + g.compatibleCount + '</span>' +
      '<span class="fitline__t">' + (g.compatibleCount === 1
        ? 'model-specific part<br>no shared fitment'
        : 'devices in this<br>' + esc(cat.short) + ' group') + '</span>' +
      '</div>' +

      C.groupPreview(row) +
      '</div>' +
      '<div class="plate__foot">' +
      '<span class="mono">' + esc(g.serialNumber) + '</span>' +
      '<button class="plate__cta" type="button" data-act="open-group" data-id="' + g.groupId + '">' +
      'Open group ' + icon('arrowRight') + '</button>' +
      '</div>' +
      '</article>';
  };

  /* ---------------------------------------------------- compatible devices */
  /* Renders in chunks — a 268-device group stays instant on a phone. */
  C.deviceRows = function (devices, opts) {
    opts = opts || {};
    return devices.map(function (d, i) {
      var cls = 'dev';
      if (d.id === opts.masterId) cls += ' is-master';
      else if (d.id === opts.hitId) cls += ' is-hit';
      return '<button class="' + cls + '" type="button" data-act="open-model" data-id="' + d.id + '">' +
        '<span class="dev__i">' + String((opts.offset || 0) + i + 1).padStart(3, '0') + '</span>' +
        '<span class="dev__n">' + esc(d.fullName) + '</span>' +
        (d.id === opts.masterId ? '<span class="pill pill--amber" style="height:20px;font-size:10px">MASTER</span>'
          : d.id === opts.hitId ? '<span class="pill pill--brand" style="height:20px;font-size:10px">YOUR MODEL</span>' : '') +
        '<span class="dev__b">' + d.displaySize + '&Prime;</span>' +
        '</button>';
    }).join('');
  };

  /* ---------------------------------------------------------- brand/model */
  /* A NEW MODEL, as a product card: the manufacturer's own photograph on top,
     the name and the screen size under it, and one action.

     The photograph is the URL the GSMArena import stored on the model — the
     real press shot, not a drawing. When a model has none, or the URL fails,
     the card falls back to SM.art.device(), which draws THAT handset from its
     own numbers (its true aspect ratio, its finish, its camera treatment)
     rather than showing a generic phone or a brand logo standing in for a
     product. A wrong picture of a phone is worse than an honest drawing of it.

     The action is a search icon and nothing else. It carries the model name in
     its accessible name, so "Search parts for Huawei Mate 80 Pro Max" is what
     a screen reader announces — the label the icon is standing in for. */
  C.newModelCard = function (m) {
    var alt = m.fullName + ' — press image';
    var art = m.image
      ? '<img class="ncard__img" src="' + esc(m.image) + '" alt="' + esc(alt) + '" ' +
        'loading="lazy" decoding="async" ' +
        'onerror="SM.modelShotFailed(this,\'' + esc(m.id) + '\')" />'
      : SM.art.device(m, 0, 'ncard__svg');

    var bits = [];
    if (m.displaySize) bits.push(m.displaySize + '&Prime;');
    if (m.releaseYear) bits.push(esc(String(m.releaseYear)));

    return '<article class="ncard">' +
      '<div class="ncard__shot">' + art + '</div>' +
      '<div class="ncard__body">' +
      '<h4 class="ncard__n" title="' + esc(m.fullName) + '">' + esc(m.fullName) + '</h4>' +
      (bits.length ? '<span class="ncard__m">' + bits.join(' <i></i> ') + '</span>' : '') +
      '</div>' +
      '<button type="button" class="ncard__go" data-act="find-parts" data-id="' + esc(m.id) + '" ' +
      'title="Search parts for ' + esc(m.fullName) + '" ' +
      'aria-label="Search parts for ' + esc(m.fullName) + '">' + icon('search') + '</button>' +
      '</article>';
  };

  /* The press shot did not load. Swap in the drawing of that same handset —
     never a broken-image glyph, and never a different phone. */
  SM.modelShotFailed = function (img, modelId) {
    var m = SM.db && SM.db.modelById && SM.db.modelById[modelId];
    if (!m || !img.parentNode) { img.remove(); return; }
    img.outerHTML = SM.art.device(m, 0, 'ncard__svg');
  };

  C.specSheet = function (m) {
    var rows = [
      ['Brand', m.brand], ['Model name', m.modelName], ['Release date', m.releaseDate],
      ['Display size', m.displaySize + '"'], ['Resolution', m.screenResolution],
      ['Screen ratio', m.screenRatio], ['Screen type', m.screenType],
      ['Refresh rate', m.refreshRate], ['Pixel density', m.ppi], ['Protection', m.protection],
      ['Height', m.height], ['Width', m.width], ['Thickness', m.thickness], ['Weight', m.weight],
      ['SIM', m.sim]
    ];
    return '<dl class="specs">' + rows.map(function (r) {
      return '<div class="spec"><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>';
    }).join('') + '</dl>';
  };

  /* ------------------------------------------------------------- paywall */
  C.paywall = function (o) {
    o = o || {};
    return '<div class="paywall">' +
      '<div class="paywall__lock">' + icon(o.icon || 'lock') + '</div>' +
      '<h3>' + esc(o.title || 'Device Finder is a Pro feature') + '</h3>' +
      '<p>' + esc(o.text || 'Browsing every phone model stays free forever. Matching a model to its compatibility group, part code and full fitment list needs an active plan.') + '</p>' +
      '<div class="paywall__acts">' +
      '<button class="btn btn--amber" data-act="go-plans">' + icon('crown') + 'See plans from ₹99</button>' +
      '</div></div>';
  };

  /* ---------------------------------------------------------------- plans */
  C.planCard = function (plan, opts) {
    opts = opts || {};
    var hero = plan.id === 'yearly';
    return '<div class="plan' + (hero ? ' plan--hero' : '') + '">' +
      (plan.badge ? '<span class="plan__tag">' + esc(plan.badge) + '</span>' : '') +
      '<div class="plan__in">' +
      '<div class="plan__name">' + esc(plan.name) + '</div>' +
      '<div class="plan__price"><b>₹' + plan.price + '</b><span>/ ' + esc(plan.per) + '</span></div>' +
      '<div class="plan__note">' + esc(plan.cadence) + ' · ' + esc(plan.note) + '</div>' +
      '<ul class="plan__feats">' + plan.feats.map(function (f) {
        return '<li>' + icon('checkCircle') + '<span>' + esc(f) + '</span></li>';
      }).join('') + '</ul>' +
      (opts.current
        ? '<button class="btn btn--block ' + (hero ? 'btn--outline' : 'btn--soft') + '" disabled>' + icon('check') + 'Your current plan</button>'
        : opts.owned
        /* The account already holds everything this plan sells, for good.
           The server refuses the order as well; this just does not offer it. */
        ? '<button class="btn btn--block btn--soft" disabled>' + icon('check') + 'Included in your access</button>'
        : '<button class="btn btn--block ' + (hero ? 'btn--amber' : 'btn--primary') + '" data-act="subscribe" data-id="' + plan.id + '">' +
        icon('bolt') + 'Choose ' + esc(plan.name) + '</button>') +
      '</div></div>';
  };

  SM.C = C;
})(window);

/* === src/app.js === */;
/* ============================================================================
   Mobile Parts Finder · app.js — shell, hash router, pages, interactions
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, C = SM.C, icon = SM.icon, api = SM.api, db = SM.db, S = SM.session;
  (SM.__rebind = SM.__rebind || []).push(function () { db = SM.db; });
  var esc = C.esc, nf = C.nf;

  /* An id, safe to put inside a CSS selector. Model ids are slugs today, so
     nothing needs escaping — but a selector built by concatenation is a
     selector that breaks the first time the catalogue ships an id with a dot
     in it, and that failure looks like a UI bug rather than a data one. */
  function cssEsc(v) {
    var s = String(v == null ? '' : v);
    return (global.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
  }

  /* ------------------------------------------------------------------ state */
  var state = {
    theme: store('mpf.theme') || 'system',
    deviceColour: 0,        /* which finish the device page is showing */
    deviceId: null,
    deviceVariant: null,  /* {ramGb, storageGb} the detail page is showing */
    route: { name: 'finder', params: {} },
    base: '/finder',
    finder: {
      modelId: null, catId: null, query: '', matchShown: 6, avail: null,
      filters: { q: '', brandId: 'all', catId: 'all', sort: 'mixed', view: 'both' },
      page: 1, rows: [], total: 0, hasMore: false, busy: false,
      /* The trending head of the feed, and how many groups sit BELOW it. The
         header still counts everything the filter matches, so `total` cannot
         also stand for "how many are left to page through". */
      trending: [], suggest: [], newModels: [], restTotal: 0,
      /* An open compatibility group, and which of its devices the right panel
         is describing. Both null means the finder is in its default state. */
      groupId: null, groupShown: 400,
      /* The devices in the open group, as /api/device-parts returned them for
         THIS account. Not read from the catalogue: the fitment list is the
         paid half and no longer ships to the browser.

           null  not asked yet, or asking
           []    asked, and this account may not have them
           [..]  a subscriber's real list

         `groupLocked` is the server saying which of the last two it is, so an
         empty list is never rendered as "this group has no devices". */
      groupMembers: null, groupLocked: false, groupLoadFailed: false,
      /* How a list of compatible models is drawn: 'compact' (names in thin
         outlines), 'grid' (photographs) or 'table' (specifications). Compact
         first, on the result page and on every freshly opened group. */
      resultView: 'compact', groupView: 'compact',
      /* The rows the last search returned, kept so the header can count the
         distinct devices it was actually given rather than guessing. */
      matches: null
    },
    models: { brandId: null, q: '', page: 1, items: [], total: 0, hasMore: false, busy: false, seq: 0,
      /* View state, not query state: the same records are already in memory,
         so a dropdown change re-renders instead of re-fetching. The chosen
         view is remembered because it is a working preference, not a session
         detail — someone who prefers the table wants it next time too. */
      view: store('mpf.modelview') || 'grid',
      sort: 'newest',
      filters: { deviceType: '', curve: '', year: '', size: '', fiveG: '', minRam: '', minStorage: '', minBattery: '' }
    },
    recent: [],
    /* How many columns the category grid uses. A working preference, like the
       models view above — someone who wants the wider two-up tiles wants them
       next time too, so it is remembered on the device rather than stored
       against an account. Read back through a whitelist: a stale or hand-edited
       value must not be able to produce a grid with no columns. */
    catCols: store('mpf.catcols') === '2' ? 2 : 3,
    brandQ: '',
    suggest: { open: false, q: '', items: [], cursor: -1 },
    sheet: null,           /* { type:'group'|'model'|'filters'|'demo', id } */
    /* Why the Plans page was just opened for this visitor, if it was sent
       there: { kind:'search'|'group', modelId? }. Cleared on leaving it. */
    planNotice: null,
  };

  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v); return v;
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ theme */
  function applyTheme() {
    var r = document.documentElement;
    if (state.theme === 'system') r.removeAttribute('data-theme');
    else r.setAttribute('data-theme', state.theme);
  }
  function cycleTheme() {
    var sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var now = state.theme === 'system' ? (sysDark ? 'dark' : 'light') : state.theme;
    state.theme = now === 'dark' ? 'light' : 'dark';
    store('mpf.theme', state.theme);
    applyTheme(); renderShellBits();
  }

  /* ------------------------------------------------------------------ toast */
  function toast(msg, ic) {
    var wrap = document.getElementById('toasts');
    var el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = icon(ic || 'checkCircle') + '<span>' + esc(msg) + '</span>';
    wrap.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0'; el.style.transform = 'translateY(8px)';
      setTimeout(function () { el.remove(); }, 260);
    }, 2600);
  }

  /* ------------------------------------------------------------------ shell */
  var NAV = [
    { id: 'finder', href: '/finder', label: 'Device Finder', short: 'Finder', icon: 'search' },
    { id: 'models', href: '/models', label: 'All Mobile Models', short: 'Models', icon: 'grid' },
    /* The shop's own counter, not the catalogue. Centred in the phone tab bar
       and drawn in its own blue so it never reads as another Finder view. */
    { id: 'billing', href: '/billing', label: 'Quick Billing', short: 'Quick Billing', icon: 'receipt', accent: true },
    { id: 'plans', href: '/plans', label: 'Plans', short: 'Plans', icon: 'crown' },
    { id: 'account', href: '/account', label: 'Account', short: 'Account', icon: 'user' }
  ];

  function mountShell() {
    document.getElementById('app').innerHTML =
      '<header class="topbar"><div class="shell topbar__in">' +
      '<div class="topbar__lead">' +
      '<a class="logo" href="/finder" aria-label="Mobile Parts Finder home">' + SM.logoMark(34) +
      '<span class="logo__word">Mobile Parts <em>Finder</em></span></a>' +
      '<nav class="nav" id="nav"></nav>' +
      '</div>' +
      /* primary search lives in the header on desktop; the hero copy below
         takes over under 1180px (only one is ever visible) */
      '<div class="topbar__search">' + searchBoxHTML('qh') + '</div>' +
      '<div class="topbar__stats">' + statsHTML() + '</div>' +
      '<div class="topbar__end" id="topEnd"></div>' +
      '</div></header>' +
      '<main class="main" id="page"></main>' +
      '<nav class="tabbar" id="tabbar" aria-label="Primary"></nav>' +
      '<div id="overlay"></div>' +
      '<div class="toasts" id="toasts" aria-live="polite"></div>';
  }

  function renderShellBits() {
    var cur = state.route.name;
    document.getElementById('nav').innerHTML = NAV.map(function (n) {
      return '<a class="nav__a' + (n.accent ? ' nav__a--qb' : '') + (cur === n.id ? ' is-on' : '') + '" href="' + n.href + '" title="' + esc(n.label) + '"' +
        (cur === n.id ? ' aria-current="page"' : '') + '>' +
        icon(n.icon) + '<span>' + esc(n.label) + '</span></a>';
    }).join('');

    document.getElementById('tabbar').innerHTML = NAV.map(function (n) {
      /* The accent tab's icon sits in its own raised, rounded container. */
      return '<a class="tab' + (n.accent ? ' tab--qb' : '') + (cur === n.id ? ' is-on' : '') + '" href="' + n.href + '"' +
        (cur === n.id ? ' aria-current="page"' : '') + '>' +
        (n.accent ? '<span class="tab__qb">' + icon(n.icon) + '</span>' : icon(n.icon)) +
        '<span>' + esc(n.short) + '</span></a>';
    }).join('');

    var s = S.get();
    var dark = state.theme === 'dark' || (state.theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    /* Install and Share sit with the other header icons rather than as new
       chrome of their own, so the row keeps its height and its spacing.

       Install appears ONLY while the browser has actually offered — a real
       beforeinstallprompt in hand, or an iPhone, where there is no prompt to
       have and instructions are the only honest answer. Once installed it
       stops appearing at all. */
    var end = '';
    if (SM.pwa && !SM.pwa.isInstalled() && (SM.pwa.canInstall() || SM.pwa.needsManualInstall())) {
      end += '<button class="iconbtn" data-act="pwa-install" title="Install app" ' +
        'aria-label="Install Mobile Parts Finder as an app">' + icon('install') + '</button>';
    }
    if (SM.pwa) {
      end += '<button class="iconbtn" data-act="pwa-share" title="Share" aria-label="Share Mobile Parts Finder">' +
        icon('share') + '</button>';
    }
    end += '<button class="iconbtn" data-act="open-filters" title="Filters" aria-label="Filter groups">' + icon('sliders') + '</button>' +
      '<button class="iconbtn" data-act="theme" title="Switch theme" aria-label="Switch colour theme">' + icon(dark ? 'sun' : 'moon') + '</button>';
    /* Free searches left. Only for a free account, only once the SERVER
       has said so, and never for a subscriber — a paid user should not be
       reading a counter about a limit they do not have. Deliberately small and
       to the left of the avatar rather than a banner across the page. */
    end = freeSearchChipHTML() + end;

    /* ------------------------------------------- signed in is not the same as
       having a profile.

       `s.status` is derived from the LOCAL profile cache, so it reads 'guest'
       whenever users/{uid} could not be loaded — which is what happens while
       the database is refusing. The header then offered "Sign in" to somebody
       Google had signed in moments earlier, and pressing it did the whole
       Google dance again to arrive back in the same place.

       Firebase is the authority on whether there is a session. It is asked
       directly here, and a signed-in user with no readable profile gets a link
       to the account screen — which explains the fault and offers the retry —
       rather than an invitation to do something they have already done.

       This deliberately does NOT promote them out of 'guest' anywhere else.
       Access is decided by the server, and a profile that could not be read is
       not evidence of a subscription. */
    var fbSignedIn = !!(SM.fb && SM.fb.user && SM.fb.user());

    if (s.status === 'guest' && !fbSignedIn) {
      end += '<a class="btn btn--primary btn--sm" href="/account">Sign in</a>';
    } else if (s.status === 'guest') {
      end += '<a class="btn btn--outline btn--sm" href="/account">Account</a>';
    } else {
      end += '<a class="avatar" href="/account" title="' + esc(s.name) + '">' + esc(initials(s.name)) + '</a>';
    }
    document.getElementById('topEnd').innerHTML = end;

    /* keep the header field in sync without stealing what is being typed */
    var qh = document.getElementById('qh');
    if (qh && document.activeElement !== qh) qh.value = state.finder.query;
  }
  function initials(n) {
    return (n || 'PG').split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
  }

  /* "3/5 free searches" while some remain, "Upgrade" once they are gone.
     Renders nothing at all for a paid account, a signed-out visitor, or before
     the server has answered — an entitlement chip drawn on a guess is a chip
     that flickers the wrong number on every page load. */
  function freeSearchChipHTML() {
    /* isMeteredAccount, not isFree: the chip counts an ACCOUNT's allowance, and
       a signed-out visitor has no account to count. They see the Sign in
       button instead, which is the more useful thing to show them. */
    if (!SM.access || !SM.access.isMeteredAccount()) return '';
    var a = SM.access.get();
    var left = SM.access.remaining();
    if (!a || left == null) return '';

    /* The title says it plainly: these do not come back. */
    if (left > 0) {
      return '<a class="pill" href="/plans" title="Free searches left on this account. They do not reset.">' +
        icon('search') + left + '/' + a.searchLimit + ' free</a>';
    }
    return '<a class="pill pill--warn" href="/plans" ' +
      'title="All 5 free searches used. A plan keeps you searching.">' +
      icon('lock') + 'Upgrade</a>';
  }

  /* ----------------------------------------------------------------- router */
  /* ------------------------------------------------------------- URL shape

     Clean paths are the canonical form — /models/apple, /categories/cc-board,
     /finder. Hash URLs still work, because every link shared before this change
     is one, and they are rewritten to the clean equivalent on arrival so a page
     never has two addresses at once.

     A search engine needs one URL per page, and it needs that URL to be the one
     it can put in a result. #/models/apple is a fragment: to a crawler the
     whole site is one page called "/". */

  /* Routes the APP owns and renders.

     Deliberately not everything the site serves. /universal-tempered-glass,
     /categories/cc-board and /mobile-parts-finder are pre-rendered pages with
     their own content; the app has no screen for them and must leave them
     alone. Listing them here made the app rewrite the URL to /finder and paint
     the finder over the page — the address bar said one thing and the screen
     said another, which is the exact problem clean URLs were added to fix. */
  var ROUTES = { finder: 1, models: 1, model: 1, plans: 1, account: 1, group: 1, billing: 1 };

  /** True when this URL is a page the app renders.

     The bare "/" is deliberately NOT one of them, and that is a correction.
     `!first` used to make it one, and the cost was the whole homepage:
     normaliseUrl rewrote / to /finder, applySeo then overwrote the canonical,
     title and description with the finder's, and the observer in index.html
     deleted the pre-rendered content. Google indexes the RENDERED page, so its
     stored copy of the front page carried
     `<link rel="canonical" href=".../finder">` and the title "Mobile
     Compatibility Finder" — the site's own name was no longer the first thing
     on its own homepage, and the one URL a brand search ranks was telling
     Google it was a duplicate of something else. Search Console confirmed it:
     user-declared canonical /finder on an inspection of /.

     So / is now treated exactly like /categories/cc-board and
     /universal-tempered-glass: a pre-rendered page the app leaves alone. The
     finder keeps its own URL at /finder. */
  function ownsPath(url) {
    var raw = String(url || '').replace(/^#\/?/, '').replace(/^\/+/, '').split(/[?#]/)[0];
    var first = raw.split('/').filter(Boolean)[0];
    return !!first && !!ROUTES[first];
  }

  function toPath(route) {
    var parts = [route.name].concat(route.params || []).filter(Boolean);
    if (!parts.length || parts[0] === 'finder') return '/finder';
    return '/' + parts.map(encodeURIComponent).join('/');
  }

  /* Accepts either shape, so existing call sites passing '#/plans' keep working
     and nothing had to be rewritten twice. */
  function toRoute(url) {
    var raw = String(url || '').replace(/^#\/?/, '').replace(/^\/+/, '').split(/[?#]/)[0];
    var parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
    var name = parts[0] || 'finder';
    if (!ROUTES[name]) return { name: 'finder', params: [] };
    return { name: name, params: parts.slice(1) };
  }

  function parseHash() {
    /* A hash wins when present: it means an old link was opened, and boot()
       converts it to the clean path immediately afterwards. */
    return toRoute(location.hash ? location.hash : location.pathname);
  }

  function route() {
    var r = parseHash();

    /* A group is a STATE OF THE FINDER, not a window over it.

       It used to open a sheet: a scrim over the whole page, the categories on
       the left and the brands on the right covered up, and the only way back a
       Close button. That is a browser popup wearing the app's colours — and it
       threw away the two panels a person filters with at the moment they had
       something to filter.

       So /group/<id> now resolves to the finder with that group selected. The
       URL still says which group, so it is still shareable and still
       bookmarkable; the centre column holds the group's devices and the right
       panel holds whichever device is selected. Nothing overlays anything. */
    /* A notice the Plans page shows once, for whoever was just sent there. */
    if (r.name !== 'plans') state.planNotice = null;

    if (r.name === 'group') {
      /* OPENING A GROUP SPENDS ONE OF THE FIVE, as a search does. A visitor
         goes to Sign in; a free account opens the group in its loading state
         and loadGroupMembers spends the credit, or sends it to Plans when the
         five are used. The server withholds the list until the credit is
         spent, so a typed URL, a Back button or a crafted request get nothing. */
      if (r.params[0] && refuseGroup(r.params[0])) return;
      state.finder.groupId = r.params[0] || null;
      /* Every fresh visit opens in the compact list. */
      state.finder.groupView = 'compact';
      state.finder.groupShown = 400;
      /* A new group: forget the last one's devices before anything paints, or
         the first frame of group B shows group A's list. */
      state.finder.groupMembers = null;
      state.finder.groupLocked = false;
      state.finder.groupLoadFailed = false;
      state.finder.groupSpent = null;
      if (state.finder.groupId) loadGroupMembers(state.finder.groupId);
      /* The variant helpers are shared with the model page and hold one
         device's selection at a time; a group opens on its master. */
      state.deviceColour = 0;
      state.deviceVariant = null;
      state.deviceShot = 0;
      r = { name: 'finder', params: [] };
    } else if (state.finder.groupId) {
      state.finder.groupId = null;
      state.finder.groupMembers = null;
      state.finder.groupLocked = false;
      state.finder.groupLoadFailed = false;
    }

    state.sheet = null;
    document.getElementById('overlay').innerHTML = '';
    document.body.style.overflow = '';
    state.route = r;
    state.base = toPath(r);
    /* Quick Billing is a workspace with a header of its own, so the site's
       chrome steps aside for it. See body.qb-workspace in styles.css. */
    document.body.classList.toggle('qb-workspace', r.name === 'billing');
    renderShellBits();
    renderPage(r);
    /* renderPage may have replaced the whole workspace, taking the mobile
       sheet's scrim with it. Asking again here is what stops a body left
       locked by a sheet that no longer exists — navigating away from a group
       is the one path that does not go through renderWorkspace. */
    syncSheet();
    window.scrollTo({ top: 0, behavior: 'instant' in document.documentElement.style ? 'instant' : 'auto' });
  }
  /* Navigation writes a clean path through the History API. Nothing sets
     location.hash any more, which is what stops the address bar flipping back
     to a fragment the moment the app takes over a pre-rendered page. */
  /* Real <a href> so a crawler can follow it and a person can middle-click it,
     intercepted so the app navigates without a reload. Modifier clicks and
     anything targeting another window are left to the browser. */
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download') || a.getAttribute('rel') === 'external') return;

    var href = a.getAttribute('href') || '';
    if (/^(https?:)?\/\//.test(href) || /^(mailto|tel):/.test(href)) return;
    if (href.indexOf('/') !== 0 && href.indexOf('#/') !== 0) return;

    /* Only intercept what the app can actually render. A link to /admin,
       /sitemap.xml or /robots.txt must reach the server.

       ownsPath, not toRoute. toRoute FALLS BACK to 'finder' for a path the app
       does not own — which is right when resolving the current URL, and wrong
       here: `ROUTES[toRoute('/admin').name]` is `ROUTES.finder`, which is
       truthy, so every unknown path was intercepted and quietly turned into
       the Finder. The address bar would say /admin and the screen would show
       the catalogue. ownsPath asks the question actually being asked — is the
       FIRST segment a route this app renders. */
    if (!ownsPath(href)) return;

    e.preventDefault();
    go(href);
  });

  /* Like go(), but in place of the current history entry — so the address a
     visitor was turned away from is not left behind Back, sending them round
     the same refusal again. */
  function redirect(url) {
    history.replaceState(null, '', toPath(toRoute(url)));
    route();
  }

  /**
   * Turns a group away from an account the server has said is not paid.
   *
   *   signed out   -> Sign in, and back to this group afterwards
   *   free         -> Plans, with a line saying why
   *
   * @returns {boolean} true when it redirected — the caller stops there.
   *          False while the answer is unknown, and for a subscriber.
   */
  function refuseGroup(groupId, spent) {
    var a = SM.access && SM.access.get();
    if (!a || a.paid) return false;
    if (!a.signedIn) {
      state.afterSignIn = '/group/' + groupId;
      authMode = 'signin';
      toast('Sign in to open a group', 'lock');
      redirect('/account');
      return true;
    }
    /* a free account may open a group with one of its five; only the server's
       "they are used" turns it away */
    if (!spent) return false;
    state.planNotice = { kind: 'search' };
    toast('Your 5 free searches are used', 'lock');
    redirect('/plans');
    return true;
  }

  function go(url) {
    var r = toRoute(url);
    var path = toPath(r);
    if (location.pathname !== path || location.hash) {
      history.pushState(null, '', path);
    }
    route();
  }

  function closeSheet() {
    if (history.length > 1 && state.base) history.back();
    else go(state.base || '/finder');
  }

  /* ------------------------------------------------------------------ SEO

     A pre-rendered page arrives with the right <title>, description and
     canonical already in the HTML — that is what a crawler and every social
     card reads. But once the app is running, moving from /finder to
     /models/samsung changes the page without reloading it, and those tags would
     still describe the page the visitor arrived on.

     So they are rewritten on every route change. Googlebot renders the app, and
     what it renders should describe the URL it is looking at. */
  var SEO_ORIGIN = 'https://www.mobilepartsfinder.com';

  function seoFor(r) {
    var brand = r.name === 'models' && r.params[0] ? db.brandById[r.params[0]] : null;
    var model = r.name === 'model' && r.params[0] ? db.modelById[r.params[0]] : null;
    var n = function (x) { return nf(x); };

    if (model) {
      return {
        title: model.fullName + ' — Compatible Spare Parts & Models | Mobile Parts Finder',
        desc: model.fullName + ': compatible tempered glass, back cover, combo display, ' +
              'CC board, middle frame and battery groups, with the other phone models ' +
              'that take the same parts.'
      };
    }
    if (brand) {
      return {
        title: brand.name + ' Mobile Models & Compatible Parts Finder | Mobile Parts Finder',
        desc: n(brand.modelCount) + ' ' + brand.name + ' models with compatible tempered ' +
              'glass, back cover, combo display, CC board, middle frame and battery groups.'
      };
    }
    if (r.name === 'models') {
      return {
        title: 'All Mobile Models — ' + n(db.stats.models) + ' Phones by Brand | Mobile Parts Finder',
        desc: 'Browse ' + n(db.stats.models) + ' phone models across ' + db.stats.brandsWithModels +
              ' brands with dimensions, display size, battery and the parts that fit each one.'
      };
    }
    if (r.name === 'plans') {
      return { title: 'Plans — Mobile Parts Finder for Mobile Shops',
               desc: 'Monthly and yearly plans for Mobile Parts Finder.' };
    }
    if (r.name === 'account') {
      return { title: 'Your Account | Mobile Parts Finder', desc: null, noindex: true };
    }
    if (r.name === 'billing') {
      return { title: 'Quick Billing | Mobile Parts Finder', desc: null, noindex: true };
    }
    return {
      title: 'Mobile Compatibility Finder — Match a Phone to Its Parts | Mobile Parts Finder',
      desc: 'Search ' + n(db.stats.models) + ' phone models and get every compatibility ' +
            'group the handset belongs to.'
    };
  }

  function applySeo(r) {
    if (!db || !db.stats) return;              /* catalogue not loaded yet */
    var meta = seoFor(r);
    document.title = meta.title;

    var set = function (sel, attr, value) {
      var el = document.head.querySelector(sel);
      if (!el) return;
      if (value == null) el.remove(); else el.setAttribute(attr, value);
    };
    if (meta.desc) set('meta[name="description"]', 'content', meta.desc);
    set('meta[property="og:title"]', 'content', meta.title);
    if (meta.desc) set('meta[property="og:description"]', 'content', meta.desc);
    set('meta[name="twitter:title"]', 'content', meta.title);

    var url = SEO_ORIGIN + toPath(r);
    set('link[rel="canonical"]', 'href', url);
    set('meta[property="og:url"]', 'content', url);

    /* The account page is a signed-in screen; it has nothing to offer a search
       result and robots.txt disallows it. Saying so here as well costs nothing
       and covers the case where it is reached by a link. */
    var robots = document.head.querySelector('meta[name="robots"]');
    if (robots) robots.setAttribute('content',
      meta.noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large');
  }

  function renderPage(r) {
    applySeo(r);

    /* One page_view per route change, with the path and the route name and
       nothing else. Fire-and-forget: SM.analytics swallows its own errors and
       is absent from builds that do not include it. */
    if (SM.analytics) {
      SM.analytics.track('page_view', { path: location.pathname, routeName: r.name });
      if (r.name === 'plans') SM.analytics.track('plan_page_viewed', {});
      if (r.name === 'model' && r.params[0]) {
        var opened = db.modelById[r.params[0]];
        SM.analytics.track('model_opened', {
          modelId: r.params[0],
          brandId: opened ? opened.brandId : undefined,
          source: 'route'
        });
      }
    }

    var page = document.getElementById('page');
    if (r.name === 'models') return renderModels(page, r.params[0]);
    if (r.name === 'model') return renderDevice(page, r.params[0]);
    if (r.name === 'plans') return renderPlans(page);
    if (r.name === 'account') return renderAccount(page);
    if (r.name === 'billing') return renderBilling(page, r.params);
    return renderFinder(page);
  }

  /* ==========================================================================
     PAGE · QUICK BILLING — the shop's own stock and bills

     Its screens live in src/shop/ and are fetched the first time /billing is
     opened: a visitor who only ever uses the Finder never downloads them, and
     no pre-rendered page has to carry them. Everything that page needs from
     the app is handed over in billingCtx() rather than reached for.
     ========================================================================== */
  var billingLoad = null;
  function loadBilling() {
    if (SM.quickBilling) return Promise.resolve();
    if (billingLoad) return billingLoad;
    var css = new Promise(function (resolve) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/assets/quick-billing.css';
      /* a stylesheet that fails is a plainer page, not a broken one */
      link.onload = link.onerror = function () { resolve(); };
      document.head.appendChild(link);
    });
    var js = ['/src/data/shop-money.js', '/src/data/shop-products.js', '/src/data/shop-offers.js', '/src/data/shop-periods.js', '/src/data/shop-emi.js', '/src/data/shop-share.js', '/src/data/shop-pdf.js',
      '/src/shop/shop-api.js', '/src/shop/quick-billing.js']
      .reduce(function (p, src) {
        return p.then(function () {
          return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = function () { reject(new Error('could not load ' + src)); };
            document.head.appendChild(s);
          });
        });
      }, Promise.resolve());
    billingLoad = Promise.all([css, js]);
    billingLoad.catch(function () { billingLoad = null; });
    return billingLoad;
  }

  function billingCtx() {
    return {
      go: go,
      replace: redirect,
      toast: toast,
      routeName: function () { return state.route.name; },
      page: function () { return document.getElementById('page'); },
      signIn: function () {
        state.afterSignIn = '/billing';
        authMode = 'signin';
        go('/account');
      }
    };
  }

  function renderBilling(page, params) {
    if (SM.quickBilling) return SM.quickBilling.render(page, params, billingCtx());
    page.innerHTML = '<div class="shell" style="padding-top:20px">' + C.skelRows(5) + '</div>';
    loadBilling().then(function () {
      if (state.route.name === 'billing') {
        SM.quickBilling.render(document.getElementById('page'), state.route.params, billingCtx());
      }
    }, function () {
      if (state.route.name !== 'billing') return;
      page.innerHTML = '<div class="shell">' + C.state({
        icon: 'alert', title: 'Quick Billing could not load',
        text: 'Check the connection and try again.',
        action: '<a class="btn btn--primary" href="/billing">' + icon('refresh') + 'Try again</a>'
      }) + '</div>';
    });
  }

  /* The way into Quick Billing from the desktop sidebar, under the part
     categories. Blue like its tab, so it reads as the shop's counter rather
     than one more catalogue filter. */
  function billingEntryHTML() {
    var on = state.route.name === 'billing';
    return '<a class="qbentry' + (on ? ' is-on' : '') + '" href="/billing"' + (on ? ' aria-current="page"' : '') + '>' +
      '<span class="qbentry__ico">' + icon('receipt') + '</span>' +
      '<span class="qbentry__txt"><b>Quick Billing</b><small>Your stock &amp; bills</small></span>' +
      icon('chevronRight') + '</a>';
  }

  /* ==========================================================================
     PAGE · DEVICE FINDER  (default landing)
     ========================================================================== */
  function renderFinder(page) {
    var f = state.finder;
    var picked = f.modelId ? db.modelById[f.modelId] : null;
    var st = db.stats;

    var benchInner = benchHTML();

    /* ONE LAYOUT, ALWAYS.

       Selecting a model used to swap the whole page for a different DOM: a
       compact result header and a single full-width column, with the category
       panel and the brand panel simply gone. The URL never changed, but for
       anyone using it that IS a different page — the two things you filter
       with disappear at the moment you have something to filter.

       The workspace is now mounted once and stays. A selected model changes
       what the CENTRE column contains and nothing else; both side panels keep
       working and keep narrowing the same result. */
    document.getElementById('app').classList.remove('is-result');

    /* Below 1180px the same markup falls back to the original stacked page
       (side panels move into the filter sheet), so the mobile and tablet
       experience is untouched. */
    page.classList.add('is-ws');
    page.innerHTML =
      '<div class="ws">' +
      '<section class="bench ws__band"><div class="shell bench__in" id="benchIn">' + benchInner + '</div></section>' +
      '<div class="ws__body">' +
      '<aside class="ws__left" id="catPanel" aria-label="Part categories"></aside>' +
      '<div class="ws__center" id="wsCenter">' +
      '<div id="centerHead" class="ws__head"></div>' +
      '<div id="results">' + C.skelPlates(6) + '</div>' +
      '<div class="loadmore" id="loadmore"></div>' +
      '</div>' +
      '<aside class="ws__right" id="brandPanel" aria-label="Brands"></aside>' +
      '</div></div>';
    renderWorkspace();
  }

  /* The hero band: heading, search, category rail. Extracted so that picking a
     model can repaint THIS and the centre column, instead of rebuilding the
     page — the panels either side are never touched, so they cannot flicker,
     lose their scroll position or drop a half-typed brand search. */
  function benchHTML() {
    var f = state.finder;
    var picked = f.modelId ? db.modelById[f.modelId] : null;
    var st = db.stats;
    /* The hero is the finder's front door. With a model picked — or a group
       open — the reader is past it, and half a phone screen of "Which parts fit
       this phone?" above their result is just something to scroll past. */
    return ((picked || state.finder.groupId) ? '' :
        '<span class="bench__eyebrow">' + icon('sparkle') + 'Compatibility groups for ' + nf(st.models) + ' phone models</span>' +
        '<h1 class="t-hero">Which parts fit<br><em>this phone?</em></h1>' +
        '<p class="bench__sub">Type any model. Mobile Parts Finder returns the compatibility group, its master model, the part code and every other device that takes the same part.</p>') +
      searchHTML(picked) +
      /* the stat cards are gone; the category rail sits directly under the
         search instead, and is the only category selector on narrow screens */
      '<div id="catRail">' + railHTML() + '</div>';
  }

  function renderBench() {
    var host = document.getElementById('benchIn');
    if (host) host.innerHTML = benchHTML();
  }

  /* The category rail under the search. Same component either way — it just
     counts what is actually on offer: every group when browsing, and this
     model's own groups once one is selected. */
  function railHTML() {
    return state.finder.modelId ? resultRailHTML() : categoryRailHTML();
  }

  function stat(v, l, act) {
    return '<div class="bstat"><b>' + v + '</b><span>' + esc(l) +
      (act ? '<button class="bstat__link" data-act="' + act + '" title="Open the product listing" ' +
        'aria-label="Open the product listing">' + icon('linkOut') + '</button>' : '') +
      '</span></div>';
  }

  function statsHTML() {
    var st = db.stats;
    /* 1 compatibility group = 1 product, so Products uses the group total */
    return stat(nf(st.models), 'Models') + stat(nf(st.groups), 'Groups') +
      stat(String(st.categories), 'Categories') + stat(nf(st.groups), 'Products', 'go-products');
  }

  /* One search component, rendered twice: once in the header (desktop) and once
     in the hero (mobile/tablet). Only one is ever visible, they share
     state.finder.query, and each owns its own suggestion slot. */
  function searchBoxHTML(id, opts) {
    opts = opts || {};
    var f = state.finder;
    return '<div class="searchwrap">' +
      '<div class="search">' +
      '<span class="search__ico">' + icon('search') + '</span>' +
      '<input id="' + id + '" type="search" autocomplete="off" spellcheck="false" ' +
      'placeholder="Search a model — Galaxy A55, Redmi Note 13…" value="' + esc(f.query) + '" ' +
      'aria-label="Search a mobile model" />' +
      (f.query ? '<button class="search__clear" data-act="clear-q" aria-label="Clear search">' + icon('close') + '</button>' : '') +
      (opts.go ? '<button class="btn btn--primary search__go" data-act="focus-q">' + icon('bolt') + 'Find parts</button>' : '') +
      '</div><div class="suggest-slot"></div></div>';
  }

  function searchHTML(picked) {
    return searchBoxHTML('q', { go: true }) +
      (picked ? '<div class="row wrap" style="gap:8px;margin-top:14px">' +
        '<span class="bench__eyebrow">' + icon('phone') + 'Showing fitment for ' + esc(picked.fullName) + '</span>' +
        '<button class="quick" data-act="clear-model">' + 'Change model' + '</button></div>' : '');
  }

  /* the search box the user can actually see right now */
  function activeSearch() {
    var ids = ['qh', 'q'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el && el.offsetParent !== null) return el;
    }
    return document.getElementById('qh') || document.getElementById('q');
  }
  function suggestSlot(input) {
    var wrap = input && input.closest('.searchwrap');
    return wrap ? wrap.querySelector('.suggest-slot') : null;
  }

  /* ------------------------------------------------------- recent searches */
  var RECENT_KEY = 'mpf.recent.v1';
  var RECENT_SEED = ['Samsung Galaxy A55 5G', 'Redmi Note 13 Pro', 'Vivo V40', 'OPPO Reno 12', 'Apple iPhone 15'];

  function loadRecent() {
    var ids = [];
    try { var raw = store(RECENT_KEY); if (raw) ids = JSON.parse(raw) || []; } catch (e) { ids = []; }
    ids = ids.filter(function (id) { return db.modelById[id]; });
    if (!ids.length) {
      ids = RECENT_SEED.map(function (n) {
        var m = db.models.filter(function (x) { return x.fullName === n; })[0];
        return m ? m.id : null;
      }).filter(Boolean);
    }
    return ids.slice(0, 8);
  }
  function pushRecent(id) {
    state.recent = [id].concat(state.recent.filter(function (x) { return x !== id; })).slice(0, 8);
    store(RECENT_KEY, JSON.stringify(state.recent));
  }
  function recentModels() {
    return state.recent.map(function (id) { return db.modelById[id]; }).filter(Boolean);
  }

  /* ---------------------------------------------------- default: browse mode */
  /* Repaints the two side panels and the centre toolbar in place, then reloads
     the results. The bench/search above is left alone so typing is never
     interrupted by a filter click. */
  /* Repaints the workspace in place: both panels, the centre head and the
     centre content. Never rebuilds the shell, so the panels keep their scroll
     position and the brand search keeps its text.

     Every filter change — a model from the search box, a category on the left,
     a brand on the right — comes through here. That is what makes the three
     compose instead of one of them replacing the page. */
  /* Sets the one category filter from any control.

     'all' and null both mean "no category" — the rail said null and the panel
     said 'all', which is how the same click could look selected in one place
     and cleared in the other. Both are written, so the whole UI agrees. */
  function setCategory(id) {
    var f = state.finder;
    var next = (!id || id === 'all') ? 'all' : id;
    if (f.modelId) {
      /* A RESULT is always one category. There is no "all" to fall back to,
         and tapping the category already on keeps it on — it must not empty
         the page the reader is looking at. */
      if (next === 'all') return;
    } else if (f.filters.catId === next && next !== 'all') {
      /* Browsing the library: tapping the tile that is already on clears it,
         which is what the tiles have always done. */
      next = 'all';
    }
    f.filters.catId = next;
    f.catId = next === 'all' ? null : next;
    f.matchShown = 6;
    f.page = 1;
  }

  /* ======================================================================
     INLINE GROUP VIEW

     The centre column holds the selected group's devices; the right panel
     holds whichever of them is selected, starting with the master. The left
     categories never move. There is no overlay anywhere in here.
     ====================================================================== */

  /** The group currently open, resolved from the catalogue. */
  function currentGroup() {
    var id = state.finder.groupId;
    if (!id) return null;
    var g = db.groupById[id];
    if (!g) return null;
    var master = db.modelById[g.masterModelId];
    if (!master) return null;
    return { group: g, category: db.categoryById[g.categoryId], master: master };
  }

  /* A copy button with nothing to copy is a button that lies. Part code used to
     be null for every group, so this rendered "Part code: " and put an empty
     string on the clipboard. */
  function copyBtn(label, value) {
    if (value == null || String(value).trim() === '') return '';
    return '<button class="copybtn" data-act="copy" data-copy="' + esc(value) + '">' +
      icon('copy') + esc(label) + ': ' + esc(value) + '</button>';
  }

  /* ------------------------------------------------------------ the count

     How many devices this group links.

     THE COUNT IS FREE AND THE NAMES ARE NOT, so this reads the group row's
     own tally first. It used to count db.membersByGroup — the fitment list
     inverted out of the public bundle — which no longer ships, so counting it
     would report 0 for every group and the banner would say "0 devices
     linked" above a part that fits 325.

     The loaded member list still wins WHEN THERE IS ONE, so a subscriber's
     banner and the grid under it are the same set counted twice. */
  function groupMemberCount(g) {
    var loaded = state.finder.groupId === (g && g.groupId) ? openGroupMembers() : null;
    if (loaded && loaded.length) return loaded.length;
    return g && g.compatibleCount ? g.compatibleCount : 0;
  }

  /* "325 devices linked" — the phrase, not the number. One place decides the
     wording so the group header, the mobile sheet and the selected-model
     header cannot drift into three ways of saying the same thing. */
  function deviceCountLabel(n, verb) {
    return nf(n) + ' device' + (n === 1 ? '' : 's') + (verb ? ' ' + verb : '');
  }

  /* ======================================================================
     THE OPEN GROUP — one layout for a searched model and an opened group

     Three parts, top to bottom, and nothing else:

       1. the category selector, floating above the sheet on a phone
       2. the master model's header — identity, codes and specifications
       3. the compatible devices, in compact, grid or table view

     A searched model (/finder) and an opened group (/group/<id>) used to be
     two layouts carrying the same facts several times over: a sticky summary
     ("35 devices linked · 4 groups"), a "Compatible parts · 1 match" heading,
     a filter box and a filter button for a list of one, a MATCH FOUND badge,
     an "Open group" button on a group that was already open, the master in a
     green card and again in a specification panel, and the whole brand list
     under it. Each of those said something already on screen. They are gone;
     what is left is the part, the master it is named after, and the phones
     it fits.
     ====================================================================== */

  /* THE CATEGORY SELECTOR. The result order and names, each category a white
     card of its own with the part's picture; the one on screen outlined in
     the brand colour. A category this master has no group in stays in its
     place, switched off, so the row never reshuffles between models. A
     category whose data is still being collected is left out rather than
     offered as a button that leads nowhere.

     @param {object|null} counts  categoryId -> groups, from the public counts
     @param {string} active       the category on screen
     @param {string} act          what a press does */
  function catSelectorHTML(counts, active, act) {
    return '<nav class="gcats" aria-label="Part category"><div class="gcats__row">' +
      resultCategories().filter(function (c) { return !c.comingSoon; }).map(function (c) {
        var n = counts ? (counts[c.id] || 0) : null;
        var on = c.id === active;
        var off = !on && n === 0;
        var label = resultCatLabel(c);
        return '<button type="button" class="gcat' + (on ? ' is-on' : '') + (off ? ' is-off' : '') + '" ' +
          'data-act="' + act + '" data-id="' + esc(c.id) + '" aria-pressed="' + on + '"' +
          (off ? ' disabled' : '') +
          ' aria-label="' + esc(label + (off ? ' — no group for this model' : '')) + '">' +
          '<span class="gcat__art">' + SM.art.category(c.id, 'pthumb--gcat', label, { eager: true }) + '</span>' +
          '<span class="gcat__n">' + esc(label) + '</span>' +
          '</button>';
      }).join('') +
      '</div></nav>';
  }

  /* THE MASTER MODEL'S HEADER. One block, drawn once, the same size for as
     long as it is on screen — it is not sticky, so it cannot shrink, jump or
     sit over the list; the device toolbar under it is what stays.

     Back; the master handset at a size it can be recognised at; the crown,
     MASTER MODEL and the category; the name; the codes a counter quotes; the
     master's measurements from the shared SPEC_COLS, so they read exactly as
     the table's columns do; and the part itself on the right, bare on its own
     white. When the searched model is not the master, one line says the part
     fits it, because the header is about the master and the reader came here
     about their own phone. */
  function masterHeadHTML(row, opts) {
    opts = opts || {};
    var g = row.group, cat = row.category, master = row.master;
    var hit = opts.hit && opts.hit.id !== master.id ? opts.hit : null;
    var codes = [
      ['Group', g.groupNumber],
      ['Part code', row.partCode || g.partCode],
      ['Serial', g.serialNumber],
      ['Manufacturer part no.', row.oemPartNo || g.oemPartNo]
    ].filter(function (c) { return c[1]; });

    return '<header class="mhead">' +
      '<span class="sheet-grab" aria-hidden="true"></span>' +
      '<div class="mhead__top">' +
        '<button type="button" class="gback mhead__back" data-act="' + esc(opts.back || 'clear-model') + '" ' +
          'aria-label="Back" title="Back">' + icon('chevronLeft') + '</button>' +
        '<span class="mhead__shot">' +
          SM.art.photo(master, { alt: master.fullName, eager: true, cls: 'mhead__ph' }) + '</span>' +
        '<div class="mhead__id">' +
          '<span class="mhead__eyebrow">' +
            '<span class="masterflag">' + icon('crown') + 'Master model</span>' +
            (cat ? '<span class="mhead__cat">' + esc(resultCatLabel(cat)) + '</span>' : '') +
          '</span>' +
          '<h2 class="mhead__n">' + esc(master.fullName) + '</h2>' +
          (hit ? '<span class="mhead__hit">' + icon('check') + 'Fits your ' + esc(hit.fullName) + '</span>' : '') +
        '</div>' +
        (cat ? '<span class="mhead__part" title="' + esc(cat.name) + '">' +
          SM.art.category(cat.id, 'pthumb--mhead', cat.name, { eager: true }) + '</span>' : '') +
      '</div>' +
      (codes.length ? '<dl class="mhead__codes">' + codes.map(function (c) {
        return '<div><dt>' + esc(c[0]) + '</dt><dd>' + esc(c[1]) + '</dd></div>';
      }).join('') + '</dl>' : '') +
      '<dl class="mhead__specs">' + SPEC_COLS.map(function (c) {
        return '<div title="' + esc(c.title) + '"><dt>' + esc(c.label) +
          ' <span>(' + esc(c.unit) + ')</span></dt><dd>' + specValue(c, master) + '</dd></div>';
      }).join('') + '</dl>' +
      '</header>';
  }

  /* THE COMPATIBLE DEVICES. A toolbar that stays — the count and the view —
     and the list under it.

     @param {number} total     the group's own size
     @param {string} listHTML  the list, already drawn in the chosen view
     @param {object} opts      { act: the view switch's action, view, listId,
                                 listAttr: an attribute that finds the list
                                 again for a repaint, note: extra pill } */
  function deviceBodyHTML(total, listHTML, opts) {
    return '<section class="gdev" aria-label="Compatible devices">' +
      '<div class="gdev__bar">' +
        '<span class="gdev__t">Compatible devices</span>' +
        '<span class="pill pill--brand">' + nf(total) + '</span>' +
        (opts.note || '') +
        listViewSwitchHTML(listView(opts.view), opts.act) +
      '</div>' +
      '<div class="gdev__list glist--' + listView(opts.view) + '"' +
        (opts.listId ? ' id="' + opts.listId + '"' : '') + (opts.listAttr || '') + '>' +
        listHTML + '</div>' +
      '</section>';
  }

  /* One device, as a chip you pick.

     A small photograph of the handset and its full name, side by side, at the
     height of one line of text. The photograph is the device's own image from
     the catalogue — 4,873 of the 4,933 have one — drawn at favicon size and
     lazily, so a group of 325 costs 325 <img> elements the browser is free to
     leave unfetched until they are scrolled to.

     The drawn fallback that SM.art.photo ships alongside every photograph is
     deliberately NOT used here. It is a full gradient-and-camera SVG carrying
     its own gradient id, and 325 of those in the DOM at 26px is a great deal
     of paint for something the size of a favicon. A device with no image gets
     one flat glyph instead, and its name — which is what the chip is for — is
     unaffected.

     There is no radio and no circle. The chip's own ground says which one is
     selected; a control that repeats that is a control that can disagree with
     it. */
  function deviceChipHTML(m, opts) {
    opts = opts || {};
    var isMaster = m.id === opts.masterId;
    var isHit = !isMaster && !!opts.hitId && m.id === opts.hitId;
    var sel = !!opts.sel && opts.sel.id === m.id;
    var img = m.image
      ? '<img class="gchip__img" src="' + esc(m.image) + '" alt="" loading="lazy" ' +
        'decoding="async" referrerpolicy="no-referrer" ' +
        'onerror="this.parentNode.classList.add(&quot;is-failed&quot;)" />'
      : '';
    /* opts.card: the open group's image-first card — photograph on top, name
       centred under it. The markup is the same chip, reordered by CSS alone,
       so every selector that finds a chip (.gchip.is-on, .gchip[data-id])
       finds a card, and the match cards that preview a group keep their
       compact horizontal row. */
    return '<button type="button" class="gchip' + (opts.card ? ' gchip--card' : '') +
      (sel ? ' is-on' : '') +
      (isMaster ? ' is-master' : '') + (isHit ? ' is-hit' : '') + '" ' +
      'data-act="' + esc(opts.act || 'pick-device') + '" data-id="' + esc(m.id) + '" ' +
      'title="' + esc(m.fullName) + '" ' +
      'aria-pressed="' + (sel ? 'true' : 'false') + '">' +
      '<span class="gchip__ph' + (m.image ? '' : ' is-failed') + '" aria-hidden="true">' +
        img + '<span class="gchip__fb"></span>' +
      '</span>' +
      '<span class="gchip__n">' + esc(m.fullName) + '</span>' +
      /* The crown and the tick are the whole of what marks the master and the
         searched-for device apart, so each carries the words as well. A title
         attribute is a hover tooltip, not an accessible name — without the .sr
         span these two chips read to a screen reader exactly like the other
         323. */
      (isMaster
        ? '<span class="gchip__flag">' + icon('crown') +
          '<span class="sr">Master model</span></span>'
        : isHit
          ? '<span class="gchip__flag gchip__flag--hit">' + icon('check') +
            '<span class="sr">Your model</span></span>'
          : '') +
      '</button>';
  }

  /* A run of chips, in the responsive grid they share. Used on its own for a
     short list — a match card's preview of eight — and once per brand by the
     block builder below.

     Nothing at all for an empty list: a group whose members the server has not
     released yet would otherwise get an empty grid with a heading over it,
     which reads as a list that failed rather than as one not asked for. */
  function chipGridHTML(list, opts) {
    if (!list || !list.length) return '';
    /* Compact: the model's name in a thin outline and nothing else, each chip
       as wide as its own name, wrapping in rows. */
    if (opts && opts.view === 'compact') {
      return '<div class="mchips">' + list.map(function (m) {
        return modelChipHTML(m, opts);
      }).join('') + '</div>';
    }
    return '<div class="gchips' + (opts && opts.card ? ' gchips--cards' : '') + '">' +
      list.map(function (m) {
      return deviceChipHTML(m, opts);
    }).join('') + '</div>';
  }

  /* ======================================================================
     THREE WAYS TO READ ONE LIST — compact, grid, table

     Shared by the result page and the opened group, so a list of compatible
     models looks and behaves the same wherever it appears: one chip, one card
     and one table, with one definition of what each column means.
     ====================================================================== */

  var LIST_VIEWS = [
    { id: 'compact', label: 'Compact', icon: 'parts' },
    { id: 'grid', label: 'Grid', icon: 'grid' },
    { id: 'table', label: 'Table', icon: 'layers' }
  ];
  function listView(v) {
    return v === 'grid' || v === 'table' ? v : 'compact';
  }

  /* The segmented control. `act` says which list it drives, so the result
     page and the group page can each keep their own choice. */
  function listViewSwitchHTML(current, act) {
    return '<div class="lview" role="group" aria-label="Display style">' +
      LIST_VIEWS.map(function (v) {
        var on = current === v.id;
        return '<button type="button" class="lview__b' + (on ? ' is-on' : '') + '" ' +
          'data-act="' + act + '" data-view="' + v.id + '" aria-pressed="' + on + '" ' +
          'title="' + v.label + ' view" aria-label="' + v.label + ' view">' + icon(v.icon) +
          '<span class="lview__t">' + v.label + '</span></button>';
      }).join('') + '</div>';
  }

  /* One compatible model in the compact view: its full name in a thin outline.

     The width is the name's own — no fixed cell, no truncation — and a very
     long name wraps inside the chip rather than being cut. The master keeps
     its crown and the searched-for model its tick, at the size of the text. */
  function modelChipHTML(m, opts) {
    opts = opts || {};
    var isMaster = m.id === opts.masterId;
    var isHit = !isMaster && !!opts.hitId && m.id === opts.hitId;
    var sel = !!opts.sel && opts.sel.id === m.id;
    return '<button type="button" class="mchip' + (sel ? ' is-on' : '') +
      (isMaster ? ' is-master' : '') + (isHit ? ' is-hit' : '') + '" ' +
      'data-act="' + esc(opts.act || 'pick-device') + '" data-id="' + esc(m.id) + '" ' +
      'aria-pressed="' + (sel ? 'true' : 'false') + '">' +
      (isMaster ? '<span class="mchip__flag">' + icon('crown') + '<span class="sr">Master model: </span></span>' : '') +
      (isHit ? '<span class="mchip__flag mchip__flag--hit">' + icon('check') + '<span class="sr">Your model: </span></span>' : '') +
      '<span class="mchip__n">' + esc(m.fullName) + '</span>' +
      '</button>';
  }

  /* ------------------------------------------------- the specification table

     ONE definition of every column, read by the result page and the group
     page alike. The values are the catalogue's own fields, unconverted:

       Display          displaySize   inches
       Height / Width   heightMm / widthMm   millimetres
       Screen area      screenCm2     square centimetres
       Screen-to-body   bodyRatio     per cent

     The catalogue records ONE ratio, `bodyRatio` — the source's
     "screen-to-body ratio", which is also what is called "body to screen" at
     the counter. It is one column. Showing it twice under two names would
     present one number as two facts, and inverting it would invent a figure
     nobody measured. Screen AREA is a different quantity and has its own
     column. A value that is not recorded is an em dash, never a guess. */
  var SPEC_COLS = [
    { k: 'size', label: 'Display', unit: 'in', title: 'Display size, inches',
      get: function (m) { return m.displaySize; } },
    { k: 'h', label: 'Height', unit: 'mm', title: 'Body height, millimetres',
      get: function (m) { return m.heightMm; } },
    { k: 'w', label: 'Width', unit: 'mm', title: 'Body width, millimetres',
      get: function (m) { return m.widthMm; } },
    { k: 'area', label: 'Screen area', unit: 'cm²', title: 'Screen area, square centimetres',
      get: function (m) { return m.screenCm2; } },
    { k: 'ratio', label: 'Screen-to-body', unit: '%',
      title: 'Screen-to-body ratio (also called body to screen), per cent',
      get: function (m) { return m.bodyRatio; } }
  ];

  /* The number exactly as the catalogue records it — the unit is in the
     heading, the figures are right-aligned in tabular digits so a column reads
     down. Not rounded or padded to a fixed precision: some heights are
     recorded to two places (165.77) and most to one, and a fixed format would
     either drop a digit that was measured or add one that was not. */
  function specValue(col, m) {
    var v = col.get(m);
    if (v == null || v === '' || !isFinite(Number(v))) return '<span class="stable__none">&mdash;</span>';
    return esc(String(Number(v)));
  }

  /* The thumbnail is the catalogue photograph at favicon size, the same image
     the chips and cards use. A device with none gets the drawn outline. */
  function thumbHTML(m) {
    return '<span class="stable__ph' + (m.image ? '' : ' is-failed') + '" aria-hidden="true">' +
      (m.image
        ? '<img class="stable__img" src="' + esc(m.image) + '" alt="" loading="lazy" decoding="async" ' +
          'referrerpolicy="no-referrer" onerror="this.parentNode.classList.add(&quot;is-failed&quot;)" />'
        : '') +
      '<span class="gchip__fb"></span></span>';
  }

  /* Wide, and scrolled sideways on a phone rather than squeezed: every column
     stays, and the name column stays put while the numbers move under it. */
  function specTableHTML(list, opts) {
    opts = opts || {};
    if (!list || !list.length) return '';
    var head = '<tr><th class="stable__dev" scope="col">Model</th>' +
      SPEC_COLS.map(function (c) {
        return '<th scope="col" title="' + esc(c.title) + '">' + esc(c.label) +
          ' <span class="stable__u">(' + esc(c.unit) + ')</span></th>';
      }).join('') + '</tr>';
    var rows = list.map(function (m) {
      var isMaster = m.id === opts.masterId;
      var isHit = !isMaster && !!opts.hitId && m.id === opts.hitId;
      var sel = !!opts.sel && opts.sel.id === m.id;
      return '<tr class="' + (sel ? 'is-on' : '') + (isMaster ? ' is-master' : '') + '" ' +
        'data-act="' + esc(opts.act || 'pick-device') + '" data-id="' + esc(m.id) + '" tabindex="0">' +
        '<th class="stable__dev" scope="row"><span class="stable__devin">' + thumbHTML(m) +
          '<span class="stable__n">' + esc(m.fullName) + '</span>' +
          (isMaster ? '<span class="stable__flag" title="Master model">' + icon('crown') +
            '<span class="sr">Master model</span></span>' : '') +
          (isHit ? '<span class="stable__flag stable__flag--hit" title="Your model">' + icon('check') +
            '<span class="sr">Your model</span></span>' : '') +
        '</span></th>' +
        SPEC_COLS.map(function (c) {
          return '<td class="stable__v">' + specValue(c, m) + '</td>';
        }).join('') +
        '</tr>';
    }).join('');
    return '<div class="stable-wrap" role="region" aria-label="Specifications" tabindex="0">' +
      '<table class="stable"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>';
  }

  /* A list of models in whichever view is chosen. Long lists keep their brand
     headings in compact and grid; the table is one table, in the same order,
     because a table split by brand is a table you cannot compare down. */
  function modelListHTML(list, opts) {
    opts = opts || {};
    var view = listView(opts.view);
    /* The master leads, whatever order the group's members were recorded in:
       it is the device the group — and the header above the list — is named
       after. The rest keep the order they came in. */
    if (opts.masterId) {
      var mi = -1;
      for (var i = 0; i < list.length; i++) if (list[i].id === opts.masterId) { mi = i; break; }
      if (mi > 0) list = [list[mi]].concat(list.slice(0, mi), list.slice(mi + 1));
    }
    var byBrand = list.length > (opts.brandsAbove || 0);
    if (view === 'table') {
      return specTableHTML(byBrand ? brandOrdered(list, opts.masterId) : list, opts);
    }
    var o = {};
    Object.keys(opts).forEach(function (k) { o[k] = opts[k]; });
    o.view = view;
    o.card = view === 'grid';
    return byBrand ? brandBlocksHTML(list, o) : chipGridHTML(list, o);
  }

  /* --------------------------------------------------------- brand blocks

     325 devices in one uninterrupted sequence is a list you scroll rather than
     read. Split by the brand each device already carries, it becomes thirteen
     short lists you can skip between — and the brand is the first thing a
     repairer knows about the handset in their hand.

     The order is the master's own brand first, because that is the device the
     group is named after, then the rest by how many devices each contributes.
     Both come out of the data; nothing here names a brand.

     @param {Array}  list  the devices to show, already filtered
     @param {object} opts  as deviceChipHTML, plus masterId deciding the order */
  /* The brands of a list, in the order the blocks are drawn: the master's own
     brand first, then by how many devices each contributes. */
  function brandGroups(list, masterId) {
    var master = db.modelById[masterId];
    var masterBrand = master ? master.brandId : null;

    var order = [];
    var byBrand = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var bid = m.brandId || '?';
      if (!byBrand[bid]) { byBrand[bid] = []; order.push(bid); }
      byBrand[bid].push(m);
    }

    order.sort(function (a, b) {
      if (a === masterBrand) return -1;
      if (b === masterBrand) return 1;
      var d = byBrand[b].length - byBrand[a].length;
      if (d) return d;
      var an = (db.brandById[a] || {}).name || a;
      var bn = (db.brandById[b] || {}).name || b;
      return an.localeCompare(bn);
    });
    return order.map(function (bid) { return { bid: bid, list: byBrand[bid] }; });
  }

  /* The same order, as one list — the table's rows. */
  function brandOrdered(list, masterId) {
    return brandGroups(list, masterId).reduce(function (out, g) { return out.concat(g.list); }, []);
  }

  function brandBlocksHTML(list, opts) {
    opts = opts || {};
    return brandGroups(list, opts.masterId).map(function (grp) {
      var bid = grp.bid;
      var mine = grp.list;
      var b = db.brandById[bid] || { id: bid, name: mine[0].brand || bid };
      return '<section class="gbrand">' +
        '<h3 class="gbrand__h">' +
          SM.brandLogo(b, 'blogo--chip') +
          '<span class="gbrand__n">' + esc(b.name) + '</span>' +
          '<span class="gbrand__c">' + nf(mine.length) + '</span>' +
        '</h3>' +
        chipGridHTML(mine, opts) +
        '</section>';
    }).join('');
  }

  /* The opened group, in the same three parts as a searched model: the
     master's categories (switching one shows the master's group there), the
     master's header, and the devices. */
  function groupCenterHTML(row) {
    var counts = (db.partCountsByCategory && db.partCountsByCategory[row.master.id]) || null;
    return catSelectorHTML(counts, row.group.categoryId, 'group-cat') +
      masterHeadHTML(row, { back: 'close-group' }) +
      deviceBodyHTML(groupMemberCount(row.group), groupListHTML(row), {
        act: 'group-view', view: state.finder.groupView, listId: 'groupList'
      });
  }

  /* Just the list. Repainted on its own when the filter changes, so the input
     keeps its caret and its focus. */
  /* ------------------------------------------------------------- the paywall

     ONE card, used everywhere a compatibility list is withheld: the opened
     group, a match card, the device page. A second copy would be a second
     wording, and two different explanations of the same rule read as two
     different rules.

     It states the count it is withholding, because that number is public —
     the group row carries it, and "325 devices" is the advertisement. What it
     never contains is a name: the rows are not in the response, so there is
     nothing here to hide, blur or truncate.

     The button is data-act="go-plans", which routes through gatedUpgrade() —
     a signed-out visitor reaches Sign in, a signed-in free account reaches
     Plans, and neither decision is made in this markup. */
  function paywallHTML(opts) {
    opts = opts || {};
    var n = Number(opts.count) || 0;
    var what = opts.what || 'the devices in this group';
    return '<div class="paywall">' +
      '<span class="paywall__ico">' + icon('lock') + '</span>' +
      '<div class="paywall__b">' +
      '<h3 class="paywall__t">' +
        (n ? esc(deviceCountLabel(n, 'in this group')) : 'Compatible devices') +
        ' &mdash; part of a plan</h3>' +
      '<p class="paywall__p">Seeing ' + esc(what) + ' needs an active ' +
        'subscription. Monthly is &#8377;99 and Yearly is &#8377;799, and both ' +
        'unlock every group, every part category and unlimited searches.</p>' +
      '<div class="row" style="gap:8px;flex-wrap:wrap">' +
      '<button class="btn btn--primary" data-act="go-plans">' + icon('crown') +
        'See the plans</button>' +
      '</div></div></div>';
  }

  /* The devices in the open group, as the SERVER gave them to this account.

     Resolved against the local catalogue for photographs and brands, with the
     server's own name as the fallback for a device the bundle does not carry.
     Never read from db.membersByGroup — that map is empty now, on purpose. */
  function openGroupMembers() {
    var raw = state.finder.groupMembers;
    if (!raw) return null;
    return raw.map(function (m) {
      var id = m && (m.id || m);
      return db.modelById[id] || {
        id: id,
        fullName: (m && m.name) || id,
        modelName: (m && m.name) || id,
        brandId: null,
        search: String((m && m.name) || id).toLowerCase()
      };
    });
  }

  function groupListHTML(row) {
    /* WITHHELD. The server said this account may not read the member list, so
       there is no list here to render — not a truncated one, not a blurred
       one. The names were never sent. */
    if (state.finder.groupLocked) {
      return paywallHTML({
        count: row.group.compatibleCount,
        what: 'which devices this part fits'
      });
    }

    if (state.finder.groupLoadFailed) {
      return '<div class="notice notice--amber">' + icon('alert') +
        '<span>The devices in this group could not be loaded just now. This is ' +
        'a fault on our side, not with your connection &mdash; nothing about ' +
        'your account has changed. Try again in a moment.</span></div>';
    }

    var all = openGroupMembers();
    if (all === null) {
      return '<div class="notice">' + icon('refresh') +
        '<span>Loading the devices in this group&hellip;</span></div>';
    }

    var list = all;
    /* The cap is a guard rail, not a page size: the largest group in the
       catalogue is 325 and the median is 3, so today it never fires. It is
       here so that a group ten times that size degrades into a button rather
       than into a second of blocked scripting. */
    var shown = list.slice(0, state.finder.groupShown || 400);
    if (!shown.length) {
      return '<div class="notice">' + icon('alert') +
        '<span>No devices are recorded in this group yet.</span></div>';
    }
    /* A device opens its own page, as it does from a searched model's list —
       the specifications live there and in the table view, not in a second
       panel beside the list. */
    return modelListHTML(shown, {
      view: state.finder.groupView, masterId: row.master.id, act: 'open-model'
    }) +
      (list.length > shown.length
        ? '<div class="loadmore"><button class="btn btn--outline" data-act="more-devices">' +
          'Show ' + nf(list.length - shown.length) + ' more</button></div>'
        : '');
  }

  /* ------------------------------------------------ opening a group, gated

     THE SERVER DECIDES, AND IT DECIDES BEFORE ANY DEVICE REACHES THE PAGE.

     /api/device-parts reads the caller's subscription out of Firestore and
     returns `members: []` with `requiresPlan: true` to a free account. So a
     free user who types /group/sg-0167 into the address bar, presses Back into
     a group they saw as a subscriber, or calls the endpoint with curl gets the
     same answer in all three cases: the group's identity and its size, and no
     device names anywhere in the payload.

     This function does not gate anything by itself; it records what the server
     said so the view can draw the right thing. Gating in the browser would be
     a lock on a door with no wall around it. */
  var groupLoadSeq = 0;
  function loadGroupMembers(groupId) {
    var ticket = ++groupLoadSeq;
    if (!SM.access || !SM.access.groupMembers) {
      state.finder.groupLoadFailed = true;
      return;
    }
    SM.access.groupMembers(groupId).then(function (g) {
      /* A later group was opened while this was in flight. */
      if (ticket !== groupLoadSeq || state.finder.groupId !== groupId) return;

      if (!g) {
        state.finder.groupLoadFailed = true;
        state.finder.groupMembers = null;
      } else if (g.requiresPlan) {
        /* Not open to this account yet. A visitor is sent to Sign in; a free
           account spends one of its five and asks again, and only a spent
           allowance sends it to Plans. */
        state.finder.groupLocked = true;
        state.finder.groupMembers = [];
        if (refuseGroup(groupId)) return;
        var acc = SM.access.get();
        if (acc && acc.signedIn && !acc.paid && !state.finder.groupSpent) {
          state.finder.groupSpent = groupId;
          SM.access.openGroup(groupId).then(function (r) {
            if (ticket !== groupLoadSeq || state.finder.groupId !== groupId) return;
            renderShellBits();
            if (r.allowed) { loadGroupMembers(groupId); return; }
            if (r.limitReached) { refuseGroup(groupId, true); return; }
            state.finder.groupLoadFailed = true;
            if (state.route.name === 'finder' && state.finder.groupId === groupId) renderWorkspace();
          });
          return;
        }
      } else {
        state.finder.groupLocked = false;
        state.finder.groupMembers = Array.isArray(g.members) ? g.members : [];
        state.finder.groupLoadFailed = false;
      }
      if (state.route.name === 'finder' && state.finder.groupId === groupId) {
        renderWorkspace();
      }
    });
  }

  /* ======================================================================
     THE MOBILE SHEET

     On a desktop the workspace is three columns and the group lives in the
     middle one. On a phone there are no columns to live in: the same markup
     stacks, and a result that begins below a hero band, a search box and a
     category rail is a result you have to go looking for.

     So below the workspace breakpoint the RESULT — an open group, or a
     selected model's matches — rises as a bottom sheet over the finder that
     produced it. Nothing is re-rendered into a second DOM to do this: the sheet
     IS .ws__body, which on a phone already contains exactly the right things in
     exactly the right order (the categories column is display:none, the centre
     column holds the sticky master header and the device list, the right column
     holds the selected device's details). Making that one element a fixed,
     rounded, scrollable panel turns the page into a sheet without moving a
     single node, so every handler, every id and every repaint keeps working.

     The scrim and the body scroll lock are the only additions, and both are
     driven from here so that they can never outlive the state that opened them.
     ====================================================================== */
  var SHEET_MQ = '(max-width:1179px)';
  function sheetIsNarrow() {
    return !!(global.matchMedia && global.matchMedia(SHEET_MQ).matches);
  }

  /* True when the finder is showing a RESULT rather than the library: a group
     is open, or a model has been selected and its matches are on screen. */
  function sheetWanted() {
    return !!(state.route && state.route.name === 'finder' &&
      (state.finder.groupId || state.finder.modelId));
  }

  function syncSheet() {
    var body = document.querySelector('.ws__body');
    if (!body) {
      document.body.classList.remove('has-gsheet');
      return;
    }
    var on = sheetWanted() && sheetIsNarrow();
    /* Toggling the class on a body that is already in that state would restart
       the slide-up animation — which is what a resize, a filter keystroke or a
       device pick would otherwise do. */
    if (body.classList.contains('ws__body--sheet') !== on) {
      body.classList.toggle('ws__body--sheet', on);
    }
    document.body.classList.toggle('has-gsheet', on);

    var scrim = document.getElementById('gscrim');
    if (on && !scrim) {
      scrim = document.createElement('div');
      scrim.id = 'gscrim';
      scrim.className = 'gscrim';
      /* Tapping the page behind a sheet closes it — the same gesture every
         other sheet in this app answers to. data-act routes it through the one
         click handler rather than adding a listener that has to be removed. */
      scrim.setAttribute('data-act', state.finder.groupId ? 'close-group' : 'clear-model');
      scrim.setAttribute('aria-hidden', 'true');
      body.parentNode.insertBefore(scrim, body);
    } else if (on && scrim) {
      scrim.setAttribute('data-act', state.finder.groupId ? 'close-group' : 'clear-model');
    } else if (scrim) {
      scrim.parentNode.removeChild(scrim);
    }
  }

  /* A phone rotated into landscape, or a window dragged past 1180px, changes
     whether the result should be a sheet at all. Listening to the query itself
     rather than to resize means one callback at the boundary instead of one per
     frame of a drag. */
  var sheetMql = null;
  if (global.matchMedia) {
    /* Kept in a module-scope variable on purpose: a MediaQueryList with no
       strong reference left to it can be collected, and its listener with it. */
    sheetMql = global.matchMedia(SHEET_MQ);
    var onSheetMq = function () { syncSheet(); };
    if (sheetMql.addEventListener) sheetMql.addEventListener('change', onSheetMq);
    else if (sheetMql.addListener) sheetMql.addListener(onSheetMq);
  }

  /* A second way to hear the same news.

     The query listener is the right instrument and it is what fires in a real
     browser. resize is the belt: an embedded webview or a devtools device
     override can change the viewport without emitting a query change, and the
     failure that leaves behind is a locked body under a sheet the stylesheet
     has already stopped drawing. Coalesced to one call a frame, and syncSheet
     is a no-op when nothing has actually changed. */
  var sheetResizeRaf = 0;
  global.addEventListener('resize', function () {
    if (sheetResizeRaf) return;
    sheetResizeRaf = global.requestAnimationFrame
      ? requestAnimationFrame(function () { sheetResizeRaf = 0; syncSheet(); })
      : setTimeout(function () { sheetResizeRaf = 0; syncSheet(); }, 60);
  });

  function renderWorkspace() {
    if (!document.getElementById('catPanel')) { renderFinder(document.getElementById('page')); return; }
    document.getElementById('catPanel').innerHTML = categoryPanelHTML() + billingEntryHTML();

    /* An open group or a searched model is the focused layout: the centre
       column alone, with its own category selector. The side panels are the
       LIBRARY's filters — categories and brands — and in a result they were
       a second category picker and a brand list that narrowed nothing the
       reader was looking at. Both stay mounted, so going back to the library
       is a class change, not a rebuild. */
    var grp = currentGroup();
    var focus = !!(grp || state.finder.modelId);
    document.getElementById('brandPanel').innerHTML = focus ? '' : brandPanelHTML();
    var wsb = document.querySelector('.ws__body');
    if (wsb) wsb.classList.toggle('ws__body--focus', focus);

    if (grp) {
      document.getElementById('centerHead').innerHTML = groupCenterHTML(grp);
      var res0 = document.getElementById('results');
      if (res0) res0.innerHTML = '';
      var lm0 = document.getElementById('loadmore');
      if (lm0) lm0.innerHTML = '';
      var rail0 = document.getElementById('catRail');
      if (rail0) rail0.innerHTML = railHTML();
      syncSheet();
      return;
    }

    document.getElementById('centerHead').innerHTML = centerHeadHTML();
    /* A model just picked: the column still holds the library behind it, and the
       sheet rising now would show the home feed until the matches arrive. It
       rises on a loading state instead. Switching category within the same
       model keeps what is there. */
    var res = document.getElementById('results');
    var heldFor = res ? res.getAttribute('data-model') || '' : '';
    if (res && heldFor !== (state.finder.modelId || '')) {
      if (state.finder.modelId) {
        res.innerHTML = C.skelRows(4);
        var lm1 = document.getElementById('loadmore');
        if (lm1) lm1.innerHTML = '';
        res.setAttribute('data-model', state.finder.modelId);
      } else {
        res.removeAttribute('data-model');
      }
    }
    syncSheet();

    var rail = document.getElementById('catRail');
    if (rail) {
      var keep = rail.querySelector('.crail') ? rail.querySelector('.crail').scrollLeft : 0;
      rail.innerHTML = railHTML();
      /* keep the rail where the user had scrolled it */
      var r = rail.querySelector('.crail');
      if (r) r.scrollLeft = keep;
    }

    /* One column, two things it can hold: the groups a model matches, or the
       whole library. */
    if (state.finder.modelId) loadMatches();
    else loadGroups(true);
  }

  /* A change of view, or "show more": the list alone, in place. */
  function repaintGroupList() {
    var row = currentGroup();
    if (!row) return;
    var host = document.getElementById('groupList');
    if (host) host.innerHTML = groupListHTML(row);
  }

  /* Kept as the old name so nothing else had to change; the two are the same
     operation now that there is only one layout. */
  function renderBrowse() { renderWorkspace(); }

  function centerHeadHTML() {
    var f = state.finder;
    var searchField = function (id) {
      return '<label class="field">' + icon('search') +
        '<input class="input" id="' + id + '" placeholder="Filter groups, part codes…" ' +
        'value="' + esc(f.filters.q) + '" aria-label="Filter groups" /></label>';
    };
    /* With a model selected the head is the category selector and nothing
       else: the master's header and its devices are the results themselves,
       one per group, drawn by loadMatches. */
    if (f.modelId) {
      return catSelectorHTML(
        (db.partCountsByCategory && db.partCountsByCategory[f.modelId]) || null,
        f.catId, 'pick-cat-rail');
    }

    return (
      '<div class="sec"><div class="sec__head"><div class="sec__title">' +
      '<h2>Compatibility groups</h2><span class="sec__count" id="gcount">…</span></div>' +
      '<div class="row wrap ws-tools" style="gap:8px">' +
      '<span class="ws-only">' + searchField('gqd') + '</span>' +
      /* What the feed CONTAINS, beside how it is sorted. The two are separate
         questions — "only the recent ones" and "newest first" are not the
         same request — so they are separate controls rather than one list
         with the cross product in it. */
      '<label class="sr" for="viewSel">Group view</label>' +
      '<select class="input" id="viewSel" style="width:auto;height:38px">' +
      opt('both', 'Suggested + All', f.filters.view) +
      opt('trending', 'Trending only', f.filters.view) +
      opt('suggest', 'Suggested only', f.filters.view) +
      opt('all', 'All groups', f.filters.view) +
      '</select>' +
      '<label class="sr" for="sortSel">Sort groups</label>' +
      '<select class="input" id="sortSel" style="width:auto;height:38px">' +
      opt('mixed', 'Best match', f.filters.sort) +
      opt('default', 'Group number', f.filters.sort) +
      opt('most', 'Most devices', f.filters.sort) +
      opt('least', 'Fewest devices', f.filters.sort) +
      opt('az', 'Master A–Z', f.filters.sort) +
      '</select></div></div>' +

      /* the group filter belongs to this section, below its heading —
         static, so it never floats over the hero or the search dropdown */
      '<div class="fbar">' +
      '<div class="field grow">' + icon('search') +
      '<input class="input" id="gq" placeholder="Filter groups, part codes…" value="' + esc(f.filters.q) + '" aria-label="Filter groups" /></div>' +
      '<button class="btn btn--outline btn--icon fbar__btn" data-act="open-filters" aria-label="Filters">' +
      icon('filter') + (activeFilterCount() ? '<span class="dotn">' + activeFilterCount() + '</span>' : '') + '</button>' +
      '</div></div>'
    );
  }

  /* THE RESULT PAGE'S CATEGORIES, IN A FIXED ORDER, WITH THE COUNTER'S NAMES.

     Written as the words a shop uses and resolved to the catalogue's own ids
     through SM.categoryAssets — so "tempered glass" lands on screen-guards
     and "combo display" on combo-display, and nothing here can invent a
     second category for an id it misspelt. That is exactly what the list this
     replaces did: it named 'tempered-glass', which is not an id, so Screen
     Guards fell to the END of the rail, after Battery, and the result page
     opened on "All Parts" instead of on the glass.

     The order is this list's, not the database's and not the alphabet's.
     A category the catalogue adds later follows the six, in its own order.
     There is no "All Parts": a result is always one category's group. */
  var RESULT_CATS = [
    { key: 'tempered glass', label: 'Tempered Glass' },
    { key: 'back cover', label: 'Back Cover' },
    { key: 'combo display', label: 'Combo / Display' },
    { key: 'middle frame', label: 'Middle Frame' },
    { key: 'battery', label: 'Battery' },
    { key: 'cc board', label: 'CC Board' }
  ];

  function resultCategories() {
    var out = [], used = {};
    RESULT_CATS.forEach(function (rc) {
      var id = (SM.categoryAssets && SM.categoryAssets.resolve(rc.key)) || rc.key;
      var c = db.categoryById[id];
      if (c && !used[c.id]) { used[c.id] = 1; out.push(c); }
    });
    db.categories.forEach(function (c) { if (!used[c.id]) out.push(c); });
    return out;
  }

  /* The name a category goes by on the result page. */
  function resultCatLabel(c) {
    if (!c) return '';
    for (var i = 0; i < RESULT_CATS.length; i++) {
      var id = SM.categoryAssets && SM.categoryAssets.resolve(RESULT_CATS[i].key);
      if (id === c.id) return RESULT_CATS[i].label;
    }
    return c.name;
  }

  /* Where a freshly searched model opens: Tempered Glass when it has one,
     otherwise the first category in the order above that it DOES have a group
     in — read from the public per-category counts, so it is decided before
     the server has answered and the first frame is already the right one. A
     model with no group anywhere opens on Tempered Glass and its honest
     empty state. */
  function defaultResultCategory(modelId) {
    var counts = (db.partCountsByCategory && db.partCountsByCategory[modelId]) || {};
    var cats = resultCategories().filter(function (c) { return !c.comingSoon; });
    for (var i = 0; i < cats.length; i++) if (counts[cats[i].id] > 0) return cats[i].id;
    return cats.length ? cats[0].id : null;
  }

  /* A category the catalogue carries but has no groups for yet.

     It is asked of the CATALOGUE, not of a list kept here, so a category
     stops being "coming soon" the moment its data lands in the bundle and no
     code changes. Every control below reads this to decide two things: show
     "Soon" instead of a count, and send the click somewhere that does not
     filter — see the 'cat-soon' action. */
  function catSoon(id) {
    var c = id && id !== 'all' && db.categoryById[id];
    return !!(c && c.comingSoon);
  }
  /* Where a category card's click goes. A category with data filters; one
     without says so. Deciding it in one place is what keeps the home rail,
     the result rail and the sidebar tiles from drifting apart. */
  function catAct(id, act) { return catSoon(id) ? 'cat-soon' : act; }

  /* ONE rail card, for both rails below.

     The phone version of the desktop tile, and the same idea: the picture is
     the card. The name used to be printed under a 46px stamp and the count
     under that, so two thirds of an already small card was type and the part
     — the thing you actually recognise — was the smallest element on it.

     Now the picture fills the card, the name appears only while the card is
     being pressed, and the count shows on the SELECTED card alone: seven
     numbers across a strip is a row of figures with no question attached,
     while one number on the card you just chose is the answer to "how many".

     Nothing is hidden from anyone who cannot see the reveal — the button's
     aria-label always carries the name and the count in full. */
  function railItem(o) {
    /* A category with no data yet is never counted, never disabled and never
       selected: it carries "Soon" where the number goes and its press opens
       the coming-soon note instead of filtering. aria-pressed is dropped with
       it — the card is not a toggle when there is nothing to toggle. */
    var soon = !!o.soon;
    var pending = !soon && o.count == null;
    var empty = !soon && !!o.empty;
    var aria = soon
      ? o.name + ' — coming soon'
      : o.name + ' — ' + (pending ? 'counting' : nf(o.count) + ' ' + (o.count === 1 ? 'group' : 'groups'));
    return '<button type="button" class="crail__item' + (o.on && !soon ? ' is-on' : '') +
      (empty ? ' is-empty' : '') + '" ' +
      'data-act="' + o.act + '" data-id="' + esc(o.id) + '"' +
      (o.color ? ' style="--c:' + o.color + '"' : '') +
      (empty ? ' disabled' : '') +
      (soon ? '' : ' aria-pressed="' + (o.on ? 'true' : 'false') + '"') +
      ' aria-label="' + esc(aria) + '">' +
      '<span class="crail__art">' +
      /* The white master, on a white card. These are product photographs shot
         on white and the card is the surface they were lit for — the
         transparent cutouts exist and still work (SM.categoryAssets.cutout),
         but floating the parts straight on the green was tried and the white
         display surface reads better against it. */
      SM.art.category(o.id, 'pthumb--rail', o.name, { eager: true }) +
      '<span class="crail__veil" aria-hidden="true"></span>' +
      '<span class="crail__name" aria-hidden="true">' + esc(o.name) + '</span>' +
      '</span>' +
      '<span class="crail__n' + (soon ? ' crail__n--soon' : '') + '" aria-hidden="true">' +
      (soon ? 'Soon' : pending ? '…' : nf(o.count)) + '</span>' +
      '</button>';
  }

  /* Result-page rail: same look and behaviour as the home rail, ordered by
     the priority above and annotated with this model's group counts. */
  function resultRailHTML() {
    var f = state.finder;
    var avail = f.avail;
    return '<div class="crail" role="group" aria-label="Part categories">' +
      resultCategories().map(function (c) {
        var n = avail ? (avail[c.id] || 0) : null;
        return railItem({
          id: c.id, name: resultCatLabel(c), count: n, color: c.color, soon: c.comingSoon,
          on: f.catId === c.id, empty: n === 0, act: catAct(c.id, 'pick-cat-rail')
        });
      }).join('') +
      '</div>';
  }

  /* ---- horizontal product-category rail, directly under the main search ---- */
  function categoryRailHTML() {
    var sel = state.finder.filters.catId;
    return '<div class="crail" role="group" aria-label="Part categories">' +
      railItem({ id: 'all', name: 'All Parts', count: db.stats.groups, on: sel === 'all', act: 'filter-cat' }) +
      db.categories.map(function (c) {
        return railItem({
          id: c.id, name: c.name, count: c.groupCount, color: c.color, soon: c.comingSoon,
          on: sel === c.id, act: catAct(c.id, 'filter-cat')
        });
      }).join('') +
      '</div>';
  }

  function opt(v, l, cur) {
    return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + esc(l) + '</option>';
  }
  function activeFilterCount() {
    var f = state.finder.filters;
    /* On a result the category is not a filter — there is always one — so it
       is not counted as one being applied. */
    var catOn = f.catId !== 'all' && !state.finder.modelId;
    return (f.brandId !== 'all' ? 1 : 0) + (catOn ? 1 : 0) + (f.sort !== 'mixed' ? 1 : 0) + (f.view && f.view !== 'both' ? 1 : 0);
  }

  /* ---- LEFT panel: part categories as a 2-up grid of icon-over-name tiles --- */
  function categoryPanelHTML() {
    var f = state.finder.filters;
    /* With a model selected the tiles count THAT model's groups, not the whole
       library — otherwise the panel offers a category with 812 groups in it and
       the centre then says there is nothing. A category the model has none of
       is disabled rather than hidden, so the six categories stay in one place. */
    var avail = state.finder.modelId ? state.finder.avail : null;
    var pending = !!state.finder.modelId && !avail;
    var availTotal = avail ? Object.keys(avail).reduce(function (n, k) { return n + avail[k]; }, 0) : 0;

    /* The picture is the tile, and at rest it is ALL of the tile: the name,
       the count and the gradient behind the name are painted only while the
       pointer is on the card. Browsing the panel is then a gallery of parts
       rather than seven captioned boxes, and the answer is one hover away.

       None of that hides anything: name and count are both in the button's
       accessible name, so a screen reader and a keyboard user get them
       without a pointer, and on touch — where hover does not exist — the CSS
       leaves them on.

       The count carries no unit. "167 groups" under seven tiles is seven
       repetitions of a word the panel heading has already said; the number is
       the only part that differs, so the number is the only part drawn. */
    var tile = function (id, name, color, ic, count) {
      /* Same card, same size, same picture treatment — a category with no
         data yet differs in three details and nothing else: "Soon" where the
         number goes, no selected state, and a press that explains rather than
         filters. It is deliberately NOT the disabled state a model's missing
         category gets: that one is off because this handset has none, this one
         is on because the part exists and the data is still being collected. */
      var soon = catSoon(id);
      var on = !soon && f.catId === id;
      var n = avail ? (id === 'all' ? availTotal : (avail[id] || 0)) : count;
      var empty = !soon && !!avail && n === 0;
      var badge = soon ? 'Soon' : pending ? '…' : nf(n);
      var aria = soon
        ? name + ' — coming soon'
        : name + ' — ' + (pending ? 'counting' : nf(n) + ' ' + (n === 1 ? 'group' : 'groups'));
      return '<button type="button" class="ctile' + (on ? ' is-on' : '') +
        (empty ? ' is-empty' : '') + '" ' +
        'data-act="' + catAct(id, 'filter-cat') + '" data-id="' + id + '" style="--c:' + color + '"' +
        (empty ? ' disabled' : '') +
        (soon ? '' : ' aria-pressed="' + (on ? 'true' : 'false') + '"') +
        ' aria-label="' + esc(aria) + '">' +
        '<span class="ctile__art">' +
        /* Eager: a focus-fitted picture is 0px tall until it loads, and a
           zero-area image never intersects the viewport, so a lazy one waits
           for a load that its own size prevents. These eight only appeared at
           all when a group card happened to warm the same URL first — which
           is why the sidebar could come up with five empty tiles. */
        SM.art.category(id === 'all' ? 'all' : id, 'pthumb--tile', name, { eager: true }) +
        '<span class="ctile__veil" aria-hidden="true"></span>' +
        '<span class="ctile__name" aria-hidden="true">' + esc(name) + '</span>' +
        '</span>' +
        '<span class="ctile__n' + (soon ? ' ctile__n--soon' : '') + '" aria-hidden="true">' +
        badge + '</span>' +
        /* No tick. aria-pressed above already states the selection, and on
           screen the card's coloured edge says it without covering the part. */
        '</button>';
    };

    /* The last slot in the grid. A placeholder for category management, not
       category management — it is deliberately not a filter, carries its own
       action, and sits in the grid as an ordinary cell so the seven real tiles
       keep their size and rhythm. */
    var addTile =
      '<button type="button" class="ctile ctile--add" data-act="add-category" ' +
      'aria-label="Add a part category">' +
      '<span class="ctile__art"><span class="ctile__plus" aria-hidden="true">' + icon('plus') + '</span>' +
      '<span class="ctile__name ctile__name--add" aria-hidden="true">Add</span></span>' +
      '</button>';

    /* Two columns or three, as a segmented pair in the panel head. The grid
       reads one custom property, so switching is a class swap on the
       container — no relayout of anything outside this panel and nothing for
       the sticky sidebar to lose. */
    var colBtn = function (n) {
      var on = state.catCols === n;
      return '<button type="button" class="cols__opt' + (on ? ' is-on' : '') + '" ' +
        'data-act="cat-cols" data-id="' + n + '" aria-pressed="' + on + '" ' +
        'title="' + n + ' columns" aria-label="Show categories in ' + n + ' columns">' +
        icon(n === 2 ? 'cols2' : 'cols3') + '</button>';
    };

    /* With a model selected this is the result page's category selector:
       the result order and names, no "All" tile and no Clear — a result is
       always one category. Browsing the library keeps the catalogue's own
       order and the All tile. */
    var resultMode = !!state.finder.modelId;
    var cats = resultMode ? resultCategories() : db.categories;
    return '<section class="panel panel--cats">' +
      '<div class="panel__head"><span class="t-lab">Part category</span>' +
      '<span class="row" style="gap:6px">' +
      '<span class="cols" role="group" aria-label="Category grid columns">' +
      colBtn(2) + colBtn(3) + '</span>' +
      (f.catId !== 'all' && !resultMode
        ? '<button class="panel__clear" data-act="filter-cat" data-id="all">' + icon('close') + 'Clear</button>'
        : '<span class="panel__n">' + db.categories.length + '</span>') +
      '</span></div>' +
      '<div class="ctiles ctiles--' + state.catCols + '">' +
      (resultMode ? '' : tile('all', 'All Categories', 'var(--teal-500)', 'grid', db.stats.groups)) +
      cats.map(function (c) {
        return tile(c.id, resultMode ? resultCatLabel(c) : c.name, c.color, c.icon, c.groupCount);
      }).join('') +
      addTile +
      '</div></section>';
  }

  /* ---- RIGHT panel: brands as a list of logo + name + group count --------- */
  function brandPanelHTML() {
    var f = state.finder.filters;
    var allOn = f.brandId === 'all';
    return '<section class="panel">' +
      '<div class="panel__head"><span class="t-lab">Brand</span>' +
      '<span class="panel__n">' + db.brands.length + '</span></div>' +
      /* search sits first inside the panel, directly under the heading */
      /* class, not id: the panel is rendered twice (sidebar + filter sheet) */
      '<div class="brandsearch"><label class="field">' + icon('search') +
      '<input class="input brandq" type="search" placeholder="Search brands…" autocomplete="off" ' +
      'value="' + esc(state.brandQ) + '" aria-label="Search brands" />' +
      (state.brandQ ? '<button class="field__clear" data-act="clear-brandq" aria-label="Clear brand search">' + icon('close') + '</button>' : '') +
      '</label></div>' +
      '<div class="brows">' + brandRowsHTML() + '</div>' +
      (activeFilterCount()
        ? '<button class="btn btn--outline btn--sm btn--block" style="margin-top:12px" data-act="reset-filters">' +
        icon('refresh') + 'Reset filters</button>'
        : '') +
      '</section>';
  }

  /* rows only — repainted on every keystroke so the input keeps focus */
  function brandRowsHTML() {
    var f = state.finder.filters;
    var q = (state.brandQ || '').toLowerCase().trim();
    var allOn = f.brandId === 'all';
    /* rank matches so a brand whose own name starts with the query leads:
       "one" puts OnePlus first rather than iPhone/Zenfone alias hits */
    function score(b) {
      var name = b.name.toLowerCase();
      if (name.indexOf(q) === 0) return 0;
      if (b.slug.indexOf(q) === 0) return 1;
      for (var i = 0; i < b.aliases.length; i++) {
        var words = b.aliases[i].toLowerCase().split(/\s+/);
        for (var j = 0; j < words.length; j++) if (words[j].indexOf(q) === 0) return 2;
      }
      if (name.indexOf(q) > -1) return 3;
      return b.search.indexOf(q) > -1 ? 4 : -1;
    }
    var list = db.brands.filter(function (b) { return b.active !== false; });
    if (q) {
      list = list.map(function (b) { return { b: b, s: score(b) }; })
        .filter(function (r) { return r.s > -1; })
        .sort(function (x, y) { return x.s - y.s || x.b.sortOrder - y.b.sortOrder; })
        .map(function (r) { return r.b; });
    }

    if (q && !list.length) {
      return '<div class="brandempty">' + icon('search') +
        '<span>No brands found for “' + esc(state.brandQ) + '”</span></div>';
    }
    /* All Brands stays pinned at the top whenever it is not filtered away */
    var head = (!q || 'all brands'.indexOf(q) > -1)
      ? '<button type="button" class="brow' + (allOn ? ' is-on' : '') + '" data-act="filter-brand" data-id="all" ' +
      'aria-pressed="' + allOn + '"><span class="brow__all">' + icon(allOn ? 'check' : 'grid') + '</span>' +
      '<span class="brow__n">All Brands</span>' +
      '<span class="brow__c">' + db.stats.groups + '</span></button>'
      : '';

    return head + list.map(function (b) {
      var on = f.brandId === b.id;
      return '<button type="button" class="brow' + (on ? ' is-on' : '') + (b.groupCount ? '' : ' brow--empty') +
        '" data-act="filter-brand" data-id="' + b.id + '" aria-pressed="' + on + '" ' +
        'title="' + esc(b.name) + (b.groupCount ? '' : ' — no product groups yet') + '">' +
        SM.art.brand(b, 'blogo--rail') +
        '<span class="brow__n">' + esc(b.name) + '</span>' +
        '<span class="brow__c">' + b.groupCount + '</span></button>';
    }).join('');
  }

  /* repaint every rendered copy of the list so sidebar and sheet stay in step */
  function paintBrandRows(source) {
    var html = brandRowsHTML();
    document.querySelectorAll('.brows').forEach(function (h) { h.innerHTML = html; });
    document.querySelectorAll('.brandq').forEach(function (i) {
      if (i !== source && i.value !== state.brandQ) i.value = state.brandQ;
    });
  }

  function loadGroups(reset) {
    var f = state.finder;
    /* Firestore pages with a cursor, not a page number — there is no OFFSET
       that skips for free, so "page 10" would re-read pages 1-9. The cursor is
       the last document of the previous page and is cleared on a new query. */
    if (reset) { f.page = 1; f.rows = []; f.cursor = null; f.rowsReady = false; }
    f.busy = true;
    var res = document.getElementById('results');
    if (reset && res) res.innerHTML = C.skelPlates(6);
    /* a new result set always starts at the top of the centre column */
    if (reset) { var sc = wsScroller(); if (sc) sc.scrollTop = 0; }

    /* The trending row is asked for only when it would be shown. Typing in the
       group filter is a specific question, and answering it with a row of
       whatever is newest would be answering a different one — so a search
       turns the row off rather than competing with itself. */
    var wantTrending = sectionWanted(f, 'trending') ? api.trendingMax() : 0;
    var wantSuggest = sectionWanted(f, 'suggest') ? api.suggestMax() : 0;

    api.listGroups({
      q: f.filters.q, brandId: f.filters.brandId, categoryId: f.filters.catId,
      sort: f.filters.sort, page: f.page, pageSize: 12, cursor: f.cursor,
      trending: wantTrending, suggest: wantSuggest
    }).then(function (r) {
      f.busy = false; f.total = r.total; f.hasMore = r.hasMore;
      f.cursor = r.cursor || null;
      f.source = r.source || 'catalogue';
      if (reset) { f.trending = r.trending || []; f.suggest = r.suggest || []; }
      f.restTotal = r.restTotal == null ? r.total : r.restTotal;
      f.rows = reset ? r.items : f.rows.concat(r.items);
      var cards = r.items.concat(reset ? (f.trending || []).concat(f.suggest || []) : []);
      withPreviews(cards, function () { f.rowsReady = true; paintGroups(); });
    });

    /* The handset strip is its own read — a different question over a
       different table — so it is fetched alongside rather than folded into
       the group query, and only when it is going to be drawn. */
    if (reset) {
      if (sectionWanted(f, 'suggest')) {
        api.newModels({
          categoryId: f.filters.catId, brandId: f.filters.brandId, limit: 14
        }).then(function (models) {
          f.newModels = models || [];
          /* Not before the groups themselves are on their way to the page:
             painting the handset strip over an empty group list would flash
             "no group matches" while the cards are still being prepared. */
          if (f.rowsReady) paintGroups();
        });
      } else {
        f.newModels = [];
      }
    }
  }

  /* The model names on the cards about to be painted, fetched first so a
     card is drawn once with its names in it rather than growing a moment
     later under the reader's thumb. Not waited on for long: past PREVIEW_WAIT
     the cards are painted without, and C.fillPreviews puts the names into
     their reserved slots when they arrive. */
  var PREVIEW_WAIT = 1200;
  function withPreviews(rows, paint) {
    var ids = (rows || []).map(function (row) { return row && row.group && row.group.groupId; })
      .filter(function (id) { return id && SM.access && !SM.access.previewOf(id); });
    if (!ids.length || !SM.access || !SM.access.previews) { paint(); return; }
    var painted = false;
    var timer = setTimeout(function () { painted = true; paint(); }, PREVIEW_WAIT);
    SM.access.previews(ids).then(function () {
      if (!painted) { clearTimeout(timer); painted = true; paint(); return; }
      C.fillPreviews(document.getElementById('results'));
    });
  }

  /* The suggestion sections are shown while BROWSING, and stand down for
     anything more specific: a text filter, or a view the user has narrowed by
     hand. With a model selected the centre runs loadMatches() and never
     reaches here at all. */
  function sectionWanted(f, which) {
    if ((f.filters.q || '').trim()) return false;
    var view = f.filters.view || 'both';
    if (view === 'both') return true;
    return view === which;
  }

  function paintGroups() {
    var f = state.finder;
    var res = document.getElementById('results');
    var lm = document.getElementById('loadmore');
    var cnt = document.getElementById('gcount');
    if (!res) return;
    /* The library is painted only while the library is what the centre column
       is showing. A page of groups can land late — its card previews are
       waited for — and by then a model may have been searched or a group
       opened; painting it then would put the whole feed under that result. */
    if (state.route.name !== 'finder' || f.groupId || f.modelId) return;
    if (cnt) cnt.textContent = nf(f.total) + (f.total === 1 ? ' group' : ' groups');

    var trending = sectionWanted(f, 'trending') ? (f.trending || []) : [];
    var suggest = sectionWanted(f, 'suggest') ? (f.suggest || []) : [];
    var sModels = sectionWanted(f, 'suggest') ? (f.newModels || []) : [];
    var view = f.filters.view || 'both';
    var onlyTrending = view === 'trending';
    var onlySuggest = view === 'suggest';

    if (!f.rows.length && !trending.length && !suggest.length) {
      res.innerHTML = C.state({
        icon: 'inbox', title: 'No compatibility group matches those filters',
        text: 'Try a different part category or brand, or clear the filter text.',
        action: '<button class="btn btn--soft" data-act="reset-filters">' + icon('refresh') + 'Reset filters</button>'
      });
      lm.innerHTML = '';
      return;
    }

    /* ONE ROW, SCROLLING SIDEWAYS. Stacking the recent groups vertically would
       push the catalogue below the fold to say something the catalogue already
       says. Only this strip scrolls horizontally; the page does not. */
    /* A carousel and the two buttons that drive it. The row is the scroll
       container, so only it ever moves sideways — the page cannot. */
    function rail(id, cls, label, inner) {
      return '<div class="rail">' +
        '<button type="button" class="rail__nav rail__nav--prev" data-act="rail" data-dir="-1" ' +
        'data-rail="' + id + '" aria-label="Scroll ' + esc(label) + ' left" disabled>' + icon('chevronLeft') + '</button>' +
        '<div class="' + cls + '" id="' + id + '" role="group" aria-label="' + esc(label) + '">' + inner + '</div>' +
        '<button type="button" class="rail__nav rail__nav--next" data-act="rail" data-dir="1" ' +
        'data-rail="' + id + '" aria-label="Scroll ' + esc(label) + ' right">' + icon('chevronRight') + '</button>' +
        '</div>';
    }

    var head = '';
    if (trending.length) {
      head =
        '<section class="feed feed--trend">' +
        '<div class="feed__head"><h3 class="feed__title">' + icon('sparkle') + 'Trending groups</h3>' +
        '<span class="feed__note">Phones from the last 12 months, widest fit first</span></div>' +
        rail('railTrend', 'trendrow', 'Trending compatibility groups',
             trending.map(function (row) { return C.plate(row); }).join('')) +
        '</section>';
    }

    /* Handsets before parts. What a counter wants to know first is what has
       just come out — a phone released last month is the one being brought in
       with a cracked screen — so this is the newest of them, with a way
       through to the whole catalogue beside it. */
    var models = '';
    if (sModels.length) {
      models =
        '<section class="feed feed--models">' +
        '<div class="feed__head"><h3 class="feed__title">' + icon('sparkle') + 'New models</h3>' +
        '<span class="feed__note">Latest releases across every brand</span>' +
        '<a class="feed__more" href="/models">All models' + icon('arrowRight') + '</a></div>' +
        rail('railModels', 'modelrow', 'New models',
             sModels.map(function (m) { return C.newModelCard(m); }).join('')) +
        '</section>';
    }

    /* Two rows deep, filling column by column, so the strongest groups are the
       ones on screen before any scrolling happens. */
    var sugg = '';
    if (suggest.length) {
      sugg =
        '<section class="feed feed--suggest">' +
        '<div class="feed__head"><h3 class="feed__title">' + icon('bolt') + 'Suggested groups</h3>' +
        '<span class="feed__note">Widest fitment in the catalogue</span></div>' +
        rail('railSuggest', 'suggestrow', 'Suggested compatibility groups',
             suggest.map(function (row) { return C.plate(row); }).join('')) +
        '</section>';
    }

    if (onlyTrending || onlySuggest) {
      res.innerHTML = (onlyTrending ? head : models + sugg) || '';
      var shown = onlyTrending ? trending.length : suggest.length;
      lm.innerHTML = shown
        ? '<span class="t-xs muted">' + nf(shown) + ' of ' + nf(f.total) +
          ' groups — switch to “All groups” for the rest</span>'
        : '<span class="t-xs muted">Nothing to suggest for these filters</span>';
      C.fitPreviews(res);
      syncRails();
      return;
    }

    /* "All groups" is named only when something sits above it; on its own it
       is just the results, and a heading over the only section is noise. */
    /* With a narrow filter the suggestion rows can hold everything there is,
       and "All groups — 0 more" over an empty grid is a heading for nothing. */
    var restHead = (trending.length || suggest.length)
      ? '<div class="feed__head feed__head--rest"><h3 class="feed__title">All groups</h3>' +
        '<span class="feed__note">' + nf(f.restTotal == null ? f.total : f.restTotal) + ' more</span></div>'
      : '';

    res.innerHTML = head + models + sugg +
      (f.rows.length
        ? '<section class="feed">' + restHead +
          '<div class="gridcards">' + f.rows.map(function (row) { return C.plate(row); }).join('') + '</div>' +
          '</section>'
        : '');

    var left = (f.restTotal == null ? f.total : f.restTotal) - f.rows.length;
    lm.innerHTML = f.hasMore
      ? '<button class="btn btn--outline" data-act="more-groups">' + icon('plus') + 'Show more groups <span class="muted">(' + nf(Math.max(0, left)) + ' left)</span></button>'
      : '<span class="t-xs muted">All ' + nf(f.total) + (f.total === 1 ? ' group' : ' groups') + ' shown</span>';
    C.fitPreviews(res);
    observeMore();
    syncRails();
  }

  /* The cards' name boxes are fitted to their width, so a change of width —
     a rotated phone, a resized window — and the web font arriving (names are
     wider in it than in the fallback) both refit them. Coalesced to a frame. */
  var fitRaf = 0;
  function refitCards(force) {
    if (fitRaf) return;
    var run = function () {
      fitRaf = 0;
      var res = document.getElementById('results');
      if (res) C.fitPreviews(res, force);
    };
    fitRaf = global.requestAnimationFrame ? global.requestAnimationFrame(run) : setTimeout(run, 16);
  }
  global.addEventListener('resize', function () { refitCards(false); });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { refitCards(true); });
  }

  /* An arrow is never left offering a direction there is nothing in, and a
     carousel that fits entirely on screen shows no arrows at all. The listener
     is bound once per row; the row survives until the next repaint, which
     rebuilds it and rebinds. */
  function syncRails() {
    document.querySelectorAll('.rail').forEach(function (wrap) {
      var row = wrap.querySelector('.trendrow, .suggestrow, .modelrow');
      if (!row) return;
      var prev = wrap.querySelector('.rail__nav--prev');
      var next = wrap.querySelector('.rail__nav--next');
      var update = function () {
        var max = row.scrollWidth - row.clientWidth;
        var x = row.scrollLeft;
        if (prev) prev.disabled = x <= 2;
        if (next) next.disabled = x >= max - 2;
        wrap.classList.toggle('is-static', max <= 2);
      };
      if (!row.railBound) {
        row.addEventListener('scroll', update, { passive: true });
        row.railBound = true;
      }
      update();
    });
  }

  /* the centre column scrolls on its own above 1180px and with the page below */
  /* Whichever element is actually scrolling the result right now.

     On a desktop that is the centre column. In the mobile sheet the centre
     column has been flattened away with display:contents and the SHEET is the
     scroller, so asking for #wsCenter there returns an element that has never
     scrolled and never will — which is why changing model or category on a
     phone used to leave the reader wherever they had scrolled to, looking at
     the middle of a group they had just replaced. */
  function wsScroller() {
    var sheet = document.querySelector('.ws__body--sheet');
    if (sheet) return sheet;
    var el = document.getElementById('wsCenter');
    if (!el) return null;
    return getComputedStyle(el).overflowY === 'auto' ? el : null;
  }

  /* Back to the top of whatever is scrolling the result — the centre column
     on a desktop, the sheet on a phone. Used wherever the result becomes a
     different result: a new category, a new model. */
  function resetResultScroll() {
    var sc = wsScroller();
    if (sc) sc.scrollTop = 0;
  }

  var io = null;
  function observeMore() {
    var lm = document.getElementById('loadmore');
    if (!lm || !('IntersectionObserver' in window)) return;
    if (io) io.disconnect();
    io = new IntersectionObserver(function (entries) {
      if (state.finder.modelId) return;
      if (entries[0].isIntersecting && state.finder.hasMore && !state.finder.busy) {
        state.finder.page++; loadGroups(false);
      }
    }, { root: wsScroller(), rootMargin: '300px' });
    io.observe(lm);
  }

  /* ------------------------------------------------ selected-model workflow

     WHICH ANSWER IS ALLOWED TO LAND.

     A result is only wanted while the question that asked for it is still the
     question on screen, and this one has two halves: the model AND the
     category. The guard used to check the model alone, so tapping through the
     category rail quickly — six taps in under a second, which is what a rail
     of six categories invites — let a slower earlier lookup resolve last and
     paint a Back Cover group under a Middle Frame heading.

     matchSeq is bumped by every call. A resolved promise compares its own
     ticket to the counter and drops itself if anything has been asked since;
     the model and category are re-checked as well, so a request that is
     somehow still current but no longer describes the state cannot land
     either. There is no cancellation to arrange and no request to abort — a
     stale answer simply has nowhere to go. */
  var matchSeq = 0;
  function loadMatches() {
    var f = state.finder;
    var modelAtCall = f.modelId;
    var catAtCall = f.catId || 'all';
    var ticket = ++matchSeq;
    var current = function () {
      return ticket === matchSeq &&
        state.finder.modelId === modelAtCall &&
        (state.finder.catId || 'all') === catAtCall;
    };

    /* The category availability drives the rail and the left-hand counts, so
       it is fetched once per model and reused. It does not depend on the
       category, so it is guarded on the model alone — switching category must
       not throw away counts that are still correct. */
    if (!f.avail) {
      api.categoryAvailability(f.modelId).then(function (rows) {
        if (state.finder.modelId !== modelAtCall) return;
        var map = Object.create(null);
        rows.forEach(function (r) { map[r.category.id] = r.count; });
        state.finder.avail = map;
        var rail = document.getElementById('catRail');
        if (rail) rail.innerHTML = railHTML();
        var panel = document.getElementById('catPanel');
        if (panel) panel.innerHTML = categoryPanelHTML() + billingEntryHTML();
      });
    }

    api.findMatches({ modelId: f.modelId, categoryId: f.catId || 'all' }).then(function (rows) {
      /* The centre column, the same element the group library renders into. */
      var host = document.getElementById('results');
      /* Model, category and sequence all still current, or this answer is to
         a question nobody is asking any more. */
      if (!host || !current()) return;

      /* COULD NOT ASK is not the same as NOTHING FOUND, and rendering the
         first as the second tells a shop their customer's phone has no parts
         when in fact the server did not answer. findMatches marks the array
         rather than throwing, because an outage is an outcome to draw, not an
         exception to swallow. */
      if (rows && rows.unavailable) {
        state.finder.matches = null;
        host.innerHTML = C.state({
          icon: 'alert',
          title: 'Could not load the compatibility groups',
          text: 'The server did not answer, so nothing is being shown rather ' +
            'than something that might be wrong. This is a fault on our side ' +
            'and not a statement about ' + esc(db.modelById[f.modelId] ? db.modelById[f.modelId].fullName : 'this device') + '.',
          action: '<button class="btn btn--soft" data-act="retry-matches">' +
            icon('refresh') + 'Try again</button>'
        });
        return;
      }
      state.finder.matches = rows;
      /* The browse view's infinite scroll must not keep firing underneath a
         result — it would append library groups below the matches. */
      if (io) io.disconnect();
      var lm = document.getElementById('loadmore');
      if (lm) lm.innerHTML = '';
      var m = db.modelById[f.modelId];
      var cat = f.catId ? db.categoryById[f.catId] : null;

      /* No brand or text filter applies here. Those are the library's
         controls, and the result page no longer shows them — a filter left
         set in the library would otherwise empty a result with nothing on
         screen to say why. */
      if (!rows.length) {
        /* The categories this model DOES have a group in, as the way on —
           named, and in the result order, rather than an "all parts" list
           the result page no longer has. */
        var have = (db.partCountsByCategory && db.partCountsByCategory[f.modelId]) || {};
        var others = resultCategories().filter(function (c) {
          return c.id !== f.catId && !c.comingSoon && have[c.id] > 0;
        });
        host.innerHTML = C.state({
          icon: 'alert', brand: true,
          title: 'No Compatibility Found',
          text: esc(m.fullName) + ' is in the database but has no ' +
            (cat ? esc(resultCatLabel(cat).toLowerCase()) + ' ' : '') + 'compatibility group' +
            ' yet. Nothing unrelated is shown in its place' +
            (others.length ? ' — it does have a group in these:' : '.'),
          action: '<div class="row wrap" style="gap:8px;justify-content:center">' +
            others.map(function (c) {
              return '<button class="btn btn--soft" data-act="pick-cat-rail" data-id="' + esc(c.id) + '">' +
                esc(resultCatLabel(c)) + '</button>';
            }).join('') +
            '<button class="btn btn--outline" data-act="clear-model">' + icon('grid') + 'Browse all groups</button></div>'
        });
        return;
      }

      var shown = rows.slice(0, f.matchShown);
      /* One category is always selected, so this is that category's group —
         one, by the one-group-per-category rule, and the rare exception still
         gets one each. Open: the master's header and its devices, with nothing
         to press first. */
      host.innerHTML = shown.map(function (row) { return matchCard(row, m); }).join('');

      /* "Show more" belongs in the column's own footer slot, the same one the
         library view uses, so the two views scroll and paginate identically. */
      if (lm) {
        lm.innerHTML = rows.length > shown.length
          ? '<button class="btn btn--outline" data-act="more-matches">' + icon('plus') +
            'Show ' + Math.min(6, rows.length - shown.length) + ' more ' +
            '<span class="muted">(' + (rows.length - shown.length) + ' hidden)</span></button>'
          : (rows.length > 6 ? '<span class="t-xs muted">All ' + rows.length + ' matches shown</span>' : '');
      }
    });
  }

  /* Every device in a group.

     ONE SOURCE NOW: row.devices, which is what /api/device-parts returned for
     THIS account. The local map it used to prefer — db.membersByGroup, the
     public bundle's fitment list inverted — is gone, because shipping it made
     every group's membership readable by anyone with the URL of a JSON file.

     Empty for a free account. The caller draws the paywall from
     row.requiresPlan rather than from the emptiness, so "withheld" and "we
     have none recorded" stay different sentences. */
  function groupDevices(row) {
    return row.devices || [];
  }

  /* The free preview of a row: the master, then the handful the server chose
     for it, resolved against the catalogue for photographs and specs. Never
     more than the server sent, and never the master twice. */
  function previewDevices(row) {
    var out = [], seen = Object.create(null);
    var add = function (m) { if (m && !seen[m.id]) { seen[m.id] = 1; out.push(m); } };
    add(row.master);
    (row.preview || []).forEach(add);
    return out;
  }

  /* "13 more devices — part of a plan", under a preview. The count is the
     group's own, which is public; the names are not in the page. */
  function lockRowHTML(n) {
    if (!(n > 0)) return '';
    return '<div class="lockrow">' +
      '<span class="lockrow__ico">' + icon('lock') + '</span>' +
      '<span class="lockrow__t"><b>' + nf(n) + ' more compatible device' + (n === 1 ? '' : 's') +
        '</b> — the full list is part of a plan.</span>' +
      '<button class="btn btn--primary btn--sm" data-act="go-plans">' + icon('crown') + 'See plans</button>' +
      '</div>';
  }

  /* The devices on a match card, in the chosen view.

       subscriber   every device in the group
       free         the preview, and a line saying how many more there are

     The free preview is exactly the names the server put in the response;
     nothing here can widen it, because nothing else was sent. */
  function matchListHTML(row, hitModel) {
    var view = listView(state.finder.resultView);
    var total = row.deviceCount || row.group.compatibleCount || 0;
    var opts = { view: view, masterId: row.master.id, hitId: hitModel && hitModel.id, act: 'open-model' };

    if (row.requiresPlan) {
      var preview = previewDevices(row);
      opts.brandsAbove = Infinity;
      return modelListHTML(preview, opts) + lockRowHTML(Math.max(0, total - preview.length));
    }
    var devices = groupDevices(row);
    if (!devices.length) {
      return '<p class="t-xs muted" style="margin:0">No devices are recorded in this group yet.</p>';
    }
    /* Brand headings earn their place on a long list and are noise on a short
       one: five devices under one heading is a heading saying what the five
       already say. */
    opts.brandsAbove = 12;
    return modelListHTML(devices, opts);
  }

  /* A change of view repaints the lists on the cards and nothing else — the
     header, the codes and the scroll position stay exactly where they were. */
  function repaintMatchLists() {
    var hit = db.modelById[state.finder.modelId];
    var rows = state.finder.matches || [];
    Array.prototype.forEach.call(document.querySelectorAll('[data-match-list]'), function (el) {
      var id = el.getAttribute('data-match-list');
      var row = rows.filter(function (r) { return r.group.groupId === id; })[0];
      if (!row) return;
      el.className = 'gdev__list glist--' + listView(state.finder.resultView);
      el.innerHTML = matchListHTML(row, hit);
    });
  }

  /* ONE GROUP, OPEN — a searched model's group in the selected category.

     The master's header, then its devices in the chosen view. The searched
     model is ticked in the list and named in the header when it is not the
     master; nothing else on the card repeats the header. */
  function matchCard(row, hitModel) {
    var total = row.deviceCount || groupDevices(row).length || row.group.compatibleCount || 0;
    /* Every row here came from asking which groups fit hitModel, so the part
       fits it whether or not this account may see the list. */
    return '<article class="gopen">' +
      masterHeadHTML(row, { back: 'clear-model', hit: hitModel }) +
      deviceBodyHTML(total, matchListHTML(row, hitModel), {
        act: 'result-view', view: state.finder.resultView,
        listAttr: ' data-match-list="' + esc(row.group.groupId) + '"'
      }) +
      '</article>';
  }

  /* ==========================================================================
     PAGE · MOBILE MODELS  (/models and /models/<brandId>)

     One page, with a brand selected or not. /models and /models/apple used to
     be two screens with their own search box and their own layout; now the URL
     only records which brand is selected. Choosing a brand repaints the toolbar
     and the list in place, so the brand rail keeps its scroll position and the
     search box keeps its text and its focus.

     Filters use native <select>. A custom dropdown would need its own keyboard
     handling, focus trap, touch targets and two themes' worth of styling, and
     would still be worse on a phone than the one the OS already ships.
     ========================================================================== */
  function renderModels(page, brandId) {
    var m = state.models;
    if (brandId && !db.brandById[brandId]) { redirect('/models'); return; }

    /* The URL names the query on arrival and on Back. A tap on a brand arrives
       here with no query in its link, and carries the box over to that brand. */
    var stayed = !!document.getElementById('mdlRoot');
    var urlQ = new URLSearchParams(location.search).get('q');
    if (urlQ !== null || !stayed) m.q = urlQ || '';
    m.brandId = brandId || null;

    if (!stayed) page.innerHTML = modelsPageHTML();
    syncBrandRail(!stayed);
    dropUnavailableFilters();
    paintModelTools();
    syncModelsUrl();
    loadModels(true);
  }

  function modelsPageHTML() {
    return '<div class="mdl" id="mdlRoot">' +
      brandRailHTML() +
      '<div class="shell">' +
        '<div class="mbar">' +
          '<div class="mbar__ctx">' +
            /* The page's H1, on every brand. The app mounts over the pre-rendered
               heading, so without one here the route has none at all. */
            '<h1 class="mbar__t" id="modelsTitle"></h1>' +
            '<span class="mbar__c" id="modelsCount" aria-live="polite"></span>' +
          '</div>' +
          '<label class="field mbar__q">' + icon('search') +
            '<input class="input" id="mdlq" type="search" enterkeyhint="search" autocomplete="off" />' +
            '<button type="button" class="mbar__x" id="mdlqClear" data-act="clear-model-search" ' +
            'aria-label="Clear search" hidden>' + icon('close') + '</button>' +
          '</label>' +
          '<div class="mbar__v" id="modelsView"></div>' +
          '<div class="mbar__f" id="modelsFilters"></div>' +
        '</div>' +
        '<div id="modelsList">' + C.skelRows(6) + '</div>' +
        '<div class="loadmore" id="modelsMore"></div>' +
      '</div></div>';
  }

  /* ------------------------------------------------------------- brand rail */
  function brandRailHTML() {
    var chev = function (dir, label, ic) {
      return '<button type="button" class="brail__go brail__go--' + (dir < 0 ? 'l' : 'r') + '" ' +
        'data-act="brand-scroll" data-dir="' + dir + '" aria-label="' + label + '">' + icon(ic) + '</button>';
    };
    /* Real links: a crawler follows them, a middle-click opens a new tab, and
       the router intercepts the ordinary click and stays on the page. */
    var brands = db.brands.filter(function (b) { return b.modelCount > 0; }).map(function (b) {
      return '<a class="brail__i" href="/models/' + esc(b.id) + '" data-brand="' + esc(b.id) + '">' +
        SM.brandLogo(b, 'blogo--rail') +
        '<span class="brail__n">' + esc(b.name) + '</span></a>';
    }).join('');

    return '<nav class="brail" aria-label="Brands"><div class="brail__w">' +
      chev(-1, 'Scroll brands left', 'chevronLeft') +
      '<div class="brail__s" id="brandRail">' +
        '<a class="brail__i" href="/models" data-brand="">' +
          '<span class="brail__all">' + icon('grid') + '</span>' +
          '<span class="brail__n">ALL</span></a>' +
        brands +
      '</div>' +
      chev(1, 'Scroll brands right', 'chevronRight') +
      '</div></nav>';
  }

  function syncBrandRail(first) {
    var rail = document.getElementById('brandRail');
    if (!rail) return;
    var id = state.models.brandId || '';
    var on = null;
    Array.prototype.forEach.call(rail.children, function (a) {
      var is = a.getAttribute('data-brand') === id;
      a.classList.toggle('is-on', is);
      if (is) { a.setAttribute('aria-current', 'page'); on = a; }
      else a.removeAttribute('aria-current');
    });
    if (!on) return;

    /* Only when it is out of view, and only the rail itself: scrollIntoView
       would also move the page. */
    var left = on.offsetLeft, right = left + on.offsetWidth;
    if (left >= rail.scrollLeft && right <= rail.scrollLeft + rail.clientWidth) return;
    var calm = first || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    rail.scrollTo({ left: left - (rail.clientWidth - on.offsetWidth) / 2, behavior: calm ? 'auto' : 'smooth' });
  }

  /* ---------------------------------------------------------------- toolbar */
  function paintModelTools() {
    var m = state.models;
    var b = m.brandId ? db.brandById[m.brandId] : null;
    var input = document.getElementById('mdlq');

    document.getElementById('modelsTitle').textContent = b ? b.name + ' Models' : 'All Mobile Models';
    input.placeholder = 'Search ' + (b ? b.name : 'all mobile') + ' models…';
    input.setAttribute('aria-label', b ? 'Search ' + b.name + ' models' : 'Search all mobile models');
    if (input.value !== m.q) input.value = m.q;
    document.getElementById('mdlqClear').hidden = !m.q;
    document.getElementById('modelsView').innerHTML = viewSwitchHTML(modelView());
    refreshModelFilters();
  }

  function refreshModelFilters() {
    var host = document.getElementById('modelsFilters');
    if (host) host.innerHTML = modelFiltersHTML(modelScope(state.models.brandId));
  }

  /* Keeps a search shareable and alive across a refresh. replaceState, so a
     word typed is not a Back press. */
  function syncModelsUrl() {
    if (state.route.name !== 'models') return;
    var q = state.models.q.trim();
    var url = toPath(state.route) + (q ? '?q=' + encodeURIComponent(q) : '');
    if (location.pathname + location.search !== url) history.replaceState(null, '', url);
  }

  /* ---------------------------------------------------------------- filters */
  var TYPE_LABELS = { phone: 'Phones', tablet: 'Tablets', watch: 'Watches' };
  var TYPE_ORDER = ['phone', 'tablet', 'watch'];
  var SIZE_BANDS = [
    ['0-5', 'Under 5"'], ['5-6.2', '5–6.2"'], ['6.2-6.7', '6.2–6.7"'], ['6.7-20', '6.7" and up']
  ];

  function inSizeBand(m, value) {
    if (m.displaySize == null) return false;
    var band = value.split('-').map(Number);
    return m.displaySize >= band[0] && m.displaySize < band[1];
  }

  /* What the models in view can actually answer. A choice that could only ever
     return an empty list is not offered: it reads as a broken filter. Cached per
     brand because it walks every model and the catalogue does not change while
     the page is open. */
  var modelScopes = Object.create(null);

  function modelScope(brandId) {
    var key = brandId || 'all';
    if (modelScopes[key]) return modelScopes[key];

    var items = brandId ? db.models.filter(function (x) { return x.brandId === brandId; }) : db.models;
    var types = {}, curves = {}, years = {}, hasBattery = false;
    items.forEach(function (x) {
      if (x.deviceType) types[x.deviceType] = 1;
      if (x.screenCurve) curves[x.screenCurve] = 1;
      if (x.releaseYear != null) years[x.releaseYear] = 1;
      if (x.specs && x.specs.batteryMah) hasBattery = true;
    });

    modelScopes[key] = {
      types: Object.keys(types).sort(function (a, b) {
        var x = TYPE_ORDER.indexOf(a), y = TYPE_ORDER.indexOf(b);
        return (x < 0 ? 99 : x) - (y < 0 ? 99 : y) || a.localeCompare(b);
      }),
      curves: Object.keys(curves),
      years: Object.keys(years).map(Number).sort(function (a, b) { return b - a; }),
      sizes: SIZE_BANDS.filter(function (s) {
        return items.some(function (x) { return inSizeBand(x, s[0]); });
      }).map(function (s) { return s[0]; }),
      hasBattery: hasBattery
    };
    return modelScopes[key];
  }

  /* A filter set on one brand may mean nothing on the next: Apple watches, then
     a brand that makes none. Left in place it would empty the list for no
     visible reason. */
  function dropUnavailableFilters() {
    var f = state.models.filters;
    var o = modelScope(state.models.brandId);
    if (f.deviceType && o.types.indexOf(f.deviceType) === -1) f.deviceType = '';
    if (f.curve && o.curves.indexOf(f.curve) === -1) f.curve = '';
    if (f.year && o.years.indexOf(Number(f.year)) === -1) f.year = '';
    if (f.size && o.sizes.indexOf(f.size) === -1) f.size = '';
    if (f.minBattery && !o.hasBattery) f.minBattery = '';
  }

  function filterModels(items, f) {
    return items.filter(function (m) {
      var sp = m.specs || {};
      if (f.curve && m.screenCurve !== f.curve) return false;
      if (f.deviceType && m.deviceType !== f.deviceType) return false;
      if (f.year && m.releaseYear !== Number(f.year)) return false;
      if (f.fiveG === '5g' && sp.network !== '5G') return false;
      if (f.fiveG === '4g' && sp.network === '5G') return false;
      if (f.minRam && Math.max.apply(null, sp.ramVariantsGb || [0]) < Number(f.minRam)) return false;
      if (f.minStorage && Math.max.apply(null, sp.storageVariantsGb || [0]) < Number(f.minStorage)) return false;
      if (f.minBattery && (sp.batteryMah || 0) < Number(f.minBattery)) return false;   /* the export carries mAh */
      if (f.size && !inSizeBand(m, f.size)) return false;
      return true;
    });
  }

  /* The date where the source has one, the year where it does not, and models
     with neither last in both directions: an unknown date is not an old one. */
  function releaseKey(m) { return m.releaseDateIso || (m.releaseYear ? m.releaseYear + '-00-00' : ''); }
  function byRelease(dir) {
    return function (a, b) {
      var x = releaseKey(a), y = releaseKey(b);
      if (x === y) return a.fullName.localeCompare(b.fullName);
      if (!x) return 1;
      if (!y) return -1;
      return x < y ? dir : -dir;
    };
  }

  /* Newest first, by year, and with the photographed models first inside each
     year. The 17 newest models in the export have no image at all, so a strict
     date order opens this catalogue on a screen of empty tiles. They are not
     hidden: they follow the other 2026 models, and search and filters reach
     them as before. */
  var newestDated = byRelease(1);
  function newestFirst(a, b) {
    var x = a.releaseYear || 0, y = b.releaseYear || 0;
    if (x !== y) return y - x;
    if (!a.image !== !b.image) return a.image ? -1 : 1;
    return newestDated(a, b);
  }

  var SORTS = {
    newest: newestFirst,
    oldest: byRelease(-1),
    name:   function (a, b) { return a.fullName.localeCompare(b.fullName); },
    size:   function (a, b) { return b.displaySize - a.displaySize; },
    groups: function (a, b) { return groupCountOf(b) - groupCountOf(a); }
  };

  function groupCountOf(m) { return (db.groupCountByModel && db.groupCountByModel[m.id]) || 0; }

  /* Does the loaded catalogue actually carry this field?
     The UI is built for a richer dataset than the current export provides, so
     rather than render empty controls and blank columns it asks first and
     leaves out what cannot be answered. One source of truth — the bundle says
     which fields it has — so a future import with real specs turns the
     filters, columns and spec cards back on without a code change. */
  function dbHas(field) {
    var cov = db.coverage;
    if (!cov) return true;                 /* sample data carries everything */
    return cov.absent.indexOf(field) === -1;
  }

  /* Named for the model page specifically: `activeFilterCount` already exists
     for the finder's brand panel, and a second declaration of it silently wins
     — the finder then called this one with no argument and threw on every
     render. */
  function activeModelFilterCount(f) {
    return Object.keys(f || {}).filter(function (k) { return f[k]; }).length;
  }

  function selectHTML(id, label, value, options) {
    /* The default sort is not a choice anyone made, so it does not light up. */
    var isSet = value && !(id === 'sort' && value === 'newest');
    return '<label class="fsel' + (isSet ? ' is-set' : '') + '">' +
      '<span class="fsel__l">' + esc(label) + '</span>' +
      '<select data-act="model-filter" data-key="' + id + '" aria-label="' + esc(label) + '">' +
      options.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (String(value) === String(o[0]) ? ' selected' : '') + '>' +
          esc(o[1]) + '</option>';
      }).join('') + '</select></label>';
  }

  function modelFiltersHTML(o) {
    var m = state.models;
    var f = m.filters;
    var n = activeModelFilterCount(f);
    var curveLabels = { flat: 'Flat (recorded)', curved: 'Curved (recorded)' };

    return '<div class="bctl">' +
      (o.types.length > 1 ? selectHTML('deviceType', 'Type', f.deviceType, [['', 'All types']].concat(
        o.types.map(function (t) { return [t, TYPE_LABELS[t] || t]; }))) : '') +
      /* The exports record a screen type for 260 of 4,933 devices, so this
         filter works — over what is RECORDED. "Flat only" showing 229 phones
         does not mean the brand made 229 flat phones, and the labels say so
         rather than letting the count imply it. */
      (dbHas('screenCurve') && o.curves.length ? selectHTML('curve', 'Screen', f.curve, [['', 'Any screen']].concat(
        o.curves.sort().reverse().map(function (c) { return [c, curveLabels[c] || c]; }))) : '') +
      (o.years.length > 1 ? selectHTML('year', 'Year', f.year, [['', 'Any year']].concat(
        o.years.map(function (y) { return [String(y), String(y)]; }))) : '') +
      (o.sizes.length > 1 ? selectHTML('size', 'Size', f.size, [['', 'Any size']].concat(
        SIZE_BANDS.filter(function (s) { return o.sizes.indexOf(s[0]) > -1; }))) : '') +
      (dbHas('network') ? selectHTML('fiveG', 'Network', f.fiveG, [
        ['', 'Any network'], ['5g', '5G only'], ['4g', '4G only']]) : '') +
      (dbHas('ram') ? selectHTML('minRam', 'RAM', f.minRam, [
        ['', 'Any RAM'], ['6', '6 GB+'], ['8', '8 GB+'], ['12', '12 GB+'], ['16', '16 GB']]) : '') +
      (dbHas('storage') ? selectHTML('minStorage', 'Storage', f.minStorage, [
        ['', 'Any storage'], ['128', '128 GB+'], ['256', '256 GB+'], ['512', '512 GB+']]) : '') +
      (o.hasBattery ? selectHTML('minBattery', 'Battery', f.minBattery, [
        ['', 'Any battery'], ['4500', '4500 mAh+'], ['5000', '5000 mAh+'], ['5500', '5500 mAh+']]) : '') +
      selectHTML('sort', 'Sort', m.sort, [
        ['newest', 'Newest first'], ['oldest', 'Oldest first'], ['name', 'Name A–Z'],
        ['size', 'Largest screen'], ['groups', 'Most parts']]) +
      (n ? '<button class="btn btn--ghost btn--sm bctl__clear" data-act="clear-model-filters">' +
        icon('close') + 'Clear ' + n + '</button>' : '') +
      '</div>';
  }

  /* ------------------------------------------------------------------ views */
  var VIEW_ICON = { grid: 'grid', list: 'list', table: 'layers' };

  /* Below 900px the table collapses into stacked rows, which is the list view
     under another name, so the phone gets two buttons rather than three that
     do two things. A table chosen on a desktop opens as a list here. */
  function modelView() {
    var v = state.models.view;
    return v === 'table' && !window.matchMedia('(min-width:900px)').matches ? 'list' : v;
  }

  function viewSwitchHTML(view) {
    return '<div class="vswitch" role="group" aria-label="Display style">' +
      ['grid', 'list', 'table'].map(function (v) {
        return '<button type="button" class="vswitch__b' + (view === v ? ' is-on' : '') + '" ' +
          'data-act="model-view" data-view="' + v + '" aria-pressed="' + (view === v) + '" ' +
          'title="' + v.charAt(0).toUpperCase() + v.slice(1) + ' view" ' +
          'aria-label="' + v + ' view">' + icon(VIEW_ICON[v]) + '</button>';
      }).join('') + '</div>';
  }

  /* The name a card prints: the brand is already selected on /models/apple, and
     "Y21" alone says nothing in the all-brands list. */
  function modelCardName(m) { return state.models.brandId ? m.modelName : m.fullName; }

  /* The catalogue photograph, or a plain "no image" tile for the 75 models
     without one. The drawn handset is kept for the model page: in a grid of
     real photographs a drawing reads as a picture of the wrong phone. */
  function modelPhoto(m, cls) {
    return SM.art.photo(m, {
      cls: cls,
      fallback: '<span class="dphoto__art mnone">' + icon('phone') + '<span>No image</span></span>'
    });
  }

  function modelFactsHTML(m, now) {
    var label = SM.dataset.releaseLabel(m);
    var isNew = SM.dataset.isNewRelease(m, now);
    return '<span class="mfacts">' +
        (m.displaySize ? '<span>' + esc(m.displaySize) + '&Prime;</span>' : '') +
        (isNew ? '<span class="mnew">NEW</span>' : '') +
      '</span>' +
      (label ? '<span class="mdate">Released: ' + esc(label) + '</span>' : '');
  }

  function modelTilesHTML(items, now) {
    return items.map(function (m) {
      /* A real href, not a button with a click handler. The delegated
         listener in the router intercepts it and navigates without a reload,
         so the behaviour is identical — but a crawler can follow it and a
         person can middle-click it. Every model page on this site was
         unreachable except through the sitemap because these were buttons. */
      return '<a class="mtile" href="/model/' + esc(m.id) + '">' +
        '<span class="mtile__shot">' + modelPhoto(m) + '</span>' +
        '<span class="mtile__b">' +
          '<span class="mname">' + esc(modelCardName(m)) + '</span>' +
          modelFactsHTML(m, now) +
        '</span></a>';
    }).join('');
  }

  function modelRowsHTML(items, now) {
    return items.map(function (m) {
      return '<a class="mrow" href="/model/' + esc(m.id) + '">' +
        '<span class="mrow__shot">' + modelPhoto(m) + '</span>' +
        '<span class="mrow__b">' +
          '<span class="mname">' + esc(modelCardName(m)) + '</span>' +
          modelFactsHTML(m, now) +
        '</span>' +
        '<span class="mrow__go">' + icon('chevronRight') + '</span>' +
      '</a>';
    }).join('');
  }

  /* Which columns survive at which width. Priority order is the order a
     repair decision actually needs them, so dropping from the right always
     drops the least useful column first. */
  var TABLE_COLS_ALL = [
    { k: 'device',  label: 'Device',     needs: null },
    { k: 'size',    label: 'Display',    needs: null },
    { k: 'curve',   label: 'Screen',     needs: 'screenCurve' },
    { k: 'year',    label: 'Released',   needs: null },
    { k: 'groups',  label: 'Parts',      needs: null },
    { k: 'chipset', label: 'Processor',  needs: 'chipset' },
    { k: 'battery', label: 'Battery',    needs: null },
    { k: 'ram',     label: 'RAM',        needs: 'ram' },
    { k: 'storage', label: 'Storage',    needs: 'storage' },
    { k: 'network', label: 'Network',    needs: 'network' },
    { k: 'camera',  label: 'Camera',     needs: 'cameras' },
    { k: 'res',     label: 'Resolution', needs: 'screenResolution' }
  ];
  /* A column the dataset cannot fill is not rendered at all. Showing twelve
     headings above nine columns of dashes tells a reader the data is broken
     rather than that it was never collected. */
  function tableCols() {
    return TABLE_COLS_ALL.filter(function (c) { return !c.needs || dbHas(c.needs); });
  }

  function modelTableRowsHTML(items) {
    return items.map(function (m) {
      var sp = m.specs || {};
      var gc = groupCountOf(m);
      var released = SM.dataset.releaseLabel(m);
      /* One hyphen for anything not recorded. Every column had its own idea of
         what an absent value looks like: an em-dash here, "undefined&Prime;"
         where displaySize was null, an empty tag element for screen curve, and
         a bare " GB" for RAM and storage the catalogue has never carried. */
      var dash = '<span class="c-none">-</span>';
      var cell = {
        device: '<a class="tcell-dev" href="/model/' + esc(m.id) + '">' +
                modelPhoto(m, 'dphoto--thumb') +
                '<span>' + esc(modelCardName(m)) + '</span></a>',
        size: m.displaySize ? esc(m.displaySize) + '&Prime;' : dash,
        curve: m.screenCurve
          ? '<span class="tag tag--' + esc(m.screenCurve) + '">' + esc(m.screenCurve) + '</span>'
          : dash,
        year: released ? esc(released) : dash,
        groups: gc ? String(gc) : dash,
        chipset: sp.chipset ? esc(sp.chipset) : dash,
        battery: sp.batteryMah ? nf(sp.batteryMah) + ' mAh' : dash,
        ram: (sp.ramVariantsGb || []).length ? esc(sp.ramVariantsGb.join('/')) + ' GB' : dash,
        storage: (sp.storageVariantsGb || []).length ? esc(sp.storageVariantsGb.join('/')) + ' GB' : dash,
        network: sp.network ? esc(sp.network) : dash,
        camera: (sp.cameraRear && sp.cameraRear[0]) ? esc(sp.cameraRear[0].mp) + ' MP' : dash,
        res: m.screenResolution ? esc(m.screenResolution) : dash
      };
      return '<tr data-act="open-model" data-id="' + esc(m.id) + '" tabindex="0">' +
        tableCols().map(function (c) {
          return '<td class="c-' + c.k + '" data-label="' + esc(c.label) + '">' + cell[c.k] + '</td>';
        }).join('') + '</tr>';
    }).join('');
  }

  /* The table renders every column; CSS hides the ones that do not fit, and
     below 900px the whole thing becomes stacked cards. Hiding in CSS rather
     than in JS means a resize needs no re-render. */
  function modelTableHTML(items) {
    var head = tableCols().map(function (c) {
      return '<th class="c-' + c.k + '">' + esc(c.label) + '</th>';
    }).join('');
    return '<div class="dtable-wrap"><table class="dtable">' +
      '<thead><tr>' + head + '</tr></thead><tbody>' + modelTableRowsHTML(items) + '</tbody></table></div>';
  }

  /* ------------------------------------------------------------------- list */
  function loadModels(reset) {
    var m = state.models;
    if (reset) m.page = 1;
    var shownBefore = reset ? 0 : m.items.length;
    var seq = ++m.seq;

    /* Filtering and sorting happen here rather than in the API seam because
       they are view state, not a query — the records are already in memory, and
       a round trip per dropdown change would be latency for nothing. When this
       moves to Firestore the seam takes over and this becomes the fallback
       path. */
    api.listModels({ brandId: m.brandId, q: m.q, page: 1, pageSize: 9999, instant: true }).then(function (r) {
      var host = document.getElementById('modelsList');
      var more = document.getElementById('modelsMore');
      if (!host || seq !== m.seq) return;     /* a newer keystroke or brand won */

      var all = filterModels(r.items, m.filters).sort(SORTS[m.sort] || SORTS.newest);
      var view = modelView();
      var pageSize = view === 'table' ? 60 : 24;
      var shown = all.slice(0, m.page * pageSize);
      var now = new Date();

      m.total = all.length;
      m.items = shown;
      m.hasMore = shown.length < all.length;
      m.busy = false;

      document.getElementById('modelsCount').textContent =
        nf(all.length) + ' model' + (all.length === 1 ? '' : 's');

      if (!shown.length) {
        var filtered = activeModelFilterCount(m.filters) > 0;
        host.innerHTML = C.state({
          icon: 'search',
          title: m.q ? 'No models match “' + m.q + '”' : 'No models match these filters',
          text: filtered ? 'Clear the filters to widen the list.'
                         : 'Try a shorter search — a series name or a number.',
          action: filtered ? '<button class="btn btn--outline btn--sm" data-act="clear-model-filters">' +
            icon('close') + 'Clear filters</button>' : ''
        });
        more.innerHTML = '';
        return;
      }

      /* "Show more" adds to the list. Rebuilding it would throw away every
         image already on screen and ask the browser to decode them again. */
      var fresh = shownBefore ? shown.slice(shownBefore) : shown;
      var list = shownBefore && host.querySelector('.mgrid, .mlist, .dtable tbody');
      if (list) {
        list.insertAdjacentHTML('beforeend', view === 'table' ? modelTableRowsHTML(fresh)
          : view === 'list' ? modelRowsHTML(fresh, now) : modelTilesHTML(fresh, now));
      } else {
        host.innerHTML = view === 'table' ? modelTableHTML(shown)
          : view === 'list' ? '<div class="mlist">' + modelRowsHTML(shown, now) + '</div>'
            : '<div class="mgrid">' + modelTilesHTML(shown, now) + '</div>';
      }

      more.innerHTML = m.hasMore
        ? '<button class="btn btn--outline" data-act="more-models">' + icon('plus') +
          'Show more (' + nf(all.length - shown.length) + ' left)</button>'
        : '<span class="t-xs muted">All ' + nf(all.length) + ' shown</span>';
    });
  }

  /* ==========================================================================
     PAGE · PLANS
     ========================================================================== */
  /* SAID FIRST, ABOVE THE PRICES: this account already has a plan.

     The Plans page is where a subscriber lands when something sends them
     there by mistake, and it used to greet them with two prices and two
     "Choose" buttons and not one word about the plan they were already on.
     A shop that had paid ₹799 that morning got as far as opening a second
     payment for ₹99 from this screen.

     Buying again is still allowed for Monthly and Yearly — it is how a plan
     is renewed, and the new period is added to the end of the current one —
     but nobody should do it without being told they do not have to. */
  function activePlanNoticeHTML(s) {
    if (s.status !== 'pro' || !s.subscription) return '';
    var sub = s.subscription;
    if (sub.lifetime) {
      return '<div class="notice notice--brand" style="margin-bottom:16px">' + icon('checkCircle') +
        '<span><b>You have lifetime access.</b> Every group and unlimited searches ' +
        'are already included, with no expiry. There is nothing to buy.</span></div>';
    }
    var p = planById(sub.plan);
    return '<div class="notice notice--brand" style="margin-bottom:16px">' + icon('checkCircle') +
      '<span><b>Your ' + esc(p ? p.name : '') + ' plan is active until ' + esc(sub.endLabel) +
      '.</b> You do not need to pay again. Choosing a plan below adds its period to ' +
      'the end of the one you already have.</span></div>';
  }

  function renderPlans(page) {
    var s = S.get();
    var lifetime = !!(s.status === 'pro' && s.subscription && s.subscription.lifetime);
    page.innerHTML =
      '<section class="bench" style="padding-bottom:30px"><div class="shell bench__in">' +
      '<span class="bench__eyebrow">' + icon('shop') + 'Built for mobile shops, not for offices</span>' +
      '<h1 class="t-hero" style="max-width:16ch">Stop guessing<br><em>what fits.</em></h1>' +
      '<p class="bench__sub">One plan for the whole counter. Look up a model, get the group, read the part code to your supplier — before the customer changes their mind.</p>' +
      '</div></section>' +

      '<div class="shell" style="margin-top:-18px;position:relative;z-index:2">' +
      planNoticeHTML() +
      (s.status === 'expired' ? '<div class="notice notice--amber" style="margin-bottom:16px">' + icon('alert') +
        '<span><b>Your plan has expired.</b> Renew to open compatibility groups ' +
        'and search without a limit again.</span></div>' : '') +
      activePlanNoticeHTML(s) +
      '<div class="plans">' + SM.PLANS.map(function (p) {
        return C.planCard(p, {
          current: s.status === 'pro' && s.plan === p.id,
          /* Lifetime already includes everything either plan sells. The cards
             stay as a description of what that is; the buttons do not offer to
             charge for it. */
          owned: lifetime
        });
      }).join('') + '</div>' +

      /* THIS TABLE MUST BE TRUE. It is the page people are asked to pay on,
         and every row of it is enforced somewhere in api/. When the catalogue
         was open it said "Free" down both columns and a notice underneath
         explained that nothing was locked; saying that now, over a paywall
         that does withhold the fitment list, would be the one page on the
         site that must never mislead doing exactly that.

         Each row below corresponds to a real check:
           searches        -> POST /api/access, metered in Firestore by uid
           opening a group -> GET /api/device-parts, members sliced by tier
           group search    -> access.groupFilter                            */
      '<div class="sec"><div class="sec__head"><div class="sec__title"><h2>What a plan changes</h2></div></div>' +
      '<div class="idgrid" style="grid-template-columns:repeat(1,minmax(0,1fr))">' +
      cmp('Browse all mobile models & specs', 'Free', 'Free') +
      cmp('Browse the group library — number, part code, master', 'Free', 'Free') +
      cmp('Model searches and opened groups', '5 in total', 'Unlimited') +
      cmp('Open a group and see the devices it fits', 'Within the 5', 'Every group') +
      cmp('Full compatible-device list', '—', 'Included') +
      cmp('Search and filter inside the group library', '—', 'Included') +
      '</div></div>' +

      '<div class="notice" style="margin:18px 0 8px">' + icon('info') +
      '<span><b>What the five free searches show you.</b> Every account gets ' +
      'five model searches, once — they do not reset. Each shows which ' +
      'compatibility groups the model belongs to, with the group number, part ' +
      'code and a few of the other handsets. Opening a group and its full list ' +
      'of compatible devices is what a plan unlocks, with unlimited ' +
      'searches.</span></div>' +
      '</div>';
  }
  /* Why this visitor was just sent here, said once, at the top. */
  function planNoticeHTML() {
    var n = state.planNotice;
    if (!n) return '';
    if (n.kind === 'search') {
      var m = n.modelId && db.modelById[n.modelId];
      return '<div class="notice notice--amber" style="margin-bottom:16px" role="status">' + icon('lock') +
        '<span><b>You have used your 5 free searches.</b> They are a one-time ' +
        'allowance for each account &mdash; a model searched and a group opened each use one &mdash; and do not reset. Choose a plan to keep searching' +
        (m ? ' &mdash; <b>' + esc(m.fullName) + '</b> stays in the search box, ready to run.' : '.') +
        '</span></div>';
    }
    return '<div class="notice notice--amber" style="margin-bottom:16px" role="status">' + icon('lock') +
      '<span><b>Opening a compatibility group needs an active plan.</b> Your free ' +
      'searches show which groups fit a phone; a plan opens every group and its ' +
      'full list of compatible devices.</span></div>';
  }

  function cmp(label, free, pro) {
    return '<div class="idcell" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">' +
      '<span style="flex:1;min-width:180px;font-weight:600;font-size:14px">' + esc(label) + '</span>' +
      '<span class="pill" style="min-width:118px;justify-content:center">' + esc(free) + '</span>' +
      '<span class="pill pill--brand" style="min-width:118px;justify-content:center">' + icon('crown') + esc(pro) + '</span>' +
      '</div>';
  }

  /* ==========================================================================
     PAGE · ACCOUNT
     ========================================================================== */
  /* ------------------------------------------------------- identity gate

     ONE promise that answers "do we know who this is yet?", covering both
     halves of the question: Firebase resolving its auth state, and the profile
     being read from Firestore. Screens wait on it instead of guessing.

     `identitySettled` is the synchronous form, for render paths that cannot
     await. It starts false and never goes back — once identity is known, it is
     known for the life of the page.

     Why both halves: an authenticated user whose profile has not loaded is
     still not a user the account screen can draw. Splitting them is how a
     screen ends up painting "signed out" during the gap. */
  var identityReady = null;
  var identitySettled = false;

  /* True from "Continue with Google" until Google answers, either way. While
     it is set and no Firebase user exists yet, the account screen shows
     "Signing in…" instead of the sign-in form. */
  var signingIn = false;

  /* Why the last resolution failed, when it failed in a way the reader has to
     be told about. Null on the happy path. Read by renderAccount so the screen
     that was stuck on a spinner now says what went wrong and offers a way out. */
  var identityFault = null;

  /* ------------------------------------------------- the gate always opens

     A ceiling on the whole question, not on any one step inside it.

     The infinite "Finishing sign-in…" was one unbounded await — a Firestore
     read against a project whose API was refusing, which the SDK retries for
     ever without ever rejecting. src/data/firestore.js now gives every read a
     deadline, so that specific hang is gone at its source.

     This is the second line, and it is here because the first one can only
     cover what it knows about. resolveIdentity awaits whatever the identity
     path happens to await today, and the next thing added to that path will
     not arrive with a timeout attached. So the gate itself expires: whatever
     is or is not pending underneath, the spinner comes down and the screen
     says something true.

     Generous on purpose. It is a backstop for a fault, not a performance
     budget, and cutting off a sign-in that was about to succeed would trade
     one bug for another.

     It has to clear the slowest legitimate path beneath it, or it fires first
     and the work underneath was time nobody gets back — in particular the
     profile read's three attempts, which cost 14.5s worst case (see
     RETRY_PLAN in src/data/firestore.js). A test asserts that budget stays
     under this number. The point of the headroom is that the SPECIFIC error
     wins: 'permission-denied' or 'unavailable' tells the owner what to fix,
     and a generic 'identity-timeout' does not. */
  var IDENTITY_DEADLINE_MS = 25000;

  function identityDeadline(promise) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        SM.debug.warn('boot', 'identity resolution timed out', { after: IDENTITY_DEADLINE_MS });
        identityFault = {
          code: 'identity-timeout',
          outage: true,
          message: 'the site did not finish checking the account'
        };
        resolve(null);
      }, IDENTITY_DEADLINE_MS);

      promise.then(function (v) {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(v);
      }, function () {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(null);
      });
    });
  }

  /* True while the app still cannot say whether anyone is signed in.

     There are two unknowns, not one, and both have to clear. Until the Firebase
     config has been fetched we do not even know whether sign-in EXISTS on this
     deployment — and `isConfigured()` answers false during that window, which
     reads exactly like "signed out". Checking `configState.checked` first is
     what stops a slow config endpoint painting the sign-in form at a user who
     has a perfectly good session. */
  function identityPending() {
    if (!SM.fb.configState.checked) return true;
    if (!SM.fb.isConfigured()) return false;      /* no sign-in here at all */
    return !identitySettled;
  }

  function resolveIdentity() {
    if (identityReady) return identityReady;
    identityFault = null;

    var work = SM.fb.loadConfig().then(function (cfg) {
      /* Firebase is genuinely unavailable — no config, no sign-in, nobody to
         resolve. Not an error: the catalogue works without it. */
      if (!cfg) {
        SM.debug.log('boot', 'firebase not configured — no identity to resolve');
        return null;
      }
      return SM.fb.whenResolved().then(function (fbUser) {
        SM.debug.log('boot', 'auth resolved', { signedIn: !!fbUser, uid: fbUser ? fbUser.uid : null });
        if (!fbUser) {
          /* Firebase is the authority, and it says nobody. A signed-in copy
             this browser still holds — a session that expired, or was ended on
             another tab — is dropped, so the account screen that may have been
             drawn from it repaints as signed out. Local only: nothing is asked
             of Firebase, so a slow network that merely timed out costs a
             repaint, never the real session. */
          if (S.get().signedIn && S.forgetLocal) {
            SM.debug.log('boot', 'no Firebase session — dropping the cached one');
            S.forgetLocal();
            forgetRole();
          }
          return null;
        }
        /* reuse: a reload inside a few minutes takes this tab's copy of the
           profile rather than reading users/{uid} again. A sign-in never finds
           one — sign-out drops it, and it is keyed to the account. */
        return S.initializeAuthenticatedUser(fbUser, { reuse: true });
      });
    }).catch(function (err) {
      SM.debug.warn('boot', 'identity resolution failed', { code: err && err.code, message: err && err.message });
      /* Remembered rather than swallowed. This used to return null and say
         nothing, so a signed-in user whose profile could not be read was
         indistinguishable from a visitor who had never signed in — and the
         account screen drew the sign-in form at someone who was, in fact,
         signed in. */
      identityFault = {
        code: (err && err.code) || 'identity-failed',
        outage: SM.isBackendOutage ? SM.isBackendOutage(err) : false,
        message: (err && err.message) || null
      };
      return null;
    });

    identityReady = identityDeadline(work).then(function (r) {
      /* The profile read came back and said it could not be read. That is not
         a new account and it is not a signed-out visitor; it is an outage, and
         the screen has to be able to say which. */
      if (r && r.offline && !identityFault) {
        identityFault = {
          code: r.reason || 'profile-unreadable',
          outage: !!r.outage,
          message: null
        };
      }
      /* Signed in, profile read, and it is missing or incomplete: this is a
         new shop, and the next screen is the one that finishes its account.
         Decided HERE, once, for every way into it — a fresh sign-in, a reload
         halfway through sign-up, a return from a Google redirect — so no path
         can land a signed-in user on the plain sign-in form instead. */
      if (r && !r.offline && !r.complete && SM.fb.user()) enterProfileCompletion(r);

      /* Set LAST and on every path, including the timeout. A gate that stays
         shut after the answer has come back is the bug it was built to
         prevent, pointed the other way. */
      identitySettled = true;
      return r;
    });

    return identityReady;
  }

  /* The account exists in Google and not yet as a shop: open the "finish
     setting up" form, filled with whatever the record already holds so a
     half-finished profile is not asked for twice. Nothing is invented — an
     absent field stays absent. */
  function enterProfileCompletion(r) {
    var u = SM.fb.user();
    if (!u) return;
    authMode = 'signup';
    state.pendingIdentity = {
      sub: u.uid,
      email: u.email || (r.profile && r.profile.email) || '',
      name: u.displayName || '',
      picture: u.photoURL || ''
    };
    var p = r.profile || {};
    reg.shopName = reg.shopName || p.mobileShopName || p.shopName || '';
    reg.proprietor = reg.proprietor || p.proprietorName || p.proprietor || '';
    reg.mobile = reg.mobile || p.mobileNumber || p.mobile || '';
    if (p.countryCode) reg.country = p.countryCode;
    SM.debug.log('identity', 'new or incomplete account — asking for the shop details', {
      has: { shop: !!reg.shopName, proprietor: !!reg.proprietor, mobile: !!reg.mobile }
    });
  }

  /* Throws the cached answer away and asks again — what the Try again button
     on the account screen runs. */
  function retryIdentity() {
    identityReady = null;
    identitySettled = false;
    identityFault = null;
    clearRoleState();
    if (state.route.name === 'account') renderAccount(document.getElementById('page'));
  }

  /* Shown while Firebase is still answering. It is deliberately NOT the
     sign-in form: 'still loading' and 'signed out' are different states, and
     painting the second while the first is true is what a returning user reads
     as "it sent me back to the login page". That is the whole mobile bug —
     most visible on the way back from Google, where the session arrives a
     moment after the page does. */
  function authPendingHTML(opts) {
    /* Three different waits, three different sentences. With a Firebase user
       in hand, Google has already said yes and all that is left is loading the
       shop. Before one, after "Continue with Google", the person is choosing an
       account. And with neither, the page is only finding out whether a
       session exists — saying "Signing in" to a visitor who never pressed
       anything would be false. */
    var u = SM.fb && SM.fb.user && SM.fb.user();
    var choosing = !u && opts && opts.signingIn;
    return '<div class="acct"><div class="card card--pad">' +
      '<div class="authwait" role="status" aria-live="polite">' + icon('refresh') +
      '<div class="grow" style="min-width:0">' +
      (u
        ? '<h2 class="t-h1">Signing in…</h2>' +
          '<p class="t-sub" style="margin-top:4px;overflow-wrap:anywhere">' +
            (u.email ? esc(u.email) + ' — loading your shop account.' : 'Loading your shop account.') +
          '</p>'
        : choosing
          ? '<h2 class="t-h1">Signing in…</h2>' +
            '<p class="t-sub" style="margin-top:4px">Choose your Google account in the ' +
            'window that opened. This page carries on by itself.</p>'
          : '<h2 class="t-h1">Checking sign-in…</h2>' +
            '<p class="t-sub" style="margin-top:4px">One moment.</p>') +
      '</div></div>' +
      /* The way back, for a chooser that was closed without the browser
         telling the page. It puts the form back; it cannot start a second
         sign-in, because SM.fb.signIn joins the attempt already open. */
      (choosing
        ? '<div style="margin-top:14px"><button class="btn btn--ghost btn--sm" ' +
          'data-act="cancel-signin" type="button">Cancel</button></div>'
        : '') +
      '</div></div>';
  }

  /* ------------------------------------------------- the spinner's way out

     WHAT WENT WRONG, AND WHAT TO DO ABOUT IT.

     The screen above is the one that hung. It had no terminal state at all:
     every path into it ended in a promise, and when a promise never settled
     there was nothing left that could repaint it. A user watched "Checking
     your Google account." until they gave up, with no error, no cause and
     nothing to press.

     So identity resolution now always ends somewhere, and when it ends badly
     it ends HERE — naming the fault and offering the retry. The two wordings
     are the same distinction the sign-up form already draws:

       outage   the database refused. Their phone is fine, retrying now will
                not help, and saying "check your connection" to someone whose
                connection is working is how people end up re-entering details
                into a form that could never have saved them.
       not      something local failed. Retrying is genuinely worth a try.

     Signing out stays available in both. Someone stuck on a broken account
     screen must always be able to leave it. */
  function authFailedHTML(fault) {
    var outage = !!(fault && fault.outage);
    var signedIn = !!(SM.fb && SM.fb.user && SM.fb.user());

    /* ------------------------------------------- REFUSED IS NOT UNREACHABLE

       'permission-denied' and 'deadline-exceeded' are both "the database did
       not give us the profile", and they need opposite responses.

         deadline-exceeded / unavailable   the backend did not answer in time.
                                           Transient. Already retried three
                                           times before reaching this screen,
                                           and pressing Try again is sensible.
         permission-denied                 the backend answered, and said no.
                                           The rules, or the project the rules
                                           belong to, are wrong. Retrying will
                                           be refused identically for ever, and
                                           telling somebody to "try again
                                           shortly" sends them to wait for a
                                           thing that will never happen on its
                                           own. It needs the owner.

       This matters most right after a Firebase project change, which is when a
       rules deployment is most likely to be missing — exactly the situation
       this site is in. */
    var refused = fault && (fault.code === 'permission-denied' ||
                            fault.code === 'unauthenticated');

    if (refused) {
      return '<div class="acct"><div class="card card--pad">' +
        '<h2 class="t-h1">' + esc(signedIn
          ? 'Signed in — but this account is not allowed to read its own profile'
          : 'The site refused the request') + '</h2>' +
        '<p class="t-sub" style="margin-top:6px">' + esc(
          'Google signed you in and the database answered — it refused. That is a ' +
          'permissions setting on our side, not anything about your account, and ' +
          'it will not clear by itself. Nothing you have entered has been lost.') +
        '</p>' +
        '<p class="t-sub" style="margin-top:8px">' + esc(
          'Searching and browsing the catalogue are unaffected.') + '</p>' +
        '<p class="t-sub" style="margin-top:10px;opacity:.7">Reference: ' +
          esc(String(fault.code)) + '</p>' +
        '<div class="row" style="gap:10px;margin-top:16px;flex-wrap:wrap">' +
          '<a class="btn btn--primary" href="/finder">Browse the catalogue</a>' +
          '<button class="btn btn--outline btn--sm" data-act="retry-identity" type="button">' +
            icon('refresh') + 'Try again</button>' +
          (signedIn
            ? '<button class="btn btn--ghost btn--sm" data-act="signout" type="button">' +
              icon('logout') + 'Sign out</button>'
            : '') +
        '</div>' +
        '</div></div>';
    }

    /* Four combinations, four sentences. Whether Google signed them in is a
       different fact from whether the database answered, and a message that
       blurs them is how someone ends up retrying the wrong thing — which is
       the failure mode this whole screen exists to end. */
    var title = signedIn
      ? (outage ? 'Signed in — but your account could not be loaded'
                : 'Your account could not be loaded')
      : (outage ? 'The site is not responding'
                : 'Sign-in could not be completed');

    var text = outage
      ? (signedIn
          ? 'Google signed you in successfully. The site’s own database is not ' +
            'responding, so your shop profile and subscription could not be read. ' +
            'This is a fault on our side, not with your connection or your Google ' +
            'account — nothing has been lost and nothing needs re-entering. ' +
            'Please try again shortly.'
          : 'The site’s database is not responding, so your account could not be ' +
            'checked. This is a fault on our side, not with your connection. ' +
            'Please try again shortly.')
      : (signedIn
          ? 'Your account details could not be read. Check the connection and ' +
            'try again — nothing has been lost, and nothing needs re-entering.'
          : 'Google sign-in could not be completed. Nothing was changed on your ' +
            'account. Please try again.');

    /* WHAT STILL WORKS, said plainly.

       The catalogue, the search and every device page are served from a CDN
       bundle and never touch Firestore — so a database outage costs the
       profile and the subscription, and nothing else. A screen that does not
       say so reads as "the site is down", and the reader has no way to know
       they could simply carry on. */
    var stillWorks = signedIn
      ? 'Searching and browsing the catalogue are unaffected — they do not use ' +
        'the database.'
      : '';

    /* The technical code, small and last. It is what turns "it did not work"
       into something the owner can act on without a screen recording, and it
       carries no credential — SM.isBackendOutage decides from exactly this. */
    var detail = fault && fault.code
      ? '<p class="t-sub" style="margin-top:10px;opacity:.7">Reference: ' + esc(String(fault.code)) + '</p>'
      : '';

    /* Try again retries the PROFILE READ, not the sign-in: resolveIdentity
       asks SM.fb.whenResolved(), which answers from the session already in
       hand. No popup, no account chooser, no second trip to Google. Saying so
       is worth a line — a button that might restart an OAuth flow is one
       people hesitate over. */
    return '<div class="acct"><div class="card card--pad">' +
      '<h2 class="t-h1">' + esc(title) + '</h2>' +
      '<p class="t-sub" style="margin-top:6px">' + esc(text) + '</p>' +
      (stillWorks ? '<p class="t-sub" style="margin-top:8px">' + esc(stillWorks) + '</p>' : '') +
      detail +
      '<div class="row" style="gap:10px;margin-top:16px;flex-wrap:wrap">' +
        '<button class="btn btn--primary" data-act="retry-identity" type="button">' +
          icon('refresh') + 'Try again</button>' +
        (signedIn
          ? '<a class="btn btn--outline" href="/finder">Browse the catalogue</a>'
          : '') +
        (signedIn
          ? '<button class="btn btn--ghost btn--sm" data-act="signout" type="button">' +
            icon('logout') + 'Sign out</button>'
          : '') +
      '</div>' +
      (signedIn
        ? '<p class="t-sub" style="margin-top:12px;opacity:.7">Try again re-reads your ' +
          'account. It will not ask you to sign in with Google a second time.</p>'
        : '') +
      '</div></div>';
  }

  /* ====================================================================== ROLE

     WHY THE ADMIN PANEL LINK KEPT VANISHING

     renderAccount used to wait for identity only when the LOCAL session said
     'guest'. For the owner it never does: mpf.session.v2 is in localStorage
     and says 'free' or 'pro' the instant the page parses. So the gate was
     skipped, the profile painted immediately from cache, and adminLinkHTML()
     asked SM.fb.isOwner() — which reads SM.fb.user(), which is null until
     Firebase has restored the session from IndexedDB. False. No link.

     Nothing repainted afterwards, because nothing in the app was subscribed to
     SM.fb.onChange at all. The Admin Panel link therefore appeared only when
     Firebase happened to win the race, which is why it came and went with no
     pattern the owner could describe.

     Two fixes, and they are both about ORDER rather than about the check
     itself. The gate below now waits for Firebase whatever the cached session
     says. And the role is resolved to a settled value before anything decides
     what to draw with it.

     WHERE THE ROLE COMES FROM

     The server, for anyone it might grant something to. api/_schema/roles.js
     owns the role table and /api/admin/session answers with the caller's role
     and permissions after verifying the Firebase ID token — that is the
     application's real role architecture and it stays the authority.

     The email compare in SM.fb.isOwner() is kept as a FILTER, not as the
     answer: it decides whether asking the server is worth a round trip. A
     visitor whose address is not the owner's cannot be granted admin by any
     reply, so they are 'user' immediately and no request is made. Only a
     candidate pays for the confirmation, and the confirmation is what actually
     decides. That preserves the property the original design cared about —
     ordinary visitors never wait on an admin lookup — while making the drawn
     UI reflect a server decision rather than a client guess. */
  var roleState = { uid: null, role: null, pending: null };

  function roleFor(uid) {
    if (!uid) return Promise.resolve('guest');
    if (roleState.uid === uid && roleState.role) return Promise.resolve(roleState.role);
    if (roleState.uid === uid && roleState.pending) return roleState.pending;

    /* A different account than the one we last resolved: drop everything about
       the old one before asking about this one. This is the line that stops a
       normal user inheriting the owner's Admin UI on a shared machine. */
    roleState = { uid: uid, role: null, pending: null };

    if (!SM.fb || !SM.fb.isOwner || !SM.fb.isOwner()) {
      roleState.role = 'user';
      return Promise.resolve('user');
    }

    /* Bounded, like every other call the account screen waits on. A role
       lookup is a link on a page — it is never worth holding a screen open
       for, and holding one open is exactly what it did. */
    roleState.pending = SM.billing && SM.billing.adminSession
      ? SM.billing.adminSession({ timeoutMs: 8000 }).then(function (res) {
          var role = (res && res.admin && res.admin.role) || 'user';
          if (roleState.uid === uid) { roleState.role = role; roleState.pending = null; }
          rememberRole(uid, role);
          SM.debug.log('identity', 'role resolved from server', { uid: uid, role: role });
          return role;
        }, function (err) {
          /* The server said no, or could not be reached. Either way this
             browser does not get to promote itself — 'user' is the safe answer
             and the only honest one. /admin re-checks regardless, so a wrong
             guess here costs a link, never access. */
          if (roleState.uid === uid) { roleState.role = 'user'; roleState.pending = null; }
          forgetRole();
          SM.debug.warn('identity', 'role lookup failed, treating as user', {
            uid: uid, status: err && err.status, message: err && err.message
          });
          return 'user';
        })
      : Promise.resolve('user').then(function (r) {
          if (roleState.uid === uid) { roleState.role = r; roleState.pending = null; }
          return r;
        });

    return roleState.pending;
  }

  /* ------------------------------------------------ the last answer, per uid

     The server's last role answer for an account, kept so a full page load can
     draw the owner's Admin Panel link on its first paint instead of a spinner.
     It decides a LINK and nothing else: /admin and every /api/admin/* route
     verify the ID token on each request, so an edited value buys a page that
     refuses you. Keyed by uid, so it can never describe a different account,
     re-verified on every load, and dropped on sign-out. */
  var ROLE_KEY = 'mpf.role.v1';
  function rememberRole(uid, role) {
    try { localStorage.setItem(ROLE_KEY, JSON.stringify({ uid: uid, role: role })); } catch (e) { /* private mode */ }
  }
  function forgetRole() {
    try { localStorage.removeItem(ROLE_KEY); } catch (e) { /* private mode */ }
  }
  function cachedRole(uid) {
    if (!uid) return null;
    try {
      var c = JSON.parse(localStorage.getItem(ROLE_KEY) || 'null');
      return c && c.uid === uid && typeof c.role === 'string' ? c.role : null;
    } catch (e) { return null; }
  }

  /** The settled role, or null while it is still being decided. */
  function currentRole() {
    var u = SM.fb && SM.fb.user && SM.fb.user();
    if (!u) {
      /* Firebase is still restoring the session. The account screen may be
         drawing this browser's cached copy of it meanwhile, and the cached
         role for that same account is what goes with it. */
      if (SM.fb && SM.fb.phase && SM.fb.phase() === 'loading') {
        var s = S.get();
        return s.signedIn ? cachedRole(s.sub) : null;
      }
      return 'guest';
    }
    if (roleState.uid === u.uid && roleState.role) return roleState.role;
    return cachedRole(u.uid);
  }

  function isAdminRole(role) {
    return role === 'owner' || role === 'super_admin' || role === 'admin';
  }

  /* Signing out, or signing in as somebody else, must leave nothing of the
     previous account behind. */
  function clearRoleState() { roleState = { uid: null, role: null, pending: null }; }

  /* The three details that make a shop a shop. A cached profile missing any
     of them is not drawn early: that account belongs on the completion form,
     and only the resolved profile can say so. */
  function cachedProfileComplete(s) {
    return !!(s && s.shopName && s.proprietor && s.mobile);
  }

  function renderAccount(page) {
    var s = S.get();
    var fbUser = SM.fb && SM.fb.user && SM.fb.user();
    var again = function () {
      /* Only if the user is still looking at this screen. */
      if (state.route.name === 'account') renderAccount(document.getElementById('page'));
    };

    /* "Continue with Google" has been pressed and Google has not answered yet
       — the account chooser is open, or it has closed and the SDK is
       exchanging the credential, which takes a second or two on a phone.

       This used to leave the sign-in form on screen with its button greyed
       out, so a shop that had just picked its Gmail was looking at "Sign in to
       Mobile Parts Finder" again and read it as being sent back. Nothing about
       that moment is signed out; it is signing in, and the card says so. */
    if (signingIn && !fbUser) {
      page.innerHTML = '<div class="shell" style="padding-top:20px">' +
        authPendingHTML({ signingIn: true }) + '</div>';
      return;
    }

    /* Nothing is DECIDED while identity is unresolved. resolveIdentity() covers
       both halves — Firebase answering, and the profile being read.

       But a returning shop does not have to look at a spinner while that
       happens. The app is a set of pages, so opening Account from the home page
       or a model page is a full page load, and it used to show "Checking
       sign-in…" every single time. When this browser holds a completed
       profile for an account, and Firebase has not said otherwise, that profile
       is drawn at once and resolution carries on underneath; whatever it
       decides repaints the screen.

       What keeps that safe:
         · only while Firebase is still restoring (no user yet), or has
           restored the SAME uid — a different account never sees this one's
           copy, not even for a frame
         · the admin link comes from the cached role for this uid only, and
           /admin re-verifies the token regardless
         · if Firebase says nobody is signed in, resolveIdentity drops the
           local copy and the screen repaints as signed out
         · paid access is never decided here; the server decides it per
           request */
    if (identityPending()) {
      var restoring = !fbUser && SM.fb && SM.fb.phase && SM.fb.phase() === 'loading';
      var sameAccount = fbUser && fbUser.uid === s.sub;
      if ((restoring || sameAccount) && s.signedIn && s.status !== 'guest' && cachedProfileComplete(s)) {
        SM.debug.log('identity', 'drawing the cached account while it is verified', { uid: s.sub });
        page.innerHTML = '<div class="shell" style="padding-top:20px">' + profileHTML(s) + '</div>';
      } else {
        page.innerHTML = '<div class="shell" style="padding-top:20px">' + authPendingHTML() + '</div>';
      }
      resolveIdentity().then(again);
      return;
    }

    /* Identity is settled and it settled badly. Draw the fault, not the
       sign-in form.

       Drawing the sign-in form here was the second half of the reported bug.
       A failed profile read used to resolve to null, which is the same value a
       genuine visitor produces, so the screen offered "Continue with Google"
       to somebody Google had already signed in — and pressing it signed them
       in again, read the profile again, failed again. */
    if (identityFault && (fbUser || identityFault.outage)) {
      page.innerHTML = '<div class="shell" style="padding-top:20px">' +
        authFailedHTML(identityFault) + '</div>';
      return;
    }

    /* Authenticated, profile in hand, role not yet confirmed by the server.

       For everyone who is not the owner, roleFor answers 'user' on the spot
       and nothing waits. For the owner it asks /api/admin/session. If the
       server's last answer for this uid is cached, the screen is drawn with it
       now and redrawn only if the server disagrees; if not, the screen waits
       rather than drawing a normal-user page that becomes an admin one a
       moment later. That wait is bounded, and settles to 'user' on any
       failure, which costs a link and never access — /admin re-checks the
       token on every request regardless. */
    if (fbUser && !(roleState.uid === fbUser.uid && roleState.role)) {
      var asked = roleFor(fbUser.uid);
      if (currentRole() === null) {
        page.innerHTML = '<div class="shell" style="padding-top:20px">' + authPendingHTML() + '</div>';
        asked.then(again);
        return;
      }
      if (!(roleState.uid === fbUser.uid && roleState.role)) {
        var drawnWith = currentRole();
        asked.then(function (role) { if (role !== drawnWith) again(); });
      }
    }

    /* THE RULE THE WHOLE SCREEN EXISTS TO KEEP: somebody Google has signed in
       is never shown the signed-out form.

       The legitimate signed-in-but-no-shop state is a new account, and that
       has already been routed to the "finish setting up" form by
       enterProfileCompletion — state.pendingIdentity says so. Anything else
       that reaches here signed in and without a session is a state the app
       could not load, and it gets the screen that says so, with Try again and
       Sign out, rather than a "Continue with Google" that would start a second
       sign-in over the first. */
    if (fbUser && s.status === 'guest' && !state.pendingIdentity) {
      SM.debug.warn('identity', 'signed in with no loadable session', { uid: fbUser.uid });
      page.innerHTML = '<div class="shell" style="padding-top:20px">' +
        authFailedHTML({ code: 'session-unavailable', outage: false }) + '</div>';
      return;
    }

    page.innerHTML = '<div class="shell" style="padding-top:20px">' +
      (s.status === 'guest' ? authHTML() : profileHTML(s)) +
      '</div>';
  }

  /* ------------------------------------------------- registration form state */
  var reg = {
    country: 'IN', mobile: '', shopName: '', proprietor: '',
    flat: '', area: '', city: '', district: '', stateName: '',
    addrOpen: false,          /* the address section starts collapsed */
    touched: {}
  };
  /* --------------------------------------------- the draft survives Google

     WHAT THIS PROTECTS AGAINST. `reg` is module state, and module state does
     not survive a navigation. Sign-in opens a popup on almost every device, so
     usually there is no navigation to survive — but when a popup cannot open
     (blocked, or a browser that does not support one) SM.fb.signIn falls back
     to signInWithRedirect, which sends the whole page to Google and reloads it
     on the way back. Everything the shop typed was gone at that point, and
     what they came back to was an empty form and the message "That Google
     account has no shop profile yet. Fill in your shop details below" — asking
     them to type it all again, having just proved they were who they said.

     The same draft also survives an accidental reload, a back button, and the
     tab being restored from the background on a phone with little memory.

     sessionStorage, not localStorage: a draft belongs to the tab that is
     filling it in. A shop name left behind on a counter machine must not greet
     the next person who opens the site on it. It is cleared the moment the
     account exists, and `touched` is deliberately NOT stored — validation
     errors are a state of the current attempt, not of the draft. */
  var REG_DRAFT_KEY = 'mpf.reg.draft.v1';
  var REG_DRAFT_FIELDS = ['country', 'mobile', 'shopName', 'proprietor',
                          'flat', 'area', 'city', 'district', 'stateName', 'addrOpen'];

  function saveRegDraft() {
    try {
      var out = {};
      REG_DRAFT_FIELDS.forEach(function (k) { out[k] = reg[k]; });
      sessionStorage.setItem(REG_DRAFT_KEY, JSON.stringify(out));
    } catch (e) { /* private mode — the draft is a nicety, never a blocker */ }
  }

  function restoreRegDraft() {
    try {
      var raw = sessionStorage.getItem(REG_DRAFT_KEY);
      if (!raw) return false;
      var d = JSON.parse(raw);
      if (!d || typeof d !== 'object') return false;
      var any = false;
      REG_DRAFT_FIELDS.forEach(function (k) {
        if (typeof d[k] === 'string' && d[k]) { reg[k] = d[k]; any = true; }
        if (k === 'addrOpen' && d[k] === true) reg.addrOpen = true;
      });
      if (any) SM.debug.log('signup', 'restored the shop details draft');
      return any;
    } catch (e) { return false; }
  }

  function clearRegDraft() {
    try { sessionStorage.removeItem(REG_DRAFT_KEY); } catch (e) { /* private mode */ }
  }

  /* mandatory only — the address is optional and must never block sign-up */
  var REG_FIELDS = [
    { k: 'mobile', label: 'Mobile number' },
    { k: 'shopName', label: 'Shop name' },
    { k: 'proprietor', label: 'Proprietor name' }
  ];
  var ADDRESS_FIELDS = ['flat', 'area', 'city', 'district', 'stateName'];

  /* The ONLY four things a shop must give us. Everything else — every address
     field — is optional and must never hold up an account.

     The rules used to be stricter than reality. "Too short" rejected a shop
     called X, and the proprietor field demanded two words, so Kishore could not
     sign up while Kishore Raj could. Neither rule described anything true about
     names or shop names; they just described what the author happened to type
     while testing. A name is whatever the person says it is. */
  function regError(k) {
    if (ADDRESS_FIELDS.indexOf(k) > -1) return '';   /* optional, always */
    var v = String(reg[k] || '').trim();

    if (k === 'mobile') {
      if (!v) return 'Enter your mobile number';
      /* Country-aware. The old check ignored the country entirely, so it had
         one opinion for the whole world and it was India's. */
      if (!SM.countries.validNumber(reg.country, v)) {
        var c = SM.countries.byCode(reg.country);
        return c ? 'Enter a valid ' + c.name + ' mobile number' : 'Enter a valid mobile number';
      }
      return '';
    }

    /* One meaningful character is enough. */
    if (!v) return 'Required';
    return '';
  }
  function regValid() {
    return !!reg.country && REG_FIELDS.every(function (f) { return !regError(f.k); });
  }
  function field(k, label, opts) {
    opts = opts || {};
    var err = reg.touched[k] ? regError(k) : '';
    return '<div class="ffield' + (err ? ' has-error' : '') + '"' + (opts.style ? ' style="' + opts.style + '"' : '') + '>' +
      '<label class="t-lab" for="reg_' + k + '">' + esc(label) + '</label>' +
      '<input class="input" id="reg_' + k + '" data-reg="' + k + '" ' +
      'type="' + (opts.type || 'text') + '" inputmode="' + (opts.inputmode || 'text') + '" ' +
      'placeholder="' + esc(opts.ph || '') + '" value="' + esc(reg[k]) + '" autocomplete="off" />' +
      (err ? '<span class="ffield__err">' + esc(err) + '</span>' : '') +
      '</div>';
  }

  function googleBtn(labelText, act, disabled) {
    return '<button class="gbtn' + (disabled ? ' is-disabled' : '') + '" data-act="' + act + '"' +
      (disabled ? ' disabled aria-disabled="true"' : '') + ' type="button">' +
      '<span class="gbtn__g" aria-hidden="true">' +
      '<svg viewBox="0 0 48 48" width="20" height="20">' +
      '<path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.6 9.5 24 9.5Z"/>' +
      '<path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.750 7-17.6Z"/>' +
      '<path fill="#FBBC05" d="M10.4 28.7a14.6 14.6 0 0 1 0-9.4l-7.8-6.1a24 24 0 0 0 0 21.6l7.8-6.1Z"/>' +
      '<path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.4 0-11.7-3.7-13.6-9.1l-7.8 6.1C6.5 42.6 14.6 48 24 48Z"/>' +
      '</svg></span>' +
      '<span>' + esc(labelText) + '</span></button>';
  }

  function authHTML() {
    /* Already through Google and only missing the shop details: the one
       screen is the completion form. The Sign in / Create account tabs are for
       somebody who has not signed in yet — offering "Sign in" here would put a
       second Google sign-in one tap away from someone who has just done one.
       The only other way out is to use a different account, which is a sign
       out, and is offered as exactly that. */
    var completing = !!state.pendingIdentity;
    var signup = completing || authMode === 'signup';
    return '<div class="acct">' +
      '<div class="card card--pad">' +
      (completing
        ? ''
        : '<div class="segmented" style="margin-bottom:18px">' +
          '<button class="' + (signup ? '' : 'is-on') + '" data-act="auth-tab" data-id="signin">Sign in</button>' +
          '<button class="' + (signup ? 'is-on' : '') + '" data-act="auth-tab" data-id="signup">Create account</button>' +
          '</div>') +
      (signup ? signupHTML() : signinHTML()) +
      (completing
        ? '<div style="margin-top:12px">' +
          '<button class="btn btn--ghost btn--sm" data-act="signout" type="button">' +
          icon('logout') + 'Use a different Google account</button></div>'
        : '') +
      '</div>' +

      '<div class="card card--pad">' +
      '<span class="t-lab">Why shops sign in</span>' +
      '<ul class="plan__feats" style="margin-top:12px">' +
      ['Keep your plan on every device at the counter', 'Your searches stay on your account', 'Staff logins and part-code export are next on the roadmap']
        .map(function (t) { return '<li>' + icon('checkCircle') + '<span>' + esc(t) + '</span></li>'; }).join('') +
      '</ul>' +
      '</div></div>';
  }

  function signinHTML() {
    return '<h2 class="t-h1">Sign in to Mobile Parts Finder</h2>' +
      '<p class="t-sub" style="margin-top:6px">Use the Google account already on this device. ' +
      'No password to type or remember.</p>' +
      '<div style="margin-top:18px">' + googleBtn('Continue with Google', 'google-signin', false) + '</div>' +
      '<div id="authMsg"></div>' +
      '<p class="t-xs muted" style="margin-top:14px">Your plan is tied to your Google account, so it follows you to every device at the counter.</p>';
  }

  function signupHTML() {
    var c = SM.countries.byCode(reg.country);
    var ready = regValid();
    var missing = REG_FIELDS.filter(function (f) { return regError(f.k); });
    /* Set once Google has already answered. From here the account is decided;
       all that is missing is the shop's own details. */
    var acct = state.pendingIdentity;

    return (acct
      ? '<h2 class="t-h1">Finish setting up your shop</h2>' +
        '<p class="t-sub" style="margin-top:6px">Signed in as the account below. ' +
        'Three details and you are done.</p>' +
        /* The Gmail is shown, not asked for — the user has already chosen it,
           and asking again is the step this screen exists to remove. */
        '<div class="gacct">' +
          '<span class="gacct__av">' +
            (acct.picture
              ? '<img src="' + esc(acct.picture) + '" alt="" referrerpolicy="no-referrer" />'
              : esc(initials(acct.name || acct.email))) +
          '</span>' +
          '<span class="gacct__b">' +
            '<span class="gacct__l">Google account</span>' +
            '<span class="gacct__e">' + esc(acct.email) + '</span>' +
          '</span>' +
          icon('checkCircle') +
        '</div>'
      : '<h2 class="t-h1">Create your Mobile Parts Finder account</h2>' +
        '<p class="t-sub" style="margin-top:6px">Tell us about your shop, then finish with your Google account.</p>') +

      '<div class="regform">' +
      /* country + mobile share one row */
      '<div class="ffield ffield--row' + (reg.touched.mobile && regError('mobile') ? ' has-error' : '') + '">' +
      '<label class="t-lab">Country &amp; mobile number</label>' +
      '<div class="phonerow">' +
      '<button type="button" class="ccpick" data-act="open-country">' +
      '<span class="ccpick__flag">' + (c ? c.flag : '🌐') + '</span>' +
      '<span class="ccpick__name">' + esc(c ? c.name : 'Select') + '</span>' +
      '<span class="ccpick__dial">' + esc(c ? c.dial : '') + '</span>' +
      icon('chevronDown') + '</button>' +
      '<input class="input" id="reg_mobile" data-reg="mobile" type="tel" inputmode="tel" ' +
      'placeholder="98765 43210" value="' + esc(reg.mobile) + '" autocomplete="off" aria-label="Mobile number" />' +
      '</div>' +
      (reg.touched.mobile && regError('mobile') ? '<span class="ffield__err">' + esc(regError('mobile')) + '</span>' : '') +
      '</div>' +

      field('shopName', 'Shop name', { ph: 'Sharma Mobile Care' }) +
      field('proprietor', 'Proprietor name', { ph: 'Rajesh Sharma' }) +

      /* Collapsed, because it is optional and five always-visible fields read
         as five more things that must be filled in. Nothing inside it can ever
         block the button below. */
      '<div class="addrfold' + (reg.addrOpen ? ' is-open' : '') + '">' +
      '<button type="button" class="addrfold__t" data-act="toggle-address" ' +
      'aria-expanded="' + (reg.addrOpen ? 'true' : 'false') + '">' +
      icon(reg.addrOpen ? 'chevronDown' : 'plus') +
      '<span class="grow">Add shop address</span>' +
      '<span class="t-xs muted">Optional</span></button>' +
      (reg.addrOpen
        ? '<div class="addrfold__b">' +
          '<p class="t-xs muted" style="margin:0 0 10px">Used on invoices and for delivery. ' +
          'You can add it later from your account.</p>' +
          field('flat', 'Flat / building number', { ph: '12B, Ganesh Complex' }) +
          field('area', 'Area / colony', { ph: 'Gandhi Nagar' }) +
          '<div class="ffield--pair">' + field('city', 'City', { ph: 'Coimbatore' }) +
          field('district', 'District', { ph: 'Coimbatore' }) + '</div>' +
          field('stateName', 'State', { ph: 'Tamil Nadu' }) +
          '</div>'
        : '') +
      '</div>' +
      '</div>' +

      '<div id="authMsg"></div>' +
      '<p class="t-xs muted" id="regHint" style="margin-top:12px">' + regHintHTML() + '</p>' +

      /* Sticky, so it is reachable without scrolling to the end of a form the
         user may never open the bottom half of. It sits inside the card and
         above the mobile tab bar, and the form keeps its own scroll. */
      '<div class="regcta">' +
        (acct
          /* Already authenticated — this saves the profile. Showing another
             "Continue with Google" here would send the user through the
             account chooser a second time for no reason. */
          /* "Continue", not "Continue as <email>". The address is already on
             the Google account card above, and a long one — any real Gmail —
             made this button wider than a phone, which dragged the whole page
             sideways. */
          ? '<button class="btn btn--primary btn--lg btn--block" data-act="finish-signup"' +
            (ready ? '' : ' disabled') + '>' + icon('check') + 'Continue</button>'
          : googleBtn('Continue with Google', 'google-signup', !ready)) +
      '</div>';
  }

  /* Enables or disables whichever submit button the form is currently showing.

     THIS IS THE BUG the sign-up form was stuck on. The input handler only ever
     looked for `.gbtn` — the "Continue with Google" button — and updated that.
     But once Google has already answered, the form renders a plain primary
     button reading "Continue as <email>" instead, which carries no such class.
     querySelector returned null, nothing was updated, and the `disabled`
     attribute set during the initial render stayed set for ever: every field
     filled, the hint underneath reading "All details complete", and the button
     still dead.

     Asking for the button inside .regcta finds it whichever of the two it is. */
  function syncRegCta() {
    var host = document.querySelector('.regcta');
    if (!host) return;
    var btn = host.querySelector('button');
    if (!btn) return;

    var ok = regValid();
    btn.disabled = !ok;
    btn.setAttribute('aria-disabled', String(!ok));
    /* .gbtn shows its disabled state through a class rather than the attribute. */
    btn.classList.toggle('is-disabled', !ok && btn.classList.contains('gbtn'));
  }

  function regHintHTML() {
    var missing = REG_FIELDS.filter(function (f) { return regError(f.k); });
    if (!missing.length) {
      /* Someone already signed in has no Google account left to pick. */
      return icon('checkCircle') + (state.pendingIdentity
        ? ' All details complete — press Continue to finish.'
        : ' All details complete — pick your Google account to finish.');
    }
    return 'Complete ' + missing.length + ' more ' + (missing.length === 1 ? 'field' : 'fields') +
      ' to continue: ' + esc(missing.map(function (f) { return f.label; }).join(', '));
  }

  function repaintAuth() {
    var page = document.getElementById('page');
    if (state.route.name === 'account' && S.get().status === 'guest') renderAccount(page);
  }

  /* The per-country phone rules arrive after the form has already been drawn,
     and they are stricter than the fallback that was in force while it loaded.
     Re-check once, so a number accepted by the placeholder rule is not left
     looking valid when the real rule disagrees. */
  SM.countries.onValidatorReady(function () {
    if (state.route.name !== 'account') return;
    syncRegCta();
    var hint = document.getElementById('regHint');
    if (hint) hint.innerHTML = regHintHTML();
  });

  /* ----------------------------------------------------- profile editing -- */
  var edit = {};

  /* Fills the edit form from the profile that is actually stored.

     It has to be called before the sheet is opened, from EVERY path that opens
     it. The payment path did not: it set state.sheet and rendered, leaving
     `edit` holding whatever it last held — an empty object on a fresh page
     load. So a shop sent to "just confirm your details before paying" was shown
     a completely blank form, and saving it would have written those blanks over
     a perfectly good Firestore profile. */
  function seedEditForm() {
    var ps = S.get().profile || {};
    var addr = ps.address || {};
    edit = {
      shopName: ps.shopName || ps.mobileShopName || '',
      proprietor: ps.proprietor || ps.proprietorName || '',
      country: ps.country || ps.countryCode || 'IN',
      mobile: ps.mobile || ps.mobileNumber || '',
      flat: addr.flat || '', area: addr.area || '',
      city: addr.city || '', district: addr.district || '',
      stateName: addr.state || '',
      photo: ps.photo || ps.profilePhotoURL || '',
      photoURL: ps.profilePhotoURL || '',
      photoPath: ps.profilePhotoPath || null,
      location: ps.location || null
    };
    return edit;
  }

  function editSheetHTML() {
    var c = SM.countries.byCode(edit.country);
    var loc = edit.location;
    return '<div class="editform">' +

      /* photo */
      '<div class="phrow">' +
      (edit.photo
        ? '<span class="avatar avatar--lg avatar--img"><img src="' + esc(edit.photo) + '" alt="" /></span>'
        : '<span class="avatar avatar--lg">' + esc(initials(edit.shopName || 'Shop')) + '</span>') +
      '<div class="grow">' +
      '<span class="t-lab">Shop photo</span>' +
      '<div class="row wrap" style="gap:8px;margin-top:6px">' +
      '<label class="btn btn--outline btn--sm" style="cursor:pointer">' + icon('plus') +
      (edit.photo ? 'Replace' : 'Upload') +
      '<input type="file" id="photoInput" accept="image/*" style="display:none" /></label>' +
      (edit.photo ? '<button class="btn btn--ghost btn--sm" data-act="clear-photo">' + icon('close') + 'Remove</button>' : '') +
      '</div>' +
      '<p class="t-xs muted" style="margin-top:6px">Uploaded to your account, so it follows you to every device.</p>' +
      '</div></div>' +

      '<div class="ffield"><label class="t-lab" for="ed_shopName">Shop name</label>' +
      '<input class="input" id="ed_shopName" data-edit="shopName" value="' + esc(edit.shopName) + '" /></div>' +
      '<div class="ffield"><label class="t-lab" for="ed_proprietor">Proprietor name</label>' +
      '<input class="input" id="ed_proprietor" data-edit="proprietor" value="' + esc(edit.proprietor) + '" /></div>' +

      '<div class="ffield"><label class="t-lab">Country &amp; mobile number</label>' +
      '<div class="phonerow">' +
      '<button type="button" class="ccpick" data-act="pick-edit-country">' +
      '<span class="ccpick__flag">' + (c ? c.flag : '🌐') + '</span>' +
      '<span class="ccpick__name">' + esc(c ? c.name : 'Select') + '</span>' +
      '<span class="ccpick__dial">' + esc(c ? c.dial : '') + '</span>' + icon('chevronDown') + '</button>' +
      '<input class="input" data-edit="mobile" type="tel" inputmode="tel" value="' + esc(edit.mobile) + '" aria-label="Mobile number" />' +
      '</div></div>' +

      '<div class="regform__sub"><span class="t-lab">Shop address</span>' +
      '<span class="t-xs muted">optional</span></div>' +
      '<div class="ffield"><label class="t-lab" for="ed_flat">Flat / building number</label>' +
      '<input class="input" id="ed_flat" data-edit="flat" value="' + esc(edit.flat) + '" /></div>' +
      '<div class="ffield"><label class="t-lab" for="ed_area">Area / colony</label>' +
      '<input class="input" id="ed_area" data-edit="area" value="' + esc(edit.area) + '" /></div>' +
      '<div class="ffield--pair">' +
      '<div class="ffield"><label class="t-lab" for="ed_city">City</label>' +
      '<input class="input" id="ed_city" data-edit="city" value="' + esc(edit.city) + '" /></div>' +
      '<div class="ffield"><label class="t-lab" for="ed_district">District</label>' +
      '<input class="input" id="ed_district" data-edit="district" value="' + esc(edit.district) + '" /></div>' +
      '</div>' +
      '<div class="ffield"><label class="t-lab" for="ed_state">State</label>' +
      '<input class="input" id="ed_state" data-edit="stateName" value="' + esc(edit.stateName) + '" /></div>' +

      /* map location */
      '<div class="regform__sub"><span class="t-lab">Shop location</span>' +
      '<span class="t-xs muted">optional</span></div>' +
      '<div class="locbox" id="locBox">' + locationHTML() + '</div>' +
      '</div>';
  }

  function locationHTML() {
    var loc = edit.location;
    if (!loc) {
      return '<button class="btn btn--outline btn--block" data-act="use-location">' +
        icon('phone') + 'Use my current location</button>' +
        '<p class="t-xs muted" style="margin-top:8px">Pins your shop on Google Maps so customers and couriers can find it.</p>';
    }
    var q = loc.lat.toFixed(6) + ',' + loc.lng.toFixed(6);
    return '<div class="locpin">' + icon('checkCircle') +
      '<div class="grow"><b>Location saved</b>' +
      '<span class="mono">' + esc(q) + '</span></div></div>' +
      '<div class="row wrap" style="gap:8px;margin-top:10px">' +
      '<a class="btn btn--outline btn--sm" target="_blank" rel="noopener noreferrer" ' +
      'href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) + '">' +
      icon('linkOut') + 'Open in Google Maps</a>' +
      '<button class="btn btn--ghost btn--sm" data-act="use-location">' + icon('refresh') + 'Update</button>' +
      '<button class="btn btn--ghost btn--sm" data-act="clear-location">' + icon('close') + 'Remove</button>' +
      '</div>';
  }

  function captureLocation() {
    if (!navigator.geolocation) { toast('This browser cannot share a location', 'alert'); return; }
    var box = document.getElementById('locBox');
    if (box) box.innerHTML = '<div class="locpin">' + icon('refresh') + '<span>Getting your location…</span></div>';
    navigator.geolocation.getCurrentPosition(function (pos) {
      edit.location = {
        lat: pos.coords.latitude, lng: pos.coords.longitude,
        accuracy: Math.round(pos.coords.accuracy), at: Date.now()
      };
      var b = document.getElementById('locBox');
      if (b) b.innerHTML = locationHTML();
      toast('Location captured');
    }, function (err) {
      var b = document.getElementById('locBox');
      if (b) b.innerHTML = locationHTML();
      toast(err && err.code === 1 ? 'Location permission denied' : 'Could not get your location', 'alert');
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }

  /* downscale before storing — a raw camera photo would blow the quota */
  function readPhoto(file) {
    return new Promise(function (resolve, reject) {
      if (!file) return reject();
      if (!/^image\//.test(file.type)) return reject(new Error('That file is not an image.'));
      var fr = new FileReader();
      fr.onload = function () {
        var img = new Image();
        img.onload = function () {
          var max = 256;
          var scale = Math.min(1, max / Math.max(img.width, img.height));
          var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
          var cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(cv.toDataURL('image/jpeg', 0.82));
        };
        img.onerror = function () { reject(new Error('That image could not be read.')); };
        img.src = fr.result;
      };
      fr.onerror = function () { reject(new Error('That image could not be read.')); };
      fr.readAsDataURL(file);
    });
  }

  function saveProfile() {
    /* The four the payment flow depends on. The phone number is here because
       Razorpay Checkout inserts its own contact step when we cannot send one —
       collecting it once removes a screen from every future purchase. */
    var missing = [];
    if (!edit.shopName.trim()) missing.push('shop name');
    if (!edit.proprietor.trim()) missing.push('proprietor name');
    if (!edit.country) missing.push('country');
    /* This call always passed two arguments; validNumber took one, and tested
       the FIRST — the country code — as if it were the digits. "IN" is not six
       to fourteen digits, so Save reported "a valid mobile number" as missing
       every single time and the profile could never be saved from this sheet.
       That is the loop behind being asked for shop details again at checkout:
       the payment needed the profile, the sheet could not write it, so the
       payment asked again. */
    if (!SM.countries.validNumber(edit.country, edit.mobile)) missing.push('a valid mobile number');
    if (missing.length) {
      toast('Still needed: ' + missing.join(', '), 'alert');
      return;
    }
    var c = SM.countries.byCode(edit.country);
    var e164 = SM.countries.toE164(edit.country, edit.mobile);
    S.updateProfile({
      /* Names the server reads when it builds the Checkout prefill. */
      mobileShopName: edit.shopName.trim(),
      proprietorName: edit.proprietor.trim(),
      mobileNumber: edit.mobile.trim(),
      mobileNumberE164: e164,
      countryCode: edit.country,
      shopName: edit.shopName.trim(), proprietor: edit.proprietor.trim(),
      country: edit.country, countryName: c && c.name, dial: c && c.dial,
      mobile: edit.mobile.trim(), photo: edit.photo || '',
      location: edit.location || null,
      address: {
        flat: edit.flat.trim(), area: edit.area.trim(), city: edit.city.trim(),
        district: edit.district.trim(), state: edit.stateName.trim(),
        country: c && c.name
      }
    }).then(function () {
      /* Mirror to Firestore. The local copy keeps the UI instant; the server
         reads Firestore when it decides whether a payment may start, so a
         profile that only ever lived in localStorage would be complete on
         screen and incomplete at checkout. */
      var uid = SM.fb && SM.fb.user() && SM.fb.user().uid;
      var editParts = {
        flat: edit.flat.trim(), area: edit.area.trim(), city: edit.city.trim(),
        district: edit.district.trim(), state: edit.stateName.trim()
      };
      var editHasAddress = Object.keys(editParts).some(function (k) { return editParts[k]; });

      var shop = {
        mobileShopName: edit.shopName.trim(),
        proprietorName: edit.proprietor.trim(),
        mobileNumber: edit.mobile.trim(),
        mobileNumberE164: e164,
        country: (c && c.name) || '',
        countryCode: edit.country,
        /* Undefined, not an empty object: an untouched address must leave the
           stored one alone rather than replacing it with a country. */
        address: editHasAddress
          ? Object.assign({}, editParts, { country: (c && c.name) || '' })
          : undefined,
        /* Only a genuinely uploaded photo is recorded. A local preview is not a
           stored photo, and writing its data URL here would put an unusable
           value in front of every other device. */
        profilePhotoURL: edit.photoURL || undefined,
        profilePhotoPath: edit.photoPath || undefined
      };

      /* Both writes, and the SERVER one is the one that must succeed.
         create-order reads users/{uid} to decide whether a payment may start,
         so a profile that only reached this browser is complete on screen and
         incomplete at checkout — which is the 409 the shop then cannot explain.
         The direct write keeps the screen instant; the server write is what
         makes the record real, and it cannot be swallowed by a security rule. */
      var direct = (uid && SM.store && SM.store.available())
        ? SM.store.saveProfile(uid, shop, SM.fb.user())
            .catch(function (e) {
              SM.debug.warn('profile', 'direct write failed, relying on the server', { code: e && e.code });
              return null;
            })
        : Promise.resolve(null);

      var mirrored = direct.then(function () {
        if (!uid || !SM.billing) return null;
        return SM.billing.syncProfile({ photoURL: edit.photoURL || null, profile: shop });
      });

      return mirrored.then(function () {
        state.sheet = null; renderSheet();
        renderShellBits();
        renderAccount(document.getElementById('page'));

        /* Straight back to the plan they picked before the form appeared. */
        var plan = state.pendingPlan;
        if (plan) {
          state.pendingPlan = null;
          toast('Profile saved — opening payment');
          var btn = document.querySelector('[data-act="subscribe"][data-id="' + plan + '"]');
          if (btn) btn.click(); else go('/plans');
        } else {
          toast('Profile updated');
        }
      }, function (err) {
        SM.debug.warn('profile', 'profile did not reach the server', {
          status: err && err.status, code: err && err.code, message: err && err.message
        });
        /* The sheet stays open on purpose: the details are still in the form,
           so Save is one tap away rather than a retype. */
        toast('Saved on this device, but not to your account — try Save again', 'alert');
      });
    });
  }

  function planById(id) {
    return SM.PLANS.filter(function (p) { return p.id === id; })[0] || null;
  }

  function avatarHTML(s, cls) {
    var img = s.photo || s.picture;
    if (img) return '<span class="avatar ' + (cls || '') + ' avatar--img"><img src="' + esc(img) + '" alt="" /></span>';
    return '<span class="avatar ' + (cls || '') + '">' + esc(initials(s.name)) + '</span>';
  }

  /* identity block, shared by every signed-in state */
  function identityHTML(s) {
    var badge = s.status === 'pro'
      ? '<span class="pill pill--ok">' + icon('checkCircle') + 'Active</span>'
      : s.status === 'expired'
        ? '<span class="pill pill--bad">' + icon('alert') + 'Expired</span>'
        : '<span class="pill">' + icon('user') + 'Free account</span>';
    return '<div class="row" style="gap:14px;align-items:flex-start">' +
      avatarHTML(s, 'avatar--lg') +
      '<div class="grow" style="min-width:0">' +
      '<h2 class="t-h1" style="word-break:break-word">' + esc(s.shopName || s.name) + '</h2>' +
      (s.proprietor ? '<p class="t-xs" style="margin-top:2px">' + esc(s.proprietor) + '</p>' : '') +
      '<p class="t-xs muted" style="word-break:break-all">' + esc(s.email) + '</p>' +
      (s.mobile ? '<p class="t-xs muted">' + esc(s.mobile) + '</p>' : '') +
      '<div style="margin-top:8px">' + badge + '</div>' +
      '</div>' +
      /* Edit, and — for the owner only — the way into the backend.

         Wrapped so the two sit together and wrap onto their own line on a
         narrow screen instead of squeezing the shop name. With one button the
         row is visually identical to before, so nothing changes for the
         4,933 accounts that are not the owner. */
      '<div class="row" style="gap:8px;flex-wrap:wrap;justify-content:flex-end">' +
      '<button class="btn btn--outline btn--sm" data-act="edit-profile">' + icon('sliders') + 'Edit</button>' +
      adminLinkHTML() +
      '</div>' +
      '</div>';
  }

  /* The Admin Panel link, for the owner account and nobody else.

     SM.fb.isOwner() compares the signed-in Google address against the owner's,
     and it decides whether to DRAW this — nothing more. /admin and every
     /api/admin/* route behind it re-check the same address against the
     verified ID token, server side, on every request. Someone who conjures
     this button in the console gets a page that refuses them.

     A real <a href> rather than a button, so it can be middle-clicked and so
     it works if the app never boots. /admin is not in ROUTES, so the app's own
     click interceptor leaves it alone and the browser navigates to the
     separate admin shell. */
  function adminLinkHTML() {
    /* The resolved role, never the raw email compare. currentRole() returns
       null while the answer is still outstanding, and renderAccount does not
       call this until it is settled — so a null here means "not admin" only
       because it can no longer mean "not decided yet". */
    if (!isAdminRole(currentRole())) return '';
    /* No data-act: there is no handler and there should not be one. The
       browser navigates to /admin on its own, which is the whole point of it
       being a link. */
    return '<a class="btn btn--primary btn--sm" href="/admin">' +
      icon('shield') + 'Admin Panel</a>';
  }

  /* plan cards the user can buy straight from Account */
  function planPickerHTML(s, opts) {
    opts = opts || {};
    return '<div class="planpick">' + SM.PLANS.map(function (p) {
      var isCurrent = s.status === 'pro' && s.plan === p.id;
      var best = p.id === 'yearly';
      return '<div class="planpick__item' + (best ? ' planpick__item--best' : '') + (isCurrent ? ' is-current' : '') + '">' +
        (p.badge ? '<span class="planpick__tag">' + esc(p.badge) + '</span>' : '') +
        '<div class="planpick__top">' +
        '<span class="planpick__name">' + esc(p.name) + '</span>' +
        '<span class="planpick__price"><b>₹' + p.price + '</b><span>/ ' + esc(p.per) + '</span></span>' +
        '</div>' +
        '<p class="planpick__note">' + esc(p.note) + '</p>' +
        (isCurrent
          ? '<button class="btn btn--sm btn--block btn--soft" disabled>' + icon('check') + 'Current plan</button>'
          : '<button class="btn btn--sm btn--block ' + (best ? 'btn--amber' : 'btn--primary') + '" ' +
          'data-act="subscribe" data-id="' + p.id + '">' + icon('bolt') + (opts.cta || 'Choose') + ' ' + esc(p.name) + '</button>') +
        '</div>';
    }).join('') + '</div>';
  }

  /* A function, not a constant: the model count comes from the catalogue, which
     now arrives over the network. Evaluating this at module scope read
     db.stats before the fetch had resolved and took the whole app down. */
  /* WHAT THIS SCREEN SAYS HAS TO MATCH WHAT THE SERVER DOES.

     These two lists were last written while the catalogue was open, and they
     promised a free account "Full compatible-device list for every group" and
     "Group sheets you can show a customer" with a tick beside each, while
     PRO_ONLY was empty. Both are now withheld by /api/device-parts. A ticked
     line for something the product refuses is worse than no line at all: it
     is the account screen telling a shop they have something, and the app
     then refusing it. */
  function freeIncluded() { return [
    'Five free model searches (one-time, they do not reset)',
    'Browse all ' + nf(db.stats.models) + ' phone models and their specs',
    'Browse every compatibility group — number, part code, master model',
    'See how many devices each group covers'
  ]; }

  /* Enforced in api/_schema/entitlement.js and api/access.js, not here. This
     list draws the padlocks; it does not decide anything. */
  var PRO_ONLY = [
    'Unlimited model searches',
    'Open any group and see every device it fits',
    'Full compatible-device list for every group',
    'Search and filter inside the group library',
    'Group sheets you can show a customer'
  ];

  /* `included` is true for an account with a running plan.

     This list used to draw a padlock and a "Plan" tag beside every paid
     feature for EVERYONE, subscribers included — so the screen that says
     "Current plan: Yearly" also said, a few lines down, that unlimited
     searches and opening a group were locked. To a shop that has just paid,
     that reads as the payment not having worked. A subscriber sees them
     ticked, because for a subscriber they are. */
  function accessHTML(included) {
    return '<span class="t-lab">What your account can do</span>' +
      '<ul class="acclist" style="margin-top:10px">' +
      (included ? [] : freeIncluded()).concat(included ? PRO_ONLY.concat(freeIncluded().slice(1)) : [])
        .map(function (t) {
          return '<li class="acclist__on">' + icon('checkCircle') + '<span>' + esc(t) + '</span></li>';
        }).join('') +
      (included ? '' : PRO_ONLY.map(function (t) {
        return '<li class="acclist__off">' + icon('lock') + '<span>' + esc(t) + '</span>' +
          '<span class="acclist__tag">Plan</span></li>';
      }).join('')) +
      '</ul>';
  }

  function profileHTML(s) {
    if (s.status === 'pro' && s.subscription && s.subscription.lifetime) return lifetimeHTML(s);
    if (s.status === 'pro') return proHTML(s);
    if (s.status === 'expired') return expiredHTML(s);
    return freeHTML(s);
  }

  /* ---------------------------------------------------------- FREE USER --- */
  function freeHTML(s) {
    return '<div class="acct">' +
      '<div class="card card--pad">' +
      identityHTML(s) +
      '<hr class="divider" style="margin:18px 0" />' +
      accessHTML() +
      '<hr class="divider" style="margin:18px 0" />' +
      '<button class="btn btn--ghost btn--sm" data-act="signout">' + icon('logout') + 'Sign out</button>' +
      '</div>' +

      '<div class="card card--pad">' +
      '<span class="t-lab">Unlock the Device Finder</span>' +
      '<p class="t-sub" style="margin:6px 0 14px">Pick a plan to match any model to its group and see every fitment.</p>' +
      planPickerHTML(s) +
      '</div></div>';
  }

  /* ----------------------------------------------------- ACTIVE SUBSCRIBER */
  function proHTML(s) {
    var sub = s.subscription;
    var p = planById(sub.plan) || SM.PLANS[0];
    return '<div class="acct">' +
      '<div class="card card--pad">' +
      identityHTML(s) +
      '<hr class="divider" style="margin:18px 0" />' +

      '<span class="t-lab">Current plan</span>' +
      '<div class="row" style="gap:10px;margin-top:8px;align-items:baseline;flex-wrap:wrap">' +
      '<span class="t-h1">' + esc(p.name) + '</span>' +
      '<span class="muted">₹' + p.price + ' / ' + esc(p.per) + '</span></div>' +

      '<div class="submeter">' +
      '<div class="submeter__bar"><i style="width:' + sub.pctLeft.toFixed(1) + '%"></i></div>' +
      '<div class="submeter__row">' +
      '<span><b>' + sub.daysLeft + '</b> ' + (sub.daysLeft === 1 ? 'day' : 'days') + ' remaining</span>' +
      '<span class="muted">' + sub.daysTotal + '-day term</span>' +
      '</div></div>' +

      '<div class="idgrid" style="margin-top:14px;grid-template-columns:repeat(2,minmax(0,1fr))">' +
      '<div class="idcell"><span>Started</span><b style="font-family:var(--f-ui);font-size:14px">' + esc(sub.startLabel) + '</b></div>' +
      '<div class="idcell"><span>' + (sub.willRenew ? 'Renews on' : 'Access until') + '</span>' +
      '<b style="font-family:var(--f-ui);font-size:14px">' + esc(sub.endLabel) + '</b></div>' +
      '</div>' +

      (sub.willRenew ? '' :
        '<div class="notice notice--amber" style="margin-top:12px">' + icon('info') +
        '<span>Renewal is off. Your plan stays active until ' + esc(sub.endLabel) + ', then the account moves to Expired.</span></div>') +

      '<div class="row wrap" style="gap:8px;margin-top:16px">' +
      '<button class="btn btn--outline btn--sm" data-act="nav" data-href="/plans">' + icon('crown') + 'Change plan</button>' +
      (sub.willRenew
        ? '<button class="btn btn--ghost btn--sm" data-act="cancel-sub">Cancel subscription</button>'
        : '<button class="btn btn--ghost btn--sm" data-act="resume-sub">Resume renewal</button>') +
      '</div>' +

      '<hr class="divider" style="margin:18px 0" />' +
      '<button class="btn btn--ghost btn--sm" data-act="signout">' + icon('logout') + 'Sign out</button>' +
      '</div>' +

      '<div class="card card--pad">' + accessHTML(true) + '</div></div>';
  }

  /* ------------------------------------------------------- LIFETIME ACCESS

     Not a plan anyone bought, so there is nothing here to renew, change or
     cancel — no term meter, no "Change plan", no price. The business granted
     it and only the business can take it away, which is the one thing worth
     saying. The same access as Monthly and Yearly; the only difference is
     that it has no end date. */
  function lifetimeHTML(s) {
    var sub = s.subscription;
    return '<div class="acct">' +
      '<div class="card card--pad">' +
      identityHTML(s) +
      '<hr class="divider" style="margin:18px 0" />' +

      '<span class="t-lab">Current plan</span>' +
      '<div class="row" style="gap:10px;margin-top:8px;align-items:baseline;flex-wrap:wrap">' +
      '<span class="t-h1">Lifetime</span>' +
      '<span class="muted">no renewal, no expiry</span></div>' +

      '<div class="idgrid" style="margin-top:14px;grid-template-columns:repeat(2,minmax(0,1fr))">' +
      '<div class="idcell"><span>Active since</span><b style="font-family:var(--f-ui);font-size:14px">' +
        esc(sub.startLabel || '—') + '</b></div>' +
      '<div class="idcell"><span>Expires</span>' +
      '<b style="font-family:var(--f-ui);font-size:14px">Never</b></div>' +
      '</div>' +

      '<div class="notice notice--brand" style="margin-top:12px">' + icon('checkCircle') +
      '<span><b>Lifetime access.</b> Every group, every part category and unlimited ' +
      'searches, with nothing to pay and nothing to renew.</span></div>' +

      '<hr class="divider" style="margin:18px 0" />' +
      '<button class="btn btn--ghost btn--sm" data-act="signout">' + icon('logout') + 'Sign out</button>' +
      '</div>' +

      '<div class="card card--pad">' + accessHTML(true) + '</div></div>';
  }

  /* ------------------------------------------------------------- EXPIRED -- */
  function expiredHTML(s) {
    var sub = s.subscription;
    var p = sub ? planById(sub.plan) : null;
    return '<div class="acct">' +
      '<div class="card card--pad">' +
      identityHTML(s) +
      '<hr class="divider" style="margin:18px 0" />' +
      '<div class="notice notice--amber">' + icon('alert') +
      '<span><b>Your ' + esc(p ? p.name.toLowerCase() : '') + ' plan expired on ' + esc(sub ? sub.endLabel : '') + '.</b> ' +
      'Your account and its details are untouched, and browsing models and ' +
      'groups still works. Opening a group to see the devices it fits, and ' +
      'searching without a limit, need a plan again.</span></div>' +

      (sub ? '<div class="idgrid" style="margin-top:12px;grid-template-columns:repeat(2,minmax(0,1fr))">' +
        '<div class="idcell"><span>Previous plan</span><b style="font-family:var(--f-ui);font-size:14px">' +
        esc(p ? p.name + ' · ₹' + p.price : '—') + '</b></div>' +
        '<div class="idcell"><span>Expired on</span><b style="font-family:var(--f-ui);font-size:14px">' +
        esc(sub.endLabel) + '</b></div></div>' : '') +

      '<hr class="divider" style="margin:18px 0" />' +
      '<button class="btn btn--ghost btn--sm" data-act="signout">' + icon('logout') + 'Sign out</button>' +
      '</div>' +

      '<div class="card card--pad">' +
      '<span class="t-lab">Pick up where you left off</span>' +
      '<p class="t-sub" style="margin:6px 0 14px">The yearly plan works out cheapest per month.</p>' +
      planPickerHTML(s, { cta: 'Renew' }) +
      '</div></div>';
  }

  /* ==========================================================================
     OVERLAYS · group sheet · model sheet · filters · demo
     ========================================================================== */
  /* ==========================================================================
     PAGE · DEVICE  (#/model/<id>)

     The showcase. A model opens as a full page rather than the bottom sheet it
     used to use: the sheet worked when this only had to answer "which parts
     fit", but it caps at about half the viewport, and a spec sheet that has to
     be scrolled inside a scrolling overlay is miserable on a phone — which is
     the device most of this audience is holding.

     The page is built from three bands, in the order a shop owner actually
     needs them: identity and price first, then the four specs that decide a
     repair quote, then the full sheet, then compatibility.
     ========================================================================== */

  /* One highlight tile. Kept deliberately terse — this band is scanned, not read. */
  /* A highlight card with no value is not rendered. Six cards reading "—" tell
     a reader the page is broken; four real ones tell them what is known. */
  /* Joins the parts that exist and returns null when none do, so a caption
     never renders as "null · null · null". */
  function join(sep, parts) {
    var kept = parts.filter(function (p) { return p != null && p !== ''; });
    return kept.length ? kept.join(sep) : null;
  }

  /* States what the loaded catalogue does not carry, by name. A spec page that
     silently omits half its sections looks incomplete; one that says which
     fields the source lacks is simply accurate, and tells the owner exactly
     what a richer import would add. */
  /* What the catalogue knows, does not know, and knows only sometimes.

     The third state is the one that was missing. Screen type, battery part
     number and release status come from the category exports and cover some
     devices and not others — calling them "not included" would be wrong on the
     260 devices that have a screen type, and listing them as present would be
     wrong on the other 4,673. */
  function coverageNoteHTML() {
    var cov = db.coverage;
    if (!cov || !cov.absent || !cov.absent.length) return '';
    var LABEL = {
      chipset: 'processor', cpu: 'CPU', gpu: 'GPU', ram: 'RAM', storage: 'storage',
      colours: 'colours', cameras: 'cameras', os: 'software', network: 'network',
      sensors: 'sensors', screenCurve: 'flat/curved screen', price: 'price',
      variants: 'RAM and storage variants', screenResolution: 'resolution',
      refreshRate: 'refresh rate',
      screenType: 'screen type', batteryPartNo: 'battery part number',
      releaseStatus: 'availability'
    };
    var names = cov.absent.map(function (f) { return LABEL[f] || f; });
    var partial = (cov.partial || []).map(function (f) { return LABEL[f] || f; });

    return '<p class="dnote">' + icon('info') +
      '<span>This catalogue carries model, brand, release date, display size, ' +
      'dimensions and battery. It does not include ' + esc(names.join(', ')) +
      ' — those fields are left out rather than estimated.' +
      (partial.length
        ? ' ' + esc(partial.join(', ')) +
          ' ' + (partial.length === 1 ? 'is' : 'are') +
          ' recorded for some devices only, and shown where known.'
        : '') +
      '</span></p>';
  }

  function keySpecHTML(iconName, label, value, sub) {
    if (value == null || value === '' || value === 'null') return '';
    return '<div class="dkey">' +
      '<span class="dkey__i">' + icon(iconName) + '</span>' +
      '<span class="dkey__l">' + esc(label) + '</span>' +
      '<span class="dkey__v">' + esc(value) + '</span>' +
      (sub ? '<span class="dkey__s">' + esc(sub) + '</span>' : '') +
      '</div>';
  }

  /* A titled block of label/value rows. Rows whose value is null are dropped
     rather than shown empty, so a sparse device does not render a wall of
     dashes. */
  /* A row marked IMPORTED is one the source workbook has a column for. When
     this particular device's cell was empty the row is still drawn, showing a
     hyphen, because that absence is a fact worth seeing: the column exists,
     most devices have a value, and this one is waiting to be filled in.

     A row NOT so marked is a field the catalogue has no source for at all —
     chipset, cameras, sensors. Those are dropped, and the note at the foot of
     the page names them once. Drawing sixteen hyphens on every device instead
     would be a longer page saying exactly the same thing. */
  var IMPORTED = true;

  /* `aside` is an optional scrap of markup for the section header — the Body
     block uses it to show the handset itself at thumbnail size. It is a visual
     footnote to the dimensions, not a second hero: the real photograph is
     already 40 pixels to the left. */
  function specBlockHTML(title, iconName, rows, aside) {
    var body = rows.filter(function (r) {
      if (!r) return false;
      var has = r[1] != null && r[1] !== '';
      return has || r[2] === IMPORTED;
    }).map(function (r) {
      var has = r[1] != null && r[1] !== '';
      return '<div class="dspec' + (has ? '' : ' is-unknown') + '">' +
        '<dt>' + esc(r[0]) + '</dt>' +
        '<dd>' + (has ? esc(String(r[1])) : '-') + '</dd></div>';
    }).join('');
    if (!body) return '';
    return '<section class="dsec">' +
      '<h3 class="dsec__h">' + icon(iconName) + esc(title) +
        (aside ? '<span class="dsec__art">' + aside + '</span>' : '') + '</h3>' +
      '<dl class="dsec__b">' + body + '</dl></section>';
  }

  /* ------------------------------------------------- enriched model record

     Models migrated to the TechSpecs pipeline carry the real variant matrix:
     one hardware SKU per market, each with its own model number, its own valid
     colour/RAM/storage combinations and its own verified price.

     The record is fetched per model from assets/models-active/ rather than
     folded into dataset.json, so enriching the whole catalogue later costs the
     bundle nothing. It is fetched ALONGSIDE the model, never after painting:
     painting once and swapping afterwards moved the scroll position under the
     reader, which is most of what "the page does not scroll smoothly" was. */
  var activeCache = {};

  function loadActive(id) {
    if (Object.prototype.hasOwnProperty.call(activeCache, id)) {
      return Promise.resolve(activeCache[id]);
    }
    /* No cache:'force-cache' here. A model that has not been migrated yet 404s,
       and force-cache replays that 404 from the HTTP cache long after the
       record exists. Normal caching lets the response's headers decide. */
    return fetch('/assets/models-active/' + encodeURIComponent(id) + '.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (v) { activeCache[id] = v; return v; });
  }

  /* ------------------------------------------------------ variant selection

     MARKET IS THE PRIMARY AXIS. A market is a distinct hardware SKU, so it
     decides the model number and constrains every other choice. The model
     number is never picked by hand — it is read off the selected market, which
     is the only relationship that is actually true of the hardware.

     Colour / RAM / storage options are derived from the variants belonging to
     the selected market, so a market that never sold Yellow simply does not
     offer it. Today every iPhone 14 market sells the same set; that is a fact
     about the data, not an assumption in the UI. */
  function inMarket(a, region) {
    return (a.variants || []).filter(function (v) { return v.region === region; });
  }
  function optionsFor(a, region, key) {
    var seen = Object.create(null), out = [];
    inMarket(a, region).forEach(function (v) {
      if (v[key] && !seen[v[key]]) { seen[v[key]] = 1; out.push(v[key]); }
    });
    return out;
  }
  function matchVariant(a, sel) {
    return inMarket(a, sel.region).filter(function (v) {
      return v.color === sel.color && v.ram === sel.ram && v.storage === sel.storage;
    })[0] || null;
  }
  /* Would this value still resolve to a real variant, holding the rest? */
  function canPick(a, sel, axis, value) {
    var probe = { region: sel.region, color: sel.color, ram: sel.ram, storage: sel.storage };
    probe[axis] = value;
    if (axis === 'region') return inMarket(a, value).length > 0;
    return !!matchVariant(a, probe);
  }

  /* Snap a selection back onto a combination the market actually sold. Called
     after any change, so switching market can never strand the page on a
     variant that does not exist. */
  function reconcile(a, sel) {
    var regions = (a.axes && a.axes.region ? a.axes.region : []).map(function (r) { return r.value; });
    if (regions.indexOf(sel.region) < 0) sel.region = regions[0];
    ['color', 'ram', 'storage'].forEach(function (k) {
      var opts = optionsFor(a, sel.region, k);
      if (opts.indexOf(sel[k]) < 0) sel[k] = opts[0] || null;
    });
    if (!matchVariant(a, sel)) {
      var v = inMarket(a, sel.region)[0];
      if (v) { sel.color = v.color; sel.ram = v.ram; sel.storage = v.storage; }
    }
    return sel;
  }

  /* India / Global first: it is the primary market for this catalogue, and a
     page that opens on a market the reader does not sell into is noise. */
  function defaultSelection(a) {
    var regions = (a.axes && a.axes.region ? a.axes.region : []);
    var pref = regions.filter(function (r) { return r.value === 'GLOBAL'; })[0] || regions[0] || {};
    return reconcile(a, { region: pref.value || null, color: null, ram: null, storage: null });
  }

  function money(p) {
    if (!p || !p.amount) return null;
    var n = Number(p.amount);
    return p.currency === 'INR'
      ? RUPEE + n.toLocaleString('en-IN')
      : (p.currency ? p.currency + ' ' : '') + n.toLocaleString('en-US');
  }

  /* A colour only changes the photograph when a real photograph of that colour
     exists. No CSS tint is applied over the default shot: a recoloured picture
     of a Midnight handset is a fabricated product image. */
  function imageFor(a, color) {
    var by = (a.image && a.image.byColor) || {};
    return (color && by[color]) || (a.image && a.image.primary) || null;
  }

  function chipsHTML(a, sel, axis, opts, labels) {
    return opts.map(function (o) {
      var on = sel[axis] === o, ok = canPick(a, sel, axis, o);
      return '<button type="button" class="vopt' + (on ? ' is-on' : '') + (ok ? '' : ' is-off') + '"' +
        (ok ? '' : ' disabled aria-disabled="true"') +
        ' data-act="vpick" data-axis="' + esc(axis) + '" data-value="' + esc(o) + '"' +
        ' aria-pressed="' + (on ? 'true' : 'false') + '">' +
        esc(labels && labels[o] ? labels[o] : o) + '</button>';
    }).join('');
  }

  /* ------------------------------------------------------------ spec sheet

     CLASS NAMES ARE NAMESPACED (mdsp-*). Three shorter names were tried first
     and every one already existed in components.css: `.spec` (display:flex,
     with its own dt/dd type scale) put each section header beside its rows,
     and `.mspecs` (display:flex) stopped the column packing working at all.
     Check a class name is free before reaching for it here.

     PACKING. Cards flow in CSS columns rather than a grid: a grid row stretches
     every card to the tallest in it, which is what left the big holes next to
     Camera. Columns let each card take exactly its content height and pull the
     next one up into the gap. Camera is lifted out as a full-width block
     because it carries far more rows than anything beside it.

     No provenance on the rows. Where a value came from is real, but it is our
     bookkeeping, not the reader's - it stays in the record and in the one
     source block at the foot of the page. */
  var SPEC_ICON = {
    general: 'info', body: 'ruler', display: 'display', performance: 'cpu',
    memory: 'layers', camera: 'camera', battery: 'battery',
    connectivity: 'signal', sim: 'simcard', audio: 'speaker',
    software: 'software', other: 'sliders'
  };
  var SPEC_ORDER = ['general', 'body', 'display', 'performance', 'memory', 'camera',
                    'battery', 'connectivity', 'sim', 'audio', 'software', 'other'];
  /* Camera gets the full width; everything else packs into the columns. */
  var WIDE_SECTIONS = { camera: 1 };

  function mrowsHTML(rows) {
    return rows.map(function (r) {
      return '<div class="mdsp-row">' +
        '<dt class="mdsp-row__l">' + esc(r.label) + '</dt>' +
        '<dd class="mdsp-row__v">' + esc(String(r.value)) + '</dd>' +
        '</div>';
    }).join('');
  }

  function mdspCardHTML(s, rows, wide) {
    return '<section class="mdsp-sec' + (wide ? ' mdsp-sec--wide' : '') + '" id="spec-' + esc(s.id) + '">' +
      '<h2 class="mdsp-sec__h">' + icon(SPEC_ICON[s.id] || 'info') +
        '<span>' + esc(s.title) + '</span></h2>' +
      '<dl class="mdsp-sec__b">' + mrowsHTML(rows) + '</dl>' +
      '</section>';
  }

  /* Rows that depend on the current selection resolve here, so the sheet always
     agrees with the picker above it. */
  function rowsForSection(a, s, sel) {
    var v = matchVariant(a, sel);
    var rows = s.rows.slice();
    if (s.id === 'general' && v) {
      rows = rows.filter(function (r) { return r.label !== 'Model numbers'; });
      rows.splice(2, 0,
        { label: 'Market', value: v.regionLabel },
        { label: 'Regional model number', value: v.modelNumber });
    }
    if (s.id === 'body' && sel.region) {
      /* Colours belong to the selected market, never to the union of all of
         them - a market that never sold Yellow must not list it. */
      var cols = optionsFor(a, sel.region, 'color');
      if (cols.length) {
        rows = rows.map(function (r) {
          return r.label === 'Colours' ? { label: 'Colours', value: cols.join(', ') } : r;
        });
      }
    }
    return rows;
  }

  function specSheetHTML(a, sel) {
    var byId = {};
    (a.specs || []).forEach(function (s) { if (s.rows && s.rows.length) byId[s.id] = s; });
    var ordered = SPEC_ORDER.filter(function (id) { return byId[id]; });
    /* A section the record adds that this order does not name still renders. */
    Object.keys(byId).forEach(function (id) { if (ordered.indexOf(id) < 0) ordered.push(id); });

    var out = '', pack = [];
    var flush = function () {
      if (!pack.length) return;
      out += '<div class="mdsp-grid">' + pack.join('') + '</div>';
      pack = [];
    };
    ordered.forEach(function (id) {
      var s = byId[id], card = mdspCardHTML(s, rowsForSection(a, s, sel), WIDE_SECTIONS[id]);
      if (WIDE_SECTIONS[id]) { flush(); out += card; } else pack.push(card);
    });
    flush();
    return out;
  }

  /* --------------------------------------------------------- related models

     Same brand, sharing the leading words of this model's name once the brand
     is stripped: "iPhone 14" also matches "iPhone 14 Plus" and "iPhone 14 Pro"
     but not "iPhone 15". Nothing is hard-coded per brand — the rule reads the
     catalogue, so Galaxy S24 or Redmi Note 13 behave the same way. */
  function relatedModels(m, limit) {
    var all = (db && db.models) || [];
    /* The catalogue keys a display name as fullName; read both so this does
       not depend on which one a given record carries. */
    var nameOf = function (o) { return o.fullName || o.modelName || o.name || ''; };
    var strip = function (o) {
      var n = String(nameOf(o)).trim();
      var br = String(o.brand || '').trim();
      /* Plain prefix strip rather than a built RegExp: brand names contain
         characters that are regex metacharacters ("Nothing Phone (2)"). */
      if (br && n.toLowerCase().indexOf(br.toLowerCase() + ' ') === 0) n = n.slice(br.length + 1);
      return n.trim();
    };
    var base = strip(m).toLowerCase().split(/\s+/).filter(Boolean);
    if (base.length < 2) return [];
    var out = [];
    all.forEach(function (o) {
      if (o.id === m.id || o.brandId !== m.brandId) return;
      var t = strip(o).toLowerCase().split(/\s+/).filter(Boolean);
      var n = 0;
      while (n < base.length && n < t.length && base[n] === t[n]) n++;
      if (n >= 2) out.push({ m: o, score: n });
    });
    out.sort(function (x, y) {
      return y.score - x.score ||
        String(nameOf(x.m)).length - String(nameOf(y.m)).length ||
        String(nameOf(x.m)).localeCompare(String(nameOf(y.m)));
    });
    return out.slice(0, limit || 6).map(function (r) { return r.m; });
  }

  function relatedHTML(m) {
    var list = relatedModels(m, 6);
    if (!list.length) return '';
    var nameOf = function (o) { return o.fullName || o.modelName || o.name || ''; };
    var series = String(nameOf(m)).split(/\s+/).slice(0, 3).join(' ');
    return '<section class="rel">' +
      '<h2 class="rel__h">Explore the ' + esc(series) + ' series</h2>' +
      '<div class="rel__g">' + list.map(function (o) {
        return '<a class="rel__c" href="/model/' + esc(o.id) + '" data-act="nav" ' +
          'data-href="/model/' + esc(o.id) + '">' +
          '<span class="rel__s">' + (o.image
            ? '<img src="' + esc(o.image) + '" alt="" width="72" height="96" loading="lazy" ' +
              'decoding="async" referrerpolicy="no-referrer" />'
            : '') + '</span>' +
          '<b class="rel__n">' + esc(nameOf(o)) + '</b>' +
          (o.displaySize ? '<i class="rel__d">' + esc(String(o.displaySize)) + '"</i>' : '') +
          '<span class="rel__v">View model ' + icon('arrowRight') + '</span>' +
          '</a>';
      }).join('') + '</div></section>';
  }

  /* ------------------------------------------------------------- provenance
     Plain sentences, not a batch record. Where the numbers came from and when
     they were last checked is what a reader needs; the audit trail stays
     behind a disclosure. */
  function sourceHTML(a) {
    var meta = a.sourceMeta || {};
    var conf = meta.conflicts || [];
    return '<section class="prov">' +
      '<dl class="prov__b">' +
        '<div><dt>Source</dt><dd>' + esc(meta.primarySource || '-') + '</dd></div>' +
        '<div><dt>Verification</dt><dd>' + esc(meta.verificationStatus || '-') + '</dd></div>' +
        '<div><dt>Image source</dt><dd>' + esc((a.image && a.image.primarySource) || '-') + '</dd></div>' +
        '<div><dt>Last verified</dt><dd>' + esc(meta.lastVerified || '-') + '</dd></div>' +
      '</dl>' +
      (meta.source1Url
        ? '<p class="prov__l">Manufacturer page: <a href="' + esc(meta.source1Url) +
          '" rel="nofollow noopener" target="_blank">' + esc(meta.source1Title || meta.source1Url) +
          '</a></p>' : '') +
      (conf.length
        ? '<details class="prov__d"><summary>Values where sources disagree (' + conf.length + ')</summary><ul>' +
          conf.map(function (c) {
            return '<li><b>' + esc(c.field) + '</b> — shown: ' + esc(c.value) +
              '<br>Other source: ' + esc(c.techspecs) + '</li>';
          }).join('') + '</ul></details>' : '') +
      ((meta.notes || []).length
        ? '<details class="prov__d"><summary>Data notes (' + meta.notes.length + ')</summary><ul>' +
          meta.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') +
          '</ul></details>' : '') +
      '</section>';
  }

  function variantPanelHTML(a, sel) {
    var regions = (a.axes && a.axes.region ? a.axes.region : []);
    var rLabels = {}; regions.forEach(function (r) { rLabels[r.value] = r.label; });
    var v = matchVariant(a, sel);
    var price = money(v && v.price);

    function row(label, axis, opts, labels) {
      if (!opts.length) return '';
      return '<div class="vrow"><span class="vrow__l">' + esc(label) + '</span>' +
        '<div class="vrow__o">' + chipsHTML(a, sel, axis, opts, labels) + '</div></div>';
    }

    /* The preview sits beside the controls so the choice and its consequence
       are one object rather than two panels that happen to be near each other. */
    return '<section class="vsel" id="variants">' +
      '<div class="vsel__h"><h2>Choose a variant</h2>' +
        '<span class="vsel__n">' + esc(String(inMarket(a, sel.region).length)) +
        ' combinations in this market</span></div>' +

      '<div class="vsel__body">' +
        '<div class="vsel__prev">' +
          '<img id="vshot" src="' + esc(imageFor(a, sel.color) || '') + '" alt="" ' +
            'width="150" height="200" loading="lazy" decoding="async" referrerpolicy="no-referrer" />' +
          '<span class="vsel__prevl">' + esc(sel.color || '') + '</span>' +
        '</div>' +
        '<div class="vsel__ctl">' +
          row('Market', 'region', regions.map(function (r) { return r.value; }), rLabels) +
          row('Colour', 'color', optionsFor(a, sel.region, 'color')) +
          row('RAM', 'ram', optionsFor(a, sel.region, 'ram')) +
          row('Storage', 'storage', optionsFor(a, sel.region, 'storage')) +
        '</div>' +
      '</div>' +

      '<div class="vout">' +
        '<div class="vout__cell">' +
          '<span class="vout__l">Model number</span>' +
          '<b class="vout__mn">' + esc(v ? v.modelNumber : '-') + '</b>' +
          '<i class="vout__hint">Set by the market</i>' +
        '</div>' +
        '<div class="vout__cell">' +
          '<span class="vout__l">Market</span>' +
          '<b>' + esc(v ? v.regionLabel : '-') + '</b>' +
        '</div>' +
        '<div class="vout__cell">' +
          '<span class="vout__l">Launch price' +
            (v && v.price && v.price.market ? ' · ' + esc(v.price.market) : '') + '</span>' +
          (price ? '<b class="vout__p">' + esc(price) + '</b>'
                 : '<b class="vout__na">Price not available</b>') +
        '</div>' +
      '</div>' +
      (v && v.countries ? '<p class="vsel__note"><b>Sold in</b> ' + esc(v.countries) + '</p>' : '') +
      (v && v.regionNote ? '<p class="vsel__note">' + esc(v.regionNote) + '</p>' : '') +
      (v && v.colorNote ? '<p class="vsel__note"><b>' + esc(v.color) + '</b> ' + esc(v.colorNote) + '</p>' : '') +
      (v && v.price && !price && v.price.note
        ? '<p class="vsel__note">' + esc(v.price.note) + '</p>' : '') +
      '</section>';
  }

  /* ------------------------------------------------------------------- hero

     Product shot on a clean light panel, identity on a gradient panel beside
     it. The two stay separate surfaces: a gradient running under a product
     photograph tints the product, and this catalogue's value is that the
     picture is of the actual handset.

     The banner carries only what identifies a device — name, four highlights,
     release date, five headline specs — and the actions. Market, model number,
     device type and form factor moved to the variant picker and the spec
     tables, where they belong: model number in particular is a consequence of
     the selected market, so showing it above the market control stated a fact
     the reader could not yet have chosen. */
  function heroTitle(a, m, b) {
    var brand = a.brand || m.brand || (b && b.name) || '';
    var model = a.commercialName || a.officialModelName || m.fullName || '';
    if (!brand) return model;
    /* "Apple iPhone 14", never "Apple Apple iPhone 14". */
    return model.toLowerCase().indexOf(brand.toLowerCase() + ' ') === 0
      ? model : (brand + ' ' + model).trim();
  }

  /* Five headline specs plus one dynamic extra, as a 3 x 2 grid. Icon first
     and left, then title, value, qualifier — the same shape in every cell, so
     the eye lands in the same place in all six. No per-cell border: this reads
     as one information block, not six cards. */
  function heroSpecsHTML(a) {
    var list = (a.primarySpecs || []).slice(0, 5);
    if (!list.length) return '';
    /* The sixth slot completes the grid. Left out entirely when the model has
       nothing worth putting there, rather than filled with padding. */
    if (a.additionalSpec) list = list.concat([a.additionalSpec]);
    return '<div class="hspecs">' + list.map(function (q) {
      return '<div class="hspec">' +
        '<span class="hspec__i">' + icon(q.icon || 'info') + '</span>' +
        '<span class="hspec__b">' +
          '<span class="hspec__l">' + esc(q.label) + '</span>' +
          '<b class="hspec__v">' + esc(q.value) + '</b>' +
          (q.sub ? '<i class="hspec__s">' + esc(q.sub) + '</i>' : '') +
        '</span>' +
        '</div>';
    }).join('') + '</div>';
  }

  /* Only the categories this model actually has parts in. Availability and the
     badge both come from api.getModel, which derives them from the existing
     compatibility index — nothing is recomputed or hard-coded here.

     The badge is the number of DISTINCT handsets the matching group covers, so
     "6" on Back Cover means that cover fits six phones. It is not a product
     count and it is never the trivial "1". Uses the Finder's own category
     artwork so an icon means the same thing on both pages. */
  function heroCatsHTML(m, r) {
    var cats = (r.categories || []).filter(function (c) { return c.count; });
    if (!cats.length) return '';
    return '<div class="hcats">' + cats.map(function (c) {
      var n = c.modelCount || 0;
      return '<button type="button" class="hcat" data-act="find-parts" ' +
        'data-id="' + esc(m.id) + '" data-cat="' + esc(c.category.id) + '" ' +
        'aria-label="' + esc(c.category.name) + (n ? ', fits ' + n + ' models' : '') + '" ' +
        'title="' + esc(c.category.name) + (n ? ' — this group covers ' + n + ' models' : '') + '">' +
        SM.art.category(c.category.id, 'hcat__art', c.category.name) +
        (n ? '<span class="hcat__n">' + nf(n) + '</span>' : '') +
        '</button>';
    }).join('') + '</div>';
  }

  function heroHTML(m, r, a, sel, b) {
    return '<section class="hero">' +
      '<div class="hero__media">' +
        '<img id="shot" src="' + esc(imageFor(a, sel.color) || '') + '" ' +
          'alt="' + esc(heroTitle(a, m, b)) + '" ' +
          'width="260" height="340" loading="eager" decoding="async" ' +
          'fetchpriority="high" referrerpolicy="no-referrer" />' +
      '</div>' +
      '<div class="hero__panel">' +
        '<div class="hero__brand">' +
          (brandHasMark(b) ? SM.brandLogo(b, 'blogo--lg') : '') +
          '<span>' + esc(a.brand || m.brand) + '</span>' +
        '</div>' +
        '<h1 class="hero__name">' + esc(heroTitle(a, m, b)) + '</h1>' +

        (a.releaseDateLabel || a.releaseDate
          ? '<p class="hero__rel"><span>Released</span> ' +
            esc(a.releaseDateLabel || a.releaseDate) + '</p>'
          : '') +

        heroSpecsHTML(a) +

        '<div class="hero__cta">' +
          '<button class="btn btn--primary" data-act="find-parts" data-id="' + esc(m.id) + '">' +
            icon('search') + 'Find parts for this model</button>' +
          heroCatsHTML(m, r) +
        '</div>' +
      '</div>' +
    '</section>';
  }

  /* ------------------------------------------------------------ whole page */
  function enrichedDeviceHTML(m, r, a, sel, b, compat) {
    return '<div class="dev-page dev-page--rich">' +
      '<div class="dhead"><div class="dhead__in">' +
        '<button class="btn btn--icon" data-act="dev-back" aria-label="Back">' + icon('chevronLeft') + '</button>' +
        (brandHasMark(b) ? SM.brandLogo(b, 'blogo--sm') : '') +
        '<span class="dhead__t">' + esc(a.officialModelName || m.fullName || '') + '</span>' +
        '<button class="btn btn--primary dhead__cta" data-act="find-parts" data-id="' + esc(m.id) + '">' +
          icon('search') + '<span>Find parts</span></button>' +
      '</div></div>' +

      '<div class="wrap rich">' +
        '<div class="adslot adslot--top" data-slot="top" aria-hidden="true"></div>' +

        heroHTML(m, r, a, sel, b) +

        '<div class="adslot" data-slot="after-hero" aria-hidden="true"></div>' +

        '<div id="vmount">' + variantPanelHTML(a, sel) + '</div>' +

        '<div id="smount" class="sheet-specs">' + specSheetHTML(a, sel) + '</div>' +

        sourceHTML(a) +

        '<div class="adslot" data-slot="before-related" aria-hidden="true"></div>' +

        relatedHTML(m) +

        '<section class="dcompat">' +
          '<h2 class="t-h3">Parts that fit this model</h2>' +
          '<p class="muted dcompat__p">Each group is one part that fits this device and every ' +
            'other device in the group.</p>' +
          compat +
        '</section>' +

        coverageNoteHTML() +
      '</div></div>';
  }

  /* Repaint only what the selection actually changes: the picker, the two
     header facts, the General rows and the photograph. Re-rendering the page
     would throw the reader back to the top mid-comparison. */
  function repaintVariant(a, sel) {
    var mount = document.getElementById('vmount');
    if (mount) mount.innerHTML = variantPanelHTML(a, sel);
    var sm = document.getElementById('smount');
    if (sm) sm.innerHTML = specSheetHTML(a, sel);
    var v = matchVariant(a, sel);
    var mh = document.getElementById('mhModel');
    if (mh) mh.textContent = v ? v.modelNumber : '-';
    var mk = document.getElementById('mhMarket');
    if (mk) mk.textContent = v ? v.regionLabel : '-';
    var src = imageFor(a, sel.color);
    ['#shot', '#vshot'].forEach(function (q) {
      var img = document.querySelector(q);
      if (img && src && img.getAttribute('src') !== src) img.setAttribute('src', src);
    });
  }

  /* The rupee sign as a named constant so the glyph appears once rather than
     inline in every price string. */
  var RUPEE = '₹';

  /* ------------------------------------------------------------- variants

     A variant is one build of a device: a RAM size, a storage size, sometimes a
     colour, and the price that build launched at. The catalogue carries none of
     it yet — dataset.fieldsAbsent lists ram, storage, colours, price and
     variants — so on production data every control below renders as nothing at
     all, which is the right answer for a model with one known build.

     What is here is the shape the import can pour into. Nothing is hardcoded:
     the selectors are built from whatever variants the model actually has, and
     a combination the data does not contain is never offered as selectable.

     To see the controls before the data exists, add ?preview=variants to a
     model URL. That synthesises a configuration in memory, for looking at. It
     is never persisted and never leaves the tab. */

  function variantsOf(m) { return (m.specs && m.specs.variants) || []; }
  function coloursOf(m) { return (m.specs && m.specs.colors) || []; }

  function colourAt(m, i) { return coloursOf(m)[i] || null; }
  function colourNameAt(m, i) { var c = colourAt(m, i); return c ? c.n : null; }

  /* Variants for one colour — but only when the data actually distinguishes
     them. A catalogue whose variants carry no colour field behaves exactly as
     it did before colours existed, rather than filtering everything away. */
  function variantsForColour(m, colourName) {
    var vs = variantsOf(m);
    if (!colourName) return vs;
    var tagged = vs.filter(function (v) { return v.colour != null; });
    if (!tagged.length) return vs;
    return tagged.filter(function (v) { return v.colour === colourName; });
  }

  function findVariant(m, ramGb, storageGb, colourName) {
    return variantsForColour(m, colourName).find(function (v) {
      return v.ramGb === ramGb && v.storageGb === storageGb;
    }) || null;
  }

  /* The build currently selected. Falls back to the first the data offers, so
     the page always has a coherent selection to price and to label. */
  function currentVariant(m) {
    var pool = variantsForColour(m, colourNameAt(m, state.deviceColour || 0));
    if (!pool.length) return null;
    var sel = state.deviceVariant;
    if (sel) {
      var hit = pool.find(function (v) {
        return v.ramGb === sel.ramGb && v.storageGb === sel.storageGb;
      });
      if (hit) return hit;
      /* Changing colour can land on a build that colour is not sold in. Keep
         the chosen RAM and take the nearest storage that does exist. */
      var sameRam = pool.filter(function (v) { return v.ramGb === sel.ramGb; });
      if (sameRam.length) {
        sameRam.sort(function (a, b) {
          return Math.abs(a.storageGb - sel.storageGb) - Math.abs(b.storageGb - sel.storageGb);
        });
        return sameRam[0];
      }
    }
    return pool[0];
  }

  var fmtRom = function (g) { return g >= 1024 ? (g / 1024) + ' TB' : g + ' GB'; };

  function variantLabel(v) {
    if (!v) return null;
    return join(' · ', [v.ramGb ? v.ramGb + ' GB' : null,
                        v.storageGb ? fmtRom(v.storageGb) : null,
                        v.colour || null]);
  }

  /* ---------------------------------------------------------------- price

     Never zero. The page used to print a rupee sign, a nought and the caption
     "launch price not recorded yet", which reads as a price to anyone scanning
     the number rather than the caption. A launch price is the one figure here
     that gets quoted to a customer, so an absent one says it is absent. */
  function priceOf(m, v) {
    if (v && v.priceInr) return v.priceInr;
    return (m.specs && m.specs.launchPriceInr) || null;
  }

  function priceHTML(m, v) {
    var inr = priceOf(m, v);
    if (!inr) {
      return '<div class="dprice dprice--none">' +
        '<span class="dprice__l">Launch price</span>' +
        '<span class="dprice__na">Not available</span></div>';
    }
    var lab = variantLabel(v);
    return '<div class="dprice">' +
      '<span class="dprice__l">Launch price</span>' +
      '<span class="dprice__n">' + RUPEE + nf(inr) + '</span>' +
      /* The build this price is for, in its own element: the label above is
         upper-cased, and running a colour name through that turns "Ocean Blue"
         into shouting. */
      (lab ? '<span class="dprice__v">' + esc(lab) + '</span>' : '') +
      (v && v.available === false
        ? '<span class="dprice__s">' + icon('alert') + 'Not in stock</span>' : '') +
      '</div>';
  }

  /* ---------------------------------------------------------------- images

     One list, in the order a gallery should show them: the selected build's own
     photograph first, then any colour or variant shots, then the model default.
     Deduplicated, because today those are all the same file.

     With one entry the thumbnail rail is not drawn at all — an empty strip is
     worse than no strip. */
  function deviceImageUrl(m) {
    var v = currentVariant(m);
    if (v && v.imageUrl) return v.imageUrl;
    var c = colourAt(m, state.deviceColour || 0);
    if (c && c.imageUrl) return c.imageUrl;
    return m.image || null;
  }

  function deviceImages(m) {
    var out = [], seen = {};
    function push(url, label) {
      if (!url || seen[url]) return;
      seen[url] = 1;
      out.push({ url: url, label: label || m.fullName });
    }
    push(deviceImageUrl(m), m.fullName);
    coloursOf(m).forEach(function (c) { push(c.imageUrl, c.n); });
    variantsOf(m).forEach(function (v) { push(v.imageUrl, variantLabel(v)); });
    push(m.image, m.fullName);
    return out;
  }

  function galleryHTML(m) {
    var shots = deviceImages(m);
    var active = state.deviceShot || 0;
    if (active >= shots.length) active = 0;
    var main = shots[active] || { url: null, label: m.fullName };

    return '<div class="dgal">' +
      '<div class="dgal__main" id="devShot">' +
        SM.art.photo(m, { src: main.url, colourIdx: state.deviceColour || 0,
                          eager: true, alt: main.label }) +
      '</div>' +
      (shots.length > 1
        ? '<div class="dgal__rail">' + shots.map(function (s, i) {
            return '<button type="button" class="dthumb' + (i === active ? ' is-on' : '') + '" ' +
              'data-act="dev-shot" data-i="' + i + '" aria-pressed="' + (i === active) + '" ' +
              'title="' + esc(s.label) + '">' +
              SM.art.photo(m, { src: s.url, colourIdx: state.deviceColour || 0, alt: s.label }) +
              '</button>';
          }).join('') + '</div>'
        : '') +
      '</div>';
  }

  /* --------------------------------------------------------- the selectors

     Three rows, each drawn only when the data has more than one thing to
     choose between. A single-colour, single-build device gets no controls at
     all rather than a row containing one disabled chip. */
  function chipHTML(kind, value, label, on, enabled) {
    return '<button type="button" class="vchip' + (on ? ' is-on' : '') + '" ' +
      'data-act="pick-variant" data-kind="' + kind + '" data-value="' + esc(value) + '" ' +
      (enabled ? '' : 'disabled ') +
      'aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(label) + '</button>';
  }

  function colourRowHTML(m) {
    var cs = coloursOf(m);
    if (cs.length < 2) return '';
    var ci = state.deviceColour || 0;
    return '<div class="vpick__row">' +
      '<span class="vpick__l">Colour</span>' +
      '<div class="vpick__chips dsw__row">' + cs.map(function (c, i) {
        return '<button type="button" class="dsw' + (i === ci ? ' is-on' : '') + '" ' +
          'data-act="dev-colour" data-i="' + i + '" style="--sw:' + esc(c.h) + '" ' +
          'title="' + esc(c.n) + '" aria-label="' + esc(c.n) + '"' +
          (i === ci ? ' aria-current="true"' : '') + '></button>';
      }).join('') + '</div>' +
      '<span class="vpick__name">' + esc(cs[ci] ? cs[ci].n : '') + '</span></div>';
  }

  function variantPickerHTML(m) {
    var colour = colourNameAt(m, state.deviceColour || 0);
    var pool = variantsForColour(m, colour);
    var cur = currentVariant(m);
    var uniq = function (key) {
      return Array.from(new Set(pool.map(function (v) { return v[key]; })))
        .filter(function (x) { return x != null; })
        .sort(function (a, b) { return a - b; });
    };
    var rams = uniq('ramGb');
    var roms = uniq('storageGb');

    var rowsHTML = colourRowHTML(m) +
      (rams.length > 1
        ? '<div class="vpick__row"><span class="vpick__l">RAM</span><div class="vpick__chips">' +
          rams.map(function (r) {
            return chipHTML('ram', r, r + ' GB', !!(cur && cur.ramGb === r), true);
          }).join('') + '</div></div>'
        : '') +
      (roms.length > 1
        ? '<div class="vpick__row"><span class="vpick__l">Storage</span><div class="vpick__chips">' +
          roms.map(function (g) {
            /* A storage the chosen RAM is not sold with is shown, disabled.
               Hiding it would make the row jump on every RAM click, and the
               absence is information: that pair is not a phone anyone makes. */
            var ok = !!(cur && findVariant(m, cur.ramGb, g, colour));
            return chipHTML('storage', g, fmtRom(g), !!(cur && cur.storageGb === g), ok);
          }).join('') + '</div></div>'
        : '');

    return rowsHTML ? '<div class="vpick">' + rowsHTML + '</div>' : '';
  }

  /* ------------------------------------------------- development preview

     Runs only with ?preview=variants on the URL. Builds a configuration in
     memory so the selectors, the price switching and the colour-to-image path
     can be looked at before the import that supplies them exists. Deterministic
     from the model id, so a reload shows the same thing.

     Never written to Firestore, never sent anywhere, never runs without the
     flag. The brief asks for the architecture now and for no invented values in
     production; this is how both hold at once. */
  function previewVariants(m) {
    if (!/[?&]preview=variants/.test(location.search)) return m;
    if (m.__preview) return m;

    var seed = 0, src = String(m.id);
    for (var i = 0; i < src.length; i++) seed = (seed * 31 + src.charCodeAt(i)) >>> 0;
    var pick = function (arr, shift) { return arr[(seed >> shift) % arr.length]; };

    var COLOURS = [{ n: 'Midnight', h: '#15171A' }, { n: 'Ocean Blue', h: '#1F4E79' },
                   { n: 'Mint', h: '#8FD3B6' }, { n: 'Starlight', h: '#EDE7DC' }];
    var rams = pick([[4, 6, 8], [6, 8, 12], [8, 12]], 2);
    var roms = pick([[64, 128, 256], [128, 256], [128, 256, 512]], 5);
    var base = 8000 + (seed % 40) * 750;
    var colors = COLOURS.slice(0, 2 + (seed % 3));

    var variants = [];
    colors.forEach(function (c) {
      rams.forEach(function (r, ri) {
        roms.forEach(function (g, gi) {
          /* Not every pair is sold — that is the whole point of a matrix. */
          if (ri === 0 && gi === roms.length - 1) return;
          variants.push({
            variantId: m.id + '-' + r + '-' + g + '-' + c.n.toLowerCase().replace(/\s+/g, '-'),
            ramGb: r, storageGb: g, colour: c.n,
            priceInr: base + ri * 2500 + gi * 2000,
            available: !(ri === rams.length - 1 && gi === 0),
            imageUrl: null
          });
        });
      });
    });

    var clone = Object.assign({}, m);
    clone.specs = Object.assign({}, m.specs, {
      colors: colors, variants: variants,
      ramVariantsGb: rams, storageVariantsGb: roms, launchPriceInr: base
    });
    clone.__preview = true;
    return clone;
  }

  /* ------------------------------------------------------------ identity

     Brand line, then the full model name. The export usually stores the name
     with the brand already on the front — "Apple iPad Air 13 (2026)" — and
     sometimes without it: Coolpad's rows are "C35". Printing brand + name
     blindly gives "Apple Apple iPad Air 13 (2026)" on the first and the right
     answer on the second, so the prefix is checked rather than assumed. */
  /* SM.brandLogo has three tiers: a logo file, a vector mark, and — when the
     brand has neither — the brand's own name set as a wordmark. That last one
     is already the name, so printing the name beside it gives "CoolpadCoolpad".
     Ask which tier came back before adding a text line to it. */
  function brandHasMark(b) {
    return !!((SM.brandFiles && SM.brandFiles[b.id]) ||
              (SM.brandMarks && SM.brandMarks[b.id]));
  }

  function deviceTitle(m) {
    var brand = m.brand || '';
    var name = m.fullName || m.modelName || '';
    if (!brand) return name;
    var lower = name.toLowerCase(), bl = brand.toLowerCase();
    if (lower === bl || lower.indexOf(bl + ' ') === 0) return name;
    return brand + ' ' + name;
  }

  /* Swap only what a selection changed: the photograph and its rail, the
     price, and which chips are lit. Re-rendering the page would throw away the
     reader's scroll position halfway down the spec column, which is exactly
     where someone comparing two builds is standing. */
  function repaintDevice(m) {
    var media = document.querySelector('.dv3__media');
    if (media) media.innerHTML = galleryHTML(m);

    var price = document.querySelector('.dprice');
    if (price) price.outerHTML = priceHTML(m, currentVariant(m));

    var pick = document.querySelector('.vpick');
    var next = variantPickerHTML(m);
    if (pick && next) pick.outerHTML = next;
  }

  function renderDevice(page, id) {
    page.innerHTML = '<div class="wrap dev-page">' + C.skelRows(5) + '</div>';

    if (state.deviceId !== id) {
      state.deviceId = id;
      state.deviceColour = 0;
      state.deviceVariant = null;
      state.deviceShot = 0;
    }

    /* Both requests go out together. Fetching the enriched record after the
       first paint meant the page rebuilt itself under the reader a moment
       after it appeared, which moved the scroll position and read as jank. */
    Promise.all([api.getModel(id), loadActive(id)]).catch(function () {
      /* A failure here is a dead page, so it falls back to the model list
         rather than leaving the skeleton on screen for ever. */
      return [null, null];
    }).then(function (res) {
      var r = res[0], active = res[1];
      if (!r) { go('/models'); return; }
      var m = previewVariants(r.model);
      var b = db.brandById[m.brandId] || { id: m.brandId, name: m.brand };
      var sp = m.specs;
      var cur = currentVariant(m);
      var title = deviceTitle(m);

      var rear = sp.cameraRear || [];
      var mainCam = rear[0] || { mp: 0 };
      var ramTxt = (sp.ramVariantsGb || []).length ? sp.ramVariantsGb.join(' / ') + ' GB' : null;
      var romTxt = (sp.storageVariantsGb || []).length
        ? sp.storageVariantsGb.map(fmtRom).join(' / ') : null;

      /* The selected build wins over the range: once someone has picked 8 GB,
         "8 GB" is more use to them than "6 / 8 / 12 GB". */
      var ramNow = cur && cur.ramGb ? cur.ramGb + ' GB' : ramTxt;
      var romNow = cur && cur.storageGb ? fmtRom(cur.storageGb) : romTxt;

      var compat = r.groupCount
        ? '<div class="cats">' + r.categories.filter(function (c) { return c.count; }).map(function (c) {
            return C.categoryCard(c.category, c.count, { act: 'find-with-cat' });
          }).join('') + '</div>'
        : '<div class="notice">' + icon('alert') +
          '<span>No compatibility group covers this model yet.</span></div>';

      /* A migrated model gets the full spec-database layout. The compatibility
         block is passed straight through unchanged — the Device Finder's data
         is not touched by any of this. */
      if (active) {
        state.active = active;
        state.vsel = defaultSelection(active);
        page.innerHTML = enrichedDeviceHTML(m, r, active, state.vsel, b, compat);
        window.scrollTo({ top: 0, behavior: 'auto' });
        return;
      }

      page.innerHTML =
        '<div class="dev-page">' +

        /* ---- sticky head: identity stays visible through a long spec sheet -- */
        '<div class="dhead">' +
          '<div class="dhead__in">' +
            '<button class="btn btn--icon" data-act="dev-back" aria-label="Back">' + icon('chevronLeft') + '</button>' +
            (brandHasMark(b) ? SM.brandLogo(b, 'blogo--sm') : '') +
            '<span class="dhead__t">' + esc(title) + '</span>' +
            '<button class="btn btn--primary dhead__cta" data-act="find-parts" data-id="' + esc(m.id) + '">' +
              icon('search') + '<span>Find parts</span></button>' +
          '</div>' +
        '</div>' +

        '<div class="wrap">' +

          /* -------------------------------------------------- three columns

             Photograph, identity, specifications. The photograph is the widest
             because it is the only column whose content cannot be summarised,
             and it is sticky because it is what the other two columns are
             about: scrolling a spec sheet with the handset still on screen is
             the point of the layout. The spec column is the long one, so
             sticking THAT would just pin a panel that wants to scroll. */
          '<div class="dv3">' +

            '<div class="dv3__media">' + galleryHTML(m) + '</div>' +

            '<div class="dv3__id">' +
              '<div class="did__brand">' + SM.brandLogo(b, 'blogo--sm') +
                (brandHasMark(b) ? '<span>' + esc(m.brand || b.name) + '</span>' : '') +
              '</div>' +
              '<h1 class="did__name">' + esc(title) + '</h1>' +

              '<div class="did__meta">' +
                (m.releaseDate
                  ? '<span class="dmeta">' + icon('calendar') + esc(m.releaseDate) + '</span>' : '') +
                (m.releaseStatus && m.releaseStatus !== 'available'
                  ? '<span class="dmeta">' + icon('alert') +
                    esc(m.releaseStatus.replace(/_/g, ' ')) + '</span>' : '') +
                (m.deviceType
                  ? '<span class="dmeta">' + icon('phone') + esc(m.deviceType) + '</span>' : '') +
              '</div>' +

              priceHTML(m, cur) +

              /* Highlights: the six numbers a counter reads before quoting.
                 keySpecHTML drops anything null, so a sparse device shows four
                 cards rather than four cards and four blanks. */
              '<div class="dkeys">' +
                keySpecHTML('calendar', 'Released', m.releaseDate,
                  m.releaseYear ? String(m.releaseYear) : null) +
                keySpecHTML('phone', 'Display', m.displaySize ? m.displaySize + '"' : null,
                  join(' · ', [m.screenResolution, m.screenType])) +
                keySpecHTML('battery', 'Battery', sp.batteryMah ? nf(sp.batteryMah) + ' mAh' : null,
                  sp.chargingWatts ? sp.chargingWatts + 'W charging' : null) +
                keySpecHTML('ruler', 'Body', join(' × ', [m.height, m.width]),
                  m.screenCm2 ? m.screenCm2 + ' cm² screen' : null) +
                keySpecHTML('cpu', 'Processor', sp.chipset, join(' · ', [sp.cpu, sp.gpu])) +
                keySpecHTML('layers', 'Memory', ramNow, romNow) +
                keySpecHTML('camera', 'Main camera', mainCam.mp ? mainCam.mp + ' MP' : null,
                  rear.length ? rear.length + ' rear' : null) +
              '</div>' +

              variantPickerHTML(m) +

              '<div class="did__cta">' +
                /* The stable model id, never the displayed name: two catalogues
                   can hold a "C35" and only one of them is this one. */
                '<button class="btn btn--primary btn--lg" data-act="find-parts" data-id="' + esc(m.id) + '">' +
                  icon('search') + 'Find parts for this model</button>' +
                (r.groupCount
                  ? '<span class="did__note">' + nf(r.groupCount) + ' compatibility group' +
                    (r.groupCount === 1 ? '' : 's') + '</span>'
                  : '') +
              '</div>' +
            '</div>' +

            '<div class="dv3__specs">' +
              '<h2 class="dv3__h">Specifications</h2>' +
              specBlockHTML('Display', 'phone', [
                ['Size', m.displaySize ? m.displaySize + ' inches' : null, IMPORTED],
                ['Resolution', m.screenResolution],
                ['Type', m.screenType],
                ['Refresh rate', m.refreshRate],
                ['Pixel density', m.ppi],
                ['Aspect ratio', m.screenRatio],
                ['Protection', m.protection]
              ]) +
              specBlockHTML('Body', 'ruler', [
                ['Height', m.height, IMPORTED],
                ['Width', m.width, IMPORTED],
                ['Thickness', m.thickness],
                ['Weight', m.weight],
                ['Screen area', m.screenCm2 ? m.screenCm2 + ' cm²' : null, IMPORTED],
                ['Body ratio', m.bodyRatio ? m.bodyRatio + '%' : null, IMPORTED],
                ['Colours', coloursOf(m).length
                  ? coloursOf(m).map(function (c) { return c.n; }).join(', ') : null]
              ], SM.art.photo(m, { src: deviceImageUrl(m), colourIdx: state.deviceColour || 0,
                                   alt: '', cls: 'dphoto--mini' })) +
              specBlockHTML('Battery & charging', 'battery', [
                ['Capacity', sp.batteryMah ? nf(sp.batteryMah) + ' mAh' : null, IMPORTED],
                /* The manufacturer's own battery code, from the category export.
                   The flag says whether the owner has checked it, because an
                   unverified code is still worth showing and still worth
                   labelling as unverified. */
                ['Battery part number', m.batteryPartNo
                  ? m.batteryPartNo + (m.batteryPartVerified ? ' (verified)' : ' (unverified)')
                  : null],
                ['Type', sp.batteryType],
                ['Wired charging', sp.chargingWatts ? sp.chargingWatts + 'W' : null],
                ['Wireless charging', sp.wirelessCharging == null ? null
                  : (sp.wirelessCharging ? 'Supported' : 'Not supported')]
              ]) +
              specBlockHTML('Memory', 'layers', [
                ['RAM', ramTxt],
                ['Storage', romTxt],
                ['Expandable', sp.expandable == null ? null
                  : (sp.expandable ? 'microSD supported' : 'Not expandable')]
              ]) +
              specBlockHTML('Performance', 'cpu', [
                ['Chipset', sp.chipset],
                ['CPU', sp.cpu],
                ['GPU', sp.gpu],
                ['Process', sp.fabrication]
              ]) +
              /* Every row tolerates a null: this column has to render for a
                 catalogue carrying only names and dimensions as readily as for
                 one with a full sheet. specBlockHTML drops null rows and omits
                 a section that ends up with none. */
              specBlockHTML('Camera', 'camera', rear.map(function (c) {
                return [c.role, c.mp + ' MP · ' + c.aperture + (c.ois ? ' · OIS' : '')];
              }).concat([
                ['Front camera', sp.cameraFront
                  ? sp.cameraFront.mp + ' MP · ' + sp.cameraFront.aperture : null],
                ['Video', sp.videoMax]
              ])) +
              specBlockHTML('Software', 'sparkle', [
                ['Operating system', sp.os ? sp.os + ' ' + (sp.osVersion || '') : null],
                ['Interface', sp.skin]
              ]) +
              specBlockHTML('Network & connectivity', 'signal', [
                ['Network', sp.networkDetail || sp.network],
                ['SIM', m.sim],
                ['Wi-Fi', sp.wifi],
                ['Bluetooth', sp.bluetooth],
                ['NFC', sp.nfc == null ? null : (sp.nfc ? 'Yes' : 'No')],
                ['USB', sp.usb],
                ['Headphone jack', sp.headphoneJack == null ? null
                  : (sp.headphoneJack ? '3.5 mm' : 'None')]
              ]) +
              specBlockHTML('Sensors', 'shield', [
                ['Sensors', sp.sensors ? sp.sensors.join(', ') : null]
              ]) +
              /* General closes the column. It carries the release facts that
                 used to sit in a "Source" block alongside a link to the site the
                 data was imported from — which is an internal provenance note,
                 not something a visitor came here for. The link is gone from
                 the page; the field stays in the record for the admin tools. */
              specBlockHTML('General', 'info', [
                ['Released', m.releaseDate, IMPORTED],
                ['Availability', m.releaseStatus && m.releaseStatus !== 'available'
                  ? m.releaseStatus.replace(/_/g, ' ') : null],
                ['Device type', m.deviceType
                  ? m.deviceType + (m.typeDerived ? ' (read from the model name)' : '') : null]
              ]) +
            '</div>' +
          '</div>' +

          /* ------------------------------------------------------ compatibility */
          '<section class="dcompat">' +
            '<h2 class="t-h3">Parts that fit this model</h2>' +
            '<p class="muted dcompat__p">Each group is one part that fits this device and every ' +
              'other device in the group.</p>' +
            compat +
          '</section>' +

          coverageNoteHTML() +
        '</div></div>';

      window.scrollTo({ top: 0, behavior: 'auto' });
    });
  }

  /* ------------------------------------------------------------- the sheet

     Every overlay in the app is this shape, and until now the function that
     drew it did not exist. renderSheet called paintSheet in seven places and
     nothing declared it, so opening the filters, the installer, the share
     card, the country picker, a model card — or Edit shop profile, which is on
     the account page this work is about — threw
     "ReferenceError: paintSheet is not defined" and left the overlay empty.
     The button appeared to do nothing at all.

     The markup is the one assets/components.css was already written for
     (.scrim / .sheet / .sheet__grab / .sheet__head / .sheet__body /
     .sheet__foot), which is also the skeleton renderSheet paints while a model
     loads — so this restores the intended structure rather than inventing a
     second one.

     @param {Element} host       the #overlay element
     @param {string}  title      heading; plain text unless richTitle is set
     @param {string}  body       inner HTML for the scrolling middle
     @param {string} [foot]      footer buttons; the footer is omitted without it
     @param {boolean}[richTitle] the title is already HTML and must not be
                                 escaped — used by the model sheet, which puts a
                                 brand logo and two lines in the heading */
  function paintSheet(host, title, body, foot, richTitle) {
    if (!host) return;
    host.innerHTML =
      '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true">' +
        '<div class="sheet__grab" aria-hidden="true"></div>' +
        '<div class="sheet__head">' +
          '<div class="grow" style="min-width:0">' +
            (richTitle ? title : '<h2 class="t-h3" style="margin:0">' + esc(title) + '</h2>') +
          '</div>' +
          '<button class="btn btn--ghost btn--icon" data-act="close-sheet" ' +
            'aria-label="Close">' + icon('close') + '</button>' +
        '</div>' +
        '<div class="sheet__body">' + body + '</div>' +
        (foot ? '<div class="sheet__foot">' + foot + '</div>' : '') +
      '</div>';
  }

  function renderSheet() {
    var host = document.getElementById('overlay');
    var s = state.sheet;
    if (!s) { host.innerHTML = ''; document.body.style.overflow = ''; return; }
    document.body.style.overflow = 'hidden';

    /* ------------------------------------------------- the in-app browser

       Shown when the visitor arrived from Instagram, Facebook, Messenger or
       anything else hosting a WebView, and only when they reach for Google
       sign-in. It is not shown on arrival: most of the site works perfectly
       well in an embedded browser, and interrupting someone who came to look
       up a part in order to talk about browsers would be worse than the
       problem.

       It is the app's own sheet, in the app's own components — no new design
       language, no full-screen takeover. */
    if (s.type === 'inapp') {
      var appName = (SM.env && SM.env.inAppName()) || 'this app';
      var onIOS = !!(SM.env && SM.env.isIOS());
      return paintSheet(host, 'Open in your browser',
        '<div class="stack" style="gap:14px">' +
          '<div class="row" style="gap:12px;align-items:flex-start">' +
            '<span style="color:var(--teal-700);flex:none;margin-top:2px">' + icon('shield') + '</span>' +
            '<p class="t-sub" style="margin:0">For secure Google sign-in, please open ' +
            'Mobile Parts Finder in ' + (onIOS ? 'Safari or Google Chrome' : 'Google Chrome') +
            '. Google does not allow sign-in inside ' + esc(appName) + '&rsquo;s built-in browser.</p>' +
          '</div>' +
          '<div class="notice">' + icon('info') +
          '<span>Everything else — search, compatibility groups and part codes — ' +
          'works here. Only sign-in needs the full browser.</span></div>' +
        '</div>',
        '<button class="btn btn--outline" data-act="inapp-stay">Continue here</button>' +
        '<button class="btn btn--primary grow" data-act="inapp-open">' +
          icon('linkOut') + (onIOS ? 'Open in browser' : 'Open in Google Chrome') + '</button>');
    }

    /* A category that is in the catalogue but has no compatibility groups yet.

       It is the app's own sheet, built from the app's own components — the
       same scrim, the same card, the same pill and notice the install and
       in-app sheets use. Nothing new is designed for it.

       It shows the part's own photograph and says plainly that the matching
       data is not there. It does NOT show an empty group list, a zero count,
       or a row of placeholder products: a category that offers nothing and
       admits it is honest, and one that offers nothing while looking like it
       offers something is not. */
    if (s.type === 'comingsoon') {
      var sc = db.categoryById[s.catId];
      if (!sc) { state.sheet = null; return renderSheet(); }
      return paintSheet(host,
        '<div class="row" style="gap:9px;flex-wrap:wrap">' +
        '<span class="pill pill--brand">' + icon('sparkle') + 'Coming Soon</span></div>',
        '<div class="stack" style="gap:14px">' +
        '<div class="row" style="gap:12px;align-items:center">' +
        /* The same call every other surface makes, at the plate size the group
           cards already use — so the reader is shown the actual part, not a
           44px identifier chip, and no new picture component is introduced. */
        SM.art.category(sc.id, 'pthumb--plate', sc.name, { eager: true }) +
        '<div style="min-width:0">' +
        '<h3 class="t-h3" style="margin:0">' + esc(sc.name) + '</h3>' +
        '<p class="t-sub" style="margin-top:4px">This part category is in the ' +
        'catalogue, and its compatibility groups are still being collected.</p>' +
        '</div></div>' +
        '<div class="notice">' + icon('info') +
        '<span>Nothing is shown here yet rather than a list that would be ' +
        'wrong at the counter. Every other category is unaffected — close ' +
        'this and carry on.</span></div>' +
        '</div>',
        '<button class="btn btn--primary btn--block" data-act="close-sheet">Got it</button>',
        true);
    }

    if (s.type === 'filters') return paintSheet(host, 'Filter groups', categoryPanelHTML() + brandPanelHTML(),
      '<button class="btn btn--outline grow" data-act="reset-filters">Reset</button>' +
      '<button class="btn btn--primary grow" data-act="close-sheet">Show ' + nf(state.finder.total) + ' groups</button>');

    /* Shown once, straight after the profile is saved. It exists because the
       previous behaviour was to redirect: the account was created and the user
       was thrown to the Finder, with nothing confirming what had been stored or
       that they were now signed in. Staying put and showing the record is the
       reassurance that step needs, and navigation stays theirs. */
    if (s.type === 'welcome') {
      var w = S.get();
      var rows = [
        ['Google account', w.email],
        ['Mobile shop name', w.shopName],
        ['Proprietor', w.proprietor],
        ['Mobile', w.mobile]
      ].filter(function (r) { return r[1]; });

      return paintSheet(host,
        '<div class="row" style="gap:9px;flex-wrap:wrap">' +
        '<span class="pill pill--ok">' + icon('checkCircle') + 'Account created</span></div>',
        '<div class="stack" style="gap:14px">' +
        '<div>' +
        '<h3 class="t-h3" style="margin:0">You are signed in</h3>' +
        '<p class="t-sub" style="margin-top:6px">Your shop details are saved to your ' +
        'Google account, so they follow you to every device at the counter.</p>' +
        '</div>' +
        '<div class="idgrid" style="grid-template-columns:repeat(1,minmax(0,1fr))">' +
        rows.map(function (r) {
          return '<div class="idcell"><span>' + esc(r[0]) + '</span>' +
            '<b style="font-family:var(--f-ui);font-size:14px;word-break:break-word">' +
            esc(r[1]) + '</b></div>';
        }).join('') +
        '</div></div>',
        '<button class="btn btn--outline" data-act="close-sheet">Close</button>' +
        '<button class="btn btn--primary grow" data-act="welcome-continue">' +
        'Continue' + icon('arrowRight') + '</button>',
        true);
    }

    /* Install. Two shapes: a button where the browser has actually offered,
       and instructions where it never will. Never a mock of the system
       dialog — a site that imitates browser chrome teaches people to trust
       imitations of browser chrome. */
    if (s.type === 'install') {
      var canPrompt = SM.pwa && SM.pwa.canInstall();
      var ios = SM.pwa && SM.pwa.isIOS();
      var why =
        '<div class="stack" style="gap:12px">' +
        '<div class="row" style="gap:12px;align-items:center">' +
        SM.logoMark(44) +
        '<div><h3 class="t-h3" style="margin:0">Install Mobile Parts Finder</h3>' +
        '<p class="t-sub" style="margin-top:4px">Keep it on your home screen for a faster, ' +
        'app-like way to look parts up at the counter.</p></div></div>' +
        '<ul class="stack" style="gap:8px;list-style:none;padding:0;margin:0">' +
        ['Opens full screen, without the browser bar',
         'One tap from the home screen — no typing the address',
         'Stays signed in on this device'].map(function (t) {
          return '<li class="row" style="gap:8px;align-items:flex-start">' +
            '<span style="color:var(--teal-700);flex:none;margin-top:1px">' + icon('checkCircle') + '</span>' +
            '<span class="t-sub" style="margin:0">' + esc(t) + '</span></li>';
        }).join('') +
        '</ul>' +
        (canPrompt ? '' :
          '<div class="notice notice--amber">' + icon('info') + '<span>' +
          (ios
            ? 'On iPhone and iPad, tap <b>Share</b> in the browser bar, then ' +
              '<b>Add to Home Screen</b>. Safari is the only route Apple allows.'
            : 'Your browser has not offered an install for this site yet. Look for ' +
              '<b>Install app</b> or <b>Add to Home screen</b> in the browser menu.') +
          '</span></div>') +
        '</div>';

      return paintSheet(host, 'Install app', why,
        '<button class="btn btn--outline" data-act="install-later">Not now</button>' +
        (canPrompt
          ? '<button class="btn btn--primary grow" data-act="pwa-install-go">' +
            icon('install') + 'Install now</button>'
          : '<button class="btn btn--primary grow" data-act="close-sheet">Got it</button>'));
    }

    /* Share, for browsers with no share sheet of their own. Reached only when
       navigator.share is absent or refused — where it exists, the phone's own
       sheet opens and this is never built. */
    if (s.type === 'share') {
      var d = SM.pwa.shareData();
      var u = encodeURIComponent(d.url);
      var txt = encodeURIComponent(d.text);
      var targets = [
        ['WhatsApp', 'https://wa.me/?text=' + encodeURIComponent(d.text + ' ' + d.url), 'chat'],
        ['X', 'https://twitter.com/intent/tweet?url=' + u + '&text=' + txt, 'sparkle'],
        ['Facebook', 'https://www.facebook.com/sharer/sharer.php?u=' + u, 'grid'],
        ['Email', 'mailto:?subject=' + encodeURIComponent(d.title) + '&body=' + txt + '%0A%0A' + u, 'mail']
      ];
      return paintSheet(host, 'Share Mobile Parts Finder',
        '<div class="stack" style="gap:12px">' +
        '<p class="t-sub" style="margin:0">' + esc(d.text) + '</p>' +
        '<div class="field"><input class="input" id="shareUrl" readonly value="' + esc(d.url) + '" ' +
        'aria-label="Link to Mobile Parts Finder" style="padding-left:12px" /></div>' +
        '<button class="btn btn--soft btn--block" data-act="share-copy">' + icon('copy') + 'Copy link</button>' +
        '<div class="sharegrid">' +
        targets.map(function (t) {
          return '<a class="sharetile" href="' + t[1] + '" target="_blank" rel="noopener noreferrer">' +
            icon(t[2]) + '<span>' + esc(t[0]) + '</span></a>';
        }).join('') +
        '</div></div>',
        '<button class="btn btn--outline btn--block" data-act="close-sheet">Close</button>');
    }

    if (s.type === 'editprofile') {
      return paintSheet(host, 'Edit shop profile', editSheetHTML(),
        '<button class="btn btn--outline" data-act="close-sheet">Cancel</button>' +
        '<button class="btn btn--primary grow" data-act="save-profile">' + icon('check') + 'Save changes</button>');
    }

    if (s.type === 'country') {
      paintSheet(host, 'Select country',
        '<label class="field" style="margin-bottom:10px">' + icon('search') +
        '<input class="input" id="countryq" placeholder="Search countries…" autocomplete="off" aria-label="Search countries" /></label>' +
        '<div class="clist" id="countryRows">' + countryRowsHTML('') + '</div>', '');
      setTimeout(function () { var i = document.getElementById('countryq'); if (i) i.focus(); }, 60);
      return;
    }


    if (s.type === 'model') {
      host.innerHTML = '<div class="scrim" data-act="close-sheet"></div><div class="sheet"><div class="sheet__grab"></div>' +
        '<div class="sheet__head"><div class="skel" style="height:22px;width:60%"></div></div>' +
        '<div class="sheet__body">' + C.skelRows(4) + '</div></div>';
      api.getModel(s.id).then(function (r) {
        if (!r) { closeSheet(); return; }
        var m = r.model, b = db.brandById[m.brandId];
        var body = C.specSheet(m) +
          '<div><span class="t-lab" style="display:block;margin-bottom:9px">Part groups containing this model</span>' +
          (r.groupCount
            ? '<div class="cats">' + r.categories.filter(function (c) { return c.count; }).map(function (c) {
              return C.categoryCard(c.category, c.count, { act: 'find-with-cat' });
            }).join('') + '</div>'
            : '<div class="notice">' + icon('alert') + '<span>No compatibility group covers this model yet.</span></div>') +
          '</div>';
        paintSheet(host,
          '<div class="row" style="gap:10px">' + SM.brandLogo(b) +
          '<div><div class="t-h3">' + esc(m.fullName) + '</div>' +
          '<div class="t-xs muted">' + esc(m.brand) + ' · ' + esc(m.releaseDate) + '</div></div></div>',
          body,
          '<button class="btn btn--outline" data-act="close-sheet">Close</button>' +
          '<button class="btn btn--primary grow" data-act="find-parts" data-id="' + m.id + '">' + icon('search') + 'Find parts for this model</button>',
          true);
      });
      return;
    }


  }


  /* ==========================================================================
     SUGGESTIONS
     ========================================================================== */
  var sugTimer = null;
  function onQuery(v, input) {
    state.finder.query = v;
    clearTimeout(sugTimer);
    var box = suggestSlot(input || activeSearch());
    if (!box) return;
    state.suggest.box = box;
    /* typing immediately replaces recents with live database matches */
    if (!v.trim()) { showIdle(box); return; }
    sugTimer = setTimeout(function () {
      api.suggestModels(v, 8).then(function (items) {
        if (state.finder.query !== v) return;
        state.suggest = { open: true, q: v, items: items, cursor: -1, mode: 'results', box: box };
        paintSuggest();

        /* The result count is known here and nowhere else, which is what makes
           a zero-result search recordable at all. trackSearch debounces again
           on its own, so a burst of keystrokes becomes one event carrying the
           final term rather than one per letter. */
        if (SM.analytics) {
          SM.analytics.trackSearch(v, {
            searchType: 'model',
            matchedResultCount: items.length
          });
        }
      });
    }, 110);
  }

  /* focused + empty: the user's recent searches, or the default list when
     there is no history yet */
  function showIdle(box) {
    var items = recentModels();
    var mode = items.length ? 'recent' : 'popular';
    if (!items.length) items = db.modelsRanked.slice(0, 6);
    state.suggest = {
      open: true, q: '', items: items, cursor: -1, mode: mode,
      box: box || suggestSlot(activeSearch())
    };
    paintSuggest();
  }
  function paintSuggest() {
    var s = state.suggest;
    var box = s.box && document.contains(s.box) ? s.box : suggestSlot(activeSearch());
    if (!box) return;
    /* never leave a stale dropdown open in the other search box */
    document.querySelectorAll('.suggest-slot').forEach(function (el) { if (el !== box) el.innerHTML = ''; });
    if (!s.open) { box.innerHTML = ''; return; }
    if (!s.items.length) {
      box.innerHTML = '<div class="suggest">' + C.state({
        icon: 'search', title: 'No model called “' + s.q + '”',
        text: 'Try the series instead — “A55”, “Note 13”, “Reno 12”. The database has ' + nf(db.stats.models) + ' sample models.'
      }) + '</div>';
      return;
    }
    var heading = s.q
      ? s.items.length + (s.items.length === 1 ? ' matching model' : ' matching models')
      : (s.mode === 'recent' ? 'Recent searches' : 'Most looked-up models');
    box.innerHTML = '<div class="suggest">' +
      '<div class="suggest__head"><span class="t-lab">' + heading + '</span>' +
      '<span class="t-xs muted">↑↓ to move · Enter to select</span></div>' +
      s.items.map(function (m, i) {
        return C.suggestion(m, s.q, i === s.cursor, { recent: s.mode === 'recent' });
      }).join('') +
      '</div>';
    fitSuggest(box);
  }
  /* Cap the panel to the space actually left on screen, reserving the fixed
     bottom tab bar on mobile so the last result is never hidden under it. */
  function fitSuggest(box) {
    var panel = box && box.querySelector('.suggest');
    if (!panel) return;
    /* the tab bar is position:fixed, so offsetParent is always null on it —
       check computed display instead */
    var tabbar = document.getElementById('tabbar');
    var reserve = (tabbar && getComputedStyle(tabbar).display !== 'none')
      ? tabbar.getBoundingClientRect().height + 12
      : 16;
    var top = panel.getBoundingClientRect().top;
    panel.style.maxHeight = Math.max(180, Math.round(window.innerHeight - top - reserve)) + 'px';
  }

  function closeSuggest() {
    state.suggest.open = false;
    document.querySelectorAll('.suggest-slot').forEach(function (el) { el.innerHTML = ''; });
  }

  /* ==========================================================================
     ACTIONS
     ========================================================================== */
  /* Both search boxes mirror state.finder.query. `force` also overwrites the
     focused box — used when the app itself sets the term (picking a model,
     clearing the selection), as opposed to passive background syncing. */
  function syncSearchInputs(force) {
    ['q', 'qh'].forEach(function (idn) {
      var el = document.getElementById(idn);
      if (!el) return;
      if (!force && document.activeElement === el) return;
      if (el.value !== state.finder.query) { el.value = state.finder.query; syncClearBtn(el); }
    });
  }

  /* ------------------------------------------------------- the metered search

     THE ONE PLACE A FREE SEARCH IS SPENT.

     pickModel is called when a search is actually RUN — a suggestion clicked,
     enter pressed on a real result, a recent search reopened, "find parts for
     master model". Typing does not reach here: onQuery fetches suggestions and
     never calls this, so "samsung galaxy m21" costs one credit rather than
     eighteen, and a user who types and gives up spends nothing.

     The server counts the credit against the uid. This function's refusal is
     the courteous half — the POST is what actually meters, and a browser that
     skipped it would find the next one refused anyway. */
  /**
   * THE ONLY WAY A MODEL SEARCH RUNS.
   *
   * Every path that puts a model into the finder comes through here — a
   * suggestion clicked, enter pressed, a recent search reopened, "Find parts
   * for master model" from a group sheet, "find with category" from a device
   * page. Two of those used to set state.finder.modelId directly and navigate,
   * which was a free unlimited search for anyone who found the button.
   *
   * @param {string} id
   * @param {{catId?: string, fromSheet?: boolean}} [opts]
   */
  function pickModel(id, opts) {
    opts = opts || {};
    var m = db.modelById[id];
    if (!m) return;

    var acc = SM.access;
    /* Paid: straight through, no round trip. The server agrees independently,
       so this is a saved request rather than a decision. */
    if (acc && acc.isPaid()) return runPickModel(id, opts);

    /* The access module has not loaded or has not answered. Ask the server
       anyway — consumeSearch is the thing that decides, and it fails closed. */
    if (!acc) return denySearch({ offline: true });

    acc.consumeSearch(id).then(function (r) {
      if (r.allowed) { runPickModel(id, opts); renderShellBits(); return; }
      denySearch(r, id);
    });
  }

  /* One refusal, one decision tree, used by every restricted action.

       not signed in            -> the existing Sign In page
       signed in, out of credit -> the existing Plans page

     The search is NOT run in either case: nothing sets state.finder.modelId,
     so the centre column keeps showing whatever it showed before. */
  /**
   * The shared "you cannot do this yet" branch, for every restricted action
   * that is NOT the metered search — the group filter, a locked device.
   *
   *   not signed in -> the existing Sign In page
   *   signed in     -> the existing Plans page
   *
   * Signed-in state comes from the session, so a free account that IS signed
   * in goes to Plans and never to Sign In. Sending an authenticated user to a
   * login page they are already past is the specific wrong turn this exists to
   * avoid.
   */
  function gatedUpgrade(message) {
    var signedIn = S.get().signedIn;
    toast(message, 'lock');
    if (signedIn) { go('/plans'); return; }
    state.afterSignIn = '/finder';
    authMode = 'signin';
    go('/account');
  }

  function denySearch(r, modelId) {
    closeSuggest();
    renderShellBits();
    /* What they were searching for stays in the box, so it is there to run
       again the moment a plan is active. */
    var m = modelId && db.modelById[modelId];
    if (m) { state.finder.query = m.fullName; syncSearchInputs(true); }

    if (r && r.needsSignIn) {
      /* Come back to the Finder once they are in, so signing in finishes the
         thing they were trying to do rather than stranding them on Account. */
      state.afterSignIn = '/finder';
      authMode = 'signin';
      toast('Sign in to search', 'lock');
      go('/account');
      return;
    }
    /* Only a 429 means the allowance is spent. Anything else — the server
       unreachable, a 503 while it is being configured — is a search that could
       not be RUN, and telling that shop it has used its searches would be
       false. The search is still refused: an unmetered search never runs. */
    if (!r || !r.limitReached) {
      toast('Could not run the search just now — please try again', 'alert');
      return;
    }
    state.planNotice = { kind: 'search', modelId: m ? m.id : null };
    toast('Your 5 free searches are used', 'lock');
    go('/plans');
  }

  /* Dismisses the sheet without navigating. Both "find parts" actions did this
     inline; they now share it, because a refused search must still close the
     sheet it was launched from rather than leaving it over the plans page. */
  function closeSheetChrome() {
    state.sheet = null;
    var overlay = document.getElementById('overlay');
    if (overlay) overlay.innerHTML = '';
    document.body.style.overflow = '';
  }

  function runPickModel(id, opts) {
    opts = opts || {};
    var m = db.modelById[id];
    if (!m) return;
    state.finder.modelId = id;
    /* EVERY SEARCH OPENS ON TEMPERED GLASS.

       Explicit wins: opts.catId is "find with category" from the device page.
       Otherwise a new model opens on Tempered Glass, by the owner's rule,
       or, when this model has no glass
       group, on the first category in the result order that it does have.
       That is decided from the public per-category counts, never by showing a
       group the model is not in. The category the previous model was on is
       deliberately NOT carried over: the result page is one fixed starting
       point, whichever phone was before it. */
    state.finder.catId = (opts.catId && db.categoryById[opts.catId]) ? opts.catId : defaultResultCategory(id);
    state.finder.filters.catId = state.finder.catId || 'all';
    state.finder.matchShown = 6;
    state.finder.avail = null;
    state.finder.query = m.fullName;
    pushRecent(id);
    closeSuggest();
    syncSearchInputs(true);
    /* IN PLACE. The workspace stays mounted: the hero band and the centre
       column are repainted, the category and brand panels are left exactly as
       they are. No navigation, no new route, no reload — picking a model is a
       filter being set, and that is all it does to the page. */
    if (state.route.name !== 'finder') go('/finder');
    else if (document.getElementById('catPanel')) { renderBench(); renderWorkspace(); }
    else renderFinder(document.getElementById('page'));
    resetResultScroll();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ------------------------------------------------------- install prompts */
  var INSTALL_ASKED = 'mpf.pwa.asked';

  function rememberInstallDismissed() {
    try { store(INSTALL_ASKED, String(Date.now())); } catch (e) { /* private mode */ }
  }

  function runInstall() {
    SM.pwa.install().then(function (outcome) {
      state.sheet = null; renderSheet();
      renderShellBits();
      if (outcome === 'accepted') { toast('Installing Mobile Parts Finder'); return; }
      /* Dismissed is a decision. Remember it so the next sign-in does not ask
         again, and say nothing — they just closed a dialog on purpose. */
      rememberInstallDismissed();
      if (outcome === 'unavailable') {
        toast('Use the browser menu → Install app', 'info');
      }
    });
  }

  /* Offered ONCE, after a successful sign-in, and only on a phone.
     After sign-in because that is the moment someone has shown they intend to
     come back — offering to install to a passer-by is asking a stranger to
     move in. Only on a phone because a home-screen icon is what a counter
     actually uses. Only when the browser has really offered, and never again
     once asked, installed, or already running installed. */
  function maybeOfferInstall() {
    if (!SM.pwa || !SM.pwa.canInstall()) return;
    if (!isPhone()) return;
    var asked = null;
    try { asked = store(INSTALL_ASKED); } catch (e) { asked = null; }
    if (asked) return;
    /* Let the sign-in toast and the repaint land first; a dialog that appears
       in the same frame as the page it interrupts reads as a glitch. */
    setTimeout(function () {
      if (!SM.pwa.canInstall() || state.sheet) return;
      rememberInstallDismissed();          /* asked once, whatever the answer */
      state.sheet = { type: 'install' };
      renderSheet();
    }, 1200);
  }

  function isPhone() {
    return (window.matchMedia && window.matchMedia('(max-width: 900px)').matches) ||
           (window.innerWidth || 0) < 900;
  }

  var authMode = 'signin';
  /* Sheets that live in memory rather than in the URL. Closing one of these
     puts it away and leaves the page exactly as it was; closing a URL-backed
     sheet navigates. The coming-soon note is firmly the first kind — it is an
     answer to a tap, not a place, and dismissing it must not take the reader
     off whatever they were already looking at. */
  var LOCAL_SHEETS = ['filters', 'country', 'editprofile', 'install', 'share', 'comingsoon'];

  /* leave the result view and restore the normal Finder home page */
  function exitResult() {
    var f = state.finder;
    f.modelId = null; f.catId = null; f.query = ''; f.matchShown = 6; f.avail = null;
    f.filters.catId = 'all';
    closeSuggest();
    if (state.route.name !== 'finder') { go('/finder'); }
    else if (document.getElementById('catPanel')) { renderBench(); renderWorkspace(); }
    else { renderFinder(document.getElementById('page')); }
    syncSearchInputs(true);
    window.scrollTo({ top: 0 });
  }

  document.addEventListener('click', function (e) {
    /* the Finder tab / nav link must never leave the user stuck in a result:
       the hash is already #/finder, so no hashchange would fire on its own */
    var finderLink = e.target.closest('a[href="/finder"]');
    if (finderLink && state.finder.modelId) {
      e.preventDefault();
      exitResult();
      return;
    }
    /* The router's link handler runs first and calls preventDefault on any
       in-app href. Without this guard a model card that is BOTH an <a> and
       inside a [data-act] row navigates twice and re-renders for nothing. */
    if (e.defaultPrevented) return;
    var t = e.target.closest('[data-act]');
    if (!t) {
      if (!e.target.closest('.searchwrap')) closeSuggest();
      return;
    }
    var act = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');

    switch (act) {
      case 'theme': cycleTheme(); break;
      case 'nav': go(t.getAttribute('data-href')); break;
      case 'close-sheet':
        if (state.sheet && LOCAL_SHEETS.indexOf(state.sheet.type) > -1) {
          state.sheet = null; renderSheet();
        } else closeSheet();
        break;

      /* search */
      case 'focus-q': { var i2 = activeSearch(); if (i2) { i2.focus(); onQuery(i2.value, i2); } break; }
      case 'clear-q': {
        state.finder.query = '';
        ['q', 'qh'].forEach(function (idn) { var el = document.getElementById(idn); if (el) el.value = ''; });
        closeSuggest();
        var i3 = activeSearch();
        renderFinder(document.getElementById('page'));
        renderShellBits();
        var again = activeSearch(); if (again && i3) again.focus();
        break;
      }
      case 'pick-model': pickModel(id); break;
      /* The search icon on a new-model card. Deliberately the SAME call the
         search box makes, so this counts against a free account's five
         searches exactly as typing the name would — a second route to the
         answer must not be a way around the meter. */
      /* One handler for the button and the category chips beside it. Without
         data-cat this is exactly the old behaviour; with it, the Finder opens
         already filtered to that category for this model. */
      case 'find-parts': {
        var fcat = t.getAttribute('data-cat');
        pickModel(id, fcat ? { catId: fcat } : undefined);
        break;
      }
      case 'clear-model':
      case 'exit-result':
        exitResult();
        break;
      /* THE category filter. The tiles on the left and the rail under the
         search are two controls for one piece of state — they used to be two
         pieces of state for two layouts, which is why picking a category in
         one place did nothing in the other. */
      case 'pick-cat':
      case 'pick-cat-rail':
      case 'filter-cat':
        setCategory(id);
        if (state.sheet) { state.sheet = null; renderSheet(); }
        renderWorkspace();
        /* A new category is a new group. Leaving the scroll where it was drops
           the reader into the middle of a device list belonging to a part they
           did not ask about — and with every device now rendered in the card,
           "the middle" can be four thousand pixels from the group's own
           details. */
        resetResultScroll();
        break;
      /* A category that exists but has no groups yet.

         It stops here, and stopping here is the point: setCategory() is never
         called, so the filter does not move, the centre column is not
         repainted, and neither api.listGroups nor api.newModels nor
         api.findMatches is asked a question whose only honest answer is
         nothing. The reader is told, and whatever they were looking at is
         still on screen behind the sheet when they close it. */
      case 'cat-soon': {
        var soonCat = db.categoryById[id];
        if (!soonCat) break;
        state.sheet = { type: 'comingsoon', catId: soonCat.id };
        renderSheet();
        break;
      }
      /* The "+" slot in the category grid. A placeholder on purpose: it says
         where category management will live without pretending to be it, and
         it deliberately does NOT touch the category filter — pressing it must
         not silently change what the centre column is showing. */
      case 'add-category':
        toast('Category management is coming soon', 'info');
        break;

      /* ---------------------------------------------------- install / share */
      /* The header button. Where the browser has offered, prompt straight
         away — the click IS the gesture Chrome requires, and routing it
         through a dialog of our own first would spend that gesture and then
         ask for another. Where it has not, explain instead. */
      case 'pwa-install':
        if (SM.pwa && SM.pwa.canInstall()) { runInstall(); }
        else { state.sheet = { type: 'install' }; renderSheet(); }
        break;
      case 'pwa-install-go':
        runInstall();
        break;
      case 'install-later':
        rememberInstallDismissed();
        state.sheet = null; renderSheet();
        break;

      /* The phone's own share sheet where there is one; ours where there is
         not. share() reports 'dismissed' when the user backs out, which is an
         outcome rather than a failure and must not open a second dialog. */
      case 'pwa-share':
        SM.pwa.share().then(function (r) {
          if (r === 'unavailable') { state.sheet = { type: 'share' }; renderSheet(); }
        });
        break;
      case 'share-copy': {
        var link = SM.pwa.shareData().url;
        var done = function () { toast('Link copied'); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(done, function () {
            var f = document.getElementById('shareUrl');
            if (f) { f.select(); }
            toast('Select the link and copy it', 'alert');
          });
        } else {
          var f2 = document.getElementById('shareUrl');
          if (f2) { f2.select(); document.execCommand && document.execCommand('copy'); }
          done();
        }
        break;
      }
      /* Carousel arrows. Scrolls by very nearly a viewport rather than a fixed
         number of cards, so the step matches whatever fits at this width and
         one card is left on screen as an anchor. */
      case 'rail': {
        var railEl = document.getElementById(t.getAttribute('data-rail'));
        if (!railEl) break;
        var dir = t.getAttribute('data-dir') === '-1' ? -1 : 1;
        railEl.scrollBy({ left: dir * Math.max(240, railEl.clientWidth * 0.86), behavior: 'smooth' });
        break;
      }
      /* Grid density. A view preference, so it repaints the category panel
         and nothing else — the filters, the results and the sidebar's scroll
         position are all untouched. Repainted in every rendered copy so the
         sidebar and the mobile filter sheet cannot disagree. */
      case 'cat-cols': {
        var cols = id === '2' ? 2 : 3;
        if (cols === state.catCols) break;
        state.catCols = cols;
        store('mpf.catcols', String(cols));
        var html = categoryPanelHTML();
        document.querySelectorAll('.panel--cats').forEach(function (p) { p.outerHTML = html; });
        break;
      }
      case 'more-matches': state.finder.matchShown += 6; loadMatches(); break;

      case 'filter-brand':
        state.finder.filters.brandId = id;
        if (state.sheet) { state.sheet = null; renderSheet(); }
        renderWorkspace();
        break;
      case 'reset-filters':
        state.finder.filters = { q: '', brandId: 'all', catId: 'all', sort: 'mixed', view: 'both' };
        if (state.sheet) { state.sheet = null; renderSheet(); }
        renderBrowse();
        break;
      case 'clear-brandq': {
        state.brandQ = '';
        var scope = t.closest('.panel') || document;
        var bq = scope.querySelector('.brandq');
        document.querySelectorAll('.field__clear').forEach(function (c) { c.remove(); });
        paintBrandRows();
        if (bq) bq.focus();
        break;
      }
      case 'open-filters':
        /* the filters act on the Device Finder, so land there first */
        if (state.route.name !== 'finder') { go('/finder'); }
        state.sheet = { type: 'filters' }; renderSheet();
        break;
      case 'more-groups': state.finder.page++; loadGroups(false); break;

      /* A group opens in the centre column. go() still writes /group/<id> —
         that URL is the share link and the back button — but route() resolves
         it to the finder with the group selected rather than to a sheet. */
      /* THE GROUP DOES NOT OPEN FOR A FREE ACCOUNT.

         The server refuses the member list regardless — that is the actual
         enforcement, and it is why a typed /group/<id> URL, a Back button and
         a curl all get the same nothing. This is the courteous half: when the
         server has ALREADY told us this account is free, there is no reason to
         navigate into a group whose body would be a paywall. Straight to the
         plans instead.

         isFree() is false while the answer is still outstanding, deliberately.
         An unanswered question is not a denial, and treating it as one would
         paywall a subscriber for as long as the request takes; the group view
         draws the paywall itself if the answer turns out to be "free". */
      /* Every route into a group goes through route(), which turns away an
         account the server has said is not paid — so a card, a button, a
         typed URL and Back all meet the same gate. */
      case 'open-group':
        go('/group/' + id);
        break;

      /* Compact, grid or table — a change of view, not of list. */
      case 'group-view':
      case 'result-view': {
        var nv = listView(t.getAttribute('data-view'));
        var key = act === 'group-view' ? 'groupView' : 'resultView';
        if (state.finder[key] === nv) break;
        state.finder[key] = nv;
        var bar = t.closest('.lview');
        if (bar) Array.prototype.forEach.call(bar.querySelectorAll('.lview__b'), function (b) {
          var on = b.getAttribute('data-view') === nv;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-pressed', String(on));
        });
        if (act === 'group-view') {
          var gl = document.getElementById('groupList');
          if (gl) gl.className = 'gdev__list glist--' + nv;
          repaintGroupList();
        } else {
          repaintMatchLists();
        }
        break;
      }

      /* The opened group's category selector: the same master's group in
         another category. That is a searched-model result for the master —
         the one layout that already knows how to show it — and the selector
         exists only on a group a subscriber has opened, so it costs no search. */
      case 'group-cat': {
        var gnow = currentGroup();
        if (!gnow || id === gnow.group.categoryId || !db.categoryById[id]) break;
        var masterId = gnow.master.id;
        go('/finder');
        pickModel(masterId, { catId: id });
        break;
      }

      /* The red X. Back to the group list, in place. */
      case 'close-group': go('/finder'); break;

      case 'more-devices':
        state.finder.groupShown = (state.finder.groupShown || 400) + 400;
        repaintGroupList();
        break;

      /* device page */
      case 'dev-back':
        if (history.length > 1) history.back(); else go('/models');
        break;

      /* Variant picker on a migrated model. Market is the primary axis, so
         changing it re-derives the valid colours, RAM and storage and pulls the
         model number with it. reconcile() guarantees the selection always lands
         on a combination the market actually sold. */
      case 'vpick': {
        var av = state.active;
        if (!av) break;
        var next = {
          region: state.vsel.region, color: state.vsel.color,
          ram: state.vsel.ram, storage: state.vsel.storage
        };
        next[t.getAttribute('data-axis')] = t.getAttribute('data-value');
        state.vsel = reconcile(av, next);
        repaintVariant(av, state.vsel);
        break;
      }

      case 'dev-colour':
      case 'dev-shot':
      case 'pick-variant': {
        /* The same three controls serve the model page and the group panel.
           Which device they are describing differs, so the device is resolved
           from whichever view is open rather than from state.deviceId alone —
           that field trails a group opened straight from a link. */
        var dm = db.modelById[state.deviceId];
        if (!dm) break;
        state.deviceId = dm.id;
        dm = previewVariants(dm);

        if (act === 'dev-colour') {
          state.deviceColour = Number(t.getAttribute('data-i')) || 0;
          /* A new colour means a new lead photograph; keeping the old index
             would leave the rail highlighting a shot of the previous finish. */
          state.deviceShot = 0;
        } else if (act === 'dev-shot') {
          state.deviceShot = Number(t.getAttribute('data-i')) || 0;
        } else {
          var kind = t.getAttribute('data-kind');
          var val = Number(t.getAttribute('data-value'));
          var colour = colourNameAt(dm, state.deviceColour || 0);
          var cv = currentVariant(dm);
          if (!cv) break;
          var want = { ramGb: cv.ramGb, storageGb: cv.storageGb };
          want[kind === 'ram' ? 'ramGb' : 'storageGb'] = val;

          /* Changing RAM can land on a pair nobody sells. Rather than price a
             phone that does not exist, keep the chosen RAM and move to the
             nearest storage that does. */
          if (!findVariant(dm, want.ramGb, want.storageGb, colour)) {
            var alt = variantsForColour(dm, colour).filter(function (v) {
              return v.ramGb === want.ramGb;
            });
            if (!alt.length) break;
            alt.sort(function (a, b) {
              return Math.abs(a.storageGb - want.storageGb) -
                     Math.abs(b.storageGb - want.storageGb);
            });
            want.storageGb = alt[0].storageGb;
          }
          state.deviceVariant = want;
        }

        repaintDevice(dm);
        break;
      }
      case 'open-model': go('/model/' + id); break;
      /* Both of these used to set state.finder.modelId and navigate, which ran
         a model search without going anywhere near the search counter — an
         unlimited free search for anyone who found the button. They go through
         pickModel now, like every other search. */
      case 'find-parts':
        closeSheetChrome();
        pickModel(id);
        break;
      case 'find-with-cat': {
        var mid = state.sheet && state.sheet.id;
        closeSheetChrome();
        pickModel(mid, { catId: id });
        break;
      }
      case 'copy':
        (function (val) {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(val).then(function () { toast('Copied ' + val); },
              function () { toast('Could not copy — select the code and copy manually', 'alert'); });
          } else toast('Copied ' + val);
        })(t.getAttribute('data-copy'));
        break;

      /* models page */
      case 'more-models': state.models.page++; loadModels(false); break;

      case 'brand-scroll': {
        var railEl = document.getElementById('brandRail');
        if (railEl) railEl.scrollBy({ left: Number(t.getAttribute('data-dir')) * railEl.clientWidth * 0.8, behavior: 'smooth' });
        break;
      }

      case 'model-view': {
        var v = t.getAttribute('data-view');
        if (v === state.models.view) break;
        state.models.view = v;
        store('mpf.modelview', v);
        state.models.page = 1;
        Array.prototype.forEach.call(document.querySelectorAll('.vswitch__b'), function (el) {
          var on = el.getAttribute('data-view') === v;
          el.classList.toggle('is-on', on);
          el.setAttribute('aria-pressed', String(on));
        });
        loadModels(true);
        break;
      }

      case 'clear-model-filters': {
        var f = state.models.filters;
        Object.keys(f).forEach(function (k) { f[k] = ''; });
        state.models.page = 1;
        refreshModelFilters();
        loadModels(true);
        break;
      }
      case 'clear-model-search': {
        var mdlq = document.getElementById('mdlq');
        clearTimeout(mqTimer);
        state.models.q = '';
        if (mdlq) { mdlq.value = ''; mdlq.focus(); }
        t.hidden = true;
        syncModelsUrl();
        loadModels(true);
        break;
      }

      /* the Products counter opens the full product listing, so it clears the
         active filters too — otherwise the count in the header (all products)
         would not match what the listing shows */
      case 'go-products':
        state.finder.modelId = null; state.finder.catId = null; state.finder.query = '';
        state.finder.filters = { q: '', brandId: 'all', catId: 'all', sort: 'mixed', view: 'both' };
        closeSuggest(); syncSearchInputs(true);
        if (state.route.name === 'finder') renderFinder(document.getElementById('page'));
        else go('/finder');
        break;

      /* plans + account */
      /* Every paywall card, including the locked remainder of a group, lands
         here. Routed through the shared branch so an authenticated free user
         reaches Plans and an anonymous one reaches Sign In — the card looks
         the same either way, which is why the decision cannot live in it. */
      case 'retry-matches':
        if (SM.access && SM.access.forgetDevice) SM.access.forgetDevice(state.finder.modelId);
        loadMatches();
        break;

      case 'go-plans': gatedUpgrade('A plan unlocks the full list'); break;
      case 'subscribe':
        /* a plan belongs to a signed-in identity, so sign in first */
        if (!S.canSubscribe()) {
          state.afterSignIn = '/plans';
          authMode = 'signin';        /* most people arriving here already have an account */
          toast('Sign in to activate a plan', 'lock');
          go('/account');
          break;
        }
        t.disabled = true;
        var restoreCta = t.innerHTML;
        var live = S.hasPaymentBackend && S.hasPaymentBackend();

        /* Each stage is shown on the button itself. A payment that looks frozen
           is the fastest way to make someone pay twice, so "Verifying…" has to
           be visible for the second or two the server takes. */
        var STAGE_LABEL = {
          'creating-order':   'Preparing…',
          'opening-checkout': 'Opening payment…',
          'verifying':        'Verifying payment…'
        };
        var onStage = function (stage) {
          if (STAGE_LABEL[stage]) t.innerHTML = icon('refresh') + STAGE_LABEL[stage];
        };

        t.innerHTML = icon('refresh') + (live ? 'Preparing…' : 'Activating…');

        S.subscribe(id, onStage).then(function (r) {
          /* A cancelled or failed payment must put the button back — the user
             is still on the pricing page and will want to try again. */
          if (r && r.ok === false) {
            t.disabled = false;
            t.innerHTML = restoreCta;
            var st = (r.result && r.result.state) || 'failed';
            if (st === 'cancelled') toast('Payment cancelled', 'alert');
            else if (st === 'verification-failed') {
              toast('Payment taken but not yet confirmed — it will activate shortly', 'alert');
              /* "Shortly" has to be something that happens. The webhook is the
                 other half of this payment and normally lands within seconds,
                 so the server is asked again until it says the plan is on —
                 rather than leaving a shop that has paid looking at a button
                 that invites it to pay a second time. */
              awaitActivation();
            } else if (st === 'signin-required') {
              toast('Sign in again to activate a plan', 'alert');
            } else if (st === 'unavailable') {
              /* Reached only when the app cannot talk to the payment backend at
                 all. It used to fall through this branch entirely and toast
                 "Plan active", which told the shop they had bought something
                 they had not. */
              toast('Payments are not switched on for this site yet', 'alert');
            } else {
              toast((r.result && r.result.reason) || 'Payment failed', 'alert');
            }
            return;
          }
          /* Re-ask the server what this account may do now. The subscription
             was verified server side a moment ago, so this comes back `paid`
             and every restriction lifts without a reload — which is the whole
             point of paying at the counter with a customer waiting. */
          if (SM.access) SM.access.refresh().then(renderShellBits);

          renderShellBits();
          toast(live ? 'Payment verified — plan active' : 'Plan active — no payment was taken');
          /* the hash may already be #/account, which would not re-render */
          if (state.route.name === 'account') renderAccount(document.getElementById('page'));
          else go('/account');
        }).catch(function (err) {
          t.disabled = false;
          t.innerHTML = restoreCta;

          /* "Could not start payment" told nobody anything — not the shop
             owner staring at it, and not us reading a bug report. Each failure
             now says which step broke and what to do about it. */
          var msg = err && err.message;

          /* The server refused to start a payment because the shop profile is
             missing something Checkout needs — most often the phone number,
             which is exactly what its extra "Contact details" step asks for.
             Open the form, remember which plan was chosen, and come straight
             back to it once the profile is saved. */
          if (msg === 'profile-incomplete') {
            state.pendingPlan = id;
            state.pendingPlanMissing = (err.data && err.data.missing) || [];

            /* Ask Firestore before believing it.

               The server read users/{uid} a moment ago and found something
               missing, but this browser may be holding a stale copy — a profile
               completed on a phone, a sign-up that finished after this tab
               loaded. Re-reading costs one document and is the difference
               between "confirm two details" and "fill this entire form again",
               which is what a shop that had already filled it in was seeing. */
            var u = SM.fb && SM.fb.user();
            var recheck = (u && SM.store && SM.store.available())
              ? SM.store.loadProfile(u.uid).catch(function () { return null; })
              : Promise.resolve(null);

            recheck.then(function (fresh) {
              var stillMissing = state.pendingPlanMissing;
              if (fresh && fresh.profileCompleted && fresh.country) {
                /* It IS complete — the server was reading an older document, or
                   this tab was. Refresh the session and go straight back to the
                   payment rather than asking for anything. */
                SM.debug.log('billing', 'profile was complete after all — retrying payment', { uid: u.uid });
                return S.initializeAuthenticatedUser(u).then(function () {
                  state.pendingPlan = null;
                  toast('Opening payment…');
                  var again = document.querySelector('[data-act="subscribe"][data-id="' + id + '"]');
                  if (again) again.click();
                });
              }

              /* Genuinely incomplete. Open the form PREFILLED with everything
                 already known, so only the gaps need typing. */
              seedEditForm();
              state.sheet = { type: 'editprofile' };
              renderSheet();
              toast(stillMissing.length === 1
                ? 'One more detail, then straight to payment'
                : 'A few shop details first — then straight to payment');
            });
            return;
          }

          /* 503 with a name means the deployment is unfinished, not broken —
             a different sentence to the shop and a different thing to fix. A
             500 stays a 500: something genuinely failed, and claiming it was a
             configuration problem would send whoever reads the report hunting
             the wrong thing. */
          var d = (err && err.data) || {};

          /* Razorpay refused the order and said why. Its own description is
             what the shop and whoever configured the account both need — "your
             account is not activated for live payments" is a different job from
             "authentication failed", and both used to read as the same
             sentence. */
          var say =
            msg === 'razorpay-refused'       ? 'Razorpay could not start this payment: ' +
                                                 (d.detail || 'it refused the order') +
                                                 ' — nothing was charged'
          : msg === 'already-lifetime'       ? 'You already have lifetime access — there is nothing to pay'
          : msg === 'payments-unconfigured'  ? 'Payments are not switched on for this site yet'
          : msg === 'signin-required'        ? 'Sign in again to activate a plan'
          : msg === 'checkout-unavailable'   ? 'Razorpay Checkout did not load — check the connection and retry'
          : msg === 'unknown plan'           ? 'That plan is no longer available'
          : (err && err.status === 401)      ? 'Your session expired — sign in again'
          : (err && err.status === 503)      ? 'Payments are temporarily unavailable — try again shortly'
          : (err && err.status === 500)      ? 'Something went wrong starting the payment — nothing was charged'
          : msg                              ? 'Could not start payment: ' + msg
                                             : 'Could not start payment';
          SM.debug.warn('billing', 'subscribe failed', {
            status: err && err.status, message: msg, data: err && err.data
          });
          console.error('[subscribe]', err);
          toast(say, 'alert');

          /* An unconfigured deployment is worth naming precisely, once, in the
             console — the toast has to stay short and the shop owner is not the
             person who can fix it. */
          if (msg === 'payments-unconfigured' && SM.billing) {
            SM.billing.health().then(function (h) {
              console.error('[subscribe] payment backend not configured. Missing:',
                            (h && h.missing) || (err.data && err.data.missing) || 'unknown');
            });
          }
          if (msg === 'razorpay-refused') {
            /* The whole of Razorpay's answer, in one place, for whoever has to
               go and fix the account. */
            console.error('[subscribe] Razorpay refused the order:', {
              detail: d.detail, code: d.code, reason: d.reason,
              field: d.field, gatewayStatus: d.gatewayStatus, mode: d.mode
            });
          }
        });
        break;
      case 'edit-profile':
        seedEditForm();
        state.sheet = { type: 'editprofile' }; renderSheet();
        break;
      case 'welcome-continue':
        /* Close, and honour a destination the user chose BEFORE signing up —
           picking a plan and being asked to sign in first, say. Absent that,
           they stay where they are: navigation is theirs. */
        state.sheet = null; renderSheet();
        if (state.afterSignIn) { var dest = state.afterSignIn; state.afterSignIn = null; go(dest); }
        /* A new account reaches the install offer here rather than at sign-in,
           because the welcome sheet was holding the screen at that moment and
           two dialogs in a row is one too many. */
        maybeOfferInstall();
        break;

      case 'toggle-address':
        reg.addrOpen = !reg.addrOpen;
        saveRegDraft();
        repaintAuth();
        break;

      case 'pick-edit-country': state.sheet = { type: 'country', forEdit: true }; renderSheet(); break;
      case 'clear-photo': edit.photo = ''; state.sheet = { type: 'editprofile' }; renderSheet(); break;
      case 'use-location': captureLocation(); break;
      case 'clear-location': edit.location = null; renderSheet(); break;
      case 'save-profile': saveProfile(); break;

      case 'resume-sub':
        /* There is no auto-renewal to switch back on: a plan is a one-off
           order for a period, not a Razorpay recurring subscription. This used
           to clear cancelledAt in localStorage and nothing else — the server
           record stayed cancelled, the next sync put it straight back, and the
           user had been told "Renewal turned back on" about a change that did
           not exist anywhere.

           Buying again is the real thing, and it does the right arithmetic:
           periodFor extends from the current expiry rather than from today, so
           no paid-for days are lost. */
        toast('Choose a plan to extend — your remaining days are carried over');
        go('/plans');
        break;

      case 'cancel-sub':
        t.disabled = true;
        S.cancel().then(function (r) {
          t.disabled = false;
          renderShellBits();
          renderAccount(document.getElementById('page'));
          if (r && r.ok) {
            /* Access is NOT revoked — the shop paid for a period and keeps it.
               The old message said "marked expired", which is both wrong and
               alarming to someone who still has days left. The date comes from
               the freshly re-synced session, so it is the server's. */
            var until = (S.get().subscription || {}).endLabel;
            toast(until
              ? 'Renewal stopped — your plan runs to ' + until
              : 'Renewal stopped — your plan runs to the end of the paid period');
          } else if (r && r.error === 'payments-unavailable') {
            toast('Cannot reach the billing service — try again shortly', 'alert');
          } else {
            toast((r && r.error) || 'Could not cancel — try again', 'alert');
          }
        });
        break;
      case 'signout':
        forgetRole();
        S.signOut().then(function () {
          authMode = 'signin';           /* land back on Sign in, not the form */
          state.pendingIdentity = null;
          /* Entitlement follows the ACCOUNT. Dropping it here is what stops
             the next person to sign in on this device inheriting the last
             one's tier or their spent searches. */
          if (SM.access) { SM.access.reset(); SM.access.refresh().then(renderShellBits); }
          renderShellBits(); renderAccount(document.getElementById('page')); toast('Signed out');
        });
        break;
      case 'auth-tab': authMode = id; repaintAuth(); break;

      case 'open-country': state.sheet = { type: 'country' }; renderSheet(); break;
      case 'pick-country':
        if (state.sheet && state.sheet.forEdit) {
          edit.country = id;
          state.sheet = { type: 'editprofile' }; renderSheet();
        } else {
          reg.country = id;
          saveRegDraft();
          state.sheet = null; renderSheet();
          /* A number valid for one country is not valid for the next, so the
             whole form is redrawn rather than just the flag. */
          repaintAuth();
          syncRegCta();
        }
        break;

      case 'google-signin': startGoogle(false); break;

      /* Puts the sign-in form back. The Google attempt itself is not
         cancelled — a page cannot close the chooser — so if the person does
         pick an account after all, the auth listener still signs them in. */
      case 'cancel-signin':
        signingIn = false;
        renderAccount(document.getElementById('page'));
        break;

      /* The way off the failure screen. Drops the cached answer and asks the
         whole identity question again — no reload, so a half-filled sign-up
         form on the same page survives the retry. */
      case 'retry-identity': retryIdentity(); break;

      /* The way out of an embedded browser. SM.env owns the platform detail —
         an Android intent that names Chrome and falls back to the default
         browser, Chrome's own URL scheme on iOS — and it carries the CURRENT
         url, so campaign and referral parameters survive the trip. */
      case 'inapp-open': {
        var res = SM.env.openExternal();
        SM.debug.log('auth', 'external browser requested', {
          method: res.method, app: SM.env.inAppName()
        });
        if (!res.attempted) {
          /* Nothing could be launched — an iPhone with no Chrome, or a host
             that blocks both. Copying the address is the one thing that always
             works, and the visitor pastes it themselves. */
          SM.env.copyUrl().then(function (copied) {
            toast(copied ? 'Link copied — paste it into your browser'
                         : 'Open ' + SM.env.currentUrl() + ' in your browser');
          });
          return;
        }
        /* The sheet stays up. If the launch worked this document is being
           replaced anyway; if it silently did not — an iPhone without Chrome
           is the realistic case — the instructions are still on screen, which
           is better than an empty page and no explanation. */
        break;
      }

      /* "Continue here". Remembered for the session so the sheet does not
         reappear at every attempt, and the sign-in is then allowed to proceed
         and fail on its own terms if Google refuses it. */
      case 'inapp-stay': {
        var wasSignup = !!(state.sheet && state.sheet.signup);
        dismissInApp();
        state.sheet = null;
        renderSheet();
        startGoogle(wasSignup);
        break;
      }
      /* Already through Google; this only saves the profile. */
      /* Already through Google; this only saves the profile. */
      case 'finish-signup':
        submitRegistration(t, state.pendingIdentity);
        break;

      case 'google-signup':
        /* Already authenticated and only missing the shop profile — same
           guarded path as the button above. Otherwise Google comes first. */
        if (state.pendingIdentity) { submitRegistration(t, state.pendingIdentity); break; }
        REG_FIELDS.forEach(function (f) { reg.touched[f.k] = true; });
        if (!regValid()) { repaintAuth(); toast('Complete the highlighted fields first', 'alert'); break; }
        startGoogle(true);
        break;
    }
  });

  function rerenderCurrent() {
    if (state.route.name === 'finder') {
      renderWorkspace();
    } else if (state.route.name === 'account') renderAccount(document.getElementById('page'));
    else if (state.route.name === 'plans') renderPlans(document.getElementById('page'));
  }

  /* --------------------------------------------------------------- inputs */
  var gqTimer = null, mqTimer = null;
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (el.id === 'q' || el.id === 'qh') {
      onQuery(el.value, el);
      syncClearBtn(el);
      var twin = document.getElementById(el.id === 'q' ? 'qh' : 'q');
      if (twin && twin.value !== el.value) { twin.value = el.value; syncClearBtn(twin); }
    }
    /* two filter inputs exist (mobile toolbar + desktop centre toolbar); only
       one is ever visible, and both drive the same filter state */
    if (el.id === 'gq' || el.id === 'gqd') {
      /* Group filtering is a paid feature. Blocked on the first keystroke —
         the value is wiped so nothing is left in the box, and the plans page
         opens. Blocking the FOCUS instead would be worse on a phone, where the
         keyboard opens and the page navigates out from under it. */
      if (SM.access && SM.access.isFree()) {
        el.value = '';
        el.blur();
        state.finder.filters.q = '';
        gatedUpgrade('Group search is part of a plan');
        return;
      }
      clearTimeout(gqTimer);
      gqTimer = setTimeout(function () {
        state.finder.filters.q = el.value;
        var twin = document.getElementById(el.id === 'gq' ? 'gqd' : 'gq');
        if (twin && twin.value !== el.value) twin.value = el.value;
        /* the same box narrows whichever list the column is showing */
        if (state.finder.modelId) { state.finder.matchShown = 6; loadMatches(); }
        else loadGroups(true);
      }, 220);
    }
    if (el.id === 'mdlq') {
      document.getElementById('mdlqClear').hidden = !el.value;
      clearTimeout(mqTimer);
      mqTimer = setTimeout(function () {
        state.models.q = el.value;
        syncModelsUrl();
        loadModels(true);
      }, 220);
    }
    /* registration fields: validate live without losing the caret */
    if (el.hasAttribute && el.hasAttribute('data-reg')) {
      var rk = el.getAttribute('data-reg');
      reg[rk] = (rk === 'mobile') ? el.value.replace(/[^\d\s-]/g, '') : el.value;
      if (rk === 'mobile' && el.value !== reg.mobile) el.value = reg.mobile;
      saveRegDraft();
      syncRegCta();
      var hint = document.getElementById('regHint');
      if (hint) hint.innerHTML = regHintHTML();
      if (reg.touched[rk]) {
        var wrap = el.closest('.ffield');
        if (wrap) {
          var e2 = regError(rk);
          wrap.classList.toggle('has-error', !!e2);
          var es = wrap.querySelector('.ffield__err');
          if (e2 && !es) { var sp = document.createElement('span'); sp.className = 'ffield__err'; sp.textContent = e2; wrap.appendChild(sp); }
          else if (e2 && es) es.textContent = e2;
          else if (!e2 && es) es.remove();
        }
      }
      return;
    }
    if (el.hasAttribute && el.hasAttribute('data-edit')) { edit[el.getAttribute('data-edit')] = el.value; return; }
    if (el.id === 'countryq') { paintCountryRows(el.value); return; }

    /* brand filter is local data — filter instantly, no debounce, no reload */
    if (el.classList && el.classList.contains('brandq')) {
      state.brandQ = el.value;
      paintBrandRows(el);
      var clr = el.parentNode.querySelector('.field__clear');
      if (el.value && !clr) {
        var c = document.createElement('button');
        c.className = 'field__clear'; c.setAttribute('data-act', 'clear-brandq');
        c.setAttribute('aria-label', 'Clear brand search'); c.innerHTML = icon('close');
        el.parentNode.appendChild(c);
      } else if (!el.value && clr) clr.remove();
    }
  });

  function syncClearBtn(input) {
    var search = input && input.closest('.search');
    if (!search) return;
    var v = input.value;
    var btn = search.querySelector('.search__clear');
    if (v && !btn) {
      var b = document.createElement('button');
      b.className = 'search__clear'; b.setAttribute('data-act', 'clear-q');
      b.setAttribute('aria-label', 'Clear search'); b.innerHTML = icon('close');
      search.insertBefore(b, search.querySelector('.search__go'));
    } else if (!v && btn) btn.remove();
  }

  document.addEventListener('change', function (e) {
    if (e.target.id === 'photoInput') {
      var f = e.target.files && e.target.files[0];
      /* Show the local preview immediately, then upload. The preview is what
         makes the picker feel instant; the upload is what makes the photo
         exist on the shop's other devices. */
      var uid = SM.fb && SM.fb.user() && SM.fb.user().uid;
      if (uid && SM.store && SM.store.available() && f) {
        SM.store.uploadProfilePhoto(uid, f).then(function (r) {
          edit.photoURL = r.url;
          edit.photoPath = r.path;
          toast('Photo uploaded');
        }, function (err) {
          /* Never claim an upload worked. The local preview stays so the form
             is not disrupted, but the stored URL is left unset so the profile
             save cannot record a photo that is not there. */
          edit.photoURL = null;
          edit.photoPath = null;
          console.error('[photo] upload failed', err);
          toast((err && err.message) || 'Photo upload failed — saved on this device only', 'alert');
        });
      }
      readPhoto(f).then(function (dataUrl) {
        edit.photo = dataUrl;
        state.sheet = { type: 'editprofile' }; renderSheet();
      }, function (err) { toast((err && err.message) || 'Could not read that image', 'alert'); });
      return;
    }

    if (e.target.id === 'sortSel') { state.finder.filters.sort = e.target.value; loadGroups(true); }
    if (e.target.id === 'viewSel') { state.finder.filters.view = e.target.value; loadGroups(true); }

    /* Model filters and sort. Only the control that changed is re-read,
       and only the list is repainted — re-rendering the whole page would drop
       focus out of the select the user just used, which on a phone closes the
       native picker mid-choice. */
    var fsel = e.target.closest && e.target.closest('[data-act="model-filter"]');
    if (fsel) {
      var key = fsel.getAttribute('data-key');
      if (key === 'sort') state.models.sort = fsel.value;
      else state.models.filters[key] = fsel.value;
      state.models.page = 1;
      fsel.parentNode.classList.toggle('is-set', !!fsel.value);
      refreshModelFilters();
      loadModels(true);
    }
  });

  document.addEventListener('focusout', function (e) {
    var el = e.target;
    if (el && el.hasAttribute && el.hasAttribute('data-reg')) {
      reg.touched[el.getAttribute('data-reg')] = true;
      var wrap = el.closest('.ffield');
      if (!wrap) return;
      var err = regError(el.getAttribute('data-reg'));
      wrap.classList.toggle('has-error', !!err);
      var es = wrap.querySelector('.ffield__err');
      if (err && !es) { var sp = document.createElement('span'); sp.className = 'ffield__err'; sp.textContent = err; wrap.appendChild(sp); }
      else if (err && es) es.textContent = err;
      else if (!err && es) es.remove();
    }
  });

  document.addEventListener('focusin', function (e) {
    if ((e.target.id === 'q' || e.target.id === 'qh') && !state.finder.query) showIdle(suggestSlot(e.target));
  });

  document.addEventListener('keydown', function (e) {
    /* keyboard activation for card-shaped controls */
    if ((e.key === 'Enter' || e.key === ' ') && e.target.getAttribute && e.target.getAttribute('role') === 'button') {
      e.preventDefault(); e.target.click(); return;
    }
    /* A focused row of a specification table opens what a click on it opens. */
    if (e.key === 'Enter' && e.target.tagName === 'TR' && e.target.hasAttribute('data-act')) {
      e.preventDefault(); e.target.click(); return;
    }
    if (e.key === 'Escape') {
      if (state.suggest.open) { closeSuggest(); return; }
      /* Escape closes an open group, the same as the red X. It is not a modal,
         but it is a view someone can be inside, and Escape is what a keyboard
         reaches for to get out of one. */
      if (state.finder.groupId) { go('/finder'); return; }
      if (state.sheet) {
        if (LOCAL_SHEETS.indexOf(state.sheet.type) > -1) { state.sheet = null; renderSheet(); }
        else closeSheet();
      }
      return;
    }
    if ((e.target.id !== 'q' && e.target.id !== 'qh') || !state.suggest.open) return;
    var s = state.suggest;
    if (e.key === 'ArrowDown') { e.preventDefault(); s.cursor = Math.min(s.cursor + 1, s.items.length - 1); paintSuggest(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); s.cursor = Math.max(s.cursor - 1, -1); paintSuggest(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      var m = s.items[s.cursor] || s.items[0];
      if (m) pickModel(m.id);
    }
  });

  /* ---------------------------------------------------- Google sign-in flow */
  function authMsg(html) {
    var host = document.getElementById('authMsg');
    if (host) host.innerHTML = html ? '<div class="notice notice--amber" style="margin-top:12px">' + icon('alert') + '<span>' + html + '</span></div>' : '';
  }

  /* Where the visitor is standing decides whether "Continue with Google" can
     work at all. Google refuses OAuth from embedded WebViews as a matter of
     policy, so inside Instagram or Facebook the button cannot succeed however
     carefully it is wired — the only useful thing to do is say so and offer
     the way out. Dismissed once, it stays dismissed for the session. */
  var INAPP_DISMISS_KEY = 'mpf.inapp.dismissed.v1';

  function inAppDismissed() {
    try { return sessionStorage.getItem(INAPP_DISMISS_KEY) === '1'; }
    catch (e) { return false; }
  }
  function dismissInApp() {
    try { sessionStorage.setItem(INAPP_DISMISS_KEY, '1'); } catch (e) { /* private mode */ }
  }

  function startGoogle(isSignup) {
    authMsg('');

    /* Ask before starting anything. Letting the popup open first and reporting
       Google's own refusal afterwards would show the visitor an OAuth error
       they cannot act on, when the actionable answer is known in advance. */
    if (SM.env && SM.env.googleAuthLikelyBlocked() && !inAppDismissed()) {
      SM.debug.log('auth', 'in-app browser — offering the external browser first', {
        app: SM.env.inAppName()
      });
      state.sheet = { type: 'inapp', signup: !!isSignup };
      renderSheet();
      return;
    }

    /* The button is markup and markup gets re-rendered; the guard that matters
       is in SM.fb.signIn, which is module state and survives. This one is
       cosmetic — it stops the button looking pressable while a popup is open. */
    if (SM.fb && SM.fb.signInPending && SM.fb.signInPending()) {
      SM.debug.log('auth', 'sign-in already running — ignoring the extra press');
      /* After Cancel the chooser may still be open; say so again rather
         than leaving a press that visibly does nothing. */
      if (!isSignup && !signingIn) {
        signingIn = true;
        if (state.route.name === 'account') renderAccount(document.getElementById('page'));
      }
      return;
    }

    SM.debug.log('auth', 'Continue with Google pressed', { signup: !!isSignup });

    /* From here until Google answers, the account card says "Signing in…".
       The sign-in form with a greyed-out button is what used to sit here, and
       it is what a shop coming back from the account chooser read as "it sent
       me back to Sign in". A sign-up keeps its form on screen instead: the
       shop's details are in it, and they are what is being submitted. */
    if (!isSignup) {
      signingIn = true;
      if (state.route.name === 'account') renderAccount(document.getElementById('page'));
    } else {
      var btn = document.querySelector('.gbtn');
      if (btn) { btn.classList.add('is-busy'); btn.disabled = true; }
    }

    /* The profile read that follows needs the Firestore SDK, which is fetched
       on first use. Starting that download now overlaps it with the account
       chooser instead of adding it to the wait after it. */
    if (SM.store && SM.store.warm) SM.store.warm();

    SM.auth.signInWithGoogle().then(function (identity) {
      signingIn = false;
      finishGoogle(identity, isSignup);
    }, function (err) {
      signingIn = false;
      /* The page is navigating to Google; leave the screen as it is rather
         than flashing a form the user will never finish reading. */
      if (err && err.code === 'redirecting') {
        SM.debug.log('auth', 'redirecting to Google — result arrives on the next page load');
        return;
      }
      /* A second press that the in-flight guard turned away. The first attempt
         is still running; saying anything here would talk over it. */
      if (err && err.code === 'superseded') return;

      /* Every other outcome puts the form back, then says why. */
      if (state.route.name === 'account' && !(SM.fb.user && SM.fb.user())) {
        renderAccount(document.getElementById('page'));
      }
      restoreSignupButton();
      if (err && err.code === 'unconfigured') {
        /* Firebase Auth is not reachable. There is deliberately no stand-in
           account any more: a pretend identity would let someone hold a
           subscription no payment backs, and real sign-in now works. */
        authMsg('Sign-in is unavailable right now. Reload the page, and if it ' +
                'persists the site configuration needs checking.');
        return;
      }
      if (err && err.code === 'cancelled') { toast('Sign-in cancelled'); return; }
      SM.debug.warn('auth', 'sign-in rejected', { code: err && err.code, message: err && err.message });
      authMsg(esc(err && err.message ? err.message : 'Google sign-in failed. Try again.'));
    });
  }

  /* The raw provider codes, kept visible but subordinate. They are what makes
     a support message actionable ("client: unavailable; server:
     datastore-unavailable" names the fault exactly) and they are meaningless
     to everyone else, so they are muted and come last. */
  function reasonNote(reasons) {
    if (!reasons || !reasons.length) return '';
    return ' <span class="muted">(' + esc(reasons.join('; ')) + ')</span>';
  }

  function finishGoogle(identity, isSignup) {
    var rc = SM.countries.byCode(reg.country) || {};

    /* The address is built ONLY when a part of it was actually filled in.
       Building it unconditionally sent {flat:'', area:'', …, country:'India'}
       for everyone who left the optional section closed — an address consisting
       of a country, stored on every account, and one more thing for the profile
       screen to render as if the shop had entered it. */
    var addrParts = {
      flat: reg.flat.trim(), area: reg.area.trim(), city: reg.city.trim(),
      district: reg.district.trim(), state: reg.stateName.trim()
    };
    var hasAddress = Object.keys(addrParts).some(function (k) { return addrParts[k]; });

    var registration = isSignup ? {
      shopName: reg.shopName.trim(), proprietor: reg.proprietor.trim(),
      country: reg.country, countryName: rc.name,
      dial: rc.dial,
      mobile: reg.mobile.trim(),
      address: hasAddress
        ? Object.assign({}, addrParts, { country: rc.name })
        : null
    } : null;

    SM.debug.log('auth', 'sign-in complete, resolving profile', {
      uid: identity.sub, withRegistration: !!registration
    });

    /* A sign-in and a page reload must reach the same conclusion, so a plain
       sign-in goes through the SAME resolver boot uses — which is also what
       creates users/{uid} and stamps lastLoginAt. Previously this path had its
       own logic and skipped both, so an existing shop signing in on a new
       device wrote nothing at all.

       A registration keeps the dedicated path, because it has shop details to
       save before anything else can be decided. */
    var settle = registration
      ? S.signInWithGoogle(identity, registration)
      : resolveSignIn(identity);

    settle.then(function (res) {
      signupInFlight = false;
      if (res && res.needsRegistration) {
        /* known Google account, no shop profile yet — send them to the form */
        authMode = 'signup';
        state.pendingIdentity = identity;

        /* Prefilled from whatever is already stored, so a half-finished
           profile does not ask for everything again. */
        var p = res.existing || {};
        reg.shopName = reg.shopName || p.mobileShopName || p.shopName || '';
        reg.proprietor = reg.proprietor || p.proprietorName || p.proprietor || '';
        reg.mobile = reg.mobile || p.mobileNumber || p.mobile || '';
        if (p.countryCode) reg.country = p.countryCode;

        /* Straight onto the completion form. Its own heading says what is
           happening — "Finish setting up your shop", with the Google account
           shown — so there is no error-coloured message to add over it: a new
           shop arriving here is the flow working, not something going wrong. */
        renderAccount(document.getElementById('page'));
        return;
      }
      /* Cleared HERE, not before the write — a failed save keeps the identity
         so the same details can be resubmitted. Same for the draft: it exists
         only to survive the trip to Google, and the account now exists, so
         keeping it would refill the form for whoever signs in next on this
         tab. */
      state.pendingIdentity = null;
      clearRegDraft();
      renderShellBits();
      renderAccount(document.getElementById('page'));

      if (res && res.saved) {
        /* Stay on the account page and show what was stored. The user is not
           sent anywhere — a redirect straight after sign-up left them on the
           Finder wondering whether anything had been saved at all. */
        state.sheet = { type: 'welcome' };
        renderSheet();
        return;
      }

      /* A different account may have been signed in on this device a moment
         ago. Drop what we knew and ask again, so nobody inherits the previous
         person's tier or their spent searches. */
      if (SM.access) { SM.access.reset(); SM.access.refresh().then(renderShellBits); }

      toast(res && res.isNew ? 'Account created — welcome' : 'Signed in');
      if (state.afterSignIn) { var go2 = state.afterSignIn; state.afterSignIn = null; go(go2); }
      /* Signing in is the moment someone has shown they mean to come back —
         the one point where offering a home-screen icon is a help rather than
         an interruption. Asked once per device, and never here for a new
         account, whose welcome sheet is already on screen. */
      if (!(res && res.isNew)) maybeOfferInstall();
    }, function (err) {
      signupInFlight = false;
      SM.debug.warn('auth', 'could not complete sign-in',
                    { code: err && err.code, message: err && err.message, reasons: err && err.reasons });

      /* The account was NOT created. Say so, put the button back, and keep the
         identity so the same details can be submitted again with one tap —
         this used to toast "Account created — welcome" over a failed write. */
      restoreSignupButton();

      /* TELL THE READER WHOSE FAULT IT IS.

         Both of these messages used to end with "check the connection", and
         for the failure that actually happened that was false in every word:
         Firestore was refusing every request from every client because billing
         had been switched off on the Google Cloud project, the shop's phone was
         working perfectly, and no number of retries could ever have saved the
         form. People re-typed their shop details into a form that could not
         save them, and then blamed their own wifi.

         So an outage says it is an outage, and says the thing that matters
         next: stop retrying, nothing you typed is lost, the owner has to fix
         it. A genuine connection drop keeps the old advice, which is correct
         for it. err.outage is decided in src/data/api.js from the HTTP status
         and the Firestore error code, never from a guess here. */
      if (err && err.code === 'profile-save-failed') {
        state.pendingIdentity = identity;
        authMsg(err.outage
          ? 'Your account could not be created — the site’s database is not ' +
            'responding. This is a fault on our side, not with your connection ' +
            'or your Google account. <strong>Your shop details are still on this ' +
            'screen</strong>, so nothing needs re-typing: press Create account ' +
            'again once the site is back.' +
            reasonNote(err.reasons)
          : 'Your details could not be saved to your account, so it has not been ' +
            'created. Check the connection and press Create account again.' +
            reasonNote(err.reasons));
        toast(err.outage ? 'Site database unavailable — nothing was saved'
                         : 'Account not created — nothing was saved', 'alert');
        return;
      }
      if (err && err.code === 'profile-unreadable') {
        /* Google DID sign them in; only the profile read failed. That is not
           a message to print under a "Continue with Google" button — it is a
           state of the account screen, which already knows how to draw it:
           signed in, what failed, Try again (which re-reads the profile and
           never reopens Google), and Sign out. The session is kept. */
        renderShellBits();
        if (state.route.name === 'account') {
          renderAccount(document.getElementById('page'));
        } else {
          toast(err.outage ? 'Signed in — but the site’s database is not responding'
                           : 'Signed in — your account could not be loaded yet', 'alert');
        }
        return;
      }
      authMsg('Signed in with Google, but your profile could not be loaded. Check the connection and reload.');
    });
  }

  /* One registration at a time. Two taps on Create account used to run the
     whole flow twice against the same uid. The writes merge, so it did not
     duplicate a document, but it did fire two Firestore writes and two toasts
     for one action. */
  var signupInFlight = false;

  function restoreSignupButton() {
    var btn = document.querySelector('[data-act="finish-signup"], [data-act="google-signup"]');
    if (btn) {
      btn.disabled = false;
      if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
    }
    var g = document.querySelector('.gbtn');
    if (g) { g.classList.remove('is-busy'); g.disabled = false; }
  }

  /* Validates, locks the button, and hands off. Shared by both buttons that can
     submit the form so the guard and the loading state cannot drift apart. */
  function submitRegistration(btn, identity) {
    if (signupInFlight) return;
    REG_FIELDS.forEach(function (f) { reg.touched[f.k] = true; });
    if (!regValid()) {
      repaintAuth();
      toast('Complete the highlighted fields first', 'alert');
      return;
    }
    if (!identity) { toast('Sign in again to continue', 'alert'); return; }

    signupInFlight = true;
    if (btn) {
      btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = icon('refresh') + 'Saving your details…';
    }
    authMsg('');
    /* pendingIdentity is NOT cleared here. It used to be, so a failed save left
       nothing to retry with and the shop had to sign in again to re-enter
       everything. It is cleared on success instead. */
    finishGoogle(identity, true);
  }

  /* The plain sign-in half of finishGoogle: resolve identity exactly as boot
     does, then report it in the shape finishGoogle expects. */
  function resolveSignIn(identity) {
    /* ONE RESOLUTION, NOT TWO.

       This used to throw the identity gate away and resolve the account all
       over again — while the auth listener below, woken by the very same
       sign-in, was already doing exactly that for the account screen. Two
       resolutions raced: two server profile-syncs, two profile reads, and
       whichever finished second decided what the screen showed. When the
       database was refusing, the loser cleared the fault the winner had
       recorded, and the screen fell through to the signed-out form — the
       "Google said yes and it sent me back to Sign in" report.

       Now this waits until the listener has published THIS account (it has
       normally done so before the popup promise resolves) and then asks
       resolveIdentity(), which hands back the resolution already running. */
    return accountPublished(identity.sub).then(function () {
      return resolveIdentity();
    }).then(function (r) {
      /* Firestore could not be read — offline, blocked, rules in flight. That
         is NOT the same as "this account has no profile", and treating it as
         one shows the sign-up form to a shop that already has an account and
         invites it to enter everything a second time. Refuse to guess.
         resolveIdentity has already recorded the fault for the screen. */
      if (!r || r.offline) {
        var offline = new Error('profile-unreadable');
        offline.code = 'profile-unreadable';
        offline.outage = identityFault ? !!identityFault.outage : !!(r && r.outage);
        offline.reason = (r && r.reason) || (identityFault && identityFault.code) || null;
        throw offline;
      }

      if (!r.complete) {
        return { needsRegistration: true, identity: identity, existing: r.profile || null };
      }
      /* Access comes from the server, never from the cache this browser holds. */
      return S.syncFromServer().then(function () {
        return { session: S.get(), isNew: !!r.isNew };
      });
    });
  }

  /* Resolves once the auth listener has announced the account with this uid —
     which is what resets the identity gate for it. Bounded: a listener that
     never fires must not hold the sign-in open, and resolveIdentity then
     resolves against whatever Firebase says, exactly as a reload would. */
  function accountPublished(uid) {
    var u = SM.fb.user();
    if (u && u.uid === uid && lastAuthUid === uid) return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      var off = SM.fb.onChange(function (user) {
        if (done || !user || user.uid !== uid) return;
        done = true;
        /* After the app's own listener, which registered first and has
           already reset the gate for this account. */
        setTimeout(function () { if (off) off(); resolve(); }, 0);
      });
      setTimeout(function () {
        if (done) return;
        done = true;
        if (off) off();
        SM.debug.warn('auth', 'account was not announced in time — resolving anyway', { uid: uid });
        resolve();
      }, 10000);
    });
  }

  /* ----------------------------------------------------------------- boot */
  /* Before anything renders, so an account page drawn on this load — including
     the one the browser lands on coming back from a Google redirect — is drawn
     with the shop details already in it rather than empty. */
  restoreRegDraft();
  applyTheme();
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (state.theme === 'system') renderShellBits();
    });
  }
  /* iOS Safari applies :active to a button on touch ONLY if the page has a
     touch listener registered somewhere — a long-standing quirk. The category
     rail reveals its label on :active, so without this the name would simply
     never appear on an iPhone while working everywhere else. An empty passive
     listener is the whole fix and costs nothing per touch. */
  try { document.addEventListener('touchstart', function () {}, { passive: true }); } catch (e) { /* no touch */ }

  /* Registers the service worker and starts watching for the browser's install
     offer. The header redraws whenever that changes, so the button appears the
     moment Chrome decides the site qualifies and disappears once installed —
     without anything having to poll for it. */
  if (SM.pwa) {
    SM.pwa.init();
    SM.pwa.onChange(function () {
      if (document.getElementById('topEnd')) renderShellBits();
    });
  }

  SM.art.mount();
  /* Point every category at its official logo. One call, before the first
     render, so no surface ever paints a drawn placeholder first and swaps. */
  if (SM.categoryAssets) SM.categoryAssets.install();
  /* Same for brands: any licensed logo file is registered before the first
     render, so a brand never paints a wordmark and then swaps to a logo. A
     brand with no file simply keeps its inline vector, which needs no
     registration and no request. */
  if (SM.brandAssets) SM.brandAssets.install();
  /* A legacy #/... link, or a bare /, becomes the clean path before anything
     renders — so the address bar, the canonical tag and what the app shows all
     agree from the first paint. replaceState rather than push: arriving at an
     old URL should not put an extra entry in the back button. */
  (function normaliseUrl() {
    /* Only for pages the app renders. A pre-rendered SEO page keeps its own
       URL and its own content — rewriting it here would replace a real page
       with the finder. */
    if (!location.hash && !ownsPath(location.pathname)) return;
    var want = toPath(parseHash());
    if (location.hash || location.pathname !== want) {
      try { history.replaceState(null, '', want); }
      catch (e) { /* file:// has no History API; the hash path still works */ }
    }
  }());

  /* The shell reads db.stats for the header counts, so it cannot mount before
     the catalogue arrives. A brand mark and a line of text hold the page in
     the meantime — ~280 KB gzipped, so this is brief, but a blank window while
     it downloads would look broken. */
  /* On a pre-rendered page the app has no screen for, stop here. The static
     content stays, its links are real and its URL is untouched — the app has
     nothing to add and everything to break. */
  if (!ownsPath(location.pathname) && document.getElementById('seoContent')) {
    SM.debug.log('boot', 'pre-rendered page, app standing down', { path: location.pathname });
    return;
  }

  var app = document.getElementById('app');
  if (app) {
    app.innerHTML = '<div class="bootwait">' + SM.logoMark(44) +
      '<span>Loading the device catalogue…</span></div>';
  }

  /* The catalogue is what the shell needs; the Firebase config is not.

     They used to be awaited together, which meant a slow /api/firebase-config
     held the whole site on "Loading the device catalogue…" — browsing, search
     and the catalogue all work without Firebase, so none of that should wait on
     sign-in. It is started here so it runs alongside the download, and whoever
     needs it (resolveIdentity) awaits it themselves. */
  SM.fb.loadConfig().catch(function () { return null; });

  /* ------------------------------------------------ start Firebase early, when
     it is going to be needed

     Restoring a session means downloading the auth SDK and letting it read
     IndexedDB, and resolveIdentity used to begin that only after the
     catalogue had arrived — one wait stacked on another, on every page load
     of a signed-in shop. When this browser already holds a signed-in session,
     or the page is the account screen (which must find out either way), the
     two now run side by side. The Firestore SDK is warmed as well for a
     signed-in session, since its profile read comes next.

     A visitor with no session anywhere else on the site still loads neither:
     that is most visits, and they should not pay for sign-in they never use. */
  (function preloadIdentity() {
    var signedIn = S.get().signedIn;
    var onAccount = /^\/account(\/|$)/.test(location.pathname);
    if (!signedIn && !onAccount) return;
    SM.fb.ready().catch(function () { /* resolveIdentity reports it */ });
    if (signedIn && SM.store && SM.store.warm) SM.store.warm();
  }());

  /* ------------------------------------------------- the account, whoever it is

     THE SUBSCRIPTION NOBODY HAD MADE.

     SM.fb.onChange existed and had no subscribers. Firebase would restore a
     session, or finish a redirect, or switch to a different Google account,
     and announce it to an empty room — so whatever was already on screen
     stayed on screen. That is the second half of the vanishing Admin Panel
     link, and all of the risk of one account showing another's UI.

     A uid that differs from the one the role state was resolved for throws
     that state away before anything is drawn with it. That is what makes a
     normal user signing in after the owner a normal user, on the first paint,
     with no admin markup to inherit. */
  var lastAuthUid = null;
  SM.fb.onChange(function (user) {
    var uid = user ? user.uid : null;
    if (uid === lastAuthUid) return;
    SM.debug.log('auth', 'account changed', { from: lastAuthUid, to: uid });
    lastAuthUid = uid;

    /* Role, cached profile keys and the identity latch all belong to the
       account that has just been replaced. */
    clearRoleState();
    identityReady = null;
    identitySettled = false;
    identityFault = null;
    /* A half-finished sign-up belongs to the account that started it. The new
       account's own resolution decides whether it needs one. */
    state.pendingIdentity = null;

    if (!uid) {
      /* Signed out. The local session cache is the one thing that would
         otherwise survive and keep the previous shop on screen. */
      S.signOut();
      forgetRole();
    }

    /* Firebase is started before the catalogue has finished downloading (see
       the preload below), so this can fire before the shell is mounted. The
       state above is reset either way; the drawing waits for mountShell,
       which reads it. */
    if (!document.getElementById('topEnd')) return;
    renderShellBits();
    if (state.route.name === 'account') {
      var host = document.getElementById('page');
      if (host) renderAccount(host);
    }
  });

  /* ------------------------------------------------- when the entitlement moves

     THE SCREEN FOLLOWS THE SERVER'S ANSWER, WHENEVER IT ARRIVES.

     SM.access asks again by itself when the account on the page changes — a
     session Firebase restores a moment after load, a sign-in, a sign-out (see
     src/data/access.js). What it cannot do is redraw anything. Until this
     listener existed, nothing did: the answer changed underneath a page that
     had already been painted for the previous one.

     That is the visible half of the bug a yearly subscriber hit on 2 October
     2026. Their paid answer could arrive after a group or a device had been
     requested as a signed-out visitor, and the paywall drawn from that first
     request simply stayed.

     It acts on a CHANGE of tier or of signed-in state and on nothing else.
     Every group and device response carries the access block and re-emits it,
     so redrawing on every emit would have each reload trigger the next. */
  var lastAccessKey = null;

  function accessKey(a) {
    return a ? (a.paid ? 'paid' : 'free') + ':' + (a.signedIn ? 'in' : 'out') : 'unknown';
  }

  /* Whatever on screen was cut to a tier is asked for again. Only two things
     are: an open group's member list, and a device's matching groups. */
  function reloadGatedContent() {
    if (state.route.name !== 'finder') return;
    if (state.finder.groupId) {
      state.finder.groupMembers = null;
      state.finder.groupLocked = false;
      state.finder.groupLoadFailed = false;
      loadGroupMembers(state.finder.groupId);
      renderWorkspace();
    } else if (state.finder.modelId) {
      if (SM.access.forgetDevice) SM.access.forgetDevice(state.finder.modelId);
      loadMatches();
    }
  }

  /* THE ACCOUNT SCREEN AND THE PAYWALL MUST DESCRIBE THE SAME ACCOUNT.

     They are fed by two requests. /api/access decides what the shop may open;
     /api/subscription fills in the plan the account page shows, and a page
     load within half an hour of the last answer reuses that one rather than
     asking again. So a shop that paid by switching to its UPI app and came
     back to a reloaded page could be let into every group by the first and
     still be told "Free account — pick a plan" by the second.

     When the two disagree about whether there is a plan, the session is
     re-read from the server, once, with no reuse. */
  var reconciling = false;
  function reconcileSession() {
    var a = SM.access && SM.access.get();
    if (!a || !a.signedIn || !S.get().signedIn || reconciling) return;
    if (!!a.paid === S.isPro()) return;
    reconciling = true;
    SM.debug.log('billing', 'account screen and entitlement disagree — re-reading the plan',
                 { paid: !!a.paid, session: S.get().status });
    var done = function () {
      reconciling = false;
      if (!document.getElementById('topEnd')) return;
      renderShellBits();
      rerenderAccountOrPlans();
    };
    S.syncFromServer().then(done, done);
  }

  function rerenderAccountOrPlans() {
    var page = document.getElementById('page');
    if (!page) return;
    /* Not while a purchase is being started from this page. The button that
       was pressed is disabled and showing its progress; redrawing the cards
       would hand back a fresh, enabled one over a payment already under way,
       which is an invitation to start a second. The purchase repaints the
       page itself when it finishes. */
    if (page.querySelector('[data-act="subscribe"][disabled]')) return;
    if (state.route.name === 'account') renderAccount(page);
    else if (state.route.name === 'plans') renderPlans(page);
  }

  /* A payment was taken and this page could not confirm it — the verify call
     failed, or the browser was away in a UPI app when Checkout finished. The
     webhook activates the plan regardless, so the server is asked a few more
     times, and the first answer that says "paid" brings the session with it.

     Bounded and quiet: six questions over about half a minute, then it stops.
     If the plan is still not on by then the function log has the reason, and
     hammering the server from a shop's phone will not change it. */
  var ACTIVATION_POLL_MS = [2000, 3000, 5000, 5000, 8000, 10000];
  var activationPoll = 0;
  function awaitActivation() {
    if (!SM.access) return;
    var run = ++activationPoll;
    var step = function (i) {
      if (run !== activationPoll || i >= ACTIVATION_POLL_MS.length) return;
      setTimeout(function () {
        if (run !== activationPoll) return;
        SM.access.refresh().then(function () {
          if (run !== activationPoll) return;
          if (!SM.access.isPaid()) { step(i + 1); return; }
          S.syncFromServer().then(function () {
            renderShellBits();
            rerenderAccountOrPlans();
            toast('Payment confirmed — plan active');
          });
        });
      }, ACTIVATION_POLL_MS[i]);
    };
    step(0);
  }

  if (SM.access) {
    SM.access.onChange(function (a) {
      var key = accessKey(a);
      if (key === lastAccessKey) return;
      var first = lastAccessKey === null;
      lastAccessKey = key;

      /* Before the shell is mounted there is nothing to redraw, and mountShell
         reads the current answer when it runs. */
      if (!document.getElementById('topEnd')) return;
      renderShellBits();
      /* Dropped, not answered: the new account's answer is on its way and
         brings its own change with it. */
      if (!a) return;
      /* The first answer of the page describes what was loaded alongside it.
         Any later one replaces an answer something may have been drawn from. */
      if (!first) reloadGatedContent();
      /* The account and plans pages are drawn from the session, not from this
         answer, so they are left alone here — reconcileSession repaints them
         itself if it finds the session was out of date. */
      reconcileSession();
    });
  }

  SM.dataset.load().then(function () {
    SM.__rebind.forEach(function (fn) { fn(); });

    /* Restore the session, then resolve identity from Firestore before any
       screen decides whether this is a signed-in user. Rendering from the
       local cache first is what let a stale profile from one device keep
       showing after the same Google account had been used on another. */
    resolveIdentity().then(function (r) {
      renderShellBits();
      if (state.route.name === 'account') renderAccount(document.getElementById('page'));
      if (!r) return;

      /* A signed-in account with no usable profile has already been routed to
         the completion form by resolveIdentity (enterProfileCompletion); the
         repaint above drew it. */
      if (r.complete) {
        /* Pull the SERVER's record of access in. The account screen must show
           the subscription the server believes in, not the one this browser
           last cached — but a page load soon after the last answer reuses it
           rather than asking again (SUBSCRIPTION_REUSE_MS in api.js). Paying or
           cancelling always asks. */
        S.syncFromServer({ reuse: true }).then(function () {
          renderShellBits();
          rerenderAccountOrPlans();
          /* The reused copy may predate a payment made in another app. If it
             now contradicts what the server says this account may open, it is
             thrown away and read again. */
          reconcileSession();
        });
      }
    });

    /* Recent searches resolve stored ids against the catalogue, so this has to
       come after it exists — reading them at boot was what crashed the page. */
    state.recent = loadRecent();
    mountShell();
    /* Back and forward now move between paths, not fragments. */
    window.addEventListener('popstate', route);
    route();

    /* Analytics starts once the app is on screen, never before. It is entirely
       fire-and-forget — see src/data/analytics.js — and the guard is here
       rather than inside it so a build without the file simply has none. */
    if (SM.analytics) SM.analytics.start();

    /* Ask the server what this visitor may do. Repaint when the answer lands
       rather than blocking on it: the catalogue is browsable regardless, and a
       page held back for an entitlement check is a page that feels slow to
       everyone including subscribers. */
    if (SM.access) {
      SM.access.refresh().then(function () {
        renderShellBits();
        if (state.route.name === 'account') renderAccount(document.getElementById('page'));
      });
    }
  }).catch(function (err) {
    console.error('[dataset]', (err && err.stack) || err);
    global.__bootError = (err && err.stack) || String(err);
    var host = document.getElementById('app');
    if (host) {
      host.innerHTML = '<div class="wrap" style="padding:40px 20px">' + C.state({
        icon: 'alert',
        title: 'Could not load the catalogue',
        text: 'The device database did not download. Check the connection and reload the page.'
      }) + '</div>';
    }
  });
})(window);
