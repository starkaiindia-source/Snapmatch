/* ============================================================================
   src/data/model-catalogue.test.js
   ----------------------------------------------------------------------------
   What the Models page promises about the catalogue it reads: which photograph
   a model gets, what its release date says, when it is NEW, what a search
   finds, and that its own page opens.

   The real dataset.js and api.js run in a sandbox over the real
   assets/dataset.json, so a claim here is a claim about the shipped catalogue
   and not about a fixture written to agree with the code.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const DATASET = fs.readFileSync(path.join(__dirname, 'dataset.js'), 'utf8');
const API = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
const BUNDLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'dataset.json'), 'utf8'));

function loadCatalogue() {
  /* setInterval is api.js's session heartbeat, which has no place in a test and
     would keep the process alive. */
  const sandbox = { setTimeout, setInterval() {}, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(DATASET, sandbox);
  vm.runInContext(API, sandbox);
  const SM = sandbox.SM;
  SM.dataset.build(BUNDLE);
  SM.__rebind.forEach(fn => fn());
  return SM;
}

const SM = loadCatalogue();
const released = (iso, extra) => Object.assign({ releaseDateIso: iso, releaseStatus: null }, extra);
const isNew = (iso, now, extra) => SM.dataset.isNewRelease(released(iso, extra), now);
const col = name => BUNDLE.modelCols.indexOf(name);

/* ---------------------------------------------------------------- NEW badge */
test('NEW: the example from the brief, on 30 October 2026', () => {
  const today = new Date(2026, 9, 30, 12);
  assert.equal(isNew('2026-10-15', today), true);
  assert.equal(isNew('2026-08-15', today), false);
});

test('NEW: the window is one calendar month, both ends included', () => {
  const today = new Date(2026, 9, 30, 12);
  assert.equal(isNew('2026-10-30', today), true, 'released today');
  assert.equal(isNew('2026-09-30', today), true, 'exactly one month ago');
  assert.equal(isNew('2026-09-29', today), false, 'a day too old');
  assert.equal(isNew('2026-10-31', today), false, 'not released yet');
});

test('NEW: a month shorter than today clamps to its last day', () => {
  const today = new Date(2026, 2, 31, 12);
  assert.equal(isNew('2026-02-28', today), true);
  assert.equal(isNew('2026-02-27', today), false);
});

test('NEW: January reaches back into December of the previous year', () => {
  const today = new Date(2026, 0, 15, 12);
  assert.equal(isNew('2025-12-15', today), true);
  assert.equal(isNew('2025-12-14', today), false);
});

test('NEW: does not move with the time of day', () => {
  for (const now of [new Date(2026, 9, 30, 0, 1), new Date(2026, 9, 30, 23, 59)]) {
    assert.equal(isNew('2026-09-30', now), true);
    assert.equal(isNew('2026-09-29', now), false);
    assert.equal(isNew('2026-10-30', now), true);
  }
});

test('NEW: needs a date recorded to the day', () => {
  const today = new Date(2026, 9, 30, 12);
  assert.equal(isNew('2026-10-01', today), false, 'a 1st is a padded month');
  assert.equal(isNew(null, today), false, 'no date at all');
  assert.equal(SM.dataset.isNewRelease(null, today), false, 'no model at all');
});

test('NEW: a model that has not reached the market never qualifies', () => {
  const today = new Date(2026, 9, 30, 12);
  assert.equal(isNew('2026-10-15', today, { releaseStatus: 'cancelled' }), false);
  assert.equal(isNew('2026-10-15', today, { releaseStatus: 'coming_soon' }), false);
  assert.equal(isNew('2026-10-15', today, { releaseStatus: 'available' }), true);
});

test('NEW: a recently added model is not new unless it was recently released', () => {
  const today = new Date(2026, 9, 30, 12);
  const dated = SM.db.models.filter(m => SM.dataset.isNewRelease(m, today));
  dated.forEach(m => assert.ok(m.releaseDateIso >= '2026-09-30', m.id));
});

/* -------------------------------------------------------------- release date */
test('a date is printed to the precision the source has', () => {
  const at = id => SM.dataset.releaseLabel(SM.db.modelById[id]);
  assert.equal(at('apple-iphone-se-2022'), '18 March 2022');
  assert.equal(at('apple-ipad-2-wi-fi'), 'March 2011', 'a padded 1st loses its day');
  assert.equal(at('infinix-hot-6'), '2018', 'the source only has a year');
  assert.equal(at('oppo-f27-pro'), null, 'cancelled, no date recorded');
});

test('an expected release is not reported as a release', () => {
  assert.equal(SM.dataset.releaseLabel(SM.db.modelById['hmd-ivalo-xe']), null);
  assert.equal(SM.db.modelById['hmd-ivalo-xe'].releaseYear, 2026, 'still filters and sorts by year');
});

/* --------------------------------------------------------------------- image */
test('a model keeps the image URL the export gave it', () => {
  const imgAt = col('img'), idAt = col('id');
  const kept = BUNDLE.models.filter(r => r[imgAt] && !/\/smartphone\.jpg$/.test(r[imgAt]) && r[idAt] !== 'realme-x9-pro');
  assert.ok(kept.length > 4000);
  kept.forEach(r => assert.equal(SM.db.modelById[r[idAt]].image, r[imgAt], r[idAt]));
});

test('the generic silhouette is not a photograph of anything', () => {
  const imgAt = col('img'), idAt = col('id');
  const generic = BUNDLE.models.filter(r => /\/smartphone\.jpg$/.test(r[imgAt] || ''));
  assert.ok(generic.length > 0, 'the export still carries it, so this test still means something');
  generic.forEach(r => assert.equal(SM.db.modelById[r[idAt]].image, null, r[idAt]));
});

test('no model shows a photograph of another brand', () => {
  assert.equal(SM.db.modelById['realme-x9-pro'].image, null);
  const brandsByUrl = {};
  SM.db.models.filter(m => m.image).forEach(m => {
    (brandsByUrl[m.image] = brandsByUrl[m.image] || new Set()).add(m.brandId);
  });
  Object.keys(brandsByUrl).forEach(url => assert.equal(brandsByUrl[url].size, 1, url));
});

/* -------------------------------------------------------------------- search */
const search = (q, brandId) =>
  SM.api.listModels({ q, brandId, page: 1, pageSize: 9999, instant: true }).then(r => r.items.map(m => m.id));

test('search finds a model written any of the ways a person writes it', async () => {
  for (const q of ['redmi note 13', 'Note 13 Redmi', 'redminote13', 'REDMI  NOTE 13']) {
    const ids = await search(q);
    assert.ok(ids.includes('xiaomi-redmi-note-13'), q);
  }
});

test('search stays inside the selected brand', async () => {
  const everyone = await search('pro');
  const apple = await search('pro', 'apple');
  assert.ok(apple.length > 0 && apple.length < everyone.length);
  apple.forEach(id => assert.equal(SM.db.modelById[id].brandId, 'apple', id));
});

test('no brand or search returns every model exactly once', async () => {
  const ids = await search('');
  assert.equal(ids.length, BUNDLE.models.length);
  assert.equal(new Set(ids).size, ids.length);
});

/* ----------------------------------------------------------------- model page */
test('getModel answers for every model', async () => {
  /* From 20 September 2026 this threw for all of them: the variable holding the
     group ids had been removed and its one use had not, so every /model/<id>
     page ended on "Could not load the catalogue". */
  await Promise.all(SM.db.models.map(m => SM.api.getModel(m.id).then(r => assert.equal(r.model.id, m.id))));
});
