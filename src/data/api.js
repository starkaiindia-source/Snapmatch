/* ============================================================================
   SnapMatch · api.js  —  the integration seam
   ----------------------------------------------------------------------------
   Every screen talks to the app ONLY through SM.api. Each method returns a
   Promise and resolves after a small simulated delay, so all loading states in
   the UI are real. To connect the live ProGlide backend later, replace the
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
  var db = SM.db;

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
      devices: g.compatibleDeviceIds.map(function (id) { return db.modelById[id]; })
    };
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
      return respond({
        model: m,
        groupCount: gids.length,
        categories: db.categories.map(function (c) {
          return {
            category: c,
            count: gids.filter(function (gid) { return db.groupById[gid].categoryId === c.id; }).length
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

    listGroups: function (opts) {
      opts = opts || {};
      var q = norm(opts.q);
      var list = db.groups.filter(function (g) {
        if (opts.categoryId && opts.categoryId !== 'all' && g.categoryId !== opts.categoryId) return false;
        if (opts.brandId && opts.brandId !== 'all' && db.modelById[g.masterModelId].brandId !== opts.brandId) return false;
        if (opts.minCount && g.compatibleCount < opts.minCount) return false;
        if (q) {
          var hit = norm(g.groupNumber).indexOf(q) > -1 ||
            norm(g.partCode).indexOf(q) > -1 ||
            norm(g.serialNumber).indexOf(q) > -1 ||
            norm(db.modelById[g.masterModelId].fullName).indexOf(q) > -1;
          if (!hit) {
            hit = g.compatibleDeviceIds.some(function (id) {
              return norm(db.modelById[id].fullName).indexOf(q) > -1;
            });
          }
          if (!hit) return false;
        }
        return true;
      });

      var sort = opts.sort || 'default';
      if (sort === 'most') list = list.slice().sort(function (a, b) { return b.compatibleCount - a.compatibleCount; });
      else if (sort === 'least') list = list.slice().sort(function (a, b) { return a.compatibleCount - b.compatibleCount; });
      else if (sort === 'az') list = list.slice().sort(function (a, b) {
        return db.modelById[a.masterModelId].fullName.localeCompare(db.modelById[b.masterModelId].fullName);
      });

      var res = page(list, opts.page, opts.pageSize || 12);
      res.items = res.items.map(hydrate);
      return respond(res, LAT.normal);
    },

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
    categoryAvailability: function (modelId) {
      var gids = db.groupsByModel[modelId] || [];
      var byCat = Object.create(null);
      gids.forEach(function (id) {
        var g = db.groupById[id];
        byCat[g.categoryId] = (byCat[g.categoryId] || 0) + 1;
      });
      return respond(db.categories.map(function (c) {
        return { category: c, count: byCat[c.id] || 0 };
      }), LAT.fast);
    }
  };

  SM.api = api;

  /* ==========================================================================
     Session + subscription — MOCK ONLY.
     No auth provider, no payment gateway, no server validation. State is held
     in memory and mirrored to localStorage so a refresh keeps the demo intact.
     ========================================================================== */
  var KEY = 'snapmatch.session.v1';
  var DEFAULT = { status: 'guest', name: '', email: '', plan: null, renewsOn: null, since: null };

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return Object.assign({}, DEFAULT);
      return Object.assign({}, DEFAULT, JSON.parse(raw));
    } catch (e) { return Object.assign({}, DEFAULT); }
  }
  function write(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
  }

  var current = read();
  var listeners = [];

  function emit() { listeners.forEach(function (fn) { fn(current); }); }
  function set(patch) {
    current = Object.assign({}, current, patch);
    write(current);
    emit();
    return current;
  }
  function fmtDate(d) {
    var mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getDate() + ' ' + mo[d.getMonth()] + ' ' + d.getFullYear();
  }

  SM.session = {
    get: function () { return current; },
    isPro: function () { return current.status === 'pro'; },
    onChange: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },

    signIn: function (email, name) {
      return respond(set({
        status: 'free',
        email: email,
        name: name || email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }),
        since: fmtDate(new Date())
      }), LAT.slow);
    },
    signOut: function () { return respond(set(Object.assign({}, DEFAULT)), LAT.fast); },

    /* prototype only — nothing is charged, nothing is validated server-side */
    subscribe: function (planId) {
      var d = new Date();
      d.setDate(d.getDate() + (planId === 'yearly' ? 365 : 30));
      return respond(set({
        status: 'pro',
        plan: planId,
        renewsOn: fmtDate(d),
        email: current.email || 'demo@proglide.app',
        name: current.name || 'Demo Shop',
        since: current.since || fmtDate(new Date())
      }), LAT.slow);
    },
    cancel: function () { return respond(set({ status: 'expired' }), LAT.normal); },

    /* demo switch used by the review panel to jump between access states */
    setState: function (status) {
      var d = new Date(); d.setDate(d.getDate() + 30);
      if (status === 'guest') return set(Object.assign({}, DEFAULT));
      if (status === 'free') return set({ status: 'free', plan: null, renewsOn: null, email: current.email || 'demo@proglide.app', name: current.name || 'Demo Shop', since: current.since || fmtDate(new Date()) });
      if (status === 'pro') return set({ status: 'pro', plan: current.plan || 'monthly', renewsOn: fmtDate(d), email: current.email || 'demo@proglide.app', name: current.name || 'Demo Shop', since: current.since || fmtDate(new Date()) });
      if (status === 'expired') return set({ status: 'expired', renewsOn: null, email: current.email || 'demo@proglide.app', name: current.name || 'Demo Shop' });
      return current;
    }
  };

  SM.PLANS = [
    {
      id: 'monthly', name: 'Monthly', price: 99, per: 'month', cadence: '₹99 billed every month',
      note: 'Best for trying SnapMatch in your shop.',
      feats: ['Unlimited Device Finder searches', 'Every compatibility group unlocked', 'Full compatible-device lists', 'Part code, group & serial numbers', 'Works on counter phone, tablet & PC']
    },
    {
      id: 'yearly', name: 'Yearly', price: 799, per: 'year', cadence: '₹799 billed once a year', badge: 'Save ₹389',
      note: 'Works out to ₹67 a month — two months free.',
      feats: ['Everything in Monthly', 'Two months free vs paying monthly', 'Priority access to new part categories', 'Bulk part-code export (coming soon)', 'Shop staff logins (coming soon)']
    }
  ];
})(window);
