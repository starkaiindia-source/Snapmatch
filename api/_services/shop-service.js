/* ============================================================================
   Mobile Parts Finder · api/_services/shop-service.js — Quick Billing
   ----------------------------------------------------------------------------
   A shop's own categories, products, stock and bills. Completely separate from
   the Device Finder catalogue: nothing here reads a master model or a
   compatibility group, and nothing the catalogue serves reads this.

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
     · the bill is written with a SNAPSHOT of every item — name, price, shelf —
       so renaming or repricing a product later does not rewrite history

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

class ShopError extends Error {
  /** @param {number} status  @param {string} code  @param {object} [extra] */
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}
const bad = (code, extra) => new ShopError(400, code, extra);
const notFound = code => new ShopError(404, code);
const conflict = (code, extra) => new ShopError(409, code, extra);

/* The categories a parts shop usually starts with. Offered, never imposed:
   the shop adds them with one press, and only the ones it does not have. */
const SUGGESTED_CATEGORIES = [
  'Tempered Glass', 'Back Cover', 'Combo Display', 'Display', 'Battery',
  'Charging Board', 'Flex Cable', 'Middle Frame', 'CC Board', 'Other Accessories'
];

const BILL_PREFIX = 'QB';
const MAX_STOCK = 999999;
const BATCH_LIMIT = 450;

/* ------------------------------------------------------------------ paths */
const shopRef = uid => db().collection(C.SHOPS).doc(uid);
const catCol = uid => shopRef(uid).collection(C.SHOP_CATEGORIES);
const prodCol = uid => shopRef(uid).collection(C.SHOP_PRODUCTS);
const billCol = uid => shopRef(uid).collection(C.SHOP_BILLS);
const moveCol = (uid, productId) => prodCol(uid).doc(productId).collection(C.SHOP_STOCK_MOVES);

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
function int(value, min, max) {
  return money.isInt(value) && value >= min && value <= max ? value : null;
}
/** Digits only; an Indian number keeps its last ten. */
function mobile(value) {
  let d = String(value == null ? '' : value).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  return d.slice(0, 15);
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
  return { id, name: d.name, order: d.order || 0, createdAt: d.createdAt || null };
}

function productView(id, d) {
  return {
    id,
    name: d.name,
    imageUrl: d.imageUrl || null,
    pricePaise: d.pricePaise,
    shelf: d.shelf || '',
    sku: d.sku || '',
    qty: d.qty || 0,
    lowStockAt: d.lowStockAt == null ? 1 : d.lowStockAt,
    categoryId: d.categoryId || null,
    active: d.active !== false,
    soldCount: d.soldCount || 0,
    createdAt: d.createdAt || null,
    updatedAt: d.updatedAt || null
  };
}

function billView(id, d) {
  return Object.assign({ id }, d, { ownerUid: undefined, customerKey: undefined });
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
    customerName: (d.customer && d.customer.name) || '',
    customerMobile: (d.customer && d.customer.mobile) || '',
    itemCount: (d.items || []).reduce((n, i) => n + i.qty, 0),
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

/** Everything the billing screen needs on open: categories and products. */
async function loadState(uid) {
  const [shopSnap, cats, prods] = await Promise.all([
    shopRef(uid).get(), catCol(uid).get(), prodCol(uid).get()
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
    shop: { billCount: shop.billSeq || 0, billPrefix: BILL_PREFIX },
    categories,
    products,
    suggestedCategories: SUGGESTED_CATEGORIES
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

async function createCategory(uid, body) {
  const name = categoryName(body.name);
  const now = Date.now();
  return db().runTransaction(async tx => {
    const all = await readCategories(tx, uid);
    const dup = all.find(c => c.d.nameKey === nameKey(name));
    if (dup) throw conflict('category-exists', { category: categoryView(dup.id, dup.d) });
    const ref = catCol(uid).doc();
    const d = {
      ownerUid: uid, name, nameKey: nameKey(name),
      order: all.reduce((m, c) => Math.max(m, c.d.order || 0), 0) + 1,
      createdAt: now, updatedAt: now
    };
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
      const d = { ownerUid: uid, name, nameKey: nameKey(name), order: ++order, createdAt: now, updatedAt: now };
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

function productFields(body, partial) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = text(body.name, 80);
    if (!out.name) throw bad('product-name');
  }
  if (!partial || body.pricePaise !== undefined) {
    out.pricePaise = int(body.pricePaise, 1, money.MAX_UNIT_PAISE);
    if (out.pricePaise == null) throw bad('product-price');
  }
  if (!partial || body.qty !== undefined) {
    out.qty = int(body.qty === undefined ? 1 : body.qty, 0, MAX_STOCK);
    if (out.qty == null) throw bad('product-qty');
  }
  if (!partial || body.shelf !== undefined) out.shelf = text(body.shelf, 24);
  if (!partial || body.sku !== undefined) out.sku = text(body.sku, 40);
  if (!partial || body.lowStockAt !== undefined) {
    out.lowStockAt = int(body.lowStockAt === undefined || body.lowStockAt === null ? 1 : body.lowStockAt, 0, MAX_STOCK);
    if (out.lowStockAt == null) throw bad('product-low-stock');
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
    ownerUid: uid, name: newName, nameKey: nameKey(newName),
    order: all.reduce((m, c) => Math.max(m, c.d.order || 0), 0) + 1,
    createdAt: now, updatedAt: now
  };
  return { id: ref.id, write: () => tx.set(ref, d), category: categoryView(ref.id, d) };
}

/**
 * Quick Product Add. The browser picks the product id, so pressing Save twice,
 * or a retry after the response was lost, returns the product it already made.
 */
async function createProduct(uid, body) {
  const id = clientId(body.productId);
  if (!id) throw bad('product-id');
  const fields = productFields(body, false);
  const ref = prodCol(uid).doc(id);

  const before = owned(uid, await ref.get());
  if (before) return { product: productView(id, before), replayed: true };

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
      active: true, soldCount: 0, createdAt: now, updatedAt: now
    });
    if (cat.write) cat.write();
    tx.set(ref, d);
    if (d.qty > 0) {
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
  const fields = productFields(body, true);
  const ref = prodCol(uid).doc(id);
  const image = body.image ? decodeImage(body.image) : null;
  if (!owned(uid, await ref.get())) throw notFound('product-not-found');
  const stored = image ? await storeImage(uid, id, image) : null;
  const now = Date.now();
  let dropPath = null;

  const result = await db().runTransaction(async tx => {
    const cur = owned(uid, await tx.get(ref));
    if (!cur) throw notFound('product-not-found');
    const cat = (body.categoryId || body.newCategory) ? await resolveCategory(tx, uid, body, now) : null;
    const patch = Object.assign({}, fields, { updatedAt: now });
    if (cat) patch.categoryId = cat.id;
    if (stored || body.removeImage) {
      dropPath = cur.imagePath || null;
      patch.imageUrl = stored ? stored.url : null;
      patch.imagePath = stored ? stored.path : null;
    }
    const delta = fields.qty == null ? 0 : fields.qty - (cur.qty || 0);
    if (cat && cat.write) cat.write();
    tx.update(ref, patch);
    if (delta) {
      tx.set(moveCol(uid, id).doc(), {
        ownerUid: uid, delta, qtyAfter: fields.qty, reason: 'edit',
        note: text(body.note, 120) || 'Quantity edited', at: now
      });
    }
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
  const ref = prodCol(uid).doc(id);
  const moveRef = moveCol(uid, id).doc('adj_' + adjustId);
  const now = Date.now();
  return db().runTransaction(async tx => {
    const [snap, moveSnap] = await Promise.all([tx.get(ref), tx.get(moveRef)]);
    const cur = owned(uid, snap);
    if (!cur) throw notFound('product-not-found');
    if (moveSnap.exists) return { product: productView(id, cur), replayed: true };
    const next = (cur.qty || 0) + delta;
    if (next < 0) throw conflict('negative-stock', { available: cur.qty || 0 });
    if (next > MAX_STOCK) throw bad('adjust-delta');
    tx.update(ref, { qty: next, updatedAt: now });
    tx.set(moveRef, {
      ownerUid: uid, delta, qtyAfter: next, reason: 'adjust',
      note: text(body.note, 120), at: now
    });
    return { product: productView(id, Object.assign({}, cur, { qty: next })), replayed: false };
  });
}

async function listMoves(uid, productId) {
  const id = docId(productId);
  if (!id) throw bad('product-id');
  if (!owned(uid, await prodCol(uid).doc(id).get())) throw notFound('product-not-found');
  const snap = await moveCol(uid, id).orderBy('at', 'desc').limit(60).get();
  return {
    moves: snap.docs.filter(s => owned(uid, s)).map(s => {
      const d = s.data();
      return {
        id: s.id, delta: d.delta, qtyAfter: d.qtyAfter, reason: d.reason,
        billId: d.billId || null, billNumber: d.billNumber || null, note: d.note || '', at: d.at
      };
    })
  };
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
      return { productId, qty, unitPaise };
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
  if (payment.status === 'paid' && !received) received = totalPaise;
  if (payment.status === 'unpaid') received = 0;
  const status = money.statusFor(totalPaise, received);
  return {
    method: payment.method, status, receivedPaise: received,
    balancePaise: Math.max(0, totalPaise - received),
    changePaise: Math.max(0, received - totalPaise)
  };
}

/** Save ("finalise") a bill — see the header: once, atomically, numbered. */
async function finaliseBill(uid, body) {
  const fid = clientId(body.finalisationId);
  if (!fid) throw bad('finalisation-id');
  const lines = readLines(body.lines);
  const adj = readAdjustments(body);
  const check = money.computeBill(lines, adj.discount, adj.tax, 0);
  if (!check.ok) throw moneyError(check);
  const customer = {
    name: text(body.customer && body.customer.name, 60),
    mobile: mobile(body.customer && body.customer.mobile),
    notes: text(body.customer && body.customer.notes, 300)
  };

  const billRef = billCol(uid).doc(fid);
  const productIds = Array.from(new Set(lines.filter(l => l.productId).map(l => l.productId)));
  const productRefs = productIds.map(id => prodCol(uid).doc(id));

  return db().runTransaction(async tx => {
    /* Every read first — Firestore requires it, and the replay check has to
       come before anything that could deduct stock. */
    const existing = owned(uid, await tx.get(billRef));
    if (existing) return { bill: billView(fid, existing), replayed: true };
    const shopSnap = await tx.get(shopRef(uid));
    const productSnaps = productRefs.length ? await tx.getAll(...productRefs) : [];
    const cats = await readCategories(tx, uid);
    const catName = new Map(cats.map(c => [c.id, c.d.name]));

    const products = new Map();
    productSnaps.forEach((s, i) => {
      const d = owned(uid, s);
      if (!d) throw conflict('product-missing', { productId: productIds[i] });
      if (d.active === false) throw conflict('product-archived', { productId: productIds[i], name: d.name });
      products.set(productIds[i], d);
    });

    const need = new Map();
    lines.forEach(l => { if (l.productId) need.set(l.productId, (need.get(l.productId) || 0) + l.qty); });
    const shortfalls = [];
    need.forEach((n, id) => {
      const have = products.get(id).qty || 0;
      if (n > have) shortfalls.push({ productId: id, name: products.get(id).name, available: have, requested: n });
    });
    if (shortfalls.length) throw conflict('insufficient-stock', { shortfalls });

    const totals = money.computeBill(lines, adj.discount, adj.tax, 0);
    const payment = settle(totals.totalPaise, adj.payment);
    if (!money.isInt(payment.receivedPaise) || payment.receivedPaise < 0 ||
        payment.receivedPaise > money.MAX_BILL_PAISE * 2) throw bad('bill-received');

    const shop = owned(uid, shopSnap) || {};
    const seq = (shop.billSeq || 0) + 1;
    const number = money.billNumber(BILL_PREFIX, seq);
    const now = Date.now();

    const items = lines.map((l, i) => {
      const p = l.productId ? products.get(l.productId) : null;
      return {
        lineNo: i + 1,
        productId: l.productId,
        custom: !p,
        name: p ? p.name : l.name,
        shelf: p ? (p.shelf || '') : '',
        sku: p ? (p.sku || '') : '',
        categoryName: p ? (catName.get(p.categoryId) || '') : '',
        unitPaise: l.unitPaise,
        listPaise: p ? p.pricePaise : null,
        qty: l.qty,
        totalPaise: totals.lineTotals[i]
      };
    });

    const bill = {
      ownerUid: uid,
      finalisationId: fid,
      number, seq,
      status: 'final',
      items,
      subtotalPaise: totals.subtotalPaise,
      discount: adj.discount,
      discountPaise: totals.discountPaise,
      tax: adj.tax,
      taxPaise: totals.taxPaise,
      totalPaise: totals.totalPaise,
      payment,
      customer,
      customerKey: customer.name.toLowerCase(),
      customerMobile: customer.mobile,
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, action: 'created', paymentStatus: payment.status }]
    };

    tx.set(shopRef(uid), Object.assign(
      { ownerUid: uid, billSeq: seq, updatedAt: now },
      shopSnap.exists ? {} : { createdAt: now }
    ), { merge: true });
    need.forEach((n, id) => {
      const p = products.get(id);
      const qtyAfter = (p.qty || 0) - n;
      tx.update(prodCol(uid).doc(id), { qty: qtyAfter, soldCount: (p.soldCount || 0) + n, updatedAt: now });
      tx.set(moveCol(uid, id).doc('bill_' + fid), {
        ownerUid: uid, delta: -n, qtyAfter, reason: 'sale', billId: fid, billNumber: number, at: now
      });
    });
    tx.create(billRef, bill);
    return { bill: billView(fid, bill), replayed: false };
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
    const payment = settle(cur.totalPaise, adj.payment);
    if (!money.isInt(payment.receivedPaise) || payment.receivedPaise < 0 ||
        payment.receivedPaise > money.MAX_BILL_PAISE * 2) throw bad('bill-received');
    const now = Date.now();
    const history = (cur.history || []).concat({
      at: now, action: 'payment',
      from: cur.payment && cur.payment.status, to: payment.status, receivedPaise: payment.receivedPaise
    }).slice(-50);
    tx.update(ref, { payment, history, updatedAt: now });
    return { bill: billView(id, Object.assign({}, cur, { payment, history, updatedAt: now })) };
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
  return db().runTransaction(async tx => {
    const cur = owned(uid, await tx.get(ref));
    if (!cur) throw notFound('bill-not-found');
    if (cur.status === 'void') return { bill: billView(id, cur), replayed: true };

    const need = new Map();
    (cur.items || []).forEach(i => { if (i.productId) need.set(i.productId, (need.get(i.productId) || 0) + i.qty); });
    const ids = Array.from(need.keys());
    const snaps = ids.length ? await tx.getAll(...ids.map(pid => prodCol(uid).doc(pid))) : [];
    const now = Date.now();
    const restored = [];
    snaps.forEach((s, i) => {
      const p = owned(uid, s);
      if (!p) return;
      const n = need.get(ids[i]);
      const qtyAfter = Math.min(MAX_STOCK, (p.qty || 0) + n);
      tx.update(s.ref, { qty: qtyAfter, soldCount: Math.max(0, (p.soldCount || 0) - n), updatedAt: now });
      tx.set(moveCol(uid, ids[i]).doc('void_' + id), {
        ownerUid: uid, delta: n, qtyAfter, reason: 'void', billId: id, billNumber: cur.number, note: reason, at: now
      });
      restored.push({ productId: ids[i], qty: n });
    });
    const history = (cur.history || []).concat({ at: now, action: 'void', reason, restored }).slice(-50);
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
 *
 * Each is a range on ONE field, which Firestore indexes on its own: nothing
 * here needs an entry in firestore.indexes.json.
 */
async function listBills(uid, query) {
  const limit = Math.min(50, Math.max(5, Number(query.limit) || 20));
  const q = text(query.q, 60);
  let ref = billCol(uid);
  let paged = false;

  if (q) {
    const num = /^(?:qb)?\s*-?\s*0*(\d{1,7})$/i.exec(q);
    const digits = q.replace(/\D/g, '');
    if (num && (/^qb/i.test(q) || digits.length <= 5)) {
      ref = ref.where('seq', '==', Number(num[1]));
    } else if (/^\+?[\d\s-]{6,}$/.test(q)) {
      const m = mobile(digits);
      ref = ref.where('customerMobile', '>=', m).where('customerMobile', '<=', m + '').orderBy('customerMobile');
    } else {
      const k = q.toLowerCase();
      ref = ref.where('customerKey', '>=', k).where('customerKey', '<=', k + '').orderBy('customerKey');
    }
    ref = ref.limit(limit);
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
    nextCursor: paged && bills.length === limit ? bills[bills.length - 1].seq : null
  };
}

module.exports = {
  ShopError, SUGGESTED_CATEGORIES, BILL_PREFIX,
  loadState,
  createCategory, addSuggested, renameCategory, reorderCategories, deleteCategory,
  createProduct, updateProduct, archiveProduct, adjustStock, listMoves,
  finaliseBill, updatePayment, voidBill, getBill, listBills,
  /* exported for tests */
  _internal: { text, clientId, decodeImage, settle, mobile }
};
