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
     POST /api/shop/bill              { action: finalise | payment | void }
     GET  /api/shop/bill?id=          one saved bill
     GET  /api/shop/bills?q=&cursor=  bill history, or a search
     POST /api/shop/customer          { action: create | update }
     GET  /api/shop/customer?id=      one customer and their bills
     GET  /api/shop/customers?q=&filter=&cursor=  the customer list
     GET  /api/shop/overview?from=&to=  the dashboard

   ONE FUNCTION FOR ALL OF IT. The Hobby plan allows 12 serverless functions
   and this is the twelfth; any further endpoint must be a section here or in
   another dispatcher (see api/admin.js for the reasoning).

   EVERY SECTION NEEDS A SIGNED-IN USER, and the shop is that user. The uid
   comes from the verified ID token and from nowhere else — no body field,
   query parameter or header can name a different shop. The service builds
   every Firestore path from it.

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
    void: shop.voidBill
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
  overview: (uid, q) => shop.overview(uid, q)
};

function sectionFrom(req) {
  const fromQuery = req.query && req.query.section;
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
  const path = String(req.url || '').split('?')[0].replace(/\/+$/, '');
  const match = /\/api\/shop\/([A-Za-z0-9_-]+)$/.exec(path);
  return match ? match[1] : '';
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

module.exports = async function handler(req, res) {
  const section = sectionFrom(req);
  const isGet = req.method === 'GET';
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
