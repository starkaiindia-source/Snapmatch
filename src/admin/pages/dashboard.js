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

    /* An index that has not finished building makes a count() throw, and the
       service reports null rather than failing the page. Saying so once at the
       top beats leaving an admin to wonder why four tiles are dashes. */
    if (hasMissingCounts(d)) {
      out += ui.banner('warn',
        '<b>Some figures are unavailable.</b> They need Firestore indexes that are ' +
        'not built yet — run <code>firebase deploy --only firestore:indexes</code>, ' +
        'then give Firestore a few minutes. Tiles showing an em dash were not counted; ' +
        'they are not zero.');
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

    /* ---- growth ---- */
    out += '<div class="adm__grid2" style="margin-top:16px">';
    out += chartCard('New users per day', d.growth.users);
    out += chartCard('New subscriptions per day', d.growth.subscriptions);
    out += '</div>';

    if (d.growth.revenuePaise) {
      out += '<div class="adm__card" style="margin-top:16px"><h2>Revenue per day</h2>' +
        '<p class="adm__hint">Captured payments, in rupees.</p>' +
        ui.barChart((d.growth.revenuePaise.points || []).map(function (p) {
          return { date: p.date, value: Math.round(p.value / 100) };
        })) +
        truncationNote(d.growth.revenuePaise) +
        '</div>';
    }

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

  function hasMissingCounts(d) {
    var checks = [d.users.total, d.users.newToday, d.subscriptions.totalActive];
    if (d.revenue) checks.push(d.revenue.lifetimePaise);
    return checks.some(function (v) { return v === null || v === undefined; });
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

  function chartCard(title, series) {
    return '<div class="adm__card"><h2>' + ui.esc(title) + '</h2>' +
      (series && series.available
        ? ui.barChart(series.points) + truncationNote(series)
        : ui.emptyState('No data yet', 'Nothing has been recorded in this window.')) +
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
