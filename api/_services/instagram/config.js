/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/config.js
   ----------------------------------------------------------------------------
   Every knob of the importer, read from the environment in one place, with
   the ceiling each one is clamped to. Cost control lives here: a limit that
   can be set to "unlimited" by a typo in the dashboard is not a limit.

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

function load() {
  const ocrProvider = (() => {
    const v = env('INSTAGRAM_OCR_PROVIDER').toLowerCase();
    if (['gateway', 'google_vision', 'none'].indexOf(v) > -1) return v;
    /* Default: the AI gateway when there is one, otherwise none. Never a
       guess at a provider that has no credentials. */
    return ai.isConfigured() ? 'gateway' : 'none';
  })();

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
    videoProvider: ai.isConfigured() && env('INSTAGRAM_VIDEO_PROVIDER').toLowerCase() !== 'none' ? 'gateway' : 'none',
    transcribe: env('INSTAGRAM_TRANSCRIBE').toLowerCase() !== 'false',
    aiMode: ['off', 'fallback', 'always'].indexOf(env('INSTAGRAM_AI_MODE').toLowerCase()) > -1
      ? env('INSTAGRAM_AI_MODE').toLowerCase() : 'fallback',

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

/** For the admin page: what is switched on, what is missing, and the limits. */
function status(cfg = load()) {
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
    video: { provider: cfg.videoProvider, configured: cfg.videoProvider === 'gateway', transcribe: cfg.transcribe },
    ai: { mode: cfg.aiMode, configured: ai.isConfigured(), missing: ai.status().missing },
    limits: {
      maxItemsPerJob: cfg.maxItemsPerJob, maxFramesPerVideo: cfg.maxFramesPerVideo,
      maxAttempts: cfg.maxAttempts, dailyGraphCalls: cfg.dailyGraphCalls,
      dailyOcrCalls: cfg.dailyOcrCalls, dailyAiCalls: cfg.dailyAiCalls, dailyVideoCalls: cfg.dailyVideoCalls
    }
  };
}

module.exports = { load, status, graphConfigured };
