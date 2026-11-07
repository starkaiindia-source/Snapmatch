/* ============================================================================
   Mobile Parts Finder · api/_services/content/publish.js
   ----------------------------------------------------------------------------
   Posts a poster to Instagram, on either account the owner runs: a single
   picture or a carousel, with a caption.

   HOW INSTAGRAM TAKES A PICTURE

   The publishing API does not take an upload. It takes a public URL, fetches
   the JPEG from it, and makes a "container"; publishing the container is the
   post. This project has no Storage bucket (Spark plan), so the URL is our
   own: /api/poster draws the picture again on request. Each URL is signed here
   and stops working after URL_TTL_MS, so nobody can have the server draw
   posters on their behalf.

       single     POST /{ig}/media {image_url, caption}
       carousel   POST /{ig}/media {image_url, is_carousel_item} per slide,
                  then POST /{ig}/media {media_type: CAROUSEL, children, caption}
       then       wait for status_code FINISHED, POST /{ig}/media_publish

   WHICH ACCOUNT, WHICH POSTER

   The account decides the poster's brand (designs.js BRANDS): a post on the
   ProGlide account carries ProGlide's logo and "Comment LINK", one on the
   Mobile Parts Finder account carries that site's logo and address. The two
   never share a picture or a caption.

   THE TOKEN

   INSTAGRAM_PUBLISH_ACCESS_TOKEN: the system user's token, which reaches every
   Instagram account assigned to it in the business portfolio. It never leaves
   the server, is never logged, and check() reports what it can do, not what
   it is.
   ========================================================================== */
'use strict';

const crypto = require('crypto');
const C = require('../../_schema/collections');
const { db } = require('../../_lib/firebase');
const { GraphError, mapError } = require('../instagram/graph-client');
const content = require('./service');
const poster = require('./poster');

const VERSION = 'v25.0';
const SITE = 'https://www.mobilepartsfinder.com';
const URL_TTL_MS = 2 * 60 * 60 * 1000;
const READY_WAIT_MS = 40 * 1000;
const CAPTION_MAX = 2200;

const env = name => String(process.env[name] || '').trim();
const token = () => env('INSTAGRAM_PUBLISH_ACCESS_TOKEN');

const ACCOUNTS = {
  proglide: { id: 'proglide', label: 'ProGlide', brand: 'proglide', igUserId: () => env('INSTAGRAM_BUSINESS_ACCOUNT_ID') },
  mpf: { id: 'mpf', label: 'Mobile Parts Finder', brand: 'mpf', igUserId: () => env('INSTAGRAM_MPF_ACCOUNT_ID') || '17841434220027404' }
};

/* ------------------------------------------------------------ signed URLs */
function urlKey() {
  const t = token();
  return t ? crypto.createHmac('sha256', t).update('mpf-poster-url-v1').digest() : null;
}
const FIELDS = ['g', 'k', 's', 'd', 'p', 'b', 'e'];
const canonical = q => FIELDS.map(f => f + '=' + String(q[f] == null ? '' : q[f])).join('&');

/** The public address of one poster picture, good for URL_TTL_MS. */
function imageUrl(o, now = Date.now()) {
  const key = urlKey();
  if (!key) throw new GraphError('unconfigured', 'INSTAGRAM_PUBLISH_ACCESS_TOKEN is not set.');
  const q = { g: o.groupId, k: o.kind, s: o.slide || 0, d: o.design || '', p: o.palette || '', b: o.brand, e: (now + URL_TTL_MS).toString(36) };
  q.sig = crypto.createHmac('sha256', key).update(canonical(q)).digest('hex').slice(0, 32);
  return SITE + '/api/poster?' + Object.keys(q).map(k => k + '=' + encodeURIComponent(q[k])).join('&');
}

/** The picture a signed URL names, or null when the URL is not ours or is old. */
function verify(q, now = Date.now()) {
  const key = urlKey();
  if (!key || !q || typeof q.sig !== 'string') return null;
  const want = crypto.createHmac('sha256', key).update(canonical(q)).digest('hex').slice(0, 32);
  if (want.length !== q.sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(q.sig))) return null;
  if (!(parseInt(String(q.e), 36) > now)) return null;
  return { groupId: String(q.g), kind: q.k === 'carousel' ? 'carousel' : 'single', slide: Number(q.s) || 0, design: q.d || undefined, palette: q.p || undefined, brand: String(q.b) };
}

/* ---------------------------------------------------------------- Graph */
/* An app set to "Require app secret" refuses a call without appsecret_proof,
   and one that is not may refuse a proof from the wrong secret. So the proof is
   added only when Meta asks for it, from each app secret this project holds. */
const SECRETS = () => [env('INSTAGRAM_REPLY_APP_SECRET'), env('INSTAGRAM_APP_SECRET')].filter(Boolean);

async function graph(method, path, params, fetchImpl) {
  try {
    return await call(method, path, params, fetchImpl, null);
  } catch (err) {
    if (!/appsecret_proof/i.test(err.message)) throw err;
    let last = err;
    for (const secret of SECRETS()) {
      try { return await call(method, path, params, fetchImpl, secret); } catch (e) { last = e; }
    }
    throw last;
  }
}

async function call(method, path, params, fetchImpl, secret) {
  const url = new URL(`https://graph.facebook.com/${VERSION}/${path}`);
  const form = new URLSearchParams();
  const into = method === 'GET' ? url.searchParams : form;
  Object.keys(params || {}).forEach(k => into.set(k, String(params[k])));
  into.set('access_token', token());
  if (secret) into.set('appsecret_proof', crypto.createHmac('sha256', secret).update(token()).digest('hex'));
  let res;
  try {
    res = await (fetchImpl || globalThis.fetch)(url.toString(), {
      method, signal: AbortSignal.timeout(30000),
      headers: method === 'GET' ? undefined : { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: method === 'GET' ? undefined : form.toString()
    });
  } catch (err) {
    throw new GraphError('network', 'Instagram could not be reached.');
  }
  let json = null;
  try { json = await res.json(); } catch (err) { /* empty */ }
  if (res.ok && json && !json.error) return json;
  throw mapError(res, json);
}

/* -------------------------------------------------------------- captions */
const TAGS = {
  'screen-guards': '#temperedglass #screenguard #screenprotector',
  'back-cover': '#backcover #mobilecover #phonecase',
  'combo-display': '#combodisplay #mobiledisplay #displayreplacement',
  'middle-frame': '#middleframe #mobilespares',
  'cc-board': '#ccboard #chargingboard #mobilespares',
  battery: '#mobilebattery #batteryreplacement',
  'button-flex': '#buttonflex #mobilespares',
  'sim-tray': '#simtray #mobilespares'
};

/** A caption from the group itself: what fits, every model by brand, and the way in. */
function captionFor(group, brandOf, brandId) {
  const category = poster.categoryOf(group.groupId);
  const part = poster.PARTS[category];
  const master = group.masterModelName || (group.members[0] || {}).name || '';
  const n = group.members.length;
  const brands = new Map();
  group.members.forEach(m => {
    const b = brandOf(m) || m.name.split(' ')[0];
    if (!brands.has(b)) brands.set(b, []);
    brands.get(b).push(m.name.toLowerCase().indexOf(b.toLowerCase() + ' ') === 0 ? m.name.slice(b.length + 1) : m.name);
  });
  const mpf = brandId === 'mpf';
  const head = `${master} ${part.word} fits ${n} phones ✅\nஒரே ${part.ta} • ${n} மொபைல்களுக்கு!`;
  const way = mpf
    ? `🔎 Check the compatible parts of any phone free at mobilepartsfinder.com (link in bio)`
    : `📲 Comment LINK for the ProGlide app${part.price ? '\n💰 Comment 9H for price' : ''}`;
  const tags = `${TAGS[category] || '#mobilespares'} #mobileshop #mobilerepair #spareparts #compatibility` +
    (mpf ? ' #mobilepartsfinder' : ' #proglide');
  const room = CAPTION_MAX - head.length - way.length - tags.length - 40;
  const lines = [];
  let used = 0;
  let left = n;
  for (const [b, models] of Array.from(brands.entries()).sort((x, y) => y[1].length - x[1].length)) {
    const text = `${b}: ${models.join(', ')}`;
    if (used + text.length + 1 > room) break;
    lines.push(text);
    used += text.length + 1;
    left -= models.length;
  }
  if (left > 0) lines.push(`+ ${left} more ${mpf ? 'on the website' : 'in the app'}`);
  return [head, lines.join('\n'), way, tags].join('\n\n');
}

/* --------------------------------------------------------------- publish */
async function waitReady(id, fetchImpl, sleep) {
  const until = Date.now() + READY_WAIT_MS;
  for (;;) {
    const r = await graph('GET', id, { fields: 'status_code,status' }, fetchImpl);
    if (r.status_code === 'FINISHED') return;
    if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') {
      throw new GraphError('graph_error', `Instagram could not take the picture (${r.status_code}): ${String(r.status || '').slice(0, 200)}`);
    }
    if (Date.now() > until) throw new GraphError('graph_error', 'Instagram is still processing the picture. Try again in a minute.');
    await (sleep || (ms => new Promise(r2 => setTimeout(r2, ms))))(2000);
  }
}

/**
 * Posts one poster.
 * @param {object} o  account, group, kind ('single'|'carousel'), design, palette, caption, uid
 */
async function publish(o, deps = {}) {
  const acct = ACCOUNTS[o.account];
  if (!acct) return { ok: false, code: 'bad_account', message: 'Choose ProGlide or Mobile Parts Finder.' };
  if (!token()) return { ok: false, code: 'unconfigured', message: 'INSTAGRAM_PUBLISH_ACCESS_TOKEN is not set in Vercel.' };
  const ig = acct.igUserId();
  if (!ig) return { ok: false, code: 'unconfigured', message: `No Instagram account id for ${acct.label}.` };
  const kind = o.kind === 'carousel' ? 'carousel' : 'single';
  const group = await content.groupOf(o.group);
  if (!group) return { ok: false, code: 'missing', message: 'No such group.' };
  const caption = String(o.caption || '').trim().slice(0, CAPTION_MAX) || captionFor(group, content.brandOf, acct.brand);
  const first = await content.picture(group.groupId, { kind, slide: 0, design: o.design, palette: o.palette, brand: acct.brand });
  const slides = kind === 'carousel' ? Math.min(first.slides, 10) : 1;
  const base = { groupId: group.groupId, kind, design: o.design, palette: o.palette, brand: acct.brand };
  const f = deps.fetch;

  let creation;
  if (kind === 'single') {
    creation = (await graph('POST', `${ig}/media`, { image_url: imageUrl(base), caption }, f)).id;
  } else {
    const children = await Promise.all(Array.from({ length: slides }, (_, i) =>
      graph('POST', `${ig}/media`, { image_url: imageUrl(Object.assign({}, base, { slide: i })), is_carousel_item: true }, f).then(r => r.id)));
    creation = (await graph('POST', `${ig}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption }, f)).id;
  }
  await waitReady(creation, f, deps.sleep);
  const posted = await graph('POST', `${ig}/media_publish`, { creation_id: creation }, f);
  const info = await graph('GET', posted.id, { fields: 'permalink' }, f).catch(() => ({}));

  const record = {
    account: acct.id, groupId: group.groupId, kind, slides, design: o.design || null, palette: o.palette || null,
    caption, mediaId: posted.id, permalink: info.permalink || null, at: Date.now(), by: o.uid || null
  };
  await (deps.db || db)().collection(C.CONTENT_POSTS).doc(String(posted.id)).set(record).catch(err => console.warn('[publish] record', err && err.message));
  return { ok: true, mediaId: posted.id, permalink: record.permalink, slides };
}

/** What the token reaches: per account, its username and how many posts are left today. */
async function check(deps = {}) {
  if (!token()) return { configured: false, accounts: [] };
  const accounts = await Promise.all(Object.values(ACCOUNTS).map(async a => {
    const ig = a.igUserId();
    const out = { id: a.id, label: a.label, reachable: false, canPublish: false };
    if (!ig) return Object.assign(out, { error: 'no account id' });
    try {
      const me = await graph('GET', ig, { fields: 'username' }, deps.fetch);
      Object.assign(out, { reachable: true, username: me.username || null });
      const limit = await graph('GET', `${ig}/content_publishing_limit`, { fields: 'quota_usage,config' }, deps.fetch);
      const row = (limit.data || [])[0] || {};
      Object.assign(out, { canPublish: true, usedToday: row.quota_usage || 0, dailyLimit: (row.config && row.config.quota_total) || null });
    } catch (err) {
      out.error = err.message;
    }
    return out;
  }));
  return { configured: true, accounts };
}

/** The last posts made from here, newest first. */
async function recent(limit = 12) {
  const snap = await db().collection(C.CONTENT_POSTS).orderBy('at', 'desc').limit(limit).get();
  return snap.docs.map(d => {
    const v = d.data();
    return { mediaId: v.mediaId, account: v.account, groupId: v.groupId, kind: v.kind, permalink: v.permalink, at: v.at };
  });
}

module.exports = { ACCOUNTS, imageUrl, verify, captionFor, publish, check, recent, URL_TTL_MS };
