/* ============================================================================
   api/_lib/instagram-pipeline.test.js
   ----------------------------------------------------------------------------
   The whole importer, end to end, against an in-memory Firestore and the
   REAL catalogue: create a job, discover, OCR, extract, match, dedupe,
   detect conflicts, review, approve into production — and every way the
   production fitment data is protected while that happens.

   Instagram, OCR and the AI are fakes that return fixed content. The
   catalogue, the taxonomy matcher, the extractor, the candidate builder,
   the job runner and the approval transaction are the real code.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeFirestore } = require('./testing/fake-firestore');
const fsx = require('../_services/instagram/firestore');
const jobs = require('../_services/instagram/job-service');
const review = require('../_services/instagram/review-service');
const configMod = require('../_services/instagram/config');
const { normaliseMedia, GraphError } = require('../_services/instagram/graph-client');
const C = require('../_schema/collections');

const ADMIN = { uid: 'ownerUid000001', email: 'stark.ai.india@gmail.com', role: 'super_admin' };
const NOW = Date.UTC(2026, 8, 30, 6, 0);

/* "Send to Missing models" reuses the existing missing-model-service, which
   reads the shared Firebase handle; point that at the same in-memory store. */
const firebaseLib = require('./firebase');
let currentFake = null;
firebaseLib.db = () => currentFake.db;

/* ------------------------------------------------------------- fixtures */

function world({ imported = true } = {}) {
  const fake = createFakeFirestore();
  fsx.use(fake.provider);
  currentFake = fake;
  if (imported) {
    fake.seed('catalog/meta', { version: 1789052260911 });
    /* Galaxy A15 and A25 share screen guard group sg-0100; A15 5G has none. */
    fake.seed('modelGroups/samsung-galaxy-a15', { id: 'samsung-galaxy-a15', byCategory: { 'screen-guards': ['sg-0100'] } });
    fake.seed('modelGroups/samsung-galaxy-a25', { id: 'samsung-galaxy-a25', byCategory: { 'screen-guards': ['sg-0100'] } });
    fake.seed('groupDetails/sg-0100', {
      groupNo: 'SG-0100', categoryId: 'screen-guards', partCode: 'MPF-SG-0100',
      memberIds: ['samsung-galaxy-a15', 'samsung-galaxy-a25'],
      memberNames: ['Samsung Galaxy A15', 'Samsung Galaxy A25'], memberCount: 2
    });
    fake.seed('groups/sg-0100', { groupNo: 'SG-0100', categoryId: 'screen-guards', memberCount: 2 });
    /* Redmi 13C and POCO C65 are in DIFFERENT combo groups. */
    fake.seed('modelGroups/xiaomi-redmi-13c', { id: 'xiaomi-redmi-13c', byCategory: { 'combo-display': ['cd-0200'] } });
    fake.seed('modelGroups/xiaomi-poco-c65', { id: 'xiaomi-poco-c65', byCategory: { 'combo-display': ['cd-0300'] } });
  }
  return fake;
}

function cfg(over) {
  return Object.assign(configMod.load(), {
    graph: { token: 'test-token', igUserId: '17841400000000000', version: 'v25.0', timeoutMs: 1000, appSecret: '' },
    ocrProvider: 'gateway', videoProvider: 'gateway', transcribe: true, aiMode: 'off',
    maxItemsPerJob: 50, maxDiscoveryPages: 5, pageSize: 25, maxFramesPerVideo: 8, maxCarouselChildren: 10,
    maxAttempts: 3, tickBudgetMs: 10 * 60 * 1000, leaseMs: 60000,
    dailyGraphCalls: 1000, dailyOcrCalls: 1000, dailyAiCalls: 1000, dailyVideoCalls: 1000
  }, over || {});
}

const RAW = {
  m1: { id: 'm1', media_type: 'IMAGE', media_url: 'https://cdn/m1.jpg', permalink: 'https://www.instagram.com/p/AAAAA1/', timestamp: '2026-09-01T10:00:00+0000',
        caption: 'Samsung A15 Tempered Glass\nCompatible: Samsung A15 / Samsung A15 5G' },
  m2: { id: 'm2', media_type: 'IMAGE', media_url: 'https://cdn/m2.jpg', permalink: 'https://www.instagram.com/p/BBBBB2/', timestamp: '2026-09-02T10:00:00+0000',
        caption: 'Samsung new arrivals 🔥' },
  m3: { id: 'm3', media_type: 'VIDEO', media_product_type: 'REELS', media_url: 'https://cdn/m3.mp4', permalink: 'https://www.instagram.com/reel/CCCCC3/', timestamp: '2026-09-03T10:00:00+0000',
        caption: '' },
  m4: { id: 'm4', media_type: 'CAROUSEL_ALBUM', permalink: 'https://www.instagram.com/p/DDDDD4/', timestamp: '2026-09-04T10:00:00+0000',
        caption: 'Battery stock', children: { data: [{ id: 'm4a', media_type: 'IMAGE', media_url: 'https://cdn/m4a.jpg' }, { id: 'm4b', media_type: 'IMAGE', media_url: 'https://cdn/m4b.jpg' }] } },
  m5: { id: 'm5', media_type: 'IMAGE', media_url: 'https://cdn/m5.jpg', permalink: 'https://www.instagram.com/p/EEEEE5/', timestamp: '2026-09-05T10:00:00+0000',
        caption: 'iPhone 13 / 13 Pro Back Cover' }
};

const OCR = {
  m2: { text: 'A25 GLASS\nCOMPATIBLE: A15 / A25', confidence: 0.95 },
  m4a: { text: 'XYZ 999 battery fits XYZ 1000', confidence: 0.9 },
  m4b: { text: '', confidence: null }
};
const VIDEO = { m3: { frames: [{ timeMs: 0, text: 'Redmi 13C combo same as POCO C65', confidence: 0.92 }], transcript: null } };

function fakeGraph(pagesByUser, { own = 'mpf_official' } = {}) {
  const calls = { own: 0, discover: 0 };
  return {
    calls,
    configured: () => true,
    ownProfile: async () => { calls.own++; return { username: own, name: 'MPF', followersCount: 10, mediaCount: 0 }; },
    ownMediaPage: async () => ({ media: [], nextCursor: null }),
    discoverPage: async (username, { after }) => {
      calls.discover++;
      const pages = pagesByUser[username];
      if (!pages) throw new GraphError('not_collectable', `@${username} cannot be read through Business Discovery (personal or private).`);
      const i = after ? Number(after) : 0;
      if (pages[i] instanceof Error) throw pages[i];
      return {
        profile: { username, name: username, followersCount: 250000, mediaCount: 99, accountType: 'professional' },
        media: pages[i].map(raw => normaliseMedia(raw)),
        nextCursor: i + 1 < pages.length ? String(i + 1) : null
      };
    }
  };
}

function fakeMedia({ ocr = OCR, video = VIDEO, failFor = {} } = {}) {
  const calls = { ocr: [], video: [] };
  return {
    calls,
    ocrImage: async ({ mediaId }) => {
      calls.ocr.push(mediaId);
      if (failFor[mediaId] && failFor[mediaId]-- > 0) throw new Error('OCR provider timed out');
      const r = ocr[mediaId];
      return r ? { status: 'ok', text: r.text, confidence: r.confidence, engine: 'fake-ocr', bytesHash: 'hash_' + mediaId } : { status: 'unavailable', reason: 'no text' };
    },
    analyzeVideo: async ({ mediaId }) => {
      calls.video.push(mediaId);
      const r = video[mediaId];
      return r ? Object.assign({ status: 'ok', engine: 'fake-video' }, r) : { status: 'unavailable', reason: 'none', frames: [], transcript: null };
    }
  };
}

const noAi = { isConfigured: () => false, status: () => ({ model: null, missing: ['AI_GATEWAY_URL'] }), invoke: async () => ({ ok: false, reason: 'ai-unconfigured' }) };

let clockT = NOW;
const clock = () => (clockT += 3);

async function runJob(profileUrl, deps, extra = {}) {
  const created = await jobs.createJob(Object.assign({ admin: ADMIN, profileUrl, now: clock(), deps }, extra));
  assert.equal(created.ok, true, created.error);
  let out = { job: created.job };
  for (let i = 0; i < 20 && ['queued', 'discovering', 'processing'].indexOf(out.job.status) > -1; i++) {
    out = await jobs.tick({ jobId: created.job.jobId, workerId: 'test', deps: Object.assign({ clock }, deps) });
  }
  return out.job;
}

function candidatesOf(fake) { return fake.all(C.COMPATIBILITY_CANDIDATES); }
function productionSnapshot(fake) {
  return JSON.stringify(['catalog/meta', 'groupDetails/', 'groups/', 'modelGroups/']
    .map(p => fake.paths(p).sort().map(k => [k, fake.read(k)])));
}
const find = (list, pred) => list.find(pred);
const rel = (c, a, b) => c.kind === 'relationship' && c.sourceMatch && c.compatibleMatch &&
  [c.sourceMatch.modelId, c.compatibleMatch.modelId].sort().join('|') === [a, b].sort().join('|');

/* ============================================================ collection */

test('without API credentials the job says "Unable to collect" and collects nothing', async () => {
  const fake = world();
  const out = await jobs.createJob({ admin: ADMIN, profileUrl: 'https://www.instagram.com/mobile_parts_hub/', now: NOW,
    deps: { cfg: cfg({ graph: { token: '', igUserId: '' } }) } });
  assert.equal(out.ok, true);
  assert.equal(out.job.status, 'unable_to_collect');
  assert.match(out.job.statusReason, /INSTAGRAM_GRAPH_ACCESS_TOKEN/);
  assert.match(out.job.statusReason, /Nothing was collected/);
  assert.equal(fake.paths(C.INSTAGRAM_IMPORT_JOBS + '/' + out.job.jobId + '/items').length, 0);
  assert.equal(fake.read(C.INSTAGRAM_SOURCES + '/ig_mobile_parts_hub').accessStatus, 'unable_to_collect');
  const ticked = await jobs.tick({ jobId: out.job.jobId, workerId: 't', deps: { cfg: cfg(), clock } });
  assert.equal(ticked.ok, false, 'a job that could not collect cannot be ticked into "collecting"');
});

test('a personal or private account is reported as not collectable — no bypass, no fabricated content', async () => {
  const fake = world();
  const deps = { cfg: cfg(), graph: fakeGraph({}), media: fakeMedia(), ai: noAi };
  const job = await runJob('https://www.instagram.com/private_person/', deps);
  assert.equal(job.status, 'unable_to_collect');
  assert.match(job.statusReason, /Unable to collect/);
  assert.equal(job.counts.postsFound, 0);
  assert.equal(candidatesOf(fake).length, 0);
});

/* ======================================================= the full import */

test('a page import: discovery, OCR, key frames, extraction, matching, dedupe, conflicts, review queue', async () => {
  const fake = world();
  const media = fakeMedia();
  const graph = fakeGraph({ mobile_parts_hub: [[RAW.m1, RAW.m2, RAW.m3], [RAW.m4, RAW.m5]] });
  const deps = { cfg: cfg(), graph, media, ai: noAi };
  const job = await runJob('https://www.instagram.com/mobile_parts_hub/', deps);

  assert.equal(job.status, 'completed');
  assert.equal(job.collectionMethod, 'graph_business_discovery');
  assert.equal(job.counts.postsFound, 5);
  assert.equal(job.counts.imagesFound, 3);
  assert.equal(job.counts.videosFound, 1);
  assert.equal(job.counts.carouselsFound, 1);
  assert.equal(job.counts.processed, 5);
  assert.equal(job.counts.framesProcessed, 1);
  assert.deepEqual(media.calls.ocr.sort(), ['m1', 'm2', 'm4a', 'm4b', 'm5'], 'each carousel image is read on its own');
  assert.deepEqual(media.calls.video, ['m3']);

  const cands = candidatesOf(fake);

  /* m1: explicit, exact matches, caption evidence, A15 grouped / A15 5G not */
  const a15 = find(cands, c => rel(c, 'samsung-galaxy-a15', 'samsung-galaxy-a15-5g'));
  assert.ok(a15, 'A15 <-> A15 5G');
  assert.equal(a15.categoryId, 'screen-guards');
  assert.equal(a15.compatibilityType, 'explicit');
  assert.equal(a15.confidence.band, 'high');
  assert.equal(a15.reviewSection, 'ready');
  assert.equal(a15.productionState.state, 'one_grouped');
  assert.equal(a15.sourceMatch.method, 'market_term');
  assert.equal(a15.sourcePost.permalink, 'https://www.instagram.com/p/AAAAA1/');
  assert.match(a15.extractedText, /Compatible: Samsung A15 \/ Samsung A15 5G/);

  /* m2: OCR says A15 / A25 — already one group in production */
  const a25 = find(cands, c => rel(c, 'samsung-galaxy-a15', 'samsung-galaxy-a25'));
  assert.equal(a25.status, 'duplicate');
  assert.equal(a25.duplicateReason, 'already_existing');
  assert.equal(a25.evidence.source, 'ocr');
  assert.ok(fake.read(C.COMPATIBILITY_EVIDENCE + '/' + a25.candidateId), 'the source is kept as additional evidence');

  /* m3: reel frame claims Redmi 13C = POCO C65; production says different groups */
  const combo = find(cands, c => rel(c, 'xiaomi-redmi-13c', 'xiaomi-poco-c65'));
  assert.equal(combo.reviewSection, 'conflicts');
  assert.equal(combo.conflict.type, 'production');
  assert.equal(combo.evidence.source, 'frame');

  /* m4: XYZ 999 is not in the catalogue — review, never a new model */
  const xyz = find(cands, c => c.kind === 'relationship' && /xyz/i.test(c.sourceText));
  assert.equal(xyz.reviewSection, 'unmatched');
  assert.equal(xyz.sourceMatch.modelId, null);

  /* m5: a title listing two iPhones is implied, low confidence, review */
  const iphone = find(cands, c => rel(c, 'apple-iphone-13', 'apple-iphone-13-pro'));
  assert.equal(iphone.compatibilityType, 'implied');
  assert.equal(iphone.confidence.band, 'low');
  assert.equal(iphone.reviewSection, 'review');

  const source = fake.read(C.INSTAGRAM_SOURCES + '/ig_mobile_parts_hub');
  assert.equal(source.followersCount, 250000, 'followers are stored as metadata…');
  assert.equal(a15.confidence.factors.followers, undefined, '…and are never a confidence factor');

  /* the models never grow: nothing was created in the catalogue */
  assert.equal(fake.paths('models/').length, 0);
  assert.equal(fake.paths('brands/').length, 0);
});

test('re-importing the same page processes nothing twice: no OCR, no new candidates', async () => {
  const fake = world();
  const media = fakeMedia();
  const deps = { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[RAW.m1, RAW.m2]] }), media, ai: noAi };
  await runJob('https://www.instagram.com/mobile_parts_hub/', deps);
  const before = candidatesOf(fake).length;
  const ocrBefore = media.calls.ocr.length;

  const again = await runJob('https://www.instagram.com/mobile_parts_hub/', deps);
  assert.equal(again.status, 'completed');
  assert.equal(again.counts.unchanged, 2);
  assert.equal(media.calls.ocr.length, ocrBefore, 'identical content is not sent to OCR again');
  assert.equal(candidatesOf(fake).length, before);
});

test('a changed post becomes version 2; version 1 is kept and its open candidates superseded', async () => {
  const fake = world();
  const media = fakeMedia();
  await runJob('https://www.instagram.com/mobile_parts_hub/', { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[RAW.m1]] }), media, ai: noAi });
  const edited = Object.assign({}, RAW.m1, { caption: 'Samsung A15 Tempered Glass\nCompatible: Samsung A15 / Samsung A25' });
  await runJob('https://www.instagram.com/mobile_parts_hub/', { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[edited]] }), media, ai: noAi });

  const content = fake.read(C.INSTAGRAM_CONTENT + '/igm_m1');
  assert.equal(content.latestVersion, 2);
  assert.equal(content.versions.length, 2);
  assert.ok(fake.read(C.INSTAGRAM_EXTRACTIONS + '/igm_m1__v1'), 'the old extraction is not overwritten');
  assert.ok(fake.read(C.INSTAGRAM_EXTRACTIONS + '/igm_m1__v2'));
  const v1 = candidatesOf(fake).filter(c => c.contentVersion === 1 && c.kind === 'relationship');
  assert.ok(v1.length && v1.every(c => c.status === 'superseded'));
});

/* ============================================================== approval */

test('approval writes exactly one additive change to production, with the previous value on the ledger', async () => {
  const fake = world();
  await runJob('https://www.instagram.com/mobile_parts_hub/', { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[RAW.m1]] }), media: fakeMedia(), ai: noAi });
  const a15 = find(candidatesOf(fake), c => rel(c, 'samsung-galaxy-a15', 'samsung-galaxy-a15-5g'));

  const out = await review.approve({ candidateId: a15.candidateId, admin: ADMIN, now: NOW + 1000 });
  assert.equal(out.outcome, 'applied');

  const gd = fake.read('groupDetails/sg-0100');
  assert.deepEqual(gd.memberIds, ['samsung-galaxy-a15', 'samsung-galaxy-a25', 'samsung-galaxy-a15-5g'], 'appended, nothing removed');
  assert.equal(gd.memberNames[2], 'Samsung Galaxy A15 5G', 'the name is the catalogue record\'s, not the post\'s');
  assert.equal(gd.memberCount, 3);
  assert.equal(fake.read('groups/sg-0100').memberCount, 3);
  assert.deepEqual(fake.read('modelGroups/samsung-galaxy-a15-5g').byCategory['screen-guards'], ['sg-0100']);

  const ledger = fake.read(C.APPROVED_COMPATIBILITIES + '/' + a15.relKey);
  assert.equal(ledger.status, 'applied');
  assert.equal(ledger.appliedChange.previousMemberCount, 2);
  assert.equal(ledger.appliedChange.newMemberCount, 3);
  assert.deepEqual(ledger.appliedChange.previousMemberIds, ['samsung-galaxy-a15', 'samsung-galaxy-a25']);
  assert.equal(ledger.approvedBy, ADMIN.uid);
  assert.equal(ledger.evidence[0].permalink, 'https://www.instagram.com/p/AAAAA1/');

  const cand = fake.read(C.COMPATIBILITY_CANDIDATES + '/' + a15.candidateId);
  assert.equal(cand.status, 'approved');
  assert.equal(cand.approvedBy, ADMIN.uid);
  assert.ok(cand.history.some(h => h.action === 'approved' && /2 -> 3/.test(h.note)));

  const job = fake.all(C.INSTAGRAM_IMPORT_JOBS)[0];
  assert.equal(job.counts.approved, 1);
  assert.equal(job.counts.appliedToProduction, 1);
  assert.equal(fake.read(C.INSTAGRAM_SOURCES + '/ig_mobile_parts_hub').reputation.approved, 1);

  /* approving twice is refused: approved is final */
  await assert.rejects(() => review.approve({ candidateId: a15.candidateId, admin: ADMIN, now: NOW + 2000 }), e => e.code === 'wrong-status');
});

test('the same claim from a second page is "Already Existing" and kept as evidence', async () => {
  const fake = world();
  const media = fakeMedia();
  await runJob('https://www.instagram.com/mobile_parts_hub/', { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[RAW.m1]] }), media, ai: noAi });
  const first = find(candidatesOf(fake), c => rel(c, 'samsung-galaxy-a15', 'samsung-galaxy-a15-5g'));

  /* second page, while the first is still pending */
  const copy = Object.assign({}, RAW.m1, { id: 'n1', permalink: 'https://www.instagram.com/p/NNNNN1/' });
  await runJob('https://www.instagram.com/glass_wholesale/', { cfg: cfg(), graph: fakeGraph({ glass_wholesale: [[copy]] }), media, ai: noAi });
  const second = find(candidatesOf(fake), c => c.sourceKey === 'ig_glass_wholesale' && rel(c, 'samsung-galaxy-a15', 'samsung-galaxy-a15-5g'));
  assert.equal(second.status, 'duplicate');
  assert.equal(second.duplicateReason, 'same_claim_pending');
  assert.equal(second.duplicateOf, first.candidateId);
  assert.equal(fake.read(C.COMPATIBILITY_CANDIDATES + '/' + first.candidateId).corroborations, 1);

  await review.approve({ candidateId: first.candidateId, admin: ADMIN, now: NOW + 1000 });
  const third = Object.assign({}, RAW.m1, { id: 'k1', permalink: 'https://www.instagram.com/p/KKKKK1/' });
  await runJob('https://www.instagram.com/spares_king/', { cfg: cfg(), graph: fakeGraph({ spares_king: [[third]] }), media, ai: noAi });
  const later = find(candidatesOf(fake), c => c.sourceKey === 'ig_spares_king' && rel(c, 'samsung-galaxy-a15', 'samsung-galaxy-a15-5g'));
  assert.equal(later.status, 'duplicate');
  assert.equal(later.duplicateReason, 'already_existing', 'after approval production itself has them in one group');
  const evidence = fake.all(C.COMPATIBILITY_EVIDENCE).filter(e => e.relKey === first.relKey);
  assert.equal(evidence.length, 3, 'three pages, three pieces of evidence, one relationship');
  assert.equal(fake.read('groupDetails/sg-0100').memberIds.length, 3, 'and still exactly one production change');
});

test('a contradicting source creates a Compatibility Conflict; the production data stays as it is', async () => {
  const fake = world();
  const media = fakeMedia();
  await runJob('https://www.instagram.com/mobile_parts_hub/', { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[RAW.m1]] }), media, ai: noAi });
  const yes = find(candidatesOf(fake), c => rel(c, 'samsung-galaxy-a15', 'samsung-galaxy-a15-5g'));

  const no = { id: 'x1', media_type: 'IMAGE', media_url: 'https://cdn/x1.jpg', permalink: 'https://www.instagram.com/p/XXXXX1/',
               caption: 'Samsung A15 tempered glass not compatible with Samsung A15 5G' };
  await runJob('https://www.instagram.com/other_page/', { cfg: cfg(), graph: fakeGraph({ other_page: [[no]] }), media, ai: noAi });

  const negative = find(candidatesOf(fake), c => c.polarity === 'negative');
  assert.equal(negative.reviewSection, 'conflicts');
  assert.deepEqual(negative.conflict.withCandidateIds, [yes.candidateId]);
  const yesNow = fake.read(C.COMPATIBILITY_CANDIDATES + '/' + yes.candidateId);
  assert.equal(yesNow.reviewSection, 'conflicts', 'both sides are shown together');
  assert.equal(yesNow.conflict.active, true);

  const prod = productionSnapshot(fake);
  await assert.rejects(() => review.approve({ candidateId: yes.candidateId, admin: ADMIN, now: NOW }), e => e.code === 'conflict');
  await assert.rejects(() => review.approve({ candidateId: negative.candidateId, admin: ADMIN, now: NOW }), e => e.code === 'negative-claim');
  assert.equal(productionSnapshot(fake), prod, 'neither side may be applied automatically');

  const detail = await review.getCandidate(yes.candidateId);
  assert.equal(detail.evidence.length, 2, 'the review card shows both pieces of evidence');
});

/* ============================================ rejection and manual correction */

test('rejection records the reason, the reviewer and the source\'s reputation', async () => {
  const fake = world();
  await runJob('https://www.instagram.com/mobile_parts_hub/', { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[RAW.m5]] }), media: fakeMedia(), ai: noAi });
  const iphone = find(candidatesOf(fake), c => rel(c, 'apple-iphone-13', 'apple-iphone-13-pro'));

  await assert.rejects(() => review.reject({ candidateId: iphone.candidateId, admin: ADMIN, reason: 'because', now: NOW }), e => e.code === 'bad-reason');
  await review.reject({ candidateId: iphone.candidateId, admin: ADMIN, reason: 'not_a_compatibility_claim', note: 'two different covers on one listing', now: NOW });
  const c = fake.read(C.COMPATIBILITY_CANDIDATES + '/' + iphone.candidateId);
  assert.equal(c.status, 'rejected');
  assert.equal(c.reviewSection, 'rejected');
  assert.equal(c.reviewer, ADMIN.uid);
  assert.equal(c.rejectReason, 'not_a_compatibility_claim');
  assert.equal(fake.read(C.INSTAGRAM_SOURCES + '/ig_mobile_parts_hub').reputation.rejected, 1);
  await assert.rejects(() => review.approve({ candidateId: iphone.candidateId, admin: ADMIN, now: NOW }), e => e.code === 'wrong-status');

  await review.reopen({ candidateId: iphone.candidateId, admin: ADMIN, now: NOW + 1 });
  assert.equal(fake.read(C.COMPATIBILITY_CANDIDATES + '/' + iphone.candidateId).status, 'pending');
});

test('a 4G reference needs a person to confirm the record; the choice is audited and can teach an alias', async () => {
  const fake = world();
  const post = Object.assign({}, RAW.m1, { caption: 'Samsung A15 4G Tempered Glass\nCompatible: A15 4G / A15 5G' });
  await runJob('https://www.instagram.com/mobile_parts_hub/', { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[post]] }), media: fakeMedia(), ai: noAi });
  const c = find(candidatesOf(fake), x => rel(x, 'samsung-galaxy-a15', 'samsung-galaxy-a15-5g'));
  assert.equal(c.sourceMatch.requiresVariantConfirmation, true);
  assert.equal(c.reviewSection, 'review', 'never "ready" while the variant is unconfirmed');
  await assert.rejects(() => review.approve({ candidateId: c.candidateId, admin: ADMIN, now: NOW }), e => e.code === 'variant-confirmation-required');

  await assert.rejects(() => review.selectModel({ candidateId: c.candidateId, side: 'source', modelId: 'samsung-galaxy-a15-4g-new', admin: ADMIN, now: NOW }),
    e => e.code === 'unknown-model', 'an admin cannot introduce a model either');

  const out = await review.selectModel({ candidateId: c.candidateId, side: 'source', modelId: 'samsung-galaxy-a15', rememberAlias: true, admin: ADMIN, now: NOW });
  assert.equal(out.previousModelId, 'samsung-galaxy-a15');
  assert.equal(out.alias.learned, true);
  const alias = fake.read('aliases/' + out.alias.key);
  assert.equal(alias.canonicalId, 'samsung-galaxy-a15');
  assert.equal(alias.confidence, 'verified');
  assert.equal(alias.createdBy, undefined, '/aliases is public-read: no admin identity in it (the audit log has that)');
  assert.equal(alias.candidateId, undefined);

  const edited = fake.read(C.COMPATIBILITY_CANDIDATES + '/' + c.candidateId);
  assert.equal(edited.sourceMatch.method, 'admin_selected');
  assert.ok(edited.history.some(h => h.action === 'match_edited' && h.newValue === 'samsung-galaxy-a15'));
  assert.equal(edited.reviewSection, 'ready');
  const approved = await review.approve({ candidateId: c.candidateId, admin: ADMIN, now: NOW + 5 });
  assert.equal(approved.outcome, 'applied');
});

test('an unmatched reference can be pointed at the right record, or sent to Missing models', async () => {
  const fake = world();
  const post = { id: 'u1', media_type: 'IMAGE', media_url: 'https://cdn/u1.jpg', permalink: 'https://www.instagram.com/p/UUUUU1/', caption: 'New: Galaxy A15 Prime glass, also XYZ 999 in stock' };
  await runJob('https://www.instagram.com/mobile_parts_hub/', { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[post]] }), media: fakeMedia(), ai: noAi });
  const refs = candidatesOf(fake).filter(c => c.kind === 'model_reference');
  assert.ok(refs.length >= 1);
  refs.forEach(r => assert.ok(['unmatched', 'ambiguous'].indexOf(r.reviewSection) > -1));
  const xyz = find(refs, r => /xyz/i.test(r.referenceText));
  const sent = await review.sendToMissingModels({ candidateId: xyz.candidateId, admin: ADMIN, now: NOW });
  assert.equal(fake.read(C.COMPATIBILITY_CANDIDATES + '/' + xyz.candidateId).status, 'resolved');
  assert.equal(sent.missingModelKey, 'xyz999');
});

test('change category accepts only the catalogue\'s categories', async () => {
  const fake = world();
  await runJob('https://www.instagram.com/mobile_parts_hub/', { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[RAW.m1]] }), media: fakeMedia(), ai: noAi });
  const c = find(candidatesOf(fake), x => rel(x, 'samsung-galaxy-a15', 'samsung-galaxy-a15-5g'));
  await assert.rejects(() => review.changeCategory({ candidateId: c.candidateId, categoryId: 'camera-glass', admin: ADMIN, now: NOW }), e => e.code === 'unknown-category');
  const out = await review.changeCategory({ candidateId: c.candidateId, categoryId: 'back-cover', admin: ADMIN, now: NOW });
  assert.equal(out.previousCategoryId, 'screen-guards');
  const after = fake.read(C.COMPATIBILITY_CANDIDATES + '/' + c.candidateId);
  assert.equal(after.relKey, 'back-cover__samsung-galaxy-a15__samsung-galaxy-a15-5g__same_part');
  assert.equal(after.productionState.state, 'none', 're-checked against production for the new category');
});

/* ======================================================== resume / retry */

test('a crash mid-job resumes from the next unprocessed item, never from zero', async () => {
  const fake = world();
  const media = fakeMedia();
  const deps = { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[RAW.m1, RAW.m2, RAW.m5]] }), media, ai: noAi };
  const created = await jobs.createJob({ admin: ADMIN, profileUrl: 'https://www.instagram.com/mobile_parts_hub/', now: NOW, deps });
  const jobId = created.job.jobId;

  /* discovery + two items, then the worker "dies" holding the lease with m5 mid-processing */
  await jobs.tick({ jobId, workerId: 'w1', deps: Object.assign({ clock, maxSteps: 3 }, deps) });
  fake.seed(`${C.INSTAGRAM_IMPORT_JOBS}/${jobId}/items/m5`, Object.assign(fake.read(`${C.INSTAGRAM_IMPORT_JOBS}/${jobId}/items/m5`), { status: 'processing' }));
  const jobDoc = fake.read(`${C.INSTAGRAM_IMPORT_JOBS}/${jobId}`);
  fake.seed(`${C.INSTAGRAM_IMPORT_JOBS}/${jobId}`, Object.assign(jobDoc, { lease: { owner: 'w1', until: clockT + 10 * 60000 } }));

  const busy = await jobs.tick({ jobId, workerId: 'w2', deps: Object.assign({ clock }, deps) });
  assert.equal(busy.busy, true, 'a second worker cannot process a job another worker holds');

  const r = await jobs.resume({ jobId, admin: ADMIN, now: clockT });
  assert.equal(r.ok, true);
  assert.equal(r.requeued, 1);
  const ocrBefore = media.calls.ocr.slice();
  const done = await jobs.tick({ jobId, workerId: 'w2', deps: Object.assign({ clock }, deps) });
  assert.equal(done.job.status, 'completed');
  assert.deepEqual(media.calls.ocr.slice(ocrBefore.length), ['m5'], 'only the unfinished item was processed');
  assert.deepEqual(ocrBefore, ['m1', 'm2']);
});

test('a failing item is retried up to the limit, then "Retry failed" finishes it', async () => {
  const fake = world();
  const media = fakeMedia({ failFor: { m2: 3 } });
  const deps = { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[RAW.m1, RAW.m2]] }), media, ai: noAi };
  const job = await runJob('https://www.instagram.com/mobile_parts_hub/', deps);
  assert.equal(job.status, 'completed_with_errors');
  assert.equal(job.counts.failed, 1);
  assert.ok(job.errors.some(e => /timed out/.test(e.message)), 'View Errors has the cause');
  assert.equal(media.calls.ocr.filter(x => x === 'm2').length, 3, 'exactly maxAttempts, no more');

  const retry = await jobs.retryFailed({ jobId: job.jobId, admin: ADMIN, now: clockT });
  assert.equal(retry.requeued, 1);
  const out = await jobs.tick({ jobId: job.jobId, workerId: 'w', deps: Object.assign({ clock }, deps) });
  assert.equal(out.job.status, 'completed');
  assert.equal(out.job.counts.failed, 0);
});

test('a rate limit pauses the job until Instagram says so; resuming early is refused', async () => {
  const fake = world();
  const limited = new GraphError('rate_limited', 'Instagram rate limit reached', { retryAfterMs: 30 * 60000 });
  const deps = { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[RAW.m1], limited] }), media: fakeMedia(), ai: noAi };
  const job = await runJob('https://www.instagram.com/mobile_parts_hub/', deps, { maxItems: 10 });
  assert.equal(job.status, 'rate_limited');
  assert.ok(job.resumeAfter > clockT);
  const early = await jobs.resume({ jobId: job.jobId, admin: ADMIN, now: clockT });
  assert.equal(early.ok, false);
  assert.match(early.error, /rate limit/);
});

test('cancel stops a job and its queued items', async () => {
  const fake = world();
  const deps = { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[RAW.m1, RAW.m2, RAW.m5]] }), media: fakeMedia(), ai: noAi };
  const created = await jobs.createJob({ admin: ADMIN, profileUrl: 'https://www.instagram.com/mobile_parts_hub/', now: NOW, deps });
  await jobs.tick({ jobId: created.job.jobId, workerId: 'w', deps: Object.assign({ clock, maxSteps: 2 }, deps) });
  const out = await jobs.cancel({ jobId: created.job.jobId, admin: ADMIN, now: clockT });
  assert.equal(out.ok, true);
  assert.equal(out.cancelledItems, 2);
  const ticked = await jobs.tick({ jobId: created.job.jobId, workerId: 'w', deps: Object.assign({ clock }, deps) });
  assert.equal(ticked.ok, false);
});

test('manual entry is processed like a post and labelled as admin-entered, not collected', async () => {
  const fake = world();
  const job = await runJob('https://www.instagram.com/mobile_parts_hub/', { cfg: cfg({ graph: { token: '', igUserId: '' } }), media: fakeMedia(), ai: noAi },
    { mode: 'manual', postUrl: 'https://www.instagram.com/p/MMMMM1/', manualText: 'Samsung A15 tempered glass\nCompatible: Samsung A15 / Samsung A15 5G' });
  assert.equal(job.status, 'completed');
  assert.equal(job.collectionMethod, 'manual_admin_entry');
  const c = find(candidatesOf(fake), x => rel(x, 'samsung-galaxy-a15', 'samsung-galaxy-a15-5g'));
  assert.equal(c.evidence.source, 'manual');
  assert.equal(c.sourcePost.collectionMethod, 'manual_admin_entry');
});

/* ======================================== 20. production database protection */

test('when the production catalogue is not in Firestore, approval writes nothing to production', async () => {
  const fake = world({ imported: false });
  await runJob('https://www.instagram.com/mobile_parts_hub/', { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[RAW.m1]] }), media: fakeMedia(), ai: noAi });
  const c = find(candidatesOf(fake), x => rel(x, 'samsung-galaxy-a15', 'samsung-galaxy-a15-5g'));
  assert.equal(c.productionState.state, 'unknown');
  const out = await review.approve({ candidateId: c.candidateId, admin: ADMIN, now: NOW });
  assert.equal(out.outcome, 'pending_build');
  assert.equal(fake.paths('groupDetails/').length + fake.paths('modelGroups/').length + fake.paths('groups/').length, 0);
  assert.equal(fake.read(C.APPROVED_COMPATIBILITIES + '/' + c.relKey).status, 'approved_pending_build');
});

test('if production changed to "different groups" after import, approval is refused and nothing is written', async () => {
  const fake = world();
  await runJob('https://www.instagram.com/mobile_parts_hub/', { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[RAW.m1]] }), media: fakeMedia(), ai: noAi });
  const c = find(candidatesOf(fake), x => rel(x, 'samsung-galaxy-a15', 'samsung-galaxy-a15-5g'));
  fake.seed('modelGroups/samsung-galaxy-a15-5g', { id: 'samsung-galaxy-a15-5g', byCategory: { 'screen-guards': ['sg-0999'] } });
  const before = productionSnapshot(fake);
  await assert.rejects(() => review.approve({ candidateId: c.candidateId, admin: ADMIN, now: NOW }), e => e.code === 'production-conflict');
  assert.equal(productionSnapshot(fake), before, 'groups are never merged');
  assert.equal(fake.read(C.COMPATIBILITY_CANDIDATES + '/' + c.candidateId).reviewSection, 'conflicts');
  assert.equal(fake.read(C.APPROVED_COMPATIBILITIES + '/' + c.relKey), undefined);
});

test('low confidence is never approved without an explicit acknowledgement, and "Approve all valid" never touches it', async () => {
  const fake = world();
  await runJob('https://www.instagram.com/mobile_parts_hub/', { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[RAW.m1, RAW.m5]] }), media: fakeMedia(), ai: noAi });
  const iphone = find(candidatesOf(fake), c => rel(c, 'apple-iphone-13', 'apple-iphone-13-pro'));

  const all = await review.approveAllValid({ admin: ADMIN, now: NOW });
  assert.equal(all.attempted, 1, 'only the one "ready" candidate');
  assert.equal(all.results[0].outcome, 'applied');
  assert.equal(fake.read(C.COMPATIBILITY_CANDIDATES + '/' + iphone.candidateId).status, 'pending');

  await assert.rejects(() => review.approve({ candidateId: iphone.candidateId, admin: ADMIN, now: NOW }), e => e.code === 'low-confidence');
  const out = await review.approve({ candidateId: iphone.candidateId, admin: ADMIN, acknowledgeLowConfidence: true, now: NOW });
  assert.equal(out.outcome, 'pending_build', 'neither iPhone has a back-cover group here: recorded, not invented');
});

test('raw AI output never reaches production: an invented claim is rejected by validation', async () => {
  const fake = world();
  const lyingAi = {
    isConfigured: () => true, status: () => ({ model: 'test-llm', missing: [] }),
    invoke: async () => ({ ok: true, output: { relationships: [{
      sourceModelText: 'Samsung A15', sourceModelId: 'samsung-galaxy-a15',
      compatibleModelText: 'Samsung A16', compatibleModelId: 'samsung-galaxy-a16',
      categoryText: 'glass', categoryId: 'screen-guards', compatibilityType: 'explicit', polarity: 'positive',
      evidenceText: 'A15 glass fits A16 perfectly'
    }] } })
  };
  const post = Object.assign({}, RAW.m1, { caption: 'Samsung new stock: A15 glass, A16 glass' });
  const before = productionSnapshot(fake);
  await runJob('https://www.instagram.com/mobile_parts_hub/', { cfg: cfg({ aiMode: 'always' }), graph: fakeGraph({ mobile_parts_hub: [[post]] }), media: fakeMedia(), ai: lyingAi });
  const ai = candidatesOf(fake).filter(c => c.extractedBy === 'ai');
  assert.equal(ai.length, 1);
  assert.equal(ai[0].status, 'rejected');
  assert.equal(ai[0].reviewSection, 'rejected');
  assert.match(ai[0].rejectNote, /does not appear in the source/);
  assert.equal(productionSnapshot(fake), before);
  const extraction = fake.all(C.INSTAGRAM_EXTRACTIONS)[0];
  assert.equal(extraction.ai.used, true);
  assert.equal(extraction.ai.rejected, 1);
});

test('the catalogue build keeps approved fitments: additive, anchored, never removing', () => {
  const { applyApprovedOverlay } = require('../../scripts/build-dataset');
  const groups = [
    { id: 'sg-0100', categoryId: 'screen-guards', memberIds: ['samsung-galaxy-a15', 'samsung-galaxy-a25'], memberNames: ['Samsung Galaxy A15', 'Samsung Galaxy A25'], memberCount: 2 },
    { id: 'sg-0101', categoryId: 'screen-guards', memberIds: ['samsung-galaxy-a35'], memberNames: ['Samsung Galaxy A35'], memberCount: 1 }
  ];
  const models = new Map([
    ['samsung-galaxy-a15', { name: 'Samsung Galaxy A15' }], ['samsung-galaxy-a25', { name: 'Samsung Galaxy A25' }],
    ['samsung-galaxy-a15-5g', { name: 'Samsung Galaxy A15 5G' }], ['samsung-galaxy-a35', { name: 'Samsung Galaxy A35' }],
    ['samsung-galaxy-a34', { name: 'Samsung Galaxy A34' }]
  ]);
  const modelGroups = new Map([['samsung-galaxy-a15', { 'screen-guards': ['sg-0100'] }]]);
  const change = (groupId, add, anchor) => ({ groupId, addedModelId: add, anchorModelId: anchor });
  const overlay = applyApprovedOverlay({ entries: [
    { relKey: 'k1', status: 'applied', categoryId: 'screen-guards', appliedChange: change('sg-0100', 'samsung-galaxy-a15-5g', 'samsung-galaxy-a15') },
    { relKey: 'k2', status: 'applied', categoryId: 'screen-guards', appliedChange: change('sg-0100', 'samsung-galaxy-a25', 'samsung-galaxy-a15') },
    { relKey: 'k3', status: 'applied', categoryId: 'screen-guards', appliedChange: change('sg-0101', 'samsung-galaxy-a34', 'samsung-galaxy-a15') },
    { relKey: 'k4', status: 'applied', categoryId: 'battery', appliedChange: change('sg-0100', 'samsung-galaxy-a34', 'samsung-galaxy-a15') },
    { relKey: 'k5', status: 'approved_pending_build', categoryId: 'screen-guards' }
  ] }, groups, models, modelGroups);

  assert.equal(overlay.applied, 1);
  assert.equal(overlay.alreadyInBuild, 1);
  assert.equal(overlay.pendingNewGroup, 1);
  assert.deepEqual(overlay.unapplied.map(u => u.relKey), ['k3', 'k4'], 'the group moved, or the category differs: reported, not guessed');
  assert.deepEqual(groups[0].memberIds, ['samsung-galaxy-a15', 'samsung-galaxy-a25', 'samsung-galaxy-a15-5g']);
  assert.equal(groups[0].memberCount, 3);
  assert.deepEqual(groups[1].memberIds, ['samsung-galaxy-a35'], 'untouched');
  assert.deepEqual(modelGroups.get('samsung-galaxy-a15-5g'), { 'screen-guards': ['sg-0100'] });
});

test('ignoring a source takes its open candidates out of the queue and blocks new imports', async () => {
  const fake = world();
  await runJob('https://www.instagram.com/mobile_parts_hub/', { cfg: cfg(), graph: fakeGraph({ mobile_parts_hub: [[RAW.m1, RAW.m5]] }), media: fakeMedia(), ai: noAi });
  const out = await review.setSourceIgnored({ sourceKey: 'ig_mobile_parts_hub', ignored: true, reason: 'sells copies', admin: ADMIN, now: NOW });
  assert.ok(out.candidatesMoved >= 2);
  assert.ok(candidatesOf(fake).every(c => c.status !== 'pending'));
  const blocked = await jobs.createJob({ admin: ADMIN, profileUrl: 'https://www.instagram.com/mobile_parts_hub/', now: NOW, deps: { cfg: cfg() } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  await review.setSourceIgnored({ sourceKey: 'ig_mobile_parts_hub', ignored: false, admin: ADMIN, now: NOW });
  assert.ok(candidatesOf(fake).some(c => c.status === 'pending'));
});
