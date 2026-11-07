/* ============================================================================
   api/_lib/content-schedule.test.js
   ----------------------------------------------------------------------------
   Nine posts a day an account, a week planned at once, and how each post did.

     · the times come from the followers' hours (in India time), else a usual
       Indian day: nine of them, in whole rows, today's still ahead
     · a row is one phone: carousel left (its glass), its biggest other part in
       the middle, its other parts (or marketing) on the right, one colour,
       posted right first
     · the week is one document; no group twice, the two accounts never share
       a phone, and their marketing is never within an hour
     · only an account with auto posting on is posted, one post a run, a slot
       taken once, a slot hours late is missed, and a run with nothing due
       reads one document
     · a row whose grid is off by a post or two starts with marketing to even it
     · a post is judged against the account's own usual, with reasons that
       rest on numbers, and a young post is not judged
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const schedule = require('../_services/content/schedule');
const insights = require('../_services/content/insights');
const designs = require('../_services/content/designs');

const HOUR = 3600 * 1000;
/* 2026-11-07 06:00 IST */
const NOW = Date.UTC(2026, 10, 7, 0, 30);
const IST = t => new Date(t + 5.5 * HOUR).toISOString().slice(11, 16);

function fakeDb() {
  const cols = {};
  let reads = 0;
  const colOf = name => (cols[name] = cols[name] || {});
  const copy = v => JSON.parse(JSON.stringify(v));
  const ref = (name, id) => ({
    id,
    get: async () => snap(name, id),
    set: async (v, o) => { const c = colOf(name); c[id] = o && o.merge ? merge(c[id] || {}, v) : copy(v); },
    update: async v => { const c = colOf(name); if (!c[id]) throw new Error('missing'); Object.assign(c[id], copy(v)); }
  });
  const snap = (name, id) => { reads++; const v = colOf(name)[id]; return { id, exists: !!v, data: () => (v ? copy(v) : undefined) }; };
  const merge = (a, b) => {
    const out = Object.assign({}, a);
    Object.keys(b).forEach(k => { out[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? merge(a[k] || {}, b[k]) : b[k]; });
    return out;
  };
  const api = {
    collection: name => ({
      doc: id => ref(name, id),
      orderBy: () => ({ limit: () => ({ get: async () => ({ docs: Object.keys(colOf(name)).map(id => ({ id, data: () => colOf(name)[id] })) }) }) })
    }),
    runTransaction: async fn => fn({ get: r => r.get(), update: (r, v) => r.update(v) })
  };
  const db = () => api;
  db.cols = cols;
  db.reads = () => reads;
  return db;
}

/* phones m0..m79: each has a glass, a back cover, and some more parts */
const PARTS = [['sg', 'screen-guards', 20], ['bc', 'back-cover', 12], ['cd', 'combo-display', 9], ['mf', 'middle-frame', 7], ['bt', 'battery', 5]];
const groupsFor = n => PARTS.slice(0, n % 4 === 0 ? 1 : n % 4 === 1 ? 2 : 5)
  .map(([p, categoryId, count]) => ({ groupId: `${p}-${1000 + n}`, categoryId, master: 'Phone ' + n, count: count - (n % 3) }));
const content = {
  ideas: async () => ({
    asked: [{ id: 'm1', name: 'Phone 1', count: 9 }],
    searched: [{ id: 'm2', name: 'Phone 2', count: 40 }],
    newest: [{ id: 'm3', name: 'Phone 3', year: 2026 }],
    biggest: [
      { groupId: 'sg-0001', categoryId: 'screen-guards', master: 'Big glass', count: 38 },
      { groupId: 'bc-0002', categoryId: 'back-cover', master: 'Big cover', count: 14 },
      { groupId: 'cd-0003', categoryId: 'combo-display', master: 'Big display', count: 20 }
    ]
  }),
  groupsOf: async id => ({ groups: groupsFor(Number(String(id).slice(1))) }),
  groupOf: async id => ({ masterModelName: 'Phone ' + id, members: [{ id: 'm' + (50 + Number(id.slice(-1))), name: 'Phone' }] }),
  masterIdOf: g => g.members[0].id,
  latest: () => Array.from({ length: 80 }, (_, i) => ({ id: 'm' + i, name: 'Phone ' + i, year: 2026 }))
};

test('nine times a day in the busy hours; the followers\' hours turned to India time', () => {
  const t = schedule.chooseTimes(schedule.blend(null), 'proglide');
  assert.equal(t.length, 9);
  assert.ok(t.every((m, i) => i === 0 || m > t[i - 1]), 'in order');
  assert.ok(t.every(m => m >= 7 * 60 && m < 24 * 60), 'from 7 AM to midnight');
  const perHour = {};
  t.forEach(m => { perHour[Math.floor(m / 60)] = (perHour[Math.floor(m / 60)] || 0) + 1; });
  assert.ok(Object.values(perHour).every(c => c <= 3));
  assert.ok(t.some(m => m >= 19 * 60 && m < 22 * 60), 'the evening peak is used');
  const mpf = schedule.chooseTimes(schedule.blend(null), 'mpf');
  assert.ok(mpf.every(m => t.indexOf(m) < 0), 'the two accounts never post at the same minute');

  /* followers online in Pacific hours: the quiet hours land in India's night */
  const raw = Array.from({ length: 24 }, (_, h) => (h >= 4 && h <= 9 ? 400 : h >= 12 && h <= 16 ? 20 : 150));
  const ist = schedule.toIndiaHours(raw);
  assert.ok(ist);
  const quiet = ist.indexOf(Math.min(...ist));
  assert.ok(quiet >= 0 && quiet <= 7, 'the quietest hour is at night in India');
  assert.equal(schedule.toIndiaHours(new Array(24).fill(1)), null, 'too few followers: no numbers');
  assert.equal(schedule.toIndiaHours(null), null);
});

test('today gets whole rows still ahead; late in the day, one row soon', () => {
  const day = schedule.dayNumber(NOW);
  const t = schedule.chooseTimes(schedule.blend(null), 'proglide');
  assert.equal(schedule.todayTimes(t, day, NOW).length, 9, 'at 6 AM the whole day is ahead');
  const afternoon = schedule.slotAt(day, 18 * 60);
  const left = schedule.todayTimes(t, day, afternoon);
  assert.equal(left.length % 3, 0);
  assert.ok(left.length >= 3 && left.every(m => schedule.slotAt(day, m) > afternoon));
  const late = schedule.slotAt(day, 22 * 60 + 50);
  const soon = schedule.todayTimes(t, day, late);
  assert.equal(soon.length, 3);
  assert.ok(soon.every(m => schedule.slotAt(day, m) > late));
});

test('a row is one phone: its glass carousel, its biggest other part, the rest on one poster', () => {
  const many = schedule.rowOf(groupsFor(2), new Set());
  assert.deepEqual(many.cells.map(c => c.kind), ['combo', 'single', 'carousel']);
  assert.equal(many.cells[2].group.categoryId, 'screen-guards', 'the carousel is the tempered glass');
  assert.equal(many.cells[1].group.categoryId, 'back-cover', 'the middle is the biggest other part');
  assert.ok(many.cells[2].also.length >= 3, 'with many parts, the carousel explains each');
  const two = schedule.rowOf(groupsFor(1), new Set());
  assert.deepEqual(two.cells.map(c => c.kind), ['promo', 'single', 'carousel'], 'one other part: marketing on the right');
  const one = schedule.rowOf(groupsFor(4), new Set());
  assert.deepEqual(one.cells.map(c => c.kind), ['promo', 'promo', 'carousel'], 'glass only: marketing fills the row');
  assert.equal(schedule.rowOf(groupsFor(4), new Set(['sg-1004'])), null, 'a phone whose glass was posted has no row');
});

test('the week is one document: nine a day, rows in one colour, no group twice, the accounts apart', async () => {
  schedule._reset();
  const db = fakeDb();
  const r = await schedule.plan({ db, content }, 'proglide', NOW);
  assert.equal(r.days, 7);
  assert.equal(r.planned, 63);
  assert.equal(r.source, 'usual', 'no follower hours: a usual Indian day');
  const p = db.cols.contentSettings.plan_proglide;
  assert.equal(p.slots.length, 63);
  const day = schedule.dayNumber(NOW);
  for (let d = day; d < day + 7; d++) assert.equal(p.slots.filter(s => s.day === d).length, 9);
  const rows = {};
  p.slots.forEach(s => { (rows[s.rowNo] = rows[s.rowNo] || []).push(s); });
  Object.values(rows).forEach(row => {
    assert.equal(row.length, 3);
    assert.equal(new Set(row.map(s => s.palette)).size, 1, 'one colour a row');
    assert.equal(new Set(row.map(s => s.masterId)).size, 1, 'one phone a row');
    const by = c => row.find(s => s.column === c);
    assert.equal(by('left').kind, 'carousel');
    assert.ok(by('right').at < by('middle').at && by('middle').at < by('left').at, 'right first, left last');
  });
  const rowNos = Object.keys(rows).map(Number).sort((a, b) => a - b);
  rowNos.slice(1).forEach((n, i) => assert.notEqual(rows[n][0].palette, rows[rowNos[i]][0].palette, 'rows next to each other differ'));
  const groups = [];
  p.slots.filter(s => s.kind !== 'promo').forEach(s => groups.push(s.groupId));
  assert.equal(new Set(groups).size, groups.length, 'no group twice');
  assert.ok(p.slots.filter(s => s.kind === 'promo').every(s => s.groupId === 'sg-0001' && s.template), 'marketing numbers from the biggest glass group');
  assert.ok(p.slots.every(s => s.account === 'proglide' && /_p[0-8]$/.test(s.id)));
  assert.ok(p.slots.filter(s => s.kind !== 'promo').every(s => /^(LINK|PROGLIDE|TOOL)$/.test(s.keyword) && designs.CTAS.indexOf(s.cta) > -1));
  assert.equal(db.cols.contentSettings.schedule.next.proglide, p.slots[0].at, 'the runner knows when the first post is due');

  const m = await schedule.plan({ db, content }, 'mpf', NOW);
  assert.ok(m.planned > 0);
  const q = db.cols.contentSettings.plan_mpf;
  const theirs = new Set(p.slots.map(s => s.masterId));
  assert.ok(q.slots.every(s => !theirs.has(s.masterId)), 'the accounts never share a phone');
  assert.ok(q.slots.every(s => s.keyword === null), 'no comment word where nothing answers it');
  const promos = p.slots.filter(s => s.kind === 'promo').map(s => s.at);
  assert.ok(q.slots.filter(s => s.kind === 'promo').every(s => promos.every(t => Math.abs(t - s.at) >= HOUR)), 'never marketing within the hour of the other');
  assert.notEqual(q.slots[0].palette, p.slots[0].palette, 'the accounts start on different colours');

  const again = await schedule.plan({ db, content }, 'proglide', NOW);
  assert.equal(again.planned, 0, 'a planned week is kept');
});

test('only an account with auto on is posted, one a run, once; a slot hours late is missed; nothing due reads one document', async () => {
  schedule._reset();
  const db = fakeDb();
  const posted = [];
  const publish = async o => { posted.push(o); return { ok: true, mediaId: 'M' + posted.length, permalink: 'https://instagram.com/p/x' }; };
  await schedule.plan({ db, content }, 'proglide', NOW);
  const slots = db.cols.contentSettings.plan_proglide.slots;
  const first = slots[0];
  const second = slots[1];

  const off = await schedule.runDue({ db, content, publish }, second.at + 60000);
  assert.equal(off.ran, false);
  assert.equal(posted.length, 0, 'auto posting is off: nothing posts');

  await schedule.setAuto(db, 'proglide', true, 'u1', NOW);
  const before = db.reads();
  await schedule.runDue({ db, content, publish }, first.at - 60000);
  assert.equal(db.reads() - before, 1, 'nothing due: one read');

  const late = first.at + 4 * HOUR;
  const due = slots.filter(s => s.at <= late && late - s.at <= schedule.LATE_MS)[0];
  const r = await schedule.runDue({ db, content, publish }, late);
  assert.equal(posted.length, 1, 'one post a run');
  assert.equal(r.posted.id, due.id);
  const now = db.cols.contentSettings.plan_proglide.slots;
  assert.equal(now.find(s => s.id === first.id).status, 'missed', 'four hours late is not posted out of order');
  assert.equal(now.find(s => s.id === due.id).status, 'posted');
  assert.equal(posted[0].kind, due.kind);
  assert.deepEqual(posted[0].also, due.also);
  assert.equal(posted[0].cta, due.cta);
  assert.equal(await schedule.postSlot({ db, content, publish }, due.id, late), null, 'a posted slot is never posted again');

  const fails = fakeDb();
  await schedule.plan({ db: fails, content }, 'mpf', NOW);
  await schedule.setAuto(fails, 'mpf', true, 'u1', NOW);
  const m = fails.cols.contentSettings.plan_mpf.slots[0];
  await schedule.runDue({ db: fails, content, publish: async () => ({ ok: false, message: 'quota' }) }, m.at + 1000);
  const mm = fails.cols.contentSettings.plan_mpf.slots.find(s => s.id === m.id);
  assert.equal(mm.status, 'failed');
  assert.equal(mm.error, 'quota');
});

test('a row whose grid is off starts with marketing to even it, then keeps count', async () => {
  schedule._reset();
  const db = fakeDb();
  const posted = [];
  let count = 100;
  const publish = async o => { posted.push(o); count++; return { ok: true, mediaId: 'M' + posted.length }; };
  const deps = { db, content, publish, mediaCount: async () => count };
  await schedule.plan(deps, 'proglide', NOW);
  await schedule.setAuto(db, 'proglide', true, 'u1', NOW);
  const s = db.cols.contentSettings.plan_proglide.slots;
  /* the first row: no count before it, so it starts where the grid is */
  for (let i = 0; i < 3; i++) await schedule.runDue(deps, s[i].at + 1000);
  assert.equal(posted.length, 3);
  assert.equal(db.cols.contentSettings.plan_proglide.align.base, 100);
  /* one post by hand: the grid is off by one */
  count++;
  await schedule.runDue(deps, s[3].at + 1000);
  assert.equal(posted.length, 4);
  assert.equal(posted[3].kind, 'promo', 'a marketing poster goes first');
  assert.ok(/_fill$/.test(posted[3].scheduleId));
  await schedule.runDue(deps, s[3].at + 2000);
  assert.equal(posted[4].kind, 'promo', 'two, to make three');
  await schedule.runDue(deps, s[3].at + 3000);
  assert.equal(posted[5].scheduleId, s[3].id, 'then the row itself');
  assert.equal(db.cols.contentSettings.plan_proglide.align.base, 106);
});

test('the owner can skip a slot, bring it back, or put another group in it', async () => {
  schedule._reset();
  const db = fakeDb();
  await schedule.plan({ db, content }, 'proglide', NOW);
  const slot = db.cols.contentSettings.plan_proglide.slots.find(s => s.kind === 'single');
  const id = slot.id;
  const get = () => db.cols.contentSettings.plan_proglide.slots.find(s => s.id === id);
  assert.equal((await schedule.change({ db, content }, id, 'skip')).ok, true);
  assert.equal(get().status, 'skipped');
  await schedule.change({ db, content }, id, 'restore');
  assert.equal(get().status, 'planned');
  assert.equal((await schedule.change({ db, content }, id, 'group', 'bt-0999')).ok, true);
  assert.equal(get().groupId, 'bt-0999');
  assert.equal((await schedule.change({ db, content }, '../x', 'skip')).ok, false);
  assert.equal((await schedule.change({ db, content }, 'proglide_2026-11-07_0', 'skip')).ok, false, 'old three-a-day ids are not this plan');
});

test('a post is judged against the usual, with reasons on numbers; a young post is not judged', () => {
  const t = h => NOW - h * HOUR;
  const post = (id, h, kind, reach, extra) => Object.assign({ id, at: t(h), kind, reach, views: reach, likes: 1, comments: 0, saves: 0, shares: 0, keyword: null }, extra);
  const posts = [
    post('a', 100, 'carousel', 900, { saves: 60, views: 2400, comments: 8, keyword: 'LINK' }),
    post('b', 124, 'carousel', 700, { saves: 20 }),
    post('c', 148, 'single', 200),
    post('d', 172, 'single', 180, { keyword: 'TOOL' }),
    post('e', 196, 'single', 220),
    post('f', 5, 'promo', 40)
  ];
  const r = insights.analyse(posts, NOW);
  assert.equal(r.usual.reach, 220);
  const a = r.posts.find(p => p.id === 'a');
  assert.ok(a.score > 4);
  assert.ok(a.reasons.some(x => x.tone === 'good' && /Reached 4\.1×/.test(x.text)));
  assert.ok(a.reasons.some(x => /Saved by/.test(x.text)));
  assert.ok(a.reasons.some(x => /swiped/.test(x.text)));
  assert.ok(a.reasons.some(x => /Comment LINK" worked/.test(x.text)));
  const d = r.posts.find(p => p.id === 'd');
  assert.ok(d.reasons.some(x => x.tone === 'bad' && /Nobody commented TOOL/.test(x.text)));
  const f = r.posts.find(p => p.id === 'f');
  assert.equal(f.young, true);
  assert.ok(/still collecting reach/.test(f.reasons[0].text), 'a 5-hour-old post is not called a failure');
  assert.ok(r.tips.some(x => /Carousels reach .* more than single posters/.test(x)));
  assert.equal(r.by.kind[0].key, 'carousel');
});

