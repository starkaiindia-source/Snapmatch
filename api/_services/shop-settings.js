/* ============================================================================
   Mobile Parts Finder · api/_services/shop-settings.js — who works in a shop,
   what the shop is called, and how it takes UPI
   ----------------------------------------------------------------------------
   WHOSE SHOP A REQUEST IS FOR

   A shop is its owner's account, and every path under shops/{uid} still comes from
   a verified token. What changes is that a token can now stand for someone working
   in another person's shop: the owner adds a Gmail address, the person signed in
   with that VERIFIED email says yes, and from then on they work in that shop
   instead of their own.

     shopStaff/{email}   { ownerUid, name, uid, ... }   the whole of that link

   The yes is what stops anyone moving a stranger out of their own shop by typing
   their address. Until it is given (uid is empty) the link changes nothing, and
   their own shop is never touched by any of this: it is only not the one shown.

   No request names a shop or a role. Both are worked out here from the token, and
   the route writes the result over anything the body said. A link is read at most
   every STAFF_CACHE_MS on one instance, so removing someone takes effect at once
   where it was done and within that time everywhere else.

   Staff bill, sell and manage stock. Only the owner reaches this file's settings.

   A SHOP'S RAZORPAY

   The shop's own account, so UPI money goes to the shop and never through this
   site. The keys are sealed (see api/_lib/shop-secrets.js), kept in a document no
   browser can read, and never sent back: the screen only ever learns that a key is
   connected and how it ends.

   A QR code is made for one amount and one bill. Whether it was paid is asked of
   Razorpay by the server, or told by Razorpay's signed webhook, and never taken from
   the browser. Confirm Bill checks that again and spends the QR on that bill, so one
   payment cannot settle two bills.
   ========================================================================== */
'use strict';

const C = require('../_schema/collections');
const money = require('../../src/data/shop-money');
const secrets = require('../_lib/shop-secrets');
const { verifyWebhookSignature } = require('../_lib/razorpay-signature');
const { ShopError } = require('./shop-error');

const db = () => require('../_lib/firebase').db();

const MAX_STAFF = 10;
const STAFF_CACHE_MS = 30 * 1000;
const QR_LIFE_S = 15 * 60;
const LOGO_MAX_CHARS = 120000;
const RAZORPAY = 'https://api.razorpay.com/v1';
const RAZORPAY_TIMEOUT_MS = 12000;

const bad = (code, extra) => new ShopError(400, code, extra);
const conflict = (code, extra) => new ShopError(409, code, extra);

const shopRef = uid => db().collection(C.SHOPS).doc(uid);
const staffCol = () => db().collection(C.SHOP_STAFF);
const keysRef = uid => shopRef(uid).collection(C.SHOP_PRIVATE).doc('razorpay');
const qrRef = (uid, id) => shopRef(uid).collection(C.SHOP_QR).doc(id);
const logoRef = uid => shopRef(uid).collection(C.SHOP_PRIVATE).doc('logo');

function text(v, max) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}
function ownerOnly(who) {
  if (!who || who.actor.role !== 'owner') throw new ShopError(403, 'owner-only');
}
const emailOf = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const goodEmail = e => /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(e) && e.length <= 120;

/* ------------------------------------------------------------------ who */
const staffCache = new Map();

async function staffLink(email) {
  const hit = staffCache.get(email);
  if (hit && Date.now() - hit.at < STAFF_CACHE_MS) return hit.link;
  const snap = await staffCol().doc(email).get();
  const link = snap.exists ? snap.data() : null;
  /* a link waiting for an answer is not kept: the answer may land on another instance */
  if (!link || link.uid) staffCache.set(email, { at: Date.now(), link });
  return link;
}

/**
 * The shop a signed-in user is working in, and who they are in it.
 * An unverified email never joins a shop: anyone can type an address.
 */
async function actorFor(user) {
  const self = { uid: user.uid, email: user.email || '', name: user.name || '', role: 'owner' };
  const email = emailOf(user.email);
  const link = email && user.emailVerified ? await staffLink(email) : null;
  if (!link || !link.ownerUid || link.ownerUid === user.uid) return { shopUid: user.uid, actor: self };
  if (link.uid !== user.uid) return { shopUid: user.uid, actor: self, invite: { shopName: link.shopName || 'A shop' } };
  return {
    shopUid: link.ownerUid,
    actor: Object.assign(self, { role: 'staff', name: link.name || self.name })
  };
}

/* ---------------------------------------------------------------- store */
/** What the shop calls itself: its own settings, then the account's profile. */
function storeView(shop, profile) {
  const s = (shop && shop.store) || {};
  const p = profile || {};
  const a = p.address && typeof p.address === 'object' ? p.address : {};
  const pick = (own, fallback) => (typeof own === 'string' ? own : fallback || '');
  return {
    name: pick(s.name, p.mobileShopName || p.shopName),
    mobile: pick(s.mobile, p.mobileNumber || p.mobile),
    address: pick(s.address, [a.flat, a.area].filter(Boolean).join(', ')),
    city: pick(s.city, a.city),
    state: pick(s.state, a.state),
    pincode: pick(s.pincode, a.pincode || a.pin),
    location: pick(s.location, ''),
    gstin: pick(s.gstin, p.gstin)
  };
}

/** The lines an invoice prints. */
function invoiceHeader(store) {
  return {
    name: store.name || 'Mobile Parts Finder shop',
    place: [store.address, store.city, store.state, store.pincode].filter(Boolean).join(', '),
    mobile: store.mobile,
    gstin: store.gstin
  };
}

async function storeOf(uid) {
  const [shop, profile] = await Promise.all([shopRef(uid).get(), db().collection(C.USERS).doc(uid).get()]);
  return storeView(shop.exists ? shop.data() : null, profile.exists ? profile.data() : null);
}

async function saveStore(uid, body, who) {
  ownerOnly(who);
  const store = {
    name: text(body.name, 80), mobile: text(body.mobile, 20), address: text(body.address, 200),
    city: text(body.city, 60), state: text(body.state, 60), pincode: text(body.pincode, 10),
    location: text(body.location, 300), gstin: text(body.gstin, 15).toUpperCase()
  };
  if (!store.name) throw bad('store-name');
  await shopRef(uid).set({ ownerUid: uid, store, updatedAt: Date.now() }, { merge: true });
  return { store };
}

/* The project has no Storage bucket, so a logo is a small image kept in a document of
   its own: every bill reads the shop's document, and none of them need the logo. */
async function saveLogo(uid, body, who) {
  ownerOnly(who);
  const data = typeof body.data === 'string' ? body.data : '';
  if (!data) {
    await logoRef(uid).delete();
    return { logo: '' };
  }
  if (data.length > LOGO_MAX_CHARS) throw bad('logo-size');
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) throw bad('logo-type');
  await logoRef(uid).set({ ownerUid: uid, data, updatedAt: Date.now() });
  return { logo: data };
}

/* ---------------------------------------------------------------- staff */
const staffView = (id, d) => ({
  email: id, name: d.name || '', addedAt: d.addedAt || null,
  joined: !!d.uid, joinedAt: d.joinedAt || null
});

async function listStaff(uid) {
  const snap = await staffCol().where('ownerUid', '==', uid).get();
  return snap.docs.map(s => staffView(s.id, s.data())).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

async function addStaff(uid, body, who) {
  ownerOnly(who);
  const email = emailOf(body.email);
  const name = text(body.name, 60);
  if (!goodEmail(email)) throw bad('staff-email');
  if (!name) throw bad('staff-name');
  if (email === emailOf(who.actor.email)) throw bad('staff-self');
  const ref = staffCol().doc(email);
  const shopName = (await storeOf(uid)).name || who.actor.name || 'A shop';
  await db().runTransaction(async tx => {
    const cur = await tx.get(ref);
    if (cur.exists && cur.data().ownerUid !== uid) throw conflict('staff-taken');
    const all = await tx.get(staffCol().where('ownerUid', '==', uid));
    if (!cur.exists && all.size >= MAX_STAFF) throw conflict('staff-limit');
    tx.set(ref, Object.assign({ ownerUid: uid, name, shopName, addedBy: uid, addedAt: cur.exists ? cur.data().addedAt : Date.now() },
      cur.exists && cur.data().uid ? { uid: cur.data().uid, joinedAt: cur.data().joinedAt || null } : {}));
  });
  staffCache.delete(email);
  return { staff: await listStaff(uid) };
}

async function removeStaff(uid, body, who) {
  ownerOnly(who);
  const email = emailOf(body.email);
  const ref = staffCol().doc(email);
  const snap = await ref.get();
  if (!snap.exists || snap.data().ownerUid !== uid) throw new ShopError(404, 'staff-missing');
  await ref.delete();
  staffCache.delete(email);
  return { staff: await listStaff(uid) };
}

/** The answer of someone a shop added. Only the account behind that email can give it. */
async function answerInvite(uid, body, who) {
  if (!who.invite) throw new ShopError(404, 'staff-missing');
  const email = emailOf(who.actor.email);
  const ref = staffCol().doc(email);
  if (body.accept === true) await ref.set({ uid: who.actor.uid, joinedAt: Date.now() }, { merge: true });
  else await ref.delete();
  staffCache.delete(email);
  return { joined: body.accept === true };
}

/* ------------------------------------------------------------- razorpay */
async function razorpay(keys, method, path, body) {
  let res;
  try {
    res = await fetch(RAZORPAY + path, {
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from(keys.keyId + ':' + keys.keySecret).toString('base64'),
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(RAZORPAY_TIMEOUT_MS)
    });
  } catch (err) {
    return { status: 599, data: {} };
  }
  let data = {};
  try { data = await res.json(); } catch (err) { /* an empty or broken reply says nothing */ }
  return { status: res.status, data };
}

async function keysOf(uid) {
  const snap = await keysRef(uid).get();
  if (!snap.exists) return null;
  const d = snap.data();
  const keySecret = secrets.unseal(d.keySecret);
  return keySecret ? { keyId: d.keyId, keySecret, webhookSecret: secrets.unseal(d.webhookSecret) } : null;
}

/**
 * A Razorpay payment link for a bill, on the shop's own account, or null when the
 * shop has not connected Razorpay. Instagram orders are paid this way: the link
 * opens Razorpay's own page, so nothing about the card or UPI passes through here.
 */
async function paymentLink(uid, { amountPaise, reference, name, phone, description }) {
  const keys = await keysOf(uid);
  if (!keys) return null;
  const r = await razorpay(keys, 'POST', '/payment_links', {
    amount: amountPaise, currency: 'INR', description: text(description, 200), reference_id: text(reference, 40),
    customer: Object.assign({ name: text(name, 60) }, /^\d{10}$/.test(phone || '') ? { contact: '+91' + phone } : {}),
    notify: { sms: false, email: false }, reminder_enable: false
  });
  if (r.status >= 300 || !r.data.short_url) {
    console.warn('[shop] razorpay refused a payment link', r.status, r.data.error && r.data.error.code);
    throw new ShopError(502, 'razorpay-link');
  }
  return { id: r.data.id, url: r.data.short_url };
}

/** 'paid', 'created', 'expired' or 'cancelled', as Razorpay says. */
async function paymentLinkStatus(uid, id) {
  if (!/^plink_[A-Za-z0-9]{6,40}$/.test(String(id || ''))) return null;
  const keys = await keysOf(uid);
  if (!keys) return null;
  const r = await razorpay(keys, 'GET', '/payment_links/' + id);
  return r.status < 300 ? r.data.status || null : null;
}

function keysView(uid, d) {
  return {
    connected: !!d,
    ready: secrets.available(),
    keyHint: d ? d.keyId.slice(0, 9) + '••••' + d.keyId.slice(-4) : '',
    mode: d ? (/^rzp_live_/.test(d.keyId) ? 'live' : 'test') : '',
    webhook: !!(d && d.webhookSecret),
    connectedAt: d ? d.connectedAt : null,
    webhookUrl: 'https://www.mobilepartsfinder.com/api/razorpay-webhook?shop=' + encodeURIComponent(uid)
  };
}

async function connectRazorpay(uid, body, who) {
  ownerOnly(who);
  const keyId = typeof body.keyId === 'string' ? body.keyId.trim() : '';
  const keySecret = typeof body.keySecret === 'string' ? body.keySecret.trim() : '';
  const webhookSecret = typeof body.webhookSecret === 'string' ? body.webhookSecret.trim() : '';
  if (!/^rzp_(live|test)_[A-Za-z0-9]{6,40}$/.test(keyId)) throw bad('razorpay-key-id');
  if (keySecret.length < 8 || keySecret.length > 80) throw bad('razorpay-key-secret');
  if (webhookSecret.length > 120) throw bad('razorpay-webhook-secret');
  if (!secrets.available()) throw new ShopError(503, 'secrets-unavailable');

  /* a key that does not work is refused here, not found out at the counter */
  const check = await razorpay({ keyId, keySecret }, 'GET', '/payments?count=1');
  if (check.status === 401) throw bad('razorpay-keys');
  if (check.status >= 300) throw new ShopError(502, 'razorpay-down');

  const now = Date.now();
  const doc = {
    ownerUid: uid, keyId, keySecret: secrets.seal(keySecret),
    webhookSecret: webhookSecret ? secrets.seal(webhookSecret) : '',
    connectedAt: now, connectedBy: who.actor.uid
  };
  await keysRef(uid).set(doc);
  await shopRef(uid).set({ ownerUid: uid, razorpayOn: true, updatedAt: now }, { merge: true });
  return { razorpay: keysView(uid, doc) };
}

async function disconnectRazorpay(uid, body, who) {
  ownerOnly(who);
  await keysRef(uid).delete();
  await shopRef(uid).set({ ownerUid: uid, razorpayOn: false, updatedAt: Date.now() }, { merge: true });
  return { razorpay: keysView(uid, null) };
}

/** Everything the Settings page shows. No secret is in it. */
async function loadSettings(uid, query, who) {
  ownerOnly(who);
  const [store, staff, keys, logo] = await Promise.all([storeOf(uid), listStaff(uid), keysRef(uid).get(), logoRef(uid).get()]);
  return {
    store, staff, razorpay: keysView(uid, keys.exists ? keys.data() : null), maxStaff: MAX_STAFF,
    logo: logo.exists ? logo.data().data : ''
  };
}

/* ------------------------------------------------------------- UPI by QR */
const qrId = v => (typeof v === 'string' && /^qr_[A-Za-z0-9]{6,40}$/.test(v) ? v : '');

async function createQr(uid, body) {
  const amountPaise = Number(body.amountPaise);
  if (!money.isInt(amountPaise) || amountPaise < 100 || amountPaise > money.MAX_BILL_PAISE) throw bad('qr-amount-bad');
  const keys = await keysOf(uid);
  if (!keys) throw conflict('razorpay-off');
  const closeBy = Math.floor(Date.now() / 1000) + QR_LIFE_S;
  const r = await razorpay(keys, 'POST', '/payments/qr_codes', {
    type: 'upi_qr', name: 'Bill', usage: 'single_use', fixed_amount: true, payment_amount: amountPaise,
    description: 'Quick Billing', close_by: closeBy,
    notes: { shop: uid, bill: text(body.fid, 40) }
  });
  if (r.status >= 300 || !r.data.id || !/^https:\/\//.test(r.data.image_url || '')) {
    /* the code only: a reply from a payment API is not for the logs in full */
    console.warn('[shop] razorpay refused a QR', r.status, r.data.error && r.data.error.code);
    throw new ShopError(502, 'razorpay-qr');
  }
  await qrRef(uid, r.data.id).set({
    ownerUid: uid, amountPaise, status: 'active', paymentId: null, billId: null,
    fid: text(body.fid, 40), createdAt: Date.now(), createdBy: body.actor ? body.actor.uid : null
  });
  return { qr: { id: r.data.id, imageUrl: r.data.image_url, amountPaise, closeBy: closeBy * 1000 } };
}

async function markPaid(uid, id, paymentId) {
  await qrRef(uid, id).set({ status: 'paid', paymentId: paymentId || null, paidAt: Date.now() }, { merge: true });
}

/** Paid, still waiting, or closed: Razorpay's answer, not the browser's. */
async function qrStatus(uid, query) {
  const id = qrId(query.id);
  if (!id) throw bad('qr-id');
  const snap = await qrRef(uid, id).get();
  if (!snap.exists) throw new ShopError(404, 'qr-missing');
  const d = snap.data();
  if (d.status === 'paid') return { status: 'paid', amountPaise: d.amountPaise };
  const keys = await keysOf(uid);
  if (!keys) throw conflict('razorpay-off');
  const r = await razorpay(keys, 'GET', '/payments/qr_codes/' + id);
  if (r.status >= 300) return { status: 'active', amountPaise: d.amountPaise };
  if ((r.data.payments_amount_received || 0) >= d.amountPaise) {
    const paid = await razorpay(keys, 'GET', '/payments/qr_codes/' + id + '/payments');
    const first = paid.data.items && paid.data.items[0];
    await markPaid(uid, id, first ? first.id : null);
    return { status: 'paid', amountPaise: d.amountPaise };
  }
  return { status: r.data.status === 'closed' ? 'closed' : 'active', amountPaise: d.amountPaise };
}

async function closeQr(uid, body) {
  const id = qrId(body.id);
  if (!id) throw bad('qr-id');
  const snap = await qrRef(uid, id).get();
  if (!snap.exists || snap.data().status !== 'active') return { closed: false };
  const keys = await keysOf(uid);
  if (keys) await razorpay(keys, 'POST', '/payments/qr_codes/' + id + '/close');
  return { closed: true };
}

/**
 * Razorpay telling a shop's webhook that a QR was paid. The address names the shop,
 * and only that shop's own webhook secret can sign for it.
 *
 * @returns {{status:number, body:object}}
 */
async function shopWebhook(uid, rawBody, signature) {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(String(uid || ''))) return { status: 400, body: { error: 'bad shop' } };
  const keys = await keysOf(uid);
  if (!keys || !keys.webhookSecret) return { status: 404, body: { error: 'not connected' } };
  if (!verifyWebhookSignature({ rawBody, signature, secret: keys.webhookSecret })) {
    return { status: 400, body: { error: 'invalid signature' } };
  }
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch (err) { return { status: 400, body: { error: 'invalid json' } }; }
  if (event.event !== 'qr_code.credited') return { status: 200, body: { received: true, ignored: event.event || null } };
  const qr = event.payload && event.payload.qr_code && event.payload.qr_code.entity;
  const pay = event.payload && event.payload.payment && event.payload.payment.entity;
  const id = qrId(qr && qr.id);
  if (!id) return { status: 200, body: { received: true, ignored: 'no qr id' } };
  const snap = await qrRef(uid, id).get();
  if (!snap.exists) return { status: 200, body: { received: true, ignored: 'unknown qr' } };
  if ((qr.payments_amount_received || 0) >= snap.data().amountPaise) await markPaid(uid, id, pay ? pay.id : null);
  return { status: 200, body: { received: true } };
}

module.exports = {
  actorFor, storeView, invoiceHeader, storeOf, saveStore, saveLogo,
  listStaff, addStaff, removeStaff, answerInvite,
  connectRazorpay, disconnectRazorpay, loadSettings,
  createQr, qrStatus, closeQr, shopWebhook, qrRef, qrId, paymentLink, paymentLinkStatus
};
