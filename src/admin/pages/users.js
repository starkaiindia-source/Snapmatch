/* ============================================================================
   Mobile Parts Finder · admin/pages/users.js
   ----------------------------------------------------------------------------
   The user table. Real accounts, searched and filtered on the server, one page
   at a time.

   ----------------------------------------------------------------------------
   WHY THE FILTERING IS NOT DONE HERE

   It would be easy: fetch every user, filter in JavaScript, sort in
   JavaScript. It also downloads the entire customer list — names, emails,
   phone numbers — into a browser tab, gets slower every month, and puts a copy
   of the business's most sensitive data anywhere the page is left open.

   So the query goes to the server, the server applies what Firestore can index
   and reports honestly when something had to be filtered afterwards, and this
   file renders the page it was given.

   ----------------------------------------------------------------------------
   SEARCH TELLS THE TRUTH ABOUT WHAT IT CAN DO

   Exact by email, uid or phone number. Prefix by shop name, proprietor name or
   display name — "sri bal" finds "Sri Balaji Mobiles"; "balaji" does not,
   because Firestore cannot do mid-word matching at index speed and pretending
   otherwise means downloading everything again. The hint under the box says
   so, rather than leaving someone to conclude the user is missing.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, ADM = SM.adm, ui = ADM.ui;

  var FILTERS = [
    ['all', 'All users'],
    ['new', 'New (30 days)'],
    ['active', 'Active (30 days)'],
    ['inactive', 'Inactive'],
    ['profile_incomplete', 'Profile incomplete'],
    ['profile_complete', 'Profile complete'],
    ['free', 'Free account'],
    ['subscription_active', 'Active subscription'],
    ['subscription_expired', 'Expired subscription'],
    ['plan_monthly', 'Monthly plan'],
    ['plan_yearly', 'Yearly plan']
  ];

  var SORTS = [
    ['newest', 'Newest account'],
    ['oldest', 'Oldest account'],
    ['recently_active', 'Recently active'],
    ['longest_inactive', 'Longest inactive'],
    ['highest_revenue', 'Highest revenue'],
    ['most_payments', 'Most payments']
  ];

  /* Kept across renders so paging back does not lose the filters, and so a
     re-render after navigating to a user and back shows the same page. */
  var query = { q: '', filter: 'all', sort: 'newest', country: '',
                createdFrom: '', createdTo: '', lastLoginFrom: '', lastLoginTo: '' };
  var cursors = [];        /* the cursor that opened each page, for Back */
  var current = null;

  function render(host, ctx) {
    host.innerHTML =
      '<div class="adm__head"><div>' +
      '<h1>Users</h1>' +
      '<p>Registered accounts, joined from Firebase Authentication and the stored ' +
      'shop profile. Nothing here is sample data.</p>' +
      '</div></div>' +
      '<div class="adm__card">' + filtersHTML() + '<div id="admUsersBody">' +
      tableShell(ui.skeletonRows(8, 7)) + '</div></div>';

    wire(host, ctx);
    load(ctx);
  }

  function filtersHTML() {
    return '<form class="adm__filters" id="admUserFilters">' +
      '<input type="search" name="q" placeholder="Email, uid, phone, shop or proprietor name" ' +
      'value="' + ui.esc(query.q) + '" />' +
      select('filter', FILTERS, query.filter) +
      select('sort', SORTS, query.sort) +
      '<input type="text" name="country" placeholder="Country" size="10" ' +
      'value="' + ui.esc(query.country) + '" />' +
      '<label>Joined <input type="date" name="createdFrom" value="' + ui.esc(query.createdFrom) + '" /></label>' +
      '<label>to <input type="date" name="createdTo" value="' + ui.esc(query.createdTo) + '" /></label>' +
      '<label>Seen <input type="date" name="lastLoginFrom" value="' + ui.esc(query.lastLoginFrom) + '" /></label>' +
      '<label>to <input type="date" name="lastLoginTo" value="' + ui.esc(query.lastLoginTo) + '" /></label>' +
      '<button class="adm__btn adm__btn--primary" type="submit">Apply</button>' +
      '<button class="adm__btn" type="button" data-act="reset">Reset</button>' +
      '</form>' +
      '<p class="adm__hint">Email, Firebase UID and phone number match exactly. ' +
      'Shop and proprietor names match from the start of the name.</p>';
  }

  function select(name, options, value) {
    return '<select name="' + name + '">' + options.map(function (o) {
      return '<option value="' + o[0] + '"' + (o[0] === value ? ' selected' : '') + '>' +
        ui.esc(o[1]) + '</option>';
    }).join('') + '</select>';
  }

  function tableShell(rows) {
    return '<div class="adm__scroll"><table class="adm__table">' +
      '<thead><tr>' +
      '<th>Shop</th><th>Contact</th><th>Profile</th><th>Plan</th>' +
      '<th class="num">Paid</th><th>Joined</th><th>Last seen</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function wire(host, ctx) {
    var form = host.querySelector('#admUserFilters');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = new FormData(form);
      Object.keys(query).forEach(function (k) { query[k] = String(data.get(k) || '').trim(); });
      cursors = [];                                  /* a new query starts at page 1 */
      load(ctx);
    });

    form.addEventListener('click', function (e) {
      if (!e.target.closest('[data-act="reset"]')) return;
      query = { q: '', filter: 'all', sort: 'newest', country: '',
                createdFrom: '', createdTo: '', lastLoginFrom: '', lastLoginTo: '' };
      cursors = [];
      render(host, ctx);
    });

    host.addEventListener('click', function (e) {
      var row = e.target.closest('tr[data-uid]');
      if (row) { ctx.go('/admin/users/' + row.getAttribute('data-uid')); return; }

      var next = e.target.closest('[data-act="next"]');
      if (next) {
        cursors.push(current && current.nextCursor);
        load(ctx);
        return;
      }
      var back = e.target.closest('[data-act="back"]');
      if (back) { cursors.pop(); load(ctx); }
    });
  }

  function load(ctx) {
    var body = document.getElementById('admUsersBody');
    if (!body) return;
    body.innerHTML = tableShell(ui.skeletonRows(8, 7));

    var params = {
      q: query.q,
      filter: query.filter,
      sort: query.sort,
      country: query.country,
      createdFrom: query.createdFrom || undefined,
      createdTo: query.createdTo ? endOfDay(query.createdTo) : undefined,
      lastLoginFrom: query.lastLoginFrom || undefined,
      lastLoginTo: query.lastLoginTo ? endOfDay(query.lastLoginTo) : undefined,
      cursor: cursors.length ? cursors[cursors.length - 1] : undefined
    };

    ADM.api.users(params).then(function (data) {
      current = data;
      body.innerHTML = paint(data, ctx);
    }, function (err) {
      body.innerHTML = ui.banner('bad',
        '<b>Could not load users.</b> ' + ui.esc(err.message || 'request failed'));
    });
  }

  /* A date input gives midnight. "Joined up to the 14th" means the whole of
     the 14th, so the upper bound is the end of that day — otherwise a filter
     for a single day returns nothing, which reads as a broken filter. */
  function endOfDay(value) {
    var ms = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(ms) ? ms + 86399999 : undefined;
  }

  function paint(data, ctx) {
    if (!data.users.length) {
      return (query.q
        ? ui.emptyState('No match for "' + query.q + '"',
            'Email, UID and phone match exactly; names match from the start. ' +
            'Try the full email address, or the first words of the shop name.')
        : ui.emptyState('No users match this filter',
            'Change the filter or clear the date range.'));
    }

    var rows = data.users.map(function (u) { return rowHTML(u); }).join('');

    var footer =
      '<div class="adm__filters" style="margin:14px 0 0;justify-content:space-between">' +
      '<span class="adm__hint" style="margin:0">' +
        'Showing ' + data.users.length + (data.approximate ? ' matching rows' : ' of this page') +
        (data.sortScope === 'page'
          ? ' · sorted within this page only, because revenue is derived from payments'
          : '') +
      '</span>' +
      '<span>' +
        '<button class="adm__btn" data-act="back"' + (cursors.length ? '' : ' disabled') + '>Back</button> ' +
        '<button class="adm__btn" data-act="next"' + (data.nextCursor ? '' : ' disabled') + '>Next</button>' +
      '</span></div>';

    return tableShell(rows) + footer;
  }

  function rowHTML(u) {
    var seen = u.lastActiveAt || u.lastLoginAt;

    return '<tr data-uid="' + ui.esc(u.uid) + '">' +
      '<td><div class="adm__who">' + ui.avatar(u) + '<div>' +
        '<b>' + ui.text(u.mobileShopName || u.displayName) + '</b>' +
        '<span>' + ui.text(u.proprietorName) + '</span>' +
      '</div></div></td>' +

      '<td><div>' + ui.text(u.email) + '</div>' +
        /* Absent when the role has no users.read_contact — the server removes
           the key, so this renders a dash without knowing why, which is
           exactly right. */
        '<span class="adm__none" style="font-size:12px">' +
        (u.mobileNumber ? ui.esc(u.mobileNumber) : ui.DASH) + '</span></td>' +

      '<td>' + ui.pill(u.accountState) +
        (u.accountStatus === 'disabled' ? ' ' + ui.pill('disabled') : '') + '</td>' +

      '<td>' + ui.pill(u.subscription.status) +
        (u.subscription.planId
          ? ' <span class="adm__none" style="font-size:12px">' + ui.esc(u.subscription.planId) + '</span>'
          : '') + '</td>' +

      '<td class="num">' +
        (u.billing.totalPaidPaise !== undefined
          ? ui.money(u.billing.totalPaidPaise)
          : ui.count(u.billing.successfulPayments)) + '</td>' +

      '<td>' + ui.date(u.createdAt) + '</td>' +
      '<td>' + ui.ago(seen) + '</td>' +
      '</tr>';
  }

  ADM.pages = ADM.pages || {};
  ADM.pages.users = { render: render };
})(window);
