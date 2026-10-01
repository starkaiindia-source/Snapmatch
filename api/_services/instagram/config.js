/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/config.js
   ----------------------------------------------------------------------------
   Every knob of the importer, read from the environment in one place, with
   the ceiling each one is clamped to. Cost control lives here: a limit that
   can be set to "unlimited" by a typo in the dashboard is not a limit.

   WHO READS WHAT

     Gemini   (GEMINI_API_KEY)        the primary media reader — images,
                                      carousels and video
     Claude   (ANTHROPIC_API_KEY)     a second opinion on the few extractions
                                      that are ambiguous; never every post
     Vision   (GOOGLE_VISION_API_KEY) plain OCR, optional and supporting
     gateway  (AI_GATEWAY_*)          the self-hosted route for all of them

   status() reports PRESENCE, never a value — it is sent to the admin UI.
   ========================================================================== */
'use strict';

const ai = require('../ai-service');

function env(name) {
  return String(process.env[name] || '').trim();
}

function int(name, fallback, min, max) {
  const n = Number(env(name));
  if (!Number.isFinite(n) || env(name) === '') return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function float(name, fallback, min, max) {
  const n = Number(env(name));
  if (!Number.isFinite(n) || env(name) === '') return fallback;
  return Math.min(max, Math.max(min, n));
}

function pick(name, allowed) {
  const v = env(name).toLowerCase();
  return allowed.indexOf(v) > -1 ? v : null;
}

function modelId(name, fallback) {
  return /^[a-z0-9][a-z0-9._-]{2,80}$/i.test(env(name)) ? env(name) : fallback;
}

/** INSTAGRAM_AI_PRICES: {"model-prefix":[inputPerMTok, outputPerMTok]}. A
    malformed value is ignored whole — a half-read price table is worse than
    the default one. */
function prices() {
  const raw = env('INSTAGRAM_AI_PRICES');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const out = {};
    Object.keys(parsed || {}).slice(0, 40).forEach(k => {
      const p = parsed[k];
      if (/^[a-z0-9._-]{3,80}$/i.test(k) && Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(Number(n)) && Number(n) >= 0)) {
        out[k.toLowerCase()] = [Number(p[0]), Number(p[1])];
      }
    });
    return out;
  } catch {
    return {};
  }
}

function load() {
  const geminiKey = env('GEMINI_API_KEY');
  const anthropicKey = env('ANTHROPIC_API_KEY');

  const ocrProvider = (() => {
    const v = pick('INSTAGRAM_OCR_PROVIDER', ['gateway', 'google_vision', 'none']);
    if (v) return v;
    /* Default: the AI gateway when there is one, Google Vision when its key
       is set, otherwise none. Never a guess at a provider that has no
       credentials. */
    if (ai.isConfigured()) return 'gateway';
    return env('GOOGLE_VISION_API_KEY') ? 'google_vision' : 'none';
  })();

  /* What an image SHOWS — compatibility list, product or repair content, and
     the models printed on it. Gemini first; Claude only if it is the one key
     there is; the gateway otherwise. */
  const visionProvider = pick('INSTAGRAM_VISION_PROVIDER', ['gemini', 'anthropic', 'gateway', 'none']) ||
    (geminiKey ? 'gemini' : anthropicKey ? 'anthropic' : ai.isConfigured() ? 'gateway' : 'none');

  /* Video: Gemini reads the file natively; the gateway samples frames. */
  const videoProvider = pick('INSTAGRAM_VIDEO_PROVIDER', ['gemini', 'gateway', 'none']) ||
    (geminiKey ? 'gemini' : ai.isConfigured() ? 'gateway' : 'none');

  /* The second opinion. Never the same model that did the reading. */
  const validator = pick('INSTAGRAM_VALIDATOR', ['anthropic', 'none']) ||
    (anthropicKey && visionProvider !== 'anthropic' ? 'anthropic' : 'none');

  return {
    graph: {
      token: env('INSTAGRAM_GRAPH_ACCESS_TOKEN'),
      igUserId: env('INSTAGRAM_BUSINESS_ACCOUNT_ID'),
      appSecret: env('INSTAGRAM_APP_SECRET'),
      version: /^v\d+\.\d+$/.test(env('INSTAGRAM_GRAPH_API_VERSION')) ? env('INSTAGRAM_GRAPH_API_VERSION') : 'v25.0',
      timeoutMs: int('INSTAGRAM_GRAPH_TIMEOUT_MS', 15000, 2000, 60000)
    },
    ocrProvider,
    visionKey: env('GOOGLE_VISION_API_KEY'),

    visionProvider,
    videoProvider,
    validator,
    geminiKey,
    /* deep extraction, and the cheap model that only decides "worth a deep look?" */
    geminiModel: modelId('INSTAGRAM_GEMINI_MODEL', 'gemini-3.8-flash'),
    geminiScreenModel: modelId('INSTAGRAM_GEMINI_SCREEN_MODEL', 'gemini-3.1-flash-lite'),
    anthropicKey,
    claudeModel: modelId('INSTAGRAM_CLAUDE_MODEL', modelId('INSTAGRAM_VISION_MODEL', 'claude-opus-5-5')),
    claudeEffort: pick('INSTAGRAM_CLAUDE_EFFORT', ['low', 'medium', 'high', 'xhigh', 'max']) || 'medium',
    /* Confidence routing: at or above `high` an AI reading goes straight to
       database matching; below `validate` it gets a second opinion. Between
       the two it is matched, and validated only if matching turns up doubt. */
    confidenceHigh: float('INSTAGRAM_CONFIDENCE_HIGH', 0.9, 0.5, 1),
    confidenceValidate: float('INSTAGRAM_VALIDATE_BELOW', 0.7, 0, 1),
    aiRetries: int('INSTAGRAM_AI_RETRIES', 1, 0, 3),
    videoFps: float('INSTAGRAM_VIDEO_FPS', 2, 0.2, 5),
    maxVideoBytes: int('INSTAGRAM_MAX_VIDEO_BYTES', 60 * 1024 * 1024, 1024 * 1024, 200 * 1024 * 1024),
    prices: prices(),

    /* A post that is repair by its own caption is not sent to OCR or vision.
       "true" reads it anyway (a compatibility list under a repair caption is
       then found, at the price of reading every repair post). */
    readRepairMedia: env('INSTAGRAM_READ_REPAIR_MEDIA').toLowerCase() === 'true',
    transcribe: env('INSTAGRAM_TRANSCRIBE').toLowerCase() !== 'false',
    aiMode: pick('INSTAGRAM_AI_MODE', ['off', 'fallback', 'always']) || 'fallback',

    /* limits */
    maxItemsPerJob: int('INSTAGRAM_MAX_ITEMS_PER_JOB', 50, 1, 500),
    maxDiscoveryPages: int('INSTAGRAM_MAX_DISCOVERY_PAGES', 20, 1, 60),
    pageSize: int('INSTAGRAM_PAGE_SIZE', 25, 5, 50),
    maxFramesPerVideo: int('INSTAGRAM_MAX_FRAMES_PER_VIDEO', 8, 1, 30),
    maxCarouselChildren: int('INSTAGRAM_MAX_CAROUSEL_CHILDREN', 10, 1, 20),
    maxImageBytes: int('INSTAGRAM_MAX_IMAGE_BYTES', 8 * 1024 * 1024, 64 * 1024, 20 * 1024 * 1024),
    maxAttempts: int('INSTAGRAM_MAX_ATTEMPTS', 3, 1, 10),
    tickBudgetMs: int('INSTAGRAM_TICK_BUDGET_MS', 8000, 2000, 55000),
    leaseMs: int('INSTAGRAM_LEASE_MS', 60000, 10000, 600000),

    /* The AI budget of ONE sync. When any of these is spent, the items that
       still need a model are queued — the job pauses as "budget reached" and
       a person decides whether to spend more. */
    maxAiItemsPerSync: int('INSTAGRAM_MAX_AI_ITEMS_PER_SYNC', 40, 0, 2000),
    maxGeminiCallsPerSync: int('INSTAGRAM_MAX_GEMINI_CALLS_PER_SYNC', 60, 0, 5000),
    maxClaudeCallsPerSync: int('INSTAGRAM_MAX_CLAUDE_VALIDATION_CALLS_PER_SYNC', 10, 0, 1000),
    maxVideoMinutesPerSync: int('INSTAGRAM_MAX_VIDEO_MINUTES_PER_SYNC', 20, 0, 600),

    /* daily caps, rolled over at midnight India time */
    dailyGraphCalls: int('INSTAGRAM_DAILY_GRAPH_CALLS', 150, 1, 5000),
    dailyOcrCalls: int('INSTAGRAM_DAILY_OCR_CALLS', 500, 0, 20000),
    dailyAiCalls: int('INSTAGRAM_DAILY_AI_CALLS', 200, 0, 20000),
    dailyVideoCalls: int('INSTAGRAM_DAILY_VIDEO_CALLS', 60, 0, 5000)
  };
}

function graphConfigured(cfg) {
  return !!(cfg.graph.token && cfg.graph.igUserId);
}

function visionConfigured(cfg) {
  return cfg.visionProvider === 'gemini' ? !!cfg.geminiKey
    : cfg.visionProvider === 'anthropic' ? !!cfg.anthropicKey
    : cfg.visionProvider === 'gateway' ? ai.isConfigured() : false;
}

function videoConfigured(cfg) {
  return cfg.videoProvider === 'gemini' ? !!cfg.geminiKey : cfg.videoProvider === 'gateway' ? ai.isConfigured() : false;
}

/** For the admin page: what is switched on, what is missing, and the limits. */
function status(cfg = load()) {
  const missingFor = p => p === 'gemini' ? ['GEMINI_API_KEY'] : p === 'anthropic' ? ['ANTHROPIC_API_KEY']
    : p === 'gateway' ? ai.status().missing : ['GEMINI_API_KEY'];
  return {
    graph: {
      configured: graphConfigured(cfg),
      missing: [
        !cfg.graph.token && 'INSTAGRAM_GRAPH_ACCESS_TOKEN',
        !cfg.graph.igUserId && 'INSTAGRAM_BUSINESS_ACCOUNT_ID'
      ].filter(Boolean),
      version: cfg.graph.version,
      appSecretProof: !!cfg.graph.appSecret
    },
    ocr: {
      provider: cfg.ocrProvider,
      configured: cfg.ocrProvider === 'gateway' ? ai.isConfigured()
        : cfg.ocrProvider === 'google_vision' ? !!cfg.visionKey : false,
      missing: cfg.ocrProvider === 'google_vision' && !cfg.visionKey ? ['GOOGLE_VISION_API_KEY']
        : cfg.ocrProvider === 'gateway' && !ai.isConfigured() ? ai.status().missing
        : cfg.ocrProvider === 'none' ? ['INSTAGRAM_OCR_PROVIDER'] : []
    },
    vision: {
      provider: cfg.visionProvider,
      configured: visionConfigured(cfg),
      model: cfg.visionProvider === 'gemini' ? cfg.geminiModel : cfg.visionProvider === 'anthropic' ? cfg.claudeModel : null,
      screenModel: cfg.visionProvider === 'gemini' ? cfg.geminiScreenModel : null,
      missing: visionConfigured(cfg) ? [] : missingFor(cfg.visionProvider)
    },
    validator: {
      provider: cfg.validator,
      configured: cfg.validator === 'anthropic' && !!cfg.anthropicKey,
      model: cfg.validator === 'anthropic' ? cfg.claudeModel : null,
      validateBelow: cfg.confidenceValidate,
      missing: cfg.validator === 'anthropic' && !cfg.anthropicKey ? ['ANTHROPIC_API_KEY'] : []
    },
    readRepairMedia: !!cfg.readRepairMedia,
    video: {
      provider: cfg.videoProvider, configured: videoConfigured(cfg), transcribe: cfg.transcribe,
      native: cfg.videoProvider === 'gemini', missing: videoConfigured(cfg) ? [] : missingFor(cfg.videoProvider)
    },
    ai: { mode: cfg.aiMode, configured: ai.isConfigured(), missing: ai.status().missing },
    budget: {
      maxAiItemsPerSync: cfg.maxAiItemsPerSync, maxGeminiCallsPerSync: cfg.maxGeminiCallsPerSync,
      maxClaudeCallsPerSync: cfg.maxClaudeCallsPerSync, maxVideoMinutesPerSync: cfg.maxVideoMinutesPerSync
    },
    limits: {
      maxItemsPerJob: cfg.maxItemsPerJob, maxFramesPerVideo: cfg.maxFramesPerVideo,
      maxAttempts: cfg.maxAttempts, dailyGraphCalls: cfg.dailyGraphCalls,
      dailyOcrCalls: cfg.dailyOcrCalls, dailyAiCalls: cfg.dailyAiCalls, dailyVideoCalls: cfg.dailyVideoCalls
    }
  };
}

module.exports = { load, status, graphConfigured, visionConfigured, videoConfigured };
