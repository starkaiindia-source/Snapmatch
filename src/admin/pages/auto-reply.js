/* ============================================================================
   Mobile Parts Finder · admin/pages/auto-reply.js
   ----------------------------------------------------------------------------
   Auto Reply: the owner's Instagram account answered by AI. Instagram is the first
   channel; WhatsApp and Facebook are shown as what comes next and do nothing yet.

   ----------------------------------------------------------------------------
   WHAT THIS PAGE WILL AND WILL NOT SAY

   "Connected" is what Meta answered a moment ago when this page asked, never what
   was configured. Whether the app is Live is the one thing Meta will not tell a
   token, so it is listed as a step for a person to confirm and is not ticked.

   The test box writes the reply a message would get and sends nothing. Every real
   comment and message is in the inbox with what the AI wrote and why it did or did
   not go out, so the owner can read a week of it before choosing Auto.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, ADM = SM.adm, ui = ADM.ui;

  var MODES = [
    ['off', 'Off', 'Nothing is read or answered.'],
    ['review', 'Review first', 'AI writes each reply. You press Send.'],
    ['auto', 'Auto', 'AI answers by itself. Anything unsure waits for you.']
  ];
  var STATUS = {
    queued: ['Queued', 'info'], draft: ['Draft', 'info'], needs_human: ['Needs you', 'warn'], sending: ['Sending', 'info'],
    sent: ['Sent', 'ok'], ignored: ['No reply needed', ''], skipped: ['Skipped', ''], failed: ['Failed', 'bad'], discarded: ['Discarded', '']
  };
  var REASONS = {
    'needs-human': 'The AI asked for a person.', 'low-confidence': 'The AI was not sure enough.', 'blocked-word': 'The reply had a blocked word.',
    'unknown-link': 'The reply had a link that is not in your links.', 'too-long': 'The reply was too long for Instagram.', empty: 'The AI wrote nothing.',
    'unchecked-fit': 'It said a product fits, but the post names no phone to check that against.',
    'no-text': 'No text in this message, such as a photo.', 'auto-reply-off': 'Auto Reply was off.', 'channel-off': 'This channel was off.',
    'sender-limit': 'This person reached the hourly limit.', 'daily-limit': 'The daily limit was reached.',
    'link-already-sent': 'This person got the app link in the last day.'
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
    var state = { data: null, check: null, checking: false, busy: false, result: null };

    function el(id) { return root.querySelector('#' + id); }
    function fail(err) { ctx.toast((err && err.message) || 'Request failed', 'bad'); }

    function load() {
      ADM.api.autoReply({ view: 'overview' }).then(function (d) {
        state.data = d;
        root.innerHTML = pageHTML();
        runCheck();
      }, function (err) {
        root.innerHTML = '<div class="adm__head"><h1>Auto Reply</h1></div>' + ui.banner('bad', '<b>Could not load.</b> ' + ui.esc(err.message || 'request failed'));
      });
    }
    function refreshInbox() {
      ADM.api.autoReply({ view: 'overview' }).then(function (d) {
        state.data = d;
        el('arInbox').innerHTML = inboxHTML();
      }, fail);
    }
    function runCheck() {
      state.checking = true;
      el('arConn').innerHTML = connectionHTML();
      ADM.api.autoReply({ view: 'check' }).then(function (c) {
        state.check = c;
      }, function (err) {
        state.check = { errors: [{ step: 'check', message: err.message || 'request failed' }] };
      }).then(function () {
        state.checking = false;
        if (el('arConn')) el('arConn').innerHTML = connectionHTML();
      });
    }

    /* ------------------------------------------------------------- the page */
    function pageHTML() {
      return '<div class="adm__head"><div><h1>Auto Reply</h1>' +
        '<p>AI answers to comments and messages on your Instagram account.</p></div></div>' +
        '<div class="ar-tabs"><span class="is-on">Instagram</span><span>WhatsApp · next</span><span>Facebook · later</span></div>' +
        '<div class="adm__card"><h2>How it replies</h2><div id="arMode">' + modeHTML() + '</div></div>' +
        '<div class="adm__card" id="arConn"></div>' +
        '<div class="adm__card"><h2>Training</h2><p class="adm__hint">The AI answers only from this text and your compatibility data. ' +
        'Anything not written here, it will not make up.</p>' + trainingHTML() + '</div>' +
        '<div class="adm__card"><h2>Try a message</h2><p class="adm__hint">Shows the reply it would write. Nothing is sent to anyone.</p>' +
        '<form id="arTest" class="ar-form"><textarea name="text" rows="2" maxlength="1000" placeholder="realme 5 ku indha temper match aaguma?"></textarea>' +
        '<input name="caption" maxlength="2000" placeholder="Caption of the post, if the comment is on one">' +
        '<div class="ar-row"><select name="kind"><option value="comment">As a comment</option><option value="dm">As a message</option></select>' +
        '<button class="adm__btn adm__btn--primary" type="submit">Write a reply</button></div></form><div id="arResult"></div></div>' +
        '<div class="adm__card"><h2>Inbox</h2><div id="arInbox">' + inboxHTML() + '</div></div>';
    }

    function modeHTML() {
      var s = state.data.settings;
      return '<div class="ar-modes">' + MODES.map(function (m) {
        return '<button class="ar-mode' + (s.mode === m[0] ? ' is-on' : '') + '" data-mode="' + m[0] + '" aria-pressed="' + (s.mode === m[0]) + '"><b>' + m[1] + '</b><span>' + m[2] + '</span></button>';
      }).join('') + '</div><div class="ar-row">' +
        '<label class="ar-check"><input type="checkbox" data-channel="comments"' + (s.comments ? ' checked' : '') + '> Comments</label>' +
        '<label class="ar-check"><input type="checkbox" data-channel="dms"' + (s.dms ? ' checked' : '') + '> Direct messages</label>' +
        '<label class="ar-check"><input type="checkbox" data-channel="salesOn"' + (s.salesOn ? ' checked' : '') + '> 9H sales and orders</label>' +
        '<a class="adm__btn" href="/admin/leads">Open Leads</a></div>';
    }

    function trainingHTML() {
      var s = state.data.settings;
      return '<form id="arTrain" class="ar-form">' + FIELDS.map(function (f) {
        var value = ui.esc(s[f[0]] || '');
        return '<label>' + f[1] + (f[2] === 'text'
          ? '<textarea name="' + f[0] + '" rows="' + (f[0] === 'products' ? 7 : 3) + '" placeholder="' + ui.esc(f[3]) + '">' + value + '</textarea>'
          : '<input name="' + f[0] + '" value="' + value + '" placeholder="' + ui.esc(f[3]) + '">') + '</label>';
      }).join('') + '<div class="ar-nums">' + NUMBERS.map(function (n) {
        return '<label>' + n[1] + '<input type="number" name="' + n[0] + '" min="' + n[2] + '" max="' + n[3] + '" step="' + n[4] + '" value="' + ui.esc(s[n[0]]) + '"></label>';
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
        if (k.login === 'facebook' && (!k.token || k.token.type !== 'SYSTEM_USER')) {
          rows.push(k.page ? row('ok', 'Linked Facebook Page', ui.esc(k.page.name || k.page.id))
            : row('bad', 'Linked Facebook Page', errorFor('page') || 'No Page linked to this account was found for this token.'));
        }
        rows.push(!k.token || !k.token.scopes ? row('warn', 'Permissions', 'Meta does not list these for an Instagram Login token. A test comment will show it.')
          : k.missing && k.missing.length ? row('bad', 'Permissions', 'Missing: ' + k.missing.map(ui.esc).join(', '))
            : row('ok', 'Permissions', 'Comments and messages are allowed.'));
        var subs = k.subscribed;
        var wanted = c.fields.filter(function (f) { return !subs || subs.indexOf(f) < 0; });
        var hooked = k.webhook && k.webhook.url === c.webhookUrl;
        if (k.login === 'facebook') {
          rows.push(hooked ? row('ok', 'App webhook', k.webhook.fields.map(ui.esc).join(', '))
            : row('bad', 'App webhook', errorFor('webhook') || 'Not pointing at this site yet.'));
        }
        rows.push(subs && !wanted.length ? row('ok', 'Receiving events', subs.map(ui.esc).join(', '))
          : row('bad', 'Receiving events', errorFor('subscription') || 'Not subscribed to: ' + wanted.map(ui.esc).join(', ')));
      }
      if (k && !state.checking) {
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
        '<h3>Steps only you can do</h3><ol class="ar-steps">' +
        '<li>Press <b>Publish</b> on the Meta app. Meta sends nothing to an app that is not Live.</li>' +
        '<li>In Business settings, System users, generate a new token for this app with <b>instagram_manage_comments</b> and <b>instagram_manage_messages</b> ticked, set to never expire. ' +
        'Put it in Vercel as <code>INSTAGRAM_REPLY_ACCESS_TOKEN</code> and redeploy.</li>' +
        '<li>In the Instagram app: Settings, Messages and story replies, Message controls, then turn on <b>Allow access to messages</b>.</li>' +
        '<li>Press <b>Connect webhook</b> above, then comment on one of your posts from another account.</li></ol>' +
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
        (open ? '<div class="ar-row"><button class="adm__btn adm__btn--primary" data-act="send">Send</button><button class="adm__btn" data-act="discard">Discard</button></div>'
          : e.status === 'queued' || e.status === 'failed' ? '<div class="ar-row"><button class="adm__btn" data-act="retry">Try again</button><button class="adm__btn" data-act="discard">Discard</button></div>' : '') +
        '</article>';
    }
    function inboxHTML() {
      var list = state.data.events;
      return list.length ? list.map(itemHTML).join('')
        : ui.emptyState('Nothing yet', 'Comments and messages appear here once Meta starts sending them.');
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
        (r.shouldReply && r.hold ? '<p class="ar-why">' + ui.esc(REASONS[r.hold] || r.hold) + ' It would wait for you.</p>' : '') +
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
        refreshInbox();
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
        if (next === 'auto' && !global.confirm('Turn on Auto? Replies will go out under your brand without you reading them first.')) return;
        saveSettings({ mode: next }, function () {
          el('arMode').innerHTML = modeHTML();
          ctx.toast('Saved');
        });
        return;
      }
      var button = e.target.closest('[data-act]');
      if (!button) return;
      var card = button.closest('[data-id]');
      act(button.getAttribute('data-act'), card && card.getAttribute('data-id'), card);
    });

    root.addEventListener('change', function (e) {
      var channel = e.target.getAttribute && e.target.getAttribute('data-channel');
      if (!channel) return;
      var patch = {};
      patch[channel] = e.target.checked;
      saveSettings(patch, function () { ctx.toast('Saved'); });
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
      ADM.api.autoReplyAction({ action: 'poll' }).then(function (r) {
        if (r && r.found && state.data) refreshInbox();
      }, function () { /* the next tick tries again */ });
    }, 60000);

    root.innerHTML = '<div class="adm__head"><div><h1>Auto Reply</h1></div></div><div class="adm__card"><div class="adm__skel" style="height:60px"></div></div>';
    load();
  }

  ADM.pages = ADM.pages || {};
  ADM.pages.autoReply = { render: render };
})(window);
