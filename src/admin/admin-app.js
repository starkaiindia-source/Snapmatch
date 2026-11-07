/* ============================================================================
   Mobile Parts Finder · admin-app.js — the admin shell and router
   ----------------------------------------------------------------------------
   A separate application from the customer site. Separate page, separate
   scripts, separate CSS. The customer navigation — Finder, Models, Plans,
   Account — is untouched by everything in this directory, and none of this
   code is in the bundle a shop downloads.

   ----------------------------------------------------------------------------
   THE GATE

   Three states, and they are decided by the SERVER, not here:

     signed out           show a sign-in button
     signed in, not staff send them back to the site
     signed in, staff     render the admin app

   The middle one is a courtesy, not a control. A customer who ignored the
   redirect would find every /api/admin/* route answering 403, and every admin
   collection in Firestore closed to their token by rule. Hiding the UI is not
   what protects the data; it just avoids showing someone a page of errors.

   ----------------------------------------------------------------------------
   AUTH PHASE IS RESPECTED

   'loading' is not 'signed out'. Painting the sign-in screen while a perfectly
   good session is still being restored is the bug that made the main site
   bounce people back to login on phones, and it would be the same bug here.
   Nothing decides anything until SM.fb.whenResolved() has answered.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});
  var ADM = (SM.adm = SM.adm || {});
  var ui = ADM.ui;

  var NAV = [
    { path: '/admin', id: 'dashboard', label: 'Dashboard', permission: null, group: 'Overview' },
    { path: '/admin/users', id: 'users', label: 'Users', permission: 'users.read', group: 'Customers' },
    { path: '/admin/leads', id: 'leads', label: 'Leads', permission: 'autoreply.manage', group: 'Customers' },
    { path: '/admin/missing-models', id: 'missingModels', label: 'Missing models',
      permission: 'missing_models.read', group: 'Catalogue' },
    { path: '/admin/ai', id: 'ai', label: 'Local AI', permission: 'ai.read', group: 'Catalogue' },
    /* Instagram compatibility intelligence: where a scan starts, the pages it
       reads, and the groups it leaves behind. The technical record — jobs,
       extraction results, the review queue, history — is still routed (below)
       and linked from where it is useful; it is not something a person has to
       visit for the compatibility data to change, so it is not in the menu. */
    { path: '/admin/instagram', id: 'igImporter', label: 'Instagram Data Importer', permission: 'instagram.read', group: 'Instagram data' },
    { path: '/admin/instagram/sources', id: 'igSources', label: 'Instagram Sources', permission: 'instagram.read', group: 'Instagram data' },
    { path: '/admin/instagram/groups', id: 'igGroups', label: 'Compatibility Management', permission: 'instagram.read', group: 'Instagram data' },
    { path: '/admin/auto-reply', id: 'autoReply', label: 'Auto Reply', permission: 'autoreply.manage', group: 'Marketing' },
    { path: '/admin/posters', id: 'posters', label: 'Posters', permission: 'autoreply.manage', group: 'Marketing' },
    { path: '/admin/settings', id: 'settings', label: 'Settings', permission: 'admins.read', group: 'Account' }
  ];

  var session = null;

  /* ------------------------------------------------------------------ boot */

  function boot() {
    var root = document.getElementById('admin');
    root.innerHTML = gateHTML('Checking your session…', '');

    /* The main site's Firebase module does all the work — one configuration,
       one SDK, one auth state. There is no second authentication system here
       and there must never be. */
    if (!SM.fb || !SM.fb.loadConfig) {
      root.innerHTML = gateHTML('Admin unavailable',
        'The Firebase module did not load. Reload the page.');
      return;
    }

    SM.fb.loadConfig().then(function () {
      if (!SM.fb.isConfigured()) {
        root.innerHTML = gateHTML('Firebase is not configured',
          'This deployment has no Firebase web configuration, so nobody can sign in. ' +
          'Set FIREBASE_PROJECT_ID, FIREBASE_API_KEY and FIREBASE_APP_ID in the ' +
          'environment and redeploy.');
        return;
      }
      /* Wait for the real answer. 'loading' is not 'signed out'. */
      return SM.fb.whenResolved().then(function (user) {
        if (!user) return showSignIn(root);
        return openSession(root);
      });
    }).catch(function (err) {
      root.innerHTML = gateHTML('Could not start',
        (err && err.message) || 'Something went wrong loading the admin area.');
    });
  }

  function showSignIn(root) {
    root.innerHTML = gateHTML(
      'Mobile Parts Finder admin',
      'Sign in with the Google account that holds your administrator role.',
      '<button class="adm__btn adm__btn--primary" id="admSignIn">Sign in with Google</button>' +
      '<a class="adm__btn" href="/finder">Back to the site</a>');

    document.getElementById('admSignIn').addEventListener('click', function () {
      var button = this;
      button.disabled = true;
      button.textContent = 'Opening Google…';
      SM.fb.signIn().then(function (user) {
        /* A redirect resolves to null — the browser is on its way to Google
           and the result arrives on the next page load. Not a failure. */
        if (!user) return;
        openSession(root);
      }, function (err) {
        button.disabled = false;
        button.textContent = 'Sign in with Google';
        var code = err && err.code;
        if (code === 'auth/popup-closed-by-user' || code === 'auth/user-cancelled') return;
        alert((err && err.message) || 'Sign-in failed.');
      });
    });
  }

  /**
   * Asks the server who this is.
   *
   * A 403 here is the normal path for a customer who found the URL — it is not
   * an error state, it is the answer. They are told plainly and pointed back
   * to the site rather than left on a broken-looking page.
   */
  function openSession(root) {
    root.innerHTML = gateHTML('Checking your access…', '');

    return ADM.api.session().then(function (data) {
      session = data;
      mount(root);
    }, function (err) {
      if (err.status === 403) {
        /* Denied, and sent back to the site.

           Nothing has been rendered at this point and nothing will be: the
           session call is the first thing the app does, and no admin data has
           been fetched — the routes would refuse it and the Firestore rules
           close the collections to this token regardless. So the redirect is
           courtesy rather than control.

           Delayed by a few seconds rather than instant, because an immediate
           bounce from a URL someone deliberately opened just looks broken.
           They get the reason, and a link if they do not want to wait. */
        root.innerHTML = gateHTML('Not an administrator',
          'This account does not have access to the Mobile Parts Finder backend. ' +
          'Taking you back to the site…',
          '<a class="adm__btn adm__btn--primary" href="/finder">Go back now</a>' +
          '<button class="adm__btn" id="admSignOut">Sign out</button>');

        var out = document.getElementById('admSignOut');
        if (out) out.addEventListener('click', function () {
          SM.fb.signOut().then(function () { location.href = '/finder'; });
        });

        /* replace, not assign: the admin URL does not go into history, so Back
           from the Finder does not land them here again. */
        setTimeout(function () { location.replace('/finder'); }, 4000);
        return;
      }
      if (err.status === 401) return showSignIn(root);

      root.innerHTML = gateHTML('Could not verify your access',
        (err && err.message) || 'The server did not answer.',
        '<button class="adm__btn adm__btn--primary" onclick="location.reload()">Try again</button>');
    });
  }

  /* ----------------------------------------------------------------- shell */

  function mount(root) {
    var allowed = NAV.filter(function (n) { return !n.permission || can(n.permission); });

    var me = session.admin;
    var who = me.name || me.email || me.uid;

    /* The navigation in sections, each with its own label, the way a console
       groups what it can do. */
    var sections = [];
    allowed.forEach(function (n) {
      var last = sections[sections.length - 1];
      if (!last || last.group !== n.group) sections.push(last = { group: n.group, items: [] });
      last.items.push(n);
    });

    root.innerHTML =
      '<div class="adm">' +
      '<header class="adm__top">' +
        '<button class="adm__burger" id="admBurger" aria-label="Menu" aria-expanded="false">' + SM.icon('list') + '</button>' +
        '<a class="adm__brand" href="/admin">' + SM.logoMark(26) + '<span>Mobile Parts Finder</span></a>' +
        '<span class="adm__crumb">Backend</span>' +
        '<div class="adm__topright">' +
          '<a class="adm__toplink" href="/finder" target="_blank" rel="noopener"><span>Open site</span>' + SM.icon('linkOut') + '</a>' +
          '<div class="adm__acct" title="' + ui.esc(me.email || '') + '">' +
            '<span class="adm__initial">' + ui.esc(String(who).trim().charAt(0).toUpperCase() || '?') + '</span>' +
            '<span class="adm__acctname"><b>' + ui.esc(who) + '</b><small>' + ui.esc(me.role.replace(/_/g, ' ')) + '</small></span>' +
          '</div>' +
          '<button class="adm__toplink" id="admSignOut">' + SM.icon('logout') + '<span>Sign out</span></button>' +
        '</div>' +
      '</header>' +
      '<aside class="adm__rail" id="admRail">' +
        '<label class="adm__find">' + SM.icon('search') +
          '<input type="search" id="admNavFind" placeholder="Quick search…" autocomplete="off" /></label>' +
        '<nav class="adm__nav" id="admNav">' + sections.map(function (sec) {
          return '<div class="adm__navsec">' +
            (sec.group ? '<div class="adm__navgroup">' + ui.esc(sec.group) + '</div>' : '') +
            sec.items.map(function (n) {
              return '<a href="' + n.path + '" data-nav="' + n.id + '">' +
                SM.icon(iconFor(n.id)) + '<span>' + ui.esc(n.label) + '</span>' +
                '<i class="adm__chev">' + SM.icon('chevronRight') + '</i></a>';
            }).join('') + '</div>';
        }).join('') + '</nav>' +
        '<div class="adm__me">' + ui.esc(me.email || '') + '</div>' +
      '</aside>' +
      '<div class="adm__scrim" id="admScrim"></div>' +
      '<main class="adm__main"><div class="adm__wrap" id="admPage"></div></main>' +
      '</div>' +
      '<div id="admToasts" class="toasts" aria-live="polite"></div>';

    document.getElementById('admSignOut').addEventListener('click', function () {
      SM.fb.signOut().then(function () { location.href = '/finder'; });
    });

    /* Phone: the menu is a drawer behind the button in the top bar. */
    var shell = root.querySelector('.adm');
    function menu(open) {
      shell.classList.toggle('is-menu', open);
      document.getElementById('admBurger').setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    document.getElementById('admBurger').addEventListener('click', function () { menu(!shell.classList.contains('is-menu')); });
    document.getElementById('admScrim').addEventListener('click', function () { menu(false); });
    document.getElementById('admNav').addEventListener('click', function () { menu(false); });

    /* Quick search narrows the menu to what matches (a section's name matches
       everything in it); Enter opens the first match. */
    var find = document.getElementById('admNavFind');
    find.addEventListener('input', function () {
      var q = find.value.trim().toLowerCase();
      Array.prototype.forEach.call(document.querySelectorAll('.adm__navsec'), function (sec) {
        var label = sec.querySelector('.adm__navgroup');
        var whole = !q || (label && label.textContent.toLowerCase().indexOf(q) > -1);
        var any = false;
        Array.prototype.forEach.call(sec.querySelectorAll('a'), function (a) {
          var hit = whole || a.textContent.toLowerCase().indexOf(q) > -1;
          a.hidden = !hit;
          any = any || hit;
        });
        sec.hidden = !any;
      });
    });
    find.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var first = document.querySelector('#admNav a:not([hidden])');
      if (!first) return;
      find.value = '';
      find.dispatchEvent(new Event('input'));
      menu(false);
      go(first.getAttribute('href'));
    });

    /* Real anchors so a middle-click opens a new tab, intercepted so a normal
       click routes without a reload. Same approach the customer app uses. */
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest && e.target.closest('a[href^="/admin"]');
      if (!a || (a.target && a.target !== '_self')) return;
      e.preventDefault();
      go(a.getAttribute('href'));
    });

    global.addEventListener('popstate', route);

    /* A token whose claim disagrees with the registry still works — the
       registry has already won on the server — but it is worth saying, because
       the fix is one sign-out and the alternative is a mystery. */
    if (session.admin.claimStale) {
      toast('Your role changed recently. Sign out and back in to refresh your session.', 'warn');
    }

    route();
  }

  /* Names from src/ui/icons.js. SM.icon falls back to `info` for an unknown
     one, so a typo here is a wrong icon rather than a crash — which is exactly
     why it is worth getting right rather than trusting the fallback. */
  function iconFor(id) {
    return { dashboard: 'grid', users: 'user', missingModels: 'inbox',
             ai: 'cpu', settings: 'sliders', autoReply: 'mail', leads: 'user', posters: 'camera',
             igImporter: 'camera', igSources: 'share', igGroups: 'layers' }[id] || 'grid';
  }

  /* ---------------------------------------------------------------- router */

  function go(path) {
    if (location.pathname !== path) history.pushState(null, '', path);
    route();
  }

  function route() {
    var page = document.getElementById('admPage');
    if (!page) return;

    var parts = location.pathname.replace(/^\/admin\/?/, '').split('/').filter(Boolean);
    var name = parts[0] || 'dashboard';

    var ctx = {
      go: go,
      toast: toast,
      can: can,
      admin: session.admin,
      services: session.services
    };

    highlight(name === 'users' && parts[1] ? 'users'
      : name === 'instagram' ? ({ sources: 'igSources', groups: 'igGroups', review: 'igGroups' }[parts[1]] || 'igImporter')
      : name === 'auto-reply' ? 'autoReply'
      : name === 'leads' ? 'leads'
      : name === 'posters' ? 'posters'
      : name);
    page.innerHTML = '';
    page.className = 'adm__wrap';
    global.scrollTo(0, 0);

    /* Every page is behind its permission here AND behind the same permission
       on the server. This check exists so a link nobody should see does not
       render a screen of 403s; it is not what stops anyone reading the data. */
    if (name === 'users' && parts[1]) {
      if (!can('users.read')) return denied(page);
      return ADM.pages.userDetail.render(page, ctx, decodeURIComponent(parts[1]));
    }
    if (name === 'users') {
      if (!can('users.read')) return denied(page);
      return ADM.pages.users.render(page, ctx);
    }
    if (name === 'missing-models') {
      if (!can('missing_models.read')) return denied(page);
      return ADM.pages.missingModels.render(page, ctx);
    }
    if (name === 'ai') {
      if (!can('ai.read')) return denied(page);
      return ADM.pages.ai.render(page, ctx);
    }
    if (name === 'leads') {
      if (!can('autoreply.manage')) return denied(page);
      return ADM.pages.leads.render(page, ctx);
    }
    if (name === 'posters') {
      if (!can('autoreply.manage')) return denied(page);
      if (parts[1] === 'templates') return ADM.pages.posters.templates(page, ctx);
      if (parts[1] === 'create') return ADM.pages.content.render(page, ctx);
      return ADM.pages.posters.render(page, ctx);
    }
    if (name === 'auto-reply') {
      if (!can('autoreply.manage')) return denied(page);
      return ADM.pages.autoReply.render(page, ctx);
    }
    if (name === 'instagram') {
      if (!can('instagram.read')) return denied(page);
      if (parts[1] === 'sources') return ADM.pages.igSources.render(page, ctx);
      if (parts[1] === 'groups') return ADM.pages.igGroups.render(page, ctx);
      if (parts[1] === 'jobs' && parts[2]) return ADM.pages.igJob.render(page, ctx, decodeURIComponent(parts[2]));
      if (parts[1] === 'jobs') return ADM.pages.igJobs.render(page, ctx);
      if (parts[1] === 'extractions') return ADM.pages.igExtractions.render(page, ctx);
      if (parts[1] === 'review') return ADM.pages.igReview.render(page, ctx);
      if (parts[1] === 'history') return ADM.pages.igHistory.render(page, ctx);
      return ADM.pages.igImporter.render(page, ctx);
    }
    if (name === 'settings') {
      return ADM.pages.settings.render(page, ctx);
    }
    return ADM.pages.dashboard.render(page, ctx);
  }

  function highlight(id) {
    var nav = document.getElementById('admNav');
    if (!nav) return;
    Array.prototype.forEach.call(nav.querySelectorAll('a'), function (a) {
      a.classList.toggle('is-on', a.getAttribute('data-nav') === id);
    });
  }

  function denied(page) {
    page.innerHTML = '<div class="adm__head"><h1>Not available</h1></div>' +
      ui.emptyState('Your role does not include this section',
        'Roles are set by a super_admin under Settings.');
  }

  /* ------------------------------------------------------------ permissions

     Read from the session the SERVER sent. The browser cannot grant itself a
     permission by editing this list — every route checks the same permission
     against the registry, so a tampered list buys a page full of 403s. */
  function can(permission) {
    return !!(session && session.admin.permissions.indexOf(permission) > -1);
  }

  /* ---------------------------------------------------------------- toasts */

  function toast(message, tone) {
    var host = document.getElementById('admToasts');
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'toast';
    if (tone === 'bad') el.style.borderColor = 'var(--bad)';
    if (tone === 'warn') el.style.borderColor = 'var(--warn)';
    el.textContent = message;
    host.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 300);
    }, tone === 'bad' || tone === 'warn' ? 6000 : 3000);
  }

  /* ------------------------------------------------------------------ gate */

  function gateHTML(title, body, actions) {
    return '<div class="adm__gate"><div>' +
      '<h1>' + ui.esc(title) + '</h1>' +
      (body ? '<p>' + ui.esc(body) + '</p>' : '') +
      (actions || '') +
      '</div></div>';
  }

  ADM.boot = boot;
  ADM.go = go;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
