/* ============================================================================
   Mobile Parts Finder · api/_services/auto-reply/service.js
   ----------------------------------------------------------------------------
   Auto Reply for the owner's Instagram account: what happens to a comment or a
   message from the moment Meta delivers it.

     delivery  ->  signature  ->  claimed once  ->  limits  ->  draft  ->  guard
                                                                  |
                     review: waits on the admin page              |
                     auto:   sent, unless guard or the model says a person should

   ONE ACCOUNT, THE OWNER'S

   This is not a feature of the site. There is no customer of this site on it, no
   per-shop setting, and it reads and writes nothing of any shop or user. What
   leaves here is written in the brand set on the admin page, on that account.

   EVERY EVENT IS CLAIMED BEFORE IT IS ANSWERED

   Meta delivers again until it gets a 200, sometimes for hours, and two deliveries
   can overlap. A second public reply to one comment is the visible failure of that,
   so the claim is a transaction on a document named after the event, made before
   anything is spent. A delivery that finds the document stops there. An event cut
   short by the function's time limit stays `queued`, and the admin page can run it
   again. It is never run again by a repeat delivery.

   IT STARTS IN REVIEW

   `review` writes the reply and waits for a person. `auto` is a choice the owner
   makes on the page, after reading some. Off means nothing is spent at all.

   Delivery is answered inline: Vercel freezes a function once it has responded, so
   work left for after the 200 may never run.
   ========================================================================== */
'use strict';

const crypto = require('crypto');
const { db } = require('../../_lib/firebase');
const C = require('../../_schema/collections');
const { consume } = require('../../_lib/rate-limit');
const { verifyWebhookSignature } = require('../../_lib/razorpay-signature');
const { redact } = require('../../_schema/analytics-event');
const configMod = require('../instagram/config');
const { createGemini, estimateCost } = require('../instagram/ai-providers');
const { GraphError } = require('../instagram/graph-client');
const { createMetaClient, SCOPES, FIELDS } = require('./meta');
const events = require('./events');
const responder = require('./responder');

const WEBHOOK_URL = 'https://www.mobilepartsfinder.com/api/instagram-webhook';
const MODES = ['off', 'review', 'auto'];
const OPEN = ['queued', 'draft', 'needs_human', 'failed'];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/* A delivery stops starting new events after this. What it leaves stays queued. */
const BUDGET_MS = 25000;
const MAX_PER_DELIVERY = 10;
const LIST_LIMIT = 50;
const MEMORY = 3;

const DEFAULTS = {
  mode: 'review', comments: true, dms: true,
  brand: 'ProGlide', about: '', products: '', links: '',
  tone: 'Friendly and short, like a helpful shop owner. No hashtags.',
  handoff: 'Our team will reply to you soon.',
  blocked: 'Mobile Parts Finder\nmobilepartsfinder\nSnapMatch',
  maxNames: 6, perSenderHour: 6, dailyReplies: 200, minConfidence: 0.7
};

const settingsRef = () => db().collection(C.AUTO_REPLY).doc('instagram');
const eventCol = () => db().collection(C.AUTO_REPLY_EVENTS);
const num = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function env(name) {
  return (process.env[name] || '').trim();
}

/** Everything this needs from the environment. A separate token is optional. */
function credentials() {
  const cfg = configMod.load();
  return {
    token: env('INSTAGRAM_REPLY_ACCESS_TOKEN') || cfg.graph.token,
    igUserId: env('INSTAGRAM_REPLY_ACCOUNT_ID') || cfg.graph.igUserId,
    secrets: [env('INSTAGRAM_REPLY_APP_SECRET'), cfg.graph.appSecret].filter(Boolean),
    version: cfg.graph.version,
    geminiKey: cfg.geminiKey,
    model: env('AUTO_REPLY_MODEL') || cfg.geminiScreenModel,
    prices: cfg.prices
  };
}

function metaClient(c) {
  return createMetaClient({ token: c.token, igUserId: c.igUserId, appSecret: c.secrets[c.secrets.length - 1], version: c.version });
}

/* --------------------------------------------------------------- settings */
function normalise(s) {
  const d = Object.assign({}, DEFAULTS, s || {});
  return {
    mode: MODES.indexOf(d.mode) > -1 ? d.mode : DEFAULTS.mode,
    comments: d.comments !== false, dms: d.dms !== false,
    brand: text(d.brand, 60), about: text(d.about, 2000), products: text(d.products, 4000), links: text(d.links, 600),
    tone: text(d.tone, 300), handoff: text(d.handoff, 200) || DEFAULTS.handoff, blocked: text(d.blocked, 600),
    maxNames: num(d.maxNames, 0, 20, DEFAULTS.maxNames),
    perSenderHour: num(d.perSenderHour, 1, 60, DEFAULTS.perSenderHour),
    dailyReplies: num(d.dailyReplies, 1, 2000, DEFAULTS.dailyReplies),
    minConfidence: num(d.minConfidence, 0, 1, DEFAULTS.minConfidence)
  };
}

async function loadSettings() {
  const snap = await settingsRef().get();
  return normalise(snap.exists ? snap.data() : null);
}

async function saveSettings(input, by) {
  const next = normalise(Object.assign(await loadSettings(), input));
  await settingsRef().set(Object.assign({}, next, { updatedAt: Date.now(), updatedBy: by || null }));
  return next;
}

/* -------------------------------------------------------------- handshake */
/** The word Meta must send back. Worked out from the app secret, so nothing new is stored. */
function verifyToken(c) {
  const secret = (c || credentials()).secrets[0];
  return secret ? crypto.createHmac('sha256', secret).update('mpf-auto-reply-webhook').digest('hex').slice(0, 40) : null;
}

/** @returns {string|null} the challenge to echo, or null to refuse */
function handshake(params) {
  const expected = verifyToken();
  const given = String(params.get('hub.verify_token') || '');
  const challenge = String(params.get('hub.challenge') || '');
  if (!expected || params.get('hub.mode') !== 'subscribe' || !/^\d{1,40}$/.test(challenge)) return null;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? challenge : null;
}

function signed(rawBody, header, secrets) {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header || ''));
  return !!m && secrets.some(secret => verifyWebhookSignature({ rawBody, signature: m[1], secret }));
}

/* -------------------------------------------------------------- the pipe */
async function claim(ev, now) {
  const ref = eventCol().doc(ev.id);
  return db().runTransaction(async tx => {
    if ((await tx.get(ref)).exists) return false;
    tx.set(ref, {
      kind: ev.kind, targetId: ev.targetId, senderId: ev.senderId, username: ev.username, mediaId: ev.mediaId, parentId: ev.parentId,
      text: redact(ev.text).slice(0, 1000), status: 'queued', at: now
    });
    return true;
  });
}

const finish = (id, fields) => eventCol().doc(id).set(Object.assign({ updatedAt: Date.now() }, fields), { merge: true });

/** What was said in this conversation lately, for "and the price?". */
async function earlier(senderId, skipId) {
  const snap = await eventCol().where('senderId', '==', senderId).get();
  return snap.docs.filter(d => d.id !== skipId && d.data().kind === 'dm').map(d => d.data())
    .sort((a, b) => b.at - a.at).slice(0, MEMORY).reverse()
    .reduce((out, e) => out.concat('Customer: ' + e.text, e.status === 'sent' ? 'Shop: ' + e.reply : []), []);
}

function cost(c, r) {
  return r.usage ? estimateCost(r.model, r.usage, c.prices) : null;
}

/** Sends a reply already decided on, once. */
async function deliver(id, reply, by, c) {
  const ref = eventCol().doc(id);
  const ev = await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists || OPEN.indexOf(snap.data().status) < 0) return null;
    tx.update(ref, { status: 'sending' });
    return snap.data();
  });
  if (!ev) return { ok: false, code: 'not-open' };
  const meta = metaClient(c);
  try {
    const sentId = ev.kind === 'comment' ? await meta.replyToComment(ev.targetId, reply) : await meta.sendMessage(ev.senderId, reply);
    await finish(id, { status: 'sent', reply, sentId, sentAt: Date.now(), sentBy: by, error: null });
    return { ok: true };
  } catch (err) {
    await finish(id, { status: 'failed', reply, error: String(err.message).slice(0, 300), errorKind: err.kind || 'error' });
    return { ok: false, code: 'send-failed', message: err.message };
  }
}

/** One claimed event, as far as the settings allow it to go. */
async function work(id, ev, settings, c, now) {
  if (settings.mode === 'off') return finish(id, { status: 'skipped', reason: 'auto-reply-off' });
  if (!(ev.kind === 'comment' ? settings.comments : settings.dms)) return finish(id, { status: 'skipped', reason: 'channel-off' });
  if (!ev.text) return finish(id, { status: 'needs_human', reason: 'no-text' });

  const sender = await consume({ key: 'auto-reply:' + ev.senderId, limit: settings.perSenderHour, now, windowMs: HOUR_MS });
  if (!sender.allowed) return finish(id, { status: 'skipped', reason: 'sender-limit' });
  const day = await consume({ key: 'auto-reply:day', limit: settings.dailyReplies, now, windowMs: DAY_MS });
  if (!day.allowed) return finish(id, { status: 'skipped', reason: 'daily-limit' });

  const caption = ev.mediaId ? await metaClient(c).caption(ev.mediaId).catch(() => '') : '';
  const history = ev.kind === 'dm' ? await earlier(ev.senderId, id) : [];
  const gemini = createGemini({ key: c.geminiKey });
  const d = await responder.draft({ text: ev.text, kind: ev.kind, settings, gemini, model: c.model, caption, history });
  if (!d.ok) return finish(id, { status: 'failed', error: d.reason, errorKind: d.kind });

  const fields = {
    reply: d.reply, intent: d.intent, confidence: d.confidence, phones: d.phones, facts: d.facts, needsHuman: d.needsHuman,
    model: d.model, costMicroUsd: cost(c, d)
  };
  if (!d.shouldReply) return finish(id, Object.assign(fields, { status: 'ignored' }));

  const person = responder.hold(d, ev.kind, settings);
  if (person) return finish(id, Object.assign(fields, { status: 'needs_human', reason: person }));
  if (settings.mode === 'review') return finish(id, Object.assign(fields, { status: 'draft', reason: null }));

  await finish(id, Object.assign(fields, { status: 'draft', reason: null }));
  return deliver(id, d.reply, 'auto', c);
}

/**
 * One delivery from Meta.
 * @returns {Promise<{status:number, body:object}>}
 */
async function receive(rawBody, signature) {
  const c = credentials();
  if (!c.secrets.length) return { status: 503, body: { error: 'not configured' } };
  if (!signed(rawBody, signature, c.secrets)) return { status: 403, body: { error: 'invalid signature' } };
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); }
  catch (err) { return { status: 400, body: { error: 'invalid json' } }; }

  const started = Date.now();
  const settings = await loadSettings();
  const list = events.parse(payload).filter(ev => ev.senderId !== c.igUserId).slice(0, MAX_PER_DELIVERY);
  for (const ev of list) {
    const now = Date.now();
    if (!(await claim(ev, now)) || now - started > BUDGET_MS) continue;
    /* a failure on one event must not make Meta deliver the others again */
    await work(ev.id, Object.assign({}, ev, { text: redact(ev.text).slice(0, 1000) }), settings, c, now)
      .catch(err => finish(ev.id, { status: 'failed', error: String(err.message).slice(0, 300), errorKind: 'error' }));
  }
  return { status: 200, body: { received: true } };
}

/* ------------------------------------------------------------ admin page */
function connection() {
  const c = credentials();
  return {
    webhookUrl: WEBHOOK_URL, verifyToken: verifyToken(c), fields: FIELDS.split(','),
    token: !!c.token, separateToken: !!env('INSTAGRAM_REPLY_ACCESS_TOKEN'), account: !!c.igUserId,
    appSecret: c.secrets.length > 0, gemini: !!c.geminiKey, model: c.model
  };
}

async function listEvents() {
  const snap = await eventCol().orderBy('at', 'desc').limit(LIST_LIMIT).get();
  return snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
}

async function overview() {
  const [settings, list] = await Promise.all([loadSettings(), listEvents()]);
  return { settings, connection: connection(), events: list, scopes: SCOPES };
}

async function liveCheck() {
  const c = credentials();
  if (!c.token) return { errors: [{ step: 'token', kind: 'unconfigured', message: 'No Instagram access token is set.' }] };
  return metaClient(c).check();
}

/** Points the app's webhook here, then starts this account's events. */
async function subscribe() {
  const c = credentials();
  const meta = metaClient(c);
  const k = await meta.check();
  const appId = k.token && k.token.appId;
  if (appId && c.secrets.length) await meta.connectWebhook({ appId, callbackUrl: WEBHOOK_URL, verifyToken: verifyToken(c) });
  return meta.subscribe();
}

/** What would be said to this message. Nothing is stored or sent. */
async function tryReply({ text: said, kind, caption }) {
  const c = credentials();
  const settings = await loadSettings();
  const k = kind === 'dm' ? 'dm' : 'comment';
  const d = await responder.draft({ text: said, kind: k, settings, gemini: createGemini({ key: c.geminiKey }), model: c.model, caption: text(caption, 2000) });
  if (!d.ok) return d;
  return Object.assign({}, d, { hold: responder.hold(d, k, settings), costMicroUsd: cost(c, d), usage: undefined });
}

async function sendDraft(id, reply, by) {
  const c = credentials();
  const snap = await eventCol().doc(id).get();
  if (!snap.exists) return { ok: false, code: 'missing' };
  const settings = await loadSettings();
  const body = text(reply, 2000) || snap.data().reply || '';
  const blocked = responder.guard(body, snap.data().kind, settings);
  if (blocked) return { ok: false, code: blocked };
  return deliver(id, body, by, c);
}

async function discard(id) {
  const ref = eventCol().doc(id);
  return db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists || OPEN.indexOf(snap.data().status) < 0) return false;
    tx.update(ref, { status: 'discarded', updatedAt: Date.now() });
    return true;
  });
}

/** An event that was cut short, or that failed, gets one more go by hand. */
async function retry(id) {
  const snap = await eventCol().doc(id).get();
  if (!snap.exists) return { ok: false, code: 'missing' };
  const ev = snap.data();
  if (['queued', 'failed'].indexOf(ev.status) < 0) return { ok: false, code: 'not-open' };
  await work(id, ev, await loadSettings(), credentials(), Date.now());
  return { ok: true };
}

module.exports = {
  DEFAULTS, MODES, handshake, verifyToken, receive, loadSettings, saveSettings, overview, liveCheck, subscribe,
  tryReply, sendDraft, discard, retry, GraphError
};
