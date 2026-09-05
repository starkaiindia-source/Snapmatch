/* ============================================================================
   Mobile Parts Finder · admin/pages/user-detail.js
   ----------------------------------------------------------------------------
   One account, in full: identity, shop profile, authentication, subscription,
   payments and a timeline.

   Every section prints what is stored and an em dash for what is not. There is
   no computed "probably" anywhere on this page — an admin reading it is often
   about to tell a customer something, and a plausible guess would be a lie
   told with confidence.

   The account facts, the billing records and the analytics events are merged
   into one timeline by the server. That is why the event log is a log: adding
   a new event type to the schema makes it appear here without touching this
   file.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, ADM = SM.adm, ui = ADM.ui;

  function render(host, ctx, uid) {
    host.innerHTML =
      '<div class="adm__head"><div>' +
      '<h1>User</h1><p class="mono">' + ui.esc(uid) + '</p>' +
      '</div><button class="adm__btn" data-act="back">Back to users</button></div>' +
      '<div class="adm__card"><div class="adm__skel" style="height:80px"></div></div>';

    host.addEventListener('click', function (e) {
      if (e.target.closest('[data-act="back"]')) ctx.go('/admin/users');
    });

    ADM.api.user(uid).then(function (data) {
      paint(host, ctx, data.user);
    }, function (err) {
      host.querySelector('.adm__card').outerHTML = err.status === 404
        ? ui.emptyState('No such account',
            'Neither Firebase Authentication nor the profile collection has this uid.')
        : ui.banner('bad', '<b>Could not load this user.</b> ' +
            ui.esc(err.message || 'request failed'));
    });
  }

  function paint(host, ctx, u) {
    var out =
      '<div class="adm__head"><div>' +
      '<h1>' + ui.text(u.mobileShopName || u.displayName || u.email) + '</h1>' +
      '<p class="mono">' + ui.esc(u.uid) + '</p>' +
      '</div><button class="adm__btn" data-act="back">Back to users</button></div>';

    /* An account that signed in and never got a profile document. A real state
       with a real cause — the tab was closed before /api/profile-sync
       finished — and worth naming, because every field below will be a dash
       and that would otherwise look like a bug. */
    if (!u.hasProfileRecord) {
      out += ui.banner('warn',
        '<b>No profile record.</b> This account exists in Firebase Authentication ' +
        'but has no document in the users collection. It is created on the next ' +
        'sign-in; until then only the authentication fields below are known.');
    }

    if (u.missingProfileFields && u.missingProfileFields.length) {
      out += ui.banner('info',
        '<b>Profile incomplete.</b> Still missing: ' +
        ui.esc(u.missingProfileFields.join(', ')) +
        '. Address is optional and is not counted.');
    }

    out += '<div class="adm__grid2">';

    /* ---- overview ---- */
    out += card('Overview',
      '<div class="adm__who" style="margin-bottom:12px">' + ui.avatar(u) +
      '<div><b>' + ui.text(u.displayName) + '</b>' +
      '<span>' + ui.text(u.email) + '</span></div></div>' +
      defs([
        ['Firebase UID', '<span class="mono">' + ui.esc(u.uid) + '</span>'],
        ['Account state', ui.pill(u.accountState)],
        ['Account status', ui.pill(u.accountStatus)],
        ['Subscription state', ui.pill(u.subscriptionState)],
        ['Email verified', u.emailVerified === null ? ui.text(null) : (u.emailVerified ? 'Yes' : 'No')]
      ]));

    /* ---- shop ---- */
    var address = u.address || {};
    out += card('Shop profile', defs([
      ['Mobile shop name', ui.text(u.mobileShopName)],
      ['Proprietor', ui.text(u.proprietorName)],
      ['Mobile number', ui.text(u.mobileNumber)],
      ['E.164', ui.text(u.mobileNumberE164)],
      ['Country', ui.text(u.country)],
      ['Country code', ui.text(u.countryCode)],
      ['Flat / building', ui.text(address.flat)],
      ['Area', ui.text(address.area)],
      ['City', ui.text(address.city)],
      ['District', ui.text(address.district)],
      ['State', ui.text(address.state)]
    ]));

    /* ---- auth ---- */
    out += card('Authentication', defs([
      ['Provider', ui.text(u.authProvider)],
      ['Account created', ui.date(u.createdAt)],
      ['Last sign-in', u.lastLoginAt ? ui.dateTime(u.lastLoginAt) + ' (' + ui.ago(u.lastLoginAt) + ')' : ui.text(null)],
      ['Last active', u.lastActiveAt ? ui.ago(u.lastActiveAt) : ui.text(null)],
      ['Record updated', ui.date(u.updatedAt)],
      ['Disabled in Firebase', u.disabled === null ? ui.text(null) : (u.disabled ? 'Yes' : 'No')]
    ]));

    /* ---- subscription ---- */
    out += card('Subscription', defs([
      ['Current plan', ui.text(u.subscription.planId)],
      ['Status', ui.pill(u.subscription.status)],
      ['Started', ui.date(u.subscription.startedAt)],
      ['Renews / expires', ui.date(u.subscription.expiresAt)],
      ['Current order', u.subscription.subscriptionId
        ? '<span class="mono">' + ui.esc(u.subscription.subscriptionId) + '</span>' : ui.text(null)],
      ['Last verified', ui.date(u.subscription.lastVerifiedAt)],
      ['Total paid', u.billing.totalPaidPaise !== undefined
        ? ui.money(u.billing.totalPaidPaise) : ui.text(null)],
      ['Successful payments', ui.count(u.billing.successfulPayments)],
      ['Failed payments', ui.count(u.billing.failedPayments)],
      ['Most recent payment', ui.date(u.billing.lastPaymentAt)]
    ]));

    out += '</div>';

    /* ---- payments ---- */
    out += '<div class="adm__card" style="margin-top:16px"><h2>Payment history</h2>' +
      '<p class="adm__hint">Razorpay payment and order references. No card, UPI or bank ' +
      'detail is stored by this system or reachable from it.</p>' +
      (u.payments && u.payments.length ? paymentsTable(u.payments)
        : ui.emptyState('No payments', 'This account has never completed a payment.')) +
      '</div>';

    /* ---- timeline ---- */
    out += '<div class="adm__card" style="margin-top:16px"><h2>Activity</h2>' +
      '<p class="adm__hint">Account facts, billing records and analytics events, newest ' +
      'first. Events only exist from the day the collector was switched on.</p>' +
      (u.timeline && u.timeline.length ? timelineHTML(u.timeline)
        : ui.emptyState('Nothing recorded yet')) +
      '</div>';

    host.innerHTML = out;
    host.addEventListener('click', function (e) {
      if (e.target.closest('[data-act="back"]')) ctx.go('/admin/users');
    });
  }

  function card(title, inner) {
    return '<div class="adm__card"><h2>' + ui.esc(title) + '</h2>' + inner + '</div>';
  }

  function defs(rows) {
    return '<dl class="adm__defs">' + rows.map(function (r) {
      return '<dt>' + ui.esc(r[0]) + '</dt><dd>' + r[1] + '</dd>';
    }).join('') + '</dl>';
  }

  function paymentsTable(payments) {
    return '<div class="adm__scroll"><table class="adm__table">' +
      '<thead><tr><th>Date</th><th>Plan</th><th class="num">Amount</th><th>Status</th>' +
      '<th>Payment ID</th><th>Order ID</th><th>Verified by</th></tr></thead><tbody>' +
      payments.map(function (p) {
        return '<tr style="cursor:default">' +
          '<td>' + ui.date(p.paidAt || p.createdAt) + '</td>' +
          '<td>' + ui.text(p.planId) + '</td>' +
          '<td class="num">' + ui.money(p.amountPaise) + '</td>' +
          '<td>' + ui.pill(p.paymentStatus) +
            (p.failureReason ? '<div class="adm__none" style="font-size:11px">' +
              ui.esc(p.failureReason) + '</div>' : '') + '</td>' +
          '<td class="mono">' + ui.text(p.providerPaymentId) + '</td>' +
          '<td class="mono">' + ui.text(p.providerOrderId) + '</td>' +
          '<td>' + ui.text(p.verifiedBy) + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function timelineHTML(items) {
    return '<ul class="adm__timeline">' + items.map(function (i) {
      var detail = i.detail && Object.keys(i.detail).length
        ? '<code>' + ui.esc(Object.keys(i.detail)
            .filter(function (k) { return i.detail[k] !== null && i.detail[k] !== undefined; })
            .map(function (k) { return k + ': ' + i.detail[k]; }).join('  ·  ')) + '</code>'
        : '';
      return '<li><time>' + ui.dateTime(i.at) + '</time>' +
        '<div><b>' + ui.esc(String(i.label || i.type).replace(/_/g, ' ')) + '</b>' +
        detail + '</div></li>';
    }).join('') + '</ul>';
  }

  ADM.pages = ADM.pages || {};
  ADM.pages.userDetail = { render: render };
})(window);
