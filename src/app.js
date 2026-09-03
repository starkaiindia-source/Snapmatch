/* ============================================================================
   Mobile Parts Finder · app.js — shell, hash router, pages, interactions
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, C = SM.C, icon = SM.icon, api = SM.api, db = SM.db, S = SM.session;
  (SM.__rebind = SM.__rebind || []).push(function () { db = SM.db; });
  var esc = C.esc, nf = C.nf;

  /* ------------------------------------------------------------------ state */
  var state = {
    theme: store('mpf.theme') || 'system',
    deviceColour: 0,        /* which finish the device page is showing */
    deviceId: null,
    deviceVariant: null,  /* {ramGb, storageGb} the detail page is showing */
    route: { name: 'finder', params: {} },
    base: '#/finder',
    finder: {
      modelId: null, catId: null, query: '', matchShown: 6, avail: null,
      filters: { q: '', brandId: 'all', catId: 'all', sort: 'default' },
      page: 1, rows: [], total: 0, hasMore: false, busy: false
    },
    models: { brandId: null, q: '', page: 1, items: [], total: 0, hasMore: false, busy: false,
      /* View state, not query state: the same records are already in memory,
         so a dropdown change re-renders instead of re-fetching. The chosen
         view is remembered because it is a working preference, not a session
         detail — someone who prefers the table wants it next time too. */
      view: store('mpf.modelview') || 'grid',
      sort: 'newest',
      filters: { deviceType: '', curve: '', year: '', size: '', fiveG: '', minRam: '', minStorage: '', minBattery: '' }
    },
    recent: [],
    brandQ: '',
    suggest: { open: false, q: '', items: [], cursor: -1 },
    sheet: null,           /* { type:'group'|'model'|'filters'|'demo', id } */
    devView: { shown: 60, q: '' }
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
    { id: 'finder', href: '#/finder', label: 'Device Finder', short: 'Finder', icon: 'search' },
    { id: 'models', href: '#/models', label: 'All Mobile Models', short: 'Models', icon: 'grid' },
    { id: 'plans', href: '#/plans', label: 'Plans', short: 'Plans', icon: 'crown' },
    { id: 'account', href: '#/account', label: 'Account', short: 'Account', icon: 'user' }
  ];

  function mountShell() {
    document.getElementById('app').innerHTML =
      '<header class="topbar"><div class="shell topbar__in">' +
      '<div class="topbar__lead">' +
      '<a class="logo" href="#/finder" aria-label="Mobile Parts Finder home">' + SM.logoMark(34) +
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
      return '<a class="nav__a' + (cur === n.id ? ' is-on' : '') + '" href="' + n.href + '" title="' + esc(n.label) + '">' +
        icon(n.icon) + '<span>' + esc(n.label) + '</span></a>';
    }).join('');

    document.getElementById('tabbar').innerHTML = NAV.map(function (n) {
      return '<a class="tab' + (cur === n.id ? ' is-on' : '') + '" href="' + n.href + '">' +
        icon(n.icon) + '<span>' + esc(n.short) + '</span></a>';
    }).join('');

    var s = S.get();
    var dark = state.theme === 'dark' || (state.theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var end = '<button class="iconbtn" data-act="open-filters" title="Filters" aria-label="Filter groups">' + icon('sliders') + '</button>' +
      '<button class="iconbtn" data-act="theme" title="Switch theme" aria-label="Switch colour theme">' + icon(dark ? 'sun' : 'moon') + '</button>';
    if (s.status === 'guest') {
      end += '<a class="btn btn--primary btn--sm" href="#/account">Sign in</a>';
    } else {
      end += '<a class="avatar" href="#/account" title="' + esc(s.name) + '">' + esc(initials(s.name)) + '</a>';
    }
    document.getElementById('topEnd').innerHTML = end;

    /* keep the header field in sync without stealing what is being typed */
    var qh = document.getElementById('qh');
    if (qh && document.activeElement !== qh) qh.value = state.finder.query;
  }
  function initials(n) {
    return (n || 'PG').split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
  }

  /* ----------------------------------------------------------------- router */
  function parseHash() {
    var h = (location.hash || '#/finder').replace(/^#\/?/, '');
    var parts = h.split('/').filter(Boolean);
    var name = parts[0] || 'finder';
    return { name: name, params: parts.slice(1) };
  }

  function route() {
    var r = parseHash();
    /* A model used to open as a bottom sheet. It is a full page now — see
       renderDevice — so only groups still take the overlay path. */
    if (r.name === 'group') {
      state.sheet = { type: r.name, id: r.params[0] };
      state.devView = { shown: 60, q: '' };
      if (!document.getElementById('page').innerHTML) renderPage(state.route);
      renderSheet();
      return;
    }
    state.sheet = null;
    document.getElementById('overlay').innerHTML = '';
    document.body.style.overflow = '';
    state.route = r;
    state.base = location.hash || '#/finder';
    renderShellBits();
    renderPage(r);
    window.scrollTo({ top: 0, behavior: 'instant' in document.documentElement.style ? 'instant' : 'auto' });
  }

  function go(hash) { location.hash = hash; }
  function closeSheet() {
    if (history.length > 1 && state.base) history.back();
    else go(state.base || '#/finder');
  }

  function renderPage(r) {
    var page = document.getElementById('page');
    if (r.name === 'models') return renderModels(page, r.params[0]);
    if (r.name === 'model') return renderDevice(page, r.params[0]);
    if (r.name === 'plans') return renderPlans(page);
    if (r.name === 'account') return renderAccount(page);
    return renderFinder(page);
  }

  /* ==========================================================================
     PAGE · DEVICE FINDER  (default landing)
     ========================================================================== */
  function renderFinder(page) {
    var f = state.finder;
    var picked = f.modelId ? db.modelById[f.modelId] : null;
    var st = db.stats;

    var benchInner =
      (picked ? '' :
        '<span class="bench__eyebrow">' + icon('sparkle') + 'Compatibility groups for ' + nf(st.models) + ' phone models</span>' +
        '<h1 class="t-hero">Which parts fit<br><em>this phone?</em></h1>' +
        '<p class="bench__sub">Type any model. Mobile Parts Finder returns the compatibility group, its master model, the part code and every other device that takes the same part.</p>') +
      searchHTML(picked) +
      /* the stat cards are gone; the category rail sits directly under the
         search instead, and is the only category selector on narrow screens */
      (picked ? '' : '<div id="catRail">' + categoryRailHTML() + '</div>');

    if (picked) {
      /* Result page: its own compact sticky head (search + close + category
         rail). The app header is hidden on narrow screens so it is not
         repeated above this one. */
      page.classList.remove('is-ws');
      document.getElementById('app').classList.add('is-result');
      page.innerHTML =
        '<section class="bench rhead"><div class="shell bench__in">' +
        '<div class="rhead__row">' + searchBoxHTML('q') +
        '<button class="rhead__x" data-act="exit-result" title="Close result" ' +
        'aria-label="Close result and return to Finder">' + icon('close') + '</button>' +
        '</div>' +
        '<div id="catRail">' + resultRailHTML() + '</div>' +
        '</div></section>' +
        '<div class="shell" id="finderBody"></div>';
      renderSelection();
      return;
    }
    document.getElementById('app').classList.remove('is-result');

    /* browse mode — full-width workspace. Below 1180px the same markup falls
       back to the original stacked page (side panels move into the filter
       sheet), so the mobile and tablet experience is untouched. */
    page.classList.add('is-ws');
    page.innerHTML =
      '<div class="ws">' +
      '<section class="bench ws__band"><div class="shell bench__in">' + benchInner + '</div></section>' +
      '<div class="ws__body">' +
      '<aside class="ws__left" id="catPanel" aria-label="Part categories"></aside>' +
      '<div class="ws__center" id="wsCenter">' +
      '<div id="centerHead" class="ws__head"></div>' +
      '<div id="results">' + C.skelPlates(6) + '</div>' +
      '<div class="loadmore" id="loadmore"></div>' +
      '</div>' +
      '<aside class="ws__right" id="brandPanel" aria-label="Brands"></aside>' +
      '</div></div>';
    renderBrowse();
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
  function renderBrowse() {
    if (!document.getElementById('catPanel')) { renderFinder(document.getElementById('page')); return; }
    document.getElementById('catPanel').innerHTML = categoryPanelHTML();
    document.getElementById('brandPanel').innerHTML = brandPanelHTML();
    document.getElementById('centerHead').innerHTML = centerHeadHTML();
    var rail = document.getElementById('catRail');
    if (rail) {
      var keep = rail.querySelector('.crail') ? rail.querySelector('.crail').scrollLeft : 0;
      rail.innerHTML = categoryRailHTML();
      /* keep the rail where the user had scrolled it */
      var r = rail.querySelector('.crail');
      if (r) r.scrollLeft = keep;
    }
    loadGroups(true);
  }

  function centerHeadHTML() {
    var f = state.finder;
    var searchField = function (id) {
      return '<label class="field">' + icon('search') +
        '<input class="input" id="' + id + '" placeholder="Filter groups, part codes…" ' +
        'value="' + esc(f.filters.q) + '" aria-label="Filter groups" /></label>';
    };
    return (
      '<div class="sec"><div class="sec__head"><div class="sec__title">' +
      '<h2>Compatibility groups</h2><span class="sec__count" id="gcount">…</span></div>' +
      '<div class="row wrap ws-tools" style="gap:8px">' +
      '<span class="ws-only">' + searchField('gqd') + '</span>' +
      '<label class="sr" for="sortSel">Sort groups</label>' +
      '<select class="input" id="sortSel" style="width:auto;height:38px">' +
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

  /* Category priority used by the Result page — both for the rail order and
     for the grouped "All Parts" listing. Anything not listed follows after. */
  var RESULT_CAT_ORDER = ['tempered-glass', 'back-cover', 'combo-display', 'middle-frame', 'cc-board', 'battery'];

  function resultCategories() {
    var byId = {}, out = [];
    db.categories.forEach(function (c) { byId[c.id] = c; });
    RESULT_CAT_ORDER.forEach(function (id) { if (byId[id]) { out.push(byId[id]); byId[id] = null; } });
    db.categories.forEach(function (c) { if (byId[c.id]) out.push(c); });
    return out;
  }

  /* Result-page rail: same look and behaviour as the home rail, ordered by
     the priority above and annotated with this model's group counts. */
  function resultRailHTML() {
    var f = state.finder;
    var avail = f.avail;
    function item(id, name, count) {
      var on = (id === 'all') ? !f.catId : f.catId === id;
      var empty = count === 0;
      return '<button type="button" class="crail__item' + (on ? ' is-on' : '') + (empty ? ' is-empty' : '') + '" ' +
        'data-act="pick-cat-rail" data-id="' + id + '" aria-pressed="' + on + '"' + (empty ? ' disabled' : '') + '>' +
        SM.art.category(id, 'pthumb--rail') +
        '<span class="crail__name">' + esc(name) + '</span>' +
        '<span class="crail__n">' + (count == null ? '&nbsp;' : count) + '</span>' +
        '</button>';
    }
    var total = avail ? Object.keys(avail).reduce(function (n, k) { return n + avail[k]; }, 0) : null;
    return '<div class="crail" role="group" aria-label="Part categories">' +
      item('all', 'All Parts', total) +
      resultCategories().map(function (c) {
        return item(c.id, c.name, avail ? (avail[c.id] || 0) : null);
      }).join('') +
      '</div>';
  }

  /* ---- horizontal product-category rail, directly under the main search ---- */
  function categoryRailHTML() {
    var sel = state.finder.filters.catId;
    function item(id, name, count) {
      var on = sel === id;
      return '<button type="button" class="crail__item' + (on ? ' is-on' : '') + '" ' +
        'data-act="filter-cat" data-id="' + id + '" aria-pressed="' + on + '">' +
        SM.art.category(id, 'pthumb--rail') +
        '<span class="crail__name">' + esc(name) + '</span>' +
        '<span class="crail__n">' + count + '</span>' +
        '</button>';
    }
    return '<div class="crail" role="group" aria-label="Part categories">' +
      item('all', 'All Parts', db.stats.groups) +
      db.categories.map(function (c) { return item(c.id, c.name, c.groupCount); }).join('') +
      '</div>';
  }

  function opt(v, l, cur) {
    return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + esc(l) + '</option>';
  }
  function activeFilterCount() {
    var f = state.finder.filters;
    return (f.brandId !== 'all' ? 1 : 0) + (f.catId !== 'all' ? 1 : 0) + (f.sort !== 'default' ? 1 : 0);
  }

  /* ---- LEFT panel: part categories as a 2-up grid of icon-over-name tiles --- */
  function categoryPanelHTML() {
    var f = state.finder.filters;
    var tile = function (id, name, color, ic, count, wide) {
      var on = f.catId === id;
      return '<button type="button" class="ctile' + (on ? ' is-on' : '') + (wide ? ' ctile--wide' : '') + '" ' +
        'data-act="filter-cat" data-id="' + id + '" style="--c:' + color + '"' +
        (on ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' +
        SM.art.category(id === 'all' ? 'all' : id, 'pthumb--tile') +
        '<span class="ctile__foot"><span class="ctile__name">' + esc(name) + '</span>' +
        '<span class="ctile__n">' + count + ' ' + (count === 1 ? 'group' : 'groups') + '</span></span>' +
        (on ? '<span class="ctile__tick">' + icon('check') + '</span>' : '') +
        '</button>';
    };
    return '<section class="panel">' +
      '<div class="panel__head"><span class="t-lab">Part category</span>' +
      (f.catId !== 'all'
        ? '<button class="panel__clear" data-act="filter-cat" data-id="all">' + icon('close') + 'Clear</button>'
        : '<span class="panel__n">' + db.categories.length + '</span>') +
      '</div>' +
      '<div class="ctiles">' +
      tile('all', 'All Categories', 'var(--teal-500)', 'grid', db.stats.groups) +
      db.categories.map(function (c, i) {
        return tile(c.id, c.name, c.color, c.icon, c.groupCount, i === db.categories.length - 1);
      }).join('') +
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
        SM.art.brand(b, 'blogo--sm') +
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
    if (reset) { f.page = 1; f.rows = []; f.cursor = null; }
    f.busy = true;
    var res = document.getElementById('results');
    if (reset && res) res.innerHTML = C.skelPlates(6);
    /* a new result set always starts at the top of the centre column */
    if (reset) { var sc = wsScroller(); if (sc) sc.scrollTop = 0; }
    api.listGroups({
      q: f.filters.q, brandId: f.filters.brandId, categoryId: f.filters.catId,
      sort: f.filters.sort, page: f.page, pageSize: 12, cursor: f.cursor
    }).then(function (r) {
      f.busy = false; f.total = r.total; f.hasMore = r.hasMore;
      f.cursor = r.cursor || null;
      f.source = r.source || 'catalogue';
      f.rows = reset ? r.items : f.rows.concat(r.items);
      paintGroups();
    });
  }

  function paintGroups() {
    var f = state.finder;
    var res = document.getElementById('results');
    var lm = document.getElementById('loadmore');
    var cnt = document.getElementById('gcount');
    if (!res) return;
    if (cnt) cnt.textContent = nf(f.total) + (f.total === 1 ? ' group' : ' groups');

    if (!f.rows.length) {
      res.innerHTML = C.state({
        icon: 'inbox', title: 'No compatibility group matches those filters',
        text: 'Try a different part category or brand, or clear the filter text.',
        action: '<button class="btn btn--soft" data-act="reset-filters">' + icon('refresh') + 'Reset filters</button>'
      });
      lm.innerHTML = '';
      return;
    }
    res.innerHTML = '<div class="gridcards">' + f.rows.map(function (row) { return C.plate(row); }).join('') + '</div>';
    lm.innerHTML = f.hasMore
      ? '<button class="btn btn--outline" data-act="more-groups">' + icon('plus') + 'Show more groups <span class="muted">(' + nf(f.total - f.rows.length) + ' left)</span></button>'
      : '<span class="t-xs muted">All ' + nf(f.total) + ' groups shown</span>';
    observeMore();
  }

  /* the centre column scrolls on its own above 1180px and with the page below */
  function wsScroller() {
    var el = document.getElementById('wsCenter');
    if (!el) return null;
    return getComputedStyle(el).overflowY === 'auto' ? el : null;
  }

  var io = null;
  function observeMore() {
    var lm = document.getElementById('loadmore');
    if (!lm || !('IntersectionObserver' in window)) return;
    if (io) io.disconnect();
    io = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting && state.finder.hasMore && !state.finder.busy) {
        state.finder.page++; loadGroups(false);
      }
    }, { root: wsScroller(), rootMargin: '300px' });
    io.observe(lm);
  }

  /* ------------------------------------------------ selected-model workflow */
  function renderSelection() {
    var f = state.finder;
    var m = db.modelById[f.modelId];
    var b = db.brandById[m.brandId];

    document.getElementById('finderBody').innerHTML =
      '<div class="sec"><div class="card card--pad" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
      SM.brandLogo(b, 'blogo--lg') +
      '<div class="grow" style="min-width:180px">' +
      '<span class="t-lab">Selected model</span>' +
      '<h2 class="t-h1" style="margin-top:2px">' + esc(m.fullName) + '</h2>' +
      '<div class="row wrap" style="gap:6px;margin-top:8px">' +
      '<span class="pill">' + m.displaySize + '&Prime;</span>' +
      '<span class="pill">' + esc(m.screenType) + '</span>' +
      '<span class="pill">' + esc(m.releaseDate) + '</span>' +
      '</div></div>' +
      '<div class="row" style="gap:8px">' +
      '<button class="btn btn--outline btn--sm" data-act="open-model" data-id="' + m.id + '">' + icon('info') + 'Specs</button>' +
      '<button class="btn btn--ghost btn--sm" data-act="clear-model">' + icon('close') + 'Clear</button>' +
      '</div></div></div>' +

      /* category picking lives only in the rail above — no duplicate grid */
      '<div class="sec" id="matchRegion">' + C.skelPlates(2) + '</div>';

    if (!f.avail) {
      api.categoryAvailability(m.id).then(function (rows) {
        if (state.finder.modelId !== m.id) return;
        var map = Object.create(null);
        rows.forEach(function (r) { map[r.category.id] = r.count; });
        state.finder.avail = map;
        var rail = document.getElementById('catRail');
        if (rail) rail.innerHTML = resultRailHTML();
      });
    }
    loadMatches();
  }

  function loadMatches() {
    var f = state.finder;
    api.findMatches({ modelId: f.modelId, categoryId: f.catId || 'all' }).then(function (rows) {
      var host = document.getElementById('matchRegion');
      if (!host) return;
      var m = db.modelById[f.modelId];
      var cat = f.catId ? db.categoryById[f.catId] : null;

      if (!rows.length) {
        host.innerHTML = C.state({
          icon: 'alert', brand: true,
          title: cat ? 'No ' + cat.name.toLowerCase() + ' group for this model yet' : 'No compatibility group for this model yet',
          text: 'This model is in the database but has not been grouped for this part category. Try another category, or browse the full group library.',
          action: '<div class="row" style="gap:8px"><button class="btn btn--soft" data-act="clear-cat">' + icon('layers') + 'Try all categories</button>' +
            '<button class="btn btn--outline" data-act="clear-model">' + icon('grid') + 'Browse all groups</button></div>'
        });
        return;
      }

      var pro = S.isPro();
      var catCount = {};
      rows.forEach(function (r) { catCount[r.group.categoryId] = 1; });
      var nCats = Object.keys(catCount).length;

      /* All Parts: keep categories together, in the agreed priority order,
         instead of interleaving them */
      if (!cat) {
        var order = {};
        resultCategories().forEach(function (c, i) { order[c.id] = i; });
        rows = rows.slice().sort(function (a, b) {
          return (order[a.group.categoryId] - order[b.group.categoryId]) ||
            a.group.groupNumber.localeCompare(b.group.groupNumber);
        });
      }

      var shown = rows.slice(0, f.matchShown);
      var head = '<div class="sec__head"><div class="sec__title">' +
        '<h2>' + (rows.length === 1 ? 'Match found' : rows.length + ' matches found') + '</h2>' +
        '<span class="sec__count">' + esc(m.fullName) + (cat ? ' · ' + esc(cat.name) : '') + '</span>' +
        '</div></div>' +
        (rows.length > 1 && !cat
          ? '<div class="notice notice--brand" style="margin-bottom:14px">' + icon('layers') +
          '<span><b>' + esc(m.fullName) + '</b> appears in ' + rows.length + ' compatibility groups across ' +
          nCats + ' part ' + (nCats === 1 ? 'category' : 'categories') + '. Pick a category above to narrow it down.</span></div>'
          : '');

      var lastCat = null;
      host.innerHTML = head + shown.map(function (row) {
        var heading = '';
        /* a heading before the first card of each category block */
        if (!cat && row.group.categoryId !== lastCat) {
          lastCat = row.group.categoryId;
          var c = row.category;
          var n = rows.filter(function (r) { return r.group.categoryId === c.id; }).length;
          heading = '<div class="catgroup" style="--c:' + c.color + '">' +
            SM.art.category(c.id, 'pthumb--head') +
            '<span class="catgroup__name">' + esc(c.name) + '</span>' +
            '<span class="catgroup__n">' + n + (n === 1 ? ' group' : ' groups') + '</span>' +
            '</div>';
        }
        return heading + matchCard(row, m);
      }).join('') +
        (rows.length > shown.length
          ? '<button class="expandbtn" data-act="more-matches">' + icon('chevronDown') +
          'Show ' + Math.min(6, rows.length - shown.length) + ' more ' +
          '<span class="muted">(' + (rows.length - shown.length) + ' groups hidden)</span></button>'
          : '') +
        (pro ? '' : '<div style="margin-top:16px">' + C.paywall({
          title: 'Unlock the full fitment list',
          text: 'You can see that ' + m.fullName + ' has a match. An active plan reveals every compatible device, the part code and the group sheet you can show a customer.'
        }) + '</div>');
    });
  }

  function matchCard(row, hitModel) {
    var g = row.group, cat = row.category, master = row.master;
    var pro = S.isPro();
    /* Null means the member list was not in the public catalogue at all — a
       different thing from a free account seeing a shortened one. */
    var preview = row.devices ? row.devices.slice(0, pro ? 8 : 4) : [];

    return '<div class="match" style="margin-bottom:14px">' +
      '<div class="match__head">' +
      '<span class="match__badge">' + icon('checkCircle') + 'Match found</span>' +
      '<span class="pill pill--code">' + esc(g.groupNumber) + '</span>' +
      '<span class="pill" style="background:' + cat.color + '18;color:' + cat.color + '">' + icon(cat.icon) + esc(cat.name) + '</span>' +
      '<button class="btn btn--ghost btn--sm" style="margin-left:auto" data-act="open-group" data-id="' + g.groupId + '">' +
      'Group sheet ' + icon('arrowRight') + '</button>' +
      '</div>' +
      '<div class="match__body">' +
      '<div class="stack" style="gap:14px">' +
      C.masterCard(master, cat) +
      /* never blur real data — either show the identifiers, or show a clear,
         deliberate locked panel in their place */
      (pro ? C.idGrid(g)
        : '<div class="lockbox">' +
        '<span class="lockbox__ico">' + icon('lock') + '</span>' +
        '<span class="lockbox__body"><b>Part code, serial &amp; group number</b>' +
        '<span>Included with any plan — from ₹99/month</span></span>' +
        '<button class="btn btn--amber btn--sm" data-act="go-plans">Unlock</button>' +
        '</div>') +
      '</div>' +
      '<div class="stack" style="gap:12px">' +
      '<div class="complist__head">' +
      '<span class="t-lab">Compatible devices</span>' +
      '<span class="pill pill--brand">' + g.compatibleCount + ' total</span>' +
      (master.id !== hitModel.id ? '<span class="pill pill--ok">' + icon('check') + esc(hitModel.modelName) + ' included</span>' : '') +
      '</div>' +
      '<div class="devlist">' + C.deviceRows(preview, { masterId: master.id, hitId: hitModel.id }) + '</div>' +
      (g.compatibleCount > preview.length
        ? (pro
          ? '<button class="expandbtn" data-act="open-group" data-id="' + g.groupId + '">' +
          icon('layers') + 'View all ' + g.compatibleCount + ' compatible models</button>'
          : '<button class="expandbtn" data-act="go-plans">' + icon('lock') + (g.compatibleCount - preview.length) + ' more devices — unlock with a plan</button>')
        : '') +
      '</div>' +
      '</div></div>';
  }

  /* ==========================================================================
     PAGE · ALL MOBILE MODELS  (free for everyone)
     ========================================================================== */
  function renderModels(page, brandId) {
    /* the search box is scoped to the view — moving between brands clears it,
       re-rendering the same view (e.g. closing a model sheet) keeps it */
    if (state.models.brandId !== (brandId || null)) state.models.q = '';
    state.models.brandId = brandId || null;

    page.innerHTML = '<div class="shell" style="padding-top:20px">' +
      '<div class="notice notice--brand" style="margin-bottom:18px">' + icon('unlock') +
      '<span><b>Free for everyone.</b> The full model database — brands, models and specifications — stays open. Device Finder matching is the paid part.</span></div>' +
      '<div id="modelsBody"></div></div>';

    if (!brandId) renderBrandGrid();
    else renderBrandModels(brandId);
  }

  function renderBrandGrid() {
    document.getElementById('modelsBody').innerHTML =
      '<div class="sec" style="margin-top:0"><div class="sec__head"><div class="sec__title">' +
      '<h2>All mobile models</h2><span class="sec__count">' + nf(db.stats.models) + ' models · ' + db.stats.brandsWithModels + ' brands</span>' +
      '</div></div>' +
      '<label class="field" style="margin-bottom:16px">' + icon('search') +
      '<input class="input" id="mq" placeholder="Search every model across all brands…" value="' + esc(state.models.q) + '" aria-label="Search all models" /></label>' +
      '<div id="modelSearchResults"></div>' +
      '<div id="brandArea"><span class="t-lab" style="display:block;margin-bottom:10px">Browse by brand</span>' +
      /* only brands that actually carry models are browsable here */
      '<div class="brandgrid">' +
      db.brands.filter(function (b) { return b.modelCount > 0; }).map(C.brandCard).join('') +
      '</div></div>' +
      '</div>';
    if (state.models.q) searchAllModels();
  }

  function searchAllModels() {
    var q = state.models.q;
    var host = document.getElementById('modelSearchResults');
    var brandArea = document.getElementById('brandArea');
    if (!host) return;
    if (!q) { host.innerHTML = ''; if (brandArea) brandArea.style.display = ''; return; }
    if (brandArea) brandArea.style.display = 'none';
    host.innerHTML = C.skelRows(6);
    api.listModels({ q: q, page: 1, pageSize: 30 }).then(function (r) {
      if (state.models.q !== q) return;
      if (!r.total) {
        host.innerHTML = C.state({
          icon: 'search', title: 'No model called “' + q + '”',
          text: 'Check the spelling, or try just the series — “A55”, “Note 13”, “Reno”.'
        });
        return;
      }
      host.innerHTML = '<div class="row" style="justify-content:space-between;margin-bottom:10px">' +
        '<span class="t-lab">' + nf(r.total) + ' models found</span>' +
        '<button class="btn btn--ghost btn--sm" data-act="clear-mq">' + icon('close') + 'Clear</button></div>' +
        '<div class="modelgrid">' + r.items.map(function (m) { return C.modelCard(m, q); }).join('') + '</div>' +
        (r.hasMore ? '<p class="t-xs muted" style="margin-top:12px">Showing first 30 of ' + nf(r.total) + ' — keep typing to narrow it down.</p>' : '');
    });
  }

  /* ==========================================================================
     PAGE · BRAND MODELS  (#/models/<brandId>)

     One list of devices, shown three ways. The view is a real choice, not a
     decoration: a shop owner scanning for a shape wants the grid, one checking
     a spec across models wants the table, and a phone screen wants neither —
     so the table collapses into stacked cards below 900px rather than becoming
     a sideways scroll.

     Filters use native <select>. A custom dropdown would need its own keyboard
     handling, focus trap, touch targets and two themes' worth of styling, and
     would still be worse on a phone than the one the OS already ships.
     ========================================================================== */

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

  function groupCountOf(m) { return (db.groupsByModel[m.id] || []).length; }

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

  /* ---------------------------------------------------------------- filters */
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
      if (f.size) {
        var band = f.size.split('-').map(Number);
        if (m.displaySize < band[0] || m.displaySize >= band[1]) return false;
      }
      return true;
    });
  }

  var SORTS = {
    newest: function (a, b) { return b.releaseYear - a.releaseYear || a.fullName.localeCompare(b.fullName); },
    oldest: function (a, b) { return a.releaseYear - b.releaseYear || a.fullName.localeCompare(b.fullName); },
    name:   function (a, b) { return a.fullName.localeCompare(b.fullName); },
    size:   function (a, b) { return b.displaySize - a.displaySize; },
    groups: function (a, b) { return groupCountOf(b) - groupCountOf(a); }
  };

  /* Named for the model page specifically: `activeFilterCount` already exists
     for the finder's brand panel, and a second declaration of it silently wins
     — the finder then called this one with no argument and threw on every
     render. */
  function activeModelFilterCount(f) {
    return Object.keys(f || {}).filter(function (k) { return f[k]; }).length;
  }

  /* ------------------------------------------------------------------ views */
  function deviceGridHTML(items) {
    return '<div class="dgrid">' + items.map(function (m) {
      var gc = groupCountOf(m);
      return '<button type="button" class="dcard" data-act="open-model" data-id="' + esc(m.id) + '">' +
        '<span class="dcard__shot">' + SM.art.device(m, 0) + '</span>' +
        '<span class="dcard__b">' +
          '<span class="dcard__n">' + esc(m.modelName) + '</span>' +
          '<span class="dcard__m">' + m.displaySize + '&Prime; · ' + m.releaseYear + '</span>' +
          '<span class="dcard__t">' +
            '<span class="tag tag--' + esc(m.screenCurve) + '">' + esc(m.screenCurve) + '</span>' +
            (gc ? '<span class="tag">' + gc + ' part' + (gc === 1 ? '' : 's') + '</span>' : '') +
          '</span>' +
        '</span></button>';
    }).join('') + '</div>';
  }

  function deviceListHTML(items) {
    return '<div class="dlist">' + items.map(function (m) {
      var sp = m.specs || {};
      var gc = groupCountOf(m);
      return '<button type="button" class="drow" data-act="open-model" data-id="' + esc(m.id) + '">' +
        '<span class="drow__shot">' + SM.art.device(m, 0) + '</span>' +
        '<span class="drow__main">' +
          '<span class="drow__n">' + esc(m.fullName) + '</span>' +
          '<span class="drow__m">' + m.displaySize + '&Prime; ' + esc(m.screenType) +
            ' · ' + esc(sp.chipset || '') + ' · ' + nf(sp.batteryMah || 0) + ' mAh</span>' +
        '</span>' +
        '<span class="drow__side">' +
          '<span class="tag tag--' + esc(m.screenCurve) + '">' + esc(m.screenCurve) + '</span>' +
          '<span class="drow__y">' + m.releaseYear + '</span>' +
          (gc ? '<span class="tag tag--parts">' + gc + '</span>' : '') +
        '</span></button>';
    }).join('') + '</div>';
  }

  /* The table renders every column; CSS hides the ones that do not fit, and
     below 900px the whole thing becomes stacked cards. Hiding in CSS rather
     than in JS means a resize needs no re-render. */
  function deviceTableHTML(items) {
    var head = tableCols().map(function (c) {
      return '<th class="c-' + c.k + '">' + esc(c.label) + '</th>';
    }).join('');

    var rows = items.map(function (m) {
      var sp = m.specs || {};
      var gc = groupCountOf(m);
      var cell = {
        device: '<span class="tcell-dev">' + SM.art.device(m, 0, 'dvc--xs') +
                '<span>' + esc(m.modelName) + '</span></span>',
        size: m.displaySize + '&Prime;',
        curve: '<span class="tag tag--' + esc(m.screenCurve) + '">' + esc(m.screenCurve) + '</span>',
        year: String(m.releaseYear),
        groups: gc ? String(gc) : '—',
        chipset: esc(sp.chipset || '—'),
        battery: sp.batteryMah ? nf(sp.batteryMah) + ' mAh' : '—',
        ram: (sp.ramVariantsGb || []).join('/') + ' GB',
        storage: (sp.storageVariantsGb || []).join('/') + ' GB',
        network: esc(sp.network || '—'),
        camera: (sp.cameraRear && sp.cameraRear[0] ? sp.cameraRear[0].mp + ' MP' : '—'),
        res: esc(m.screenResolution || '—')
      };
      return '<tr data-act="open-model" data-id="' + esc(m.id) + '" tabindex="0">' +
        tableCols().map(function (c) {
          return '<td class="c-' + c.k + '" data-label="' + esc(c.label) + '">' + cell[c.k] + '</td>';
        }).join('') + '</tr>';
    }).join('');

    return '<div class="dtable-wrap"><table class="dtable">' +
      '<thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  /* --------------------------------------------------------------- controls */
  function selectHTML(id, label, value, options) {
    return '<label class="fsel' + (value ? ' is-set' : '') + '">' +
      '<span class="fsel__l">' + esc(label) + '</span>' +
      '<select data-act="model-filter" data-key="' + id + '" aria-label="' + esc(label) + '">' +
      options.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (String(value) === String(o[0]) ? ' selected' : '') + '>' +
          esc(o[1]) + '</option>';
      }).join('') + '</select></label>';
  }

  function brandControlsHTML(b, years) {
    var m = state.models;
    var f = m.filters;
    var n = activeModelFilterCount(f);

    /* A filter the dataset cannot answer is not shown. Offering "Curved only"
       against data with no curvature field returns an empty list and reads as
       a broken filter rather than as missing data. */
    return '<div class="bctl">' +
      selectHTML('deviceType', 'Type', f.deviceType, [
        ['', 'All types'], ['phone', 'Phones'], ['tablet', 'Tablets'], ['watch', 'Watches']]) +
      (dbHas('screenCurve') ? selectHTML('curve', 'Screen', f.curve, [
        ['', 'Flat & curved'], ['flat', 'Flat only'], ['curved', 'Curved only']]) : '') +
      selectHTML('year', 'Year', f.year,
        [['', 'Any year']].concat(years.map(function (y) { return [String(y), String(y)]; }))) +
      selectHTML('size', 'Size', f.size, [
        ['', 'Any size'], ['0-5', 'Under 5"'], ['5-6.2', '5–6.2"'],
        ['6.2-6.7', '6.2–6.7"'], ['6.7-20', '6.7" and up']]) +
      (dbHas('network') ? selectHTML('fiveG', 'Network', f.fiveG, [
        ['', 'Any network'], ['5g', '5G only'], ['4g', '4G only']]) : '') +
      (dbHas('ram') ? selectHTML('minRam', 'RAM', f.minRam, [
        ['', 'Any RAM'], ['6', '6 GB+'], ['8', '8 GB+'], ['12', '12 GB+'], ['16', '16 GB']]) : '') +
      (dbHas('storage') ? selectHTML('minStorage', 'Storage', f.minStorage, [
        ['', 'Any storage'], ['128', '128 GB+'], ['256', '256 GB+'], ['512', '512 GB+']]) : '') +
      selectHTML('minBattery', 'Battery', f.minBattery, [
        ['', 'Any battery'], ['4500', '4500 mAh+'], ['5000', '5000 mAh+'], ['5500', '5500 mAh+']]) +
      selectHTML('sort', 'Sort', m.sort, [
        ['newest', 'Newest first'], ['oldest', 'Oldest first'], ['name', 'Name A–Z'],
        ['size', 'Largest screen'], ['groups', 'Most parts']]) +
      (n ? '<button class="btn btn--ghost btn--sm bctl__clear" data-act="clear-model-filters">' +
        icon('close') + 'Clear ' + n + '</button>' : '') +
      '</div>';
  }

  var VIEW_ICON = { grid: 'grid', list: 'parts', table: 'layers' };

  function viewSwitchHTML(view) {
    return '<div class="vswitch" role="group" aria-label="Display style">' +
      ['grid', 'list', 'table'].map(function (v) {
        return '<button type="button" class="vswitch__b' + (view === v ? ' is-on' : '') + '" ' +
          'data-act="model-view" data-view="' + v + '" aria-pressed="' + (view === v) + '" ' +
          'title="' + v.charAt(0).toUpperCase() + v.slice(1) + ' view" ' +
          'aria-label="' + v + ' view">' + icon(VIEW_ICON[v]) + '</button>';
      }).join('') + '</div>';
  }

  /* ------------------------------------------------------------------- page */
  function renderBrandModels(brandId) {
    var b = db.brandById[brandId];
    if (!b) { go('#/models'); return; }
    var m = state.models;
    var c = b.counts || {};

    var years = Array.from(new Set(db.models
      .filter(function (x) { return x.brandId === brandId; })
      .map(function (x) { return x.releaseYear; }))).sort(function (x, y) { return y - x; });

    document.getElementById('modelsBody').innerHTML =
      '<div class="crumbs" style="margin-bottom:14px">' +
      '<button data-act="nav" data-href="#/models">All brands</button>' + icon('chevronRight') +
      '<span style="color:var(--ink)">' + esc(b.name) + '</span></div>' +

      '<div class="bhead" style="--b1:' + b.color + '">' +
        '<div class="bhead__id">' +
          SM.brandLogo(b, 'blogo--lg') +
          '<div>' +
            '<h2 class="bhead__n">' + esc(b.name) + '</h2>' +
            '<p class="bhead__c">' + c.total + ' devices · ' + (c.phones || 0) + ' phones' +
              (c.tablets ? ' · ' + c.tablets + ' tablets' : '') +
              (c.watches ? ' · ' + c.watches + ' watches' : '') + '</p>' +
          '</div>' +
        '</div>' +
        '<div class="bhead__tools">' +
          '<label class="field bhead__q">' + icon('search') +
            '<input id="bq" placeholder="Search ' + esc(b.name) + '…" value="' + esc(m.q) + '" ' +
            'aria-label="Search within ' + esc(b.name) + '" /></label>' +
          viewSwitchHTML(m.view) +
        '</div>' +
      '</div>' +

      '<div id="brandControls">' + brandControlsHTML(b, years) + '</div>' +
      '<div class="bcount" id="brandCount"></div>' +
      '<div id="brandModels">' + C.skelRows(9) + '</div>' +
      '<div class="loadmore" id="brandMore"></div>';

    loadBrandModels(true);
  }

  /* Repaints the filter bar in place. Called after a change so the "Clear N"
     button appears and disappears without rebuilding the header, which would
     blur the search box mid-typing. */
  function refreshBrandControls() {
    var host = document.getElementById('brandControls');
    var b = db.brandById[state.models.brandId];
    if (!host || !b) return;
    var years = Array.from(new Set(db.models
      .filter(function (x) { return x.brandId === b.id; })
      .map(function (x) { return x.releaseYear; }))).sort(function (x, y) { return y - x; });
    host.innerHTML = brandControlsHTML(b, years);
  }

  function loadBrandModels(reset) {
    var m = state.models;
    if (reset) { m.page = 1; }

    /* Filtering and sorting happen here rather than in the API seam because
       they are view state, not a query — the same 344 records are already in
       memory, and a round trip per dropdown change would be latency for
       nothing. When this moves to Firestore the seam takes over and this
       becomes the fallback path. */
    api.listModels({ brandId: m.brandId, q: m.q, page: 1, pageSize: 9999, sort: m.sort }).then(function (r) {
      var all = filterModels(r.items, m.filters).sort(SORTS[m.sort] || SORTS.newest);
      var pageSize = m.view === 'table' ? 60 : 24;
      var shown = all.slice(0, m.page * pageSize);

      m.total = all.length;
      m.items = shown;
      m.hasMore = shown.length < all.length;
      m.busy = false;

      var host = document.getElementById('brandModels');
      var more = document.getElementById('brandMore');
      var count = document.getElementById('brandCount');
      if (!host) return;

      if (count) {
        count.innerHTML = all.length
          ? '<span>' + nf(all.length) + ' device' + (all.length === 1 ? '' : 's') +
            (all.length !== r.items.length ? ' of ' + nf(r.items.length) : '') + '</span>'
          : '';
      }

      if (!shown.length) {
        host.innerHTML = C.state({
          icon: 'search',
          title: m.q ? 'No models match “' + esc(m.q) + '”' : 'No models match these filters',
          text: m.q ? 'Try a shorter search — a series name or a number.'
                    : 'Clear a filter or two to widen the list.'
        });
        more.innerHTML = '';
        return;
      }

      host.innerHTML = m.view === 'table' ? deviceTableHTML(shown)
        : m.view === 'list' ? deviceListHTML(shown)
          : deviceGridHTML(shown);

      more.innerHTML = m.hasMore
        ? '<button class="btn btn--outline" data-act="more-models">' + icon('plus') +
          'Show more (' + nf(all.length - shown.length) + ' left)</button>'
        : '<span class="t-xs muted">All ' + nf(all.length) + ' shown</span>';
    });
  }

  /* ==========================================================================
     PAGE · PLANS
     ========================================================================== */
  function renderPlans(page) {
    var s = S.get();
    page.innerHTML =
      '<section class="bench" style="padding-bottom:30px"><div class="shell bench__in">' +
      '<span class="bench__eyebrow">' + icon('shop') + 'Built for mobile shops, not for offices</span>' +
      '<h1 class="t-hero" style="max-width:16ch">Stop guessing<br><em>what fits.</em></h1>' +
      '<p class="bench__sub">One plan for the whole counter. Look up a model, get the group, read the part code to your supplier — before the customer changes their mind.</p>' +
      '</div></section>' +

      '<div class="shell" style="margin-top:-18px;position:relative;z-index:2">' +
      (s.status === 'expired' ? '<div class="notice notice--amber" style="margin-bottom:16px">' + icon('alert') +
        '<span><b>Your plan has expired.</b> Device Finder matching is locked until you renew. Everything in All Mobile Models still works.</span></div>' : '') +
      '<div class="plans">' + SM.PLANS.map(function (p) {
        return C.planCard(p, { current: s.status === 'pro' && s.plan === p.id });
      }).join('') + '</div>' +

      '<div class="sec"><div class="sec__head"><div class="sec__title"><h2>What a plan changes</h2></div></div>' +
      '<div class="idgrid" style="grid-template-columns:repeat(1,minmax(0,1fr))">' +
      cmp('Browse all mobile models & specs', 'Free', 'Free') +
      cmp('Browse the compatibility group library', 'Free', 'Free') +
      cmp('Match a model to its group', 'Locked', 'Included') +
      cmp('Full compatible-device list', 'First few only', 'All devices') +
      cmp('Part code, serial & group number', 'Hidden', 'Included') +
      '</div></div>' +

      '<div class="notice" style="margin:18px 0 8px">' + icon('info') +
      '<span><b>Prototype note.</b> No payment gateway is connected in this build. Choosing a plan only switches the local demo state so you can review the subscriber experience.</span></div>' +
      '</div>';
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
  function renderAccount(page) {
    var s = S.get();
    page.innerHTML = '<div class="shell" style="padding-top:20px">' +
      (s.status === 'guest' ? authHTML() : profileHTML(s)) +
      '</div>';
  }

  /* ------------------------------------------------- registration form state */
  var reg = {
    country: 'IN', mobile: '', shopName: '', proprietor: '',
    flat: '', area: '', city: '', district: '', stateName: '', touched: {}
  };
  /* mandatory only — the address is optional and must never block sign-up */
  var REG_FIELDS = [
    { k: 'mobile', label: 'Mobile number' },
    { k: 'shopName', label: 'Shop name' },
    { k: 'proprietor', label: 'Proprietor name' }
  ];
  var ADDRESS_FIELDS = ['flat', 'area', 'city', 'district', 'stateName'];
  function regError(k) {
    if (ADDRESS_FIELDS.indexOf(k) > -1) return '';   /* optional */
    var v = String(reg[k] || '').trim();
    if (k === 'mobile') {
      if (!v) return 'Enter your mobile number';
      if (!SM.countries.validNumber(v.replace(/\D/g, ''))) return 'Enter a valid mobile number';
      return '';
    }
    if (!v) return 'Required';
    if (v.length < 2) return 'Too short';
    if (k === 'proprietor' && v.split(/\s+/).length < 2) return 'Enter the full name';
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
    var signup = authMode === 'signup';
    return '<div class="acct">' +
      '<div class="card card--pad">' +
      '<div class="segmented" style="margin-bottom:18px">' +
      '<button class="' + (signup ? '' : 'is-on') + '" data-act="auth-tab" data-id="signin">Sign in</button>' +
      '<button class="' + (signup ? 'is-on' : '') + '" data-act="auth-tab" data-id="signup">Create account</button>' +
      '</div>' +
      (signup ? signupHTML() : signinHTML()) +
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
    return '<h2 class="t-h1">Create your Mobile Parts Finder account</h2>' +
      '<p class="t-sub" style="margin-top:6px">Tell us about your shop, then finish with your Google account.</p>' +

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
      field('proprietor', 'Proprietor name (full name)', { ph: 'Rajesh Kumar Sharma' }) +

      '<div class="regform__sub"><span class="t-lab">Shop address</span>' +
      '<span class="t-xs muted">optional · ' + esc(c ? c.name : '—') + '</span></div>' +
      field('flat', 'Flat / building number', { ph: '12B, Ganesh Complex' }) +
      field('area', 'Area / colony', { ph: 'Gandhi Nagar' }) +
      '<div class="ffield--pair">' + field('city', 'City', { ph: 'Coimbatore' }) +
      field('district', 'District', { ph: 'Coimbatore' }) + '</div>' +
      field('stateName', 'State', { ph: 'Tamil Nadu' }) +
      '</div>' +

      '<div style="margin-top:16px">' + googleBtn('Continue with Google', 'google-signup', !ready) + '</div>' +
      '<div id="authMsg"></div>' +
      '<p class="t-xs muted" id="regHint" style="margin-top:12px">' + regHintHTML() + '</p>';
  }

  function regHintHTML() {
    var missing = REG_FIELDS.filter(function (f) { return regError(f.k); });
    if (!missing.length) return icon('checkCircle') + ' All details complete — pick your Google account to finish.';
    return 'Complete ' + missing.length + ' more ' + (missing.length === 1 ? 'field' : 'fields') +
      ' to continue: ' + esc(missing.map(function (f) { return f.label; }).join(', '));
  }

  function repaintAuth() {
    var page = document.getElementById('page');
    if (state.route.name === 'account' && S.get().status === 'guest') renderAccount(page);
  }

  /* ----------------------------------------------------- profile editing -- */
  var edit = {};

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
      '<p class="t-xs muted" style="margin-top:6px">Stored on this device with your profile. Resized to 256px.</p>' +
      '</div></div>' +

      '<div class="ffield"><label class="t-lab" for="ed_shopName">Shop name</label>' +
      '<input class="input" id="ed_shopName" data-edit="shopName" value="' + esc(edit.shopName) + '" /></div>' +
      '<div class="ffield"><label class="t-lab" for="ed_proprietor">Proprietor name (full name)</label>' +
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
    if (!edit.shopName.trim() || !edit.proprietor.trim()) {
      toast('Shop name and proprietor name are required', 'alert'); return;
    }
    var c = SM.countries.byCode(edit.country);
    S.updateProfile({
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
      state.sheet = null; renderSheet();
      renderShellBits();
      renderAccount(document.getElementById('page'));
      toast('Profile updated');
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
      '<button class="btn btn--outline btn--sm" data-act="edit-profile">' + icon('sliders') + 'Edit</button>' +
      '</div>';
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
  function freeIncluded() { return [
    'Browse all ' + nf(db.stats.models) + ' phone models and their specs',
    'Browse every compatibility group in the catalogue',
    'Search by model, part code or group number'
  ]; }
  var PRO_ONLY = [
    'Match a model to its compatibility group',
    'Full compatible-device list for every group',
    'Part code, serial number and group number',
    'Group sheets you can show a customer'
  ];

  function accessHTML() {
    return '<span class="t-lab">What your account can do</span>' +
      '<ul class="acclist" style="margin-top:10px">' +
      freeIncluded().map(function (t) {
        return '<li class="acclist__on">' + icon('checkCircle') + '<span>' + esc(t) + '</span></li>';
      }).join('') +
      PRO_ONLY.map(function (t) {
        return '<li class="acclist__off">' + icon('lock') + '<span>' + esc(t) + '</span>' +
          '<span class="acclist__tag">Plan</span></li>';
      }).join('') +
      '</ul>';
  }

  function profileHTML(s) {
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
      '<button class="btn btn--outline btn--sm" data-act="nav" data-href="#/plans">' + icon('crown') + 'Change plan</button>' +
      (sub.willRenew
        ? '<button class="btn btn--ghost btn--sm" data-act="cancel-sub">Cancel subscription</button>'
        : '<button class="btn btn--ghost btn--sm" data-act="resume-sub">Resume renewal</button>') +
      '</div>' +

      '<hr class="divider" style="margin:18px 0" />' +
      '<button class="btn btn--ghost btn--sm" data-act="signout">' + icon('logout') + 'Sign out</button>' +
      '</div>' +

      '<div class="card card--pad">' + accessHTML() + '</div></div>';
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
      'Device Finder matching, full fitment lists and part codes are no longer active. ' +
      'Browsing models and groups stays free.</span></div>' +

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

  /* Draws the handset itself. There is no product photography in the sample
     data, and a stock image of the wrong phone would be worse than none — so
     the device is rendered from its own numbers: real aspect ratio from the
     screen resolution, real corner radius by tier, and the finish the viewer
     picked. It is honest about being a drawing and it never 404s. */
  function deviceShotHTML(m, colourIndex) {
    var sp = m.specs;
    var col = (sp.colors && sp.colors[colourIndex || 0]) || { n: 'Black', h: '#15171A' };
    var res = String(m.screenResolution).match(/(\d+)\s*x\s*(\d+)/);
    var pw = res ? Number(res[1]) : 1080;
    var ph = res ? Number(res[2]) : 2340;
    var W = 150;
    var H = Math.round(W * (ph / pw));
    var pad = 6;
    var radius = m.tier === 'flag' ? 22 : 18;

    /* a light finish needs a visible outline or it vanishes on the white chip */
    var light = parseInt(col.h.slice(1, 3), 16) * 0.299 +
                parseInt(col.h.slice(3, 5), 16) * 0.587 +
                parseInt(col.h.slice(5, 7), 16) * 0.114 > 190;

    return '<svg class="dshot__svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
      'aria-label="' + esc(m.fullName) + ' in ' + esc(col.n) + '">' +
      '<defs><linearGradient id="dsg" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#fff" stop-opacity=".28"/>' +
      '<stop offset=".45" stop-color="#fff" stop-opacity=".04"/>' +
      '<stop offset="1" stop-color="#000" stop-opacity=".18"/></linearGradient></defs>' +
      /* body */
      '<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="' + radius + '" fill="' + esc(col.h) + '"' +
      (light ? ' stroke="rgba(0,0,0,.22)" stroke-width="1"' : '') + '/>' +
      /* screen */
      '<rect x="' + pad + '" y="' + pad + '" width="' + (W - pad * 2) + '" height="' + (H - pad * 2) +
      '" rx="' + (radius - 5) + '" fill="#0B1211"/>' +
      /* highlight */
      '<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="' + radius + '" fill="url(#dsg)"/>' +
      /* camera island — Apple gets the pill, everyone else the punch-hole */
      (m.brandId === 'apple' && m.releaseYear >= 2022
        ? '<rect x="' + (W / 2 - 17) + '" y="' + (pad + 6) + '" width="34" height="11" rx="5.5" fill="#05090A"/>'
        : '<circle cx="' + (W / 2) + '" cy="' + (pad + 12) + '" r="4.4" fill="#05090A"/>') +
      '</svg>';
  }

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
  function coverageNoteHTML() {
    var cov = db.coverage;
    if (!cov || !cov.absent || !cov.absent.length) return '';
    var LABEL = {
      chipset: 'processor', cpu: 'CPU', gpu: 'GPU', ram: 'RAM', storage: 'storage',
      colours: 'colours', cameras: 'cameras', os: 'software', network: 'network',
      sensors: 'sensors', screenCurve: 'flat/curved screen', price: 'price',
      variants: 'RAM and storage variants', screenResolution: 'resolution'
    };
    var names = cov.absent.map(function (f) { return LABEL[f] || f; });
    return '<p class="dnote">' + icon('info') +
      '<span>This catalogue carries model, brand, release date, display size, ' +
      'dimensions and battery. It does not include ' + esc(names.join(', ')) +
      ' — those fields are left out rather than estimated.</span></p>';
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
  function specBlockHTML(title, iconName, rows) {
    var body = rows.filter(function (r) { return r && r[1] != null && r[1] !== ''; })
      .map(function (r) {
        return '<div class="dspec"><dt>' + esc(r[0]) + '</dt><dd>' + esc(String(r[1])) + '</dd></div>';
      }).join('');
    if (!body) return '';
    return '<section class="dsec">' +
      '<h3 class="dsec__h">' + icon(iconName) + esc(title) + '</h3>' +
      '<dl class="dsec__b">' + body + '</dl></section>';
  }

  /* ------------------------------------------------------------- variants
     The configuration picker. RAM and storage are chosen separately because
     that is how a buyer thinks about them, but they are not independent: not
     every pair is sold. Picking a RAM that has no build at the current storage
     moves storage to the nearest one that exists rather than showing a price
     for a phone nobody makes. */
  function variantsOf(m) { return (m.specs && m.specs.variants) || []; }

  function findVariant(m, ramGb, storageGb) {
    var vs = variantsOf(m);
    return vs.find(function (v) { return v.ramGb === ramGb && v.storageGb === storageGb; }) || null;
  }

  /* The variant currently selected, falling back to the cheapest build. */
  function currentVariant(m) {
    var vs = variantsOf(m);
    if (!vs.length) return null;
    var sel = state.deviceVariant;
    if (sel) {
      var hit = findVariant(m, sel.ramGb, sel.storageGb);
      if (hit) return hit;
    }
    return vs[0];
  }

  function variantPickerHTML(m) {
    var vs = variantsOf(m);
    if (vs.length < 2) return '';
    var cur = currentVariant(m);
    var rams = Array.from(new Set(vs.map(function (v) { return v.ramGb; })));
    var roms = Array.from(new Set(vs.map(function (v) { return v.storageGb; })));

    var fmtRom = function (g) { return g >= 1024 ? (g / 1024) + ' TB' : g + ' GB'; };

    var chip = function (kind, value, label, on, enabled) {
      return '<button type="button" class="vchip' + (on ? ' is-on' : '') + '" ' +
        'data-act="pick-variant" data-kind="' + kind + '" data-value="' + value + '" ' +
        (enabled ? '' : 'disabled ') +
        'aria-pressed="' + (on ? 'true' : 'false') + '">' + label + '</button>';
    };

    return '<div class="vpick">' +
      '<div class="vpick__row">' +
        '<span class="vpick__l">RAM</span>' +
        '<div class="vpick__chips">' + rams.map(function (r) {
          return chip('ram', r, r + ' GB', cur.ramGb === r, true);
        }).join('') + '</div>' +
      '</div>' +
      '<div class="vpick__row">' +
        '<span class="vpick__l">Storage</span>' +
        '<div class="vpick__chips">' + roms.map(function (g) {
          /* A storage that does not exist at the chosen RAM is shown but
             disabled — hiding it would make the row jump on every RAM click. */
          var v = findVariant(m, cur.ramGb, g);
          return chip('storage', g, fmtRom(g), cur.storageGb === g, !!v);
        }).join('') + '</div>' +
      '</div>' +
      '<div class="vpick__out" id="variantOut">' + variantOutHTML(m, cur) + '</div>' +
      '</div>';
  }

  function variantOutHTML(m, v) {
    if (!v) return '';
    return '<span class="vprice">₹' + nf(v.priceInr) + '</span>' +
      '<span class="vmeta">' + v.ramGb + ' GB · ' +
        (v.storageGb >= 1024 ? (v.storageGb / 1024) + ' TB' : v.storageGb + ' GB') + '</span>' +
      '<span class="vstock ' + (v.available ? 'is-in' : 'is-out') + '">' +
        icon(v.available ? 'check' : 'alert') +
        (v.available ? 'Available' : 'Not in stock') + '</span>';
  }

  function renderDevice(page, id) {
    page.innerHTML = '<div class="wrap dev-page">' + C.skelRows(5) + '</div>';

    if (state.deviceId !== id) {
      state.deviceId = id; state.deviceColour = 0; state.deviceVariant = null;
    }

    api.getModel(id).then(function (r) {
      if (!r) { go('#/models'); return; }
      var m = r.model;
      var b = db.brandById[m.brandId] || { id: m.brandId, name: m.brand };
      var sp = m.specs;
      var ci = state.deviceColour || 0;
      if (ci >= (sp.colors || []).length) ci = 0;

      var rear = sp.cameraRear || [];
      var mainCam = rear[0] || { mp: 0 };
      var ramTxt = (sp.ramVariantsGb || []).join(' / ') + ' GB';
      var romTxt = (sp.storageVariantsGb || []).map(function (g) {
        return g >= 1024 ? (g / 1024) + ' TB' : g + ' GB';
      }).join(' / ');

      var meta = [
        ['calendar', m.releaseDate],
        ['signal', sp.network],
        ['check', sp.status]
      ].map(function (x) {
        return '<span class="dmeta">' + icon(x[0]) + esc(x[1]) + '</span>';
      }).join('');

      var swatches = (sp.colors || []).map(function (c, i) {
        return '<button class="dsw' + (i === ci ? ' is-on' : '') + '" data-act="dev-colour" data-i="' + i + '" ' +
          'style="--sw:' + esc(c.h) + '" title="' + esc(c.n) + '" aria-label="' + esc(c.n) + '"' +
          (i === ci ? ' aria-current="true"' : '') + '></button>';
      }).join('');

      var compat = r.groupCount
        ? '<div class="cats">' + r.categories.filter(function (c) { return c.count; }).map(function (c) {
            return C.categoryCard(c.category, c.count, { act: 'find-with-cat' });
          }).join('') + '</div>'
        : '<div class="notice">' + icon('alert') +
          '<span>No compatibility group covers this model yet in the sample data.</span></div>';

      page.innerHTML =
        '<div class="dev-page">' +

        /* ---- sticky head: identity stays visible through a long spec sheet -- */
        '<div class="dhead">' +
          '<div class="dhead__in">' +
            '<button class="btn btn--icon" data-act="dev-back" aria-label="Back">' + icon('chevronLeft') + '</button>' +
            SM.brandLogo(b, 'blogo--sm') +
            '<span class="dhead__t">' + esc(m.fullName) + '</span>' +
            '<button class="btn btn--primary dhead__cta" data-act="find-parts" data-id="' + esc(m.id) + '">' +
              icon('search') + '<span>Find parts</span></button>' +
          '</div>' +
        '</div>' +

        '<div class="wrap">' +

          /* ------------------------------------------------------------ hero */
          '<div class="dhero">' +
            '<div class="dshot">' + SM.art.device(m, ci) + '</div>' +
            '<div class="dintro">' +
              '<div class="dintro__brand">' + SM.brandLogo(b, 'blogo--sm') +
                '<span>' + esc(m.brand) + '</span></div>' +
              '<h1 class="dintro__h">' + esc(m.modelName) + '</h1>' +
              '<div class="dintro__meta">' + meta + '</div>' +
              (sp.launchPriceInr
                ? '<div class="dprice"><span class="dprice__n">₹' + nf(sp.launchPriceInr) + '</span>' +
                  '<span class="dprice__l">from · launch price</span></div>'
                : '') +
              variantPickerHTML(m) +
              (swatches
                ? '<div class="dcolours"><span class="t-lab">' +
                  esc((sp.colors || []).length) + ' colour' + ((sp.colors || []).length === 1 ? '' : 's') +
                  ' · ' + esc(sp.colors[ci].n) + '</span>' +
                  '<div class="dsw__row">' + swatches + '</div></div>'
                : '') +
              '<div class="dintro__cta">' +
                '<button class="btn btn--primary btn--lg" data-act="find-parts" data-id="' + esc(m.id) + '">' +
                  icon('search') + 'Find parts for this model</button>' +
                (r.groupCount
                  ? '<span class="dintro__note">' + nf(r.groupCount) + ' compatibility group' +
                    (r.groupCount === 1 ? '' : 's') + '</span>'
                  : '') +
              '</div>' +
            '</div>' +
          '</div>' +

          /* The specs that decide a repair quote, beside the device rather than
             below the fold — a three-column band so the hero balances instead
             of leaving the right half of a desktop window empty. */
          '<div class="dkeys">' +
            keySpecHTML('phone', 'Display', m.displaySize ? m.displaySize + '"' : null,
              join(' · ', [m.screenResolution, m.screenType, m.screenRatio])) +
            keySpecHTML('cpu', 'Processor', sp.chipset, join(' · ', [sp.cpu, sp.gpu])) +
            keySpecHTML('camera', 'Main camera', mainCam.mp ? mainCam.mp + ' MP' : null,
              rear.length ? rear.length + ' rear' : null) +
            keySpecHTML('battery', 'Battery', sp.batteryMah ? nf(sp.batteryMah) + ' mAh' : null,
              sp.chargingWatts ? sp.chargingWatts + 'W' + (sp.wirelessCharging ? ' · wireless' : '') : null) +
            keySpecHTML('layers', 'Memory', sp.ramVariantsGb ? ramTxt : null, sp.storageVariantsGb ? romTxt : null) +
            keySpecHTML('signal', 'Network', sp.network, sp.wifi) +
            keySpecHTML('ruler', 'Body', join(' × ', [m.height, m.width]),
              m.screenCm2 ? m.screenCm2 + ' cm² screen' : null) +
            keySpecHTML('calendar', 'Released', m.releaseDate, m.releaseYear ? String(m.releaseYear) : null) +
          '</div>' +

          /* --------------------------------------------------- full spec sheet */
          '<div class="dsecs">' +
            specBlockHTML('Display', 'phone', [
              ['Size', m.displaySize + ' inches'],
              ['Resolution', m.screenResolution],
              ['Type', m.screenType],
              ['Refresh rate', m.refreshRate],
              ['Pixel density', m.ppi],
              ['Aspect ratio', m.screenRatio],
              ['Protection', m.protection]
            ]) +
            specBlockHTML('Performance', 'cpu', [
              ['Chipset', sp.chipset],
              ['CPU', sp.cpu],
              ['GPU', sp.gpu],
              ['Process', sp.fabrication]
            ]) +
            specBlockHTML('Memory', 'layers', [
              ['RAM', sp.ramVariantsGb ? ramTxt : null],
              ['Storage', sp.storageVariantsGb ? romTxt : null],
              ['Expandable', sp.expandable == null ? null
                : (sp.expandable ? 'microSD supported' : 'Not expandable')]
            ]) +
            /* Every row here tolerates a null: this page must render for a
               catalogue that carries only names and dimensions as readily as
               for one with a full spec sheet. specBlockHTML drops null rows
               and omits a section that ends up with none. */
            specBlockHTML('Camera', 'camera', rear.map(function (c) {
              return [c.role, c.mp + ' MP · ' + c.aperture + (c.ois ? ' · OIS' : '')];
            }).concat([
              ['Front camera', sp.cameraFront ? sp.cameraFront.mp + ' MP · ' + sp.cameraFront.aperture : null],
              ['Video', sp.videoMax]
            ])) +
            specBlockHTML('Battery & charging', 'battery', [
              ['Capacity', sp.batteryMah ? nf(sp.batteryMah) + ' mAh' : null],
              ['Type', sp.batteryType],
              ['Wired charging', sp.chargingWatts ? sp.chargingWatts + 'W' : null],
              ['Wireless charging', sp.wirelessCharging == null ? null
                : (sp.wirelessCharging ? 'Supported' : 'Not supported')]
            ]) +
            specBlockHTML('Software', 'sparkle', [
              ['Operating system', sp.os ? sp.os + ' ' + (sp.osVersion || '') : null],
              ['Interface', sp.skin]
              /* Release date lives in its own highlight card and in Source —
                 filed under Software it was the only row keeping an otherwise
                 empty section on the page. */
            ]) +
            specBlockHTML('Network & connectivity', 'signal', [
              ['Network', sp.networkDetail],
              ['SIM', m.sim],
              ['Wi-Fi', sp.wifi],
              ['Bluetooth', sp.bluetooth],
              ['NFC', sp.nfc == null ? null : (sp.nfc ? 'Yes' : 'No')],
              ['USB', sp.usb],
              ['Headphone jack', sp.headphoneJack == null ? null : (sp.headphoneJack ? '3.5 mm' : 'None')]
            ]) +
            specBlockHTML('Body', 'ruler', [
              ['Height', m.height],
              ['Width', m.width],
              ['Thickness', m.thickness],
              ['Weight', m.weight],
              ['Screen area', m.screenCm2 ? m.screenCm2 + ' cm²' : null],
              ['Body ratio', m.bodyRatio ? m.bodyRatio + '%' : null],
              ['Colours', sp.colors ? sp.colors.map(function (c) { return c.n; }).join(', ') : null]
            ]) +
            specBlockHTML('Sensors', 'shield', [
              ['Sensors', sp.sensors ? sp.sensors.join(', ') : null]
            ]) +
            /* The source link is the one field the export always has and the
               UI had nowhere to show. It is also the attribution the licence
               asks for. */
            specBlockHTML('Source', 'linkOut', [
              ['Released', m.releaseDate],
              ['Catalogue entry', m.sourceUrl ? m.sourceUrl.replace(/^https?:\/\//, '') : null],
              ['Device type', m.deviceType + (m.typeDerived ? ' (read from the model name)' : '')]
            ]) +
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

  function renderSheet() {
    var host = document.getElementById('overlay');
    var s = state.sheet;
    if (!s) { host.innerHTML = ''; document.body.style.overflow = ''; return; }
    document.body.style.overflow = 'hidden';

    if (s.type === 'filters') return paintSheet(host, 'Filter groups', categoryPanelHTML() + brandPanelHTML(),
      '<button class="btn btn--outline grow" data-act="reset-filters">Reset</button>' +
      '<button class="btn btn--primary grow" data-act="close-sheet">Show ' + nf(state.finder.total) + ' groups</button>');

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
            : '<div class="notice">' + icon('alert') + '<span>No compatibility group covers this model yet in the sample data.</span></div>') +
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

    if (s.type === 'group') {
      host.innerHTML = '<div class="scrim" data-act="close-sheet"></div><div class="sheet"><div class="sheet__grab"></div>' +
        '<div class="sheet__head"><div class="skel" style="height:22px;width:50%"></div></div>' +
        '<div class="sheet__body">' + C.skelPlate() + '</div></div>';
      api.getGroup(s.id).then(function (row) {
        if (!row) { closeSheet(); return; }
        paintGroupSheet(host, row);
      });
    }
  }

  function countryRowsHTML(q) {
    var list = SM.countries.search(q);
    if (!list.length) return '<div class="brandempty">' + icon('search') + '<span>No country found</span></div>';
    return list.map(function (c) {
      return '<button class="crow' + (reg.country === c.code ? ' is-on' : '') + '" ' +
        'data-act="pick-country" data-id="' + c.code + '">' +
        '<span class="crow__flag">' + c.flag + '</span>' +
        '<span class="crow__name">' + esc(c.name) + '</span>' +
        '<span class="crow__dial">' + esc(c.dial) + '</span></button>';
    }).join('');
  }
  function paintCountryRows(q) {
    var host = document.getElementById('countryRows');
    if (host) host.innerHTML = countryRowsHTML(q);
  }

  function paintSheet(host, titleHTML, bodyHTML, footHTML, rawTitle) {
    host.innerHTML = '<div class="scrim" data-act="close-sheet"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true"><div class="sheet__grab"></div>' +
      '<div class="sheet__head">' + (rawTitle ? titleHTML : '<div class="t-h3 grow">' + esc(titleHTML) + '</div>') +
      '<button class="iconbtn" style="margin-left:auto" data-act="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<div class="sheet__body">' + bodyHTML + '</div>' +
      (footHTML ? '<div class="sheet__foot">' + footHTML + '</div>' : '') +
      '</div>';
  }

  function paintGroupSheet(host, row) {
    var g = row.group, cat = row.category, master = row.master;
    var pro = S.isPro();
    var freeLimit = 8;

    var title = '<div class="row" style="gap:9px;flex-wrap:wrap">' +
      '<span class="pill" style="background:' + cat.color + '18;color:' + cat.color + '">' + icon(cat.icon) + esc(cat.name) + '</span>' +
      '<span class="pill pill--code">' + esc(g.groupNumber) + '</span></div>';

    var body =
      '<div style="--c:' + cat.color + '">' + C.masterCard(master, cat) + '</div>' +
      '<div><span class="t-lab" style="display:block;margin-bottom:9px">Auto-generated identifiers</span>' +
      C.idGrid(g) +
      '<div class="row wrap" style="gap:8px;margin-top:10px">' +
      copyBtn('Part code', g.partCode) + copyBtn('Serial', g.serialNumber) + copyBtn('Group', g.groupNumber) +
      '</div></div>' +
      '<div id="devSection"></div>';

    paintSheet(host, title, body,
      '<button class="btn btn--outline" data-act="close-sheet">Close</button>' +
      '<button class="btn btn--primary grow" data-act="find-parts" data-id="' + master.id + '">' + icon('search') + 'Find parts for master model</button>',
      true);

    state.devView = { shown: pro ? 60 : freeLimit, q: '' };
    paintDevSection(row);
  }

  function copyBtn(label, value) {
    return '<button class="copybtn" data-act="copy" data-copy="' + esc(value) + '">' + icon('copy') + esc(label) + ': ' + esc(value) + '</button>';
  }

  function paintDevSection(row) {
    var host = document.getElementById('devSection');
    if (!host) return;
    var g = row.group, master = row.master, pro = S.isPro();
    var v = state.devView;
    var q = v.q.toLowerCase();
    var all = row.devices || [];
    var list = q ? all.filter(function (d) { return d.fullName.toLowerCase().indexOf(q) > -1; }) : all;
    var shown = list.slice(0, v.shown);
    var remaining = list.length - shown.length;

    host.innerHTML =
      '<div class="complist__head">' +
      '<span class="t-lab">Compatible devices</span>' +
      '<span class="pill pill--brand">' + g.compatibleCount + ' in this group</span>' +
      (g.compatibleCount > 24 ? '<label class="field grow" style="min-width:180px">' + icon('search') +
        '<input class="input" id="devq" placeholder="Find inside this group…" value="' + esc(v.q) + '" aria-label="Search compatible devices" /></label>' : '') +
      '</div>' +
      (list.length
        ? '<div class="devlist">' + C.deviceRows(shown, { masterId: master.id }) + '</div>'
        : C.state({ icon: 'search', title: 'Nothing in this group matches “' + v.q + '”', text: 'Clear the search to see all ' + g.compatibleCount + ' devices.' })) +
      (remaining > 0
        ? (pro
          ? '<button class="expandbtn" style="margin-top:10px" data-act="more-devs">' + icon('chevronDown') +
          'Show ' + Math.min(60, remaining) + ' more <span class="muted">(' + remaining + ' hidden)</span></button>'
          : '<div style="margin-top:12px">' + C.paywall({
            title: remaining + ' more compatible devices',
            text: 'This group covers ' + g.compatibleCount + ' devices in total. An active plan opens the complete list and its part codes.'
          }) + '</div>')
        : (list.length > 12 ? '<p class="t-xs muted" style="margin-top:10px">End of list — ' + list.length + ' devices shown.</p>' : ''));
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

  function pickModel(id) {
    var m = db.modelById[id];
    if (!m) return;
    state.finder.modelId = id;
    state.finder.catId = null;
    state.finder.matchShown = 6;
    state.finder.avail = null;
    state.finder.query = m.fullName;
    pushRecent(id);
    closeSuggest();
    syncSearchInputs(true);
    if (state.route.name !== 'finder') go('#/finder');
    else renderFinder(document.getElementById('page'));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  var authMode = 'signin';
  /* sheets that live in memory rather than in the URL */
  var LOCAL_SHEETS = ['filters', 'country', 'editprofile'];

  /* leave the result view and restore the normal Finder home page */
  function exitResult() {
    var f = state.finder;
    f.modelId = null; f.catId = null; f.query = ''; f.matchShown = 6; f.avail = null;
    closeSuggest();
    if (location.hash.indexOf('#/finder') !== 0) { go('#/finder'); }
    else { renderFinder(document.getElementById('page')); }
    syncSearchInputs(true);
    window.scrollTo({ top: 0 });
  }

  document.addEventListener('click', function (e) {
    /* the Finder tab / nav link must never leave the user stuck in a result:
       the hash is already #/finder, so no hashchange would fire on its own */
    var finderLink = e.target.closest('a[href="#/finder"]');
    if (finderLink && state.finder.modelId) {
      e.preventDefault();
      exitResult();
      return;
    }
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
      case 'clear-model':
      case 'exit-result':
        exitResult();
        break;
      case 'pick-cat':
        state.finder.catId = state.finder.catId === id ? null : id;
        state.finder.matchShown = 6;
        renderSelection();
        break;
      /* rail on the result page: 'all' clears the category filter */
      case 'pick-cat-rail': {
        state.finder.catId = (id === 'all') ? null : id;
        state.finder.matchShown = 6;
        var railHost = document.getElementById('catRail');
        if (railHost) railHost.innerHTML = resultRailHTML();
        renderSelection();
        break;
      }
      case 'clear-cat': state.finder.catId = null; state.finder.matchShown = 6; renderSelection(); break;
      case 'more-matches': state.finder.matchShown += 6; loadMatches(); break;

      /* browse filters */
      case 'filter-cat':
        state.finder.filters.catId = id;
        if (state.sheet) { state.sheet = null; renderSheet(); }
        renderBrowse();
        break;
      case 'filter-brand':
        state.finder.filters.brandId = id;
        if (state.sheet) { state.sheet = null; renderSheet(); }
        renderBrowse();
        break;
      case 'reset-filters':
        state.finder.filters = { q: '', brandId: 'all', catId: 'all', sort: 'default' };
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
        if (state.route.name !== 'finder') { go('#/finder'); }
        state.sheet = { type: 'filters' }; renderSheet();
        break;
      case 'more-groups': state.finder.page++; loadGroups(false); break;

      /* overlays */
      case 'open-group': go('#/group/' + id); break;

      /* device page */
      case 'dev-back':
        if (history.length > 1) history.back(); else go('#/models');
        break;
      case 'pick-variant': {
        var dm = db.modelById[state.deviceId];
        if (!dm) break;
        var kind = t.getAttribute('data-kind');
        var val = Number(t.getAttribute('data-value'));
        var cur = currentVariant(dm);
        var want = { ramGb: cur.ramGb, storageGb: cur.storageGb };
        want[kind === 'ram' ? 'ramGb' : 'storageGb'] = val;

        /* Changing RAM can land on a pair that is not sold. Rather than show a
           price for a phone nobody makes, fall back to the nearest storage
           that does exist at the chosen RAM. */
        if (!findVariant(dm, want.ramGb, want.storageGb)) {
          var alt = variantsOf(dm).filter(function (v) { return v.ramGb === want.ramGb; });
          if (!alt.length) break;
          alt.sort(function (a, b) {
            return Math.abs(a.storageGb - want.storageGb) - Math.abs(b.storageGb - want.storageGb);
          });
          want.storageGb = alt[0].storageGb;
        }
        state.deviceVariant = want;

        /* Repaint only the picker — re-rendering the page would throw away the
           reader's scroll position halfway down a spec sheet. */
        var pick = document.querySelector('.vpick');
        if (pick) pick.outerHTML = variantPickerHTML(dm);
        break;
      }

      case 'dev-colour': {
        /* Repaint only the handset and the swatch row. Re-rendering the whole
           page would throw away the reader's scroll position mid-spec-sheet. */
        state.deviceColour = Number(t.getAttribute('data-i')) || 0;
        var dm = db.modelById[state.deviceId];
        var shot = document.querySelector('.dshot');
        if (dm && shot) {
          shot.innerHTML = deviceShotHTML(dm, state.deviceColour);
          var lab = document.querySelector('.dcolours .t-lab');
          if (lab) {
            lab.textContent = dm.specs.colors.length + ' colour' +
              (dm.specs.colors.length === 1 ? '' : 's') + ' · ' +
              dm.specs.colors[state.deviceColour].n;
          }
          Array.prototype.forEach.call(document.querySelectorAll('.dsw'), function (el, i) {
            var on = i === state.deviceColour;
            el.classList.toggle('is-on', on);
            if (on) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current');
          });
        }
        break;
      }
      case 'open-model': go('#/model/' + id); break;
      case 'find-parts':
        state.sheet = null;
        document.getElementById('overlay').innerHTML = '';
        document.body.style.overflow = '';
        state.finder.modelId = id; state.finder.catId = null;
        state.finder.query = db.modelById[id].fullName;
        go('#/finder');
        break;
      case 'find-with-cat': {
        var mid = state.sheet && state.sheet.id;
        state.sheet = null; document.getElementById('overlay').innerHTML = ''; document.body.style.overflow = '';
        state.finder.modelId = mid; state.finder.catId = id;
        state.finder.query = db.modelById[mid].fullName;
        go('#/finder');
        break;
      }
      case 'more-devs':
        state.devView.shown += 60;
        api.getGroup(state.sheet.id).then(paintDevSection);
        break;
      case 'copy':
        (function (val) {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(val).then(function () { toast('Copied ' + val); },
              function () { toast('Could not copy — select the code and copy manually', 'alert'); });
          } else toast('Copied ' + val);
        })(t.getAttribute('data-copy'));
        break;

      /* models page */
      case 'open-brand': go('#/models/' + id); break;
      case 'more-models': state.models.page++; loadBrandModels(false); break;

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
        loadBrandModels(true);
        break;
      }

      case 'clear-model-filters': {
        var f = state.models.filters;
        Object.keys(f).forEach(function (k) { f[k] = ''; });
        state.models.page = 1;
        refreshBrandControls();
        loadBrandModels(true);
        break;
      }
      case 'clear-mq': {
        state.models.q = '';
        var mq = document.getElementById('mq'); if (mq) mq.value = '';
        searchAllModels();
        break;
      }

      /* the Products counter opens the full product listing, so it clears the
         active filters too — otherwise the count in the header (all products)
         would not match what the listing shows */
      case 'go-products':
        state.finder.modelId = null; state.finder.catId = null; state.finder.query = '';
        state.finder.filters = { q: '', brandId: 'all', catId: 'all', sort: 'default' };
        closeSuggest(); syncSearchInputs(true);
        if (location.hash.indexOf('#/finder') === 0) renderFinder(document.getElementById('page'));
        else go('#/finder');
        break;

      /* plans + account */
      case 'go-plans': go('#/plans'); break;
      case 'subscribe':
        /* a plan belongs to a signed-in identity, so sign in first */
        if (!S.canSubscribe()) {
          state.afterSignIn = '#/plans';
          authMode = 'signin';        /* most people arriving here already have an account */
          toast('Sign in to activate a plan', 'lock');
          go('#/account');
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
            } else {
              toast((r.result && r.result.reason) || 'Payment failed', 'alert');
            }
            return;
          }
          renderShellBits();
          toast(live ? 'Payment verified — plan active' : 'Plan active — no payment was taken');
          /* the hash may already be #/account, which would not re-render */
          if (location.hash.indexOf('#/account') === 0) renderAccount(document.getElementById('page'));
          else go('#/account');
        }).catch(function (err) {
          t.disabled = false;
          t.innerHTML = restoreCta;
          toast(err && err.message === 'signin-required'
            ? 'Sign in to activate a plan' : 'Could not start payment', 'alert');
        });
        break;
      case 'edit-profile': {
        var ps = S.get().profile || {};
        edit = {
          shopName: ps.shopName || '', proprietor: ps.proprietor || '',
          country: ps.country || 'IN', mobile: ps.mobile || '',
          flat: (ps.address || {}).flat || '', area: (ps.address || {}).area || '',
          city: (ps.address || {}).city || '', district: (ps.address || {}).district || '',
          stateName: (ps.address || {}).state || '',
          photo: ps.photo || '', location: ps.location || null
        };
        state.sheet = { type: 'editprofile' }; renderSheet();
        break;
      }
      case 'pick-edit-country': state.sheet = { type: 'country', forEdit: true }; renderSheet(); break;
      case 'clear-photo': edit.photo = ''; state.sheet = { type: 'editprofile' }; renderSheet(); break;
      case 'use-location': captureLocation(); break;
      case 'clear-location': edit.location = null; renderSheet(); break;
      case 'save-profile': saveProfile(); break;

      case 'resume-sub':
        S.updateProfile({
          subscription: Object.assign({}, S.get().profile.subscription, { cancelledAt: null })
        }).then(function () {
          renderShellBits(); renderAccount(document.getElementById('page')); toast('Renewal turned back on');
        });
        break;

      case 'cancel-sub':
        S.cancel().then(function () { renderShellBits(); toast('Subscription marked expired', 'alert'); renderAccount(document.getElementById('page')); });
        break;
      case 'signout':
        S.signOut().then(function () {
          authMode = 'signin';           /* land back on Sign in, not the form */
          state.pendingIdentity = null;
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
          state.sheet = null; renderSheet();
          repaintAuth();
        }
        break;

      case 'google-signin': startGoogle(false); break;
      case 'google-signup':
        REG_FIELDS.forEach(function (f) { reg.touched[f.k] = true; });
        if (!regValid()) { repaintAuth(); toast('Complete the highlighted fields first', 'alert'); break; }
        /* already authenticated, just missing the shop profile */
        if (state.pendingIdentity) { finishGoogle(state.pendingIdentity, true); state.pendingIdentity = null; break; }
        startGoogle(true);
        break;
    }
  });

  function rerenderCurrent() {
    if (state.route.name === 'finder') {
      if (state.finder.modelId) renderSelection(); else renderBrowse();
    } else if (state.route.name === 'account') renderAccount(document.getElementById('page'));
    else if (state.route.name === 'plans') renderPlans(document.getElementById('page'));
    if (state.sheet && state.sheet.type === 'group') api.getGroup(state.sheet.id).then(function (r) { paintGroupSheet(document.getElementById('overlay'), r); });
  }

  /* --------------------------------------------------------------- inputs */
  var gqTimer = null, mqTimer = null, bqTimer = null;
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
      clearTimeout(gqTimer);
      gqTimer = setTimeout(function () {
        state.finder.filters.q = el.value;
        var twin = document.getElementById(el.id === 'gq' ? 'gqd' : 'gq');
        if (twin && twin.value !== el.value) twin.value = el.value;
        loadGroups(true);
      }, 220);
    }
    if (el.id === 'mq') {
      clearTimeout(mqTimer);
      mqTimer = setTimeout(function () { state.models.q = el.value; searchAllModels(); }, 220);
    }
    if (el.id === 'bq') {
      clearTimeout(bqTimer);
      bqTimer = setTimeout(function () { state.models.q = el.value; loadBrandModels(true); }, 220);
    }
    /* registration fields: validate live without losing the caret */
    if (el.hasAttribute && el.hasAttribute('data-reg')) {
      var rk = el.getAttribute('data-reg');
      reg[rk] = (rk === 'mobile') ? el.value.replace(/[^\d\s-]/g, '') : el.value;
      if (rk === 'mobile' && el.value !== reg.mobile) el.value = reg.mobile;
      var gb = document.querySelector('.gbtn');
      if (gb) {
        var ok = regValid();
        gb.classList.toggle('is-disabled', !ok);
        gb.disabled = !ok;
        gb.setAttribute('aria-disabled', String(!ok));
      }
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
    if (el.id === 'devq') {
      state.devView.q = el.value; state.devView.shown = S.isPro() ? 60 : 8;
      api.getGroup(state.sheet.id).then(function (r) {
        paintDevSection(r);
        var again = document.getElementById('devq');
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      });
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
      readPhoto(f).then(function (dataUrl) {
        edit.photo = dataUrl;
        state.sheet = { type: 'editprofile' }; renderSheet();
      }, function (err) { toast((err && err.message) || 'Could not read that image', 'alert'); });
      return;
    }

    if (e.target.id === 'sortSel') { state.finder.filters.sort = e.target.value; loadGroups(true); }

    /* Brand-page filters and sort. Only the control that changed is re-read,
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
      refreshBrandControls();
      loadBrandModels(true);
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
    if (e.key === 'Escape') {
      if (state.suggest.open) { closeSuggest(); return; }
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

  function startGoogle(isSignup) {
    authMsg('');
    var btn = document.querySelector('.gbtn');
    if (btn) { btn.classList.add('is-busy'); btn.disabled = true; }
    SM.auth.signInWithGoogle().then(function (identity) {
      finishGoogle(identity, isSignup);
    }, function (err) {
      if (btn) { btn.classList.remove('is-busy'); btn.disabled = false; }
      if (err && err.code === 'unconfigured') {
        /* Firebase Auth is not reachable. There is deliberately no stand-in
           account any more: a pretend identity would let someone hold a
           subscription no payment backs, and real sign-in now works. */
        authMsg('Sign-in is unavailable right now. Reload the page, and if it ' +
                'persists the site configuration needs checking.');
        return;
      }
      if (err && err.code === 'cancelled') { toast('Sign-in cancelled'); return; }
      authMsg(esc(err && err.message ? err.message : 'Google sign-in failed. Try again.'));
    });
  }

  function finishGoogle(identity, isSignup) {
    var registration = isSignup ? {
      shopName: reg.shopName.trim(), proprietor: reg.proprietor.trim(),
      country: reg.country, countryName: (SM.countries.byCode(reg.country) || {}).name,
      dial: (SM.countries.byCode(reg.country) || {}).dial,
      mobile: reg.mobile.trim(),
      address: {
        flat: reg.flat.trim(), area: reg.area.trim(), city: reg.city.trim(),
        district: reg.district.trim(), state: reg.stateName.trim(),
        country: (SM.countries.byCode(reg.country) || {}).name
      }
    } : null;

    S.signInWithGoogle(identity, registration).then(function (res) {
      if (res && res.needsRegistration) {
        /* known Google account, no shop profile yet — send them to the form */
        authMode = 'signup';
        state.pendingIdentity = identity;
        repaintAuth();
        authMsg('That Google account has no shop profile yet. Fill in your shop details below to finish creating it.');
        return;
      }
      renderShellBits();
      renderAccount(document.getElementById('page'));
      toast(res && res.isNew ? 'Account created — welcome' : 'Signed in');
      if (state.afterSignIn) { var go2 = state.afterSignIn; state.afterSignIn = null; go(go2); }
    });
  }

  /* ----------------------------------------------------------------- boot */
  applyTheme();
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (state.theme === 'system') renderShellBits();
    });
  }
  SM.art.mount();
  if (!location.hash) location.replace('#/finder');

  /* The shell reads db.stats for the header counts, so it cannot mount before
     the catalogue arrives. A brand mark and a line of text hold the page in
     the meantime — ~280 KB gzipped, so this is brief, but a blank window while
     it downloads would look broken. */
  var app = document.getElementById('app');
  if (app) {
    app.innerHTML = '<div class="bootwait">' + SM.logoMark(44) +
      '<span>Loading the device catalogue…</span></div>';
  }

  /* The catalogue and the Firebase config are fetched together — they are
     independent, and doing them in sequence would add a round trip to every
     visit. The config resolve is deliberately not allowed to fail the boot:
     browsing, search and the catalogue all work without Firebase, and the site
     should not go dark because sign-in is unavailable. */
  Promise.all([
    SM.dataset.load(),
    SM.fb.loadConfig().catch(function () { return null; })
  ]).then(function () {
    SM.__rebind.forEach(function (fn) { fn(); });

    /* Restores a signed-in session before the first render, so a returning
       subscriber does not see the signed-out shell flash past. */
    if (SM.fb.isConfigured()) {
      SM.fb.restore().then(function () { renderShellBits(); });
    }
    /* Recent searches resolve stored ids against the catalogue, so this has to
       come after it exists — reading them at boot was what crashed the page. */
    state.recent = loadRecent();
    mountShell();
    window.addEventListener('hashchange', route);
    route();
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
