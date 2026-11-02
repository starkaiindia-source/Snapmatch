/* ============================================================================
   Mobile Parts Finder · api/_services/shop-service.js — Quick Billing
   ----------------------------------------------------------------------------
   A shop's own categories, products, variants, stock, customers and bills.

   The Device Finder catalogue stays the catalogue. A product may REFER to a
   master device and to compatibility groups, by id, but this file never writes
   a model or a group, and nothing the catalogue serves reads a shop. Six things
   stay separate:

     master device         the global record, catalogue only
     product               a shop's own listing, shops/{uid}/products/{id}
     variant               one sellable RAM/storage of a product, with its own
                           price and stock, held on the product document
     stock                 `qty` on a product or variant, moved only by movements
     compatibility group   the global record, catalogue only
     group link            `groupIds` on a product: ids, never copies

   Variants live on the product document, not in a subcollection, so a bill locks
   one document per product and opening the counter costs one read per product.

   ----------------------------------------------------------------------------
   OWNERSHIP IS THE PATH

   Every document lives under shops/{uid}, and `uid` is only ever the one the
   route took from a verified Firebase ID token. There is no parameter that
   names a shop. A product id from another account is simply a document that
   does not exist under this one — a 404, never another shop's data. Each
   document also carries `ownerUid`, which is checked on read as a second
   line, so a document copied to the wrong place by a script still refuses.

   The browser never talks to Firestore for any of this. shops/** matches no
   rule in firestore.rules except the catch-all deny, so the rules file needs
   no deploy for this feature to be closed to clients.

   ----------------------------------------------------------------------------
   A BILL IS SAVED EXACTLY ONCE

   The browser makes up a finalisation id when a bill is started and sends the
   same id on every attempt to save it. That id IS the bill's document id. The
   save is one transaction that reads the bill first: if it already exists,
   the earlier result is returned and nothing is written — a double tap, a
   retry after a dropped connection, or a second tab all get the same bill,
   and stock is deducted once.

   Inside that transaction, in one atomic step:
     · the shop's counter is read and advanced — the bill number is the next
       integer, so two tills saving at the same moment cannot share one
       (Firestore retries the loser against the new counter)
     · every product on the bill is read and its stock checked; a line asking
       for more than is on the shelf fails the WHOLE bill, nothing is deducted
     · stock is deducted and one movement written per product, keyed by the
       bill, so the movement log can never hold the same sale twice
     · the bill is written with a SNAPSHOT of every item — name, price, shelf,
       and the model the customer asked for — so renaming or repricing a product
       or changing a group later does not rewrite history
     · the customer's totals and the day's figures move with it, so the Overview
       can never disagree with the bills

   A saved bill is never deleted and its items never change. A mistake is
   undone by voiding it, which restores the stock (again keyed by the bill, so
   once) and records who, when and why.

   ----------------------------------------------------------------------------
   MONEY

   Integer paise throughout, via src/data/shop-money.js — the same file the
   browser draws the live invoice with. The browser's totals are never stored:
   the server recomputes the bill from its lines and stores its own answer.
   ========================================================================== */
'use strict';

const crypto = require('crypto');
const { db, bucket } = require('../_lib/firebase');
const C = require('../_schema/collections');
const money = require('../../src/data/shop-money');
const insights = require('./shop-insights');
const search = require('./search-service');
const { invoicePage } = require('./shop-invoice-page');
const offerEngine = require('../../src/data/shop-offers');
const emiEngine = require('../../src/data/shop-emi');
const settings = require('./shop-settings');
const { ShopError } = require('./shop-error');
const entitlements = require('./entitlement-service');
const { TIERS } = require('../_schema/entitlement');
const { CATALOG_VERSION, DEVICE_KINDS, STANDARD_CATEGORIES, SUGGESTED_CATEGORIES } = require('../_schema/shop-standard');

const bad = (code, extra) => new ShopError(400, code, extra);
const notFound = code => new ShopError(404, code);
const conflict = (code, extra) => new ShopError(409, code, extra);

const BILL_PREFIX = 'QB';
const MAX_STOCK = 999999;
const BATCH_LIMIT = 450;
const MAX_VARIANTS = 30;
const MAX_GROUP_LINKS = 30;
/* Firestore's ceiling on one array-contains-any or in. */
const QUERY_CHUNK = 30;
/* Bumped when the day documents change meaning; each shop rebuilds them once. */
const STATS_VERSION = 1;
const NEW_CUSTOMER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const PREFIX_END = '\uf8ff';
/* The Bills page adds its groups up from the rows, so a page has to be big enough
   to hold a month of a busy counter. Each bill read counts against the Spark quota. */
const MAX_BILL_PAGE = 300;

/* ------------------------------------------------------------------ paths */
const shopRef = uid => db().collection(C.SHOPS).doc(uid);
const catCol = uid => shopRef(uid).collection(C.SHOP_CATEGORIES);
const prodCol = uid => shopRef(uid).collection(C.SHOP_PRODUCTS);
const billCol = uid => shopRef(uid).collection(C.SHOP_BILLS);
/**
 * A transaction that leaves a line in the log when it retried or ran slowly,
 * because at the counter both look the same: a bill that will not save. `ran` is
 * how long each attempt spent in `run`; the rest of `ms` is waiting and commits.
 */
async function transaction(name, run, options) {
  const started = Date.now();
  const ran = [];
  try {
    return await db().runTransaction(async tx => {
      const at = Date.now();
      const result = await run(tx);
      ran.push(Date.now() - at);
      return result;
    }, options);
  } finally {
    const ms = Date.now() - started;
    if (ran.length > 1 || ms > 3000) console.warn('[shop] slow transaction', name, JSON.stringify({ ms, ran }));
  }
}

const offerCol = uid => shopRef(uid).collection(C.SHOP_OFFERS);
const moveCol = (uid, productId) => prodCol(uid).doc(productId).collection(C.SHOP_STOCK_MOVES);
const custCol = uid => shopRef(uid).collection(C.SHOP_CUSTOMERS);
const dayCol = uid => shopRef(uid).collection(C.SHOP_DAYS);

/* -------------------------------------------------------------- validation */

/** Trimmed, single-spaced, no control characters, capped. */
function text(value, max) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    const c = ch.codePointAt(0);
    out += (c < 32 || c === 127) ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}
const nameKey = s => text(s, 120).toLowerCase();

/** A browser-made id: product ids, finalisation ids, adjustment ids. */
function clientId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{12,64}$/.test(value) ? value : '';
}
/** A server-made document id coming back from the browser. */
function docId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : '';
}
/** A catalogue model id. */
function modelId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9+._-]{0,119}$/i.test(value) ? value : '';
}
function groupId(value) {
  return typeof value === 'string' && /^[a-z0-9]{2,3}-\d{1,6}$/.test(value) ? value : '';
}
function int(value, min, max) {
  return money.isInt(value) && value >= min && value <= max ? value : null;
}
const blank = v => v === undefined || v === null || v === '';
/** Digits only; an Indian number keeps its last ten. */
function mobile(value) {
  let d = String(value == null ? '' : value).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  return d.slice(0, 15);
}

/** A device photo from the catalogue. No other host is ever stored here. */
function masterImage(value) {
  return typeof value === 'string' && /^https:\/\/[a-z0-9.-]*gsmarena\.com\/\S+$/i.test(value) ? value : null;
}

/* ------------------------------------------------------------------- views */
function owned(uid, snap) {
  if (!snap || !snap.exists) return null;
  const d = snap.data();
  /* The path already says whose it is; this refuses a document that says
     otherwise, rather than trusting where a script happened to put it. */
  if (d.ownerUid && d.ownerUid !== uid) return null;
  return d;
}

function categoryView(id, d) {
  const compat = d.compat || {};
  return {
    id,
    name: d.name,
    description: d.description || '',
    order: d.order || 0,
    stdKey: d.stdKey || null,
    compat: { enabled: !!compat.enabled, partCategory: compat.partCategory || null },
    deviceKind: d.deviceKind || null,
    status: d.status === 'inactive' ? 'inactive' : 'active',
    createdAt: d.createdAt || null
  };
}

function productView(id, d) {
  return {
    id,
    name: d.name,
    imageUrl: d.imageUrl || null,
    pricePaise: d.pricePaise,
    costPaise: d.costPaise == null ? null : d.costPaise,
    shelf: d.shelf || '',
    sku: d.sku || '',
    description: d.description || '',
    qty: d.qty || 0,
    openingQty: d.openingQty == null ? null : d.openingQty,
    lowStockAt: d.lowStockAt == null ? 1 : d.lowStockAt,
    categoryId: d.categoryId || null,
    active: d.active !== false,
    soldCount: d.soldCount || 0,
    master: d.master || null,
    variants: d.variants || [],
    groupIds: d.groupIds || [],
    createdAt: d.createdAt || null,
    updatedAt: d.updatedAt || null
  };
}

function billView(id, d) {
  return Object.assign({ id }, d, { ownerUid: undefined, customerKey: undefined });
}

function customerView(id, d) {
  const bills = d.billCount || 0;
  return {
    id,
    name: d.name || '',
    mobile: d.mobile || '',
    whatsapp: d.whatsapp || '',
    address: d.address || '',
    gstin: d.gstin || '',
    notes: d.notes || '',
    status: d.status === 'inactive' ? 'inactive' : 'active',
    createdAt: d.createdAt || null,
    billCount: bills,
    totalPaise: d.totalPaise || 0,
    paidPaise: d.paidPaise || 0,
    outstandingPaise: d.outstandingPaise || 0,
    averageBillPaise: bills ? Math.round((d.totalPaise || 0) / bills) : 0,
    firstBillAt: d.firstBillAt || null,
    lastBillAt: d.lastBillAt || null
  };
}

const OFFER_SETTINGS = { autoApplyDefault: true, billAutoApply: true, stacking: false, order: 'specific' };
const MAX_OFFER_TARGETS = 200;

function offerSettings(shop) {
  return Object.assign({}, OFFER_SETTINGS, shop && shop.offerSettings);
}

function offerView(id, d) {
  return {
    id,
    name: d.name,
    description: d.description || '',
    kind: d.kind,
    percentBp: d.percentBp || null,
    amountPaise: d.amountPaise || null,
    fixedMode: d.fixedMode || 'unit',
    maxPaise: d.maxPaise || null,
    target: d.target,
    categoryIds: d.categoryIds || [],
    productIds: d.productIds || [],
    variants: d.variants || [],
    startDate: d.startDate || '', startTime: d.startTime || '',
    endDate: d.endDate || '', endTime: d.endTime || '',
    startAt: d.startAt || null,
    endAt: d.endAt || null,
    minQty: d.minQty || 1,
    minBillPaise: d.minBillPaise || 0,
    priority: d.priority || 100,
    stackable: !!d.stackable,
    autoApply: d.autoApply !== false,
    status: d.status,
    createdBy: d.createdBy || null, updatedBy: d.updatedBy || null,
    createdAt: d.createdAt, updatedAt: d.updatedAt
  };
}

function billSummary(id, d) {
  return {
    id,
    number: d.number,
    seq: d.seq,
    status: d.status,
    totalPaise: d.totalPaise,
    paymentStatus: d.payment && d.payment.status,
    paymentMethod: d.payment && d.payment.method,
    customerId: d.customerId || null,
    customerName: (d.customer && d.customer.name) || '',
    customerMobile: (d.customer && d.customer.mobile) || '',
    itemCount: (d.items || []).reduce((n, i) => n + i.qty, 0),
    receivedPaise: d.payment ? Math.min(d.payment.receivedPaise || 0, d.totalPaise) : 0,
    balancePaise: (d.payment && d.status !== 'void' && d.payment.balancePaise) || 0,
    emiNextDue: d.emi && d.status !== 'void' ? (emiEngine.nextDue(d.emi) || {}).due || null : null,
    staffName: d.staff ? d.staff.name || d.staff.email || '' : '',
    discountPaise: (d.discountPaise || 0) + (d.offerDiscountPaise || 0),
    createdAt: d.createdAt
  };
}

/* ---------------------------------------------------------------- images */
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_IMAGE_BYTES = 1500 * 1024;

/**
 * A product photo from the request, checked by its BYTES, not by what the
 * browser said it was. The browser already shrinks it to a few hundred KB;
 * this is the ceiling, not the expectation.
 */
function decodeImage(img) {
  if (!img) return null;
  const type = typeof img.type === 'string' ? img.type : '';
  if (!IMAGE_TYPES[type]) throw bad('image-type');
  if (typeof img.data !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(img.data)) throw bad('image-data');
  const buf = Buffer.from(img.data, 'base64');
  if (buf.length < 64) throw bad('image-data');
  if (buf.length > MAX_IMAGE_BYTES) throw bad('image-too-large');
  const jpeg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  const png = buf.slice(0, 4).toString('hex') === '89504e47';
  const webp = buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
  if (!(type === 'image/jpeg' ? jpeg : type === 'image/png' ? png : webp)) throw bad('image-data');
  return { buf, type, ext: IMAGE_TYPES[type] };
}

/**
 * Uploads through the Admin SDK and returns a token-bearing download URL.
 *
 * The token is what lets the image be shown without opening storage.rules:
 * Firebase serves an object to anyone holding its download token, and the
 * rules keep every other path in the bucket closed. The token is random and
 * per upload, so a URL cannot be guessed from a product id.
 */
async function storeImage(uid, productId, image) {
  const b = bucket();
  const token = crypto.randomUUID();
  const path = `shops/${uid}/products/${productId}/${token.slice(0, 8)}.${image.ext}`;
  try {
    await b.file(path).save(image.buf, {
      resumable: false,
      contentType: image.type,
      metadata: {
        contentType: image.type,
        cacheControl: 'public, max-age=31536000, immutable',
        metadata: { firebaseStorageDownloadTokens: token }
      }
    });
  } catch (err) {
    console.error('[shop:image] upload failed', err && err.message);
    throw new ShopError(502, 'image-upload-failed');
  }
  const url = typeof b.downloadUrl === 'function'
    ? b.downloadUrl(path, token)
    : 'https://firebasestorage.googleapis.com/v0/b/' + b.name + '/o/' +
      encodeURIComponent(path) + '?alt=media&token=' + token;
  return { url, path };
}

async function dropImage(path) {
  if (!path) return;
  try { await bucket().file(path).delete(); }
  catch (err) { console.warn('[shop:image] could not delete', path, err && err.message); }
}

/* ================================================================== STATE */

/**
 * Gives a shop the standard categories, once.
 *
 * Idempotent three ways: the shop records the version it has, a standard
 * category's document id is fixed, and all of it happens in one transaction, so
 * two tabs opening at once cannot make twins. A category the shop already has
 * under the same name becomes the standard one and keeps its id, its products
 * and any settings it has. Custom categories keep their relative order, after
 * the standard twelve.
 */
async function ensureCatalog(uid) {
  const now = Date.now();
  await db().runTransaction(async tx => {
    const shopSnap = await tx.get(shopRef(uid));
    const shop = owned(uid, shopSnap) || {};
    if ((shop.catalogV || 0) >= CATALOG_VERSION) return;
    const all = await readCategories(tx, uid);
    const taken = new Set();

    STANDARD_CATEGORIES.forEach((std, i) => {
      const compat = { enabled: std.compat, partCategory: std.partCategory };
      const match = all.find(c => !taken.has(c.id) && (c.d.stdKey === std.key || c.d.nameKey === nameKey(std.name)));
      if (match) {
        taken.add(match.id);
        const patch = { stdKey: std.key, order: i + 1, updatedAt: now };
        if (match.d.description === undefined) patch.description = std.description;
        if (match.d.compat === undefined) patch.compat = compat;
        if (match.d.deviceKind === undefined) patch.deviceKind = std.deviceKind;
        if (match.d.status === undefined) patch.status = 'active';
        tx.update(match.ref, patch);
        return;
      }
      tx.set(catCol(uid).doc('std_' + std.key), {
        ownerUid: uid, name: std.name, nameKey: nameKey(std.name), stdKey: std.key,
        description: std.description, order: i + 1, compat, deviceKind: std.deviceKind,
        status: 'active', createdAt: now, updatedAt: now
      });
    });

    all.filter(c => !taken.has(c.id))
      .sort((a, b) => (a.d.order || 0) - (b.d.order || 0))
      .forEach((c, i) => tx.update(c.ref, { order: STANDARD_CATEGORIES.length + i + 1, updatedAt: now }));

    tx.set(shopRef(uid), Object.assign(
      { ownerUid: uid, catalogV: CATALOG_VERSION, updatedAt: now },
      shopSnap.exists ? {} : { createdAt: now }
    ), { merge: true });
  });
}

/**
 * Builds customers and day figures from bills saved before either existed.
 *
 * Runs once per shop. A bill with a mobile number links to a customer with that
 * number. A bill with only a typed name stays a walk-in, because a name alone
 * does not say two bills were the same person. The money is taken from the bills
 * as they stand; a balance paid later is counted on the bill's own day, because
 * the old bills do not say otherwise reliably.
 */
async function ensureStats(uid) {
  const shopSnap = await shopRef(uid).get();
  const shop = owned(uid, shopSnap) || {};
  if ((shop.statsV || 0) >= STATS_VERSION) return;

  const [billSnap, custSnap] = await Promise.all([billCol(uid).get(), custCol(uid).get()]);
  const bills = billSnap.docs.map(s => ({ id: s.id, d: owned(uid, s) })).filter(x => x.d)
    .sort((a, b) => (a.d.seq || 0) - (b.d.seq || 0));
  const now = Date.now();
  const customers = new Map();
  custSnap.docs.forEach(s => { const d = owned(uid, s); if (d) customers.set(s.id, Object.assign({}, d)); });
  const days = new Map();
  const dayOf = key => {
    if (!days.has(key)) days.set(key, insights.emptyDay(key, uid));
    return days.get(key);
  };
  const billPatches = [];
  let outstanding = 0;

  bills.forEach(({ id, d: b }) => {
    const mob = mobile(b.customerMobile || (b.customer && b.customer.mobile));
    const cid = b.customerId || (mob.length >= 10 ? 'm_' + mob : null);
    const key = b.day || insights.dayKey(b.createdAt);
    if (b.day !== key || (b.customerId || null) !== cid) billPatches.push({ id, patch: { day: key, customerId: cid } });
    const isVoid = b.status === 'void';
    const pay = b.payment || {};
    const received = Math.min(pay.receivedPaise || 0, b.totalPaise);

    if (isVoid) {
      const day = dayOf(key);
      day.voids += 1;
      day.voidedPaise += b.totalPaise;
      return;
    }
    let c = cid ? customers.get(cid) : null;
    if (cid && !c) {
      c = blankCustomer(uid, { name: (b.customer && b.customer.name) || '', mobile: mob }, b.createdAt);
      customers.set(cid, c);
    }
    const isNew = !!c && !c.billCount;
    insights.addBill(dayOf(key), b, c ? { id: cid, isNew } : null);
    insights.addCollected(dayOf(key), pay.method || 'cash', received);
    outstanding += Math.max(0, b.totalPaise - received);
    if (c) addToCustomer(c, b.totalPaise, received, b.createdAt);
  });

  const writes = [];
  days.forEach((d, key) => writes.push(batch => batch.set(dayCol(uid).doc(key), d)));
  customers.forEach((d, id) => writes.push(batch => batch.set(custCol(uid).doc(id), d)));
  billPatches.forEach(x => writes.push(batch => batch.update(billCol(uid).doc(x.id), x.patch)));
  for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
    const batch = db().batch();
    writes.slice(i, i + BATCH_LIMIT).forEach(w => w(batch));
    await batch.commit();
  }
  await shopRef(uid).set({
    ownerUid: uid, statsV: STATS_VERSION, customerCount: customers.size,
    outstandingPaise: outstanding, updatedAt: now
  }, { merge: true });
}

/** Who did something, as a bill records it. */
function stamp(actor) {
  return actor ? { uid: actor.uid, email: actor.email || '', name: actor.name || '', role: actor.role || 'owner' } : null;
}
const byName = actor => (actor ? actor.name || actor.email || '' : '');

/** Everything the billing screen needs on open: categories and products. */
async function loadState(uid, query, who) {
  const first = owned(uid, await shopRef(uid).get()) || {};
  if ((first.catalogV || 0) < CATALOG_VERSION) await ensureCatalog(uid);
  if ((first.statsV || 0) < STATS_VERSION) await ensureStats(uid);

  const [shopSnap, cats, prods, offers, profile] = await Promise.all([
    shopRef(uid).get(), catCol(uid).get(), prodCol(uid).get(), offerCol(uid).get(), db().collection(C.USERS).doc(uid).get()
  ]);
  const shop = owned(uid, shopSnap) || {};
  const categories = cats.docs
    .map(s => ({ s, d: owned(uid, s) })).filter(x => x.d)
    .map(x => categoryView(x.s.id, x.d))
    .sort((a, b) => a.order - b.order || String(a.name).localeCompare(b.name));
  const products = prods.docs
    .map(s => ({ s, d: owned(uid, s) })).filter(x => x.d)
    .map(x => productView(x.s.id, x.d));
  return {
    shop: {
      billCount: shop.billSeq || 0, billPrefix: BILL_PREFIX,
      customerCount: shop.customerCount || 0, outstandingPaise: shop.outstandingPaise || 0
    },
    categories,
    products,
    offers: offers.docs.map(s => ({ s, d: owned(uid, s) })).filter(x => x.d && x.d.status !== 'archived').map(x => offerView(x.s.id, x.d)),
    offerSettings: offerSettings(shop),
    suggestedCategories: SUGGESTED_CATEGORIES,
    store: settings.storeView(shop, profile.exists ? profile.data() : null),
    payments: { razorpay: !!shop.razorpayOn, upiId: shop.upiId || '', autoCollect: !!(shop.razorpayOn && shop.autoCollect) },
    me: who ? { role: who.actor.role, name: who.actor.name, email: who.actor.email, invite: who.invite || null } : null
  };
}

/* ============================================================= CATEGORIES */

function categoryName(value) {
  const name = text(value, 40);
  if (!name) throw bad('category-name');
  return name;
}

async function readCategories(tx, uid) {
  const snap = await tx.get(catCol(uid));
  return snap.docs.map(s => ({ id: s.id, ref: s.ref, d: owned(uid, s) })).filter(x => x.d);
}

/** The settings a shop chooses for a category, checked. Undefined means unchanged. */
function categorySettings(body) {
  const out = {};
  if (body.description !== undefined) out.description = text(body.description, 200);
  if (body.compatEnabled !== undefined || body.partCategory !== undefined) {
    const part = blank(body.partCategory) ? null : text(body.partCategory, 40);
    if (part && !search.loadIndex().categories.has(part)) throw bad('part-category');
    out.compat = { enabled: !!body.compatEnabled, partCategory: part };
  }
  if (body.deviceKind !== undefined) {
    const kind = blank(body.deviceKind) ? null : body.deviceKind;
    if (kind && !DEVICE_KINDS.includes(kind)) throw bad('device-kind');
    out.deviceKind = kind;
  }
  if (body.status !== undefined) out.status = body.status === 'inactive' ? 'inactive' : 'active';
  return out;
}

async function createCategory(uid, body) {
  const name = categoryName(body.name);
  const settings = categorySettings(body);
  const now = Date.now();
  return db().runTransaction(async tx => {
    const all = await readCategories(tx, uid);
    const dup = all.find(c => c.d.nameKey === nameKey(name));
    if (dup) throw conflict('category-exists', { category: categoryView(dup.id, dup.d) });
    const ref = catCol(uid).doc();
    const d = Object.assign({
      ownerUid: uid, name, nameKey: nameKey(name), stdKey: null, description: '',
      compat: { enabled: false, partCategory: null }, deviceKind: null, status: 'active',
      order: all.reduce((m, c) => Math.max(m, c.d.order || 0), 0) + 1,
      createdAt: now, updatedAt: now
    }, settings);
    tx.set(ref, d);
    tx.set(shopRef(uid), { ownerUid: uid, updatedAt: now }, { merge: true });
    return { category: categoryView(ref.id, d) };
  });
}

/** Adds the suggested categories the shop does not already have. Never a duplicate. */
async function addSuggested(uid, body) {
  const wanted = Array.isArray(body.names) && body.names.length
    ? body.names.map(n => text(n, 40)).filter(n => SUGGESTED_CATEGORIES.includes(n))
    : SUGGESTED_CATEGORIES;
  const now = Date.now();
  return db().runTransaction(async tx => {
    const all = await readCategories(tx, uid);
    const have = new Set(all.map(c => c.d.nameKey));
    let order = all.reduce((m, c) => Math.max(m, c.d.order || 0), 0);
    const created = [];
    wanted.forEach(name => {
      if (have.has(nameKey(name))) return;
      have.add(nameKey(name));
      const ref = catCol(uid).doc();
      const d = {
        ownerUid: uid, name, nameKey: nameKey(name), stdKey: null, description: '',
        compat: { enabled: false, partCategory: null }, deviceKind: null, status: 'active',
        order: ++order, createdAt: now, updatedAt: now
      };
      tx.set(ref, d);
      created.push(categoryView(ref.id, d));
    });
    if (created.length) tx.set(shopRef(uid), { ownerUid: uid, updatedAt: now }, { merge: true });
    return { created };
  });
}

async function renameCategory(uid, body) {
  const id = docId(body.categoryId);
  if (!id) throw bad('category-id');
  const name = categoryName(body.name);
  return db().runTransaction(async tx => {
    const all = await readCategories(tx, uid);
    const me = all.find(c => c.id === id);
    if (!me) throw notFound('category-not-found');
    const dup = all.find(c => c.id !== id && c.d.nameKey === nameKey(name));
    if (dup) throw conflict('category-exists', { category: categoryView(dup.id, dup.d) });
    tx.update(me.ref, { name, nameKey: nameKey(name), updatedAt: Date.now() });
    return { category: categoryView(id, Object.assign({}, me.d, { name })) };
  });
}

/**
 * Edits a category's name, description, position and compatibility settings.
 *
 * Turning compatibility off stops the category's products being offered by
 * model search and leaves their links exactly as they are, so turning it back on
 * restores them. No product and no bill is touched.
 */
async function updateCategory(uid, body) {
  const id = docId(body.categoryId);
  if (!id) throw bad('category-id');
  const patch = categorySettings(body);
  if (body.name !== undefined) {
    patch.name = categoryName(body.name);
    patch.nameKey = nameKey(patch.name);
  }
  const position = body.order === undefined ? null : int(body.order, 1, 10000);
  if (body.order !== undefined && position == null) throw bad('category-order');
  const now = Date.now();

  return db().runTransaction(async tx => {
    const all = await readCategories(tx, uid);
    const me = all.find(c => c.id === id);
    if (!me) throw notFound('category-not-found');
    if (patch.nameKey) {
      const dup = all.find(c => c.id !== id && c.d.nameKey === patch.nameKey);
      if (dup) throw conflict('category-exists', { category: categoryView(dup.id, dup.d) });
    }
    if (position != null) {
      const rest = all.filter(c => c.id !== id).sort((a, b) => (a.d.order || 0) - (b.d.order || 0));
      rest.splice(Math.min(position - 1, rest.length), 0, me);
      rest.forEach((c, i) => {
        if (c.id === id) patch.order = i + 1;
        else if ((c.d.order || 0) !== i + 1) tx.update(c.ref, { order: i + 1, updatedAt: now });
      });
    }
    tx.update(me.ref, Object.assign({ updatedAt: now }, patch));
    return { category: categoryView(id, Object.assign({}, me.d, patch)) };
  });
}

/** `ids` in the order the shop wants them; any it left out keep their place after. */
async function reorderCategories(uid, body) {
  const ids = Array.isArray(body.ids) ? body.ids.map(docId).filter(Boolean) : [];
  if (!ids.length) throw bad('category-order');
  const snap = await catCol(uid).get();
  const mine = snap.docs.filter(s => owned(uid, s));
  const rank = new Map(ids.map((id, i) => [id, i + 1]));
  const rest = mine.filter(s => !rank.has(s.id))
    .sort((a, b) => (a.data().order || 0) - (b.data().order || 0));
  rest.forEach((s, i) => rank.set(s.id, ids.length + i + 1));
  const batch = db().batch();
  const now = Date.now();
  mine.forEach(s => batch.update(s.ref, { order: rank.get(s.id), updatedAt: now }));
  await batch.commit();
  return { order: mine.map(s => s.id).sort((a, b) => rank.get(a) - rank.get(b)) };
}

/**
 * Deletes a category. Its products are never deleted: a category that still
 * holds any — archived ones included — can only go once they have somewhere
 * else to be, and they are moved there first.
 */
async function deleteCategory(uid, body) {
  const id = docId(body.categoryId);
  if (!id) throw bad('category-id');
  const moveTo = body.moveTo ? docId(body.moveTo) : '';
  const [catSnap, targetSnap, prods] = await Promise.all([
    catCol(uid).doc(id).get(),
    moveTo ? catCol(uid).doc(moveTo).get() : Promise.resolve(null),
    prodCol(uid).where('categoryId', '==', id).get()
  ]);
  if (!owned(uid, catSnap)) throw notFound('category-not-found');
  const products = prods.docs.filter(s => owned(uid, s));
  if (products.length && !moveTo) throw conflict('category-has-products', { count: products.length });
  if (moveTo && (moveTo === id || !owned(uid, targetSnap))) throw bad('move-target');

  const now = Date.now();
  for (let i = 0; i < products.length; i += BATCH_LIMIT) {
    const batch = db().batch();
    products.slice(i, i + BATCH_LIMIT).forEach(s => batch.update(s.ref, { categoryId: moveTo, updatedAt: now }));
    await batch.commit();
  }
  await catCol(uid).doc(id).delete();
  return { deleted: id, moved: products.length, moveTo: moveTo || null };
}

/* =============================================================== PRODUCTS */

function productFields(body, partial, hasVariants) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = text(body.name, 80);
    if (!out.name) throw bad('product-name');
  }
  if (!hasVariants) {
    if (!partial || body.pricePaise !== undefined) {
      out.pricePaise = int(body.pricePaise, 1, money.MAX_UNIT_PAISE);
      if (out.pricePaise == null) throw bad('product-price');
    }
    if (!partial || body.qty !== undefined) {
      out.qty = int(body.qty === undefined ? 1 : body.qty, 0, MAX_STOCK);
      if (out.qty == null) throw bad('product-qty');
    }
    if (!partial || body.costPaise !== undefined) {
      out.costPaise = blank(body.costPaise) ? null : int(body.costPaise, 0, money.MAX_UNIT_PAISE);
      if (!blank(body.costPaise) && out.costPaise == null) throw bad('product-cost');
    }
  }
  if (!partial || body.shelf !== undefined) out.shelf = text(body.shelf, 24);
  if (!partial || body.sku !== undefined) out.sku = text(body.sku, 40);
  if (!partial || body.description !== undefined) out.description = text(body.description, 300);
  if (!partial || body.lowStockAt !== undefined) {
    out.lowStockAt = int(body.lowStockAt === undefined || body.lowStockAt === null ? 1 : body.lowStockAt, 0, MAX_STOCK);
    if (out.lowStockAt == null) throw bad('product-low-stock');
  }
  if (body.active !== undefined) out.active = !!body.active;
  return out;
}

/**
 * The sellable variants of a device. Each has its own price and its own stock;
 * two variants are never merged because they share a model.
 *
 * @returns {Array|undefined} undefined when the request does not mention them
 */
function readVariants(raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw bad('variants');
  if (raw.length > MAX_VARIANTS) throw bad('too-many-variants');
  const seen = new Set();
  return raw.map((v, i) => {
    v = v || {};
    const id = typeof v.id === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(v.id) ? v.id : '';
    if (!id) throw bad('variant-id', { line: i });
    const ram = text(v.ram, 16);
    const storage = text(v.storage, 16);
    const label = text(v.label, 40);
    if (!ram && !storage && !label) throw bad('variant-name', { line: i });
    const key = [ram, storage, label].join('|').toLowerCase();
    if (seen.has(key) || seen.has('id:' + id)) throw bad('variant-duplicate', { line: i });
    seen.add(key);
    seen.add('id:' + id);
    const pricePaise = int(v.pricePaise, 1, money.MAX_UNIT_PAISE);
    if (pricePaise == null) throw bad('variant-price', { line: i });
    const costPaise = blank(v.costPaise) ? null : int(v.costPaise, 0, money.MAX_UNIT_PAISE);
    if (!blank(v.costPaise) && costPaise == null) throw bad('variant-cost', { line: i });
    const qty = int(blank(v.qty) ? 0 : v.qty, 0, MAX_STOCK);
    if (qty == null) throw bad('variant-qty', { line: i });
    return { id, ram, storage, label, sku: text(v.sku, 40), shelf: text(v.shelf, 24), pricePaise, costPaise, qty };
  });
}

function variantLabel(v) {
  return [v.ram, v.storage, v.label].filter(Boolean).join(' / ');
}

/** A product with variants shows the total of its stock and its lowest price. */
function applyVariants(fields, variants) {
  fields.variants = variants;
  fields.qty = variants.reduce((n, v) => n + v.qty, 0);
  fields.pricePaise = variants.reduce((m, v) => Math.min(m, v.pricePaise), Infinity);
  fields.costPaise = null;
}

/**
 * Which master device a product is. The record itself is never copied or
 * changed: the name comes from the catalogue, not from the request, and the
 * photo is only ever a catalogue image URL.
 *
 * @returns {object|null|undefined} undefined when the request does not mention it
 */
function readMaster(raw, category) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const id = modelId(raw.id);
  const known = id ? search.loadIndex().byId.get(id) : null;
  if (!known) throw bad('master-unknown');
  const kind = category && category.deviceKind;
  if (!kind) throw bad('master-category');
  if (raw.kind && raw.kind !== kind) throw bad('master-kind');
  return { id, name: known.name, brandId: known.brandId, kind, image: masterImage(raw.image) };
}

/**
 * Checks the compatibility groups a product is being linked to. A link already
 * on the product is kept without asking, so a group retired from the catalogue
 * cannot stop the product being edited. A group that was merged is linked as the
 * group it became.
 *
 * @returns {Promise<string[]|undefined>} undefined when the request does not mention them
 */
async function readGroupLinks(raw, category, existing) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw bad('group-links');
  const ids = Array.from(new Set(raw.map(groupId).filter(Boolean)));
  if (ids.length !== new Set(raw).size) throw bad('group-unknown');
  if (ids.length > MAX_GROUP_LINKS) throw bad('too-many-groups');
  const fresh = ids.filter(id => !existing.includes(id));
  if (fresh.length && !(category && category.compat && category.compat.enabled)) throw bad('group-category-off');
  const part = category && category.compat && category.compat.partCategory;

  const out = ids.filter(id => existing.includes(id));
  for (const id of fresh) {
    let snap = await db().collection(C.GROUPS).doc(id).get();
    if (!snap.exists) throw bad('group-unknown', { groupId: id });
    if (snap.data().mergedInto) {
      snap = await db().collection(C.GROUPS).doc(String(snap.data().mergedInto)).get();
      if (!snap.exists) throw bad('group-unknown', { groupId: id });
    }
    if (part && snap.data().categoryId !== part) throw bad('group-category', { groupId: id });
    if (!out.includes(snap.id)) out.push(snap.id);
  }
  return out;
}

/**
 * Which category a product goes in: an existing one by id, or one named in
 * the same form ("existing or new"). A new name that matches a category the
 * shop already has — in any case — reuses it rather than making a twin.
 */
async function resolveCategory(tx, uid, body, now) {
  const id = body.categoryId ? docId(body.categoryId) : '';
  const newName = body.newCategory ? categoryName(body.newCategory) : '';
  if (!id && !newName) throw bad('product-category');
  const all = await readCategories(tx, uid);
  if (id) {
    if (!all.some(c => c.id === id)) throw bad('product-category');
    return { id, write: null };
  }
  const same = all.find(c => c.d.nameKey === nameKey(newName));
  if (same) return { id: same.id, write: null, category: categoryView(same.id, same.d) };
  const ref = catCol(uid).doc();
  const d = {
    ownerUid: uid, name: newName, nameKey: nameKey(newName), stdKey: null, description: '',
    compat: { enabled: false, partCategory: null }, deviceKind: null, status: 'active',
    order: all.reduce((m, c) => Math.max(m, c.d.order || 0), 0) + 1,
    createdAt: now, updatedAt: now
  };
  return { id: ref.id, write: () => tx.set(ref, d), category: categoryView(ref.id, d) };
}

async function categoryOf(uid, id) {
  const clean = id ? docId(id) : '';
  return clean ? owned(uid, await catCol(uid).doc(clean).get()) : null;
}

/**
 * Quick Product Add. The browser picks the product id, so pressing Save twice,
 * or a retry after the response was lost, returns the product it already made.
 */
async function createProduct(uid, body) {
  const id = clientId(body.productId);
  if (!id) throw bad('product-id');
  const variants = readVariants(body.variants) || [];
  const fields = productFields(body, false, variants.length > 0);
  if (variants.length) applyVariants(fields, variants);
  const ref = prodCol(uid).doc(id);

  const before = owned(uid, await ref.get());
  if (before) return { product: productView(id, before), replayed: true };

  const category = await categoryOf(uid, body.categoryId);
  const master = readMaster(body.master, category);
  const groupIds = await readGroupLinks(body.groupIds, category, []);

  const image = decodeImage(body.image);
  const stored = image ? await storeImage(uid, id, image) : null;
  const now = Date.now();

  const result = await db().runTransaction(async tx => {
    const again = owned(uid, await tx.get(ref));
    if (again) return { product: productView(id, again), replayed: true };
    const cat = await resolveCategory(tx, uid, body, now);
    const d = Object.assign({ ownerUid: uid }, fields, {
      categoryId: cat.id,
      imageUrl: stored ? stored.url : null,
      imagePath: stored ? stored.path : null,
      master: master || null,
      variants,
      groupIds: groupIds || [],
      openingQty: fields.qty,
      active: fields.active !== false, soldCount: 0, createdAt: now, updatedAt: now
    });
    if (cat.write) cat.write();
    tx.set(ref, d);
    if (variants.length) {
      variants.filter(v => v.qty > 0).forEach(v => {
        tx.set(moveCol(uid, id).doc('opening_' + v.id), {
          ownerUid: uid, delta: v.qty, qtyAfter: v.qty, reason: 'opening',
          variantId: v.id, variantLabel: variantLabel(v), at: now
        });
      });
    } else if (d.qty > 0) {
      tx.set(moveCol(uid, id).doc('opening'), {
        ownerUid: uid, delta: d.qty, qtyAfter: d.qty, reason: 'opening', at: now
      });
    }
    tx.set(shopRef(uid), { ownerUid: uid, updatedAt: now }, { merge: true });
    return { product: productView(id, d), category: cat.write ? cat.category : null, replayed: false };
  });
  /* Lost the race to an identical request: the photo this one uploaded is
     not the one the product points at. */
  if (result.replayed && stored) await dropImage(stored.path);
  return result;
}

/**
 * Edits a product. A changed quantity is recorded as a stock movement like
 * any other — editing the number is not a way round the log.
 */
async function updateProduct(uid, body) {
  const id = docId(body.productId);
  if (!id) throw bad('product-id');
  const variants = readVariants(body.variants);
  const ref = prodCol(uid).doc(id);
  const image = body.image ? decodeImage(body.image) : null;
  const known = owned(uid, await ref.get());
  if (!known) throw notFound('product-not-found');

  const hasVariants = variants !== undefined ? variants.length > 0 : (known.variants || []).length > 0;
  const fields = productFields(body, true, hasVariants);
  const category = await categoryOf(uid, body.categoryId || known.categoryId);
  const master = readMaster(body.master, category);
  const groupIds = await readGroupLinks(body.groupIds, category, known.groupIds || []);

  const stored = image ? await storeImage(uid, id, image) : null;
  const now = Date.now();
  let dropPath = null;

  const result = await db().runTransaction(async tx => {
    const cur = owned(uid, await tx.get(ref));
    if (!cur) throw notFound('product-not-found');
    const cat = (body.categoryId || body.newCategory) ? await resolveCategory(tx, uid, body, now) : null;
    const patch = Object.assign({}, fields, { updatedAt: now });
    if (cat) patch.categoryId = cat.id;
    if (master !== undefined) patch.master = master;
    if (groupIds !== undefined) patch.groupIds = groupIds;
    if (stored || body.removeImage) {
      dropPath = cur.imagePath || null;
      patch.imageUrl = stored ? stored.url : null;
      patch.imagePath = stored ? stored.path : null;
    }

    const moves = [];
    if (variants !== undefined) {
      const old = cur.variants || [];
      const gone = old.find(o => o.qty > 0 && !variants.some(v => v.id === o.id));
      if (gone) throw conflict('variant-has-stock', { label: variantLabel(gone), available: gone.qty });
      if (variants.length) {
        applyVariants(patch, variants);
        if (!old.length && (cur.qty || 0) > 0) {
          moves.push({ delta: -cur.qty, qtyAfter: 0, reason: 'edit', note: 'Stock moved to variants' });
        }
        variants.forEach(v => {
          const was = old.find(o => o.id === v.id);
          const delta = v.qty - (was ? was.qty : 0);
          if (delta) {
            moves.push({
              delta, qtyAfter: v.qty, reason: was ? 'edit' : 'opening',
              variantId: v.id, variantLabel: variantLabel(v), note: was ? 'Quantity edited' : ''
            });
          }
        });
      } else {
        patch.variants = [];
        if (old.length && fields.qty === undefined) patch.qty = 0;
      }
    }
    const single = (variants === undefined ? (cur.variants || []).length === 0 : variants.length === 0);
    const delta = single && fields.qty != null ? fields.qty - (cur.qty || 0) : 0;

    if (cat && cat.write) cat.write();
    tx.update(ref, patch);
    if (delta) {
      moves.push({ delta, qtyAfter: fields.qty, reason: 'edit', note: text(body.note, 120) || 'Quantity edited' });
    }
    moves.forEach(m => tx.set(moveCol(uid, id).doc(), Object.assign({ ownerUid: uid, at: now }, m)));
    return { product: productView(id, Object.assign({}, cur, patch)), category: cat && cat.write ? cat.category : null };
  });
  if (dropPath) await dropImage(dropPath);
  return result;
}

/** Archived products stay on every bill that sold them and can be restored. */
async function archiveProduct(uid, body) {
  const id = docId(body.productId);
  if (!id) throw bad('product-id');
  const ref = prodCol(uid).doc(id);
  const cur = owned(uid, await ref.get());
  if (!cur) throw notFound('product-not-found');
  const patch = { active: body.archived === false, updatedAt: Date.now() };
  await ref.update(patch);
  return { product: productView(id, Object.assign({}, cur, patch)) };
}

/**
 * A manual stock correction: received stock, damage, a recount. `adjustId`
 * comes from the browser and keys the movement, so a repeated request adds
 * the stock once.
 */
async function adjustStock(uid, body) {
  const id = docId(body.productId);
  const adjustId = clientId(body.adjustId);
  if (!id) throw bad('product-id');
  if (!adjustId) throw bad('adjust-id');
  const delta = int(body.delta, -MAX_STOCK, MAX_STOCK);
  if (!delta) throw bad('adjust-delta');
  /* Sent by a stock count: the figure the shop was looking at. If a bill has
     moved the stock since, the count is out of date and must not be applied. */
  const expected = blank(body.expectedQty) ? null : int(body.expectedQty, 0, MAX_STOCK);
  if (!blank(body.expectedQty) && expected == null) throw bad('adjust-expected');
  const ref = prodCol(uid).doc(id);
  const moveRef = moveCol(uid, id).doc('adj_' + adjustId);
  const now = Date.now();
  return db().runTransaction(async tx => {
    const [snap, moveSnap] = await Promise.all([tx.get(ref), tx.get(moveRef)]);
    const cur = owned(uid, snap);
    if (!cur) throw notFound('product-not-found');
    if (moveSnap.exists) return { product: productView(id, cur), replayed: true };

    const variants = cur.variants || [];
    const variant = body.variantId ? variants.find(v => v.id === body.variantId) : null;
    if (variants.length && !variant) throw bad('variant-required');
    const have = variant ? variant.qty : (cur.qty || 0);
    if (expected != null && expected !== have) throw conflict('stock-changed', { available: have });
    const next = have + delta;
    if (next < 0) throw conflict('negative-stock', { available: have });
    if (next > MAX_STOCK) throw bad('adjust-delta');

    const patch = { updatedAt: now };
    if (variant) {
      patch.variants = variants.map(v => (v.id === variant.id ? Object.assign({}, v, { qty: next }) : v));
      patch.qty = patch.variants.reduce((n, v) => n + v.qty, 0);
    } else {
      patch.qty = next;
    }
    tx.update(ref, patch);
    tx.set(moveRef, Object.assign({
      ownerUid: uid, delta, qtyAfter: next, reason: 'adjust', note: text(body.note, 120), at: now
    }, variant ? { variantId: variant.id, variantLabel: variantLabel(variant) } : {}));
    return { product: productView(id, Object.assign({}, cur, patch)), replayed: false };
  });
}

async function listMoves(uid, productId) {
  const id = docId(productId);
  if (!id) throw bad('product-id');
  if (!owned(uid, await prodCol(uid).doc(id).get())) throw notFound('product-not-found');
  const snap = await moveCol(uid, id).orderBy('at', 'desc').limit(60).get();
  /* Two movements in one millisecond have no order of their own. The opening
     stock came first whatever the clock says, so it stays at the bottom. */
  const opening = m => (m.reason === 'opening' ? 1 : 0);
  return {
    moves: snap.docs.filter(s => owned(uid, s)).map(s => {
      const d = s.data();
      return {
        id: s.id, delta: d.delta, qtyAfter: d.qtyAfter, reason: d.reason,
        billId: d.billId || null, billNumber: d.billNumber || null, note: d.note || '',
        variantLabel: d.variantLabel || '', at: d.at
      };
    }).sort((a, b) => b.at - a.at || opening(a) - opening(b))
  };
}

/* ========================================================== COMPATIBILITY

   The groups are the catalogue's: Compatibility Management writes them and
   nothing here does. A product carries group ids, and "what fits this phone" is
   answered by the same modelGroups document the Device Finder reads. Compatibility
   is never inferred from a name, so a phone with no group finds nothing.

   What a group contains is the paid half of the catalogue, so a preview goes
   through entitlement-service and comes back cut to the caller's plan. Which
   groups a device is in is free, and is all that matching needs. */

async function tierOf(uid) {
  const ent = await entitlements.getUserEntitlement(uid, Date.now());
  return ent.isActive ? TIERS.PAID : TIERS.FREE;
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** One group, for the product form's preview. */
async function groupInfo(uid, query) {
  const id = groupId(query.id);
  if (!id) throw bad('group-id');
  const group = await entitlements.groupForUser(id, await tierOf(uid), { preview: true });
  if (!group) throw notFound('group-not-found');
  return { group };
}

/** The groups a device belongs to, for choosing which a product should link to. */
async function modelGroups(uid, query) {
  const id = modelId(query.modelId);
  const model = id ? search.loadIndex().byId.get(id) : null;
  if (!model) throw notFound('model-not-found');
  const tier = await tierOf(uid);
  const map = await entitlements.deviceGroupMap(id) || {};
  const part = query.partCategory ? text(query.partCategory, 40) : '';
  const categories = await Promise.all(Object.keys(map)
    .filter(c => (!part || c === part) && Array.isArray(map[c]) && map[c].length)
    .map(async c => ({
      categoryId: c,
      groups: (await Promise.all(map[c].map(g => entitlements.groupForUser(String(g), tier, { preview: true })))).filter(Boolean)
    })));
  return { model: { id, name: model.name, brandId: model.brandId }, categories };
}

/**
 * This shop's products that fit a device.
 *
 * A group merged into one of the device's groups still counts, because a link
 * made before the merge keeps its old id. A product appears once however many of
 * its groups match. A category with compatibility switched off keeps its links
 * but does not answer here.
 */
async function compatProducts(uid, query) {
  const id = modelId(query.modelId);
  if (!id) throw bad('model-id');
  const model = search.loadIndex().byId.get(id);
  if (!model) throw notFound('model-not-found');
  const out = { model: { id, name: model.name, brandId: model.brandId }, groupCount: 0, matches: [] };

  const groups = await entitlements.deviceGroupIds(id) || [];
  out.groupCount = groups.length;
  if (!groups.length) return out;

  const canonical = new Map(groups.map(g => [g, g]));
  for (const part of chunks(groups, QUERY_CHUNK)) {
    const merged = await db().collection(C.GROUPS).where('mergedInto', 'in', part).get();
    merged.docs.forEach(s => canonical.set(s.id, String(s.data().mergedInto)));
  }

  const found = new Map();
  for (const part of chunks(Array.from(canonical.keys()), QUERY_CHUNK)) {
    const snap = await prodCol(uid).where('groupIds', 'array-contains-any', part).get();
    snap.docs.forEach(s => found.set(s.id, s));
  }
  if (!found.size) return out;

  const cats = await catCol(uid).get();
  const enabled = new Set(cats.docs.filter(s => {
    const d = owned(uid, s);
    return d && d.compat && d.compat.enabled;
  }).map(s => s.id));

  found.forEach((s, productId) => {
    const d = owned(uid, s);
    if (!d || d.active === false || !enabled.has(d.categoryId)) return;
    const linked = Array.from(new Set((d.groupIds || []).filter(g => canonical.has(g)).map(g => canonical.get(g))));
    out.matches.push({ productId, groupIds: linked, groupId: linked[0] || null });
  });
  return out;
}

/* ================================================================== BILLS */

function readLines(raw) {
  if (!Array.isArray(raw) || !raw.length) throw bad('bill-empty');
  if (raw.length > money.MAX_LINES) throw bad('too-many-lines');
  return raw.map((l, i) => {
    l = l || {};
    const qty = int(l.qty, 1, money.MAX_QTY);
    const unitPaise = int(l.unitPaise, 0, money.MAX_UNIT_PAISE);
    if (qty == null) throw bad('line-qty', { line: i });
    if (unitPaise == null) throw bad('line-price', { line: i });
    if (l.productId) {
      const productId = docId(l.productId);
      if (!productId) throw bad('line-product', { line: i });
      const variantId = l.variantId ? docId(l.variantId) : '';
      if (l.variantId && !variantId) throw bad('line-variant', { line: i });
      return {
        productId, variantId: variantId || null, qty, unitPaise,
        selectedModelId: modelId(l.selectedModelId) || null,
        groupId: groupId(l.groupId) || null
      };
    }
    const name = text(l.name, 80);
    if (!name) throw bad('line-name', { line: i });
    return { productId: null, name, qty, unitPaise };
  });
}

function readAdjustments(body) {
  const d = body.discount || {};
  const discount = {
    mode: d.mode === 'percent' ? 'percent' : 'amount',
    value: d.value == null || d.value === '' ? 0 : d.value
  };
  const t = body.tax || {};
  const rate = t.rateBp == null || t.rateBp === '' ? 0 : t.rateBp;
  const tax = { rateBp: rate, inclusive: !!t.inclusive && rate > 0, label: rate > 0 ? (text(t.label, 16) || 'Tax') : '' };
  const p = body.payment || {};
  const payment = {
    method: money.PAYMENT_METHODS.includes(p.method) ? p.method : 'cash',
    status: money.PAYMENT_STATUSES.includes(p.status) ? p.status : null,
    receivedPaise: p.receivedPaise == null || p.receivedPaise === '' ? 0 : p.receivedPaise
  };
  return { discount, tax, payment };
}

function moneyError(totals) {
  return bad('bill-' + totals.error, totals.line == null ? {} : { line: totals.line });
}

/**
 * What was received, and what that makes the bill. "Paid" with nothing typed
 * means paid in full — the common case at a counter — and the status is then
 * always the one the amount implies, so a bill cannot say Paid with a
 * balance outstanding.
 */
function settle(totalPaise, payment) {
  let received = payment.receivedPaise;
  if (payment.status === 'emi') {
    /* the down payment is what was received; the plan is the rest of the bill */
    return {
      method: payment.method, status: 'emi', receivedPaise: received,
      balancePaise: Math.max(0, totalPaise - received), changePaise: 0
    };
  }
  if (payment.status === 'paid' && !received) received = totalPaise;
  if (payment.status === 'unpaid') received = 0;
  const status = money.statusFor(totalPaise, received);
  return {
    method: payment.method, status, receivedPaise: received,
    balancePaise: Math.max(0, totalPaise - received),
    changePaise: Math.max(0, received - totalPaise)
  };
}

/** Money actually kept against a bill: change handed back was never collected. */
const collectedOn = (totalPaise, payment) => Math.min(payment.receivedPaise || 0, totalPaise);

function blankCustomer(uid, c, now) {
  return {
    ownerUid: uid, name: c.name || '', nameKey: (c.name || '').toLowerCase(), mobile: c.mobile || '',
    whatsapp: c.whatsapp || '', address: c.address || '', gstin: c.gstin || '', notes: c.notes || '', status: 'active',
    billCount: 0, totalPaise: 0, paidPaise: 0, outstandingPaise: 0,
    firstBillAt: 0, lastBillAt: 0, createdAt: now, updatedAt: now
  };
}

function addToCustomer(c, totalPaise, collected, at) {
  c.billCount = (c.billCount || 0) + 1;
  c.totalPaise = (c.totalPaise || 0) + totalPaise;
  c.paidPaise = (c.paidPaise || 0) + collected;
  c.outstandingPaise = (c.outstandingPaise || 0) + Math.max(0, totalPaise - collected);
  c.firstBillAt = c.firstBillAt || at;
  c.lastBillAt = Math.max(c.lastBillAt || 0, at);
  c.updatedAt = at;
}

/**
 * Whose bill this is. An existing customer by id, or by mobile number, or a new
 * record when a number is given that nobody has. A bill with only a typed name
 * stays a walk-in: a name is not enough to say who someone is, and a guess would
 * put one person's purchases on another's history.
 */
async function findCustomer(tx, uid, input) {
  if (input.id) {
    const ref = custCol(uid).doc(input.id);
    const d = owned(uid, await tx.get(ref));
    if (!d) throw conflict('customer-missing');
    return { ref, id: input.id, d };
  }
  if (input.mobile.length < 10) return null;
  const id = 'm_' + input.mobile;
  const ref = custCol(uid).doc(id);
  const snap = await tx.get(ref);
  if (snap.exists) return { ref, id, d: owned(uid, snap) };
  const same = await tx.get(custCol(uid).where('mobile', '==', input.mobile).limit(1));
  const hit = same.docs.find(s => owned(uid, s));
  if (hit) return { ref: hit.ref, id: hit.id, d: hit.data() };
  return { ref, id, d: null };
}

/** The instalment terms the shop chose. The amounts are worked out from the bill. */
function readEmi(raw) {
  const e = raw || {};
  const months = int(e.months, 1, emiEngine.MAX_MONTHS);
  const rateBp = int(blank(e.rateBp) ? 0 : e.rateBp, 0, emiEngine.MAX_RATE_BP);
  if (months == null) throw bad('emi-months');
  if (rateBp == null) throw bad('emi-rate');
  if (!insights.isDay(e.firstDue)) throw bad('emi-first-due');
  return { months, rateBp, method: e.method === 'reducing' ? 'reducing' : 'flat', firstDue: e.firstDue };
}

/** Save ("finalise") a bill — see the header: once, atomically, numbered. */
async function finaliseBill(uid, body) {
  const fid = clientId(body.finalisationId);
  if (!fid) throw bad('finalisation-id');
  const lines = readLines(body.lines);
  const adj = readAdjustments(body);
  const check = money.computeBill(lines, adj.discount, adj.tax, 0);
  if (!check.ok) throw moneyError(check);
  const emiTerms = adj.payment.status === 'emi' ? readEmi(body.emi) : null;
  const paidByQr = settings.qrId(body.payment && body.payment.qrId);
  const typed = body.customer || {};
  const customer = {
    name: text(typed.name, 60),
    mobile: mobile(typed.mobile),
    whatsapp: mobile(typed.whatsapp),
    address: text(typed.address, 200),
    gstin: text(typed.gstin, 15).toUpperCase(),
    notes: text(typed.notes, 300)
  };
  const customerInput = Object.assign({}, customer, { id: typed.id ? docId(typed.id) : '' });
  const wanted = body.offers || {};
  const offerPicks = Array.isArray(wanted.picks) ? wanted.picks : [];

  const billRef = billCol(uid).doc(fid);
  const productIds = Array.from(new Set(lines.filter(l => l.productId).map(l => l.productId)));
  const productRefs = productIds.map(id => prodCol(uid).doc(id));
  const catalogue = search.loadIndex().byId;

  return transaction('finalise', async tx => {
    /* Every read first — Firestore requires it, and the replay check has to
       come before anything that could deduct stock. */
    const existing = owned(uid, await tx.get(billRef));
    if (existing) return { bill: billView(fid, existing), replayed: true };
    const now = Date.now();
    const today = insights.dayKey(now);
    const shopSnap = await tx.get(shopRef(uid));
    const productSnaps = productRefs.length ? await tx.getAll(...productRefs) : [];
    const cats = await readCategories(tx, uid);
    const catName = new Map(cats.map(c => [c.id, c.d.name]));
    const who = await findCustomer(tx, uid, customerInput);
    const daySnap = await tx.get(dayCol(uid).doc(today));
    const offerSnap = await tx.get(offerCol(uid).where('status', '==', 'active'));
    const qrSnap = paidByQr ? await tx.get(settings.qrRef(uid, paidByQr)) : null;

    const products = new Map();
    productSnaps.forEach((s, i) => {
      const d = owned(uid, s);
      if (!d) throw conflict('product-missing', { productId: productIds[i] });
      if (d.active === false) throw conflict('product-archived', { productId: productIds[i], name: d.name });
      products.set(productIds[i], d);
    });

    /* The stock each sellable thing is asked for: the product, or its variant. */
    const need = new Map();
    lines.forEach((l, i) => {
      if (!l.productId) return;
      const p = products.get(l.productId);
      const variants = p.variants || [];
      if (variants.length && !l.variantId) throw conflict('variant-required', { line: i, name: p.name });
      if (l.variantId && !variants.some(v => v.id === l.variantId)) throw conflict('variant-missing', { line: i, name: p.name });
      const key = l.productId + '|' + (l.variantId || '');
      need.set(key, (need.get(key) || 0) + l.qty);
    });
    const variantOf = (p, vid) => (vid ? (p.variants || []).find(v => v.id === vid) : null);

    const shortfalls = [];
    need.forEach((n, key) => {
      const [pid, vid] = key.split('|');
      const p = products.get(pid);
      const v = variantOf(p, vid);
      const have = v ? v.qty : (p.qty || 0);
      if (n > have) {
        shortfalls.push({
          productId: pid, variantId: vid || null, available: have, requested: n,
          name: v ? p.name + ' (' + variantLabel(v) + ')' : p.name
        });
      }
    });
    if (shortfalls.length) throw conflict('insufficient-stock', { shortfalls });

    /* The offers are worked out here, from this shop's own offers and products.
       What the browser showed is only compared against the answer. */
    const priced = offerEngine.applyOffers({
      now,
      auto: wanted.auto !== false,
      settings: offerSettings(owned(uid, shopSnap)),
      offers: offerSnap.docs.map(s => ({ s, d: owned(uid, s) })).filter(x => x.d).map(x => offerView(x.s.id, x.d)),
      lines: lines.map((l, i) => ({
        productId: l.productId, variantId: l.variantId || null, unitPaise: l.unitPaise, qty: l.qty,
        categoryId: l.productId ? products.get(l.productId).categoryId : null,
        pick: offerPicks[i] === 'none' ? 'none' : (docId(offerPicks[i]) || undefined)
      }))
    });
    const totals = money.computeBill(
      lines.map((l, i) => Object.assign({}, l, { offerPaise: priced.lines[i].offerPaise })), adj.discount, adj.tax, 0);
    if (!totals.ok) throw moneyError(totals);
    if (Number.isInteger(body.expectedTotalPaise) && body.expectedTotalPaise !== totals.totalPaise) {
      throw conflict('offers-changed', { totalPaise: totals.totalPaise });
    }
    const payment = settle(totals.totalPaise, adj.payment);
    if (!money.isInt(payment.receivedPaise) || payment.receivedPaise < 0 ||
        payment.receivedPaise > money.MAX_BILL_PAISE * 2) throw bad('bill-received');
    /* credit is given to someone: a plan with nobody to collect from is not one */
    if (emiTerms && !who) throw conflict('emi-customer');
    if (emiTerms && !payment.balancePaise) throw bad('emi-down');
    if (qrSnap) {
      /* Razorpay said this was paid, and it has not already settled another bill */
      const qr = owned(uid, qrSnap);
      if (!qr || qr.status !== 'paid') throw conflict('qr-unpaid');
      if (qr.billId) throw conflict('qr-used');
      if (qr.amountPaise !== collectedOn(totals.totalPaise, payment)) throw conflict('qr-amount', { amountPaise: qr.amountPaise });
      payment.razorpay = { qrId: paidByQr, paymentId: qr.paymentId || null };
    }

    const shop = owned(uid, shopSnap) || {};
    const seq = (shop.billSeq || 0) + 1;
    const number = money.billNumber(BILL_PREFIX, seq);

    const items = lines.map((l, i) => {
      const p = l.productId ? products.get(l.productId) : null;
      const v = p ? variantOf(p, l.variantId) : null;
      const model = p && l.selectedModelId ? catalogue.get(l.selectedModelId) : null;
      const cost = v ? v.costPaise : (p ? p.costPaise : null);
      return {
        lineNo: i + 1,
        productId: l.productId,
        variantId: v ? v.id : null,
        variantLabel: v ? variantLabel(v) : '',
        custom: !p,
        name: p ? p.name : l.name,
        shelf: p ? ((v && v.shelf) || p.shelf || '') : '',
        sku: p ? ((v && v.sku) || p.sku || '') : '',
        categoryName: p ? (catName.get(p.categoryId) || '') : '',
        unitPaise: l.unitPaise,
        offerPaise: priced.lines[i].offerPaise,
        finalUnitPaise: priced.lines[i].finalUnitPaise,
        /* The bill's own copy, so editing or pausing an offer cannot reach it. */
        offers: priced.lines[i].applied,
        listPaise: p ? (v ? v.pricePaise : p.pricePaise) : null,
        costPaise: cost == null ? null : cost,
        qty: l.qty,
        totalPaise: totals.lineTotals[i],
        /* The phone the customer asked about, kept apart from the product sold.
           Stock never moves on this: it is a note on the sale. */
        selectedModelId: model ? l.selectedModelId : null,
        selectedModelName: model ? model.name : '',
        groupId: model && l.groupId && (p.groupIds || []).includes(l.groupId) ? l.groupId : null
      };
    });

    const collected = collectedOn(totals.totalPaise, payment);
    const balance = Math.max(0, totals.totalPaise - collected);

    /* Who bought it, and what that does to their record. */
    let customerId = null;
    let customerRow = null;
    let firstBill = false;
    if (who) {
      customerId = who.id;
      customerRow = Object.assign({}, who.d || blankCustomer(uid, customerInput, now));
      firstBill = !customerRow.billCount;
      addToCustomer(customerRow, totals.totalPaise, collected, now);
      if (!customer.name) customer.name = customerRow.name;
      if (!customer.mobile) customer.mobile = customerRow.mobile;
      /* what was typed fills a gap on their record and never replaces it */
      ['whatsapp', 'address', 'gstin'].forEach(k => {
        if (!customerRow[k]) customerRow[k] = customer[k];
        if (!customer[k]) customer[k] = customerRow[k] || '';
      });
    }

    const bill = {
      ownerUid: uid,
      finalisationId: fid,
      number, seq,
      status: 'final',
      day: today,
      items,
      originalSubtotalPaise: totals.originalSubtotalPaise,
      offerDiscountPaise: totals.offerPaise,
      offersAuto: wanted.auto !== false,
      subtotalPaise: totals.subtotalPaise,
      discount: adj.discount,
      discountPaise: totals.discountPaise,
      tax: adj.tax,
      taxPaise: totals.taxPaise,
      totalPaise: totals.totalPaise,
      payment,
      customer,
      customerId,
      customerKey: customer.name.toLowerCase(),
      customerMobile: customer.mobile,
      staff: stamp(body.actor),
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, action: 'created', paymentStatus: payment.status, by: byName(body.actor) }]
    };
    if (emiTerms) {
      const plan = emiEngine.plan(Object.assign({ principalPaise: payment.balancePaise }, emiTerms));
      bill.emi = Object.assign(plan, { interestPaidPaise: 0 });
    }

    const day = daySnap.exists ? daySnap.data() : insights.emptyDay(today, uid);
    insights.addBill(day, bill, customerId ? { id: customerId, isNew: firstBill } : null);
    insights.addCollected(day, payment.method, collected);

    tx.set(shopRef(uid), Object.assign(
      {
        ownerUid: uid, billSeq: seq, updatedAt: now,
        customerCount: (shop.customerCount || 0) + (who && !who.d ? 1 : 0),
        outstandingPaise: (shop.outstandingPaise || 0) + balance
      },
      shopSnap.exists ? {} : { createdAt: now }
    ), { merge: true });

    products.forEach((p, id) => {
      let sold = 0;
      let qty = p.qty || 0;
      let variants = p.variants || [];
      need.forEach((n, key) => {
        const [pid, vid] = key.split('|');
        if (pid !== id) return;
        sold += n;
        if (vid) {
          const v = variants.find(x => x.id === vid);
          const qtyAfter = v.qty - n;
          variants = variants.map(x => (x.id === vid ? Object.assign({}, x, { qty: qtyAfter }) : x));
          tx.set(moveCol(uid, id).doc('bill_' + fid + '_' + vid), {
            ownerUid: uid, delta: -n, qtyAfter, reason: 'sale', billId: fid, billNumber: number,
            variantId: vid, variantLabel: variantLabel(v), at: now
          });
        } else {
          qty -= n;
          tx.set(moveCol(uid, id).doc('bill_' + fid), {
            ownerUid: uid, delta: -n, qtyAfter: qty, reason: 'sale', billId: fid, billNumber: number, at: now
          });
        }
      });
      const patch = { soldCount: (p.soldCount || 0) + sold, updatedAt: now };
      if (variants.length) {
        patch.variants = variants;
        patch.qty = variants.reduce((n, v) => n + v.qty, 0);
      } else {
        patch.qty = qty;
      }
      tx.update(prodCol(uid).doc(id), patch);
    });

    if (customerRow) tx.set(who.ref, customerRow);
    if (qrSnap) tx.update(qrSnap.ref, { billId: billRef.id });
    tx.set(dayCol(uid).doc(today), day);
    tx.create(billRef, bill);
    return {
      bill: billView(fid, bill),
      customer: customerRow ? customerView(customerId, customerRow) : null,
      replayed: false
    };
  /* Two tills saving at the same instant contend on the counter; the default
     five attempts is thin for a busy counter, and every retry is safe. */
  }, { maxAttempts: 10 });
}

/** Records money received against a saved bill, after the fact. */
async function updatePayment(uid, body) {
  const id = clientId(body.billId) || docId(body.billId);
  if (!id) throw bad('bill-id');
  const adj = readAdjustments({ payment: body.payment || body });
  const ref = billCol(uid).doc(id);
  return db().runTransaction(async tx => {
    const cur = owned(uid, await tx.get(ref));
    if (!cur) throw notFound('bill-not-found');
    if (cur.status === 'void') throw conflict('bill-void');
    if (cur.emi) throw conflict('bill-emi');
    const payment = settle(cur.totalPaise, adj.payment);
    if (!money.isInt(payment.receivedPaise) || payment.receivedPaise < 0 ||
        payment.receivedPaise > money.MAX_BILL_PAISE * 2) throw bad('bill-received');
    const now = Date.now();
    const today = insights.dayKey(now);
    const [shopSnap, daySnap, custSnap] = await Promise.all([
      tx.get(shopRef(uid)),
      tx.get(dayCol(uid).doc(today)),
      cur.customerId ? tx.get(custCol(uid).doc(cur.customerId)) : Promise.resolve(null)
    ]);

    /* The money moves on the day it arrived, not on the bill's day. */
    const delta = collectedOn(cur.totalPaise, payment) - collectedOn(cur.totalPaise, cur.payment || {});
    const shop = owned(uid, shopSnap) || {};
    tx.set(shopRef(uid), {
      ownerUid: uid, outstandingPaise: Math.max(0, (shop.outstandingPaise || 0) - delta), updatedAt: now
    }, { merge: true });
    if (delta) {
      const day = daySnap.exists ? daySnap.data() : insights.emptyDay(today, uid);
      insights.addCollected(day, payment.method, delta);
      tx.set(dayCol(uid).doc(today), day);
    }
    const c = custSnap ? owned(uid, custSnap) : null;
    if (c && delta) {
      tx.update(custSnap.ref, {
        paidPaise: (c.paidPaise || 0) + delta,
        outstandingPaise: Math.max(0, (c.outstandingPaise || 0) - delta),
        updatedAt: now
      });
    }

    const history = (cur.history || []).concat({
      at: now, action: 'payment', by: byName(body.actor),
      from: cur.payment && cur.payment.status, to: payment.status, receivedPaise: payment.receivedPaise
    }).slice(-50);
    tx.update(ref, { payment, history, updatedAt: now });
    return { bill: billView(id, Object.assign({}, cur, { payment, history, updatedAt: now })) };
  });
}

/**
 * One instalment of an EMI bill, received. The principal in it pays down the bill
 * and the interest is money on top of the bill, so the bill's total never moves.
 * Collecting the same instalment twice changes nothing the second time.
 */
async function payInstalment(uid, body) {
  const id = clientId(body.billId) || docId(body.billId);
  if (!id) throw bad('bill-id');
  const no = int(body.no, 1, emiEngine.MAX_MONTHS);
  if (no == null) throw bad('emi-instalment');
  const method = money.PAYMENT_METHODS.includes(body.method) ? body.method : 'cash';
  const ref = billCol(uid).doc(id);
  return transaction('instalment', async tx => {
    const cur = owned(uid, await tx.get(ref));
    if (!cur) throw notFound('bill-not-found');
    if (cur.status === 'void') throw conflict('bill-void');
    if (!cur.emi) throw conflict('bill-not-emi');
    const item = cur.emi.schedule.find(s => s.no === no);
    if (!item) throw bad('emi-instalment');
    if (item.paidAt) return { bill: billView(id, cur), replayed: true };

    const now = Date.now();
    const today = insights.dayKey(now);
    const [shopSnap, daySnap, custSnap] = await Promise.all([
      tx.get(shopRef(uid)),
      tx.get(dayCol(uid).doc(today)),
      cur.customerId ? tx.get(custCol(uid).doc(cur.customerId)) : Promise.resolve(null)
    ]);

    const schedule = cur.emi.schedule.map(s => (s.no === no ? Object.assign({}, s, { paidAt: now, paidMethod: method }) : s));
    const emi = Object.assign({}, cur.emi, {
      schedule, interestPaidPaise: (cur.emi.interestPaidPaise || 0) + item.interestPaise
    });
    const receivedPaise = (cur.payment.receivedPaise || 0) + item.principalPaise;
    const balancePaise = Math.max(0, cur.totalPaise - receivedPaise);
    const payment = Object.assign({}, cur.payment, {
      method, receivedPaise, balancePaise, status: schedule.every(s => s.paidAt) ? 'paid' : 'emi'
    });

    const day = daySnap.exists ? daySnap.data() : insights.emptyDay(today, uid);
    insights.addCollected(day, method, item.amountPaise);
    tx.set(dayCol(uid).doc(today), day);

    const shop = owned(uid, shopSnap) || {};
    tx.set(shopRef(uid), {
      ownerUid: uid, outstandingPaise: Math.max(0, (shop.outstandingPaise || 0) - item.principalPaise), updatedAt: now
    }, { merge: true });
    const c = custSnap ? owned(uid, custSnap) : null;
    if (c) {
      tx.update(custSnap.ref, {
        paidPaise: (c.paidPaise || 0) + item.principalPaise,
        outstandingPaise: Math.max(0, (c.outstandingPaise || 0) - item.principalPaise),
        updatedAt: now
      });
    }

    const history = (cur.history || []).concat({ at: now, action: 'instalment', no, amountPaise: item.amountPaise, method, by: byName(body.actor) }).slice(-80);
    tx.update(ref, { payment, emi, history, updatedAt: now });
    return { bill: billView(id, Object.assign({}, cur, { payment, emi, history, updatedAt: now })), replayed: false };
  });
}

/**
 * Voids a saved bill and puts its stock back. Voiding twice is answered with
 * the already-void bill and restores nothing the second time.
 */
async function voidBill(uid, body) {
  const id = clientId(body.billId) || docId(body.billId);
  if (!id) throw bad('bill-id');
  const reason = text(body.reason, 200);
  if (!reason) throw bad('void-reason');
  const ref = billCol(uid).doc(id);
  return transaction('void', async tx => {
    const cur = owned(uid, await tx.get(ref));
    if (!cur) throw notFound('bill-not-found');
    if (cur.status === 'void') return { bill: billView(id, cur), replayed: true };

    const need = new Map();
    (cur.items || []).forEach(i => {
      if (!i.productId) return;
      const key = i.productId + '|' + (i.variantId || '');
      need.set(key, (need.get(key) || 0) + i.qty);
    });
    const ids = Array.from(new Set(Array.from(need.keys()).map(k => k.split('|')[0])));
    const snaps = ids.length ? await tx.getAll(...ids.map(pid => prodCol(uid).doc(pid))) : [];
    const now = Date.now();
    const today = insights.dayKey(now);
    const billDay = cur.day || insights.dayKey(cur.createdAt);
    const [shopSnap, billDaySnap, todaySnap, custSnap] = await Promise.all([
      tx.get(shopRef(uid)),
      tx.get(dayCol(uid).doc(billDay)),
      tx.get(dayCol(uid).doc(today)),
      cur.customerId ? tx.get(custCol(uid).doc(cur.customerId)) : Promise.resolve(null)
    ]);

    const restored = [];
    snaps.forEach((s, i) => {
      const p = owned(uid, s);
      if (!p) return;
      const pid = ids[i];
      let qty = p.qty || 0;
      let variants = p.variants || [];
      let back = 0;
      need.forEach((n, key) => {
        const [kp, vid] = key.split('|');
        if (kp !== pid) return;
        back += n;
        const has = vid && variants.find(v => v.id === vid);
        /* A variant deleted since the sale has nowhere to go back to: the
           sold count is corrected and the bill says what was restored. */
        if (vid && !has) return;
        if (has) {
          const qtyAfter = Math.min(MAX_STOCK, has.qty + n);
          variants = variants.map(v => (v.id === vid ? Object.assign({}, v, { qty: qtyAfter }) : v));
          tx.set(moveCol(uid, pid).doc('void_' + id + '_' + vid), {
            ownerUid: uid, delta: n, qtyAfter, reason: 'void', billId: id, billNumber: cur.number,
            variantId: vid, variantLabel: variantLabel(has), note: reason, at: now
          });
        } else {
          qty = Math.min(MAX_STOCK, qty + n);
          tx.set(moveCol(uid, pid).doc('void_' + id), {
            ownerUid: uid, delta: n, qtyAfter: qty, reason: 'void', billId: id, billNumber: cur.number, note: reason, at: now
          });
        }
        restored.push({ productId: pid, variantId: vid || null, qty: n });
      });
      const patch = { soldCount: Math.max(0, (p.soldCount || 0) - back), updatedAt: now };
      if (variants.length) {
        patch.variants = variants;
        patch.qty = variants.reduce((n, v) => n + v.qty, 0);
      } else {
        patch.qty = qty;
      }
      tx.update(s.ref, patch);
    });

    const collected = collectedOn(cur.totalPaise, cur.payment || {});
    const balance = Math.max(0, cur.totalPaise - collected);

    const dayDoc = billDaySnap.exists ? billDaySnap.data() : insights.emptyDay(billDay, uid);
    insights.removeBill(dayDoc, cur);
    const refundDay = billDay === today ? dayDoc
      : (todaySnap.exists ? todaySnap.data() : insights.emptyDay(today, uid));
    refundDay.refundedPaise += collected + ((cur.emi && cur.emi.interestPaidPaise) || 0);
    tx.set(dayCol(uid).doc(billDay), dayDoc);
    if (refundDay !== dayDoc) tx.set(dayCol(uid).doc(today), refundDay);

    const shop = owned(uid, shopSnap) || {};
    tx.set(shopRef(uid), {
      ownerUid: uid, outstandingPaise: Math.max(0, (shop.outstandingPaise || 0) - balance), updatedAt: now
    }, { merge: true });

    const c = custSnap ? owned(uid, custSnap) : null;
    if (c) {
      tx.update(custSnap.ref, {
        billCount: Math.max(0, (c.billCount || 0) - 1),
        totalPaise: Math.max(0, (c.totalPaise || 0) - cur.totalPaise),
        paidPaise: Math.max(0, (c.paidPaise || 0) - collected),
        outstandingPaise: Math.max(0, (c.outstandingPaise || 0) - balance),
        updatedAt: now
      });
    }

    const history = (cur.history || []).concat({ at: now, action: 'void', reason, restored, by: byName(body.actor) }).slice(-50);
    const patch = { status: 'void', voidedAt: now, voidReason: reason, history, updatedAt: now };
    tx.update(ref, patch);
    return { bill: billView(id, Object.assign({}, cur, patch)), restored, replayed: false };
  });
}

async function getBill(uid, billId) {
  const id = clientId(billId) || docId(billId);
  if (!id) throw bad('bill-id');
  const d = owned(uid, await billCol(uid).doc(id).get());
  if (!d) throw notFound('bill-not-found');
  return { bill: billView(id, d) };
}

/**
 * Bill history, newest first, a page at a time — or a search.
 *
 *   "QB-0012", "12"       that bill number
 *   six digits or more    a customer mobile number, by prefix
 *   anything else         a customer name, by prefix
 *   from, to              a time range, for the Overview's drill-down
 *
 * Each is a range on ONE field, which Firestore indexes on its own: nothing
 * here needs an entry in firestore.indexes.json.
 */
async function listBills(uid, query) {
  const limit = Math.min(MAX_BILL_PAGE, Math.max(5, Number(query.limit) || 20));
  const q = text(query.q, 60);
  const from = Number(query.from) || 0;
  const to = Number(query.to) || 0;
  let ref = billCol(uid);
  let paged = false;
  let cursorField = 'seq';

  if (q) {
    const num = /^(?:qb)?\s*-?\s*0*(\d{1,7})$/i.exec(q);
    const digits = q.replace(/\D/g, '');
    if (num && (/^qb/i.test(q) || digits.length <= 5)) {
      ref = ref.where('seq', '==', Number(num[1]));
    } else if (/^\+?[\d\s-]{6,}$/.test(q)) {
      const m = mobile(digits);
      ref = ref.where('customerMobile', '>=', m).where('customerMobile', '<=', m + PREFIX_END).orderBy('customerMobile');
    } else {
      const k = q.toLowerCase();
      ref = ref.where('customerKey', '>=', k).where('customerKey', '<=', k + PREFIX_END).orderBy('customerKey');
    }
    ref = ref.limit(limit);
  } else if (from || to) {
    const cursor = Number(query.cursor);
    const end = Number.isInteger(cursor) && cursor > 0 ? cursor : (to || Number.MAX_SAFE_INTEGER);
    ref = ref.where('createdAt', '>=', from).where('createdAt', '<', end).orderBy('createdAt', 'desc').limit(limit);
    paged = true;
    cursorField = 'createdAt';
  } else {
    const cursor = Number(query.cursor);
    ref = ref.orderBy('seq', 'desc');
    if (Number.isInteger(cursor) && cursor > 0) ref = ref.where('seq', '<', cursor);
    ref = ref.limit(limit);
    paged = true;
  }

  const snap = await ref.get();
  const bills = snap.docs.filter(s => owned(uid, s)).map(s => billSummary(s.id, s.data()));
  if (q) bills.sort((a, b) => b.seq - a.seq);
  return {
    bills,
    nextCursor: paged && bills.length === limit ? bills[bills.length - 1][cursorField] : null
  };
}

/* ================================================================== OFFERS

   Created, edited, paused and ended here. Which offer a bill gets is decided in
   src/data/shop-offers.js, by the same code the cart runs. */

const IST = '+05:30';

function offerMoment(date, time, field, fallback) {
  if (!blank(time) && blank(date)) throw bad('offer-dates', { field });
  if (blank(date)) return { date: '', time: '', at: null };
  const d = String(date);
  const t = blank(time) ? '' : String(time);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || (t && !/^\d{2}:\d{2}$/.test(t))) throw bad('offer-dates', { field });
  const at = Date.parse(d + 'T' + (t || fallback) + IST);
  if (!Number.isFinite(at)) throw bad('offer-dates', { field });
  return { date: d, time: t, at };
}

function idList(raw, read) {
  const list = Array.from(new Set((Array.isArray(raw) ? raw : []).map(read).filter(Boolean)));
  if (list.length > MAX_OFFER_TARGETS) throw bad('offer-target');
  return list;
}

/** An offer that can still be changed. A removed one is gone as far as the shop goes. */
function liveOffer(uid, snap) {
  const d = owned(uid, snap);
  if (!d || d.status === 'archived') throw notFound('offer-not-found');
  return d;
}

/** Everything about an offer that the form sets, checked. */
function offerFields(body) {
  const name = text(body.name, 80);
  if (!name) throw bad('offer-name');
  const kind = body.kind === 'fixed' ? 'fixed' : 'percent';
  const out = {
    name, description: text(body.description, 300), kind,
    percentBp: null, amountPaise: null, fixedMode: 'unit', maxPaise: null
  };
  if (kind === 'percent') {
    out.percentBp = int(body.percentBp, 1, 10000);
    if (out.percentBp == null) throw bad('offer-value');
    if (!blank(body.maxPaise)) {
      out.maxPaise = int(body.maxPaise, 1, money.MAX_UNIT_PAISE);
      if (out.maxPaise == null) throw bad('offer-max');
    }
  } else {
    out.amountPaise = int(body.amountPaise, 1, money.MAX_UNIT_PAISE);
    if (out.amountPaise == null) throw bad('offer-value');
    out.fixedMode = body.fixedMode === 'line' ? 'line' : 'unit';
  }

  out.target = ['category', 'product', 'variant'].includes(body.target) ? body.target : null;
  if (!out.target) throw bad('offer-target');
  out.categoryIds = out.target === 'category' ? idList(body.categoryIds, docId) : [];
  out.productIds = out.target === 'product' ? idList(body.productIds, docId) : [];
  const seen = new Set();
  out.variants = out.target !== 'variant' ? [] : (Array.isArray(body.variants) ? body.variants : []).map(v => ({
    productId: docId(v && v.productId), variantId: docId(v && v.variantId)
  })).filter(v => {
    const key = v.productId + '|' + v.variantId;
    if (!v.productId || !v.variantId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (out.variants.length > MAX_OFFER_TARGETS) throw bad('offer-target');
  if (!out.categoryIds.length && !out.productIds.length && !out.variants.length) throw bad('offer-target');

  const start = offerMoment(body.startDate, body.startTime, 'start', '00:00:00'.slice(0, 5));
  const end = offerMoment(body.endDate, body.endTime, 'end', '23:59');
  out.startDate = start.date; out.startTime = start.time; out.startAt = start.at;
  out.endDate = end.date; out.endTime = end.time;
  /* an end with no time runs to the end of that minute; with one, to the minute named */
  out.endAt = end.at == null ? null : end.at + 59999;
  if (out.startAt != null && out.endAt != null && out.endAt <= out.startAt) throw bad('offer-dates', { field: 'end' });

  out.minQty = int(blank(body.minQty) ? 1 : body.minQty, 1, money.MAX_QTY);
  if (out.minQty == null) throw bad('offer-min-qty');
  out.minBillPaise = int(blank(body.minBillPaise) ? 0 : body.minBillPaise, 0, money.MAX_BILL_PAISE);
  if (out.minBillPaise == null) throw bad('offer-min-bill');
  out.priority = int(blank(body.priority) ? 100 : body.priority, 1, 999);
  if (out.priority == null) throw bad('offer-priority');
  out.stackable = !!body.stackable;
  out.status = body.status === 'paused' ? 'paused' : 'active';
  return out;
}

/** Every category, product and variant named has to be this shop's own. */
async function checkOfferTargets(uid, o) {
  if (o.target === 'category') {
    const snaps = await Promise.all(o.categoryIds.map(id => catCol(uid).doc(id).get()));
    if (snaps.some(s => !owned(uid, s))) throw bad('offer-target');
    return;
  }
  const ids = o.target === 'product' ? o.productIds : Array.from(new Set(o.variants.map(v => v.productId)));
  const snaps = await Promise.all(ids.map(id => prodCol(uid).doc(id).get()));
  const products = new Map();
  snaps.forEach((s, i) => {
    const d = owned(uid, s);
    if (!d) throw bad('offer-target');
    products.set(ids[i], d);
  });
  const tooLarge = (price, name) => {
    if (o.kind === 'fixed' && o.fixedMode === 'unit' && o.amountPaise > price) throw bad('offer-too-large', { name });
  };
  if (o.target === 'product') {
    products.forEach(p => tooLarge(p.pricePaise, p.name));
    return;
  }
  o.variants.forEach(v => {
    const p = products.get(v.productId);
    const found = (p.variants || []).find(x => x.id === v.variantId);
    if (!found) throw bad('offer-target');
    tooLarge(found.pricePaise, p.name);
  });
}

async function createOffer(uid, body) {
  const id = clientId(body.offerId);
  if (!id) throw bad('offer-id');
  const fields = offerFields(body);
  await checkOfferTargets(uid, fields);
  const ref = offerCol(uid).doc(id);
  return db().runTransaction(async tx => {
    const before = owned(uid, await tx.get(ref));
    if (before) return { offer: offerView(id, before), replayed: true };
    const shop = owned(uid, await tx.get(shopRef(uid))) || {};
    const now = Date.now();
    const d = Object.assign({ ownerUid: uid }, fields, {
      autoApply: body.autoApply === undefined ? offerSettings(shop).autoApplyDefault : !!body.autoApply,
      createdBy: uid, updatedBy: uid, createdAt: now, updatedAt: now
    });
    tx.set(ref, d);
    return { offer: offerView(id, d), replayed: false };
  });
}

async function updateOffer(uid, body) {
  const id = docId(body.offerId);
  if (!id) throw bad('offer-id');
  const fields = offerFields(body);
  await checkOfferTargets(uid, fields);
  const ref = offerCol(uid).doc(id);
  return db().runTransaction(async tx => {
    const cur = liveOffer(uid, await tx.get(ref));
    const patch = Object.assign({}, fields, {
      autoApply: body.autoApply === undefined ? cur.autoApply !== false : !!body.autoApply,
      updatedBy: uid, updatedAt: Date.now()
    });
    tx.update(ref, patch);
    return { offer: offerView(id, Object.assign({}, cur, patch)) };
  });
}

/** Pause, resume or end an offer. New bills see the change at once; old bills never do. */
async function setOfferStatus(uid, body) {
  const id = docId(body.offerId);
  if (!id) throw bad('offer-id');
  const status = ['active', 'paused', 'expired'].includes(body.status) ? body.status : null;
  if (!status) throw bad('offer-status');
  const ref = offerCol(uid).doc(id);
  return db().runTransaction(async tx => {
    const cur = liveOffer(uid, await tx.get(ref));
    const now = Date.now();
    if (status === 'active' && cur.endAt && now > cur.endAt) throw conflict('offer-ended');
    const patch = { status, updatedBy: uid, updatedAt: now };
    tx.update(ref, patch);
    return { offer: offerView(id, Object.assign({}, cur, patch)) };
  });
}

async function setOfferAuto(uid, body) {
  const id = docId(body.offerId);
  if (!id) throw bad('offer-id');
  const ref = offerCol(uid).doc(id);
  return db().runTransaction(async tx => {
    const cur = liveOffer(uid, await tx.get(ref));
    const patch = { autoApply: !!body.autoApply, updatedBy: uid, updatedAt: Date.now() };
    tx.update(ref, patch);
    return { offer: offerView(id, Object.assign({}, cur, patch)) };
  });
}

/**
 * Takes an offer off the shop's list for good: the Discounts & Offers page, its
 * figures and new bills stop seeing it. The record stays, marked with who removed
 * it and why, because a saved bill may name it. `reason` 'test-data' marks a record
 * that was never a real offer. Removing twice changes nothing.
 */
async function archiveOffer(uid, body) {
  const id = docId(body.offerId);
  if (!id) throw bad('offer-id');
  const reason = body.reason === 'test-data' ? 'test-data' : 'owner';
  const ref = offerCol(uid).doc(id);
  return db().runTransaction(async tx => {
    const cur = owned(uid, await tx.get(ref));
    if (!cur) throw notFound('offer-not-found');
    if (cur.status === 'archived') return { offerId: id, replayed: true };
    const now = Date.now();
    tx.update(ref, {
      status: 'archived', archivedFrom: cur.status, archivedReason: reason,
      archivedBy: uid, archivedAt: now, updatedBy: uid, updatedAt: now
    });
    return { offerId: id, replayed: false };
  });
}

/** The shop's defaults. A saved offer keeps its own Auto Apply whatever these say. */
async function saveOfferSettings(uid, body) {
  const settings = {
    autoApplyDefault: !!body.autoApplyDefault,
    billAutoApply: !!body.billAutoApply,
    stacking: !!body.stacking,
    order: body.order === 'priority' ? 'priority' : 'specific'
  };
  await shopRef(uid).set({ ownerUid: uid, offerSettings: settings, updatedAt: Date.now() }, { merge: true });
  return { offerSettings: settings };
}

/* ========================================================= SHARED INVOICES

   A link a shop can put in a WhatsApp message. Whoever holds it sees that one
   invoice and nothing else, with no sign-in, so the token is the only thing
   protecting it: 144 random bits, made once per bill, and only when the shop
   asks to share. Reopening or resending uses the same link. */


async function shareBill(uid, body) {
  const id = docId(body.billId);
  if (!id) throw bad('bill-id');
  const ref = billCol(uid).doc(id);
  return db().runTransaction(async tx => {
    const bill = owned(uid, await tx.get(ref));
    if (!bill) throw notFound('bill-not-found');
    if (bill.shareToken) return { token: bill.shareToken };
    const token = crypto.randomBytes(18).toString('base64url');
    const now = Date.now();
    tx.create(db().collection(C.INVOICE_LINKS).doc(token), { uid, billId: id, createdAt: now });
    tx.update(ref, { shareToken: token, updatedAt: now });
    return { token };
  });
}

/** The page behind a link, or a refusal that says nothing about why. */
async function sharedInvoice(query) {
  const token = String(query.t || '');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw notFound('invoice-not-found');
  const link = await db().collection(C.INVOICE_LINKS).doc(token).get();
  if (!link.exists) throw notFound('invoice-not-found');
  const { uid, billId } = link.data();
  const billSnap = await billCol(uid).doc(billId).get();
  const bill = owned(uid, billSnap);
  if (!bill || bill.shareToken !== token) throw notFound('invoice-not-found');
  return invoicePage(bill, settings.invoiceHeader(await settings.storeOf(uid)));
}

/* ============================================================== CUSTOMERS

   A customer belongs to one shop. Whoever holds a mobile number holds the
   document m_<number>, so the same number cannot become two customers even from
   two tills at once. Their totals move in the same transaction as their bills. */

function customerFields(body, partial) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = text(body.name, 60);
    if (!out.name) throw bad('customer-name');
    out.nameKey = out.name.toLowerCase();
  }
  if (!partial || body.mobile !== undefined) {
    out.mobile = mobile(body.mobile);
    if (out.mobile && out.mobile.length < 10) throw bad('customer-mobile');
  }
  if (!partial || body.whatsapp !== undefined) {
    out.whatsapp = mobile(body.whatsapp);
    if (out.whatsapp && out.whatsapp.length < 10) throw bad('customer-whatsapp');
  }
  if (!partial || body.address !== undefined) out.address = text(body.address, 200);
  if (!partial || body.gstin !== undefined) out.gstin = text(body.gstin, 15).toUpperCase();
  if (!partial || body.notes !== undefined) out.notes = text(body.notes, 300);
  if (body.status !== undefined) out.status = body.status === 'inactive' ? 'inactive' : 'active';
  return out;
}

async function createCustomer(uid, body) {
  const fields = customerFields(body, false);
  const now = Date.now();
  const id = fields.mobile ? 'm_' + fields.mobile : clientId(body.customerId);
  if (!id) throw bad('customer-id');
  const ref = custCol(uid).doc(id);
  return db().runTransaction(async tx => {
    const shopSnap = await tx.get(shopRef(uid));
    const existing = owned(uid, await tx.get(ref));
    if (existing) {
      if (!fields.mobile) return { customer: customerView(id, existing), replayed: true };
      throw conflict('customer-exists', { customer: customerView(id, existing) });
    }
    if (fields.mobile) {
      const same = await tx.get(custCol(uid).where('mobile', '==', fields.mobile).limit(1));
      const hit = same.docs.find(s => owned(uid, s));
      if (hit) throw conflict('customer-exists', { customer: customerView(hit.id, hit.data()) });
    }
    const d = Object.assign(blankCustomer(uid, fields, now), fields);
    const shop = owned(uid, shopSnap) || {};
    tx.set(ref, d);
    tx.set(shopRef(uid), { ownerUid: uid, customerCount: (shop.customerCount || 0) + 1, updatedAt: now }, { merge: true });
    return { customer: customerView(id, d), replayed: false };
  });
}

async function updateCustomer(uid, body) {
  const id = docId(body.customerId);
  if (!id) throw bad('customer-id');
  const patch = customerFields(body, true);
  const ref = custCol(uid).doc(id);
  return db().runTransaction(async tx => {
    const cur = owned(uid, await tx.get(ref));
    if (!cur) throw notFound('customer-not-found');
    if (patch.mobile && patch.mobile !== cur.mobile) {
      const same = await tx.get(custCol(uid).where('mobile', '==', patch.mobile).limit(1));
      const taken = same.docs.find(s => s.id !== id && owned(uid, s));
      const held = owned(uid, await tx.get(custCol(uid).doc('m_' + patch.mobile)));
      if (taken || (held && 'm_' + patch.mobile !== id)) throw conflict('customer-mobile-taken');
    }
    patch.updatedAt = Date.now();
    tx.update(ref, patch);
    return { customer: customerView(id, Object.assign({}, cur, patch)) };
  });
}

/** The shop's customers, a page at a time, or a search by name or mobile. */
async function listCustomers(uid, query) {
  const limit = Math.min(50, Math.max(5, Number(query.limit) || 25));
  const q = text(query.q, 60);
  if (q) {
    const digits = q.replace(/\D/g, '');
    const ref = /^\+?[\d\s-]{3,}$/.test(q)
      ? custCol(uid).where('mobile', '>=', mobile(digits)).where('mobile', '<=', mobile(digits) + PREFIX_END).orderBy('mobile')
      : custCol(uid).where('nameKey', '>=', q.toLowerCase()).where('nameKey', '<=', q.toLowerCase() + PREFIX_END).orderBy('nameKey');
    const snap = await ref.limit(limit).get();
    return { customers: snap.docs.filter(s => owned(uid, s)).map(s => customerView(s.id, s.data())), nextCursor: null };
  }

  const now = Date.now();
  const since = Number(query.since) || now - NEW_CUSTOMER_WINDOW_MS;
  const filters = {
    all: { field: 'createdAt' },
    recent: { field: 'lastBillAt', where: ['lastBillAt', '>', 0] },
    top: { field: 'totalPaise', where: ['totalPaise', '>', 0] },
    repeat: { field: 'billCount', where: ['billCount', '>=', 2] },
    new: { field: 'firstBillAt', where: ['firstBillAt', '>=', since] },
    outstanding: { field: 'outstandingPaise', where: ['outstandingPaise', '>', 0] }
  };
  const f = filters[query.filter] || filters.all;
  let ref = custCol(uid);
  if (f.where) ref = ref.where(f.where[0], f.where[1], f.where[2]);
  ref = ref.orderBy(f.field, 'desc').orderBy('__name__', 'desc');

  const cursor = /^(-?\d+)\|([A-Za-z0-9_-]{1,64})$/.exec(String(query.cursor || ''));
  if (cursor) ref = ref.startAfter(Number(cursor[1]), cursor[2]);
  const snap = await ref.limit(limit).get();
  const docs = snap.docs.filter(s => owned(uid, s));
  const last = docs[docs.length - 1];
  return {
    customers: docs.map(s => customerView(s.id, s.data())),
    nextCursor: docs.length === limit && last ? last.data()[f.field] + '|' + last.id : null
  };
}

/** One customer, their bills, and what those bills add up to. */
async function getCustomer(uid, query) {
  const id = docId(query.id);
  if (!id) throw bad('customer-id');
  const d = owned(uid, await custCol(uid).doc(id).get());
  if (!d) throw notFound('customer-not-found');

  const snap = await billCol(uid).where('customerId', '==', id).limit(300).get();
  const bills = snap.docs.filter(s => owned(uid, s)).map(s => ({ id: s.id, d: s.data() }))
    .sort((a, b) => b.d.createdAt - a.d.createdAt);
  const live = bills.filter(b => b.d.status !== 'void');

  const days = new Set(live.map(b => b.d.day || insights.dayKey(b.d.createdAt)));
  const bought = new Map();
  live.forEach(b => (b.d.items || []).forEach(it => {
    const row = bought.get(it.name) || { name: it.name, qty: 0, revenuePaise: 0 };
    row.qty += it.qty;
    row.revenuePaise += it.totalPaise;
    bought.set(it.name, row);
  }));

  const payments = [];
  live.forEach(b => (b.d.history || []).forEach(h => {
    if (h.action === 'payment') payments.push({ at: h.at, billId: b.id, number: b.d.number, receivedPaise: h.receivedPaise, to: h.to });
  }));

  return {
    customer: customerView(id, d),
    insights: {
      visits: days.size,
      firstTime: live.length <= 1,
      topProducts: Array.from(bought.values()).sort((a, b) => b.qty - a.qty).slice(0, 5)
    },
    payments: payments.sort((a, b) => b.at - a.at),
    bills: bills.map(b => Object.assign(billSummary(b.id, b.d), {
      items: (b.d.items || []).map(it => ({
        name: it.name, variantLabel: it.variantLabel || '', qty: it.qty,
        selectedModelName: it.selectedModelName || '', totalPaise: it.totalPaise
      })),
      day: b.d.day || insights.dayKey(b.d.createdAt)
    }))
  };
}

/* =============================================================== OVERVIEW */

/**
 * The dashboard, from day documents and nothing else: see shop-insights. A
 * period of a month reads about seventy documents however many bills it held.
 */
async function overview(uid, query) {
  const today = insights.dayKey(Date.now());
  const from = insights.isDay(query.from) ? query.from : insights.addDays(today, -29);
  let to = insights.isDay(query.to) ? query.to : today;
  if (to > today) to = today;
  if (from > to) throw bad('range');
  if (insights.daysBetween(from, to) > 366) throw bad('range-too-long');

  const earliest = insights.earliestNeeded(from, to, today);
  const [snap, shopSnap] = await Promise.all([
    dayCol(uid).where('day', '>=', earliest).where('day', '<=', today).orderBy('day').get(),
    shopRef(uid).get()
  ]);
  const docs = snap.docs.filter(s => owned(uid, s)).map(s => s.data());
  const shop = owned(uid, shopSnap) || {};
  return Object.assign(insights.overview(docs, { today, from, to }), {
    todayKey: today,
    shop: { customerCount: shop.customerCount || 0, outstandingPaise: shop.outstandingPaise || 0 }
  });
}

/**
 * A day from before the days counted their discounted bills gets the counts from
 * its own bills, once. In a transaction on the day, so a bill saved at the same
 * moment makes this run again rather than being missed.
 */
function settleDiscounted(uid, day) {
  const ref = dayCol(uid).doc(day);
  return db().runTransaction(async tx => {
    const cur = owned(uid, await tx.get(ref));
    if (!cur || cur.discV) return cur;
    const bills = await tx.get(billCol(uid).where('day', '==', day));
    const counts = insights.discountedOf(bills.docs.filter(s => owned(uid, s)).map(s => s.data()));
    tx.update(ref, counts);
    return Object.assign({}, cur, counts);
  });
}

/** The Sales Overview, from day documents: at most one read per day of the period. */
async function salesOverview(uid, query) {
  const today = insights.dayKey(Date.now());
  const from = insights.isDay(query.from) ? query.from : today.slice(0, 8) + '01';
  let to = insights.isDay(query.to) ? query.to : today;
  if (to > today) to = today;
  if (from > to) throw bad('range');
  if (insights.daysBetween(from, to) > 366) throw bad('range-too-long');

  const snap = await dayCol(uid).where('day', '>=', from).where('day', '<=', to).orderBy('day').get();
  const days = await Promise.all(snap.docs.filter(s => owned(uid, s)).map(s => {
    const d = s.data();
    return !d.discV && d.discountPaise ? settleDiscounted(uid, d.day) : d;
  }));
  return Object.assign(insights.salesOverview(days.filter(Boolean)), { from, to });
}

module.exports = {
  ShopError, SUGGESTED_CATEGORIES, BILL_PREFIX,
  loadState,
  createCategory, addSuggested, renameCategory, updateCategory, reorderCategories, deleteCategory,
  createProduct, updateProduct, archiveProduct, adjustStock, listMoves,
  groupInfo, modelGroups, compatProducts,
  finaliseBill, updatePayment, payInstalment, voidBill, getBill, listBills, shareBill, sharedInvoice,
  createOffer, updateOffer, setOfferStatus, setOfferAuto, archiveOffer, saveOfferSettings,
  createCustomer, updateCustomer, listCustomers, getCustomer,
  overview, salesOverview,
  /* exported for tests */
  _internal: { text, clientId, decodeImage, settle, mobile }
};
