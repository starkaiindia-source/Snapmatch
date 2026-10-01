/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/provider-check.js
   ----------------------------------------------------------------------------
   "Is it actually working?" — answered by calling the real provider with the
   configured key, never by looking at whether a variable is set.

   Each provider comes back VERIFIED or NOT_VERIFIED, with the reason:

     API_KEY_MISSING    no key in the environment
     API_KEY_INVALID    the provider rejected the key
     MODEL_NOT_FOUND    the key works, the configured model is not one it may use
     RATE_LIMITED       the provider is refusing calls for now
     ERROR              anything else, with the provider's own status

   There is no path here that reports success without a successful call, and a
   provider that was not called is reported as not called.

   The calls are deliberately tiny: a model listing, and one answer of a few
   tokens about a 1×1 image — enough to prove the key, the model and image
   input, and nothing more. What it cannot prove is said too: video analysis
   needs a real reel whose video Instagram hands over.
   ========================================================================== */
'use strict';

const configMod = require('./config');
const aiProviders = require('./ai-providers');
const { createGraphClient } = require('./graph-client');

/* a 1×1 PNG: the smallest thing that proves image input reaches the model */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const notVerified = (code, detail, extra) => Object.assign({ status: 'NOT_VERIFIED', code, detail }, extra || {});
const codeFor = res => res.code || (res.kind === 'rate_limited' ? 'RATE_LIMITED' : res.kind === 'auth' ? 'API_KEY_INVALID' : 'ERROR');

async function checkGemini(cfg, gemini) {
  if (!cfg.geminiKey && !gemini.configured()) return notVerified('API_KEY_MISSING', 'GEMINI_API_KEY is not set.');
  const listed = await gemini.listModels();
  if (!listed.ok) return notVerified(codeFor(listed), listed.reason);
  const wanted = [cfg.geminiModel, cfg.geminiScreenModel];
  const missing = wanted.filter(m => listed.models.indexOf(m) < 0);
  if (missing.length) {
    return notVerified('MODEL_NOT_FOUND', 'This key cannot use: ' + missing.join(', ') + '.', {
      available: listed.models.filter(m => /flash|pro/.test(m) && !/image|tts|live|embedding/.test(m)).slice(0, 12)
    });
  }
  const calls = [];
  for (const model of Array.from(new Set(wanted))) {
    const r = await gemini.interact({
      /* each model at the thinking level the pipeline asks of it; a level the
         model lacks is stepped up by the client, and the one used is reported */
      model, thinkingLevel: model === cfg.geminiModel ? 'low' : 'minimal', maxOutputTokens: 1024,
      schema: { type: 'object', additionalProperties: false, properties: { saw_image: { type: 'boolean' } }, required: ['saw_image'] },
      input: [{ type: 'image', data: PIXEL, mime_type: 'image/png', resolution: 'low' },
              { type: 'text', text: 'Is an image attached to this message? Answer in the JSON asked for.' }]
    });
    if (!r.ok) return notVerified(codeFor(r), model + ': ' + r.reason, { calls });
    calls.push({ model: r.model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens,
                 costMicroUsd: aiProviders.estimateCost(r.model, r.usage, cfg.prices), imageInput: r.output && r.output.saw_image === true,
                 thinkingLevel: r.thinkingLevel || null });
  }
  return {
    status: 'VERIFIED', model: cfg.geminiModel, screenModel: cfg.geminiScreenModel, calls,
    detail: 'The key works, both models answered, and image input was accepted.',
    notProven: 'Video understanding is not proven by this check: it needs a reel whose video Instagram returns.'
  };
}

async function checkClaude(cfg, claude) {
  if (cfg.validator !== 'anthropic' && cfg.visionProvider !== 'anthropic') {
    return { status: 'NOT_CONFIGURED', detail: 'No Claude validator is configured. Lists that need a second opinion go to manual review.' };
  }
  if (!claude.configured()) return notVerified('API_KEY_MISSING', 'ANTHROPIC_API_KEY is not set.');
  const model = await claude.retrieveModel(cfg.claudeModel);
  if (!model.ok) return notVerified(model.kind === 'error' && /know that model/.test(model.reason) ? 'MODEL_NOT_FOUND' : codeFor(model), model.reason);
  const r = await claude.structured({
    model: cfg.claudeModel, effort: 'low', system: 'Answer in the JSON asked for.',
    schema: { type: 'object', additionalProperties: false, properties: { saw_image: { type: 'boolean' } }, required: ['saw_image'] },
    content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXEL } },
              { type: 'text', text: 'Is an image attached to this message?' }]
  });
  if (!r.ok) return notVerified(codeFor(r), r.reason);
  return {
    status: 'VERIFIED', model: r.model,
    calls: [{ model: r.model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens,
              costMicroUsd: aiProviders.estimateCost(r.model, r.usage, cfg.prices), imageInput: r.output && r.output.saw_image === true }],
    detail: 'The key works and the model answered in the required structure.'
  };
}

async function checkInstagram(cfg, graph) {
  if (!configMod.graphConfigured(cfg)) return notVerified('API_KEY_MISSING', 'INSTAGRAM_GRAPH_ACCESS_TOKEN / INSTAGRAM_BUSINESS_ACCOUNT_ID are not set.');
  try {
    const me = await graph.ownProfile();
    return { status: 'VERIFIED', detail: 'The Graph API answered for @' + (me.username || '?') + '.',
             notProven: 'Whether a given reel\'s VIDEO is returned is decided per reel by Meta (it withholds video with licensed audio).' };
  } catch (err) {
    const kind = err && err.kind;
    return notVerified(kind === 'token_invalid' ? 'API_KEY_INVALID' : kind === 'rate_limited' ? 'RATE_LIMITED' : 'ERROR',
      String(err && err.message || 'the Graph API could not be reached').slice(0, 200));
  }
}

/**
 * @param {object} [deps]   { cfg, gemini, claude, graph, fetchImpl } — tests inject
 * @returns {Promise<{checkedAt:number, ready:boolean, providers:object}>}
 */
async function verifyProviders(deps = {}) {
  const cfg = deps.cfg || configMod.load();
  const gemini = deps.gemini || aiProviders.createGemini({ key: cfg.geminiKey, fetchImpl: deps.fetchImpl });
  const claude = deps.claude || aiProviders.createClaude({ key: cfg.anthropicKey });
  const graph = deps.graph || createGraphClient(Object.assign({}, cfg.graph, { fetchImpl: deps.fetchImpl }));

  const [g, c, i] = await Promise.all([checkGemini(cfg, gemini), checkClaude(cfg, claude), checkInstagram(cfg, graph)]);
  const providers = {
    gemini: Object.assign({ role: 'primary media reader — images, carousels, video' }, g),
    claude: Object.assign({ role: 'second opinion on ambiguous lists' }, c),
    instagram: Object.assign({ role: 'the only source of Instagram content' }, i),
    ocr: {
      role: 'plain OCR — optional',
      status: cfg.ocrProvider === 'none' ? 'NOT_CONFIGURED' : 'NOT_CALLED',
      detail: cfg.ocrProvider === 'none' ? 'No OCR provider. Gemini reads images directly.'
        : cfg.ocrProvider + ' is configured; this check does not call it.'
    }
  };
  return {
    checkedAt: Date.now(),
    /* the pipeline can read media and reach Instagram */
    ready: providers.gemini.status === 'VERIFIED' && providers.instagram.status === 'VERIFIED',
    pricesAsOf: aiProviders.PRICES_AS_OF,
    providers
  };
}

module.exports = { verifyProviders };
