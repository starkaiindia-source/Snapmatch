/* ============================================================================
   Mobile Parts Finder · admin/pages/auto-reply.js
   ----------------------------------------------------------------------------
   Auto Reply: the owner's Instagram account answered by AI, as one overview.

     · one switch for the whole thing (Off, Review first, Auto)
     · what it did: replies today, this week and in 30 days, a bar a day,
       what is waiting, and the sales it led to
     · what is set: each rule as a card with its own switch and its numbers
       (app link, 9H sales, the "is it useful?" follow-up, AI on comments, AI on
       messages, answer everything)
     · needs your eye: a model said to be wrong, a model suggested, a complaint,
       a question only the owner can answer, with the post it is on
     · the latest comments and what was said back
     · training, words, connection and every message, folded away below

   ----------------------------------------------------------------------------
   WHAT THIS PAGE WILL AND WILL NOT SAY

   Every number is counted from the bot's own records. Instagram does not tell
   anyone who taps a button in a message, so taps are not shown as a number;
   the app link carries a campaign tag that Google Play's console reports.

   "Connected" is what Meta answered a moment ago when this page asked, never
   what was configured. The test box writes the reply a message would get and
   sends nothing.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, ADM = SM.adm, ui = ADM.ui;

  var MODES = [
    ['off', 'Off', 'Nothing is answered.'],
    ['review', 'Review first', 'AI writes, you press Send.'],
    ['auto', 'Auto', 'AI answers by itself.']
  ];
  var STATUS = {
    queued: ['Queued', 'info'], draft: ['Draft', 'info'], needs_human: ['Needs you', 'warn'], sending: ['Sending', 'info'],
    sent: ['Sent', 'ok'], ignored: ['No reply needed', ''], skipped: ['Skipped', ''], failed: ['Failed', 'bad'], discarded: ['Discarded', '']
  };
  var REASONS = {
    'needs-human': 'The AI asked for a person.', 'low-confidence': 'The AI was not sure enough.', 'blocked-word': 'The reply had a blocked word.',
    'unknown-link': 'The reply had a link that is not in your links.', 'too-long': 'The reply was too long for Instagram.', empty: 'The AI wrote nothing.',
    'unchecked-fit': 'It said a product fits, but the post names no phone to check that against.', 'ai-failed': 'The AI did not answer in time.',
    'no-text': 'No text in this message, such as a photo.', 'auto-reply-off': 'Auto Reply was off.', 'channel-off': 'This channel was off.',
    'sender-limit': 'This person reached the hourly limit.', 'daily-limit': 'The daily limit was reached.',
    'link-already-sent': 'This person got the app link in the last day.'
  };
  var FLAGS = {
    correction: ['Model said to be wrong', 'bad'], suggestion: ['Model suggested', 'info'], complaint: ['Complaint', 'warn'], question: ['Only you can answer', 'warn']
  };
  var FIELDS = [
    ['appLink', 'App link', 'input', 'Your Play Store link. Anyone asking for the app gets it at once, even in Review.'],
    ['appLinkText', 'Message before the button', 'text', 'Use {brand} for the brand name'],
    ['appCardTitle', 'Card title', 'input', 'Up to 80 letters'],
    ['appCardSubtitle', 'Card line', 'input', 'Up to 80 letters'],
    ['appButton', 'Button', 'input', 'Up to 20 letters'],
    ['appImage', 'Card picture', 'input', 'An https link to the app icon'],
    ['appLinkComment', 'Reply on the comment', 'input', 'Links in comments cannot be tapped, so the link goes by DM'],
    ['appKeywords', 'Words that ask for the app', 'text', 'One per line. A short comment with one of these gets the app link.'],
    ['iosLink', 'Link for iPhone users', 'input', 'The app is Android only, so iPhone users get this'],
    ['iosText', 'Message for iPhone users', 'text', 'Use {brand}'],
    ['iosCardTitle', 'iPhone card title', 'input', ''],
    ['iosCardSubtitle', 'iPhone card line', 'input', ''],
    ['iosButton', 'iPhone button', 'input', 'Up to 20 letters'],
    ['salesKeywords', 'Words that start a sale', 'text', 'One per line, like 9h. Price questions start one too.'],
    ['salesPriceText', 'Price message', 'text', 'Use {box} {pieces} {piece} {min} {minTotal} {home} {near} {far} {homeState} {brand}'],
    ['salesComment', 'Reply on a price comment', 'input', ''],
    ['salesThanks', 'Message when paid', 'input', ''],
    ['homeState', 'Your state', 'input', 'Courier is cheapest here'],
    ['nearStates', 'Nearby states', 'input', 'Comma separated'],
    ['brand', 'Brand name', 'input', 'The name replies are written as'],
    ['about', 'About the shop', 'text', 'What the shop and the app do, in your own words'],
    ['products', 'Products', 'text', 'Each product with its price, material, warranty and how to order'],
    ['links', 'Links the AI may share', 'text', 'One per line. Any other link stops the reply.'],
    ['tone', 'Tone', 'input', 'How replies should sound'],
    ['handoff', 'When it cannot answer', 'input', 'What it says while waiting for you'],
    ['blocked', 'Blocked words', 'text', 'One per line. A reply with any of these never goes out.']
  ];
  var NUMBERS = [
    ['maxNames', 'Phone names in one reply', 0, 20, 1],
    ['perSenderHour', 'Replies to one person per hour', 1, 60, 1],
    ['dailyReplies', 'Replies per day', 1, 2000, 1],
    ['minConfidence', 'Least confidence to send', 0, 1, 0.05],
    ['boxPrice', 'Price of a box (₹)', 1, 100000, 1],
    ['boxPieces', 'Pieces in a box', 1, 1000, 1],
    ['minBoxes', 'Minimum boxes', 1, 1000, 1],
    ['courierHome', 'Courier, your state (₹)', 0, 10000, 1],
    ['courierNear', 'Courier, nearby states (₹)', 0, 10000, 1],
    ['courierFar', 'Courier, other states (₹)', 0, 10000, 1]
  ];
  /* the rules as cards: setting, title, what it does, its count, and where its words are */
  var RULES = [
    ['appOn', 'App link', 'Anyone asking for the app ("link", "app", the comment word) gets the Play Store card in DM; iPhone users get the website.', 'app_link'],
    ['salesOn', '9H sales and orders', 'Price and "9H" asks get the wholesale price; models and boxes make a bill in Quick Billing with a UPI QR.', 'sale'],
    ['feedbackOn', '"Is it useful?" follow-up', 'About 20 hours after the app link, a Yes/No question; a yes gets the Play Store rating card.', 'feedback'],
    ['comments', 'AI on comments', 'Questions under posts are answered from your catalogue: which phones share a glass, cover or display.', 'ai_comments'],
    ['dms', 'AI on messages', 'Direct messages are answered the same way, with the last few lines of the chat in mind.', 'ai_dms'],
    ['takeOver', 'Answer everything', 'In Auto, a message the AI may not answer alone still gets your holding line, and shows below for you.', 'holding']
  ];

  var n = function (v) { return v == null ? '—' : Number(v).toLocaleString('en-IN'); };
  function pill(tone, label) {
    return '<span class="adm__pill' + (tone ? ' adm__pill--' + tone : '') + '">' + ui.esc(label) + '</span>';
  }
  function copyRow(label, value) {
    return '<div class="ar-copy"><span>' + ui.esc(label) + '</span><code>' + ui.esc(value || '—') + '</code>' +
      (value ? '<button class="adm__btn" data-copy="' + ui.esc(value) + '">Copy</button>' : '') + '</div>';
  }

  function render(host, ctx) {
    host.innerHTML = '';
    var root = document.createElement('div');
    host.appendChild(root);
    var state = { data: null, check: null, checking: false, busy: false, posts: {}, postsAsked: false };

    function el(id) { return root.querySelector('#' + id); }
    function fail(err) { ctx.toast((err && err.message) || 'Request failed', 'bad'); }

    function load() {
      ADM.api.autoReply({ view: 'overview' }).then(function (d) {
        state.data = d;
        paint();
        runCheck();
        loadPosts();
      }, function (err) {
        root.innerHTML = '<div class="adm__head"><h1>Auto Reply</h1></div>' + ui.banner('bad', '<b>Could not load.</b> ' + ui.esc(err.message || 'request failed'));
      });
    }
    function refresh() {
      ADM.api.autoReply({ view: 'overview' }).then(function (d) { state.data = d; paint(); loadPosts(); }, fail);
    }
    /* the posts the flagged comments are on, for their pictures and links */
    function loadPosts() {
      var st = state.data.stats || {};
      var ids = (st.flagged || []).concat(st.comments || []).map(function (e) { return e.mediaId; }).filter(function (id) { return id && !state.posts[id]; });
      if (!ids.length) return;
      ADM.api.autoReply({ view: 'posts', ids: Array.from(new Set(ids)).slice(0, 12).join(',') }).then(function (r) {
        Object.keys(r.posts || {}).forEach(function (k) { state.posts[k] = r.posts[k]; });
        paint();
      }, function () { /* the list works without pictures */ });
    }
    function runCheck() {
      state.checking = true;
      if (el('arConn')) el('arConn').innerHTML = connectionHTML();
      ADM.api.autoReply({ view: 'check' }).then(function (c) {
        state.check = c;
      }, function (err) {
        state.check = { errors: [{ step: 'check', message: err.message || 'request failed' }] };
      }).then(function () {
        state.checking = false;
        if (el('arConn')) el('arConn').innerHTML = connectionHTML();
        if (el('arStatus')) el('arStatus').innerHTML = statusHTML();
      });
    }

    /* ------------------------------------------------------------- the page */
    function paint() {
      var open = {};
      Array.prototype.forEach.call(root.querySelectorAll('details[id]'), function (d) { open[d.id] = d.open; });
      root.innerHTML = headHTML() + numbersHTML() + rulesHTML() + flaggedHTML() + commentsHTML() + moreHTML();
      Object.keys(open).forEach(function (id) { if (el(id)) el(id).open = open[id]; });
    }

    function headHTML() {
      var s = state.data.settings;
      return '<div class="ar2-head"><div><h1>Auto Reply</h1><p>AI answers comments and messages on your Instagram account. <span id="arStatus">' + statusHTML() + '</span></p></div>' +
        '<div class="ar2-modes" role="group" aria-label="How it replies">' + MODES.map(function (m) {
          return '<button class="ar2-mode' + (s.mode === m[0] ? ' is-on is-' + m[0] : '') + '" data-mode="' + m[0] + '" aria-pressed="' + (s.mode === m[0]) + '" title="' + ui.esc(m[2]) + '">' + m[1] + '</button>';
        }).join('') + '</div></div>' +
        (s.mode === 'auto' ? '' : ui.banner(s.mode === 'off' ? 'bad' : 'warn', s.mode === 'off' ? '<b>Auto Reply is off.</b> Nobody gets an answer until you switch it to Auto.'
          : '<b>Review first.</b> The app link and sales go at once; every other reply waits for you to press Send.'));
    }
    function statusHTML() {
      var k = state.check;
      if (state.checking || !k) return '<span class="ar2-dot"></span>Asking Meta…';
      var good = k.account && k.token && k.token.valid && !(k.errors || []).length;
      return '<span class="ar2-dot ' + (good ? 'is-ok' : 'is-bad') + '"></span>' + (k.account ? '@' + ui.esc(k.account.username || k.account.id) : 'Instagram') + (good ? ' · connected' : ' · needs a look (see Connection below)');
    }

    function numbersHTML() {
      var st = state.data.stats;
      if (!st || st.error) return ui.banner('warn', '<b>The numbers could not be counted.</b> ' + ui.esc((st && st.error) || ''));
      var t = st.totals;
      var tile = function (label, value, hint, tone) { return '<div class="ar2-kpi' + (tone ? ' is-' + tone : '') + '"><span>' + label + '</span><b>' + value + '</b><small>' + hint + '</small></div>'; };
      var stages = st.leads.stages || {};
      return '<div class="ar2-kpis">' +
        tile('Replied today', n(t.today), 'comments and messages') +
        tile('This week', n(t.week), 'replies sent') +
        tile('Last 30 days', n(t.sent), 'of ' + n(t.read) + ' read · ' + n(t.comments) + ' comments, ' + n(t.dms) + ' messages') +
        tile('Waiting for you', n(t.waiting + (st.flagged || []).length), n((st.flagged || []).length) + ' flagged · ' + n(t.waiting) + ' held', t.waiting + (st.flagged || []).length ? 'warn' : '') +
        tile('Sales', n(st.leads.total), n(stages.billed || 0) + ' billed · ' + n(st.leads.paid) + ' paid') +
        '</div><div class="ar2-chart"><div class="ar2-chart__head"><h2>Replies a day</h2><small>' + (st.capped ? 'Counted from the latest ' + n(t.read) + ' records' : 'Last ' + st.days + ' days') + ' · ' + ui.esc(ui.ago(st.readAt)) + '</small></div>' +
        ui.barChart((st.daily || []).map(function (d) { return { date: d.day, value: d.sent }; }), { label: 'Replies sent', totalLabel: 'replies in ' + st.days + ' days', color: '#D62976' }) + '</div>';
    }

    function rulesHTML() {
      var s = state.data.settings, st = state.data.stats || {};
      var r = st.rules || {};
      return '<section class="ar2-sec"><div class="ar2-sec__head"><h2>What is set</h2><p>Each rule with its own switch. Numbers are replies sent: today, this week, 30 days.</p></div><div class="ar2-rules">' +
        RULES.map(function (x) {
          var on = !!s[x[0]];
          var c = x[3] && r[x[3]];
          var extra = x[0] === 'appOn' ? '<p class="ar2-rule__note">Taps on the button are not reported by Instagram. Installs from these links show in Google Play Console under the campaign <code>utm_source=instagram</code>.</p>'
            : x[0] === 'salesOn' ? '<p class="ar2-rule__note">' + n(((st.leads || {}).stages || {}).price_sent || 0) + ' asked the price · ' + n(((st.leads || {}).stages || {}).billed || 0) + ' billed · ' + n((st.leads || {}).paid || 0) + ' paid. <a href="/admin/leads">Open Leads</a></p>'
              : x[0] === 'takeOver' && s.mode !== 'auto' ? '<p class="ar2-rule__note">Works when the switch at the top is on Auto.</p>' : '';
          return '<article class="ar2-rule' + (on ? ' is-on' : '') + '"><div class="ar2-rule__top"><b>' + x[1] + '</b><label class="pz-switch ar2-switch"><input type="checkbox" data-setting="' + x[0] + '"' + (on ? ' checked' : '') + '><i></i></label></div>' +
            '<p>' + ui.esc(x[2]) + '</p>' +
            (c ? '<div class="ar2-rule__nums"><span><b>' + n(c.today) + '</b>today</span><span><b>' + n(c.week) + '</b>week</span><span><b>' + n(c.all) + '</b>30 days</span></div>' : '') + extra + '</article>';
        }).join('') + '</div></section>';
    }

    function postBit(id) {
      var p = id && state.posts[id];
      if (!p) return '';
      return '<a class="ar2-post" href="' + ui.esc(p.permalink || '#') + '" target="_blank" rel="noopener">' + (p.picture ? '<span style="background-image:url(\'' + ui.esc(p.picture) + '\')"></span>' : '') +
        '<small>' + ui.esc(p.caption || 'Open the post') + '</small></a>';
    }

    function flaggedHTML() {
      var list = (state.data.stats || {}).flagged || [];
      return '<section class="ar2-sec"><div class="ar2-sec__head"><h2>Needs your eye</h2><p>What people said that you should see: a model said to be wrong, a model suggested, a complaint, a question only you can answer. Each already got a reply.</p></div>' +
        (list.length ? '<div class="ar2-flags">' + list.map(function (e) {
          var f = FLAGS[e.flag] || FLAGS.question;
          return '<article class="ar2-flag is-' + ui.esc(e.flag) + '" data-id="' + ui.esc(e.id) + '"><div class="ar2-flag__top">' + pill(f[1], f[0]) + '<b>' + (e.kind === 'dm' ? 'Message' : 'Comment') + (e.username ? ' from @' + ui.esc(e.username) : '') + '</b><span class="adm__none">' + ui.esc(ui.ago(e.at)) + '</span></div>' +
            '<p class="ar2-flag__said">' + ui.esc(e.text || '(no text)') + '</p>' +
            ((e.phones || []).length ? '<p class="ar2-flag__phones">Phones: ' + e.phones.map(ui.esc).join(', ') + '</p>' : '') +
            (e.reply ? '<p class="ar-reply">' + ui.esc(e.reply) + '</p>' : '') +
            (e.reason ? '<p class="ar-why">' + ui.esc(REASONS[e.reason] || e.reason) + '</p>' : '') +
            postBit(e.mediaId) +
            '<div class="ar-row">' + (e.kind === 'dm' ? '<a class="adm__btn adm__btn--sm" href="/admin/leads">Answer in Leads</a>' : '') +
            '<button class="adm__btn adm__btn--sm adm__btn--primary" data-act="flagDone">Done</button></div></article>';
        }).join('') + '</div>' : ui.emptyState('Nothing waiting', 'Corrections, suggestions and complaints show here as they come.')) + '</section>';
    }

    function commentsHTML() {
      var list = (state.data.stats || {}).comments || [];
      if (!list.length) return '';
      return '<section class="ar2-sec"><div class="ar2-sec__head"><h2>Latest comments</h2><p>Comments under your posts, and what was said back.</p></div><div class="ar2-feed">' + list.slice(0, 15).map(function (e) {
        var st = STATUS[e.status] || [e.status, ''];
        var p = e.mediaId && state.posts[e.mediaId];
        return '<div class="ar2-line">' + (p && p.picture ? '<a class="ar2-line__pic" href="' + ui.esc(p.permalink || '#') + '" target="_blank" rel="noopener" style="background-image:url(\'' + ui.esc(p.picture) + '\')"></a>' : '<span class="ar2-line__pic"></span>') +
          '<div class="ar2-line__txt"><div><b>' + (e.username ? '@' + ui.esc(e.username) : 'Someone') + '</b> ' + ui.esc(e.text || '') + '</div>' +
          (e.reply ? '<div class="ar2-line__reply">↳ ' + ui.esc(e.reply) + '</div>' : '') + '</div>' +
          '<div class="ar2-line__meta">' + (e.flag ? pill((FLAGS[e.flag] || FLAGS.question)[1], (FLAGS[e.flag] || FLAGS.question)[0]) : '') + pill(st[1], st[0]) + '<small>' + ui.esc(ui.ago(e.at)) + '</small></div></div>';
      }).join('') + '</div></section>';
    }

    /* training, words, the test box, the connection and every message, folded away */
    function moreHTML() {
      return '<details class="ar2-more" id="arMoreTrain"><summary>Training and words</summary><p class="adm__hint">The AI answers only from this text and your compatibility data. Anything not written here, it will not make up.</p>' + trainingHTML() + '</details>' +
        '<details class="ar2-more" id="arMoreTest"><summary>Try a message</summary><p class="adm__hint">Shows the reply it would write. Nothing is sent to anyone.</p>' +
        '<form id="arTest" class="ar-form"><textarea name="text" rows="2" maxlength="1000" placeholder="realme 5 ku indha temper match aaguma?"></textarea>' +
        '<input name="caption" maxlength="2000" placeholder="Caption of the post, if the comment is on one">' +
        '<div class="ar-row"><select name="kind"><option value="comment">As a comment</option><option value="dm">As a message</option></select>' +
        '<button class="adm__btn adm__btn--primary" type="submit">Write a reply</button></div></form><div id="arResult"></div></details>' +
        '<details class="ar2-more" id="arMoreConn"><summary>Connection</summary><div id="arConn">' + connectionHTML() + '</div></details>' +
        '<details class="ar2-more" id="arMoreAll"><summary>Every message (latest 50)</summary><div id="arInbox">' + inboxHTML() + '</div></details>';
    }

    function trainingHTML() {
      var s = state.data.settings;
      return '<form id="arTrain" class="ar-form">' + FIELDS.map(function (f) {
        var value = ui.esc(s[f[0]] || '');
        return '<label>' + f[1] + (f[2] === 'text'
          ? '<textarea name="' + f[0] + '" rows="' + (f[0] === 'products' ? 7 : 3) + '" placeholder="' + ui.esc(f[3]) + '">' + value + '</textarea>'
          : '<input name="' + f[0] + '" value="' + value + '" placeholder="' + ui.esc(f[3]) + '">') + '</label>';
      }).join('') + '<div class="ar-nums">' + NUMBERS.map(function (x) {
        return '<label>' + x[1] + '<input type="number" name="' + x[0] + '" min="' + x[2] + '" max="' + x[3] + '" step="' + x[4] + '" value="' + ui.esc(s[x[0]]) + '"></label>';
      }).join('') + '</div><div><button class="adm__btn adm__btn--primary" type="submit">Save training</button></div></form>';
    }

    /* ------------------------------------------------------------ connection */
    function row(tone, label, detail) {
      return '<li>' + pill(tone, tone === 'ok' ? 'OK' : tone === 'bad' ? 'Not ready' : tone === 'warn' ? 'Check' : '…') +
        '<span class="grow"><b>' + ui.esc(label) + '</b><span>' + detail + '</span></span></li>';
    }
    function connectionHTML() {
      var c = state.data.connection, k = state.check;
      var rows = [];
      var errorFor = function (step) {
        var e = k && (k.errors || []).filter(function (x) { return x.step === step; })[0];
        return e ? ui.esc(e.message) : '';
      };
      if (state.checking || !k) rows.push(row('', 'Asking Meta', 'One moment.'));
      else {
        rows.push(k.account
          ? row('ok', 'Instagram account', '@' + ui.esc(k.account.username || k.account.id))
          : row('bad', 'Instagram account', errorFor('account') || 'Not reachable with this token.'));
        rows.push(k.token && k.token.valid
          ? row('ok', 'Access token', ui.esc(k.token.type || '') + (k.token.expiresAt ? ', expires ' + ui.date(k.token.expiresAt) : ''))
          : row('bad', 'Access token', errorFor('token') || 'Meta did not accept it.'));
        rows.push(!k.token || !k.token.scopes ? row('warn', 'Permissions', 'Meta does not list these for an Instagram Login token. A test comment will show it.')
          : k.missing && k.missing.length ? row('bad', 'Permissions', 'Missing: ' + k.missing.map(ui.esc).join(', '))
            : row('ok', 'Permissions', 'Comments and messages are allowed.'));
        rows.push(k.conversations != null ? row('ok', 'Message access', 'Meta lets this app read the account\'s messages.')
          : row('bad', 'Message access', errorFor('messages') || 'Not checked.'));
        rows.push(k.comments ? row(k.comments.readable ? 'ok' : 'warn', 'Comments', k.comments.readable + ' recent comments can be read' +
          (k.comments.latestAt ? ', the latest ' + ui.esc(ui.ago(k.comments.latestAt)) : '') + '.')
          : row('bad', 'Comments', errorFor('comments') || 'Not checked.'));
      }
      rows.push(c.gemini ? row('ok', 'AI model', ui.esc(c.model)) : row('bad', 'AI model', 'GEMINI_API_KEY is not set.'));
      return '<div class="ar-head"><h2>Connection</h2><div class="ar-row"><button class="adm__btn" data-act="subscribe">Connect webhook</button>' +
        '<button class="adm__btn" data-act="check">Check again</button></div></div>' +
        '<ul class="ar-conn">' + rows.join('') + '</ul>' +
        '<p class="adm__hint">Meta sends no webhooks to this app yet (Standard Access), so the account is read every minute instead.</p>' +
        '<h3>If you set the webhook by hand in Meta</h3>' + copyRow('Callback URL', c.webhookUrl) + copyRow('Verify token', c.verifyToken);
    }

    /* ----------------------------------------------------------------- inbox */
    function itemHTML(e) {
      var st = STATUS[e.status] || [e.status, ''];
      var open = e.status === 'draft' || e.status === 'needs_human';
      var detail = [e.intent, e.confidence != null ? Math.round(e.confidence * 100) + '% sure' : '', (e.phones || []).join(', ')].filter(Boolean).join(' · ');
      return '<article class="ar-item" data-id="' + ui.esc(e.id) + '"><div class="ar-row"><b>' + (e.kind === 'dm' ? 'Message' : 'Comment') +
        (e.username ? ' from @' + ui.esc(e.username) : '') + '</b><span class="adm__none">' + ui.esc(ui.ago(e.at)) + '</span>' + pill(st[1], st[0]) + '</div>' +
        '<p class="ar-said">' + ui.esc(e.text || '(no text)') + '</p>' +
        (open ? '<textarea rows="3" maxlength="2000" data-reply>' + ui.esc(e.reply || '') + '</textarea>'
          : e.reply ? '<p class="ar-reply">' + ui.esc(e.reply) + '</p>' : '') +
        (detail ? '<p class="adm__none ar-meta">' + ui.esc(detail) + '</p>' : '') +
        (e.reason || e.error ? '<p class="ar-why">' + ui.esc(REASONS[e.reason] || e.error || e.reason) + '</p>' : '') +
        (open ? '<div class="ar-row"><button class="adm__btn adm__btn--primary" data-act="send">Send</button>' +
            (e.status === 'needs_human' ? '<button class="adm__btn" data-act="retry">Try again</button>' : '') +
            '<button class="adm__btn" data-act="discard">Discard</button></div>'
          : e.status === 'queued' || e.status === 'failed' ? '<div class="ar-row"><button class="adm__btn" data-act="retry">Try again</button><button class="adm__btn" data-act="discard">Discard</button></div>' : '') +
        '</article>';
    }
    function inboxHTML() {
      var list = state.data.events;
      return list.length ? list.map(itemHTML).join('')
        : ui.emptyState('Nothing yet', 'Comments and messages appear here once the account is read.');
    }

    /* --------------------------------------------------------------- actions */
    function resultHTML(r) {
      if (!r.ok) return ui.banner('bad', '<b>No reply.</b> ' + ui.esc(r.reason || r.kind || 'The AI did not answer.'));
      return '<div class="ar-item">' + (r.shouldReply
        ? '<p class="ar-reply">' + ui.esc(r.reply) + '</p>' : '<p class="ar-why">No reply needed for this.</p>') +
        '<p class="adm__none ar-meta">' + ui.esc([r.intent, Math.round(r.confidence * 100) + '% sure'].filter(Boolean).join(' · ')) + '</p>' +
        (r.card ? '<div class="ar-card">' + (r.card.image_url ? '<img src="' + ui.esc(r.card.image_url) + '" alt="">' : '') +
          '<b>' + ui.esc(r.card.title) + '</b><span>' + ui.esc(r.card.subtitle) + '</span>' +
          r.card.buttons.map(function (b) { return '<a href="' + ui.esc(b.url) + '" target="_blank" rel="noopener">' + ui.esc(b.title) + '</a>'; }).join('') + '</div>' : '') +
        (r.instant ? '<p class="adm__none ar-meta">Sent at once, without waiting for you.</p>' : '') +
        (r.shouldReply && r.hold ? '<p class="ar-why">' + ui.esc(REASONS[r.hold] || r.hold) + (state.data.settings.mode === 'auto' && state.data.settings.takeOver ? ' Your holding line would go instead, and it would show under Needs your eye.' : ' It would wait for you.') + '</p>' : '') +
        (r.facts ? '<pre class="ar-facts">' + ui.esc(r.facts) + '</pre>' : '') + '</div>';
    }
    function saveSettings(patch, then) {
      ADM.api.autoReplyAction({ action: 'save', settings: patch }).then(function (r) {
        state.data.settings = r.settings;
        if (then) then();
      }, fail);
    }
    function act(name, id, card) {
      if (name === 'check') return runCheck();
      if (name === 'subscribe') {
        return ADM.api.autoReplyAction({ action: 'subscribe' }).then(function () {
          ctx.toast('Webhook connected');
        }, fail).then(runCheck);
      }
      if (state.busy) return null;
      state.busy = true;
      var box = card && card.querySelector('[data-reply]');
      return ADM.api.autoReplyAction({ action: name, id: id, reply: box ? box.value : undefined }).then(function () {
        ctx.toast(name === 'send' ? 'Reply sent' : name === 'discard' ? 'Discarded' : 'Done');
      }, fail).then(function () {
        state.busy = false;
        refresh();
      });
    }

    root.addEventListener('click', function (e) {
      var copy = e.target.closest('[data-copy]');
      if (copy) {
        global.navigator.clipboard.writeText(copy.getAttribute('data-copy')).then(function () { ctx.toast('Copied'); }, fail);
        return;
      }
      var mode = e.target.closest('[data-mode]');
      if (mode) {
        var next = mode.getAttribute('data-mode');
        if (next === state.data.settings.mode) return;
        if (next === 'auto' && !global.confirm('Turn on Auto? Replies will go out under your brand without you reading them first.')) return;
        saveSettings({ mode: next }, function () { paint(); ctx.toast('Saved'); });
        return;
      }
      var button = e.target.closest('[data-act]');
      if (!button) return;
      var card = button.closest('[data-id]');
      act(button.getAttribute('data-act'), card && card.getAttribute('data-id'), card);
    });

    root.addEventListener('change', function (e) {
      var key = e.target.getAttribute && e.target.getAttribute('data-setting');
      if (!key) return;
      var patch = {};
      patch[key] = e.target.checked;
      saveSettings(patch, function () { paint(); ctx.toast('Saved'); });
    });

    root.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      if (f.id === 'arTrain') {
        var patch = {};
        FIELDS.forEach(function (x) { patch[x[0]] = f.elements[x[0]].value; });
        NUMBERS.forEach(function (x) { patch[x[0]] = Number(f.elements[x[0]].value); });
        saveSettings(patch, function () { ctx.toast('Training saved'); });
      } else if (f.id === 'arTest') {
        if (!f.elements.text.value.trim()) return;
        el('arResult').innerHTML = '<p class="adm__none">Writing…</p>';
        ADM.api.autoReplyAction({ action: 'test', text: f.elements.text.value, kind: f.elements.kind.value, caption: f.elements.caption.value }).then(function (r) {
          el('arResult').innerHTML = resultHTML(r);
        }, function (err) {
          el('arResult').innerHTML = resultHTML({ ok: false, reason: err.message });
        });
      }
    });

    /* While the page is open it reads Instagram itself, so a reply does not wait for
       the schedule. It stops when the page is left. */
    var timer = global.setInterval(function () {
      if (!document.body.contains(root)) { global.clearInterval(timer); return; }
      /* a page left open in a hidden tab reads nothing: the schedule still answers */
      if (document.hidden) return;
      ADM.api.autoReplyAction({ action: 'poll' }).then(function (r) {
        if (r && r.found && state.data && !root.querySelector('details[open] textarea:focus, details[open] input:focus')) refresh();
      }, function () { /* the next tick tries again */ });
    }, 60000);

    root.innerHTML = '<div class="adm__head"><div><h1>Auto Reply</h1></div></div><div class="ar2-kpis">' + [1, 2, 3, 4, 5].map(function () { return '<div class="ar2-kpi adm__skel" style="height:86px"></div>'; }).join('') + '</div>';
    load();
  }

  ADM.pages = ADM.pages || {};
  ADM.pages.autoReply = { render: render };
})(window);
