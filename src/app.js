/* ============================================================================
   SnapMatch · app.js — shell, hash router, pages, interactions
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, C = SM.C, icon = SM.icon, api = SM.api, db = SM.db, S = SM.session;
  var esc = C.esc, nf = C.nf;

  /* ------------------------------------------------------------------ state */
  var state = {
    theme: store('snapmatch.theme') || 'system',
    route: { name: 'finder', params: {} },
    base: '#/finder',
    finder: {
      modelId: null, catId: null, query: '', matchShown: 3,
      filters: { q: '', brandId: 'all', catId: 'all', sort: 'default' },
      page: 1, rows: [], total: 0, hasMore: false, busy: false
    },
    models: { brandId: null, q: '', page: 1, items: [], total: 0, hasMore: false, busy: false },
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
    store('snapmatch.theme', state.theme);
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
      '<a class="logo" href="#/finder" aria-label="SnapMatch home">' + SM.logoMark(34) +
      '<span><span class="logo__word">Snap<em>Match</em></span>' +
      '<span class="logo__by">A ProGlide product</span></span></a>' +
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
    if (r.name === 'group' || r.name === 'model') {
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
        '<p class="bench__sub">Type any model. SnapMatch returns the compatibility group, its master model, the part code and every other device that takes the same part.</p>') +
      searchHTML(picked) +
      /* recent searches are no longer a permanent row — they live in the
         search dropdown. Stats stay here for narrow screens only; the header
         carries them from 1180px up. */
      (picked ? '' : '<div class="bench__stats">' + statsHTML() + '</div>');

    if (picked) {
      /* focused result view — unchanged single-column page */
      page.classList.remove('is-ws');
      page.innerHTML =
        '<section class="bench"><div class="shell bench__in">' + benchInner + '</div></section>' +
        '<div class="shell" id="finderBody"></div>';
      renderSelection();
      return;
    }

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
  var RECENT_KEY = 'snapmatch.recent.v1';
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
      /* mobile / tablet toolbar — unchanged behaviour */
      '<div class="fbar">' +
      '<div class="field grow">' + icon('search') +
      '<input class="input" id="gq" placeholder="Filter groups, part codes…" value="' + esc(f.filters.q) + '" aria-label="Filter groups" /></div>' +
      '<button class="btn btn--outline btn--icon fbar__btn" data-act="open-filters" aria-label="Filters">' +
      icon('filter') + (activeFilterCount() ? '<span class="dotn">' + activeFilterCount() + '</span>' : '') + '</button>' +
      '</div>' +

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

      /* horizontal category selector — mobile/tablet only, panels take over on desktop */
      '<div class="catrow" style="margin-bottom:14px">' +
      '<button class="catchip' + (f.filters.catId === 'all' ? ' is-on' : '') + '" data-act="filter-cat" data-id="all" style="--c:var(--teal-500)"><span class="dot"></span>All parts</button>' +
      db.categories.map(function (c) { return C.categoryChip(c, f.filters.catId === c.id); }).join('') +
      '</div></div>'
    );
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
    if (reset) { f.page = 1; f.rows = []; }
    f.busy = true;
    var res = document.getElementById('results');
    if (reset && res) res.innerHTML = C.skelPlates(6);
    /* a new result set always starts at the top of the centre column */
    if (reset) { var sc = wsScroller(); if (sc) sc.scrollTop = 0; }
    api.listGroups({
      q: f.filters.q, brandId: f.filters.brandId, categoryId: f.filters.catId,
      sort: f.filters.sort, page: f.page, pageSize: 12
    }).then(function (r) {
      f.busy = false; f.total = r.total; f.hasMore = r.hasMore;
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

      '<div class="sec"><div class="sec__head"><div class="sec__title">' +
      '<h2>Pick a part category</h2></div>' +
      (f.catId ? '<button class="btn btn--ghost btn--sm" data-act="pick-cat" data-id="' + f.catId + '">' + icon('close') + 'All categories</button>' : '') +
      '</div><div class="cats" id="cats">' +
      db.categories.map(function (c) { return C.categoryCard(c, null, { active: f.catId === c.id }); }).join('') +
      '</div></div>' +

      '<div class="sec" id="matchRegion">' + C.skelPlates(2) + '</div>';

    api.categoryAvailability(m.id).then(function (rows) {
      var host = document.getElementById('cats');
      if (!host) return;
      host.innerHTML = rows.map(function (r) {
        return C.categoryCard(r.category, r.count, { active: f.catId === r.category.id, dim: true });
      }).join('');
    });
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

      host.innerHTML = head + shown.map(function (row) {
        return matchCard(row, m);
      }).join('') +
        (rows.length > shown.length
          ? '<button class="expandbtn" data-act="more-matches">' + icon('chevronDown') +
          'Show ' + Math.min(3, rows.length - shown.length) + ' more ' +
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
    var preview = row.devices.slice(0, pro ? 8 : 4);

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
      (pro ? C.idGrid(g) : '<div class="locked"><div class="locked__blur">' + C.idGrid(g) + '</div></div>') +
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

  function renderBrandModels(brandId) {
    var b = db.brandById[brandId];
    if (!b) { go('#/models'); return; }
    var m = state.models;
    document.getElementById('modelsBody').innerHTML =
      '<div class="crumbs" style="margin-bottom:14px">' +
      '<button data-act="nav" data-href="#/models">All brands</button>' + icon('chevronRight') +
      '<span style="color:var(--ink)">' + esc(b.name) + '</span></div>' +

      '<div class="card card--pad" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:18px;--b1:' + b.color + '">' +
      SM.brandLogo(b, 'blogo--lg') +
      '<div class="grow"><h2 class="t-h1">' + esc(b.name) + '</h2>' +
      '<p class="t-xs">' + b.modelCount + ' models in the sample database</p></div>' +
      '<label class="field" style="min-width:min(280px,100%)">' + icon('search') +
      '<input class="input" id="bq" placeholder="Search ' + esc(b.name) + ' models…" value="' + esc(m.q) + '" aria-label="Search within brand" /></label>' +
      '</div>' +
      '<div id="brandModels">' + C.skelRows(9) + '</div>' +
      '<div class="loadmore" id="brandMore"></div>';

    loadBrandModels(true);
  }

  function loadBrandModels(reset) {
    var m = state.models;
    if (reset) { m.page = 1; m.items = []; }
    m.busy = true;
    api.listModels({ brandId: m.brandId, q: m.q, page: m.page, pageSize: 24, sort: 'newest' }).then(function (r) {
      m.busy = false; m.total = r.total; m.hasMore = r.hasMore;
      m.items = reset ? r.items : m.items.concat(r.items);
      var host = document.getElementById('brandModels');
      var more = document.getElementById('brandMore');
      if (!host) return;
      if (!m.items.length) {
        host.innerHTML = C.state({ icon: 'search', title: 'No models match “' + m.q + '”', text: 'Try a shorter search — a series name or a number.' });
        more.innerHTML = ''; return;
      }
      host.innerHTML = '<div class="modelgrid">' + m.items.map(function (x) { return C.modelCard(x, m.q); }).join('') + '</div>';
      more.innerHTML = m.hasMore
        ? '<button class="btn btn--outline" data-act="more-models">' + icon('plus') + 'Show more (' + nf(m.total - m.items.length) + ' left)</button>'
        : '<span class="t-xs muted">All ' + nf(m.total) + ' models shown</span>';
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

  function authHTML() {
    return '<div class="acct">' +
      '<div class="card card--pad">' +
      '<div class="segmented" style="margin-bottom:18px">' +
      '<button class="is-on" data-act="auth-tab" data-id="signin">Sign in</button>' +
      '<button data-act="auth-tab" data-id="signup">Create account</button>' +
      '</div>' +
      '<h2 class="t-h1" id="authTitle">Sign in to SnapMatch</h2>' +
      '<p class="t-sub" style="margin-top:6px" id="authSub">Use any email — this prototype has no authentication backend, so nothing is sent anywhere.</p>' +
      '<form id="authForm" style="display:flex;flex-direction:column;gap:12px;margin-top:18px">' +
      '<div id="nameRow" style="display:none"><label class="t-lab" for="nm">Shop name</label>' +
      '<input class="input" id="nm" placeholder="Sharma Mobile Care" autocomplete="off" /></div>' +
      '<div><label class="t-lab" for="em">Email</label>' +
      '<input class="input" id="em" type="email" placeholder="you@shop.in" value="demo@proglide.app" autocomplete="off" required /></div>' +
      '<div><label class="t-lab" for="pw">Password</label>' +
      '<input class="input" id="pw" type="password" placeholder="••••••••" value="demo1234" autocomplete="off" /></div>' +
      '<button class="btn btn--primary btn--lg btn--block" type="submit">' + icon('arrowRight') + '<span id="authBtn">Sign in</span></button>' +
      '</form>' +
      '<p class="t-xs muted" style="margin-top:14px">Prototype only — no credentials are validated, stored on a server, or transmitted.</p>' +
      '</div>' +

      '<div class="card card--pad">' +
      '<span class="t-lab">Why shops sign in</span>' +
      '<ul class="plan__feats" style="margin-top:12px">' +
      ['Keep your plan on every device at the counter', 'Your searches stay on your account', 'Staff logins and part-code export are next on the roadmap']
        .map(function (t) { return '<li>' + icon('checkCircle') + '<span>' + esc(t) + '</span></li>'; }).join('') +
      '</ul>' +
      '<hr class="divider" style="margin:16px 0" />' +
      demoPanelHTML() +
      '</div></div>';
  }

  function profileHTML(s) {
    var plan = s.plan ? SM.PLANS.filter(function (p) { return p.id === s.plan; })[0] : null;
    var badge = s.status === 'pro' ? '<span class="pill pill--ok">' + icon('checkCircle') + 'Active</span>'
      : s.status === 'expired' ? '<span class="pill pill--bad">' + icon('alert') + 'Expired</span>'
        : '<span class="pill">' + icon('user') + 'Free account</span>';

    return '<div class="acct">' +
      '<div class="card card--pad">' +
      '<div class="row" style="gap:14px">' +
      '<span class="avatar avatar--lg">' + esc(initials(s.name)) + '</span>' +
      '<div class="grow"><h2 class="t-h1">' + esc(s.name || 'Demo Shop') + '</h2>' +
      '<p class="t-xs">' + esc(s.email) + '</p>' +
      '<div style="margin-top:8px">' + badge + '</div></div></div>' +
      '<hr class="divider" style="margin:18px 0" />' +

      (s.status === 'pro'
        ? '<span class="t-lab">Current plan</span>' +
        '<div class="row" style="gap:10px;margin-top:8px;align-items:baseline">' +
        '<span class="t-h1">' + esc(plan ? plan.name : 'Monthly') + '</span>' +
        '<span class="muted">₹' + (plan ? plan.price : 99) + ' / ' + (plan ? plan.per : 'month') + '</span></div>' +
        '<p class="t-xs" style="margin-top:6px">Renews on ' + esc(s.renewsOn) + '</p>' +
        '<div class="statusbar" style="margin-top:12px"><i style="width:62%"></i></div>' +
        '<div class="row wrap" style="gap:8px;margin-top:16px">' +
        '<button class="btn btn--outline btn--sm" data-act="nav" data-href="#/plans">' + icon('crown') + 'Change plan</button>' +
        '<button class="btn btn--ghost btn--sm" data-act="cancel-sub">Cancel subscription</button>' +
        '</div>'

        : s.status === 'expired'
          ? '<div class="notice notice--amber">' + icon('alert') +
          '<span><b>Subscription expired.</b> Device Finder matching is locked. All Mobile Models is still completely free to browse.</span></div>' +
          '<button class="btn btn--amber btn--block btn--lg" style="margin-top:14px" data-act="nav" data-href="#/plans">' +
          icon('bolt') + 'Renew from ₹99</button>'

          : '<div class="notice notice--brand">' + icon('info') +
          '<span><b>You are on the free tier.</b> Browse every model and every group. Add a plan to match a model to its group and see full fitment lists.</span></div>' +
          '<button class="btn btn--primary btn--block btn--lg" style="margin-top:14px" data-act="nav" data-href="#/plans">' +
          icon('crown') + 'See plans from ₹99</button>') +

      '<hr class="divider" style="margin:18px 0" />' +
      '<button class="btn btn--ghost btn--sm" data-act="signout">' + icon('logout') + 'Sign out</button>' +
      '</div>' +

      '<div class="card card--pad">' +
      '<span class="t-lab">Your shop at a glance</span>' +
      '<div class="idgrid" style="margin-top:12px;grid-template-columns:repeat(2,minmax(0,1fr))">' +
      '<div class="idcell"><span>Models available</span><b style="font-family:var(--f-ui);font-size:17px">' + nf(db.stats.models) + '</b></div>' +
      '<div class="idcell"><span>Groups available</span><b style="font-family:var(--f-ui);font-size:17px">' + nf(db.stats.groups) + '</b></div>' +
      '<div class="idcell"><span>Part categories</span><b style="font-family:var(--f-ui);font-size:17px">' + db.stats.categories + '</b></div>' +
      '<div class="idcell"><span>Member since</span><b style="font-family:var(--f-ui);font-size:17px">' + esc(s.since || '—') + '</b></div>' +
      '</div>' +
      '<hr class="divider" style="margin:18px 0" />' +
      demoPanelHTML() +
      '</div></div>';
  }

  function demoPanelHTML() {
    var s = S.get();
    var opts = [['guest', 'Guest'], ['free', 'Free user'], ['pro', 'Active subscriber'], ['expired', 'Expired']];
    return '<span class="t-lab">Prototype access states</span>' +
      '<p class="t-xs" style="margin:6px 0 10px">Switch the mock account state to review every screen. Nothing here talks to a server.</p>' +
      '<div class="segmented" style="flex-wrap:wrap">' + opts.map(function (o) {
        return '<button class="' + (s.status === o[0] ? 'is-on' : '') + '" data-act="set-state" data-id="' + o[0] + '" style="min-width:88px">' + esc(o[1]) + '</button>';
      }).join('') + '</div>';
  }

  /* ==========================================================================
     OVERLAYS · group sheet · model sheet · filters · demo
     ========================================================================== */
  function renderSheet() {
    var host = document.getElementById('overlay');
    var s = state.sheet;
    if (!s) { host.innerHTML = ''; document.body.style.overflow = ''; return; }
    document.body.style.overflow = 'hidden';

    if (s.type === 'filters') return paintSheet(host, 'Filter groups', categoryPanelHTML() + brandPanelHTML(),
      '<button class="btn btn--outline grow" data-act="reset-filters">Reset</button>' +
      '<button class="btn btn--primary grow" data-act="close-sheet">Show ' + nf(state.finder.total) + ' groups</button>');

    if (s.type === 'demo') return paintSheet(host, 'Prototype access states', demoPanelHTML() +
      '<div class="notice" style="margin-top:14px">' + icon('info') +
      '<span>This switch exists only so the UI can be reviewed end to end. In production the state comes from the ProGlide backend.</span></div>',
      '<button class="btn btn--primary btn--block" data-act="close-sheet">Done</button>');

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
    var list = q ? row.devices.filter(function (d) { return d.fullName.toLowerCase().indexOf(q) > -1; }) : row.devices;
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
    state.finder.matchShown = 3;
    state.finder.query = m.fullName;
    pushRecent(id);
    closeSuggest();
    syncSearchInputs(true);
    if (state.route.name !== 'finder') go('#/finder');
    else renderFinder(document.getElementById('page'));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  var authMode = 'signin';

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t) {
      if (!e.target.closest('.searchwrap')) closeSuggest();
      return;
    }
    var act = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');

    switch (act) {
      case 'theme': cycleTheme(); break;
      case 'demo': state.sheet = { type: 'demo' }; renderSheet(); break;
      case 'nav': go(t.getAttribute('data-href')); break;
      case 'close-sheet':
        if (state.sheet && (state.sheet.type === 'filters' || state.sheet.type === 'demo')) {
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
        state.finder.modelId = null; state.finder.catId = null; state.finder.query = '';
        closeSuggest();
        renderFinder(document.getElementById('page'));
        syncSearchInputs(true);
        break;
      case 'pick-cat':
        state.finder.catId = state.finder.catId === id ? null : id;
        state.finder.matchShown = 3;
        renderSelection();
        break;
      case 'clear-cat': state.finder.catId = null; state.finder.matchShown = 3; renderSelection(); break;
      case 'more-matches': state.finder.matchShown += 3; loadMatches(); break;

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
      case 'demo-pro':
        S.setState('pro'); renderShellBits();
        toast('Previewing as an active subscriber');
        rerenderCurrent();
        break;
      case 'subscribe':
        t.disabled = true;
        t.innerHTML = icon('refresh') + 'Activating…';
        S.subscribe(id).then(function () {
          renderShellBits();
          toast('Prototype plan active — no payment was taken');
          go('#/account');
        });
        break;
      case 'cancel-sub':
        S.cancel().then(function () { renderShellBits(); toast('Subscription marked expired', 'alert'); renderAccount(document.getElementById('page')); });
        break;
      case 'set-state':
        S.setState(id); renderShellBits();
        if (state.sheet) { state.sheet = null; renderSheet(); }
        toast('Access state: ' + id);
        rerenderCurrent();
        break;
      case 'signout':
        S.signOut().then(function () { renderShellBits(); renderAccount(document.getElementById('page')); toast('Signed out'); });
        break;
      case 'auth-tab': {
        authMode = id;
        var seg = t.parentNode.querySelectorAll('button');
        for (var k = 0; k < seg.length; k++) seg[k].classList.toggle('is-on', seg[k] === t);
        document.getElementById('nameRow').style.display = id === 'signup' ? '' : 'none';
        document.getElementById('authTitle').textContent = id === 'signup' ? 'Create your SnapMatch account' : 'Sign in to SnapMatch';
        document.getElementById('authBtn').textContent = id === 'signup' ? 'Create account' : 'Sign in';
        break;
      }
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
    if (e.target.id === 'sortSel') { state.finder.filters.sort = e.target.value; loadGroups(true); }
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
        if (state.sheet.type === 'filters' || state.sheet.type === 'demo') { state.sheet = null; renderSheet(); }
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

  document.addEventListener('submit', function (e) {
    if (e.target.id !== 'authForm') return;
    e.preventDefault();
    var em = document.getElementById('em').value || 'demo@proglide.app';
    var nm = (document.getElementById('nm') || {}).value || '';
    var btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.innerHTML = icon('refresh') + 'Signing in…';
    S.signIn(em, nm).then(function () {
      renderShellBits();
      renderAccount(document.getElementById('page'));
      toast(authMode === 'signup' ? 'Account created (prototype)' : 'Signed in (prototype)');
    });
  });

  /* ----------------------------------------------------------------- boot */
  applyTheme();
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (state.theme === 'system') renderShellBits();
    });
  }
  state.recent = loadRecent();
  SM.art.mount();
  mountShell();
  if (!location.hash) location.replace('#/finder');
  window.addEventListener('hashchange', route);
  route();
})(window);
