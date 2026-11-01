/* ============================================================================
   /api/shop/<section> — Quick Billing & Inventory
   ----------------------------------------------------------------------------
     GET  /api/shop/state             categories + products, for the billing screen
     POST /api/shop/category          { action: create | suggested | rename | update | reorder | delete }
     POST /api/shop/product           { action: create | update | archive | adjust }
     GET  /api/shop/moves?productId=  a product's stock movements
     GET  /api/shop/group?id=         one compatibility group, cut to the plan
     GET  /api/shop/model-groups?modelId=  the groups a device is in
     GET  /api/shop/compat?modelId=   this shop's products that fit a device
     POST /api/shop/bill              { action: finalise | payment | void | share }
     GET  /api/shop/bill?id=          one saved bill
     GET  /api/shop/bills?q=&cursor=  bill history, or a search
     POST /api/shop/offer             { action: create | update | status | auto | remove | settings }
     POST /api/shop/customer          { action: create | update }
     GET  /api/shop/customer?id=      one customer and their bills
     GET  /api/shop/customers?q=&filter=&cursor=  the customer list
     GET  /api/shop/overview?from=&to=  the dashboard
     GET  /api/shop/sales?from=&to=   Discounts & Offers' Sales Overview
     GET  /i/<token>                  one shared invoice, as a page. The only
                                      section with no sign-in: see below

   ONE FUNCTION FOR ALL OF IT. The Hobby plan allows 12 serverless functions
   and this is the twelfth; any further endpoint must be a section here or in
   another dispatcher (see api/admin.js for the reasoning).

   EVERY SECTION BUT ONE NEEDS A SIGNED-IN USER, and the shop is that user. The
   uid comes from the verified ID token and from nowhere else — no body field,
   query parameter or header can name a different shop. The service builds
   every Firestore path from it.

   The exception is `invoice`, the link a shop sends a customer. The customer has
   no account, so an unguessable token stands in for one, and it opens that one
   invoice and nothing else. It is handled apart so it can never fall through to
   a section that trusts the caller.

   Nothing here changes a subscription or a payment. The compatibility sections
   only read, and what they show of a group is cut to the caller's plan.
   ========================================================================== */
'use strict';

const { ok, json, fail, notAllowed, requireUser, body } = require('./_lib/http');
const shop = require('./_services/shop-service');

const POSTS = {
  category: {
    create: shop.createCategory,
    suggested: shop.addSuggested,
    rename: shop.renameCategory,
    update: shop.updateCategory,
    reorder: shop.reorderCategories,
    delete: shop.deleteCategory
  },
  product: {
    create: shop.createProduct,
    update: shop.updateProduct,
    archive: shop.archiveProduct,
    adjust: shop.adjustStock
  },
  bill: {
    finalise: shop.finaliseBill,
    payment: shop.updatePayment,
    void: shop.voidBill,
    share: shop.shareBill
  },
  offer: {
    create: shop.createOffer,
    update: shop.updateOffer,
    status: shop.setOfferStatus,
    auto: shop.setOfferAuto,
    remove: shop.archiveOffer,
    settings: shop.saveOfferSettings
  },
  customer: {
    create: shop.createCustomer,
    update: shop.updateCustomer
  }
};

const GETS = {
  state: (uid) => shop.loadState(uid),
  moves: (uid, q) => shop.listMoves(uid, q.productId),
  group: (uid, q) => shop.groupInfo(uid, q),
  'model-groups': (uid, q) => shop.modelGroups(uid, q),
  compat: (uid, q) => shop.compatProducts(uid, q),
  bill: (uid, q) => shop.getBill(uid, q.id),
  bills: (uid, q) => shop.listBills(uid, q),
  customer: (uid, q) => shop.getCustomer(uid, q),
  customers: (uid, q) => shop.listCustomers(uid, q),
  overview: (uid, q) => shop.overview(uid, q),
  sales: (uid, q) => shop.salesOverview(uid, q)
};

function sectionFrom(req) {
  const fromQuery = req.query && req.query.section;
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
  const path = String(req.url || '').split('?')[0].replace(/\/+$/, '');
  const match = /\/api\/shop\/([A-Za-z0-9_-]+)$/.exec(path);
  return match ? match[1] : '';
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

async function sharedInvoice(req, res) {
  const page = (status, html) => {
    res.status(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    /* A private document at a secret address: never cached, never indexed, and
       the address is not passed on to anything it links to. */
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.end(html);
  };
  try {
    return page(200, await shop.sharedInvoice(req.query || {}));
  } catch (err) {
    if (err instanceof shop.ShopError) {
      return page(404, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Invoice not found</title><p style="font:16px system-ui;padding:24px">This invoice link is not valid. Ask the shop to send it again.</p>');
    }
    return fail(res, err, 'shop:invoice');
  }
}

module.exports = async function handler(req, res) {
  const section = sectionFrom(req);
  const isGet = req.method === 'GET';
  if (isGet && section === 'invoice') return sharedInvoice(req, res);
  if (req.method !== 'GET' && req.method !== 'POST') return notAllowed(res);
  if (isGet ? !has(GETS, section) : !has(POSTS, section)) {
    return json(res, 404, { error: 'no such shop section', section: section || null });
  }

  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (isGet) return ok(res, await GETS[section](user.uid, req.query || {}));

    const input = body(req);
    const action = typeof input.action === 'string' ? input.action : '';
    const run = has(POSTS[section], action) ? POSTS[section][action] : null;
    if (!run) return json(res, 400, { error: 'unknown action', action: action || null });
    return ok(res, await run(user.uid, input));
  } catch (err) {
    /* A refusal the service decided on — bad input, not found, out of stock —
       goes back with its own status and a machine-readable code the screen
       can turn into a sentence. Anything else is a fault, and stays opaque. */
    if (err instanceof shop.ShopError) {
      return json(res, err.status, Object.assign({ error: err.code }, err.extra));
    }
    return fail(res, err, 'shop:' + section);
  }
};
