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
     The handsets worth putting in front of a counter: the ones the most part
     groups fit. That number is what makes a model useful to stock for — a
     phone with six part groups is six things you can sell for it — and it is
     already on the model card, so the ranking and the card agree.

     It is counted from db.groupsByModel, the same public map the device pages
     read. No member list is opened and nothing withheld becomes visible: a
     count of groups is not a list of them. */
  var suggestModelCache = Object.create(null);

  function suggestModels(opts) {
    opts = opts || {};
    var cat = opts.categoryId && opts.categoryId !== 'all' ? opts.categoryId : null;
    var brand = opts.brandId && opts.brandId !== 'all' ? opts.brandId : null;
    var want = Math.max(1, (opts.limit | 0) || 12);
    var key = [cat || 'all', brand || 'all', want].join('|');
    if (suggestModelCache[key]) return suggestModelCache[key];

    var counts = db.partCountsByCategory || {};
    var out = db.models.filter(function (m) {
      if (brand && m.brandId !== brand) return false;
      return groupCountFor(m.id, cat, counts) > 0;
    }).sort(function (a, b) {
      var ga = groupCountFor(a.id, cat, counts), gb = groupCountFor(b.id, cat, counts);
      if (gb !== ga) return gb - ga;
      var ta = parseReleaseTs(a.releaseDateIso), tb = parseReleaseTs(b.releaseDateIso);
      if (tb !== ta) return tb - ta;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }).slice(0, want);

    suggestModelCache[key] = out;
    return out;
  }

  function groupCountFor(modelId, cat, counts) {
    if (cat) return (counts[modelId] && counts[modelId][cat]) || 0;
    return (db.groupsByModel[modelId] || []).length;
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

    listModels: function (opts) {
      opts = opts || {};
      var q = norm(opts.q);
      var list = db.modelsRanked.filter(function (m) {
        if (opts.brandId && opts.brandId !== 'all' && m.brandId !== opts.brandId) return false;
        if (q && m.search.indexOf(q) === -1 && norm(m.fullName).indexOf(q) === -1) return false;
        return true;
      });
      if (opts.sort === 'az') list = list.slice().sort(function (a, b) { return a.fullName.localeCompare(b.fullName); });
      if (opts.sort === 'newest') list = list.slice().sort(function (a, b) { return b.releaseYear - a.releaseYear || a.fullName.localeCompare(b.fullName); });
      return respond(page(list, opts.page, opts.pageSize || 24), LAT.normal);
    },

    getModel: function (id) {
      var m = db.modelById[id];
      if (!m) return respond(null, LAT.fast);
      var gids = db.groupsByModel[m.id] || [];
      /* The public catalogue ships counts per category and withholds the group
         ids, so counting memberships here returns zero for every category.
         The count map is the source when it exists; the membership scan is
         the fallback for a fully loaded catalogue. */
      var counts = db.partCountsByCategory && db.partCountsByCategory[m.id];
      return respond({
        model: m,
        groupCount: gids.length,
        categories: db.categories.map(function (c) {
          return {
            category: c,
            count: counts
              ? (counts[c.id] || 0)
              : gids.filter(function (gid) {
                  var g = db.groupById[gid];
                  return g && g.categoryId === c.id;
                }).length
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

    /* The handsets the most part groups fit, for the current filter. */
    suggestModels: function (opts) { return respond(suggestModels(opts), LAT.fast); },


    getGroup: function (groupId) {
      var g = db.groupById[groupId];
      return respond(g ? hydrate(g) : null, LAT.fast);
    },

    /* the core Device Finder lookup: model (+ optional category) -> groups */
    findMatches: function (opts) {
      opts = opts || {};
      var order = {};
      db.categories.forEach(function (c, i) { order[c.id] = i; });
      var gids = db.groupsByModel[opts.modelId] || [];
      var out = gids.map(function (id) { return db.groupById[id]; })
        .filter(function (g) { return !opts.categoryId || opts.categoryId === 'all' || g.categoryId === opts.categoryId; })
        /* canonical part order first (glass, cover, display, …), then group no. */
        .sort(function (a, b) {
          return order[a.categoryId] - order[b.categoryId] || a.groupNumber.localeCompare(b.groupNumber);
        })
        .map(hydrate);
      return respond(out, LAT.normal);
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

      if (counts) {
        byCat = counts;
      } else {
        (db.groupsByModel[modelId] || []).forEach(function (id) {
          var g = db.groupById[id];
          if (g) byCat[g.categoryId] = (byCat[g.categoryId] || 0) + 1;
        });
      }
      return respond(db.categories.map(function (c) {
        return { category: c, count: byCat[c.id] || 0 };
      }), LAT.fast);
    }
  };

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

  /* the single source of truth for what state an account is in */
  function deriveStatus(profile) {
    if (!profile) return 'guest';
    var s = profile.subscription;
    if (!s || !s.expiresAt) return 'free';
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
    if (s && s.expiresAt) {
      var total = Math.max(1, s.expiresAt - s.startedAt);
      var left = s.expiresAt - Date.now();
      view.plan = s.plan;
      view.subscription = {
        plan: s.plan,
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
  function initializeAuthenticatedUser(fbUser) {
    if (!fbUser) {
      SM.debug.log('identity', 'no user to initialise');
      return Promise.resolve({ profile: null, complete: false, isNew: false });
    }
    var uid = fbUser.uid;
    SM.debug.log('identity', 'initialising', { uid: uid, email: fbUser.email || null });

    if (!SM.store || !SM.store.available()) {
      SM.debug.warn('identity', 'firestore unavailable — profile cannot be resolved');
      return Promise.resolve({ profile: null, complete: false, isNew: false, offline: true });
    }

    /* THE WRITE THAT MAKES THE DOCUMENT EXIST.
       Firebase Authentication creating a user creates nothing in Firestore —
       they are separate products — so a sign-in that never reached the sign-up
       form left an account with no record anywhere. That was the bug: visible
       under Authentication -> Users, absent from the users collection.

       It runs on the server through the Admin SDK, for two reasons. Security
       rules cannot silently swallow it, which a client-side write can; and the
       server-owned fields — the opening subscriptionStatus, accountStatus,
       lastLoginAt — get written by the only party allowed to write them.

       Its failure is not fatal. Firestore is still read below, and the browser
       still writes its own shop details directly, so a profile-sync that cannot
       reach the server degrades to what the app did before rather than blocking
       the sign-in. */
    var synced = SM.billing
      ? SM.billing.syncProfile({ photoURL: fbUser.photoURL || null })
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
          })
      : Promise.resolve(null);

    return synced.then(function () {
      return SM.store.loadProfile(uid);
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
      return { profile: SM.auth.findProfile(uid) || null, complete: false, isNew: false, offline: true };
    });
  }
  SM.session_initializeAuthenticatedUser = initializeAuthenticatedUser;

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
    var reasons = [];

    var viaServer = SM.billing
      ? SM.billing.syncProfile({ photoURL: identity.picture || null, profile: shop })
          .then(function (r) {
            serverOk = true;
            SM.debug.log('signup', 'profile written server side', { uid: r.uid, complete: r.profileCompleted });
            return r;
          }, function (e) {
            reasons.push('server: ' + ((e && e.message) || 'unreachable'));
            SM.debug.warn('signup', 'server profile write failed',
                          { status: e && e.status, error: e && e.message });
            return null;
          })
      : Promise.resolve(null);

    var viaClient = (SM.store && SM.store.available() && SM.fb.user())
      ? SM.store.saveProfile(identity.sub, shop, SM.fb.user())
          .then(function (p) {
            clientOk = true;
            SM.debug.log('signup', 'profile written from the browser', { uid: identity.sub });
            return p;
          }, function (e) {
            reasons.push('client: ' + ((e && e.code) || (e && e.message) || 'failed'));
            SM.debug.warn('signup', 'direct profile write failed', { code: e && e.code });
            return null;
          })
      : Promise.resolve(null);

    return Promise.all([viaServer, viaClient]).then(function () {
      if (!serverOk && !clientOk) {
        var err = new Error('profile-save-failed');
        err.code = 'profile-save-failed';
        err.reasons = reasons;
        throw err;
      }
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
    initializeAuthenticatedUser: function (fbUser) { return initializeAuthenticatedUser(fbUser); },

    signInWithGoogle: function (identity, registration) {
      var remote = (SM.store && SM.store.available())
        ? SM.store.loadProfile(identity.sub).catch(function (e) {
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
    signOut: function () {
      writeSub(null);
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
    syncFromServer: function () {
      if (!this.hasPaymentBackend() || !current.signedIn) return Promise.resolve(current);
      return SM.billing.status().then(function (data) {
        var a = data.access || {};
        SM.auth.saveProfile(current.sub, {
          subscription: a.expiresAt ? {
            plan: a.plan,
            startedAt: a.startedAt,
            expiresAt: a.expiresAt,
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
