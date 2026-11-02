/* ============================================================================
   Mobile Parts Finder · api/_services/auto-reply/meta.js
   ----------------------------------------------------------------------------
   The calls Auto Reply makes to Meta: answer a comment, answer a message, read a
   post's caption, and report what the connection can do.

   TWO LOGINS, ONE CLIENT

   An Instagram Login token (it starts "IG") talks to graph.instagram.com and needs
   no Facebook Page. Any other token talks to graph.facebook.com. A Facebook Login
   token sends through the Page the account is linked to, whose token is asked for
   here rather than stored; a system-user token with no Page in reach sends as the
   Instagram account itself. Which of these a token is decides all of it, so moving
   an account from one to another is a change of token and nothing else.

   The importer's graph-client.js only reads, and its header promises that. Sending
   is kept out of it for that reason, and shares only its error mapping.

   The token travels as the access_token parameter Meta documents. A request URL is
   never logged, and check() returns what a token can do, never the token.
   ========================================================================== */
'use strict';

const crypto = require('crypto');
const { GraphError, mapError } = require('../instagram/graph-client');

const SCOPES = {
  facebook: ['instagram_basic', 'instagram_manage_comments', 'instagram_manage_messages',
    'pages_manage_metadata', 'pages_read_engagement', 'pages_show_list'],
  instagram: ['instagram_business_basic', 'instagram_business_manage_comments', 'instagram_business_manage_messages']
};
const FIELDS = 'comments,messages';

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

  async function call(method, path, { params, body, as } = {}) {
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
        method, signal: AbortSignal.timeout(timeoutMs),
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
    const me = await call('GET', 'me', { params: { fields: 'id,name,instagram_business_account' } });
    const linked = p => p.instagram_business_account && String(p.instagram_business_account.id) === String(igUserId);
    if (linked(me)) {
      page = { id: me.id, name: me.name, token };
      return page;
    }
    const list = await call('GET', 'me/accounts', { params: { fields: 'id,name,access_token,instagram_business_account', limit: 50 } });
    const hit = (list.data || []).filter(linked)[0];
    if (hit) page = { id: hit.id, name: hit.name, token: hit.access_token };
    return page;
  }

  async function pageToken() {
    const p = await linkedPage().catch(() => null);
    return p ? p.token : undefined;
  }

  async function replyToComment(commentId, text) {
    const r = await call('POST', `${commentId}/replies`, { params: { message: text }, as: await pageToken() });
    return r.id || null;
  }

  async function sendMessage(recipientId, text) {
    const as = await pageToken();
    const path = login === 'facebook' && !as ? `${igUserId}/messages` : 'me/messages';
    const r = await call('POST', path, { body: { recipient: { id: recipientId }, message: { text } }, as });
    return r.message_id || null;
  }

  async function caption(mediaId) {
    const r = await call('GET', mediaId, { params: { fields: 'caption' } });
    return typeof r.caption === 'string' ? r.caption : '';
  }

  /** Asks Meta to start sending this account's comments and messages. */
  async function subscribe() {
    if (login === 'instagram') {
      await call('POST', 'me/subscribed_apps', { params: { subscribed_fields: FIELDS } });
      return { fields: FIELDS.split(',') };
    }
    const p = await linkedPage().catch(() => null);
    await call('POST', `${p ? p.id : igUserId}/subscribed_apps`, { params: { subscribed_fields: FIELDS }, as: p ? p.token : undefined });
    return { fields: FIELDS.split(',') };
  }

  /** What this token and account can do, as Meta reports it. No secret is in it. */
  async function check() {
    const out = { login, host, account: null, page: null, token: null, missing: [], subscribed: null, errors: [] };
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
      }
      const p = await attempt('page', linkedPage);
      if (p) out.page = { id: p.id, name: p.name };
      const who = await attempt('account', () => call('GET', igUserId, { params: { fields: 'id,username' } }));
      if (who) out.account = { id: who.id, username: who.username || null };
      const subs = await attempt('subscription', () => call('GET', `${p ? p.id : igUserId}/subscribed_apps`, { as: p ? p.token : undefined }));
      if (subs) out.subscribed = ((subs.data || [])[0] || {}).subscribed_fields || [];
      return out;
    }

    const me = await attempt('token', () => call('GET', 'me', { params: { fields: 'user_id,username,account_type' } }));
    if (me) {
      out.token = { valid: true, type: me.account_type || 'INSTAGRAM', scopes: null, expiresAt: null };
      out.account = { id: me.user_id || me.id, username: me.username || null };
    }
    const subs = await attempt('subscription', () => call('GET', 'me/subscribed_apps'));
    if (subs) out.subscribed = ((subs.data || [])[0] || {}).subscribed_fields || [];
    return out;
  }

  return { login, host, replyToComment, sendMessage, caption, subscribe, check };
}

module.exports = { createMetaClient, SCOPES, FIELDS };
