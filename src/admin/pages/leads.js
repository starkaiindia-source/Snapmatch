/* ============================================================================
   Mobile Parts Finder · admin/pages/leads.js
   ----------------------------------------------------------------------------
   Leads: everyone who asked to buy the 9H screen guard on Instagram, and how far
   each has got. Price sent, models given, address given, billed, paid.

   The conversation is what the bot and the customer said, so the owner can step
   in. A lead marked "needs you" asked something the bot does not answer.

   While this page is open it also reads Instagram every minute, the same as the
   Auto Reply page, so new messages and follow-ups do not wait for anyone else.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, ADM = SM.adm, ui = ADM.ui;

  var STAGES = [
    ['price_sent', 'Price sent', 'info'], ['models', 'Choosing models', 'info'], ['address', 'Asked address', 'warn'],
    ['billed', 'Billed', 'warn'], ['paid', 'Paid', 'ok'], ['won', 'Won', 'ok'], ['lost', 'Lost', '']
  ];
  var byId = {};
  STAGES.forEach(function (s) { byId[s[0]] = s; });

  function rupees(p) { return '₹' + Math.round((p || 0) / 100).toLocaleString('en-IN'); }
  function pill(stage) {
    var s = byId[stage] || [stage, stage, ''];
    return '<span class="adm__pill' + (s[2] ? ' adm__pill--' + s[2] : '') + '">' + ui.esc(s[1]) + '</span>';
  }

  function leadHTML(l) {
    var boxes = (l.items || []).reduce(function (n, i) { return n + i.boxes; }, 0);
    var a = l.address || {};
    return '<article class="ar-item ld-item" data-id="' + ui.esc(l.id) + '">' +
      '<div class="ar-row"><b>' + (l.username ? '@' + ui.esc(l.username) : 'Instagram user') + '</b>' + pill(l.stage) +
      (l.needsHuman ? '<span class="adm__pill adm__pill--bad">Needs you</span>' : '') +
      '<span class="adm__none">' + ui.esc(l.source === 'comment' ? 'from a comment' : 'from a message') + ' · ' + ui.esc(ui.ago(l.updatedAt)) +
      (l.followUps ? ' · ' + l.followUps + ' follow-up' + (l.followUps > 1 ? 's' : '') : '') + '</span></div>' +
      ((l.items || []).length ? '<p>' + l.items.map(function (i) { return ui.esc(i.master) + ' × ' + i.boxes; }).join(', ') +
        ' <span class="adm__none">(' + boxes + ' boxes)</span></p>' : '') +
      (a.name ? '<p class="adm__none">' + ui.esc([a.name, a.phone, a.address, a.city, a.state, a.pincode].filter(Boolean).join(', ')) + '</p>' : '') +
      (l.billId ? '<p><b>' + rupees(l.totalPaise) + '</b> incl. courier ' + rupees(l.courierPaise) + ' (' + ui.esc(l.courierZone || '') + ') · ' +
        '<a href="/billing/bills/' + encodeURIComponent(l.billId) + '" target="_blank" rel="noopener">Bill ' + ui.esc(l.billNumber || '') + '</a>' +
        (l.payUrl ? ' · <a href="' + ui.esc(l.payUrl) + '" target="_blank" rel="noopener">Payment link</a>' : ' · <span class="adm__none">no payment link: Razorpay not connected</span>') + '</p>' : '') +
      '<details><summary>Conversation</summary><ol class="ld-log">' + (l.log || []).map(function (m) {
        return '<li class="' + (m.who === 'bot' ? 'is-bot' : '') + '"><span>' + ui.esc(ui.ago(m.at)) + '</span>' + ui.esc(m.text) + '</li>';
      }).join('') + '</ol></details>' +
      '<div class="ar-row">' + (l.stage !== 'won' ? '<button class="adm__btn" data-stage="won">Mark won</button>' : '') +
      (l.stage !== 'lost' ? '<button class="adm__btn" data-stage="lost">Mark lost</button>' : '') + '</div></article>';
  }

  function render(host, ctx) {
    host.innerHTML = '';
    var root = document.createElement('div');
    host.appendChild(root);
    var state = { leads: [], filter: 'open' };

    function visible() {
      return state.leads.filter(function (l) {
        return state.filter === 'all' || (state.filter === 'open' ? ['price_sent', 'models', 'address', 'billed'].indexOf(l.stage) > -1 : l.stage === state.filter);
      });
    }
    function paint() {
      var count = function (st) { return state.leads.filter(function (l) { return l.stage === st; }).length; };
      var won = state.leads.filter(function (l) { return l.stage === 'paid' || l.stage === 'won'; });
      var value = won.reduce(function (n, l) { return n + (l.totalPaise || 0); }, 0);
      var list = visible();
      root.innerHTML = '<div class="adm__head"><div><h1>Leads</h1><p>People who asked to buy on Instagram, and where each one is.</p></div></div>' +
        '<dl class="adm__tiles">' + [['Open', state.leads.length - count('paid') - count('won') - count('lost')], ['Billed', count('billed')],
          ['Paid', count('paid') + count('won')], ['Paid value', rupees(value)], ['Need you', state.leads.filter(function (l) { return l.needsHuman; }).length]]
          .map(function (t) { return '<div class="adm__tile"><dt>' + t[0] + '</dt><dd>' + t[1] + '</dd></div>'; }).join('') + '</dl>' +
        '<div class="ar-tabs">' + [['open', 'Open'], ['billed', 'Billed'], ['paid', 'Paid'], ['lost', 'Lost'], ['all', 'All']].map(function (f) {
          return '<span role="button" tabindex="0" data-filter="' + f[0] + '" class="' + (state.filter === f[0] ? 'is-on' : '') + '">' + f[1] + '</span>';
        }).join('') + '</div>' +
        '<div class="adm__card">' + (list.length ? list.map(leadHTML).join('')
          : ui.emptyState('No leads here', 'Someone commenting "9H" or asking the price starts one.')) + '</div>';
    }
    function load() {
      ADM.api.autoReply({ view: 'leads' }).then(function (r) {
        state.leads = r.leads || [];
        paint();
      }, function (err) {
        root.innerHTML = '<div class="adm__head"><h1>Leads</h1></div>' + ui.banner('bad', '<b>Could not load.</b> ' + ui.esc(err.message || 'request failed'));
      });
    }

    root.addEventListener('click', function (e) {
      var f = e.target.closest('[data-filter]');
      if (f) { state.filter = f.getAttribute('data-filter'); paint(); return; }
      var b = e.target.closest('[data-stage]');
      if (!b) return;
      var id = b.closest('[data-id]').getAttribute('data-id');
      ADM.api.autoReplyAction({ action: 'lead', id: id, stage: b.getAttribute('data-stage') }).then(function () {
        ctx.toast('Saved');
        load();
      }, function (err) { ctx.toast(err.message || 'Could not save', 'bad'); });
    });

    var timer = global.setInterval(function () {
      if (!document.body.contains(root)) { global.clearInterval(timer); return; }
      ADM.api.autoReplyAction({ action: 'poll' }).then(load, load);
    }, 60000);

    root.innerHTML = '<div class="adm__head"><div><h1>Leads</h1></div></div><div class="adm__card"><div class="adm__skel" style="height:60px"></div></div>';
    load();
  }

  ADM.pages = ADM.pages || {};
  ADM.pages.leads = { render: render };
})(window);
