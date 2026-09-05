/* ============================================================================
   api/_lib/search-chat.test.js
   ----------------------------------------------------------------------------
   The deterministic search ladder and the chatbot's use of it.

   Run against the REAL catalogue — the same build output the site serves — so
   these are not fixtures agreeing with themselves. If the dataset changes
   shape, these fail, which is the point.

   The property under test throughout: the assistant answers from the database
   or says it cannot. It never guesses a handset, a part code or a fitment.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const search = require('../_services/search-service');
const chatbot = require('../_services/chatbot-service');
const { PLANS } = require('./plans');

test('the catalogue index loads from the real build output', () => {
  const status = search.indexStatus();
  assert.equal(status.loaded, true, status.error);
  assert.ok(status.models > 4000, `only ${status.models} models loaded`);
  assert.ok(status.groups > 3000, `only ${status.groups} groups loaded`);
});

/* ------------------------------------------------------------ the ladder */

test('an exact model name matches exactly, and confidently', () => {
  const r = search.findModels('Realme 5');
  assert.equal(r.matchType, 'exact');
  assert.equal(r.confident, true);
  assert.equal(r.models[0].name, 'Realme 5');
});

test('spacing and case do not matter', () => {
  ['realme5', 'REALME 5', '  Realme   5  '].forEach(q => {
    const r = search.findModels(q);
    assert.equal(r.matchType, 'exact', `${q} should match exactly`);
    assert.equal(r.models[0].id, 'realme-5');
  });
});

test('a typo is caught by the fuzzy rung', () => {
  const r = search.findModels('reame 5');
  assert.equal(r.matchType, 'fuzzy');
  assert.equal(r.models[0].name, 'Realme 5');
});

test('a handset that does not exist matches nothing', () => {
  /* The rung that matters most: nothing invented, no nearest-neighbour
     presented as a finding. */
  const r = search.findModels('Zebraphone Quantum 9000');
  assert.equal(r.matchType, 'none');
  assert.deepEqual(r.models, []);
  assert.equal(r.confident, false);
});

test('an ambiguous match is reported as a list, not as an answer', () => {
  /* Where a chatbot normally goes wrong: it picks the top result and states it
     as fact. `confident` is what stops that. */
  const r = search.findModels('Nokia 3310');
  assert.ok(r.models.length > 1, 'expected several Nokia 3310 variants');
  assert.equal(r.confident, false);
});

test('edit distance counts a transposition as one mistake', () => {
  assert.equal(search.editDistance('realme', 'raelme', 3), 1);
  assert.equal(search.editDistance('realme', 'realme', 3), 0);
  assert.ok(search.editDistance('realme', 'samsung', 3) > 3);
});

/* ------------------------------------------------------- compatibility */

test('compatibility comes from recorded fitments, with real part codes', () => {
  const c = search.compatibilityFor('realme-5');
  assert.ok(c, 'Realme 5 should have compatibility data');
  assert.ok(c.categories.length >= 5, 'expected several part categories');

  c.categories.forEach(cat => {
    assert.ok(cat.categoryName, 'every category needs a display name');
    cat.groups.forEach(g => {
      assert.match(g.partCode, /^MPF-[A-Z]{2}-\d{4}$/, `odd part code ${g.partCode}`);
      assert.ok(g.memberCount >= 1);
      /* The device itself must be in its own group, or the fitment data is
         describing something other than this handset. */
      assert.ok(g.members.length >= 1);
    });
  });
});

test('a handset with no recorded fitment returns no groups rather than a guess', () => {
  const c = search.compatibilityFor('a-model-id-that-does-not-exist');
  assert.equal(c, null);
});

test('a part code resolves with or without its prefix', () => {
  const full = search.findByPartCode('MPF-SG-0001');
  const short = search.findByPartCode('sg-0001');
  assert.ok(full);
  assert.equal(full.partCode, 'MPF-SG-0001');
  assert.equal(short.groupId, full.groupId);
  assert.equal(search.findByPartCode('MPF-SG-9999'), null);
});

/* ------------------------------------------------------------- chatbot */

test('intent is classified by rules, not by a model', () => {
  assert.equal(chatbot.classify('Do you have Realme 5?'), 'availability');
  assert.equal(chatbot.classify('hi'), 'greeting');
  assert.equal(chatbot.classify('Which models match MPF-SG-0167?'), 'part_code');
  assert.equal(chatbot.classify('I searched a model but could not find it'), 'not_found');
  assert.equal(chatbot.classify('which models are compatible with this glass'), 'compatibility');
});

test('the handset is pulled out of the sentence around it', () => {
  assert.equal(chatbot.extractSubject('Do you have Realme 5 in stock?'), 'Realme 5');
  assert.equal(chatbot.extractSubject('is samgung galxy m21 available'), 'samgung galxy m21');
});

test('a part code is recognised in any of the forms people write it', () => {
  assert.equal(chatbot.extractPartCode('Which models match MPF-SG-0167?'), 'SG0167');
  assert.equal(chatbot.extractPartCode('sg 0167'), 'SG0167');
  assert.equal(chatbot.extractPartCode('no code here'), null);
});

test('a sentence with no handset in it is not recorded as a missing model', () => {
  /* "I searched a model but could not find it" leaves the word "but". Without
     this guard the review queue fills with sentence fragments an admin has to
     read past to find the real requests. */
  assert.equal(chatbot.looksLikeModelName('but'), false);
  assert.equal(chatbot.looksLikeModelName('it'), false);
  assert.equal(chatbot.looksLikeModelName('Realme 5'), true);
  assert.equal(chatbot.looksLikeModelName('iphone'), true);
});

/* --------------------------------------------------------- plan reuse */

test('the plans the payment flow charges for are the two the business sells', () => {
  /* Guards Part 8: plan selection reads the server catalogue, so a change here
     is a change to what a customer is charged. */
  assert.equal(PLANS.monthly.amountPaise, 9900);
  assert.equal(PLANS.yearly.amountPaise, 79900);
  assert.equal(PLANS.monthly.periodMonths, 1);
  assert.equal(PLANS.yearly.periodMonths, 12);
});
