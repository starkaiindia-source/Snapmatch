/* ============================================================================
   GET  /api/admin/auto-reply?view=overview|check|history|leads|inbox|people|thread
   POST /api/admin/auto-reply {action}   save, test, send, discard, retry, subscribe, poll, lead,
                                        reply, contact, suggest, bill, paid (the inbox)
   ----------------------------------------------------------------------------
   The owner's page for answering the Instagram account. A section of the one admin
   function, like every other: the project is at Vercel Hobby's 12-function limit.

   One permission, autoreply.manage, on every request. Only the owner's role holds
   it: a reply from here goes out in public under the brand's name.

   `check` and `test` cost a call to Meta or to the model, so neither runs unless
   the page asks. No token or secret leaves this file. The verify token does, to
   the owner, because the owner has to paste it into Meta's dashboard, and it can
   only be used to confirm this address.
   ========================================================================== */
'use strict';

const { requirePermission } = require('../_lib/admin-auth');
const { PERMISSIONS } = require('../_schema/roles');
const { ok, bad, json, fail, notAllowed, body } = require('../_lib/http');
const audit = require('../_services/audit-service');
const replies = require('../_services/auto-reply/service');

const WORDS = {
  'not-open': 'This one was already dealt with.',
  missing: 'This message no longer exists.',
  empty: 'There is nothing to send.',
  'too-long': 'This reply is longer than Instagram allows.',
  'blocked-word': 'This reply contains a blocked word.',
  'unknown-link': 'This reply has a link that is not in your allowed links.'
};

const accountOf = v => (v === 'mpf' ? 'mpf' : 'proglide');
const validId = v => (typeof v === 'string' && /^[0-9a-f]{32}$/.test(v) ? v : null);

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') return notAllowed(res);
    const admin = await requirePermission(req, res, PERMISSIONS.AUTO_REPLY_MANAGE);
    if (!admin) return;
    const view = (req.query || {}).view;
    if (req.method === 'GET') {
      if (view === 'leads') return ok(res, { leads: await replies.sales.listLeads() });
      /* the inbox: every chat on every channel, the leads and notes behind them, one chat */
      if (view === 'inbox') return ok(res, await replies.inboxList({ more: req.query.more === '1', fresh: req.query.fresh === '1' }));
      if (view === 'people') return ok(res, await replies.inboxLeads());
      if (view === 'thread') {
        const t = await replies.inboxThread(req.query || {});
        return t ? ok(res, t) : bad(res, 'channel and userId are required');
      }
      if (view === 'performance') return ok(res, await replies.performance());
      /* the numbers again, read fresh; the posts flagged comments are on */
      if (view === 'stats') return ok(res, await replies.stats(Date.now(), true, accountOf(req.query.account)));
      if (view === 'posts') return ok(res, { posts: await replies.postsOf(String(req.query.ids || '').split(','), accountOf(req.query.account)) });
      const account = accountOf(req.query.account);
      return ok(res, view === 'check' ? await replies.liveCheck(account) : view === 'history' ? await replies.history() : await replies.overview(account));
    }
    return await act(req, res, admin);
  } catch (err) {
    if (err instanceof replies.GraphError) return json(res, 502, { error: err.message, kind: err.kind });
    return fail(res, err, 'admin-auto-reply');
  }
};

async function act(req, res, admin) {
  const input = body(req);
  const id = validId(input.id);
  const done = async (action, targetId, detail) => audit.record({
    actorUid: admin.uid, actorRole: admin.role, action, targetType: 'auto_reply', targetId, detail, now: Date.now()
  });

  switch (input.action) {
    case 'save': {
      const account = accountOf(input.account);
      const settings = await replies.saveSettings(input.settings || {}, admin.uid, account);
      await done(audit.ACTIONS.AUTO_REPLY_SETTINGS_SAVED, account === 'mpf' ? 'instagram-mpf' : 'instagram', { mode: settings.mode, comments: settings.comments, dms: settings.dms });
      return ok(res, { settings });
    }
    case 'test': {
      if (typeof input.text !== 'string' || !input.text.trim()) return bad(res, 'text is required');
      return ok(res, await replies.tryReply({ text: input.text, kind: input.kind, caption: input.caption, account: accountOf(input.account) }));
    }
    case 'poll': return ok(res, (await replies.poll()).body);
    case 'flagDone': {
      if (!id) return bad(res, 'id is required');
      return (await replies.resolveFlag(id)) ? ok(res, { done: true }) : bad(res, 'no such message');
    }
    case 'lead': {
      const lead = typeof input.id === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(input.id) ? await replies.sales.setStage(input.id, input.stage) : null;
      return lead ? ok(res, { lead }) : bad(res, 'no such lead or stage');
    }
    /* the inbox: a message, notes, a bill and a payment, all from the owner */
    case 'reply': {
      const r = await replies.inboxReply(input);
      if (!r.ok) return bad(res, r.error);
      await done(audit.ACTIONS.AUTO_REPLY_SENT, String(input.userId || ''), { channel: input.channel, from: 'inbox' });
      return ok(res, r);
    }
    case 'contact': {
      const c = await replies.inboxContact(input);
      return c ? ok(res, { contact: c }) : bad(res, 'channel and userId are required');
    }
    case 'suggest': {
      const r = await replies.inboxSuggest(input);
      return r.ok ? ok(res, r) : bad(res, r.error);
    }
    case 'bill': case 'paid': {
      if (input.channel !== 'instagram' || !/^[0-9A-Za-z_-]{3,64}$/.test(String(input.userId || ''))) return bad(res, 'bills are made for Instagram chats');
      try {
        const r = input.action === 'bill' ? await replies.inboxBill(input) : await replies.inboxPaid(input);
        await done(audit.ACTIONS.AUTO_REPLY_SENT, String(input.userId), { action: input.action, bill: r.billNumber });
        return ok(res, r);
      } catch (err) {
        if (err.code === 'bad-input') return bad(res, err.message);
        throw err;
      }
    }
    case 'subscribe': {
      const r = await replies.subscribe();
      await done(audit.ACTIONS.AUTO_REPLY_SUBSCRIBED, 'instagram', r);
      return ok(res, r);
    }
    case 'send': {
      if (!id) return bad(res, 'id is required');
      const r = await replies.sendDraft(id, input.reply, admin.uid);
      if (!r.ok) return json(res, 409, { error: r.message || WORDS[r.code] || r.code, code: r.code });
      await done(audit.ACTIONS.AUTO_REPLY_SENT, id, {});
      return ok(res, r);
    }
    case 'discard': {
      if (!id) return bad(res, 'id is required');
      return ok(res, { discarded: await replies.discard(id) });
    }
    case 'retry': {
      if (!id) return bad(res, 'id is required');
      const r = await replies.retry(id);
      return r.ok ? ok(res, r) : json(res, 409, { error: WORDS[r.code] || r.code, code: r.code });
    }
    default:
      return bad(res, 'unknown action');
  }
}
