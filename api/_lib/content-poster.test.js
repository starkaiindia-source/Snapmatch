/* ============================================================================
   api/_lib/content-poster.test.js
   ----------------------------------------------------------------------------
   Instagram posters from a compatibility group.

     · every design draws every category, in every colour, with the same
       footer: the ProGlide logo, Google's Play badge and "Comment LINK"
     · the colour turns every day and the design every three days, so a colour
       always sits in the same column of the profile grid
     · a carousel is a cover, list pages and an app page, never more than
       Instagram's ten
     · the picture is a JPEG, the only kind Instagram's publishing API takes
     · the AI photo is asked for with no text and no logos, and is kept small
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const poster = require('../_services/content/poster');
const photos = require('../_services/content/picture-ai');

const BRANDS = ['Vivo', 'Realme', 'Samsung', 'Oppo', 'Tecno', 'Xiaomi', 'Infinix', 'itel'];
function group(groupId, count) {
  const members = [];
  for (let i = 0; i < count; i++) members.push({ id: 'm' + i, name: BRANDS[i % BRANDS.length] + ' Phone ' + i });
  return { groupId, masterModelName: members[0].name, memberCount: count, members };
}
const brandOf = m => m.name.split(' ')[0];
const images = svg => (svg.match(/<image /g) || []).length;

test('every category has its part, and the group id says which', () => {
  Object.keys(poster.PARTS).forEach(cat => assert.ok(poster.PARTS[cat].en && poster.PARTS[cat].ta && poster.PARTS[cat].unit, cat));
  assert.equal(poster.categoryOf('sg-0167'), 'screen-guards');
  assert.equal(poster.categoryOf('bc-0627'), 'back-cover');
  assert.equal(poster.categoryOf('zz-1'), null);
});

test('every design draws, in every colour, big group and small, with the logo and Play badge', async () => {
  await poster.ready();
  assert.equal(poster.DESIGNS.length, 6);
  assert.equal(poster.PALETTES.length, 3);
  poster.DESIGNS.forEach(d => poster.PALETTES.forEach(p => [group('sg-0001', 300), group('bc-0001', 3)].forEach(g => {
    const svg = poster.single(g, brandOf, { design: d.id, palette: p.id });
    assert.ok(svg.startsWith('<svg') && svg.indexOf('<defs>') > 0, d.id);
    assert.ok(images(svg) >= 3, d.id + ': logo, Play badge and the part');
    const plain = svg.replace(/data:[^"]+/g, '');
    assert.ok(plain.indexOf('undefined') < 0 && plain.indexOf('NaN') < 0, d.id + ' ' + p.id + ' has a broken value');
  })));
});

test('the colour turns daily and the design every three days', () => {
  const days = [0, 1, 2, 3, 4, 5, 6].map(poster.planFor);
  assert.deepEqual(days.slice(0, 3).map(x => x.palette), ['royal', 'sunset', 'mint']);
  assert.equal(days[3].palette, 'royal');
  assert.equal(days[0].design, days[2].design);
  assert.notEqual(days[2].design, days[3].design);
  assert.equal(poster.planFor(18).design, poster.planFor(0).design, 'six designs, then round again');
});

test('a carousel is a cover, list pages and an app page, at most ten', async () => {
  await poster.ready();
  const big = poster.carousel(group('sg-0002', 900), brandOf, { design: 'update' });
  assert.ok(big.length <= 10 && big.length >= 3, String(big.length));
  const small = poster.carousel(group('mf-0002', 20), brandOf, { design: 'checklist' });
  assert.equal(small.length, 3);
});

test('the picture is a JPEG of 1080 by 1350', async () => {
  await poster.ready();
  const jpeg = Buffer.from(poster.toJpeg(poster.single(group('cd-0003', 30), brandOf, { design: 'splash' })));
  assert.equal(jpeg[0], 0xFF);
  assert.equal(jpeg[1], 0xD8);
  assert.equal(poster.W, 1080);
  assert.equal(poster.H, 1350);
});

test('the AI photo is asked for without text or logos, and kept as a small JPEG', () => {
  const p = photos.prompt('screen-guards', 'Realme 5');
  assert.match(p, /no text/i);
  assert.match(p, /logos/i);
  assert.equal(photos.keyOf('back-cover', 'Oppo A6 (India)'), 'back-cover__oppo-a6-india-');
  const { PNG } = require('pngjs');
  const png = new PNG({ width: 1600, height: 1600 });
  png.data.fill(200);
  const jpeg = photos.toJpeg(PNG.sync.write(png));
  assert.equal(jpeg[0], 0xFF);
  assert.ok(jpeg.length < 200000);
});
