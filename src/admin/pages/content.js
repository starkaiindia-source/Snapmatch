/* ============================================================================
   Mobile Parts Finder · admin/pages/content.js
   ----------------------------------------------------------------------------
   Posters: Instagram pictures drawn from the compatibility data.

   Pick a phone (searched most on the site, asked most on Instagram, newest, or
   typed in), then one of its parts, or one of the biggest groups straight away.
   The poster is drawn on the server, a single picture or a carousel, and each
   picture can be downloaded as the JPEG Instagram takes.

   Posting: pick the account (ProGlide or Mobile Parts Finder; the poster
   takes that account's logo and way in), edit the caption, and press Post.
   The browser asks once more before anything goes on Instagram.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, ADM = SM.adm, ui = ADM.ui;

  var SOURCES = [
    ['asked', 'Asked on Instagram', 'Phones named most in comments and messages lately.'],
    ['searched', 'Searched on the site', 'Models opened most in the last 14 days.'],
    ['newest', 'New models', 'The latest phones in the catalogue.'],
    ['biggest', 'Biggest groups', 'One part that fits the most phones.']
  ];
  var ACCOUNTS = [['proglide', 'ProGlide'], ['mpf', 'Mobile Parts Finder']];
  var PARTS = {
    'screen-guards': 'Tempered glass', 'back-cover': 'Back cover', 'combo-display': 'Combo display', 'middle-frame': 'Middle frame',
    'cc-board': 'CC board', battery: 'Battery', 'button-flex': 'Button flex', 'sim-tray': 'SIM tray'
  };

  function render(host, ctx) {
    host.innerHTML = '';
    var root = document.createElement('div');
    host.appendChild(root);
    var state = { ideas: null, source: 'asked', found: null, model: null, groups: null, group: null, kind: 'single', design: '', palette: '', photo: false, making: false, slides: [], busy: false,
      account: 'proglide', caption: '', captionKey: '', posting: false, accounts: null, posts: null };
    var urls = [];

    function modelRow(m) {
      return '<button class="ar-mode" data-model="' + ui.esc(m.id) + '"><b>' + ui.esc(m.name) + '</b><span>' +
        (m.count ? m.count + (state.source === 'asked' ? ' asks' : ' opens') : m.year ? 'Released ' + m.year : '') + '</span></button>';
    }
    function groupRow(g) {
      return '<button class="ar-mode' + (state.group && state.group.groupId === g.groupId ? ' is-on' : '') + '" data-group="' + ui.esc(g.groupId) +
        '" data-master="' + ui.esc(g.master) + '"><b>' + ui.esc(PARTS[g.categoryId] || g.categoryId) + ' · ' + g.count + ' models</b><span>' +
        ui.esc(g.master) + ' group</span></button>';
    }

    function paint() {
      var list = state.found || (state.ideas ? state.ideas[state.source] || [] : null);
      var typingHere = document.activeElement && document.activeElement.id === 'ctFind';
      var src = SOURCES.filter(function (s) { return s[0] === state.source; })[0];
      root.innerHTML = '<div class="adm__head"><div><h1>Create a poster</h1><p>One poster by hand, from any phone. ' +
        'Each one carries the logo and the way in of the account it is posted to.</p></div><a class="adm__btn" href="/admin/posters" data-go>← Posters</a></div>' + accountsCard() +

        '<div class="adm__card"><div class="ar-form"><label>Any phone<input id="ctFind" type="search" placeholder="Type a model, e.g. Realme 5" autocomplete="off"></label></div>' +
        (state.found ? '' : '<div class="ar-tabs" style="margin-top:14px">' + SOURCES.map(function (s) {
          return '<span role="button" tabindex="0" data-filter="' + s[0] + '" class="' + (state.source === s[0] ? 'is-on' : '') + '">' + s[1] + '</span>';
        }).join('') + '</div><p class="adm__none" style="margin:0 0 10px">' + ui.esc(src[2]) + '</p>') +
        (list === null ? '<div class="adm__skel" style="height:60px"></div>'
          : list.length ? '<div class="ar-modes">' + list.map(state.source === 'biggest' && !state.found ? groupRow : modelRow).join('') + '</div>'
          : ui.emptyState('Nothing here yet', state.found ? 'No model matches that.' : 'This list fills as people search and ask.')) + '</div>' +

        (state.model ? '<div class="adm__card"><div class="ar-head"><h2>' + ui.esc(state.model.name) + '</h2></div>' +
          (state.groups === null ? '<div class="adm__skel" style="height:60px"></div>'
            : state.groups.length ? '<div class="ar-modes">' + state.groups.map(groupRow).join('') + '</div>'
            : ui.emptyState('No parts recorded', 'Nothing in the catalogue fits this phone yet.')) + '</div>' : '') +

        (state.group ? '<div class="adm__card"><div class="ar-head"><h2>' + ui.esc(state.group.master) + ' group</h2>' +
          '<div class="ar-tabs" style="margin:0">' + ACCOUNTS.map(function (a) {
            return '<span role="button" tabindex="0" data-account="' + a[0] + '" class="' + (state.account === a[0] ? 'is-on' : '') + '">' + a[1] + '</span>';
          }).join('') + '</div>' +
          '<div class="ar-tabs" style="margin:0">' + [['single', 'Single poster'], ['carousel', 'Carousel']].map(function (k) {
            return '<span role="button" tabindex="0" data-kind="' + k[0] + '" class="' + (state.kind === k[0] ? 'is-on' : '') + '">' + k[1] + '</span>';
          }).join('') + '</div></div>' + options() +
          '<div class="ct-slides">' + state.slides.map(function (s, i) {
            return '<figure><img src="' + s + '" alt="Slide ' + (i + 1) + '"><a class="adm__btn" download="' + state.account + '-' + ui.esc(state.group.groupId) + '-' +
              state.kind + (state.slides.length > 1 ? '-' + (i + 1) : '') + '.jpg" href="' + s + '">Download' + (state.slides.length > 1 ? ' ' + (i + 1) : '') + '</a></figure>';
          }).join('') + (state.busy ? '<div class="adm__skel ct-wait"></div>' : '') + '</div>' + postForm() + '</div>' : '') +
        postsCard();

      var input = root.querySelector('#ctFind');
      if (state.query) input.value = state.query;
      if (state.query && typingHere) { input.focus(); input.setSelectionRange(state.query.length, state.query.length); }
    }

    function accountName(id) { return (ACCOUNTS.filter(function (a) { return a[0] === id; })[0] || [id, id])[1]; }

    /* what the publish token reaches, one line an account */
    function accountsCard() {
      var a = state.accounts;
      if (!a) return '';
      if (!a.configured) return ui.banner('bad', '<b>Posting is off.</b> INSTAGRAM_PUBLISH_ACCESS_TOKEN is not set in Vercel.');
      return '<div class="adm__card"><div class="ar-head"><h2>Instagram accounts</h2></div>' + a.accounts.map(function (x) {
        return '<p class="adm__none" style="margin:4px 0">' + (x.canPublish ? '✅ ' : '⚠️ ') + '<b>' + ui.esc(x.label) + '</b>' +
          (x.username ? ' @' + ui.esc(x.username) : '') + ' · ' +
          (x.canPublish ? 'can post' + (x.dailyLimit ? ' (' + (x.usedToday || 0) + ' of ' + x.dailyLimit + ' today)' : '') : ui.esc(x.error || 'cannot post')) + '</p>';
      }).join('') + '</div>';
    }

    function postForm() {
      if (state.busy || !state.slides.length) return '';
      return '<h3>Post to ' + ui.esc(accountName(state.account)) + '</h3>' +
        '<div class="ar-form"><label>Caption<textarea id="ctCaption" rows="9" maxlength="2200">' + ui.esc(state.caption) + '</textarea></label></div>' +
        '<div class="ar-row" style="margin:10px 0 0"><button class="adm__btn adm__btn--primary" data-post="1"' + (state.posting || !state.caption ? ' disabled' : '') + '>' +
        (state.posting ? 'Posting…' : 'Post ' + (state.kind === 'carousel' ? state.slides.length + ' slides' : 'poster') + ' to Instagram') + '</button>' +
        '<span class="adm__none">Goes live on @' + ui.esc(usernameOf(state.account) || accountName(state.account)) + ' straight away.</span></div>';
    }

    function usernameOf(id) {
      var x = state.accounts && (state.accounts.accounts || []).filter(function (a) { return a.id === id; })[0];
      return x && x.username;
    }

    function postsCard() {
      var p = state.posts;
      if (!p || !p.length) return '';
      return '<div class="adm__card"><div class="ar-head"><h2>Posted from here</h2></div>' + p.map(function (x) {
        return '<p class="adm__none" style="margin:4px 0">' + ui.esc(new Date(x.at).toLocaleString()) + ' · <b>' + ui.esc(accountName(x.account)) + '</b> · ' +
          ui.esc(x.groupId) + ' ' + ui.esc(x.kind) + (x.permalink ? ' · <a href="' + ui.esc(x.permalink) + '" target="_blank" rel="noopener">open</a>' : '') + '</p>';
      }).join('') + '</div>';
    }

    function loadCaption() {
      var key = state.account + '|' + state.group.groupId;
      if (state.captionKey === key) return;
      state.captionKey = key;
      state.caption = '';
      ADM.api.content({ view: 'caption', group: state.group.groupId, account: state.account }).then(function (r) {
        if (state.captionKey !== key) return;
        state.caption = r.caption;
        paint();
      }, function () { /* the owner can still write one */ });
    }

    function post() {
      var name = accountName(state.account);
      if (!global.confirm('Post this ' + (state.kind === 'carousel' ? 'carousel' : 'poster') + ' to ' + name + ' on Instagram now? Everyone will see it.')) return;
      state.posting = true;
      paint();
      ADM.api.contentAction({
        action: 'publish', account: state.account, group: state.group.groupId, kind: state.kind,
        design: state.design, palette: state.palette, caption: state.caption
      }).then(function (r) {
        state.posting = false;
        ctx.toast('Posted to ' + name);
        if (r.permalink) global.open(r.permalink, '_blank', 'noopener');
        loadPosts();
        loadAccounts();
      }, function (err) {
        state.posting = false;
        paint();
        ctx.toast(err.message || 'Could not post', 'bad');
      });
    }

    function loadAccounts() {
      ADM.api.content({ view: 'accounts' }).then(function (r) { state.accounts = r; paint(); }, function () { /* the page works without it */ });
    }
    function loadPosts() {
      ADM.api.content({ view: 'posts' }).then(function (r) { state.posts = r.posts; paint(); }, function () { /* nothing posted yet */ });
    }

    /* the design and the colour (today's unless chosen), and the part's AI photo */
    function options() {
      var ideas = state.ideas || {}, today = ideas.today || {};
      var name = function (list, id) { return ((list || []).filter(function (x) { return x.id === id; })[0] || {}).name || id; };
      var chips = function (attr, list, on, auto) {
        return '<div class="ar-tabs">' + [['', auto]].concat((list || []).map(function (x) { return [x.id, x.name]; })).map(function (o) {
          return '<span role="button" tabindex="0" ' + attr + '="' + o[0] + '" class="' + (on === o[0] ? 'is-on' : '') + '">' + ui.esc(o[1]) + '</span>';
        }).join('') + '</div>';
      };
      return '<h3>Design</h3>' + chips('data-design', ideas.designs, state.design, "Today's: " + name(ideas.designs, today.design)) +
        '<h3>Colour</h3>' + chips('data-palette', ideas.palettes, state.palette, "Today's: " + name(ideas.palettes, today.palette)) +
        '<div class="ar-row" style="margin:4px 0 14px"><button class="adm__btn" data-photo="1"' + (state.making ? ' disabled' : '') + '>' +
        (state.making ? 'Making the AI photo…' : state.photo ? 'Make a new AI photo' : 'Make AI photo') + '</button>' +
        '<span class="adm__none">' + (state.photo ? 'Using the AI photo of this part.' : 'Using the plain part picture. An AI photo is one Gemini image call.') + '</span></div>';
    }

    function makePhoto() {
      state.making = true;
      paint();
      ADM.api.contentAction({ action: 'photo', group: state.group.groupId }).then(function () {
        state.making = false;
        ctx.toast('AI photo ready');
        draw();
      }, function (err) {
        state.making = false;
        paint();
        ctx.toast(err.message || 'Could not make the photo', 'bad');
      });
    }

    function draw() {
      urls.forEach(function (u) { URL.revokeObjectURL(u); });
      urls = [];
      state.slides = [];
      state.busy = true;
      paint();
      var group = state.group, kind = state.kind, account = state.account;
      loadCaption();
      function next(i, total) {
        if (state.group !== group || state.kind !== kind || state.account !== account) return;
        if (i >= total) { state.busy = false; paint(); return; }
        ADM.api.poster({ group: group.groupId, kind: kind, slide: i, design: state.design, palette: state.palette, brand: account }).then(function (r) {
          if (state.group !== group || state.kind !== kind || state.account !== account) return;
          state.photo = r.photo;
          var u = URL.createObjectURL(r.blob);
          urls.push(u);
          state.slides.push(u);
          paint();
          next(i + 1, r.slides);
        }, function (err) {
          state.busy = false;
          paint();
          ctx.toast(err.message || 'Could not draw the poster', 'bad');
        });
      }
      next(0, 1);
    }

    function openModel(id) {
      state.model = { id: id, name: '' };
      state.groups = null;
      state.group = null;
      paint();
      ADM.api.content({ view: 'model', id: id }).then(function (r) {
        state.model = r.model;
        state.groups = r.groups;
        paint();
      }, function (err) { state.groups = []; paint(); ctx.toast(err.message || 'Could not load', 'bad'); });
    }

    var typing = null;
    root.addEventListener('input', function (e) {
      if (e.target.id === 'ctCaption') {
        state.caption = e.target.value;
        var btn = root.querySelector('[data-post]');
        if (btn) btn.disabled = state.posting || !state.caption.trim();
        return;
      }
      if (e.target.id !== 'ctFind') return;
      state.query = e.target.value;
      clearTimeout(typing);
      typing = setTimeout(function () {
        var q = state.query.trim();
        if (q.length < 2) { state.found = null; paint(); return; }
        ADM.api.content({ view: 'find', q: q }).then(function (r) { if (state.query.trim() === q) { state.found = r.models; paint(); } });
      }, 300);
    });

    root.addEventListener('click', function (e) {
      var t;
      if ((t = e.target.closest('[data-go]'))) { e.preventDefault(); ctx.go(t.getAttribute('href')); return; }
      if ((t = e.target.closest('[data-filter]'))) { state.source = t.getAttribute('data-filter'); paint(); return; }
      if ((t = e.target.closest('[data-model]'))) { openModel(t.getAttribute('data-model')); return; }
      if ((t = e.target.closest('[data-group]'))) {
        state.group = { groupId: t.getAttribute('data-group'), master: t.getAttribute('data-master') };
        draw();
        var card = root.querySelector('.ct-slides');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if ((t = e.target.closest('[data-kind]'))) { state.kind = t.getAttribute('data-kind'); draw(); return; }
      if ((t = e.target.closest('[data-account]'))) { state.account = t.getAttribute('data-account'); draw(); return; }
      if (e.target.closest('[data-post]') && !state.posting) { post(); return; }
      if ((t = e.target.closest('[data-design]'))) { state.design = t.getAttribute('data-design'); draw(); return; }
      if ((t = e.target.closest('[data-palette]'))) { state.palette = t.getAttribute('data-palette'); draw(); return; }
      if (e.target.closest('[data-photo]') && !state.making) makePhoto();
    });

    paint();
    loadAccounts();
    loadPosts();
    /* opened from the Posters board with a group: draw it straight away */
    var want = new URLSearchParams(global.location.search);
    if (/^[a-z]{2}-d{1,6}$/.test(want.get('group') || '')) {
      state.group = { groupId: want.get('group'), master: want.get('master') || want.get('group') };
      draw();
    }
    ADM.api.content({ view: 'ideas' }).then(function (r) {
      state.ideas = r;
      if (!(r.asked || []).length) state.source = (r.searched || []).length ? 'searched' : 'newest';
      paint();
    }, function (err) {
      root.innerHTML = '<div class="adm__head"><h1>Posters</h1></div>' + ui.banner('bad', '<b>Could not load.</b> ' + ui.esc(err.message || 'request failed'));
    });
  }

  ADM.pages = ADM.pages || {};
  ADM.pages.content = { render: render };
})(window);
