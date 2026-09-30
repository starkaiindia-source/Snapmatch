/* ============================================================================
   api/_lib/instagram-taxonomy.test.js
   ----------------------------------------------------------------------------
   The taxonomy layer against the REAL catalogue (assets/search-index.json).

   Every expectation below is about the catalogue that ships, not a fixture:
   "Samsung A15" must find the record that exists, and "XYZ 999" must find
   nothing, because that is what the review queue will show an admin.

   Similar names are NOT compatibility. These tests only ever ask "which
   record is this text?" — whether two records take the same part is decided
   by source evidence and approval, never here.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const t = require('../_services/taxonomy-service');

function m(text, opts) { return t.matchModel(text, opts || {}); }

/* ----------------------------------------------------- 4. normalisation */

test('normalisation keeps what distinguishes handsets and drops only notation', () => {
  assert.deepEqual(t.basicTokens('Redmi Note 13 Pro+'), ['redmi', 'note', '13', 'pro', 'plus']);
  assert.deepEqual(t.basicTokens('One Plus Nord CE 3'), ['oneplus', 'nord', 'ce', '3']);
  assert.deepEqual(t.basicTokens('i-Phone 13'), ['iphone', '13']);
  assert.deepEqual(t.basicTokens('A15 5 G'), ['a15', '5g']);
  assert.deepEqual(t.basicTokens('Réalme  C65'), ['realme', 'c65']);
  const a = t.analyse(t.basicTokens('vivo Y27 (2014) 4G'));
  assert.deepEqual(a.base, ['vivo', 'y27']);
  assert.equal(a.network, '4g');
  assert.equal(a.year, '2014');
  assert.equal(t.analyse(['tecno', 'pop', '5', 'lte']).network, '4g', 'LTE and 4G are one network');
});

/* ------------------------------------------------------ 5. exact matching */

test('the record\'s own name matches exactly', () => {
  [
    ['Samsung Galaxy A15', 'samsung-galaxy-a15'],
    ['Samsung Galaxy A15 5G', 'samsung-galaxy-a15-5g'],
    ['Xiaomi Redmi 13C', 'xiaomi-redmi-13c'],
    ['vivo Y27', 'vivo-y27'],
    ['Realme C65', 'realme-c65']
  ].forEach(([text, id]) => {
    const r = m(text);
    assert.equal(r.status, 'matched', text);
    assert.equal(r.modelId, id, text);
    assert.equal(r.method, 'exact', text);
    assert.equal(r.strength, 'strong', text);
    assert.equal(r.requiresVariantConfirmation, false, text);
  });
});

test('the brief\'s examples resolve to the records that already exist', () => {
  /* "Samsung A15" -> the existing "Samsung Galaxy A15", never a new model */
  let r = m('Samsung A15');
  assert.equal(r.modelId, 'samsung-galaxy-a15');
  assert.equal(r.method, 'market_term');

  /* "Redmi 13C" -> the existing "Xiaomi Redmi 13C" */
  r = m('Redmi 13C');
  assert.equal(r.modelId, 'xiaomi-redmi-13c');
  assert.equal(r.method, 'official_name');

  /* "POCO C65" -> the existing "Xiaomi Poco C65" — not the Realme C65 */
  r = m('POCO C65');
  assert.equal(r.modelId, 'xiaomi-poco-c65');
});

/* ------------------------------------------------------ 6. alias matching */

test('an alias from /aliases resolves to its canonical record', () => {
  const aliases = new Map([['samsung-sm-a155f', { canonicalId: 'samsung-galaxy-a15', confidence: 'verified' }]]);
  const r = m('Samsung SM-A155F', { aliasLookup: k => aliases.get(k) || null });
  assert.equal(r.status, 'matched');
  assert.equal(r.modelId, 'samsung-galaxy-a15');
  assert.equal(r.method, 'alias');
  assert.equal(r.strength, 'strong');
});

test('an unverified alias is a good match, not a strong one; an alias to a missing record is ignored', () => {
  const aliases = new Map([
    ['samsung-sm-a155f', { canonicalId: 'samsung-galaxy-a15', confidence: 'unverified' }],
    ['samsung-sm-x999', { canonicalId: 'samsung-galaxy-does-not-exist' }]
  ]);
  const lookup = k => aliases.get(k) || null;
  assert.equal(m('Samsung SM-A155F', { aliasLookup: lookup }).strength, 'good');
  assert.notEqual(m('Samsung SM-X999', { aliasLookup: lookup }).status, 'matched',
    'an alias can never introduce a model the catalogue does not hold');
});

/* ---------------------------------------------------- 7. synonym matching */

test('notation variants match as synonyms', () => {
  let r = m('Apple iPhone SE 2nd gen');
  assert.equal(r.modelId, 'apple-iphone-se-2020');
  assert.equal(r.method, 'synonym');
  r = m('Tecno Pop 5 4G');
  assert.equal(r.modelId, 'tecno-pop-5-lte', 'the record says LTE; 4G is the same network, stated by the record itself');
  assert.equal(r.requiresVariantConfirmation, false);
});

test('keyword order and spacing variants still find the record', () => {
  assert.equal(m('A15 Galaxy Samsung').modelId, 'samsung-galaxy-a15');
  assert.equal(m('A15 Galaxy Samsung').method, 'keyword');
  assert.equal(m('Redmi13C').modelId, 'xiaomi-redmi-13c');
  assert.equal(m('Redmi13C').method, 'alternate_spelling');
});

/* ------------------------------------------------------ 8. fuzzy matching */

test('fuzzy matching repairs WORDS and never a model number', () => {
  let r = m('Samsang Galexy A15');
  assert.equal(r.modelId, 'samsung-galaxy-a15');
  assert.equal(r.method, 'misspelling');

  r = m('Samsung Galaksy A15');
  assert.equal(r.modelId, 'samsung-galaxy-a15');
  assert.equal(r.method, 'similarity');
  assert.equal(r.strength, 'weak', 'a fuzzy match can never reach "ready for approval"');

  /* One edit apart, different phones. */
  assert.equal(m('Samsung Galaxy A16').modelId, 'samsung-galaxy-a16', 'A16 is its own record');
  assert.notEqual(m('Samsung A15s').modelId, 'samsung-galaxy-a15', 'A15s must never collapse to A15');
  assert.notEqual(m('Samsung Galaxy A51').modelId, 'samsung-galaxy-a15', 'digits are never transposed');
});

/* --------------------------------------------------- 9. unknown models */

test('an unknown model is unmatched — never created, never guessed', () => {
  ['XYZ 999', 'Zebraphone 9000', 'Samsung Galaxy Z999 Ultra'].forEach(text => {
    const r = m(text);
    assert.equal(r.status, 'unmatched', text);
    assert.equal(r.modelId, null, text);
  });
  const before = t.taxonomy().entries.length;
  m('XYZ 999');
  assert.equal(t.taxonomy().entries.length, before, 'matching never adds to the catalogue');
});

/* ------------------------------------------------- variants: 4G / 5G / year */

test('4G and 5G are never merged, and a network is never inferred from a sibling', () => {
  const a15 = m('Samsung A15');
  const a15g5 = m('Samsung A15 5G');
  assert.notEqual(a15.modelId, a15g5.modelId, 'A15 and A15 5G stay two records');
  assert.equal(a15g5.modelId, 'samsung-galaxy-a15-5g');

  /* "A15 4G": the record's NAME has no network. It is proposed, flagged for
     confirmation, and capped below "strong" — because the only reason to
     think it is the 4G phone would be that a 5G sibling exists. */
  const a15g4 = m('Samsung A15 4G');
  assert.equal(a15g4.modelId, 'samsung-galaxy-a15');
  assert.equal(a15g4.requiresVariantConfirmation, true);
  assert.equal(a15g4.strength, 'good');
  assert.ok(a15g4.alternatives.some(x => x.modelId === 'samsung-galaxy-a15-5g' && /5G/.test(x.note)),
    'the 5G record is listed, and why it was not chosen');

  /* The text says 5G and no 5G record exists: not a match to the 4G record. */
  const oppo = m('Oppo A15 5G');
  assert.equal(oppo.status, 'ambiguous');
  assert.equal(oppo.modelId, null);
});

test('"Vivo Y27 4G" picks the existing Y27 record and lists the 2014 Y27 and the Y27 5G as alternatives', () => {
  const r = m('Vivo Y27 4G');
  assert.equal(r.modelId, 'vivo-y27');
  assert.equal(r.requiresVariantConfirmation, true);
  const alt = r.alternatives.map(a => a.modelId);
  assert.ok(alt.indexOf('vivo-y27-2014') > -1);
  assert.ok(alt.indexOf('vivo-y27-5g') > -1);
});

test('a bare model number with no brand is ambiguous when two brands use it', () => {
  const c65 = m('C65');
  assert.equal(c65.status, 'ambiguous');
  const ids = c65.alternatives.map(a => a.modelId);
  assert.ok(ids.indexOf('realme-c65') > -1 && ids.indexOf('xiaomi-poco-c65') > -1, 'Realme C65 and POCO C65 are different phones');
  assert.equal(m('A15').status, 'ambiguous', 'Oppo A15 and Samsung Galaxy A15');
});

test('a brand stated elsewhere in the same content narrows a bare reference, and says so', () => {
  const r = m('A15 5G', { brandHint: 'samsung' });
  assert.equal(r.modelId, 'samsung-galaxy-a15-5g');
  assert.ok(r.notes.some(n => /elsewhere/.test(n)));
  assert.equal(m('13 Pro', { brandHint: 'apple' }).modelId, 'apple-iphone-13-pro');
});

/* -------------------------------------------------- 10. category matching */

test('categories map to the catalogue\'s own eight and nothing else', () => {
  [
    ['Samsung A15 Tempered Glass', 'screen-guards', 'synonym'],
    ['A15 9D glass', 'screen-guards', 'synonym'],
    ['iPhone 13 back cover', 'back-cover', 'exact'],
    ['Redmi 13C combo display', 'combo-display', 'exact'],
    ['Redmi 13C folder', 'combo-display', 'synonym'],
    ['Y27 battery', 'battery', 'exact'],
    ['A15 middle frame', 'middle-frame', 'exact'],
    ['Redmi 13C charging board', 'cc-board', 'synonym'],
    ['power volume flex A15', 'button-flex', 'synonym'],
    ['A15 sim tray', 'sim-tray', 'exact']
  ].forEach(([text, id, method]) => {
    const r = t.resolveCategory(text);
    assert.equal(r.categoryId, id, text);
    assert.equal(r.method, method, text);
  });
});

test('a product with no catalogue category is reported, never mapped to the nearest thing', () => {
  ['A15 camera lens protector', 'A15 back glass', 'A15 battery door', 'Samsung 25W charger', 'A15 flip cover'].forEach(text => {
    const r = t.resolveCategory(text);
    assert.equal(r.categoryId, null, text);
    assert.ok(r.unmappedTerm, text);
  });
  assert.equal(t.isKnownCategory('camera-lens'), false, 'no category is ever created');
});

test('a single generic word maps only as a keyword, and two categories named equally is weak', () => {
  const glass = t.resolveCategory('A15 glass');
  assert.equal(glass.categoryId, 'screen-guards');
  assert.equal(glass.method, 'keyword');
  assert.equal(glass.strength, 'good');
  assert.equal(t.resolveCategory('A15 tempered glass and back cover').strength, 'weak');
});

test('every category spelling the site already knows resolves the same way here (drift guard)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'data', 'category-assets.js'), 'utf8');
  const block = /var ALIASES = (\{[\s\S]*?\n {2}\});/.exec(src);
  assert.ok(block, 'ALIASES block not found in src/data/category-assets.js');
  const ALIASES = vm.runInNewContext('(' + block[1] + ')');
  Object.keys(ALIASES).forEach(id => {
    ALIASES[id].filter(a => a.length > 2).forEach(alias => {
      assert.equal(t.resolveCategory(alias).categoryId, id, `"${alias}" should resolve to ${id}`);
    });
  });
});
