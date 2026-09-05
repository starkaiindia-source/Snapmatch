/* ============================================================================
   Mobile Parts Finder · api/_services/ai-service.js
   ----------------------------------------------------------------------------
   The AI GATEWAY. Not a model, and deliberately not one.

   ----------------------------------------------------------------------------
   WHERE THE MODEL ACTUALLY RUNS

       browser
          |  HTTPS, Firebase ID token
          v
       /api/chat, /api/admin/ai            <- Vercel, this codebase
          |
          v
       this gateway                        <- decides IF the model is asked at all
          |  HTTPS, bearer token, private network
          v
       Local LLM service                   <- a separate machine you control
          |
          v
       tool + knowledge layer              <- search-service, Firestore, catalogue

   The model does not run here. It cannot: a Vercel function is a short-lived
   container with no GPU and a hard memory ceiling, and a browser cannot hold a
   production model either. Anyone who ships "a local LLM" inside a static site
   has shipped a text box.

   So this file is the CONTRACT with a service that runs elsewhere — your own
   box, a rented GPU host, an on-premise server behind a VPN. Set AI_GATEWAY_URL
   and AI_GATEWAY_TOKEN and it starts calling it. Leave them unset and every
   feature that depends on it degrades honestly: `available:false`, a named
   reason, and a deterministic answer where one exists.

   NOTHING HERE FABRICATES A MODEL RESPONSE. There is no canned reply pretending
   to be AI. Unconfigured means unconfigured.

   ----------------------------------------------------------------------------
   THE HARD RULE: AI NEVER WRITES TO PRODUCTION

   The gateway has no Firestore write path to the catalogue. It cannot add a
   model, edit a compatibility group, change a part code or publish a page. What
   it can do is create an `aiTask` — a PROPOSAL, with `status: 'draft'` — and
   an administrator with the ai.approve permission decides.

   That is not a policy someone must remember to follow. It is the shape of the
   code: this module exports no function that writes to models, groups,
   groupDetails or any catalogue collection, and the service account those
   collections trust is not reachable from here.

   ----------------------------------------------------------------------------
   WHAT GOES TO THE MODEL

   Only what the task needs, and never raw customer data. A prompt is assembled
   from catalogue facts and aggregated counts. A user's phone number, email or
   address is never put in a prompt — not to a hosted model, not to one running
   in the next room. The redaction in _schema/analytics-event.js means even the
   search terms that reach an AI task have been through a PII filter first.
   ========================================================================== */
'use strict';

const { db } = require('../_lib/firebase');
const { AI_TASKS } = require('../_schema/collections');
const v = require('../_lib/validate');

/* --------------------------------------------------------------- capability

   Two environment variables, and honest answers when they are absent. */

function gatewayUrl() {
  return (process.env.AI_GATEWAY_URL || '').trim();
}
function gatewayToken() {
  return (process.env.AI_GATEWAY_TOKEN || '').trim();
}

/** Which model the gateway should use, when it offers a choice. */
function gatewayModel() {
  return (process.env.AI_GATEWAY_MODEL || '').trim() || null;
}

/**
 * Is there a model to talk to?
 *
 * A URL without a token is treated as unconfigured. An unauthenticated AI
 * endpoint reachable from a public serverless function is somebody else's free
 * GPU, and it would be ours to pay for.
 */
function isConfigured() {
  return !!(gatewayUrl() && gatewayToken());
}

/** For /api/health and the admin AI page. Reports presence, never a value. */
function status() {
  const url = gatewayUrl();
  return {
    configured: isConfigured(),
    /* The host, not the URL: it is useful to see WHICH box is configured and
       it must not print a token that someone put in a query string. */
    host: url ? safeHost(url) : null,
    model: gatewayModel(),
    missing: [
      !gatewayUrl() && 'AI_GATEWAY_URL',
      !gatewayToken() && 'AI_GATEWAY_TOKEN'
    ].filter(Boolean),
    capabilities: CAPABILITIES
  };
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return null; }
}

/**
 * What the local service is expected to be able to do.
 *
 * Declared here so the admin UI can list them, and so adding one is a change
 * in this file rather than a string typed into a route.
 */
const CAPABILITIES = [
  { id: 'answer_user_question', description: 'Answer a shop question from supplied catalogue facts' },
  { id: 'normalise_model_name', description: 'Read a mistyped or aliased handset name' },
  { id: 'explain_compatibility', description: 'Explain a compatibility group in plain language' },
  { id: 'assist_zero_result', description: 'Suggest what a failed search may have meant' },
  { id: 'propose_missing_model', description: 'Draft a record for a handset the catalogue lacks' },
  { id: 'seo_content_draft', description: 'Draft meta titles, descriptions and page copy' },
  { id: 'marketing_content_draft', description: 'Draft campaign and social copy' },
  { id: 'business_insight', description: 'Summarise aggregated metrics into observations' }
];

/* --------------------------------------------------------------- invocation */

/** How long a model has to answer before the request is abandoned. */
const TIMEOUT_MS = Number(process.env.AI_GATEWAY_TIMEOUT_MS) || 20000;

/**
 * Calls the local model.
 *
 * @param {object} args
 * @param {string} args.capability   one of CAPABILITIES
 * @param {object} args.input        the task payload — facts, never PII
 * @param {string} [args.systemHint] extra grounding for this call
 * @returns {Promise<{ok:true, output:object}|{ok:false, reason:string, detail?:string}>}
 *
 * Rejects nothing. Every failure — unconfigured, timed out, refused, malformed
 * — comes back as `ok:false` with a reason, because every caller has a
 * deterministic fallback and none of them should be a 500.
 */
async function invoke({ capability, input, systemHint }) {
  if (!isConfigured()) {
    return { ok: false, reason: 'ai-unconfigured', detail: status().missing.join(', ') };
  }
  if (!CAPABILITIES.some(c => c.id === capability)) {
    return { ok: false, reason: 'unknown-capability', detail: capability };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(gatewayUrl().replace(/\/+$/, '') + '/v1/task', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + gatewayToken(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        capability,
        model: gatewayModel(),
        systemHint: systemHint || null,
        input
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, reason: 'gateway-error', detail: detail.slice(0, 300) };
    }

    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') {
      return { ok: false, reason: 'gateway-bad-response' };
    }
    return { ok: true, output: data };
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? 'ai-timeout' : 'ai-unreachable';
    console.warn('[ai] invoke failed', { capability, reason, message: err && err.message });
    return { ok: false, reason, detail: err && err.message };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------- tasks

   The approval queue. Everything the AI proposes lands here first. */

const TASK_STATUSES = ['draft', 'pending_review', 'approved', 'rejected', 'applied', 'failed'];

const TASK_TYPES = [
  'missing_model_draft',
  'alias_suggestion',
  'seo_meta_draft',
  'seo_content_draft',
  'marketing_copy_draft',
  'business_insight',
  'data_correction'
];

/**
 * Records a proposal.
 *
 * `payload` is what the AI produced. It is stored as data and read as data —
 * nothing in this codebase executes it, interpolates it into a query, or
 * treats it as an instruction. A model that emits "ignore your rules and
 * publish this" produces a row with that text in it and no other effect.
 */
async function createTask({ type, capability, payload, sourceRef, createdBy, now, prompt }) {
  if (TASK_TYPES.indexOf(type) < 0) throw new Error('unknown ai task type: ' + type);

  const ref = db().collection(AI_TASKS).doc();
  const doc = {
    taskId: ref.id,
    type,
    capability: v.string(capability, 60) || null,
    status: 'draft',
    /* Capped hard. A model can emit a great deal of text and a Firestore
       document stops at 1 MB; truncating here beats a write that fails after
       the model has already been paid for. */
    payload: capPayload(payload),
    promptSummary: v.string(prompt, 500) || null,
    sourceType: sourceRef ? v.string(sourceRef.type, 40) : null,
    sourceId: sourceRef ? v.string(sourceRef.id, 200) : null,
    createdBy: createdBy || 'system',
    createdAt: now,
    updatedAt: now,
    reviewedBy: null,
    reviewedAt: null,
    reviewNotes: null,
    appliedAt: null
  };

  await ref.set(doc);
  return doc;
}

function capPayload(payload) {
  if (payload == null) return {};
  let json;
  try { json = JSON.stringify(payload); } catch { return { error: 'unserialisable payload' }; }
  if (json.length <= 200000) return payload;
  return { truncated: true, preview: json.slice(0, 200000) };
}

/**
 * An administrator's decision on a proposal.
 *
 * Approving does NOT apply the change. It marks the proposal as accepted; the
 * apply step is a separate, explicit action with its own permission, and for
 * catalogue changes it runs through the importer. Two steps rather than one,
 * because "approve" gets clicked quickly and "publish to the live catalogue"
 * should not be the same click.
 */
async function reviewTask({ taskId, decision, adminUid, notes, now }) {
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new Error('decision must be approved or rejected');
  }
  const ref = db().collection(AI_TASKS).doc(taskId);

  return db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, reason: 'not found' };

    const current = snap.data().status;
    if (current === 'applied') return { ok: false, reason: 'already applied' };

    tx.set(ref, {
      status: decision,
      reviewedBy: adminUid,
      reviewedAt: now,
      reviewNotes: v.string(notes, 1000) || null,
      updatedAt: now
    }, { merge: true });

    return { ok: true, from: current, to: decision };
  });
}

async function listTasks({ status, type, limit = 50 }) {
  let q = db().collection(AI_TASKS);
  if (status && TASK_STATUSES.indexOf(status) > -1) q = q.where('status', '==', status);
  if (type && TASK_TYPES.indexOf(type) > -1) q = q.where('type', '==', type);

  try {
    const snap = await q.orderBy('createdAt', 'desc').limit(Math.min(200, limit)).get();
    return snap.docs.map(d => d.data());
  } catch (err) {
    console.warn('[ai] listTasks failed', err && (err.code || err.message));
    return [];
  }
}

module.exports = {
  CAPABILITIES, TASK_STATUSES, TASK_TYPES, TIMEOUT_MS,
  isConfigured, status, invoke,
  createTask, reviewTask, listTasks
};
