/* ============================================================================
   api/_lib/missing-models.test.js
   ----------------------------------------------------------------------------
   Model-name normalisation and the review workflow.

   Two things are being protected here:

     1. Aggregation. "Realme 5", "realme5" and "REALME  5" must land on ONE
        record, or the queue is a list of spellings rather than a list of
        handsets.

     2. Separation. "Realme 5" and "Realme 5i" must NOT. They are different
        phones with different parts, and merging them puts the wrong glass in
        an order — a failure nobody notices until a customer complains.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normaliseModelName, displayModelName, isRecordableQuery,
  canTransition, buildRequest, STATUSES, ALLOWED_TRANSITIONS
} = require('../_schema/missing-model-request');

test('the ways people type one handset collapse to one key', () => {
  const key = normaliseModelName('Realme 5');
  ['realme5', 'REALME  5', 'Realme-5', ' realme 5 ', 'Realme_5', 'realme(5)', 'Réalme 5']
    .forEach(variant => {
      assert.equal(normaliseModelName(variant), key, `${variant} should match Realme 5`);
    });
});

test('different handsets stay different', () => {
  /* The expensive mistake. A normaliser that stripped the trailing letter
     would merge these, and the merge is invisible until someone orders parts. */
  const pairs = [
    ['Realme 5', 'Realme 5i'],
    ['Realme 5', 'Realme 5s'],
    ['Galaxy A10', 'Galaxy A10s'],
    ['Redmi Note 13', 'Redmi Note 13 Pro'],
    ['iPhone 14', 'iPhone 14 Plus']
  ];
  pairs.forEach(([a, b]) => {
    assert.notEqual(normaliseModelName(a), normaliseModelName(b), `${a} must not equal ${b}`);
  });
});

test('a normalised key is safe as a Firestore document id', () => {
  /* The key becomes the document id, so anything that could climb out of a
     path has to be gone. */
  ['../../../etc/passwd', 'a/b/c', '.', '..', '__proto__', 'x'.repeat(500)]
    .forEach(nasty => {
      const key = normaliseModelName(nasty);
      assert.equal(key.includes('/'), false, `${nasty} produced a slash`);
      assert.equal(key.includes('.'), false, `${nasty} produced a dot`);
      assert.ok(key.length <= 80);
      assert.ok(/^[a-z0-9]*$/.test(key), `${nasty} produced ${key}`);
    });
});

test('a keystroke is not a model request', () => {
  /* Noise in the queue is noise an admin has to read past to find the real
     requests, so the bar is low but it exists. */
  ['a', 'ab', '  ', '???', '5', '12345'].forEach(noise => {
    assert.equal(isRecordableQuery(noise), false, `"${noise}" should not be recorded`);
  });
  ['realme 5', 'Nokia 3310', 'iPhone'].forEach(real => {
    assert.equal(isRecordableQuery(real), true, `"${real}" should be recorded`);
  });
});

test('the display name keeps what the person typed', () => {
  /* The key is for grouping; a human has to read the original. */
  assert.equal(displayModelName('  Realme   5  '), 'Realme 5');
  assert.equal(displayModelName('REALME 5i'), 'REALME 5i');
});

/* ---------------------------------------------------------------- workflow */

test('published is reachable only from approved', () => {
  STATUSES.forEach(from => {
    const legal = canTransition(from, 'published');
    assert.equal(legal, from === 'approved',
      `${from} -> published should be ${from === 'approved'}`);
  });
});

test('a new request cannot jump straight to published', () => {
  assert.equal(canTransition('new', 'published'), false);
  assert.equal(canTransition('under_review', 'published'), false);
  assert.equal(canTransition('draft_found', 'published'), false);
});

test('published is final', () => {
  assert.deepEqual(ALLOWED_TRANSITIONS.published, []);
  STATUSES.forEach(to => {
    assert.equal(canTransition('published', to), false, `published -> ${to} must be refused`);
  });
});

test('an unknown status is never a legal destination', () => {
  ['', null, undefined, 'live', 'PUBLISHED', 'approved ', '__proto__']
    .forEach(value => assert.equal(canTransition('approved', value), false));
});

test('a request that was dismissed can be reopened', () => {
  /* The first judgement may have been wrong, and repeated demand is the
     evidence that says so. */
  assert.equal(canTransition('not_a_valid_model', 'new'), true);
  assert.equal(canTransition('duplicate', 'new'), true);
});

test('every transition target is a real status', () => {
  Object.entries(ALLOWED_TRANSITIONS).forEach(([from, targets]) => {
    targets.forEach(to => {
      assert.ok(STATUSES.includes(to), `${from} -> ${to} names a status that does not exist`);
    });
  });
});

/* -------------------------------------------------------------- the record */

test('a new request starts at new, with a count of one', () => {
  const doc = buildRequest({ raw: 'Realme 5', now: 1000, source: 'search', userId: 'uid1' });
  assert.equal(doc.status, 'new');
  assert.equal(doc.requestCount, 1);
  assert.equal(doc.normalisedName, 'realme5');
  assert.equal(doc.requestedName, 'Realme 5');
  assert.equal(doc.firstRequestedAt, 1000);
  assert.equal(doc.lastRequestedAt, 1000);
  assert.deepEqual(doc.searchVariants, ['Realme 5']);
  assert.equal(doc.signedInRequesters, 1);
});

test('an anonymous request is recorded without a requester', () => {
  const doc = buildRequest({ raw: 'Realme 5', now: 1000, source: 'chatbot', userId: null });
  assert.equal(doc.signedInRequesters, 0);
  assert.equal(doc.lastRequestedByUid, null);
});

test('a new request has no candidate data and no publication', () => {
  /* Everything the AI or an admin might later fill in starts null, so an
     unreviewed row cannot be mistaken for a researched one. */
  const doc = buildRequest({ raw: 'Realme 5', now: 1000, source: 'search', userId: null });
  assert.equal(doc.candidateBrandId, null);
  assert.equal(doc.candidateModelName, null);
  assert.equal(doc.publishedModelId, null);
  assert.equal(doc.reviewedByUid, null);
  assert.equal(doc.reviewedAt, null);
});
