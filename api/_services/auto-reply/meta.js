/* ============================================================================
   Mobile Parts Finder · api/_services/auto-reply/meta.js
   ----------------------------------------------------------------------------
   The calls Auto Reply makes to Meta: answer a comment, answer a message, read a
   post's caption, and report what the connection can do.

   TWO LOGINS, ONE CLIENT

   An Instagram Login token (it starts "IG") talks to graph.instagram.com. Any other
   token talks to graph.facebook.com and acts as the Instagram account itself, which
   is how a system-user token works (Meta's Unified Login) and needs no Facebook Page.
   A Facebook Login token is refused there, so it falls back to the Page the account
   is linked to, whose token is asked for here rather than stored. Which of these a
   token is decides all of it, so changing login is a change of token and nothing else.

   The importer's graph-client.js only reads, and its header promises that. Sending
   is kept out of it for that reason, and shares only its error mapping.

   The token travels as the access_token parameter Meta documents. A request URL is
   never logged, and check() returns what a token can do, never the token.
   ========================================================================== */
'use strict';

const crypto = require('crypto');
const { GraphError, mapError } = require('../instagram/graph-client');

const SCOPES = {
  facebook: ['instagram_basic', 'instagram_manage_comments', 'instagram_manage_messages'],
  instagram: ['instagram_business_basic', 'instagram_business_manage_comments', 'instagram_business_manage_messages']
};
const FIELDS = 'comments,messages';
/* A Page has no comments field, and refuses a list that names one. */
const PAGE_FIELDS = 'feed,messages';

/**
 * @param {object} opts
 * @param {string} opts.token
 * @param {string} opts.igUserId
 * @param {string} [opts.appSecret]
 * @param {string} [opts.version]
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.fetchImpl]
 */
function createMetaClient(opts = {}) {
  const token = opts.token || '';
  const igUserId = opts.igUserId || '';
  const version = opts.version || 'v25.0';
  const timeoutMs = opts.timeoutMs || 6000;
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const login = /^IG/.test(token) ? 'instagram' : 'facebook';
  const host = login === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
  let page = null;

  async function call(method, path, { params, body, as, wait } = {}) {
    const useToken = as || token;
    if (!useToken) throw new GraphError('unconfigured', 'No Instagram access token is set.');
    const url = new URL(`https://${host}/${version}/${path}`);
    Object.keys(params || {}).forEach(k => url.searchParams.set(k, String(params[k])));
    url.searchParams.set('access_token', useToken);
    if (login === 'facebook' && opts.appSecret) {
      url.searchParams.set('appsecret_proof', crypto.createHmac('sha256', opts.appSecret).update(useToken).digest('hex'));
    }
    let res;
    try {
      res = await doFetch(url.toString(), {
        method, signal: AbortSignal.timeout(wait || timeoutMs),
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (err) {
      throw new GraphError('network', 'Instagram could not be reached.');
    }
    let json = null;
    try { json = await res.json(); } catch (err) { /* an empty reply says nothing */ }
    if (res.ok && json && !json.error) return json;
    throw mapError(res, json);
  }

  /** The Facebook Page this account is linked to, with that Page's own token. */
  async function linkedPage() {
    if (login === 'instagram') return null;
    if (page) return page;
    const linked = p => p.instagram_business_account && String(p.instagram_business_account.id) === String(igUserId);
    const list = await call('GET', 'me/accounts', { params: { fields: 'id,name,access_token,instagram_business_account', limit: 50 } }).catch(() => null);
    const hit = list && (list.data || []).filter(linked)[0];
    if (hit) page = { id: hit.id, name: hit.name, token: hit.access_token };
    else {
      const me = await call('GET', 'me', { params: { fields: 'id,name,instagram_business_account' } });
      if (linked(me)) page = { id: me.id, name: me.name, token };
    }
    return page;
  }

  /** As the account first. If Meta refuses that, through the linked Page. */
  async function asAccount(run) {
    try { return await run(null); }
    catch (err) {
      if (login === 'instagram' || err.kind === 'rate_limited' || err.kind === 'network') throw err;
      const p = await linkedPage().catch(() => null);
      if (!p) throw err;
      /* the first refusal is the one that says what is wrong with this token */
      try { return await run(p); } catch (second) { throw err; }
    }
  }

  async function replyToComment(commentId, text) {
    const r = await asAccount(p => call('POST', `${commentId}/replies`, { params: { message: text }, as: p ? p.token : undefined }));
    return r.id || null;
  }

  async function send(recipient, message) {
    const body = { recipient, message };
    const r = await asAccount(p => call('POST', login === 'instagram' || p ? 'me/messages' : `${igUserId}/messages`, { body, as: p ? p.token : undefined }));
    return r.message_id || null;
  }

  /* A card with a picture, a title and buttons: a link a person can tap, where a link
     typed into a message is only text. card is { title, subtitle, image_url, buttons }. */
  const template = card => ({ attachment: { type: 'template', payload: { template_type: 'generic', elements: [card] } } });

  const sendMessage = (recipientId, text) => send({ id: recipientId }, { text });
  const sendCard = (recipientId, card) => send({ id: recipientId }, template(card));
  /* A picture from an https address, such as a payment QR. */
  const sendImage = (recipientId, url) => send({ id: recipientId }, { attachment: { type: 'image', payload: { url } } });
  /* A question with buttons the person taps to answer; the answer comes back as
     their message, in the button's words. At most 13, 20 characters each. */
  const sendQuick = (recipientId, text, answers) => send({ id: recipientId }, {
    text, quick_replies: answers.slice(0, 13).map(a => ({ content_type: 'text', title: a.slice(0, 20), payload: a.slice(0, 20).toUpperCase() }))
  });

  /* A message to someone who commented. Links in a comment cannot be tapped, so this
     is how a comment gets a link. Meta allows one for each person who comments. */
  const privateReply = (commentId, text) => send({ comment_id: commentId }, { text });
  const privateCard = (commentId, card) => send({ comment_id: commentId }, template(card));

  async function caption(mediaId) {
    const r = await call('GET', mediaId, { params: { fields: 'caption' } });
    return typeof r.caption === 'string' ? r.caption : '';
  }

  /* The app's own webhook, set with the app's token so nobody has to paste a secret
     into a dashboard. Meta calls the address back to confirm it before saying yes. */
  const appToken = appId => `${appId}|${opts.appSecret}`;

  async function connectWebhook({ appId, callbackUrl, verifyToken }) {
    await call('POST', `${appId}/subscriptions`, {
      as: appToken(appId),
      params: { object: 'instagram', callback_url: callbackUrl, fields: FIELDS, verify_token: verifyToken, include_values: 'true' }
    });
  }

  async function appWebhook(appId) {
    const r = await call('GET', `${appId}/subscriptions`, { as: appToken(appId) });
    const sub = (r.data || []).filter(s => s.object === 'instagram')[0];
    return sub ? { url: sub.callback_url, active: !!sub.active, fields: (sub.fields || []).map(f => f.name || f) } : null;
  }

  /** Asks Meta to start sending this account's comments and messages. */
  async function subscribe() {
    await asAccount(p => call('POST', `${login === 'instagram' ? 'me' : p ? p.id : igUserId}/subscribed_apps`, {
      params: { subscribed_fields: p ? PAGE_FIELDS : FIELDS }, as: p ? p.token : undefined
    }));
    return { fields: FIELDS.split(',') };
  }

  /* Reading is the proof that sending needs. Instagram's "Allow access to messages"
     cannot be asked about directly, but with it off Meta refuses to list conversations. */
  async function probe(out, attempt) {
    const account = login === 'instagram' ? 'me' : igUserId;
    const talks = await attempt('messages', () => call('GET', `${account}/conversations`, { params: { platform: 'instagram', limit: 5 } }));
    out.conversations = talks ? (talks.data || []).length : null;
    const media = await attempt('comments', () => call('GET', `${account}/media`, {
      params: { fields: 'id,comments_count,comments.limit(5){id,timestamp}', limit: 10 }
    }));
    if (!media) return;
    const stamps = [];
    (media.data || []).forEach(m => ((m.comments && m.comments.data) || []).forEach(c => stamps.push(Date.parse(c.timestamp) || 0)));
    out.comments = { posts: (media.data || []).length, readable: stamps.length, latestAt: stamps.length ? Math.max.apply(null, stamps) : null };
  }

  /**
   * The account's past: recent posts with their comments and the account's replies
   * under them, and recent conversations. For the owner to read, never stored.
   */
  async function history() {
    const account = login === 'instagram' ? 'me' : igUserId;
    const reply = '{id,text,timestamp,username,from}';
    const media = await call('GET', `${account}/media`, { wait: 25000, params: {
      fields: `id,caption,media_product_type,timestamp,permalink,comments_count,comments.limit(50){id,text,timestamp,username,from,replies.limit(10)${reply}}`,
      limit: 25
    } });
    const talks = await call('GET', `${account}/conversations`, { wait: 25000, params: {
      platform: 'instagram', fields: 'updated_time,messages.limit(30){id,message,created_time,from}', limit: 30
    } });
    return { media: media.data || [], conversations: talks.data || [] };
  }

  /**
   * Comments and messages since a moment, read rather than delivered. Meta only
   * delivers a stranger's comment or message to an app with Advanced Access, and
   * reading the account's own inbox needs only what this app has.
   */
  /* the read every minute is how anything arrives, so a slow Meta is waited for */
  const READ_WAIT_MS = 12000;
  async function recent(sinceMs) {
    const account = login === 'instagram' ? 'me' : igUserId;
    const out = { comments: [], messages: [] };
    const media = await call('GET', `${account}/media`, {
      params: { fields: 'id,comments.limit(25){id,text,timestamp,username,from,parent_id}', limit: 10 }, wait: READ_WAIT_MS
    });
    (media.data || []).forEach(m => ((m.comments && m.comments.data) || []).forEach(c => {
      const at = Date.parse(c.timestamp) || 0;
      if (at >= sinceMs) out.comments.push({ id: c.id, text: c.text || '', at, from: Object.assign({ username: c.username }, c.from || {}), mediaId: m.id, parentId: c.parent_id || null });
    }));
    const talks = await call('GET', `${account}/conversations`, {
      params: { platform: 'instagram', fields: 'messages.limit(5){id,message,created_time,from}', limit: 10 }, wait: READ_WAIT_MS
    });
    (talks.data || []).forEach(t => ((t.messages && t.messages.data) || []).forEach(m => {
      const at = Date.parse(m.created_time) || 0;
      if (at >= sinceMs) out.messages.push({ id: m.id, text: m.message || '', at, from: m.from || {} });
    }));
    return out;
  }

  async function username() {
    const r = await call('GET', login === 'instagram' ? 'me' : igUserId, { params: { fields: 'username' } });
    return r.username || '';
  }

  /** What this token and account can do, as Meta reports it. No secret is in it. */
  async function check() {
    const out = { login, host, account: null, page: null, token: null, missing: [], webhook: null, subscribed: null, errors: [] };
    const attempt = async (step, run) => {
      try { return await run(); }
      catch (err) {
        out.errors.push({ step, kind: err.kind || 'error', message: err.message });
        return null;
      }
    };

    if (login === 'facebook') {
      const debug = await attempt('token', () => call('GET', 'debug_token', { params: { input_token: token } }));
      const d = debug && debug.data;
      if (d) {
        out.token = {
          valid: !!d.is_valid, type: d.type || null, appId: d.app_id || null, scopes: d.scopes || [],
          expiresAt: d.expires_at ? d.expires_at * 1000 : null
        };
        out.missing = SCOPES.facebook.filter(s => (d.scopes || []).indexOf(s) < 0);
        if (d.app_id && opts.appSecret) out.webhook = await attempt('webhook', () => appWebhook(d.app_id));
      }
      const needsPage = !d || d.type !== 'SYSTEM_USER';
      const p = needsPage ? await attempt('page', linkedPage) : null;
      if (p) out.page = { id: p.id, name: p.name };
      const who = await attempt('account', () => call('GET', igUserId, { params: { fields: 'id,username' } }));
      if (who) out.account = { id: who.id, username: who.username || null };
      const subs = await attempt('subscription', () => call('GET', `${p ? p.id : igUserId}/subscribed_apps`, { as: p ? p.token : undefined }));
      if (subs) out.subscribed = ((subs.data || [])[0] || {}).subscribed_fields || [];
      await probe(out, attempt);
      return out;
    }

    const me = await attempt('token', () => call('GET', 'me', { params: { fields: 'user_id,username,account_type' } }));
    if (me) {
      out.token = { valid: true, type: me.account_type || 'INSTAGRAM', scopes: null, expiresAt: null };
      out.account = { id: me.user_id || me.id, username: me.username || null };
    }
    const subs = await attempt('subscription', () => call('GET', 'me/subscribed_apps'));
    if (subs) out.subscribed = ((subs.data || [])[0] || {}).subscribed_fields || [];
    await probe(out, attempt);
    return out;
  }

  return { login, host, replyToComment, sendMessage, sendCard, sendImage, sendQuick, privateReply, privateCard, caption, recent, history, username, connectWebhook, subscribe, check };
}

module.exports = { createMetaClient, SCOPES, FIELDS };
