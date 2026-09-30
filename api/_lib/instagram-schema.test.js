/* ============================================================================
   api/_lib/instagram-schema.test.js
   ----------------------------------------------------------------------------
   URL validation, content keys and hashes, relationship keys, the confidence
   rules and the review sections — the pure half of the Instagram importer.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../_schema/instagram');
const { fetchAllowed } = require('../../backend/sources');

/* ------------------------------------------------------ 1. URL validation */

test('profile URLs are accepted in every shape a person pastes', () => {
  [
    'https://www.instagram.com/mobile_parts_hub/',
    'https://instagram.com/mobile_parts_hub',
    'instagram.com/mobile_parts_hub/',
    'http://m.instagram.com/Mobile_Parts_Hub/?igsh=abc123&utm_source=qr',
    'https://www.instagram.com/mobile_parts_hub/reels/',
    '@mobile_parts_hub'
  ].forEach(url => {
    const r = S.parseInstagramUrl(url);
    assert.equal(r.ok, true, `${url}: ${r.reason}`);
    assert.equal(r.kind, 'profile');
    assert.equal(r.username, 'mobile_parts_hub');
    assert.equal(r.canonicalUrl, 'https://www.instagram.com/mobile_parts_hub/');
  });
});

test('post, reel and tv URLs are accepted, with or without the username segment', () => {
  const cases = [
    ['https://www.instagram.com/p/C1a2B3c4D5e/', 'p', null],
    ['https://www.instagram.com/reel/C1a2B3c4D5e/?igsh=xyz', 'reel', null],
    ['https://www.instagram.com/reels/C1a2B3c4D5e/', 'reel', null],
    ['https://www.instagram.com/tv/C1a2B3c4D5e', 'tv', null],
    ['https://www.instagram.com/mobile_parts_hub/p/C1a2B3c4D5e/', 'p', 'mobile_parts_hub']
  ];
  cases.forEach(([url, path, username]) => {
    const r = S.parseInstagramUrl(url);
    assert.equal(r.ok, true, `${url}: ${r.reason}`);
    assert.equal(r.kind, 'post');
    assert.equal(r.shortcode, 'C1a2B3c4D5e');
    assert.equal(r.mediaPath, path);
    assert.equal(r.username, username);
  });
});

test('anything that is not an Instagram profile or post is refused with a reason', () => {
  [
    ['', /Enter/],
    ['https://instagram.com.evil.example/mobile_parts_hub', /not instagram\.com/],
    ['https://evil.example/instagram.com/mobile_parts_hub', /not instagram\.com/],
    ['https://www.facebook.com/mobile_parts_hub', /not instagram\.com/],
    ['javascript:alert(1)', /(not a valid URL|http)/],
    ['ftp://instagram.com/x', /http/],
    ['https://user:pass@instagram.com/mobile_parts_hub', /credentials/],
    ['https://www.instagram.com/stories/mobile_parts_hub/123/', /Stories/],
    ['https://www.instagram.com/explore/tags/temperedglass/', /Hashtag/],
    ['https://www.instagram.com/accounts/login/', /Instagram page/],
    ['https://www.instagram.com/p/', /no valid post code/],
    ['https://www.instagram.com/bad..name/', /not a valid Instagram username/],
    ['https://www.instagram.com/.leadingdot/', /not a valid Instagram username/],
    ['https://www.instagram.com/' + 'a'.repeat(31) + '/', /not a valid Instagram username/],
    ['https://www.instagram.com/mobile_parts_hub/followers/', /profile URL itself/]
  ].forEach(([url, reason]) => {
    const r = S.parseInstagramUrl(url);
    assert.equal(r.ok, false, `${url} should be refused`);
    assert.match(r.reason, reason, `${url}: ${r.reason}`);
  });
});

test('instagram.com itself is never fetched — only the Graph API is an allowed source', () => {
  assert.throws(() => fetchAllowed('instagram-web', 'https://www.instagram.com/mobile_parts_hub/'), /refusing to fetch/);
  assert.equal(fetchAllowed('instagram-graph-api', 'https://graph.facebook.com/v25.0/me'), true);
  assert.throws(() => fetchAllowed('instagram-graph-api', 'https://www.instagram.com/api/v1/'), /is not on graph\.facebook\.com/);
});

/* ------------------------------------------------ 2. content deduplication */

test('the content signature ignores whitespace and rotating media URLs, and sees real changes', () => {
  const base = { caption: 'Samsung A15 glass\nCompatible: A15 5G', mediaType: 'IMAGE', mediaIds: ['1789'] };
  const same = { caption: '  Samsung A15 glass   Compatible: A15 5G ', mediaType: 'IMAGE', mediaIds: ['1789'] };
  assert.equal(S.contentSignature(base), S.contentSignature(same), 'reflowed whitespace is not a change');
  assert.notEqual(S.contentSignature(base), S.contentSignature(Object.assign({}, base, { caption: base.caption + ' / A25 5G' })),
    'an edited caption IS a change');
  assert.notEqual(S.contentSignature({ caption: 'x', mediaType: 'CAROUSEL_ALBUM', mediaIds: ['1', '2', '3'] }),
    S.contentSignature({ caption: 'x', mediaType: 'CAROUSEL_ALBUM', mediaIds: ['1', '2'] }),
    'a removed carousel item IS a change');
  assert.equal(S.contentSignature({ caption: 'x', mediaType: 'CAROUSEL_ALBUM', mediaIds: ['2', '1'] }),
    S.contentSignature({ caption: 'x', mediaType: 'CAROUSEL_ALBUM', mediaIds: ['1', '2'] }), 'order of ids does not matter');
});

test('content keys and ids are deterministic and path-safe', () => {
  assert.equal(S.contentKeyFor({ mediaId: '17895695668004550' }), 'igm_17895695668004550');
  assert.equal(S.contentKeyFor({ mediaId: '../../x/y' }), 'igm_xy');
  assert.match(S.contentKeyFor({ manualHash: S.sha256('a') }), /^man_[0-9a-f]{32}$/);
  assert.equal(S.sourceKeyFor('Mobile_Parts_Hub'), 'ig_mobile_parts_hub');
  const a = S.candidateIdFor({ extractionId: 'igm_1__v1', kind: 'relationship', sourceText: 'Samsung A15', compatibleText: 'A15 5G', polarity: 'positive' });
  const b = S.candidateIdFor({ extractionId: 'igm_1__v1', kind: 'relationship', sourceText: 'samsung  a15', compatibleText: 'A15 5G', polarity: 'positive' });
  assert.equal(a, b, 'reprocessing one version cannot create a second candidate');
});

/* ------------------------------------------------- 12. relationship keys */

test('a relationship key is symmetric and includes the category and the kind', () => {
  const k1 = S.relKeyFor('screen-guards', 'samsung-galaxy-a15', 'samsung-galaxy-a15-5g');
  const k2 = S.relKeyFor('screen-guards', 'samsung-galaxy-a15-5g', 'samsung-galaxy-a15');
  assert.equal(k1, k2);
  assert.equal(k1, 'screen-guards__samsung-galaxy-a15__samsung-galaxy-a15-5g__same_part');
  assert.notEqual(k1, S.relKeyFor('battery', 'samsung-galaxy-a15', 'samsung-galaxy-a15-5g'), 'another category is another relationship');
  assert.equal(S.relKeyFor(null, 'a', 'b'), null, 'no category, no key');
  assert.equal(S.relKeyFor('battery', 'a', 'a'), null, 'a model is not compatible with itself');
});

/* --------------------------------------------------------- confidence */

const strong = { status: 'matched', modelId: 'x', method: 'exact', strength: 'strong' };

test('high confidence needs exact matches, a clear category, an explicit claim and strong evidence', () => {
  const c = S.evaluateConfidence({
    sourceMatch: strong, compatibleMatch: Object.assign({}, strong, { modelId: 'y' }),
    category: { categoryId: 'screen-guards', strength: 'strong' },
    compatibilityType: 'explicit', polarity: 'positive', evidence: { source: 'caption' }
  });
  assert.equal(c.band, 'high');
  assert.deepEqual(c.reasons, []);
});

test('each weakness lowers the band and is named', () => {
  const base = {
    sourceMatch: strong, compatibleMatch: strong,
    category: { categoryId: 'screen-guards', strength: 'strong' },
    compatibilityType: 'explicit', polarity: 'positive', evidence: { source: 'caption' }
  };
  const variant = S.evaluateConfidence(Object.assign({}, base, {
    compatibleMatch: Object.assign({}, strong, { requiresVariantConfirmation: true, variantNote: 'the text says 4G', strength: 'good' })
  }));
  assert.equal(variant.band, 'medium');
  assert.match(variant.reasons.join(' '), /4G/);

  assert.equal(S.evaluateConfidence(Object.assign({}, base, { compatibilityType: 'implied' })).band, 'low',
    'a listing is not a claim: "iPhone 13 / 13 Pro" never reaches medium');
  assert.equal(S.evaluateConfidence(Object.assign({}, base, { evidence: { source: 'ocr', confidence: 0.4 } })).band, 'low', 'poor OCR');
  assert.equal(S.evaluateConfidence(Object.assign({}, base, { evidence: { source: 'ocr', confidence: 0.95 } })).band, 'high', 'clean OCR');
  assert.equal(S.evaluateConfidence(Object.assign({}, base, { sourceMatch: Object.assign({}, strong, { method: 'similarity', strength: 'weak' }) })).band, 'low');
  assert.equal(S.evaluateConfidence(Object.assign({}, base, { category: null })).band, 'low');
});

test('AI can suggest but never certify', () => {
  const c = S.evaluateConfidence({
    sourceMatch: strong, compatibleMatch: strong, category: { categoryId: 'battery', strength: 'strong' },
    compatibilityType: 'explicit', polarity: 'positive', evidence: { source: 'caption' }, extractedByAi: true
  });
  assert.notEqual(c.band, 'high');
});

/* ---------------------------------------------------------- sections */

test('the review section follows the evidence, and precedence is fixed', () => {
  const ready = { kind: 'relationship', status: 'pending', polarity: 'positive', compatibilityType: 'explicit',
    categoryId: 'battery', sourceMatch: strong, compatibleMatch: strong, confidence: { band: 'high' } };
  assert.equal(S.reviewSectionFor(ready), 'ready');
  assert.equal(S.reviewSectionFor(Object.assign({}, ready, { confidence: { band: 'medium' } })), 'review');
  assert.equal(S.reviewSectionFor(Object.assign({}, ready, { compatibleMatch: { status: 'unmatched' } })), 'unmatched');
  assert.equal(S.reviewSectionFor(Object.assign({}, ready, { compatibleMatch: { status: 'ambiguous' } })), 'ambiguous');
  assert.equal(S.reviewSectionFor(Object.assign({}, ready, { conflict: { active: true } })), 'conflicts');
  assert.equal(S.reviewSectionFor(Object.assign({}, ready, { status: 'duplicate', conflict: { active: true } })), 'duplicates');
  assert.equal(S.reviewSectionFor(Object.assign({}, ready, { status: 'rejected' })), 'rejected');
  assert.equal(S.reviewSectionFor(Object.assign({}, ready, { status: 'approved' })), 'closed');
  assert.equal(S.reviewSectionFor(Object.assign({}, ready, { compatibleMatch: Object.assign({}, strong, { requiresVariantConfirmation: true }) })), 'review',
    'a high band with an unconfirmed variant is never "ready"');
  assert.equal(S.reviewSectionFor(Object.assign({}, ready, { polarity: 'negative' })), 'review');
});

test('approved is final in this tool: nothing moves out of it', () => {
  assert.deepEqual(S.CANDIDATE_TRANSITIONS.approved, []);
  S.CANDIDATE_STATUSES.forEach(to => assert.equal(S.canTransitionCandidate('approved', to), false));
  assert.equal(S.canTransitionCandidate('rejected', 'approved'), false, 'a rejected claim must be reopened and reviewed first');
});
