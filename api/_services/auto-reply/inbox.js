/* ============================================================================
   Mobile Parts Finder · api/_services/auto-reply/inbox.js
   ----------------------------------------------------------------------------
   The owner's inbox on the Leads page: every chat on every connected channel in
   one list, one conversation open beside it, and the customer behind it.

   CHANNELS

     instagram  the account's own Instagram inbox, read from Meta
     messenger  the linked Facebook Page's inbox, read with the Page's token
     whatsapp   WhatsApp Business Cloud API. Not connected yet: WhatsApp has no
                way to read past chats, so it needs its own number, token and a
                webhook that keeps what arrives. Reported as not connected, and
                nothing is pretended.

   WHAT IS STORED

   The chats themselves are read from Meta each time and never copied. What the
   owner adds about a person (a note, tags, a follow-up date, a phone number,
   "AI off" while they talk themselves) is one small document a person in
   inboxContacts, written only when the owner changes something. Orders and
   bills stay where they were: the lead (autoReplyLeads) and Quick Billing.

   Reading is cheap on purpose. The list is Meta only; leads and contacts are
   read when the page asks for them, not with every refresh.
   ========================================================================== */
'use strict';

const C = require('../../_schema/collections');

const CHANNELS = ['instagram', 'messenger', 'whatsapp'];
const WINDOW_MS = 24 * 60 * 60 * 1000;
const TAGS_MAX = 8;

const keyOf = (channel, userId) => `${channel}_${userId}`;
const validChannel = c => (CHANNELS.indexOf(c) > -1 ? c : null);
const validUser = v => (typeof v === 'string' && /^[0-9A-Za-z_-]{3,64}$/.test(v) ? v : null);
const clip = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/* --------------------------------------------------------------- threads */

/* The other person in a conversation. Our own id is the one in every thread,
   which holds whichever login the token uses. */
function selfIdOf(convs, fallback) {
  const seen = new Map();
  convs.forEach(c => ((c.participants && c.participants.data) || []).forEach(p => seen.set(p.id, (seen.get(p.id) || 0) + 1)));
  if (fallback && seen.has(String(fallback))) return String(fallback);
  let best = null;
  seen.forEach((n, id) => { if (convs.length > 1 && n === convs.length) best = id; });
  return best || (fallback ? String(fallback) : null);
}

function threadOf(channel, conv, self) {
  const people = (conv.participants && conv.participants.data) || [];
  const them = people.filter(p => String(p.id) !== String(self))[0] || people[0] || {};
  const last = ((conv.messages && conv.messages.data) || [])[0] || {};
  const at = Date.parse(last.created_time || conv.updated_time) || 0;
  return {
    key: keyOf(channel, them.id), channel, userId: String(them.id || ''), convId: conv.id,
    username: them.username || '', name: them.name || '',
    lastText: last.message || (last.id ? '(attachment)' : ''), lastAt: at,
    lastFromMe: !!(last.from && String(last.from.id) === String(self))
  };
}

/** WhatsApp is connected when its Cloud API number and token are set. */
function whatsappStatus(env) {
  const on = !!(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
  return on ? { connected: false, reason: 'WhatsApp keys are set, but receiving WhatsApp messages is not built yet.' }
    : { connected: false, reason: 'Not connected. Needs a WhatsApp Business number on Meta\'s Cloud API.' };
}

/**
 * Every chat on every channel, newest first, with each channel's state.
 * @param {{meta:object, env?:object}} deps
 */
async function list(deps) {
  const meta = deps.meta;
  const channels = {};
  const threads = [];

  const [ig, fb] = await Promise.all([
    meta.conversations(50).then(d => ({ d }), err => ({ err })),
    meta.pageConversations(50).then(d => ({ d }), err => ({ err }))
  ]);

  if (ig.err) channels.instagram = { connected: false, reason: ig.err.message || 'Instagram could not be read.' };
  else {
    const self = selfIdOf(ig.d, meta.igUserId);
    ig.d.forEach(c => threads.push(threadOf('instagram', c, self)));
    channels.instagram = { connected: true, count: ig.d.length };
  }

  if (fb.err) channels.messenger = { connected: false, reason: fb.err.message || 'Messenger could not be read.' };
  else if (!fb.d) channels.messenger = { connected: false, reason: 'No Facebook Page is linked to this account.' };
  else {
    const self = selfIdOf(fb.d.data, fb.d.page.id);
    fb.d.data.forEach(c => threads.push(threadOf('messenger', c, self)));
    channels.messenger = { connected: true, count: fb.d.data.length, page: fb.d.page.name };
  }

  channels.whatsapp = whatsappStatus(deps.env || process.env);
  threads.sort((a, b) => b.lastAt - a.lastAt);
  return { channels, threads: threads.filter(t => t.userId) };
}

/* -------------------------------------------------------------- contacts */
const contactRef = (db, key) => db().collection(C.INBOX_CONTACTS).doc(key);

async function contacts(db) {
  const snap = await db().collection(C.INBOX_CONTACTS).limit(500).get();
  const out = {};
  snap.docs.forEach(d => { out[d.id] = d.data(); });
  return out;
}

/** What the owner keeps about a person. Only the fields sent are changed. */
async function saveContact(db, input, now) {
  const channel = validChannel(input.channel);
  const userId = validUser(input.userId);
  if (!channel || !userId) return null;
  const set = { channel, userId, updatedAt: now };
  if (typeof input.note === 'string') set.note = clip(input.note, 2000);
  if (typeof input.name === 'string') set.name = clip(input.name, 80);
  if (typeof input.username === 'string') set.username = clip(input.username, 60);
  if (typeof input.mobile === 'string') {
    const m = input.mobile.replace(/\D/g, '').replace(/^91(\d{10})$/, '$1');
    set.mobile = /^\d{10}$/.test(m) ? m : '';
  }
  if (Array.isArray(input.tags)) set.tags = input.tags.map(t => clip(String(t), 24)).filter(Boolean).slice(0, TAGS_MAX);
  if (input.followUpAt === null || Number.isFinite(Number(input.followUpAt))) set.followUpAt = input.followUpAt === null ? null : Number(input.followUpAt);
  if (typeof input.aiPaused === 'boolean') set.aiPaused = input.aiPaused;
  if (typeof input.pinned === 'boolean') set.pinned = input.pinned;
  await contactRef(db, keyOf(channel, userId)).set(set, { merge: true });
  return Object.assign({ key: keyOf(channel, userId) }, set);
}

/** Has the owner switched the bot off for this person? One read a message. */
async function paused(db, channel, userId) {
  try {
    const snap = await contactRef(db, keyOf(channel, userId)).get();
    return !!(snap && snap.exists && snap.data().aiPaused);
  } catch (err) {
    return false;
  }
}

async function pausedIds(db, channel) {
  const snap = await db().collection(C.INBOX_CONTACTS).where('aiPaused', '==', true).limit(500).get();
  return new Set(snap.docs.map(d => d.data()).filter(d => d.channel === channel).map(d => String(d.userId)));
}

/* ---------------------------------------------------------------- thread */

function messageOf(m, userId) {
  const files = ((m.attachments && m.attachments.data) || []).map(a => ({
    image: (a.image_data && (a.image_data.url || a.image_data.preview_url)) || null,
    url: a.file_url || (a.video_data && a.video_data.url) || null,
    name: a.name || ''
  }));
  return {
    id: m.id, text: m.message || '', at: Date.parse(m.created_time) || 0,
    mine: !(m.from && String(m.from.id) === String(userId)), files
  };
}

/**
 * One conversation, oldest first, with the person and everything known about
 * them: the lead, the owner's notes, and their Quick Billing history.
 */
async function thread(deps, q) {
  const channel = validChannel(q.channel);
  const userId = validUser(q.userId);
  if (!channel || !userId) return null;
  const { meta, sales, db, now } = deps;

  let convId = typeof q.convId === 'string' && /^[A-Za-z0-9_:-]{4,200}$/.test(q.convId) ? q.convId : null;
  let raw = [];
  let profile = null;
  if (channel === 'instagram') {
    if (!convId) convId = await meta.conversationWith(userId).catch(() => null);
    [raw, profile] = await Promise.all([
      convId ? meta.messagesOf(convId, 40) : [],
      q.lite ? null : meta.profile(userId).catch(() => null)
    ]);
  } else if (channel === 'messenger') {
    if (!convId) convId = await meta.pageConversationWith(userId).catch(() => null);
    raw = convId ? await meta.pageMessages(convId, 40) : [];
  }

  const messages = raw.map(m => messageOf(m, userId)).sort((a, b) => a.at - b.at);
  const theirs = messages.filter(m => !m.mine);
  const lastCustomerAt = theirs.length ? theirs[theirs.length - 1].at : null;

  const [lead, contactSnap] = await Promise.all([
    channel === 'instagram' ? sales.loadLead(userId) : null,
    contactRef(db, keyOf(channel, userId)).get().catch(() => null)
  ]);
  const contact = contactSnap && contactSnap.exists ? contactSnap.data() : {};

  /* the bot's own lines, so the chat can mark which replies were the AI's */
  const botLines = new Set(((lead && lead.log) || []).filter(l => l.who === 'bot').map(l => String(l.text).slice(0, 80)));
  messages.forEach(m => { if (m.mine && m.text && botLines.has(m.text.slice(0, 80))) m.ai = true; });

  const mobile = contact.mobile || (lead && lead.address && lead.address.phone) || '';
  const customer = mobile && deps.customer && !q.lite ? await deps.customer(mobile).catch(() => null) : null;

  return {
    channel, userId, convId,
    profile: profile ? {
      name: profile.name || '', username: profile.username || '', picture: profile.profile_pic || '',
      followers: profile.follower_count == null ? null : profile.follower_count,
      followsUs: profile.is_user_follow_business == null ? null : !!profile.is_user_follow_business,
      weFollow: profile.is_business_follow_user == null ? null : !!profile.is_business_follow_user
    } : null,
    messages,
    lastCustomerAt,
    canReply: !!lastCustomerAt && now - lastCustomerAt < WINDOW_MS,
    replyUntil: lastCustomerAt ? lastCustomerAt + WINDOW_MS : null,
    lite: !!q.lite,
    lead: lead ? leadView(lead) : null,
    contact: Object.assign({ key: keyOf(channel, userId), mobile }, contact),
    customer
  };
}

function leadView(l) {
  return {
    stage: l.stage, needsHuman: !!l.needsHuman, items: (l.items || []).map(i => ({ master: i.master, asked: i.asked, boxes: i.boxes })),
    address: l.address || {}, totalPaise: l.totalPaise || 0, courierPaise: l.courierPaise || 0, courierZone: l.courierZone || '',
    billId: l.billId || null, billNumber: l.billNumber || null, invoiceUrl: l.invoiceUrl || null,
    qrImage: l.qrImage || null, payUrl: l.payUrl || null, paidAt: l.paidAt || null,
    followUps: l.followUps || 0, createdAt: l.createdAt || null, updatedAt: l.updatedAt || null,
    log: (l.log || []).slice(-20)
  };
}

/* ----------------------------------------------------------------- send */

/** A message from the owner, on the channel the person wrote on. */
async function reply(deps, input) {
  const channel = validChannel(input.channel);
  const userId = validUser(input.userId);
  const text = clip(input.text, 1000);
  if (!channel || !userId || !text) return { ok: false, error: 'Write a message first.' };
  if (channel === 'whatsapp') return { ok: false, error: 'WhatsApp is not connected.' };
  const id = channel === 'instagram' ? await deps.meta.sendMessage(userId, text) : await deps.meta.pageSend(userId, text);
  if (channel === 'instagram') await deps.sales.logOwner(userId, text, deps.now).catch(() => null);
  return { ok: true, id };
}

module.exports = { CHANNELS, WINDOW_MS, keyOf, list, contacts, saveContact, paused, pausedIds, thread, reply, selfIdOf, threadOf };
