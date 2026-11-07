/* ============================================================================
   Mobile Parts Finder · api/_services/content/schedule.js
   ----------------------------------------------------------------------------
   Three posts a day on each Instagram account, planned three days ahead and
   posted on time.

   A DAY IS ONE ROW OF THE GRID

   Instagram's profile grid is three wide, newest first, so a day's three posts
   make one row. Each day takes one colour (designs.js PALETTES, in order, cool
   and warm in turn), so every row is one colour and the row under it another.
   The day's first post lands on the right of its row, the last on the left:

       slot 0  09:30 IST  single poster      right
       slot 1  14:00 IST  marketing poster   middle: the app / the website
       slot 2  19:30 IST  carousel           left

   so the middle column of the grid is always the brand's own message. The two
   accounts start the colours at different places, so they never look alike.

   WHAT GOES ON A POSTER

   Single and carousel posters are compatibility groups people want: phones
   asked about on Instagram, searched on the site, new models, then the
   biggest groups. A group already posted on that account (or planned) is not
   planned again. The marketing poster is one of promos.js's templates, drawn
   with the biggest tempered-glass group, so its numbers are real. On ProGlide
   every poster asks for one comment word (LINK, PROGLIDE or TOOL, in turn),
   and the reply bot answers each with the app's link.

   WHAT IS STORED

     contentSchedule/{account}_{date}_{slot}   one planned post; the id makes
                                               planning idempotent
     contentSettings/schedule                  auto on/off per account, and
                                               the groups each account used

   Posting happens only for an account whose auto posting is on, only within
   LATE_MS of the slot's time (a slot missed by hours is marked missed, never
   posted late out of order), one post a run, and a slot is taken for posting
   in a transaction so two runs cannot post it twice.
   ========================================================================== */
'use strict';

const C = require('../../_schema/collections');
const designs = require('./designs');
const promos = require('./promos');

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_MS = 5.5 * 60 * 60 * 1000;
const AHEAD_DAYS = 3;
/* the days after the planned ones, shown as they will be planned */
const PROJECT_DAYS = 3;
const LATE_MS = 3 * 60 * 60 * 1000;
const STUCK_MS = 15 * 60 * 1000;
const USED_KEEP_MS = 60 * DAY_MS;
const CANDIDATES_MS = 30 * 60 * 1000;
const PLAN_RETRY_MS = 6 * 60 * 60 * 1000;

const ACCOUNTS = ['proglide', 'mpf'];
const OFFSET = { proglide: 0, mpf: 3 };
const SLOTS = [
  { slot: 0, minutes: 9 * 60 + 30, kind: 'single', column: 'right' },
  { slot: 1, minutes: 14 * 60, kind: 'promo', column: 'middle' },
  { slot: 2, minutes: 19 * 60 + 30, kind: 'carousel', column: 'left' }
];
const STATUSES = ['planned', 'posting', 'posted', 'failed', 'missed', 'skipped'];

const dayNumber = now => Math.floor((now + IST_MS) / DAY_MS);
const dateOf = day => new Date(day * DAY_MS).toISOString().slice(0, 10);
const slotAt = (day, minutes) => day * DAY_MS - IST_MS + minutes * 60 * 1000;
const idOf = (account, day, slot) => `${account}_${dateOf(day)}_${slot}`;
const validAccount = a => (ACCOUNTS.indexOf(a) > -1 ? a : null);

/** The colour of a day's row on an account's grid. */
function rowPalette(account, day) {
  const list = designs.PALETTES;
  return list[(day + (OFFSET[account] || 0)) % list.length].id;
}

/** A day's three posts, without their groups: kind, time, design, colour, word. */
function dayPlan(account, day) {
  const D = designs.DESIGNS;
  const T = promos.TEMPLATES;
  const K = designs.KEYWORDS;
  return SLOTS.map(s => ({
    id: idOf(account, day, s.slot), account, date: dateOf(day), day, slot: s.slot, column: s.column,
    at: slotAt(day, s.minutes), kind: s.kind, palette: rowPalette(account, day),
    design: s.kind === 'single' ? D[day % D.length].id : s.kind === 'carousel' ? D[(day + 3) % D.length].id : null,
    template: s.kind === 'promo' ? T[day % T.length].id : null,
    keyword: account === 'proglide' ? K[(day + s.slot) % K.length] : null
  }));
}

/* ----------------------------------------------------------------- store */
const col = db => db().collection(C.CONTENT_SCHEDULE);
const settingsRef = db => db().collection(C.CONTENT_SETTINGS).doc('schedule');

async function loadSettings(db) {
  const snap = await settingsRef(db).get();
  const v = snap.exists ? snap.data() : {};
  return { auto: Object.assign({ proglide: false, mpf: false }, v.auto), used: v.used || {}, planTry: v.planTry || {}, by: v.by || null };
}

async function setAuto(db, account, on, uid, now) {
  if (!validAccount(account)) return null;
  await settingsRef(db).set({ auto: { [account]: !!on }, by: uid || null, updatedAt: now }, { merge: true });
  return loadSettings(db);
}

/** The groups an account has used lately: planned here, or posted from the Posters page. */
async function usedGroups(db, account, settings, now) {
  const used = new Set();
  const mine = settings.used[account] || {};
  Object.keys(mine).forEach(g => { if (now - mine[g] < USED_KEEP_MS) used.add(g); });
  const snap = await db().collection(C.CONTENT_POSTS).orderBy('at', 'desc').limit(60).get().catch(() => ({ docs: [] }));
  snap.docs.forEach(d => { const v = d.data(); if (v.account === account && v.groupId && now - v.at < USED_KEEP_MS) used.add(v.groupId); });
  return used;
}

/* ------------------------------------------------------------ candidates */
let candidateCache = null;

/**
 * Groups worth a post, best first, each with why. Asked on Instagram, searched
 * on the site, new models, then the biggest groups.
 * @param {object} content  service.js: ideas(now), groupsOf(modelId)
 */
async function candidates(content, now) {
  if (candidateCache && now - candidateCache.at < CANDIDATES_MS) return candidateCache.list;
  const ideas = await content.ideas(now);
  const out = [];
  const seen = new Set();
  const add = (g, source, why) => {
    if (!g || !g.groupId || seen.has(g.groupId)) return;
    seen.add(g.groupId);
    out.push({ groupId: g.groupId, categoryId: g.categoryId, master: g.master, count: g.count, source, why });
  };
  const models = [].concat(
    (ideas.asked || []).slice(0, 3).map(m => [m, 'asked', `${m.name}: asked ${m.count}× on Instagram`]),
    (ideas.searched || []).slice(0, 3).map(m => [m, 'searched', `${m.name}: opened ${m.count}× on the site`]),
    (ideas.newest || []).slice(0, 2).map(m => [m, 'newest', `${m.name}: a new model${m.year ? ' of ' + m.year : ''}`])
  );
  for (const [m, source, why] of models) {
    const r = await content.groupsOf(m.id).catch(() => null);
    ((r && r.groups) || []).filter(g => g.count >= 3).slice(0, 2).forEach(g => add(g, source, why));
  }
  (ideas.biggest || []).forEach(g => add(g, 'biggest', `One part fits ${g.count} phones`));
  const stat = (ideas.biggest || []).filter(g => g.categoryId === 'screen-guards').sort((a, b) => b.count - a.count)[0] || (ideas.biggest || [])[0] || null;
  const list = { groups: out, stat: stat ? { groupId: stat.groupId, master: stat.master, count: stat.count, categoryId: stat.categoryId } : null };
  if (out.length) candidateCache = { at: now, list };
  return list;
}

/** The next group for a slot: not used, not already in the day, a carousel wants a long list. */
function pick(groups, taken, kind, dayCats) {
  const free = groups.filter(g => !taken.has(g.groupId));
  const fits = g => (kind === 'carousel' ? g.count >= 12 : true);
  return free.find(g => fits(g) && dayCats.indexOf(g.categoryId) < 0) || free.find(fits) || free[0] || null;
}

/* ------------------------------------------------------------------ plan */

/**
 * Fills the next AHEAD_DAYS days of an account with what is missing. Slots
 * already planned (or posted, or skipped) are left as they are.
 * @returns {Promise<{planned:number, missing:number}>}
 */
async function plan(deps, account, now) {
  if (!validAccount(account)) return { planned: 0, missing: 0 };
  const { db, content } = deps;
  const today = dayNumber(now);
  const want = [];
  for (let d = today; d < today + AHEAD_DAYS; d++) dayPlan(account, d).forEach(s => { if (s.at > now + 10 * 60 * 1000) want.push(s); });
  if (!want.length) return { planned: 0, missing: 0 };
  const snaps = await db().getAll(...want.map(s => col(db).doc(s.id)));
  const have = new Map(snaps.filter(s => s.exists).map(s => [s.id, s.data()]));
  const missing = want.filter(s => !have.has(s.id));
  if (!missing.length) return { planned: 0, missing: 0 };

  const settings = await loadSettings(db);
  const [cands, used] = await Promise.all([candidates(content, now), usedGroups(db, account, settings, now)]);
  have.forEach(v => { if (v.groupId && v.kind !== 'promo') used.add(v.groupId); });
  /* the marketing poster's group stays the marketing poster's, so no day shows it twice */
  if (cands.stat) used.add(cands.stat.groupId);
  const usedNow = {};
  let planned = 0;
  for (const s of missing) {
    const dayCats = Array.from(have.values()).concat(missing).filter(x => x.day === s.day && x.categoryId).map(x => x.categoryId);
    let g = null;
    if (s.kind === 'promo') g = cands.stat;
    else {
      g = pick(cands.groups, used, s.kind, dayCats);
      if (g) { used.add(g.groupId); usedNow[g.groupId] = now; }
    }
    if (!g) continue;
    Object.assign(s, { groupId: g.groupId, categoryId: g.categoryId || null, master: g.master || '', count: g.count || 0,
      why: s.kind === 'promo' ? 'Sells the ' + (account === 'proglide' ? 'app' : 'website') : g.why || '', source: s.kind === 'promo' ? 'promo' : g.source || '',
      status: 'planned', createdAt: now });
    const ok = await col(db).doc(s.id).create(s).then(() => true, () => false);
    if (ok) planned++;
  }
  const patch = { planTry: { [account]: now } };
  if (Object.keys(usedNow).length) patch.used = { [account]: usedNow };
  await settingsRef(db).set(patch, { merge: true });
  return { planned, missing: missing.length };
}

/* ----------------------------------------------------------------- board */

/** What an account has planned from today on, each slot with its state, and the groups ready to go. */
async function board(deps, account, now) {
  if (!validAccount(account)) return null;
  const { db, content } = deps;
  const today = dayNumber(now);
  const ids = [];
  for (let d = today; d < today + AHEAD_DAYS; d++) dayPlan(account, d).forEach(s => ids.push(s));
  const [snaps, settings] = await Promise.all([db().getAll(...ids.map(s => col(db).doc(s.id))), loadSettings(db)]);
  const got = new Map(snaps.filter(s => s.exists).map(s => [s.id, s.data()]));
  const slots = ids.map(s => Object.assign({}, s, got.get(s.id) || { status: 'open' }));

  let ready = [];
  let stat = null;
  let upcoming = [];
  try {
    const [cands, used] = await Promise.all([candidates(content, now), usedGroups(db, account, settings, now)]);
    slots.forEach(s => { if (s.groupId && s.kind !== 'promo') used.add(s.groupId); });
    ready = cands.groups.filter(g => !used.has(g.groupId) && !(cands.stat && g.groupId === cands.stat.groupId)).slice(0, 18);
    stat = cands.stat;
    upcoming = project(account, today + AHEAD_DAYS, ready, stat);
  } catch (err) {
    console.warn('[schedule] ready list', err && err.message);
  }
  const inUpcoming = new Set(upcoming.map(s => s.groupId));
  return {
    account, auto: !!settings.auto[account], slots, ready, stat, upcoming,
    suggest: ready.filter(g => !inUpcoming.has(g.groupId)),
    rows: designs.PALETTES.map(p => p.id), times: SLOTS.map(s => ({ slot: s.slot, minutes: s.minutes, kind: s.kind, column: s.column }))
  };
}

/**
 * The days after the planned ones, as they will be planned: the ready groups
 * put in the same order plan() takes them, each in its own day's colour, so
 * the owner sees the grid that is coming, not a list. Nothing is stored; when
 * a day comes into the planned window, plan() makes it for real.
 */
function project(account, firstDay, ready, stat) {
  const taken = new Set();
  const out = [];
  for (let d = firstDay; d < firstDay + PROJECT_DAYS; d++) {
    const cats = [];
    dayPlan(account, d).forEach(s => {
      const g = s.kind === 'promo' ? stat : pick(ready, taken, s.kind, cats);
      if (!g) return;
      if (s.kind !== 'promo') { taken.add(g.groupId); cats.push(g.categoryId); }
      out.push(Object.assign(s, { groupId: g.groupId, categoryId: g.categoryId || null, master: g.master || '', count: g.count || 0,
        why: s.kind === 'promo' ? 'Sells the ' + (account === 'proglide' ? 'app' : 'website') : g.why || '', source: s.kind === 'promo' ? 'promo' : g.source || '', status: 'next' }));
    });
  }
  return out;
}

/** The owner's changes to one planned slot: skip it, or plan another group in it. */
async function change(deps, id, op, groupId) {
  const { db } = deps;
  if (typeof id !== 'string' || !/^(proglide|mpf)_\d{4}-\d{2}-\d{2}_[0-2]$/.test(id)) return { ok: false, error: 'No such slot.' };
  const ref = col(db).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, error: 'That slot is not planned yet.' };
  const v = snap.data();
  if (v.status === 'posted' || v.status === 'posting') return { ok: false, error: 'That post is already on Instagram.' };
  if (op === 'skip') { await ref.update({ status: 'skipped' }); return { ok: true }; }
  if (op === 'restore') { await ref.update({ status: 'planned' }); return { ok: true }; }
  if (op === 'group' && v.kind !== 'promo' && typeof groupId === 'string' && /^[a-z]{2}-\d{1,6}$/.test(groupId)) {
    const g = await deps.content.groupOf(groupId);
    if (!g) return { ok: false, error: 'No such group.' };
    const cat = require('./poster').categoryOf(groupId);
    await ref.update({ groupId, categoryId: cat, master: g.masterModelName || '', count: g.members.length, why: 'Chosen by the owner', source: 'owner', status: 'planned' });
    await settingsRef(db).set({ used: { [v.account]: { [groupId]: Date.now() } } }, { merge: true });
    return { ok: true };
  }
  return { ok: false, error: 'Unknown change.' };
}

/* ------------------------------------------------------------------- run */

/**
 * Posts what is due, at most one post a run, on accounts whose auto posting is
 * on; plans ahead when the plan runs short.
 * @param {{db:Function, content:object, publish:Function}} deps
 */
async function runDue(deps, now) {
  const { db } = deps;
  const settings = await loadSettings(db);
  const on = ACCOUNTS.filter(a => settings.auto[a]);
  if (!on.length) return { ran: false, reason: 'auto posting is off' };
  const today = dayNumber(now);
  const slots = [];
  on.forEach(a => [today - 1, today].forEach(d => dayPlan(a, d).forEach(s => slots.push(s))));
  const snaps = await db().getAll(...slots.map(s => col(db).doc(s.id)));
  const docs = snaps.filter(s => s.exists).map(s => Object.assign({ id: s.id }, s.data()));

  for (const v of docs) {
    if (v.status === 'planned' && now - v.at > LATE_MS) await col(db).doc(v.id).update({ status: 'missed' });
    if (v.status === 'posting' && now - (v.startedAt || 0) > STUCK_MS) {
      await col(db).doc(v.id).update({ status: 'failed', error: 'Posting did not finish. Check Instagram before posting it again.' });
    }
  }
  const due = docs.filter(v => v.status === 'planned' && v.at <= now && now - v.at <= LATE_MS).sort((a, b) => a.at - b.at)[0];
  let posted = null;
  if (due) posted = await postSlot(deps, due.id, now);

  /* keep three days planned; tried at most every few hours, as it reads the idea lists */
  const planned = {};
  for (const a of on) {
    if (now - (settings.planTry[a] || 0) < PLAN_RETRY_MS) continue;
    planned[a] = await plan(deps, a, now).catch(err => ({ error: err.message }));
  }
  return { ran: true, posted, planned };
}

/** Takes one slot for posting (once), posts it, and records how it went. */
async function postSlot(deps, id, now) {
  const { db } = deps;
  const ref = col(db).doc(id);
  const took = await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().status !== 'planned') return null;
    tx.update(ref, { status: 'posting', startedAt: now });
    return snap.data();
  });
  if (!took) return null;
  try {
    const r = await deps.publish({
      account: took.account, group: took.groupId, kind: took.kind, design: took.design || undefined, palette: took.palette,
      template: took.template || undefined, keyword: took.keyword || undefined, uid: 'scheduler', scheduleId: id
    });
    if (!r.ok) {
      await ref.update({ status: 'failed', error: String(r.message || 'not posted').slice(0, 300), endedAt: Date.now() });
      return { id, ok: false, error: r.message };
    }
    await ref.update({ status: 'posted', mediaId: r.mediaId, permalink: r.permalink || null, postedAt: Date.now() });
    return { id, ok: true, mediaId: r.mediaId };
  } catch (err) {
    await ref.update({ status: 'failed', error: String(err.message || err).slice(0, 300), endedAt: Date.now() });
    return { id, ok: false, error: err.message };
  }
}

/** The live services, for the runner on the reply bot's poll and for the admin page. */
function liveDeps() {
  const { db } = require('../../_lib/firebase');
  const content = require('./service');
  const publisher = require('./publish');
  return { db, content, publish: o => publisher.publish(o) };
}

module.exports = {
  liveDeps, ACCOUNTS, SLOTS, STATUSES, AHEAD_DAYS, LATE_MS,
  dayNumber, dateOf, slotAt, idOf, rowPalette, dayPlan, pick,
  loadSettings, setAuto, candidates, plan, board, change, runDue, postSlot,
  _reset: () => { candidateCache = null; }
};
