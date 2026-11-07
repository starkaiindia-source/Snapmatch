/* ============================================================================
   Mobile Parts Finder · admin/pages/posters.js
   ----------------------------------------------------------------------------
   Posters: three posts a day on each Instagram account, and how they did.

     /admin/posters             the board for one account (switch at the top):
                                top posts, the grid as it will look with what
                                is scheduled next, the posters ready to plan,
                                what works and why, and every post's numbers
     /admin/posters/templates   every design, colour and marketing template,
                                and the order of the grid's colours
     /admin/posters/create      one poster by hand (pages/content.js)

   A day is one row of the grid: a single poster on the right, the marketing
   poster in the middle, a carousel on the left, all in that day's colour. The
   grid here is drawn the way Instagram fills it (newest top-left, three a
   row), so the rows show exactly as they will.

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
  var KIND = { single: 'Single', carousel: 'Carousel', promo: 'Marketing', reel: 'Reel' };
  var STATUS = { planned: ['Planned', 'info'], posting: ['Posting', 'warn'], posted: ['Posted', 'ok'], failed: ['Failed', 'bad'],
    missed: ['Missed', 'bad'], skipped: ['Skipped', ''], open: ['Not planned', ''] };
  var SWATCH = { royal: '#5B2EE8', sunset: '#FF5A1F', mint: '#0E9F84', berry: '#D6246E', ocean: '#0069B4', noir: '#1E1E2E' };
  var KEY = 'adm.posters.account';

  function remembered() {
    try { var v = global.localStorage.getItem(KEY); return v === 'mpf' ? 'mpf' : 'proglide'; } catch (e) { return 'proglide'; }
  }
  function remember(v) { try { global.localStorage.setItem(KEY, v); } catch (e) { /* the page works without it */ } }

  /* ------------------------------------------------------------ pictures
     Posters are drawn on the server, one JPEG a request, so they load a few
     at a time and are kept for the visit. */
  var pics = { cache: {}, queue: [], busy: 0 };
  function picKey(p) { return [p.group, p.kind, p.slide || 0, p.design || '', p.palette || '', p.brand || '', p.template || '', p.keyword || ''].join('|'); }
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
    return { group: s.groupId, kind: s.kind, slide: 0, design: s.design || '', palette: s.palette || '', brand: account, template: s.template || '', keyword: s.keyword || '' };
  }

  /* --------------------------------------------------------------- bits */
  var n = function (v) { return v == null ? '—' : Number(v).toLocaleString('en-IN'); };
  var short = function (v) { v = Number(v) || 0; return v >= 100000 ? (v / 1000).toFixed(0) + 'K' : v >= 10000 ? (v / 1000).toFixed(1) + 'K' : v.toLocaleString('en-IN'); };
  var chip = function (text, tone) { return '<span class="pz-chip' + (tone ? ' pz-chip--' + tone : '') + '">' + ui.esc(text) + '</span>'; };
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
  function head(title, sub, right) {
    return '<div class="adm__head pz-head"><div><h1>' + title + '</h1><p>' + sub + '</p></div><div class="pz-head__act">' + (right || '') + '</div></div>';
  }
  var ICON = {
    grid: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    back: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    ig: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/></svg>',
    reel: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M3 8h18M8 3l3 5M14 3l3 5"/><path d="M10 11.5v5l4.5-2.5z" fill="currentColor"/></svg>',
    carousel: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 3h12a2 2 0 0 1 2 2v12h-2V5H7z"/><rect x="3" y="7" width="14" height="14" rx="2"/></svg>'
  };

  /* the live server answers "unknown view" until this page's server code is deployed */
  function notYet(err) {
    var m = (err && err.message) || 'request failed';
    return /unknown view/i.test(m) ? 'The server does not have this yet. It arrives with the next deploy.' : m;
  }

  /* ================================================================ board */
  function board(host, ctx) {
    var state = { account: remembered(), board: null, boardErr: null, ins: null, insErr: null, accounts: null, open: null, busy: false };
    var root = document.createElement('div');
    host.appendChild(root);

    function acctInfo(id) {
      return (state.accounts && (state.accounts.accounts || []).filter(function (a) { return a.id === id; })[0]) || null;
    }

    function paint() {
      var a = state.account, b = state.board, ins = state.ins;
      var right = '<a class="adm__btn" href="/admin/posters/templates" data-go>' + ICON.grid + 'Templates</a>' +
        '<a class="adm__btn adm__btn--primary" href="/admin/posters/create" data-go>' + ICON.plus + 'Create a poster</a>';
      root.innerHTML = head('Posters', 'Three posts a day on each account, planned three days ahead. Each day is one row of the grid, in one colour.', right) +
        switcher() + kpis() +
        section('Top posts', 'The account\'s best recent posts, against its own usual reach.', topPosts(), insRefresh()) +
        section('Scheduled next', 'Your grid as it will look: the next three days on top, already posted below. Newest top-left, three a row, as Instagram shows it.', grid(), planButton()) +
        section('Ready posters', 'Groups people want that this account has not posted. Put one in a slot, or open it in the editor.', ready()) +
        section('What works', 'Why posts reach or not: each line rests on this account\'s own numbers.', works()) +
        section('Every post', 'Last 30 posts, newest first.', table()) +
        reels() + drawer();
      fill(root);
    }

    function section(title, sub, body, act) {
      return '<section class="pz-sec"><div class="pz-sec__head"><div><h2>' + title + '</h2><p>' + sub + '</p></div>' + (act || '') + '</div>' + body + '</section>';
    }

    function switcher() {
      var b = state.board;
      return '<div class="pz-accts">' + ACCOUNTS.map(function (x) {
        var info = acctInfo(x.id);
        var on = state.account === x.id;
        var prof = on && state.ins && state.ins.profile;
        var pic = prof && prof.picture ? '<img src="' + ui.esc(prof.picture) + '" alt="">' : '<b style="background:' + x.color + '">' + x.label.charAt(0) + '</b>';
        return '<button class="pz-acct' + (on ? ' is-on' : '') + '" data-account="' + x.id + '"><span class="pz-acct__pic">' + pic + '</span><span class="pz-acct__txt"><b>' + x.label + '</b><small>' +
          (info && info.username ? '@' + ui.esc(info.username) : x.sub) + (info ? (info.canPublish ? ' · can post' + (info.dailyLimit ? ' (' + (info.usedToday || 0) + '/' + info.dailyLimit + ' today)' : '') : ' · cannot post') : '') +
          '</small></span></button>';
      }).join('') +
        '<div class="pz-auto">' + (b ? '<label class="pz-switch"><input type="checkbox" data-auto' + (b.auto ? ' checked' : '') + (state.busy ? ' disabled' : '') + '><i></i><span><b>Auto posting ' + (b.auto ? 'on' : 'off') + '</b><small>' +
          (b.auto ? 'Posts go live at their times by themselves.' : 'Nothing posts until you switch this on.') + '</small></span></label>' : '') + '</div></div>' +
        (state.accounts && state.accounts.configured === false ? ui.banner('bad', '<b>Posting is off.</b> INSTAGRAM_PUBLISH_ACCESS_TOKEN is not set in Vercel.') : '') +
        (state.boardErr ? ui.banner('bad', '<b>The schedule could not load.</b> ' + ui.esc(state.boardErr)) : '');
    }

    function kpis() {
      var ins = state.ins, b = state.board;
      var next = b ? b.slots.filter(function (s) { return s.status === 'planned' && s.at > Date.now(); }).sort(function (x, y) { return x.at - y.at; })[0] : null;
      var tile = function (label, value, hint) { return '<div class="pz-kpi"><span>' + label + '</span><b>' + value + '</b><small>' + (hint || '&nbsp;') + '</small></div>'; };
      return '<div class="pz-kpis">' +
        tile('Followers', ins && ins.profile ? n(ins.profile.followers) : '—', ins && ins.profile && ins.profile.username ? '@' + ui.esc(ins.profile.username) : '') +
        tile('Posts', ins && ins.profile ? n(ins.profile.posts) : '—', 'on the account') +
        tile('Usual reach', ins ? n(ins.usual.reach) : '—', 'median of recent posts') +
        tile('Saved by', ins ? ins.usual.saveRate + '%' : '—', 'of the people reached') +
        tile('Next post', next ? timeOf(next.at) : '—', next ? dayLabel(next.at) + ' · ' + inTime(next.at) : 'nothing planned') +
        '</div>';
    }

    function insRefresh() { return '<button class="adm__btn adm__btn--sm" data-refresh>Read again</button>'; }

    function topPosts() {
      var ins = state.ins;
      if (state.insErr) return ui.banner('warn', '<b>Instagram numbers could not be read.</b> ' + ui.esc(state.insErr));
      if (!ins) return '<div class="pz-row">' + [1, 2, 3, 4, 5].map(function () { return '<div class="pz-top adm__skel"></div>'; }).join('') + '</div>';
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

    /* the grid, filled as Instagram fills it: newest first, three a row */
    function gridItems() {
      var b = state.board, ins = state.ins;
      if (!b) return null;
      var media = ins ? ins.posts : [];
      var onIg = {};
      media.forEach(function (m) { onIg[m.id] = true; });
      var coming = b.slots.filter(function (s) {
        return s.status === 'planned' || s.status === 'posting' || s.status === 'open' || (s.status === 'posted' && !onIg[s.mediaId]);
      }).sort(function (x, y) { return y.at - x.at; });
      return coming.map(function (s) { return { slot: s }; }).concat(media.slice(0, 12).map(function (m) { return { post: m }; }));
    }

    function grid() {
      var b = state.board;
      if (!b && state.boardErr) return ui.emptyState('Nothing to show yet', 'The schedule could not be read: ' + ui.esc(state.boardErr));
      if (!b) return '<div class="pz-gridwrap"><div class="pz-grid">' + [1, 2, 3, 4, 5, 6].map(function () { return '<div class="pz-tile adm__skel"></div>'; }).join('') + '</div></div>';
      var items = gridItems();
      var rows = [];
      for (var i = 0; i < items.length; i += 3) rows.push(items.slice(i, i + 3));
      var gaps = b.slots.filter(function (s) { return (s.status === 'skipped' || s.status === 'missed' || s.status === 'failed'); });
      var html = '<div class="pz-gridwrap"><div class="pz-phone"><div class="pz-phone__bar">' + ICON.ig + ' <b>' + ui.esc((acctInfo(state.account) || {}).username || (ACCOUNTS.filter(function (x) { return x.id === state.account; })[0].label)) + '</b></div>' +
        rows.map(function (row) {
          var first = row[0];
          var label = first.slot ? dayLabel(first.slot.at) : 'On Instagram';
          var pal = first.slot && first.slot.palette;
          return '<div class="pz-gridrow"><div class="pz-gridrow__lbl">' + (pal ? '<i style="background:' + (SWATCH[pal] || '#999') + '"></i>' : '') + '<span>' + ui.esc(label) + '</span></div><div class="pz-grid">' +
            row.map(tile).join('') + '</div></div>';
        }).join('') + '</div>' +
        '<aside class="pz-gridside"><h3>How the rows are kept</h3><ul class="pz-list">' +
        b.times.map(function (t) {
          var h = Math.floor(t.minutes / 60), m = t.minutes % 60;
          return '<li><b>' + (h % 12 || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' AM' : ' PM') + '</b> ' + KIND[t.kind] + ' <small>' + t.column + ' of the row</small></li>';
        }).join('') + '</ul><p class="pz-note">Every day takes the next colour, cool and warm in turn, so two rows next to each other never look alike. The middle column is always the ' + (state.account === 'proglide' ? 'app' : 'website') + '.</p>' +
        '<div class="pz-pals">' + (b.rows || []).map(function (p) { return '<i title="' + p + '" style="background:' + (SWATCH[p] || '#999') + '"></i>'; }).join('') + '</div>' +
        (gaps.length ? '<div class="pz-gaps"><b>' + gaps.length + ' slot' + (gaps.length > 1 ? 's' : '') + ' did not post</b><p>A day with fewer than three posts shifts every row below it. Restore or post something in its place.</p>' +
          gaps.map(function (s) { return '<button class="pz-gap" data-slot="' + s.id + '">' + chip(STATUS[s.status][0], STATUS[s.status][1]) + ' ' + dayLabel(s.at) + ' ' + timeOf(s.at) + '</button>'; }).join('') + '</div>' : '') +
        '</aside></div>';
      return html;
    }

    function tile(it) {
      if (it.post) {
        var p = it.post;
        return '<button class="pz-tile pz-tile--ig" data-post="' + ui.esc(p.id) + '"' + (p.picture ? ' style="background-image:url(\'' + ui.esc(p.picture) + '\')"' : '') + '>' +
          (p.kind === 'carousel' ? '<i class="pz-kindico">' + ICON.carousel + '</i>' : '') + '<span class="pz-tile__foot">' + short(p.reach) + ' reached</span></button>';
      }
      var s = it.slot;
      if (s.status === 'open' || !s.groupId) {
        return '<button class="pz-tile pz-tile--open" data-slot="' + s.id + '"><span>' + KIND[s.kind] + '<small>' + timeOf(s.at) + ' · not planned</small></span></button>';
      }
      return '<button class="pz-tile" data-slot="' + s.id + '"' + picAttr(slotPic(s, state.account)) + '>' +
        (s.kind === 'carousel' ? '<i class="pz-kindico">' + ICON.carousel + '</i>' : '') +
        '<span class="pz-tile__top">' + chip(timeOf(s.at)) + (s.status !== 'planned' ? chip(STATUS[s.status][0], STATUS[s.status][1]) : '') + '</span>' +
        '<span class="pz-tile__foot">' + KIND[s.kind] + (s.keyword ? ' · ' + s.keyword : '') + '</span></button>';
    }

    function planButton() {
      var b = state.board;
      var open = b ? b.slots.filter(function (s) { return s.status === 'open' && s.at > Date.now() + 600000; }).length : 0;
      return open ? '<button class="adm__btn adm__btn--primary adm__btn--sm" data-plan' + (state.busy ? ' disabled' : '') + '>Plan ' + open + ' open slot' + (open > 1 ? 's' : '') + '</button>' : '';
    }

    function ready() {
      var b = state.board;
      if (!b && state.boardErr) return '';
      if (!b) return '<div class="pz-cards">' + [1, 2, 3, 4].map(function () { return '<div class="pz-card adm__skel" style="height:300px"></div>'; }).join('') + '</div>';
      if (!b.ready.length) return ui.emptyState('Nothing new to post', 'Every group people asked about is planned or posted. New ones come as people search and ask.');
      var pal = (b.slots[0] || {}).palette || '';
      return '<div class="pz-cards">' + b.ready.map(function (g) {
        return '<div class="pz-card"><div class="pz-card__pic"' + picAttr({ group: g.groupId, kind: 'single', slide: 0, design: '', palette: pal, brand: state.account, template: '', keyword: '' }) + '></div>' +
          '<div class="pz-card__body"><b>' + ui.esc(PARTS[g.categoryId] || g.categoryId) + ' · ' + g.count + ' phones</b><span>' + ui.esc(g.master) + ' group</span>' +
          '<small class="pz-src pz-src--' + g.source + '">' + ui.esc(g.why) + '</small>' +
          '<div class="pz-card__act"><button class="adm__btn adm__btn--sm" data-use="' + ui.esc(g.groupId) + '">Put in a slot</button>' +
          '<a class="adm__btn adm__btn--sm adm__btn--ghost" data-go href="/admin/posters/create?group=' + encodeURIComponent(g.groupId) + '&master=' + encodeURIComponent(g.master) + '">Edit</a></div></div></div>';
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
      if (!ins) return state.insErr ? '' : '<div class="adm__skel" style="height:180px"></div>';
      return '<div class="pz-works"><div class="pz-tips"><h3>What to do more of</h3><ul>' + ins.tips.map(function (t) { return '<li>' + ui.esc(t) + '</li>'; }).join('') + '</ul>' +
        '<p class="pz-note">Usual reach: ' + n(ins.usual.reach) + ' · judged on ' + ins.judged + ' posts older than two days · read ' + ui.ago(ins.readAt) + '</p></div>' +
        '<div class="pz-barsgrid">' + bars('By kind', ins.by.kind, function (k) { return KIND[k] || k; }) + bars('By time (IST)', ins.by.time, function (k) { return k.charAt(0).toUpperCase() + k.slice(1); }) +
        bars('By day', ins.by.weekday) + bars('By colour', ins.by.palette) + bars('By design', ins.by.design) + bars('By marketing template', ins.by.template) + bars('By comment word', ins.by.keyword) + '</div></div>';
    }

    function table() {
      var ins = state.ins;
      if (!ins || !ins.posts.length) return ins ? ui.emptyState('No posts yet', '') : '<div class="adm__skel" style="height:200px"></div>';
      return '<div class="adm__scroll"><table class="adm__table pz-table"><thead><tr><th></th><th>Posted</th><th>Kind</th><th>Reach</th><th>Views</th><th>Likes</th><th>Comments</th><th>Saves</th><th>Shares</th><th>vs usual</th><th>Why</th></tr></thead><tbody>' +
        ins.posts.map(function (p) {
          var why = (p.reasons || [])[1] || (p.reasons || [])[0];
          return '<tr data-post="' + ui.esc(p.id) + '"><td><span class="pz-thumb"' + (p.picture ? ' style="background-image:url(\'' + ui.esc(p.picture) + '\')"' : '') + '></span></td><td>' + ui.esc(dayLabel(p.at)) + '<br><small>' + timeOf(p.at) + '</small></td><td>' + (KIND[p.kind] || p.kind) + '</td>' +
            '<td><b>' + n(p.reach) + '</b></td><td>' + n(p.views) + '</td><td>' + n(p.likes) + '</td><td>' + n(p.comments) + '</td><td>' + n(p.saves) + '</td><td>' + n(p.shares) + '</td>' +
            '<td>' + (p.young ? chip('new') : chip(p.score + '×', p.score >= 1.5 ? 'ok' : p.score <= 0.6 ? 'bad' : '')) + '</td><td class="pz-table__why">' + (why ? ui.esc(why.text) : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    function reels() {
      return '<section class="pz-sec pz-reels"><span class="pz-reels__ico">' + ICON.reel + '</span><div><h2>Reels</h2><p>Reels will be planned here too, beside the posters. Making them automatically comes next.</p></div>' + chip('Coming soon') + '</section>';
    }

    /* the side panel for one slot or one post */
    function drawer() {
      var o = state.open;
      if (!o) return '';
      var body = '';
      if (o.slot) {
        var s = (state.board.slots.filter(function (x) { return x.id === o.slot; })[0]);
        if (!s) return '';
        var st = STATUS[s.status] || [s.status, ''];
        var canChange = s.status === 'planned' || s.status === 'open' || s.status === 'skipped' || s.status === 'missed' || s.status === 'failed';
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
          '</div><p class="pz-note">' + (s.status === 'planned' ? (state.board.auto ? 'Auto posting is on: this goes live by itself at its time.' : 'Auto posting is off: this waits until you post it or switch auto posting on.') : '') + '</p></div>';
      } else if (o.post) {
        var p = (state.ins.posts.filter(function (x) { return x.id === o.post; })[0]);
        if (!p) return '';
        body = '<div class="pz-drawer__pic is-loaded"' + (p.picture ? ' style="background-image:url(\'' + ui.esc(p.picture) + '\')"' : '') + '></div><div class="pz-drawer__body">' +
          '<div class="pz-chips">' + chip(KIND[p.kind] || p.kind) + (p.young ? chip('new') : chip(p.score + '× usual', p.score >= 1.5 ? 'ok' : p.score <= 0.6 ? 'bad' : '')) + (p.keyword ? chip('Comment ' + p.keyword, 'info') : '') + '</div>' +
          '<h3>' + ui.esc(p.caption || 'Post') + '</h3>' +
          '<div class="pz-stats">' + [['Reached', p.reach], ['Views', p.views], ['Likes', p.likes], ['Comments', p.comments], ['Saves', p.saves], ['Shares', p.shares]].map(function (x) { return '<div><b>' + n(x[1]) + '</b><span>' + x[0] + '</span></div>'; }).join('') + '</div>' +
          '<h4>Why</h4><ul class="pz-reasons">' + (p.reasons || []).map(function (r) { return '<li class="is-' + r.tone + '">' + ui.esc(r.text) + '</li>'; }).join('') + '</ul>' +
          '<p class="pz-note">' + dayLabel(p.at) + ', ' + timeOf(p.at) + (p.fromHere ? ' · made on this page' + (p.design ? ', ' + ui.esc(p.design) : '') + (p.palette ? ', ' + ui.esc(p.palette) : '') : '') + '</p>' +
          (p.permalink ? '<a class="adm__btn" href="' + ui.esc(p.permalink) + '" target="_blank" rel="noopener">' + ICON.ig + 'Open on Instagram</a>' : '') + '</div>';
      }
      return '<div class="pz-scrim" data-close></div><aside class="pz-drawer" role="dialog" aria-label="Details"><button class="pz-drawer__x" data-close aria-label="Close">×</button>' + body + '</aside>';
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
      ADM.api.content({ view: 'insights', account: a, fresh: fresh ? '1' : undefined }).then(function (r) {
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
      if (e.target.closest('[data-refresh]')) { state.ins = null; paint(); loadInsights(true); return; }
      if (e.target.closest('[data-plan]')) { act({ action: 'plan', account: state.account }, 'Planned').catch(function () {}); return; }
      if ((t = e.target.closest('[data-slot]'))) { state.open = { slot: t.getAttribute('data-slot') }; paint(); return; }
      if ((t = e.target.closest('[data-post]'))) { if (state.ins) { state.open = { post: t.getAttribute('data-post') }; paint(); } return; }
      if (e.target.closest('[data-skip]')) { act({ action: 'slot', id: state.open.slot, op: 'skip' }, 'Skipped').catch(function () {}); return; }
      if (e.target.closest('[data-restore]')) { act({ action: 'slot', id: state.open.slot, op: 'restore' }, 'Planned again').catch(function () {}); return; }
      if (e.target.closest('[data-postnow]')) {
        var name = ACCOUNTS.filter(function (x) { return x.id === state.account; })[0].label;
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
        var name = ACCOUNTS.filter(function (x) { return x.id === state.account; })[0].label;
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

  /* ============================================================ templates */
  function templates(host, ctx) {
    var state = { data: null, err: null, brand: remembered(), design: {} };
    var root = document.createElement('div');
    host.appendChild(root);

    function paint() {
      var d = state.data;
      var right = '<a class="adm__btn" href="/admin/posters" data-go>' + ICON.back + 'Posters</a>';
      var html = head('Templates', 'Every poster the schedule can make. Add a template in the code and the scheduler uses it on its own.', right);
      if (state.err) { root.innerHTML = html + ui.banner('bad', '<b>Could not load.</b> ' + ui.esc(state.err)); return; }
      if (!d) { root.innerHTML = html + '<div class="adm__skel" style="height:300px"></div>'; return; }
      var sample = d.sample;
      html += '<div class="pz-accts pz-accts--slim">' + ACCOUNTS.map(function (x) {
        return '<button class="pz-acct' + (state.brand === x.id ? ' is-on' : '') + '" data-brand="' + x.id + '"><span class="pz-acct__pic"><b style="background:' + x.color + '">' + x.label.charAt(0) + '</b></span><span class="pz-acct__txt"><b>' + x.label + '</b><small>' + x.sub + '</small></span></button>';
      }).join('') + '</div>';

      html += '<section class="pz-sec"><div class="pz-sec__head"><div><h2>Grid colours</h2><p>One colour a day, in this order, so each row of the grid is one colour and the next row another.</p></div></div>' +
        '<div class="pz-palrow">' + d.palettes.map(function (p, i) {
          return '<div class="pz-pal"><div class="pz-pal__row">' + [0, 1, 2].map(function () { return '<i style="background:' + (SWATCH[p.id] || p.color) + '"></i>'; }).join('') + '</div><b>' + (i + 1) + '. ' + ui.esc(p.name) + '</b></div>';
        }).join('') + '</div>' +
        '<div class="pz-slots">' + d.slots.map(function (s) {
          var h = Math.floor(s.minutes / 60), m = s.minutes % 60;
          return '<div class="pz-slot"><b>' + (h % 12 || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' AM' : ' PM') + '</b><span>' + KIND[s.kind] + '</span><small>' + s.column + ' of the row</small></div>';
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
      if ((t = e.target.closest('[data-brand]'))) { state.brand = t.getAttribute('data-brand'); remember(state.brand); paint(); return; }
      if ((t = e.target.closest('[data-recolor]'))) { state.design[t.getAttribute('data-recolor')] = t.getAttribute('data-pal'); paint(); }
    });

    paint();
    ADM.api.content({ view: 'templates' }).then(function (r) { state.data = r; paint(); }, function (err) { state.err = notYet(err); paint(); });
  }

  ADM.pages = ADM.pages || {};
  ADM.pages.posters = { render: board, templates: templates };
})(window);
