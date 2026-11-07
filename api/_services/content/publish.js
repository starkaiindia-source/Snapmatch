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
const FIELDS = ['g', 'k', 's', 'd', 'p', 'b', 't', 'w', 'a', 'c', 'e'];
const KINDS = ['single', 'carousel', 'promo', 'combo'];
const canonical = q => FIELDS.map(f => f + '=' + String(q[f] == null ? '' : q[f])).join('&');

/** The public address of one poster picture, good for URL_TTL_MS. */
function imageUrl(o, now = Date.now()) {
  const key = urlKey();
  if (!key) throw new GraphError('unconfigured', 'INSTAGRAM_PUBLISH_ACCESS_TOKEN is not set.');
  const q = { g: o.groupId, k: o.kind, s: o.slide || 0, d: o.design || '', p: o.palette || '', b: o.brand };
  if (o.template) q.t = o.template;
  if (o.keyword) q.w = o.keyword;
  if (o.also && o.also.length) q.a = o.also.join('.');
  if (o.cta) q.c = o.cta;
  q.e = (now + URL_TTL_MS).toString(36);
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
  const out = { groupId: String(q.g), kind: KINDS.indexOf(q.k) > -1 ? q.k : 'single', slide: Number(q.s) || 0, design: q.d || undefined, palette: q.p || undefined, brand: String(q.b) };
  if (q.t) out.template = String(q.t);
  if (q.w) out.keyword = String(q.w);
  if (q.a) out.also = String(q.a).split('.');
  if (q.c) out.cta = String(q.c);
  return out;
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
/* what else people call the part, for the search line */
const ALSO = {
  'screen-guards': 'screen guard', 'back-cover': 'back case', 'combo-display': 'combo LCD', 'middle-frame': 'housing frame',
  'cc-board': 'charging board', battery: 'battery replacement', 'button-flex': 'power button flex', 'sim-tray': 'SIM card tray'
};
/* Instagram takes at most five hashtags a post, so each is chosen: the phone,
   the phone with the part (what a shop types), the part, the trade, the brand.
   The words people search for go in the caption's text instead, where
   Instagram's search reads them. */
const PART_TAG = {
  'screen-guards': 'temperedglass', 'back-cover': 'backcover', 'combo-display': 'combodisplay', 'middle-frame': 'middleframe',
  'cc-board': 'ccboard', battery: 'mobilebattery', 'button-flex': 'buttonflex', 'sim-tray': 'simtray'
};
const tagOf = text => String(text || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]/g, '');

/** Five hashtags for a post about one phone's part. */
function hashtags(master, category, brandId) {
  const phone = tagOf(master);
  const part = PART_TAG[category] || 'mobilespares';
  const list = [phone && '#' + phone, phone && '#' + phone + part.replace(/^mobile/, ''), '#' + part,
    brandId === 'mpf' ? '#mobilespareparts' : '#mobileshop', brandId === 'mpf' ? '#mobilepartsfinder' : '#proglide'];
  return Array.from(new Set(list.filter(Boolean))).slice(0, 5).join(' ');
}

/* a few ways to open, turned by the group so the feed does not repeat itself;
   ProGlide talks to the shop counter, Mobile Parts Finder to the searcher */
const HOOKS = {
  proglide: [
    (m, w, n) => `${m} ${w}: one ${w} fits ${n} phones ✅`,
    (m, w, n) => `Same ${w} for ${n} phones, starting with the ${m} 📦`,
    (m, w, n) => `Stock one ${w}, sell it for ${n} models: the ${m} list ✅`
  ],
  mpf: [
    (m, w, n) => `Which phones take the same ${w} as the ${m}? ${n} of them 🔎`,
    (m, w, n) => `${m} ${w} compatible models: the full list of ${n} 📱`,
    (m, w, n) => `Looking for a ${m} ${w}? These ${n} phones share it 🔎`
  ]
};
const turn = (id, n) => String(id).split('').reduce((a, c) => a + c.charCodeAt(0), 0) % n;

/** Every model by brand, as long as the caption has room. */
function modelLines(group, brandOf, room, mpf) {
  const brands = new Map();
  group.members.forEach(m => {
    const b = brandOf(m) || m.name.split(' ')[0];
    if (!brands.has(b)) brands.set(b, []);
    brands.get(b).push(m.name.toLowerCase().indexOf(b.toLowerCase() + ' ') === 0 ? m.name.slice(b.length + 1) : m.name);
  });
  const lines = [];
  let used = 0;
  let left = group.members.length;
  for (const [b, models] of Array.from(brands.entries()).sort((x, y) => y[1].length - x[1].length)) {
    const text = `${b}: ${models.join(', ')}`;
    if (used + text.length + 1 > room) break;
    lines.push(text);
    used += text.length + 1;
    left -= models.length;
  }
  if (left > 0) lines.push(`+ ${left} more ${mpf ? 'on the website' : 'in the app'}`);
  return lines.join('\n');
}

/** A caption from the group itself: what fits, every model by brand, and the way in. */
function captionFor(group, brandOf, brandId, keyword, also) {
  const category = poster.categoryOf(group.groupId);
  const part = poster.PARTS[category];
  const master = group.masterModelName || (group.members[0] || {}).name || '';
  const n = group.members.length;
  const mpf = brandId === 'mpf';
  /* The first line is what Instagram shows and what search takes as the
     title, so it says what someone would type: the phone, the part, "compatible". */
  const hooks = HOOKS[mpf ? 'mpf' : 'proglide'];
  const head = hooks[turn(group.groupId, hooks.length)](master, part.word, n) + '\n' +
    (mpf ? `Check before you buy: every phone below takes the same ${part.word} as the ${master}.`
      : `Check before you order: every phone below takes the same ${part.word} as the ${master}. Stock one, serve many customers.`);
  const swipe = (also || []).length
    ? '➡️ Swipe for the ' + master + "'s " + also.map(g => (poster.PARTS[poster.categoryOf(g.groupId)] || {}).word).filter(Boolean).join(', ') + ' too.'
    : '';
  const way = mpf
    ? `🔎 Any phone's compatible parts, free: mobilepartsfinder.com (link in bio)`
    : `📲 Comment ${keyword || 'LINK'} and we DM you the free ProGlide app${part.price ? '\n💰 Comment 9H for the wholesale price' : ''}`;
  const search = (mpf ? 'For mobile shops, repair technicians and anyone fixing a phone.\n' : 'For mobile shop owners, repair technicians and accessory sellers.\n') +
    `${master} ${part.word} · ${master} ${ALSO[category] || part.word} compatible · same ${part.word} models · ${part.word} compatibility list`;
  const tags = hashtags(master, category, brandId);
  const room = CAPTION_MAX - head.length - swipe.length - way.length - search.length - tags.length - 40;
  return [head, swipe, modelLines(group, brandOf, room, mpf), way, search, tags].filter(Boolean).join('\n\n');
}

/** A combo poster's caption: one phone, each of its parts with the phones that share it. */
function comboCaption(groups, brandOf, brandId, keyword) {
  const first = groups[0];
  const master = first.masterModelName || (first.members[0] || {}).name || '';
  const mpf = brandId === 'mpf';
  const words = groups.map(g => (poster.PARTS[poster.categoryOf(g.groupId)] || {}).word).filter(Boolean);
  const head = (mpf ? `${master} spare parts: which phones share each one 🔎` : `${master} parts compatibility: ${words.length} parts, every phone that shares them 🛠️`) +
    `\n${words.join(', ').replace(/^./, c => c.toUpperCase())}: check the list before you order.`;
  const way = mpf
    ? `🔎 Every part of any phone, free: mobilepartsfinder.com (link in bio)`
    : `📲 Comment ${keyword || 'LINK'} and we DM you the free ProGlide app`;
  const search = `${master} ${words.join(' · ' + master + ' ')} · compatible models`;
  const tags = hashtags(master, poster.categoryOf(first.groupId), brandId);
  const room = Math.floor((CAPTION_MAX - head.length - way.length - search.length - tags.length - 60) / groups.length);
  const parts = groups.map(g => {
    const word = (poster.PARTS[poster.categoryOf(g.groupId)] || {}).word || 'part';
    const t = `🔧 ${word[0].toUpperCase() + word.slice(1)} · fits ${g.members.length} phones\n`;
    return t + modelLines(g, brandOf, room - t.length, mpf);
  });
  return [head, parts.join('\n\n'), way, search, tags].join('\n\n');
}

/** A marketing poster's caption: what the app or site does, in plain English, and the way in. */
function promoCaption(template, group, brandId, keyword, models) {
  const part = poster.PARTS[poster.categoryOf(group.groupId)];
  const n = group.members.length;
  const mpf = brandId === 'mpf';
  const thing = mpf ? 'mobilepartsfinder.com' : 'the ProGlide app';
  const count = models ? Math.floor(models / 100) * 100 + '+' : 'thousands of';
  const heads = {
    search: `Mobile parts compatibility finder: the matching parts for any phone in seconds 🔎\nType a model in ${thing} and see every tempered glass, back cover, display and battery that fits it.`,
    oneglass: `Universal ${part.word} for ${n} phones: 1 ${part.word} = ${n} models ✅\nStock one, fit many. Find the compatible ${part.word} of any phone with ${thing}.`,
    wrongpart: `Stop ordering the wrong mobile spare part ❌\nCheck what fits before you buy: tempered glass, back cover, display, battery, middle frame and more, for ${count} phone models.`,
    steps: `How to find the right mobile spare part in 3 steps 🛠️\n1. Type the phone model\n2. See every compatible part\n3. Sell the right one, first time`,
    numbers: `The mobile parts finder for phone shops 📱\n${count} phone models, 8 part types, one search. Same glass, same cover, same display: see which phones share them.`
  };
  const way = mpf ? '🔗 Search free at mobilepartsfinder.com (link in bio)' : `💬 Comment ${keyword || 'LINK'} and get the app link in your DM`;
  const search = 'Mobile spare parts compatibility · same tempered glass models · compatible back cover list · tool for mobile shops';
  const tags = mpf ? '#mobilepartsfinder #mobilespareparts #mobilerepair #temperedglass #phonerepair'
    : '#proglide #mobileshop #mobileaccessories #temperedglass #mobilerepair';
  return [heads[template] || heads.search, 'Made for mobile shop owners, repair technicians and accessory sellers, anywhere in the world.', way, search, tags].join('\n\n');
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
 * @param {object} o  account, group, kind ('single'|'carousel'), design, palette, caption, uid,
 *                   check (true: make the containers and wait for Instagram to take
 *                   the pictures, but publish nothing; a container left unpublished
 *                   is never shown and expires in a day)
 */
async function publish(o, deps = {}) {
  const acct = ACCOUNTS[o.account];
  if (!acct) return { ok: false, code: 'bad_account', message: 'Choose ProGlide or Mobile Parts Finder.' };
  if (!token()) return { ok: false, code: 'unconfigured', message: 'INSTAGRAM_PUBLISH_ACCESS_TOKEN is not set in Vercel.' };
  const ig = acct.igUserId();
  if (!ig) return { ok: false, code: 'unconfigured', message: `No Instagram account id for ${acct.label}.` };
  const kind = KINDS.indexOf(o.kind) > -1 ? o.kind : 'single';
  const group = await content.groupOf(o.group);
  if (!group) return { ok: false, code: 'missing', message: 'No such group.' };
  /* the master's other parts: a combo poster's, a carousel's extra slides */
  const alsoIds = (Array.isArray(o.also) ? o.also : []).filter(id => /^[a-z]{2}-\d{1,6}$/.test(String(id)) && id !== group.groupId).slice(0, 5);
  const also = kind === 'combo' || kind === 'carousel' ? (await Promise.all(alsoIds.map(id => content.groupOf(id).catch(() => null)))).filter(Boolean) : [];
  const cta = ['bar', 'sticker', 'stripe'].indexOf(o.cta) > -1 ? o.cta : undefined;
  /* a comment word only where the reply bot answers it: the ProGlide account */
  const keyword = acct.brand === 'proglide' && poster.KEYWORDS.indexOf(o.keyword) > -1 ? o.keyword : undefined;
  const template = kind === 'promo' ? (poster.PROMOS.find(t => t.id === o.template) || poster.PROMOS[0]).id : undefined;
  const caption = String(o.caption || '').trim().slice(0, CAPTION_MAX) || (kind === 'promo'
    ? promoCaption(template, group, acct.brand, keyword, o.models || content.modelCount())
    : kind === 'combo' ? comboCaption([group].concat(also), content.brandOf, acct.brand, keyword)
      : captionFor(group, content.brandOf, acct.brand, keyword, kind === 'carousel' ? also : []));
  const alsoUsed = also.map(g => g.groupId);
  const first = await content.picture(group.groupId, { kind, slide: 0, design: o.design, palette: o.palette, brand: acct.brand, template, keyword, also: alsoUsed, cta });
  const slides = kind === 'carousel' ? Math.min(first.slides, 10) : 1;
  const base = { groupId: group.groupId, kind, design: o.design, palette: o.palette, brand: acct.brand, template, keyword, also: alsoUsed, cta };
  const f = deps.fetch;

  let creation;
  if (kind !== 'carousel') {
    creation = (await graph('POST', `${ig}/media`, { image_url: imageUrl(base), caption }, f)).id;
  } else {
    const children = await Promise.all(Array.from({ length: slides }, (_, i) =>
      graph('POST', `${ig}/media`, { image_url: imageUrl(Object.assign({}, base, { slide: i })), is_carousel_item: true }, f).then(r => r.id)));
    creation = (await graph('POST', `${ig}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption }, f)).id;
  }
  await waitReady(creation, f, deps.sleep);
  if (o.check) return { ok: true, checked: true, slides };
  const posted = await graph('POST', `${ig}/media_publish`, { creation_id: creation }, f);
  const info = await graph('GET', posted.id, { fields: 'permalink' }, f).catch(() => ({}));

  const record = {
    account: acct.id, groupId: group.groupId, kind, slides, design: o.design || null, palette: o.palette || null,
    template: template || null, keyword: keyword || null, scheduleId: o.scheduleId || null, also: alsoUsed, cta: cta || null,
    row: o.meta && o.meta.row != null ? o.meta.row : null, column: (o.meta && o.meta.column) || null,
    master: (o.meta && o.meta.master) || group.masterModelName || null, filler: !!(o.meta && o.meta.filler),
    caption, mediaId: posted.id, permalink: info.permalink || null, at: Date.now(), by: o.uid || null
  };
  await (deps.db || db)().collection(C.CONTENT_POSTS).doc(String(posted.id)).set(record).catch(err => console.warn('[publish] record', err && err.message));
  return { ok: true, mediaId: posted.id, permalink: record.permalink, slides };
}

/** The account's post count, as the profile shows it; null when it cannot be read. */
async function mediaCount(account, deps = {}) {
  const acct = ACCOUNTS[account];
  const ig = acct && acct.igUserId();
  if (!ig || !token()) return null;
  const r = await graph('GET', ig, { fields: 'media_count' }, deps.fetch).catch(() => null);
  return r && typeof r.media_count === 'number' ? r.media_count : null;
}

/**
 * How many followers are online in each hour, Instagram's own hours 0..23, or
 * null when Instagram has no such numbers for the account (too few followers,
 * or no insights permission).
 */
async function onlineFollowers(account, deps = {}) {
  const acct = ACCOUNTS[account];
  const ig = acct && acct.igUserId();
  if (!ig || !token()) return null;
  const r = await graph('GET', `${ig}/insights`, { metric: 'online_followers', period: 'lifetime' }, deps.fetch).catch(() => null);
  const values = r && r.data && r.data[0] && r.data[0].values;
  if (!Array.isArray(values) || !values.length) return null;
  /* the days it gives, added up hour by hour */
  const hours = new Array(24).fill(0);
  let any = false;
  values.forEach(v => Object.keys(v.value || {}).forEach(h => {
    const i = Number(h);
    if (i >= 0 && i < 24) { hours[i] += Number(v.value[h]) || 0; any = true; }
  }));
  return any ? hours : null;
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
    return { mediaId: v.mediaId, account: v.account, groupId: v.groupId, kind: v.kind, permalink: v.permalink, at: v.at,
      design: v.design || null, palette: v.palette || null, template: v.template || null, keyword: v.keyword || null, scheduleId: v.scheduleId || null };
  });
}

module.exports = { ACCOUNTS, imageUrl, verify, captionFor, promoCaption, comboCaption, hashtags, publish, check, recent, graph, token, mediaCount, onlineFollowers, URL_TTL_MS };
