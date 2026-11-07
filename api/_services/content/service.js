/* ============================================================================
   Mobile Parts Finder · api/_services/content/service.js
   ----------------------------------------------------------------------------
   What to post on @proglide_9h_screenguard, and the poster for it.

   A post is one compatibility group. Which group is worth a post comes from
   what people already want:

     searched   the models opened most on the site in the last two weeks
                (analyticsDaily.topModels, the counts the dashboard reads)
     asked      the phones named most in Instagram comments and messages
                lately (autoReplyEvents, read with the reply bot's own matcher)
     newest     the latest models in the catalogue: a new phone's glass and
                cover are asked for before anyone has a list
     biggest    the groups with the most models: the account's best posts were
                the long "universal" lists

   A model leads to its groups, one a part. The poster is drawn from the group's
   full member list, read the way the paid site reads it.

   This file only READS. Nothing is written, and nothing is posted from here.
   ========================================================================== */
'use strict';

const C = require('../../_schema/collections');
const { TIERS } = require('../../_schema/entitlement');
const { db } = require('../../_lib/firebase');
const search = require('../search-service');
const entitlements = require('../entitlement-service');
const responder = require('../auto-reply/responder');
const poster = require('./poster');
const photos = require('./picture-ai');
const phones = require('./phones');

const DAY_MS = 24 * 60 * 60 * 1000;
const SEARCH_DAYS = 14;
const EVENTS_READ = 150;
/* the lists change slowly and each costs Firestore reads, so a warm instance keeps them a while */
const IDEAS_MS = 10 * 60 * 1000;
let ideasCache = null;
const LIST = 12;
const GROUP_ID = /^[a-z]{2}-\d{1,6}$/;

const modelOf = id => {
  const m = search.loadIndex().byId.get(id);
  return m ? { id: m.id, name: m.name, year: m.year || null } : null;
};

const day = t => new Date(t).toISOString().slice(0, 10);

/** The models opened most on the site lately, most first. */
async function searched(now) {
  const days = [];
  for (let i = 0; i < SEARCH_DAYS; i++) days.push(day(now - i * DAY_MS));
  const snaps = await db().getAll(...days.map(d => db().collection(C.ANALYTICS_DAILY).doc(d)));
  const counts = new Map();
  snaps.forEach(s => {
    const top = (s.exists && s.data().topModels) || {};
    Object.keys(top).forEach(k => counts.set(k, (counts.get(k) || 0) + (Number(top[k]) || 0)));
  });
  return Array.from(counts.entries()).map(([id, count]) => Object.assign(modelOf(id) || {}, { count }))
    .filter(m => m.id).sort((a, b) => b.count - a.count).slice(0, LIST);
}

/** The phones named most in comments and messages lately, most first. */
async function asked() {
  const snap = await db().collection(C.AUTO_REPLY_EVENTS).orderBy('at', 'desc').limit(EVENTS_READ).get();
  const counts = new Map();
  snap.docs.forEach(d => responder.phonesIn(d.data().text || '').forEach(p => {
    const hit = counts.get(p.id) || { id: p.id, name: p.name, count: 0 };
    hit.count++;
    counts.set(p.id, hit);
  }));
  return Array.from(counts.values()).sort((a, b) => b.count - a.count).slice(0, LIST);
}

/** The latest models in the catalogue, newest year first, latest added first. */
function newest(limit = LIST) {
  const models = search.loadIndex().models;
  const top = models.reduce((y, m) => Math.max(y, m.year || 0), 0);
  return models.filter(m => m.year && m.year >= top - 1)
    .map((m, i) => ({ m, i })).sort((a, b) => (b.m.year - a.m.year) || (b.i - a.i))
    .slice(0, limit).map(({ m }) => ({ id: m.id, name: m.name, year: m.year }));
}

/** More of the newest phones, for a week of rows once the idea lists are used up. */
const latest = limit => newest(Math.min(Number(limit) || LIST, 400));

/** The groups with the most models. */
async function biggest() {
  const snap = await db().collection(C.GROUP_DETAILS).orderBy('memberCount', 'desc').limit(60).get();
  const seen = {};
  return snap.docs.filter(d => !d.data().mergedInto && poster.categoryOf(d.id)).map(d => ({
    groupId: d.id, categoryId: poster.categoryOf(d.id), master: d.data().drawingName || d.id, count: Number(d.data().memberCount) || 0
  })).filter(g => (seen[g.categoryId] = (seen[g.categoryId] || 0) + 1) <= 4).slice(0, LIST * 2);
}

/** Every source at once; a source that cannot be read is empty, not an error. */
async function ideas(now = Date.now()) {
  if (ideasCache && now - ideasCache.at < IDEAS_MS) {
    return Object.assign({}, ideasCache.value, { today: poster.planFor(poster.dayNumber(now)) });
  }
  const value = await readIdeas(now);
  if (value.searched.length || value.asked.length || value.biggest.length) ideasCache = { at: now, value };
  return value;
}

async function readIdeas(now) {
  const safe = (name, p) => Promise.resolve(p).catch(err => { console.warn('[content]', name, err && err.message); return []; });
  const [s, a, b] = await Promise.all([safe('searched', searched(now)), safe('asked', asked()), safe('biggest', biggest())]);
  return {
    searched: s, asked: a, newest: newest(), biggest: b,
    designs: poster.DESIGNS, palettes: poster.PALETTES, promos: poster.PROMOS, keywords: poster.KEYWORDS, today: poster.planFor(poster.dayNumber(now))
  };
}

/** A model's groups, one a part, with what the poster would say. */
async function groupsOf(modelId) {
  const model = modelOf(modelId);
  if (!model) return null;
  const compat = await entitlements.deviceGroupsForUser(modelId, TIERS.PAID);
  const groups = [];
  ((compat && compat.categories) || []).forEach(c => c.groups.forEach(g => {
    if (!poster.categoryOf(g.groupId)) return;
    groups.push({ groupId: g.groupId, categoryId: poster.categoryOf(g.groupId), master: g.masterModelName || model.name, count: g.memberCount || g.members.length });
  }));
  return { model, groups: groups.sort((a, b) => b.count - a.count) };
}

/** Models matching what the owner typed, for a poster of any phone. */
function find(q) {
  return search.findModels(String(q || '').slice(0, 60), { limit: 8 }).models.map(m => ({ id: m.id, name: m.name, year: m.year || null }));
}

const brandOf = m => {
  const idx = search.loadIndex();
  const known = idx.byId.get(m.id);
  const brand = known && idx.brands.get(known.brandId);
  return brand ? brand.name : null;
};

const DESIGN_IDS = poster.DESIGNS.map(x => x.id);
const CTA_IDS = ['bar', 'sticker', 'stripe'];
const PALETTE_IDS = poster.PALETTES.map(x => x.id);
const PROMO_IDS = poster.PROMOS.map(x => x.id);

/* a carousel's slides are drawn one a request, each reading the same groups;
   a warm function keeps them a while instead of reading Firestore again */
const groupKept = new Map();
const GROUP_KEEP_MS = 10 * 60 * 1000;
async function groupOf(groupId) {
  if (!GROUP_ID.test(String(groupId)) || !poster.categoryOf(groupId)) return null;
  const hit = groupKept.get(groupId);
  if (hit && Date.now() - hit.at < GROUP_KEEP_MS) return hit.group;
  const group = await entitlements.groupForUser(groupId, TIERS.PAID);
  const out = group && group.members && group.members.length ? group : null;
  if (groupKept.size > 300) groupKept.delete(groupKept.keys().next().value);
  groupKept.set(groupId, { at: Date.now(), group: out });
  return out;
}

/** The master's model id: the member named as the master, else the first. */
function masterIdOf(group) {
  const m = group.members.find(x => x.name === group.masterModelName) || group.members[0];
  return m ? m.id : null;
}

/**
 * The real pictures and numbers a poster shows, fetched before it is drawn:
 * the master's photo, one photo a brand (its first model), its screen size,
 * and ProGlide's store rating. Anything that cannot be fetched is left out.
 */
async function looks(group, brand) {
  const masterId = masterIdOf(group);
  const firstOf = new Map();
  group.members.forEach(m => {
    const b = brandOf(m) || m.name.split(' ')[0];
    if (!firstOf.has(b)) firstOf.set(b, m.id);
  });
  const [phone, play, ...shots] = await Promise.all([
    phones.phone(masterId),
    brand === 'mpf' ? null : phones.play(),
    ...Array.from(firstOf.values()).slice(0, 10).map(id => phones.phone(id))
  ]);
  const brandPhones = {};
  Array.from(firstOf.keys()).slice(0, 10).forEach((b, i) => { if (shots[i]) brandPhones[b] = shots[i]; });
  const info = phones.infoOf(masterId);
  return { phone: phone || undefined, play: play || undefined, brandPhones, inches: info && info.inches ? info.inches : undefined };
}

/**
 * One picture of a group's poster, as JPEG: the single poster, or one slide of
 * the carousel. Slides are drawn one a request so no answer is larger than a
 * picture. The design and colour are today's unless asked; the part's photo is
 * the kept AI photo when there is one.
 * @returns {Promise<{jpeg: Buffer, slides: number, photo: boolean}|null>}
 */
async function picture(groupId, o = {}) {
  const group = await groupOf(groupId);
  if (!group) return null;
  const category = poster.categoryOf(groupId);
  /* the other parts of the master: a combo poster's, or a carousel's extra slides */
  const alsoIds = (Array.isArray(o.also) ? o.also : String(o.also || '').split(/[.,]/)).filter(id => GROUP_ID.test(id) && id !== groupId).slice(0, 5);
  const [photo, look, also] = await Promise.all([
    photos.stored(category, group.masterModelName).catch(() => null),
    looks(group, o.brand).catch(() => ({})),
    Promise.all(alsoIds.map(id => groupOf(id).catch(() => null)))
  ]);
  await poster.ready();
  const opts = {
    cta: CTA_IDS.indexOf(o.cta) > -1 ? o.cta : undefined,
    phone: look.phone, play: look.play, brandPhones: look.brandPhones, inches: look.inches,
    design: DESIGN_IDS.indexOf(o.design) > -1 ? o.design : undefined,
    palette: PALETTE_IDS.indexOf(o.palette) > -1 ? o.palette : undefined,
    brand: poster.BRANDS.indexOf(o.brand) > -1 ? o.brand : undefined,
    keyword: poster.KEYWORDS.indexOf(o.keyword) > -1 ? o.keyword : undefined,
    template: PROMO_IDS.indexOf(o.template) > -1 ? o.template : undefined,
    models: search.loadIndex().models.length,
    picture: photo || undefined
  };
  const others = also.filter(Boolean);
  const pages = o.kind === 'carousel' ? poster.carousel(group, brandOf, opts, others)
    : o.kind === 'combo' ? [poster.combo([group].concat(others), brandOf, opts)]
      : o.kind === 'promo' ? [poster.promo(group, brandOf, opts)] : [poster.single(group, brandOf, opts)];
  const at = Math.min(Math.max(0, Number(o.slide) || 0), pages.length - 1);
  return { jpeg: Buffer.from(poster.toJpeg(pages[at])), slides: pages.length, photo: !!photo };
}

/** Makes (or makes again) the AI photo of a group's part and master. */
async function makePhoto(groupId, uid) {
  const group = await groupOf(groupId);
  if (!group) return { ok: false, code: 'missing', message: 'No such group.' };
  return photos.make(poster.categoryOf(groupId), group.masterModelName, uid);
}

/** How many phones the catalogue holds, for the marketing posters' numbers. */
const modelCount = () => search.loadIndex().models.length;

module.exports = { ideas, groupsOf, find, picture, makePhoto, groupOf, brandOf, modelCount, masterIdOf, modelOf, latest };
