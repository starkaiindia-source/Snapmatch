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
      groupId: null, detailModelId: null, groupQ: '', groupShown: 400
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
    /* How many columns the category grid uses. A working preference, like the
       models view above — someone who wants the wider two-up tiles wants them
       next time too, so it is remembered on the device rather than stored
       against an account. Read back through a whitelist: a stale or hand-edited
       value must not be able to produce a grid with no columns. */
    catCols: store('mpf.catcols') === '2' ? 2 : 3,
    brandQ: '',
    suggest: { open: false, q: '', items: [], cursor: -1 },
    sheet: null,           /* { type:'group'|'model'|'filters'|'demo', id } */
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
      return '<a class="nav__a' + (cur === n.id ? ' is-on' : '') + '" href="' + n.href + '" title="' + esc(n.label) + '">' +
        icon(n.icon) + '<span>' + esc(n.label) + '</span></a>';
    }).join('');

    document.getElementById('tabbar').innerHTML = NAV.map(function (n) {
      return '<a class="tab' + (cur === n.id ? ' is-on' : '') + '" href="' + n.href + '">' +
        icon(n.icon) + '<span>' + esc(n.short) + '</span></a>';
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
    /* Free searches left today. Only for a free account, only once the SERVER
       has said so, and never for a subscriber — a paid user should not be
       reading a counter about a limit they do not have. Deliberately small and
       to the left of the avatar rather than a banner across the page. */
    end = freeSearchChipHTML() + end;

    if (s.status === 'guest') {
      end += '<a class="btn btn--primary btn--sm" href="/account">Sign in</a>';
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

  /* "2/3 searches" while some remain, "Upgrade" once they are gone.
     Renders nothing at all for a paid account, a signed-out visitor, or before
     the server has answered — an entitlement chip drawn on a guess is a chip
     that flickers the wrong number on every page load. */
  function freeSearchChipHTML() {
    /* isMeteredAccount, not isFree: the chip counts an ACCOUNT's allowance, and
       a signed-out visitor has no account to count. They see the Sign in
       button instead, which is the more useful thing to show them. */
    if (!SM.access || !SM.access.isMeteredAccount()) return '';
    var a = SM.access.get();
    if (!a || a.dailySearchesRemaining == null) return '';

    if (a.dailySearchesRemaining > 0) {
      return '<a class="pill" href="/plans" title="Free searches reset each day">' +
        icon('search') + a.dailySearchesRemaining + '/' + a.dailySearchLimit + ' searches</a>';
    }
    return '<a class="pill pill--warn" href="/plans" ' +
      'title="Daily free searches used. Upgrade to keep searching.">' +
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
  var ROUTES = { finder: 1, models: 1, model: 1, plans: 1, account: 1, group: 1 };

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
     an inspection of / reported a user-declared canonical of /finder.

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
    if (r.name === 'group') {
      state.finder.groupId = r.params[0] || null;
      state.finder.detailModelId = null;
      state.finder.groupQ = '';
      state.finder.groupShown = 400;
      /* The variant helpers are shared with the model page and hold one
         device's selection at a time; a group opens on its master. */
      state.deviceColour = 0;
      state.deviceVariant = null;
      state.deviceShot = 0;
      r = { name: 'finder', params: [] };
    } else if (state.finder.groupId) {
      state.finder.groupId = null;
      state.finder.detailModelId = null;
      state.finder.groupQ = '';
    }

    state.sheet = null;
    document.getElementById('overlay').innerHTML = '';
    document.body.style.overflow = '';
    state.route = r;
    state.base = toPath(r);
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
    return renderFinder(page);
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
    /* Tapping the tile that is already on clears it, which is what the tiles
       have always done. */
    if (f.filters.catId === next && next !== 'all') next = 'all';
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

  /** The device the right panel is describing: the picked one, or the master. */
  function detailModel() {
    var row = currentGroup();
    if (!row) return null;
    var id = state.finder.detailModelId;
    return (id && db.modelById[id]) || row.master;
  }

  /* CategoryProductVisual — one place the group view asks for a category's
     picture, so a second call site cannot start showing a different one.

     Today it delegates to SM.art.category, which already resolves the official
     logo from Firebase Storage first and the identical file deployed with the
     site second, falling back to a drawn symbol only when both are
     unreachable. An explicit imageUrl overrides all of that, and that is the
     seam the admin panel will write to: once a category record carries its own
     product photograph, it arrives here as `imageUrl` and no call site changes.

     @param {object} cat   the category record
     @param {object} opts  { imageUrl, cls } */
  function categoryVisual(cat, opts) {
    opts = opts || {};
    if (!cat) return '';
    /* categoryImageUrl is not in the schema yet. Reading it now means the
       import that adds it needs no code change here. */
    var url = opts.imageUrl || cat.categoryImageUrl || cat.imageUrl || null;
    var cls = 'catvis' + (opts.cls ? ' ' + opts.cls : '');
    var inner = url
      ? '<img class="catvis__img" src="' + esc(url) + '" alt="' + esc(cat.name) + '" ' +
        'loading="lazy" decoding="async" />'
      : SM.art.category(cat.id, 'catvis__art', cat.name);
    return '<span class="' + cls + '" title="' + esc(cat.name) + '" ' +
      'aria-label="' + esc(cat.name) + '">' + inner + '</span>';
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

     How many devices this group actually links, read from the compatibility
     edges themselves rather than from any stored figure. api.groupMembers
     resolves db.membersByGroup — the inverse of the model -> groups map the
     bundle ships — so the number here and the list under it are always the
     same set counted twice. Nothing about it is written down in this file.

     compatibleCount is the group row's own tally and is used only when the
     member list has not been hydrated yet, so a group that is still loading
     says how big it is instead of saying nothing. */
  function groupMemberCount(g) {
    var members = api.groupMembers(g);
    if (members.length) return members.length;
    return g && g.compatibleCount ? g.compatibleCount : 0;
  }

  /* "325 devices linked" — the phrase, not the number. One place decides the
     wording so the group header, the mobile sheet and the selected-model
     header cannot drift into three ways of saying the same thing. */
  function deviceCountLabel(n, verb) {
    return nf(n) + ' device' + (n === 1 ? '' : 's') + (verb ? ' ' + verb : '');
  }

  /* The sticky master header: back, the master handset, its name, the part
     codes, how many devices the group links, the category's own picture, and
     the filter.

     It is a SIBLING of everything below it, not a wrapper around the head.
     position:sticky is bounded by its own parent's box, so nested inside a
     header block it would unstick the moment that block scrolled past — about
     200px into a list that can run to 325 devices. As a direct child of the
     centre column it spans the whole scroll instead.

     The title is the model, and only the model. It used to read "Motorola Razr
     50 cover group", which put the part category inside the device's name; the
     category is already said by the picture on the right and by the left-hand
     rail, and saying it a third time inside the heading made the heading wrong
     rather than fuller. */
  function groupBarHTML(row) {
    var g = row.group, cat = row.category, master = row.master;
    var codes = [g.groupNumber, g.partCode, g.oemPartNo].filter(Boolean).join(' · ');
    var total = groupMemberCount(g);

    return '<div class="gbar">' +
      /* The phone's own grab handle. Drawn only inside the mobile sheet, where
         the header is the top of a panel rather than a column heading. */
      '<span class="gbar__grab" aria-hidden="true"></span>' +

      '<div class="gbar__row">' +
        '<button type="button" class="gback" data-act="close-group" ' +
          'aria-label="Back to compatibility groups" title="Back to compatibility groups">' +
          icon('chevronLeft') + '<span class="gback__t">Back</span></button>' +

        '<span class="gbar__shot">' +
          SM.art.photo(master, { alt: master.fullName, eager: true, cls: 'gbar__ph' }) +
        '</span>' +

        '<span class="gbar__id">' +
          '<span class="gbar__n">' + esc(deviceTitle(master)) + '</span>' +
          '<span class="gbar__meta">' +
            '<span class="gbar__count" id="gdCount">' +
              esc(deviceCountLabel(total, 'linked')) + '</span>' +
            (codes ? '<span class="gbar__codes">' + esc(codes) + '</span>' : '') +
          '</span>' +
        '</span>' +

        '<span class="gbar__right">' +
          categoryVisual(cat, { cls: 'catvis--bar' }) +
          '<label class="field gbar__filter">' + icon('search') +
            '<input class="input" id="gdq" placeholder="Filter these devices…" ' +
            'value="' + esc(state.finder.groupQ || '') + '" ' +
            'aria-label="Filter devices in this group" /></label>' +
        '</span>' +
      '</div>' +
      '</div>';
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
    return '<button type="button" class="gchip' + (sel ? ' is-on' : '') +
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
    return '<div class="gchips">' + list.map(function (m) {
      return deviceChipHTML(m, opts);
    }).join('') + '</div>';
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
  function brandBlocksHTML(list, opts) {
    opts = opts || {};
    var master = db.modelById[opts.masterId];
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

    return order.map(function (bid) {
      var mine = byBrand[bid];
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

  function groupCenterHTML(row) {
    return groupBarHTML(row) +
      '<div class="fbar"><div class="field grow">' + icon('search') +
        '<input class="input" id="gdqm" placeholder="Filter these devices…" ' +
        'value="' + esc(state.finder.groupQ || '') + '" ' +
        'aria-label="Filter devices in this group" /></div></div>' +
      '<div id="groupList" class="glist">' + groupListHTML(row) + '</div>';
  }

  /* Just the list. Repainted on its own when the filter changes, so the input
     keeps its caret and its focus. */
  function groupListHTML(row) {
    var all = api.groupMembers(row.group);
    var q = String(state.finder.groupQ || '').trim().toLowerCase();
    var list = q ? all.filter(function (m) { return m.search.indexOf(q) > -1; }) : all;
    /* The cap is a guard rail, not a page size: the largest group in the
       catalogue is 325 and the median is 3, so today it never fires. It is
       here so that a group ten times that size degrades into a button rather
       than into a second of blocked scripting. */
    var shown = list.slice(0, state.finder.groupShown || 400);
    var sel = detailModel();
    if (!shown.length) {
      return '<div class="notice">' + icon('alert') +
        '<span>No device in this group matches that filter.</span></div>';
    }
    return brandBlocksHTML(shown, { masterId: row.master.id, sel: sel }) +
      (list.length > shown.length
        ? '<div class="loadmore"><button class="btn btn--outline" data-act="more-devices">' +
          'Show ' + nf(list.length - shown.length) + ' more</button></div>'
        : '');
  }

  /* The right panel: the selected device, in the space a sidebar has.

     The sections are the same builder the full model page uses, so a field the
     import adds later appears here too without a second edit. IMPORTED is not
     passed: on the model page an empty-but-known column is worth a hyphen,
     because the page is about completeness; in a 240px sidebar a column of
     hyphens just reads as broken. */
  function groupDetailHTML() {
    var row = currentGroup();
    var base = detailModel();
    if (!row || !base) return '';
    var m = previewVariants(base);
    var b = db.brandById[m.brandId] || { id: m.brandId, name: m.brand };
    var sp = m.specs || {};
    var cur = currentVariant(m);
    var rear = sp.cameraRear || [];
    var isMaster = m.id === row.master.id;

    var ramTxt = (sp.ramVariantsGb || []).length ? sp.ramVariantsGb.join(' / ') + ' GB' : null;
    var romTxt = (sp.storageVariantsGb || []).length
      ? sp.storageVariantsGb.map(fmtRom).join(' / ') : null;

    return '<div class="gdet">' +
      '<div class="gdet__top">' +
        /* Drawn only inside the mobile sheet, where the list this device was
           picked from is thousands of pixels above. Beside the list on a
           desktop it would be a button that scrolls nothing. */
        '<button type="button" class="gdet__back" data-act="back-to-list">' +
          icon('chevronLeft') + 'Device list</button>' +
        '<span class="t-lab">' + (isMaster ? 'Master model' : 'Selected device') + '</span>' +
      '</div>' +

      /* The photograph, and nothing around it.

         This used to sit in a bordered, tinted, radiused box — inside which
         .dphoto draws its own box — so every handset in the panel arrived
         wearing two frames it did not need. The picture is a cut-out on a
         white ground already; a second outline around it reads as a smudge on
         the part rather than as a card. The box is gone, the image is bigger
         for the space it frees, and object-fit still keeps whatever ratio the
         file actually has. */
      '<div class="gdet__shot">' +
        SM.art.photo(m, { src: deviceImageUrl(m), colourIdx: state.deviceColour || 0,
                          alt: m.fullName, eager: true, cls: 'gdet__ph' }) +
      '</div>' +

      '<div class="gdet__brand">' + SM.brandLogo(b, 'blogo--sm') +
        (brandHasMark(b) ? '<span>' + esc(b.name) + '</span>' : '') + '</div>' +
      '<h3 class="gdet__n">' + esc(deviceTitle(m)) + '</h3>' +

      priceHTML(m, cur) +
      /* Renders nothing at all until the catalogue carries variants — which is
         the right answer for a device with one known build, and means the
         import that adds them needs no work here. */
      variantPickerHTML(m) +

      '<div class="gdet__secs">' +
        specBlockHTML('Overview', 'info', [
          ['Brand', b.name],
          ['Released', m.releaseDate],
          ['Availability', m.releaseStatus && m.releaseStatus !== 'available'
            ? m.releaseStatus.replace(/_/g, ' ') : null],
          ['Device type', m.deviceType]
        ]) +
        specBlockHTML('Display', 'phone', [
          ['Size', m.displaySize ? m.displaySize + ' inches' : null],
          ['Resolution', m.screenResolution],
          ['Type', m.screenType],
          ['Refresh rate', m.refreshRate],
          ['Protection', m.protection]
        ]) +
        specBlockHTML('Body', 'ruler', [
          ['Height', m.height],
          ['Width', m.width],
          ['Thickness', m.thickness],
          ['Weight', m.weight],
          ['Screen area', m.screenCm2 ? m.screenCm2 + ' cm²' : null],
          ['Body ratio', m.bodyRatio ? m.bodyRatio + '%' : null],
          ['Colours', coloursOf(m).length
            ? coloursOf(m).map(function (c) { return c.n; }).join(', ') : null]
        ]) +
        specBlockHTML('Battery & charging', 'battery', [
          ['Capacity', sp.batteryMah ? nf(sp.batteryMah) + ' mAh' : null],
          ['Battery part number', m.batteryPartNo
            ? m.batteryPartNo + (m.batteryPartVerified ? ' (verified)' : ' (unverified)') : null],
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
          ['Chipset', sp.chipset], ['CPU', sp.cpu], ['GPU', sp.gpu]
        ]) +
        specBlockHTML('Camera', 'camera', rear.map(function (c) {
          return [c.role, c.mp + ' MP · ' + c.aperture + (c.ois ? ' · OIS' : '')];
        }).concat([
          ['Front camera', sp.cameraFront
            ? sp.cameraFront.mp + ' MP · ' + sp.cameraFront.aperture : null],
          ['Video', sp.videoMax]
        ])) +
        specBlockHTML('Network & connectivity', 'signal', [
          ['Network', sp.networkDetail || sp.network],
          ['SIM', m.sim], ['Wi-Fi', sp.wifi], ['Bluetooth', sp.bluetooth],
          ['NFC', sp.nfc == null ? null : (sp.nfc ? 'Yes' : 'No')],
          ['USB', sp.usb]
        ]) +
      '</div>' +

      '<div class="gdet__cta">' +
        '<a class="btn btn--outline" href="/model/' + esc(m.id) + '">' +
          icon('info') + 'Full specifications</a>' +
        '<button class="btn btn--primary" data-act="find-parts" data-id="' + esc(m.id) + '">' +
          icon('search') + 'Find parts</button>' +
      '</div>' +
      '</div>';
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

  /* ------------------------------------------------- where the header ends

     The brand headings stick UNDER the master header, which means they need
     its height. That height is not a constant: it grows with a long device
     name that wraps, with a third part code, and with the grab handle the
     mobile sheet adds. A number written into the stylesheet would be wrong for
     most groups — either a gap under the header or a heading sliding beneath
     it — so it is measured from the element itself and published as --gbar-h.

     ResizeObserver where it exists, which is every browser this app supports
     bar none; the initial write covers the rest, and a wrong value there costs
     a few pixels of overlap on one heading, not a broken list. */
  var gbarRO = null;
  function measureGbar() {
    var bar = document.querySelector('.gbar');
    var host = document.documentElement;
    if (!bar) { host.style.removeProperty('--gbar-h'); return; }
    var h = Math.round(bar.getBoundingClientRect().height);
    if (h > 0) host.style.setProperty('--gbar-h', h + 'px');

    if (global.ResizeObserver) {
      if (gbarRO) gbarRO.disconnect();
      gbarRO = new ResizeObserver(function () {
        var b = document.querySelector('.gbar');
        if (!b) return;
        var n = Math.round(b.getBoundingClientRect().height);
        if (n > 0) host.style.setProperty('--gbar-h', n + 'px');
      });
      gbarRO.observe(bar);
    }
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
    /* After the class, not before: the sheet adds a grab handle to the header,
       so its height is not the height it had a moment ago. */
    measureGbar();

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
  if (global.matchMedia) {
    var sheetMql = global.matchMedia(SHEET_MQ);
    var onSheetMq = function () { syncSheet(); };
    if (sheetMql.addEventListener) sheetMql.addEventListener('change', onSheetMq);
    else if (sheetMql.addListener) sheetMql.addListener(onSheetMq);
  }

  function renderWorkspace() {
    if (!document.getElementById('catPanel')) { renderFinder(document.getElementById('page')); return; }
    document.getElementById('catPanel').innerHTML = categoryPanelHTML();

    /* With a group open the right panel stops being the brand list and becomes
       the selected device. Both panels stay mounted either way — the left one
       never changes, which is what keeps this a state change rather than a
       different page. */
    var grp = currentGroup();
    document.getElementById('brandPanel').innerHTML =
      grp ? groupDetailHTML() : brandPanelHTML();
    document.getElementById('brandPanel').classList.toggle('ws__right--detail', !!grp);

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

  /* Picking a device changes one panel. Repainting the whole workspace would
     rebuild the centre list and throw away its scroll position, which is where
     the reader is standing when they pick. */
  function repaintGroupDetail() {
    var panel = document.getElementById('brandPanel');
    if (panel) panel.innerHTML = groupDetailHTML();
    var sel = detailModel();
    /* Only the chip that WAS on and the chip that is on now are touched. The
       old pass wrote two attributes on all 325 chips for every pick, which is
       325 style invalidations to move one highlight. */
    var want = sel ? sel.id : null;
    var prev = document.querySelector('.gchip.is-on');
    if (prev && prev.getAttribute('data-id') !== want) {
      prev.classList.remove('is-on');
      prev.setAttribute('aria-pressed', 'false');
    }
    if (want) {
      var next = document.querySelector('.gchip[data-id="' + cssEsc(want) + '"]');
      if (next) { next.classList.add('is-on'); next.setAttribute('aria-pressed', 'true'); }
    }
  }

  /* In the mobile sheet the details are BELOW the list — which is the right
     order to read them in, and the wrong place to leave them after a tap three
     hundred devices down: the panel updates somewhere off screen and the tap
     looks like it did nothing. So the sheet carries the reader to the answer,
     and the answer carries a way back to the exact chip they came from.

     Not smoothly. The gap can be eight thousand pixels, and a smooth scroll
     across that either takes seconds or gives up part way. A jump that the
     sticky master header stays put across reads as a panel changing rather
     than as the page running away.

     scroll-margin-top on the panel is what keeps its own heading — and the way
     back — clear of that sticky header.

     Only in the sheet. On a desktop the panel is already beside the list and
     nothing needs to move; scrolling the column there would take the list out
     from under the hand that is picking from it. */
  function revealDetailOnPhone() {
    var body = document.querySelector('.ws__body--sheet');
    var panel = document.getElementById('brandPanel');
    if (!body || !panel || !panel.scrollIntoView) return;
    panel.scrollIntoView({ behavior: 'auto', block: 'start' });
  }

  /* The way back: the chip that is selected, which is the one that was tapped
     to get here. Scrolling to the top of the list instead would be a different
     journey home from the one taken out. */
  function backToDeviceList() {
    var body = document.querySelector('.ws__body--sheet');
    if (!body) return;
    var chip = document.querySelector('.gchip.is-on') || document.querySelector('.gchip');
    if (chip && chip.scrollIntoView) chip.scrollIntoView({ behavior: 'auto', block: 'center' });
  }

  function repaintGroupList() {
    var row = currentGroup();
    if (!row) return;
    var host = document.getElementById('groupList');
    if (host) host.innerHTML = groupListHTML(row);
    var all = api.groupMembers(row.group);
    var q = String(state.finder.groupQ || '').trim().toLowerCase();
    var n = q ? all.filter(function (m) { return m.search.indexOf(q) > -1; }).length : all.length;
    var c = document.getElementById('gdCount');
    /* Filtering narrows what is on screen; it does not change how many devices
       the group links. "12 of 325 devices" says both, and the group's own
       total never silently becomes the size of a search. */
    if (c) {
      c.textContent = q
        ? nf(n) + ' of ' + deviceCountLabel(all.length)
        : deviceCountLabel(all.length, 'linked');
    }
  }

  /* Kept as the old name so nothing else had to change; the two are the same
     operation now that there is only one layout. */
  function renderBrowse() { renderWorkspace(); }

  /* ------------------------------------------------- devices linked to ONE

     Every distinct device that shares at least one compatibility group with
     this model. Read from the same two maps the group view reads — the model's
     groups, and each of those groups' members — so "88 devices linked" and the
     lists underneath it are the same edges counted two ways.

     The model itself is seeded into `seen`, because a phone is not compatible
     with itself; a device that appears in six of its groups is counted once,
     because it is one phone you could take the part off. */
  function linkedDeviceCount(modelId) {
    var gids = (db.groupsByModel && db.groupsByModel[modelId]) || [];
    var seen = Object.create(null);
    seen[modelId] = 1;
    var n = 0;
    for (var i = 0; i < gids.length; i++) {
      var ids = (db.membersByGroup && db.membersByGroup[gids[i]]) || [];
      for (var j = 0; j < ids.length; j++) {
        if (!seen[ids[j]]) { seen[ids[j]] = 1; n++; }
      }
    }
    return n;
  }

  /* The selected model, as the head of the CENTRE column.

     It used to be the whole page, then a card that scrolled away with the
     results it was heading. It is now the SAME sticky header the group view
     uses — the same element, the same classes, the same behaviour — because a
     search result and an opened group are one result page in two states, and
     shipping two headers is how they drift apart.

     What it says is what the reader arrived to find out: which handset this is
     about, how many devices are linked to it, and across how many groups. All
     three are counted from the compatibility edges at the moment of render. */
  function selectedModelHTML() {
    var f = state.finder;
    var m = db.modelById[f.modelId];
    if (!m) return '';
    var gids = (db.groupsByModel && db.groupsByModel[m.id]) || [];
    var cats = (db.partCountsByCategory && db.partCountsByCategory[m.id]) || {};
    var nCats = Object.keys(cats).length;
    var linked = linkedDeviceCount(m.id);

    var meta = [
      gids.length ? nf(gids.length) + ' group' + (gids.length === 1 ? '' : 's') : null,
      nCats ? nf(nCats) + ' part ' + (nCats === 1 ? 'category' : 'categories') : null
    ].filter(Boolean).join(' · ');

    return '<div class="gbar">' +
      '<span class="gbar__grab" aria-hidden="true"></span>' +
      '<div class="gbar__row">' +
        '<button type="button" class="gback" data-act="clear-model" ' +
          'aria-label="Clear the selected model" title="Clear the selected model">' +
          icon('chevronLeft') + '<span class="gback__t">Back</span></button>' +

        '<span class="gbar__shot">' +
          SM.art.photo(m, { alt: m.fullName, eager: true, cls: 'gbar__ph' }) +
        '</span>' +

        '<span class="gbar__id">' +
          '<span class="gbar__n">' + esc(deviceTitle(m)) + '</span>' +
          '<span class="gbar__meta">' +
            '<span class="gbar__count">' + esc(deviceCountLabel(linked, 'linked')) + '</span>' +
            (meta ? '<span class="gbar__codes">' + esc(meta) + '</span>' : '') +
          '</span>' +
        '</span>' +

        '<span class="gbar__right">' +
          '<a class="btn btn--outline btn--sm gbar__specs" href="/model/' + esc(m.id) + '">' +
            icon('info') + '<span class="gbar__specst">Specs</span></a>' +
        '</span>' +
      '</div>' +
      '</div>';
  }

  function centerHeadHTML() {
    var f = state.finder;
    var searchField = function (id) {
      return '<label class="field">' + icon('search') +
        '<input class="input" id="' + id + '" placeholder="Filter groups, part codes…" ' +
        'value="' + esc(f.filters.q) + '" aria-label="Filter groups" /></label>';
    };
    /* With a model selected the head is that model plus a filter row; the
       "Compatibility groups" title and the sort control belong to the library
       view and would be describing something else here. */
    if (f.modelId) {
      /* Same section shell as the library view — the desktop filter field in
         the head, the compact filter bar below it on narrow screens. Only the
         words change, so the column behaves identically whether it is holding
         matches or the whole library.

         sec--flow, though: the library's section head sticks to the top of the
         column, and here the SELECTED MODEL is what has to stay put. Two
         elements stuck to top:0 in one scroller do not queue — they stack on
         top of each other, and the one that loses is the one the reader
         needs. */
      return selectedModelHTML() +
        '<div class="sec sec--flow"><div class="sec__head"><div class="sec__title">' +
        '<h2>Compatible parts</h2><span class="sec__count" id="gcount">…</span></div>' +
        '<div class="row wrap ws-tools" style="gap:8px">' +
        '<span class="ws-only">' + searchField('gqd') + '</span></div></div>' +
        '<div class="fbar">' +
        '<div class="field grow">' + icon('search') +
        '<input class="input" id="gq" placeholder="Filter these groups…" value="' +
        esc(f.filters.q) + '" aria-label="Filter matching groups" /></div>' +
        '<button class="btn btn--outline btn--icon fbar__btn" data-act="open-filters" aria-label="Filters">' +
        icon('filter') + (activeFilterCount() ? '<span class="dotn">' + activeFilterCount() + '</span>' : '') +
        '</button></div></div>';
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
    var pending = o.count == null;
    var aria = o.name + ' — ' + (pending ? 'counting' : nf(o.count) + ' ' + (o.count === 1 ? 'group' : 'groups'));
    return '<button type="button" class="crail__item' + (o.on ? ' is-on' : '') +
      (o.empty ? ' is-empty' : '') + '" ' +
      'data-act="' + o.act + '" data-id="' + esc(o.id) + '"' +
      (o.color ? ' style="--c:' + o.color + '"' : '') +
      (o.empty ? ' disabled' : '') +
      ' aria-pressed="' + (o.on ? 'true' : 'false') + '" aria-label="' + esc(aria) + '">' +
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
      '<span class="crail__n" aria-hidden="true">' + (pending ? '…' : nf(o.count)) + '</span>' +
      '</button>';
  }

  /* Result-page rail: same look and behaviour as the home rail, ordered by
     the priority above and annotated with this model's group counts. */
  function resultRailHTML() {
    var f = state.finder;
    var avail = f.avail;
    var total = avail ? Object.keys(avail).reduce(function (n, k) { return n + avail[k]; }, 0) : null;
    return '<div class="crail" role="group" aria-label="Part categories">' +
      railItem({ id: 'all', name: 'All Parts', count: total, on: !f.catId, act: 'pick-cat-rail' }) +
      resultCategories().map(function (c) {
        var n = avail ? (avail[c.id] || 0) : null;
        return railItem({
          id: c.id, name: c.name, count: n, color: c.color,
          on: f.catId === c.id, empty: n === 0, act: 'pick-cat-rail'
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
          id: c.id, name: c.name, count: c.groupCount, color: c.color,
          on: sel === c.id, act: 'filter-cat'
        });
      }).join('') +
      '</div>';
  }

  function opt(v, l, cur) {
    return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + esc(l) + '</option>';
  }
  function activeFilterCount() {
    var f = state.finder.filters;
    return (f.brandId !== 'all' ? 1 : 0) + (f.catId !== 'all' ? 1 : 0) + (f.sort !== 'mixed' ? 1 : 0) + (f.view && f.view !== 'both' ? 1 : 0);
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
      var on = f.catId === id;
      var n = avail ? (id === 'all' ? availTotal : (avail[id] || 0)) : count;
      var empty = !!avail && n === 0;
      var badge = pending ? '…' : nf(n);
      var aria = name + ' — ' + (pending ? 'counting' : nf(n) + ' ' + (n === 1 ? 'group' : 'groups'));
      return '<button type="button" class="ctile' + (on ? ' is-on' : '') +
        (empty ? ' is-empty' : '') + '" ' +
        'data-act="filter-cat" data-id="' + id + '" style="--c:' + color + '"' +
        (empty ? ' disabled' : '') +
        ' aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + esc(aria) + '">' +
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
        '<span class="ctile__n" aria-hidden="true">' + badge + '</span>' +
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

    return '<section class="panel panel--cats">' +
      '<div class="panel__head"><span class="t-lab">Part category</span>' +
      '<span class="row" style="gap:6px">' +
      '<span class="cols" role="group" aria-label="Category grid columns">' +
      colBtn(2) + colBtn(3) + '</span>' +
      (f.catId !== 'all'
        ? '<button class="panel__clear" data-act="filter-cat" data-id="all">' + icon('close') + 'Clear</button>'
        : '<span class="panel__n">' + db.categories.length + '</span>') +
      '</span></div>' +
      '<div class="ctiles ctiles--' + state.catCols + '">' +
      tile('all', 'All Categories', 'var(--teal-500)', 'grid', db.stats.groups) +
      db.categories.map(function (c) {
        return tile(c.id, c.name, c.color, c.icon, c.groupCount);
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
    if (reset) { f.page = 1; f.rows = []; f.cursor = null; }
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
      paintGroups();
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
          paintGroups();
        });
      } else {
        f.newModels = [];
      }
    }
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
    observeMore();
    syncRails();
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
      if (state.finder.modelId) return;
      if (entries[0].isIntersecting && state.finder.hasMore && !state.finder.busy) {
        state.finder.page++; loadGroups(false);
      }
    }, { root: wsScroller(), rootMargin: '300px' });
    io.observe(lm);
  }

  /* ------------------------------------------------ selected-model workflow */
  function loadMatches() {
    var f = state.finder;
    var modelAtCall = f.modelId;

    /* The category availability drives the rail and the left-hand counts, so
       it is fetched once per model and reused. */
    if (!f.avail) {
      api.categoryAvailability(f.modelId).then(function (rows) {
        if (state.finder.modelId !== modelAtCall) return;
        var map = Object.create(null);
        rows.forEach(function (r) { map[r.category.id] = r.count; });
        state.finder.avail = map;
        var rail = document.getElementById('catRail');
        if (rail) rail.innerHTML = railHTML();
        var panel = document.getElementById('catPanel');
        if (panel) panel.innerHTML = categoryPanelHTML();
      });
    }

    api.findMatches({ modelId: f.modelId, categoryId: f.catId || 'all' }).then(function (rows) {
      /* The centre column, the same element the group library renders into. */
      var host = document.getElementById('results');
      if (!host || state.finder.modelId !== modelAtCall) return;
      /* The browse view's infinite scroll must not keep firing underneath a
         result — it would append library groups below the matches. */
      if (io) io.disconnect();
      var lm = document.getElementById('loadmore');
      if (lm) lm.innerHTML = '';
      var m = db.modelById[f.modelId];
      var cat = f.catId ? db.categoryById[f.catId] : null;

      /* The right-hand panel and the filter box narrow this list too — a model,
         a category and a brand are three filters on one result, not three
         separate modes. */
      if (f.filters.brandId && f.filters.brandId !== 'all') {
        rows = rows.filter(function (r) { return r.master && r.master.brandId === f.filters.brandId; });
      }
      /* The same fields the group library searches, so one box means one thing
         on both sides of the switch. */
      var q = (f.filters.q || '').toLowerCase().trim();
      if (q) {
        var hasq = function (v) { return String(v == null ? '' : v).toLowerCase().indexOf(q) > -1; };
        rows = rows.filter(function (r) {
          var g = r.group;
          return hasq(g.groupNumber) || hasq(g.partCode) || hasq(g.serialNumber) ||
                 (r.category && hasq(r.category.name)) ||
                 (r.master && hasq(r.master.fullName)) ||
                 (r.devices || []).some(function (d) { return hasq(d.fullName); });
        });
      }

      if (!rows.length) {
        var cnt0 = document.getElementById('gcount');
        if (cnt0) cnt0.textContent = 'no matches';
        host.innerHTML = C.state({
          icon: 'alert', brand: true,
          title: 'No Compatibility Found',
          text: esc(m.fullName) + ' is in the database but has no ' +
            (cat ? cat.name.toLowerCase() + ' ' : '') + 'compatibility group' +
            (f.filters.brandId !== 'all' && db.brandById[f.filters.brandId]
              ? ' under ' + esc(db.brandById[f.filters.brandId].name) : '') +
            ' yet. Nothing unrelated is shown in its place — try another part category, or clear the filters.',
          action: '<div class="row" style="gap:8px"><button class="btn btn--soft" data-act="clear-cat">' + icon('layers') + 'Try all categories</button>' +
            '<button class="btn btn--outline" data-act="clear-model">' + icon('grid') + 'Browse all groups</button></div>'
        });
        return;
      }

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
      var cnt = document.getElementById('gcount');
      if (cnt) cnt.textContent = rows.length === 1 ? '1 match' : rows.length + ' matches';
      var head =
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
            SM.art.category(c.id, 'pthumb--head', c.name) +
            '<span class="catgroup__name">' + esc(c.name) + '</span>' +
            '<span class="catgroup__n">' + n + (n === 1 ? ' group' : ' groups') + '</span>' +
            '</div>';
        }
        return heading + matchCard(row, m);
      }).join('');

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

  function matchCard(row, hitModel) {
    var g = row.group, cat = row.category, master = row.master;
    /* Null means the member list is not in the catalogue at all — a different
       thing from a group that genuinely has one member. */
    var preview = row.devices ? row.devices.slice(0, 8) : [];

    return '<div class="match" style="margin-bottom:14px">' +
      '<div class="match__head">' +
      '<span class="match__badge">' + icon('checkCircle') + 'Match found</span>' +
      '<span class="pill pill--code">' + esc(g.groupNumber) + '</span>' +
      '<span class="pill" style="background:' + cat.color + '18;color:' + cat.color + '">' + icon(cat.icon) + esc(cat.name) + '</span>' +
      '<button class="btn btn--ghost btn--sm" style="margin-left:auto" data-act="open-group" data-id="' + g.groupId + '">' +
      'Open group ' + icon('arrowRight') + '</button>' +
      '</div>' +
      '<div class="match__body">' +
      '<div class="stack" style="gap:14px">' +
      C.masterCard(master, cat) +
      C.idGrid(g) +
      '</div>' +
      '<div class="stack" style="gap:12px">' +
      '<div class="complist__head">' +
      '<span class="t-lab">Compatible devices</span>' +
      '<span class="pill pill--brand">' + g.compatibleCount + ' total</span>' +
      (master.id !== hitModel.id ? '<span class="pill pill--ok">' + icon('check') + esc(hitModel.modelName) + ' included</span>' : '') +
      '</div>' +
      /* The same chip the group view is built from, so a device reads
         identically whether it is previewed in a match card or listed in the
         group that card opens. Eight of them: too few to be worth splitting by
         brand, which is why this is the plain grid rather than the blocks. */
      chipGridHTML(preview, { masterId: master.id, hitId: hitModel.id, act: 'open-model' }) +
      (g.compatibleCount > preview.length
        ? '<button class="expandbtn" data-act="open-group" data-id="' + g.groupId + '">' +
          icon('layers') + 'View all ' + g.compatibleCount + ' compatible models</button>'
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
      '<span><b>Free for everyone.</b> The full model database — brands, models, ' +
      'specifications and every compatibility group — is open to use.</span></div>' +
      '<div id="modelsBody"></div></div>';

    if (!brandId) renderBrandGrid();
    else renderBrandModels(brandId);
  }

  function renderBrandGrid() {
    document.getElementById('modelsBody').innerHTML =
      '<div class="sec" style="margin-top:0"><div class="sec__head"><div class="sec__title">' +
      '<h1>All mobile models</h1><span class="sec__count">' + nf(db.stats.models) + ' models · ' + db.stats.brandsWithModels + ' brands</span>' +
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
      /* A real href, not a button with a click handler. The delegated
         listener in the router intercepts it and navigates without a reload,
         so the behaviour is identical — but a crawler can follow it and a
         person can middle-click it. Every model page on this site was
         unreachable except through the sitemap because these were buttons. */
      return '<a class="dcard" href="/model/' + esc(m.id) + '">' +
        '<span class="dcard__shot">' + SM.art.device(m, 0) + '</span>' +
        '<span class="dcard__b">' +
          '<span class="dcard__n">' + esc(m.modelName) + '</span>' +
          '<span class="dcard__m">' + m.displaySize + '&Prime; · ' + m.releaseYear + '</span>' +
          '<span class="dcard__t">' +
            (m.screenCurve
            ? '<span class="tag tag--' + esc(m.screenCurve) + '">' + esc(m.screenCurve) + '</span>'
            : '') +
            (gc ? '<span class="tag">' + gc + ' part' + (gc === 1 ? '' : 's') + '</span>' : '') +
          '</span>' +
        '</span></a>';
    }).join('') + '</div>';
  }

  function deviceListHTML(items) {
    return '<div class="dlist">' + items.map(function (m) {
      var sp = m.specs || {};
      var gc = groupCountOf(m);
      return '<a class="drow" href="/model/' + esc(m.id) + '">' +
        '<span class="drow__shot">' + SM.art.device(m, 0) + '</span>' +
        '<span class="drow__main">' +
          '<span class="drow__n">' + esc(m.fullName) + '</span>' +
          /* Built from what is actually recorded. chipset is null for every
             device in this catalogue and screenType for most, so the fixed
             " · null · " separators left the row reading "6.4″  ·  · 0 mAh". */
          '<span class="drow__m">' +
            [ m.displaySize ? esc(m.displaySize) + '&Prime;' : null,
              m.screenType ? esc(m.screenType) : null,
              sp.chipset ? esc(sp.chipset) : null,
              sp.batteryMah ? nf(sp.batteryMah) + ' mAh' : null
            ].filter(Boolean).join(' · ') + '</span>' +
        '</span>' +
        '<span class="drow__side">' +
          (m.screenCurve
            ? '<span class="tag tag--' + esc(m.screenCurve) + '">' + esc(m.screenCurve) + '</span>'
            : '') +
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
      /* One hyphen for anything not recorded. Every column had its own idea of
         what an absent value looks like: an em-dash here, "undefined&Prime;"
         where displaySize was null, an empty tag element for screen curve, and
         a bare " GB" for RAM and storage the catalogue has never carried. */
      var dash = '<span class="c-none">-</span>';
      var cell = {
        device: '<a class="tcell-dev" href="/model/' + esc(m.id) + '">' +
                SM.art.device(m, 0, 'dvc--xs') +
                '<span>' + esc(m.modelName) + '</span></a>',
        size: m.displaySize ? esc(m.displaySize) + '&Prime;' : dash,
        curve: m.screenCurve
          ? '<span class="tag tag--' + esc(m.screenCurve) + '">' + esc(m.screenCurve) + '</span>'
          : dash,
        year: m.releaseYear ? esc(String(m.releaseYear)) : dash,
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
      /* The exports record a screen type for 260 of 4,933 devices, so this
         filter works — over what is RECORDED. "Flat only" showing 229 phones
         does not mean the brand made 229 flat phones, and the labels say so
         rather than letting the count imply it. */
      (dbHas('screenCurve') ? selectHTML('curve', 'Screen', f.curve, [
        ['', 'Any screen'], ['flat', 'Flat (recorded)'], ['curved', 'Curved (recorded)']]) : '') +
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
    if (!b) { go('/models'); return; }
    var m = state.models;
    var c = b.counts || {};

    /* Devices with no release date produce a null year, and it was reaching the
       dropdown as an option literally reading "null". */
    var years = Array.from(new Set(db.models
      .filter(function (x) { return x.brandId === brandId; })
      .map(function (x) { return x.releaseYear; })
      .filter(function (y) { return y != null; }))).sort(function (x, y) { return y - x; });

    document.getElementById('modelsBody').innerHTML =
      '<div class="crumbs" style="margin-bottom:14px">' +
      '<button data-act="nav" data-href="/models">All brands</button>' + icon('chevronRight') +
      '<span style="color:var(--ink)">' + esc(b.name) + '</span></div>' +

      '<div class="bhead" style="--b1:' + b.color + '">' +
        '<div class="bhead__id">' +
          SM.brandLogo(b, 'blogo--lg') +
          '<div>' +
            /* The page's H1: on /models/apple the brand IS the subject of the
               page. It was an h2 only because it sits inside a section header,
               which left the route with no H1 at all once the app mounted over
               the pre-rendered one. */
            '<h1 class="bhead__n">' + esc(b.name) + '</h1>' +
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
      .map(function (x) { return x.releaseYear; })
      .filter(function (y) { return y != null; }))).sort(function (x, y) { return y - x; });
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
        '<span><b>Your plan has expired.</b> Renew to carry on supporting the ' +
        'catalogue — everything in the app keeps working either way.</span></div>' : '') +
      '<div class="plans">' + SM.PLANS.map(function (p) {
        return C.planCard(p, { current: s.status === 'pro' && s.plan === p.id });
      }).join('') + '</div>' +

      '<div class="sec"><div class="sec__head"><div class="sec__title"><h2>What a plan changes</h2></div></div>' +
      '<div class="idgrid" style="grid-template-columns:repeat(1,minmax(0,1fr))">' +
      cmp('Browse all mobile models & specs', 'Free', 'Free') +
      cmp('Browse the compatibility group library', 'Free', 'Free') +
      cmp('Match a model to its group', 'Free', 'Free') +
      cmp('Full compatible-device list', 'Free', 'Free') +
      cmp('Part code, serial & group number', 'Free', 'Free') +
      '</div></div>' +

      /* Says what is actually true. The table above claimed four locks that
         the app no longer has, and a plan page that describes a paywall the
         product does not enforce is the one page that must not. */
      '<div class="notice" style="margin:18px 0 8px">' + icon('info') +
      '<span><b>The whole catalogue is currently open.</b> Every compatibility ' +
      'group, part code and fitment list is free to use while Mobile Parts Finder ' +
      'is being built out. A plan supports that work and keeps your account ' +
      'ready for the staff logins and part-code export that are next.</span></div>' +
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

    identityReady = SM.fb.loadConfig().then(function (cfg) {
      /* Firebase is genuinely unavailable — no config, no sign-in, nobody to
         resolve. Not an error: the catalogue works without it. */
      if (!cfg) {
        SM.debug.log('boot', 'firebase not configured — no identity to resolve');
        return null;
      }
      return SM.fb.whenResolved().then(function (fbUser) {
        SM.debug.log('boot', 'auth resolved', { signedIn: !!fbUser, uid: fbUser ? fbUser.uid : null });
        if (!fbUser) return null;
        return S.initializeAuthenticatedUser(fbUser);
      });
    }).catch(function (err) {
      SM.debug.warn('boot', 'identity resolution failed', { message: err && err.message });
      return null;
    }).then(function (r) {
      identitySettled = true;
      return r;
    });

    return identityReady;
  }

  /* Shown while Firebase is still answering. It is deliberately NOT the
     sign-in form: 'still loading' and 'signed out' are different states, and
     painting the second while the first is true is what a returning user reads
     as "it sent me back to the login page". That is the whole mobile bug —
     most visible on the way back from Google, where the session arrives a
     moment after the page does. */
  function authPendingHTML() {
    return '<div class="acct"><div class="card card--pad">' +
      '<div class="authwait">' + icon('refresh') +
      '<div class="grow" style="min-width:0">' +
      '<h2 class="t-h1">Finishing sign-in…</h2>' +
      '<p class="t-sub" style="margin-top:4px">Checking your Google account.</p>' +
      '</div></div></div></div>';
  }

  function renderAccount(page) {
    var s = S.get();

    /* Nothing decides anything while identity is unresolved. resolveIdentity()
       covers both halves — Firebase answering, and the profile being read —
       because a user who is authenticated but whose profile has not loaded yet
       is still not a user the account screen can draw. */
    if (s.status === 'guest' && identityPending()) {
      page.innerHTML = '<div class="shell" style="padding-top:20px">' + authPendingHTML() + '</div>';
      resolveIdentity().then(function () {
        /* Only if the user is still looking at this screen. */
        if (state.route.name === 'account') renderAccount(document.getElementById('page'));
      });
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
          ? '<button class="btn btn--primary btn--lg btn--block" data-act="finish-signup"' +
            (ready ? '' : ' disabled') + '>' + icon('check') +
            'Continue as ' + esc(acct.email) + '</button>'
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
    if (!missing.length) return icon('checkCircle') + ' All details complete — pick your Google account to finish.';
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
    if (!SM.fb || !SM.fb.isOwner || !SM.fb.isOwner()) return '';
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
  function freeIncluded() { return [
    'Browse all ' + nf(db.stats.models) + ' phone models and their specs',
    'Browse every compatibility group in the catalogue',
    'Search by model, part code or group number',
    /* These four moved up from PRO_ONLY when the catalogue was opened. They
       are shown to everyone now, signed in or not, so listing them with a
       padlock would be the account screen describing a lock the app does not
       have. */
    'Match a model to its compatibility group',
    'Full compatible-device list for every group',
    'Part code, serial number and group number',
    'Group sheets you can show a customer'
  ]; }
  /* Nothing is plan-only at present. The list is kept rather than deleted
     because the split still exists everywhere else — the rules, the paid
     collections and /api/device-parts — and narrowing the catalogue again is a
     matter of putting entries back here. */
  var PRO_ONLY = [];

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
      '<button class="btn btn--outline btn--sm" data-act="nav" data-href="/plans">' + icon('crown') + 'Change plan</button>' +
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
      'Nothing has been taken away — the catalogue, the fitment lists and the ' +
      'part codes are all still open. Renew whenever you want to.</span></div>' +

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

    api.getModel(id).then(function (r) {
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

  function renderSheet() {
    var host = document.getElementById('overlay');
    var s = state.sheet;
    if (!s) { host.innerHTML = ''; document.body.style.overflow = ''; return; }
    document.body.style.overflow = 'hidden';

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
    if (!acc) return denySearch({ needsSignIn: false });

    acc.consumeSearch().then(function (r) {
      if (r.allowed) { runPickModel(id, opts); renderShellBits(); return; }
      denySearch(r);
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

  function denySearch(r) {
    closeSuggest();
    renderShellBits();

    if (r && r.needsSignIn) {
      /* Come back to the Finder once they are in, so signing in finishes the
         thing they were trying to do rather than stranding them on Account. */
      state.afterSignIn = '/finder';
      authMode = 'signin';
      toast('Sign in to search', 'lock');
      go('/account');
      return;
    }
    toast('Daily free searches used', 'lock');
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
    /* A category carried in from "find with category" on the device page;
       null for an ordinary search, which is the old behaviour. Set AFTER the
       reset below it used to sit above, or the reset wiped it. */
    state.finder.catId = opts.catId || null;
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
    var sc = wsScroller();
    if (sc) sc.scrollTop = 0;
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
  /* sheets that live in memory rather than in the URL */
  var LOCAL_SHEETS = ['filters', 'country', 'editprofile', 'install', 'share'];

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
         search box makes, so this counts against a free account's daily
         searches exactly as typing the name would — a second route to the
         answer must not be a way around the meter. */
      case 'find-parts': pickModel(id); break;
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
        break;
      case 'clear-cat':
        setCategory('all');
        renderWorkspace();
        break;
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
      case 'open-group': go('/group/' + id); break;

      /* Picking a device inside an open group changes the right panel and
         nothing else. No navigation, no overlay. */
      case 'pick-device':
        state.finder.detailModelId = id;
        repaintGroupDetail();
        revealDetailOnPhone();
        break;

      /* The mobile sheet's way back from a device's specifications to the list
         it was picked from. */
      case 'back-to-list': backToDeviceList(); break;

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
      /* One path for all three selectors. Picking a colour, a RAM, a storage
         or a thumbnail changes the same handful of things — which photograph
         is shown, what the price says, which chips are lit — so they share a
         repaint instead of each re-rendering the page underneath the reader. */
      case 'dev-colour':
      case 'dev-shot':
      case 'pick-variant': {
        /* The same three controls serve the model page and the group panel.
           Which device they are describing differs, so the device is resolved
           from whichever view is open rather than from state.deviceId alone —
           that field trails a group opened straight from a link. */
        var dm = state.finder.groupId ? detailModel() : db.modelById[state.deviceId];
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

        if (state.finder.groupId) repaintGroupDetail();
        else repaintDevice(dm);
        break;
      }
      case 'open-model': go('/model/' + id); break;
      /* Both of these used to set state.finder.modelId and navigate, which ran
         a model search without going anywhere near the daily counter — an
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
      case 'open-brand': go('/models/' + id); break;
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
          state.sheet = null; renderSheet();
          /* A number valid for one country is not valid for the next, so the
             whole form is redrawn rather than just the flag. */
          repaintAuth();
          syncRegCta();
        }
        break;

      case 'google-signin': startGoogle(false); break;
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
  var gqTimer = null, mqTimer = null, bqTimer = null, gdqTimer = null;
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
    /* Narrowing the devices ALREADY on screen inside an open group. Not the
       same thing as the paid group search above: this filters a list the
       reader has already been shown, and asks the server nothing. */
    if (el.id === 'gdq' || el.id === 'gdqm') {
      clearTimeout(gdqTimer);
      gdqTimer = setTimeout(function () {
        state.finder.groupQ = el.value;
        state.finder.groupShown = 400;
        var gtwin = document.getElementById(el.id === 'gdq' ? 'gdqm' : 'gdq');
        if (gtwin && gtwin.value !== el.value) gtwin.value = el.value;
        repaintGroupList();
      }, 180);
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

  function startGoogle(isSignup) {
    authMsg('');
    var btn = document.querySelector('.gbtn');
    if (btn) { btn.classList.add('is-busy'); btn.disabled = true; }
    SM.debug.log('auth', 'Continue with Google pressed', { signup: !!isSignup });
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
      /* The page is navigating to Google; leave the button as it is rather
         than flashing an error the user will never finish reading. */
      if (err && err.code === 'redirecting') {
        SM.debug.log('auth', 'redirecting to Google — result arrives on the next page load');
        return;
      }
      if (err && err.code === 'cancelled') { toast('Sign-in cancelled'); return; }
      SM.debug.warn('auth', 'sign-in rejected', { code: err && err.code, message: err && err.message });
      authMsg(esc(err && err.message ? err.message : 'Google sign-in failed. Try again.'));
    });
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

        repaintAuth();
        renderAccount(document.getElementById('page'));
        authMsg('That Google account has no shop profile yet. Fill in your shop details below to finish creating it.');
        return;
      }
      /* Cleared HERE, not before the write — a failed save keeps the identity
         so the same details can be resubmitted. */
      state.pendingIdentity = null;
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
      if (err && err.code === 'profile-save-failed') {
        state.pendingIdentity = identity;
        authMsg('Your details could not be saved to your account, so it has not been created. ' +
                'Check the connection and press Create account again.' +
                (err.reasons && err.reasons.length
                  ? ' <span class="muted">(' + esc(err.reasons.join('; ')) + ')</span>'
                  : ''));
        toast('Account not created — nothing was saved', 'alert');
        return;
      }
      if (err && err.code === 'profile-unreadable') {
        authMsg('Signed in, but your account could not be read from the server. ' +
                'Check the connection and try again — your details are safe, and ' +
                'nothing needs re-entering.');
        toast('Could not load your account — try again', 'alert');
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
    /* The gate is per page load, and a sign-in is a new answer to the question
       it caches — so it is rebuilt rather than reused. */
    identityReady = null;
    identitySettled = false;

    /* Normally the SDK has already published the new user by the time the
       popup promise resolves. Not assumed: if it has not, wait for it rather
       than resolving identity against a null and concluding "new account". */
    var who = SM.fb.user() ? Promise.resolve(SM.fb.user()) : SM.fb.whenResolved();

    return who.then(function (fbUser) {
      return S.initializeAuthenticatedUser(fbUser);
    }).then(function (r) {
      /* Re-armed on BOTH paths. Leaving it false after a failure would strand
         the account screen on "Finishing sign-in…" for the rest of the page's
         life, waiting for an answer that has already come back. */
      identitySettled = true;
      identityReady = Promise.resolve(r);

      /* Firestore could not be read — offline, blocked, rules in flight. That
         is NOT the same as "this account has no profile", and treating it as
         one shows the sign-up form to a shop that already has an account and
         invites it to enter everything a second time. Refuse to guess. */
      if (r && r.offline) {
        var offline = new Error('profile-unreadable');
        offline.code = 'profile-unreadable';
        throw offline;
      }

      if (!r || !r.complete) {
        return { needsRegistration: true, identity: identity, existing: (r && r.profile) || null };
      }
      /* Access comes from the server, never from the cache this browser holds. */
      return S.syncFromServer().then(function () {
        return { session: S.get(), isNew: !!(r && r.isNew) };
      });
    }, function (err) {
      identitySettled = true;
      identityReady = Promise.resolve(null);
      throw err;
    });
  }

  /* ----------------------------------------------------------------- boot */
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

      /* A signed-in account with no usable profile has to finish signing up —
         but only once the server has actually said so. A profile that merely
         has not loaded yet is not a missing profile. */
      if (!r.complete && !r.offline) {
        var u = SM.fb.user();
        authMode = 'signup';
        state.pendingIdentity = {
          sub: u ? u.uid : (r.profile && r.profile.uid) || '',
          email: (u && u.email) || (r.profile && r.profile.email) || '',
          name: (u && u.displayName) || '',
          picture: (u && u.photoURL) || ''
        };
        /* Prefill from whatever the record already holds, so a shop that has
           entered two of the three details is not asked for all three again.
           Nothing is invented — an absent field stays absent. */
        var p = r.profile || {};
        reg.shopName = reg.shopName || p.mobileShopName || p.shopName || '';
        reg.proprietor = reg.proprietor || p.proprietorName || p.proprietor || '';
        reg.mobile = reg.mobile || p.mobileNumber || p.mobile || '';
        if (p.countryCode) reg.country = p.countryCode;

        SM.debug.log('boot', 'profile incomplete — asking for the missing details', {
          has: { shop: !!reg.shopName, proprietor: !!reg.proprietor, mobile: !!reg.mobile }
        });
        if (state.route.name === 'account') renderAccount(document.getElementById('page'));
      } else if (r.complete) {
        /* Pull the SERVER's record of access in. The account screen must show
           the subscription the server believes in, not the one this browser
           last cached. */
        S.syncFromServer().then(function () {
          renderShellBits();
          if (state.route.name === 'account') renderAccount(document.getElementById('page'));
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
