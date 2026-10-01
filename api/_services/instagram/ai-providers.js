/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/ai-providers.js
   ----------------------------------------------------------------------------
   The two hosted models the Instagram pipeline may call, and what each call
   cost.

     Gemini   the PRIMARY media reader: image screening, image extraction and
              native video understanding. Google's Interactions API
              (POST /v1beta/interactions), with a JSON schema and store:false.
     Claude   a SECONDARY validator for the few extractions that are
              ambiguous. The official Anthropic SDK, structured output, the
              server-side refusal fallback.

   ----------------------------------------------------------------------------
   NOTHING HERE PRETENDS

   There is no mock, no canned answer and no "demo mode". A call either
   reaches the provider with a real key or returns { ok:false, kind } saying
   why not — `auth` (no key, or the provider rejected it), `rate_limited`,
   `timeout`, `refused`, `bad_output`, `error`. Tests inject their own fetch /
   client; nothing in this file knows it is under test.

   A key is read from the environment by config.js and passed in. It travels
   only in a request header to its own provider, is never logged, and never
   appears in a returned reason.

   ----------------------------------------------------------------------------
   COST IS MEASURED, NOT ASSUMED

   Every successful call returns the token usage the PROVIDER reported and the
   model that actually served it. estimateCost() turns that into micro-dollars
   from a price table — list prices with the date they were read, overridable
   per model by INSTAGRAM_AI_PRICES. A model with no price returns null: an
   unknown cost is shown as unknown, never as zero.
   ========================================================================== */
'use strict';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

/* USD per million tokens: [input, output]. Read from the providers' pricing
   pages on 2026-10-01 (Gemini's are the "through 2026-12-31" rates; output
   includes thinking tokens). Override or extend with INSTAGRAM_AI_PRICES, e.g.
   {"gemini-3.8-flash":[0.75,3.75]}. Matched by the longest prefix. */
const PRICES_AS_OF = '2026-10-01';
const DEFAULT_PRICES = {
  'gemini-3.8-flash': [0.75, 3.75],
  'gemini-3.7-flash': [0.75, 3.75],
  'gemini-3.6-flash': [0.75, 3.75],
  'gemini-3.5-flash-lite': [0.30, 2.50],
  'gemini-3.5-flash': [1.50, 9.00],
  'gemini-3.1-flash-lite': [0.25, 1.50],
  'gemini-3.1-pro': [2.00, 12.00],
  'gemini-2.5-flash-lite': [0.10, 0.40],
  'gemini-2.5-flash': [0.30, 2.50],
  'gemini-2.5-pro': [1.25, 10.00],
  'claude-opus-5-5': [4.00, 20.00],
  'claude-sonnet-5-5': [2.00, 10.00],
  'claude-haiku-4-5': [1.00, 5.00]
};

function priceFor(model, overrides) {
  const table = Object.assign({}, DEFAULT_PRICES, overrides || {});
  const id = String(model || '').toLowerCase().replace(/^models\//, '');
  const key = Object.keys(table).filter(k => id.indexOf(k) === 0).sort((a, b) => b.length - a.length)[0];
  const p = key ? table[key] : null;
  return Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(Number(n)) && Number(n) >= 0)
    ? { input: Number(p[0]), output: Number(p[1]) } : null;
}

/**
 * @returns {number|null} micro-dollars (1e-6 USD), or null when the model has
 *          no price — the caller counts that call as "cost unknown".
 */
function estimateCost(model, usage, overrides) {
  const p = priceFor(model, overrides);
  if (!p || !usage) return null;
  return Math.round((Number(usage.inputTokens) || 0) * p.input + (Number(usage.outputTokens) || 0) * p.output);
}

function fail(kind, reason, extra) {
  return Object.assign({ ok: false, kind, reason }, extra || {});
}

/* ================================================================= Gemini */

/* Not every Gemini model accepts every thinking level — gemini-3.8-flash has
   no "minimal", and says so with HTTP 400 (seen on the first live provider
   check, 2026-10-01). The caller asks for the cheapest level that suits the
   job; a level a model refuses is remembered for as long as this instance
   lives and the next one up is used instead. A refusal costs no tokens. */
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'];
const refusedLevels = new Map();          /* model -> Set of levels it refused */

/** The cheapest level at or above `wanted` the model has not refused; null
    when it refused them all (the field is then left out: the model's default). */
function thinkingLevelFor(model, wanted) {
  const from = THINKING_LEVELS.indexOf(wanted);
  if (from < 0) return null;
  const refused = refusedLevels.get(model);
  for (let i = from; i < THINKING_LEVELS.length; i++) {
    if (!refused || !refused.has(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.key
 * @param {Function} [opts.fetchImpl]
 */
function createGemini({ key, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const configured = () => !!key;

  async function request(path, { method = 'GET', body, headers, timeoutMs = 30000, raw = false } = {}) {
    if (!key) return fail('auth', 'GEMINI_API_KEY is not set.', { code: 'API_KEY_MISSING' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(/^https:/.test(path) ? path : GEMINI_BASE + path, {
        method, signal: controller.signal,
        headers: Object.assign({ 'x-goog-api-key': key }, raw ? {} : { 'Content-Type': 'application/json' }, headers || {}),
        body: body == null ? undefined : (raw ? body : JSON.stringify(body))
      });
      let json = null;
      try { json = await res.json(); } catch { json = null; }
      if (res.ok) return { ok: true, status: res.status, json, headers: res.headers };
      return mapGeminiError(res.status, json);
    } catch (err) {
      return err && err.name === 'AbortError'
        ? fail('timeout', 'Gemini did not answer in time.')
        : fail('error', 'Gemini could not be reached.');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One model call.
   * @param {object} args
   * @param {string} args.model
   * @param {Array<object>} args.input        Interactions API content parts
   * @param {string} [args.system]
   * @param {object} [args.schema]            JSON schema the answer must follow
   * @param {number} [args.maxOutputTokens]
   * @param {'minimal'|'low'|'medium'|'high'} [args.thinkingLevel]
   * @returns {Promise<{ok:true, output:any, text:string, model:string, usage:object}|{ok:false, kind:string, reason:string}>}
   */
  async function interact({ model, input, system, schema, maxOutputTokens, thinkingLevel, timeoutMs }) {
    const body = { model, input, store: false };
    if (system) body.system_instruction = system;
    if (schema) body.response_format = { type: 'text', mime_type: 'application/json', schema };

    let res;
    let level;
    /* at most one attempt per level, then one with the model's own default */
    for (let attempt = 0; attempt <= THINKING_LEVELS.length; attempt++) {
      level = thinkingLevel ? thinkingLevelFor(model, thinkingLevel) : null;
      const gen = {};
      if (maxOutputTokens) gen.max_output_tokens = maxOutputTokens;
      if (level) gen.thinking_level = level;
      if (Object.keys(gen).length) body.generation_config = gen; else delete body.generation_config;
      res = await request('/v1beta/interactions', { method: 'POST', body, timeoutMs: timeoutMs || 45000 });
      if (res.ok || res.code !== 'THINKING_LEVEL_UNSUPPORTED' || !level) break;
      if (!refusedLevels.has(model)) refusedLevels.set(model, new Set());
      refusedLevels.get(model).add(level);
    }
    if (!res.ok) return res;
    const j = res.json || {};
    if (j.status && j.status !== 'completed') {
      return fail(j.status === 'failed' ? 'error' : 'bad_output', 'Gemini ended the call as "' + String(j.status).slice(0, 40) + '".');
    }
    const text = (j.steps || []).filter(s => s && s.type === 'model_output')
      .map(s => (s.content || []).filter(c => c && c.type === 'text').map(c => c.text).join('')).join('') ||
      (typeof j.output_text === 'string' ? j.output_text : '');
    const u = j.usage || {};
    const usage = {
      inputTokens: Number(u.total_input_tokens) || 0,
      /* thinking is billed as output */
      outputTokens: (Number(u.total_output_tokens) || 0) + (Number(u.total_thought_tokens) || 0),
      cachedTokens: Number(u.total_cached_tokens) || 0
    };
    let output = text;
    if (schema) {
      try { output = JSON.parse(text); }
      catch { return fail('bad_output', 'Gemini did not return the JSON it was asked for.', { usage, model: j.model || model }); }
    }
    return { ok: true, output, text, model: String(j.model || model).replace(/^models\//, ''), usage, thinkingLevel: level || null };
  }

  /**
   * A video too large to send inline: the Files API, resumable protocol, then
   * wait until Google has processed it.
   * @returns {Promise<{ok:true, uri:string, name:string}|{ok:false,...}>}
   */
  async function uploadFile(bytes, mimeType, { waitMs = 60000 } = {}) {
    const start = await request('/upload/v1beta/files', {
      method: 'POST', body: { file: { display_name: 'mpf-instagram-media' } },
      headers: {
        'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(bytes.length), 'X-Goog-Upload-Header-Content-Type': mimeType
      }
    });
    if (!start.ok) return start;
    const uploadUrl = start.headers && start.headers.get && start.headers.get('x-goog-upload-url');
    if (!uploadUrl) return fail('error', 'Gemini returned no upload URL for the file.');
    const up = await request(uploadUrl, {
      method: 'POST', raw: true, body: bytes, timeoutMs: 120000,
      headers: { 'Content-Length': String(bytes.length), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }
    });
    if (!up.ok) return up;
    let file = (up.json && up.json.file) || {};
    const deadline = Date.now() + waitMs;
    while (file.state === 'PROCESSING' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const st = await request('/v1beta/' + file.name);
      if (!st.ok) return st;
      file = st.json || file;
    }
    if (file.state === 'FAILED') return fail('error', 'Gemini could not process the uploaded file.');
    if (file.state === 'PROCESSING') return fail('timeout', 'Gemini was still processing the uploaded file.', { name: file.name });
    if (!file.uri) return fail('error', 'Gemini returned no URI for the uploaded file.');
    return { ok: true, uri: file.uri, name: file.name };
  }

  /** Best effort: an uploaded video is not left behind once it has been read. */
  async function deleteFile(name) {
    if (!name || !/^files\/[A-Za-z0-9_-]+$/.test(name)) return;
    await request('/v1beta/' + name, { method: 'DELETE', timeoutMs: 10000 }).catch(() => null);
  }

  /** The models this key may use — a real call, for verification. */
  async function listModels() {
    const res = await request('/v1beta/models?pageSize=200', { timeoutMs: 15000 });
    if (!res.ok) return res;
    return { ok: true, models: ((res.json && res.json.models) || []).map(m => String(m.name || '').replace(/^models\//, '')) };
  }

  return { configured, interact, uploadFile, deleteFile, listModels };
}

function mapGeminiError(status, json) {
  const e = (json && json.error) || {};
  const message = String(e.message || '').slice(0, 200);
  const extra = { httpStatus: status };
  if (status === 429 || e.status === 'RESOURCE_EXHAUSTED') return fail('rate_limited', 'Gemini rate limit or quota reached.', extra);
  if (status === 401 || status === 403 || /api key not valid|api_key_invalid|permission/i.test(message)) {
    return fail('auth', 'Gemini rejected the API key' + (/not valid/i.test(message) ? ' (it is not a valid key).' : '.'),
      Object.assign(extra, { code: 'API_KEY_INVALID' }));
  }
  if (status === 400 && /thinking.?level/i.test(message) && /not supported/i.test(message)) {
    return fail('error', 'Gemini refused the request (HTTP 400): ' + message, Object.assign(extra, { code: 'THINKING_LEVEL_UNSUPPORTED' }));
  }
  if (status === 404) return fail('error', 'Gemini does not know that model or endpoint: ' + message, extra);
  if (status >= 500) return fail('error', 'Gemini is unavailable (HTTP ' + status + ').', Object.assign(extra, { retryable: true }));
  return fail('error', 'Gemini refused the request (HTTP ' + status + '): ' + message, extra);
}

/* ================================================================= Claude */

/**
 * @param {object} opts
 * @param {string} opts.key
 * @param {object} [opts.client]   an Anthropic client (tests); otherwise one is
 *                                 built from the SDK the first time it is needed
 */
function createClaude({ key, client } = {}) {
  let sdk = null;
  let instance = client || null;
  const configured = () => !!(key || client);

  function get() {
    if (instance) return instance;
    const mod = require('@anthropic-ai/sdk');
    sdk = mod.default || mod;
    /* one retry: the caller has its own retry policy, and a validation that
       fails keeps the extraction it was validating */
    instance = new sdk({ apiKey: key, maxRetries: 1, timeout: 60000 });
    return instance;
  }

  function mapError(err) {
    const A = sdk || (() => { try { const m = require('@anthropic-ai/sdk'); return m.default || m; } catch { return null; } })();
    if (A && err instanceof A.AuthenticationError) return fail('auth', 'Claude rejected the API key.', { code: 'API_KEY_INVALID' });
    if (A && err instanceof A.PermissionDeniedError) return fail('auth', 'This Claude key may not use that model.', { code: 'API_KEY_INVALID' });
    if (A && err instanceof A.RateLimitError) return fail('rate_limited', 'Claude rate limit reached.');
    if (A && err instanceof A.NotFoundError) return fail('error', 'Claude does not know that model.');
    if (A && err instanceof A.BadRequestError) return fail('error', 'Claude refused the request as malformed.');
    if (A && err instanceof A.APIConnectionError) return fail('timeout', 'Claude could not be reached in time.');
    if (A && err instanceof A.APIError) return fail('error', 'Claude answered HTTP ' + err.status + '.', { retryable: Number(err.status) >= 500 });
    return fail('error', 'The Claude call failed.');
  }

  /**
   * One structured answer.
   * @param {object} args
   * @param {string} args.model
   * @param {string} args.system
   * @param {Array<object>} args.content    user content blocks (image and text)
   * @param {object} args.schema            JSON schema; every object needs additionalProperties:false
   * @param {'low'|'medium'|'high'|'xhigh'|'max'} [args.effort]
   */
  async function structured({ model, system, content, schema, effort }) {
    if (!configured()) return fail('auth', 'ANTHROPIC_API_KEY is not set.', { code: 'API_KEY_MISSING' });
    let response;
    try {
      response = await get().beta.messages.create({
        model,
        max_tokens: 16000,
        /* a classifier decline is re-run server-side on the model Anthropic
           recommends for that category, instead of coming back as a refusal */
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: effort || 'medium', format: { type: 'json_schema', schema } },
        system,
        messages: [{ role: 'user', content }]
      });
    } catch (err) {
      return mapError(err);
    }
    const u = response.usage || {};
    const usage = {
      inputTokens: (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0),
      outputTokens: Number(u.output_tokens) || 0
    };
    const served = String(response.model || model);
    if (response.stop_reason === 'refusal') return fail('refused', 'Claude declined this request.', { usage, model: served });
    if (response.stop_reason === 'max_tokens') return fail('bad_output', 'Claude ran out of output tokens before finishing.', { usage, model: served });
    const text = (response.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('');
    let output;
    try { output = JSON.parse(text); }
    catch { return fail('bad_output', 'Claude did not return the JSON it was asked for.', { usage, model: served }); }
    return { ok: true, output, model: served, usage };
  }

  /** Does the key work, and does the model exist? Free: no tokens generated. */
  async function retrieveModel(model) {
    if (!configured()) return fail('auth', 'ANTHROPIC_API_KEY is not set.', { code: 'API_KEY_MISSING' });
    try {
      const m = await get().models.retrieve(model);
      return { ok: true, model: m.id, displayName: m.display_name || null };
    } catch (err) {
      return mapError(err);
    }
  }

  return { configured, structured, retrieveModel };
}

module.exports = {
  createGemini, createClaude, estimateCost, priceFor, DEFAULT_PRICES, PRICES_AS_OF, mapGeminiError,
  _internal: { refusedLevels, thinkingLevelFor }
};
