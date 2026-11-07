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
const { waitUntil } = require('@vercel/functions');
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
const sales = require('./sales');
const feedback = require('./feedback');
const inbox = require('./inbox');
const shop = require('../shop-service');

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
/* Between the minute's reads, messages are read again this often, so a chat moves
   at the pace of a chat. Only on Vercel, where the function may outlive its answer. */
const QUICK_READ_MS = 15 * 1000;
/* Follow-ups are due in hours, and each check reads every open lead and every
   person waiting for the feedback question, so they run every ten minutes, not
   with every read. Run every minute they were most of the project's daily
   Firestore reads, and Spark stops at 50,000. */
const TICK_EVERY_MS = 10 * 60 * 1000;
/* a read that cannot finish (Firestore over quota retries for minutes) gives up */
const READ_LIMIT_MS = 25 * 1000;
const QUICK_READS = 3;
/* someone who wrote this recently may still be typing: their messages wait a moment
   and are answered together */
const SETTLE_MS = 8 * 1000;
const MEMORY = 3;

const DEFAULTS = {
  mode: 'review', comments: true, dms: true,
  brand: 'ProGlide', about: '', products: '', links: '',
  appLink: '', appLinkComment: 'Sent you the link in DM 📩',
  appLinkText: '🔥 {brand}: made for mobile shop owners\n\n✅ Find which models take the same tempered glass in seconds\n✅ Back covers, displays and more: every compatible model in one place\n✅ No more guessing at the counter\n\n👇 Tap the button below to download',
  appCardTitle: '{brand}: compatible parts finder', appCardSubtitle: 'Find the same glass, cover and parts for any phone',
  appButton: 'Download the app', appImage: '',
  appKeywords: 'proglide\npro glide\nproglite\nporglide\napp\naap\ntool\nlink\nwebsite\nwebsite link',
  iosLink: 'https://www.mobilepartsfinder.com', iosText: '📱 {brand} is on Android (Play Store) for now.\n\n🍏 On iPhone, use Mobile Parts Finder in your browser: compatible glass, covers and parts for any phone model.\n\n👇 Tap the button below',
  iosCardTitle: 'Mobile Parts Finder', iosCardSubtitle: 'Compatible parts for any phone, in your browser', iosButton: 'Open website',
  salesOn: true, salesKeywords: '9h\n9 h\n9h temper\n9h price\nprice\nrate',
  salesPriceText: '🔥 {brand} 9H Flexible Fiber + Ceramic Coated Temper\n\n📦 1 box = {pieces} pieces of one model → {box} (just {piece} a piece)\n🛒 Wholesale only: minimum {min} boxes ({minTotal})\n🚚 Courier: {homeState} {home} · South India {near} · Other states {far}\n💡 One master glass fits many models, so one box covers several phones.\n\n👉 Send your phone models and how many boxes of each, for example: Realme 5 - 2 boxes',
  salesComment: 'Sent you the price in DM 📩', salesThanks: '✅ Payment received! Thank you. Your order will be dispatched soon. 🚚',
  feedbackOn: true, feedbackAsk: '👋 Hi! Quick question: is {brand} useful for your shop?',
  feedbackYes: '🙏 Thank you! Could you rate {brand} ⭐⭐⭐⭐⭐ on the Play Store? It takes a minute and helps other shop owners find it.',
  feedbackNo: '🙏 Thanks for telling us. What should we make better? Reply here, we read every message.',
  feedbackButton: 'Rate on Play Store',
  salesVariants: '✨ Clear: available · 🌫️ Matte: out of stock\n💰 Clear and Matte are the same price',
  salesWhatsApp: '919894301600',
  boxPrice: 299, boxPieces: 10, minBoxes: 4, homeState: 'Tamil Nadu',
  courierHome: 60, courierNear: 100, courierFar: 200, nearStates: 'Kerala, Karnataka, Andhra Pradesh, Telangana, Puducherry',
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
    appLinkText: text(d.appLinkText, 600) || DEFAULTS.appLinkText,
    appLinkComment: text(d.appLinkComment, 200) || DEFAULTS.appLinkComment,
    appCardTitle: text(d.appCardTitle, 80) || DEFAULTS.appCardTitle,
    appCardSubtitle: text(d.appCardSubtitle, 80) || DEFAULTS.appCardSubtitle,
    appButton: text(d.appButton, 20) || DEFAULTS.appButton,
    appImage: /^https:\/\/\S+$/.test(text(d.appImage, 400)) ? text(d.appImage, 400) : '',
    appKeywords: text(d.appKeywords, 600),
    iosLink: /^https:\/\/\S+$/.test(text(d.iosLink, 300)) ? text(d.iosLink, 300) : '',
    iosText: text(d.iosText, 600) || DEFAULTS.iosText, iosCardTitle: text(d.iosCardTitle, 80) || DEFAULTS.iosCardTitle,
    iosCardSubtitle: text(d.iosCardSubtitle, 80) || DEFAULTS.iosCardSubtitle, iosButton: text(d.iosButton, 20) || DEFAULTS.iosButton,
    salesOn: d.salesOn !== false, salesKeywords: text(d.salesKeywords, 600),
    salesPriceText: text(d.salesPriceText, 900) || DEFAULTS.salesPriceText,
    salesComment: text(d.salesComment, 200) || DEFAULTS.salesComment, salesThanks: text(d.salesThanks, 300) || DEFAULTS.salesThanks,
    feedbackOn: d.feedbackOn !== false, feedbackAsk: text(d.feedbackAsk, 300) || DEFAULTS.feedbackAsk,
    feedbackYes: text(d.feedbackYes, 400) || DEFAULTS.feedbackYes, feedbackNo: text(d.feedbackNo, 300) || DEFAULTS.feedbackNo,
    feedbackButton: text(d.feedbackButton, 20) || DEFAULTS.feedbackButton,
    salesVariants: typeof d.salesVariants === 'string' ? text(d.salesVariants, 300) : DEFAULTS.salesVariants,
    salesWhatsApp: /^\d{10,13}$/.test(String(d.salesWhatsApp || '')) ? String(d.salesWhatsApp) : DEFAULTS.salesWhatsApp,
    boxPrice: num(d.boxPrice, 1, 100000, DEFAULTS.boxPrice), boxPieces: num(d.boxPieces, 1, 1000, DEFAULTS.boxPieces),
    minBoxes: num(d.minBoxes, 1, 1000, DEFAULTS.minBoxes), homeState: text(d.homeState, 40) || DEFAULTS.homeState,
    courierHome: num(d.courierHome, 0, 10000, DEFAULTS.courierHome), courierNear: num(d.courierNear, 0, 10000, DEFAULTS.courierNear),
    courierFar: num(d.courierFar, 0, 10000, DEFAULTS.courierFar), nearStates: text(d.nearStates, 300),
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

const brandIn = (value, s) => value.replace(/\{brand\}/g, s.brand);

/** The words before the button. The button carries the link. */
function linkIntro(s) {
  return brandIn(s.appLinkText, s).replace(/\{link\}/g, '').trim();
}

/** The same words with the link typed in, for wherever a button cannot go. */
function linkMessage(s) {
  return linkIntro(s) + '\n\n' + s.appLink;
}

function linkCard(s) {
  return Object.assign({ title: brandIn(s.appCardTitle, s).slice(0, 80), subtitle: brandIn(s.appCardSubtitle, s).slice(0, 80) },
    s.appImage ? { image_url: s.appImage } : {},
    { default_action: { type: 'web_url', url: s.appLink }, buttons: [{ type: 'web_url', url: s.appLink, title: s.appButton.slice(0, 20) }] });
}

/* One link a day is enough for one person, however often they ask. */
async function linkSentLately(senderId, skipId, now) {
  const snap = await eventCol().where('senderId', '==', senderId).get();
  return snap.docs.some(d => d.id !== skipId && d.data().intent === 'app_link' && d.data().status === 'sent' &&
    now - (d.data().sentAt || 0) < DAY_MS);
}

/* A message gets the words, then a card with a button. A comment gets the card by
   private reply, since a link in a comment cannot be tapped, and a word on the
   comment. Meta allows one private reply per person, so it is a single message. If
   a card is refused, the link goes as text; if no message can go, on the comment. */
async function sendLink(id, ev, s, c) {
  const plain = linkMessage(s);
  if (await linkSentLately(ev.senderId, id, Date.now())) return finish(id, { status: 'skipped', intent: 'app_link', reason: 'link-already-sent' });
  await finish(id, { intent: 'app_link', reason: null });
  return deliver(id, plain, 'app-link', c, async (meta, e) => {
    if (e.kind === 'dm') {
      await meta.sendMessage(e.senderId, linkIntro(s));
      const sent = await meta.sendCard(e.senderId, linkCard(s)).catch(() => meta.sendMessage(e.senderId, s.appLink));
      if (s.feedbackOn) await feedback.linkSent(ev, Date.now()).catch(() => null);
      return sent;
    }
    const messaged = await meta.privateCard(e.targetId, linkCard(s))
      .catch(() => meta.privateReply(e.targetId, plain)).then(() => true, () => false);
    return meta.replyToComment(e.targetId, messaged ? s.appLinkComment : plain);
  });
}

/* The answer to "is it useful?": a yes gets the rating link, a no is asked what to
   make better, and the owner sees it on the Auto Reply page. */
async function sendFeedbackReply(id, said, s, c) {
  const words = brandIn(said === 'yes' ? s.feedbackYes : s.feedbackNo, s);
  await finish(id, { intent: 'feedback', reason: null, feedback: said });
  return deliver(id, words, 'feedback', c, async (meta, e) => {
    const sent = await meta.sendMessage(e.senderId, words);
    if (said === 'yes' && s.appLink) {
      await meta.sendCard(e.senderId, { title: brandIn('Rate {brand} ⭐', s).slice(0, 80), subtitle: 'Google Play Store',
        default_action: { type: 'web_url', url: s.appLink }, buttons: [{ type: 'web_url', url: s.appLink, title: s.feedbackButton }] })
        .catch(() => meta.sendMessage(e.senderId, s.appLink));
    }
    return sent;
  });
}

function iosCard(s) {
  return { title: s.iosCardTitle, subtitle: s.iosCardSubtitle, default_action: { type: 'web_url', url: s.iosLink },
    buttons: [{ type: 'web_url', url: s.iosLink, title: s.iosButton }] };
}

/* The same as the app link, for someone on an iPhone: the app is Android only. */
async function sendIos(id, ev, s, c) {
  const intro = brandIn(s.iosText, s);
  if (await linkSentLately(ev.senderId, id, Date.now())) return finish(id, { status: 'skipped', intent: 'app_link', reason: 'link-already-sent' });
  await finish(id, { intent: 'app_link', reason: null });
  return deliver(id, intro, 'app-link', c, async (meta, e) => {
    if (e.kind === 'dm') {
      await meta.sendMessage(e.senderId, intro);
      return meta.sendCard(e.senderId, iosCard(s)).catch(() => meta.sendMessage(e.senderId, s.iosLink));
    }
    const messaged = await meta.privateCard(e.targetId, iosCard(s))
      .catch(() => meta.privateReply(e.targetId, intro + '\n\n' + s.iosLink)).then(() => true, () => false);
    return meta.replyToComment(e.targetId, messaged ? s.appLinkComment : intro + ' ' + s.iosLink);
  });
}

/* A step of a sale. The words are the sale's own, so they go at once, like the link. */
async function sellStep(id, ev, s, c, now) {
  let out;
  try {
    out = await sales.step(ev, s, createGemini({ key: c.geminiKey }), c.model, now);
  } catch (err) {
    console.warn('[auto-reply] sale step failed', err.code || err.message);
    return finish(id, { status: 'failed', intent: 'sale', error: String(err.code || err.message).slice(0, 200), errorKind: 'error' });
  }
  if (!out) return null;
  await sales.saveLead(ev.senderId, out.lead);
  if (!out.reply) return finish(id, { status: 'needs_human', intent: 'sale', reason: 'needs-human' });
  await finish(id, { intent: 'sale', reason: null });
  return deliver(id, out.reply, 'sales', c, async (meta, e) => {
    if (e.kind === 'comment') {
      const messaged = await meta.privateReply(e.targetId, out.reply).then(() => true, () => false);
      return meta.replyToComment(e.targetId, messaged ? s.salesComment : out.reply.slice(0, 2000));
    }
    const sent = out.quick
      ? await meta.sendQuick(e.senderId, out.reply, out.quick).catch(() => meta.sendMessage(e.senderId, out.reply))
      : await meta.sendMessage(e.senderId, out.reply);
    for (const extra of out.more || []) await meta.sendMessage(e.senderId, extra);
    if (out.image) await meta.sendImage(e.senderId, out.image).catch(() => null);
    /* the bill card, with the QR as its picture; refused, the picture alone, then the page */
    if (out.card) {
      await meta.sendCard(e.senderId, out.card).catch(async () => {
        if (out.card.image_url) await meta.sendImage(e.senderId, out.card.image_url).catch(() => null);
        const { image_url: _drop, ...plain } = out.card;
        return meta.sendCard(e.senderId, plain).catch(() => meta.sendMessage(e.senderId, out.lead.invoiceUrl));
      });
    }
    return sent;
  });
}

/** Follow-ups and paid bills, on every read. A failure here never stops replies. */
async function salesTick(s, c, now) {
  if (!s.salesOn) return 0;
  const meta = metaClient(c);
  let sent = 0;
  try {
    const dueNow = await sales.dueFollowUps(now);
    const quiet = dueNow.length ? await inbox.pausedIds(db, 'instagram').catch(() => new Set()) : new Set();
    for (const due of dueNow.filter(d => !quiet.has(String(d.lead.senderId)))) {
      if (Date.now() - now > BUDGET_MS) break;
      if (await meta.sendMessage(due.lead.senderId, due.text).then(() => true, () => false)) {
        await sales.markFollowedUp(due.lead, due.text, now);
        sent++;
      }
    }
    for (const lead of await sales.settlePaid(now)) {
      if (now - lead.lastCustomerAt < 23 * HOUR_MS) await meta.sendMessage(lead.senderId, sales.paidMessage(lead, s)).catch(() => null);
    }
  } catch (err) {
    console.warn('[auto-reply] sales tick failed', err.code || err.message);
  }
  return sent;
}

/* The day-after question to people who were sent the app link. */
async function feedbackTick(s, c, now) {
  if (!s.feedbackOn || !s.appLink) return 0;
  const meta = metaClient(c);
  let asked = 0;
  try {
    for (const d of await feedback.due(now)) {
      if (Date.now() - now > BUDGET_MS) break;
      const ok = await meta.sendQuick(d.senderId, brandIn(s.feedbackAsk, s), feedback.ANSWERS).then(() => true, () => false);
      if (ok) { await feedback.asked(d.senderId, now); asked++; }
    }
  } catch (err) {
    console.warn('[auto-reply] feedback tick failed', err.code || err.message);
  }
  return asked;
}

/** One claimed event, as far as the settings allow it to go. */
async function work(id, ev, settings, c, now) {
  if (settings.mode === 'off') return finish(id, { status: 'skipped', reason: 'auto-reply-off' });
  if (!(ev.kind === 'comment' ? settings.comments : settings.dms)) return finish(id, { status: 'skipped', reason: 'channel-off' });
  if (ev.kind === 'dm' && await inbox.paused(db, 'instagram', ev.senderId)) return finish(id, { status: 'needs_human', reason: 'owner-chatting' });
  if (!ev.text) {
    /* a picture from someone whose bill is waiting is a payment screenshot to check */
    const lead = settings.salesOn && ev.kind === 'dm' ? await sales.loadLead(ev.senderId) : null;
    if (!lead || lead.stage !== 'billed') return finish(id, { status: 'needs_human', reason: 'no-text' });
    return sellStep(id, Object.assign({}, ev, { screenshot: true }), settings, c, now);
  }

  /* someone in the middle of an order says a lot in an hour, and is not held to the limit */
  const selling = settings.salesOn && sales.activeLead(await sales.loadLead(ev.senderId));
  if (!selling) {
    const sender = await consume({ key: 'auto-reply:' + ev.senderId, limit: settings.perSenderHour, now, windowMs: HOUR_MS });
    if (!sender.allowed) return finish(id, { status: 'skipped', reason: 'sender-limit' });
  }
  /* a yes or no to "is it useful?" */
  if (settings.feedbackOn) {
    const said = await feedback.answer(ev, now).catch(() => null);
    if (said) return sendFeedbackReply(id, said, settings, c);
  }
  /* asking for the app is answered with the app, even in the middle of an order;
     "iPhone 14 Pro Max 3 boxes" in an order is a phone, not the app */
  const ordering = selling && sales.parseOrder(ev.raw || ev.text, settings).length > 0;
  if (!ordering && settings.iosLink && responder.asksForIos(ev.text, settings.appKeywords)) return sendIos(id, ev, settings, c);
  if (settings.appLink && responder.asksForApp(ev.text, settings.appKeywords)) return sendLink(id, ev, settings, c);
  if (settings.salesOn) {
    const sold = await sellStep(id, ev, settings, c, now);
    if (sold !== null) return sold;
  }
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

/**
 * Takes each event once and answers it, until the time runs out. Oldest first, as
 * the customer wrote them. Messages one person sent close together are one thought,
 * "iPhone 14 Pro Max" then "3 boxes", so they are answered as one, by the last of
 * them; and someone who wrote a moment ago is left until they stop typing.
 */
async function handle(list, settings, c, started) {
  const sorted = list.slice().sort((a, b) => (a.sentAt || 0) - (b.sentAt || 0));
  const newest = new Map();
  sorted.forEach(ev => { if (ev.kind === 'dm') newest.set(ev.senderId, Math.max(newest.get(ev.senderId) || 0, ev.sentAt || 0)); });
  const typing = id => started - (newest.get(id) || 0) < SETTLE_MS;
  const groups = [];
  const bySender = new Map();
  for (const ev of sorted) {
    if (ev.kind === 'dm' && typing(ev.senderId)) continue;
    if (ev.kind === 'dm' && bySender.has(ev.senderId)) { bySender.get(ev.senderId).push(ev); continue; }
    const g = [ev];
    groups.push(g);
    if (ev.kind === 'dm') bySender.set(ev.senderId, g);
  }
  let done = 0;
  for (const g of groups) {
    if (Date.now() - started > BUDGET_MS) break;
    const fresh = [];
    for (const ev of g) if (await claim(ev, Date.now())) fresh.push(ev);
    if (!fresh.length) continue;
    /* a request for the app, said among other things, is still its own question */
    const separate = fresh.length > 1 && fresh.some(ev => responder.asksForApp(ev.text, settings.appKeywords) || responder.asksForIos(ev.text, settings.appKeywords));
    const runs = separate || fresh.length === 1 ? fresh.map(ev => [ev]) : [fresh];
    for (const run of runs) {
      const last = run[run.length - 1];
      for (const ev of run.slice(0, -1)) await finish(ev.id, { status: 'merged', mergedInto: last.id });
      const raw = run.map(ev => ev.text).filter(Boolean).join('\n');
      done++;
      /* a failure on one event must not stop the others */
      await work(last.id, Object.assign({}, last, { raw, text: redact(raw).slice(0, 1000) }), settings, c, Date.now())
        .catch(err => finish(last.id, { status: 'failed', error: String(err.message).slice(0, 300), errorKind: 'error' }));
    }
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

/* Scheduled posts (content/schedule.js): looked at every CONTENT_RUN_MS at most,
   whoever polls, and only for an account whose auto posting is on. */
const CONTENT_RUN_MS = 10 * 60 * 1000;
async function contentRun(now) {
  const gate = await consume({ key: 'content:run', limit: 1, now, windowMs: CONTENT_RUN_MS });
  if (!gate.allowed) return null;
  const schedule = require('../content/schedule');
  const r = await schedule.runDue(schedule.liveDeps(), now);
  if (r.posted) console.log('[content] scheduled post', r.posted.id, r.posted.ok ? 'posted' : 'failed: ' + r.posted.error);
  return r;
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
  /* the scheduled Instagram posts ride on the same clock, after the answer */
  if (process.env.VERCEL) waitUntil(contentRun(now).catch(err => console.warn('[content] scheduled post run failed', err.message)));

  const settings = await loadSettings();
  if (settings.mode === 'off') return { status: 200, body: { polled: false, reason: 'off' } };
  const body = await capped(readOnce(settings, c, now, false));
  /* the quick reads go on after the answer, so the caller is not kept waiting */
  if (process.env.VERCEL) {
    waitUntil((async () => {
      for (let i = 0; i < QUICK_READS; i++) {
        await new Promise(r => setTimeout(r, QUICK_READ_MS));
        await capped(readOnce(settings, c, Date.now(), true)).catch(err => console.warn('[auto-reply] quick read failed', err.message));
      }
    })());
  }
  return { status: 200, body };
}

function capped(work) {
  let timer;
  return Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the read took too long')), READ_LIMIT_MS); })])
    .finally(() => clearTimeout(timer));
}

/* One read of the account and everything it brings. `quick` reads messages only,
   and leaves follow-ups and comments to the minute's full read. */
async function readOnce(settings, c, now, quick) {
  const last = await pollRef().get();
  const since = last.exists && last.data().readAt ? last.data().readAt - READ_OVERLAP_MS : now - FIRST_LOOKBACK_MS;
  const meta = metaClient(c);
  const read = await meta.recent(since, { dmsOnly: quick });
  const me = await meta.username().catch(() => '');
  const list = events.fromRead(read, c.igUserId, String(me).toLowerCase());
  const answered = await handle(list, settings, c, now) + (quick ? 0 : await catchUp(settings, c, now));
  const lastTick = (last.exists && last.data().tickAt) || 0;
  const ticking = !quick && now - lastTick >= TICK_EVERY_MS;
  const followed = ticking ? await salesTick(settings, c, now) + await feedbackTick(settings, c, now) : 0;
  if (!quick) await pollRef().set({ readAt: now, tickAt: ticking ? now : lastTick, found: list.length, answered, followed });
  return { polled: true, found: list.length, answered, followed };
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

/** The account's recent posts, comments and conversations, read for the owner. */
async function history() {
  const c = credentials();
  if (!c.token) return { media: [], conversations: [] };
  return metaClient(c).history();
}

/** How the account's posts and reels did, for the owner. */
async function performance() {
  const c = credentials();
  if (!c.token) return { posts: [] };
  return { posts: await metaClient(c).performance(80) };
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
  if (settings.iosLink && responder.asksForIos(said, settings.appKeywords)) {
    return { ok: true, reply: brandIn(settings.iosText, settings), card: iosCard(settings), intent: 'app_link', confidence: 1, shouldReply: true, hold: null, instant: true };
  }
  if (settings.salesOn && sales.asksToBuy(said, settings.salesKeywords)) {
    return { ok: true, reply: sales.priceText(settings), intent: 'sale', confidence: 1, shouldReply: true, hold: null, instant: true };
  }
  if (settings.appLink && responder.asksForApp(said, settings.appKeywords)) {
    return { ok: true, reply: linkIntro(settings), card: linkCard(settings), intent: 'app_link', confidence: 1, shouldReply: true, hold: null, instant: true };
  }
  const d = await responder.draft({ text: said, kind: k, settings, gemini: createGemini({ key: c.geminiKey }), model: c.model, caption: text(caption, 2000) });
  if (!d.ok) return d;
  return Object.assign({}, d, { hold: responder.hold(d, k, settings), costMicroUsd: cost(c, d), usage: undefined });
}

/* ------------------------------------------------------------------ inbox */

function inboxDeps(now) {
  return {
    meta: metaClient(credentials()), sales, db, now: now || Date.now(),
    customer: async mobile => {
      const uid = await sales.ownerShopUid();
      const r = await shop.getCustomer(uid, { id: 'm_' + mobile });
      return { customer: r.customer, insights: r.insights, bills: (r.bills || []).slice(0, 25) };
    }
  };
}

const inboxList = () => inbox.list(inboxDeps());
const inboxThread = q => inbox.thread(inboxDeps(), q);
const inboxReply = input => inbox.reply(inboxDeps(), input);
const inboxContact = input => inbox.saveContact(db, input, Date.now());

async function inboxLeads() {
  const [leads, contacts] = await Promise.all([sales.listLeads(), inbox.contacts(db)]);
  return { leads: leads.map(l => ({ id: l.id, username: l.username || '', stage: l.stage, needsHuman: !!l.needsHuman,
    totalPaise: l.totalPaise || 0, billNumber: l.billNumber || null, source: l.source, updatedAt: l.updatedAt || null,
    lastCustomerAt: l.lastCustomerAt || null, boxes: (l.items || []).reduce((n, i) => n + i.boxes, 0) })), contacts };
}

/** A reply for the owner to edit: the sales assistant's, or the general one's. */
async function inboxSuggest(input) {
  const c = credentials();
  const settings = await loadSettings();
  const said = text(input.text, 1000);
  if (!said) return { ok: false, error: 'There is no customer message to answer.' };
  const gemini = createGemini({ key: c.geminiKey });
  const lead = input.channel === 'instagram' ? await sales.loadLead(input.userId) : null;
  if (lead || (settings.salesOn && sales.asksToBuy(said, settings.salesKeywords))) {
    const a = await sales.suggestFor(String(input.userId), said, settings, gemini, c.model);
    if (a) return { ok: true, reply: a.reply };
  }
  const d = await responder.draft({ text: said, kind: 'dm', settings, gemini, model: c.model, history: [] });
  return d.ok && d.reply ? { ok: true, reply: d.reply } : { ok: false, error: 'The AI could not suggest a reply.' };
}

/* The bill message, then its card; a card Meta refuses goes as the QR and a link. */
async function sendBill(meta, userId, out) {
  await meta.sendMessage(userId, out.reply);
  await meta.sendCard(userId, out.card).catch(async () => {
    if (out.card.image_url) await meta.sendImage(userId, out.card.image_url).catch(() => null);
    const { image_url: _drop, ...plain } = out.card;
    return meta.sendCard(userId, plain).catch(() => meta.sendMessage(userId, out.lead.invoiceUrl));
  });
}

/** A bill made by the owner, sent to the customer when Instagram still allows it. */
async function inboxBill(input) {
  const now = Date.now();
  const settings = await loadSettings();
  const out = await sales.manualBill(String(input.userId), input, settings, now);
  let sent = false;
  if (input.send) {
    const meta = metaClient(credentials());
    sent = await sendBill(meta, String(input.userId), out).then(() => true, err => {
      console.warn('[auto-reply] inbox bill not sent', err.kind || err.message);
      return false;
    });
    if (sent) await sales.logOwner(String(input.userId), out.reply, now).catch(() => null);
  }
  return { ok: true, sent, billNumber: out.lead.billNumber, totalPaise: out.lead.totalPaise, invoiceUrl: out.lead.invoiceUrl };
}

/** Marked paid by the owner, and the customer thanked when the window is open. */
async function inboxPaid(input) {
  const now = Date.now();
  const settings = await loadSettings();
  const lead = await sales.ownerMarkPaid(String(input.userId), now);
  let told = false;
  if (input.tell && now - (lead.lastCustomerAt || 0) < inbox.WINDOW_MS) {
    told = await metaClient(credentials()).sendMessage(lead.senderId, sales.paidMessage(lead, settings)).then(() => true, () => false);
  }
  return { ok: true, told, billNumber: lead.billNumber };
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
  /* held for a person too: after a fix, the owner can let it run again */
  if (ev.status !== 'failed' && ev.status !== 'needs_human' && !waiting(ev, Date.now())) return { ok: false, code: 'not-open' };
  await work(id, ev, await loadSettings(), credentials(), Date.now());
  return { ok: true };
}

module.exports = {
  DEFAULTS, MODES, sales, handshake, verifyToken, receive, poll, loadSettings, saveSettings, overview, liveCheck, history, subscribe,
  tryReply, sendDraft, discard, retry, performance, GraphError,
  inboxList, inboxThread, inboxReply, inboxContact, inboxLeads, inboxSuggest, inboxBill, inboxPaid
};
