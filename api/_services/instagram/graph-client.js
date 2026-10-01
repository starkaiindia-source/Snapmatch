/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/graph-client.js
   ----------------------------------------------------------------------------
   The ONLY way this project reads Instagram: Meta's official Graph API.

   ----------------------------------------------------------------------------
   WHAT IT CAN READ, AND WHAT IT CANNOT

     · The business's OWN professional account: GET /{ig-user-id}/media
     · Another account's public media, IF that account is a professional
       (Business or Creator) account: Business Discovery,
         GET /{ig-user-id}?fields=business_discovery.username(NAME){…media…}

   Personal accounts, private accounts and age-gated accounts are NOT
   reachable, and this file does not try: the Graph API's refusal is mapped
   to `not_collectable` and the job says "Unable to collect" with Meta's
   reason. There is no fallback to the web page, no logged-in session, no
   headless browser and no retry that hopes the answer changes — backend/
   sources.js marks instagram.com itself `allowed: false`.

   Stories are not available through Business Discovery and are refused at
   URL validation. A reel whose audio is copyrighted comes back WITHOUT a
   media_url (Meta omits it); that item is processed from its caption alone
   and says so.

   ----------------------------------------------------------------------------
   RATE LIMITS ARE OBEYED, NOT WORKED AROUND

   Error codes 4, 17, 32, 613 and 80002 and HTTP 429 mean "slow down". They
   become `rate_limited` with the wait Meta reported in
   X-Business-Use-Case-Usage, and the job pauses until then. Nothing here
   rotates tokens, spreads calls across apps, or retries in a loop.

   ----------------------------------------------------------------------------
   THE TOKEN

   Server-side only, from INSTAGRAM_GRAPH_ACCESS_TOKEN. It travels as the
   access_token parameter Meta documents, so the request URL is never logged
   anywhere in this file. With INSTAGRAM_APP_SECRET set, every call carries
   appsecret_proof, which stops a leaked token being usable from anywhere
   that does not also hold the app secret.
   ========================================================================== */
'use strict';

const crypto = require('crypto');
const { shortcodeFromPermalink } = require('../../_schema/instagram');

const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,media_url,permalink,timestamp,' +
  'children{id,media_type,media_url}';
/* The own-account edge can also return thumbnail_url (a video's cover) and
   shortcode; Business Discovery does not offer them. */
const OWN_MEDIA_FIELDS = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,' +
  'shortcode,timestamp,children{id,media_type,media_url,thumbnail_url}';

class GraphError extends Error {
  constructor(kind, message, extra) {
    super(message);
    this.name = 'GraphError';
    this.kind = kind;
    Object.assign(this, extra || {});
  }
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);
const PERMISSION_CODES = new Set([3, 10, 200, 294]);

/**
 * @param {object} opts
 * @param {string} opts.token
 * @param {string} opts.igUserId        the business's own IG professional account id
 * @param {string} [opts.appSecret]
 * @param {string} [opts.version]       e.g. "v25.0"
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.fetchImpl]   injected in tests
 * @param {(kind:string)=>void} [opts.onCall]  usage logging
 */
function createGraphClient(opts = {}) {
  const token = opts.token || '';
  const igUserId = opts.igUserId || '';
  const version = opts.version || 'v25.0';
  const timeoutMs = opts.timeoutMs || 15000;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const onCall = typeof opts.onCall === 'function' ? opts.onCall : () => {};
  const proof = opts.appSecret
    ? crypto.createHmac('sha256', opts.appSecret).update(token).digest('hex') : null;

  function configured() { return !!(token && igUserId); }

  async function call(path, params) {
    if (!configured()) {
      throw new GraphError('unconfigured',
        'The Instagram Graph API is not configured: set INSTAGRAM_GRAPH_ACCESS_TOKEN and INSTAGRAM_BUSINESS_ACCOUNT_ID.');
    }
    const url = new URL(`https://graph.facebook.com/${version}/${path}`);
    Object.keys(params || {}).forEach(k => { if (params[k] != null) url.searchParams.set(k, String(params[k])); });
    url.searchParams.set('access_token', token);
    if (proof) url.searchParams.set('appsecret_proof', proof);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      onCall('graph');
      res = await fetchImpl(url.toString(), { method: 'GET', signal: controller.signal });
    } catch (err) {
      throw new GraphError('network', err && err.name === 'AbortError'
        ? 'The Instagram Graph API did not answer in time.'
        : 'The Instagram Graph API could not be reached.');
    } finally {
      clearTimeout(timer);
    }

    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (res.ok && body && !body.error) return body;
    throw mapError(res, body);
  }

  /** The business's own account: who the token belongs to. */
  async function ownProfile() {
    const body = await call(igUserId, { fields: 'id,username,name,followers_count,media_count' });
    return {
      igUserId: body.id, username: body.username ? String(body.username).toLowerCase() : null,
      name: body.name || null, followersCount: num(body.followers_count), mediaCount: num(body.media_count),
      accountType: 'professional'
    };
  }

  /**
   * One page of another professional account's public media.
   * @returns {Promise<{profile:object, media:object[], nextCursor:string|null}>}
   */
  async function discoverPage(username, { after = null, limit = 25 } = {}) {
    const mediaEdge = `media${after ? `.after(${after})` : ''}.limit(${limit}){${MEDIA_FIELDS}}`;
    const fields = `business_discovery.username(${username}){id,username,name,followers_count,media_count,${mediaEdge}}`;
    const body = await call(igUserId, { fields });
    const bd = body.business_discovery;
    if (!bd) {
      throw new GraphError('not_collectable',
        `@${username} is not visible to Business Discovery (it is not a public professional account).`);
    }
    const media = (bd.media && bd.media.data) || [];
    const cursor = nextCursor(bd.media && bd.media.paging, media.length, limit);
    return {
      profile: {
        igUserId: bd.id || null, username: bd.username ? String(bd.username).toLowerCase() : username,
        name: bd.name || null, followersCount: num(bd.followers_count), mediaCount: num(bd.media_count),
        accountType: 'professional'
      },
      media: media.map(normaliseMedia),
      nextCursor: cursor
    };
  }

  /** One page of the business's own media. */
  async function ownMediaPage({ after = null, limit = 25 } = {}) {
    const body = await call(`${igUserId}/media`, { fields: OWN_MEDIA_FIELDS, limit, after });
    const media = body.data || [];
    const cursor = nextCursor(body.paging, media.length, limit);
    return { media: media.map(normaliseMedia), nextCursor: cursor };
  }

  return { configured, ownProfile, discoverPage, ownMediaPage };
}

/**
 * The cursor for the next page, or null when there is none.
 *
 * Business Discovery's nested media edge pages by `cursors` ONLY — Meta does
 * not send a `next` link there (confirmed against the live API on
 * 2026-09-30). Requiring `next` stopped every Business Discovery import after
 * its first page. So: an `after` cursor with either a `next` link or a FULL
 * page means there may be more; a short page is the end. A last page that
 * happens to be exactly full costs one extra, empty call — and the job's
 * maxDiscoveryPages bounds it regardless.
 */
function nextCursor(paging, count, limit) {
  const after = paging && paging.cursors && paging.cursors.after;
  if (!after) return null;
  return paging.next || count >= limit ? after : null;
}

/** Graph's error envelope -> one of a small set of kinds a job can act on. */
function mapError(res, body) {
  const e = (body && body.error) || {};
  const code = Number(e.code);
  const sub = Number(e.error_subcode);
  const message = String(e.message || `HTTP ${res.status}`).slice(0, 300);
  const extra = { code: Number.isFinite(code) ? code : null, subcode: Number.isFinite(sub) ? sub : null, httpStatus: res.status };

  if (res.status === 429 || RATE_LIMIT_CODES.has(code)) {
    return new GraphError('rate_limited', 'Instagram rate limit reached: ' + message,
      Object.assign(extra, { retryAfterMs: retryAfter(res) }));
  }
  if (code === 190 || res.status === 401) {
    return new GraphError('token_invalid', 'The Instagram access token was rejected (expired or revoked): ' + message, extra);
  }
  /* 110 / 2207013 and the "cannot find user" family: a personal, private,
     age-gated or non-existent account. Business Discovery cannot see it. */
  if (code === 110 || sub === 2207013 || /cannot find user|not a business|professional account|does not exist|invalid user/i.test(message)) {
    return new GraphError('not_collectable',
      'Instagram reports this account cannot be read through Business Discovery (personal, private, age-gated or not found): ' + message, extra);
  }
  if (PERMISSION_CODES.has(code) || res.status === 403) {
    return new GraphError('permission_denied', 'The app lacks a permission this call needs: ' + message, extra);
  }
  return new GraphError('graph_error', 'Instagram Graph API error: ' + message, extra);
}

/** Meta's own estimate of when calls are allowed again, in ms. */
function retryAfter(res) {
  try {
    const raw = res.headers && (res.headers.get ? res.headers.get('x-business-use-case-usage') : null);
    if (raw) {
      const usage = JSON.parse(raw);
      let minutes = 0;
      Object.keys(usage).forEach(k => (usage[k] || []).forEach(u => {
        minutes = Math.max(minutes, Number(u.estimated_time_to_regain_access) || 0);
      }));
      if (minutes > 0) return minutes * 60 * 1000;
    }
  } catch { /* fall through */ }
  return 60 * 60 * 1000;   /* an hour: Meta's windows are hourly */
}

/** The API's media object -> the importer's shape. */
function normaliseMedia(m) {
  const type = String(m.media_type || '').toUpperCase();
  const product = String(m.media_product_type || '').toUpperCase();
  const children = ((m.children && m.children.data) || []).map(c => ({
    mediaId: String(c.id),
    mediaType: String(c.media_type || '').toUpperCase(),
    mediaUrl: c.media_url || null,
    thumbnailUrl: c.thumbnail_url || null
  }));
  let contentType = 'image';
  if (type === 'CAROUSEL_ALBUM') contentType = 'carousel';
  else if (type === 'VIDEO') contentType = product === 'REELS' ? 'reel' : 'video';
  return {
    mediaId: String(m.id),
    permalink: m.permalink || null,
    shortcode: m.shortcode || shortcodeFromPermalink(m.permalink),
    mediaType: type || null,
    productType: product || null,
    contentType,
    caption: typeof m.caption === 'string' ? m.caption : '',
    timestamp: m.timestamp ? Date.parse(m.timestamp) || null : null,
    mediaUrl: m.media_url || null,
    thumbnailUrl: m.thumbnail_url || null,
    /* Meta omits media_url for copyrighted or flagged media. Recorded so the
       item says why it was read from its caption only. */
    mediaUrlOmitted: type !== 'CAROUSEL_ALBUM' && !m.media_url,
    children
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { createGraphClient, GraphError, normaliseMedia, mapError, nextCursor, MEDIA_FIELDS };
