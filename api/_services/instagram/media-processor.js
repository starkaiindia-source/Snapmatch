/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/media-processor.js
   ----------------------------------------------------------------------------
   Text and meaning out of images and videos — cheapest reader first.

   ----------------------------------------------------------------------------
   WHO READS WHAT, AND WHAT IT COSTS

     ocrImage         plain OCR. Google Cloud Vision or the gateway. Cheap,
                      and it cannot tell a compatibility list from a jumper
                      diagram — so it never decides anything alone.
     screenImage      Gemini's small model, low resolution, a one-word answer:
                      LIKELY_COMPATIBILITY / LIKELY_IRRELEVANT / UNCERTAIN.
                      Its only job is to keep the deep call for images that
                      may deserve it.
     understandImage  Gemini's main model at full resolution: compatibility
                      list, product or repair content; the part pictured; the
                      product title; every model printed.
     understandVideo  Gemini reading the VIDEO ITSELF — not a thumbnail, not a
                      first frame. Two passes: a cheap one over the whole clip
                      ("is there a product, is there a list?"), then a detailed
                      one only if the first says yes.
     validateExtraction  Claude, on the few extractions matching left in doubt.

   A caller decides WHEN each is worth it (job-service.js). This file makes
   each call once: results are cached by the SHA-256 of the bytes (a repost, a
   reprocessing run or the same poster on five pages costs one call), a video
   by its media id, a validation by the hash of what was asked.

   ----------------------------------------------------------------------------
   EVERY CALL IS COUNTED AND CAPPED

   Before a model is called: the daily cap (usage.allow) and the budget of
   this sync (usage.budgetAllow). After: provider, model, tokens and estimated
   cost go to usage.recordAi. At a cap the answer is `deferred` or `budget` —
   the item waits; it is not failed and nothing is guessed in its place.

   ----------------------------------------------------------------------------
   NOTHING IS FILLED IN TO LOOK PROCESSED

   No provider, no key, a rejected key, no media URL: the result says which
   (`unavailable` with a code — API_KEY_MISSING, API_KEY_INVALID,
   VIDEO_MEDIA_UNAVAILABLE). A cover image read in place of a video is
   reported as a cover image.
   ========================================================================== */
'use strict';

const { sha256 } = require('../../_schema/instagram');
const aiProviders = require('./ai-providers');

/* English, Hindi and Tamil: what the trade's posters and reels are set in. */
const LANGUAGE_HINTS = ['en', 'hi', 'ta'];

const GEMINI_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const CLAUDE_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VIDEO_MIME = ['video/mp4', 'video/mpeg', 'video/mov', 'video/quicktime', 'video/webm', 'video/3gpp'];
/* An inline request may be 20 MB in all; base64 adds a third. */
const INLINE_VIDEO_MAX = 14 * 1024 * 1024;
const CLAUDE_IMAGE_MAX = Math.floor(3.5 * 1024 * 1024);
const VISION_CLASSES = ['compatibility', 'product', 'repair', 'other'];
const SCREEN_VERDICTS = ['LIKELY_COMPATIBILITY', 'LIKELY_IRRELEVANT', 'UNCERTAIN'];

/* --------------------------------------------------------------- prompts
   Changing any of these is a PROCESSING_VERSION bump: cached answers were
   given to the old wording. */

const SCREEN_SYSTEM_PROMPT = [
  'You screen media posted by mobile-phone spare-part sellers and repair technicians.',
  'Decide ONE thing: might this contain product COMPATIBILITY information — a part (display, combo, tempered glass,',
  'back cover, battery, frame, charging board) together with a statement or list of phone models it fits?',
  'verdict:',
  '  LIKELY_COMPATIBILITY  a list of phone models, or wording like "compatible with", "universal", "fits N models", in any language',
  '  LIKELY_IRRELEVANT     repair or diagnostic content (jumper diagrams, schematics, marked circuit boards, IC / bypass / short /',
  '                        charging-error / temperature-warning fixes), or anything with no part and no model list',
  '  UNCERTAIN             a part is shown but you cannot tell whether models are listed, or the text is too small to judge',
  'When in doubt answer UNCERTAIN — a wrong LIKELY_IRRELEVANT loses real data. Do not extract model names here.'
].join('\n');

const VISION_SYSTEM_PROMPT = [
  'You read media posted by mobile-phone spare-part sellers and repair technicians.',
  'Report ONLY what is visibly printed or pictured.',
  'Never add a phone model that is not printed. Never complete a series ("Y20, Y21" does not imply "Y22").',
  'Never replace a printed model name with a different model; copy each one exactly as printed, including spacing.',
  'If a character is hard to read, give what is printed as best you can see it, not what would make sense.',
  'The text may be English, Hindi, Tamil or mixed; model names are reported in the Latin script they are printed in.',
  '',
  'contentClass:',
  '  "compatibility" — it states that one part fits several phone models: a headed list of models,',
  '     "compatible with", "universal", "fits N models", in any language.',
  '  "repair" — repair or diagnostic content: jumper diagrams, schematics, board photos with marked lines,',
  '     IC / bypass / short / dead / charging-error / temperature-warning fixes. A phone model named there is NOT a compatibility claim.',
  '  "product" — a part shown or named without a compatibility list.',
  '  "other" — anything else.',
  'product: the part pictured or named ("display combo", "tempered glass", "back cover", "battery", "middle frame",',
  '  "charging board"), or "" if none is evident.',
  'lists: one entry per separate compatibility list. headline is that list\'s product title exactly as printed',
  '  (for example "Vivo Y20 Combo"), or "" if it has none. models is every phone model of that list, in reading order,',
  '  each once. atSecond is the time in the video where the list is readable, or 0 for an image.',
  '  Empty unless contentClass is "compatibility".',
  'text: the other legible text, line by line.',
  'confidence: 0 to 1 — how sure you are that the lists are complete and every model is read correctly.',
  '  Below 0.7 if text was small, blurred, cut off or shown too briefly.'
].join('\n');

const VIDEO_NOTE = 'This is a short video. Look at the WHOLE clip: a compatibility list often appears for only a second or two, ' +
  'sometimes near the end, and there may be several lists for different products. Report every one.';

const VALIDATOR_SYSTEM_PROMPT = [
  'You are a second reader checking a compatibility list that another system read from a phone-parts seller\'s post.',
  'You receive the entries that are in doubt, each with the catalogue records it might be, and — when available — the image itself.',
  'For each entry decide:',
  '  "candidate"   it is one of the offered catalogue records: give that record\'s id in model_id. Only an offered id is valid.',
  '  "none"        it is a real entry but none of the offered records is that phone. Leave model_id "".',
  '  "misread"     the image shows different text: give what is actually printed in printed_text.',
  '  "not_visible" you have the image and this entry is not printed in it.',
  'Never invent a phone model, never pick a record because its name merely looks similar, and never infer a variant',
  '(4G/5G, a year, Pro/Plus) that is not printed. If you cannot tell, answer "none".',
  'Without an image, judge only the text you are given and never answer "not_visible".',
  'list_is_compatibility: is this a statement that one part fits these phones (true), or something else such as a repair note (false)?',
  'product_category_id: one of the offered category ids if the product is clear, else "".'
].join('\n');

const str = { type: 'string' };

const SCREEN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: SCREEN_VERDICTS },
    kind: { type: 'string', enum: VISION_CLASSES },
    hasModelList: { type: 'boolean' },
    reason: str
  },
  required: ['verdict', 'kind', 'hasModelList', 'reason']
};

const VISION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    contentClass: { type: 'string', enum: VISION_CLASSES },
    confidence: { type: 'number' },
    product: str,
    lists: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { headline: str, models: { type: 'array', items: str }, atSecond: { type: 'number' } },
        required: ['headline', 'models', 'atSecond']
      }
    },
    text: str
  },
  required: ['contentClass', 'confidence', 'product', 'lists', 'text']
};

const VALIDATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    list_is_compatibility: { type: 'boolean' },
    product_category_id: str,
    entries: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          key: str,
          decision: { type: 'string', enum: ['candidate', 'none', 'misread', 'not_visible'] },
          model_id: str, printed_text: str, note: str
        },
        required: ['key', 'decision', 'model_id', 'printed_text', 'note']
      }
    },
    summary: str
  },
  required: ['list_is_compatibility', 'product_category_id', 'entries', 'summary']
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {object} deps
 * @param {object} deps.cfg          from config.load()
 * @param {object} deps.ai           ai-service (invoke / isConfigured)
 * @param {Function} [deps.fetchImpl]
 * @param {{get:Function, put:Function}} deps.cache
 * @param {{allow:Function, record:Function, budgetAllow?:Function, recordAi?:Function, addVideoSeconds?:Function}} deps.usage
 * @param {{gemini?:object, claude?:object}} [deps.providers]   injected in tests
 */
function createMediaProcessor({ cfg, ai, fetchImpl, cache, usage, providers }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const gemini = (providers && providers.gemini) || aiProviders.createGemini({ key: cfg.geminiKey, fetchImpl: doFetch });
  const claude = (providers && providers.claude) || aiProviders.createClaude({ key: cfg.anthropicKey });

  /* One download per image per tick, however many readers want its bytes. */
  const fetched = new Map();
  function bytesOf(mediaUrl) {
    if (!fetched.has(mediaUrl)) {
      if (fetched.size >= 6) fetched.delete(fetched.keys().next().value);
      fetched.set(mediaUrl, download(mediaUrl, cfg.maxImageBytes, 'image'));
    }
    return fetched.get(mediaUrl);
  }

  async function imageBytes({ mediaUrl, bytes, mimeType }) {
    if (bytes) return { bytes, mimeType: mimeType || 'image/jpeg' };
    if (!mediaUrl) throw Object.assign(new Error('no media URL'), { noUrl: true });
    return bytesOf(mediaUrl);
  }

  /* ------------------------------------------------------------ the gate */

  /**
   * One guarded model call: daily cap, sync budget, retry with backoff, and
   * the usage record — for every provider, in one place.
   * @param {'gemini'|'claude'} provider
   * @param {'screen'|'extract'|'video_screen'|'video'|'validate'} stage
   */
  async function guarded(provider, stage, call) {
    if (!usage.allow('ai')) return { ok: false, kind: 'deferred', reason: 'The daily AI cap has been reached.' };
    if (usage.budgetAllow && !usage.budgetAllow(provider)) {
      return { ok: false, kind: 'budget', reason: 'The AI budget of this sync is spent (' + (provider === 'claude' ? 'Claude validation calls' : 'Gemini calls') + ').' };
    }
    let res;
    for (let attempt = 0; attempt <= (cfg.aiRetries || 0); attempt++) {
      res = await call();
      if (usage.recordAi) usage.recordAi({ provider, stage, model: res.model || null, usage: res.usage || null, ok: !!res.ok });
      else usage.record('ai');
      if (res.ok || !(res.retryable || res.kind === 'timeout')) break;
      if (attempt < (cfg.aiRetries || 0)) await sleep(1000 * Math.pow(2, attempt));
    }
    return res;
  }

  /** A provider failure in the vocabulary the pipeline acts on. */
  function failure(res, extra) {
    if (res.kind === 'deferred') return Object.assign({ status: 'deferred', reason: res.reason }, extra);
    if (res.kind === 'budget') return Object.assign({ status: 'budget', reason: res.reason }, extra);
    if (res.kind === 'rate_limited') return Object.assign({ status: 'deferred', code: 'RATE_LIMITED', reason: res.reason + ' The item is queued for later.' }, extra);
    if (res.kind === 'auth') return Object.assign({ status: 'unavailable', code: res.code || 'API_KEY_INVALID', reason: res.reason }, extra);
    return Object.assign({ status: 'failed', code: res.kind === 'timeout' ? 'RETRY_REQUIRED' : null, reason: res.reason }, extra);
  }

  /* ------------------------------------------------------------------ OCR */

  /**
   * The text in one image. `bytes` (an image an admin supplied) is read
   * directly; otherwise `mediaUrl` is downloaded.
   */
  async function ocrImage({ mediaId, mediaUrl, bytes: given, mimeType: givenType }) {
    if (!mediaUrl && !given) {
      return { status: 'unavailable', reason: 'Instagram returned no media URL for this item (it omits it for copyrighted or flagged media).' };
    }
    if (cfg.ocrProvider === 'none') {
      return { status: 'unavailable', reason: 'No OCR provider is configured (INSTAGRAM_OCR_PROVIDER), so text in the image was not read.' };
    }
    if (cfg.ocrProvider === 'gateway' && !ai.isConfigured()) {
      return { status: 'unavailable', reason: 'OCR is set to the AI gateway, which is not configured.' };
    }
    if (cfg.ocrProvider === 'google_vision' && !cfg.visionKey) {
      return { status: 'unavailable', reason: 'OCR is set to Google Vision but GOOGLE_VISION_API_KEY is not set.' };
    }

    let bytes, mimeType;
    try {
      ({ bytes, mimeType } = await imageBytes({ mediaUrl, bytes: given, mimeType: givenType }));
    } catch (err) {
      return { status: 'failed', reason: 'The image could not be downloaded: ' + (err && err.message) };
    }
    const bytesHash = sha256(bytes);
    const cacheKey = 'ocr_' + bytesHash;
    const hit = await cache.get(cacheKey);
    if (hit) {
      usage.record('cacheHit');
      return Object.assign({ status: 'ok', cached: true, bytesHash, mediaId }, hit);
    }
    if (!usage.allow('ocr')) {
      return { status: 'deferred', reason: 'The daily OCR cap has been reached.', bytesHash };
    }

    usage.record('ocr');
    const result = cfg.ocrProvider === 'google_vision'
      ? await visionOcr(bytes)
      : await gatewayOcr(bytes, mimeType, mediaUrl);
    if (!result.ok) return { status: 'failed', reason: result.reason, bytesHash };

    const value = { text: result.text, lines: result.lines, confidence: result.confidence, engine: result.engine };
    await cache.put(cacheKey, value);
    return Object.assign({ status: 'ok', cached: false, bytesHash, mediaId }, value);
  }

  /* ------------------------------------------------------------ screening */

  /**
   * The cheapest look that can tell "worth reading" from "not": Gemini's
   * small model, low resolution, a three-way verdict and no extraction.
   */
  async function screenImage({ mediaId, mediaUrl, bytes: given, mimeType: givenType }) {
    if (cfg.visionProvider !== 'gemini') {
      return { status: 'unavailable', reason: 'Visual screening needs Gemini (GEMINI_API_KEY).' };
    }
    if (!gemini.configured()) return { status: 'unavailable', code: 'API_KEY_MISSING', reason: 'GEMINI_API_KEY is not set.' };
    let bytes, mimeType;
    try {
      ({ bytes, mimeType } = await imageBytes({ mediaUrl, bytes: given, mimeType: givenType }));
    } catch (err) {
      return err.noUrl ? { status: 'unavailable', reason: 'No image is available to screen.' }
        : { status: 'failed', reason: 'The image could not be downloaded: ' + (err && err.message) };
    }
    mimeType = cleanMime(mimeType);
    if (GEMINI_IMAGE_MIME.indexOf(mimeType) < 0) return { status: 'failed', reason: 'Gemini cannot read ' + mimeType + '.' };

    const bytesHash = sha256(bytes);
    const cacheKey = 'scr_' + bytesHash;
    const hit = await cache.get(cacheKey);
    if (hit) {
      usage.record('cacheHit');
      return Object.assign({ status: 'ok', cached: true, bytesHash, mediaId }, hit);
    }
    const res = await guarded('gemini', 'screen', () => gemini.interact({
      model: cfg.geminiScreenModel, system: SCREEN_SYSTEM_PROMPT, schema: SCREEN_SCHEMA,
      thinkingLevel: 'minimal', maxOutputTokens: 300,
      input: [
        { type: 'image', data: bytes.toString('base64'), mime_type: mimeType, resolution: 'low' },
        { type: 'text', text: 'Screen this image.' }
      ]
    }));
    if (!res.ok) return failure(res, { bytesHash });
    const parsed = validateScreenOutput(res.output, 'gemini:' + res.model);
    if (!parsed.ok) return { status: 'failed', reason: parsed.reason, bytesHash };
    await cache.put(cacheKey, parsed.value);
    return Object.assign({ status: 'ok', cached: false, bytesHash, mediaId }, parsed.value);
  }

  /* ------------------------------------------------------- image reading */

  /**
   * What one image SHOWS. Its answer is never trusted on its own: the caller
   * turns it back into text for the same extractor, matcher and validation
   * everything else goes through.
   */
  async function understandImage({ mediaId, mediaUrl, bytes: given, mimeType: givenType, ocrText }) {
    const provider = cfg.visionProvider;
    if (provider === 'none' || !provider) {
      return { status: 'unavailable', code: 'API_KEY_MISSING', reason: 'No AI vision provider is configured (GEMINI_API_KEY).' };
    }
    if (provider === 'gemini' && !gemini.configured()) return { status: 'unavailable', code: 'API_KEY_MISSING', reason: 'AI vision is set to Gemini but GEMINI_API_KEY is not set.' };
    if (provider === 'anthropic' && !claude.configured()) return { status: 'unavailable', code: 'API_KEY_MISSING', reason: 'AI vision is set to Claude but ANTHROPIC_API_KEY is not set.' };
    if (provider === 'gateway' && !ai.isConfigured()) return { status: 'unavailable', reason: 'AI vision is set to the AI gateway, which is not configured.' };

    let bytes, mimeType;
    try {
      ({ bytes, mimeType } = await imageBytes({ mediaUrl, bytes: given, mimeType: givenType }));
    } catch (err) {
      return err.noUrl ? { status: 'unavailable', reason: 'Instagram returned no media URL for this item.' }
        : { status: 'failed', reason: 'The image could not be downloaded: ' + (err && err.message) };
    }
    mimeType = cleanMime(mimeType);
    const accepted = provider === 'anthropic' ? CLAUDE_IMAGE_MIME : GEMINI_IMAGE_MIME;
    if (accepted.indexOf(mimeType) < 0) return { status: 'failed', reason: 'AI vision cannot read ' + mimeType + '.' };
    if (provider === 'anthropic' && bytes.length > CLAUDE_IMAGE_MAX) return { status: 'failed', reason: 'The image is larger than the vision model accepts.' };

    const bytesHash = sha256(bytes);
    const cacheKey = 'vis3_' + bytesHash;
    const hit = await cache.get(cacheKey);
    if (hit) {
      usage.record('cacheHit');
      return Object.assign({ status: 'ok', cached: true, bytesHash, mediaId }, hit);
    }

    const ask = requestText(ocrText);
    let res;
    if (provider === 'gemini') {
      res = await guarded('gemini', 'extract', () => gemini.interact({
        model: cfg.geminiModel, system: VISION_SYSTEM_PROMPT, schema: VISION_SCHEMA,
        thinkingLevel: 'low', maxOutputTokens: 8192,
        input: [{ type: 'image', data: bytes.toString('base64'), mime_type: mimeType, resolution: 'high' }, { type: 'text', text: ask }]
      }));
      if (res.ok) res.engine = 'gemini:' + res.model;
    } else if (provider === 'anthropic') {
      res = await guarded('claude', 'extract', () => claude.structured({
        model: cfg.claudeModel, system: VISION_SYSTEM_PROMPT, schema: VISION_SCHEMA, effort: cfg.claudeEffort,
        content: [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: bytes.toString('base64') } }, { type: 'text', text: ask }]
      }));
      if (res.ok) res.engine = 'claude:' + res.model;
    } else {
      if (!usage.allow('ai')) return { status: 'deferred', reason: 'The daily AI cap has been reached.', bytesHash };
      usage.record('ai');
      const g = await ai.invoke({
        capability: 'vision_understand', systemHint: VISION_SYSTEM_PROMPT,
        input: { mimeType, imageBase64: bytes.toString('base64'), request: ask, schema: VISION_SCHEMA, languageHints: LANGUAGE_HINTS }
      });
      res = g.ok
        ? { ok: true, engine: 'gateway', output: g.output && g.output.result && typeof g.output.result === 'object' ? g.output.result : g.output }
        : { ok: false, kind: 'error', reason: 'AI vision failed: ' + g.reason };
    }
    if (!res.ok) return failure(res, { bytesHash });
    const parsed = validateVisionOutput(res.output, res.engine);
    if (!parsed.ok) return { status: 'failed', reason: parsed.reason, bytesHash };

    await cache.put(cacheKey, parsed.value);
    return Object.assign({ status: 'ok', cached: false, bytesHash, mediaId }, parsed.value);
  }

  function requestText(ocrText) {
    return 'Report what this image shows.' + (ocrText && ocrText.trim()
      ? '\n\nAn OCR engine read the following from the same image. It may contain errors and may have lost the layout; ' +
        'use it to check your reading, never to add anything you cannot see:\n' + String(ocrText).slice(0, 4000) : '');
  }

  /* ------------------------------------------------------- video reading */

  /**
   * Gemini reading the video itself, in two passes.
   *
   *   pass 1  small model, low resolution, one frame every two seconds, a
   *           three-way verdict. Skipped when the caption already says the
   *           reel is about compatibility (`tier: 'HIGH'`).
   *   pass 2  main model, high resolution, cfg.videoFps frames a second,
   *           every list with the second it is readable at. Run only when
   *           pass 1 does not say LIKELY_IRRELEVANT.
   *
   * No media URL is `unavailable / VIDEO_MEDIA_UNAVAILABLE`: a cover image is
   * not a video, and reading one is never reported as video analysis.
   *
   * @param {{mediaId:string, mediaUrl:string|null, tier?:string}} args
   */
  async function understandVideo({ mediaId, mediaUrl, tier }) {
    if (cfg.videoProvider !== 'gemini') {
      return { status: 'unavailable', reason: 'Native video understanding needs Gemini (GEMINI_API_KEY).', lists: [] };
    }
    if (!gemini.configured()) return { status: 'unavailable', code: 'API_KEY_MISSING', reason: 'GEMINI_API_KEY is not set.', lists: [] };
    if (!mediaUrl) {
      return { status: 'unavailable', code: 'VIDEO_MEDIA_UNAVAILABLE', lists: [],
               reason: 'Instagram returned no media URL for this video (it omits it for copyrighted audio or flagged media).' };
    }

    const cacheKey = 'vid3_' + String(mediaId).replace(/[^A-Za-z0-9_-]/g, '');
    const hit = await cache.get(cacheKey);
    if (hit) {
      usage.record('cacheHit');
      return Object.assign({ status: 'ok', cached: true, mediaId }, hit);
    }

    let bytes, mimeType;
    try {
      ({ bytes, mimeType } = await download(mediaUrl, cfg.maxVideoBytes, 'video'));
    } catch (err) {
      return { status: 'failed', code: 'VIDEO_MEDIA_UNAVAILABLE', lists: [], reason: 'The video could not be downloaded: ' + (err && err.message) };
    }
    mimeType = cleanMime(mimeType);
    if (mimeType === 'video/quicktime') mimeType = 'video/mov';
    const seconds = mp4DurationSeconds(bytes);

    if (!usage.allow('video')) return { status: 'deferred', reason: 'The daily video-analysis cap has been reached.', lists: [] };
    if (usage.budgetAllow && !usage.budgetAllow('videoSeconds', seconds || 0)) {
      return { status: 'budget', reason: 'The video minutes budgeted for this sync are spent.', lists: [] };
    }

    /* small clips travel inline; larger ones through the Files API */
    let part, uploaded = null;
    if (bytes.length <= INLINE_VIDEO_MAX) {
      part = { type: 'video', data: bytes.toString('base64'), mime_type: mimeType };
    } else {
      const up = await gemini.uploadFile(bytes, mimeType);
      if (!up.ok) return failure(up, { lists: [] });
      uploaded = up.name;
      part = { type: 'video', uri: up.uri, mime_type: mimeType };
    }
    usage.record('video');
    if (usage.addVideoSeconds) usage.addVideoSeconds(seconds || 0);

    try {
      let screen = null;
      if (tier !== 'HIGH') {
        const p1 = await guarded('gemini', 'video_screen', () => gemini.interact({
          model: cfg.geminiScreenModel, system: SCREEN_SYSTEM_PROMPT, schema: SCREEN_SCHEMA,
          thinkingLevel: 'minimal', maxOutputTokens: 300, timeoutMs: 60000,
          input: [Object.assign({}, part, { resolution: 'low', processing: { type: 'static', fps: 0.5 } }),
                  { type: 'text', text: 'Screen this video. ' + VIDEO_NOTE }]
        }));
        if (!p1.ok) return failure(p1, { lists: [] });
        const parsed1 = validateScreenOutput(p1.output, 'gemini:' + p1.model);
        if (!parsed1.ok) return { status: 'failed', reason: parsed1.reason, lists: [] };
        screen = parsed1.value;
        if (screen.verdict === 'LIKELY_IRRELEVANT') {
          const value = {
            contentClass: screen.kind === 'repair' ? 'repair' : 'other', confidence: null, product: null, lists: [], text: '',
            engine: screen.engine, screen, passes: 1, seconds
          };
          await cache.put(cacheKey, value);
          return Object.assign({ status: 'ok', cached: false, mediaId }, value);
        }
      }

      const p2 = await guarded('gemini', 'video', () => gemini.interact({
        model: cfg.geminiModel, system: VISION_SYSTEM_PROMPT, schema: VISION_SCHEMA,
        thinkingLevel: 'low', maxOutputTokens: 8192, timeoutMs: 120000,
        input: [Object.assign({}, part, { resolution: 'high', processing: { type: 'static', fps: cfg.videoFps || 2 } }),
                { type: 'text', text: 'Report what this video shows. ' + VIDEO_NOTE }]
      }));
      if (!p2.ok) return failure(p2, { lists: [], screen });
      const parsed2 = validateVisionOutput(p2.output, 'gemini:' + p2.model);
      if (!parsed2.ok) return { status: 'failed', reason: parsed2.reason, lists: [] };
      const value = Object.assign({}, parsed2.value, { screen, passes: screen ? 2 : 1, seconds });
      await cache.put(cacheKey, value);
      return Object.assign({ status: 'ok', cached: false, mediaId }, value);
    } finally {
      if (uploaded) await gemini.deleteFile(uploaded);
    }
  }

  /* ---------------------------------------- frames through the gateway */

  async function analyzeVideo({ mediaId, mediaUrl, thumbnailUrl }) {
    const coverOnly = async reason => {
      if (!thumbnailUrl) return { status: 'unavailable', reason, frames: [], transcript: null };
      const cover = await ocrImage({ mediaId: mediaId + ':cover', mediaUrl: thumbnailUrl });
      if (cover.status === 'deferred') return Object.assign(cover, { frames: [], transcript: null });
      const frames = cover.status === 'ok' && cover.text
        ? [{ timeMs: 0, text: cover.text, confidence: cover.confidence, source: 'cover' }] : [];
      return {
        status: frames.length ? 'partial' : 'unavailable',
        reason: reason + (frames.length ? ' Only the cover image was read.' : ''),
        frames, transcript: null, engine: cover.engine || null
      };
    };

    if (cfg.videoProvider !== 'gateway' || !ai.isConfigured()) {
      return coverOnly('No video processor is configured, so frames and speech were not read.');
    }
    if (!mediaUrl) {
      return coverOnly('Instagram returned no media URL for this video (it omits it for copyrighted audio or flagged media).');
    }

    const cacheKey = 'vid_' + String(mediaId).replace(/[^A-Za-z0-9_-]/g, '');
    const hit = await cache.get(cacheKey);
    if (hit) {
      usage.record('cacheHit');
      return Object.assign({ status: 'ok', cached: true }, hit);
    }
    if (!usage.allow('video')) return { status: 'deferred', reason: 'The daily video-analysis cap has been reached.', frames: [], transcript: null };

    usage.record('video');
    const res = await ai.invoke({
      capability: 'video_analyze',
      systemHint: 'Sample frames on scene or on-screen text change. Return only text actually visible or spoken. Never infer.',
      input: {
        mediaUrl,
        maxSampledFrames: cfg.maxFramesPerVideo * 3,
        sceneThreshold: 0.3,
        transcribe: cfg.transcribe,
        languageHints: LANGUAGE_HINTS
      }
    });
    if (!res.ok) return { status: 'failed', reason: 'Video analysis failed: ' + res.reason, frames: [], transcript: null };

    const parsed = validateVideoOutput(res.output);
    if (!parsed.ok) return { status: 'failed', reason: parsed.reason, frames: [], transcript: null };

    const keyFrames = selectKeyFrames(parsed.frames, { maxFrames: cfg.maxFramesPerVideo });
    const value = {
      frames: keyFrames,
      sampledFrames: parsed.frames.length,
      transcript: cfg.transcribe ? parsed.transcript : null,
      engine: parsed.engine
    };
    await cache.put(cacheKey, value);
    return Object.assign({ status: 'ok', cached: false }, value);
  }

  /* -------------------------------------------------- the second opinion */

  /**
   * Claude, on one extraction that matching left in doubt. `request` is the
   * digest validation.js builds: the doubtful entries, the catalogue records
   * each might be, the categories. The image is sent when there is one.
   *
   * A failure here never discards the extraction it was asked about.
   */
  async function validateExtraction({ request, mediaUrl, bytes: given, mimeType: givenType }) {
    if (cfg.validator !== 'anthropic') return { status: 'unavailable', reason: 'No validator is configured.' };
    if (!claude.configured()) return { status: 'unavailable', code: 'API_KEY_MISSING', reason: 'ANTHROPIC_API_KEY is not set.' };

    let image = null;
    if (given || mediaUrl) {
      try {
        const got = await imageBytes({ mediaUrl, bytes: given, mimeType: givenType });
        const mime = cleanMime(got.mimeType);
        if (CLAUDE_IMAGE_MIME.indexOf(mime) > -1 && got.bytes.length <= CLAUDE_IMAGE_MAX) image = { bytes: got.bytes, mime };
      } catch { image = null; }      /* validated from the text alone */
    }
    const body = JSON.stringify(Object.assign({}, request, { image_attached: !!image }));
    const cacheKey = 'val_' + sha256(body + '|' + (image ? sha256(image.bytes) : 'text') + '|' + cfg.claudeModel);
    const hit = await cache.get(cacheKey);
    if (hit) {
      usage.record('cacheHit');
      return Object.assign({ status: 'ok', cached: true }, hit);
    }
    const content = [];
    if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.bytes.toString('base64') } });
    content.push({ type: 'text', text: 'Check these entries.\n\n' + body });

    const res = await guarded('claude', 'validate', () => claude.structured({
      model: cfg.claudeModel, system: VALIDATOR_SYSTEM_PROMPT, schema: VALIDATION_SCHEMA, effort: cfg.claudeEffort, content
    }));
    if (!res.ok) return failure(res);
    const out = res.output;
    if (!out || typeof out !== 'object' || !Array.isArray(out.entries) || typeof out.list_is_compatibility !== 'boolean') {
      return { status: 'failed', reason: 'The validator did not return the required object.' };
    }
    const value = { output: out, model: res.model, engine: 'claude:' + res.model, visual: !!image };
    await cache.put(cacheKey, value);
    return Object.assign({ status: 'ok', cached: false }, value);
  }

  /* ---------------------------------------------------------- providers */

  async function download(url, maxBytes, kind) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), kind === 'video' ? 45000 : 15000);
    try {
      const res = await doFetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) throw new Error('larger than the configured limit');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error('larger than the configured limit');
      const mimeType = (res.headers && res.headers.get && res.headers.get('content-type')) || (kind === 'video' ? 'video/mp4' : 'image/jpeg');
      if (kind === 'video') {
        if (!/^video\//i.test(mimeType) && !/octet-stream/i.test(mimeType)) throw new Error('not a video (' + mimeType + ')');
        return { bytes: buf, mimeType: /^video\//i.test(mimeType) ? mimeType : 'video/mp4' };
      }
      if (!/^image\//i.test(mimeType)) throw new Error('not an image (' + mimeType + ')');
      return { bytes: buf, mimeType };
    } finally {
      clearTimeout(timer);
    }
  }

  async function gatewayOcr(bytes, mimeType, mediaUrl) {
    const input = { mimeType, languageHints: LANGUAGE_HINTS };
    /* Small images travel inline; large ones by URL so the request stays
       well under any body limit. The gateway fetches the URL itself. */
    if (bytes.length <= 3 * 1024 * 1024 || !mediaUrl) input.imageBase64 = bytes.toString('base64');
    else input.mediaUrl = mediaUrl;
    const res = await ai.invoke({
      capability: 'media_ocr',
      systemHint: 'Return only the text visible in the image, line by line, with per-line confidence. Never infer.',
      input
    });
    if (!res.ok) return { ok: false, reason: 'OCR failed: ' + res.reason };
    return validateOcrOutput(res.output, 'gateway');
  }

  async function visionOcr(bytes) {
    try {
      const res = await doFetch('https://vision.googleapis.com/v1/images:annotate?key=' + encodeURIComponent(cfg.visionKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{
          image: { content: bytes.toString('base64') },
          /* DOCUMENT_: dense text in columns — a 68-model list — comes back
             block by block, in reading order, instead of as scattered words */
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          imageContext: { languageHints: LANGUAGE_HINTS }
        }] })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) return { ok: false, reason: 'Google Vision answered HTTP ' + res.status };
      return parseVisionResponse(body);
    } catch (err) {
      return { ok: false, reason: 'Google Vision could not be reached' };
    }
  }

  return { ocrImage, screenImage, understandImage, understandVideo, analyzeVideo, validateExtraction };
}

/* ------------------------------------------------------------ validation */

function cleanMime(m) {
  return String(m || '').split(';')[0].trim().toLowerCase();
}

const text = (v, max) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null);

/** Nothing the screening model returns is used until it passes this. */
function validateScreenOutput(out, engine) {
  if (!out || typeof out !== 'object') return { ok: false, reason: 'screening output is not an object' };
  if (SCREEN_VERDICTS.indexOf(out.verdict) < 0) return { ok: false, reason: 'screening output has no valid verdict' };
  return { ok: true, value: {
    verdict: out.verdict,
    kind: VISION_CLASSES.indexOf(out.kind) > -1 ? out.kind : 'other',
    hasModelList: out.hasModelList === true,
    reason: text(out.reason, 200),
    engine: String(engine || 'vision').slice(0, 80)
  } };
}

/** Nothing the vision model returns is used until it passes this. Accepts the
    current shape (`lists`) and the earlier one (`headline` + `models`). */
function validateVisionOutput(out, engine) {
  if (!out || typeof out !== 'object') return { ok: false, reason: 'vision output is not an object' };
  if (VISION_CLASSES.indexOf(out.contentClass) < 0) return { ok: false, reason: 'vision output has no valid contentClass' };
  const raw = Array.isArray(out.lists) ? out.lists
    : Array.isArray(out.models) ? [{ headline: out.headline, models: out.models, atSecond: 0 }] : null;
  if (!raw) return { ok: false, reason: 'vision output has no lists array' };

  const lists = raw.slice(0, 12).map(l => {
    const seen = new Set();
    const models = (Array.isArray(l && l.models) ? l.models : [])
      .filter(m => typeof m === 'string' && m.trim() && m.length <= 80)
      .map(m => m.replace(/\s+/g, ' ').trim())
      .filter(m => { const k = m.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 200);
    const at = Number(l && l.atSecond);
    return { headline: text(l && l.headline, 160), models, atSecond: Number.isFinite(at) && at > 0 ? Math.round(at * 10) / 10 : 0 };
  }).filter(l => l.models.length || l.headline);

  const conf = Number(out.confidence);
  return { ok: true, value: {
    contentClass: out.contentClass,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null,
    product: text(out.product, 80),
    /* a model named in a repair image is not a compatibility entry */
    lists: out.contentClass === 'compatibility' ? lists : [],
    text: typeof out.text === 'string' ? out.text.slice(0, 8000) : '',
    engine: String(engine || 'vision').slice(0, 80)
  } };
}

/**
 * The duration of an MP4 / MOV from its `mvhd` box, or null. Read from the
 * bytes already downloaded: the video budget is in minutes, and Instagram's
 * API does not say how long a reel is.
 */
function mp4DurationSeconds(buf) {
  try {
    const at = buf.indexOf(Buffer.from('mvhd', 'latin1'));
    if (at < 0 || at + 32 > buf.length) return null;
    const version = buf[at + 4];
    let timescale, duration;
    if (version === 1) {
      if (at + 40 > buf.length) return null;
      timescale = buf.readUInt32BE(at + 24);
      duration = Number(buf.readBigUInt64BE(at + 28));
    } else {
      timescale = buf.readUInt32BE(at + 16);
      duration = buf.readUInt32BE(at + 20);
    }
    if (!timescale || !Number.isFinite(duration)) return null;
    const s = duration / timescale;
    return s > 0 && s < 6 * 3600 ? Math.round(s * 10) / 10 : null;
  } catch {
    return null;
  }
}

function validateOcrOutput(out, engine) {
  if (!out || typeof out !== 'object') return { ok: false, reason: 'OCR output is not an object' };
  const inner = out.result && typeof out.result === 'object' ? out.result : out;
  if (typeof inner.text !== 'string') return { ok: false, reason: 'OCR output has no text field' };
  const lines = Array.isArray(inner.lines)
    ? inner.lines.slice(0, 400).filter(l => l && typeof l.text === 'string')
        .map(l => ({ text: l.text.slice(0, 500), confidence: clamp01(l.confidence) }))
    : [];
  const conf = clamp01(inner.confidence) != null ? clamp01(inner.confidence) : averageConfidence(lines);
  return {
    ok: true, text: inner.text.slice(0, 20000), lines, confidence: conf,
    engine: typeof inner.engine === 'string' ? inner.engine.slice(0, 80) : engine
  };
}

function parseVisionResponse(body) {
  const r = body && Array.isArray(body.responses) ? body.responses[0] : null;
  if (!r) return { ok: false, reason: 'Google Vision returned no response' };
  if (r.error) return { ok: false, reason: 'Google Vision: ' + String(r.error.message || 'error').slice(0, 200) };
  const full = r.fullTextAnnotation;
  const text = full && typeof full.text === 'string' ? full.text
    : (r.textAnnotations && r.textAnnotations[0] && r.textAnnotations[0].description) || '';
  const confidences = [];
  ((full && full.pages) || []).forEach(p => (p.blocks || []).forEach(b => {
    if (Number.isFinite(b.confidence)) confidences.push(b.confidence);
  }));
  const confidence = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null;
  return { ok: true, text: String(text).slice(0, 20000), lines: [], confidence, engine: 'google-vision:DOCUMENT_TEXT_DETECTION' };
}

function validateVideoOutput(out) {
  if (!out || typeof out !== 'object') return { ok: false, reason: 'video output is not an object' };
  const inner = out.result && typeof out.result === 'object' ? out.result : out;
  if (!Array.isArray(inner.frames)) return { ok: false, reason: 'video output has no frames array' };
  const frames = inner.frames.slice(0, 300).filter(f => f && typeof f.text === 'string').map(f => ({
    timeMs: Number.isFinite(Number(f.timeMs)) ? Math.max(0, Math.round(Number(f.timeMs))) : 0,
    text: f.text.slice(0, 4000),
    confidence: clamp01(f.confidence),
    sceneScore: clamp01(f.sceneScore)
  }));
  let transcript = null;
  if (inner.transcript && typeof inner.transcript === 'object' && typeof inner.transcript.text === 'string') {
    transcript = { text: inner.transcript.text.slice(0, 20000), language: typeof inner.transcript.language === 'string' ? inner.transcript.language.slice(0, 16) : null };
  }
  return { ok: true, frames, transcript, engine: typeof inner.engine === 'string' ? inner.engine.slice(0, 80) : 'gateway' };
}

/* ------------------------------------------------------------ key frames */

function frameTokens(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1));
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  a.forEach(t => { if (b.has(t)) inter++; });
  return inter / (a.size + b.size - inter);
}

/**
 * Keeps the frames whose on-screen text says something new.
 *
 * A frame is kept when its text is less than 60% the same as the last kept
 * frame's (a new card, a new model list), or when it is a scene cut with
 * text on it. A clearer read of the SAME text replaces the earlier one. If
 * more than `maxFrames` remain, the ones that contribute the most words not
 * already seen are kept — in time order.
 *
 * @param {Array<{timeMs:number, text:string, confidence:number|null, sceneScore:number|null}>} frames
 */
function selectKeyFrames(frames, { maxFrames = 8, sameText = 0.6, sceneThreshold = 0.3 } = {}) {
  const sorted = (frames || []).filter(f => f && String(f.text || '').trim())
    .slice().sort((a, b) => a.timeMs - b.timeMs);
  const kept = [];
  sorted.forEach(f => {
    const tokens = frameTokens(f.text);
    if (!tokens.size) return;
    const last = kept[kept.length - 1];
    if (!last) { kept.push({ f, tokens }); return; }
    const sim = jaccard(tokens, last.tokens);
    if (sim < sameText || (Number(f.sceneScore) >= sceneThreshold && sim < 0.95)) {
      kept.push({ f, tokens });
    } else if ((Number(f.confidence) || 0) > (Number(last.f.confidence) || 0) + 0.1) {
      kept[kept.length - 1] = { f, tokens };
    }
  });
  if (kept.length <= maxFrames) return kept.map(k => k.f);

  const seen = new Set();
  const scored = kept.map((k, i) => ({ k, i }));
  const chosen = [];
  while (chosen.length < maxFrames && scored.length) {
    let bestIdx = 0, best = -1;
    scored.forEach((s, idx) => {
      let novelty = 0;
      s.k.tokens.forEach(t => { if (!seen.has(t)) novelty++; });
      if (novelty > best) { best = novelty; bestIdx = idx; }
    });
    const pick = scored.splice(bestIdx, 1)[0];
    pick.k.tokens.forEach(t => seen.add(t));
    chosen.push(pick);
  }
  return chosen.sort((a, b) => a.i - b.i).map(c => c.k.f);
}

function clamp01(v) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function averageConfidence(lines) {
  const vals = lines.map(l => l.confidence).filter(v => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

module.exports = {
  createMediaProcessor, selectKeyFrames, validateOcrOutput, parseVisionResponse, validateVideoOutput,
  validateVisionOutput, validateScreenOutput, mp4DurationSeconds,
  VISION_SYSTEM_PROMPT, SCREEN_SYSTEM_PROMPT, VALIDATOR_SYSTEM_PROMPT,
  VISION_SCHEMA, SCREEN_SCHEMA, VALIDATION_SCHEMA, LANGUAGE_HINTS, VIDEO_MIME
};
