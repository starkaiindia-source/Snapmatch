/* ============================================================================
   api/_lib/instagram-intelligence.test.js
   ----------------------------------------------------------------------------
   The compatibility INTELLIGENCE layer, against the shape of a real
   technician's page: mostly repair posts, a few reels whose frames carry a
   compatibility list, and captions that say almost nothing.

     · a repair or jumper post is classified and ignored — it names a phone,
       it makes no claim, and it must not reach an admin as a card
     · a list read out of frames becomes ONE group proposal, compared with the
       groups production already has
     · one category + one model = at most one group, enforced inside the
       approval transaction — whatever the card said when it was drawn

   The texts below are what an OCR engine returns for such a reel. They are
   INPUT: nothing in the code under test knows any of these model names. The
   catalogue, the matcher, the extractor, the classifier, the group planner
   and the approval transaction are the real code; Instagram, OCR and vision
   are fakes that return fixed content.
   ========================================================================== */
'use strict';

/* hermetic: whatever keys this machine has, these tests use none of them */
['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_VISION_API_KEY', 'AI_GATEWAY_URL', 'AI_GATEWAY_TOKEN'].forEach(k => { delete process.env[k]; });

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeFirestore } = require('./testing/fake-firestore');
const fsx = require('../_services/instagram/firestore');
const jobs = require('../_services/instagram/job-service');
const review = require('../_services/instagram/review-service');
const configMod = require('../_services/instagram/config');
const relevance = require('../_services/instagram/relevance');
const extractor = require('../_services/instagram/extractor');
const groupProposals = require('../_services/instagram/group-proposals');
const { createGraphClient, normaliseMedia } = require('../_services/instagram/graph-client');
const taxonomy = require('../_services/taxonomy-service');
const S = require('../_schema/instagram');
const C = require('../_schema/collections');

const ADMIN = { uid: 'ownerUid000001', email: 'stark.ai.india@gmail.com', role: 'super_admin' };
const NOW = Date.UTC(2026, 9, 1, 6, 0);
let clockT = NOW;
const clock = () => (clockT += 3);

/* --------------------------------------------------- the catalogue, by name */

const id = name => {
  const m = taxonomy.matchModel(name);
  assert.equal(m.status, 'matched', `fixture model "${name}" must be in the catalogue`);
  return m.modelId;
};
const nameOf = modelId => taxonomy.modelById(modelId).modelName;

/* --------------------------------------------------------------- the world */

function seedGroup(fake, groupId, categoryId, masterName, memberNames) {
  const ids = memberNames.map(id);
  const master = id(masterName);
  fake.seed('groups/' + groupId, {
    groupNo: groupId.toUpperCase(), categoryId, partCode: 'MPF-' + groupId.toUpperCase(),
    masterModelId: master, masterModelName: nameOf(master), memberCount: ids.length
  });
  fake.seed('groupDetails/' + groupId, {
    groupNo: groupId.toUpperCase(), categoryId, partCode: 'MPF-' + groupId.toUpperCase(),
    memberIds: ids, memberNames: ids.map(nameOf), memberCount: ids.length
  });
  ids.forEach(m => {
    const cur = fake.read('modelGroups/' + m) || { id: m, byCategory: {} };
    cur.byCategory[categoryId] = (cur.byCategory[categoryId] || []).concat(groupId);
    fake.seed('modelGroups/' + m, cur);
  });
}

/** Production as the combo-display category has it around these phones. */
function world() {
  const fake = createFakeFirestore();
  fsx.use(fake.provider);
  require('./firebase').db = () => fake.db;
  fake.seed('catalog/meta', { version: 1789052260911 });
  seedGroup(fake, 'cd-0678', 'combo-display', 'Vivo Y11s', ['Vivo Y11s', 'Vivo Y20', 'Vivo Y20a', 'Vivo Y20g', 'Vivo Y20s', 'Vivo Y12s', 'vivo iQOO U1x']);
  seedGroup(fake, 'cd-0244', 'combo-display', 'Vivo Y21s', ['Vivo Y21s', 'Vivo Y16', 'Vivo Y15c', 'Vivo Y32', 'Vivo Y21t']);
  seedGroup(fake, 'cd-0557', 'combo-display', 'Vivo Y36', ['Vivo Y36']);
  seedGroup(fake, 'cd-0085', 'combo-display', 'Vivo Y33s', ['Vivo Y33s']);
  seedGroup(fake, 'cd-0679', 'combo-display', 'Realme 5', ['Realme 5', 'Realme 5s', 'Realme C3', 'Realme Narzo 10A', 'Oppo A5 (2020)', 'Oppo A31', 'Realme 5i', 'Realme Narzo 20A']);
  seedGroup(fake, 'cd-0235', 'combo-display', 'Oppo A9 (2020)', ['Oppo A9 (2020)']);
  return fake;
}

function cfg(over) {
  return Object.assign(configMod.load(), {
    graph: { token: 'test-token', igUserId: '17841400000000000', version: 'v25.0', timeoutMs: 1000, appSecret: '' },
    ocrProvider: 'gateway', videoProvider: 'gateway', visionProvider: 'none', transcribe: true, aiMode: 'off', readRepairMedia: false,
    maxItemsPerJob: 50, maxDiscoveryPages: 5, pageSize: 25, maxFramesPerVideo: 8, maxCarouselChildren: 10,
    maxAttempts: 3, tickBudgetMs: 10 * 60 * 1000, leaseMs: 60000,
    dailyGraphCalls: 1000, dailyOcrCalls: 1000, dailyAiCalls: 1000, dailyVideoCalls: 1000
  }, over || {});
}

const noAi = { isConfigured: () => false, status: () => ({ model: null, missing: ['AI_GATEWAY_URL'] }), invoke: async () => ({ ok: false, reason: 'ai-unconfigured' }) };

/* ------------------------------------------------- what the page looks like */

/* What OCR returns for the three scenes of the reel: columns block by block,
   a watermark between two of them, two columns read as one line, numbering,
   three spellings of one phone, a Hindi sentence above an English heading. */
const SCENE_VIVO_LIST = [
  'यह एक Display लग जाएगा 68 models में',
  'COMPATIBLE MODELS (VIVO)',
  'Vivo Y21', 'Vivo Y36', 'Vivo Y20a', 'Vivo Y21s', 'Vivo Y20', 'Vivo Y20g', 'Vivo Y16', 'Vivo Y30 5G',
  'SK MOBILE DOCTOR',
  'Vivo Y15a Vivo Y15c', 'Vivo Y32', 'Vivo Y33 5G', 'Vivo Y20e', 'Vivo Y20s', 'Vivo Y33s', 'Vivo Y21t',
  'Vivo Y51 2020', 'Vivo Y31 2020', 'Vivo Y73', 'Vivo Y73s', 'Vivo Y12s', 'Vivo Y35 5G', 'iQOO Z3', 'iQOO U3x'
].join('\n');
const SCENE_REALME = [
  'Realme C3 Combo', 'Universal All in One', 'Compatible With:',
  'Realme c3, Oppo a5 2020, Oppo a9 2020,', 'Oppo a31 2020, Realme 5, 5s, 5i,', 'narzo 10a, narzo 20a'
].join('\n');
const SCENE_VIVO_TITLE = [
  'Vivo Y20 Combo', 'Universal All in One', 'COMPATIBLE WITH (68)',
  '1. Vivo Y20 2. Vivo Y20i', '3. Vivo Y20 A', '4) Vivo Y20G', '5 Vivo Y12s', '6. IQOO U1x', '7. vivo y 20s'
].join('\n');

const REPAIR_CAPTIONS = [
  'Samsung galaxy A14 5g display light jumper',
  'Realme c65 no baseband problem',
  'Oppo A15 Display Light Jumper',
  'Samsung A21S Temperature Charging Error',
  'Redmi 9 Power dead shorting remove capacitor',
  'Samsung A03S temperature warning OVP IC bypass',
  'Redmi Note 10 power button jumper'
];

const post = (n, over) => Object.assign({
  id: 'p' + n, media_type: 'IMAGE', media_url: `https://cdn/p${n}.jpg`,
  permalink: `https://www.instagram.com/p/POST${String(n).padStart(4, '0')}/`, timestamp: '2026-09-20T10:00:00+0000', caption: ''
}, over);
const reel = (n, over) => Object.assign({
  id: 'r' + n, media_type: 'VIDEO', media_product_type: 'REELS', media_url: `https://cdn/r${n}.mp4`,
  permalink: `https://www.instagram.com/reel/REEL${String(n).padStart(4, '0')}/`, timestamp: '2026-09-21T10:00:00+0000', caption: ''
}, over);

const REPAIR_POSTS = REPAIR_CAPTIONS.map((caption, i) => post(i + 1, { caption }));
const COMBO_REEL = reel(1, { caption: 'Universal combo ... #display #combo' });
const REEL_FRAMES = { r1: { frames: [
  { timeMs: 1000, text: SCENE_VIVO_LIST, confidence: 0.93 },
  { timeMs: 6000, text: SCENE_REALME, confidence: 0.93 },
  { timeMs: 11000, text: SCENE_VIVO_TITLE, confidence: 0.93 }
], transcript: null } };

function fakeGraph(pagesByUser) {
  return {
    configured: () => true,
    ownProfile: async () => ({ username: 'mpf_official', name: 'MPF', followersCount: 10, mediaCount: 0 }),
    ownMediaPage: async () => ({ media: [], nextCursor: null }),
    discoverPage: async (username, { after }) => {
      const pages = pagesByUser[username];
      const i = after ? Number(after) : 0;
      return {
        profile: { username, name: username, followersCount: 52848, mediaCount: 585, accountType: 'professional' },
        media: pages[i].map(raw => normaliseMedia(raw)),
        nextCursor: i + 1 < pages.length ? String(i + 1) : null
      };
    }
  };
}

function fakeMedia({ ocr = {}, video = {}, byBytes = {} } = {}) {
  const calls = { ocr: [], video: [] };
  return {
    calls,
    ocrImage: async ({ mediaId, bytes }) => {
      calls.ocr.push(mediaId);
      const r = bytes ? byBytes[bytes.toString()] : ocr[mediaId];
      return r ? { status: 'ok', text: r.text, confidence: r.confidence, engine: 'fake-ocr', bytesHash: 'hash_' + mediaId }
               : { status: 'unavailable', reason: 'No OCR provider is configured.' };
    },
    analyzeVideo: async ({ mediaId, mediaUrl }) => {
      calls.video.push(mediaId);
      if (!mediaUrl) return { status: 'unavailable', reason: 'Instagram returned no media URL for this video (it omits it for copyrighted audio or flagged media).', frames: [], transcript: null };
      const r = video[mediaId];
      return r ? Object.assign({ status: 'ok', engine: 'fake-video' }, r) : { status: 'unavailable', reason: 'none', frames: [], transcript: null };
    }
  };
}

async function runJob(profileUrl, deps) {
  const created = await jobs.createJob({ admin: ADMIN, profileUrl, now: clock(), deps });
  assert.equal(created.ok, true, created.error);
  let out = { job: created.job };
  for (let i = 0; i < 30 && ['queued', 'discovering', 'processing'].indexOf(out.job.status) > -1; i++) {
    out = await jobs.tick({ jobId: created.job.jobId, workerId: 'test', deps: Object.assign({ clock }, deps) });
  }
  return out.job;
}

const candidatesOf = fake => fake.all(C.COMPATIBILITY_CANDIDATES);
const proposalsOf = fake => candidatesOf(fake).filter(c => c.kind === 'group_proposal');
const production = fake => JSON.stringify(['catalog/meta', 'groupDetails/', 'groups/', 'modelGroups/']
  .map(p => fake.paths(p).sort().map(k => [k, fake.read(k)])));
const member = (p, name) => p.members.find(m => m.match && m.match.modelId === id(name));
const fresh = (fake, p) => fake.read(C.COMPATIBILITY_CANDIDATES + '/' + p.candidateId);

/** No model may be in two groups of one category. */
function assertOneGroupPerCategory(fake) {
  fake.paths('modelGroups/').forEach(path => {
    const doc = fake.read(path);
    Object.keys(doc.byCategory || {}).forEach(cat => {
      assert.ok(doc.byCategory[cat].length <= 1, `${doc.id} is in ${doc.byCategory[cat].join(' and ')} for ${cat}`);
    });
  });
}

async function importSkPage(fake, extra = {}) {
  const media = fakeMedia({ video: REEL_FRAMES });
  const graph = fakeGraph({ sk_mobile_doctar: [REPAIR_POSTS.concat([COMBO_REEL])] });
  const job = await runJob('https://www.instagram.com/sk_mobile_doctar/', Object.assign({ cfg: cfg(), graph, media, ai: noAi }, extra));
  return { job, media };
}

/* ================================================================ relevance */

test('repair, jumper and fault posts are classified as repair — whatever phone they name', () => {
  REPAIR_CAPTIONS.concat([
    'Redmi 9 charging ways same as Redmi 9 Prime',
    'iPhone 11 no network solution',
    'Vivo Y20 dead solution 100% working'
  ]).forEach(caption => {
    const segments = [{ source: 'caption', ref: null, text: caption, confidence: null }];
    const det = extractor.extractDeterministic(segments);
    const out = relevance.classify({ segments, det, mediaItems: [] });
    assert.equal(out.relevance, 'IRRELEVANT_REPAIR', caption);
    assert.equal(out.sets.length + out.relationships.length, 0, 'no statement survives: ' + caption);
    assert.equal(relevance.captionGate(caption), 'repair', caption);
  });
});

test('"display light jumper" is not the product Display, and "same as" between repair routes is not compatibility', () => {
  const segments = [{ source: 'caption', ref: null, text: 'Samsung A14 5G display light jumper same as Samsung A15', confidence: null }];
  const det = extractor.extractDeterministic(segments);
  assert.equal(det.relationships.length, 1, 'the extractor sees two models tied by "same as"…');
  const out = relevance.classify({ segments, det, mediaItems: [] });
  assert.equal(out.relevance, 'IRRELEVANT_REPAIR', '…and the classifier sees what ties them is a repair');
  assert.equal(out.relationships.length, 0);
  assert.equal(out.sets.length, 0);
  assert.ok(out.signals.droppedAsRepair >= 1, 'and it is recorded that a statement was set aside as repair');
});

test('a compatibility statement is relevant in English, Hinglish, Hindi and Tamil', () => {
  [
    ['Samsung A15 Tempered Glass\nCompatible: Samsung A15 / Samsung A15 5G', 'RELEVANT_COMPATIBILITY'],
    ['Redmi 13C combo same as POCO C65', 'RELEVANT_COMPATIBILITY'],
    ['Samsung A15 me A15 5G ka glass lagega', 'RELEVANT_COMPATIBILITY'],
    [SCENE_VIVO_LIST, 'RELEVANT_COMPATIBILITY'],
    ['இந்த Battery பொருந்தும்\nSamsung A15\nSamsung A25\nSamsung A35', 'RELEVANT_COMPATIBILITY'],
    ['iPhone 13 / 13 Pro Back Cover', 'PARTIALLY_RELEVANT'],
    ['Samsung new arrivals', 'IRRELEVANT_GENERAL'],
    ['Samsung A15 tempered glass available', 'IRRELEVANT_GENERAL']
  ].forEach(([text, expected]) => {
    const segments = [{ source: 'caption', ref: null, text, confidence: null }];
    const out = relevance.classify({ segments, det: extractor.extractDeterministic(segments), mediaItems: [] });
    assert.equal(out.relevance, expected, text.split('\n')[0]);
  });
});

test('a generic caption decides nothing: unread media is INSUFFICIENT_EVIDENCE, not "irrelevant"', () => {
  const segments = [{ source: 'caption', ref: null, text: 'Universal combo ...', confidence: null }];
  const det = extractor.extractDeterministic(segments);
  const unread = [{ mediaId: 'r1', kind: 'video', ocrStatus: 'unavailable', reason: 'Instagram returned no media URL' }];
  const out = relevance.classify({ segments, det, mediaItems: unread });
  assert.equal(out.relevance, 'INSUFFICIENT_EVIDENCE');
  assert.equal(out.compatSignal, true);
  assert.match(out.reason, /could not be read/);
  assert.equal(relevance.captionGate('Universal combo ...'), 'compat');
  assert.equal(relevance.captionGate('New stock 🔥'), 'generic', 'a generic caption is read, not skipped');
  assert.deepEqual(S.extractionFiltersFor({ relevance: out.relevance, compatSignal: true, candidates: [], mediaItems: unread }), ['all', 'needs_review']);
});

/* =============================================================== extraction */

test('a list is read as printed: columns, numbering, a watermark, a count, two columns on one line', () => {
  const det = extractor.extractDeterministic([{ source: 'frame', ref: 'r1@1000ms', text: SCENE_VIVO_LIST, confidence: 0.93 }]);
  assert.equal(det.sets.length, 1);
  const texts = det.sets[0].members.map(m => m.text);
  assert.equal(texts.length, 24, 'every entry, across the watermark line');
  assert.ok(texts.indexOf('Vivo Y15A') > -1 && texts.indexOf('Vivo Y15C') > -1, 'two columns on one OCR line are two entries');
  assert.ok(!texts.some(t => /68/.test(t)), '"68 models" is a count, never a model');
  assert.equal(det.sets[0].headline, null, 'no product title here — the first entry is NOT promoted to one');
  assert.equal(det.sets[0].category.categoryId, 'combo-display', 'the product is read from the sentence above the heading');
  assert.equal(det.sets[0].members.find(m => m.text === 'Vivo Y21').line, 'Vivo Y21', 'each entry keeps the line it was read from');

  const titled = extractor.extractDeterministic([{ source: 'frame', ref: 'r1@11000ms', text: SCENE_VIVO_TITLE, confidence: 0.93 }]);
  assert.equal(titled.sets[0].headline.text, 'Vivo Y20', 'the product title is the headline');
  assert.deepEqual(titled.sets[0].members.map(m => m.text),
    ['Vivo Y20', 'Vivo Y20I', 'Vivo Y20 A', 'Vivo Y20G', 'Vivo Y12S', 'iQOO U1X', 'Vivo Y 20S'], 'numbering is not part of a name');
});

test('normalisation: spacing, case and a brand written once — never a new model for an OCR spelling', () => {
  const resolve = (text, brandHint) => taxonomy.matchModel(text, { brandHint: brandHint || undefined });
  const det = extractor.extractDeterministic([
    { source: 'frame', ref: 'a', text: SCENE_VIVO_LIST, confidence: 0.93 },
    { source: 'frame', ref: 'b', text: SCENE_VIVO_TITLE, confidence: 0.93 }
  ]);
  const sets = groupProposals.consolidateSets(det, resolve);
  assert.equal(sets.length, 1, 'the same list in two frames is one list');
  const y20a = sets[0].members.find(m => m.match.modelId === id('Vivo Y20a'));
  assert.deepEqual(y20a.texts.sort(), ['Vivo Y20 A', 'Vivo Y20A'], '"Y20 A" and "Y20A" are one entry, both spellings kept');
  assert.equal(y20a.evidence.length, 2, 'seen in two frames');
  assert.equal(sets[0].members.filter(m => m.match.modelId === id('Vivo Y20s')).length, 1, '"vivo y 20s" is the Y20s');
  assert.equal(sets[0].members.find(m => /iqoo u1x/i.test(m.text)).match.modelId, id('vivo iQOO U1x'), '"IQOO" is "iQOO"');
  assert.equal(sets[0].headline.match.modelId, id('Vivo Y20'));

  const statuses = Object.fromEntries(sets[0].members.map(m => [m.text, S.matchStatusFor(m.match)]));
  assert.equal(statuses['Vivo Y20'], 'Exact Match');
  assert.equal(statuses['Vivo Y21'], 'Needs Review', 'two catalogue records fit "Vivo Y21": a person chooses');
  assert.equal(statuses['Vivo Y20E'], 'Unknown / Not Found', 'not in the catalogue — and not invented');
  assert.equal(statuses['Vivo Y31 2020'], 'Needs Review', 'a year the record name does not carry is confirmed, never inferred');
});

/* ============================================================ the page import */

test('a technician\'s page: repair posts are ignored and unread; the reel becomes two group proposals', async () => {
  const fake = world();
  const before = production(fake);
  const { job, media } = await importSkPage(fake);

  assert.equal(job.status, 'completed');
  assert.equal(job.counts.postsFound, 8);
  assert.equal(job.counts.processed, 8);
  assert.equal(job.counts.ignored, 7, 'seven repair posts');
  assert.equal(job.counts.relevant, 1, 'one reel with compatibility lists');
  assert.equal(job.counts.groupProposals, 2);
  assert.deepEqual(media.calls.ocr, [], 'no repair image was sent to OCR: stage 1 decided from the caption');
  assert.deepEqual(media.calls.video, ['r1'], 'a generic "Universal combo" caption does not skip the reel');

  /* nothing from a repair post is a candidate of any kind */
  const cands = candidatesOf(fake);
  assert.equal(cands.filter(c => c.kind !== 'group_proposal').length, 0, 'no pairwise cards, no "unmatched model" cards');
  assert.ok(cands.every(c => c.contentKey === 'igm_r1'));

  /* …but each is kept, classified, with the reason, behind the Ignored filter */
  const extractions = fake.all(C.INSTAGRAM_EXTRACTIONS);
  const ignored = extractions.filter(x => x.relevance === 'IRRELEVANT_REPAIR');
  assert.equal(ignored.length, 7);
  ignored.forEach(x => {
    assert.deepEqual(x.filters, ['all', 'ignored']);
    assert.equal(x.actionable, false);
    assert.match(x.relevanceReason, /Repair or technical content/);
    assert.equal(x.mediaItems[0].ocrStatus, 'skipped');
  });
  const relevant = extractions.find(x => x.contentKey === 'igm_r1');
  assert.equal(relevant.relevance, 'RELEVANT_COMPATIBILITY');
  assert.ok(relevant.filters.indexOf('relevant') > -1 && relevant.filters.indexOf('conflicts') > -1);
  assert.equal(relevant.proposals.length, 2);
  assert.equal(relevant.texts.frames.length, 3, 'every key frame\'s text is stored as evidence');

  const source = fake.read(C.INSTAGRAM_SOURCES + '/ig_sk_mobile_doctar');
  assert.deepEqual(source.stats, { content: 8, ignored: 7, relevant: 1 });
  assert.ok(source.lastScanAt && source.lastSuccessfulScanAt);

  assert.equal(production(fake), before, 'an import writes nothing to production');
});

test('the Vivo list: the group of the product the post names, what it would add, and what is BLOCKED', async () => {
  const fake = world();
  await importSkPage(fake);
  const p = proposalsOf(fake).find(x => x.headline && x.headline.match.modelId === id('Vivo Y20'));
  assert.ok(p, 'the list headed "Vivo Y20 Combo"');

  assert.equal(p.categoryId, 'combo-display');
  assert.equal(p.target.mode, 'existing');
  assert.equal(p.target.groupId, 'cd-0678');
  assert.match(p.target.reason, /product the post names/);
  assert.equal(p.proposedMaster.modelId, id('Vivo Y11s'), 'the existing group keeps its master — not "the first model in the reel"');
  assert.equal(p.masterReviewRequired, false);

  ['Vivo Y20', 'Vivo Y20a', 'Vivo Y20g', 'Vivo Y20s', 'Vivo Y12s', 'vivo iQOO U1x'].forEach(n => assert.equal(member(p, n).state, 'existing', n));
  ['Vivo Y20i', 'Vivo Y30 5G', 'Vivo Y15a', 'Vivo Y73', 'Vivo Y73s', 'Vivo Y35 5G'].forEach(n => assert.equal(member(p, n).state, 'add', n));
  ['Vivo Y36', 'Vivo Y21s', 'Vivo Y16', 'Vivo Y15c', 'Vivo Y32', 'Vivo Y21t', 'Vivo Y33s'].forEach(n => assert.equal(member(p, n).state, 'conflict', n));
  assert.equal(member(p, 'Vivo Y21s').currentGroupId, 'cd-0244');
  assert.equal(member(p, 'Vivo Y21s').currentGroupMaster, nameOf(id('Vivo Y21s')));
  assert.equal(p.members.find(m => m.text === 'Vivo Y20E').state, 'unmatched');
  assert.equal(p.members.find(m => m.text === 'Vivo Y21').state, 'needs_review');

  assert.equal(p.proposedAction, 'MERGE_REQUIRED', 'the list covers all of cd-0244: the post treats two groups as one part');
  assert.equal(p.reviewSection, 'conflicts');
  assert.equal(p.duplicateCheck, 'BLOCKED');
  assert.match(p.conflict.note, /CATEGORY CONFLICT/);
  assert.deepEqual(p.otherGroups.map(g => g.groupId).sort(), ['cd-0085', 'cd-0244', 'cd-0557']);
  assert.equal(p.otherGroups.find(g => g.groupId === 'cd-0244').coverage, 1);

  /* every entry is traceable to the frame and the line it was read from */
  const y20 = member(p, 'Vivo Y20');
  assert.deepEqual(y20.evidence.map(e => e.ref).sort(), ['r1@1000ms', 'r1@11000ms'], 'both frames it appeared in');
  assert.equal(y20.evidence[0].source, 'frame');
  assert.equal(y20.matchStatus, 'Exact Match');
  assert.equal(p.confidence.band, 'medium', 'not high: several entries did not resolve with certainty');
});

test('approval is BLOCKED server-side while any listed model belongs to another group; nothing is written', async () => {
  const fake = world();
  await importSkPage(fake);
  const p = proposalsOf(fake).find(x => x.target.groupId === 'cd-0678');
  const before = production(fake);

  await assert.rejects(() => review.approveProposal({ candidateId: p.candidateId, admin: ADMIN, now: NOW + 10 }), e => {
    assert.equal(e.code, 'category-conflict');
    assert.match(e.message, /BLOCKED — MODEL ALREADY ASSIGNED/);
    assert.equal(e.blocked.length, 7);
    assert.deepEqual(e.blocked.find(b => b.modelId === id('Vivo Y36')), {
      modelId: id('Vivo Y36'), modelName: nameOf(id('Vivo Y36')), existingGroupId: 'cd-0557',
      existingGroupMaster: nameOf(id('Vivo Y36')), proposedGroupId: 'cd-0678'
    });
    return true;
  });
  assert.equal(production(fake), before, 'not one production document changed');
  assert.equal(fresh(fake, p).status, 'pending');
  assert.equal(fake.all(C.APPROVED_COMPATIBILITIES).length, 0);
});

test('resolving the conflicts by hand, then approving: only models with no group are added, and the rule still holds', async () => {
  const fake = world();
  await importSkPage(fake);
  let p = proposalsOf(fake).find(x => x.target.groupId === 'cd-0678');

  /* each blocked model is left where it is — an explicit, recorded decision */
  for (const m of p.members.filter(x => x.state === 'conflict')) {
    await review.proposalMemberDecision({ candidateId: p.candidateId, memberKey: m.key, decision: 'exclude', admin: ADMIN, now: clock() });
  }
  p = fresh(fake, p);
  assert.equal(p.proposedAction, 'UPDATE_EXISTING_GROUP');
  assert.equal(p.reviewSection, 'group_updates');
  assert.equal(p.conflict, null);
  assert.equal(p.counts.excluded, 7);
  const tags = () => fake.read(C.INSTAGRAM_EXTRACTIONS + '/' + p.extractionId);
  assert.ok(tags().filters.indexOf('group_updates') > -1, 'Extraction Results now lists it under Existing Group Updates');
  assert.equal(tags().proposals.find(x => x.candidateId === p.candidateId).proposedAction, 'UPDATE_EXISTING_GROUP');
  const adding = p.members.filter(m => m.state === 'add').map(m => m.match.modelId);
  assert.ok(adding.length >= 6);

  /* "Vivo Y21" fitted two records: the admin picks one, from the catalogue only */
  await assert.rejects(() => review.proposalSelectModel({ candidateId: p.candidateId, memberKey: 't:vivo y21', modelId: 'vivo-y9999', admin: ADMIN, now: clock() }),
    e => e.code === 'unknown-model');

  const before = JSON.parse(production(fake));
  await assert.rejects(() => review.approveProposal({ candidateId: p.candidateId, admin: ADMIN, expectedAdd: adding.length + 3, now: clock() }),
    e => e.code === 'stale', 'the admin approves what was shown, or nothing');
  const out = await review.approveProposal({ candidateId: p.candidateId, admin: ADMIN, expectedAdd: adding.length, now: clock() });
  assert.equal(out.outcome, 'applied');
  assert.deepEqual(out.change.addedModelIds.slice().sort(), adding.slice().sort());

  const group = fake.read('groupDetails/cd-0678');
  assert.equal(group.memberCount, 7 + adding.length);
  assert.deepEqual(group.memberIds.slice(0, 7), JSON.parse(JSON.stringify(before))[1].find(([k]) => k === 'groupDetails/cd-0678')[1].memberIds, 'existing members untouched, in place');
  adding.forEach(m => assert.deepEqual(fake.read('modelGroups/' + m).byCategory['combo-display'], ['cd-0678']));
  assert.equal(fake.read('groups/cd-0678').memberCount, group.memberCount);
  ['cd-0244', 'cd-0557', 'cd-0085'].forEach(g => assert.equal(fake.read('groupDetails/' + g).memberCount,
    before[1].find(([k]) => k === 'groupDetails/' + g)[1].memberCount, g + ' is untouched'));
  assertOneGroupPerCategory(fake);

  /* one ledger entry per added model, in the shape the build overlay reads */
  const ledger = fake.all(C.APPROVED_COMPATIBILITIES);
  assert.equal(ledger.length, adding.length);
  ledger.forEach(e => {
    assert.equal(e.status, 'applied');
    assert.equal(e.appliedChange.groupId, 'cd-0678');
    assert.equal(e.appliedChange.anchorModelId, id('Vivo Y11s'), 'anchored on the group\'s master');
    assert.equal(e.proposalId, p.candidateId);
  });
  const { applyApprovedOverlay } = require('../../scripts/build-dataset');
  const buildGroups = [{ id: 'cd-0678', categoryId: 'combo-display', memberIds: before[1].find(([k]) => k === 'groupDetails/cd-0678')[1].memberIds.slice(), memberNames: [], memberCount: 7 }];
  const models = new Map(adding.map(m => [m, { name: nameOf(m) }]));
  const overlay = applyApprovedOverlay({ entries: ledger }, buildGroups, models, new Map());
  assert.equal(overlay.applied, adding.length, 'the next catalogue build keeps every one of them');

  const done = fresh(fake, p);
  assert.equal(tags().filters.indexOf('group_updates'), -1, 'and no longer once it is approved: a tab lists what is open');
  assert.equal(tags().proposals.find(x => x.candidateId === p.candidateId).status, 'approved');
  assert.equal(done.status, 'approved');
  assert.equal(done.productionOutcome, 'applied');
  assert.equal(done.reviewSection, 'closed');
  await assert.rejects(() => review.approveProposal({ candidateId: p.candidateId, admin: ADMIN, now: clock() }), e => e.code === 'wrong-status');
});

test('if production changes after the card was drawn, the transaction re-reads it and blocks', async () => {
  const fake = world();
  await importSkPage(fake);
  let p = proposalsOf(fake).find(x => x.target.groupId === 'cd-0678');
  for (const m of p.members.filter(x => x.state === 'conflict')) {
    await review.proposalMemberDecision({ candidateId: p.candidateId, memberKey: m.key, decision: 'exclude', admin: ADMIN, now: clock() });
  }
  p = fresh(fake, p);
  assert.equal(member(p, 'Vivo Y73').state, 'add', 'on the card, the Y73 is free to add');

  /* meanwhile the catalogue import puts the Y73 in a group of its own */
  seedGroup(fake, 'cd-0072', 'combo-display', 'Vivo Y73', ['Vivo Y73']);
  const before = production(fake);

  await assert.rejects(() => review.approveProposal({ candidateId: p.candidateId, admin: ADMIN, now: clock() }), e => {
    assert.equal(e.code, 'category-conflict');
    assert.deepEqual(e.blocked.map(b => b.modelId), [id('Vivo Y73')]);
    assert.equal(e.blocked[0].existingGroupId, 'cd-0072');
    return true;
  });
  assert.equal(production(fake), before, 'the stale card wrote nothing');
  const after = fresh(fake, p);
  assert.equal(member(after, 'Vivo Y73').state, 'conflict', 'and the card now shows the conflict');
  assert.equal(after.reviewSection, 'conflicts');
  assertOneGroupPerCategory(fake);
});

test('the Realme list: an existing group, one model held by another group, and a reassignment only ever REQUESTED', async () => {
  const fake = world();
  await importSkPage(fake);
  let p = proposalsOf(fake).find(x => x.target.groupId === 'cd-0679');
  assert.ok(p);
  assert.equal(p.headline.text, 'Realme C3');
  assert.equal(p.proposedMaster.modelId, id('Realme 5'));
  ['Realme C3', 'Oppo A5 (2020)', 'Realme 5', 'Realme 5s', 'Realme 5i', 'Realme Narzo 10A', 'Realme Narzo 20A'].forEach(n => assert.equal(member(p, n).state, 'existing', n));
  assert.equal(member(p, 'Oppo A9 (2020)').state, 'conflict');
  assert.equal(member(p, 'Oppo A9 (2020)').currentGroupId, 'cd-0235');
  assert.equal(member(p, 'Oppo A31').state, 'needs_review', '"Oppo a31 2020": the record has no year in its name');
  assert.equal(p.proposedAction, 'CONFLICT_REVIEW', 'one model of a one-model group is not a merge');
  assert.equal(p.counts.add, 0);

  const before = production(fake);
  await review.proposalMemberDecision({ candidateId: p.candidateId, memberKey: member(p, 'Oppo A9 (2020)').key, decision: 'reassign_request', admin: ADMIN, now: clock() });
  await review.proposalSelectModel({ candidateId: p.candidateId, memberKey: member(p, 'Oppo A31').key, modelId: id('Oppo A31'), admin: ADMIN, now: clock() });
  p = fresh(fake, p);
  assert.equal(member(p, 'Oppo A31').state, 'existing');
  assert.equal(member(p, 'Oppo A31').matchStatus, 'Selected by admin');
  assert.equal(p.conflict, null);

  const out = await review.approveProposal({ candidateId: p.candidateId, admin: ADMIN, now: clock() });
  assert.equal(out.outcome, 'pending_master');
  assert.deepEqual(out.requests, [{ type: 'reassign', modelId: id('Oppo A9 (2020)'), modelName: nameOf(id('Oppo A9 (2020)')), fromGroupId: 'cd-0235', toGroupId: 'cd-0679' }]);
  assert.equal(production(fake), before, 'the model was NOT moved: moving it is a change to the master catalogue');
  const request = fake.all(C.APPROVED_COMPATIBILITIES)[0];
  assert.equal(request.kind, 'master_change_request');
  assert.equal(request.status, 'approved_pending_master');
});

/* ================================================== new groups and no change */

const batteryPost = text => ({ p1: { text, confidence: 0.95 } });

test('a list whose models have no group is a NEW GROUP proposal — recorded on approval, never created here', async () => {
  const fake = world();
  const text = 'Samsung A15 Battery\nCompatible with:\nSamsung A15\nSamsung A15 5G\nSamsung A25';
  const media = fakeMedia({ ocr: batteryPost(text) });
  await runJob('https://www.instagram.com/battery_house/', { cfg: cfg(), graph: fakeGraph({ battery_house: [[post(1, { caption: 'New stock' })]] }), media, ai: noAi });
  const p = proposalsOf(fake)[0];
  assert.equal(p.categoryId, 'battery');
  assert.equal(p.proposedAction, 'CREATE_NEW_GROUP');
  assert.equal(p.reviewSection, 'new_groups');
  assert.equal(p.target.mode, 'new');
  assert.equal(p.duplicateCheck, 'PASSED');
  assert.equal(p.proposedMaster.modelId, id('Samsung Galaxy A15'), 'the master is the product the post names');
  assert.equal(p.proposedMaster.reason, 'the product the post names');
  assert.equal(p.counts.add, 3);
  assert.equal(p.confidence.band, 'high');
  assert.equal(p.evidence.source, 'ocr');

  const before = production(fake);
  const out = await review.approveProposal({ candidateId: p.candidateId, admin: ADMIN, now: clock() });
  assert.equal(out.outcome, 'pending_build');
  assert.equal(production(fake), before, 'a group needs a part code and a serial: production is untouched');
  const entry = fake.all(C.APPROVED_COMPATIBILITIES)[0];
  assert.equal(entry.kind, 'new_group');
  assert.equal(entry.status, 'approved_pending_build');
  assert.equal(entry.masterModelId, id('Samsung Galaxy A15'));
  assert.equal(entry.memberIds.length, 3);
});

test('MASTER MODEL REVIEW REQUIRED: with no product title the master is not guessed, and approval waits', async () => {
  const fake = world();
  const text = 'Compatible models:\nSamsung A15\nSamsung A15 5G\nSamsung A25';
  const media = fakeMedia({ ocr: batteryPost(text) });
  await runJob('https://www.instagram.com/battery_house/', { cfg: cfg(), graph: fakeGraph({ battery_house: [[post(1, { caption: 'Battery' })]] }), media, ai: noAi });
  let p = proposalsOf(fake)[0];
  assert.equal(p.proposedAction, 'CREATE_NEW_GROUP');
  assert.equal(p.masterReviewRequired, true);
  assert.equal(p.proposedMaster, null, 'not "Samsung A15" just because it was listed first');
  assert.ok(p.actionReasons.some(r => /MASTER MODEL REVIEW REQUIRED/.test(r)));

  await assert.rejects(() => review.approveProposal({ candidateId: p.candidateId, admin: ADMIN, acknowledgeLowConfidence: true, now: clock() }),
    e => e.code === 'master-review-required');
  await assert.rejects(() => review.proposalSetMaster({ candidateId: p.candidateId, modelId: id('Vivo Y20'), admin: ADMIN, now: clock() }),
    e => e.code === 'not-a-member', 'the master is one of the group\'s own models');
  await review.proposalSetMaster({ candidateId: p.candidateId, modelId: id('Samsung Galaxy A25'), admin: ADMIN, now: clock() });
  p = fresh(fake, p);
  assert.equal(p.proposedMaster.modelId, id('Samsung Galaxy A25'));
  assert.equal(p.proposedMaster.reason, 'chosen by an admin');
  const out = await review.approveProposal({ candidateId: p.candidateId, admin: ADMIN, acknowledgeLowConfidence: true, now: clock() });
  assert.equal(out.outcome, 'pending_build');
});

test('a list an existing group already holds is NO_CHANGE: kept as evidence, nothing queued', async () => {
  const fake = world();
  const text = 'Vivo Y20 Combo\nCompatible with:\nVivo Y20\nVivo Y20a\nVivo Y20g\nVivo Y12s';
  const media = fakeMedia({ ocr: batteryPost(text) });
  const job = await runJob('https://www.instagram.com/combo_shop/', { cfg: cfg(), graph: fakeGraph({ combo_shop: [[post(1, { caption: 'Combo' })]] }), media, ai: noAi });
  const p = proposalsOf(fake)[0];
  assert.equal(p.proposedAction, 'NO_CHANGE');
  assert.equal(p.status, 'duplicate');
  assert.equal(p.duplicateReason, 'already_existing');
  assert.equal(p.reviewSection, 'duplicates');
  assert.equal(job.counts.pendingReview, 0);
  assert.ok(fake.read(C.COMPATIBILITY_EVIDENCE + '/' + p.candidateId), 'the source is kept as evidence for the group');
});

test('a list with a model the group lacks is an UPDATE: add it, keep the rest, nothing removed', async () => {
  const fake = world();
  const text = 'Vivo Y20 Combo\nCompatible with:\nVivo Y20\nVivo Y20a\nVivo Y20i\nVivo Y20t';
  const media = fakeMedia({ ocr: batteryPost(text) });
  await runJob('https://www.instagram.com/combo_shop/', { cfg: cfg(), graph: fakeGraph({ combo_shop: [[post(1, { caption: 'Combo' })]] }), media, ai: noAi });
  const p = proposalsOf(fake)[0];
  assert.equal(p.proposedAction, 'UPDATE_EXISTING_GROUP');
  assert.equal(p.reviewSection, 'group_updates');
  assert.deepEqual(p.members.filter(m => m.state === 'add').map(m => m.match.modelName).sort(), [nameOf(id('Vivo Y20i')), nameOf(id('Vivo Y20t'))].sort());
  assert.equal(p.target.memberNames.length, 7, 'the group\'s current members are on the card');
  assert.equal(p.confidence.band, 'high');

  /* the same list from a second page corroborates the first proposal */
  await runJob('https://www.instagram.com/combo_wholesale/', { cfg: cfg(), graph: fakeGraph({ combo_wholesale: [[post(2, { caption: 'Combo' })]] }),
    media: fakeMedia({ ocr: { p2: { text, confidence: 0.95 } } }), ai: noAi });
  const second = proposalsOf(fake).find(x => x.sourceKey === 'ig_combo_wholesale');
  assert.equal(second.status, 'duplicate');
  assert.equal(second.duplicateReason, 'same_claim_pending');
  assert.equal(second.duplicateOf, p.candidateId);
  assert.equal(fresh(fake, p).corroborations, 1);

  const out = await review.approveProposal({ candidateId: p.candidateId, admin: ADMIN, expectedAdd: 2, now: clock() });
  assert.equal(out.outcome, 'applied');
  assert.equal(fake.read('groupDetails/cd-0678').memberCount, 9);
  assertOneGroupPerCategory(fake);
  assert.equal(fake.read(C.INSTAGRAM_EXTRACTIONS + '/' + p.extractionId).proposalStatus[p.candidateId], 'approved');
});

test('an admin can add a catalogue model to a proposal, choose the target group, and change the category', async () => {
  const fake = world();
  const text = 'Vivo Y20 Combo\nCompatible with:\nVivo Y20\nVivo Y20a\nVivo Y20i';
  await runJob('https://www.instagram.com/combo_shop/', { cfg: cfg(), graph: fakeGraph({ combo_shop: [[post(1, { caption: 'Combo' })]] }),
    media: fakeMedia({ ocr: batteryPost(text) }), ai: noAi });
  let p = proposalsOf(fake)[0];

  await assert.rejects(() => review.proposalAddModel({ candidateId: p.candidateId, modelId: 'vivo-y9999', admin: ADMIN, now: clock() }), e => e.code === 'unknown-model');
  await review.proposalAddModel({ candidateId: p.candidateId, modelId: id('Vivo Y20t'), admin: ADMIN, now: clock() });
  p = fresh(fake, p);
  assert.equal(member(p, 'Vivo Y20t').state, 'add');
  assert.equal(member(p, 'Vivo Y20t').addedBy, ADMIN.uid);
  assert.equal(member(p, 'Vivo Y20t').evidence[0].source, 'manual', 'labelled as added by a person, not read from Instagram');

  /* adding a model another group holds does not slip past the rule */
  await review.proposalAddModel({ candidateId: p.candidateId, modelId: id('Vivo Y36'), admin: ADMIN, now: clock() });
  p = fresh(fake, p);
  assert.equal(member(p, 'Vivo Y36').state, 'conflict');
  assert.equal(p.proposedAction, 'CONFLICT_REVIEW');

  await assert.rejects(() => review.proposalSetTarget({ candidateId: p.candidateId, groupId: 'cd-9999', admin: ADMIN, now: clock() }), e => e.code === 'unknown-group');
  await review.proposalSetTarget({ candidateId: p.candidateId, groupId: 'new', admin: ADMIN, now: clock() });
  p = fresh(fake, p);
  assert.equal(p.target.mode, 'new');
  assert.equal(member(p, 'Vivo Y20').state, 'conflict', 'as a NEW group, the models already in cd-0678 are the conflict');

  await assert.rejects(() => review.proposalChangeCategory({ candidateId: p.candidateId, categoryId: 'camera-glass', admin: ADMIN, now: clock() }), e => e.code === 'unknown-category');
  await review.proposalChangeCategory({ candidateId: p.candidateId, categoryId: 'battery', admin: ADMIN, now: clock() });
  p = fresh(fake, p);
  assert.equal(p.categoryId, 'battery');
  assert.equal(p.target.mode, 'new', 'no listed model has a battery group in this world');
  assert.equal(p.counts.conflict, 0);
  assert.ok(p.history.some(h => h.action === 'category_changed' && h.byEmail === ADMIN.email), 'every edit is in the proposal\'s history');
});

/* ======================================================= what the API withheld */

test('a reel whose video Instagram withheld is not skipped: it waits for evidence, and an admin can supply it', async () => {
  const fake = world();
  const withheld = reel(7, { caption: 'Universal combo ...', media_url: undefined });
  const media = fakeMedia();
  const job = await runJob('https://www.instagram.com/sk_mobile_doctar/', { cfg: cfg(), graph: fakeGraph({ sk_mobile_doctar: [[withheld]] }), media, ai: noAi });
  assert.equal(job.counts.insufficient, 1);
  let x = fake.all(C.INSTAGRAM_EXTRACTIONS)[0];
  assert.equal(x.relevance, 'INSUFFICIENT_EVIDENCE');
  assert.deepEqual(x.filters, ['all', 'needs_review'], 'listed for a person, not ignored');
  assert.match(x.relevanceReason, /video could not be read/);
  assert.equal(candidatesOf(fake).length, 0, 'and nothing was invented from the caption');

  /* the admin watches the reel and attaches a screenshot of the list */
  const shot = Buffer.from('screenshot-of-scene-3');
  const evidenceMedia = fakeMedia({ byBytes: { [shot.toString()]: { text: SCENE_VIVO_TITLE, confidence: 0.9 } } });
  const before = production(fake);
  const out = await jobs.addEvidence({
    contentKey: 'igm_r7', admin: ADMIN, now: clock(),
    images: [{ bytes: shot, mimeType: 'image/jpeg', preview: 'data:image/jpeg;base64,AAAA', note: 'frame at 0:11' }],
    deps: { cfg: cfg(), media: evidenceMedia, ai: noAi, clock }
  });
  assert.equal(out.ok, true);
  assert.equal(out.analysed, true);
  assert.equal(out.relevance, 'RELEVANT_COMPATIBILITY');
  assert.equal(out.proposals, 1);
  assert.equal(out.added[0].status, 'read');

  const content = fake.read(C.INSTAGRAM_CONTENT + '/igm_r7');
  assert.equal(content.latestVersion, 2, 'new evidence is a new version, never an overwrite');
  assert.equal(content.manualEvidence.length, 1);
  assert.equal(content.manualEvidence[0].addedByEmail, ADMIN.email);
  assert.equal(await jobs.evidencePreview(content.manualEvidence[0].id), 'data:image/jpeg;base64,AAAA');

  const p = proposalsOf(fake)[0];
  const versions = fake.all(C.INSTAGRAM_EXTRACTIONS).sort((a, b) => a.version - b.version);
  assert.deepEqual(versions[0].filters, [], 'version 1 leaves every tab…');
  assert.equal(versions[0].supersededBy, versions[1].extractionId, '…and points at what replaced it');
  assert.deepEqual(versions[1].filters.slice().sort(), ['all', 'group_updates', 'relevant']);
  assert.equal(p.target.groupId, 'cd-0678');
  assert.equal(p.proposedAction, 'UPDATE_EXISTING_GROUP', 'the Y20i is not in the group yet');
  assert.equal(member(p, 'Vivo Y20i').evidence[0].ref, 'evidence:' + content.manualEvidence[0].id, 'traceable to the screenshot it came from');
  assert.equal(p.contentVersion, 2);
  const evidenceJob = fake.read(C.INSTAGRAM_IMPORT_JOBS + '/' + out.jobId);
  assert.equal(evidenceJob.mode, 'evidence');
  assert.equal(evidenceJob.status, 'completed');
  assert.equal(fake.read(C.INSTAGRAM_SOURCES + '/ig_sk_mobile_doctar').stats.relevant, 1, 'the source\'s counters MOVE: one item, one bucket');
  assert.equal(fake.read(C.INSTAGRAM_SOURCES + '/ig_sk_mobile_doctar').stats.needsReview, 0);
  assert.equal(production(fake), before, 'evidence is evidence: production waits for approval');

  /* typed text works without any OCR at all */
  const typed = await jobs.addEvidence({ contentKey: 'igm_r7', admin: ADMIN, now: clock(), text: SCENE_REALME,
    deps: { cfg: cfg({ ocrProvider: 'none' }), media: fakeMedia(), ai: noAi, clock } });
  assert.equal(typed.proposals, 2);
  assert.equal(fake.read(C.INSTAGRAM_CONTENT + '/igm_r7').latestVersion, 3);
  assert.equal(proposalsOf(fake).filter(c => c.status === 'pending').length, 2, 'version 2\'s proposal was superseded by version 3\'s');
});

test('content that could not be read is read again once a provider exists — "unchanged" never hides it', async () => {
  const fake = world();
  const text = 'Vivo Y20 Combo\nCompatible with:\nVivo Y20\nVivo Y20a\nVivo Y20i';
  const graph = fakeGraph({ combo_shop: [[post(1, { caption: 'New stock' })]] });
  const first = await runJob('https://www.instagram.com/combo_shop/', { cfg: cfg({ ocrProvider: 'none' }), graph, media: fakeMedia(), ai: noAi });
  assert.equal(first.counts.insufficient, 1);
  assert.deepEqual(fake.all(C.INSTAGRAM_EXTRACTIONS)[0].filters, ['all', 'errors'], 'a caption that decides nothing + unread media is a reading failure');

  const again = await runJob('https://www.instagram.com/combo_shop/', { cfg: cfg({ ocrProvider: 'none' }), graph, media: fakeMedia(), ai: noAi });
  assert.equal(again.counts.unchanged, 1, 'same providers: nothing is spent on it twice');

  const media = fakeMedia({ ocr: batteryPost(text) });
  const third = await runJob('https://www.instagram.com/combo_shop/', { cfg: cfg({ ocrProvider: 'gateway' }), graph, media, ai: noAi });
  assert.equal(third.counts.unchanged, 0);
  assert.equal(third.counts.relevant, 1);
  assert.deepEqual(media.calls.ocr, ['p1']);
  assert.equal(proposalsOf(fake).length, 1);
});

/* ================================================================ AI vision

   The provider clients, screening, video passes, budgets and the second
   opinion are in instagram-cost.test.js. */

test('a reel with no video but a cover: the cover is read, the list is used, and the reel still counts as not fully read', async () => {
  const fake = world();
  const seen = [];
  const media = {
    ocrImage: async () => ({ status: 'unavailable', reason: 'No OCR provider is configured.' }),
    analyzeVideo: async () => ({ status: 'unavailable', reason: 'Instagram returned no media URL for this video.', frames: [], transcript: null }),
    understandImage: async ({ mediaId, mediaUrl }) => {
      seen.push([mediaId, mediaUrl]);
      return { status: 'ok', engine: 'claude:test', contentClass: 'compatibility', product: 'display combo', headline: 'Vivo Y20 Combo',
               models: ['Vivo Y20', 'Vivo Y20a', 'Vivo Y20i'], text: '' };
    }
  };
  const withCover = reel(4, { caption: 'Universal combo ...', media_url: undefined, thumbnail_url: 'https://cdn/r4-cover.jpg' });
  const job = await runJob('https://www.instagram.com/sk_mobile_doctar/', {
    cfg: cfg({ ocrProvider: 'none', visionProvider: 'anthropic', anthropicKey: 'test-only-anthropic-key-not-real' }),
    graph: fakeGraph({ sk_mobile_doctar: [[withCover]] }), media, ai: noAi
  });
  assert.deepEqual(seen, [['r4:cover', 'https://cdn/r4-cover.jpg']], 'vision is asked about the cover, once');
  assert.equal(job.counts.relevant, 1);
  const p = proposalsOf(fake)[0];
  assert.equal(p.proposedAction, 'UPDATE_EXISTING_GROUP');
  assert.equal(member(p, 'Vivo Y20i').evidence[0].ref, 'r4:cover');
  const content = fake.read(C.INSTAGRAM_CONTENT + '/igm_r4');
  assert.equal(content.mediaItems[0].ocrStatus, 'partial', 'a cover is one frame: the video itself was not read');
  assert.equal(content.mediaComplete, false, 'so it is read again when a video processor exists');
});

/* ============================================================== Instagram API */

test('Business Discovery is asked for reel covers once; if Meta rejects the field it is dropped, not worked around', async () => {
  const urls = [];
  const media = [{ id: 'r1', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/AAAAA1/', caption: 'Universal combo' }];
  const answer = (body, ok = true, status = 200) => ({ ok, status, headers: { get: () => null }, json: async () => body });
  let supported = false;
  const fetchImpl = async url => {
    const fields = new URL(url).searchParams.get('fields');
    urls.push(fields);
    if (/thumbnail_url/.test(fields) && !supported) {
      return answer({ error: { code: 100, message: '(#100) Tried accessing nonexisting field (thumbnail_url) on node type (Media)' } }, false, 400);
    }
    return answer({ business_discovery: { id: '1', username: 'shop', media: { data: media.map(m => Object.assign({}, m, supported ? { thumbnail_url: 'https://cdn/cover.jpg' } : {})) } } });
  };
  const client = createGraphClient({ token: 't', igUserId: '17841400000000000', fetchImpl });
  const page = await client.discoverPage('shop', { limit: 25 });
  assert.equal(page.media[0].thumbnailUrl, null);
  assert.equal(page.media[0].mediaUrlOmitted, true);
  assert.equal(client.coverFieldSupported(), false);
  assert.equal(urls.length, 2, 'one refused call, then the documented field list');
  await client.discoverPage('shop', { limit: 25 });
  assert.equal(urls.length, 3, 'and never asked again by this client');
  assert.ok(!/thumbnail_url/.test(urls[2]));

  supported = true;
  const withCover = createGraphClient({ token: 't', igUserId: '17841400000000000', fetchImpl });
  assert.equal((await withCover.discoverPage('shop', { limit: 25 })).media[0].thumbnailUrl, 'https://cdn/cover.jpg');
  const remembered = createGraphClient({ token: 't', igUserId: '17841400000000000', fetchImpl, coverField: false });
  await remembered.discoverPage('shop', { limit: 25 });
  assert.ok(!/thumbnail_url/.test(urls[urls.length - 1]), 'a job remembers the answer across ticks');
});

/* ================================================= the other way in: the build */

test('the catalogue build names every device that sits in two groups of one category, and the real build has none', () => {
  const { findDuplicateAssignments } = require('../../scripts/build-dataset');
  const bad = new Map([
    ['samsung-galaxy-a14', { 'screen-guards': ['sg-0001', 'sg-0002'], 'back-cover': ['bc-0001'] }],
    ['samsung-galaxy-a15', { 'screen-guards': ['sg-0002'] }],
    ['samsung-galaxy-a16', { 'screen-guards': ['sg-0003', 'sg-0003'] }]
  ]);
  assert.deepEqual(findDuplicateAssignments(bad), [{ modelId: 'samsung-galaxy-a14', categoryId: 'screen-guards', groupIds: ['sg-0001', 'sg-0002'] }],
    'the same group listed twice is not two groups');

  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', '..', 'data', 'build', 'modelGroups.ndjson');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(findDuplicateAssignments(rows), [], 'one category + one model = one group, in the catalogue that is live');
  const importer = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'import-firestore.js'), 'utf8');
  assert.match(importer, /guardOneGroupPerCategory\(\);/, 'and the importer checks it before anything is published');
});

/* ============================================================ the planner */

test('the planner: a tie between groups chooses none; the catalogue being absent blocks everything', () => {
  const m = (name, extra) => Object.assign({ key: 'm:' + id(name), text: name, match: taxonomy.matchModel(name) }, extra);
  const membership = new Map([[id('Vivo Y20'), ['cd-1']], [id('Vivo Y20a'), ['cd-1']], [id('Vivo Y36'), ['cd-2']], [id('Vivo Y33s'), ['cd-2']]]);
  const members = () => ['Vivo Y20', 'Vivo Y20a', 'Vivo Y36', 'Vivo Y33s'].map(n => m(n));
  const tie = groupProposals.plan({ categoryId: 'combo-display', headline: null, members: members(), imported: true, membership, groups: new Map() });
  assert.equal(tie.target.mode, 'undecided');
  assert.equal(tie.proposedAction, 'CONFLICT_REVIEW');
  assert.equal(tie.conflict.active, true);

  const groups = new Map([['cd-1', { groupId: 'cd-1', groupNo: 'CD-1', memberCount: 2 }], ['cd-2', { groupId: 'cd-2', groupNo: 'CD-2', memberCount: 2 }]]);
  const chosen = groupProposals.plan({ categoryId: 'combo-display', headline: null, members: members(), imported: true, membership, groups, targetOverride: 'cd-1' });
  assert.equal(chosen.target.groupId, 'cd-1');
  assert.equal(chosen.proposedAction, 'MERGE_REQUIRED', 'the list holds ALL of cd-2: the post says the two groups are one part');
  groups.get('cd-2').memberCount = 40;
  const partial = groupProposals.plan({ categoryId: 'combo-display', headline: null, members: members(), imported: true, membership, groups, targetOverride: 'cd-1' });
  assert.equal(partial.proposedAction, 'CONFLICT_REVIEW', 'two models of a forty-model group is a conflict, not a merge');

  const noCatalogue = groupProposals.plan({ categoryId: 'combo-display', headline: null, members: members(), imported: false, membership: new Map(), groups: new Map() });
  assert.equal(noCatalogue.proposedAction, 'CONFLICT_REVIEW');
  assert.match(noCatalogue.actionReasons[0], /not in Firestore/);

  const noCategory = groupProposals.plan({ categoryId: null, headline: null, members: members(), imported: true, membership, groups: new Map() });
  assert.equal(noCategory.proposedAction, 'PRODUCT_CATEGORY_REVIEW');
  assert.equal(S.reviewSectionFor({ kind: 'group_proposal', status: 'pending', proposedAction: 'PRODUCT_CATEGORY_REVIEW' }), 'review');

  const weak = groupProposals.plan({ categoryId: 'combo-display', headline: null, imported: true, membership: new Map(), groups: new Map(),
    members: [m('Vivo Y20'), { key: 't:xyz 999', text: 'XYZ 999', match: taxonomy.matchModel('XYZ 999') }, { key: 't:xyz 1000', text: 'XYZ 1000', match: taxonomy.matchModel('XYZ 1000') }] });
  assert.equal(weak.proposedAction, 'MODEL_REVIEW', 'one resolved model is not a group');
});
