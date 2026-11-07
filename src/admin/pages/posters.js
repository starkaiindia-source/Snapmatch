/* ============================================================================
   Mobile Parts Finder · admin/pages/posters.js
   ----------------------------------------------------------------------------
   Posters: three posts a day on each Instagram account, and how they did.
   Three tabs, the accounts as two small icons beside them:

     /admin/posters             Posters: the account's bio, the next post with
                                a countdown, the scheduled posts large, the
                                days after them as they will be planned, the
                                grid as it will look, and groups to suggest
     /admin/posters/templates   Templates: every design, colour and marketing
                                template, and the order of the grid's colours
     /admin/posters/analytics   Analytics: followers and their growth, which
                                posts brought followers, top posts, what works
                                and every post's numbers
     /admin/posters/create      one poster by hand (pages/content.js)

   A day is one row of the grid: a carousel on the left, the marketing poster
   in the middle, a single poster on the right, all in that day's colour.
   Reels are not part of the poster grid and are left out of it here.

   Nothing posts from here without a press and a confirm: "Post now" on one
   slot, or auto posting, which the owner switches on per account.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, ADM = SM.adm, ui = ADM.ui;

  var ACCOUNTS = [
    { id: 'proglide', label: 'ProGlide', sub: 'App', color: '#5B2EE8' },
    { id: 'mpf', label: 'Mobile Parts Finder', sub: 'Website', color: '#0E9F84' }
  ];
  var PARTS = {
    'screen-guards': 'Tempered glass', 'back-cover': 'Back cover', 'combo-display': 'Combo display', 'middle-frame': 'Middle frame',
    'cc-board': 'CC board', battery: 'Battery', 'button-flex': 'Button flex', 'sim-tray': 'SIM tray'
  };
  var KIND = { single: 'Single', carousel: 'Carousel', promo: 'Marketing', combo: 'All parts', reel: 'Reel' };
  var STATUS = { planned: ['Planned', 'info'], posting: ['Posting', 'warn'], posted: ['Posted', 'ok'], failed: ['Failed', 'bad'],
    missed: ['Missed', 'bad'], skipped: ['Skipped', ''], open: ['Not planned', ''], next: ['Coming', ''] };
  var SWATCH = { royal: '#5B2EE8', sunset: '#FF5A1F', mint: '#0E9F84', berry: '#D6246E', ocean: '#0069B4', noir: '#1E1E2E' };
  /* left to right in a row of the grid, as Instagram shows it */
  var ROW_ORDER = { carousel: 0, promo: 1, single: 2, combo: 2 };
  var COL_ORDER = { left: 0, middle: 1, right: 2 };
  var KEY = 'adm.posters.account';
  var PICS = 'adm.posters.pics';

  function remembered() {
    try { var v = global.localStorage.getItem(KEY); return v === 'mpf' ? 'mpf' : 'proglide'; } catch (e) { return 'proglide'; }
  }
  function remember(v) { try { global.localStorage.setItem(KEY, v); } catch (e) { /* the page works without it */ } }
  /* the accounts' profile pictures, for the two icons; kept for the next visit */
  var profilePics = (function () { try { return JSON.parse(global.localStorage.getItem(PICS) || '{}') || {}; } catch (e) { return {}; } })();
  function keepPic(account, url) {
    if (!url || profilePics[account] === url) return;
    profilePics[account] = url;
    try { global.localStorage.setItem(PICS, JSON.stringify(profilePics)); } catch (e) { /* fine */ }
  }

  /* ------------------------------------------------------------ pictures
     Posters are drawn on the server, one JPEG a request, so they load a few
     at a time, one after another, and are kept for the visit. */
  var pics = { cache: {}, queue: [], busy: 0 };
  function picKey(p) { return [p.group, p.kind, p.slide || 0, p.design || '', p.palette || '', p.brand || '', p.template || '', p.keyword || '', p.also || '', p.cta || ''].join('|'); }
  function picture(params) {
    var key = picKey(params);
    if (pics.cache[key]) return pics.cache[key];
    pics.cache[key] = new Promise(function (resolve, reject) { pics.queue.push({ params: params, resolve: resolve, reject: reject }); pump(); });
    pics.cache[key].catch(function () { delete pics.cache[key]; });
    return pics.cache[key];
  }
  function pump() {
    while (pics.busy < 2 && pics.queue.length) {
      var job = pics.queue.shift();
      pics.busy++;
      ADM.api.poster(job.params).then(function (r) { return URL.createObjectURL(r.blob); }).then(job.resolve, job.reject)
        .then(function () { pics.busy--; pump(); }, function () { pics.busy--; pump(); });
    }
  }
  /* every [data-pic] in a host gets its picture when it nears the screen */
  function fill(host) {
    var els = host.querySelectorAll('[data-pic]:not([data-done])');
    var load = function (el) {
      el.setAttribute('data-done', '1');
      var p;
      try { p = JSON.parse(el.getAttribute('data-pic')); } catch (e) { return; }
      picture(p).then(function (url) {
        el.style.backgroundImage = 'url("' + url + '")';
        el.classList.add('is-loaded');
      }, function () { el.classList.add('is-error'); });
    };
    if (!('IntersectionObserver' in global)) { Array.prototype.forEach.call(els, load); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { io.unobserve(en.target); load(en.target); } });
    }, { rootMargin: '300px' });
    Array.prototype.forEach.call(els, function (el) { io.observe(el); });
  }
  function picAttr(p) { return " data-pic='" + ui.esc(JSON.stringify(p)) + "'"; }
  function slotPic(s, account) {
    return { group: s.groupId, kind: s.kind, slide: 0, design: s.design || '', palette: s.palette || '', brand: account, template: s.template || '', keyword: s.keyword || '',
      also: (s.also || []).join('.'), cta: s.cta || '' };
  }

  /* --------------------------------------------------------------- bits */
  var n = function (v) { return v == null ? '—' : Number(v).toLocaleString('en-IN'); };
  var short = function (v) { v = Number(v) || 0; return v >= 100000 ? (v / 1000).toFixed(0) + 'K' : v >= 10000 ? (v / 1000).toFixed(1) + 'K' : v.toLocaleString('en-IN'); };
  var chip = function (text, tone) { return '<span class="pz-chip' + (tone ? ' pz-chip--' + tone : '') + '">' + ui.esc(text) + '</span>'; };
  var accountOf = function (id) { return ACCOUNTS.filter(function (x) { return x.id === id; })[0]; };
  function dayLabel(t) {
    var d = new Date(t), today = new Date();
    var a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), b = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    var diff = Math.round((a - b) / 864e5);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function timeOf(t) { return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
  function inTime(t) {
    var m = Math.round((t - Date.now()) / 60000);
    if (m < 1) return 'now';
    if (m < 60) return 'in ' + m + ' min';
    var h = Math.floor(m / 60);
    return h < 24 ? 'in ' + h + ' h ' + (m % 60) + ' min' : 'in ' + Math.floor(h / 24) + ' d ' + (h % 24) + ' h';
  }
  /* 2 d 04:12:09, ticking */
  function countdown(t) {
    var s = Math.max(0, Math.floor((t - Date.now()) / 1000));
    var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    var two = function (v) { return (v < 10 ? '0' : '') + v; };
    return (d ? d + ' d ' : '') + two(h) + ':' + two(m) + ':' + two(x);
  }
  var ICON = {
    grid: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    ig: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/></svg>',
    chart: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    image: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    link: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
    carousel: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 3h12a2 2 0 0 1 2 2v12h-2V5H7z"/><rect x="3" y="7" width="14" height="14" rx="2"/></svg>'
  };

  /* the live server answers "unknown view" until this page's server code is deployed */
  function notYet(err) {
    var m = (err && err.message) || 'request failed';
    return /unknown view/i.test(m) ? 'The server does not have this yet. It arrives with the next deploy.' : m;
  }

  /* ------------------------------------------------------- the top bar
     Posters, Templates, Analytics; the two accounts as icons, the chosen one
     ringed; and Create a poster. */
  var TABS = [['posters', 'Posters', '/admin/posters', ICON.image], ['templates', 'Templates', '/admin/posters/templates', ICON.grid], ['analytics', 'Analytics', '/admin/posters/analytics', ICON.chart]];
  function hub(tab, account) {
    return '<div class="pz-hub"><nav class="pz-tabs" aria-label="Posters">' + TABS.map(function (t) {
      return '<a href="' + t[2] + '" data-go class="pz-tab' + (t[0] === tab ? ' is-on' : '') + '"' + (t[0] === tab ? ' aria-current="page"' : '') + '>' + t[3] + '<span>' + t[1] + '</span></a>';
    }).join('') + '</nav><div class="pz-hub__right"><div class="pz-icons" role="group" aria-label="Instagram account">' + ACCOUNTS.map(function (x) {
      var on = account === x.id;
      var pic = profilePics[x.id] ? '<img src="' + ui.esc(profilePics[x.id]) + '" alt="">' : '<b style="background:' + x.color + '">' + x.label.charAt(0) + '</b>';
      return '<button class="pz-icon' + (on ? ' is-on' : '') + '" data-account="' + x.id + '" title="' + ui.esc(x.label) + '" aria-pressed="' + on + '"><span class="pz-icon__ring">' + pic + '</span><span class="pz-icon__name">' + ui.esc(x.label) + '</span></button>';
    }).join('') + '</div><a class="adm__btn adm__btn--primary" href="/admin/posters/create" data-go>' + ICON.plus + '<span>Create a poster</span></a></div></div>';
  }

  /* the account's Instagram head: picture, name, numbers and bio */
  function bio(ins, account, extra) {
    var x = accountOf(account);
    var p = ins && ins.profile;
    var pic = p && p.picture ? '<img src="' + ui.esc(p.picture) + '" alt="">' : '<b style="background:' + x.color + '">' + x.label.charAt(0) + '</b>';
    if (!ins) return '<div class="pz-bio"><span class="pz-bio__pic adm__skel"></span><div class="pz-bio__txt"><div class="adm__skel" style="height:18px;width:200px"></div><div class="adm__skel" style="height:44px;margin-top:10px"></div></div>' + (extra || '') + '</div>';
    var stat = function (v, l) { return '<span><b>' + (v == null ? '—' : short(v)) + '</b> ' + l + '</span>'; };
    var site = p && p.website ? '<a href="' + ui.esc(p.website) + '" target="_blank" rel="noopener">' + ICON.link + ui.esc(String(p.website).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')) + '</a>' : '';
    return '<div class="pz-bio"><span class="pz-bio__pic">' + pic + '</span><div class="pz-bio__txt">' +
      '<div class="pz-bio__name"><b>' + ui.esc((p && p.username) || x.label) + '</b>' + (p && p.name ? '<span>' + ui.esc(p.name) + '</span>' : '') + '</div>' +
      '<div class="pz-bio__stats">' + stat(p && p.posts, 'posts') + stat(p && p.followers, 'followers') + stat(p && p.following, 'following') + '</div>' +
      (p && p.bio ? '<p class="pz-bio__bio">' + ui.esc(p.bio) + '</p>' : '') + site + '</div>' + (extra || '') + '</div>';
  }

  /* insights are read once a visit per account, and shared by the tabs */
  var insCache = {};
  function readInsights(account, fresh) {
    if (!fresh && insCache[account]) return insCache[account];
    insCache[account] = ADM.api.content({ view: 'insights', account: account, fresh: fresh ? '1' : undefined }).then(function (r) {
      if (r && r.profile) keepPic(account, r.profile.picture);
      return r;
    });
    insCache[account].catch(function () { delete insCache[account]; });
    return insCache[account];
  }

  /* ============================================================== posters */
  function board(host, ctx) {
    var state = { account: remembered(), board: null, boardErr: null, ins: null, insErr: null, accounts: null, open: null, busy: false };
    var root = document.createElement('div');
    root.className = 'pz';
    host.appendChild(root);

    function paint() {
      root.innerHTML = hub('posters', state.account) + top() + nextPost() +
        section('Scheduled posts', 'The week, planned at once: nine posts a day, three rows. A row is one phone in one colour: its carousel, its biggest other part, then its other parts or marketing. Posted right first, left last.', scheduled(), planButton()) +
        section('Posting hours', 'When this account\'s followers are online, in India time. The coloured bars are the hours it posts in.', hours()) +
        section('Your grid', 'How the profile will look, newest top-left, three a row. Reels are not part of the poster grid.', grid()) +
        section('Suggest', 'More groups people want, in the colours they would take. Put one in a slot, or open it in the editor.', suggest()) +
        drawer();
      fill(root);
      tick();
    }

    function section(title, sub, body, act) {
      return '<section class="pz-sec"><div class="pz-sec__head"><div><h2>' + title + '</h2><p>' + sub + '</p></div>' + (act || '') + '</div>' + body + '</section>';
    }

    function top() {
      var b = state.board, ins = state.ins;
      var info = state.accounts && (state.accounts.accounts || []).filter(function (a) { return a.id === state.account; })[0];
      var hl = '<div class="pz-hl">' +
        '<div><span>Usual reach</span><b>' + (ins ? n(ins.usual.reach) : '—') + '</b></div>' +
        '<div><span>Saved by</span><b>' + (ins ? ins.usual.saveRate + '%' : '—') + '</b></div>' +
        (b ? '<label class="pz-switch"><input type="checkbox" data-auto' + (b.auto ? ' checked' : '') + (state.busy ? ' disabled' : '') + '><i></i><span><b>Auto posting ' + (b.auto ? 'on' : 'off') + '</b><small>' +
          (b.auto ? 'Posts go live by themselves.' : 'Nothing posts until you switch it on.') + '</small></span></label>' : '') + '</div>';
      return bio(ins, state.account, hl) +
        (state.accounts && state.accounts.configured === false ? ui.banner('bad', '<b>Posting is off.</b> INSTAGRAM_PUBLISH_ACCESS_TOKEN is not set in Vercel.') : '') +
        (info && !info.canPublish ? ui.banner('warn', '<b>This account cannot post right now.</b> Instagram did not accept the posting token for it.') : '') +
        (state.insErr ? ui.banner('warn', '<b>Instagram numbers could not be read.</b> ' + ui.esc(state.insErr)) : '') +
        (state.boardErr ? ui.banner('bad', '<b>The schedule could not load.</b> ' + ui.esc(state.boardErr)) : '');
    }

    function nextSlot() {
      var b = state.board;
      if (!b) return null;
      return b.slots.filter(function (s) { return (s.status === 'planned' || s.status === 'posting') && s.at > Date.now() - 60000; }).sort(function (x, y) { return x.at - y.at; })[0] || null;
    }

    /* one compact row: the next post, and the time left to it, ticking */
    function nextPost() {
      var b = state.board;
      if (!b) return '<div class="pz-next adm__skel" style="height:96px"></div>';
      var s = nextSlot();
      if (!s) {
        var open = b.slots.filter(function (x) { return x.status === 'open' && x.at > Date.now(); }).sort(function (x, y) { return x.at - y.at; })[0];
        return '<div class="pz-next"><span class="pz-next__pic is-empty">' + ICON.clock + '</span><div class="pz-next__txt"><span class="pz-next__lbl">Next post</span><b>Nothing planned yet</b><small>' +
          (open ? 'The next slot is ' + dayLabel(open.at) + ', ' + timeOf(open.at) + '. Plan it to see the poster here.' : 'Plan the week to see the next poster here.') + '</small></div>' + planButton() + '</div>';
      }
      var title = s.kind === 'promo' ? 'Marketing poster' : (PARTS[s.categoryId] || 'Poster') + ' · ' + (s.master || '');
      return '<div class="pz-next"><button class="pz-next__pic" data-slot="' + s.id + '"' + picAttr(slotPic(s, state.account)) + '></button>' +
        '<div class="pz-next__txt"><span class="pz-next__lbl">Next post</span><b>' + ui.esc(title) + '</b><small>' + KIND[s.kind] + ' · ' + dayLabel(s.at) + ', ' + timeOf(s.at) +
        (s.keyword ? ' · asks for "' + ui.esc(s.keyword) + '"' : '') + '</small></div>' +
        '<div class="pz-next__clock"><span>' + (b.auto ? 'Goes live in' : 'Due in') + '</span><b data-countdown="' + s.at + '">' + countdown(s.at) + '</b>' +
        (b.auto ? '' : '<small>Auto posting is off: it waits for you</small>') + '</div>' +
        '<div class="pz-next__act"><button class="adm__btn adm__btn--sm" data-slot="' + s.id + '">Open</button></div></div>';
    }

    /* rows, oldest first; each row's posts left to right as the grid shows them */
    function byDay(list) {
      var days = [];
      var at = {};
      list.slice().sort(function (x, y) { return x.at - y.at; }).forEach(function (s) {
        var k = (s.date || new Date(s.at).toDateString()) + (s.row != null ? '_' + s.row : '');
        if (!at[k]) { at[k] = { key: k, at: s.at, palette: s.palette, master: s.master, row: s.row, items: [] }; days.push(at[k]); }
        at[k].items.push(s);
      });
      days.forEach(function (d) {
        d.items.sort(function (x, y) {
          return x.column && y.column ? COL_ORDER[x.column] - COL_ORDER[y.column] : ROW_ORDER[x.kind] - ROW_ORDER[y.kind];
        });
      });
      return days;
    }

    function bigCard(s, coming) {
      var st = STATUS[s.status] || [s.status, ''];
      if (!s.groupId) {
        return '<button class="pz-big pz-big--open" data-slot="' + s.id + '"><span class="pz-big__pic"><span>' + KIND[s.kind] + '<small>' + timeOf(s.at) + ' · not planned</small></span></span></button>';
      }
      var title = s.kind === 'promo' ? 'Marketing' + (s.template ? ' · ' + s.template : '') : (PARTS[s.categoryId] || '') + ' · ' + (s.master || '');
      return '<button class="pz-big' + (coming ? ' is-coming' : '') + '" data-slot="' + s.id + '"' + (coming ? ' data-next="1"' : '') + '>' +
        '<span class="pz-big__pic"' + picAttr(slotPic(s, state.account)) + '><span class="pz-big__make">Creating…</span>' +
        (s.kind === 'carousel' ? '<i class="pz-kindico">' + ICON.carousel + '</i>' : '') +
        '<span class="pz-big__time">' + timeOf(s.at) + '</span></span>' +
        '<span class="pz-big__body"><b>' + ui.esc(title) + '</b><span>' + KIND[s.kind] + (s.count && s.kind !== 'promo' ? ' · ' + s.count + ' phones' : '') + (s.keyword ? ' · ' + ui.esc(s.keyword) : '') +
        (!coming && s.status !== 'planned' ? ' ' + chip(st[0], st[1]) : '') + '</span></span></button>';
    }

    function dayRows(days, coming) {
      return '<div class="pz-days">' + days.map(function (d) {
        return '<div class="pz-day"><div class="pz-day__lbl"><i style="background:' + (SWATCH[d.palette] || '#999') + '"></i><b>' + ui.esc(dayLabel(d.at)) + (d.row != null ? ' · row ' + (d.row + 1) : '') + '</b><small>' + ui.esc((d.master ? d.master + ' · ' : '') + (d.palette || '')) + '</small></div>' +
          '<div class="pz-day__row">' + d.items.map(function (s) { return bigCard(s, coming); }).join('') + '</div></div>';
      }).join('') + '</div>';
    }

    function scheduled() {
      var b = state.board;
      if (!b && state.boardErr) return ui.emptyState('Nothing to show yet', 'The schedule could not be read.');
      if (!b) return '<div class="pz-day__row">' + [1, 2, 3].map(function () { return '<div class="pz-big adm__skel" style="height:420px"></div>'; }).join('') + '</div>';
      var list = b.slots.filter(function (s) { return (s.status === 'planned' || s.status === 'posting' || s.status === 'open') && s.at > Date.now() - 60000; });
      if (!list.length) return ui.emptyState('Nothing scheduled', 'Plan the week, and nine posts a day are laid out here.');
      return dayRows(byDay(list), false) + gaps();
    }

    function gaps() {
      var g = state.board.slots.filter(function (s) { return s.status === 'skipped' || s.status === 'missed' || s.status === 'failed'; });
      if (!g.length) return '';
      return '<div class="pz-gaps"><b>' + g.length + ' slot' + (g.length > 1 ? 's' : '') + ' did not post</b><p>A row with fewer than three posts shifts every row below it; the next row starts with a marketing poster or two to even it. Open one to plan it again.</p>' +
        g.map(function (s) { return '<button class="pz-gap" data-slot="' + s.id + '">' + chip(STATUS[s.status][0], STATUS[s.status][1]) + ' ' + dayLabel(s.at) + ' ' + timeOf(s.at) + '</button>'; }).join('') + '</div>';
    }

    function upcoming() {
      var b = state.board;
      if (!b) return state.boardErr ? '' : '<div class="pz-day__row">' + [1, 2, 3].map(function () { return '<div class="pz-big adm__skel" style="height:420px"></div>'; }).join('') + '</div>';
      if (!(b.upcoming || []).length) return ui.emptyState('Nothing to plan next', 'New groups come as people search and ask.');
      return dayRows(byDay(b.upcoming), true);
    }

    /* the phone grid: what is coming, then what is on Instagram (no reels) */
    function grid() {
      var b = state.board, ins = state.ins;
      if (!b) return state.boardErr ? '' : '<div class="adm__skel" style="height:360px"></div>';
      var onIg = {};
      var media = ins ? ins.posts.filter(function (m) { return m.kind !== 'reel'; }) : [];
      media.forEach(function (m) { onIg[m.id] = true; });
      var coming = (b.upcoming || []).concat(b.slots.filter(function (s) {
        return s.status === 'planned' || s.status === 'posting' || s.status === 'open' || (s.status === 'posted' && !onIg[s.mediaId]);
      }));
      /* newest first; in a day, the last posted (the carousel, at the left) first */
      coming.sort(function (x, y) { return y.at - x.at; });
      var items = coming.map(function (s) { return { slot: s }; }).concat(media.slice(0, 9).map(function (m) { return { post: m }; }));
      var rows = [];
      for (var i = 0; i < items.length; i += 3) rows.push(items.slice(i, i + 3));
      return '<div class="pz-gridwrap"><div class="pz-phone"><div class="pz-phone__bar">' + ICON.ig + ' <b>' + ui.esc((ins && ins.profile && ins.profile.username) || accountOf(state.account).label) + '</b></div>' +
        rows.map(function (row) {
          var first = row[0];
          var label = first.slot ? dayLabel(first.slot.at) : 'On Instagram';
          var pal = first.slot && first.slot.palette;
          return '<div class="pz-gridrow"><div class="pz-gridrow__lbl">' + (pal ? '<i style="background:' + (SWATCH[pal] || '#999') + '"></i>' : '') + '<span>' + ui.esc(label) + '</span></div><div class="pz-grid">' +
            row.map(tile).join('') + '</div></div>';
        }).join('') + '</div>' +
        '<aside class="pz-gridside"><h3>How the rows are kept</h3><ul class="pz-list">' +
        '<li><b>Left</b> <small>the carousel: the phone\'s tempered glass, page by page, and its other parts</small></li>' +
        '<li><b>Middle</b> <small>its biggest other part</small></li>' +
        '<li><b>Right</b> <small>its other parts on one poster, or marketing</small></li>' +
        '</ul><p class="pz-note">Every row takes the next colour, cool and warm in turn, so two rows next to each other never look alike. A row is posted right first and left last, so it lands as one row.</p>' +
        '<div class="pz-pals">' + (b.rows || []).map(function (p) { return '<i title="' + p + '" style="background:' + (SWATCH[p] || '#999') + '"></i>'; }).join('') + '</div></aside></div>';
    }

    function tile(it) {
      if (it.post) {
        var p = it.post;
        return '<button class="pz-tile pz-tile--ig" data-post="' + ui.esc(p.id) + '"' + (p.picture ? ' style="background-image:url(\'' + ui.esc(p.picture) + '\')"' : '') + '>' +
          (p.kind === 'carousel' ? '<i class="pz-kindico">' + ICON.carousel + '</i>' : '') + '<span class="pz-tile__foot">' + short(p.reach) + ' reached</span></button>';
      }
      var s = it.slot;
      if (!s.groupId) return '<button class="pz-tile pz-tile--open" data-slot="' + s.id + '"><span>' + KIND[s.kind] + '<small>' + timeOf(s.at) + '</small></span></button>';
      return '<button class="pz-tile' + (s.status === 'next' ? ' is-coming' : '') + '" data-slot="' + s.id + '"' + picAttr(slotPic(s, state.account)) + '>' +
        (s.kind === 'carousel' ? '<i class="pz-kindico">' + ICON.carousel + '</i>' : '') + '</button>';
    }

    function planButton() {
      var b = state.board;
      if (!b) return '';
      var waiting = b.slots.filter(function (s) { return s.status === 'planned' && s.at > Date.now(); }).length;
      return '<button class="adm__btn ' + (waiting ? '' : 'adm__btn--primary ') + 'adm__btn--sm" data-plan' + (waiting ? ' data-fresh' : '') + (state.busy ? ' disabled' : '') + '>' +
        (waiting ? 'Plan the week again' : 'Plan the week') + '</button>';
    }

    /* followers online by hour (India time), and the hours posted in */
    function hours() {
      var b = state.board;
      if (!b) return state.boardErr ? '' : '<div class="adm__skel" style="height:160px"></div>';
      var pk = b.peak;
      if (!pk || !pk.hours) return ui.emptyState('No hours yet', 'They are worked out when the week is planned.');
      var used = {};
      (b.times || []).forEach(function (t) { var h = Math.floor(t.minutes / 60); used[h] = (used[h] || 0) + 1; });
      var max = Math.max.apply(null, pk.hours) || 1;
      var bars = '';
      for (var h = 6; h <= 23; h++) {
        var v = pk.hours[h] || 0;
        var lbl = (h % 12 || 12) + (h < 12 ? 'a' : 'p');
        bars += '<div title="' + lbl + ': ' + Math.round(v / max * 100) + '% of the busiest hour' + (used[h] ? ', ' + used[h] + ' post' + (used[h] > 1 ? 's' : '') : '') + '" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0">' +
          '<div style="width:100%;height:110px;display:flex;align-items:flex-end"><div style="width:100%;height:' + Math.max(2, Math.round(v / max * 110)) + 'px;border-radius:4px 4px 0 0;background:' + (used[h] ? accountOf(state.account).color : 'rgba(128,128,150,.28)') + '"></div></div>' +
          '<small style="font-size:10px;opacity:.7">' + (h % 3 === 0 ? lbl : '&nbsp;') + '</small><b style="font-size:11px">' + (used[h] || '&nbsp;') + '</b></div>';
      }
      var times = (b.times || []).map(function (t) { var hh = Math.floor(t.minutes / 60), mm = t.minutes % 60; return (hh % 12 || 12) + ':' + String(mm).padStart(2, '0') + (hh < 12 ? ' AM' : ' PM'); });
      return '<div style="display:flex;gap:3px;align-items:flex-end">' + bars + '</div>' +
        '<p class="pz-note">' + (pk.source === 'followers' ? 'From this account\'s followers on Instagram, blended with a usual Indian day.' : 'Instagram has no follower hours for this account yet, so a usual Indian day is used. It switches by itself when Instagram has them.') +
        ' Posts at ' + ui.esc(times.join(', ')) + '. Worked out again with each new week.</p>';
    }

    /* the groups left over, each drawn in the colour its day would have */
    function suggest() {
      var b = state.board;
      if (!b) return state.boardErr ? '' : '<div class="pz-cards">' + [1, 2, 3, 4].map(function () { return '<div class="pz-card adm__skel" style="height:300px"></div>'; }).join('') + '</div>';
      var list = b.suggest || [];
      if (!list.length) return ui.emptyState('Nothing more to suggest', 'Every group people asked about is planned or posted. New ones come as people search and ask.');
      var rows = b.rows || ['royal'];
      var last = (b.upcoming || []).concat(b.slots).sort(function (x, y) { return y.at - x.at; })[0];
      var start = Math.max(0, rows.indexOf(last && last.palette)) + 1;
      return '<div class="pz-cards">' + list.map(function (g, i) {
        var pal = rows[(start + Math.floor(i / 2)) % rows.length];
        return '<div class="pz-card"><div class="pz-card__pic"' + picAttr({ group: g.groupId, kind: 'single', slide: 0, design: '', palette: pal, brand: state.account, template: '', keyword: '' }) + '></div>' +
          '<div class="pz-card__body"><b>' + ui.esc(PARTS[g.categoryId] || g.categoryId) + ' · ' + g.count + ' phones</b><span>' + ui.esc(g.master) + ' group</span>' +
          '<small class="pz-src pz-src--' + g.source + '">' + ui.esc(g.why) + '</small>' +
          '<div class="pz-card__act"><button class="adm__btn adm__btn--sm" data-use="' + ui.esc(g.groupId) + '">Put in a slot</button>' +
          '<a class="adm__btn adm__btn--sm adm__btn--ghost" data-go href="/admin/posters/create?group=' + encodeURIComponent(g.groupId) + '&master=' + encodeURIComponent(g.master) + '">Edit</a></div></div></div>';
      }).join('') + '</div>';
    }

    /* the side panel for one slot or one post */
    function drawer() {
      var o = state.open;
      if (!o || !state.board) return '';
      var body = '';
      if (o.slot) {
        var s = state.board.slots.concat(state.board.upcoming || []).filter(function (x) { return x.id === o.slot; })[0];
        if (!s) return '';
        var coming = s.status === 'next';
        var st = STATUS[s.status] || [s.status, ''];
        var canChange = !coming && (s.status === 'planned' || s.status === 'open' || s.status === 'skipped' || s.status === 'missed' || s.status === 'failed');
        var choices = (state.board.ready || []).map(function (g) { return '<option value="' + ui.esc(g.groupId) + '">' + ui.esc((PARTS[g.categoryId] || g.categoryId) + ' · ' + g.master + ' (' + g.count + ')') + '</option>'; }).join('');
        body = '<div class="pz-drawer__pic"' + (s.groupId ? picAttr(slotPic(s, state.account)) : '') + '></div>' +
          '<div class="pz-drawer__body"><div class="pz-chips">' + chip(KIND[s.kind]) + chip(st[0], st[1]) + (s.keyword ? chip('Comment ' + s.keyword, 'info') : '') + '</div>' +
          '<h3>' + (s.kind === 'promo' ? 'Marketing: ' + ui.esc(s.template || '') : ui.esc((PARTS[s.categoryId] || '') + ' · ' + (s.master || ''))) + '</h3>' +
          '<dl class="pz-dl"><dt>Goes out</dt><dd>' + dayLabel(s.at) + ', ' + timeOf(s.at) + (s.at > Date.now() ? ' (' + inTime(s.at) + ')' : '') + '</dd>' +
          (s.count ? '<dt>Phones</dt><dd>' + s.count + '</dd>' : '') + (s.why ? '<dt>Why this</dt><dd>' + ui.esc(s.why) + '</dd>' : '') +
          '<dt>Colour</dt><dd><i class="pz-dot" style="background:' + (SWATCH[s.palette] || '#999') + '"></i>' + ui.esc(s.palette || '') + (s.design ? ' · ' + ui.esc(s.design) + ' design' : '') + '</dd>' +
          (s.error ? '<dt>Error</dt><dd class="pz-err">' + ui.esc(s.error) + '</dd>' : '') +
          (s.permalink ? '<dt>On Instagram</dt><dd><a href="' + ui.esc(s.permalink) + '" target="_blank" rel="noopener">Open the post</a></dd>' : '') + '</dl>' +
          (canChange && s.kind !== 'promo' && choices ? '<label class="pz-field">Put another group here<select data-pick><option value="">Choose a group…</option>' + choices + '</select></label>' : '') +
          '<div class="pz-drawer__act">' +
          (s.status === 'planned' ? '<button class="adm__btn adm__btn--primary" data-postnow' + (state.busy ? ' disabled' : '') + '>Post now</button><button class="adm__btn" data-skip>Skip</button>' : '') +
          (s.status === 'skipped' || s.status === 'missed' || s.status === 'failed' ? '<button class="adm__btn" data-restore>Plan it again</button>' : '') +
          (s.groupId && s.kind !== 'promo' ? '<a class="adm__btn adm__btn--ghost" data-go href="/admin/posters/create?group=' + encodeURIComponent(s.groupId) + '&master=' + encodeURIComponent(s.master || '') + '">Edit in the editor</a>' : '') +
          '</div><p class="pz-note">' + (coming ? 'Not planned yet: this day joins the schedule by itself three days before. The group may change if a newer one is asked for first.'
            : s.status === 'planned' ? (state.board.auto ? 'Auto posting is on: this goes live by itself at its time.' : 'Auto posting is off: this waits until you post it or switch auto posting on.') : '') + '</p></div>';
      } else if (o.post && state.ins) {
        var p = state.ins.posts.filter(function (x) { return x.id === o.post; })[0];
        if (!p) return '';
        body = postDrawer(p);
      }
      return '<div class="pz-scrim" data-close></div><aside class="pz-drawer" role="dialog" aria-label="Details"><button class="pz-drawer__x" data-close aria-label="Close">×</button>' + body + '</aside>';
    }

    /* the countdown ticks once a second while the page is open */
    var timer = null;
    function tick() {
      if (timer) return;
      timer = global.setInterval(function () {
        if (!document.body.contains(root)) { global.clearInterval(timer); timer = null; return; }
        var els = root.querySelectorAll('[data-countdown]');
        for (var i = 0; i < els.length; i++) {
          var t = Number(els[i].getAttribute('data-countdown'));
          els[i].textContent = countdown(t);
          if (t < Date.now() - 90000) { loadBoard(); break; }
        }
      }, 1000);
    }

    /* ------------------------------------------------------------ loading */
    function loadBoard() {
      var a = state.account;
      ADM.api.content({ view: 'board', account: a }).then(function (r) {
        if (state.account !== a) return;
        state.board = r; state.boardErr = null; paint();
      }, function (err) { if (state.account === a) { state.boardErr = notYet(err); paint(); } });
    }
    function loadInsights(fresh) {
      var a = state.account;
      readInsights(a, fresh).then(function (r) {
        if (state.account !== a) return;
        state.ins = r; state.insErr = null; paint();
      }, function (err) { if (state.account === a) { state.insErr = notYet(err); paint(); } });
    }
    function loadAll() {
      state.board = null; state.ins = null; state.boardErr = null; state.insErr = null;
      paint(); loadBoard(); loadInsights(false);
    }

    function act(body, okText) {
      state.busy = true; paint();
      return ADM.api.contentAction(body).then(function (r) {
        state.busy = false;
        if (okText) ctx.toast(okText);
        loadBoard();
        return r;
      }, function (err) {
        state.busy = false; paint();
        ctx.toast(err.message || 'Could not do that', 'bad');
        throw err;
      });
    }

    root.addEventListener('click', function (e) {
      var t;
      if ((t = e.target.closest('[data-go]'))) { e.preventDefault(); ctx.go(t.getAttribute('href')); return; }
      if ((t = e.target.closest('[data-account]'))) {
        var id = t.getAttribute('data-account');
        if (id !== state.account) { state.account = id; state.open = null; remember(id); loadAll(); }
        return;
      }
      if (e.target.closest('[data-close]')) { state.open = null; paint(); return; }
      if ((t = e.target.closest('[data-plan]'))) { act({ action: 'plan', account: state.account, fresh: t.hasAttribute('data-fresh') }, 'The week is planned').catch(function () {}); return; }
      if ((t = e.target.closest('[data-slot]'))) { state.open = { slot: t.getAttribute('data-slot') }; paint(); return; }
      if ((t = e.target.closest('[data-post]'))) { if (state.ins) { state.open = { post: t.getAttribute('data-post') }; paint(); } return; }
      if (e.target.closest('[data-skip]')) { act({ action: 'slot', id: state.open.slot, op: 'skip' }, 'Skipped').catch(function () {}); return; }
      if (e.target.closest('[data-restore]')) { act({ action: 'slot', id: state.open.slot, op: 'restore' }, 'Planned again').catch(function () {}); return; }
      if (e.target.closest('[data-postnow]')) {
        var name = accountOf(state.account).label;
        if (!global.confirm('Post this to ' + name + ' on Instagram now? Everyone will see it.')) return;
        act({ action: 'postSlot', id: state.open.slot }, 'Posted to ' + name).then(function () { loadInsights(true); }, function () {});
        return;
      }
      if ((t = e.target.closest('[data-use]'))) {
        var gid = t.getAttribute('data-use');
        var slot = state.board.slots.filter(function (s) { return s.status === 'planned' && s.kind !== 'promo' && s.at > Date.now(); }).sort(function (x, y) { return y.at - x.at; })[0];
        if (!slot) { ctx.toast('No planned slot to put it in', 'bad'); return; }
        if (!global.confirm('Put this group in the ' + KIND[slot.kind].toLowerCase() + ' slot of ' + dayLabel(slot.at) + ', ' + timeOf(slot.at) + '? It replaces what is planned there.')) return;
        act({ action: 'slot', id: slot.id, op: 'group', group: gid }, 'Put in ' + dayLabel(slot.at) + ' ' + timeOf(slot.at)).catch(function () {});
      }
    });
    root.addEventListener('change', function (e) {
      if (e.target.matches('[data-auto]')) {
        var on = e.target.checked;
        var name = accountOf(state.account).label;
        if (on && !global.confirm('Switch on auto posting for ' + name + '? The planned posts will go live on Instagram at their times, three a day, without asking again.')) { e.target.checked = false; return; }
        act({ action: 'auto', account: state.account, on: on }, on ? 'Auto posting on for ' + name : 'Auto posting off for ' + name).catch(function () {});
        return;
      }
      if (e.target.matches('[data-pick]') && e.target.value) {
        act({ action: 'slot', id: state.open.slot, op: 'group', group: e.target.value }, 'Changed').catch(function () {});
      }
    });
    root.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.open) { state.open = null; paint(); } });

    ADM.api.content({ view: 'accounts' }).then(function (r) { state.accounts = r; paint(); }, function () { /* the board works without it */ });
    loadAll();
  }

  /* one post's numbers and why, for the side panel */
  function postDrawer(p) {
    return '<div class="pz-drawer__pic is-loaded"' + (p.picture ? ' style="background-image:url(\'' + ui.esc(p.picture) + '\')"' : '') + '></div><div class="pz-drawer__body">' +
      '<div class="pz-chips">' + chip(KIND[p.kind] || p.kind) + (p.young ? chip('new') : chip(p.score + '× usual', p.score >= 1.5 ? 'ok' : p.score <= 0.6 ? 'bad' : '')) + (p.keyword ? chip('Comment ' + p.keyword, 'info') : '') + '</div>' +
      '<h3>' + ui.esc(p.caption || 'Post') + '</h3>' +
      '<div class="pz-stats">' + [['Reached', p.reach], ['Views', p.views], ['Likes', p.likes], ['Comments', p.comments], ['Saves', p.saves], ['Shares', p.shares]]
        .concat(p.follows != null ? [['Follows', p.follows], ['Profile visits', p.visits]] : []).map(function (x) { return '<div><b>' + n(x[1]) + '</b><span>' + x[0] + '</span></div>'; }).join('') + '</div>' +
      '<h4>Why</h4><ul class="pz-reasons">' + (p.reasons || []).map(function (r) { return '<li class="is-' + r.tone + '">' + ui.esc(r.text) + '</li>'; }).join('') + '</ul>' +
      '<p class="pz-note">' + dayLabel(p.at) + ', ' + timeOf(p.at) + (p.fromHere ? ' · made on the Posters page' + (p.design ? ', ' + ui.esc(p.design) : '') + (p.palette ? ', ' + ui.esc(p.palette) : '') : '') + '</p>' +
      (p.permalink ? '<a class="adm__btn" href="' + ui.esc(p.permalink) + '" target="_blank" rel="noopener">' + ICON.ig + 'Open on Instagram</a>' : '') + '</div>';
  }

  /* ============================================================ analytics */
  function analytics(host, ctx) {
    var state = { account: remembered(), ins: null, err: null, open: null };
    var root = document.createElement('div');
    root.className = 'pz';
    host.appendChild(root);

    function sum(list) { return (list || []).reduce(function (a, x) { return a + (Number(x.value) || 0); }, 0); }

    function paint() {
      var ins = state.ins;
      var html = hub('analytics', state.account) + bio(ins, state.account, '<div class="pz-hl"><button class="adm__btn adm__btn--sm" data-refresh>Read again</button></div>');
      if (state.err) { root.innerHTML = html + ui.banner('bad', '<b>Instagram numbers could not be read.</b> ' + ui.esc(state.err)); return; }
      if (!ins) { root.innerHTML = html + '<div class="pz-kpis">' + [1, 2, 3, 4, 5].map(function () { return '<div class="pz-kpi adm__skel" style="height:84px"></div>'; }).join('') + '</div><div class="adm__skel" style="height:260px;margin-top:20px"></div>'; return; }
      var g = ins.growth || {};
      var tile = function (label, value, hint) { return '<div class="pz-kpi"><span>' + label + '</span><b>' + value + '</b><small>' + (hint || '&nbsp;') + '</small></div>'; };
      html += '<div class="pz-kpis">' +
        tile('Followers', ins.profile ? n(ins.profile.followers) : '—', ins.profile && ins.profile.username ? '@' + ui.esc(ins.profile.username) : '') +
        tile('New followers', g.followers ? '+' + n(sum(g.followers)) : '—', g.followers ? 'last 30 days' : 'Instagram did not say') +
        tile('Reached', g.reach ? short(sum(g.reach)) : '—', g.reach ? 'accounts, last 30 days' : 'Instagram did not say') +
        tile('Usual reach', n(ins.usual.reach), 'a post, median') +
        tile('Follows from posts', ins.follows ? n(ins.follows.total) : '—', ins.follows ? 'from the last ' + ins.posts.length + ' posts' : 'Instagram did not say') +
        '</div>';
      html += '<section class="pz-sec"><div class="pz-sec__head"><div><h2>Growth</h2><p>New followers each day, then the accounts reached each day, as Instagram counts them (the last 30 days).</p></div></div>' +
        '<div class="pz-charts"><div class="pz-chartcard"><h3>New followers</h3>' + (g.followers && g.followers.length ? ui.barChart(g.followers.map(function (x) { return { date: x.day, value: x.value }; }), { label: 'New followers', totalLabel: 'new followers in 30 days', color: accountOf(state.account).color })
          : ui.emptyState('Not available', 'Instagram gives daily followers only to accounts with 100 or more followers.')) + '</div>' +
        '<div class="pz-chartcard"><h3>Accounts reached</h3>' + (g.reach && g.reach.length ? ui.barChart(g.reach.map(function (x) { return { date: x.day, value: x.value }; }), { label: 'Accounts reached', totalLabel: 'reached in 30 days', color: '#0069B4' })
          : ui.emptyState('Not available', 'Instagram did not answer this.')) + '</div></div></section>';
      html += section('Top followers by content', 'The posts that brought the most new followers: people who followed the account from the post.', followersBy());
      html += section('Top posts', 'The best recent posts, against the account\'s own usual reach.', topPosts());
      html += section('What works', 'Why posts reach or not: each line rests on this account\'s own numbers.', works());
      html += section('Every post', 'The last ' + ins.posts.length + ' posts, newest first.', table());
      root.innerHTML = html + drawer();
    }

    function section(title, sub, body) {
      return '<section class="pz-sec"><div class="pz-sec__head"><div><h2>' + title + '</h2><p>' + sub + '</p></div></div>' + body + '</section>';
    }

    function followersBy() {
      var ins = state.ins;
      if (!ins.follows) return ui.emptyState('Instagram did not give follows', 'Follows a post brought are counted by Instagram for newer posts only.');
      var byId = {};
      ins.posts.forEach(function (p) { byId[p.id] = p; });
      var list = ins.follows.top.map(function (id) { return byId[id]; }).filter(Boolean);
      var kinds = ins.follows.kind.filter(function (k) { return k.posts; });
      var max = Math.max.apply(null, kinds.map(function (k) { return k.follows; }).concat([1]));
      return '<div class="pz-follows"><div class="pz-row">' + (list.length ? list.map(function (p, i) {
        return '<button class="pz-top" data-post="' + ui.esc(p.id) + '"><span class="pz-top__pic"' + (p.picture ? ' style="background-image:url(\'' + ui.esc(p.picture) + '\')"' : '') + '><i class="pz-rank">' + (i + 1) + '</i>' +
          (p.kind === 'carousel' ? '<i class="pz-kindico">' + ICON.carousel + '</i>' : '') + '<i class="pz-score is-up">+' + n(p.follows) + '</i></span>' +
          '<span class="pz-top__body"><b>+' + n(p.follows) + ' <small>followers</small></b><span class="pz-metrics"><span>' + KIND[p.kind] + '</span><span>' + short(p.reach) + ' reached</span>' +
          (p.visits != null ? '<span>' + short(p.visits) + ' profile visits</span>' : '') + '</span><span class="pz-why">' + ui.esc(p.caption || '') + '</span></span></button>';
      }).join('') : '<p class="pz-note">No post brought a follow yet in what Instagram reports.</p>') + '</div>' +
        '<div class="pz-bars"><h3>Followers by kind of post</h3>' + kinds.map(function (k) {
          return '<div class="pz-bar"><span>' + ui.esc(KIND[k.key] || k.key) + ' <small>' + k.posts + ' posts</small></span><i><b style="width:' + Math.max(3, Math.round(k.follows / max * 100)) + '%"></b></i><em>+' + n(k.follows) + '</em></div>';
        }).join('') + '</div></div>';
    }

    function topPosts() {
      var ins = state.ins;
      var list = ins.posts.slice().sort(function (x, y) { return (x.young - y.young) || (y.score - x.score) || (y.reach - x.reach); }).slice(0, 10);
      if (!list.length) return ui.emptyState('No posts yet', 'The best posts show here once the account has some.');
      return '<div class="pz-row">' + list.map(function (p, i) {
        var good = (p.reasons || []).filter(function (r) { return r.tone === 'good'; })[0] || (p.reasons || [])[0];
        return '<button class="pz-top" data-post="' + ui.esc(p.id) + '"><span class="pz-top__pic"' + (p.picture ? ' style="background-image:url(\'' + ui.esc(p.picture) + '\')"' : '') + '>' +
          '<i class="pz-rank">' + (i + 1) + '</i>' + (p.kind === 'carousel' ? '<i class="pz-kindico">' + ICON.carousel + '</i>' : '') +
          (p.score && !p.young ? '<i class="pz-score' + (p.score >= 1 ? ' is-up' : ' is-down') + '">' + p.score + '×</i>' : p.young ? '<i class="pz-score">new</i>' : '') + '</span>' +
          '<span class="pz-top__body"><b>' + short(p.reach) + ' <small>reached</small></b>' +
          '<span class="pz-metrics"><span title="Views">👁 ' + short(p.views) + '</span><span title="Likes">♥ ' + short(p.likes) + '</span><span title="Comments">💬 ' + short(p.comments) + '</span><span title="Saves">🔖 ' + short(p.saves) + '</span></span>' +
          (good ? '<span class="pz-why pz-why--' + good.tone + '">' + ui.esc(good.text) + '</span>' : '') + '</span></button>';
      }).join('') + '</div>';
    }

    function bars(title, rows, fmt) {
      if (!rows || !rows.length) return '';
      var max = Math.max.apply(null, rows.map(function (r) { return r.reach; }).concat([1]));
      return '<div class="pz-bars"><h3>' + title + '</h3>' + rows.map(function (r) {
        return '<div class="pz-bar"><span>' + ui.esc(fmt ? fmt(r.key) : r.key) + ' <small>' + r.posts + ' post' + (r.posts > 1 ? 's' : '') + '</small></span><i><b style="width:' + Math.max(3, Math.round(r.reach / max * 100)) + '%' +
          (SWATCH[r.key] ? ';background:' + SWATCH[r.key] : '') + '"></b></i><em>' + short(r.reach) + '</em></div>';
      }).join('') + '</div>';
    }

    function works() {
      var ins = state.ins;
      return '<div class="pz-works"><div class="pz-tips"><h3>What to do more of</h3><ul>' + ins.tips.map(function (t) { return '<li>' + ui.esc(t) + '</li>'; }).join('') + '</ul>' +
        '<p class="pz-note">Usual reach: ' + n(ins.usual.reach) + ' · judged on ' + ins.judged + ' posts older than two days · read ' + ui.ago(ins.readAt) + '</p></div>' +
        '<div class="pz-barsgrid">' + bars('By kind', ins.by.kind, function (k) { return KIND[k] || k; }) + bars('By time (IST)', ins.by.time, function (k) { return k.charAt(0).toUpperCase() + k.slice(1); }) +
        bars('By day', ins.by.weekday) + bars('By colour', ins.by.palette) + bars('By design', ins.by.design) + bars('By marketing template', ins.by.template) + bars('By comment word', ins.by.keyword) + '</div></div>';
    }

    function table() {
      var ins = state.ins;
      if (!ins.posts.length) return ui.emptyState('No posts yet', '');
      var follows = ins.posts.some(function (p) { return p.follows != null; });
      return '<div class="adm__scroll"><table class="adm__table pz-table"><thead><tr><th></th><th>Posted</th><th>Kind</th><th>Reach</th><th>Views</th><th>Likes</th><th>Comments</th><th>Saves</th><th>Shares</th>' + (follows ? '<th>Follows</th>' : '') + '<th>vs usual</th><th>Why</th></tr></thead><tbody>' +
        ins.posts.map(function (p) {
          var why = (p.reasons || [])[1] || (p.reasons || [])[0];
          return '<tr data-post="' + ui.esc(p.id) + '"><td><span class="pz-thumb"' + (p.picture ? ' style="background-image:url(\'' + ui.esc(p.picture) + '\')"' : '') + '></span></td><td>' + ui.esc(dayLabel(p.at)) + '<br><small>' + timeOf(p.at) + '</small></td><td>' + (KIND[p.kind] || p.kind) + '</td>' +
            '<td><b>' + n(p.reach) + '</b></td><td>' + n(p.views) + '</td><td>' + n(p.likes) + '</td><td>' + n(p.comments) + '</td><td>' + n(p.saves) + '</td><td>' + n(p.shares) + '</td>' + (follows ? '<td>' + n(p.follows) + '</td>' : '') +
            '<td>' + (p.young ? chip('new') : chip(p.score + '×', p.score >= 1.5 ? 'ok' : p.score <= 0.6 ? 'bad' : '')) + '</td><td class="pz-table__why">' + (why ? ui.esc(why.text) : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    function drawer() {
      if (!state.open || !state.ins) return '';
      var p = state.ins.posts.filter(function (x) { return x.id === state.open; })[0];
      return p ? '<div class="pz-scrim" data-close></div><aside class="pz-drawer" role="dialog" aria-label="Details"><button class="pz-drawer__x" data-close aria-label="Close">×</button>' + postDrawer(p) + '</aside>' : '';
    }

    function load(fresh) {
      var a = state.account;
      state.err = null;
      readInsights(a, fresh).then(function (r) { if (state.account === a) { state.ins = r; paint(); } }, function (err) { if (state.account === a) { state.err = notYet(err); paint(); } });
    }

    root.addEventListener('click', function (e) {
      var t;
      if ((t = e.target.closest('[data-go]'))) { e.preventDefault(); ctx.go(t.getAttribute('href')); return; }
      if ((t = e.target.closest('[data-account]'))) {
        var id = t.getAttribute('data-account');
        if (id !== state.account) { state.account = id; state.ins = null; state.open = null; remember(id); paint(); load(false); }
        return;
      }
      if (e.target.closest('[data-close]')) { state.open = null; paint(); return; }
      if (e.target.closest('[data-refresh]')) { state.ins = null; paint(); load(true); return; }
      if ((t = e.target.closest('[data-post]'))) { state.open = t.getAttribute('data-post'); paint(); }
    });
    root.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.open) { state.open = null; paint(); } });
    paint();
    load(false);
  }

  /* ============================================================ templates */
  function templates(host, ctx) {
    var state = { data: null, err: null, brand: remembered(), design: {} };
    var root = document.createElement('div');
    root.className = 'pz';
    host.appendChild(root);

    function paint() {
      var d = state.data;
      var html = hub('templates', state.brand);
      if (state.err) { root.innerHTML = html + ui.banner('bad', '<b>Could not load.</b> ' + ui.esc(state.err)); return; }
      if (!d) { root.innerHTML = html + '<div class="adm__skel" style="height:300px"></div>'; return; }
      var sample = d.sample;
      html += '<section class="pz-sec"><div class="pz-sec__head"><div><h2>Grid colours</h2><p>One colour a day, in this order, so each row of the grid is one colour and the next row another.</p></div></div>' +
        '<div class="pz-palrow">' + d.palettes.map(function (p, i) {
          return '<div class="pz-pal"><div class="pz-pal__row">' + [0, 1, 2].map(function () { return '<i style="background:' + (SWATCH[p.id] || p.color) + '"></i>'; }).join('') + '</div><b>' + (i + 1) + '. ' + ui.esc(p.name) + '</b></div>';
        }).join('') + '</div>' +
        '<div class="pz-slots">' + d.slots.slice().sort(function (x, y) { return ROW_ORDER[x.kind] - ROW_ORDER[y.kind]; }).map(function (s) {
          var h = Math.floor(s.minutes / 60), m = s.minutes % 60;
          return '<div class="pz-slot"><b>' + KIND[s.kind] + '</b><span>' + (h % 12 || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' AM' : ' PM') + '</span><small>' + s.column + ' of the row</small></div>';
        }).join('') + '</div></section>';

      if (!sample) {
        root.innerHTML = html + ui.banner('warn', 'No sample group could be read, so the previews cannot be drawn.');
        return;
      }
      html += '<section class="pz-sec"><div class="pz-sec__head"><div><h2>Marketing posters</h2><p>The middle post of every day. Numbers are real: drawn here with the ' + ui.esc(sample.master) + ' group (' + sample.count + ' phones).' +
        (state.brand === 'proglide' ? ' Each asks for one comment word; the reply bot sends the app link.' : ' They send people to the website.') + '</p></div></div>' +
        '<div class="pz-cards pz-cards--tpl">' + d.promos.map(function (t, i) {
          var pal = d.palettes[i % d.palettes.length].id;
          return '<div class="pz-card"><div class="pz-card__pic"' + picAttr({ group: sample.groupId, kind: 'promo', slide: 0, design: '', palette: pal, brand: state.brand, template: t.id, keyword: state.brand === 'proglide' ? d.keywords[i % d.keywords.length] : '' }) + '></div>' +
            '<div class="pz-card__body"><b>' + ui.esc(t.name) + '</b><span>' + ui.esc(t.about) + '</span></div></div>';
        }).join('') + '</div></section>';

      html += '<section class="pz-sec"><div class="pz-sec__head"><div><h2>Poster designs</h2><p>The single posters and carousel covers. Pick a colour to see each design in it.</p></div></div>' +
        '<div class="pz-cards pz-cards--tpl">' + d.designs.map(function (x, i) {
          var pal = state.design[x.id] || d.palettes[i % d.palettes.length].id;
          return '<div class="pz-card"><div class="pz-card__pic"' + picAttr({ group: sample.groupId, kind: 'single', slide: 0, design: x.id, palette: pal, brand: state.brand, template: '', keyword: '' }) + '></div>' +
            '<div class="pz-card__body"><b>' + ui.esc(x.name) + '</b><div class="pz-pals pz-pals--pick">' + d.palettes.map(function (p) {
              return '<button title="' + ui.esc(p.name) + '" data-recolor="' + x.id + '" data-pal="' + p.id + '" class="' + (p.id === pal ? 'is-on' : '') + '" style="background:' + (SWATCH[p.id] || p.color) + '"></button>';
            }).join('') + '</div></div></div>';
        }).join('') + '</div></section>';
      root.innerHTML = html;
      fill(root);
    }

    root.addEventListener('click', function (e) {
      var t;
      if ((t = e.target.closest('[data-go]'))) { e.preventDefault(); ctx.go(t.getAttribute('href')); return; }
      if ((t = e.target.closest('[data-account]'))) { state.brand = t.getAttribute('data-account'); remember(state.brand); paint(); return; }
      if ((t = e.target.closest('[data-recolor]'))) { state.design[t.getAttribute('data-recolor')] = t.getAttribute('data-pal'); paint(); }
    });

    paint();
    ADM.api.content({ view: 'templates' }).then(function (r) { state.data = r; paint(); }, function (err) { state.err = notYet(err); paint(); });
  }

  ADM.pages = ADM.pages || {};
  ADM.pages.posters = { render: board, templates: templates, analytics: analytics };
})(window);
