/* ============================================================================
   Mobile Parts Finder · admin/pages/leads.js
   ----------------------------------------------------------------------------
   Leads is the owner's inbox: every chat on every channel, laid out like
   Instagram on a desktop. People on the left, the open chat in the middle, the
   customer on the right.

     channels   All · Instagram · WhatsApp · Messenger, each with its logo;
                a channel that is not connected says why
     funnel     Chats · Open · Billed · Paid · Lost · Needs you · Follow-up
     chat       the real conversation, read from Meta; the AI's replies are
                marked; the owner writes, asks the AI for a draft, makes a bill,
                marks it paid, or switches the AI off for this person
     customer   their Quick Billing history (bills, total, unpaid), the order
                in progress, notes, tags, a follow-up date and their number

   Reading costs: the chat list comes from Meta. Leads and notes (Firestore,
   one read each) are read when the page opens, when the minute's poll finds
   something, or every ten minutes. An open chat is read again every 30
   seconds without its billing history, which is read once when it opens.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, ADM = SM.adm, ui = ADM.ui;

  var OPEN = ['price_sent', 'models', 'address'];
  var STAGE = {
    chat: ['Chat', ''], price_sent: ['Price sent', 'info'], models: ['Choosing models', 'info'], address: ['Asked address', 'info'],
    billed: ['Billed · unpaid', 'warn'], paid: ['Paid', 'ok'], won: ['Won', 'ok'], lost: ['Lost', '']
  };
  var FUNNEL = [
    ['all', 'All'], ['chat', 'Chats'], ['open', 'Open'], ['billed', 'Billed'], ['paid', 'Paid'],
    ['lost', 'Lost'], ['needs', 'Needs you'], ['follow', 'Follow-up']
  ];
  var CHANNELS = [['all', 'All'], ['instagram', 'Instagram'], ['whatsapp', 'WhatsApp'], ['messenger', 'Messenger']];
  var TAGS = ['VIP', 'Regular', 'Wholesale', 'Retail', 'Interested', 'Price check', 'Call back'];
  var DAY = 24 * 3600 * 1000;

  /* ------------------------------------------------------------- logos
     Simple marks of each app, so a chat says at a glance where it is. */
  function logo(channel, size) {
    var s = size || 16;
    var a = 'width="' + s + '" height="' + s + '" viewBox="0 0 24 24" aria-hidden="true" class="ib-logo"';
    if (channel === 'instagram') {
      return '<svg ' + a + '><defs><linearGradient id="ibIg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#FEDA75"/>' +
        '<stop offset=".35" stop-color="#FA7E1E"/><stop offset=".6" stop-color="#D62976"/><stop offset="1" stop-color="#4F5BD5"/></linearGradient></defs>' +
        '<rect width="24" height="24" rx="6.5" fill="url(#ibIg)"/><rect x="5.5" y="5.5" width="13" height="13" rx="4" fill="none" stroke="#fff" stroke-width="1.9"/>' +
        '<circle cx="12" cy="12" r="3.1" fill="none" stroke="#fff" stroke-width="1.9"/><circle cx="16.1" cy="7.9" r="1.05" fill="#fff"/></svg>';
    }
    if (channel === 'whatsapp') {
      return '<svg ' + a + '><circle cx="12" cy="12" r="12" fill="#25D366"/>' +
        '<path d="M12 5.2a6.8 6.8 0 0 0-5.85 10.27L5.3 18.7l3.3-.83A6.8 6.8 0 1 0 12 5.2z" fill="none" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>' +
        '<path d="M9.6 9.1c.15-.4.4-.42.6-.42h.37c.12 0 .28.02.4.33l.52 1.25c.05.12.07.27-.02.42l-.32.42c-.1.13-.1.27 0 .42.5.78 1.13 1.37 1.93 1.75.15.07.3.05.4-.07l.43-.52c.12-.15.3-.15.45-.08l1.2.57c.17.08.28.15.28.3 0 .38-.2 1.05-1.1 1.27-.67.17-1.6.07-3.05-.75-1.5-.9-2.4-2.45-2.55-2.95-.2-.62-.13-1.25.22-1.73z" fill="#fff"/></svg>';
    }
    if (channel === 'messenger') {
      return '<svg ' + a + '><defs><linearGradient id="ibFb" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#0099FF"/>' +
        '<stop offset=".6" stop-color="#A033FF"/><stop offset="1" stop-color="#FF5280"/></linearGradient></defs>' +
        '<path d="M12 1.8C6.25 1.8 1.8 6 1.8 11.7c0 2.98 1.22 5.56 3.2 7.34v3.16l2.98-1.64c1.27.35 2.6.54 4.02.54 5.75 0 10.2-4.2 10.2-9.9S17.75 1.8 12 1.8z" fill="url(#ibFb)"/>' +
        '<path d="M5.9 14.4l3.05-4.84a1.56 1.56 0 0 1 2.26-.42l2.43 1.82c.22.17.53.17.75 0l3.28-2.49c.44-.33 1.01.19.72.66l-3.05 4.84a1.56 1.56 0 0 1-2.26.42l-2.43-1.82a.62.62 0 0 0-.75 0l-3.28 2.49c-.44.33-1.01-.19-.72-.66z" fill="#fff"/></svg>';
    }
    return '<svg ' + a + '><circle cx="12" cy="12" r="11" fill="var(--surface-3)"/><path d="M7 9h10M7 12.5h7" stroke="var(--ink-2)" stroke-width="1.8" stroke-linecap="round"/></svg>';
  }

  /* ----------------------------------------------------------- helpers */
  function rupees(p) { return '₹' + Math.round((p || 0) / 100).toLocaleString('en-IN'); }
  function nameOf(t) { return t.username ? '@' + t.username : t.name || 'Customer'; }
  function initial(t) { return String(t.name || t.username || '?').replace(/^@/, '').charAt(0).toUpperCase() || '?'; }
  function when(ms) {
    if (!ms) return '';
    var d = new Date(ms), now = new Date();
    if (d.toDateString() === now.toDateString()) return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (now - d < 6 * DAY) return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    return d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  }
  function pill(stage) {
    var s = STAGE[stage] || [stage, ''];
    return '<span class="adm__pill' + (s[1] ? ' adm__pill--' + s[1] : '') + '">' + ui.esc(s[0]) + '</span>';
  }
  function avatar(t, size, picture) {
    return '<span class="ib-av" style="--s:' + (size || 44) + 'px">' +
      (picture ? '<img src="' + ui.esc(picture) + '" alt="" referrerpolicy="no-referrer" />' : '<b>' + ui.esc(initial(t)) + '</b>') +
      '<i>' + logo(t.channel, Math.round((size || 44) * 0.4)) + '</i></span>';
  }
  /* Where a customer stands with us, from what they have actually bought. */
  function segment(c) {
    if (!c || !c.billCount) return ['Prospect', ''];
    if (c.totalPaise >= 1000000) return ['Top buyer', 'ok'];
    if (c.billCount >= 3) return ['Regular', 'ok'];
    if (c.billCount === 2) return ['Repeat buyer', 'info'];
    return ['New customer', 'info'];
  }

  /* ------------------------------------------------------------- page */
  function render(host, ctx) {
    host.className = 'adm__wrap adm__wrap--full';
    host.innerHTML = '';
    var root = document.createElement('div');
    root.className = 'ib';
    host.appendChild(root);

    var state = {
      channels: null, threads: [], leads: {}, contacts: {}, channel: 'all', funnel: 'all', q: '',
      open: null, chat: null, chatErr: null, profile: global.innerWidth > 1180, billing: false, busy: false, draft: {}
    };
    var params = new URLSearchParams(location.search);
    if (params.get('chat')) state.open = params.get('chat');

    /* -------- merged view of a thread: the chat, its lead and the owner's notes */
    function stageOf(t) {
      var l = t.channel === 'instagram' && state.leads[t.userId];
      return l ? l.stage : 'chat';
    }
    function allThreads() {
      var seen = {};
      var list = state.threads.map(function (t) { seen[t.key] = true; return t; });
      /* a lead from a comment may have no chat yet */
      Object.keys(state.leads).forEach(function (id) {
        var l = state.leads[id];
        var key = 'instagram_' + id;
        if (seen[key]) return;
        list.push({ key: key, channel: 'instagram', userId: id, username: l.username, name: '', lastText: l.source === 'comment' ? '(from a comment)' : '', lastAt: l.updatedAt || 0, lastFromMe: true });
      });
      return list.sort(function (a, b) {
        var pa = (state.contacts[a.key] || {}).pinned ? 1 : 0, pb = (state.contacts[b.key] || {}).pinned ? 1 : 0;
        return pb - pa || b.lastAt - a.lastAt;
      });
    }
    function inFunnel(t, f) {
      var st = stageOf(t), l = state.leads[t.userId], c = state.contacts[t.key] || {};
      if (f === 'all') return true;
      if (f === 'chat') return st === 'chat';
      if (f === 'open') return OPEN.indexOf(st) > -1;
      if (f === 'billed') return st === 'billed';
      if (f === 'paid') return st === 'paid' || st === 'won';
      if (f === 'lost') return st === 'lost';
      if (f === 'needs') return !!(l && l.needsHuman) || (!t.lastFromMe && Date.now() - t.lastAt < DAY && st !== 'chat');
      if (f === 'follow') return !!c.followUpAt;
      return true;
    }
    function shown() {
      var q = state.q.trim().toLowerCase();
      return allThreads().filter(function (t) {
        if (state.channel !== 'all' && t.channel !== state.channel) return false;
        if (!inFunnel(t, state.funnel)) return false;
        if (q) {
          var c = state.contacts[t.key] || {};
          var hay = [t.username, t.name, t.lastText, c.name, c.note, (c.tags || []).join(' '), c.mobile].join(' ').toLowerCase();
          if (hay.indexOf(q) < 0) return false;
        }
        return true;
      });
    }
    function threadByKey(key) { return allThreads().filter(function (t) { return t.key === key; })[0] || null; }

    /* ----------------------------------------------------------- paint */
    function paint() {
      var all = allThreads();
      var paying = Object.keys(state.leads).filter(function (id) { var s = state.leads[id].stage; return s === 'paid' || s === 'won'; }).length;
      var value = Object.keys(state.leads).reduce(function (n, id) { var l = state.leads[id]; return n + (l.stage === 'paid' || l.stage === 'won' ? l.totalPaise : 0); }, 0);
      var unpaid = Object.keys(state.leads).filter(function (id) { return state.leads[id].stage === 'billed'; });
      var unpaidValue = unpaid.reduce(function (n, id) { return n + state.leads[id].totalPaise; }, 0);

      root.setAttribute('data-view', state.open ? 'chat' : 'list');
      root.classList.toggle('has-profile', !!(state.open && state.profile));
      root.innerHTML =
        '<header class="ib__head"><div><h1>Leads</h1><p>Every chat in one inbox. Sell, bill and follow up without leaving this page.</p></div>' +
          '<div class="ib__kpis">' +
            '<div class="ib__goal"><span>Paying customers</span><b>' + paying + '<small> / 100</small></b><i style="--p:' + Math.min(100, paying) + '%"></i></div>' +
            kpi('Paid value', rupees(value)) + kpi('Unpaid bills', unpaid.length + (unpaid.length ? ' · ' + rupees(unpaidValue) : '')) +
            kpi('Chats', all.length) +
          '</div></header>' +
        '<div class="ib__body">' + listHTML() + chatHTML() + profileHTML() + '</div>' +
        (state.billing ? billHTML() : '');
      var log = root.querySelector('.ib__msgs');
      if (log) log.scrollTop = log.scrollHeight;
      var box = root.querySelector('#ibText');
      if (box && state.draft[state.open]) box.value = state.draft[state.open];
    }
    function kpi(label, v) { return '<div class="ib__kpi"><span>' + label + '</span><b>' + v + '</b></div>'; }

    function listHTML() {
      var ch = state.channels || {};
      var all = allThreads();
      var countIn = function (c) { return all.filter(function (t) { return c === 'all' || t.channel === c; }).length; };
      var inChannel = all.filter(function (t) { return state.channel === 'all' || t.channel === state.channel; });
      var list = shown();
      var off = state.channel !== 'all' && ch[state.channel] && !ch[state.channel].connected;
      return '<aside class="ib__list">' +
        '<div class="ib__channels" role="tablist">' + CHANNELS.map(function (c) {
          var info = ch[c[0]];
          var dead = c[0] !== 'all' && info && !info.connected;
          return '<button role="tab" data-channel="' + c[0] + '" class="' + (state.channel === c[0] ? 'is-on' : '') + (dead ? ' is-off' : '') + '"' +
            ' title="' + ui.esc(c[1] + (dead ? ': ' + info.reason : '')) + '">' + (c[0] === 'all' ? '<span class="ib-all">All</span>' : logo(c[0], 18)) +
            '<em>' + (dead ? '–' : countIn(c[0])) + '</em></button>';
        }).join('') + '</div>' +
        '<label class="ib__search">' + SM.icon('search') + '<input type="search" id="ibFind" placeholder="Search name, @username, note, tag" value="' + ui.esc(state.q) + '" /></label>' +
        '<div class="ib__funnel">' + FUNNEL.map(function (f) {
          var n = inChannel.filter(function (t) { return inFunnel(t, f[0]); }).length;
          return '<button data-funnel="' + f[0] + '" class="' + (state.funnel === f[0] ? 'is-on' : '') + '">' + f[1] + ' <em>' + n + '</em></button>';
        }).join('') + '</div>' +
        '<div class="ib__threads">' +
          (state.listErr && !state.threads.length ? '<div class="ib__off"><b>Chats could not be read</b><p>' + ui.esc(state.listErr) + '</p></div>'
            : off ? '<div class="ib__off">' + logo(state.channel, 36) + '<b>' + ui.esc(CHANNELS.filter(function (c) { return c[0] === state.channel; })[0][1]) + ' is not connected</b><p>' + ui.esc(ch[state.channel].reason) + '</p></div>'
            : !state.channels ? '<p class="ib__wait">Reading your chats from Instagram…</p>' + new Array(6).fill('<div class="ib__row is-skel"><span class="ib-av" style="--s:44px"></span><div><div class="adm__skel"></div><div class="adm__skel" style="width:60%;margin-top:7px"></div></div></div>').join('')
            : list.length ? list.map(rowHTML).join('') + (!state.more && state.threads.length >= 25 && !state.q
              ? '<button class="ib__more" data-more>' + (state.loadingMore ? 'Reading older chats…' : 'Show older chats') + '</button>' : '')
            : '<div class="ib__off"><b>Nothing here</b><p>' + (state.q ? 'No chat matches that search.' : 'No chats in this stage yet.') + '</p></div>') +
        '</div></aside>';
    }

    function rowHTML(t) {
      var st = stageOf(t), l = state.leads[t.userId], c = state.contacts[t.key] || {};
      var waiting = !t.lastFromMe && t.lastText;
      var due = c.followUpAt && c.followUpAt <= Date.now() + DAY;
      return '<button class="ib__row' + (state.open === t.key ? ' is-on' : '') + (waiting ? ' is-new' : '') + '" data-open="' + ui.esc(t.key) + '">' +
        avatar(t, 44) +
        '<div class="ib__rowmain"><div class="ib__rowtop"><b>' + ui.esc(c.name || nameOf(t)) + '</b>' + logo(t.channel, 13) +
          (c.pinned ? '<span class="ib__pin" title="Pinned">📌</span>' : '') + '<time>' + when(t.lastAt) + '</time></div>' +
          '<p>' + (t.lastFromMe && t.lastText ? '<span>You: </span>' : '') + ui.esc(t.lastText || ' ') + '</p>' +
          '<div class="ib__rowtags">' + (st !== 'chat' ? pill(st) : '') +
            (l && l.stage === 'billed' && l.totalPaise ? '<span class="adm__pill adm__pill--warn">' + rupees(l.totalPaise) + '</span>' : '') +
            (l && l.needsHuman ? '<span class="adm__pill adm__pill--bad">Needs you</span>' : '') +
            (due ? '<span class="adm__pill adm__pill--info">Follow up</span>' : '') +
            (c.aiPaused ? '<span class="adm__pill">AI off</span>' : '') +
            (c.tags || []).slice(0, 2).map(function (x) { return '<span class="adm__pill">' + ui.esc(x) + '</span>'; }).join('') +
          '</div></div>' + (waiting ? '<i class="ib__dot"></i>' : '') + '</button>';
    }

    function chatHTML() {
      var t = state.open && threadByKey(state.open);
      if (!t) {
        return '<section class="ib__chat ib__chat--empty"><div>' + logo('instagram', 44) + logo('whatsapp', 44) + logo('messenger', 44) +
          '<b>Your messages</b><p>Pick a chat on the left. Reply, ask the AI for a draft, make a bill or mark it paid, all from here.</p></div></section>';
      }
      var d = state.chat && state.chat.key === t.key ? state.chat : null;
      var l = d && d.lead, c = (d && d.contact) || state.contacts[t.key] || {};
      var st = l ? l.stage : stageOf(t);
      var p = d && d.profile;
      var hours = d && d.replyUntil ? Math.max(0, Math.round((d.replyUntil - Date.now()) / 3600000)) : 0;
      return '<section class="ib__chat">' +
        '<header class="ib__chathead">' +
          '<button class="ib__back" data-back="1" aria-label="Back">' + SM.icon('chevronLeft') + '</button>' +
          '<button class="ib__who" data-profile="1" title="Customer details">' + avatar(t, 40, p && p.picture) +
            '<span><b>' + ui.esc(c.name || (p && p.name) || nameOf(t)) + ' ' + logo(t.channel, 14) + '</b>' +
            '<small>' + ui.esc(t.username ? '@' + t.username : t.channel) + (p && p.followers != null ? ' · ' + Number(p.followers).toLocaleString('en-IN') + ' followers' : '') + '</small></span></button>' +
          '<div class="ib__status">' + (st !== 'chat' ? pill(st) : '') +
            (l && l.billNumber ? '<a class="adm__pill adm__pill--' + (st === 'billed' ? 'warn' : 'ok') + '" href="/billing/bills/' + encodeURIComponent(l.billId) + '" target="_blank" rel="noopener">' +
              ui.esc(l.billNumber) + ' · ' + rupees(l.totalPaise) + '</a>' : '') +
            (d && d.customer && d.customer.customer ? '<span class="adm__pill adm__pill--' + segment(d.customer.customer)[1] + '">' + segment(d.customer.customer)[0] + '</span>' : '') +
          '</div>' +
          '<div class="ib__actions">' +
            '<button class="ib__ai' + (c.aiPaused ? '' : ' is-on') + '" data-ai="1" title="' + (c.aiPaused ? 'AI is off: only you reply to this person' : 'AI replies to this person automatically') + '">' +
              SM.icon('sparkle') + '<span>AI ' + (c.aiPaused ? 'off' : 'on') + '</span></button>' +
            (t.channel === 'instagram' ? '<button class="adm__btn" data-bill="1">' + SM.icon('receipt') + '<span>' + (st === 'billed' ? 'New bill' : 'Bill') + '</span></button>' : '') +
            (st === 'billed' ? '<button class="adm__btn adm__btn--primary" data-paid="1">' + SM.icon('check') + '<span>Mark paid</span></button>' : '') +
            '<button class="adm__btn ib__info" data-profile="1" aria-label="Customer details">' + SM.icon('user') + '</button>' +
          '</div></header>' +
        (d && !d.canReply && t.channel !== 'whatsapp'
          ? '<div class="ib__window">⏳ Instagram allows a reply only within 24 hours of the customer\'s last message. Their next message opens it again.</div>'
          : d && d.canReply && hours <= 4 ? '<div class="ib__window is-soon">⏳ About ' + hours + 'h left to reply before Instagram closes this chat.</div>' : '') +
        '<div class="ib__msgs">' + (state.chatErr ? ui.banner('bad', ui.esc(state.chatErr))
          : !d ? '<div class="adm__skel" style="height:44px;width:55%"></div><div class="adm__skel" style="height:44px;width:40%;margin:12px 0 0 auto"></div>'
          : d.messages.length ? bubbles(d.messages, t) : '<p class="ib__none">No messages to show yet.</p>') + '</div>' +
        '<footer class="ib__compose">' +
          '<button class="ib__suggest" data-suggest="1" title="Ask the AI for a reply you can edit"' + (state.busy ? ' disabled' : '') + '>' + SM.icon('sparkle') + '<span>AI draft</span></button>' +
          '<textarea id="ibText" rows="1" maxlength="1000" placeholder="' + (d && !d.canReply ? 'Waiting for the customer to message again…' : 'Message…') + '"' + (d && !d.canReply ? ' disabled' : '') + '></textarea>' +
          '<button class="ib__send" data-send="1"' + (state.busy || (d && !d.canReply) ? ' disabled' : '') + '>Send</button>' +
        '</footer></section>';
    }

    function bubbles(list, t) {
      var out = '', lastDay = '';
      list.forEach(function (m) {
        var day = new Date(m.at).toDateString();
        if (day !== lastDay) { out += '<div class="ib__day">' + ui.date(m.at) + '</div>'; lastDay = day; }
        out += '<div class="ib__msg' + (m.mine ? ' is-mine' : '') + '">' +
          (m.ai ? '<span class="ib__tag">AI</span>' : '') +
          (m.files || []).map(function (f) {
            return f.image ? '<a href="' + ui.esc(f.image) + '" target="_blank" rel="noopener"><img src="' + ui.esc(f.image) + '" alt="" referrerpolicy="no-referrer" /></a>'
              : f.url ? '<a href="' + ui.esc(f.url) + '" target="_blank" rel="noopener">📎 ' + ui.esc(f.name || 'Attachment') + '</a>' : '';
          }).join('') +
          (m.text ? '<p>' + ui.esc(m.text) + '</p>' : (m.files || []).length ? '' : '<p class="ib__none">(a message Instagram does not show here)</p>') +
          '<time>' + when(m.at) + '</time></div>';
      });
      return out;
    }

    function profileHTML() {
      var t = state.open && threadByKey(state.open);
      if (!t || !state.profile) return '';
      var d = state.chat && state.chat.key === t.key ? state.chat : null;
      var p = d && d.profile, l = d && d.lead, c = (d && d.contact) || state.contacts[t.key] || {};
      var cu = d && d.customer, k = cu && cu.customer;
      var seg = segment(k);
      var follow = c.followUpAt ? new Date(c.followUpAt) : null;
      return '<aside class="ib__profile">' +
        '<button class="ib__close" data-profile="0" aria-label="Close">' + SM.icon('close') + '</button>' +
        '<div class="ib__card ib__me">' + avatar(t, 76, p && p.picture) +
          '<b>' + ui.esc(c.name || (p && p.name) || nameOf(t)) + '</b>' +
          (t.username ? '<a href="https://www.instagram.com/' + encodeURIComponent(t.username) + '" target="_blank" rel="noopener">@' + ui.esc(t.username) + ' ' + SM.icon('linkOut') + '</a>' : '') +
          '<div class="ib__chips"><span class="adm__pill adm__pill--' + seg[1] + '">' + seg[0] + '</span>' +
            (p && p.followsUs ? '<span class="adm__pill">Follows you</span>' : '') +
            (p && p.followers != null ? '<span class="adm__pill">' + Number(p.followers).toLocaleString('en-IN') + ' followers</span>' : '') + '</div></div>' +

        '<div class="ib__card"><h3>Purchases</h3>' + (k
          ? '<dl class="ib__stats">' + stat('Total bought', rupees(k.totalPaise)) + stat('Bills', k.billCount) + stat('Paid', rupees(k.paidPaise)) +
              stat('Unpaid', rupees(k.outstandingPaise)) + stat('Average bill', rupees(k.averageBillPaise)) + stat('Last bill', k.lastBillAt ? ui.date(k.lastBillAt) : '—') + '</dl>' +
            (cu.insights && cu.insights.topProducts && cu.insights.topProducts.length ? '<h4>Buys most</h4><ul class="ib__top">' + cu.insights.topProducts.map(function (x) {
              return '<li><span>' + ui.esc(x.name) + '</span><b>× ' + x.qty + '</b></li>'; }).join('') + '</ul>' : '') +
            '<h4>Bill history</h4><ul class="ib__bills">' + (cu.bills || []).map(function (b) {
              return '<li><a href="/billing/bills/' + encodeURIComponent(b.id) + '" target="_blank" rel="noopener"><b>' + ui.esc(b.number) + '</b><span>' + ui.date(b.createdAt) + '</span></a>' +
                '<em>' + rupees(b.totalPaise) + '</em>' + (b.status === 'void' ? '<span class="adm__pill">Void</span>'
                  : '<span class="adm__pill adm__pill--' + (b.paymentStatus === 'paid' ? 'ok">Paid' : 'warn">Unpaid') + '</span>') + '</li>';
            }).join('') + '</ul>'
          : '<p class="ib__hint">' + (d ? 'No bills yet' + (c.mobile ? ' for ' + ui.esc(c.mobile) : '. Add their mobile number below to link their Quick Billing history.') : 'Loading…') + '</p>') + '</div>' +

        (l ? '<div class="ib__card"><h3>Current order ' + pill(l.stage) + '</h3>' +
          ((l.items || []).length ? '<ul class="ib__top">' + l.items.map(function (i) { return '<li><span>' + ui.esc(i.asked && i.asked !== i.master ? i.asked + ' (' + i.master + ' glass)' : i.master + ' glass') + '</span><b>× ' + i.boxes + '</b></li>'; }).join('') + '</ul>' : '<p class="ib__hint">No models yet.</p>') +
          (l.address && l.address.name ? '<p class="ib__addr">' + ui.esc([l.address.name, l.address.phone, l.address.address, l.address.city, l.address.state, l.address.pincode].filter(Boolean).join(', ')) + '</p>' : '') +
          (l.billNumber ? '<p class="ib__links"><a href="/billing/bills/' + encodeURIComponent(l.billId) + '" target="_blank" rel="noopener">Bill ' + ui.esc(l.billNumber) + '</a>' +
            (l.invoiceUrl ? ' · <a href="' + ui.esc(l.invoiceUrl) + '" target="_blank" rel="noopener">Customer page</a>' : '') +
            (l.qrImage ? ' · <a href="' + ui.esc(l.qrImage) + '" target="_blank" rel="noopener">Payment QR</a>' : l.payUrl ? ' · <a href="' + ui.esc(l.payUrl) + '" target="_blank" rel="noopener">Payment link</a>' : '') + '</p>' : '') +
          '<div class="ib__row2">' + (l.stage !== 'lost' ? '<button class="adm__btn" data-stage="lost">Mark lost</button>' : '<button class="adm__btn" data-stage="models">Reopen</button>') + '</div></div>' : '') +

        '<div class="ib__card"><h3>Follow up</h3><div class="ib__follow">' +
          [[1, 'Tomorrow'], [3, 'In 3 days'], [7, 'Next week']].map(function (f) { return '<button class="adm__btn" data-follow="' + f[0] + '">' + f[1] + '</button>'; }).join('') +
          (follow ? '<button class="adm__btn" data-follow="0">Clear</button>' : '') + '</div>' +
          (follow ? '<p class="ib__hint">Due ' + ui.date(follow.getTime()) + (follow.getTime() < Date.now() ? ' · <b>overdue</b>' : '') + '</p>' : '') + '</div>' +

        '<div class="ib__card"><h3>Tags</h3><div class="ib__chips">' + TAGS.concat((c.tags || []).filter(function (x) { return TAGS.indexOf(x) < 0; })).map(function (x) {
            return '<button class="ib__tagbtn' + ((c.tags || []).indexOf(x) > -1 ? ' is-on' : '') + '" data-tag="' + ui.esc(x) + '">' + ui.esc(x) + '</button>'; }).join('') + '</div></div>' +

        '<div class="ib__card"><h3>Details</h3><div class="ar-form">' +
          '<label>Name<input id="ibName" maxlength="80" value="' + ui.esc(c.name || '') + '" placeholder="' + ui.esc((p && p.name) || 'Shop or person') + '" /></label>' +
          '<label>Mobile (links their bills)<input id="ibMobile" inputmode="tel" maxlength="14" value="' + ui.esc(c.mobile || '') + '" placeholder="10-digit number" /></label>' +
          '<label>Note<textarea id="ibNote" rows="3" maxlength="2000" placeholder="What they like, what they asked, what you promised">' + ui.esc(c.note || '') + '</textarea></label>' +
          '<div class="ib__row2"><button class="adm__btn adm__btn--primary" data-save="1">Save details</button>' +
          '<button class="adm__btn" data-pin="1">' + (c.pinned ? 'Unpin' : 'Pin to top') + '</button></div></div></div>' +
        '</aside>';
    }
    function stat(label, v) { return '<div><dt>' + label + '</dt><dd>' + v + '</dd></div>'; }

    function billHTML() {
      var t = threadByKey(state.open);
      var d = state.chat || {};
      var l = d.lead || {}, a = l.address || {}, c = d.contact || {};
      var items = (l.items || []).length ? l.items.map(function (i) { return { phone: i.asked || i.master, boxes: i.boxes }; }) : [{ phone: '', boxes: 1 }];
      return '<div class="ib__modal" role="dialog" aria-label="Make a bill"><form class="ib__sheet" id="ibBill">' +
        '<header><h2>Bill for ' + ui.esc(t ? nameOf(t) : '') + '</h2><button type="button" class="ib__close" data-billclose="1" aria-label="Close">' + SM.icon('close') + '</button></header>' +
        '<p class="ib__hint">Made in your Quick Billing at your box price, with courier worked out from the address. ' +
          (l.stage === 'billed' ? '<b>The unpaid bill ' + ui.esc(l.billNumber || '') + ' is cancelled and replaced.</b>' : '') + '</p>' +
        '<h3>Models</h3><div id="ibItems">' + items.map(itemRow).join('') + '</div>' +
        '<button type="button" class="adm__btn" data-additem="1">+ Add a model</button>' +
        '<h3>Deliver to</h3><div class="ib__grid">' +
          field('name', 'Name', a.name || c.name) + field('phone', 'Mobile', a.phone || c.mobile) +
          field('address', 'Address', a.address, true) + field('city', 'City', a.city) + field('state', 'State', a.state) + field('pincode', 'Pincode', a.pincode) +
        '</div>' +
        '<label class="ar-check"><input type="checkbox" id="ibSend"' + (d.canReply ? ' checked' : ' disabled') + ' /> Send the bill and payment QR to the customer on Instagram' +
          (d.canReply ? '' : ' <span class="adm__none">(not possible: their last message is over 24 hours old)</span>') + '</label>' +
        '<footer><button type="button" class="adm__btn" data-billclose="1">Cancel</button><button class="adm__btn adm__btn--primary"' + (state.busy ? ' disabled' : '') + '>' +
          (state.busy ? 'Making the bill…' : 'Make bill') + '</button></footer></form></div>';
    }
    function itemRow(i) {
      return '<div class="ib__item"><input name="phone" placeholder="Phone model, e.g. Realme 5" value="' + ui.esc(i.phone) + '" />' +
        '<input name="boxes" type="number" min="1" max="100" value="' + (i.boxes || 1) + '" aria-label="Boxes" /><span>boxes</span>' +
        '<button type="button" class="ib__x" data-delitem="1" aria-label="Remove">' + SM.icon('close') + '</button></div>';
    }
    function field(name, label, v, wide) {
      return '<label class="' + (wide ? 'is-wide' : '') + '">' + label + '<input name="' + name + '" value="' + ui.esc(v || '') + '" /></label>';
    }

    /* ----------------------------------------------------------- data */
    function loadList() {
      return ADM.api.autoReply({ view: 'inbox', more: state.more ? '1' : undefined }).then(function (r) {
        state.loadingMore = false;
        /* a server without the inbox answers with something else: say so, never load forever */
        if (!r || !r.channels) throw new Error('The server does not have the inbox yet. It arrives with the next deploy.');
        state.listErr = null;
        state.channels = r.channels;
        state.threads = r.threads || [];
        keepTyping(paint);
      }).catch(function (err) {
        state.loadingMore = false;
        state.listErr = err.message || 'Could not read the chats';
        state.channels = state.channels || {};
        keepTyping(paint);
      });
    }
    function loadPeople() {
      return ADM.api.autoReply({ view: 'people' }).then(function (r) {
        state.leads = {};
        (r.leads || []).forEach(function (l) { state.leads[l.id] = l; });
        state.contacts = r.contacts || {};
        keepTyping(paint);
      }, function () { /* the chats still show */ });
    }
    function loadChat(lite) {
      var t = threadByKey(state.open);
      if (!t) return Promise.resolve();
      var key = t.key;
      return ADM.api.autoReply({ view: 'thread', channel: t.channel, userId: t.userId, convId: t.convId || '', lite: lite ? 1 : '' }).then(function (r) {
        if (state.open !== key) return;
        if (lite && state.chat && state.chat.key === key) {
          r.profile = state.chat.profile;
          r.customer = state.chat.customer;
        }
        state.chat = Object.assign({ key: key }, r);
        state.chatErr = null;
        if (r.contact) state.contacts[key] = Object.assign({}, state.contacts[key], r.contact);
        keepTyping(paint);
      }, function (err) {
        if (state.open !== key) return;
        state.chatErr = err.message || 'Could not open this chat.';
        paint();
      });
    }
    /* a repaint must not lose what the owner is typing */
    function keepTyping(fn) {
      var box = root.querySelector('#ibText');
      if (box && state.open) state.draft[state.open] = box.value;
      var active = document.activeElement && document.activeElement.id;
      if (state.billing) return;
      if (active === 'ibNote' || active === 'ibName' || active === 'ibMobile' || active === 'ibFind') return;
      fn();
      if (active === 'ibText') { var b = root.querySelector('#ibText'); if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); } }
    }

    function open(key) {
      state.open = key;
      state.chat = null;
      state.chatErr = null;
      history.replaceState(null, '', '/admin/leads?chat=' + encodeURIComponent(key));
      paint();
      loadChat(false);
    }

    function saveContact(fields, msg) {
      var t = threadByKey(state.open);
      if (!t) return;
      var body = Object.assign({ action: 'contact', channel: t.channel, userId: t.userId, username: t.username || '' }, fields);
      return ADM.api.autoReplyAction(body).then(function (r) {
        state.contacts[t.key] = Object.assign({}, state.contacts[t.key], r.contact);
        if (state.chat && state.chat.key === t.key) state.chat.contact = Object.assign({}, state.chat.contact, r.contact);
        if (msg) ctx.toast(msg);
        if ('mobile' in fields) loadChat(false); else paint();
      }, function (err) { ctx.toast(err.message || 'Could not save', 'bad'); });
    }

    function send() {
      var t = threadByKey(state.open);
      var box = root.querySelector('#ibText');
      var text = box && box.value.trim();
      if (!t || !text || state.busy) return;
      state.busy = true;
      ADM.api.autoReplyAction({ action: 'reply', channel: t.channel, userId: t.userId, text: text }).then(function () {
        state.busy = false;
        state.draft[t.key] = '';
        if (state.chat && state.chat.key === t.key) state.chat.messages.push({ id: 'local' + Date.now(), text: text, at: Date.now(), mine: true, files: [] });
        t.lastText = text; t.lastAt = Date.now(); t.lastFromMe = true;
        var b = root.querySelector('#ibText'); if (b) b.value = '';
        paint();
        global.setTimeout(function () { loadChat(true); }, 2500);
      }, function (err) {
        state.busy = false;
        paint();
        ctx.toast(err.message || 'Could not send', 'bad');
      });
    }

    function suggest() {
      var t = threadByKey(state.open);
      var d = state.chat;
      if (!t || !d) return;
      var theirs = d.messages.filter(function (m) { return !m.mine && m.text; });
      if (!theirs.length) { ctx.toast('There is no customer message to answer yet.', 'warn'); return; }
      state.busy = true;
      paint();
      ADM.api.autoReplyAction({ action: 'suggest', channel: t.channel, userId: t.userId, text: theirs.slice(-3).map(function (m) { return m.text; }).join('\n') }).then(function (r) {
        state.busy = false;
        state.draft[t.key] = r.reply;
        paint();
        var b = root.querySelector('#ibText'); if (b) { b.focus(); autoGrow(b); }
      }, function (err) {
        state.busy = false;
        paint();
        ctx.toast(err.message || 'The AI could not suggest a reply', 'bad');
      });
    }

    function makeBill(form) {
      var t = threadByKey(state.open);
      var items = Array.prototype.map.call(form.querySelectorAll('.ib__item'), function (row) {
        return { phone: row.querySelector('[name=phone]').value, boxes: Number(row.querySelector('[name=boxes]').value) || 1 };
      }).filter(function (i) { return i.phone.trim(); });
      var address = {};
      ['name', 'phone', 'address', 'city', 'state', 'pincode'].forEach(function (k) { address[k] = form.querySelector('[name=' + k + ']').value; });
      var sendIt = form.querySelector('#ibSend').checked;
      state.busy = true;
      form.querySelector('footer .adm__btn--primary').disabled = true;
      form.querySelector('footer .adm__btn--primary').textContent = 'Making the bill…';
      ADM.api.autoReplyAction({ action: 'bill', channel: 'instagram', userId: t.userId, username: t.username || '', items: items, address: address, send: sendIt }).then(function (r) {
        state.busy = false;
        state.billing = false;
        ctx.toast('Bill ' + r.billNumber + ' for ' + rupees(r.totalPaise) + (r.sent ? ' sent on Instagram' : ' made' + (sendIt ? ', but Instagram did not take the message' : '')), r.sent || !sendIt ? undefined : 'warn');
        loadPeople();
        loadChat(false);
      }, function (err) {
        state.busy = false;
        var btn = form.querySelector('footer .adm__btn--primary');
        btn.disabled = false;
        btn.textContent = 'Make bill';
        ctx.toast(err.message || 'Could not make the bill', 'bad');
      });
    }

    function markPaid() {
      var t = threadByKey(state.open);
      var l = state.chat && state.chat.lead;
      if (!t || !l) return;
      if (!global.confirm('Mark bill ' + (l.billNumber || '') + ' (' + rupees(l.totalPaise) + ') as paid?\n\nDo this only when the money is in your account. It is marked paid in Quick Billing too' +
        (state.chat.canReply ? ', and the customer is told their order is being packed.' : '.'))) return;
      ADM.api.autoReplyAction({ action: 'paid', channel: 'instagram', userId: t.userId, tell: !!state.chat.canReply }).then(function (r) {
        ctx.toast('Bill ' + r.billNumber + ' marked paid' + (r.told ? ' and the customer told' : ''));
        loadPeople();
        loadChat(false);
      }, function (err) { ctx.toast(err.message || 'Could not mark it paid', 'bad'); });
    }

    function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(160, el.scrollHeight) + 'px'; }

    /* --------------------------------------------------------- events */
    root.addEventListener('click', function (e) {
      var b = e.target.closest('button, [data-open]');
      if (!b || !root.contains(b)) return;
      if (b.hasAttribute('data-more')) { if (!state.loadingMore) { state.more = true; state.loadingMore = true; paint(); loadList(); } return; }
      if (b.hasAttribute('data-channel')) { state.channel = b.getAttribute('data-channel'); paint(); return; }
      if (b.hasAttribute('data-funnel')) { state.funnel = b.getAttribute('data-funnel'); paint(); return; }
      if (b.hasAttribute('data-open')) { open(b.getAttribute('data-open')); return; }
      if (b.hasAttribute('data-back')) { state.open = null; state.chat = null; history.replaceState(null, '', '/admin/leads'); paint(); return; }
      if (b.hasAttribute('data-profile')) { state.profile = b.getAttribute('data-profile') !== '0' && !(b.classList.contains('ib__info') && state.profile); paint(); return; }
      if (b.hasAttribute('data-send')) { send(); return; }
      if (b.hasAttribute('data-suggest')) { suggest(); return; }
      if (b.hasAttribute('data-ai')) {
        var c = state.contacts[state.open] || {};
        saveContact({ aiPaused: !c.aiPaused }, c.aiPaused ? 'AI replies to this person again' : 'AI is off for this person. Only you reply.');
        return;
      }
      if (b.hasAttribute('data-bill')) { state.billing = true; paint(); var f = root.querySelector('#ibItems input'); if (f) f.focus(); return; }
      if (b.hasAttribute('data-billclose')) { state.billing = false; paint(); return; }
      if (b.hasAttribute('data-additem')) { root.querySelector('#ibItems').insertAdjacentHTML('beforeend', itemRow({ phone: '', boxes: 1 })); root.querySelector('#ibItems .ib__item:last-child input').focus(); return; }
      if (b.hasAttribute('data-delitem')) { var rows = root.querySelectorAll('#ibItems .ib__item'); if (rows.length > 1) b.closest('.ib__item').remove(); return; }
      if (b.hasAttribute('data-paid')) { markPaid(); return; }
      if (b.hasAttribute('data-follow')) {
        var days = Number(b.getAttribute('data-follow'));
        var at = new Date(); at.setHours(10, 0, 0, 0);
        saveContact({ followUpAt: days ? at.getTime() + days * DAY : null }, days ? 'Follow-up set' : 'Follow-up cleared');
        return;
      }
      if (b.hasAttribute('data-tag')) {
        var tag = b.getAttribute('data-tag');
        var tags = ((state.contacts[state.open] || {}).tags || []).slice();
        var i = tags.indexOf(tag);
        if (i > -1) tags.splice(i, 1); else tags.push(tag);
        saveContact({ tags: tags });
        return;
      }
      if (b.hasAttribute('data-pin')) { saveContact({ pinned: !(state.contacts[state.open] || {}).pinned }); return; }
      if (b.hasAttribute('data-save')) {
        saveContact({ name: root.querySelector('#ibName').value, mobile: root.querySelector('#ibMobile').value, note: root.querySelector('#ibNote').value }, 'Saved');
        return;
      }
      if (b.hasAttribute('data-stage')) {
        var t = threadByKey(state.open);
        ADM.api.autoReplyAction({ action: 'lead', id: t.userId, stage: b.getAttribute('data-stage') }).then(function () {
          ctx.toast('Saved'); loadPeople(); loadChat(true);
        }, function (err) { ctx.toast(err.message || 'Could not save', 'bad'); });
      }
    });
    root.addEventListener('submit', function (e) {
      if (e.target.id !== 'ibBill') return;
      e.preventDefault();
      makeBill(e.target);
    });
    root.addEventListener('input', function (e) {
      if (e.target.id === 'ibFind') {
        state.q = e.target.value;
        var at = e.target.selectionStart;
        var list = root.querySelector('.ib__threads');
        var tmp = document.createElement('div');
        tmp.innerHTML = listHTML();
        list.innerHTML = tmp.querySelector('.ib__threads').innerHTML;
        e.target.setSelectionRange(at, at);
        return;
      }
      if (e.target.id === 'ibText') { state.draft[state.open] = e.target.value; autoGrow(e.target); }
    });
    root.addEventListener('keydown', function (e) {
      if (e.target.id === 'ibText' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
      if (e.key === 'Escape' && state.billing) { state.billing = false; paint(); }
    });

    /* ------------------------------------------------------- refresh
       The minute's poll keeps the auto reply running while the page is open,
       as before. Chats from Meta every minute; leads and notes when the poll
       found something or every ten minutes; the open chat every 30 seconds. */
    var ticks = 0;
    var minute = global.setInterval(function () {
      if (!document.body.contains(root)) { global.clearInterval(minute); global.clearInterval(half); return; }
      if (document.hidden) return;
      ticks++;
      ADM.api.autoReplyAction({ action: 'poll' }).then(function (r) {
        loadList();
        if ((r && (r.found || r.answered || r.followed)) || ticks % 10 === 0) loadPeople();
      }, function () { loadList(); });
    }, 60000);
    var half = global.setInterval(function () {
      if (!document.body.contains(root) || document.hidden || !state.open || state.busy) return;
      loadChat(true);
    }, 30000);

    paint();
    Promise.all([loadList(), loadPeople()]).then(function () { if (state.open) loadChat(false); });
  }

  ADM.pages = ADM.pages || {};
  ADM.pages.leads = { render: render };
})(window);
