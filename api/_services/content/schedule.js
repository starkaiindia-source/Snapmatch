/* ============================================================================
   Mobile Parts Finder · api/_services/content/schedule.js
   ----------------------------------------------------------------------------
   Nine posts a day on each Instagram account, a week planned at once, each
   post at an hour its followers are online.

   A ROW OF THE GRID IS ONE PHONE

   Instagram's profile grid is three wide, newest first, so three posts in a
   row make one row of the grid. A day is three rows. Every row is about one
   master phone, in one colour (designs.js PALETTES, cool and warm in turn), and
   is posted right first, then middle, then left:

       right    the master's small parts on one poster ("combo"), or the
                marketing poster when the master has only one other part
       middle   the master's biggest other part, a single poster
       left     a carousel: the tempered glass (else the biggest part), its
                models a page at a time, and one slide for each other part
                when the master has many

   A master with no other part gets marketing in its free places. The two
   accounts use the same groups and the same data but never the same phone in
   a week, start their colours, designs and call-to-action styles at
   different places, and never post marketing within an hour of each other.

   WHEN

   The times come from the account's followers: Instagram's online_followers
   (the followers online in each hour), turned to India time and blended with
   a usual Indian day; with no data, the usual day alone. Nine posts go in
   the best hours, two or three in the busiest ones. They are worked out
   again with each new week.

   KEEPING THE ROWS IN THREES

   A row stays a row only if exactly three posts go up for it. When a post is
   missed, fails, or one is posted by hand, every row below shifts. So before
   a row's first post the account's media count is compared with the count at
   the start of the last row, and one or two marketing posters go first when
   the count is off, which brings the rows back into line.

   WHAT IS STORED, AND WHAT IT COSTS

     contentSettings/plan_{account}   the week: times, peak hours, every slot
                                      (one document, written at once)
     contentSettings/schedule         auto on/off per account, the groups each
                                      account used, and when its next post is
                                      due (`next`), and its last planned day

   The runner looks every few minutes and reads only the settings document; it
   opens a plan only when that account's `next` time has come. A slot is taken
   in a transaction, so two runs never post it twice. A slot missed by hours is
   marked missed, never posted late out of order.
   ========================================================================== */
'use strict';

const C = require('../../_schema/collections');
const designs = require('./designs');
const promos = require('./promos');

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
const IST_MS = 5.5 * 60 * 60 * 1000;
const WEEK_DAYS = 7;
/* a new week is planned when fewer than this many days are left */
const RENEW_DAYS = 2;
const LATE_MS = 3 * 60 * 60 * 1000;
const STUCK_MS = 15 * 60 * 1000;
const USED_KEEP_MS = 60 * DAY_MS;
const CANDIDATES_MS = 30 * 60 * 1000;
const PLAN_RETRY_MS = 3 * 60 * 60 * 1000;
const PEAK_KEEP_MS = 7 * DAY_MS;
/* the first post of today's plan: at least this far ahead */
const LEAD_MS = 15 * MIN_MS;
/* two accounts' marketing posters: at least this far apart */
const PROMO_APART_MS = 60 * MIN_MS;
const MAX_FILLERS = 2;
const PER_DAY = 9;

const ACCOUNTS = ['proglide', 'mpf'];
/* where each account starts its colours, designs and call-to-action styles */
const OFFSET = { proglide: 0, mpf: 3 };
/* the second account posts a little after the first, never at the same minute */
const MINUTE_SHIFT = { proglide: 0, mpf: 8 };
/* posting order inside a row: right first, left last */
const POSITIONS = [
  { pos: 0, column: 'right' },
  { pos: 1, column: 'middle' },
  { pos: 2, column: 'left' }
];
const STATUSES = ['planned', 'posting', 'posted', 'failed', 'missed', 'skipped'];

/* A usual Indian day on Instagram, by hour in India time: morning, a lunch
   bump, and the evening peak. Used alone with no data, and blended with it. */
const INDIA_DAY = [0, 0, 0, 0, 0, 0, 1, 3, 4, 5, 5, 5, 6, 7, 6, 5, 5, 6, 7, 9, 10, 10, 8, 4];
const FIRST_HOUR = 7;
const LAST_HOUR = 23;

const dayNumber = now => Math.floor((now + IST_MS) / DAY_MS);
const dateOf = day => new Date(day * DAY_MS).toISOString().slice(0, 10);
const slotAt = (day, minutes) => day * DAY_MS - IST_MS + minutes * MIN_MS;
const minutesOf = at => Math.floor(((at + IST_MS) % DAY_MS) / MIN_MS);
/* p for a place in the day: the old three-a-day ids ended _0.._2 */
const idOf = (account, day, i) => `${account}_${dateOf(day)}_p${i}`;
const validAccount = a => (ACCOUNTS.indexOf(a) > -1 ? a : null);
const SLOT_ID = /^(proglide|mpf)_\d{4}-\d{2}-\d{2}_p[0-8]$/;

/* ------------------------------------------------------------ peak hours */

/**
 * Instagram's followers-online hours, turned to India time. Its hour keys are
 * not in India time, and which zone they are in is not stated reliably, so the
 * zone is the one that puts the quiet hours in India's night.
 * @param {number[]} raw  24 counts, Instagram's hour 0..23
 * @returns {number[]|null}  24 counts by India hour, or null when too thin
 */
function toIndiaHours(raw) {
  if (!Array.isArray(raw) || raw.length !== 24) return null;
  const total = raw.reduce((a, b) => a + (Number(b) || 0), 0);
  if (total < 30) return null;
  /* UTC, Pacific daylight, Pacific standard: India is 5.5, 12.5 or 13.5 hours on */
  const shifts = [13, 12, 5];
  const quiet = curve => {
    let best = Infinity;
    let at = 0;
    for (let h = 0; h < 24; h++) {
      let s = 0;
      for (let k = 0; k < 5; k++) s += curve[(h + k) % 24];
      if (s < best) { best = s; at = (h + 2) % 24; }
    }
    return at;
  };
  for (const shift of shifts) {
    const ist = new Array(24).fill(0);
    raw.forEach((v, h) => {
      const n = Number(v) || 0;
      ist[(h + shift) % 24] += n / 2;
      ist[(h + shift + 1) % 24] += n / 2;
    });
    const q = quiet(ist);
    if (q >= 1 && q <= 6) return ist;
  }
  return null;
}

/** The hours to post in: followers' hours blended with a usual Indian day. */
function blend(ist) {
  const norm = c => { const m = Math.max(...c) || 1; return c.map(v => v / m); };
  const base = norm(INDIA_DAY);
  if (!ist) return base;
  const data = norm(ist);
  return base.map((v, h) => Math.round((0.7 * data[h] + 0.3 * v) * 1000) / 1000);
}

/**
 * Nine posting times, in minutes after midnight India time: the best hours
 * first, two posts in a busy hour, three in the two busiest, spread inside it.
 */
function chooseTimes(curve, account) {
  const hours = [];
  for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) if (curve[h] > 0) hours.push(h);
  const top = hours.slice().sort((a, b) => curve[b] - curve[a]).slice(0, 2);
  const count = {};
  for (let n = 0; n < PER_DAY; n++) {
    let best = null;
    let score = -1;
    hours.forEach(h => {
      const c = count[h] || 0;
      if (c >= (top.indexOf(h) > -1 ? 3 : 2)) return;
      const s = curve[h] / (c + 1);
      if (s > score) { score = s; best = h; }
    });
    if (best == null) break;
    count[best] = (count[best] || 0) + 1;
  }
  const SPREAD = { 1: [15], 2: [10, 40], 3: [5, 25, 45] };
  const out = [];
  Object.keys(count).forEach(h => SPREAD[count[h]].forEach(m => out.push(Number(h) * 60 + m + (MINUTE_SHIFT[account] || 0))));
  return out.sort((a, b) => a - b);
}

/**
 * Today's times: those still ahead, in whole rows (the last ones, so the day
 * ends on a full row). Late in the day with no row left, one row starts soon.
 */
function todayTimes(times, day, now) {
  let ahead = times.filter(t => slotAt(day, t) > now + LEAD_MS);
  if (ahead.length < 3) {
    const start = Math.ceil((minutesOf(now + LEAD_MS)) / 5) * 5;
    if (start + 40 < 24 * 60) ahead = [start, start + 20, start + 40];
  }
  /* a whole number of rows: one more late post when there is room, else fewer */
  while (ahead.length % 3 && ahead[ahead.length - 1] + 30 <= 23 * 60 + 45) ahead.push(ahead[ahead.length - 1] + 30);
  return ahead.slice(ahead.length % 3);
}

/* ----------------------------------------------------------------- store */
const settingsRef = db => db().collection(C.CONTENT_SETTINGS).doc('schedule');
const planRef = (db, account) => db().collection(C.CONTENT_SETTINGS).doc('plan_' + account);

async function loadSettings(db) {
  const snap = await settingsRef(db).get();
  const v = snap.exists ? snap.data() : {};
  return {
    auto: Object.assign({ proglide: false, mpf: false }, v.auto), used: v.used || {}, planTry: v.planTry || {},
    next: v.next || {}, until: v.until || {}, by: v.by || null
  };
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

/** When the account's next post is due: the earliest slot still planned. */
function nextDue(slots) {
  const t = slots.filter(s => s.status === 'planned').map(s => s.at).sort((a, b) => a - b)[0];
  return t == null ? null : t;
}

/* ------------------------------------------------------------ candidates */
let candidateCache = null;

/**
 * Phones worth a row, best first, each with why: asked on Instagram, searched
 * on the site, new models, the masters of the biggest groups, then more of
 * the newest phones. Also the biggest tempered-glass group, for the
 * marketing posters' numbers.
 * @param {object} content  service.js
 */
async function candidates(content, now) {
  if (candidateCache && now - candidateCache.at < CANDIDATES_MS) return candidateCache.list;
  const ideas = await content.ideas(now);
  const masters = [];
  const seen = new Set();
  const add = (id, name, source, why) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    masters.push({ id, name, source, why });
  };
  (ideas.asked || []).forEach(m => add(m.id, m.name, 'asked', `${m.name}: asked ${m.count}× on Instagram`));
  (ideas.searched || []).forEach(m => add(m.id, m.name, 'searched', `${m.name}: opened ${m.count}× on the site`));
  (ideas.newest || []).forEach(m => add(m.id, m.name, 'newest', `${m.name}: a new model${m.year ? ' of ' + m.year : ''}`));
  const big = (ideas.biggest || []).slice(0, 16);
  const bigGroups = await Promise.all(big.map(g => content.groupOf(g.groupId).catch(() => null)));
  big.forEach((g, i) => {
    const group = bigGroups[i];
    const id = group && content.masterIdOf ? content.masterIdOf(group) : null;
    if (id) add(id, group.masterModelName || g.master, 'biggest', `One part of it fits ${g.count} phones`);
  });
  ((content.latest && content.latest(150)) || []).forEach(m => add(m.id, m.name, 'newest', `${m.name}: a new model${m.year ? ' of ' + m.year : ''}`));
  const groups = (ideas.biggest || []).map(g => ({ groupId: g.groupId, categoryId: g.categoryId, master: g.master, count: g.count, source: 'biggest', why: `One part fits ${g.count} phones` }));
  const stat = (ideas.biggest || []).filter(g => g.categoryId === 'screen-guards').sort((a, b) => b.count - a.count)[0] || (ideas.biggest || [])[0] || null;
  const list = { masters, groups, stat: stat ? { groupId: stat.groupId, master: stat.master, count: stat.count, categoryId: stat.categoryId } : null };
  if (masters.length) candidateCache = { at: now, list };
  return list;
}

/**
 * One master's row, or null when it has too little: the carousel's part
 * (tempered glass first), the middle single, and the right-hand poster.
 * @param {object[]} groups  the master's groups, biggest first
 * @param {Set} used         groups already posted or planned
 */
function rowOf(groups, used) {
  const free = groups.filter(g => g.count >= 2 && !used.has(g.groupId));
  const glass = free.find(g => g.categoryId === 'screen-guards' && g.count >= 4);
  const lead = glass || free.find(g => g.count >= 4);
  if (!lead) return null;
  const others = free.filter(g => g !== lead && g.categoryId !== lead.categoryId)
    .filter((g, i, a) => a.findIndex(x => x.categoryId === g.categoryId) === i);
  const left = { kind: 'carousel', group: lead, also: others.length >= 3 ? others.slice(0, 5) : [] };
  const middle = others[0] ? { kind: 'single', group: others[0] } : { kind: 'promo' };
  const right = others.length >= 3 ? { kind: 'combo', group: others[1], also: others.slice(2, 5) }
    : others.length === 2 ? { kind: 'single', group: others[1] } : { kind: 'promo' };
  return { lead, others, cells: [right, middle, left] };
}

/* ------------------------------------------------------------------ plan */

/** A slot's look: its row's colour, and designs, words and styles that turn. */
function looks(account, rowNo, pos, kind) {
  const off = OFFSET[account] || 0;
  const P = designs.PALETTES;
  const D = designs.DESIGNS;
  const T = promos.TEMPLATES;
  const K = designs.KEYWORDS;
  const CT = designs.CTAS;
  return {
    palette: P[(rowNo + off) % P.length].id,
    design: kind === 'single' ? D[(rowNo * 2 + off) % D.length].id : kind === 'carousel' ? D[(rowNo * 2 + off + 3) % D.length].id : null,
    template: null,
    keyword: account === 'proglide' ? K[(rowNo + pos) % K.length] : null,
    cta: CT[(rowNo + pos + off) % CT.length]
  };
}

/**
 * Plans the account's week: every day from today to the seventh that has no
 * slots yet gets its rows. Slots already planned are kept, unless `fresh`,
 * when every slot still waiting is planned again (and the hours read again).
 * The whole week is written as one document.
 * @param {{db:Function, content:object, peak?:Function}} deps
 * @returns {Promise<{planned:number, days:number, times:number[], source:string}>}
 */
async function plan(deps, account, now, opts = {}) {
  if (!validAccount(account)) return { planned: 0, days: 0 };
  const { db, content } = deps;
  const today = dayNumber(now);
  const other = ACCOUNTS.find(a => a !== account);
  const [mineSnap, otherSnap, settings] = await Promise.all([planRef(db, account).get(), planRef(db, other).get(), loadSettings(db)]);
  const old = mineSnap.exists ? mineSnap.data() : {};
  const theirs = otherSnap.exists ? otherSnap.data() : {};

  /* the hours: read again with a new week, or when asked */
  let peak = old.peak && now - (old.peak.at || 0) < PEAK_KEEP_MS && !opts.fresh ? old.peak : null;
  if (!peak) {
    const raw = deps.peak ? await deps.peak(account).catch(() => null) : null;
    const ist = toIndiaHours(raw);
    peak = { source: ist ? 'followers' : 'usual', hours: blend(ist).map(v => Math.round(v * 100) / 100), at: now };
  }
  const times = chooseTimes(peak.hours, account);

  /* keep what has gone out, is going out, or (unless fresh) is still planned */
  const keep = (old.slots || []).filter(s => s.day >= today - 1 &&
    (s.status !== 'planned' || !opts.fresh || s.at <= now + LEAD_MS));
  const daysHave = new Set(keep.filter(s => s.day >= today).map(s => s.day));

  const [cands, used] = await Promise.all([candidates(content, now), usedGroups(db, account, settings, now)]);
  keep.forEach(s => { if (s.groupId && s.kind !== 'promo') used.add(s.groupId); (s.also || []).forEach(g => used.add(g)); });
  /* the other account's week: its phones and groups are not this one's */
  const theirMasters = new Set();
  (theirs.slots || []).forEach(s => {
    if (s.masterId) theirMasters.add(s.masterId);
    if (s.groupId && s.kind !== 'promo') used.add(s.groupId);
    (s.also || []).forEach(g => used.add(g));
  });
  const mineMasters = new Set(keep.map(s => s.masterId).filter(Boolean));
  if (cands.stat) used.add(cands.stat.groupId);
  const theirPromos = (theirs.slots || []).filter(s => s.kind === 'promo' && s.status !== 'skipped').map(s => s.at);

  /* the days to plan, and their times */
  const days = [];
  for (let d = today; d < today + WEEK_DAYS; d++) {
    if (daysHave.has(d)) continue;
    const t = d === today ? todayTimes(times, d, now) : times;
    if (t.length) days.push({ day: d, times: t });
  }
  const rowsWanted = days.reduce((a, d) => a + d.times.length / 3, 0);

  /* the rows: one master each, taken in order of the candidates */
  /* read a few phones at a time, in candidate order, until the week is full */
  const rows = [];
  /* groups read but not in a row: a single in place of marketing that would clash */
  const spares = cands.groups.slice();
  const pool = cands.masters.filter(m => !theirMasters.has(m.id) && !mineMasters.has(m.id)).slice(0, rowsWanted * 3 + 20);
  for (let i = 0; i < pool.length && rows.length < rowsWanted; i += 6) {
    const batch = pool.slice(i, i + 6);
    const got = await Promise.all(batch.map(m => content.groupsOf(m.id).catch(() => null)));
    batch.forEach((m, j) => {
      ((got[j] && got[j].groups) || []).forEach(g => { if (g.count >= 4) spares.push(Object.assign({ why: m.why, source: m.source }, g)); });
      if (rows.length >= rowsWanted) return;
      const row = got[j] && rowOf(got[j].groups || [], used);
      if (!row) return;
      [row.lead].concat(row.others).forEach(g => used.add(g.groupId));
      mineMasters.add(m.id);
      rows.push(Object.assign(row, { master: m }));
    });
  }

  /* the slots */
  const usedNow = {};
  const made = [];
  let rowAt = 0;
  let promoTurn = (OFFSET[account] || 0) + today;
  const T = promos.TEMPLATES;
  days.forEach(({ day, times: t }) => {
    const rowsToday = t.length / 3;
    for (let k = 0; k < rowsToday; k++) {
      const r = 3 - rowsToday + k;
      const rowNo = day * 3 + r;
      const row = rows[rowAt++];
      if (!row) return;
      POSITIONS.forEach(({ pos, column }) => {
        const cell = row.cells[pos];
        const at = slotAt(day, t[k * 3 + pos]);
        let kind = cell.kind;
        let group = cell.group;
        /* marketing never within the hour of the other account's */
        if (kind === 'promo' && theirPromos.some(x => Math.abs(x - at) < PROMO_APART_MS)) {
          const spare = spares.find(g => !used.has(g.groupId));
          if (spare) { kind = 'single'; group = spare; used.add(spare.groupId); }
        }
        if (kind === 'promo' && !cands.stat) return;
        const look = looks(account, rowNo, pos, kind);
        if (kind === 'promo') look.template = T[promoTurn++ % T.length].id;
        const g = kind === 'promo' ? cands.stat : group;
        const slot = Object.assign({
          id: idOf(account, day, r * 3 + pos), account, date: dateOf(day), day, i: r * 3 + pos, row: r, rowNo, pos, column, at, kind,
          groupId: g.groupId, also: (cell.also || []).map(x => x.groupId), categoryId: g.categoryId || null,
          master: kind === 'promo' ? row.master.name : g.master || row.master.name, masterId: row.master.id, count: g.count || 0,
          why: kind === 'promo' ? 'Sells the ' + (account === 'proglide' ? 'app' : 'website') : row.master.why || '',
          source: kind === 'promo' ? 'promo' : row.master.source || '', status: 'planned', createdAt: now
        }, look);
        if (kind !== 'promo') usedNow[g.groupId] = now;
        made.push(slot);
      });
    }
  });

  const slots = keep.concat(made).sort((a, b) => a.at - b.at);
  const until = slots.reduce((a, s) => Math.max(a, s.day), today - 1);
  await planRef(db, account).set({
    account, times, peak, slots, stat: cands.stat || null, align: old.align || {}, builtAt: now, from: today, until
  });
  const patch = { planTry: { [account]: now }, next: { [account]: nextDue(slots) }, until: { [account]: until } };
  if (Object.keys(usedNow).length) patch.used = { [account]: usedNow };
  await settingsRef(db).set(patch, { merge: true });
  return { planned: made.length, days: days.length, rows: rows.length, times, source: peak.source };
}

/* ----------------------------------------------------------------- board */

/** The account's week, slot by slot, the hours it posts in, and groups ready to put in a slot. */
async function board(deps, account, now) {
  if (!validAccount(account)) return null;
  const { db, content } = deps;
  const [snap, settings] = await Promise.all([planRef(db, account).get(), loadSettings(db)]);
  const p = snap.exists ? snap.data() : {};
  const today = dayNumber(now);
  const slots = (p.slots || []).filter(s => s.day >= today - 1);
  let ready = [];
  try {
    const [cands, used] = await Promise.all([candidates(content, now), usedGroups(db, account, settings, now)]);
    slots.forEach(s => { if (s.groupId && s.kind !== 'promo') used.add(s.groupId); });
    ready = cands.groups.filter(g => !used.has(g.groupId) && !(cands.stat && g.groupId === cands.stat.groupId)).slice(0, 18);
  } catch (err) {
    console.warn('[schedule] ready list', err && err.message);
  }
  return {
    account, auto: !!settings.auto[account], slots, ready, stat: p.stat || null, upcoming: [], suggest: ready,
    rows: designs.PALETTES.map(x => x.id), times: (p.times || []).map(m => ({ minutes: m })),
    peak: p.peak || null, builtAt: p.builtAt || null, until: p.until != null ? dateOf(p.until) : null, next: settings.next[account] || null
  };
}

/** Runs fn on the account's plan in a transaction; fn changes the slots and returns a result. */
async function withPlan(db, account, fn) {
  const ref = planRef(db, account);
  return db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { none: true };
    const p = snap.data();
    const slots = (p.slots || []).map(s => Object.assign({}, s));
    const out = fn(slots, p);
    if (out && out.write) {
      const patch = { slots };
      if (out.align) patch.align = out.align;
      tx.update(ref, patch);
    }
    return Object.assign({ slots }, out || {});
  });
}

const setNext = (db, account, slots) => settingsRef(db).set({ next: { [account]: nextDue(slots) } }, { merge: true });

/** The owner's changes to one planned slot: skip it, plan it again, or put another group in it. */
async function change(deps, id, op, groupId) {
  const { db } = deps;
  if (typeof id !== 'string' || !SLOT_ID.test(id)) return { ok: false, error: 'No such slot.' };
  const account = id.split('_')[0];
  let patch = null;
  if (op === 'group') {
    if (typeof groupId !== 'string' || !/^[a-z]{2}-\d{1,6}$/.test(groupId)) return { ok: false, error: 'No such group.' };
    const g = await deps.content.groupOf(groupId);
    if (!g) return { ok: false, error: 'No such group.' };
    patch = { groupId, categoryId: require('./poster').categoryOf(groupId), master: g.masterModelName || '', count: g.members.length,
      also: [], why: 'Chosen by the owner', source: 'owner', status: 'planned' };
  } else if (op !== 'skip' && op !== 'restore') return { ok: false, error: 'Unknown change.' };
  const r = await withPlan(db, account, slots => {
    const s = slots.find(x => x.id === id);
    if (!s) return { error: 'That slot is not planned.' };
    if (s.status === 'posted' || s.status === 'posting') return { error: 'That post is already on Instagram.' };
    if (op === 'skip') s.status = 'skipped';
    if (op === 'restore') { s.status = 'planned'; delete s.error; }
    if (op === 'group') {
      if (s.kind === 'promo') return { error: 'A marketing slot keeps its poster.' };
      if (s.kind === 'combo') s.kind = 'single';
      Object.assign(s, patch);
    }
    return { write: true };
  });
  if (r.none) return { ok: false, error: 'Nothing is planned yet.' };
  if (r.error) return { ok: false, error: r.error };
  await setNext(db, account, r.slots);
  if (op === 'group') await settingsRef(db).set({ used: { [account]: { [groupId]: Date.now() } } }, { merge: true });
  return { ok: true };
}

/* ------------------------------------------------------------------- run */

/**
 * Posts what is due, at most one post a run, on accounts whose auto posting is
 * on, and plans a new week when the plan runs short. A run with nothing due
 * reads one document.
 * @param {{db:Function, content:object, publish:Function, mediaCount?:Function, peak?:Function}} deps
 */
async function runDue(deps, now) {
  const { db } = deps;
  const settings = await loadSettings(db);
  const on = ACCOUNTS.filter(a => settings.auto[a]);
  if (!on.length) return { ran: false, reason: 'auto posting is off' };
  const today = dayNumber(now);
  let posted = null;
  for (const a of on) {
    const due = settings.next[a];
    if (due == null || due > now) continue;
    posted = await runAccount(deps, a, now);
    if (posted && posted.id) break;
  }
  const planned = {};
  for (const a of on) {
    const until = settings.until[a];
    if (until != null && until >= today + RENEW_DAYS) continue;
    if (now - (settings.planTry[a] || 0) < PLAN_RETRY_MS) continue;
    planned[a] = await plan(deps, a, now).catch(err => ({ error: err.message }));
  }
  return { ran: true, posted, planned };
}

/** The account's due slot: missed and stuck ones marked, then the earliest planned one posted. */
async function runAccount(deps, account, now) {
  const { db } = deps;
  const snap = await planRef(db, account).get();
  if (!snap.exists) { await setNext(db, account, []); return null; }
  const p = snap.data();
  const slots = p.slots || [];
  const stale = slots.some(s => (s.status === 'planned' && now - s.at > LATE_MS) || (s.status === 'posting' && now - (s.startedAt || 0) > STUCK_MS));
  let current = slots;
  if (stale) {
    const r = await withPlan(db, account, list => {
      list.forEach(s => {
        if (s.status === 'planned' && now - s.at > LATE_MS) s.status = 'missed';
        if (s.status === 'posting' && now - (s.startedAt || 0) > STUCK_MS) {
          s.status = 'failed';
          s.error = 'Posting did not finish. Check Instagram before posting it again.';
        }
      });
      return { write: true };
    });
    current = r.slots || slots;
  }
  const due = current.filter(s => s.status === 'planned' && s.at <= now).sort((a, b) => a.at - b.at)[0];
  if (!due) { await setNext(db, account, current); return null; }

  /* a row's first post: bring the grid back to threes first, when it is off */
  if (due.pos === 0 && !due.aligned && deps.mediaCount) {
    const fill = await fillersFor(deps, account, p, now).catch(() => null);
    if (fill && fill.need > 0 && (due.fillers || 0) < MAX_FILLERS) return postFiller(deps, account, due, p, now);
    return postSlot(deps, due.id, now, fill ? fill.count : null);
  }
  return postSlot(deps, due.id, now, null);
}

/**
 * How many posts the grid needs before a new row: the media count against the
 * count at the last row's start. The first time, the rows of the old
 * schedule (one row a day) tell where the grid stands.
 */
async function fillersFor(deps, account, p, now) {
  const count = await deps.mediaCount(account);
  if (!(count >= 0)) return null;
  const align = p.align || {};
  if (typeof align.base === 'number') {
    const off = ((count - (align.base + 3)) % 3 + 3) % 3;
    return { count, need: (3 - off) % 3 };
  }
  const snap = await deps.db().collection(C.CONTENT_POSTS).orderBy('at', 'desc').limit(30).get().catch(() => ({ docs: [] }));
  const mine = snap.docs.map(d => d.data()).filter(v => v.account === account);
  const lastOld = mine.findIndex(v => /_\d{4}-\d{2}-\d{2}_[0-2]$/.test(String(v.scheduleId || '')));
  if (lastOld < 0) return { count, need: 0 };
  const k = Number(String(mine[lastOld].scheduleId).slice(-1));
  const into = (k + 1 + lastOld) % 3;
  return { count, need: (3 - into) % 3 };
}

/** A marketing poster that only evens the grid; the row's slot waits for the next run. */
async function postFiller(deps, account, due, p, now) {
  const { db } = deps;
  const stat = p.stat;
  if (!stat) return postSlot(deps, due.id, now, null);
  const T = promos.TEMPLATES;
  const template = T[((due.rowNo || 0) + (due.fillers || 0) + 2) % T.length].id;
  const r = await deps.publish({
    account, group: stat.groupId, kind: 'promo', palette: due.palette, template, keyword: account === 'proglide' ? 'LINK' : undefined,
    cta: designs.CTAS[((due.rowNo || 0) + 1) % designs.CTAS.length], uid: 'scheduler', scheduleId: due.id + '_fill',
    meta: { filler: true, row: due.rowNo, column: 'filler' }
  }).catch(err => ({ ok: false, message: err.message }));
  await withPlan(db, account, slots => {
    const s = slots.find(x => x.id === due.id);
    if (s) s.fillers = (s.fillers || 0) + 1;
    return { write: true };
  });
  return { id: due.id + '_fill', ok: !!r.ok, filler: true, mediaId: r.mediaId, error: r.ok ? undefined : r.message };
}

/** Takes one slot for posting (once), posts it, and records how it went. */
async function postSlot(deps, id, now, alignBase) {
  const { db } = deps;
  if (typeof id !== 'string' || !SLOT_ID.test(id)) return null;
  const account = id.split('_')[0];
  const took = await withPlan(db, account, (slots, p) => {
    const s = slots.find(x => x.id === id);
    if (!s || s.status !== 'planned') return { took: null };
    s.status = 'posting';
    s.startedAt = now;
    s.aligned = true;
    const out = { took: Object.assign({}, s), write: true };
    if (s.pos === 0 && typeof alignBase === 'number') out.align = { base: alignBase, at: now };
    return out;
  });
  if (!took || !took.took) return null;
  const s = took.took;
  let r;
  try {
    r = await deps.publish({
      account: s.account, group: s.groupId, kind: s.kind, design: s.design || undefined, palette: s.palette,
      template: s.template || undefined, keyword: s.keyword || undefined, cta: s.cta || undefined, also: s.also || [],
      uid: 'scheduler', scheduleId: id, meta: { row: s.rowNo, column: s.column, master: s.master, masterId: s.masterId || null }
    });
  } catch (err) {
    r = { ok: false, message: err.message || String(err) };
  }
  const done = await withPlan(db, account, slots => {
    const x = slots.find(y => y.id === id);
    if (!x) return {};
    if (r.ok) Object.assign(x, { status: 'posted', mediaId: r.mediaId, permalink: r.permalink || null, postedAt: Date.now() });
    else Object.assign(x, { status: 'failed', error: String(r.message || 'not posted').slice(0, 300), endedAt: Date.now() });
    return { write: true };
  });
  await setNext(db, account, done.slots || []);
  return r.ok ? { id, ok: true, mediaId: r.mediaId } : { id, ok: false, error: r.message };
}

/** The live services, for the runner on the reply bot's poll and for the admin page. */
function liveDeps() {
  const { db } = require('../../_lib/firebase');
  const content = require('./service');
  const publisher = require('./publish');
  return {
    db, content,
    publish: o => publisher.publish(o),
    mediaCount: a => publisher.mediaCount(a),
    peak: a => publisher.onlineFollowers(a)
  };
}

/* The old three-a-day times, for the templates view's legend */
const SLOTS = POSITIONS.map(x => ({ slot: x.pos, column: x.column, kind: x.pos === 2 ? 'carousel' : x.pos === 1 ? 'single' : 'combo' }));

module.exports = {
  liveDeps, ACCOUNTS, SLOTS, STATUSES, WEEK_DAYS, PER_DAY, LATE_MS, INDIA_DAY,
  dayNumber, dateOf, slotAt, idOf, toIndiaHours, blend, chooseTimes, todayTimes, rowOf, looks,
  loadSettings, setAuto, candidates, plan, board, change, runDue, runAccount, postSlot, nextDue,
  _reset: () => { candidateCache = null; }
};
