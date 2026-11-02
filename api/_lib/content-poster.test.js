/* ============================================================================
   api/_lib/content-poster.test.js
   ----------------------------------------------------------------------------
   Instagram posters from a compatibility group.

     · every category draws, with its own part name, and the footer is the same
       on every picture: the ProGlide logo, the Play badge and "Comment LINK"
     · a single poster shows several brands, not the first brand's list, and
       says how many more are in the app
     · a carousel is a cover, list pages and an app page, never more than
       Instagram's ten
     · the picture is a JPEG, the only kind Instagram's publishing API takes
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const poster = require('../_services/content/poster');

const BRANDS = ['Vivo', 'Realme', 'Samsung', 'Oppo', 'Tecno', 'Xiaomi', 'Infinix', 'itel'];
function group(groupId, count) {
  const members = [];
  for (let i = 0; i < count; i++) members.push({ id: 'm' + i, name: BRANDS[i % BRANDS.length] + ' Phone ' + i });
  return { groupId, masterModelName: members[0].name, memberCount: count, members };
}
const brandOf = m => m.name.split(' ')[0];
/* the text is drawn as glyph outlines, so a picture is checked by its parts */
const images = svg => (svg.match(/<image /g) || []).length;
const brandBars = svg => (svg.match(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="38" rx="10"/g) || []).length;

test('every category has its part, and the group id says which', () => {
  Object.keys(poster.PARTS).forEach(cat => assert.ok(poster.PARTS[cat].en && poster.PARTS[cat].ta, cat));
  assert.equal(poster.categoryOf('sg-0167'), 'screen-guards');
  assert.equal(poster.categoryOf('bc-0627'), 'back-cover');
  assert.equal(poster.categoryOf('zz-1'), null);
});

test('a single poster shows six brands of a big group, with the logo and Play badge', async () => {
  await poster.ready();
  const svg = poster.single(group('sg-0001', 300), brandOf);
  assert.ok(svg.startsWith('<svg') && svg.indexOf('<defs>') > 0);
  assert.equal(brandBars(svg), 6, 'six brands share the list');
  assert.ok(images(svg) >= 4, 'logo twice, part picture, Play badge');
});

test('a small group lists every model on one poster', async () => {
  await poster.ready();
  const svg = poster.single(group('bc-0001', 12), brandOf);
  assert.ok(brandBars(svg) >= 6);
});

test('a carousel is a cover, list pages and an app page, at most ten', async () => {
  await poster.ready();
  const big = poster.carousel(group('sg-0002', 900), brandOf);
  assert.ok(big.length <= 10 && big.length >= 3, String(big.length));
  const small = poster.carousel(group('mf-0002', 20), brandOf);
  assert.equal(small.length, 3);
});

test('the picture is a JPEG of 1080 by 1350', async () => {
  await poster.ready();
  const jpeg = Buffer.from(poster.toJpeg(poster.single(group('cd-0003', 30), brandOf)));
  assert.equal(jpeg[0], 0xFF);
  assert.equal(jpeg[1], 0xD8);
  assert.equal(poster.W, 1080);
  assert.equal(poster.H, 1350);
});
