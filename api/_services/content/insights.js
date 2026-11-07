/* ============================================================================
   Mobile Parts Finder · api/_services/content/insights.js
   ----------------------------------------------------------------------------
   How every post on an account did, and why: for the owner to grow the page.

   Read from Instagram with the publish token (the system user reaches both
   accounts): the account's last posts with their reach, views, likes,
   comments, saves and shares. A post made from the Posters page is joined to
   its record (contentPosts), so its design, colour, template and comment word
   are known too.

   WHY A POST DID OR DID NOT REACH

   Instagram does not say why. What can be said honestly is how a post did
   against the account's own usual (the median of the posts read), and what it
   had in common with the posts that did well: its kind (single, carousel,
   reel, marketing), the time and day it went out (IST), its design and
   colour, and how people acted on it (saves, shares, comments a reach). Each
   reason below is one of those comparisons, with the numbers it rests on.
   Nothing is guessed, and a post younger than two days is said to be still
   collecting reach rather than judged.

   Nothing is stored: each read is fresh from Instagram (kept ten minutes in a
   warm instance, as each read is one call a post).
   ========================================================================== */
'use strict';

const C = require('../../_schema/collections');

const HOUR_MS = 60 * 60 * 1000;
const IST_MS = 5.5 * HOUR_MS;
const YOUNG_MS = 48 * HOUR_MS;
const READ = 30;
const CACHE_MS = 10 * 60 * 1000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const KIND_NAMES = { single: 'single posters', carousel: 'carousels', promo: 'marketing posters', reel: 'reels' };
const cache = new Map();

const median = list => {
  const a = list.filter(n => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const round = (n, d) => Math.round(n * Math.pow(10, d || 0)) / Math.pow(10, d || 0);
const istHour = t => new Date(t + IST_MS).getUTCHours();
const istDay = t => new Date(t + IST_MS).getUTCDay();
const bucketOf = h => (h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening');

function kindOf(m, rec) {
  if (rec && rec.kind === 'promo') return 'promo';
  if (m.media_product_type === 'REELS' || m.media_type === 'VIDEO') return 'reel';
  return m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'single';
}

/** One post as the page shows it: its numbers, and what is known of how it was made. */
function postOf(m, rec) {
  const i = m.insights || {};
  const reach = Number(i.reach) || 0;
  return {
    id: m.id, permalink: m.permalink || null, at: Date.parse(m.timestamp) || 0,
    picture: m.media_type === 'VIDEO' ? m.thumbnail_url || null : m.media_url || m.thumbnail_url || null,
    caption: String(m.caption || '').split('\n')[0].slice(0, 120),
    kind: kindOf(m, rec),
    reach, views: Number(i.views) || 0, likes: Number(m.like_count) || 0, comments: Number(m.comments_count) || 0,
    saves: Number(i.saved) || 0, shares: Number(i.shares) || 0,
    design: (rec && rec.design) || null, palette: (rec && rec.palette) || null, template: (rec && rec.template) || null,
    keyword: (rec && rec.keyword) || null, fromHere: !!rec
  };
}

/** The median reach of each value of a field, with how many posts it rests on. */
function groupBy(posts, key) {
  const m = new Map();
  posts.forEach(p => { const k = key(p); if (k == null) return; if (!m.has(k)) m.set(k, []); m.get(k).push(p); });
  return Array.from(m.entries()).map(([k, list]) => ({
    key: k, posts: list.length, reach: round(median(list.map(p => p.reach))),
    saves: round(median(list.map(p => p.saves)), 1), comments: round(median(list.map(p => p.comments)), 1)
  })).sort((a, b) => b.reach - a.reach);
}

/**
 * Scores and explains every post against the account's own usual.
 * @param {object[]} posts  postOf() rows
 * @param {number} now
 */
function analyse(posts, now) {
  const judged = posts.filter(p => now - p.at >= YOUNG_MS);
  const base = judged.length >= 3 ? judged : posts;
  const usual = {
    reach: median(base.map(p => p.reach)),
    saveRate: median(base.filter(p => p.reach).map(p => p.saves / p.reach)),
    shareRate: median(base.filter(p => p.reach).map(p => p.shares / p.reach)),
    comments: median(base.map(p => p.comments))
  };
  const by = {
    kind: groupBy(base, p => p.kind),
    time: groupBy(base, p => bucketOf(istHour(p.at))),
    weekday: groupBy(base, p => WEEKDAYS[istDay(p.at)]),
    design: groupBy(base, p => p.design),
    palette: groupBy(base, p => p.palette),
    template: groupBy(base, p => p.template),
    keyword: groupBy(base, p => p.keyword)
  };
  const rank = (list, k) => { const row = list.find(x => x.key === k); return row ? { row, best: list[0] === row && list.length > 1, worst: list[list.length - 1] === row && list.length > 1 } : null; };

  const out = posts.map(p => {
    const reasons = [];
    const age = now - p.at;
    const score = usual.reach ? p.reach / usual.reach : 0;
    if (age < YOUNG_MS) reasons.push({ tone: 'info', text: `Posted ${Math.max(1, Math.round(age / HOUR_MS))} h ago: still collecting reach.` });
    else if (score >= 1.5) reasons.push({ tone: 'good', text: `Reached ${round(score, 1)}× the account's usual (${p.reach} vs ${round(usual.reach)}).` });
    else if (usual.reach && score <= 0.6) reasons.push({ tone: 'bad', text: `Reached only ${round(score, 1)}× the usual (${p.reach} vs ${round(usual.reach)}).` });
    else reasons.push({ tone: 'info', text: `About the usual reach (${p.reach} vs ${round(usual.reach)}).` });

    if (p.reach >= 20) {
      const sr = p.saves / p.reach;
      const shr = p.shares / p.reach;
      if (p.saves >= 3 && sr >= Math.max(0.01, usual.saveRate * 2)) reasons.push({ tone: 'good', text: `Saved by ${round(sr * 100, 1)}% of those reached: kept as a reference, which Instagram rewards.` });
      if (p.shares >= 2 && shr >= Math.max(0.005, usual.shareRate * 2)) reasons.push({ tone: 'good', text: `Shared ${p.shares}×: passed on to other shops.` });
      if (p.kind === 'carousel' && p.views > p.reach * 1.6) reasons.push({ tone: 'good', text: `People swiped through the slides (${p.views} views from ${p.reach} reached).` });
    }
    if (p.comments >= 3 && p.comments >= usual.comments * 2) {
      reasons.push({ tone: 'good', text: `${p.comments} comments${p.keyword ? `: "Comment ${p.keyword}" worked` : ''}. Comments push a post to more people.` });
    } else if (age >= YOUNG_MS && p.keyword && p.comments === 0) {
      reasons.push({ tone: 'bad', text: `Nobody commented ${p.keyword}: the call to comment did not land.` });
    }
    const k = rank(by.kind, p.kind);
    if (k && k.best && k.row.posts >= 2) reasons.push({ tone: 'good', text: `${cap(KIND_NAMES[p.kind])} do best on this account (usual reach ${k.row.reach}).` });
    if (k && k.worst && k.row.posts >= 2) reasons.push({ tone: 'bad', text: `${cap(KIND_NAMES[p.kind])} reach least here (usual ${k.row.reach}).` });
    const t = rank(by.time, bucketOf(istHour(p.at)));
    if (t && t.best && t.row.posts >= 2) reasons.push({ tone: 'good', text: `Went out in the ${t.row.key} (IST), the account's best time.` });
    if (t && t.worst && t.row.posts >= 2 && score < 1) reasons.push({ tone: 'bad', text: `Went out in the ${t.row.key} (IST), the account's weakest time.` });
    return Object.assign({}, p, { score: round(score, 2), young: age < YOUNG_MS, reasons });
  });

  const tips = [];
  const best = (list, min) => list.filter(x => x.posts >= (min || 2))[0];
  const bk = best(by.kind);
  const wk = by.kind.filter(x => x.posts >= 2).slice(-1)[0];
  if (bk && wk && bk !== wk && bk.reach > wk.reach * 1.2) tips.push(`${cap(KIND_NAMES[bk.key])} reach ${round(bk.reach / Math.max(1, wk.reach), 1)}× more than ${KIND_NAMES[wk.key]}: make more of them.`);
  const bt = best(by.time);
  if (bt && by.time.length > 1) tips.push(`Posts in the ${bt.key} (IST) reach most (usual ${bt.reach}).`);
  const bw = best(by.weekday);
  if (bw && by.weekday.length > 2) tips.push(`${bw.key} is the best day so far (usual reach ${bw.reach}).`);
  const bd = best(by.design);
  if (bd && by.design.length > 1) tips.push(`The "${bd.key}" design reaches most of the posters made here.`);
  const bp = best(by.palette);
  if (bp && by.palette.length > 1) tips.push(`The ${bp.key} colour reaches most so far.`);
  const kw = by.keyword.filter(x => x.posts >= 2).sort((a, b) => b.comments - a.comments)[0];
  if (kw && by.keyword.length > 1) tips.push(`"Comment ${kw.key}" gets the most comments (usual ${kw.comments} a post).`);
  if (usual.saveRate) tips.push(`Usually ${round(usual.saveRate * 100, 1)}% of the people reached save a post. Long model lists get saved most.`);
  if (!tips.length) tips.push('Too few posts to compare yet. The reasons fill in as the schedule posts.');

  return { usual: { reach: round(usual.reach), saveRate: round(usual.saveRate * 100, 2), comments: round(usual.comments, 1) }, by, posts: out, tips, judged: judged.length };
}

const cap = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

/**
 * Reads an account's posts and explains them.
 * @param {{graph:Function, accounts:object, db:Function}} deps  publish.js's graph() and ACCOUNTS
 */
async function read(deps, account, now, fresh) {
  const acct = deps.accounts[account];
  if (!acct) return null;
  const hit = cache.get(account);
  if (!fresh && hit && now - hit.at < CACHE_MS) return hit.value;
  const ig = acct.igUserId();
  const [profile, media, records] = await Promise.all([
    deps.graph('GET', ig, { fields: 'username,followers_count,media_count,profile_picture_url' }).catch(() => ({})),
    deps.graph('GET', `${ig}/media`, { fields: 'id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count', limit: READ }),
    deps.db().collection(C.CONTENT_POSTS).orderBy('at', 'desc').limit(80).get().then(s => s.docs.map(d => d.data())).catch(() => [])
  ]);
  const list = media.data || [];
  await Promise.all(list.map(async m => {
    const got = await deps.graph('GET', `${m.id}/insights`, { metric: 'reach,views,saved,shares,total_interactions' })
      .catch(() => deps.graph('GET', `${m.id}/insights`, { metric: 'reach,saved,total_interactions' }).catch(() => null));
    m.insights = {};
    ((got && got.data) || []).forEach(x => { m.insights[x.name] = (x.values && x.values[0] && x.values[0].value) || (x.total_value && x.total_value.value) || 0; });
  }));
  const byMedia = new Map(records.filter(r => r.account === account).map(r => [String(r.mediaId), r]));
  const value = Object.assign({
    account,
    profile: { username: profile.username || null, followers: profile.followers_count == null ? null : profile.followers_count, posts: profile.media_count == null ? null : profile.media_count, picture: profile.profile_picture_url || null },
    readAt: now
  }, analyse(list.map(m => postOf(m, byMedia.get(String(m.id)))), now));
  cache.set(account, { at: now, value });
  return value;
}

module.exports = { analyse, postOf, median, read, bucketOf };
