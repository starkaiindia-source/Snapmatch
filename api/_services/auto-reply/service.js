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

   The one exception to waiting is the app link. Someone asking for the app gets the
   link at once, in review too: the owner wrote the words, no model is involved, and
   nothing in it can be wrong about a phone.

   Delivery is answered inline: Vercel freezes a function once it has responded, so
   work left for after the 200 may never run.

   READ AS WELL AS DELIVERED

   Meta delivers a stranger's comment or message only to an app with Advanced Access,
   which takes App Review. Until then poll() reads the account's recent comments and
   messages, which this app may do, and puts them through the same claim. An event
   carries the same id whichever way it came, so nothing is answered twice.
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
const OPEN = ['queued', 'working', 'draft', 'needs_human', 'failed'];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/* A delivery stops starting new events after this. What it leaves stays queued. */
const BUDGET_MS = 25000;
const MAX_PER_DELIVERY = 10;
const LIST_LIMIT = 50;
/* The first read looks back this far; every later one from where the last stopped. */
const FIRST_LOOKBACK_MS = 2 * HOUR_MS;
const READ_OVERLAP_MS = 2 * 60 * 1000;
const POLL_EVERY_MS = 60 * 1000;
const MEMORY = 3;

const DEFAULTS = {
  mode: 'review', comments: true, dms: true,
  brand: 'ProGlide', about: '', products: '', links: '',
  appLink: '', appLinkText: 'Here is the {brand} app: {link}', appLinkComment: 'Sent you the link in DM',
  tone: 'Friendly and short, like a helpful shop owner. No hashtags.',
  handoff: 'Our team will reply to you soon.',
  blocked: 'Mobile Parts Finder\nmobilepartsfinder\nSnapMatch',
  maxNames: 6, perSenderHour: 6, dailyReplies: 200, minConfidence: 0.7
};

const settingsRef = () => db().collection(C.AUTO_REPLY).doc('instagram');
const pollRef = () => db().collection(C.AUTO_REPLY).doc('instagram-poll');
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
    appLink: /^https:\/\/\S+$/.test(text(d.appLink, 300)) ? text(d.appLink, 300) : '',
    appLinkText: text(d.appLinkText, 300) || DEFAULTS.appLinkText,
    appLinkComment: text(d.appLinkComment, 200) || DEFAULTS.appLinkComment,
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
async function deliver(id, reply, by, c, send) {
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
    const sentId = send ? await send(meta, ev)
      : ev.kind === 'comment' ? await meta.replyToComment(ev.targetId, reply) : await meta.sendMessage(ev.senderId, reply);
    await finish(id, { status: 'sent', reply, sentId, sentAt: Date.now(), sentBy: by, error: null });
    return { ok: true };
  } catch (err) {
    await finish(id, { status: 'failed', reply, error: String(err.message).slice(0, 300), errorKind: err.kind || 'error' });
    return { ok: false, code: 'send-failed', message: err.message };
  }
}

function linkMessage(s) {
  const body = s.appLinkText.replace(/\{brand\}/g, s.brand);
  return body.indexOf('{link}') > -1 ? body.replace(/\{link\}/g, s.appLink) : body + ' ' + s.appLink;
}

/* A comment gets the link by message, with a word on the comment to say so. If the
   message cannot go, Meta allows one per person, the comment carries the link itself. */
async function sendLink(id, ev, s, c) {
  const message = linkMessage(s);
  await finish(id, { intent: 'app_link', reason: null });
  return deliver(id, message, 'app-link', c, async (meta, e) => {
    if (e.kind === 'dm') return meta.sendMessage(e.senderId, message);
    const messaged = await meta.privateReply(e.targetId, message).then(() => true, () => false);
    return meta.replyToComment(e.targetId, messaged ? s.appLinkComment : message);
  });
}

/** One claimed event, as far as the settings allow it to go. */
async function work(id, ev, settings, c, now) {
  if (settings.mode === 'off') return finish(id, { status: 'skipped', reason: 'auto-reply-off' });
  if (!(ev.kind === 'comment' ? settings.comments : settings.dms)) return finish(id, { status: 'skipped', reason: 'channel-off' });
  if (!ev.text) return finish(id, { status: 'needs_human', reason: 'no-text' });

  const sender = await consume({ key: 'auto-reply:' + ev.senderId, limit: settings.perSenderHour, now, windowMs: HOUR_MS });
  if (!sender.allowed) return finish(id, { status: 'skipped', reason: 'sender-limit' });
  if (settings.appLink && responder.asksForApp(ev.text)) return sendLink(id, ev, settings, c);
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

  const settings = await loadSettings();
  const list = events.parse(payload).filter(ev => ev.senderId !== c.igUserId).slice(0, MAX_PER_DELIVERY);
  await handle(list, settings, c, Date.now());
  return { status: 200, body: { received: true } };
}

/** Takes each event once and answers it, until the time runs out. */
async function handle(list, settings, c, started) {
  let done = 0;
  for (const ev of list) {
    const now = Date.now();
    if (!(await claim(ev, now)) || now - started > BUDGET_MS) continue;
    done++;
    /* a failure on one event must not stop the others */
    await work(ev.id, Object.assign({}, ev, { text: redact(ev.text).slice(0, 1000) }), settings, c, now)
      .catch(err => finish(ev.id, { status: 'failed', error: String(err.message).slice(0, 300), errorKind: 'error' }));
  }
  return done;
}

/* An event claimed but cut short by the time limit, or left working by a run that
   stopped. Taken in a transaction, so a read and a press of Try again cannot both
   answer it, and a working one only once it has been still for a while. */
const STALE_MS = 2 * 60 * 1000;
const waiting = (e, now) => e.status === 'queued' || (e.status === 'working' && now - (e.updatedAt || e.at || 0) > STALE_MS);

async function takeQueued(id) {
  const ref = eventCol().doc(id);
  return db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    const now = Date.now();
    if (!snap.exists || !waiting(snap.data(), now)) return null;
    tx.update(ref, { status: 'working', updatedAt: now });
    return snap.data();
  });
}

async function catchUp(settings, c, started) {
  const snap = await eventCol().where('status', 'in', ['queued', 'working']).limit(MAX_PER_DELIVERY).get();
  let done = 0;
  for (const doc of snap.docs) {
    if (Date.now() - started > BUDGET_MS) break;
    const ev = await takeQueued(doc.id);
    if (!ev) continue;
    done++;
    await work(doc.id, ev, settings, c, Date.now())
      .catch(err => finish(doc.id, { status: 'failed', error: String(err.message).slice(0, 300), errorKind: 'error' }));
  }
  return done;
}

/**
 * Reads what arrived since the last read and answers it. Anyone may ask for this, so
 * it runs at most once a minute whoever asks, and it can only answer the account's
 * own comments and messages.
 */
async function poll() {
  const c = credentials();
  if (!c.token) return { status: 503, body: { error: 'not configured' } };
  const now = Date.now();
  const gate = await consume({ key: 'auto-reply:poll', limit: 1, now, windowMs: POLL_EVERY_MS });
  if (!gate.allowed) return { status: 200, body: { polled: false, reason: 'too soon' } };

  const settings = await loadSettings();
  if (settings.mode === 'off') return { status: 200, body: { polled: false, reason: 'off' } };
  const last = await pollRef().get();
  const since = last.exists && last.data().readAt ? last.data().readAt - READ_OVERLAP_MS : now - FIRST_LOOKBACK_MS;
  const meta = metaClient(c);
  const read = await meta.recent(since);
  const me = await meta.username().catch(() => '');
  const list = events.fromRead(read, c.igUserId, String(me).toLowerCase());
  const answered = await handle(list, settings, c, now) + await catchUp(settings, c, now);
  await pollRef().set({ readAt: now, found: list.length, answered });
  return { status: 200, body: { polled: true, found: list.length, answered } };
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
  if (settings.appLink && responder.asksForApp(said)) {
    return { ok: true, reply: linkMessage(settings), intent: 'app_link', confidence: 1, shouldReply: true, hold: null, instant: true };
  }
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
  if (ev.status !== 'failed' && !waiting(ev, Date.now())) return { ok: false, code: 'not-open' };
  await work(id, ev, await loadSettings(), credentials(), Date.now());
  return { ok: true };
}

module.exports = {
  DEFAULTS, MODES, handshake, verifyToken, receive, poll, loadSettings, saveSettings, overview, liveCheck, subscribe,
  tryReply, sendDraft, discard, retry, GraphError
};
