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

   ----------------------------------------------------------------------------
   ASSIGN / CHANGE PLAN

   The Subscription card is also where an administrator gives an account a
   plan by hand: ₹99 Monthly, ₹799 Yearly, or Lifetime — which is offered here
   and nowhere a customer can reach.

   The control is drawn only when the server says this role may use it
   (`subscriptions.write`). That is a courtesy. The server checks the same
   permission on the POST, so a role that conjures the form still gets a 403,
   and it is that check — not the missing button — that keeps support and
   analyst accounts from handing out the product.

   Nothing on this page records a payment. The form says so beside the button,
   because the person pressing it is often doing so BECAUSE of a payment they
   have just looked up, and must not come away thinking this system verified
   it.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, ADM = SM.adm, ui = ADM.ui;

  /* What the page is showing, kept so a click can act on it and a successful
     change can repaint without a full reload. One user page is open at a
     time, so one of these is enough. */
  var view = { uid: null, user: null, sub: null, formOpen: false, revokeOpen: false, busy: false };

  function render(host, ctx, uid) {
    view = { uid: uid, user: null, sub: null, formOpen: false, revokeOpen: false, busy: false };

    host.innerHTML =
      '<div class="adm__head"><div>' +
      '<h1>User</h1><p class="mono">' + ui.esc(uid) + '</p>' +
      '</div><button class="adm__btn" data-act="back">Back to users</button></div>' +
      '<div class="adm__card"><div class="adm__skel" style="height:80px"></div></div>';

    /* ONE listener each, however many times this page has been opened. The
       host element outlives the page it shows, so listeners added on every
       render pile up — harmless for "Back", and a plan assigned three times
       over for "Assign". The previous pair is taken off before this one goes
       on. */
    if (host.__udClick) host.removeEventListener('click', host.__udClick);
    if (host.__udSubmit) host.removeEventListener('submit', host.__udSubmit);
    if (host.__udChange) host.removeEventListener('change', host.__udChange);
    host.__udClick = function (e) { onClick(e, host, ctx); };
    host.__udSubmit = function (e) { onSubmit(e, host, ctx); };
    host.__udChange = function (e) { onChange(e, host); };
    host.addEventListener('click', host.__udClick);
    host.addEventListener('submit', host.__udSubmit);
    host.addEventListener('change', host.__udChange);

    load(host, ctx);
  }

  function load(host, ctx) {
    var uid = view.uid;

    /* The entitlement panel is a second request and its failure must not take
       the page with it: the account, its payments and its timeline are still
       worth reading when the plan controls cannot be loaded. */
    var subscription = ctx.can('billing.read')
      ? ADM.api.subscription(uid).catch(function (err) { return { failed: err }; })
      : Promise.resolve(null);

    Promise.all([ADM.api.user(uid), subscription]).then(function (results) {
      if (view.uid !== uid) return;                    /* navigated away meanwhile */
      view.user = results[0].user;
      view.sub = results[1];
      paint(host, ctx);
    }, function (err) {
      if (view.uid !== uid) return;
      var card = host.querySelector('.adm__card');
      if (!card) return;
      card.outerHTML = err.status === 404
        ? ui.emptyState('No such account',
            'Neither Firebase Authentication nor the profile collection has this uid.')
        : ui.banner('bad', '<b>Could not load this user.</b> ' +
            ui.esc(err.message || 'request failed'));
    });
  }

  /* ---------------------------------------------------------------- events */

  function onClick(e, host, ctx) {
    if (e.target.closest('[data-act="back"]')) { ctx.go('/admin/users'); return; }

    if (e.target.closest('[data-act="plan-open"]')) {
      view.formOpen = true;
      view.revokeOpen = false;
      paint(host, ctx);
      var first = host.querySelector('#admPlanForm input[name="planId"]:checked') ||
                  host.querySelector('#admPlanForm input[name="planId"]');
      if (first) first.focus();
      return;
    }
    if (e.target.closest('[data-act="plan-cancel"]')) {
      view.formOpen = false;
      view.revokeOpen = false;
      paint(host, ctx);
      return;
    }
    /* Opens a form rather than acting. Taking access away is the one thing on
       this page that should not happen on a single stray click. */
    if (e.target.closest('[data-act="plan-revoke"]')) {
      view.revokeOpen = true;
      view.formOpen = false;
      paint(host, ctx);
      var reason = host.querySelector('#admRevokeForm input[name="reason"]');
      if (reason) reason.focus();
    }
  }

  /* Extending only means anything for the plan that is already running, so
     the choice is enabled for that one plan and switched back to "today" for
     any other. */
  function onChange(e, host) {
    if (!e.target.closest('#admPlanForm') || e.target.name !== 'planId') return;
    syncMode(host);
  }

  function syncMode(host) {
    var form = host.querySelector('#admPlanForm');
    if (!form) return;
    var mode = form.querySelector('select[name="mode"]');
    if (!mode) return;
    var picked = form.querySelector('input[name="planId"]:checked');
    var extendable = !!picked && picked.value === form.getAttribute('data-extendable');
    mode.disabled = !extendable;
    if (!extendable) mode.value = 'replace';
  }

  function onSubmit(e, host, ctx) {
    var revokeForm = e.target.closest('#admRevokeForm');
    if (revokeForm) {
      e.preventDefault();
      revoke(host, ctx, String(new FormData(revokeForm).get('reason') || '').trim());
      return;
    }

    var form = e.target.closest('#admPlanForm');
    if (!form) return;
    e.preventDefault();
    if (view.busy) return;

    var data = new FormData(form);
    var planId = String(data.get('planId') || '');
    if (!planId) { ctx.toast('Choose a plan first', 'warn'); return; }

    var plan = planById(planId);
    var label = plan ? plan.label : planId;
    var who = (view.user && (view.user.email || view.user.uid)) || view.uid;
    var mode = String(data.get('mode') || 'replace');

    /* The last chance to notice the wrong account or the wrong plan. Lifetime
       says what it means, because it is the one choice with no end date and
       no way for the customer to have bought it. */
    var question = planId === 'lifetime'
      ? 'Give LIFETIME access to ' + who + '?\n\nIt never expires. Only an administrator can take it away.'
      : (mode === 'extend' ? 'Add one more period of ' : 'Assign ') + label + ' to ' + who + '?';
    if (!global.confirm(question + '\n\nNo payment will be recorded.')) return;

    send({
      action: 'assign',
      uid: view.uid,
      planId: planId,
      mode: mode,
      reason: String(data.get('reason') || '').trim(),
      reference: String(data.get('reference') || '').trim()
    }, host, ctx, function (r) {
      return 'Plan updated: ' + plainPlan(r.entitlement) +
        (r.entitlement.isLifetime ? ' — never expires' : '');
    });
  }

  function revoke(host, ctx, reason) {
    if (view.busy) return;
    var who = (view.user && (view.user.email || view.user.uid)) || view.uid;
    if (!global.confirm('Revoke access for ' + who + '?\n\n' +
        'Search and compatibility groups are blocked on their next request. ' +
        'Nothing is deleted and no refund is made.')) return;

    send({ action: 'revoke', uid: view.uid, reason: reason || '' }, host, ctx,
      function (r) { return r.alreadyRevoked ? 'Access was already revoked' : 'Access revoked'; });
  }

  function send(body, host, ctx, message) {
    view.busy = true;
    setBusy(host, true);

    ADM.api.changeSubscription(body).then(function (r) {
      view.busy = false;
      view.formOpen = false;
      view.revokeOpen = false;
      ctx.toast(message(r));
      /* Re-read both halves rather than patching the page from the response:
         the timeline, the record list and the history all changed with it. */
      load(host, ctx);
    }, function (err) {
      view.busy = false;
      setBusy(host, false);
      var detail = err.data && err.data.detail;
      ctx.toast(
        err.status === 403 ? 'Your role may not change subscriptions'
        : (err.message || 'Could not change the plan') + (detail ? ' — ' + detail : ''),
        'bad');
    });
  }

  function setBusy(host, busy) {
    Array.prototype.forEach.call(
      host.querySelectorAll('#admPlanForm button, #admRevokeForm button, ' +
        '[data-act="plan-open"], [data-act="plan-revoke"]'),
      function (b) { b.disabled = busy; });
  }

  function planById(id) {
    var plans = (view.sub && view.sub.plans) || [];
    for (var i = 0; i < plans.length; i++) if (plans[i].id === id) return plans[i];
    return null;
  }

  /** "₹799 Yearly" as text, for a toast. */
  function plainPlan(ent) {
    if (!ent || !ent.planType) return 'no plan';
    return (ent.price != null ? '₹' + ent.price + ' ' : '') + (ent.planName || ent.planType);
  }

  /* ----------------------------------------------------------------- paint */

  function paint(host, ctx) {
    var u = view.user;
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
    out += subscriptionCard(u, ctx);

    out += '</div>';

    /* ---- what administrators did to this plan ---- */
    out += planHistoryCard();

    /* ---- payments ---- */
    out += '<div class="adm__card" style="margin-top:16px"><h2>Payment history</h2>' +
      '<p class="adm__hint">Razorpay payment and order references. No card, UPI or bank ' +
      'detail is stored by this system or reachable from it. A plan an administrator ' +
      'assigned by hand is not a payment and does not appear here.</p>' +
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
    syncMode(host);
  }

  /* The Subscription card: what the account holds, and — for a role that may
     — the control that changes it. */
  function subscriptionCard(u, ctx) {
    var s = u.subscription;
    var sub = view.sub && !view.sub.failed ? view.sub : null;
    var canWrite = !!(sub && sub.canWrite && ctx.can('subscriptions.write'));

    var rows = [
      ['Current plan', '<b>' + ui.planLabel(s) + '</b>'],
      ['Status', ui.pill(s.status)],
      ['Activated', ui.date(s.startedAt)],
      ['Expires', ui.expiryLabel(s)],
      ['Source', ui.sourceLabel(s.source)]
    ];
    if (s.status === 'revoked') rows.push(['Revoked', ui.date(s.revokedAt)]);
    rows = rows.concat([
      ['Current record', s.subscriptionId
        ? '<span class="mono">' + ui.esc(s.subscriptionId) + '</span>' : ui.text(null)],
      ['Last verified payment', ui.date(s.lastVerifiedAt)],
      ['Total paid', u.billing.totalPaidPaise !== undefined
        ? ui.money(u.billing.totalPaidPaise) : ui.text(null)],
      ['Successful payments', ui.count(u.billing.successfulPayments)],
      ['Failed payments', ui.count(u.billing.failedPayments)],
      ['Most recent payment', ui.date(u.billing.lastPaymentAt)]
    ]);

    var inner = defs(rows);

    if (view.sub && view.sub.failed) {
      inner += ui.banner('warn', '<b>Plan controls unavailable.</b> ' +
        ui.esc(view.sub.failed.message || 'The server did not answer.') +
        ' The details above are still current.');
    } else if (canWrite) {
      inner += view.formOpen
        ? planFormHTML(s, sub.plans)
        : view.revokeOpen && s.isActive
        ? revokeFormHTML(s)
        : '<div class="adm__planbar">' +
            '<button class="adm__btn adm__btn--primary" data-act="plan-open">Assign / Change Plan</button>' +
            (s.isActive
              ? '<button class="adm__btn adm__btn--danger" data-act="plan-revoke">Revoke access</button>'
              : '') +
          '</div>';
    }

    return card('Subscription', inner);
  }

  function planFormHTML(s, plans) {
    /* The plan that is running, when it is one that has a period to add to. */
    var extendable = s.isActive && !s.isLifetime && s.planId ? s.planId : '';

    return '<form class="adm__planform" id="admPlanForm" data-extendable="' + ui.esc(extendable) + '">' +
      '<fieldset><legend>Assign / Change Plan</legend>' +
      plans.map(function (p) {
        return '<label class="adm__planopt"><input type="radio" name="planId" value="' +
          ui.esc(p.id) + '"' + (p.id === s.planId && s.isActive ? ' checked' : '') + ' />' +
          '<span><b>' + ui.esc(p.label) + '</b>' +
          '<small>' + ui.esc(planHelp(p)) + '</small></span></label>';
      }).join('') +
      '</fieldset>' +

      '<label class="adm__planfield">Starts' +
        '<select name="mode">' +
        '<option value="replace">A new period, from today</option>' +
        '<option value="extend">Add to the end of the period already running</option>' +
        '</select></label>' +

      '<label class="adm__planfield">Reason' +
        '<input type="text" name="reason" maxlength="200" ' +
        'placeholder="Why this account is being given this plan" /></label>' +

      '<label class="adm__planfield">Reference you checked' +
        '<input type="text" name="reference" maxlength="120" ' +
        'placeholder="Optional — a UTR or transaction id you verified yourself" /></label>' +

      '<p class="adm__hint" style="margin:10px 0 12px">This sets the entitlement directly. ' +
        '<b>No payment is recorded</b> and nothing is checked with Razorpay — a reference ' +
        'typed here is your own note. The change is written to the audit trail with your ' +
        'account.</p>' +

      '<div class="adm__planbar" style="margin-top:0">' +
        '<button class="adm__btn adm__btn--primary" type="submit">Assign plan</button>' +
        '<button class="adm__btn" type="button" data-act="plan-cancel">Cancel</button>' +
      '</div></form>';
  }

  function revokeFormHTML(s) {
    return '<form class="adm__planform" id="admRevokeForm">' +
      '<fieldset><legend>Revoke access</legend>' +
      '<p class="adm__hint" style="margin:0 0 10px">Ends this account’s ' +
        ui.planLabel(s) + ' access on its next request, whatever the expiry date says. ' +
        'Nothing is deleted and <b>no refund is made</b> — a payment is refunded in ' +
        'Razorpay, separately. The plan can be assigned again afterwards.</p>' +
      '</fieldset>' +
      '<label class="adm__planfield">Reason' +
        '<input type="text" name="reason" maxlength="200" ' +
        'placeholder="Why access is being withdrawn — kept in the audit trail" /></label>' +
      '<div class="adm__planbar" style="margin-top:0">' +
        '<button class="adm__btn adm__btn--danger" type="submit">Revoke access</button>' +
        '<button class="adm__btn" type="button" data-act="plan-cancel">Cancel</button>' +
      '</div></form>';
  }

  function planHelp(p) {
    if (p.id === 'lifetime') return 'No payment, no expiry. Ends only if an administrator revokes it.';
    return p.periodMonths === 12 ? 'Access for twelve months.' : 'Access for one month.';
  }

  /* The audit entries for this account's entitlement, in plain words. */
  function planHistoryCard() {
    var sub = view.sub && !view.sub.failed ? view.sub : null;
    if (!sub) return '';

    var body = sub.history && sub.history.length
      ? '<div class="adm__scroll"><table class="adm__table"><thead><tr>' +
        '<th>When</th><th>Action</th><th>From</th><th>To</th><th>Expiry</th>' +
        '<th>By</th><th>Reason</th></tr></thead><tbody>' +
        sub.history.map(function (h) {
          var d = h.detail || {};
          return '<tr style="cursor:default">' +
            '<td>' + ui.dateTime(h.at) + '</td>' +
            '<td>' + ui.text(String(d.actionType || h.action || '').replace(/_/g, ' ')) + '</td>' +
            '<td>' + ui.text(d.previousPlan) +
              '<div class="adm__none" style="font-size:11px">' + ui.text(d.previousStatus) + '</div></td>' +
            '<td>' + ui.text(d.newPlan) +
              '<div class="adm__none" style="font-size:11px">' + ui.text(d.newStatus) + '</div></td>' +
            '<td>' + auditExpiry(d.newExpiresAt) + '</td>' +
            '<td>' + ui.text(d.adminEmail || h.actorUid) + '</td>' +
            '<td>' + ui.text(d.reason) +
              (d.reference ? '<div class="adm__none mono" style="font-size:11px">ref ' +
                ui.esc(d.reference) + '</div>' : '') + '</td>' +
            '</tr>';
        }).join('') + '</tbody></table></div>'
      : ui.emptyState('No manual changes',
          'Nobody has assigned, changed or revoked this account’s plan by hand.');

    return '<div class="adm__card" style="margin-top:16px"><h2>Plan changes by administrators</h2>' +
      '<p class="adm__hint">Every plan assigned, changed, extended or revoked by hand. ' +
      'Written with the change itself, so it cannot be missing.</p>' + body + '</div>';
  }

  /** An expiry as the audit entry stores it: a date, "never", or "none". */
  function auditExpiry(value) {
    if (value === 'never') return 'Never';
    if (value === 'none' || value === undefined || value === null || value === '') return ui.text(null);
    return ui.date(value);
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
