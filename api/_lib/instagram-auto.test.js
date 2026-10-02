/* ============================================================================
   api/_lib/instagram-auto.test.js
   ----------------------------------------------------------------------------
   Instagram Intelligence: a list that passes every check changes the
   compatibility data without a person approving it.

     · the post that started this — "Universal On Off Patta + Vellum", four
       boxes of models — becomes two updated groups and one new one, not four
       groups and not three cards waiting for review
     · a visual box is not a database group: two boxes that share models are
       one group, and a box whose models already have a group joins it
     · a group the list holds most of is merged; a group it barely touches is
       left alone, and the model stays where it was
     · a weak reading, or a product the site has no category for, is NOT
       applied — it waits, with the reason
     · the page is scanned for free first, and nothing is spent until Continue
     · the catalogue build carries every one of these changes

   The providers are scripted stand-ins, as in instagram-cost.test.js.
   ========================================================================== */
'use strict';

['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_VISION_API_KEY', 'AI_GATEWAY_URL', 'AI_GATEWAY_TOKEN', 'INSTAGRAM_AI_PRICES', 'INSTAGRAM_AUTO_APPLY']
  .forEach(k => { delete process.env[k]; });

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeFirestore } = require('./testing/fake-firestore');
/* the audit service takes its database handle when it is first loaded, so the
   handle is pointed at the test's store BEFORE any service is required */
let currentFake = null;
require('./firebase').db = () => currentFake.db;
const fsx = require('../_services/instagram/firestore');
const jobs = require('../_services/instagram/job-service');
const review = require('../_services/instagram/review-service');
const autoApply = require('../_services/instagram/auto-apply');
const groupProposals = require('../_services/instagram/group-proposals');
const configMod = require('../_services/instagram/config');
const { normaliseMedia } = require('../_services/instagram/graph-client');
const taxonomy = require('../_services/taxonomy-service');
const S = require('../_schema/instagram');
const C = require('../_schema/collections');
const { applyApprovedOverlay, findDuplicateAssignments } = require('../../scripts/build-dataset');

const ADMIN = { uid: 'ownerUid000001', email: 'stark.ai.india@gmail.com', role: 'super_admin' };
const NOW = Date.UTC(2026, 9, 2, 4, 0);
let clockT = NOW;
const clock = () => (clockT += 3);

const id = name => {
  const m = taxonomy.matchModel(name);
  assert.equal(m.status, 'matched', `fixture model "${name}" must be in the catalogue`);
  return m.modelId;
};
const nameOf = modelId => taxonomy.modelById(modelId).modelName;

/* ------------------------------------------------------------- the world */

function seedGroup(fake, groupId, categoryId, masterName, memberNames) {
  const ids = memberNames.map(id);
  const master = id(masterName);
  fake.seed('groups/' + groupId, { groupNo: groupId.toUpperCase(), categoryId, partCode: 'MPF-' + groupId.toUpperCase(),
    masterModelId: master, masterModelName: nameOf(master), memberCount: ids.length });
  fake.seed('groupDetails/' + groupId, { groupNo: groupId.toUpperCase(), categoryId, partCode: 'MPF-' + groupId.toUpperCase(),
    memberIds: ids, memberNames: ids.map(nameOf), memberCount: ids.length });
  ids.forEach(m => {
    const cur = fake.read('modelGroups/' + m) || { id: m, byCategory: {} };
    cur.byCategory[categoryId] = (cur.byCategory[categoryId] || []).concat(groupId);
    fake.seed('modelGroups/' + m, cur);
  });
}

function world() {
  const fake = createFakeFirestore();
  fsx.use(fake.provider);
  currentFake = fake;
  taxonomy.registerCategories([]);          /* a fresh store has no run-time categories */
  fake.seed('catalog/meta', { version: 1 });
  /* the button-flex groups around the phones of the post */
  seedGroup(fake, 'bf-0010', 'button-flex', 'Realme 5', ['Realme 5', 'Realme 5s', 'Realme 5i', 'Realme C3', 'Realme C11', 'Realme C12', 'Realme C15']);
  seedGroup(fake, 'bf-0020', 'button-flex', 'Vivo Y18', ['Vivo Y18', 'Vivo Y28s', 'Vivo Y03']);
  /* the display groups around the Vivo Y20 */
  seedGroup(fake, 'cd-0678', 'combo-display', 'Vivo Y11s', ['Vivo Y11s', 'Vivo Y20', 'Vivo Y20a', 'Vivo Y20g', 'Vivo Y20s', 'Vivo Y12s', 'vivo iQOO U1x']);
  seedGroup(fake, 'cd-0244', 'combo-display', 'Vivo Y21s', ['Vivo Y21s', 'Vivo Y16', 'Vivo Y15c', 'Vivo Y32', 'Vivo Y21t']);
  seedGroup(fake, 'cd-0557', 'combo-display', 'Vivo Y36', ['Vivo Y36']);
  return fake;
}

function cfg(over) {
  return Object.assign(configMod.load(), {
    graph: { token: 'test-token', igUserId: '17841400000000000', version: 'v25.0', timeoutMs: 1000, appSecret: '' },
    autoApply: true,
    ocrProvider: 'none', visionProvider: 'gemini', videoProvider: 'gemini', validator: 'none',
    geminiKey: 'test-only-gemini-key-not-real', anthropicKey: '',
    geminiModel: 'gemini-3.8-flash', geminiScreenModel: 'gemini-3.1-flash-lite',
    confidenceHigh: 0.9, confidenceValidate: 0.7, aiRetries: 0, videoFps: 2, readRepairMedia: false, aiMode: 'off', prices: {},
    maxItemsPerJob: 500, maxDiscoveryPages: 20, pageSize: 25, maxCarouselChildren: 10, maxAttempts: 3,
    maxImageBytes: 8 * 1024 * 1024, maxVideoBytes: 60 * 1024 * 1024,
    tickBudgetMs: 10 * 60 * 1000, leaseMs: 60000,
    maxAiItemsPerSync: 1000, maxGeminiCallsPerSync: 1000, maxClaudeCallsPerSync: 100, maxVideoMinutesPerSync: 600,
    dailyGraphCalls: 1000, dailyOcrCalls: 1000, dailyAiCalls: 5000, dailyVideoCalls: 1000
  }, over || {});
}

const noAi = { isConfigured: () => false, status: () => ({ model: null, missing: [] }), invoke: async () => ({ ok: false, reason: 'ai-unconfigured' }) };

function cdn() {
  return async url => {
    const m = /^https:\/\/cdn\/([a-z0-9]+)\.(jpg|mp4)$/.exec(String(url));
    if (!m) throw new Error('unexpected fetch in a test: ' + String(url).slice(0, 60));
    const bytes = Buffer.from('IMG:' + m[1] + ';');
    return { ok: true, status: 200, headers: { get: h => (h === 'content-type' ? 'image/jpeg' : String(bytes.length)) },
             arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
}

/** Gemini: `script[id].vision` is what the deep read returns for image <id>. */
function fakeGemini(script) {
  const calls = [];
  return {
    calls, configured: () => true,
    interact: async ({ model, input, schema }) => {
      const part = input.find(p => p.type === 'image' || p.type === 'video');
      const mid = /^(?:IMG|VID):([a-z0-9]+);/.exec(Buffer.from(part.data, 'base64').slice(0, 40).toString('latin1'))[1];
      const stage = schema.properties.verdict ? 'screen' : 'read';
      calls.push({ model, stage, id: mid });
      const s = script[mid] || {};
      const output = stage === 'screen' ? (s.screen || { verdict: 'UNCERTAIN', kind: 'product', hasModelList: false, reason: 'small text' })
        : (s.vision || { contentClass: 'product', confidence: 0.9, product: '', lists: [], text: '' });
      return { ok: true, output, text: JSON.stringify(output), model, usage: { inputTokens: 1000, outputTokens: 100 } };
    },
    uploadFile: async () => ({ ok: false, kind: 'error', reason: 'not used' }), deleteFile: async () => {},
    listModels: async () => ({ ok: true, models: ['gemini-3.8-flash', 'gemini-3.1-flash-lite'] })
  };
}
const noClaude = { configured: () => false, structured: async () => ({ ok: false, kind: 'auth', reason: 'not configured' }), retrieveModel: async () => ({ ok: false }) };

function fakeGraph(pagesByUser) {
  return {
    configured: () => true,
    ownProfile: async () => ({ username: 'mpf_official', name: 'MPF', followersCount: 10, mediaCount: 0 }),
    ownMediaPage: async () => ({ media: [], nextCursor: null }),
    discoverPage: async (username, { after }) => {
      const pages = pagesByUser[username];
      const i = after ? Number(after) : 0;
      return { profile: { username, name: username, followersCount: 52848, mediaCount: 585, accountType: 'professional' },
               media: pages[i].map(raw => normaliseMedia(raw)), nextCursor: i + 1 < pages.length ? String(i + 1) : null };
    },
    coverFieldSupported: () => false
  };
}

const image = (mid, caption) => ({ id: mid, media_type: 'IMAGE', media_url: `https://cdn/${mid}.jpg`,
  permalink: `https://www.instagram.com/p/${('POST' + mid + 'XXXXX').slice(0, 11)}/`, timestamp: '2026-09-24T10:00:00+0000', caption });

async function drive(job, deps) {
  let out = { job };
  for (let i = 0; i < 60 && ['queued', 'discovering', 'processing'].indexOf(out.job.status) > -1; i++) {
    out = await jobs.tick({ jobId: job.jobId, workerId: 'test', deps: Object.assign({ clock }, deps) });
  }
  return out.job;
}
async function runJob(profileUrl, deps, extra = {}) {
  const created = await jobs.createJob(Object.assign({ admin: ADMIN, profileUrl, now: clock(), deps }, extra));
  assert.equal(created.ok, true, created.error);
  return drive(created.job, deps);
}
const depsFor = (posts, script, over) => ({ cfg: cfg(over), graph: fakeGraph({ sk_mobile_doctar: [posts] }), ai: noAi, fetchImpl: cdn(),
                                           providers: { gemini: fakeGemini(script), claude: noClaude } });

const proposalsOf = fake => fake.all(C.COMPATIBILITY_CANDIDATES).filter(c => c.kind === 'group_proposal');
const members = (fake, groupId) => fake.read(C.GROUP_DETAILS + '/' + groupId).memberIds.slice().sort();
const ids = names => names.map(id).sort();
function assertOneGroupPerCategory(fake) {
  fake.paths('modelGroups/').forEach(path => {
    const doc = fake.read(path);
    Object.keys(doc.byCategory || {}).forEach(cat => assert.ok(doc.byCategory[cat].length <= 1, `${doc.id} is in ${doc.byCategory[cat].join(' and ')} for ${cat}`));
  });
}

/* ================================================ the post that started this */

/* What Gemini read from the real post (2026-10-02): one image, four boxes. */
const PATTA = { contentClass: 'compatibility', confidence: 1, product: 'On Off Patta + Vellum', text: '', lists: [
  { headline: 'Universal On Off Patta + Vellum Compatible Models', atSecond: 0, models: ['Vivo y18', 'Vivo y28s', 'Vivo y03', 'Vivo y18e', 'Vivo t3 lite'] },
  { headline: 'Universal On Off Patta + Vellum Compatible Models', atSecond: 0, models: ['Realme 5', 'Realme 5S', 'Realme 5i', 'Realme C3', 'Realme C11', 'Realme C12', 'Realme C15'] },
  { headline: 'Universal On Off Patta + Vellum Compatible Models', atSecond: 0, models: ['Realme c11', 'Realme c12', 'Realme c15', 'Realme c25', 'Realme c25s'] },
  { headline: 'Universal On Off Patta + Vellum Compatible Models', atSecond: 0, models: ['Oppo A16', 'Oppo A16s', 'Oppo A54', 'Oppo A55 4G'] }
] };
const PATTA_POST = image('patta', 'Universal ON off Patta\n\n#mobilerepair #repair #mobile');

test('"On Off Patta" is the Button Flex — the trade\'s word for it — and other flex strips are not', () => {
  ['Universal On Off Patta + Vellum Compatible Models', 'Product shown: On Off Patta + Vellum', 'Universal ON off Patta', 'power patta', 'volume patta']
    .forEach(t => assert.equal(taxonomy.resolveCategory(t).categoryId, 'button-flex', t));
  ['charging patta', 'lcd patta'].forEach(t => {
    const r = taxonomy.resolveCategory(t);
    assert.equal(r.categoryId, null, t + ' is not a button flex, and not a display');
    assert.equal(r.unmappedTerm, t);
  });
});

test('four boxes on one image: two groups gain models, one group is created, and nothing waits for review', async () => {
  const fake = world();
  const deps = depsFor([PATTA_POST], { patta: { vision: PATTA } });
  const job = await runJob('https://www.instagram.com/sk_mobile_doctar/', deps);
  assert.equal(job.status, 'completed');
  assert.equal(job.autoApply, true);

  /* the two Realme boxes share C11 / C12 / C15: they are ONE list, and its
     models already have a group — so no group is created for them */
  assert.deepEqual(members(fake, 'bf-0010'),
    ids(['Realme 5', 'Realme 5s', 'Realme 5i', 'Realme C3', 'Realme C11', 'Realme C12', 'Realme C15', 'Realme C25', 'Realme C25s']),
    'the existing Realme group gained C25 and C25s');
  assert.equal(fake.read(C.GROUPS + '/bf-0010').masterModelId, id('Realme 5'), 'an existing group keeps its master');
  assert.equal(fake.read(C.GROUPS + '/bf-0010').memberCount, 9);

  /* the Vivo box: found through the models already grouped */
  assert.deepEqual(members(fake, 'bf-0020'), ids(['Vivo Y18', 'Vivo Y28s', 'Vivo Y03', 'Vivo Y18e', 'Vivo T3 Lite']));

  /* the Oppo box: none of them had a button-flex group — one is created */
  const created = fake.paths(C.GROUPS + '/').filter(p => /bf-9\d{3}$/.test(p));
  assert.deepEqual(created, [C.GROUPS + '/bf-9001'], 'exactly one new group, not one per box');
  const oppo = fake.read(C.GROUPS + '/bf-9001');
  assert.equal(oppo.categoryId, 'button-flex');
  assert.equal(oppo.partCode, 'MPF-BF-9001');
  assert.equal(oppo.masterModelId, id('Oppo A16'), 'the base model the other names extend — not "whichever was printed first"');
  assert.deepEqual(members(fake, 'bf-9001'), ids(['Oppo A16', 'Oppo A16s', 'Oppo A54']));
  /* "Oppo A55 4G": the catalogue record is "Oppo A55" — the 4G is not in its
     name, so it is not applied on a guess. It is reported, and the rest goes on. */
  const oppoP = proposalsOf(fake).find(p => p.createdGroup);
  assert.equal(oppoP.autoApply.skipped.length, 1);
  assert.match(oppoP.autoApply.skipped[0].text, /A55/);
  assert.ok(!fake.read(C.MODEL_GROUPS + '/' + id('Oppo A55')), 'nothing was written for it');

  /* nothing is left for a person */
  assert.equal(proposalsOf(fake).length, 3, 'three lists: Vivo, Realme (two boxes), Oppo');
  assert.ok(proposalsOf(fake).every(p => p.status === 'approved' && p.approvedBy === 'instagram-intelligence'));
  assert.equal(job.counts.pendingReview, 0);
  assert.equal(job.counts.autoApplied, 3);
  assert.equal(job.counts.autoGroupsUpdated, 2);
  assert.equal(job.counts.autoGroupsCreated, 1);
  assert.equal(job.counts.autoModelsAdded, 2 + 2 + 3);
  assert.equal(job.counts.autoSkippedEntries, 1);
  assert.equal(job.counts.autoAttention, 0);
  assertOneGroupPerCategory(fake);

  /* every change says where it came from, on the group and in the ledger */
  const stamp = fake.read(C.GROUPS + '/bf-0010').lastChange;
  assert.equal(stamp.source, 'instagram-intelligence');
  assert.equal(stamp.sourceUsername, 'sk_mobile_doctar');
  assert.deepEqual(stamp.addedModelIds.slice().sort(), ids(['Realme C25', 'Realme C25s']));
  const ledger = fake.all(C.APPROVED_COMPATIBILITIES);
  assert.equal(ledger.filter(e => e.kind === 'same_part' && e.status === 'applied').length, 4, 'one entry per model added to an existing group');
  assert.equal(ledger.filter(e => e.kind === 'new_group' && e.status === 'applied').length, 1);
  assert.ok(ledger.every(e => e.automatic === true && e.onBehalfOf === ADMIN.uid), 'who did it, and whose scan it was');
  const audit = fake.all('adminAuditLog').filter(a => a.action === 'compat.auto_applied');
  assert.equal(audit.length, 3);
  assert.ok(audit.every(a => a.actorUid === 'instagram-intelligence' && a.detail.onBehalfOf === ADMIN.uid));
});

test('the same post tomorrow costs nothing and changes nothing; a later post finds the group that was created', async () => {
  const fake = world();
  const deps = depsFor([PATTA_POST], { patta: { vision: PATTA } });
  await runJob('https://www.instagram.com/sk_mobile_doctar/', deps);
  const before = JSON.stringify(fake.paths('groupDetails/').sort().map(k => fake.read(k).memberIds));
  const calls = deps.providers.gemini.calls.length;

  const again = await runJob('https://www.instagram.com/sk_mobile_doctar/', deps);
  assert.equal(again.counts.unchanged, 1);
  assert.equal(deps.providers.gemini.calls.length, calls, 'no model was asked again');
  assert.equal(JSON.stringify(fake.paths('groupDetails/').sort().map(k => fake.read(k).memberIds)), before);

  /* a new post lists the Oppo models again, with one more: the group created
     yesterday is found through them, and gains the new one */
  const next = { contentClass: 'compatibility', confidence: 0.96, product: 'On Off Patta', text: '', lists: [
    { headline: 'On Off Patta Compatible Models', atSecond: 0, models: ['Oppo A16', 'Oppo A16s', 'Oppo A54', 'Oppo A53s'] }] };
  const deps2 = depsFor([image('oppo2', 'Universal on off patta')], { oppo2: { vision: next } });
  const job = await runJob('https://www.instagram.com/sk_mobile_doctar/', deps2);
  assert.equal(job.counts.autoGroupsCreated || 0, 0, 'no second group');
  assert.equal(job.counts.autoGroupsUpdated, 1);
  assert.deepEqual(members(fake, 'bf-9001'), ids(['Oppo A16', 'Oppo A16s', 'Oppo A54', 'Oppo A53s']));
  assert.equal(fake.paths(C.GROUPS + '/').filter(p => /bf-9\d{3}$/.test(p)).length, 1);
  assertOneGroupPerCategory(fake);
});

/* ============================================================ merge, or not */

const DISPLAY = models => ({ contentClass: 'compatibility', confidence: 0.95, product: 'display combo', text: '', lists: [
  { headline: 'Vivo Y20 Combo', atSecond: 0, models }] });

test('a group the list holds whole is merged into the target, live; a group it barely touches is left alone', async () => {
  const fake = world();
  /* Y36 is a group of one (cd-0557): the list holds all of it.
     Y21s is one of five in cd-0244: one shared model does not make two groups one.
     Y20i has no display group: it is simply added. */
  const deps = depsFor([image('vivo', 'Vivo Y20 combo compatible models')],
    { vivo: { vision: DISPLAY(['Vivo Y20', 'Vivo Y20a', 'Vivo Y20g', 'Vivo Y12s', 'Vivo Y20i', 'Vivo Y36', 'Vivo Y21s']) } });
  const job = await runJob('https://www.instagram.com/sk_mobile_doctar/', deps);

  const p = proposalsOf(fake)[0];
  assert.equal(p.status, 'approved');
  assert.equal(p.target.groupId, 'cd-0678', 'the group of the product the post names');

  /* the two groups are one group now, in the live data */
  assert.equal(job.counts.autoGroupsMerged, 1);
  assert.equal(job.counts.autoMergesQueued || 0, 0);
  assert.deepEqual(members(fake, 'cd-0678'),
    ids(['Vivo Y11s', 'Vivo Y20', 'Vivo Y20a', 'Vivo Y20g', 'Vivo Y20s', 'Vivo Y12s', 'vivo iQOO U1x', 'Vivo Y20i', 'Vivo Y36']),
    'its own seven, the model with no group, and the model of the merged group');
  assert.equal(fake.read(C.GROUPS + '/cd-0678').memberCount, 9);
  assert.equal(fake.read(C.GROUPS + '/cd-0678').masterModelId, id('Vivo Y11s'), 'the survivor keeps its master');
  assert.deepEqual(fake.read(C.MODEL_GROUPS + '/' + id('Vivo Y36')).byCategory['combo-display'], ['cd-0678'], 'one group, and it is the survivor');

  /* the merged group is kept, and says where it went: an old link to its part
     code is answered with the group it became */
  assert.equal(fake.read(C.GROUPS + '/cd-0557').mergedInto, 'cd-0678');
  assert.equal(fake.read(C.GROUP_DETAILS + '/cd-0557').mergedInto, 'cd-0678');
  const merge = fake.all(C.APPROVED_COMPATIBILITIES).find(e => e.kind === 'merge_groups');
  assert.equal(merge.status, 'applied');
  assert.equal(merge.live, true);
  assert.equal(merge.survivor.anchorModelId, id('Vivo Y11s'));
  assert.equal(merge.absorbed.groupId, 'cd-0557');
  assert.deepEqual(merge.absorbed.memberIds, [id('Vivo Y36')], 'what it held, so the merge can be taken back exactly');
  assert.equal(merge.automatic, true);
  assert.equal(fake.read(C.GROUP_DETAILS + '/cd-0678').lastChange.mergedGroupIds[0], 'cd-0557');

  /* the model in the larger group stays exactly where it was */
  const y21s = p.members.find(m => m.match.modelId === id('Vivo Y21s'));
  assert.equal(y21s.decision, 'skip');
  assert.match(y21s.skipReason, /too little of that group to merge/);
  assert.deepEqual(members(fake, 'cd-0244'), ids(['Vivo Y21s', 'Vivo Y16', 'Vivo Y15c', 'Vivo Y32', 'Vivo Y21t']));
  assert.ok(!fake.read(C.GROUPS + '/cd-0244').mergedInto);
  assertOneGroupPerCategory(fake);

  /* another post naming the merged model finds it where it now is: nothing to merge again */
  const deps2 = depsFor([image('vivo2', 'Vivo Y20 combo compatible models')],
    { vivo2: { vision: DISPLAY(['Vivo Y20', 'Vivo Y20a', 'Vivo Y20s', 'Vivo Y36']) } });
  const again = await runJob('https://www.instagram.com/sk_mobile_doctar/', deps2);
  assert.equal(again.counts.autoGroupsMerged || 0, 0);
  assert.equal(fake.all(C.APPROVED_COMPATIBILITIES).filter(e => e.kind === 'merge_groups').length, 1);
  assert.equal(members(fake, 'cd-0678').length, 9);
});

test('the merge rule: most of the other group and at least two of its models, or a group of one — never a single shared model', () => {
  const g = (memberCount, overlap) => ({ groupId: 'x', memberCount, overlap, coverage: memberCount ? overlap / memberCount : null });
  assert.equal(groupProposals.absorbs(g(1, 1)), true, 'a group of one, all of it listed');
  assert.equal(groupProposals.absorbs(g(4, 2)), true, 'half, and two models');
  assert.equal(groupProposals.absorbs(g(5, 5)), true);
  assert.equal(groupProposals.absorbs(g(3, 1)), false, 'A B C and C X Y share one model: not the same part');
  assert.equal(groupProposals.absorbs(g(2, 1)), false, 'half, but only one model');
  assert.equal(groupProposals.absorbs(g(10, 3)), false, 'three of ten');
  assert.equal(groupProposals.absorbs({ groupId: 'x', overlap: 3, coverage: null }), false, 'a group whose size is unknown is never merged');
});

test('the master of a new group is chosen by a rule a person can read — and is stable', () => {
  const entries = names => names.map(n => ({ state: 'add', match: { modelId: id(n), modelName: nameOf(id(n)) } }));
  const pick = names => groupProposals.chooseMaster(entries(names));
  assert.equal(pick(['Realme C25s', 'Realme 5i', 'Realme 5', 'Realme 5s', 'Realme C3']).modelId, id('Realme 5'), 'the base of 5s and 5i, whatever the order printed');
  assert.equal(pick(['Oppo A54', 'Oppo A16s', 'Oppo A16']).modelId, id('Oppo A16'));
  assert.match(pick(['Oppo A54', 'Oppo A16s', 'Oppo A16']).reason, /chosen automatically/);
  /* no name extends another: the shortest catalogue name, then alphabetical */
  const a = pick(['Vivo Y03', 'Vivo Y28s', 'Vivo T3 Lite']);
  const b = pick(['Vivo T3 Lite', 'Vivo Y28s', 'Vivo Y03']);
  assert.equal(a.modelId, b.modelId, 'the same list in another order gives the same master');
  assert.equal(groupProposals.chooseMaster([]), null);
});

/* ======================================================== what is NOT applied */

test('a weak reading is not applied: it waits, with the reason, and production is untouched', async () => {
  const fake = world();
  const blurry = Object.assign({}, PATTA, { confidence: 0.6, lists: [PATTA.lists[1].models.concat(['Realme C25', 'Realme C25s'])]
    .map(models => ({ headline: 'On Off Patta Compatible Models', atSecond: 0, models })) });
  const before = JSON.stringify(fake.paths('groupDetails/').sort().map(k => fake.read(k)));
  const job = await runJob('https://www.instagram.com/sk_mobile_doctar/', depsFor([PATTA_POST], { patta: { vision: blurry } }));
  const p = proposalsOf(fake)[0];
  assert.equal(p.status, 'pending');
  assert.equal(p.confidence.band, 'low');
  assert.equal(p.autoApply.status, 'attention');
  assert.match(p.autoApply.reasons.join(' '), /not strong enough to apply without a person/);
  assert.equal(job.counts.autoAttention, 1);
  assert.equal(job.counts.autoApplied || 0, 0);
  assert.equal(JSON.stringify(fake.paths('groupDetails/').sort().map(k => fake.read(k))), before);
  assert.equal(fake.all(C.APPROVED_COMPATIBILITIES).length, 0);
});

const CAMERA = { contentClass: 'compatibility', confidence: 0.97, product: 'camera glass', text: '', lists: [
  { headline: 'Camera Glass Compatible Models', atSecond: 0, models: ['Vivo Y20', 'Vivo Y20a', 'Vivo Y20g', 'Vivo Y12s'] }] };

test('a part type there is no category for gets one — in the compatibility data, not on the public site — and its group in it', async () => {
  const fake = world();
  const job = await runJob('https://www.instagram.com/sk_mobile_doctar/', depsFor([image('cam', 'Camera glass compatible models')], { cam: { vision: CAMERA } }));

  /* the category */
  const cat = fake.read(C.COMPAT_CATEGORIES + '/camera-glass');
  assert.equal(cat.name, 'Camera Glass');
  assert.equal(cat.code, 'CG', 'a part-code prefix none of the others has');
  assert.equal(cat.origin, 'instagram-intelligence');
  assert.equal(cat.onPublicSite, false);
  assert.equal(job.counts.autoCategoriesCreated, 1);
  assert.equal(taxonomy.isKnownCategory('camera-glass'), true);
  assert.equal(taxonomy.isSiteCategory('camera-glass'), false, 'not one of the site\'s categories until it is in the build');

  /* the group, in THAT category — the display group those phones are in is not touched */
  const p = proposalsOf(fake)[0];
  assert.equal(p.status, 'approved');
  assert.equal(p.categoryId, 'camera-glass');
  assert.equal(p.categoryMethod, 'created_category');
  assert.equal(p.createdGroup.groupNo, 'CG-9001');
  assert.equal(p.createdGroup.partCode, 'MPF-CG-9001');
  assert.deepEqual(members(fake, 'cg-9001'), ids(['Vivo Y20', 'Vivo Y20a', 'Vivo Y20g', 'Vivo Y12s']));
  assert.equal(fake.read(C.GROUPS + '/cg-9001').masterModelId, id('Vivo Y20'));
  assert.equal(members(fake, 'cd-0678').length, 7);
  assert.deepEqual(fake.read(C.MODEL_GROUPS + '/' + id('Vivo Y20')).byCategory, { 'combo-display': ['cd-0678'], 'camera-glass': ['cg-9001'] },
    'one group per category: a display group and a camera-glass group are two categories');
  assert.equal(job.counts.autoGroupsCreated, 1);

  /* the next post about camera glass finds the category and the group */
  const more = Object.assign({}, CAMERA, { lists: [{ headline: 'Camera Lens Compatible Models', atSecond: 0, models: ['Vivo Y20', 'Vivo Y20a', 'Vivo Y20s'] }] });
  const next = await runJob('https://www.instagram.com/sk_mobile_doctar/', depsFor([image('cam2', 'Camera lens compatible models')], { cam2: { vision: more } }));
  assert.equal(next.counts.autoCategoriesCreated || 0, 0, 'created once');
  assert.equal(next.counts.autoGroupsUpdated, 1);
  assert.deepEqual(members(fake, 'cg-9001'), ids(['Vivo Y20', 'Vivo Y20a', 'Vivo Y20g', 'Vivo Y12s', 'Vivo Y20s']));
  assert.equal(fake.all(C.COMPAT_CATEGORIES).length, 1);
  assertOneGroupPerCategory(fake);
});

test('a product that is not a fitted part is not made into a category: the list waits, and says which product', async () => {
  const fake = world();
  const charger = { contentClass: 'compatibility', confidence: 0.97, product: 'charger', text: '', lists: [
    { headline: 'Charger Compatible Models', atSecond: 0, models: ['Vivo Y20', 'Vivo Y20a', 'Vivo Y20g', 'Vivo Y12s'] }] };
  const job = await runJob('https://www.instagram.com/sk_mobile_doctar/', depsFor([image('chg', 'Charger compatible models')], { chg: { vision: charger } }));
  const p = proposalsOf(fake)[0];
  assert.equal(p.categoryId, null);
  assert.equal(p.status, 'pending');
  assert.match(p.autoApply.reasons.join(' '), /charger.*not one of the site's categories/);
  assert.equal(job.counts.autoAttention, 1);
  assert.equal(fake.all(C.COMPAT_CATEGORIES).length, 0);
  assert.equal(taxonomy.creatableCategoryFor('charger'), null);

  /* and with category creation switched off, even a creatable one waits */
  const fake2 = world();
  await runJob('https://www.instagram.com/sk_mobile_doctar/', depsFor([image('cam', 'Camera glass compatible models')], { cam: { vision: CAMERA } }, { autoCreateCategories: false }));
  assert.equal(fake2.all(C.COMPAT_CATEGORIES).length, 0);
  assert.equal(proposalsOf(fake2)[0].status, 'pending');
});

test('automatic application is the server\'s decision: the role of whoever started the scan, and the switch', async () => {
  world();
  const make = (admin, over) => jobs.createJob({ admin, profileUrl: 'https://www.instagram.com/sk_mobile_doctar/', now: clock(), deps: { cfg: cfg(over) } });
  assert.equal((await make(ADMIN)).job.autoApply, true);
  assert.equal((await make(ADMIN, { autoApply: false })).job.autoApply, false, 'INSTAGRAM_AUTO_APPLY=off');
  assert.equal((await make({ uid: 'analystUid00001', email: 'a@example.com', role: 'analyst' })).job.autoApply, false,
    'someone who may not approve a change cannot have one applied for them');
  assert.equal((await make({ uid: 'nobodyUid000001', email: 'n@example.com' })).job.autoApply, false, 'no role is no permission');

  /* with it off, the list is queued for a person exactly as before */
  const fake = world();
  await runJob('https://www.instagram.com/sk_mobile_doctar/', depsFor([PATTA_POST], { patta: { vision: PATTA } }, { autoApply: false }));
  assert.ok(proposalsOf(fake).length === 3 && proposalsOf(fake).every(p => p.status === 'pending' && !p.autoApply));
  assert.equal(fake.all(C.APPROVED_COMPATIBILITIES).length, 0);
});

test('the gate, on its own: what stops a list, in words', () => {
  const ok = { kind: 'group_proposal', status: 'pending', categoryId: 'button-flex', confidence: { band: 'medium', reasons: [] }, counts: { matched: 5 }, proposedAction: 'UPDATE_EXISTING_GROUP' };
  assert.deepEqual(autoApply.gate(ok, { relevance: 'RELEVANT_COMPATIBILITY' }), []);
  assert.match(autoApply.gate(Object.assign({}, ok, { counts: { matched: 1 } }))[0], /fewer than two/);
  assert.match(autoApply.gate(ok, { relevance: 'NEEDS_REVIEW' })[0], /mixes compatibility with repair/);
  assert.match(autoApply.gate(Object.assign({}, ok, { categoryId: null, unmappedCategoryText: 'back glass' }))[0], /back glass/);
  assert.deepEqual(autoApply.gate(Object.assign({}, ok, { status: 'approved' })), ['not a pending list']);
});

/* ================================================================ scan first */

test('scan first: the page is listed and scored for free, and nothing is spent until Continue', async () => {
  const fake = world();
  const posts = [
    PATTA_POST,
    image('jumper', 'Redmi Note 10 power button jumper'),
    image('stock', 'New stock 🔥'),
    image('combo', 'Vivo Y20 combo compatible with 68 models')
  ];
  const deps = depsFor(posts, { patta: { vision: PATTA } });
  const created = await jobs.createJob({ admin: ADMIN, profileUrl: 'https://www.instagram.com/sk_mobile_doctar/', scanFirst: true, now: clock(), deps });
  let job = await drive(created.job, deps);

  assert.equal(job.status, 'scanned');
  assert.equal(deps.providers.gemini.calls.length, 0, 'no model has been asked anything');
  assert.equal(job.counts.postsFound, 4);
  assert.equal(job.counts.scanLikely, 1, 'the caption that says "compatible with 68 models"');
  assert.equal(job.counts.scanCheck, 2, 'a generic caption decides nothing: the picture has to be looked at');
  assert.equal(job.counts.scanIrrelevant, 1, 'a jumper post');
  assert.equal(job.counts.processed || 0, 0);
  const item = k => fake.read(`${C.INSTAGRAM_IMPORT_JOBS}/${job.jobId}/items/${k}`);
  assert.equal(item('jumper').scan.class, 'likely_irrelevant');
  assert.equal(item('combo').scan.class, 'likely_relevant');
  assert.ok(item('combo').scan.why.length > 0, 'and why');
  assert.equal(fake.all(C.COMPATIBILITY_CANDIDATES).length, 0, 'a scan changes nothing');

  /* a tick does not start it; only Continue does */
  assert.equal((await jobs.tick({ jobId: job.jobId, workerId: 'test', deps: Object.assign({ clock }, deps) })).ok, false);
  assert.equal((await jobs.continueJob({ jobId: job.jobId, admin: ADMIN, now: clock() })).ok, true);
  assert.equal((await jobs.continueJob({ jobId: job.jobId, admin: ADMIN, now: clock() })).status, 409, 'once');
  job = await drive(fake.read(C.INSTAGRAM_IMPORT_JOBS + '/' + job.jobId), deps);
  assert.equal(job.status, 'completed');
  assert.equal(job.counts.cheapRejected, 1, 'the jumper post was never read');
  assert.equal(job.counts.autoGroupsUpdated, 2);

  /* tomorrow: the scan says what it has already processed, before spending */
  const again = await jobs.createJob({ admin: ADMIN, profileUrl: 'https://www.instagram.com/sk_mobile_doctar/', scanFirst: true, now: clock(), deps });
  const rescanned = await drive(again.job, deps);
  assert.equal(rescanned.status, 'scanned');
  assert.equal(rescanned.counts.scanSeen, 4, 'all four are known, unchanged');
  assert.equal(rescanned.counts.scanLikely || 0, 0);

  /* one post, or text a person typed, has nothing to summarise: no pause */
  const one = await jobs.createJob({ admin: ADMIN, profileUrl: 'https://www.instagram.com/sk_mobile_doctar/', postUrl: PATTA_POST.permalink,
    scanFirst: true, now: clock(), deps });
  assert.equal(one.job.scanFirst, false);
});

test('more than fifty posts: a scan lists as many as were asked for, page after page', async () => {
  world();
  const many = Array.from({ length: 180 }, (_, i) => image('m' + i, i % 9 === 0 ? 'Universal combo compatible models' : 'Samsung A21S temperature charging error'));
  const paged = many.reduce((out, x, i) => { (out[Math.floor(i / 25)] = out[Math.floor(i / 25)] || []).push(x); return out; }, []);
  const deps = { cfg: cfg(), graph: fakeGraph({ sk_mobile_doctar: paged }), ai: noAi, fetchImpl: cdn(), providers: { gemini: fakeGemini({}), claude: noClaude } };
  const created = await jobs.createJob({ admin: ADMIN, profileUrl: 'https://www.instagram.com/sk_mobile_doctar/', maxItems: 150, scanFirst: true, now: clock(), deps });
  assert.equal(created.job.maxItems, 150, 'not clamped to 50');
  const job = await drive(created.job, deps);
  assert.equal(job.status, 'scanned');
  assert.equal(job.counts.postsFound, 150);
  assert.equal(job.discovery.pages, 6);
  assert.equal(job.counts.scanLikely, 17);
  assert.equal(job.counts.scanIrrelevant, 133);
});

/* ======================================================== the catalogue build */

test('the catalogue build carries it all: the group created at run time keeps its number, and the merge is folded in', async () => {
  const fake = world();
  await runJob('https://www.instagram.com/sk_mobile_doctar/', depsFor([PATTA_POST, image('vivo', 'Vivo Y20 combo compatible models')], {
    patta: { vision: PATTA },
    vivo: { vision: DISPLAY(['Vivo Y20', 'Vivo Y20a', 'Vivo Y20g', 'Vivo Y12s', 'Vivo Y20i', 'Vivo Y36']) }
  }));

  /* the build starts from the EXPORTS — the groups as they were before any of this */
  const before = world();
  const groups = before.paths('groupDetails/').map(p => {
    const gd = before.read(p), g = before.read(p.replace('groupDetails/', 'groups/'));
    return { id: p.split('/')[1], categoryId: gd.categoryId, partCode: gd.partCode, masterModelId: g.masterModelId,
             memberIds: gd.memberIds.slice(), memberNames: gd.memberNames.slice(), memberCount: gd.memberCount };
  });
  const tax = taxonomy.taxonomy();
  const models = new Map();
  groups.forEach(g => g.memberIds.forEach(m => models.set(m, { name: nameOf(m), brandId: taxonomy.modelById(m).brandId, tokens: [] })));
  ['Realme C25', 'Realme C25s', 'Vivo Y18e', 'Vivo T3 Lite', 'Oppo A16', 'Oppo A16s', 'Oppo A54', 'Vivo Y20i']
    .forEach(n => models.set(id(n), { name: nameOf(id(n)), brandId: taxonomy.modelById(id(n)).brandId, tokens: [] }));
  const modelGroups = new Map();
  groups.forEach(g => g.memberIds.forEach(m => { const row = modelGroups.get(m) || {}; (row[g.categoryId] = row[g.categoryId] || []).push(g.id); modelGroups.set(m, row); }));

  const entries = fake.all(C.APPROVED_COMPATIBILITIES);
  const overlay = applyApprovedOverlay({ entries }, groups, models, modelGroups, Array.from(tax.categories.values()));
  assert.deepEqual(overlay.unapplied, [], 'nothing refused');
  assert.equal(overlay.applied, 5, 'C25, C25s, Y18e, T3 Lite, Y20i');
  assert.equal(overlay.createdGroups, 1);
  assert.equal(overlay.merged, 1);

  const byId = new Map(groups.map(g => [g.id, g]));
  assert.equal(byId.get('bf-9001').partCode, 'MPF-BF-9001', 'the number issued at run time, not a new one');
  assert.equal(byId.get('bf-9001').memberIds[0], id('Oppo A16'));
  assert.equal(byId.has('cd-0557'), false, 'the absorbed group is gone from the build');
  assert.ok(byId.get('cd-0678').memberIds.indexOf(id('Vivo Y36')) > -1, 'its model is in the survivor');
  assert.deepEqual(modelGroups.get(id('Vivo Y36')), { 'combo-display': ['cd-0678'] });
  assert.deepEqual(findDuplicateAssignments(modelGroups), [], 'one category + one model = one group, in the build too');

  /* folding the same ledger into a build that already has it changes nothing */
  const second = applyApprovedOverlay({ entries }, groups, models, modelGroups, Array.from(tax.categories.values()));
  assert.equal(second.applied + second.createdGroups + second.merged, 0);
  assert.deepEqual(second.unapplied, []);
});

/* ===================================================================== undo */

test('a person can undo what one list did: the models come out again, the created group goes, a merged group is a group again', async () => {
  const fake = world();
  await runJob('https://www.instagram.com/sk_mobile_doctar/', depsFor([PATTA_POST, image('vivo', 'Vivo Y20 combo compatible models')], {
    patta: { vision: PATTA },
    vivo: { vision: DISPLAY(['Vivo Y20', 'Vivo Y20a', 'Vivo Y20g', 'Vivo Y12s', 'Vivo Y20i', 'Vivo Y36']) }
  }));
  const byOutcome = o => proposalsOf(fake).filter(p => p.productionOutcome === o);
  const realme = byOutcome('applied').find(p => p.appliedChange.groupId === 'bf-0010');
  const oppo = byOutcome('created')[0];
  const vivo = byOutcome('applied').find(p => p.appliedChange.groupId === 'cd-0678');

  /* models added to an existing group */
  const a = await review.undoProposal({ candidateId: realme.candidateId, admin: ADMIN, now: clock() });
  assert.deepEqual(a.removedModelIds.slice().sort(), ids(['Realme C25', 'Realme C25s']));
  assert.deepEqual(members(fake, 'bf-0010'), ids(['Realme 5', 'Realme 5s', 'Realme 5i', 'Realme C3', 'Realme C11', 'Realme C12', 'Realme C15']),
    'exactly as it was before the scan');
  assert.equal(fake.read(C.GROUPS + '/bf-0010').memberCount, 7);
  assert.equal(fake.read(C.GROUPS + '/bf-0010').masterModelId, id('Realme 5'));
  assert.deepEqual(fake.read(C.MODEL_GROUPS + '/' + id('Realme C25')).byCategory['button-flex'], [], 'free to be grouped again');
  assert.ok(taxonomy.modelById(id('Realme C25')), 'the model itself is still in the catalogue');
  assert.equal(fake.read(C.COMPATIBILITY_CANDIDATES + '/' + realme.candidateId).status, 'reverted');
  const led = fake.all(C.APPROVED_COMPATIBILITIES).filter(e => e.proposalId === realme.candidateId);
  assert.ok(led.length === 2 && led.every(e => e.status === 'reverted'), 'kept, and marked — the build will not put them back');
  await assert.rejects(() => review.undoProposal({ candidateId: realme.candidateId, admin: ADMIN, now: clock() }), e => e.code === 'wrong-status', 'once');

  /* a group that was created */
  const b = await review.undoProposal({ candidateId: oppo.candidateId, admin: ADMIN, now: clock() });
  assert.equal(b.deletedGroup, 'BF-9001');
  assert.ok(!fake.read(C.GROUPS + '/bf-9001') && !fake.read(C.GROUP_DETAILS + '/bf-9001'));
  assert.deepEqual(fake.read(C.MODEL_GROUPS + '/' + id('Oppo A16')).byCategory['button-flex'], []);

  /* an added model and a merge made by the same list */
  assert.equal(members(fake, 'cd-0678').length, 9);
  const c = await review.undoProposal({ candidateId: vivo.candidateId, admin: ADMIN, now: clock() });
  assert.deepEqual(c.removedModelIds.slice().sort(), ids(['Vivo Y20i', 'Vivo Y36']));
  assert.deepEqual(c.restoredGroups, ['CD-0557']);
  assert.equal(fake.all(C.APPROVED_COMPATIBILITIES).find(e => e.kind === 'merge_groups').status, 'reverted');
  assert.deepEqual(members(fake, 'cd-0678'), ids(['Vivo Y11s', 'Vivo Y20', 'Vivo Y20a', 'Vivo Y20g', 'Vivo Y20s', 'Vivo Y12s', 'vivo iQOO U1x']), 'as it was');
  assert.ok(!fake.read(C.GROUPS + '/cd-0557').mergedInto && !fake.read(C.GROUP_DETAILS + '/cd-0557').mergedInto, 'the merged group is a group again');
  assert.deepEqual(fake.read(C.GROUP_DETAILS + '/cd-0557').memberIds, [id('Vivo Y36')]);
  assert.deepEqual(fake.read(C.MODEL_GROUPS + '/' + id('Vivo Y36')).byCategory['combo-display'], ['cd-0557']);

  /* and the build folds none of it back in */
  const groups = fake.paths('groupDetails/').map(p => { const gd = fake.read(p); return { id: p.split('/')[1], categoryId: gd.categoryId, memberIds: gd.memberIds.slice(), memberNames: gd.memberNames.slice() }; });
  const models = new Map(); groups.forEach(g => g.memberIds.forEach(m => models.set(m, { name: nameOf(m), tokens: [] })));
  const overlay = applyApprovedOverlay({ entries: fake.all(C.APPROVED_COMPATIBILITIES) }, groups, models, new Map(), Array.from(taxonomy.taxonomy().categories.values()));
  assert.equal(overlay.applied + overlay.createdGroups + overlay.merged, 0, 'nothing that was undone comes back');
  assert.equal(overlay.alreadyInBuild, 2, 'the Vivo button-flex list was not undone: its two models are in the group');
  assert.deepEqual(overlay.unapplied, []);
  assertOneGroupPerCategory(fake);
});

test('undo refuses what it cannot take back cleanly: a created group that has since gained models', async () => {
  const fake = world();
  await runJob('https://www.instagram.com/sk_mobile_doctar/', depsFor([PATTA_POST], { patta: { vision: PATTA } }));
  const next = { contentClass: 'compatibility', confidence: 0.96, product: 'On Off Patta', text: '', lists: [
    { headline: 'On Off Patta Compatible Models', atSecond: 0, models: ['Oppo A16', 'Oppo A16s', 'Oppo A54', 'Oppo A53s'] }] };
  await runJob('https://www.instagram.com/sk_mobile_doctar/', depsFor([image('oppo2', 'Universal on off patta')], { oppo2: { vision: next } }));
  const created = proposalsOf(fake).find(p => p.productionOutcome === 'created');
  const before = JSON.stringify(fake.read(C.GROUP_DETAILS + '/bf-9001'));
  await assert.rejects(() => review.undoProposal({ candidateId: created.candidateId, admin: ADMIN, now: clock() }), e => e.code === 'group-grew');
  assert.equal(JSON.stringify(fake.read(C.GROUP_DETAILS + '/bf-9001')), before, 'nothing was changed');
});
