/* ============================================================================
   api/_lib/instagram-extraction.test.js
   ----------------------------------------------------------------------------
   OCR and video processing, the compatibility extractor, AI output
   validation, and the Graph API client's refusal to go beyond what Meta
   allows. No network: fetch and the AI gateway are injected.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const x = require('../_services/instagram/extractor');
const { createMediaProcessor, selectKeyFrames, parseVisionResponse } = require('../_services/instagram/media-processor');
const { createGraphClient, GraphError } = require('../_services/instagram/graph-client');

const seg = (text, source = 'caption', extra = {}) => Object.assign({ source, ref: null, text, confidence: null }, extra);
const rels = out => out.relationships.map(r => `${r.sourceText} <-> ${r.compatibleText} [${r.polarity}/${r.compatibilityType}]`);

/* ------------------------------------------------ 11. compatibility extraction */

test('the brief\'s example: a title line, then "Compatible:" with the brand stated once', () => {
  const out = x.extractDeterministic([seg('Samsung A15 4G Tempered Glass\nCompatible: A15 4G / A15 5G')]);
  assert.equal(out.category.categoryId, 'screen-guards');
  assert.equal(out.brandHint, 'samsung');
  assert.deepEqual(rels(out), [
    'Samsung A15 4G <-> A15 4G [positive/explicit]',
    'Samsung A15 4G <-> A15 5G [positive/explicit]'
  ]);
  /* the evidence is the source, verbatim */
  assert.equal(out.relationships[1].evidenceText, 'Samsung A15 4G Tempered Glass / Compatible: A15 4G / A15 5G');
});

test('a slash-list in a product title is only IMPLIED — "iPhone 13 / 13 Pro" is not a claim', () => {
  const out = x.extractDeterministic([seg('iPhone 13 / 13 Pro Back Cover')]);
  assert.deepEqual(rels(out), ['iPhone 13 <-> iPhone 13 Pro [positive/implied]']);
});

test('negative statements are kept as negative evidence', () => {
  const out = x.extractDeterministic([seg('Samsung A15 glass not compatible with A15 5G')]);
  assert.deepEqual(rels(out), ['Samsung A15 <-> A15 5G [negative/explicit]']);
});

test('"same body" is a chassis hint, not a part claim', () => {
  const out = x.extractDeterministic([seg('Redmi 13C and Poco C65 same body')]);
  assert.equal(out.relationships[0].compatibilityType, 'same_chassis');
});

test('a list under a heading, the trade\'s Hinglish, and a series carried across a list', () => {
  let out = x.extractDeterministic([seg('Samsung A15 5G 9D tempered glass\nCompatible models:\nA15 5G\nA25 5G\nA24\n\nDM for wholesale 9876543210')]);
  assert.deepEqual(rels(out), [
    'Samsung A15 5G <-> A15 5G [positive/explicit]',
    'Samsung A15 5G <-> A25 5G [positive/explicit]',
    'Samsung A15 5G <-> A24 [positive/explicit]'
  ], 'the glass grade "9D" and the phone number are not models');

  out = x.extractDeterministic([seg('A15 me A15 5G ka glass lagega, samsung')]);
  assert.deepEqual(rels(out), ['A15 <-> A15 5G [positive/explicit]']);
  assert.equal(out.brandHint, 'samsung');

  out = x.extractDeterministic([seg('Redmi Note 13 / 13 Pro / 13 Pro+ same glass')]);
  assert.deepEqual(out.relationships.map(r => r.compatibleText), ['Redmi Note 13 Pro', 'Redmi Note 13 Pro Plus']);
});

test('a model name ends where the catalogue says it does — real captions keep talking after it', () => {
  /* Captions from the first live import (2026-10-01). Taking the whole
     fragment as the model made every one of them "unmatched". */
  const taxonomy = require('../_services/taxonomy-service');
  const refOf = caption => {
    const out = x.extractDeterministic([seg(caption)]);
    const r = out.references.filter(a => !a.fromHashtag);
    assert.equal(r.length, 1, caption);
    return { text: r[0].text, match: taxonomy.matchModel(r[0].text, { brandHint: r[0].brandHint }) };
  };
  [
    ['Samsung galaxy A14 5g display light Jumper\n#mobile #mobilerepair #repair', 'samsung-galaxy-a14-5g'],
    ['Realme c65 no baseband problem\n\n#mobilerepair #repair #mobile', 'realme-c65'],
    ['Vivo y16 charging ovp ic bypas\n#mobilerepair #repair #mobile', 'vivo-y16'],
    ['Infinix Hot 11 charging Jumper solution', 'infinix-hot-11'],
    ['iphone xs max display price', 'apple-iphone-xs-max']
  ].forEach(([caption, id]) => {
    const r = refOf(caption);
    assert.equal(r.match.modelId, id, `${caption} -> ${r.text}`);
  });
  assert.equal(x.extractDeterministic([seg('Charging error solution')]).references.length, 0, 'no model, no reference');
});

test('bounding a model name never drops a variant or a network to force a match', () => {
  const taxonomy = require('../_services/taxonomy-service');
  const first = caption => x.extractDeterministic([seg(caption)]).references[0];

  /* "A15 Prime" is not in the catalogue. It must stay "A15 Prime", unmatched —
     trimming it to the A15 would merge two phones. */
  const prime = first('Samsung Galaxy A15 Prime glass in stock');
  assert.equal(prime.text, 'Samsung Galaxy A15 Prime');
  assert.equal(taxonomy.matchModel(prime.text).status, 'unmatched');

  /* the 5G stays with the model: this is the A15 5G, not the A15 */
  assert.equal(taxonomy.matchModel(first('Samsung A15 5G dead solution').text).modelId, 'samsung-galaxy-a15-5g');
  /* and a 4G the record's name lacks still needs a person */
  const g4 = first('Samsung A15 4G network problem');
  assert.equal(g4.text, 'Samsung A15 4G');
  assert.equal(taxonomy.matchModel(g4.text).requiresVariantConfirmation, true);

  /* the "s" is part of the number: A15s is its own record */
  assert.equal(taxonomy.matchModel(first('oppo a15s dead solution').text).modelId, 'oppo-a15s');
  /* no brand, two candidates: still ambiguous, not guessed */
  assert.equal(taxonomy.matchModel(first('c65 no baseband').text).status, 'ambiguous');
});

test('hashtags are references, never relationships; prices and emoji are not models', () => {
  const out = x.extractDeterministic([seg('Redmi 13C combo same as POCO C65 ✅ Price ₹450 #redmi13c #combo #a15glass')]);
  assert.deepEqual(rels(out), ['Redmi 13C <-> POCO C65 [positive/explicit]']);
  assert.ok(out.references.some(r => r.fromHashtag && r.text === 'redmi13c'));
  assert.ok(!out.references.some(r => /450/.test(r.text)));
});

test('an unmapped product is reported as such', () => {
  const out = x.extractDeterministic([seg('Samsung A15 camera lens protector fits A15 5G')]);
  assert.equal(out.category.categoryId, null);
  assert.match(out.warnings.join(' '), /lens protector/);
});

test('OCR text from an image and a caption are read together, each keeping its source', () => {
  const out = x.extractDeterministic([
    seg('New stock 🔥 #samsung'),
    seg('A15 TEMPERED GLASS\nCOMPATIBLE: A15 / A15 5G', 'ocr', { ref: '1789_child_2', confidence: 0.93 })
  ]);
  assert.equal(out.relationships.length, 1);
  assert.equal(out.relationships[0].evidence.source, 'ocr');
  assert.equal(out.relationships[0].evidence.ref, '1789_child_2');
  assert.equal(out.relationships[0].evidence.confidence, 0.93);
});

/* ------------------------------------------------------- AI validation (22) */

const ctx = {
  sourceText: '[caption] Samsung A15 Tempered Glass. Compatible: A15 / A15 5G',
  modelIds: new Set(['samsung-galaxy-a15', 'samsung-galaxy-a15-5g']),
  categoryIds: new Set(['screen-guards', 'battery'])
};
const good = {
  sourceModelText: 'Samsung A15', sourceModelId: 'samsung-galaxy-a15',
  compatibleModelText: 'A15 5G', compatibleModelId: 'samsung-galaxy-a15-5g',
  categoryText: 'Tempered Glass', categoryId: 'screen-guards',
  compatibilityType: 'explicit', polarity: 'positive', evidenceText: 'Compatible: A15 / A15 5G'
};

test('valid AI output passes schema validation', () => {
  const r = x.validateAiExtraction({ relationships: [good] }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.valid.length, 1);
  assert.equal(r.rejected.length, 0);
});

test('an AI relationship whose evidence is not in the source is refused — the anti-invention check', () => {
  const invented = Object.assign({}, good, { evidenceText: 'A15 glass also fits the A16', compatibleModelId: 'UNMATCHED' });
  const r = x.validateAiExtraction({ relationships: [invented] }, ctx);
  assert.equal(r.valid.length, 0);
  assert.match(r.rejected[0].reasons.join(' '), /does not appear in the source/);
});

test('ids the model was not offered, unknown categories and free-form types are refused', () => {
  const r = x.validateAiExtraction({ relationships: [
    Object.assign({}, good, { compatibleModelId: 'samsung-galaxy-a16' }),
    Object.assign({}, good, { categoryId: 'camera-lens' }),
    Object.assign({}, good, { compatibilityType: 'definitely' }),
    Object.assign({}, good, { polarity: 'maybe' })
  ] }, ctx);
  assert.equal(r.valid.length, 0);
  assert.equal(r.rejected.length, 4);
});

test('output that is not the JSON contract is refused whole; JSON inside a fence gets one chance', () => {
  assert.equal(x.validateAiExtraction('Sure! A15 fits A15 5G.', ctx).ok, false);
  assert.equal(x.validateAiExtraction({ message: 'Here you go' }, ctx).ok, false);
  const fenced = { message: '```json\n' + JSON.stringify({ relationships: [good] }) + '\n```' };
  assert.equal(x.validateAiExtraction(fenced, ctx).valid.length, 1);
});

test('the AI receives the brief\'s strict instruction verbatim', () => {
  [
    'You are extracting mobile-part compatibility information from source content.',
    'Extract only information supported by the provided source.',
    'Do not invent models, compatibility relationships, categories, or specifications.',
    'If no confident match exists, return UNMATCHED.',
    'Return structured JSON only.'
  ].forEach(line => assert.ok(x.AI_SYSTEM_PROMPT.indexOf(line) > -1, line));
});

test('the AI is asked only when the rules left something on the table', () => {
  const clear = x.extractDeterministic([seg('Samsung A15 Tempered Glass\nCompatible: Samsung A15 / Samsung A15 5G')]);
  const matched = clear.references.map(r => ({ text: r.text, match: { status: 'matched' } }));
  assert.equal(x.shouldAskAi('fallback', clear, matched), false);
  assert.equal(x.shouldAskAi('off', clear, matched), false);
  assert.equal(x.shouldAskAi('always', clear, matched), true);
  const unresolved = clear.references.map(r => ({ text: r.text, match: { status: 'unmatched' } }));
  assert.equal(x.shouldAskAi('fallback', clear, unresolved), true);
});

/* --------------------------------------------------------------- 3. OCR */

function memoryCache() {
  const m = new Map();
  return { get: async k => m.get(k) || null, put: async (k, v) => { m.set(k, v); }, map: m };
}
function usageStub(caps = {}) {
  const used = {};
  return {
    allow: k => (used[k] || 0) < (caps[k] == null ? Infinity : caps[k]),
    record: k => { used[k] = (used[k] || 0) + 1; },
    used
  };
}
function imageFetch(bytes = Buffer.from('fake-jpeg-bytes')) {
  let calls = 0;
  const fn = async () => {
    calls++;
    return { ok: true, status: 200, headers: { get: h => (h === 'content-type' ? 'image/jpeg' : String(bytes.length)) }, arrayBuffer: async () => bytes };
  };
  fn.calls = () => calls;
  return fn;
}
function fakeAi(outputs) {
  const calls = [];
  return {
    calls,
    isConfigured: () => true,
    status: () => ({ model: 'test-model', missing: [] }),
    invoke: async args => { calls.push(args); const o = outputs[args.capability]; return o ? { ok: true, output: typeof o === 'function' ? o(args) : o } : { ok: false, reason: 'no fake' }; }
  };
}
const cfg = { ocrProvider: 'gateway', videoProvider: 'gateway', transcribe: true, maxFramesPerVideo: 4, maxImageBytes: 1e6, visionKey: '' };

test('OCR reads an image through the gateway, and the same bytes are never read twice', async () => {
  const ai = fakeAi({ media_ocr: { text: 'A15 TEMPERED GLASS\nCOMPATIBLE: A15 / A15 5G', confidence: 0.91, engine: 'paddleocr' } });
  const cache = memoryCache();
  const usage = usageStub();
  const p = createMediaProcessor({ cfg, ai, fetchImpl: imageFetch(), cache, usage });

  const first = await p.ocrImage({ mediaId: '1', mediaUrl: 'https://cdn.example/1.jpg' });
  assert.equal(first.status, 'ok');
  assert.match(first.text, /COMPATIBLE/);
  assert.equal(first.cached, false);
  assert.ok(first.bytesHash);

  /* a repost of the same photo under another media id */
  const second = await p.ocrImage({ mediaId: '2', mediaUrl: 'https://cdn.example/other-url.jpg' });
  assert.equal(second.cached, true);
  assert.equal(ai.calls.length, 1, 'one paid OCR call for identical bytes');
  assert.equal(usage.used.cacheHit, 1);
});

test('without an OCR provider nothing is invented: the image is reported unread', async () => {
  const p = createMediaProcessor({ cfg: Object.assign({}, cfg, { ocrProvider: 'none' }), ai: fakeAi({}), fetchImpl: imageFetch(), cache: memoryCache(), usage: usageStub() });
  const r = await p.ocrImage({ mediaId: '1', mediaUrl: 'https://cdn.example/1.jpg' });
  assert.equal(r.status, 'unavailable');
  assert.equal(r.text, undefined);
  const noUrl = await createMediaProcessor({ cfg, ai: fakeAi({}), fetchImpl: imageFetch(), cache: memoryCache(), usage: usageStub() })
    .ocrImage({ mediaId: '1', mediaUrl: null });
  assert.match(noUrl.reason, /copyrighted/);
});

test('at the daily OCR cap an image is deferred, not failed and not skipped', async () => {
  const ai = fakeAi({ media_ocr: { text: 'x' } });
  const p = createMediaProcessor({ cfg, ai, fetchImpl: imageFetch(), cache: memoryCache(), usage: usageStub({ ocr: 0 }) });
  const r = await p.ocrImage({ mediaId: '1', mediaUrl: 'https://cdn.example/1.jpg' });
  assert.equal(r.status, 'deferred');
  assert.equal(ai.calls.length, 0);
});

test('Google Vision responses are parsed, and its errors are reported', () => {
  const okBody = { responses: [{ fullTextAnnotation: { text: 'Redmi 13C Combo', pages: [{ blocks: [{ confidence: 0.9 }, { confidence: 0.7 }] }] } }] };
  const r = parseVisionResponse(okBody);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Redmi 13C Combo');
  assert.ok(Math.abs(r.confidence - 0.8) < 1e-9);
  assert.equal(parseVisionResponse({ responses: [{ error: { message: 'billing disabled' } }] }).ok, false);
});

test('key frames: only frames whose text changes are kept, and the cap prefers new information', () => {
  const frames = [
    { timeMs: 0, text: 'A15 TEMPERED GLASS', confidence: 0.7 },
    { timeMs: 400, text: 'A15 TEMPERED GLASS', confidence: 0.95 },      /* same text, clearer */
    { timeMs: 800, text: 'A15 TEMPERED GLASS', confidence: 0.9 },
    { timeMs: 1600, text: 'COMPATIBLE A15 5G A25 5G', confidence: 0.9 },
    { timeMs: 2000, text: '', confidence: null },                        /* no text */
    { timeMs: 2400, text: 'FOLLOW FOR MORE', confidence: 0.9 }
  ];
  const kept = selectKeyFrames(frames, { maxFrames: 8 });
  assert.deepEqual(kept.map(f => f.timeMs), [400, 1600, 2400]);
  const capped = selectKeyFrames(frames, { maxFrames: 2 });
  assert.equal(capped.length, 2);
  assert.ok(capped.some(f => /COMPATIBLE/.test(f.text)));
});

test('a video is analysed once per media id; frames and transcript come back validated', async () => {
  const ai = fakeAi({ video_analyze: {
    frames: [{ timeMs: 0, text: 'Redmi 13C combo' }, { timeMs: 500, text: 'Redmi 13C combo' }, { timeMs: 3000, text: 'same as POCO C65', confidence: 0.9 }],
    transcript: { text: 'yeh Redmi 13C ka combo POCO C65 me bhi lagega', language: 'hi' }, engine: 'whisper+ocr'
  } });
  const p = createMediaProcessor({ cfg, ai, fetchImpl: imageFetch(), cache: memoryCache(), usage: usageStub() });
  const r = await p.analyzeVideo({ mediaId: 'reel1', mediaUrl: 'https://cdn.example/v.mp4' });
  assert.equal(r.status, 'ok');
  assert.equal(r.frames.length, 2, 'the repeated frame is collapsed');
  assert.match(r.transcript.text, /lagega/);
  await p.analyzeVideo({ mediaId: 'reel1', mediaUrl: 'https://cdn.example/v-new-signature.mp4' });
  assert.equal(ai.calls.length, 1);
});

test('without a video processor only the cover image is read, and the result says so', async () => {
  const ai = fakeAi({ media_ocr: { text: 'A15 glass', confidence: 0.8 } });
  const p = createMediaProcessor({ cfg: Object.assign({}, cfg, { videoProvider: 'none' }), ai, fetchImpl: imageFetch(), cache: memoryCache(), usage: usageStub() });
  const r = await p.analyzeVideo({ mediaId: 'v', mediaUrl: 'https://cdn.example/v.mp4', thumbnailUrl: 'https://cdn.example/cover.jpg' });
  assert.equal(r.status, 'partial');
  assert.match(r.reason, /cover image/);
  assert.equal(r.transcript, null);
});

/* ---------------------------------------------------- Graph API client (2) */

function graphFetch(handler) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const { status = 200, body, headers = {} } = handler(new URL(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: h => headers[h.toLowerCase()] || null } };
  };
  fn.calls = calls;
  return fn;
}

test('unconfigured means nothing is called and nothing is claimed', async () => {
  const fetchImpl = graphFetch(() => ({ body: {} }));
  const g = createGraphClient({ token: '', igUserId: '', fetchImpl });
  assert.equal(g.configured(), false);
  await assert.rejects(() => g.discoverPage('mobile_parts_hub'), e => e instanceof GraphError && e.kind === 'unconfigured');
  assert.equal(fetchImpl.calls.length, 0);
});

test('Business Discovery reads a professional account\'s media, normalised, with the cursor', async () => {
  const fetchImpl = graphFetch(url => {
    assert.equal(url.host, 'graph.facebook.com', 'only the official API host is ever called');
    assert.match(url.searchParams.get('fields'), /business_discovery\.username\(mobile_parts_hub\)/);
    assert.ok(url.searchParams.get('appsecret_proof'), 'appsecret_proof is sent when the secret is set');
    return { body: { business_discovery: {
      id: '999', username: 'mobile_parts_hub', name: 'Hub', followers_count: 120000, media_count: 2,
      media: { data: [
        { id: '1', caption: 'A15 glass', media_type: 'IMAGE', media_url: 'https://cdn/1.jpg', permalink: 'https://www.instagram.com/p/AAAAA1/', timestamp: '2026-09-01T10:00:00+0000' },
        { id: '2', caption: 'Redmi 13C combo', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/BBBBB2/', timestamp: '2026-09-02T10:00:00+0000' },
        { id: '3', caption: '', media_type: 'CAROUSEL_ALBUM', permalink: 'https://www.instagram.com/p/CCCCC3/', children: { data: [{ id: '31', media_type: 'IMAGE', media_url: 'https://cdn/31.jpg' }] } }
      ], paging: { cursors: { after: 'CURSOR2' }, next: 'https://graph.facebook.com/next' } }
    } } };
  });
  const g = createGraphClient({ token: 'tok', igUserId: '17841400000000000', appSecret: 'shh', fetchImpl });
  const page = await g.discoverPage('mobile_parts_hub', { limit: 25 });
  assert.equal(page.nextCursor, 'CURSOR2');
  assert.equal(page.profile.followersCount, 120000);
  assert.deepEqual(page.media.map(m => m.contentType), ['image', 'reel', 'carousel']);
  assert.equal(page.media[1].mediaUrlOmitted, true, 'a reel without media_url (copyrighted audio) is flagged, not guessed');
  assert.equal(page.media[0].shortcode, 'AAAAA1');
  assert.equal(page.media[2].children[0].mediaId, '31');
});

test('Business Discovery pages by cursors alone — Meta sends no `next` link there', async () => {
  /* The shape the live API returned on 2026-09-30: `paging.cursors.after`
     and nothing else, and a reel with no media_url. Requiring `next` stopped
     every import after its first page. */
  const page = (n, after) => ({ business_discovery: { id: '1', username: 'shop_x', media: {
    data: Array.from({ length: n }, (_, i) => i === 1
      ? { id: 'r' + i, media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/RRRRR' + i + '/', timestamp: '2026-09-30T01:56:03+0000', caption: 'reel' }
      : { id: 'm' + i, media_type: 'IMAGE', media_product_type: 'FEED', media_url: 'https://cdn/x.heic?stp=dst-jpg', permalink: 'https://www.instagram.com/p/PPPPP' + i + '/', timestamp: '2026-09-30T01:58:34+0000', caption: 'post' }),
    paging: after ? { cursors: { after } } : { cursors: {} }
  } } });
  let calls = 0;
  const g = createGraphClient({ token: 't', igUserId: '1', fetchImpl: graphFetch(url => {
    calls++;
    const after = /\.after\(([^)]+)\)/.exec(url.searchParams.get('fields'));
    return { body: !after ? page(3, 'C2') : page(2, 'C3') };
  }) });
  const first = await g.discoverPage('shop_x', { limit: 3 });
  assert.equal(first.nextCursor, 'C2', 'a full page with an after cursor means there may be more');
  assert.equal(first.media[1].mediaUrlOmitted, true);
  assert.equal(first.media[0].timestamp, Date.UTC(2026, 8, 30, 1, 58, 34), 'the +0000 timestamp parses');
  const second = await g.discoverPage('shop_x', { limit: 3, after: 'C2' });
  assert.equal(second.nextCursor, null, 'a short page is the last one, whatever cursor comes with it');
  assert.equal(calls, 2);
});

test('a personal or private account is "not collectable", and a rate limit pauses rather than retries', async () => {
  const notBusiness = createGraphClient({ token: 't', igUserId: '1', fetchImpl: graphFetch(() => ({ status: 400, body: { error: { code: 110, error_subcode: 2207013, message: 'Cannot find User' } } })) });
  await assert.rejects(() => notBusiness.discoverPage('someone_private'), e => e.kind === 'not_collectable');

  const limited = createGraphClient({ token: 't', igUserId: '1', fetchImpl: graphFetch(() => ({
    status: 400, body: { error: { code: 80002, message: 'Application request limit reached' } },
    headers: { 'x-business-use-case-usage': JSON.stringify({ 1: [{ estimated_time_to_regain_access: 17 }] }) }
  })) });
  await assert.rejects(() => limited.discoverPage('hub'), e => e.kind === 'rate_limited' && e.retryAfterMs === 17 * 60000);

  const expired = createGraphClient({ token: 't', igUserId: '1', fetchImpl: graphFetch(() => ({ status: 400, body: { error: { code: 190, message: 'Session has expired' } } })) });
  await assert.rejects(() => expired.ownMediaPage(), e => e.kind === 'token_invalid');
});
