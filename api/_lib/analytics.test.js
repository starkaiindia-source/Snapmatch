/* ============================================================================
   api/_lib/analytics.test.js
   ----------------------------------------------------------------------------
   The event allowlist, the metadata filter and the PII redaction.

   /api/events is the one route an unauthenticated browser may write through,
   so these tests are the boundary. Every one of them is written from the
   attacker's side: what happens when the client sends something it should not
   be able to send.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isKnownEventType, sanitiseMetadata, buildEvent, normaliseSource, redact,
  EVENT_TYPE_LIST, METADATA_SCHEMA, dayKey
} = require('../_schema/analytics-event');

const NOW = Date.UTC(2026, 5, 1, 14, 30);

test('only allowlisted event types are recognised', () => {
  assert.equal(isKnownEventType('model_search'), true);
  assert.equal(isKnownEventType('payment_completed'), true);

  ['', null, undefined, 'anything', 'MODEL_SEARCH', '__proto__', 'constructor',
   'toString', 'hasOwnProperty'].forEach(value => {
    assert.equal(isKnownEventType(value), false, `${String(value)} must be rejected`);
  });
});

test('every declared event type has a metadata schema', () => {
  /* An event type with no schema would silently drop all its metadata, which
     looks like a working event and produces an empty column in every report. */
  EVENT_TYPE_LIST.forEach(type => {
    assert.ok(METADATA_SCHEMA[type], `${type} has no metadata schema`);
  });
});

test('a field the event type did not declare is dropped', () => {
  const clean = sanitiseMetadata('model_opened', {
    modelId: 'realme-5',
    brandId: 'realme',
    creditCard: '4111111111111111',
    internalNote: 'anything at all',
    __proto__: { polluted: true }
  });
  assert.deepEqual(Object.keys(clean).sort(), ['brandId', 'modelId', 'source'].filter(
    k => clean[k] !== undefined).sort());
  assert.equal(clean.creditCard, undefined);
  assert.equal(clean.internalNote, undefined);
  assert.equal(clean.polluted, undefined);
});

test('an email in a search term is redacted', () => {
  const clean = sanitiseMetadata('model_search', {
    searchQuery: 'contact me at shop@example.com',
    searchType: 'model',
    matchedResultCount: 3
  });
  assert.equal(clean.searchQuery.includes('@example.com'), false);
  assert.equal(clean.searchQuery, 'contact me at [email]');
});

test('a phone number in a search term is redacted', () => {
  ['9876543210', '+91 98765 43210', '098765-43210'].forEach(number => {
    const clean = sanitiseMetadata('search_zero_result', {
      searchQuery: 'my number ' + number, searchType: 'model'
    });
    assert.equal(clean.searchQuery.includes('98765'), false,
      `${number} survived redaction as ${clean.searchQuery}`);
  });
});

test('a long card-shaped number is redacted', () => {
  assert.equal(redact('4111111111111111').includes('4111'), false);
});

test('redaction leaves an ordinary model name alone', () => {
  /* The redaction is deliberately blunt, but it must not eat the data the
     whole feature exists to collect. */
  ['Realme 5', 'Samsung Galaxy M21', 'iPhone 14 Pro Max', 'Redmi Note 13 5G']
    .forEach(name => assert.equal(redact(name), name));
});

test('a value of the wrong type is dropped, not coerced', () => {
  /* Coercing undefined into "undefined" is how a top-search-terms list ends up
     with "undefined" as its most popular entry. */
  const clean = sanitiseMetadata('model_search', {
    searchQuery: { toString: () => 'evil' },
    searchType: 'model',
    matchedResultCount: 'not a number'
  });
  assert.equal(clean.searchQuery, undefined);
  assert.equal(clean.matchedResultCount, undefined);
  assert.equal(clean.searchType, 'model');
});

test('an enum only accepts its declared values', () => {
  assert.equal(sanitiseMetadata('plan_selected', { planId: 'monthly' }).planId, 'monthly');
  assert.equal(sanitiseMetadata('plan_selected', { planId: 'free_forever' }).planId, undefined);
  assert.equal(sanitiseMetadata('model_search', { searchType: 'sql' }).searchType, undefined);
});

test('an integer is clamped rather than rejected', () => {
  assert.equal(sanitiseMetadata('model_search', { matchedResultCount: -5 }).matchedResultCount, 0);
  assert.equal(sanitiseMetadata('model_search', { matchedResultCount: 1e12 }).matchedResultCount, 100000);
  assert.equal(sanitiseMetadata('model_search', { matchedResultCount: 12.7 }).matchedResultCount, 13);
});

test('a long string is capped', () => {
  const clean = sanitiseMetadata('model_search', { searchQuery: 'x'.repeat(5000) });
  assert.equal(clean.searchQuery.length, 120);
});

test('metadata is never null, so a reader never has to check', () => {
  assert.deepEqual(sanitiseMetadata('logout', undefined), {});
  assert.deepEqual(sanitiseMetadata('logout', null), {});
  assert.deepEqual(sanitiseMetadata('logout', 'a string'), {});
  assert.deepEqual(sanitiseMetadata('unknown_type', { a: 1 }), {});
});

/* --------------------------------------------------------------- the event */

test('the timestamp is the server\'s, whatever the client sent', () => {
  const doc = buildEvent({
    userId: 'uid1', sessionId: 'sess1', eventType: 'login',
    source: 'web', metadata: { provider: 'google', timestamp: 0 }, now: NOW
  });
  assert.equal(doc.timestamp, NOW);
  assert.equal(doc.day, '2026-06-01');
});

test('an unrecognised source becomes web rather than being stored', () => {
  assert.equal(normaliseSource('server'), 'server');
  assert.equal(normaliseSource('admin'), 'admin');
  assert.equal(normaliseSource('anything-else'), 'web');
  assert.equal(normaliseSource(undefined), 'web');
});

test('an anonymous event has an explicit null user, not a missing key', () => {
  const doc = buildEvent({ userId: null, sessionId: null, eventType: 'first_visit',
                           source: 'web', metadata: {}, now: NOW });
  assert.equal(doc.userId, null);
  assert.equal(doc.sessionId, null);
  assert.ok('userId' in doc);
});

test('the day key is UTC, so two reports cannot disagree by a day', () => {
  assert.equal(dayKey(Date.UTC(2026, 0, 1, 23, 59, 59)), '2026-01-01');
  assert.equal(dayKey(Date.UTC(2026, 0, 2, 0, 0, 1)), '2026-01-02');
});

test('a referrer field carries a host, and the schema has no field for a full URL', () => {
  /* A full referrer URL can carry a search term or a token from the site
     someone came from. The schema declares referrerHost and nothing else, so
     there is no field for one to arrive in. */
  assert.ok(METADATA_SCHEMA.first_visit.referrerHost);
  assert.equal(METADATA_SCHEMA.first_visit.referrer, undefined);
  assert.equal(METADATA_SCHEMA.first_visit.referrerUrl, undefined);
});

test('no event type declares a field that would carry contact details', () => {
  /* A structural check rather than a behavioural one: the way PII gets into an
     analytics table is somebody adding a convenient field, and this fails the
     moment they do. */
  const forbidden = ['email', 'phone', 'mobile', 'mobileNumber', 'address',
                     'name', 'proprietorName', 'password', 'token', 'ip'];
  Object.entries(METADATA_SCHEMA).forEach(([type, schema]) => {
    Object.keys(schema).forEach(field => {
      assert.equal(forbidden.includes(field), false,
        `${type} declares a field named "${field}"`);
    });
  });
});
