/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/media-processor.js
   ----------------------------------------------------------------------------
   Text out of images and videos: OCR, key frames, transcripts.

   ----------------------------------------------------------------------------
   WHERE THE WORK HAPPENS

   Not in a Vercel function — there is no GPU, no ffmpeg and a hard time limit
   there. Two providers, both configured by environment and both honest when
   absent:

     gateway        the Local AI service (docs/AI-ARCHITECTURE.md), which runs
                    on hardware you control and implements the `media_ocr` and
                    `video_analyze` capabilities
     google_vision  Cloud Vision TEXT_DETECTION for images, with an API key
                    (needs billing on the Google Cloud project)

   With neither, an image is recorded as "OCR unavailable" and the post is
   read from its caption. Nothing is ever filled in to look processed.

   ----------------------------------------------------------------------------
   COST CONTROL

     · the same bytes are never OCR'd twice: results are cached by the
       SHA-256 of the image, so a repost, a reprocessing run or the same
       glass photo on five pages costs one call
     · a video is analysed once per media id (a published video cannot change)
     · every call checks the daily cap first; at the cap the item is DEFERRED,
       not failed, and the job pauses as quota_exhausted
     · key frames: the provider samples on scene change, and this file keeps
       only the frames whose TEXT changed — twenty frames of the same "A15
       Tempered Glass" banner are one piece of evidence, not twenty
   ========================================================================== */
'use strict';

const { sha256 } = require('../../_schema/instagram');

/**
 * @param {object} deps
 * @param {object} deps.cfg          from config.load()
 * @param {object} deps.ai           ai-service (invoke / isConfigured)
 * @param {Function} [deps.fetchImpl]
 * @param {{get:Function, put:Function}} deps.cache
 * @param {{allow:Function, record:Function}} deps.usage
 */
function createMediaProcessor({ cfg, ai, fetchImpl, cache, usage }) {
  const doFetch = fetchImpl || globalThis.fetch;

  async function ocrImage({ mediaId, mediaUrl }) {
    if (!mediaUrl) {
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
      ({ bytes, mimeType } = await download(mediaUrl, cfg.maxImageBytes));
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
      return coverOnly('No video processor is configured (the AI gateway\'s video_analyze capability), so frames and speech were not read.');
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
        languageHints: ['en', 'hi']
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

  /* ---------------------------------------------------------- providers */

  async function download(url, maxBytes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await doFetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) throw new Error('larger than the configured limit');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error('larger than the configured limit');
      const mimeType = (res.headers && res.headers.get && res.headers.get('content-type')) || 'image/jpeg';
      if (!/^image\//i.test(mimeType)) throw new Error('not an image (' + mimeType + ')');
      return { bytes: buf, mimeType };
    } finally {
      clearTimeout(timer);
    }
  }

  async function gatewayOcr(bytes, mimeType, mediaUrl) {
    const input = { mimeType, languageHints: ['en', 'hi'] };
    /* Small images travel inline; large ones by URL so the request stays
       well under any body limit. The gateway fetches the URL itself. */
    if (bytes.length <= 3 * 1024 * 1024) input.imageBase64 = bytes.toString('base64');
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
          features: [{ type: 'TEXT_DETECTION' }],
          imageContext: { languageHints: ['en', 'hi'] }
        }] })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) return { ok: false, reason: 'Google Vision answered HTTP ' + res.status };
      return parseVisionResponse(body);
    } catch (err) {
      return { ok: false, reason: 'Google Vision could not be reached' };
    }
  }

  return { ocrImage, analyzeVideo };
}

/* ------------------------------------------------------------ validation */

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
  return { ok: true, text: String(text).slice(0, 20000), lines: [], confidence, engine: 'google-vision:TEXT_DETECTION' };
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

module.exports = { createMediaProcessor, selectKeyFrames, validateOcrOutput, parseVisionResponse, validateVideoOutput };
