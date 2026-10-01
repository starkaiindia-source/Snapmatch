/* ============================================================================
   api/_lib/instagram-cost.test.js
   ----------------------------------------------------------------------------
   The cost pipeline: cheap first, a model only when it is needed.

     · 150 posts must not mean 150 expensive calls — the cheap filter and a
       visual screen decide which few get a deep read
     · the same media is never paid for twice; a repeated scan costs nothing
     · a sync has a budget; when it is spent the rest waits for a person
     · Gemini reads media, Claude is asked only where matching left doubt, and
       neither of them resolves a model, a group or a conflict
     · every call is counted with its tokens and an estimated cost

   The providers here are stand-ins that return scripted answers and record
   how they were called — that is what a unit test is for. Nothing in api/
   contains a stand-in: scripts/instagram-verify-providers.js and
   scripts/instagram-ai-smoke.js exercise the real ones.
   ========================================================================== */
'use strict';

/* hermetic: whatever keys this machine has, these tests use none of them */
['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_VISION_API_KEY', 'AI_GATEWAY_URL', 'AI_GATEWAY_TOKEN', 'INSTAGRAM_AI_PRICES'].forEach(k => { delete process.env[k]; });

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeFirestore } = require('./testing/fake-firestore');
const fsx = require('../_services/instagram/firestore');
const jobs = require('../_services/instagram/job-service');
const review = require('../_services/instagram/review-service');
const configMod = require('../_services/instagram/config');
const relevance = require('../_services/instagram/relevance');
const aiProviders = require('../_services/instagram/ai-providers');
const { verifyProviders } = require('../_services/instagram/provider-check');
const { createMediaProcessor, mp4DurationSeconds, validateVisionOutput } = require('../_services/instagram/media-processor');
const { normaliseMedia } = require('../_services/instagram/graph-client');
const taxonomy = require('../_services/taxonomy-service');
const C = require('../_schema/collections');

const ADMIN = { uid: 'ownerUid000001', email: 'stark.ai.india@gmail.com', role: 'super_admin' };
const NOW = Date.UTC(2026, 9, 1, 9, 0);
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
  fake.seed('groupDetails/' + groupId, { groupNo: groupId.toUpperCase(), categoryId, memberIds: ids, memberNames: ids.map(nameOf), memberCount: ids.length });
  ids.forEach(m => {
    const cur = fake.read('modelGroups/' + m) || { id: m, byCategory: {} };
    cur.byCategory[categoryId] = (cur.byCategory[categoryId] || []).concat(groupId);
    fake.seed('modelGroups/' + m, cur);
  });
}

function world() {
  const fake = createFakeFirestore();
  fsx.use(fake.provider);
  require('./firebase').db = () => fake.db;
  fake.seed('catalog/meta', { version: 1 });
  seedGroup(fake, 'cd-0678', 'combo-display', 'Vivo Y11s', ['Vivo Y11s', 'Vivo Y20', 'Vivo Y20a']);
  seedGroup(fake, 'cd-0557', 'combo-display', 'Vivo Y36', ['Vivo Y36']);
  return fake;
}

function cfg(over) {
  return Object.assign(configMod.load(), {
    graph: { token: 'test-token', igUserId: '17841400000000000', version: 'v25.0', timeoutMs: 1000, appSecret: '' },
    ocrProvider: 'none', visionProvider: 'gemini', videoProvider: 'gemini', validator: 'anthropic',
    geminiKey: 'test-only-gemini-key-not-real', anthropicKey: 'test-only-anthropic-key-not-real',
    geminiModel: 'gemini-3.8-flash', geminiScreenModel: 'gemini-3.1-flash-lite', claudeModel: 'claude-opus-5-5', claudeEffort: 'medium',
    confidenceHigh: 0.9, confidenceValidate: 0.7, aiRetries: 0, videoFps: 2, readRepairMedia: false, aiMode: 'off', prices: {},
    maxItemsPerJob: 200, maxDiscoveryPages: 10, pageSize: 50, maxCarouselChildren: 10, maxAttempts: 3,
    maxImageBytes: 8 * 1024 * 1024, maxVideoBytes: 60 * 1024 * 1024,
    tickBudgetMs: 10 * 60 * 1000, leaseMs: 60000,
    maxAiItemsPerSync: 1000, maxGeminiCallsPerSync: 1000, maxClaudeCallsPerSync: 100, maxVideoMinutesPerSync: 600,
    dailyGraphCalls: 1000, dailyOcrCalls: 1000, dailyAiCalls: 5000, dailyVideoCalls: 1000
  }, over || {});
}

/* --------------------------------------------------- scripted stand-ins */

const LIST = { contentClass: 'compatibility', confidence: 0.95, product: 'display combo',
  lists: [{ headline: 'Vivo Y20 Combo', models: ['Vivo Y20', 'Vivo Y20a', 'Vivo Y20i'], atSecond: 0 }], text: '' };
const PRODUCT_ONLY = { contentClass: 'product', confidence: 0.9, product: 'display combo', lists: [], text: '' };
const TOKENS = { inputTokens: 1000, outputTokens: 100 };
const DEEP_COST = 1000 * 0.75 + 100 * 3.75;        /* gemini-3.8-flash, micro-dollars */
const SCREEN_COST = 1000 * 0.25 + 100 * 1.5;       /* gemini-3.1-flash-lite */

const noAi = { isConfigured: () => false, status: () => ({ model: null, missing: [] }), invoke: async () => ({ ok: false, reason: 'ai-unconfigured' }) };

/** A CDN: "https://cdn/<id>.jpg" is the image <id>; ".mp4" the video. */
function cdn(sizes = {}) {
  return async url => {
    const m = /^https:\/\/cdn\/([a-z0-9]+)\.(jpg|mp4)$/.exec(String(url));
    if (!m) throw new Error('unexpected fetch in a test: ' + String(url).slice(0, 60));
    const tag = Buffer.from((m[2] === 'mp4' ? 'VID:' : 'IMG:') + m[1] + ';');
    const bytes = sizes[m[1]] ? Buffer.concat([tag, Buffer.alloc(sizes[m[1]])]) : tag;
    return { ok: true, status: 200, headers: { get: h => (h === 'content-type' ? (m[2] === 'mp4' ? 'video/mp4' : 'image/jpeg') : String(bytes.length)) },
             arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
}

function mediaIdOf(part, uploads) {
  if (part.uri) return uploads.get(part.uri);
  const head = Buffer.from(part.data, 'base64').slice(0, 40).toString('latin1');
  return /^(?:IMG|VID):([a-z0-9]+);/.exec(head)[1];
}

/** Gemini: answers from `script[id].screen` / `script[id].vision`, and records every call. */
function fakeGemini(script, { fail } = {}) {
  const calls = [];
  const uploads = new Map();
  const deleted = [];
  return {
    calls, deleted, uploads,
    configured: () => true,
    interact: async ({ model, input, schema }) => {
      const part = input.find(p => p.type === 'image' || p.type === 'video');
      const mid = mediaIdOf(part, uploads);
      const stage = schema.properties.verdict ? 'screen' : 'read';
      calls.push({ model, stage, id: mid, kind: part.type, resolution: part.resolution, processing: part.processing || null, viaFile: !!part.uri });
      if (fail) return fail({ model, stage, id: mid, n: calls.length });
      const s = script[mid] || {};
      const output = stage === 'screen' ? (s.screen || { verdict: 'UNCERTAIN', kind: 'product', hasModelList: false, reason: 'small text' })
        : (s.vision || PRODUCT_ONLY);
      return { ok: true, output, text: JSON.stringify(output), model, usage: Object.assign({}, TOKENS) };
    },
    uploadFile: async (bytes) => {
      const uri = 'https://generativelanguage.googleapis.com/v1beta/files/f' + (uploads.size + 1);
      uploads.set(uri, /^VID:([a-z0-9]+);/.exec(bytes.slice(0, 40).toString('latin1'))[1]);
      return { ok: true, uri, name: 'files/f' + uploads.size };
    },
    deleteFile: async name => { deleted.push(name); },
    listModels: async () => ({ ok: true, models: ['gemini-3.8-flash', 'gemini-3.1-flash-lite'] })
  };
}

/** Claude: `answer(request, hasImage)` returns the validation JSON. */
function fakeClaude(answer, { fail } = {}) {
  const calls = [];
  return {
    calls,
    configured: () => true,
    retrieveModel: async model => ({ ok: true, model }),
    structured: async ({ model, content, schema, effort, system }) => {
      const text = content.find(c => c.type === 'text').text;
      const request = /\{[\s\S]*\}$/.exec(text) ? JSON.parse(/\{[\s\S]*\}$/.exec(text)[0]) : null;
      calls.push({ model, effort, request, hasImage: content.some(c => c.type === 'image'), schemaKeys: Object.keys(schema.properties), system });
      if (fail) return fail();
      return { ok: true, output: answer(request, content.some(c => c.type === 'image')), model, usage: { inputTokens: 2000, outputTokens: 300 } };
    }
  };
}

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
  permalink: `https://www.instagram.com/p/${('POST' + mid + 'XXXXX').slice(0, 11)}/`, timestamp: '2026-09-20T10:00:00+0000', caption });
const reel = (mid, caption, withVideo = true) => Object.assign({ id: mid, media_type: 'VIDEO', media_product_type: 'REELS',
  permalink: `https://www.instagram.com/reel/${('REEL' + mid + 'XXXXX').slice(0, 11)}/`, timestamp: '2026-09-21T10:00:00+0000', caption },
  withVideo ? { media_url: `https://cdn/${mid}.mp4` } : {});

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

const proposalsOf = fake => fake.all(C.COMPATIBILITY_CANDIDATES).filter(c => c.kind === 'group_proposal');
const pages = (list, size) => list.reduce((out, x, i) => { (out[Math.floor(i / size)] = out[Math.floor(i / size)] || []).push(x); return out; }, []);

/* ========================================================== the cheap filter */

test('the cheap filter is a weighted score: repair wording lowers it, and only clear repair is rejected', () => {
  const tier = (caption, sourceStats) => relevance.scoreCandidate({ caption, contentType: 'reel', sourceStats }).tier;
  ['Samsung galaxy A14 5g display light jumper', 'Realme c65 no baseband problem', 'Oppo A15 Display Light Jumper',
   'Samsung A21S Temperature Charging Error', 'Redmi 9 Power dead shorting remove capacitor',
   'Samsung A03S temperature warning OVP IC bypass', 'Redmi Note 10 power button jumper', 'iPhone 11 no network solution']
    .forEach(c => assert.equal(tier(c), 'REJECT', c));

  /* the brief's own example: a jumper word beside a product is not a rejection */
  assert.equal(tier('Vivo Y20 display jumper'), 'LOW', 'screened, not thrown away');
  assert.equal(tier('Vivo Y20 display jumper. Compatible with Vivo Y20, Y21, Y21S'), 'HIGH', 'compatibility wording wins over a repair word');

  /* a generic caption is never a reason to skip */
  ['Universal combo ...', 'यह एक Display लग जाएगा 68 models में'].forEach(c => assert.equal(tier(c), 'HIGH', c));
  ['New stock 🔥', '', 'Samsung new arrivals'].forEach(c => assert.equal(tier(c), 'LOW', JSON.stringify(c)));
  ['Battery stock', 'Vivo Y20 Combo'].forEach(c => assert.equal(tier(c), 'MEDIUM', c));

  /* what the page posted before is a one-point nudge, shown, and can never reject */
  const quiet = { content: 200, relevant: 0 };
  const scored = relevance.scoreCandidate({ caption: 'New stock', sourceStats: quiet });
  assert.equal(scored.score, -1);
  assert.equal(scored.tier, 'LOW', 'a page that has never posted compatibility content is still screened');
  assert.ok(scored.reasons.some(r => /rarely posted/.test(r.signal)), 'and the nudge is on the record');
  assert.equal(relevance.scoreCandidate({ caption: 'New stock', sourceStats: { content: 40, relevant: 20 } }).tier, 'MEDIUM');
});

/* ============================================================ the providers */

test('Gemini is called through the Interactions API with a schema, store:false and the key in a header only', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({
      model: 'gemini-3.8-flash', status: 'completed',
      steps: [{ type: 'thought' }, { type: 'model_output', content: [{ type: 'text', text: '{"verdict":"UNCERTAIN"}' }] }],
      usage: { total_input_tokens: 300, total_output_tokens: 20, total_thought_tokens: 40, total_cached_tokens: 0 }
    }) };
  };
  const gemini = aiProviders.createGemini({ key: 'test-only-gemini-key-not-real', fetchImpl });
  const r = await gemini.interact({
    model: 'gemini-3.8-flash', system: 'sys', schema: { type: 'object' }, thinkingLevel: 'low', maxOutputTokens: 100,
    input: [{ type: 'image', data: 'AAAA', mime_type: 'image/jpeg', resolution: 'high' }, { type: 'text', text: 'read' }]
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.output, { verdict: 'UNCERTAIN' });
  assert.deepEqual(r.usage, { inputTokens: 300, outputTokens: 60, cachedTokens: 0 }, 'thinking tokens are billed as output');

  const { url, init } = seen[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(init.headers['x-goog-api-key'], 'test-only-gemini-key-not-real');
  assert.ok(url.indexOf('test-only') < 0, 'the key is never in a URL');
  const body = JSON.parse(init.body);
  assert.equal(body.store, false, 'nothing is kept on Google\'s side');
  assert.equal(body.system_instruction, 'sys');
  assert.deepEqual(body.response_format, { type: 'text', mime_type: 'application/json', schema: { type: 'object' } });
  assert.deepEqual(body.generation_config, { max_output_tokens: 100, thinking_level: 'low' });
  assert.equal(body.input[0].resolution, 'high');
});

test('a thinking level a model does not have is stepped up, once, and remembered', async () => {
  /* the first live provider check: gemini-3.8-flash has no "minimal" */
  aiProviders._internal.refusedLevels.clear();
  const sent = [];
  const supports = { 'gemini-3.8-flash': ['low', 'medium', 'high'], 'gemini-3.1-flash-lite': ['minimal', 'high'], 'no-levels-model': [] };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const level = (body.generation_config || {}).thinking_level;
    sent.push({ model: body.model, level: level || null });
    if (level && supports[body.model].indexOf(level) < 0) {
      return { ok: false, status: 400, headers: { get: () => null }, json: async () => ({ error: { code: 400, status: 'INVALID_ARGUMENT',
        message: 'Thinking level THINKING_LEVEL_' + level.toUpperCase() + ' is not supported for this model. Please retry with other thinking level.' } }) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: body.model, status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"saw_image":true}' }] }], usage: { total_input_tokens: 260, total_output_tokens: 8 } }) };
  };
  const gemini = aiProviders.createGemini({ key: 'test-only-gemini-key-not-real', fetchImpl });
  const ask = (model, thinkingLevel) => gemini.interact({ model, thinkingLevel, schema: { type: 'object' }, maxOutputTokens: 64, input: [{ type: 'text', text: 'x' }] });

  const first = await ask('gemini-3.8-flash', 'minimal');
  assert.equal(first.ok, true, 'the refusal is not the answer');
  assert.equal(first.thinkingLevel, 'low', 'the next level up, not a jump to the most expensive');
  assert.deepEqual(sent.map(s => s.level), ['minimal', 'low']);

  await ask('gemini-3.8-flash', 'minimal');
  assert.deepEqual(sent.map(s => s.level), ['minimal', 'low', 'low'], 'the refused level is not tried again');

  const lite = await ask('gemini-3.1-flash-lite', 'minimal');
  assert.equal(lite.thinkingLevel, 'minimal', 'a model that has the level keeps it — what one model refused says nothing about another');

  /* a model that refuses every level is asked with none: its own default */
  const none = await ask('no-levels-model', 'low');
  assert.equal(none.ok, true);
  assert.equal(none.thinkingLevel, null);
  assert.deepEqual(sent.filter(s => s.model === 'no-levels-model').map(s => s.level), ['low', 'medium', 'high', null]);

  /* and the provider check, the call that failed live, now passes on both models */
  aiProviders._internal.refusedLevels.clear();
  const report = await verifyProviders({
    cfg: cfg({ validator: 'none', anthropicKey: '' }),
    gemini: Object.assign({}, gemini, { listModels: async () => ({ ok: true, models: ['gemini-3.8-flash', 'gemini-3.1-flash-lite'] }) }),
    graph: { ownProfile: async () => ({ username: 'mpf_official' }) }
  });
  assert.equal(report.providers.gemini.status, 'VERIFIED');
  assert.deepEqual(report.providers.gemini.calls.map(c => [c.model, c.thinkingLevel]),
    [['gemini-3.8-flash', 'low'], ['gemini-3.1-flash-lite', 'minimal']], 'each model is checked at the level the pipeline asks of it');
  aiProviders._internal.refusedLevels.clear();
});

test('a provider failure is named for what it is, and never carries the key', async () => {
  const answer = (status, body) => async () => ({ ok: false, status, headers: { get: () => null }, json: async () => body });
  const call = async fetchImpl => aiProviders.createGemini({ key: 'test-only-gemini-key-not-real', fetchImpl })
    .interact({ model: 'gemini-3.8-flash', input: [{ type: 'text', text: 'x' }] });

  const invalid = await call(answer(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }));
  assert.equal(invalid.kind, 'auth');
  assert.equal(invalid.code, 'API_KEY_INVALID');
  const limited = await call(answer(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }));
  assert.equal(limited.kind, 'rate_limited');
  const down = await call(answer(503, { error: { message: 'overloaded' } }));
  assert.equal(down.retryable, true);
  const missing = await aiProviders.createGemini({ key: '' }).interact({ model: 'm', input: [] });
  assert.equal(missing.code, 'API_KEY_MISSING');
  [invalid, limited, down, missing].forEach(r => assert.ok(JSON.stringify(r).indexOf('test-only') < 0));
});

test('Claude is asked for structured output with the refusal fallback — never with a forced tool call', async () => {
  let sent = null;
  const client = { beta: { messages: { create: async params => {
    sent = params;
    return { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"ok":true}' }],
             usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0 } };
  } } }, models: { retrieve: async model => ({ id: model, display_name: 'Claude Opus 5.5' }) } };
  const claude = aiProviders.createClaude({ client });
  const schema = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  const r = await claude.structured({ model: 'claude-opus-5-5', system: 'sys', schema, effort: 'medium', content: [{ type: 'text', text: 'check' }] });
  assert.deepEqual(r.output, { ok: true });
  assert.deepEqual(r.usage, { inputTokens: 1200, outputTokens: 80 });

  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.tool_choice, undefined, 'claude-opus-5-5 rejects a forced tool call');
  assert.equal(sent.tools, undefined);
  assert.deepEqual(sent.output_config, { effort: 'medium', format: { type: 'json_schema', schema } });
  assert.deepEqual(sent.thinking, { type: 'adaptive' });
  assert.equal(sent.fallbacks, 'default');
  assert.deepEqual(sent.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(sent.temperature, undefined, 'sampling parameters are rejected by this model');

  client.beta.messages.create = async () => ({ model: 'claude-opus-5-5', stop_reason: 'refusal', content: [], usage: { input_tokens: 10, output_tokens: 0 } });
  const refused = await claude.structured({ model: 'claude-opus-5-5', system: 's', schema, content: [] });
  assert.equal(refused.kind, 'refused', 'a refusal is checked before the content is read');
});

test('cost is estimated from the provider\'s own token counts; an unpriced model is unknown, never free', () => {
  assert.equal(aiProviders.estimateCost('gemini-3.8-flash', TOKENS), DEEP_COST);
  assert.equal(aiProviders.estimateCost('gemini-3.1-flash-lite', TOKENS), SCREEN_COST);
  assert.equal(aiProviders.estimateCost('models/gemini-3.8-flash', TOKENS), DEEP_COST);
  assert.equal(aiProviders.estimateCost('gemini-3.5-flash-lite', TOKENS), 1000 * 0.30 + 100 * 2.50, 'the longest matching name wins, not "3.5-flash"');
  assert.equal(aiProviders.estimateCost('claude-opus-5-5', { inputTokens: 2000, outputTokens: 300 }), 2000 * 4 + 300 * 20);
  assert.equal(aiProviders.estimateCost('gemini-9-future', TOKENS), null);
  assert.equal(aiProviders.estimateCost('gemini-9-future', TOKENS, { 'gemini-9': [1, 2] }), 1000 * 1 + 100 * 2, 'INSTAGRAM_AI_PRICES extends the table');
});

/* ============================================================ media readers */

function processor(script, over, opts = {}) {
  const gemini = fakeGemini(script, opts);
  const store = new Map();
  const recorded = [];
  const usage = {
    allow: () => true, record: k => recorded.push(k), budgetAllow: () => true,
    recordAi: x => recorded.push(x), addVideoSeconds: s => recorded.push({ videoSeconds: s })
  };
  const media = createMediaProcessor({
    cfg: cfg(over), ai: noAi, fetchImpl: cdn(opts.sizes), usage,
    cache: { get: async k => store.get(k) || null, put: async (k, v) => { store.set(k, v); } },
    providers: { gemini, claude: fakeClaude(() => ({})) }
  });
  return { media, gemini, recorded };
}

test('screening is the small model at low resolution with a three-way answer — and is paid for once per image', async () => {
  const { media, gemini } = processor({ a1: { screen: { verdict: 'LIKELY_IRRELEVANT', kind: 'repair', hasModelList: false, reason: 'a marked circuit board' } } });
  const s = await media.screenImage({ mediaId: 'a1', mediaUrl: 'https://cdn/a1.jpg' });
  assert.equal(s.status, 'ok');
  assert.equal(s.verdict, 'LIKELY_IRRELEVANT');
  assert.equal(s.kind, 'repair');
  assert.deepEqual(gemini.calls, [{ model: 'gemini-3.1-flash-lite', stage: 'screen', id: 'a1', kind: 'image', resolution: 'low', processing: null, viaFile: false }]);
  assert.equal((await media.screenImage({ mediaId: 'a1-reposted', mediaUrl: 'https://cdn/a1.jpg' })).cached, true);
  assert.equal(gemini.calls.length, 1, 'the same bytes are never screened twice');

  const read = await media.understandImage({ mediaId: 'a2', mediaUrl: 'https://cdn/a2.jpg', ocrText: '' });
  assert.equal(read.contentClass, 'product');
  assert.equal(gemini.calls[1].model, 'gemini-3.8-flash');
  assert.equal(gemini.calls[1].resolution, 'high', 'the deep read is the main model at full resolution');
});

test('a reel is read as a VIDEO in two passes; the second runs only if the first does not say no', async () => {
  const script = {
    v1: { screen: { verdict: 'LIKELY_IRRELEVANT', kind: 'repair', hasModelList: false, reason: 'soldering' } },
    v2: { screen: { verdict: 'LIKELY_COMPATIBILITY', kind: 'compatibility', hasModelList: true, reason: 'a list near the end' },
          vision: Object.assign({}, LIST, { lists: [{ headline: 'Vivo Y20 Combo', models: ['Vivo Y20', 'Vivo Y20a', 'Vivo Y20i'], atSecond: 11.5 }] }) },
    v3: { vision: LIST }
  };
  const { media, gemini } = processor(script);

  const none = await media.understandVideo({ mediaId: 'v0', mediaUrl: null, tier: 'LOW' });
  assert.equal(none.status, 'unavailable');
  assert.equal(none.code, 'VIDEO_MEDIA_UNAVAILABLE', 'no media URL is said plainly — a cover is never passed off as the video');
  assert.equal(gemini.calls.length, 0);

  const repair = await media.understandVideo({ mediaId: 'v1', mediaUrl: 'https://cdn/v1.mp4', tier: 'LOW' });
  assert.equal(repair.contentClass, 'repair');
  assert.equal(repair.passes, 1);
  assert.equal(gemini.calls.length, 1, 'an irrelevant reel costs one cheap call, not a full analysis');
  assert.deepEqual(gemini.calls[0], { model: 'gemini-3.1-flash-lite', stage: 'screen', id: 'v1', kind: 'video', resolution: 'low',
    processing: { type: 'static', fps: 0.5 }, viaFile: false });

  const list = await media.understandVideo({ mediaId: 'v2', mediaUrl: 'https://cdn/v2.mp4', tier: 'LOW' });
  assert.equal(list.passes, 2);
  assert.equal(list.lists[0].atSecond, 11.5, 'the second the list is readable at is kept');
  assert.deepEqual(gemini.calls[2], { model: 'gemini-3.8-flash', stage: 'read', id: 'v2', kind: 'video', resolution: 'high',
    processing: { type: 'static', fps: 2 }, viaFile: false });

  const before = gemini.calls.length;
  const direct = await media.understandVideo({ mediaId: 'v3', mediaUrl: 'https://cdn/v3.mp4', tier: 'HIGH' });
  assert.equal(direct.passes, 1);
  assert.equal(gemini.calls.length - before, 1, 'a caption that already says "compatible" skips the screening pass');
  assert.equal(gemini.calls[before].stage, 'read');

  assert.equal((await media.understandVideo({ mediaId: 'v2', mediaUrl: 'https://cdn/v2.mp4', tier: 'LOW' })).cached, true);
  assert.equal(gemini.calls.length, before + 1, 'a reel already analysed is never sent again');

  const segs = jobs._internal.visionSegments(list, 'v2', '');
  assert.equal(segs[0].ref, 'v2@11500ms', 'evidence carries the timestamp');
  assert.equal(segs[0].source, 'vision');
});

test('a large reel goes through the Files API and is deleted afterwards; duration is read from the file', async () => {
  const { media, gemini, recorded } = processor({ big: { vision: LIST } }, null, { sizes: { big: 15 * 1024 * 1024 } });
  const r = await media.understandVideo({ mediaId: 'big', mediaUrl: 'https://cdn/big.mp4', tier: 'HIGH' });
  assert.equal(r.status, 'ok');
  assert.equal(gemini.calls[0].viaFile, true, '15 MB does not fit an inline request');
  assert.deepEqual(gemini.deleted, ['files/f1'], 'the upload is not left behind');
  assert.ok(recorded.some(x => x && x.provider === 'gemini' && x.stage === 'video'));

  const mvhd = Buffer.alloc(40);
  mvhd.write('mvhd', 4, 'latin1');          /* version 0 */
  mvhd.writeUInt32BE(1000, 20);             /* timescale */
  mvhd.writeUInt32BE(30500, 24);            /* duration  */
  assert.equal(mp4DurationSeconds(mvhd), 30.5);
  assert.equal(mp4DurationSeconds(Buffer.from('not a video')), null);
});

test('what a model returns is validated: unknown classes are refused, and a model named in a repair image is not an entry', () => {
  assert.equal(validateVisionOutput({ contentClass: 'nonsense', lists: [] }).ok, false);
  assert.equal(validateVisionOutput({ contentClass: 'compatibility' }).ok, false);
  const repair = validateVisionOutput({ contentClass: 'repair', confidence: 0.9, product: '', text: 'jumper', lists: [{ headline: '', models: ['Samsung A14'], atSecond: 0 }] });
  assert.deepEqual(repair.value.lists, []);
  const twice = validateVisionOutput({ contentClass: 'compatibility', confidence: 7, product: 'combo', text: '',
    lists: [{ headline: 'Vivo Y20 Combo', models: ['Vivo Y20', 'vivo y20', 'Vivo Y20a'], atSecond: -3 }] });
  assert.deepEqual(twice.value.lists[0].models, ['Vivo Y20', 'Vivo Y20a'], 'a model listed twice is one entry');
  assert.equal(twice.value.confidence, 1, 'confidence is clamped');
  assert.equal(twice.value.lists[0].atSecond, 0);
  assert.equal(validateVisionOutput({ contentClass: 'compatibility', headline: 'X', models: ['Vivo Y20', 'Vivo Y20a'] }).value.lists.length, 1, 'the earlier single-list shape still reads');
});

/* ========================================================= the whole funnel */

function bigPage() {
  const repair = ['Samsung galaxy A14 5g display light jumper', 'Realme c65 no baseband problem', 'Oppo A15 Display Light Jumper',
    'Samsung A21S Temperature Charging Error', 'Redmi 9 Power dead shorting remove capacitor'];
  const posts = [];
  const script = {};
  for (let i = 1; i <= 100; i++) posts.push(image('x' + i, repair[i % repair.length] + ' — tip ' + i));
  for (let i = 1; i <= 30; i++) {
    posts.push(image('g' + i, 'New stock ' + (i > 9 ? 'today' : 'now') + ' ' + '🔥'.repeat((i % 3) + 1) + ' no ' + 'x'.repeat(i)));
    script['g' + i] = i <= 24 ? { screen: { verdict: 'LIKELY_IRRELEVANT', kind: 'product', hasModelList: false, reason: 'a product photo, no list' } }
      : { screen: { verdict: 'UNCERTAIN', kind: 'product', hasModelList: false, reason: 'small text' }, vision: i <= 28 ? LIST : PRODUCT_ONLY };
  }
  for (let i = 1; i <= 10; i++) { posts.push(image('c' + i, 'Universal combo offer ' + 'x'.repeat(i))); script['c' + i] = { vision: LIST }; }
  for (let i = 1; i <= 10; i++) {
    posts.push(reel('v' + i, 'Watch till the end ' + 'x'.repeat(i)));
    script['v' + i] = i <= 7 ? { screen: { verdict: 'LIKELY_IRRELEVANT', kind: 'repair', hasModelList: false, reason: 'a repair bench' } }
      : { screen: { verdict: 'LIKELY_COMPATIBILITY', kind: 'compatibility', hasModelList: true, reason: 'a list' }, vision: LIST };
  }
  return { posts, script };
}

test('150 posts are not 150 expensive calls: the funnel, the bill, and a second scan that costs nothing', async () => {
  const fake = world();
  const { posts, script } = bigPage();
  assert.equal(posts.length, 150);
  const gemini = fakeGemini(script);
  const claude = fakeClaude(() => { throw new Error('Claude must not be asked about a clean list'); });
  const deps = { cfg: cfg(), graph: fakeGraph({ sk_mobile_doctar: pages(posts, 50) }), ai: noAi, fetchImpl: cdn(), providers: { gemini, claude } };
  const job = await runJob('https://www.instagram.com/sk_mobile_doctar/', deps);

  assert.equal(job.status, 'completed');
  const c = job.counts, u = job.usage;
  assert.equal(c.postsFound, 150);
  assert.equal(c.processed, 150);
  assert.equal(c.cheapRejected, 100, 'a hundred repair posts cost nothing at all');
  assert.equal(c.screened, 40, '30 generic images and 10 reels get the cheap look');
  assert.equal(c.screenRejected, 31, 'and most of them stop there');
  assert.equal(c.deepAnalysed, 19, 'only 19 of 150 reach the expensive read');
  assert.equal(c.videosUnderstood, 3);
  assert.equal(c.relevant, 17);
  assert.equal(c.ignored, 133);
  assert.equal(c.extracted, 17);

  assert.equal(u.geminiCalls, 59);
  assert.equal(u.screenCalls, 40);
  assert.equal(gemini.calls.filter(x => x.model === 'gemini-3.8-flash').length, 19);
  assert.equal(u.claudeCalls, 0, 'clean, confident lists need no second opinion');
  assert.equal(claude.calls.length, 0);
  assert.equal(u.geminiInputTokens, 59 * 1000);
  assert.equal(u.geminiOutputTokens, 59 * 100);
  assert.equal(u.costMicroUsd, 19 * DEEP_COST + 40 * SCREEN_COST, 'the estimate is the sum of what each model call cost');
  assert.equal(u.costUnknownCalls, 0);
  assert.ok(u.costMicroUsd / 1e6 < 0.05, 'about four cents for the page, not 150 deep reads');

  /* repair posts were never downloaded, let alone read */
  assert.ok(!gemini.calls.some(x => /^x\d+$/.test(x.id)));
  const rejected = fake.read(C.INSTAGRAM_CONTENT + '/igm_x7');
  assert.equal(rejected.relevance, 'IRRELEVANT_REPAIR');
  assert.equal(rejected.pipelineState, 'IGNORED');
  assert.equal(rejected.candidateScore.tier, 'REJECT');
  assert.equal(rejected.mediaItems[0].ocrStatus, 'skipped');

  /* one claim, seventeen posts: one open proposal, the rest corroborate it */
  const props = proposalsOf(fake);
  assert.equal(props.length, 17);
  assert.equal(props.filter(p => p.status === 'pending').length, 1);
  assert.equal(props.find(p => p.status === 'pending').corroborations, 16);
  assert.equal(props.find(p => p.status === 'pending').proposedAction, 'UPDATE_EXISTING_GROUP');

  /* the page's running total */
  const source = fake.read(C.INSTAGRAM_SOURCES + '/ig_sk_mobile_doctar');
  assert.equal(source.usage.geminiCalls, 59);
  assert.equal(source.usage.costMicroUsd, u.costMicroUsd);
  assert.deepEqual(source.stats, { content: 150, ignored: 133, relevant: 17 });

  /* scan it again: nothing new, nothing spent */
  const again = await runJob('https://www.instagram.com/sk_mobile_doctar/', deps);
  assert.equal(again.counts.unchanged, 150);
  assert.equal(again.usage.geminiCalls, 0);
  assert.equal(again.usage.costMicroUsd, 0);
  assert.equal(gemini.calls.length, 59);

  /* one post changes its caption: that post alone is processed, and its
     picture — the same bytes — is answered from the cache */
  const edited = posts.map(p => (p.id === 'g30' ? Object.assign({}, p, { caption: 'New stock, restocked' }) : p));
  const third = await runJob('https://www.instagram.com/sk_mobile_doctar/', Object.assign({}, deps, { graph: fakeGraph({ sk_mobile_doctar: pages(edited, 50) }) }));
  assert.equal(third.counts.unchanged, 149);
  assert.equal(third.usage.geminiCalls, 0);
  assert.ok(third.usage.cacheHits >= 1);
  assert.equal(gemini.calls.length, 59, 'still 59 calls after three scans of 150 posts');
});

test('a sync has an AI budget: when it is spent the rest is queued, and a person decides to spend more', async () => {
  const fake = world();
  const posts = [];
  const script = {};
  for (let i = 1; i <= 12; i++) { posts.push(image('c' + i, 'Universal combo offer ' + 'x'.repeat(i))); script['c' + i] = { vision: LIST }; }
  posts.push(image('x1', 'Samsung A21S Temperature Charging Error'));
  const gemini = fakeGemini(script);
  const deps = { cfg: cfg({ maxGeminiCallsPerSync: 5 }), graph: fakeGraph({ combo_shop: [posts] }), ai: noAi, fetchImpl: cdn(), providers: { gemini, claude: fakeClaude(() => ({})) } };
  let job = await runJob('https://www.instagram.com/combo_shop/', deps);

  assert.equal(job.status, 'budget_reached');
  assert.match(job.statusReason, /AI processing budget reached — 7 remaining item\(s\) queued/);
  assert.equal(gemini.calls.length, 5, 'not one call past the budget');
  assert.equal(job.counts.aiDeferred, 7);
  assert.equal(job.counts.processed, 6, 'the repair post behind them was still classified — that costs nothing');
  assert.equal(job.budget.geminiCalls, 5);
  assert.equal(job.finishedAt, null, 'a paused job is not a finished one');
  const waiting = fake.paths(C.INSTAGRAM_IMPORT_JOBS + '/' + job.jobId + '/items/').map(p => fake.read(p)).filter(i => i.status === 'deferred_ai');
  assert.equal(waiting.length, 7);
  assert.ok(waiting.every(i => i.pipelineState === 'QUEUED_FOR_AI'));

  /* nothing resumes on its own */
  assert.equal((await jobs.tick({ jobId: job.jobId, workerId: 'test', deps: Object.assign({ clock }, deps) })).ok, false);

  assert.equal((await jobs.resume({ jobId: job.jobId, admin: ADMIN, now: clock() })).requeued, 7);
  job = await drive(fake.read(C.INSTAGRAM_IMPORT_JOBS + '/' + job.jobId), deps);
  assert.equal(job.status, 'budget_reached');
  assert.equal(gemini.calls.length, 10);
  assert.equal(job.counts.aiDeferred, 2, '"queued for AI" is what waits now, not what ever waited');
  await jobs.resume({ jobId: job.jobId, admin: ADMIN, now: clock() });
  job = await drive(fake.read(C.INSTAGRAM_IMPORT_JOBS + '/' + job.jobId), deps);
  assert.equal(job.status, 'completed');
  assert.equal(job.counts.aiDeferred, 0);
  assert.equal(gemini.calls.length, 12);
  assert.equal(job.usage.geminiCalls, 12, 'the totals keep counting across budgets');
  assert.equal(job.budgetResets, 2);

  /* the same guard, counted in items */
  world();
  const g2 = fakeGemini(script);
  const perItem = await runJob('https://www.instagram.com/combo_shop/', Object.assign({}, deps, { cfg: cfg({ maxAiItemsPerSync: 3 }), providers: { gemini: g2, claude: fakeClaude(() => ({})) } }));
  assert.equal(perItem.status, 'budget_reached');
  assert.equal(g2.calls.length, 3);
});

test('the daily cap and a provider rate limit pause the job; they are never retried in a loop', async () => {
  world();
  const posts = [image('c1', 'Universal combo offer'), image('c2', 'Universal combo offer two')];
  const limited = fakeGemini({}, { fail: () => ({ ok: false, kind: 'rate_limited', reason: 'Gemini rate limit or quota reached.' }) });
  const job = await runJob('https://www.instagram.com/combo_shop/', { cfg: cfg(), graph: fakeGraph({ combo_shop: [posts] }), ai: noAi, fetchImpl: cdn(),
    providers: { gemini: limited, claude: fakeClaude(() => ({})) } });
  assert.equal(job.status, 'quota_exhausted');
  assert.match(job.statusReason, /rate limit/i);
  assert.equal(limited.calls.length, 1, 'one refused call, then it stops');
  assert.equal(job.counts.processed, 0);
});

/* ======================================================= the second opinion */

async function importOne(fake, vision, claude, over) {
  const gemini = fakeGemini({ p1: { vision } });
  const job = await runJob('https://www.instagram.com/combo_shop/', {
    cfg: cfg(over), graph: fakeGraph({ combo_shop: [[image('p1', 'Universal combo offer')]] }), ai: noAi, fetchImpl: cdn(), providers: { gemini, claude }
  });
  return { job, gemini, proposal: proposalsOf(fake)[0] };
}
const withModels = (models, confidence = 0.95) => Object.assign({}, LIST, { confidence, lists: [{ headline: 'Vivo Y20 Combo', models, atSecond: 0 }] });

test('Claude is asked only where matching left doubt — and may suggest, never decide', async () => {
  /* a clean, confident list: no call */
  let fake = world();
  let claude = fakeClaude(() => { throw new Error('not needed'); });
  let r = await importOne(fake, LIST, claude);
  assert.equal(claude.calls.length, 0);
  assert.equal(r.proposal.validation, undefined);
  assert.equal(r.job.usage.claudeCalls, 0);

  /* "Vivo Y21" fits two catalogue records: one call, about that entry alone */
  fake = world();
  claude = fakeClaude(request => ({
    list_is_compatibility: true, product_category_id: '', summary: 'the list is a compatibility list',
    entries: request.entries.map(e => ({ key: e.key, decision: 'candidate', model_id: e.candidates[0].id, printed_text: '', note: 'printed as Y21' }))
  }));
  r = await importOne(fake, withModels(['Vivo Y20', 'Vivo Y20a', 'Vivo Y21']), claude);
  assert.equal(claude.calls.length, 1);
  const call = claude.calls[0];
  assert.equal(call.model, 'claude-opus-5-5');
  assert.equal(call.hasImage, true, 'it sees the image the list was read from');
  assert.deepEqual(call.request.entries.map(e => e.text_as_read), ['Vivo Y21'], 'only the doubtful entry is sent, with the records it might be');
  assert.ok(call.request.entries[0].candidates.length >= 2 && call.request.entries[0].candidates.length <= 6, 'a handful of candidates, never the catalogue');

  const y21 = r.proposal.members.find(m => m.text === 'Vivo Y21');
  assert.equal(y21.suggestion.modelId, call.request.entries[0].candidates[0].id);
  assert.equal(y21.suggestion.by, 'validator');
  assert.equal(y21.state, 'needs_review', 'a suggestion is not a match: a person confirms it');
  assert.equal(y21.match.status, 'ambiguous', 'the matcher\'s answer is untouched');
  assert.equal(r.proposal.validation.status, 'confirmed');
  assert.equal(r.proposal.validation.suggested, 1);
  assert.equal(r.job.counts.validated, 1);
  assert.equal(r.job.usage.claudeCalls, 1);
  assert.equal(r.job.usage.costMicroUsd, DEEP_COST + (2000 * 4 + 300 * 20), 'Gemini\'s call plus Claude\'s');
  assert.ok(r.proposal.history.some(h => h.action === 'validated'));

  /* an id it was not offered is thrown away */
  fake = world();
  claude = fakeClaude(request => ({ list_is_compatibility: true, product_category_id: 'invented-category', summary: '',
    entries: request.entries.map(e => ({ key: e.key, decision: 'candidate', model_id: 'vivo-y9999-invented', printed_text: '', note: '' }))
      .concat([{ key: 'm:vivo-y36', decision: 'candidate', model_id: 'vivo-y36', printed_text: '', note: 'an entry nobody asked about' }]) }));
  r = await importOne(fake, withModels(['Vivo Y20', 'Vivo Y20a', 'Vivo Y21']), claude);
  assert.equal(r.proposal.members.find(m => m.text === 'Vivo Y21').suggestion, null, 'an invented id is never used');
  assert.equal(r.proposal.members.length, 3, 'and it cannot add an entry');
  assert.equal(r.proposal.validation.discarded, 2);
  assert.equal(r.proposal.categoryId, 'combo-display', 'nor change the category');
});

test('a reading the reader itself doubted is checked against the image; what Claude disputes waits for a person', async () => {
  const fake = world();
  const claude = fakeClaude(request => ({ list_is_compatibility: true, product_category_id: '', summary: 'one entry is not in the image',
    entries: request.entries.map(e => (/^vivo y20i$/i.test(e.text_as_read)
      ? { key: e.key, decision: 'not_visible', model_id: '', printed_text: '', note: 'not printed' }
      : { key: e.key, decision: 'candidate', model_id: e.candidates[0].id, printed_text: '', note: '' })) }));
  const r = await importOne(fake, withModels(['Vivo Y20', 'Vivo Y20a', 'Vivo Y20i'], 0.5), claude);
  assert.equal(claude.calls.length, 1);
  assert.equal(claude.calls[0].request.entries.length, 3, 'at 50% confidence every entry it would act on is checked');
  const y20i = r.proposal.members.find(m => /^vivo y20i$/i.test(m.text));
  assert.equal(y20i.disputed, true);
  assert.equal(y20i.state, 'needs_review', 'it was about to be ADDED to a production group; now it is not');
  assert.equal(r.proposal.counts.add, 0);
  assert.equal(r.proposal.proposedAction, 'MODEL_REVIEW');
  assert.equal(r.proposal.validation.status, 'disputed');
  assert.equal(r.proposal.confidence.band, 'low');
  assert.ok(r.proposal.confidence.reasons.some(x => /second model disputed/.test(x)));
  await assert.rejects(() => review.approveProposal({ candidateId: r.proposal.candidateId, admin: ADMIN, acknowledgeLowConfidence: true, now: clock() }),
    e => e.code === 'not-approvable');
});

test('if the second opinion cannot be had, the extraction is kept as it was', async () => {
  /* the call fails */
  let fake = world();
  let claude = fakeClaude(() => ({}), { fail: () => ({ ok: false, kind: 'error', reason: 'Claude answered HTTP 500.' }) });
  let r = await importOne(fake, withModels(['Vivo Y20', 'Vivo Y20a', 'Vivo Y20i', 'Vivo Y21']), claude);
  assert.equal(r.proposal.validation.status, 'failed');
  assert.equal(r.job.counts.validationFailed, 1);
  assert.equal(r.proposal.status, 'pending');
  assert.equal(r.proposal.proposedAction, 'UPDATE_EXISTING_GROUP', 'the Y20i is still proposed');
  assert.equal(r.proposal.members.find(m => m.text === 'Vivo Y21').state, 'needs_review');
  assert.equal(fake.all(C.INSTAGRAM_EXTRACTIONS)[0].pipeline.trace.some(t => t.stage === 'VALIDATION_FAILED'), true);

  /* no validator at all */
  fake = world();
  claude = fakeClaude(() => { throw new Error('no key, no call'); });
  r = await importOne(fake, withModels(['Vivo Y20', 'Vivo Y20a', 'Vivo Y21']), claude, { validator: 'none', anthropicKey: '' });
  assert.equal(claude.calls.length, 0);
  assert.equal(r.proposal.validation.status, 'not_configured');
  assert.match(r.proposal.validation.note, /manual review/);

  /* its budget for this sync is spent */
  fake = world();
  claude = fakeClaude(() => { throw new Error('over budget'); });
  r = await importOne(fake, withModels(['Vivo Y20', 'Vivo Y20a', 'Vivo Y21']), claude, { maxClaudeCallsPerSync: 0 });
  assert.equal(claude.calls.length, 0);
  assert.equal(r.proposal.validation.status, 'queued');
  assert.equal(r.job.status, 'completed', 'a missing second opinion does not hold the import up');
});

/* ========================================================= safety nets */

test('"Analyse anyway": a person can overrule the cheap filter for one post — never for a page', async () => {
  const fake = world();
  const post = image('x1', 'Vivo Y20 display light jumper solution');
  const gemini = fakeGemini({ x1: { vision: LIST } });
  const deps = { cfg: cfg(), graph: fakeGraph({ sk_mobile_doctar: [[post]] }), ai: noAi, fetchImpl: cdn(), providers: { gemini, claude: fakeClaude(() => ({})) } };
  const first = await runJob('https://www.instagram.com/sk_mobile_doctar/', deps);
  assert.equal(first.counts.cheapRejected, 1);
  assert.equal(gemini.calls.length, 0);
  assert.equal(proposalsOf(fake).length, 0);

  const page = await jobs.createJob({ admin: ADMIN, profileUrl: 'https://www.instagram.com/sk_mobile_doctar/', force: true, now: clock(), deps });
  assert.equal(page.job.forceDeep, false, 'forcing a whole page would be the unlimited spend the filter prevents');

  const forced = await runJob('https://www.instagram.com/sk_mobile_doctar/', deps, { postUrl: post.permalink, force: true });
  assert.equal(forced.forceDeep, true);
  assert.equal(gemini.calls.length, 1);
  assert.equal(gemini.calls[0].stage, 'read');
  assert.equal(proposalsOf(fake).length, 1, 'the list under the repair caption is found');
  const content = fake.read(C.INSTAGRAM_CONTENT + '/igm_x1');
  assert.equal(content.latestVersion, 2);
  assert.equal(content.relevance, 'RELEVANT_COMPATIBILITY');
  assert.equal(content.candidateScore.tier, 'HIGH');
});

test('a reel with no video is VIDEO_UNAVAILABLE — its cover is screened, and it is never reported as analysed', async () => {
  const fake = world();
  const noVideo = Object.assign(reel('v9', 'Watch till the end', false), { thumbnail_url: 'https://cdn/cover9.jpg' });
  const gemini = fakeGemini({ cover9: { screen: { verdict: 'UNCERTAIN', kind: 'product', hasModelList: false, reason: 'a display' }, vision: PRODUCT_ONLY } });
  const job = await runJob('https://www.instagram.com/sk_mobile_doctar/', { cfg: cfg(), graph: fakeGraph({ sk_mobile_doctar: [[noVideo]] }), ai: noAi, fetchImpl: cdn(),
    providers: { gemini, claude: fakeClaude(() => ({})) } });
  assert.equal(job.counts.videoUnavailable, 1);
  assert.equal(job.counts.videosUnderstood, 0);
  assert.equal(job.usage.videoSeconds, 0);
  const x = fake.all(C.INSTAGRAM_EXTRACTIONS)[0];
  assert.equal(x.mediaItems[0].code, 'VIDEO_MEDIA_UNAVAILABLE');
  assert.equal(x.mediaItems[0].ocrStatus, 'partial', 'the cover was read; the video was not');
  assert.equal(x.relevance, 'INSUFFICIENT_EVIDENCE');
  assert.equal(x.pipeline.state, 'VIDEO_UNAVAILABLE');
  assert.ok(x.pipeline.trace.some(t => t.stage === 'VIDEO_UNAVAILABLE'));
  assert.deepEqual(gemini.calls.map(c => c.kind), ['image', 'image'], 'only the cover image was sent, as an image');
  assert.equal(fake.read(C.INSTAGRAM_CONTENT + '/igm_v9').mediaComplete, false, 'so it is read again if the video ever becomes available');
});

/* ======================================================= verification */

test('"verified" means the provider answered a real call; a key that is merely set is not verified', async () => {
  const ok = await verifyProviders({ cfg: cfg(), gemini: fakeGeminiForCheck(), claude: fakeClaudeForCheck(), graph: { ownProfile: async () => ({ username: 'proglide_9h_screenguard' }) } });
  assert.equal(ok.providers.gemini.status, 'VERIFIED');
  assert.equal(ok.providers.gemini.calls.length, 2, 'both the main and the screening model answered');
  assert.equal(ok.providers.claude.status, 'VERIFIED');
  assert.equal(ok.providers.instagram.status, 'VERIFIED');
  assert.equal(ok.ready, true);
  assert.match(ok.providers.gemini.notProven, /Video understanding is not proven/);

  const none = await verifyProviders({ cfg: cfg({ geminiKey: '', anthropicKey: '', graph: { token: '', igUserId: '' } }),
    gemini: aiProviders.createGemini({ key: '' }), claude: aiProviders.createClaude({ key: '' }) });
  assert.equal(none.providers.gemini.status, 'NOT_VERIFIED');
  assert.equal(none.providers.gemini.code, 'API_KEY_MISSING');
  assert.equal(none.providers.claude.code, 'API_KEY_MISSING');
  assert.equal(none.providers.instagram.code, 'API_KEY_MISSING');
  assert.equal(none.ready, false);

  const rejected = await verifyProviders({ cfg: cfg(), claude: fakeClaudeForCheck(), graph: { ownProfile: async () => ({ username: 'x' }) },
    gemini: Object.assign(fakeGeminiForCheck(), { listModels: async () => ({ ok: false, kind: 'auth', code: 'API_KEY_INVALID', reason: 'Gemini rejected the API key (it is not a valid key).' }) }) });
  assert.equal(rejected.providers.gemini.status, 'NOT_VERIFIED');
  assert.equal(rejected.providers.gemini.code, 'API_KEY_INVALID');
  assert.equal(rejected.ready, false);

  const wrongModel = await verifyProviders({ cfg: cfg({ geminiModel: 'gemini-0-retired' }), gemini: fakeGeminiForCheck(), claude: fakeClaudeForCheck(), graph: { ownProfile: async () => ({ username: 'x' }) } });
  assert.equal(wrongModel.providers.gemini.code, 'MODEL_NOT_FOUND');
  assert.deepEqual(wrongModel.providers.gemini.available, ['gemini-3.8-flash', 'gemini-3.1-flash-lite']);
});

function fakeGeminiForCheck() {
  return {
    configured: () => true,
    listModels: async () => ({ ok: true, models: ['gemini-3.8-flash', 'gemini-3.1-flash-lite'] }),
    interact: async ({ model }) => ({ ok: true, output: { saw_image: true }, model, usage: { inputTokens: 80, outputTokens: 6 } })
  };
}
function fakeClaudeForCheck() {
  return {
    configured: () => true,
    retrieveModel: async model => ({ ok: true, model }),
    structured: async ({ model }) => ({ ok: true, output: { saw_image: true }, model, usage: { inputTokens: 120, outputTokens: 12 } })
  };
}

test('no stand-in provider ships: nothing under api/ answers for a model that was not called', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '_services', 'instagram');
  fs.readdirSync(dir).filter(f => /\.js$/.test(f)).forEach(f => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.equal(/require\(['"][^'"]*testing\/fake/.test(src), false, f + ' must not load a test stand-in');
    assert.equal(/\b(mockResponse|fakeResponse|DEMO_MODE|cannedAnswer)\b/.test(src), false, f);
  });
  /* the keys reach a provider in a header, and nothing in the admin UI holds one */
  const ui = path.join(__dirname, '..', '..', 'src', 'admin', 'pages');
  fs.readdirSync(ui).forEach(f => {
    assert.equal(/generativelanguage\.googleapis\.com|api\.anthropic\.com|GEMINI_API_KEY\s*=|ANTHROPIC_API_KEY\s*=|x-goog-api-key/.test(fs.readFileSync(path.join(ui, f), 'utf8')), false, f);
  });
});
