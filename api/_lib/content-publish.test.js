/* ============================================================================
   api/_lib/content-publish.test.js
   ----------------------------------------------------------------------------
   Posting a poster to Instagram.

     · the picture URL Instagram fetches is signed, and a changed or expired one
       is refused
     · each account gets its own brand: a Mobile Parts Finder poster or caption
       never carries ProGlide's logo or name, and the other way round
     · a single poster is one container, a carousel one per slide plus the
       carousel, and nothing is published before Instagram says FINISHED
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.INSTAGRAM_PUBLISH_ACCESS_TOKEN = 'test-token-not-real';
process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID = '111';

const publish = require('../_services/content/publish');
const content = require('../_services/content/service');
const poster = require('../_services/content/poster');
const draw = require('../_services/content/draw');

const BRANDS = ['Vivo', 'Realme', 'Samsung', 'Oppo'];
function group(groupId, count) {
  const members = [];
  for (let i = 0; i < count; i++) members.push({ id: 'm' + i, name: BRANDS[i % BRANDS.length] + ' Phone ' + i });
  return { groupId, masterModelName: members[0].name, memberCount: count, members };
}
const brandOf = m => m.name.split(' ')[0];

test('a poster link is signed, and a changed or expired link is refused', () => {
  const now = Date.now();
  const url = new URL(publish.imageUrl({ groupId: 'sg-0167', kind: 'carousel', slide: 2, design: 'series', palette: 'mint', brand: 'mpf' }, now));
  assert.equal(url.origin + url.pathname, 'https://www.mobilepartsfinder.com/api/poster');
  const q = Object.fromEntries(url.searchParams);
  assert.deepEqual(publish.verify(q, now), { groupId: 'sg-0167', kind: 'carousel', slide: 2, design: 'series', palette: 'mint', brand: 'mpf' });
  assert.equal(publish.verify(Object.assign({}, q, { g: 'sg-0001' }), now), null, 'another group');
  assert.equal(publish.verify(Object.assign({}, q, { b: 'proglide' }), now), null, 'another brand');
  assert.equal(publish.verify(Object.assign({}, q, { sig: 'x'.repeat(32) }), now), null, 'forged');
  assert.equal(publish.verify(q, now + publish.URL_TTL_MS + 1000), null, 'expired');
  assert.equal(publish.verify({}, now), null);
});

test('each account gets its own logo on the poster', async () => {
  await poster.ready();
  const g = group('sg-0167', 30);
  const mine = draw.asset('mpf.png');
  const theirs = draw.asset('proglide.png');
  assert.ok(mine && theirs);
  for (const design of poster.DESIGNS) {
    const m = poster.single(g, brandOf, { brand: 'mpf', design: design.id });
    const p = poster.single(g, brandOf, { brand: 'proglide', design: design.id });
    assert.ok(m.includes(mine) && !m.includes(theirs), 'mpf ' + design.id);
    assert.ok(p.includes(theirs) && !p.includes(mine), 'proglide ' + design.id);
  }
  const last = poster.carousel(g, brandOf, { brand: 'mpf' }).pop();
  assert.ok(!last.includes(theirs) && !last.includes(draw.asset('google-play-badge.png')), 'the MPF app page has no ProGlide logo or Play badge');
});

test('each account gets its own caption, every model listed, within Instagram\'s length', () => {
  const g = group('sg-0167', 40);
  const m = publish.captionFor(g, brandOf, 'mpf');
  const p = publish.captionFor(g, brandOf, 'proglide');
  assert.ok(/mobilepartsfinder\.com/.test(m) && !/proglide|comment link/i.test(m));
  assert.ok(/Comment LINK/.test(p) && /Comment 9H/.test(p) && !/mobilepartsfinder/i.test(p));
  assert.ok(m.includes('Vivo: Phone 0, Phone 4'));
  const big = publish.captionFor(group('bc-0001', 900), brandOf, 'mpf');
  assert.ok(big.length <= 2200 && /\+ \d+ more on the website/.test(big));
});

function fakeGraph(statusSeq) {
  const calls = [];
  let n = 0;
  const statuses = statusSeq.slice();
  const fetch = async (url, init) => {
    const u = new URL(url);
    const params = Object.fromEntries(init.method === 'GET' ? u.searchParams : new URLSearchParams(init.body));
    calls.push({ method: init.method, path: u.pathname.replace('/v25.0/', ''), params });
    let body;
    if (u.pathname.endsWith('/media')) body = { id: 'c' + (++n) };
    else if (u.pathname.endsWith('/media_publish')) body = { id: 'post1' };
    else if (params.fields === 'status_code,status') body = { status_code: statuses.length > 1 ? statuses.shift() : statuses[0] };
    else if (params.fields === 'permalink') body = { permalink: 'https://www.instagram.com/p/x/' };
    else body = {};
    return { ok: true, status: 200, json: async () => body, headers: { get: () => null } };
  };
  return { calls, fetch };
}

function withFakes(g, slides, fn) {
  const saved = { groupOf: content.groupOf, picture: content.picture };
  content.groupOf = async () => g;
  content.picture = async () => ({ jpeg: Buffer.from('x'), slides, photo: false });
  const writes = [];
  const db = () => ({ collection: () => ({ doc: id => ({ set: async v => writes.push({ id, v }) }) }) });
  return fn(db, writes).finally(() => Object.assign(content, saved));
}

test('a single poster: one container, published once Instagram has it, and recorded', () =>
  withFakes(group('sg-0167', 12), 1, async (db, writes) => {
    const g = fakeGraph(['IN_PROGRESS', 'FINISHED']);
    const r = await publish.publish({ account: 'proglide', group: 'sg-0167', kind: 'single', caption: 'hello', uid: 'u1' },
      { fetch: g.fetch, db, sleep: async () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.permalink, 'https://www.instagram.com/p/x/');
    const posts = g.calls.filter(c => c.method === 'POST');
    assert.deepEqual(posts.map(c => c.path), ['111/media', '111/media_publish']);
    assert.equal(posts[0].params.caption, 'hello');
    assert.match(posts[0].params.image_url, /\/api\/poster\?.*b=proglide/);
    assert.equal(g.calls.filter(c => c.params.fields === 'status_code,status').length, 2, 'waited for FINISHED');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].v.account, 'proglide');
    assert.ok(!JSON.stringify(writes[0].v).includes('test-token'), 'the token is not stored');
  }));

test('a carousel on Mobile Parts Finder: a container a slide, then the carousel, all in its brand', () =>
  withFakes(group('sg-0167', 60), 4, async db => {
    const g = fakeGraph(['FINISHED']);
    const r = await publish.publish({ account: 'mpf', group: 'sg-0167', kind: 'carousel' }, { fetch: g.fetch, db, sleep: async () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.slides, 4);
    const media = g.calls.filter(c => c.method === 'POST' && c.path.endsWith('/media'));
    assert.equal(media.length, 5);
    assert.ok(media.every(c => c.path === '17841434220027404/media'));
    assert.ok(media.slice(0, 4).every(c => c.params.is_carousel_item === 'true' && /b=mpf/.test(c.params.image_url)));
    assert.equal(media[4].params.media_type, 'CAROUSEL');
    assert.equal(media[4].params.children.split(',').length, 4);
    assert.ok(/mobilepartsfinder\.com/.test(media[4].params.caption) && !/proglide/i.test(media[4].params.caption), 'its own default caption');
  }));

test('nothing is posted when Instagram cannot take the picture', () =>
  withFakes(group('sg-0167', 12), 1, async db => {
    const g = fakeGraph(['ERROR']);
    await assert.rejects(publish.publish({ account: 'mpf', group: 'sg-0167', kind: 'single' }, { fetch: g.fetch, db, sleep: async () => {} }), /could not take the picture/);
    assert.equal(g.calls.filter(c => c.path.endsWith('media_publish')).length, 0);
  }));

test('an unknown account is refused before anything is drawn', async () => {
  const r = await publish.publish({ account: 'someone', group: 'sg-0167' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_account');
});
