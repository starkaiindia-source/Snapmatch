/* ============================================================================
   api/_lib/content-schedule.test.js
   ----------------------------------------------------------------------------
   Three posts a day an account, and how each post did.

     · a day is one row of the grid: three posts, one colour, a single on the
       right, the marketing poster in the middle, a carousel on the left; the
       next day's row is another colour, and the accounts differ
     · planning fills only what is missing, never the same group twice on an
       account, and a carousel gets a long list
     · only an account with auto posting on is posted, one post a run, a slot
       taken once, and a slot missed by hours is marked missed, not posted late
     · a post is judged against the account's own usual, with reasons that
       rest on numbers, and a young post is not judged
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const schedule = require('../_services/content/schedule');
const insights = require('../_services/content/insights');
const designs = require('../_services/content/designs');

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
/* 2026-11-07 06:00 IST */
const NOW = Date.UTC(2026, 10, 7, 0, 30);

function fakeDb() {
  const cols = {};
  const colOf = name => (cols[name] = cols[name] || {});
  const ref = (name, id) => ({
    id,
    get: async () => snap(name, id),
    set: async (v, o) => { const c = colOf(name); c[id] = o && o.merge ? merge(c[id] || {}, v) : v; },
    create: async v => { const c = colOf(name); if (c[id]) throw new Error('exists'); c[id] = Object.assign({}, v); },
    update: async v => { const c = colOf(name); if (!c[id]) throw new Error('missing'); Object.assign(c[id], v); }
  });
  const snap = (name, id) => ({ id, exists: !!colOf(name)[id], data: () => colOf(name)[id] });
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
    getAll: async (...refs) => refs.map(r => r.get()).reduce(async (acc, p) => (await acc).concat([await p]), Promise.resolve([])),
    runTransaction: async fn => fn({ get: r => r.get(), update: (r, v) => r.update(v) })
  };
  const db = () => api;
  db.cols = cols;
  return db;
}

const content = {
  ideas: async () => ({
    asked: [{ id: 'a1', name: 'Redmi 13C', count: 9 }],
    searched: [{ id: 's1', name: 'Vivo Y21', count: 40 }],
    newest: [],
    biggest: [
      { groupId: 'sg-0001', categoryId: 'screen-guards', master: 'Redmi Note 13', count: 38 },
      { groupId: 'bc-0002', categoryId: 'back-cover', master: 'Realme C35', count: 14 },
      { groupId: 'cd-0003', categoryId: 'combo-display', master: 'Oppo A17', count: 20 },
      { groupId: 'bt-0004', categoryId: 'battery', master: 'Vivo Y20', count: 16 },
      { groupId: 'mf-0005', categoryId: 'middle-frame', master: 'Infinix Hot 40i', count: 12 },
      { groupId: 'sg-0006', categoryId: 'screen-guards', master: 'Samsung A05', count: 25 },
      { groupId: 'bf-0007', categoryId: 'button-flex', master: 'Tecno Spark 20', count: 4 }
    ]
  }),
  groupsOf: async id => ({ groups: id === 'a1' ? [{ groupId: 'sg-0100', categoryId: 'screen-guards', master: 'Redmi 13C', count: 6 }]
    : [{ groupId: 'bc-0200', categoryId: 'back-cover', master: 'Vivo Y21', count: 3 }, { groupId: 'cd-0201', categoryId: 'combo-display', master: 'Vivo Y21', count: 2 }] }),
  groupOf: async id => ({ masterModelName: 'X', members: [{ id: '1' }, { id: '2' }] })
};

test('a day is one row: single right, marketing middle, carousel left, one colour, the next day another', () => {
  const day = schedule.dayNumber(NOW);
  const a = schedule.dayPlan('proglide', day);
  assert.deepEqual(a.map(s => s.kind), ['single', 'promo', 'carousel']);
  assert.deepEqual(a.map(s => s.column), ['right', 'middle', 'left']);
  assert.equal(new Set(a.map(s => s.palette)).size, 1, 'one colour a row');
  assert.ok(a[0].at < a[1].at && a[1].at < a[2].at, 'posted right to left, so the grid reads in order');
  assert.equal(new Date(a[0].at + 5.5 * HOUR).toISOString().slice(0, 16), '2026-11-07T09:30');
  assert.equal(a[0].id, 'proglide_2026-11-07_0');
  assert.notEqual(a[0].design, a[2].design, 'the single and the carousel look different');
  assert.ok(a.every(s => /^(LINK|PROGLIDE|TOOL)$/.test(s.keyword)));
  assert.ok(schedule.dayPlan('mpf', day).every(s => s.keyword === null), 'no comment word where nothing answers it');
  for (let d = day; d < day + 12; d++) {
    assert.notEqual(schedule.rowPalette('proglide', d), schedule.rowPalette('proglide', d + 1), 'rows next to each other differ');
  }
  assert.notEqual(schedule.rowPalette('proglide', day), schedule.rowPalette('mpf', day), 'the two accounts differ');
  assert.equal(designs.PALETTES.length, 6);
});

test('planning fills three days once, never the same group twice, a carousel gets a long list', async () => {
  schedule._reset();
  const db = fakeDb();
  const r = await schedule.plan({ db, content }, 'proglide', NOW);
  assert.equal(r.planned, 9);
  const slots = Object.values(db.cols.contentSchedule);
  const groups = slots.filter(s => s.kind !== 'promo').map(s => s.groupId);
  assert.equal(new Set(groups).size, groups.length, 'no group twice');
  assert.ok(slots.filter(s => s.kind === 'carousel').every(s => s.count >= 12), 'carousels are long lists');
  assert.ok(slots.filter(s => s.kind === 'promo').every(s => s.groupId === 'sg-0001' && s.template), 'promo numbers from the biggest glass group');
  assert.equal(slots.find(s => s.kind === 'single').source, 'asked', 'what people ask about goes first');
  const again = await schedule.plan({ db, content }, 'proglide', NOW);
  assert.equal(again.planned, 0, 'nothing planned twice');
  assert.ok(db.cols.contentSettings.schedule.used.proglide['sg-0100']);
});

test('only an account with auto on is posted, one a run, once; a slot hours late is missed', async () => {
  schedule._reset();
  const db = fakeDb();
  const posted = [];
  const publish = async o => { posted.push(o); return { ok: true, mediaId: 'M' + posted.length, permalink: 'https://instagram.com/p/x' }; };
  await schedule.plan({ db, content }, 'proglide', NOW);
  const day = schedule.dayNumber(NOW);
  const [single, promo] = schedule.dayPlan('proglide', day);

  const off = await schedule.runDue({ db, content, publish }, promo.at + 60000);
  assert.equal(off.ran, false);
  assert.equal(posted.length, 0, 'auto posting is off: nothing posts');

  await schedule.setAuto(db, 'proglide', true, 'u1', NOW);
  const r = await schedule.runDue({ db, content, publish }, promo.at + 60000);
  assert.equal(posted.length, 1, 'one post a run');
  assert.equal(r.posted.id, promo.id);
  assert.equal(db.cols.contentSchedule[single.id].status, 'missed', 'the morning slot, 4.5 hours late, is not posted out of order');
  assert.equal(db.cols.contentSchedule[promo.id].status, 'posted');
  assert.equal(posted[0].kind, 'promo');
  assert.ok(posted[0].template && /^(LINK|PROGLIDE|TOOL)$/.test(posted[0].keyword));
  await schedule.runDue({ db, content, publish }, promo.at + 120000);
  assert.equal(posted.length, 1, 'a posted slot is never posted again');
  assert.equal(await schedule.postSlot({ db, content, publish }, promo.id, NOW), null);

  const fails = fakeDb();
  await schedule.plan({ db: fails, content }, 'mpf', NOW);
  await schedule.setAuto(fails, 'mpf', true, 'u1', NOW);
  const m = schedule.dayPlan('mpf', day)[0];
  await schedule.runDue({ db: fails, content, publish: async () => ({ ok: false, message: 'quota' }) }, m.at + 1000);
  assert.equal(fails.cols.contentSchedule[m.id].status, 'failed');
  assert.equal(fails.cols.contentSchedule[m.id].error, 'quota');
});

test('the owner can skip a slot, bring it back, or put another group in it', async () => {
  schedule._reset();
  const db = fakeDb();
  await schedule.plan({ db, content }, 'proglide', NOW);
  const id = schedule.dayPlan('proglide', schedule.dayNumber(NOW) + 1)[0].id;
  assert.equal((await schedule.change({ db, content }, id, 'skip')).ok, true);
  assert.equal(db.cols.contentSchedule[id].status, 'skipped');
  await schedule.change({ db, content }, id, 'restore');
  assert.equal(db.cols.contentSchedule[id].status, 'planned');
  assert.equal((await schedule.change({ db, content }, id, 'group', 'bt-0999')).ok, true);
  assert.equal(db.cols.contentSchedule[id].groupId, 'bt-0999');
  assert.equal((await schedule.change({ db, content }, '../x', 'skip')).ok, false);
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
