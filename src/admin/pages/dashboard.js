/* ============================================================================
   Mobile Parts Finder · admin/pages/dashboard.js
   ----------------------------------------------------------------------------
   The business overview.

   Every tile on this page is a number the server counted from production data,
   or an em dash. There is no seeded chart, no baseline, no smoothing and
   nothing invented to make a young dataset look busier than it is.

   A month with no payments draws a flat chart, and that flat chart is the
   correct answer. The alternative — a plausible curve — is a decision someone
   will make on a number that was never true.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, ADM = SM.adm, ui = ADM.ui;

  var WINDOW_DAYS = 30;

  function render(host, ctx) {
    host.innerHTML =
      '<div class="adm__head"><div>' +
      '<h1>Dashboard</h1>' +
      '<p>Live figures from production. Last ' + WINDOW_DAYS + ' days where a window applies.</p>' +
      '</div></div>' +
      '<div class="adm__card"><div class="adm__tiles">' +
      new Array(8).fill('<div class="adm__tile"><div class="adm__skel"></div>' +
                        '<div class="adm__skel" style="height:24px;margin-top:8px"></div></div>').join('') +
      '</div></div>';

    ADM.api.metrics(WINDOW_DAYS).then(function (data) {
      host.innerHTML = paint(data, ctx);
    }, function (err) {
      host.innerHTML =
        '<div class="adm__head"><h1>Dashboard</h1></div>' +
        ui.banner('bad', '<b>Could not load metrics.</b> ' + ui.esc(err.message || 'request failed'));
    });
  }

  function paint(d, ctx) {
    var out =
      '<div class="adm__head"><div>' +
      '<h1>Dashboard</h1>' +
      '<p>Generated ' + ui.dateTime(d.generatedAt) + ' · ' + d.windowDays + '-day window</p>' +
      '</div></div>';

    /* A figure the server could not count comes back null and shows as a dash.
       Name which ones, once, at the top. The cause is in the server log
       ("[metrics] …"), which carries Firestore's own words. */
    var missing = missingFigures(d);
    if (missing.length) {
      out += ui.banner('warn',
        '<b>' + missing.length + (missing.length === 1 ? ' figure' : ' figures') + ' could not be counted:</b> ' +
        ui.esc(missing.join(', ')) + '. They show a dash, not zero. Reload to try again; ' +
        'the server log ("[metrics]") has the reason.');
    }

    out += tiles('Users', [
      ['Total registered', ui.count(d.users.total)],
      ['New today', ui.count(d.users.newToday)],
      ['New this week', ui.count(d.users.newThisWeek)],
      ['New this month', ui.count(d.users.newThisMonth)],
      ['Active today', ui.count(d.users.activeToday)],
      ['Active this week', ui.count(d.users.activeThisWeek)],
      ['Active this month', ui.count(d.users.activeThisMonth)],
      ['Profile complete', ui.count(d.users.profileComplete)],
      ['Profile incomplete', ui.count(d.users.profileIncomplete)]
    ], 'Active means signed in within ' + d.users.activeWindowDays + ' days.');

    out += tiles('Subscriptions', [
      ['Active now', ui.count(d.subscriptions.totalActive)],
      ['Monthly', ui.count(d.subscriptions.monthly)],
      ['Yearly', ui.count(d.subscriptions.yearly)],
      ['Lifetime', ui.count(d.subscriptions.lifetime)],
      ['Free accounts', ui.count(d.subscriptions.free)],
      ['Expired', ui.count(d.subscriptions.expired)],
      ['Cancelled', ui.count(d.subscriptions.cancelled)],
      ['Pending orders', ui.count(d.subscriptions.pending)]
    ], 'Active is checked against the server clock, not the stored flag.');

    if (d.revenue) {
      out += tiles('Revenue', [
        ['Today', ui.money(d.revenue.todayPaise)],
        ['This week', ui.money(d.revenue.thisWeekPaise)],
        ['This month', ui.money(d.revenue.thisMonthPaise)],
        ['Lifetime', ui.money(d.revenue.lifetimePaise)],
        ['Monthly plan', ui.money(d.revenue.monthlyPlanPaise)],
        ['Yearly plan', ui.money(d.revenue.yearlyPlanPaise)],
        ['Avg per paying user', ui.money(d.revenue.averageRevenuePerPayingUserPaise)],
        ['Successful payments', ui.count(d.revenue.successfulPayments)],
        ['Failed payments', ui.count(d.revenue.failedPayments)],
        ['Paying users', ui.count(d.revenue.payingUsers)]
      ], 'Captured payments only. A failed attempt carries an amount and is not revenue.');
    } else {
      out += '<div class="adm__card"><h2>Revenue</h2>' +
        '<p class="adm__hint">Your role does not include revenue figures.</p></div>';
    }

    /* ---- growth: one colour a chart, hover a day for its value ---- */
    out += '<div class="adm__charts">';
    out += chartCard('New users per day', 'Accounts created', d.growth.users, { color: '#2B6AEB' });
    out += chartCard('New subscriptions per day', 'Paid plans started', d.growth.subscriptions, { color: '#7C3AED' });
    if (d.growth.revenuePaise) {
      var rev = d.growth.revenuePaise;
      out += chartCard('Revenue per day', 'Captured payments, in rupees', {
        available: rev.available,
        truncated: rev.truncated,
        points: (rev.points || []).map(function (p) { return { date: p.date, value: Math.round(p.value / 100) }; })
      }, { color: '#0E9F6E', rupees: true });
    }
    out += '</div>';

    /* ---- website activity ---- */
    out += '<div class="adm__card" style="margin-top:16px"><h2>Website activity</h2>';
    if (!d.activity.available) {
      out += '<p class="adm__hint">' + ui.esc(d.activity.reason || 'No analytics events recorded yet.') +
        '</p>' + ui.emptyState('No data yet',
          'Events are recorded as visitors use the site. This fills in once traffic ' +
          'reaches the new collector; nothing is shown here until it does.');
    } else {
      out += '<p class="adm__hint">Last ' + d.activity.windowDays + ' days.</p>' +
        '<div class="adm__tiles">' +
        tile('Total events', ui.count(d.activity.totalEvents)) +
        tile('Searches', ui.count(d.activity.searchesPerformed)) +
        tile('Models opened', ui.count(d.activity.modelsOpened)) +
        tile('Groups opened', ui.count(d.activity.compatibilityGroupsOpened)) +
        tile('Zero-result searches', ui.count(d.activity.zeroResultSearches)) +
        '</div>';
    }
    out += '</div>';

    /* ---- what people looked for ---- */
    if (d.tops && d.tops.available) {
      out += '<div class="adm__grid2" style="margin-top:16px">' +
        rankCard('Top search terms', d.tops.topSearchTerms) +
        rankCard('Searches with no result', d.tops.zeroResultTerms) +
        rankCard('Most opened models', d.tops.topModels) +
        rankCard('Most viewed brands', d.tops.topBrands) +
        rankCard('Most viewed categories', d.tops.topCategories) +
        '</div>';
    }

    return out;
  }

  function missingFigures(d) {
    var checks = [
      ['Total users', d.users.total], ['New users today', d.users.newToday],
      ['Active subscriptions', d.subscriptions.totalActive]
    ];
    if (d.revenue) {
      checks.push(['Lifetime revenue', d.revenue.lifetimePaise], ['Failed payments', d.revenue.failedPayments]);
    }
    var out = checks.filter(function (c) { return c[1] === null || c[1] === undefined; })
      .map(function (c) { return c[0]; });
    if (d.growth.users && d.growth.users.available === false) out.push('the users chart');
    if (d.growth.subscriptions && d.growth.subscriptions.available === false) out.push('the subscriptions chart');
    if (d.growth.revenuePaise && d.growth.revenuePaise.available === false) out.push('the revenue chart');
    return out;
  }

  function tile(label, value) {
    var isNone = value.indexOf('adm__none') > -1;
    return '<div class="adm__tile"><dt>' + ui.esc(label) + '</dt>' +
           '<dd' + (isNone ? ' class="is-none"' : '') + '>' + value + '</dd></div>';
  }

  function tiles(title, rows, hint) {
    return '<div class="adm__card" style="margin-top:16px"><h2>' + ui.esc(title) + '</h2>' +
      (hint ? '<p class="adm__hint">' + ui.esc(hint) + '</p>' : '') +
      '<dl class="adm__tiles">' + rows.map(function (r) { return tile(r[0], r[1]); }).join('') +
      '</dl></div>';
  }

  function chartCard(title, hint, series, opts) {
    opts = Object.assign({ label: title, totalLabel: 'in the last ' + ((series && series.points && series.points.length) || WINDOW_DAYS) + ' days' }, opts);
    return '<div class="adm__card adm__chartcard"><h2>' + ui.esc(title) + '</h2>' +
      '<p class="adm__hint">' + ui.esc(hint) + '</p>' +
      (series && series.available
        ? ui.barChart(series.points, opts) + truncationNote(series)
        : ui.emptyState('Not available', 'This chart could not be counted. Reload to try again.')) +
      '</div>';
  }

  /* A truncated series is a series that does not cover the whole window, and
     saying so is the difference between an honest chart and a wrong one. */
  function truncationNote(series) {
    if (!series || !series.truncated) return '';
    return '<p class="adm__hint" style="margin-top:8px">Series truncated at the scan cap — ' +
      'the earliest days in this window are not fully counted.</p>';
  }

  function rankCard(title, items) {
    return '<div class="adm__card"><h2>' + ui.esc(title) + '</h2>' +
      ui.rankList(items, 'Nothing recorded in this window yet.') + '</div>';
  }

  ADM.pages = ADM.pages || {};
  ADM.pages.dashboard = { render: render };
})(window);
