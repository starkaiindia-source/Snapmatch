/* ============================================================================
   Mobile Parts Finder · quick-billing.js — Quick Billing & Inventory screens
   ----------------------------------------------------------------------------
   A shop's own counter: its products and stock, a bill being built, saved
   bills, categories, customers, the shop's figures, printing. Loaded on demand
   by app.js the first time /billing is opened, so the Finder never pays for it.

   It reads the Device Finder catalogue and never writes to it. A product can
   refer to a master device and to compatibility groups; the catalogue itself
   (SM.db) stays exactly as it was. What a group contains comes from the server,
   cut to the shop's plan, like everywhere else.

   ROUTES (all under /billing, rendered into the app's #page)
     /billing                   a new bill: the customer and what they are buying
     /billing/review            on a phone: what it comes to and how it was paid
     /billing/invoice/<id>      on a phone: the saved invoice, to share or print
     /billing/bills             saved bills by date: search, filters, history
     /billing/bills/<id>        one saved bill: reprint, labels, payment, void
     /billing/products          stock: table or grid, filters, edit, adjust
     /billing/offers            discounts for a category, a product or a variant
     /billing/categories        create, edit, reorder, delete-with-move
     /billing/customers         the customer list, filters, search
     /billing/customers/<id>    one customer: totals, history, payments
     /billing/overview          the shop's sales, customers and stock figures

   THE BILL BEING BUILT lives in this browser (localStorage, per account)
   until it is saved, so a reload or a dropped connection loses nothing. It
   carries a finalisation id from the moment it is started; every attempt to
   save it sends the same id, which is what makes saving it twice impossible.

   MONEY is integer paise through src/data/shop-money.js, the same module the
   server recomputes the saved bill with. What is typed is parsed straight to
   paise; nothing here holds a rupee float.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, C = SM.C, icon = SM.icon, M = SM.shopMoney, API = SM.shopApi, PF = SM.shopProducts, SH = SM.shopShare, OF = SM.shopOffers, PD = SM.shopPeriods;
  var esc = C.esc, inr = M.inr;

  var PRODUCT_PAGE = 50;
  /* One read per bill. A page has to hold a month of a counter, because the groups
     on the Bills page are added up from the rows. */
  var BILL_PAGE = 300;

  var METHODS = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['other', 'Other']];
  var STATUSES = [['unpaid', 'Unpaid'], ['partial', 'Partially Paid'], ['paid', 'Paid']];
  /* upi.png is NPCI's own artwork with its blank margins cut off. The other three
     are this project's drawings. Card names no network: nothing here records which
     networks a shop's card machine takes. */
  var METHOD_LOGOS = { cash: '/assets/pay/cash.svg', upi: '/assets/pay/upi.png', card: '/assets/pay/card.svg', other: '/assets/pay/wallet.svg' };
  var BILL_STATUSES = [['all', 'All Statuses'], ['paid', 'Paid'], ['unpaid', 'Unpaid'], ['partial', 'Partially Paid'], ['void', 'Void']];
  var SIZES = [['a4', 'A4'], ['a5', 'A5'], ['80', '80 mm'], ['58', '58 mm']];
  var VOID_REASONS = ['Customer returned the items', 'Wrong item or price', 'Duplicate bill', 'Other'];
  var ADJUST_REASONS = ['Stock received', 'Damaged / faulty', 'Stock count correction', 'Other'];
  var label = function (list, v) { for (var i = 0; i < list.length; i++) if (list[i][0] === v) return list[i][1]; return v || ''; };

  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) { /* private mode: the draft just does not survive a reload */ }
    return null;
  }

  /* ---------------------------------------------------------------- state */
  var S;
  function blankBillFilter() { return { period: '', from: '', to: '', status: 'all', label: '' }; }
  function reset(uid) {
    S = {
      uid: uid || null,
      loaded: false, loading: null, loadError: null,
      categories: [], products: [], suggested: [], billCount: 0,
      offers: [], offerSettings: {}, offerFilter: { q: '', status: 'all' }, offerKey: '',
      sales: { preset: 'month', from: '', to: '', data: null, loading: false, error: null, ticket: 0 },
      filter: { cat: 'all', q: '' }, catLimit: 60, pickQty: {}, lastAdd: null, custPicked: null,
      cart: null, saving: false, saveError: null, lastSaved: null, priceEdit: {},
      bills: { items: [], cursor: null, q: '', filter: blankBillFilter(), loading: false, loaded: false, error: null, ticket: 0 },
      prodFilter: PF.blankFilter(), prodView: 'table', prodPop: null, prodLimit: PRODUCT_PAGE, prodOpen: {},
      prodCols: PF.readColumns(store('mpf.qb.columns')), prodFlash: null, stockEdit: null,
      billCache: {},
      compat: null,            /* the phone being matched at the counter */
      customers: { items: [], cursor: null, q: '', filter: 'all', since: 0, loading: false, loaded: false, error: null, ticket: 0 },
      customerCache: {},
      customerCount: 0, outstandingPaise: 0,
      overview: { data: null, loading: false, error: null, preset: '30', from: '', to: '', trend: 'day', ticket: 0 },
      sheet: null,
      openCart: false,
      printSize: store('mpf.qb.size') || 'a4'
    };
  }
  reset(null);

  var ctx = null;          /* app.js: { go, replace, toast, signIn, routeName, page } */
  var params = [];

  /* The bill's two shapes. From this width a bill is one page in two columns. Below
     it the columns stack, so each stage gets a page of its own. The choice is made
     when drawing, not in CSS, so neither shape carries the other's controls. */
  var WIDE = global.matchMedia('(min-width:1100px)');
  function wide() { return WIDE.matches; }

  function toast(msg, ic) { if (ctx) ctx.toast(msg, ic); }
  function go(url) { if (ctx) ctx.go(url); }
  function onBilling() { return !!ctx && ctx.routeName() === 'billing'; }
  function el(id) { return document.getElementById(id); }
  function paint(id, html) { var n = el(id); if (n) n.innerHTML = html; return n; }

  /* ------------------------------------------------------------- lookups */
  function catById(id) { for (var i = 0; i < S.categories.length; i++) if (S.categories[i].id === id) return S.categories[i]; return null; }
  function productById(id) { for (var i = 0; i < S.products.length; i++) if (S.products[i].id === id) return S.products[i]; return null; }
  function catName(id) { var c = catById(id); return c ? c.name : 'Uncategorised'; }
  function activeProducts() { return S.products.filter(function (p) { return p.active; }); }
  function variantLabel(v) { return [v.ram, v.storage, v.label].filter(Boolean).join(' / '); }
  function hasVariants(p) { return !!(p.variants && p.variants.length); }
  function variantOf(p, id) { return (p.variants || []).filter(function (v) { return v.id === id; })[0] || null; }
  /** How many are on the bill: of one variant when `vid` is given, else of the product. */
  function inCart(pid, vid) {
    var n = 0;
    (S.cart ? S.cart.lines : []).forEach(function (l) {
      if (l.productId === pid && (vid === undefined || (l.variantId || null) === vid)) n += l.qty;
    });
    return n;
  }
  /** The stock a bill line draws on, and how much of it the bill already uses. */
  function lineStock(l) {
    var p = l.productId ? productById(l.productId) : null;
    if (!p) return null;
    var v = l.variantId ? variantOf(p, l.variantId) : null;
    return { qty: v ? v.qty : p.qty, used: v ? inCart(p.id, v.id) : inCart(p.id), name: p.name };
  }
  function compatOn(c) { return !!(c && c.compat && c.compat.enabled); }
  function needsLinks(p) {
    return p.active && compatOn(catById(p.categoryId)) && !(p.groupIds && p.groupIds.length);
  }
  function stockState(p) { return p.qty <= 0 ? 'out' : p.qty <= p.lowStockAt ? 'low' : 'ok'; }
  function upsertProduct(p) {
    for (var i = 0; i < S.products.length; i++) if (S.products[i].id === p.id) { S.products[i] = p; return; }
    S.products.unshift(p);
  }
  function upsertCategory(c) {
    if (!c) return;
    for (var i = 0; i < S.categories.length; i++) if (S.categories[i].id === c.id) { S.categories[i] = c; return; }
    S.categories.push(c);
  }

  /* --------------------------------------------------------------- errors */
  /** A refusal from /api/shop, as a sentence a shop can act on. */
  function say(err) {
    var code = err && err.code, d = (err && err.data) || {};
    switch (code) {
      case 'network': case 'timeout':
        return 'No connection to the server. Nothing was lost — try again when you are back online.';
      case 'datastore-unavailable':
        return 'The billing server is not answering right now. Nothing was lost — try again in a minute.';
      case 'signed-out': return 'Your session ended. Sign in again to continue.';
      case 'insufficient-stock':
        return (d.shortfalls || []).map(function (s) {
          return 'Only ' + s.available + ' of “' + s.name + '” in stock (bill has ' + s.requested + ').';
        }).join(' ') || 'Not enough stock for this bill.';
      case 'variant-required': return 'Choose which variant of “' + (d.name || 'this product') + '” is being sold.';
      case 'variant-missing': return 'A variant of “' + (d.name || 'this product') + '” no longer exists. Remove it from the bill and add it again.';
      case 'variant-duplicate': return 'Two variants are the same. Each RAM and storage pair can appear once.';
      case 'variant-has-stock': return 'The ' + (d.label || 'variant') + ' variant still has ' + d.available + ' in stock. Bring it to zero before removing it.';
      case 'variant-price': return 'Every variant needs a selling price.';
      case 'variant-name': return 'Every variant needs a RAM and storage, or a name.';
      case 'too-many-variants': return 'A product can have up to 30 variants.';
      case 'master-unknown': return 'That model is not in the master database.';
      case 'group-unknown': return 'One of these compatibility groups no longer exists. Remove it and try again.';
      case 'group-category': return 'That compatibility group is for a different part type than this category.';
      case 'group-category-off': return 'Turn compatibility on for this category before linking groups.';
      case 'too-many-groups': return 'A product can be linked to up to 30 groups.';
      case 'customer-missing': return 'This customer no longer exists. Choose another, or bill as walk-in.';
      case 'customer-exists': return 'A customer with this mobile number already exists: ' + ((d.customer && d.customer.name) || 'open Customers to find them') + '.';
      case 'customer-mobile-taken': return 'Another customer already has this mobile number.';
      case 'customer-mobile': case 'customer-whatsapp': return 'Enter a full mobile number.';
      case 'customer-name': return 'Enter the customer’s name.';
      case 'range-too-long': return 'Choose a period of a year or less.';
      case 'product-archived': return '“' + (d.name || 'A product') + '” is archived. Remove it from the bill or restore it in Products.';
      case 'product-missing': return 'A product on this bill no longer exists. Remove it and add it again.';
      case 'category-exists': return 'A category with this name already exists.';
      case 'category-has-products': return 'This category still has ' + d.count + ' products. Choose where to move them.';
      case 'stock-changed': return 'A bill changed this stock to ' + d.available + ' while you were editing. Check the number and save again.';
      case 'offers-changed': return 'An offer changed while this bill was open, so the total is now ' + M.inr(d.totalPaise) + '. Check the bill and confirm again.';
      case 'offer-name': return 'Give the offer a name.';
      case 'offer-value': return 'Enter a discount above zero. A percentage cannot be more than 100.';
      case 'offer-max': return 'Enter the maximum discount as an amount, or leave it empty.';
      case 'offer-target': return 'Choose what the offer applies to. Something chosen may no longer exist.';
      case 'offer-dates': return 'Check the dates: the end has to come after the start, and a time needs a date.';
      case 'offer-too-large': return 'The discount is larger than the price of “' + (d.name || 'a chosen product') + '”.';
      case 'offer-ended': return 'This offer’s end date has passed. Edit the dates to run it again.';
      case 'offer-not-found': return 'This offer no longer exists.';
      case 'negative-stock': return 'Stock cannot go below zero (in stock: ' + d.available + ').';
      case 'image-type': case 'image-data': return 'That photo could not be used. Try a JPG or PNG.';
      case 'image-too-large': return 'That photo is too large. Try a smaller one.';
      case 'image-upload-failed': return 'The photo could not be uploaded. Try again, or save without a photo.';
      case 'bill-void': return 'This bill is void.';
      case 'bill-discount-too-large': return 'The discount is more than the bill.';
      case 'bill-not-found': return 'This bill could not be found.';
      default: return 'Something went wrong. Please try again.';
    }
  }

  /* ================================================================= CART */
  function emptyCart() {
    return {
      fid: API.newId('b_'),
      lines: [],
      discount: { mode: 'amount', text: '' },
      tax: { on: false, rate: '18', inclusive: false, label: 'GST' },
      customer: { id: '', name: '', mobile: '', whatsapp: '', address: '', gstin: '', notes: '' },
      payment: { method: 'cash', status: 'paid', received: '' },
      autoOffers: null          /* null: this bill follows the shop's setting */
    };
  }
  function cartKey() { return 'mpf.qb.cart.' + S.uid; }
  /* The draft survives a reload. A customer's details are kept only for this tab:
     they have no business outliving the visit in the browser's long-term storage. */
  function sessionCustomer() {
    try { return JSON.parse(global.sessionStorage.getItem(cartKey()) || 'null'); } catch (e) { return null; }
  }
  function loadCart() {
    try {
      var c = JSON.parse(store(cartKey()) || 'null');
      if (c && typeof c.fid === 'string' && Array.isArray(c.lines)) {
        var e = emptyCart();
        return {
          fid: c.fid,
          lines: c.lines.filter(function (l) { return l && l.key && l.name; }),
          discount: Object.assign(e.discount, c.discount),
          tax: Object.assign(e.tax, c.tax),
          customer: Object.assign(e.customer, sessionCustomer()),
          payment: Object.assign(e.payment, c.payment),
          autoOffers: c.autoOffers == null ? null : !!c.autoOffers
        };
      }
    } catch (err) { /* a corrupt draft is replaced, not trusted */ }
    return emptyCart();
  }
  function saveCart() {
    if (!S.uid || !S.cart) return;
    var c = S.cart;
    store(cartKey(), JSON.stringify({ fid: c.fid, lines: c.lines, discount: c.discount, tax: c.tax, payment: c.payment, autoOffers: c.autoOffers }));
    try { global.sessionStorage.setItem(cartKey(), JSON.stringify(c.customer)); } catch (e) { /* private mode */ }
  }
  function lineByKey(k) { for (var i = 0; i < S.cart.lines.length; i++) if (S.cart.lines[i].key === k) return S.cart.lines[i]; return null; }

  /**
   * Puts a product on the bill. `v` is the variant; `model` is the phone the
   * customer asked about, when the product was found through compatibility. The
   * model is a note on the line: the stock that moves is always this product's.
   */
  function addToCart(p, v, model, qty) {
    if (hasVariants(p) && !v) { openVariantPicker(p, model, qty); return; }
    var want = qty || 1;
    var stock = v ? v.qty : p.qty;
    var used = v ? inCart(p.id, v.id) : inCart(p.id);
    var left = stock - used;
    var title = v ? p.name + ' (' + variantLabel(v) + ')' : p.name;
    if (left <= 0) { toast(stock <= 0 ? '“' + title + '” is out of stock' : 'All ' + stock + ' in stock are already on the bill', 'alert'); return; }
    if (want > left) { toast('Only ' + left + ' more of “' + title + '” in stock', 'alert'); return; }
    var vid = v ? v.id : null;
    var mid = model ? model.id : null;
    /* a second tap on the same button within a moment is the same intention */
    var key = p.id + '|' + vid + '|' + mid;
    if (S.lastAdd && S.lastAdd.key === key && Date.now() - S.lastAdd.at < 350) return;
    S.lastAdd = { key: key, at: Date.now() };
    var line = null;
    S.cart.lines.forEach(function (l) {
      if (!line && l.productId === p.id && (l.variantId || null) === vid && (l.modelId || null) === mid) line = l;
    });
    if (line) line.qty += want;
    else {
      var price = v ? v.pricePaise : p.pricePaise;
      S.cart.lines.push({
        key: API.newId('l'), productId: p.id, variantId: vid, variantLabel: v ? variantLabel(v) : '',
        name: p.name, shelf: (v && v.shelf) || p.shelf || '', sku: (v && v.sku) || p.sku || '',
        unitPaise: price, priceText: M.toInput(price), qty: want,
        modelId: mid, modelName: model ? model.name : '', groupId: model ? model.groupId || null : null
      });
    }
    delete S.pickQty[p.id];
    cartChanged(true);
    pulse(p.id);
  }

  function addCustom(name, priceText, qty) {
    var unit = M.parseRupees(priceText);
    S.cart.lines.push({ key: API.newId('l'), productId: null, name: name, shelf: '', sku: '', unitPaise: unit, priceText: priceText, qty: qty });
    cartChanged(true);
  }

  /* What the bill comes to, from what is on screen. Display never fails: an
     unreadable price counts as zero here and is flagged; Save is what refuses. */
  function autoOffers() {
    var a = S.cart.autoOffers;
    return a == null ? S.offerSettings.billAutoApply !== false : a;
  }
  function draft() {
    var c = S.cart;
    var offers = OF.applyOffers({
      offers: S.offers, settings: S.offerSettings, auto: autoOffers(), now: Date.now(),
      lines: c.lines.map(function (l) {
        var p = l.productId ? productById(l.productId) : null;
        return {
          key: l.key, productId: l.productId, variantId: l.variantId || null, categoryId: p ? p.categoryId : null,
          unitPaise: l.unitPaise == null ? 0 : l.unitPaise, qty: l.qty, pick: l.offerPick || undefined
        };
      })
    });
    var lines = c.lines.map(function (l, i) {
      return { unitPaise: l.unitPaise == null ? 0 : l.unitPaise, qty: l.qty, offerPaise: offers.lines[i].offerPaise };
    });
    var dt = String(c.discount.text || '').trim();
    var dv = dt ? (c.discount.mode === 'percent' ? M.parsePercent(dt) : M.parseRupees(dt)) : 0;
    var discount = { mode: c.discount.mode, value: dv == null ? 0 : dv };
    var bp = c.tax.on ? M.parsePercent(String(c.tax.rate || '')) : 0;
    var tax = { rateBp: bp || 0, inclusive: !!c.tax.inclusive, label: String(c.tax.label || '').trim().slice(0, 16) || 'Tax' };
    var rt = String(c.payment.received || '').trim();
    var rv = rt ? M.parseRupees(rt) : 0;

    var totals = M.computeBill(lines, discount, tax, 0);
    if (!totals.ok && totals.error === 'discount-too-large') {
      totals = M.computeBill(lines, { mode: 'amount', value: 0 }, tax, 0);
      totals.discountError = true;
    }
    var pay = settlePreview(totals.totalPaise, c.payment.status, rv || 0);

    var errors = {};
    c.lines.forEach(function (l) { if (l.unitPaise == null) errors['line:' + l.key] = 'Enter a price'; });
    if (dv == null) errors.disc = 'Not a valid ' + (c.discount.mode === 'percent' ? 'percentage' : 'amount');
    else if (totals.discountError) errors.disc = 'Discount is more than the bill';
    if (c.tax.on && !bp) errors.tax = 'Enter a tax rate, e.g. 18';
    if (rv == null) errors.recv = 'Not a valid amount';
    else if (c.payment.status === 'partial' && (!rv || rv >= totals.totalPaise)) errors.recv = 'Enter the part amount received';
    var cust = c.customer;
    var phone = digitsOf(cust.mobile);
    if (!cust.id && phone && phone.length < 10) errors.cmobile = 'Enter the full mobile number, or leave it empty for a walk-in';
    var whats = digitsOf(cust.whatsapp);
    if (whats && whats.length < 10) errors.cwhats = 'Enter the full number, or leave it empty';
    var gst = String(cust.gstin || '').trim();
    if (gst && !/^[0-9A-Za-z]{15}$/.test(gst)) errors.cgstin = 'A GSTIN has 15 letters and numbers';
    var ok = c.lines.length > 0 && Object.keys(errors).length === 0;
    return { totals: totals, offers: offers, pay: pay, discount: discount, tax: tax, received: rv || 0, errors: errors, ok: ok };
  }

  /* The same rule the server applies: "Paid" with nothing typed is paid in
     full, "Unpaid" is nothing received, and otherwise the amount decides. */
  function settlePreview(total, status, received) {
    var r = received;
    if (status === 'paid' && !r) r = total;
    if (status === 'unpaid') r = 0;
    return {
      status: M.statusFor(total, r), receivedPaise: r,
      balancePaise: Math.max(0, total - r), changePaise: Math.max(0, r - total)
    };
  }

  function billPayload(d) {
    var c = S.cart;
    return {
      action: 'finalise',
      finalisationId: c.fid,
      lines: c.lines.map(function (l) {
        return l.productId
          ? {
            productId: l.productId, variantId: l.variantId || undefined, qty: l.qty, unitPaise: l.unitPaise,
            selectedModelId: l.modelId || undefined, groupId: l.groupId || undefined
          }
          : { name: l.name, qty: l.qty, unitPaise: l.unitPaise };
      }),
      discount: d.discount,
      tax: c.tax.on ? d.tax : { rateBp: 0 },
      /* what the shop chose. The server works the offers out for itself, and the
         total is sent so it can say so if its answer is not what was on screen */
      offers: { auto: autoOffers(), picks: c.lines.map(function (l) { return l.offerPick || null; }) },
      expectedTotalPaise: d.totals.totalPaise,
      payment: { method: c.payment.method, status: c.payment.status, receivedPaise: d.received },
      customer: {
        id: c.customer.id || undefined, name: c.customer.name, mobile: c.customer.mobile, whatsapp: c.customer.whatsapp,
        address: c.customer.address, gstin: c.customer.gstin, notes: c.customer.notes
      }
    };
  }

  /* ============================================================== INVOICE */
  function shopInfo() {
    var s = (SM.session && SM.session.get) ? SM.session.get() : {};
    var p = s.profile || {};
    var a = p.address || {};
    return {
      name: p.shopName || p.mobileShopName || s.shopName || s.name || 'My Shop',
      place: [a.flat, a.area, a.city, a.state].filter(Boolean).join(', '),
      mobile: p.mobile || p.mobileNumber || '',
      gstin: p.gstin || ''
    };
  }
  function when(ms) {
    try {
      return new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
    } catch (e) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); }
  }
  function pct(bp) { return (bp / 100).toFixed(2).replace(/\.?0+$/, '') + '%'; }

  /**
   * One invoice, for the live preview AND for every printed size. The print
   * sizes differ in CSS only (assets/quick-billing.css, .inv--a4 … .inv--58),
   * plus a stacked row layout on the two thermal widths, where a five-column
   * table does not fit on 48 mm of paper.
   */
  function invoiceHTML(b, size) {
    var shop = shopInfo();
    var thermal = size === '80' || size === '58';
    var head =
      '<header class="inv__head">' +
      '<div class="inv__shop"><b>' + esc(shop.name) + '</b>' +
      (shop.place ? '<span>' + esc(shop.place) + '</span>' : '') +
      (shop.mobile ? '<span>Mobile: ' + esc(shop.mobile) + '</span>' : '') +
      (shop.gstin ? '<span>GSTIN: ' + esc(shop.gstin) + '</span>' : '') + '</div>' +
      '<div class="inv__meta"><b>INVOICE</b>' +
      '<span>No. ' + esc(b.number) + '</span>' +
      '<span>' + esc(when(b.createdAt)) + '</span></div>' +
      '</header>';
    var cust = b.customer || {};
    var to = (cust.name || cust.mobile || cust.notes)
      ? '<div class="inv__to"><span class="inv__lab">Bill to</span>' +
        (cust.name ? '<b>' + esc(cust.name) + '</b>' : '') +
        (cust.mobile ? '<span>' + esc(cust.mobile) + '</span>' : '') +
        (cust.address ? '<span>' + esc(cust.address) + '</span>' : '') +
        (cust.gstin ? '<span>GSTIN: ' + esc(cust.gstin) + '</span>' : '') +
        (cust.notes ? '<span class="inv__note">' + esc(cust.notes) + '</span>' : '') + '</div>'
      : '';

    var rows = (b.items || []).map(function (it, i) {
      var meta = [it.shelf ? 'Shelf ' + it.shelf : '', it.sku || ''].filter(Boolean).join(' · ');
      var title = it.name + (it.variantLabel ? ' (' + it.variantLabel + ')' : '');
      var fits = (it.selectedModelName ? '<span class="inv__dim">For ' + esc(it.selectedModelName) + '</span>' : '') +
        (it.offers || []).map(function (o) { return '<span class="inv__dim">Offer: ' + esc(o.name) + ' (' + esc(OF.valueText(o, inr)) + ')</span>'; }).join('') +
        (it.offerPaise ? '<span class="inv__dim">Discount ' + M.format(it.offerPaise) + ' · Final ' + M.format(it.finalUnitPaise) + ' each</span>' : '');
      if (thermal) {
        return '<tr><td colspan="2"><b>' + esc(title) + '</b>' + fits + '<br><span class="inv__dim">' +
          it.qty + ' × ' + M.format(it.unitPaise) + '</span></td><td class="inv__num">' + M.format(it.totalPaise) + '</td></tr>';
      }
      return '<tr><td class="inv__i">' + (i + 1) + '</td><td><b>' + esc(title) + '</b>' + fits +
        (meta ? '<span class="inv__dim">' + esc(meta) + '</span>' : '') + '</td>' +
        '<td class="inv__num">' + it.qty + '</td><td class="inv__num">' + M.format(it.unitPaise) + '</td>' +
        '<td class="inv__num">' + M.format(it.totalPaise) + '</td></tr>';
    }).join('');
    var thead = thermal
      ? '<tr><th colspan="2">Item</th><th class="inv__num">Amount</th></tr>'
      : '<tr><th class="inv__i">#</th><th>Item</th><th class="inv__num">Qty</th><th class="inv__num">Rate</th><th class="inv__num">Amount</th></tr>';
    var table = '<table class="inv__items"><thead>' + thead + '</thead><tbody>' +
      (rows || '<tr><td colspan="5" class="inv__empty">No items yet</td></tr>') + '</tbody></table>';

    var t = function (k, v, cls) { return '<div class="inv__t' + (cls ? ' ' + cls : '') + '"><span>' + k + '</span><b>' + v + '</b></div>'; };
    var tax = b.tax || {};
    var pay = b.payment || {};
    var offerOff = b.offerDiscountPaise || 0;
    var totals = '<div class="inv__totals">' +
      t('Subtotal', M.format(b.originalSubtotalPaise || b.subtotalPaise || 0)) +
      (offerOff ? t('Product discounts', '−' + M.format(offerOff)) : '') +
      (b.discountPaise ? t('Additional discount' + (b.discount && b.discount.mode === 'percent' ? ' (' + pct(b.discount.value) + ')' : ''), '−' + M.format(b.discountPaise)) : '') +
      (tax.rateBp ? t(esc(tax.label || 'Tax') + ' ' + pct(tax.rateBp) + (tax.inclusive ? ' (incl.)' : ''), (tax.inclusive ? '' : '+') + M.format(b.taxPaise || 0)) : '') +
      t('Total', inr(b.totalPaise || 0), 'inv__grand') +
      (offerOff ? t('Total discount', M.format(offerOff + (b.discountPaise || 0))) : '') +
      t('Amount paid', M.format(Math.min(pay.receivedPaise || 0, b.totalPaise || 0))) +
      t('Balance due', M.format(pay.balancePaise || 0), pay.balancePaise ? 'inv__due' : '') +
      (pay.changePaise ? t('Change', M.format(pay.changePaise)) : '') +
      '</div>';
    var status = '<div class="inv__pay">' + esc(label(STATUSES, pay.status)) + ' · ' + esc(label(METHODS, pay.method)) + '</div>';
    var stamp = b.status === 'void'
      ? '<div class="inv__void">VOID<span>' + esc(b.voidReason || '') + '</span></div>' : '';
    return '<article class="inv inv--' + (size || 'preview') + (b.status === 'void' ? ' is-void' : '') + '">' +
      head + to + table + totals + status + stamp +
      '<footer class="inv__foot">Thank you for your purchase</footer></article>';
  }

  /* ============================================================== PRINTING
     The browser's own print dialog, nothing else: no printer drivers, no
     plug-ins. What is printed is put in #qbPrint, the only thing the print
     stylesheet leaves visible, and the paper size is one @page rule written
     for this print. A thermal receipt is measured first so the page is
     exactly as long as the receipt — no metre of blank roll after it. */
  function printNow(html, kind, pageCss, rollWidthMm) {
    var host = el('qbPrint');
    if (!host) {
      host = document.createElement('div');
      host.id = 'qbPrint';
      document.body.appendChild(host);
    }
    host.className = 'qbprint qbprint--' + kind;
    host.innerHTML = html;
    var style = el('qbPageCss');
    if (!style) {
      style = document.createElement('style');
      style.id = 'qbPageCss';
      document.head.appendChild(style);
    }
    var css = pageCss;
    if (rollWidthMm) {
      var h = host.firstElementChild ? host.firstElementChild.getBoundingClientRect().height : 600;
      css = '@page{size:' + rollWidthMm + 'mm ' + (Math.ceil(h * 25.4 / 96) + 8) + 'mm;margin:0}';
    }
    style.textContent = '@media print{' + css + '}';
    document.body.classList.add('qb-printing');
    var done = function () {
      document.body.classList.remove('qb-printing');
      global.removeEventListener('afterprint', done);
    };
    global.addEventListener('afterprint', done);
    /* let the images in the print host load before the dialog snapshots it */
    setTimeout(function () { global.print(); }, 120);
  }

  function printInvoice(bill, size) {
    size = size || S.printSize;
    var page = { a4: '@page{size:A4;margin:12mm}', a5: '@page{size:A5;margin:9mm}' }[size] || '';
    printNow(invoiceHTML(bill, size), 'inv-' + size, page, size === '80' ? 80 : size === '58' ? 58 : 0);
  }

  function labelsHTML(entries, layout) {
    var out = '';
    entries.forEach(function (e) {
      for (var i = 0; i < e.count; i++) {
        out += '<div class="lbl"><b class="lbl__name">' + esc(e.name) + '</b>' +
          '<span class="lbl__price">' + inr(e.pricePaise) + '</span>' +
          '<span class="lbl__meta">' + (e.shelf ? '<span>Shelf ' + esc(e.shelf) + '</span>' : '<span></span>') +
          (e.sku ? '<span class="lbl__sku">' + esc(e.sku) + '</span>' : '') + '</span></div>';
      }
    });
    return '<div class="lbls lbls--' + layout + '">' + out + '</div>';
  }
  function printLabels(entries, layout) {
    var page = layout === 'roll' ? '@page{size:50mm 25mm;margin:0}' : '@page{size:A4;margin:8mm}';
    printNow(labelsHTML(entries, layout), 'lbl-' + layout, page, 0);
  }

  /* ================================================================ RENDER */
  function render(page, prm, context) {
    ctx = context;
    params = prm || [];
    var fb = SM.fb;
    var user = fb && fb.user ? fb.user() : null;
    var phase = fb && fb.phase ? fb.phase() : 'unauthenticated';

    if (!user && phase === 'loading') {
      page.innerHTML = frame('pos', skeleton());
      fb.whenResolved().then(function () { if (onBilling()) rerender(); });
      return;
    }
    if (!user) {
      closeSheet();
      page.innerHTML = '<div class="qb qb--gate"><div class="shell">' + C.state({
        icon: 'lock', brand: true,
        title: 'Sign in to use Quick Billing',
        text: 'Your products, stock and bills are saved to your own account and stay private to your shop.',
        action: '<button class="btn qb-btn" data-qb="sign-in">' + icon('user') + 'Sign in</button>' +
          '<a class="btn btn--ghost" href="/finder">Back to Mobile Parts Finder</a>'
      }) + '</div></div>';
      return;
    }
    if (S.uid !== user.uid) {
      closeSheet();
      reset(user.uid);
      S.cart = loadCart();
    }
    if (!S.loaded) {
      if (S.loadError) {
        page.innerHTML = frame(viewName(), '<div class="shell">' + C.state({
          icon: 'alert', title: 'Could not open Quick Billing', text: say(S.loadError),
          action: '<button class="btn qb-btn" data-qb="reload">' + icon('refresh') + 'Try again</button>'
        }) + '</div>');
      } else {
        page.innerHTML = frame(viewName(), skeleton());
        load();
      }
      return;
    }
    renderView(page);
    var tab = page.querySelector('.qb-tab.is-on');
    if (tab && tab.scrollIntoView) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function rerender() {
    if (!onBilling()) return;
    render(ctx.page(), params, ctx);
  }

  function viewName() {
    var p = params[0];
    if (p === 'bills') return params[1] ? 'bill' : 'bills';
    if (p === 'customers') return params[1] ? 'customer' : 'customers';
    if (p === 'invoice' && params[1]) return 'invoice';
    if (p === 'review' || p === 'products' || p === 'offers' || p === 'categories' || p === 'overview') return p;
    return 'pos';
  }

  function renderView(page) {
    var v = viewName();
    if (v === 'pos') return renderPos(page);
    S.lastSaved = null;
    if (v === 'review') return wide() ? ctx.replace('/billing') : renderReview(page);
    if (v === 'invoice') return renderInvoice(page, params[1]);
    if (v === 'bills') return renderBills(page);
    if (v === 'bill') return renderBillView(page, params[1]);
    if (v === 'products') return renderProducts(page);
    if (v === 'offers') return renderOffers(page);
    if (v === 'categories') return renderCategories(page);
    if (v === 'customers') return renderCustomers(page);
    if (v === 'customer') return renderCustomer(page, params[1]);
    if (v === 'overview') return renderOverview(page);
  }

  function load() {
    if (S.loading) return S.loading;
    var uid = S.uid;
    var first = !S.loaded;
    S.loading = API.state().then(function (r) {
      if (S.uid !== uid) return;
      S.categories = r.categories || [];
      S.products = r.products || [];
      S.suggested = r.suggestedCategories || [];
      S.billCount = (r.shop && r.shop.billCount) || 0;
      S.customerCount = (r.shop && r.shop.customerCount) || 0;
      S.outstandingPaise = (r.shop && r.shop.outstandingPaise) || 0;
      S.offers = r.offers || [];
      S.offerSettings = r.offerSettings || {};
      S.offerKey = activeOfferKey();
      S.loaded = true;
      S.loadError = null;
    }, function (err) {
      if (S.uid !== uid) return;
      if (first) S.loadError = err;
    }).then(function () {
      S.loading = null;
      if (S.uid !== uid) return;
      /* The first load draws the page. A refresh afterwards only repaints the
         parts that show stock, so nothing anyone is typing into is replaced. */
      if (first) rerender(); else softRepaint();
    });
    return S.loading;
  }

  function softRepaint() {
    if (!onBilling()) return;
    var v = viewName();
    if (v === 'pos') {
      paintCatalog();
      paintDerived();
      /* fresh stock can change which lines are over it — but a line being
         typed in is left alone */
      var lines = el('qbLines');
      if (lines && !lines.contains(document.activeElement)) paint('qbLines', linesHTML(draft()));
    }
    else if (v === 'review') paintDerived();
    else if (v === 'products') paintProductList();
    else if (v === 'categories') rerender();
  }

  function skeleton() {
    return '<div class="shell qb-skel">' + C.skelRows(6) + '</div>';
  }

  /** The page frame every billing screen shares: title, sub-navigation, actions. */
  function frame(view, inner, extraCls) {
    var tab = function (id, href, text, ic) {
      var on = view === id || (id === 'bills' && view === 'bill') || (id === 'customers' && view === 'customer') ||
        (id === 'pos' && (view === 'review' || view === 'invoice'));
      return '<a class="qb-tab' + (on ? ' is-on' : '') + '" href="' + href + '"' + (on ? ' aria-current="page"' : '') + '>' +
        icon(ic) + '<span>' + text + '</span></a>';
    };
    return '<div class="qb qb--' + view + (extraCls ? ' ' + extraCls : '') + '" id="qb">' +
      '<div class="qb-head"><div class="qb-head__in">' +
      '<div class="qb-title"><span class="qb-title__ico">' + icon('receipt') + '</span><h1>Quick Billing</h1></div>' +
      '<nav class="qb-tabs" aria-label="Quick Billing">' +
      tab('pos', '/billing', 'New Bill', 'receipt') +
      tab('bills', '/billing/bills', 'Bills', 'history') +
      tab('products', '/billing/products', 'Products', 'box') +
      tab('offers', '/billing/offers', 'Discounts &amp; Offers', 'tag') +
      tab('categories', '/billing/categories', 'Categories', 'layers') +
      tab('customers', '/billing/customers', 'Customers', 'user') +
      tab('overview', '/billing/overview', 'Overview', 'chart') +
      '</nav>' +
      '<a class="qb-exit" href="/finder" aria-label="Leave Quick Billing">' + icon('close') + '<span>Exit</span></a>' +
      '</div></div>' +
      inner + '</div>';
  }

  /* ============================================================== NEW BILL

     On a desktop, one page: the customer and products on the left, the cart,
     summary and payment on the right, and the saved invoice takes the form's place
     without the address changing.

     On a phone or tablet, three pages at their own addresses: who the bill is for
     and what they are buying; what it comes to and how it was paid; the saved
     invoice. The draft lives in S.cart between the first two, so going back and
     forward loses nothing.

     Either way it stays a draft until the server has saved it: the invoice is drawn
     from what the server sent back, never from what was on screen. */
  function renderPos(page) {
    if (wide() && S.lastSaved) {
      page.innerHTML = frame('pos', invoicePageHTML(S.lastSaved));
      return;
    }
    page.innerHTML = frame('pos',
      '<div class="qb-nb">' +
      '<div class="qb-nb__main">' +
      '<section class="qb-panel" id="qbCustSec" aria-label="Customer details">' + customerSecHTML() + '</section>' +
      '<section class="qb-nb__find" aria-label="Products">' + catalogPaneHTML() + '</section>' +
      '</div>' +
      '<div class="qb-nb__side" aria-label="Bill">' + billSideHTML() + '</div>' +
      '</div>' +
      (wide() ? '' : '<div class="qb-cartbar" id="qbCartBar">' + cartBarHTML() + '</div>'), 'qb--nb');
  }

  function catalogPaneHTML() {
    var none = !S.products.length;
    return '<div class="qb-find">' +
      '<label class="qb-search">' + icon('search') +
      '<input id="qbQ" type="search" autocomplete="off" placeholder="Search mobile model, product name, SKU..." ' +
      'value="' + esc(S.filter.q) + '" aria-label="Search your products or a mobile model" data-qbi="q" /></label>' +
      '<div class="qb-mhits" id="qbModelHits">' + modelHitsHTML() + '</div>' +
      '</div>' +
      '<div class="qb-chips" id="qbChips" role="group" aria-label="Categories">' + chipsHTML() + '</div>' +
      '<div class="qb-catalog" id="qbCatalog">' + catalogHTML() + '</div>' +
      (none ? '' : '<button class="qb-quickadd" data-qb="add-product">' + icon('plus') + 'Quick Product Add</button>');
  }

  function chipsHTML() {
    var f = S.filter;
    var chip = function (id, text, n) {
      return '<button class="qb-chip' + (f.cat === id ? ' is-on' : '') + '" data-qb="cat" data-id="' + esc(id) + '" aria-pressed="' + (f.cat === id) + '">' +
        esc(text) + (n != null ? '<em>' + n + '</em>' : '') + '</button>';
    };
    var counts = {};
    activeProducts().forEach(function (p) { counts[p.categoryId] = (counts[p.categoryId] || 0) + 1; });
    var frequent = frequentProducts().length;
    return chip('all', 'All', activeProducts().length) +
      (frequent ? chip('frequent', 'Frequent', null) : '') +
      S.categories.filter(function (c) { return c.status !== 'inactive'; })
        .map(function (c) { return chip(c.id, c.name, counts[c.id] || 0); }).join('');
  }

  function frequentProducts() {
    return activeProducts().filter(function (p) { return p.soldCount > 0; })
      .sort(function (a, b) { return b.soldCount - a.soldCount; }).slice(0, 8);
  }

  function matches(p, q) { return PF.matches(p, q, productCtx()); }

  function catalogHTML() {
    if (S.compat) return compatHTML();
    if (!S.products.length) return setupHTML();
    var f = S.filter;
    var list = f.cat === 'frequent' ? frequentProducts() : activeProducts().filter(function (p) {
      return f.cat === 'all' || p.categoryId === f.cat;
    });
    list = list.filter(function (p) { return matches(p, f.q); });
    if (f.cat !== 'frequent') list.sort(function (a, b) { return a.name.localeCompare(b.name); });
    if (!list.length) {
      return '<div class="qb-empty">' + icon('search') +
        '<p>' + (f.q ? 'No product matches “' + esc(f.q) + '”.' : 'No products in this category yet.') + '</p>' +
        '<button class="btn btn--outline btn--sm" data-qb="add-product">' + icon('plus') + 'Add product</button></div>';
    }
    return '<div class="qb-grid">' + list.slice(0, S.catLimit).map(function (p) { return cardHTML(p); }).join('') + '</div>' +
      (list.length > S.catLimit
        ? '<div class="qb-more"><button class="btn btn--outline btn--sm" data-qb="cat-more">Show more (' + (list.length - S.catLimit) + ')</button></div>'
        : '');
  }

  function thumbHTML(p, cls) {
    var url = p.imageUrl || (p.master && p.master.image) || '';
    if (url) return '<span class="qb-thumb ' + (cls || '') + '"><img src="' + esc(url) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" /></span>';
    var letters = String(p.name || '?').split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase();
    return '<span class="qb-thumb qb-thumb--none ' + (cls || '') + '" aria-hidden="true">' + esc(letters) + '</span>';
  }

  /* A result is a store product, never a catalogue device: the only way a phone
     gets here is by being on the shop's own shelf. `fits` names the model the
     customer asked for when the product was found through compatibility. */
  function cardHTML(p, fits) {
    var used = inCart(p.id);
    var left = p.qty - used;
    var st = stockState(p);
    var many = hasVariants(p) && p.variants.length > 1;
    var qty = S.pickQty[p.id] || 1;
    var meta = [catName(p.categoryId), p.sku ? 'SKU ' + p.sku : '', p.shelf ? 'Shelf ' + p.shelf : '',
      hasVariants(p) ? p.variants.length + (p.variants.length === 1 ? ' variant' : ' variants') : ''].filter(Boolean).join(' · ');
    return '<article class="qb-card' + (used ? ' is-in' : '') + (left <= 0 ? ' is-out' : '') + '" data-id="' + esc(p.id) + '">' +
      thumbHTML(p, 'qb-thumb--card') +
      '<div class="qb-card__body">' +
      (fits ? '<span class="qb-card__fits">Requested model: <b>' + esc(fits) + '</b></span><span class="qb-card__tag">Actual stock product</span>' : '') +
      '<b class="qb-card__name">' + esc(p.name) + '</b>' +
      '<span class="qb-card__meta">' + esc(meta) + '</span>' +
      '<span class="qb-card__nums"><b class="qb-card__price">' + (many ? 'From ' : '') + inr(p.pricePaise) + '</b>' +
      '<span class="qb-stock qb-stock--' + st + '">' + (p.qty <= 0 ? 'Out of stock' : p.qty + ' in stock') + '</span>' +
      (used ? '<span class="qb-card__in">' + used + ' on the bill</span>' : '') + '</span>' +
      (left > 0
        ? '<div class="qb-card__add"><div class="qb-qty" role="group" aria-label="Quantity of ' + esc(p.name) + '">' +
          '<button type="button" data-qb="pick-dec" data-id="' + esc(p.id) + '" aria-label="Decrease">' + icon('minus') + '</button>' +
          '<input class="qb-qty__in" inputmode="numeric" autocomplete="off" value="' + qty + '" data-qbi="pick-qty" data-id="' + esc(p.id) + '" aria-label="Quantity to add" />' +
          '<button type="button" data-qb="pick-inc" data-id="' + esc(p.id) + '" aria-label="Increase">' + icon('plus') + '</button></div>' +
          '<button type="button" class="btn qb-btn btn--sm qb-card__go" data-qb="add" data-id="' + esc(p.id) + '" aria-label="Add ' + esc(p.name) + ' to the bill">' + icon('plus') + 'Add to Bill</button></div>'
        : '') +
      '</div></article>';
  }

  /* ----------------------------------------------- finding stock by phone

     The search box takes a phone model as well as a product. Asking about a
     model asks the server which of this shop's products are linked to a group
     that phone is in, so the answer can only ever be real links, never a similar
     name. The model is only what the customer asked for: price, quantity and
     stock are always the product's. */
  var modelHitTimer = null;
  function modelMatches(q, kind, limit) {
    var words = q.toLowerCase().split(/\s+/).filter(Boolean);
    var compact = q.toLowerCase().replace(/[^a-z0-9]/g, '');
    var exact = [], starts = [], rest = [];
    var list = (SM.db && SM.db.modelsRanked) || [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (kind && m.deviceType !== kind) continue;
      if (m.compact === compact) exact.push(m);
      else if (m.compact.indexOf(compact) === 0) starts.push(m);
      else if (m.compact.indexOf(compact) > -1 || words.every(function (w) { return m.search.indexOf(w) > -1; })) rest.push(m);
    }
    return exact.concat(starts, rest).slice(0, limit);
  }
  function modelHitsHTML() {
    var q = S.filter.q;
    if (q.length < 2) return '';
    var hits = modelMatches(q, null, 6);
    if (!hits.length) return '';
    return '<span class="qb-mhits__l">Find stock that fits a model</span>' + hits.map(function (m) {
      var on = S.compat && S.compat.id === m.id;
      return '<button class="qb-mhit' + (on ? ' is-on' : '') + '" data-qb="pick-model" data-id="' + esc(m.id) + '" aria-pressed="' + !!on + '">' + esc(m.fullName) + '</button>';
    }).join('');
  }
  function paintModelHits() { paint('qbModelHits', modelHitsHTML()); }

  /** After typing stops: a name that is exactly one model is answered at once. */
  function modelSearchSettled() {
    paintModelHits();
    var q = S.filter.q;
    if (q.length < 3 || (S.compat && S.compat.q === q)) return;
    var first = modelMatches(q, null, 1)[0];
    if (first && first.compact === q.toLowerCase().replace(/[^a-z0-9]/g, '')) pickModel(first.id);
  }

  function pickModel(id) {
    var m = SM.db && SM.db.modelById[id];
    if (!m) return;
    var uid = S.uid;
    S.compat = { id: id, name: m.fullName, q: S.filter.q, loading: true, error: null, matches: [], groupCount: 0 };
    S.filter.cat = 'all';
    paintModelHits();
    paintCatalog();
    API.compat(id).then(function (r) {
      if (S.uid !== uid || !S.compat || S.compat.id !== id) return;
      S.compat.loading = false;
      S.compat.matches = r.matches || [];
      S.compat.groupCount = r.groupCount || 0;
      paintCatalog();
    }, function (err) {
      if (S.uid !== uid || !S.compat || S.compat.id !== id) return;
      S.compat.loading = false;
      S.compat.error = err;
      paintCatalog();
    });
  }
  function clearModel() {
    S.compat = null;
    S.filter.q = '';
    var q = el('qbQ');
    if (q) { q.value = ''; q.focus(); }
    paintModelHits();
    paintCatalog();
  }
  /** What adding means while a phone is selected, or null for a plain sale. */
  function compatContext(p) {
    var c = S.compat;
    if (!c) return null;
    var hit = c.matches.filter(function (m) { return m.productId === p.id; })[0];
    return hit ? { id: c.id, name: c.name, groupId: hit.groupId } : null;
  }

  function compatHTML() {
    var c = S.compat;
    var banner = '<div class="qb-compatbar" role="status"><span class="qb-compatbar__l">Requested model</span>' +
      '<b>' + esc(c.name) + '</b>' +
      '<button class="qb-link" data-qb="clear-model">' + icon('close') + 'Clear</button></div>';
    if (c.loading) return banner + C.skelRows(3);
    if (c.error) {
      return banner + C.state({ icon: 'alert', title: 'Could not check compatibility', text: say(c.error),
        action: '<button class="btn btn--outline btn--sm" data-qb="pick-model" data-id="' + esc(c.id) + '">' + icon('refresh') + 'Try again</button>' });
    }
    /* The phone itself, when the shop stocks it, is not a compatibility match. */
    var own = activeProducts().filter(function (p) { return p.master && p.master.id === c.id; });
    var linked = c.matches.map(function (m) { return productById(m.productId); }).filter(function (p) { return p && p.active; })
      .sort(function (a, b) { return (b.qty > 0) - (a.qty > 0) || a.name.localeCompare(b.name); });
    var f = S.filter.cat;
    if (f !== 'all' && f !== 'frequent') {
      own = own.filter(function (p) { return p.categoryId === f; });
      linked = linked.filter(function (p) { return p.categoryId === f; });
    }
    if (!own.length && !linked.length) {
      return banner + '<div class="qb-empty">' + icon('search') +
        '<p>' + (c.groupCount
          ? 'None of your products are linked to a group that fits this model.'
          : 'This model is not in any compatibility group yet.') + '</p>' +
        '<a class="btn btn--outline btn--sm" href="/billing/products">' + icon('box') + 'Link products</a></div>';
    }
    return banner +
      (own.length ? '<p class="qb-gridlab">This phone, in your stock</p><div class="qb-grid">' + own.map(function (p) { return cardHTML(p); }).join('') + '</div>' : '') +
      (linked.length ? '<p class="qb-gridlab">Fits this phone</p><div class="qb-grid">' + linked.map(function (p) { return cardHTML(p, c.name); }).join('') + '</div>' : '');
  }

  function setupHTML() {
    return '<div class="qb-setup">' +
      '<span class="qb-setup__ico">' + icon('box') + '</span>' +
      '<h2>Set up your counter</h2>' +
      '<p>Add the products you sell with a price, where each sits on the shelf and how many you have. ' +
      'They are yours alone and separate from the Device Finder.</p>' +
      '<div class="qb-setup__acts">' +
      '<button class="btn qb-btn" data-qb="add-product">' + icon('plus') + 'Add your first product</button>' +
      '</div>' +
      '<p class="qb-setup__or">You can also bill custom items without adding products.</p></div>';
  }

  function paintCatalog() {
    paint('qbChips', chipsHTML());
    paint('qbCatalog', catalogHTML());
  }

  function pulse(pid) {
    var n = document.querySelector('.qb-card[data-id="' + (global.CSS && CSS.escape ? CSS.escape(pid) : pid) + '"]');
    if (!n) return;
    n.classList.remove('is-pulse');
    void n.offsetWidth;
    n.classList.add('is-pulse');
  }
  /** How many of this product can still go on the bill. */
  function pickRoom(id) {
    var p = productById(id);
    return p ? Math.max(1, Math.min(M.MAX_QTY, p.qty - inCart(id))) : 1;
  }
  function setPick(id, n) {
    var qty = Math.max(1, Math.min(pickRoom(id), n));
    S.pickQty[id] = qty;
    var box = document.querySelector('[data-qbi="pick-qty"][data-id="' + id + '"]');
    if (box) box.value = qty;
  }

  /* ------------------------------------------------------------- customer

     A bill can be for a customer on file, for someone new, or for nobody in
     particular. A full mobile number finds or makes the customer when the bill
     is saved. A name alone stays a walk-in: a name is not enough to say who
     someone is, and a guess would put one person's purchases on another's record. */
  function digitsOf(v) { return String(v || '').replace(/\D/g, ''); }
  function customerState() {
    var c = S.cart.customer;
    if (c.id) return 'Existing customer';
    return digitsOf(c.mobile).length >= 10 ? 'New customer' : 'Walk-in';
  }
  function customerHint() {
    var c = S.cart.customer;
    if (c.id) return '';
    if (digitsOf(c.mobile).length >= 10) return 'This customer is saved with the bill, or matched by their number.';
    return c.name.trim()
      ? 'Add a mobile number to save them as a customer. Without one this stays a walk-in bill.'
      : 'Search by name or mobile, or leave it empty for a walk-in.';
  }
  function customerSecHTML() {
    var c = S.cart.customer;
    var d = draft();
    var box = function (id, key, label, attrs, value) {
      return '<label class="qb-vf"><span>' + label + '</span><input class="input qb-in" id="' + id + '" autocomplete="off" data-qbi="' + key + '" value="' + esc(value) + '"' + attrs + ' />' +
        '<small class="qb-err" data-err="' + key + '">' + esc(d.errors[key] || '') + '</small></label>';
    };
    return '<div class="qb-sec"><h2>Customer</h2><span class="qb-count" id="qbCustState">' + esc(customerState()) + '</span></div>' +
      '<div id="qbCust">' + customerPickHTML(d) + '</div>' +
      '<details class="qb-custmore"' + (c.whatsapp || c.address || c.gstin || c.notes ? ' open' : '') + '>' +
      '<summary>WhatsApp, address, GSTIN, notes</summary><div class="qb-custmore__in">' +
      box('qbCWhats', 'cwhats', 'WhatsApp number', ' type="tel" inputmode="tel" placeholder="Same as mobile"', c.whatsapp) +
      box('qbCGst', 'cgstin', 'GSTIN', ' maxlength="15" placeholder="Optional"', c.gstin) +
      box('qbCAddr', 'caddr', 'Address', ' maxlength="200" placeholder="Optional"', c.address) +
      box('qbCNotes', 'cnotes', 'Notes', ' maxlength="300" placeholder="e.g. warranty, delivery"', c.notes) +
      '</div></details>';
  }
  function customerPickHTML(d) {
    var c = S.cart.customer;
    if (c.id) {
      var x = S.custPicked && S.custPicked.id === c.id ? S.custPicked : null;
      var facts = x ? [x.lastBillAt ? 'Last purchase ' + dateOnly(x.lastBillAt) : '', x.outstandingPaise ? inr(x.outstandingPaise) + ' outstanding' : ''].filter(Boolean).join(' · ') : '';
      return '<div class="qb-custpick"><span class="qb-custpick__who"><b>' + esc(c.name || c.mobile) + '</b>' +
        (c.name && c.mobile ? '<span>' + esc(c.mobile) + '</span>' : '') +
        (facts ? '<span>' + esc(facts) + '</span>' : '') + '</span>' +
        '<button class="qb-link" data-qb="cust-clear">' + icon('close') + 'Change</button></div>';
    }
    return '<div class="qb-cust__row">' +
      '<input class="input qb-in" id="qbCName" autocomplete="off" placeholder="Customer name" value="' + esc(c.name) + '" data-qbi="cname" aria-label="Customer name, or search customers" />' +
      '<input class="input qb-in" id="qbCMob" type="tel" inputmode="tel" autocomplete="off" placeholder="Mobile number" value="' + esc(c.mobile) + '" data-qbi="cmobile" aria-label="Customer mobile number, or search customers" /></div>' +
      '<small class="qb-err" data-err="cmobile">' + esc(((d || {}).errors || {}).cmobile || '') + '</small>' +
      '<div class="qb-custhits" id="qbCustHits"></div>' +
      '<small class="qb-help" id="qbCustHint">' + esc(customerHint()) + '</small>';
  }

  var custSearchTimer = null, custSearchTicket = 0;
  function searchCustomers(q) {
    clearTimeout(custSearchTimer);
    var ticket = ++custSearchTicket;
    if (q.replace(/\s/g, '').length < 2) { paint('qbCustHits', ''); return; }
    custSearchTimer = setTimeout(function () {
      API.customers({ q: q, limit: 5 }).then(function (r) {
        if (ticket !== custSearchTicket) return;
        S.custHits = r.customers || [];
        paint('qbCustHits', S.custHits.map(function (x) {
          return '<button class="qb-custhit" data-qb="cust-pick" data-id="' + esc(x.id) + '"><b>' + esc(x.name || x.mobile) + '</b>' +
            '<span>' + esc(x.mobile || '') + (x.billCount ? ' · ' + x.billCount + (x.billCount === 1 ? ' bill' : ' bills') : '') + '</span></button>';
        }).join(''));
      }, function () { /* a failed lookup leaves the typed details to work as they are */ });
    }, 300);
  }

  /* ----------------------------------------------- cart, summary, payment */
  function billSideHTML() {
    var d = draft();
    return '<section class="qb-panel" id="qbBill" aria-label="Cart">' + billEditorHTML(d) + '</section>' +
      (wide() ? billDetailsHTML(d) : '');
  }

  /* What the bill comes to and how it was paid: under the cart on a desktop, the
     whole of the second page on a phone. */
  function billDetailsHTML(d) {
    return '<section class="qb-panel" id="qbSummary" aria-label="Bill summary">' + summaryHTML(d) + '</section>' +
      '<section class="qb-panel qb-pay" id="qbPay" aria-label="Payment details">' + payHTML(d) + '</section>' +
      '<div class="qb-acts" id="qbActs">' + actsHTML() + '</div>';
  }

  function billEditorHTML(d) {
    var c = S.cart;
    var count = c.lines.reduce(function (n, l) { return n + l.qty; }, 0);
    return '<div class="qb-sec"><h2>Cart</h2><span class="qb-count" id="qbCount">' + count + (count === 1 ? ' item' : ' items') + '</span>' +
      (c.lines.length ? '<button class="qb-link" data-qb="clear-cart">' + icon('trash') + 'Clear</button>' : '') + '</div>' +
      '<label class="qb-autooffers"><span class="qb-switch"><input type="checkbox" data-qbi="bill-auto"' + (autoOffers() ? ' checked' : '') + ' /><i></i></span>Auto Apply Discounts &amp; Offers</label>' +
      '<div class="qb-lines" id="qbLines">' + linesHTML(d) + '</div>' +
      customFormHTML();
  }

  function linesHTML(d) {
    var c = S.cart;
    if (!c.lines.length) {
      return '<div class="qb-empty qb-empty--bill">' + icon('receipt') + '<p>Search above and add a product to the bill.</p></div>';
    }
    return c.lines.map(function (l, i) {
      var p = l.productId ? productById(l.productId) : null;
      var r = d.offers.lines[i];
      var stock = lineStock(l);
      var over = stock && stock.used > stock.qty;
      var err = d.errors['line:' + l.key];
      return '<div class="qb-line' + (err || over ? ' is-bad' : '') + '" data-key="' + esc(l.key) + '">' +
        '<div class="qb-line__top"><div class="qb-line__main"><b>' + esc(l.name) + (l.variantLabel ? ' · ' + esc(l.variantLabel) : '') + '</b>' +
        (l.modelName ? '<span class="qb-fits">Requested model: ' + esc(l.modelName) + '</span>' : '') + '<span>' +
        (l.productId ? (l.shelf ? 'Shelf ' + esc(l.shelf) : catName(p && p.categoryId)) : '<em class="qb-tagc">Custom item</em>') +
        (over ? ' · <em class="qb-warn">only ' + stock.qty + ' in stock</em>' : '') +
        (!l.productId ? ' · <button class="qb-link" data-qb="custom-save" data-id="' + esc(l.key) + '">Save as product</button>' : '') +
        '</span></div>' +
        '<button class="qb-line__x" data-qb="remove" data-id="' + esc(l.key) + '" aria-label="Remove ' + esc(l.name) + '">' + icon('close') + '</button></div>' +
        '<div class="qb-line__offer" data-offer="' + esc(l.key) + '">' + lineOfferHTML(l, r) + '</div>' +
        '<div class="qb-line__deal" data-deal="' + esc(l.key) + '">' + lineDealHTML(l, r) + '</div>' +
        '<div class="qb-line__row"><div class="qb-qty" role="group" aria-label="Quantity">' +
        '<button data-qb="qty-dec" data-id="' + esc(l.key) + '" aria-label="Decrease">' + icon('minus') + '</button>' +
        '<input class="qb-qty__in" inputmode="numeric" autocomplete="off" value="' + l.qty + '" data-qbi="line-qty" data-id="' + esc(l.key) + '" aria-label="Quantity of ' + esc(l.name) + '" />' +
        '<button data-qb="qty-inc" data-id="' + esc(l.key) + '" aria-label="Increase">' + icon('plus') + '</button></div>' +
        '<label class="qb-price" data-price="' + esc(l.key) + '"' + (priceHidden(l, r) ? ' hidden' : '') + '><span>₹</span><input inputmode="decimal" autocomplete="off" value="' + esc(l.priceText) + '" data-qbi="line-price" data-id="' + esc(l.key) + '" aria-label="Original price of ' + esc(l.name) + '" /></label>' +
        '<span class="qb-line__sum"><em>Line Total</em><b data-total="' + esc(l.key) + '">' + (l.unitPaise == null ? '—' : inr(r.linePaise)) + '</b></span></div>' +
        '</div>';
    }).join('');
  }

  /* An offer's line shows what the item now sells for. The price it came down
     from can still be changed, but only by asking: it is no longer the price. */
  function priceHidden(l, r) { return !!r.offerPaise && !S.priceEdit[l.key] && l.unitPaise != null; }

  function dealTag(l, r) {
    var a = r.applied[0];
    if (r.applied.length === 1 && a.kind === 'percent' && !a.maxPaise) return (a.percentBp / 100) + '% OFF';
    return inr(Math.round(r.offerPaise / l.qty)) + ' OFF';
  }
  function lineDealHTML(l, r) {
    if (!r || !r.offerPaise || l.unitPaise == null) return '';
    return '<span class="qb-deal"><em class="qb-deal__off">' + esc(dealTag(l, r)) + '</em>' +
      '<b class="qb-deal__now">' + inr(r.finalUnitPaise) + '</b>' +
      '<s class="qb-deal__was" aria-label="Original price ' + inr(l.unitPaise) + '">' + inr(l.unitPaise) + '</s></span>';
  }

  function customFormHTML() {
    return '<details class="qb-custom" id="qbCustom"><summary>' + icon('plus') + 'Custom item <em>not saved as a product</em></summary>' +
      '<div class="qb-custom__row">' +
      '<input class="input qb-in" id="qbXName" autocomplete="off" placeholder="Item name, e.g. Fitting charge" aria-label="Custom item name" />' +
      '<input class="input qb-in qb-in--price" id="qbXPrice" inputmode="decimal" autocomplete="off" placeholder="Price ₹" aria-label="Custom item price" />' +
      '<input class="input qb-in qb-in--qty" id="qbXQty" inputmode="numeric" autocomplete="off" value="1" aria-label="Custom item quantity" />' +
      '<button class="btn btn--outline btn--sm" data-qb="custom-add">' + icon('plus') + 'Add</button>' +
      '</div><small class="qb-err" data-err="custom"></small></details>';
  }

  function taxHTML(d) {
    var c = S.cart;
    if (!c.tax.on) {
      return '<span class="qb-lab">Tax</span><button class="qb-toggle" data-qb="tax-toggle" aria-pressed="false">' +
        '<span class="qb-toggle__k"></span>No tax · <em>Add tax</em></button>';
    }
    return '<span class="qb-lab">Tax <button class="qb-link" data-qb="tax-toggle">Remove</button></span>' +
      '<div class="qb-inrow">' +
      '<input class="input qb-in qb-in--label" id="qbTaxLabel" autocomplete="off" value="' + esc(c.tax.label) + '" data-qbi="tax-label" aria-label="Tax name" />' +
      '<label class="qb-suffix"><input class="input qb-in" id="qbTaxRate" inputmode="decimal" autocomplete="off" value="' + esc(c.tax.rate) + '" data-qbi="tax-rate" aria-label="Tax rate percent" /><span>%</span></label>' +
      '</div>' +
      '<label class="qb-check"><input type="checkbox" id="qbTaxIncl" data-qbi="tax-incl"' + (c.tax.inclusive ? ' checked' : '') + ' /> Prices already include tax</label>' +
      '<small class="qb-err" data-err="tax">' + esc((d && d.errors.tax) || '') + '</small>';
  }

  function summaryHTML(d) {
    var c = S.cart;
    return '<div class="qb-sec"><h2>Bill Summary</h2>' +
      (wide() ? '' : '<button class="qb-link qb-sec__end" data-qb="edit-bill">' + icon('edit') + 'Edit Bill</button>') + '</div>' +
      '<div class="qb-adj">' +
      '<div class="qb-field"><span class="qb-lab">Additional discount</span><div class="qb-inrow">' +
      '<div class="qb-seg qb-seg--sm" role="group" aria-label="Discount type">' +
      '<button class="' + (c.discount.mode === 'amount' ? 'is-on' : '') + '" data-qb="disc-mode" data-id="amount" aria-pressed="' + (c.discount.mode === 'amount') + '">₹</button>' +
      '<button class="' + (c.discount.mode === 'percent' ? 'is-on' : '') + '" data-qb="disc-mode" data-id="percent" aria-pressed="' + (c.discount.mode === 'percent') + '">%</button></div>' +
      '<input class="input qb-in" id="qbDisc" inputmode="decimal" autocomplete="off" placeholder="0" value="' + esc(c.discount.text) + '" data-qbi="disc" aria-label="Additional discount" /></div>' +
      '<small class="qb-err" data-err="disc">' + esc(d.errors.disc || '') + '</small></div>' +
      '<div class="qb-field" id="qbTax">' + taxHTML(d) + '</div>' +
      '</div>' +
      '<div class="qb-totals" id="qbTotals">' + totalsHTML(d) + '</div>';
  }

  function sizeSelectHTML(id) {
    return '<label class="qb-size"><span class="sr">Paper size</span><select class="input" id="' + id + '" data-qbi="size">' +
      SIZES.map(function (s) { return '<option value="' + s[0] + '"' + (S.printSize === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') +
      '</select></label>';
  }

  function totalsHTML(d) {
    var t = d.totals, c = S.cart;
    var row = function (k, v, cls) { return '<div class="qb-trow' + (cls ? ' ' + cls : '') + '"><span>' + k + '</span><b>' + v + '</b></div>'; };
    var taxed = c.tax.on && d.tax.rateBp;
    return row('Original subtotal', inr(t.originalSubtotalPaise)) +
      row('Product discounts', (t.offerPaise ? '−' : '') + inr(t.offerPaise)) +
      row('Additional discount', (t.discountPaise ? '−' : '') + inr(t.discountPaise)) +
      row(taxed ? esc(d.tax.label) + ' ' + pct(d.tax.rateBp) + (d.tax.inclusive ? ' (included)' : '') : 'Tax', (taxed && !d.tax.inclusive ? '+' : '') + inr(t.taxPaise)) +
      row('Final total', inr(t.totalPaise), 'qb-trow--grand') +
      row('Amount paid', inr(Math.min(d.pay.receivedPaise, t.totalPaise))) +
      row('Outstanding balance', inr(d.pay.balancePaise));
  }

  function payHTML(d) {
    var c = S.cart;
    var option = function (x, cur, act, inner) {
      return '<button type="button" class="' + (cur === x[0] ? 'is-on' : '') + '" data-qb="' + act + '" data-id="' + x[0] + '" aria-pressed="' + (cur === x[0]) + '">' + inner + '</button>';
    };
    return '<div class="qb-sec"><h2>Payment</h2></div>' +
      '<div class="' + (wide() ? 'qb-seg' : 'qb-paym') + '" role="group" aria-label="Payment method">' + METHODS.map(function (m) {
        return option(m, c.payment.method, 'pay-method', wide() ? m[1]
          : '<img src="' + METHOD_LOGOS[m[0]] + '" alt="" decoding="async" /><span>' + m[1] + '</span>');
      }).join('') + '</div>' +
      '<div class="qb-seg" role="group" aria-label="Payment status" id="qbStatus">' + STATUSES.map(function (s) {
        return option(s, c.payment.status, 'pay-status', s[1]);
      }).join('') + '</div>' +
      '<div class="qb-recv"><div class="qb-field"><label class="qb-lab" for="qbRecv">Amount received</label>' +
      '<label class="qb-prefix"><span>₹</span><input class="input qb-in" id="qbRecv" inputmode="decimal" autocomplete="off" ' +
      'placeholder="' + (c.payment.status === 'paid' ? M.toInput(d.totals.totalPaise) + ' (full)' : '0') + '" value="' + esc(c.payment.received) + '" data-qbi="recv" /></label>' +
      '<small class="qb-err" data-err="recv">' + esc(d.errors.recv || '') + '</small></div>' +
      '<div class="qb-bal" id="qbBal">' + balanceHTML(d) + '</div></div>';
  }

  function balanceHTML(d) {
    if (d.pay.changePaise) return '<span>Change to return</span><b class="qb-good">' + inr(d.pay.changePaise) + '</b>';
    if (d.pay.balancePaise) return '<span>Outstanding balance</span><b class="qb-due">' + inr(d.pay.balancePaise) + '</b>';
    return '<span>Outstanding balance</span><b>' + inr(0) + '</b>';
  }

  function actsHTML() {
    var alert = S.saveError ? '<div class="qb-alert" role="alert">' + icon('alert') + '<span>' + esc(S.saveError) + '</span></div>' : '';
    if (!wide()) return alert;
    return alert + '<button class="btn qb-btn btn--lg btn--block" id="qbConfirm" data-qb="confirm-bill"' + (S.cart.lines.length && !S.saving ? '' : ' disabled') + '>' +
      (S.saving ? '<span class="qb-spin"></span>Saving the bill…' : icon('check') + 'Confirm Bill') + '</button>' +
      (S.cart.lines.length ? '' : '<p class="qb-hint">Add a product or a custom item to start a bill.</p>');
  }

  /* The bill's one action on a phone: Review Bill, then Confirm Bill. */
  function cartBarHTML() {
    var n = S.cart.lines.reduce(function (k, l) { return k + l.qty; }, 0);
    var d = draft();
    var ready = S.cart.lines.some(function (l) { return l.unitPaise != null; });
    var act = viewName() === 'review'
      ? '<button class="qb-cartbar__go" id="qbConfirm" data-qb="confirm-bill"' + (S.saving ? ' disabled' : '') + '>' +
        (S.saving ? '<span class="qb-spin qb-spin--bar"></span>Saving…' : icon('check') + 'Confirm Bill') + '</button>'
      : '<button class="qb-cartbar__go" data-qb="review"' + (ready ? '' : ' disabled') + '>Review Bill' + icon('chevronRight') + '</button>';
    var sum = '<b>' + inr(d.totals.totalPaise) + '</b><em>' + n + (n === 1 ? ' item' : ' items') + '</em>';
    return '<div class="qb-cartbar__in">' + (viewName() === 'review'
      ? '<span class="qb-cartbar__t">' + sum + '</span>'
      : '<button class="qb-cartbar__t" data-qb="to-cart" aria-label="Go to the cart">' + sum + '</button>') +
      act + '</div>';
  }
  function paintCartBar() { paint('qbCartBar', cartBarHTML()); }

  /* ----------------------------------------------- after the cart changes */
  /** `structure` true: lines were added or removed, so the list is redrawn. */
  function cartChanged(structure) {
    saveCart();
    var d = draft();
    if (structure) {
      paint('qbLines', linesHTML(d));
      var count = S.cart.lines.reduce(function (n, l) { return n + l.qty; }, 0);
      paint('qbCount', count + (count === 1 ? ' item' : ' items'));
      var sec = document.querySelector('#qbBill .qb-sec');
      if (sec) {
        var clear = sec.querySelector('[data-qb="clear-cart"]');
        if (!S.cart.lines.length && clear) clear.remove();
        if (S.cart.lines.length && !clear) sec.insertAdjacentHTML('beforeend', '<button class="qb-link" data-qb="clear-cart">' + icon('trash') + 'Clear</button>');
      }
      paintCatalog();
    } else {
      S.cart.lines.forEach(function (l) {
        var t = document.querySelector('[data-total="' + l.key + '"]');
        var row = t && t.closest('.qb-line');
        if (row) row.classList.toggle('is-bad', l.unitPaise == null);
      });
      var count2 = S.cart.lines.reduce(function (n, l) { return n + l.qty; }, 0);
      paint('qbCount', count2 + (count2 === 1 ? ' item' : ' items'));
    }
    paintDerived(d);
  }

  /** Everything computed from the cart that holds no input being typed in. */
  function paintDerived(d) {
    d = d || draft();
    S.cart.lines.forEach(function (l, i) {
      var r = d.offers.lines[i];
      var t = document.querySelector('[data-total="' + l.key + '"]');
      if (t) t.textContent = l.unitPaise == null ? '—' : inr(r.linePaise);
      var o = document.querySelector('[data-offer="' + l.key + '"]');
      if (o) o.innerHTML = lineOfferHTML(l, r);
      var deal = document.querySelector('[data-deal="' + l.key + '"]');
      if (deal) deal.innerHTML = lineDealHTML(l, r);
      var box = document.querySelector('[data-price="' + l.key + '"]');
      if (box) box.hidden = priceHidden(l, r);
    });

    paint('qbTotals', totalsHTML(d));
    paint('qbBal', balanceHTML(d));
    paint('qbActs', actsHTML(d));
    var st = el('qbStatus');
    if (st) Array.prototype.forEach.call(st.querySelectorAll('button'), function (b) {
      var on = b.getAttribute('data-id') === S.cart.payment.status;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    var recv = el('qbRecv');
    if (recv) recv.placeholder = S.cart.payment.status === 'paid' ? M.toInput(d.totals.totalPaise) + ' (full)' : '0';
    ['disc', 'tax', 'recv', 'cmobile', 'cwhats', 'cgstin'].forEach(function (k) {
      var e = document.querySelector('[data-err="' + k + '"]');
      if (e) e.textContent = d.errors[k] || '';
    });
    paint('qbCustState', esc(customerState()));
    paint('qbCustHint', esc(customerHint()));
    paintCartBar();
  }

  /* ================================================================ REVIEW

     The second page on a phone: what the bill comes to, the additional discount,
     the tax and the payment, on one screen. Nothing is saved by being here, and
     Edit Bill goes back to a first page holding exactly what it held. */
  function showErrors(d, msg) {
    toast(msg, 'alert');
    paintDerived(d);
    var bad = document.querySelector('.qb-nb .qb-err:not(:empty), .qb-line.is-bad');
    if (bad) bad.scrollIntoView({ block: 'center' });
  }
  /** What has to be put right on the first page. The rest is on the second. */
  function firstPageErrors(d) {
    return Object.keys(d.errors).filter(function (k) { return !/^(disc|tax|recv)$/.test(k); });
  }
  function openReview() {
    var d = draft();
    if (!S.cart.lines.length) { toast('Add something to the bill first', 'alert'); return; }
    if (firstPageErrors(d).length) { showErrors(d, 'Check the highlighted fields'); return; }
    S.saveError = null;
    go('/billing/review');
    global.scrollTo(0, 0);
  }

  function renderReview(page) {
    /* an open tab or the Back button, after this bill was saved or cleared */
    if (!S.cart.lines.length) { ctx.replace('/billing'); return; }
    page.innerHTML = frame('review',
      '<div class="qb-rv">' + billDetailsHTML(draft()) + '</div>' +
      '<div class="qb-cartbar" id="qbCartBar">' + cartBarHTML() + '</div>');
  }

  /* ================================================================ SAVING */
  function saveBill() {
    if (S.saving) return;
    var d = draft();
    if (!wide() && firstPageErrors(d).length) { toast('Check the highlighted fields', 'alert'); go('/billing'); return; }
    if (!d.ok) { showErrors(d, 'Check the highlighted fields'); return; }
    var p = S.cart.lines.filter(function (l) { return l.productId && !productById(l.productId); })[0];
    if (p) { S.saveError = '“' + p.name + '” is no longer in your products. Remove it from the bill.'; paint('qbActs', actsHTML()); return; }

    S.saving = true;
    S.saveError = null;
    paint('qbActs', actsHTML());
    paintCartBar();
    var uid = S.uid;
    API.bill(billPayload(d)).then(function (r) {
      if (S.uid !== uid) return;
      var bill = r.bill;
      S.billCache[bill.id] = bill;
      if (!r.replayed) {
        /* deduct locally at once; the refresh below confirms it */
        S.cart.lines.forEach(function (l) {
          var prod = l.productId && productById(l.productId);
          if (!prod) return;
          var v = l.variantId ? variantOf(prod, l.variantId) : null;
          if (v) v.qty = Math.max(0, v.qty - l.qty);
          prod.qty = Math.max(0, prod.qty - l.qty);
          prod.soldCount = (prod.soldCount || 0) + l.qty;
        });
      }
      S.billCount = Math.max(S.billCount, bill.seq || 0);
      markFiguresStale(bill);
      S.cart = emptyCart();
      S.compat = null;
      S.filter.q = '';
      S.pickQty = {};
      S.custPicked = null;
      S.priceEdit = {};
      saveCart();
      S.saving = false;
      /* replayed: an earlier attempt of THIS bill had already reached the
         server (a double tap, or a reply lost to the connection) — it is the
         same bill, saved once */
      toast(r.replayed ? 'Bill ' + bill.number + ' saved (it had already reached the server)' : 'Bill ' + bill.number + ' saved', 'checkCircle');
      load();
      if (onBilling()) {
        if (wide()) {
          S.lastSaved = bill;
          rerender();
        } else {
          /* in place of the review page: Back has no bill left to review */
          ctx.replace('/billing/invoice/' + encodeURIComponent(bill.id));
        }
        global.scrollTo(0, 0);
      }
    }, function (err) {
      if (S.uid !== uid) return;
      S.saving = false;
      S.saveError = say(err);
      if (err.code === 'insufficient-stock' || err.code === 'product-archived' || err.code === 'product-missing' || err.code === 'offers-changed') load();
      if (onBilling()) {
        paintDerived();
        if (err.code === 'insufficient-stock') paint('qbLines', linesHTML(draft()));
        var why = el('qbActs');
        if (why) why.scrollIntoView({ block: 'center' });
      }
    });
  }

  /**
   * Anything that changes a bill changes these; they are read again when next
   * shown. The bill itself is put straight into a loaded list, so going back to
   * Bills after a sale does not read the whole list again.
   */
  function markFiguresStale(bill) {
    listBill(bill);
    S.customers.loaded = false;
    S.customerCache = {};
    S.overview.data = null;
    S.sales.data = null;
  }
  function listBill(bill) {
    var b = S.bills;
    if (!b.loaded || b.q) { b.loaded = false; return; }
    var pay = bill.payment || {};
    var row = {
      id: bill.id, number: bill.number, seq: bill.seq, status: bill.status, totalPaise: bill.totalPaise,
      paymentStatus: pay.status, paymentMethod: pay.method, customerId: bill.customerId || null,
      customerName: (bill.customer && bill.customer.name) || '', customerMobile: (bill.customer && bill.customer.mobile) || '',
      itemCount: (bill.items || []).reduce(function (n, i) { return n + i.qty; }, 0),
      receivedPaise: Math.min(pay.receivedPaise || 0, bill.totalPaise),
      balancePaise: bill.status === 'void' ? 0 : pay.balancePaise || 0,
      discountPaise: (bill.discountPaise || 0) + (bill.offerDiscountPaise || 0),
      createdAt: bill.createdAt
    };
    for (var i = 0; i < b.items.length; i++) if (b.items[i].id === bill.id) { b.items[i] = row; return; }
    b.items.unshift(row);
  }

  function newBill() {
    S.lastSaved = null;
    S.saveError = null;
    if (!S.cart.lines.length) S.cart = emptyCart();
    saveCart();
    if (viewName() !== 'pos') { go('/billing'); return; }
    rerender();
    global.scrollTo(0, 0);
  }

  /* ======================================================= THE SAVED INVOICE

     In the form's place on a desktop, a third page of its own on a phone, and a
     page from Bills. Everything here reads the saved bill, fetched again after a
     refresh, so sharing, printing and downloading can be repeated freely and never
     make another sale. */
  function invoiceActsHTML(b) {
    var id = esc(b.id);
    return '<button class="btn btn--outline" data-qb="inv-pdf" data-id="' + id + '">' + icon('install') + 'Download PDF</button>' +
      '<button class="btn btn--outline" data-qb="inv-share" data-id="' + id + '">' + icon('share') + 'Share Invoice</button>' +
      '<button class="btn qb-btn" data-qb="inv-wa" data-id="' + id + '">' + icon('share') + 'WhatsApp Share</button>' +
      '<span class="qb-invprint">' + sizeSelectHTML('qbSize') +
      '<button class="btn btn--outline" data-qb="print-saved" data-id="' + id + '">' + icon('printer') + 'Print Invoice</button></span>';
  }
  function renderInvoice(page, id) {
    var b = billFor(page, id, 'invoice');
    if (b) page.innerHTML = frame('invoice', invoicePageHTML(b));
  }
  function invoicePageHTML(b) {
    var isVoid = b.status === 'void';
    return '<div class="qb-invpage shell">' +
      '<div class="qb-invpage__head"><span class="qb-saved__ico">' + icon('checkCircle') + '</span>' +
      '<div class="grow"><h2>' + (isVoid ? 'Bill voided' : 'Bill saved') + '</h2>' +
      '<p>' + esc(b.number) + ' · ' + inr(b.totalPaise) + ' · ' + esc(isVoid ? 'VOID' : label(STATUSES, b.payment.status)) + '</p></div></div>' +
      '<div class="qb-invacts">' + invoiceActsHTML(b) +
      '<button class="btn btn--outline" data-qb="new-bill">' + icon('plus') + 'New Bill</button></div>' +
      '<div class="qb-preview qb-preview--full">' + invoiceHTML(b, 'preview') + '</div>' +
      '<div class="qb-done__more">' +
      '<button class="qb-link" data-qb="labels" data-id="' + esc(b.id) + '">' + icon('tag') + 'Print Product Labels</button>' +
      '<a class="qb-link" href="/billing/bills/' + encodeURIComponent(b.id) + '">' + icon('linkOut') + 'Open bill</a></div>' +
      '</div>';
  }

  function billById(id) { return S.billCache[id]; }
  function pdfWords(b) {
    return {
      money: M.format, when: when,
      offer: function (o) { return o.name + ' (' + OF.valueText(o, inr) + ')'; },
      method: label(METHODS, b.payment.method), status: label(STATUSES, b.payment.status)
    };
  }
  function invoiceFile(b) {
    return new File([SM.shopPdf.invoiceBlob(b, shopInfo(), pdfWords(b))], 'Invoice-' + b.number + '.pdf', { type: 'application/pdf' });
  }
  function downloadInvoice(b) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(invoiceFile(b));
    a.download = 'Invoice-' + b.number + '.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 30000);
    toast('Invoice downloaded', 'checkCircle');
  }

  /* ------------------------------------------------------- WhatsApp sheet

     The link has to exist before WhatsApp opens, so it is made first and the
     button is a plain link the person presses themselves. Pressing it, closing
     WhatsApp or sending nothing all leave the bill exactly as it was. */
  function shareMessage(b, url) {
    return SH.invoiceMessage({
      customerName: (b.customer && b.customer.name) || '',
      shopName: shopInfo().name, number: b.number, total: inr(b.totalPaise),
      paid: inr(Math.min(b.payment.receivedPaise || 0, b.totalPaise)), balance: inr(b.payment.balancePaise || 0),
      url: url
    });
  }
  function canShareFile() {
    if (!global.navigator.canShare || !global.File) return false;
    try { return global.navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] }); } catch (e) { return false; }
  }
  function waHref() {
    var sh = S.sheet;
    return SH.whatsappUrl(SH.whatsappNumber(sh.to), sh.text);
  }
  function waFootHTML() {
    var sh = S.sheet;
    var badNumber = digitsOf(sh.to).length > 0 && !SH.whatsappNumber(sh.to);
    return (canShareFile() ? '<button class="btn btn--outline" data-qb="wa-file">' + icon('share') + 'Share PDF</button>' : '') +
      (sh.loading
        ? '<button class="btn qb-btn grow" disabled><span class="qb-spin"></span>Preparing…</button>'
        : '<a class="btn qb-btn grow' + (badNumber ? ' is-off' : '') + '" id="qbWaGo" href="' + esc(badNumber ? '#' : waHref()) + '" target="_blank" rel="noopener noreferrer"' + (badNumber ? ' aria-disabled="true"' : '') + '>' + icon('share') + 'Open WhatsApp</a>');
  }
  function openWhatsApp(b) {
    var c = b.customer || {};
    var sh = { type: 'wa', billId: b.id, to: c.whatsapp || c.mobile || '', text: shareMessage(b, ''), loading: true, linkFailed: false };
    S.sheet = sh;
    openSheet('wa',
      '<div class="sheet__grab"></div><div class="sheet__head"><h3 class="t-h3 grow">Share on WhatsApp</h3>' +
      '<button class="iconbtn" data-qb="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<div class="sheet__body qb-form">' +
      fieldHTML('qbWaTo', 'wato', 'WhatsApp number', false, '<input class="input qb-in" id="qbWaTo" type="tel" inputmode="tel" autocomplete="off" value="' + esc(sh.to) + '" placeholder="Leave empty to choose in WhatsApp" data-qbi="wa-to" />') +
      fieldHTML('qbWaText', 'watext', 'Message', false, '<textarea class="input qb-in qb-notes" id="qbWaText" rows="11" data-qbi="wa-text">' + esc(sh.text) + '</textarea>') +
      '<small class="qb-help" id="qbWaNote">You press send in WhatsApp. The message carries a link to the invoice; WhatsApp cannot attach a PDF by link, so use Download PDF or Share PDF for the file.</small>' +
      '</div><div class="sheet__foot" id="qbWaFoot">' + waFootHTML() + '</div>', 'Share on WhatsApp');
    API.bill({ action: 'share', billId: b.id }).then(function (r) {
      if (S.sheet !== sh) return;
      sh.loading = false;
      sh.text = shareMessage(b, global.location.origin + '/i/' + r.token);
      var box = el('qbWaText');
      if (box) box.value = sh.text;
      paint('qbWaFoot', waFootHTML());
    }, function (err) {
      if (S.sheet !== sh) return;
      sh.loading = false;
      paint('qbWaNote', esc('The invoice link could not be made (' + say(err) + '). The message below has no link: send the PDF instead.'));
      paint('qbWaFoot', waFootHTML());
    });
  }
  function shareFile() {
    var sh = S.sheet;
    var b = sh && billById(sh.billId);
    if (!b) return;
    global.navigator.share({ files: [invoiceFile(b)], text: sh.text }).catch(function (err) {
      /* backing out of the share sheet is not a failure, and changes nothing */
      if (err && err.name !== 'AbortError') toast('Could not open sharing here. Download the invoice instead.', 'alert');
    });
  }

  /* Share Invoice: the PDF through the phone's own share sheet where it can carry
     a file, otherwise the invoice's link. Nothing here says it was sent, because
     only the person sharing knows that. */
  function copyLink(url) {
    var clip = global.navigator.clipboard;
    if (!clip) { toast('Could not copy the link here. Use WhatsApp Share instead.', 'alert'); return; }
    clip.writeText(url).then(function () {
      toast('Invoice link copied. Paste it where you want to send it.', 'checkCircle');
    }, function () { toast('Could not copy the link here. Use WhatsApp Share instead.', 'alert'); });
  }
  function shareInvoice(b) {
    var title = 'Invoice ' + b.number;
    var bail = function (err) {
      if (err && err.name !== 'AbortError') toast('Could not open sharing here. Download the invoice instead.', 'alert');
    };
    if (canShareFile()) {
      global.navigator.share({ files: [invoiceFile(b)], title: title, text: shareMessage(b, '') }).catch(bail);
      return;
    }
    API.bill({ action: 'share', billId: b.id }).then(function (r) {
      var url = global.location.origin + '/i/' + r.token;
      if (!global.navigator.share) { copyLink(url); return; }
      global.navigator.share({ title: title, text: shareMessage(b, ''), url: url }).catch(function (err) {
        if (err && err.name === 'NotAllowedError') copyLink(url); else bail(err);
      });
    }, function (err) { toast(say(err), 'alert'); });
  }

  /* ============================================================ BILLS LIST

     Every matching bill, by date, once. The figures on a group are added up from
     the rows under it, so they always describe what is on screen. Search goes to
     the server; a date range too, because it decides which bills to read; and the
     rest is decided here over the rows that came back. */
  function renderBills(page) {
    var b = S.bills;
    var n = billFilterCount();
    page.innerHTML = frame('bills',
      '<div class="qb-list shell">' +
      '<div class="qb-list__head"><label class="qb-search">' + icon('search') +
      '<input id="qbBillQ" type="search" autocomplete="off" placeholder="Bill number, customer name or mobile" value="' + esc(b.q) + '" data-qbi="bills-q" aria-label="Search bills" /></label>' +
      '<button type="button" class="qb-filterbtn' + (n ? ' is-on' : '') + '" data-qb="bills-filter" aria-label="Filter bills' + (n ? ', ' + n + ' active' : '') + '">' + icon('filter') +
      (n ? '<em class="qb-pmcount">' + n + '</em>' : '') + '</button></div>' +
      '<div id="qbBillList">' + billListHTML() + '</div></div>');
    if (!b.loaded && !b.loading) loadBills(true);
  }

  function billFilterCount() {
    var f = S.bills.filter;
    return (f.period ? 1 : 0) + (f.status !== 'all' ? 1 : 0);
  }
  /** The chosen dates, as moments and as words, or null for all dates. */
  function billRange() {
    var f = S.bills.filter;
    if (!f.period) return null;
    var p = f.period === 'custom' ? { from: f.from, to: f.to } : PD.period(f.period, Date.now());
    return {
      fromMs: p.from ? PD.dayStart(p.from) : 0,
      toMs: PD.dayStart(PD.addDays(p.to, 1)),
      title: f.label || PD.periodName(f.period) || 'Custom Date Range',
      range: p.from ? PD.rangeName(p.from, p.to) : 'Up to ' + PD.dayName(p.to)
    };
  }
  function shownBills() {
    var b = S.bills, st = b.filter.status, range = billRange();
    return b.items.filter(function (x) {
      if (st !== 'all' && PD.statusOf(x) !== st) return false;
      return !range || (x.createdAt >= range.fromMs && x.createdAt < range.toMs);
    });
  }
  function resetBillFilter() {
    var b = S.bills;
    if (b.filter.period || b.q) b.loaded = false;
    b.filter = blankBillFilter();
    b.q = '';
    closeSheet();
    rerender();
  }

  function openBillFilter() {
    var f = S.bills.filter;
    S.sheet = { type: 'billfilter', period: f.period, from: f.from, to: f.to, status: f.status };
    openSheet('billfilter',
      '<div class="sheet__grab"></div><div class="sheet__head"><h3 class="t-h3 grow">Filter bills</h3>' +
      '<button class="iconbtn" data-qb="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<div class="sheet__body qb-form" id="qbBFBody">' + billFilterBodyHTML() + '</div>' +
      '<div class="sheet__foot"><button class="btn btn--ghost" data-qb="bf-reset">Reset Filters</button>' +
      '<button class="btn qb-btn grow" data-qb="bf-go">' + icon('check') + 'Show bills</button></div>', 'Filter bills');
  }
  function billFilterBodyHTML() {
    var sh = S.sheet;
    var chips = function (list, cur, act, name) {
      return '<div class="qb-chips qb-chips--wrap" role="group" aria-label="' + name + '">' + list.map(function (x) {
        var on = cur === x[0];
        return '<button type="button" class="qb-chip' + (on ? ' is-on' : '') + '" data-qb="' + act + '" data-id="' + x[0] + '" aria-pressed="' + on + '">' + x[1] + '</button>';
      }).join('') + '</div>';
    };
    return '<span class="qb-lab">Date</span>' +
      chips([['', 'All Dates']].concat(PD.PERIODS, [['custom', 'Custom Date Range']]), sh.period, 'bf-date', 'Date') +
      (sh.period === 'custom'
        ? '<div class="qb-form__row">' +
          fieldHTML('qbBFFrom', 'bffrom', 'From', false, '<input class="input qb-in" type="date" id="qbBFFrom" value="' + esc(sh.from) + '" data-qbi="bf-from" />') +
          fieldHTML('qbBFTo', 'bfto', 'To', false, '<input class="input qb-in" type="date" id="qbBFTo" value="' + esc(sh.to) + '" data-qbi="bf-to" />') +
          '</div><small class="qb-err" id="qbBFErr"></small>'
        : '') +
      '<span class="qb-lab">Payment status</span>' +
      chips(BILL_STATUSES, sh.status, 'bf-status', 'Payment status');
  }
  function applyBillFilter() {
    var sh = S.sheet, b = S.bills;
    if (!sh || sh.type !== 'billfilter') return;
    var from = sh.period === 'custom' ? sh.from : '';
    var to = sh.period === 'custom' ? sh.to : '';
    if (sh.period === 'custom') {
      if (!from && !to) { paint('qbBFErr', 'Choose a start date, an end date or both.'); return; }
      if (!to) to = PD.dayKey(Date.now());
      if (from > to) { var swap = from; from = to; to = swap; }
    }
    var f = b.filter;
    if (sh.period !== f.period || from !== f.from || to !== f.to) b.loaded = false;
    b.filter = { period: sh.period, from: from, to: to, status: sh.status, label: '' };
    closeSheet();
    rerender();
  }

  function loadBills(fresh) {
    var b = S.bills;
    var ticket = ++b.ticket;
    var uid = S.uid;
    b.loading = true;
    if (fresh) { b.items = []; b.cursor = null; }
    paint('qbBillList', billListHTML());
    var range = b.q ? null : billRange();
    API.bills({ q: b.q, limit: BILL_PAGE, from: range ? range.fromMs : null, to: range ? range.toMs : null, cursor: fresh ? null : b.cursor }).then(function (r) {
      if (ticket !== b.ticket || S.uid !== uid) return;
      b.items = fresh ? r.bills : b.items.concat(r.bills);
      b.cursor = r.nextCursor;
      b.loaded = true;
      b.error = null;
    }, function (err) {
      if (ticket !== b.ticket || S.uid !== uid) return;
      b.error = err;
    }).then(function () {
      if (ticket !== b.ticket) return;
      b.loading = false;
      paint('qbBillList', billListHTML());
    });
  }

  function billListHTML() {
    var b = S.bills;
    if (b.error && !b.items.length) {
      return C.state({ icon: 'alert', title: 'Could not load bills', text: say(b.error),
        action: '<button class="btn btn--outline btn--sm" data-qb="bills-retry">' + icon('refresh') + 'Try again</button>' });
    }
    var rows = shownBills();
    var more = b.cursor
      ? '<div class="qb-more"><button class="btn btn--outline" data-qb="bills-more"' + (b.loading ? ' disabled' : '') + '>' +
        (b.loading ? 'Loading…' : 'Load older bills') + '</button></div><p class="qb-hint">The totals above cover the bills loaded so far.</p>'
      : '';
    var filtered = !!(b.q || billFilterCount());
    if (!rows.length) {
      if (b.loading) return C.skelRows(5);
      if (!filtered) {
        return C.state({ icon: 'receipt', title: 'No bills yet', text: 'Saved bills appear here, newest first.',
          action: '<a class="btn qb-btn btn--sm" href="/billing">' + icon('plus') + 'New Bill</a>' });
      }
      return C.state({ icon: 'receipt', title: b.q ? 'No bills match “' + b.q + '”' : 'No bills match these filters',
        text: b.q ? 'Search by bill number (QB-0012 or 12), customer name, or mobile number.' : 'Try a different date or payment status.',
        action: '<button class="btn btn--outline btn--sm" data-qb="bills-reset">Reset Filters</button>' }) + more;
    }
    var range = billRange();
    var groups = range
      ? [{ title: range.title, range: range.range, rows: rows.slice().sort(function (x, y) { return y.createdAt - x.createdAt; }), stats: PD.billStats(rows) }]
      : PD.groupBills(rows, Date.now()).filter(function (g) { return g.rows.length || (g.id === 'today' && !filtered); });
    return groups.map(billGroupHTML).join('') + more;
  }

  function billGroupHTML(g) {
    var s = g.stats;
    var fig = function (k, v) { return '<div><dt>' + k + '</dt><dd>' + inr(v) + '</dd></div>'; };
    var count = s.bills + (s.bills === 1 ? ' Bill' : ' Bills') + (s.voids ? ' · ' + s.voids + ' Void' : '');
    return '<section class="qb-bgroup" aria-label="' + esc(g.title) + '">' +
      '<header class="qb-bgroup__head"><div class="qb-bgroup__t"><h2>' + esc(g.title) + '</h2>' +
      '<span>' + esc([g.range, count].filter(Boolean).join(' · ')) + '</span></div>' +
      '<dl class="qb-bgroup__s">' + fig('Total Sales', s.salesPaise) + fig('Collected', s.collectedPaise) + fig('Outstanding', s.outstandingPaise) + '</dl></header>' +
      (g.rows.length ? '<div class="qb-bills">' + g.rows.map(billRowHTML).join('') + '</div>' : '<p class="qb-hint qb-bgroup__none">No bills yet today.</p>') +
      '</section>';
  }
  function billRowHTML(x) {
    return '<a class="qb-brow" href="/billing/bills/' + encodeURIComponent(x.id) + '">' +
      '<span class="qb-brow__no">' + esc(x.number) + '</span>' +
      '<span class="qb-brow__who"><b>' + esc(x.customerName || 'Walk-in') + '</b>' +
      '<span>' + esc(when(x.createdAt)) + ' · ' + x.itemCount + (x.itemCount === 1 ? ' item' : ' items') + (x.customerMobile ? ' · ' + esc(x.customerMobile) : '') + '</span></span>' +
      '<span class="qb-brow__amt">' + inr(x.totalPaise) + statusPill(PD.statusOf(x)) + '</span></a>';
  }

  function statusPill(st) {
    var map = { paid: ['pill--ok', 'Paid'], partial: ['pill--warn', 'Partially Paid'], unpaid: ['pill--bad', 'Unpaid'], void: ['qb-pill--void', 'VOID'] };
    var m = map[st] || ['', st];
    return '<span class="pill ' + m[0] + '">' + m[1] + '</span>';
  }

  /* ============================================================= ONE BILL */
  /** A saved bill from memory, or null while it is read for the page asking. */
  function billFor(page, id, view) {
    var b = S.billCache[id];
    if (b) return b;
    page.innerHTML = frame(view, '<div class="shell qb-billview">' + C.skelRows(4) + '</div>');
    var uid = S.uid;
    API.getBill(id).then(function (r) {
      if (S.uid !== uid) return;
      S.billCache[id] = r.bill;
      if (onBilling() && params[1] === id) rerender();
    }, function (err) {
      if (onBilling() && params[1] === id) {
        ctx.page().innerHTML = frame(view, '<div class="shell">' + C.state({ icon: 'alert', title: 'Could not open this bill', text: say(err),
          action: '<a class="btn btn--outline btn--sm" href="/billing/bills">' + icon('chevronLeft') + 'All bills</a>' }) + '</div>');
      }
    });
    return null;
  }
  function renderBillView(page, id) {
    var b = billFor(page, id, 'bill');
    if (!b) return;
    var isVoid = b.status === 'void';
    var hist = (b.history || []).map(function (h) {
      var what = h.action === 'created' ? 'Bill saved' : h.action === 'payment'
        ? 'Payment updated: ' + label(STATUSES, h.from) + ' → ' + label(STATUSES, h.to) + (h.receivedPaise != null ? ' (' + inr(h.receivedPaise) + ' received)' : '')
        : h.action === 'void' ? 'Voided — ' + (h.reason || '') + (h.restored && h.restored.length ? ' · stock restored' : '') : h.action;
      return '<li><span>' + esc(when(h.at)) + '</span>' + esc(what) + '</li>';
    }).join('');
    page.innerHTML = frame('bill',
      '<div class="shell qb-billview">' +
      '<div class="qb-billview__bar"><a class="btn btn--ghost btn--sm" href="/billing/bills">' + icon('chevronLeft') + 'All bills</a>' +
      '<div class="qb-billview__no"><h2>' + esc(b.number) + '</h2>' + statusPill(isVoid ? 'void' : b.payment.status) + '</div></div>' +
      '<div class="qb-billview__grid">' +
      '<div class="qb-preview qb-preview--full">' + invoiceHTML(b, 'preview') + '</div>' +
      '<div class="qb-billview__side">' +
      '<div class="qb-card2"><span class="qb-lab">Invoice</span><div class="qb-invacts">' + invoiceActsHTML(b) + '</div>' +
      '<button class="btn btn--outline btn--block" data-qb="labels" data-id="' + esc(b.id) + '">' + icon('tag') + 'Print Product Labels</button></div>' +
      (isVoid ? '' :
        '<div class="qb-card2"><span class="qb-lab">Payment</span>' +
        '<p class="qb-billview__pay">' + esc(label(STATUSES, b.payment.status)) + ' · ' + esc(label(METHODS, b.payment.method)) +
        ' · received ' + inr(b.payment.receivedPaise) + (b.payment.balancePaise ? ' · <b class="qb-due">' + inr(b.payment.balancePaise) + ' due</b>' : '') + '</p>' +
        (b.payment.status !== 'paid' ? '<button class="btn btn--outline btn--block" data-qb="record-payment" data-id="' + esc(b.id) + '">' + icon('checkCircle') + 'Record payment</button>' : '') +
        '</div>') +
      (b.customerId ? '<div class="qb-card2"><span class="qb-lab">Customer</span>' +
        '<a class="qb-link" href="/billing/customers/' + encodeURIComponent(b.customerId) + '">' + icon('user') + esc((b.customer && b.customer.name) || 'Open customer') + '</a></div>' : '') +
      '<div class="qb-card2"><span class="qb-lab">History</span><ul class="qb-hist">' + hist + '</ul>' +
      (isVoid ? '' : '<button class="btn btn--ghost btn--block qb-danger" data-qb="void" data-id="' + esc(b.id) + '">' + icon('alert') + 'Void this bill</button>') +
      '</div>' +
      '</div></div></div>');
  }

  /* ============================================================== PRODUCTS */
  function renderProducts(page) {
    var f = S.prodFilter;
    var view = function (v, ic, text) {
      var on = S.prodView === v;
      return '<button type="button" class="' + (on ? 'is-on' : '') + '" data-qb="pv" data-id="' + v + '" aria-pressed="' + on + '" aria-label="' + text + ' view">' + icon(ic) + '<span>' + text + '</span></button>';
    };
    page.innerHTML = frame('products',
      '<div class="qb-pm">' +
      '<div class="qb-pmbar">' +
      '<label class="qb-pmsearch">' + icon('search') +
      '<input id="qbProdQ" type="search" autocomplete="off" placeholder="Search product, model, SKU, shelf..." value="' + esc(f.q) + '" data-qbi="prod-q" aria-label="Search products" />' +
      '<button type="button" class="qb-pmclear" id="qbProdClear" data-qb="pq-clear" aria-label="Clear search"' + (f.q ? '' : ' hidden') + '>' + icon('close') + '</button></label>' +
      '<div class="qb-popw"><button type="button" class="qb-toolbtn" id="qbPopFiltersBtn" data-qb="pop" data-id="filters" aria-haspopup="dialog" aria-expanded="false">' + icon('filter') + '<span>Filters</span>' +
      '<em class="qb-pmcount" id="qbPfCount"' + (PF.activeCount(f) ? '' : ' hidden') + '>' + PF.activeCount(f) + '</em></button>' +
      '<div id="qbPopFilters"></div></div>' +
      '<div class="qb-popw" id="qbColsWrap"' + (S.prodView === 'table' ? '' : ' hidden') + '><button type="button" class="qb-toolbtn" id="qbPopColsBtn" data-qb="pop" data-id="cols" aria-haspopup="dialog" aria-expanded="false" aria-label="Choose columns">' + icon('sliders') + '<span>Columns</span></button>' +
      '<div id="qbPopCols"></div></div>' +
      '<div class="qb-seg qb-seg--sm qb-pmview" id="qbProdView" role="group" aria-label="Product view">' + view('table', 'list', 'Table') + view('grid', 'grid', 'Grid') + '</div>' +
      '<button type="button" class="btn qb-btn qb-pmadd" data-qb="add-product">' + icon('plus') + '<span>Add Product</span></button>' +
      '</div>' +
      '<div class="qb-pmlist" id="qbProdList">' + productListHTML() + '</div></div>');
    paintPops();
  }

  function productCtx() {
    return {
      categoryName: catName,
      brandName: function (id) { var b = SM.db && SM.db.brandById[id]; return b ? b.name : id; },
      compatOn: function (id) { return compatOn(catById(id)); },
      rupees: M.parseRupees
    };
  }
  function shownProducts() { return PF.filterProducts(S.products, S.prodFilter, productCtx()); }

  function productListHTML() {
    if (!S.products.length) {
      return C.state({ icon: 'box', title: 'No products yet', text: 'Add what you sell with a price, shelf and quantity.',
        action: '<button class="btn qb-btn btn--sm" data-qb="add-product">' + icon('plus') + 'Add Product</button>' });
    }
    var list = shownProducts();
    if (!list.length) {
      return '<div class="qb-empty">' + icon('search') + '<p>No products match this search and these filters.</p>' +
        '<button class="btn btn--outline btn--sm" data-qb="pf-reset">Reset Filters</button></div>';
    }
    if (S.prodFlash) {
      var at = list.map(function (p) { return p.id; }).indexOf(S.prodFlash);
      if (at >= S.prodLimit) S.prodLimit = at + 1;
    }
    var page = list.slice(0, S.prodLimit);
    return (S.prodView === 'grid' ? productGridHTML(page) : productTableHTML(page)) +
      '<div class="qb-pmfoot"><span>Showing ' + page.length + ' of ' + list.length + (list.length === 1 ? ' product' : ' products') + '</span>' +
      (page.length < list.length ? '<button class="btn btn--outline btn--sm" data-qb="prod-more">Show more</button>' : '') + '</div>';
  }

  function paintProductList() {
    var box = document.querySelector('.qb-ptwrap,.qb-pgrid');
    var top = box ? box.scrollTop : 0, left = box ? box.scrollLeft : 0;
    paint('qbProdList', productListHTML());
    box = document.querySelector('.qb-ptwrap,.qb-pgrid');
    if (box) { box.scrollTop = top; box.scrollLeft = left; }
    if (S.prodFlash) {
      var row = document.querySelector('[data-pid="' + S.prodFlash + '"]');
      if (row) { row.classList.add('is-new'); row.scrollIntoView({ block: 'center' }); }
      else toast('Saved. The current search or filters hide this product.', 'info');
      S.prodFlash = null;
    }
  }
  function filterChanged() {
    S.prodLimit = PRODUCT_PAGE;
    var n = PF.activeCount(S.prodFilter);
    var badge = el('qbPfCount');
    if (badge) { badge.hidden = !n; badge.textContent = n; }
    paintProductList();
  }

  /* ------------------------------------------------------- the table */
  function dashIfEmpty(v) { return v ? esc(v) : '<span class="qb-pt__none" aria-label="None">—</span>'; }
  function productLine(p) {
    var master = p.master && p.master.name !== p.name ? p.master.name : '';
    return [master, catName(p.categoryId)].filter(Boolean).join(' | ');
  }
  function groupsHTML(p) {
    var n = (p.groupIds || []).length;
    if (n) return '<span class="qb-gcount">' + n + (n === 1 ? ' Group' : ' Groups') + '</span>';
    return compatOn(catById(p.categoryId)) ? '<span class="qb-gcount qb-gcount--need">No groups</span>' : '';
  }
  function levelHTML(level) {
    if (level === 'in') return '';
    return '<span class="qb-lvl qb-lvl--' + level + '">' + icon('alert') + (level === 'low' ? 'Low' : 'Out') + '</span>';
  }
  /* The number is the control. A variant's stock is changed on the variant's own
     row, so the product's total only opens those rows. */
  function stockCellHTML(p, v) {
    var hasRows = hasVariants(p) && !v;
    var qty = v ? v.qty : p.qty;
    var level = v ? (qty <= 0 ? 'out' : qty <= p.lowStockAt ? 'low' : 'in') : PF.stockLevel(p);
    var vid = v ? v.id : '';
    var title = p.name + (v ? ' ' + variantLabel(v) : '');
    var e = S.stockEdit;
    if (e && e.id === p.id && e.vid === vid) {
      return '<form class="qb-qtyedit" data-qbf="qty" novalidate>' +
        '<input class="input qb-in" id="qbQtyIn" inputmode="numeric" autocomplete="off" maxlength="6" value="' + esc(e.value) + '" data-qbi="qty-edit" aria-label="New stock for ' + esc(title) + '"' + (e.busy ? ' disabled' : '') + ' />' +
        '<button class="qb-qtyact" type="submit" aria-label="Save stock"' + (e.busy ? ' disabled' : '') + '>' + (e.busy ? '<span class="qb-spin qb-spin--dark"></span>' : icon('check')) + '</button>' +
        '<button class="qb-qtyact" type="button" data-qb="qty-cancel" aria-label="Cancel"' + (e.busy ? ' disabled' : '') + '>' + icon('close') + '</button>' +
        (e.error ? '<small class="qb-err" role="alert">' + esc(e.error) + '</small>' : '') + '</form>';
    }
    if (hasRows) {
      var open = !!S.prodOpen[p.id];
      return '<button type="button" class="qb-qtybtn" data-qb="pv-rows" data-id="' + esc(p.id) + '" aria-expanded="' + open + '" aria-label="' + qty + ' in stock across ' + p.variants.length + ' variants of ' + esc(p.name) + '">' + qty + icon(open ? 'chevronUp' : 'chevronDown') + '</button>' + levelHTML(level);
    }
    return '<button type="button" class="qb-qtybtn" data-qb="qty-edit" data-id="' + esc(p.id) + '" data-vid="' + esc(vid) + '" aria-label="Stock of ' + esc(title) + ' is ' + qty + '. Change it">' + qty + '</button>' + levelHTML(level);
  }
  function td(key, html, label, cls, blank) {
    return '<td role="cell" class="c-' + key + (cls ? ' ' + cls : '') + (blank ? ' is-blank' : '') + '"' + (label ? ' data-l="' + label + '"' : '') + '>' + html + '</td>';
  }
  function productTableHTML(list) {
    var on = S.prodCols;
    var heads = [
      ['category', 'Category'], ['sku', 'SKU'], ['compat', 'Compatibility'], ['price', 'Selling Price', 'c-num'],
      ['cost', 'Purchase Price', 'c-num'], ['stock', 'Stock'], ['shelf', 'Shelf'], ['status', 'Status'], ['created', 'Created']
    ].filter(function (h) { return on[h[0]]; });
    var rowHTML = function (p) {
      var multi = hasVariants(p) && p.variants.length > 1;
      var cells = {
        category: td('category', esc(catName(p.categoryId))),
        sku: td('sku', dashIfEmpty(p.sku), 'SKU', '', !p.sku),
        compat: td('compat', groupsHTML(p) || dashIfEmpty(''), '', '', !groupsHTML(p)),
        price: td('price', (multi ? '<span class="qb-pt__from">From </span>' : '') + '<b>' + inr(p.pricePaise) + '</b>', '', 'c-num'),
        cost: td('cost', p.costPaise == null ? dashIfEmpty('') : inr(p.costPaise), 'Cost', 'c-num', p.costPaise == null),
        stock: td('stock', stockCellHTML(p), 'Stock'),
        shelf: td('shelf', dashIfEmpty(p.shelf), 'Shelf', '', !p.shelf),
        status: td('status', p.active ? '<span class="pill pill--ok">Active</span>' : '<span class="pill">Inactive</span>', '', '', p.active),
        created: td('created', esc(dateOnly(p.createdAt)), 'Created')
      };
      var row = '<tr role="row" data-pid="' + esc(p.id) + '"' + (p.active ? '' : ' class="is-off"') + '>' +
        td('product', '<div class="qb-pt__prod">' + (on.image ? thumbHTML(p, 'qb-thumb--xs') : '') +
          '<div class="qb-pt__name"><b>' + esc(p.name) + '</b><span>' + esc(productLine(p)) + '</span></div></div>') +
        heads.map(function (h) { return cells[h[0]]; }).join('') +
        td('actions', '<button class="btn btn--outline btn--sm" data-qb="edit-product" data-id="' + esc(p.id) + '" aria-label="Edit ' + esc(p.name) + '">' + icon('edit') + '<span>Edit</span></button>' +
          '<button class="iconbtn qb-pt__hist" data-qb="stock" data-id="' + esc(p.id) + '" title="Stock movements" aria-label="Stock movements for ' + esc(p.name) + '">' + icon('history') + '</button>') +
        '</tr>';
      if (!hasVariants(p) || !S.prodOpen[p.id]) return row;
      return row + p.variants.map(function (v) {
        var vc = {
          category: td('category', ''),
          sku: td('sku', dashIfEmpty(v.sku), 'SKU', '', !v.sku),
          compat: td('compat', ''),
          price: td('price', '<b>' + inr(v.pricePaise) + '</b>', '', 'c-num'),
          cost: td('cost', v.costPaise == null ? dashIfEmpty('') : inr(v.costPaise), 'Cost', 'c-num', v.costPaise == null),
          stock: td('stock', stockCellHTML(p, v), 'Stock'),
          shelf: td('shelf', dashIfEmpty(v.shelf), 'Shelf', '', !v.shelf),
          status: td('status', ''),
          created: td('created', '')
        };
        return '<tr role="row" class="qb-pt__v">' + td('product', '<div class="qb-pt__vname">' + esc(variantLabel(v)) + '</div>') +
          heads.map(function (h) { return vc[h[0]]; }).join('') + td('actions', '') + '</tr>';
      }).join('');
    };
    return '<div class="qb-ptwrap"><table class="qb-pt" role="table" aria-label="Products"><thead role="rowgroup"><tr role="row">' +
      '<th role="columnheader" scope="col" class="c-product">Product</th>' +
      heads.map(function (h) { return '<th role="columnheader" scope="col" class="c-' + h[0] + (h[2] ? ' ' + h[2] : '') + '">' + h[1] + '</th>'; }).join('') +
      '<th role="columnheader" scope="col" class="c-actions">Actions</th></tr></thead>' +
      '<tbody role="rowgroup">' + list.map(rowHTML).join('') + '</tbody></table></div>';
  }

  /* -------------------------------------------------------- the grid */
  function productGridHTML(list) {
    return '<div class="qb-pgrid">' + list.map(function (p) {
      var multi = hasVariants(p) && p.variants.length > 1;
      var meta = [p.sku ? 'SKU ' + p.sku : '', p.shelf ? 'Shelf ' + p.shelf : ''].filter(Boolean).join(' · ');
      return '<article class="qb-pc' + (p.active ? '' : ' is-off') + '" data-pid="' + esc(p.id) + '">' + thumbHTML(p, 'qb-thumb--grid') +
        '<b class="qb-pc__name">' + esc(p.name) + '</b>' +
        '<span class="qb-pc__meta">' + esc(catName(p.categoryId)) + (p.active ? '' : ' · Inactive') + '</span>' +
        (meta ? '<span class="qb-pc__meta">' + esc(meta) + '</span>' : '') +
        (groupsHTML(p) ? '<span class="qb-pc__meta">' + groupsHTML(p) + '</span>' : '') +
        '<div class="qb-pc__row"><b class="qb-pc__price">' + (multi ? 'From ' : '') + inr(p.pricePaise) + '</b>' +
        '<span class="qb-pc__stock">' + (hasVariants(p)
          ? '<span class="qb-pc__total">' + p.qty + ' in stock</span>' + levelHTML(PF.stockLevel(p))
          : stockCellHTML(p)) + '</span></div>' +
        '<div class="qb-pc__acts"><button class="btn btn--outline btn--sm" data-qb="edit-product" data-id="' + esc(p.id) + '" aria-label="Edit ' + esc(p.name) + '">' + icon('edit') + '<span>Edit</span></button>' +
        '<button class="iconbtn" data-qb="stock" data-id="' + esc(p.id) + '" title="Stock movements" aria-label="Stock movements for ' + esc(p.name) + '">' + icon('history') + '</button></div>' +
        '</article>';
    }).join('') + '</div>';
  }

  /* --------------------------------------------- changing stock in the row

     Stock goes through the same adjustment as the stock sheet, so it lands in the
     movement log as an adjustment and never as a sale. The figure the shop was
     looking at travels with it: if a bill has moved the stock since, the server
     refuses rather than overwrite that sale. */
  function stockCurrent(e) {
    var p = productById(e.id);
    if (!p) return null;
    if (!e.vid) return p.qty;
    var v = variantOf(p, e.vid);
    return v ? v.qty : null;
  }
  function focusQty() {
    var box = el('qbQtyIn');
    if (box) { box.focus(); box.select(); }
  }
  function startStockEdit(id, vid) {
    var e = S.stockEdit;
    if (e && e.busy) return;
    if (e && !(e.id === id && e.vid === vid) && !confirmDropStock()) { focusQty(); return; }
    var p = productById(id);
    var v = vid ? variantOf(p, vid) : null;
    S.stockEdit = { id: id, vid: vid, value: String(v ? v.qty : p.qty), adjustId: API.newId('a_'), sent: null, busy: false, error: '' };
    paintProductList();
    focusQty();
  }
  function stockEditDirty() {
    var e = S.stockEdit;
    return !!e && e.value.trim() !== String(stockCurrent(e));
  }
  function confirmDropStock() {
    return !stockEditDirty() || global.confirm('Discard the stock change you have not saved?');
  }
  function endStockEdit() {
    var e = S.stockEdit;
    S.stockEdit = null;
    paintProductList();
    var again = e && document.querySelector('[data-qb="qty-edit"][data-id="' + e.id + '"][data-vid="' + e.vid + '"]');
    if (again) again.focus();
  }
  function saveStockEdit() {
    var e = S.stockEdit;
    if (!e || e.busy) return;
    var text = e.value.trim();
    var cur = stockCurrent(e);
    if (!/^\d{1,6}$/.test(text)) {
      e.error = 'Enter a whole number, 0 or more';
      paintProductList();
      focusQty();
      return;
    }
    var next = Number(text);
    if (next === cur) { endStockEdit(); return; }
    if (e.sent !== text) { e.adjustId = API.newId('a_'); e.sent = text; }
    e.busy = true;
    e.error = '';
    paintProductList();
    var uid = S.uid;
    API.product({
      action: 'adjust', productId: e.id, adjustId: e.adjustId, delta: next - cur, expectedQty: cur,
      variantId: e.vid || undefined, note: 'Stock count'
    }).then(function (r) {
      if (S.uid !== uid) return;
      upsertProduct(r.product);
      var saved = e.vid ? variantOf(r.product, e.vid).qty : r.product.qty;
      toast('Stock is now ' + saved, 'checkCircle');
      if (S.stockEdit === e) endStockEdit(); else softAfterProductChange();
    }, function (err) {
      if (S.uid !== uid) return;
      e.busy = false;
      e.error = say(err);
      if (err.code === 'stock-changed') {
        /* someone else's sale is the true figure now, so that is what is shown */
        var p = productById(e.id);
        var v = e.vid ? variantOf(p, e.vid) : null;
        if (v) { p.qty += err.data.available - v.qty; v.qty = err.data.available; }
        else p.qty = err.data.available;
        e.value = String(err.data.available);
      }
      paintProductList();
      focusQty();
    });
  }

  /* ------------------------------------------------- filters and columns */
  function selectHTML(key, label, value, options) {
    return '<label class="qb-pf"><span>' + label + '</span><select class="input qb-in" data-qbi="pf" data-k="' + key + '">' +
      options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === value ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') +
      '</select></label>';
  }
  function filtersHTML() {
    var f = S.prodFilter;
    var opts = PF.options(S.products);
    var ctxp = productCtx();
    return '<div class="qb-pop" role="dialog" aria-label="Filter products">' +
      '<div class="qb-pop__head"><b>Filters</b><button type="button" class="qb-link" data-qb="pf-clear">Clear All</button>' +
      '<button type="button" class="qb-link" data-qb="pf-reset">Reset Filters</button></div>' +
      '<div class="qb-pop__grid">' +
      selectHTML('status', 'Status', f.status, [['all', 'All Statuses'], ['active', 'Active'], ['inactive', 'Inactive']]) +
      selectHTML('stock', 'Stock', f.stock, [['all', 'All Stock Statuses'], ['in', 'In Stock'], ['low', 'Low Stock'], ['out', 'Out of Stock']]) +
      selectHTML('cat', 'Category', f.cat, [['all', 'All Categories']].concat(S.categories.map(function (c) { return [c.id, c.name]; }))) +
      selectHTML('compat', 'Compatibility', f.compat, [['all', 'All Products'], ['has', 'Has Compatibility Groups'], ['none', 'No Compatibility Groups']]) +
      (opts.brands.length ? selectHTML('brand', 'Brand', f.brand, [['all', 'All Brands']].concat(opts.brands.map(function (b) { return [b, ctxp.brandName(b)]; }))) : '') +
      (opts.shelves.length ? selectHTML('shelf', 'Shelf', f.shelf, [['all', 'All Shelves']].concat(opts.shelves.map(function (s) { return [s, s]; }))) : '') +
      '<label class="qb-pf"><span>Price from ₹</span><input class="input qb-in" inputmode="decimal" autocomplete="off" value="' + esc(f.min) + '" data-qbi="pf-price" data-k="min" /></label>' +
      '<label class="qb-pf"><span>Price to ₹</span><input class="input qb-in" inputmode="decimal" autocomplete="off" value="' + esc(f.max) + '" data-qbi="pf-price" data-k="max" /></label>' +
      '</div></div>';
  }
  function columnsHTML() {
    return '<div class="qb-pop qb-pop--cols" role="dialog" aria-label="Choose columns">' +
      '<div class="qb-pop__head"><b>Columns</b><button type="button" class="qb-link" data-qb="pc-reset">Reset</button></div>' +
      '<label class="qb-check is-fixed"><input type="checkbox" checked disabled />Product name</label>' +
      PF.COLUMNS.map(function (c) {
        return '<label class="qb-check"><input type="checkbox" data-qbi="pc" data-k="' + c.key + '"' + (S.prodCols[c.key] ? ' checked' : '') + ' />' + c.label + '</label>';
      }).join('') + '</div>';
  }
  function paintPops() {
    var open = S.prodPop;
    paint('qbPopFilters', open === 'filters' ? filtersHTML() : '');
    paint('qbPopCols', open === 'cols' ? columnsHTML() : '');
    [['qbPopFiltersBtn', 'filters'], ['qbPopColsBtn', 'cols']].forEach(function (b) {
      var btn = el(b[0]);
      if (btn) btn.setAttribute('aria-expanded', String(open === b[1]));
    });
  }
  function openPop(which) {
    S.prodPop = S.prodPop === which ? null : which;
    paintPops();
    var first = S.prodPop && document.querySelector('.qb-pop select, .qb-pop input:not([disabled])');
    if (first) first.focus();
  }
  function closePop() {
    var which = S.prodPop;
    if (!which) return;
    S.prodPop = null;
    paintPops();
    var btn = el(which === 'filters' ? 'qbPopFiltersBtn' : 'qbPopColsBtn');
    if (btn) btn.focus();
  }
  function setProductView(v) {
    if (S.prodView === v) return;
    if (!confirmDropStock()) { focusQty(); return; }
    S.stockEdit = null;
    S.prodView = v;
    Array.prototype.forEach.call(document.querySelectorAll('#qbProdView button'), function (b) {
      var on = b.getAttribute('data-id') === v;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    var cols = el('qbColsWrap');
    if (cols) cols.hidden = v !== 'table';
    if (S.prodPop === 'cols') { S.prodPop = null; paintPops(); }
    paintProductList();
  }

  /* ==================================================== DISCOUNTS & OFFERS

     An offer points at categories, products or variants by id and holds no copy
     of them, so a product added to a category later is covered by the category's
     offer. Offers are never deleted: a bill keeps its own copy of what it was
     given, and an offer that is over is marked so. */
  var OFFER_TABS = [['all', 'All Offers'], ['active', 'Active'], ['scheduled', 'Scheduled'], ['expired', 'Expired'], ['paused', 'Paused']];
  var OFFER_STATES = { active: ['pill--ok', 'Active'], scheduled: ['pill--warn', 'Scheduled'], expired: ['', 'Expired'], paused: ['', 'Paused'] };
  var WHY_NOT = {
    'too-large': 'The discount is larger than this item’s price.',
    'min-qty': 'The minimum quantity has not been reached.',
    'min-bill': 'The bill is below this offer’s minimum.',
    'no-value': 'It comes to nothing on this price.',
    'bill-auto-off': 'Auto Apply is off for this bill.',
    'offer-auto-off': 'This offer’s Auto Apply is off.',
    removed: 'You removed the offer from this item.',
    'other-chosen': 'You chose another offer for this item.'
  };
  var LEVEL_NAMES = { variant: 'Variant', product: 'Product', category: 'Category' };

  function offerById(id) { return S.offers.filter(function (o) { return o.id === id; })[0] || null; }
  function offerState(o) { return OF.offerStatus(o, Date.now()); }
  function upsertOffer(o) {
    for (var i = 0; i < S.offers.length; i++) if (S.offers[i].id === o.id) { S.offers[i] = o; return; }
    S.offers.unshift(o);
  }
  function offerPill(o) {
    var st = OFFER_STATES[offerState(o)];
    return '<span class="pill ' + st[0] + '">' + st[1] + '</span>';
  }
  function offerProducts(o) { return activeProducts().filter(function (p) { return OF.covers(o, p); }); }
  function appliesToText(o) {
    if (o.target === 'category') return o.categoryIds.map(catName).join(', ');
    if (o.target === 'product') {
      return o.productIds.map(function (id) { var p = productById(id); return p ? p.name : 'A removed product'; }).join(', ');
    }
    return o.variants.map(function (v) {
      var p = productById(v.productId);
      var x = p && variantOf(p, v.variantId);
      return p ? p.name + (x ? ' (' + variantLabel(x) + ')' : '') : 'A removed product';
    }).join(', ');
  }
  function validityText(o) {
    var day = function (d, t) { return dayName(d) + ' ' + d.slice(0, 4) + (t ? ', ' + t : ''); };
    if (!o.startDate && !o.endDate) return 'Ongoing';
    if (!o.endDate) return 'From ' + day(o.startDate, o.startTime);
    if (!o.startDate) return 'Until ' + day(o.endDate, o.endTime);
    return day(o.startDate, o.startTime) + ' – ' + day(o.endDate, o.endTime);
  }

  function renderOffers(page) {
    var t = OF.offerTally(S.offers, activeProducts(), Date.now());
    var stat = function (label, n) { return '<div class="qb-ofstat"><b>' + n + '</b><span>' + label + '</span></div>'; };
    var f = S.offerFilter;
    page.innerHTML = frame('offers',
      '<div class="qb-of shell">' +
      '<div class="qb-ofhead"><h2>Discounts &amp; Offers</h2>' +
      '<button class="btn btn--outline btn--sm" data-qb="of-settings">' + icon('sliders') + '<span>Offer settings</span></button>' +
      '<button class="btn qb-btn btn--sm" data-qb="of-new">' + icon('plus') + 'Create New Offer</button></div>' +
      '<div class="qb-ofstats">' + stat('Total Offers', t.total) + stat('Active Offers', t.active) +
      stat('Scheduled Offers', t.scheduled) + stat('Expired Offers', t.expired) +
      stat('Products Covered', t.products) + stat('Categories Covered', t.categories) + '</div>' +
      '<section class="qb-sales" id="qbSales" aria-label="Sales Overview">' + salesHTML() + '</section>' +
      '<div class="qb-ofbar"><label class="qb-pmsearch">' + icon('search') +
      '<input id="qbOfferQ" type="search" autocomplete="off" placeholder="Search offer, product, category, SKU, variant..." value="' + esc(f.q) + '" data-qbi="of-search" aria-label="Search offers" /></label>' +
      '<div class="qb-chips" role="group" aria-label="Offer status">' + OFFER_TABS.map(function (t) {
        var on = f.status === t[0];
        return '<button class="qb-chip' + (on ? ' is-on' : '') + '" data-qb="of-tab" data-id="' + t[0] + '" aria-pressed="' + on + '">' + t[1] + '</button>';
      }).join('') + '</div></div>' +
      '<div id="qbOfferList">' + offerListHTML() + '</div></div>');
    if (!S.sales.data && !S.sales.loading && !S.sales.error) loadSales();
  }

  /* -------------------------------------------------------- the sales overview

     From the server's own record of each day, so these are the figures the
     Overview adds up: confirmed bills only, voids taken back off. */
  function salesRange() {
    var s = S.sales;
    return s.preset === 'custom' ? { from: s.from, to: s.to } : PD.period(s.preset, Date.now());
  }
  function loadSales() {
    var s = S.sales, r = salesRange(), uid = S.uid;
    var ticket = ++s.ticket;
    s.error = null;
    if (!r.from || !r.to) { s.loading = false; paint('qbSalesBody', salesBodyHTML()); return; }
    s.loading = true;
    paint('qbSalesBody', salesBodyHTML());
    API.sales({ from: r.from, to: r.to }).then(function (data) {
      if (ticket !== s.ticket || S.uid !== uid) return;
      s.data = data;
    }, function (err) {
      if (ticket !== s.ticket || S.uid !== uid) return;
      s.error = err;
    }).then(function () {
      if (ticket !== s.ticket) return;
      s.loading = false;
      paint('qbSalesBody', salesBodyHTML());
    });
  }
  function salesHTML() {
    var s = S.sales;
    var r = salesRange();
    return '<div class="qb-sec"><h2>Sales Overview</h2><span class="qb-count">' + esc(r.from && r.to ? PD.rangeName(r.from, r.to) : 'Choose dates') + '</span></div>' +
      '<div class="qb-chips" role="group" aria-label="Reporting period">' + PD.PERIODS.concat([['custom', 'Custom']]).map(function (p) {
        var on = s.preset === p[0];
        return '<button class="qb-chip' + (on ? ' is-on' : '') + '" data-qb="sales-preset" data-id="' + p[0] + '" aria-pressed="' + on + '">' + p[1] + '</button>';
      }).join('') + '</div>' +
      (s.preset === 'custom'
        ? '<div class="qb-range qb-sales__dates"><label>From <input class="input" type="date" id="qbSalesFrom" value="' + esc(s.from) + '" data-qbi="sales-range" /></label>' +
          '<label>To <input class="input" type="date" id="qbSalesTo" value="' + esc(s.to) + '" data-qbi="sales-range" /></label></div>'
        : '') +
      '<div id="qbSalesBody">' + salesBodyHTML() + '</div>';
  }
  function salesBodyHTML() {
    var s = S.sales, x = s.data;
    if (s.error) {
      return C.state({ icon: 'alert', title: 'Could not load the sales figures', text: say(s.error),
        action: '<button class="btn btn--outline btn--sm" data-qb="sales-retry">' + icon('refresh') + 'Try again</button>' });
    }
    if (s.loading || !x) {
      if (!s.loading && s.preset === 'custom') return '<p class="qb-hint">Choose both dates to see this period.</p>';
      return '<div class="qb-salesgrid">' + [0, 1, 2, 3, 4, 5].map(function () { return '<div class="qb-kpi"><div class="skel" style="height:44px"></div></div>'; }).join('') + '</div>';
    }
    var kpi = function (k, v, sub) {
      return '<div class="qb-kpi"><span class="qb-kpi__l">' + k + '</span><b>' + v + '</b>' + (sub ? '<span class="qb-kpi__s">' + sub + '</span>' : '') + '</div>';
    };
    return '<div class="qb-salesgrid">' +
      kpi('Total Sales', inr(x.salesPaise), x.bills + (x.bills === 1 ? ' confirmed bill' : ' confirmed bills')) +
      kpi('Discounted Sales', inr(x.discountedSalesPaise), 'on bills with a discount') +
      kpi('Total Discount Given', inr(x.discountPaise), 'offers and additional discounts') +
      kpi('Discounted Bills', String(x.discountedBills), 'of ' + x.bills + (x.bills === 1 ? ' bill' : ' bills')) +
      kpi('Average Discount', inr(x.averageDiscountPaise), 'per discounted bill') +
      kpi('Discount Sales Contribution', pct(x.contributionBp), 'of total sales') + '</div>' +
      '<p class="qb-sales__note">Collected in this period: <b>' + inr(x.collectedPaise) + '</b>. Sales are what confirmed bills came to, whether or not they are paid. Collected is the money received, and void bills count in neither.</p>';
  }

  function offerHay(o) {
    var names = offerProducts(o).map(function (p) {
      return p.name + ' ' + p.sku + ' ' + catName(p.categoryId) + ' ' + (p.variants || []).map(function (v) { return variantLabel(v) + ' ' + v.sku; }).join(' ');
    }).join(' ');
    return (o.name + ' ' + appliesToText(o) + ' ' + names).toLowerCase();
  }
  function offerListHTML() {
    var f = S.offerFilter;
    if (!S.offers.length) {
      return C.state({ icon: 'tag', title: 'No offers yet', text: 'Create an offer for a category, a product or one variant, and it applies itself on New Bill.',
        action: '<button class="btn qb-btn btn--sm" data-qb="of-new">' + icon('plus') + 'Create New Offer</button>' });
    }
    var words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    var list = S.offers.filter(function (o) {
      if (f.status !== 'all' && offerState(o) !== f.status) return false;
      if (!words.length) return true;
      var hay = offerHay(o);
      return words.every(function (w) { return hay.indexOf(w) > -1; });
    }).sort(function (a, b) { return b.createdAt - a.createdAt; });
    if (!list.length) return '<div class="qb-empty">' + icon('search') + '<p>No offers match this search and filter.</p></div>';
    var cell = function (key, html, label) { return td(key, html, label); };
    return '<div class="qb-ptwrap qb-ofwrap"><table class="qb-pt" role="table" aria-label="Offers"><thead role="rowgroup"><tr role="row">' +
      ['Offer Name', 'Discount', 'Applies To', 'Products Covered', 'Validity', 'Auto Apply', 'Status', 'Actions'].map(function (h, i) {
        return '<th role="columnheader" scope="col" class="' + (i === 0 ? 'c-product' : i === 7 ? 'c-actions' : '') + '">' + h + '</th>';
      }).join('') + '</tr></thead><tbody role="rowgroup">' + list.map(function (o) {
        var st = offerState(o);
        var over = st === 'expired';
        var running = st === 'active' || st === 'scheduled';
        var ended = !!o.endAt && Date.now() > o.endAt;
        return '<tr role="row"' + (over ? ' class="is-off"' : '') + '>' +
          td('product', '<div class="qb-pt__name"><b>' + esc(o.name) + '</b>' + (o.description ? '<span>' + esc(o.description) + '</span>' : '') + '</div>') +
          cell('value', '<b>' + esc(OF.valueText(o, inr)) + '</b>') +
          cell('target', '<span class="qb-ofapply"><em>' + LEVEL_NAMES[o.target] + '</em> ' + esc(appliesToText(o)) + '</span>') +
          cell('count', String(offerProducts(o).length), 'Products') +
          cell('valid', esc(validityText(o))) +
          cell('auto', '<label class="qb-switch"><input type="checkbox" data-qbi="of-auto" data-id="' + esc(o.id) + '"' + (o.autoApply ? ' checked' : '') + ' aria-label="Auto Apply for ' + esc(o.name) + '" /><i></i></label>', 'Auto Apply') +
          cell('status', offerPill(o)) +
          td('actions', '<button class="qb-link" data-qb="of-view" data-id="' + esc(o.id) + '">View</button>' +
            '<button class="qb-link" data-qb="of-edit" data-id="' + esc(o.id) + '">Edit</button>' +
            (running ? '<button class="qb-link" data-qb="of-status" data-id="' + esc(o.id) + '" data-to="paused">Pause</button>' : '') +
            ((st === 'paused' || over) && !ended ? '<button class="qb-link" data-qb="of-status" data-id="' + esc(o.id) + '" data-to="active">Activate</button>' : '') +
            (over ? '' : '<button class="qb-link qb-danger" data-qb="of-status" data-id="' + esc(o.id) + '" data-to="expired">Expire</button>')) +
          '</tr>';
      }).join('') + '</tbody></table></div>';
  }
  function paintOffers() {
    if (onBilling() && viewName() === 'offers') rerender();
  }

  function changeOffer(body, ok) {
    return API.offer(body).then(function (r) {
      upsertOffer(r.offer);
      toast(ok, 'checkCircle');
      paintOffers();
      offersMoved();
    }, function (e) { toast(say(e), 'alert'); paintOffers(); });
  }
  /** The cart reads the offers afresh, so a change here reaches an open bill at once. */
  function offersMoved() {
    S.offerKey = activeOfferKey();
    if (S.cart && S.cart.lines.length && (viewName() === 'pos' || viewName() === 'review')) cartChanged(false);
  }
  function activeOfferKey() {
    return S.offers.filter(function (o) { return offerState(o) === 'active'; }).map(function (o) { return o.id; }).sort().join();
  }

  /* ---------------------------------------------------------- the offer form */
  function openOfferForm(id) {
    var o = id ? offerById(id) : null;
    S.sheet = {
      type: 'offer', mode: o ? 'edit' : 'create', id: o ? o.id : API.newId('o_'), busy: false,
      kind: o ? o.kind : 'percent', fixedMode: (o && o.fixedMode) || 'unit',
      target: o ? o.target : 'category',
      categoryIds: o ? o.categoryIds.slice() : [],
      productIds: o ? o.productIds.slice() : [],
      variants: o ? o.variants.map(function (v) { return { productId: v.productId, variantId: v.variantId }; }) : [],
      q: '', variantProduct: null
    };
    var v = o || {};
    var row = function () { return '<div class="qb-form__row">' + Array.prototype.join.call(arguments, '') + '</div>'; };
    var sec = function (n, t) { return '<h4 class="qb-fsec">' + n + '. ' + t + '</h4>'; };
    openSheet('offer',
      '<div class="sheet__grab"></div><div class="sheet__head"><h3 class="t-h3 grow">' + (o ? 'Edit offer' : 'Create New Offer') + '</h3>' +
      '<button class="iconbtn" data-qb="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<form class="sheet__body qb-form" id="qbOfferForm" data-qbf="offer" novalidate>' +
      '<div class="qb-ok qb-ok--bad" id="qbOFail" hidden></div>' +
      sec(1, 'Basic information') +
      fieldHTML('qbOName', 'oname', 'Offer name', true, '<input class="input qb-in" id="qbOName" maxlength="80" autocomplete="off" placeholder="e.g. Tempered Glass 10% OFF" value="' + esc(v.name || '') + '" />') +
      fieldHTML('qbODesc', 'odesc', 'Internal description', false, '<input class="input qb-in" id="qbODesc" maxlength="300" autocomplete="off" placeholder="Optional. Customers do not see this." value="' + esc(v.description || '') + '" />') +
      sec(2, 'Discount') +
      '<div id="qbOValue">' + offerValueHTML(v) + '</div>' +
      sec(3, 'Applies to') +
      '<div id="qbOTarget">' + offerTargetHTML() + '</div>' +
      sec(4, 'Validity') +
      '<small class="qb-help">Leave the dates empty for an ongoing offer. Times are Indian Standard Time.</small>' +
      row(fieldHTML('qbOStartD', 'ostart', 'Start date', false, '<input class="input qb-in" type="date" id="qbOStartD" value="' + esc(v.startDate || '') + '" />'),
        fieldHTML('qbOStartT', 'ostartt', 'Start time', false, '<input class="input qb-in" type="time" id="qbOStartT" value="' + esc(v.startTime || '') + '" />')) +
      row(fieldHTML('qbOEndD', 'oend', 'End date', false, '<input class="input qb-in" type="date" id="qbOEndD" value="' + esc(v.endDate || '') + '" />'),
        fieldHTML('qbOEndT', 'oendt', 'End time', false, '<input class="input qb-in" type="time" id="qbOEndT" value="' + esc(v.endTime || '') + '" />')) +
      sec(5, 'Eligibility') +
      row(fieldHTML('qbOMinQ', 'ominq', 'Minimum quantity', false, '<input class="input qb-in" id="qbOMinQ" inputmode="numeric" autocomplete="off" value="' + esc(v.minQty || 1) + '" />'),
        fieldHTML('qbOMinB', 'ominb', 'Minimum bill value', false, '<label class="qb-prefix"><span>₹</span><input class="input qb-in" id="qbOMinB" inputmode="decimal" autocomplete="off" placeholder="None" value="' + (v.minBillPaise ? esc(M.toInput(v.minBillPaise)) : '') + '" /></label>')) +
      sec(6, 'Priority and stacking') +
      row(fieldHTML('qbOPrio', 'oprio', 'Priority', false, '<input class="input qb-in" id="qbOPrio" inputmode="numeric" autocomplete="off" value="' + esc(v.priority || 100) + '" /><small class="qb-help">A lower number wins.</small>'),
        '<label class="qb-check qb-ofcheck"><input type="checkbox" id="qbOStack"' + (v.stackable ? ' checked' : '') + ' />Can combine with other offers</label>') +
      '<small class="qb-help">Combining only happens when it is switched on in Offer settings.</small>' +
      sec(7, 'Auto Apply') +
      '<label class="qb-check"><input type="checkbox" id="qbOAuto"' + ((o ? o.autoApply : S.offerSettings.autoApplyDefault !== false) ? ' checked' : '') + ' />Apply this offer automatically on New Bill</label>' +
      '<label class="qb-check"><input type="checkbox" id="qbOPaused"' + (o && o.status === 'paused' ? ' checked' : '') + ' />Save as paused</label>' +
      '<button type="submit" hidden></button></form>' +
      '<div class="sheet__foot"><button class="btn btn--ghost" data-qb="close-sheet">Cancel</button>' +
      '<button class="btn qb-btn grow" id="qbOGo" data-qb="of-save">' + icon('check') + 'Save Offer</button></div>',
      o ? 'Edit offer' : 'Create New Offer');
  }

  function offerValueHTML(v) {
    var sh = S.sheet;
    var seg = function (key, val, text) {
      return '<button type="button" class="' + (sh[key] === val ? 'is-on' : '') + '" data-qb="of-seg" data-id="' + val + '" data-k="' + key + '" aria-pressed="' + (sh[key] === val) + '">' + text + '</button>';
    };
    var pct = sh.kind === 'percent';
    var quick = (pct ? ['5', '10', '15', '20'] : ['20', '50', '100']).map(function (n) {
      return '<button type="button" class="qb-chip" data-qb="of-quick" data-id="' + n + '">' + (pct ? n + '%' : '₹' + n) + '</button>';
    }).join('');
    var valueNow = (el('qbOValueIn') || {}).value;
    var value = valueNow != null ? valueNow : (pct ? (v.percentBp ? String(v.percentBp / 100) : '') : (v.amountPaise ? M.toInput(v.amountPaise) : ''));
    var maxNow = (el('qbOMax') || {}).value;
    var max = maxNow != null ? maxNow : (v.maxPaise ? M.toInput(v.maxPaise) : '');
    return '<div class="qb-seg" role="group" aria-label="Discount type">' + seg('kind', 'percent', 'Percentage') + seg('kind', 'fixed', 'Fixed amount') + '</div>' +
      '<div class="qb-ofquick">' + quick + '</div>' +
      '<div class="qb-form__row">' +
      fieldHTML('qbOValueIn', 'ovalue', pct ? 'Percentage off' : 'Amount off', true,
        '<label class="' + (pct ? 'qb-suffix' : 'qb-prefix') + '">' + (pct ? '' : '<span>₹</span>') + '<input class="input qb-in" id="qbOValueIn" inputmode="decimal" autocomplete="off" value="' + esc(value) + '" />' + (pct ? '<span>%</span>' : '') + '</label>') +
      (pct
        ? fieldHTML('qbOMax', 'omax', 'Maximum discount per line', false, '<label class="qb-prefix"><span>₹</span><input class="input qb-in" id="qbOMax" inputmode="decimal" autocomplete="off" placeholder="No limit" value="' + esc(max) + '" /></label>')
        : '<div class="qb-ff"><span class="qb-lab">Applies</span><div class="qb-seg" role="group" aria-label="How the fixed amount applies">' + seg('fixedMode', 'unit', 'Per unit') + seg('fixedMode', 'line', 'Per line') + '</div></div>') +
      '</div>';
  }

  function offerTargetHTML() {
    var sh = S.sheet;
    var seg = function (val, text) {
      return '<button type="button" class="' + (sh.target === val ? 'is-on' : '') + '" data-qb="of-target" data-id="' + val + '" aria-pressed="' + (sh.target === val) + '">' + text + '</button>';
    };
    var head = '<div class="qb-seg" role="group" aria-label="What the offer applies to">' + seg('category', 'Category') + seg('product', 'Product') + seg('variant', 'Variant') + '</div>' +
      '<small class="qb-err" data-ferr="otarget"></small><div data-ff="otarget"></div>';
    if (sh.target === 'category') {
      return head + '<small class="qb-help">Products added to a chosen category later are covered too.</small>' +
        '<div class="qb-ofcats">' + S.categories.map(function (c) {
          return '<label class="qb-check"><input type="checkbox" data-qbi="of-cat" data-id="' + esc(c.id) + '"' + (sh.categoryIds.indexOf(c.id) > -1 ? ' checked' : '') + ' />' + esc(c.name) + '</label>';
        }).join('') + '</div>';
    }
    return head + '<input class="input qb-in" id="qbOFind" type="search" autocomplete="off" value="' + esc(sh.q) + '" data-qbi="of-find" aria-label="Search products" placeholder="' +
      (sh.target === 'product' ? 'Search a product, SKU or shelf' : 'Search a product that has variants') + '" />' +
      '<div class="qb-hits" id="qbOHits">' + offerHitsHTML() + '</div>' +
      '<div id="qbOChosen">' + offerChosenHTML() + '</div>';
  }
  function offerHitsHTML() {
    var sh = S.sheet;
    if (sh.target === 'variant' && sh.variantProduct) {
      var p = productById(sh.variantProduct);
      return '<div class="qb-picked"><span class="grow"><b>' + esc(p.name) + '</b><span>Choose the variants</span></span>' +
        '<button type="button" class="qb-link" data-qb="of-var-back">Change</button></div>' +
        p.variants.map(function (v) {
          var on = sh.variants.some(function (x) { return x.productId === p.id && x.variantId === v.id; });
          return '<label class="qb-check"><input type="checkbox" data-qbi="of-var" data-id="' + esc(v.id) + '"' + (on ? ' checked' : '') + ' />' + esc(variantLabel(v)) + ' · ' + inr(v.pricePaise) + '</label>';
        }).join('');
    }
    if (sh.q.length < 1) return '';
    var list = activeProducts().filter(function (p) { return (sh.target !== 'variant' || hasVariants(p)) && matches(p, sh.q); }).slice(0, 8);
    if (!list.length) return '<p class="qb-sub">No product matches “' + esc(sh.q) + '”.</p>';
    return list.map(function (p) {
      var on = sh.target === 'product' && sh.productIds.indexOf(p.id) > -1;
      return '<button type="button" class="qb-hit' + (on ? ' is-on' : '') + '" data-qb="' + (sh.target === 'product' ? 'of-prod' : 'of-var-prod') + '" data-id="' + esc(p.id) + '" aria-pressed="' + on + '">' +
        thumbHTML(p, 'qb-thumb--xs') + '<span class="grow"><b>' + esc(p.name) + '</b><span>' + esc(catName(p.categoryId)) + (p.sku ? ' · ' + esc(p.sku) : '') + ' · ' + inr(p.pricePaise) + '</span></span></button>';
    }).join('');
  }
  function offerChosenHTML() {
    var sh = S.sheet;
    var rows = sh.target === 'product'
      ? sh.productIds.map(function (id) { var p = productById(id); return { key: id, text: p ? p.name : 'A removed product' }; })
      : sh.variants.map(function (v) {
        var p = productById(v.productId);
        var x = p && variantOf(p, v.variantId);
        return { key: v.productId + '|' + v.variantId, text: (p ? p.name : 'A removed product') + (x ? ' (' + variantLabel(x) + ')' : '') };
      });
    if (!rows.length) return '';
    return '<span class="qb-lab">Chosen <em>(' + rows.length + ')</em></span><div class="qb-ofchosen">' + rows.map(function (r) {
      return '<span class="qb-chip">' + esc(r.text) + '<button type="button" data-qb="of-drop" data-id="' + esc(r.key) + '" aria-label="Remove ' + esc(r.text) + '">' + icon('close') + '</button></span>';
    }).join('') + '</div>';
  }

  function submitOffer() {
    var sh = S.sheet;
    if (!sh || sh.type !== 'offer' || sh.busy) return;
    var val = function (id) { var n = el(id); return n ? n.value.trim() : ''; };
    var name = val('qbOName').replace(/\s+/g, ' ');
    var pct = sh.kind === 'percent';
    var valueText = val('qbOValueIn');
    var percentBp = pct ? M.parsePercent(valueText) : null;
    var amountPaise = pct ? null : M.parseRupees(valueText);
    var maxText = pct ? val('qbOMax') : '';
    var maxPaise = maxText ? M.parseRupees(maxText) : null;
    var minBillText = val('qbOMinB');
    var minBillPaise = minBillText ? M.parseRupees(minBillText) : 0;
    var minQtyText = val('qbOMinQ') || '1';
    var prioText = val('qbOPrio') || '100';
    var targetEmpty = sh.target === 'category' ? !sh.categoryIds.length : sh.target === 'product' ? !sh.productIds.length : !sh.variants.length;
    var startD = val('qbOStartD'), startT = val('qbOStartT'), endD = val('qbOEndD'), endT = val('qbOEndT');

    var bad = [];
    var check = function (key, id, msg) { formError(key, msg); if (msg) bad.push(id); };
    check('oname', 'qbOName', name ? '' : 'Give the offer a name');
    check('ovalue', 'qbOValueIn', pct
      ? (percentBp && percentBp <= 10000 ? '' : 'Enter a percentage above 0, up to 100')
      : (amountPaise > 0 ? '' : 'Enter an amount, e.g. 50'));
    if (pct) check('omax', 'qbOMax', maxText && !(maxPaise > 0) ? 'Enter an amount, or leave it empty' : '');
    check('ostartt', 'qbOStartT', startT && !startD ? 'Choose a start date too' : '');
    check('oendt', 'qbOEndT', endT && !endD ? 'Choose an end date too' : '');
    check('ominq', 'qbOMinQ', /^\d{1,4}$/.test(minQtyText) && Number(minQtyText) >= 1 ? '' : 'Enter a whole number, 1 or more');
    check('ominb', 'qbOMinB', minBillPaise == null ? 'Enter an amount, or leave it empty' : '');
    check('oprio', 'qbOPrio', /^\d{1,3}$/.test(prioText) && Number(prioText) >= 1 ? '' : 'Enter a number from 1 to 999');
    var targetErr = document.querySelector('[data-ferr="otarget"]');
    if (targetErr) targetErr.textContent = targetEmpty ? 'Choose what this offer applies to' : '';
    if (targetEmpty) bad.push('qbOTarget');
    if (bad.length) { var f = el(bad[0]); if (f) { f.scrollIntoView({ block: 'center' }); if (f.focus) f.focus(); } return; }

    var body = {
      action: sh.mode === 'edit' ? 'update' : 'create', offerId: sh.id, name: name, description: val('qbODesc'),
      kind: sh.kind, percentBp: percentBp, amountPaise: amountPaise, fixedMode: sh.fixedMode, maxPaise: maxPaise,
      target: sh.target, categoryIds: sh.categoryIds, productIds: sh.productIds, variants: sh.variants,
      startDate: startD, startTime: startT, endDate: endD, endTime: endT,
      minQty: Number(minQtyText), minBillPaise: minBillPaise, priority: Number(prioText),
      stackable: !!(el('qbOStack') && el('qbOStack').checked), autoApply: !!(el('qbOAuto') && el('qbOAuto').checked),
      status: el('qbOPaused') && el('qbOPaused').checked ? 'paused' : 'active'
    };
    sh.busy = true;
    var go2 = el('qbOGo'); if (go2) go2.disabled = true;
    API.offer(body).then(function (r) {
      sh.busy = false;
      upsertOffer(r.offer);
      closeSheet();
      toast(sh.mode === 'edit' ? 'Offer saved' : 'Offer “' + r.offer.name + '” created', 'checkCircle');
      paintOffers();
      offersMoved();
    }, function (e) {
      sh.busy = false;
      if (go2) go2.disabled = false;
      var box = el('qbOFail');
      if (box) { box.hidden = false; box.innerHTML = icon('alert') + '<span>' + esc(say(e)) + '</span>'; box.scrollIntoView({ block: 'center' }); }
    });
  }

  function openOfferView(id) {
    var o = offerById(id);
    if (!o) return;
    var row = function (k, v) { return v ? '<div class="qb-trow"><span>' + k + '</span><span>' + esc(v) + '</span></div>' : ''; };
    var covered = offerProducts(o);
    S.sheet = { type: 'offerview' };
    openSheet('offerview',
      '<div class="sheet__grab"></div><div class="sheet__head"><div class="grow"><h3 class="t-h3">' + esc(o.name) + '</h3></div>' + offerPill(o) +
      '<button class="iconbtn" data-qb="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<div class="sheet__body qb-form"><div class="qb-rows">' +
      row('Description', o.description) + row('Discount', OF.valueText(o, inr)) +
      row('Applies to', LEVEL_NAMES[o.target] + ': ' + appliesToText(o)) + row('Validity', validityText(o)) +
      row('Minimum quantity', o.minQty > 1 ? String(o.minQty) : '') + row('Minimum bill value', o.minBillPaise ? inr(o.minBillPaise) : '') +
      row('Priority', String(o.priority)) + row('Combines with others', o.stackable ? 'Yes' : 'No') +
      row('Auto Apply', o.autoApply ? 'On' : 'Off') + row('Created', when(o.createdAt)) + row('Last changed', when(o.updatedAt)) + '</div>' +
      '<span class="qb-lab">Products covered <em>(' + covered.length + ')</em></span>' +
      (covered.length ? '<ul class="qb-review__items">' + covered.slice(0, 30).map(function (p) {
        var off = OF.amountOn(o, p.pricePaise, 1);
        return '<li><div class="grow"><b>' + esc(p.name) + '</b><span>' + esc(catName(p.categoryId)) + '</span></div><b>' + inr(p.pricePaise) +
          (off ? ' → ' + inr(p.pricePaise - off) : '') + '</b></li>';
      }).join('') + '</ul>' : '<p class="qb-sub">No active product is covered right now.</p>') +
      '</div><div class="sheet__foot"><button class="btn btn--ghost qb-danger" data-qb="of-remove" data-id="' + esc(o.id) + '">Remove</button>' +
      '<button class="btn btn--outline grow" data-qb="of-edit" data-id="' + esc(o.id) + '">' + icon('edit') + 'Edit Offer</button></div>',
      o.name);
  }
  function removeOffer(id) {
    var o = offerById(id);
    if (!o || !global.confirm('Remove “' + o.name + '” from your offers? It stops applying to new bills. Saved bills keep their discount.')) return;
    API.offer({ action: 'remove', offerId: id }).then(function () {
      S.offers = S.offers.filter(function (x) { return x.id !== id; });
      closeSheet();
      toast('Offer removed', 'checkCircle');
      paintOffers();
      offersMoved();
    }, function (e) { toast(say(e), 'alert'); });
  }

  function openOfferSettings() {
    var s = S.offerSettings;
    S.sheet = { type: 'offerset', busy: false };
    openSheet('offerset',
      '<div class="sheet__grab"></div><div class="sheet__head"><h3 class="t-h3 grow">Offer settings</h3>' +
      '<button class="iconbtn" data-qb="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<form class="sheet__body qb-form" data-qbf="offer-settings" novalidate>' +
      '<label class="qb-check"><input type="checkbox" id="qbSDefault"' + (s.autoApplyDefault !== false ? ' checked' : '') + ' />New offers start with Auto Apply on</label>' +
      '<small class="qb-help">Offers already saved keep their own setting.</small>' +
      '<label class="qb-check"><input type="checkbox" id="qbSBill"' + (s.billAutoApply !== false ? ' checked' : '') + ' />New bills start with Auto Apply on</label>' +
      '<small class="qb-help">Switching it on one bill changes that bill only.</small>' +
      '<label class="qb-check"><input type="checkbox" id="qbSStack"' + (s.stacking ? ' checked' : '') + ' />Allow offers to combine on one item</label>' +
      '<small class="qb-help">Off: an item gets one offer. On: offers marked to combine are taken one after another.</small>' +
      '<div class="qb-ff"><label class="qb-lab" for="qbSOrder">When several offers fit one item</label>' +
      '<select class="input qb-in" id="qbSOrder"><option value="specific"' + (s.order !== 'priority' ? ' selected' : '') + '>Most specific wins: variant, product, category</option>' +
      '<option value="priority"' + (s.order === 'priority' ? ' selected' : '') + '>Lowest priority number wins</option></select></div>' +
      '<small class="qb-err" id="qbSErr"></small><button type="submit" hidden></button></form>' +
      '<div class="sheet__foot"><button class="btn btn--ghost" data-qb="close-sheet">Cancel</button>' +
      '<button class="btn qb-btn grow" id="qbSGo" data-qb="of-settings-go">' + icon('check') + 'Save settings</button></div>', 'Offer settings');
  }
  function submitOfferSettings() {
    var sh = S.sheet;
    if (!sh || sh.type !== 'offerset' || sh.busy) return;
    var on = function (id) { return !!(el(id) && el(id).checked); };
    sh.busy = true;
    var go2 = el('qbSGo'); if (go2) go2.disabled = true;
    API.offer({
      action: 'settings', autoApplyDefault: on('qbSDefault'), billAutoApply: on('qbSBill'),
      stacking: on('qbSStack'), order: (el('qbSOrder') || {}).value
    }).then(function (r) {
      sh.busy = false;
      S.offerSettings = r.offerSettings;
      closeSheet();
      toast('Offer settings saved', 'checkCircle');
      offersMoved();
    }, function (e) {
      sh.busy = false;
      if (go2) go2.disabled = false;
      var er = el('qbSErr'); if (er) er.textContent = say(e);
    });
  }

  /* --------------------------------------------------- offers on a cart line */
  function lineOfferHTML(l, r) {
    if (!r || !r.options.length) return '';
    var key = esc(l.key);
    var btn = function (act, text, cls) { return '<button type="button" class="qb-link' + (cls || '') + '" data-qb="' + act + '" data-id="' + key + '">' + text + '</button>'; };
    var usable = r.options.filter(function (o) { return o.state !== 'blocked'; });
    if (l.offerPick === 'none') {
      return '<span class="qb-lineoffer qb-lineoffer--idle">Offer cancelled' + (usable.length ? btn('line-restore', 'Apply Offer Again') : '') + '</span>';
    }
    if (!r.applied.length) {
      return '<span class="qb-lineoffer qb-lineoffer--idle">' + (usable.length ? usable.length + (usable.length === 1 ? ' offer available' : ' offers available') : 'Offer not applied') +
        btn('line-offers', usable.length ? 'Apply Offer' : 'Why no offer?') + '</span>';
    }
    var each = Math.round(r.offerPaise / l.qty);
    return '<span class="qb-lineoffer">' + r.applied.map(function (a) { return '<b>' + icon('tag') + esc(a.name) + '</b>'; }).join('') +
      '<em>' + inr(each) + ' off' + (l.qty > 1 ? ' each' : '') + '</em>' +
      btn('line-cancel', 'Cancel Offer', ' qb-danger') +
      (r.options.length > 1 ? btn('line-offers', 'Offers') : '') +
      (S.priceEdit[l.key] ? '' : btn('line-price-edit', 'Edit price')) + '</span>';
  }
  function openLineOffers(key) {
    var l = lineByKey(key);
    if (!l) return;
    S.sheet = { type: 'lineoffers', key: key };
    openSheet('lineoffers', lineOffersHTML(l), 'Offers for this item');
  }
  function lineOffersHTML(l) {
    var d = draft();
    var r = d.offers.lines[S.cart.lines.indexOf(l)];
    return '<div class="sheet__grab"></div><div class="sheet__head"><div class="grow"><h3 class="t-h3">Offers</h3><span class="qb-sub">' + esc(l.name) + (l.variantLabel ? ' · ' + esc(l.variantLabel) : '') + '</span></div>' +
      '<button class="iconbtn" data-qb="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<div class="sheet__body qb-form"><div class="qb-hits">' + r.options.map(function (o) {
        var line = o.state === 'applied' ? 'Applied on this item'
          : o.why === 'lost' ? 'Not applied: “' + o.beatenBy + '” has higher priority'
          : (WHY_NOT[o.why] || 'Available');
        return '<div class="qb-hit' + (o.state === 'applied' ? ' is-on' : '') + '"><span class="grow"><b>' + esc(o.name) + '</b><span>' + LEVEL_NAMES[o.level] + ' offer · ' + esc(line) + '</span></span>' +
          (o.discountPaise ? '<b class="qb-hit__n">−' + inr(o.discountPaise) + '</b>' : '') +
          (o.state === 'available' ? '<button type="button" class="btn btn--outline btn--sm" data-qb="line-pick" data-id="' + esc(o.id) + '">Apply</button>' : '') +
          (o.state === 'applied' ? '<button type="button" class="btn btn--ghost btn--sm" data-qb="line-pick" data-id="none">Remove</button>' : '') + '</div>';
      }).join('') + '</div>' +
      (l.offerPick ? '<button type="button" class="qb-link" data-qb="line-pick" data-id="">Go back to the automatic choice</button>' : '') +
      '</div>';
  }

  /* ============================================================ CATEGORIES */
  function renderCategories(page) {
    var counts = {}, unlinked = {};
    S.products.forEach(function (p) {
      counts[p.categoryId] = (counts[p.categoryId] || 0) + 1;
      if (needsLinks(p)) unlinked[p.categoryId] = (unlinked[p.categoryId] || 0) + 1;
    });
    var have = {};
    S.categories.forEach(function (c) { have[c.name.toLowerCase()] = 1; });
    var missing = (S.suggested || []).filter(function (n) { return !have[n.toLowerCase()]; });
    var rows = S.categories.map(function (c, i) {
      var n = counts[c.id] || 0;
      var part = c.compat && c.compat.partCategory && SM.db && SM.db.categoryById[c.compat.partCategory];
      var bits = [n + (n === 1 ? ' product' : ' products')];
      if (compatOn(c)) bits.push('Compatibility: ' + (part ? part.name : 'on'));
      if (c.deviceKind) bits.push({ phone: 'Mobile list', tablet: 'Tablet list', watch: 'Watch list' }[c.deviceKind]);
      return '<div class="qb-crow' + (c.status === 'inactive' ? ' is-off' : '') + '" data-id="' + esc(c.id) + '">' +
        '<div class="qb-crow__ord">' +
        '<button data-qb="cat-up" data-id="' + esc(c.id) + '" aria-label="Move ' + esc(c.name) + ' up"' + (i === 0 ? ' disabled' : '') + '>' + icon('chevronUp') + '</button>' +
        '<button data-qb="cat-down" data-id="' + esc(c.id) + '" aria-label="Move ' + esc(c.name) + ' down"' + (i === S.categories.length - 1 ? ' disabled' : '') + '>' + icon('chevronDown') + '</button></div>' +
        '<div class="qb-crow__main"><b>' + esc(c.name) + (c.status === 'inactive' ? ' <em class="qb-offtag">Inactive</em>' : '') + '</b>' +
        (c.description ? '<span class="qb-crow__d">' + esc(c.description) + '</span>' : '') +
        '<span>' + esc(bits.join(' · ')) + '</span>' +
        (unlinked[c.id] ? '<button class="qb-link" data-qb="cat-links" data-id="' + esc(c.id) + '">' + unlinked[c.id] + (unlinked[c.id] === 1 ? ' product needs' : ' products need') + ' groups</button>' : '') +
        '</div>' +
        '<div class="qb-crow__acts">' +
        '<button class="btn btn--ghost btn--sm" data-qb="cat-view" data-id="' + esc(c.id) + '" aria-label="View products in ' + esc(c.name) + '">' + icon('box') + '<span>View products</span></button>' +
        '<button class="btn btn--ghost btn--sm" data-qb="cat-edit" data-id="' + esc(c.id) + '" aria-label="Edit ' + esc(c.name) + '">' + icon('edit') + '<span>Edit</span></button>' +
        '<button class="btn btn--ghost btn--sm qb-danger" data-qb="cat-delete" data-id="' + esc(c.id) + '" aria-label="Delete ' + esc(c.name) + '">' + icon('trash') + '<span>Delete</span></button></div>' +
        '</div>';
    }).join('');
    page.innerHTML = frame('categories',
      '<div class="qb-list shell">' +
      '<form class="qb-newcat" data-qbf="cat-new"><input class="input qb-in" id="qbNewCat" maxlength="40" autocomplete="off" placeholder="New category name" aria-label="New category name" />' +
      '<button class="btn qb-btn" type="submit">' + icon('plus') + 'Add category</button></form>' +
      (missing.length
        ? '<div class="qb-suggest"><div class="qb-suggest__head"><span class="t-lab">Suggested</span>' +
          '<button class="qb-link" data-qb="cat-suggest-all">Add all ' + missing.length + '</button></div>' +
          '<div class="qb-chips qb-chips--wrap">' + missing.map(function (n) {
            return '<button class="qb-chip qb-chip--add" data-qb="cat-suggest" data-id="' + esc(n) + '">' + icon('plus') + esc(n) + '</button>';
          }).join('') + '</div></div>'
        : '') +
      (S.categories.length
        ? '<div class="qb-cats">' + rows + '</div>'
        : C.state({ icon: 'layers', title: 'No categories yet', text: 'Add your own, or start with the suggested ones above.' })) +
      '</div>');
  }

  /* ============================================================= CUSTOMERS */
  var CUST_FILTERS = [['all', 'All'], ['new', 'New'], ['repeat', 'Repeat'], ['recent', 'Recent'], ['top', 'Highest spending'], ['outstanding', 'Outstanding']];

  function dateOnly(ms) {
    return ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—';
  }

  function renderCustomers(page) {
    var cu = S.customers;
    page.innerHTML = frame('customers',
      '<div class="qb-list shell">' +
      '<div class="qb-list__head"><label class="qb-search">' + icon('search') +
      '<input id="qbCustQ" type="search" autocomplete="off" placeholder="Search name or mobile" value="' + esc(cu.q) + '" data-qbi="cust-q" aria-label="Search customers" /></label>' +
      '<button class="btn qb-btn" data-qb="cust-new">' + icon('plus') + 'New customer</button></div>' +
      (cu.range ? '<div class="qb-compatbar"><span class="qb-compatbar__l">Showing</span><b>' + esc(cu.range) + '</b>' +
        '<button class="qb-link" data-qb="cust-filter" data-id="all">' + icon('close') + 'All customers</button></div>' : '') +
      '<div class="qb-chips" role="group" aria-label="Filter customers">' + CUST_FILTERS.map(function (f) {
        var on = cu.filter === f[0] && !cu.q;
        return '<button class="qb-chip' + (on ? ' is-on' : '') + '" data-qb="cust-filter" data-id="' + f[0] + '" aria-pressed="' + on + '">' + f[1] +
          (f[0] === 'all' ? '<em>' + S.customerCount + '</em>' : '') + '</button>';
      }).join('') + '</div>' +
      '<div id="qbCustList">' + customerListHTML() + '</div></div>');
    if (!cu.loaded && !cu.loading) loadCustomers(true);
  }

  function loadCustomers(fresh) {
    var cu = S.customers;
    var ticket = ++cu.ticket;
    var uid = S.uid;
    cu.loading = true;
    if (fresh) { cu.items = []; cu.cursor = null; }
    paint('qbCustList', customerListHTML());
    API.customers({ q: cu.q, filter: cu.q ? null : cu.filter, since: cu.since || null, cursor: fresh ? null : cu.cursor }).then(function (r) {
      if (ticket !== cu.ticket || S.uid !== uid) return;
      cu.items = fresh ? r.customers : cu.items.concat(r.customers);
      cu.cursor = r.nextCursor;
      cu.loaded = true;
      cu.error = null;
    }, function (err) {
      if (ticket !== cu.ticket || S.uid !== uid) return;
      cu.error = err;
    }).then(function () {
      if (ticket !== cu.ticket) return;
      cu.loading = false;
      paint('qbCustList', customerListHTML());
    });
  }

  function customerListHTML() {
    var cu = S.customers;
    if (cu.error && !cu.items.length) {
      return C.state({ icon: 'alert', title: 'Could not load customers', text: say(cu.error),
        action: '<button class="btn btn--outline btn--sm" data-qb="cust-retry">' + icon('refresh') + 'Try again</button>' });
    }
    if (!cu.items.length) {
      if (cu.loading) return C.skelRows(5);
      return C.state({ icon: 'user', title: cu.q ? 'No customers match “' + cu.q + '”' : cu.filter !== 'all' ? 'No customers here yet' : 'No customers yet',
        text: cu.q ? 'Search by the start of a name, or by mobile number.' : 'Add a mobile number to a bill and the customer is saved here.',
        action: cu.q || cu.filter !== 'all' ? '' : '<button class="btn qb-btn btn--sm" data-qb="cust-new">' + icon('plus') + 'New customer</button>' });
    }
    var stat = function (label, value, cls) {
      return '<span class="qb-curow__s"><em>' + label + '</em><b' + (cls ? ' class="' + cls + '"' : '') + '>' + value + '</b></span>';
    };
    return '<div class="qb-bills">' + cu.items.map(function (x) {
      return '<a class="qb-curow" href="/billing/customers/' + encodeURIComponent(x.id) + '">' +
        '<span class="qb-brow__who"><b>' + esc(x.name || x.mobile) + '</b><span>' + esc(x.mobile || 'No mobile') + '</span></span>' +
        '<span class="qb-curow__stats">' + stat('Total', inr(x.totalPaise)) + stat('Bills', x.billCount) + stat('Average', inr(x.averageBillPaise)) +
        stat('Last purchase', esc(dateOnly(x.lastBillAt))) + stat('Outstanding', inr(x.outstandingPaise), x.outstandingPaise ? 'qb-due' : '') + '</span></a>';
    }).join('') + '</div>' +
      (cu.cursor ? '<div class="qb-more"><button class="btn btn--outline btn--sm" data-qb="cust-more"' + (cu.loading ? ' disabled' : '') + '>' + (cu.loading ? 'Loading…' : 'Load more') + '</button></div>' : '');
  }

  function loadCustomer(id) {
    var uid = S.uid;
    return API.customer(id).then(function (r) {
      if (S.uid !== uid) return;
      S.customerCache[id] = r;
      if (onBilling() && viewName() === 'customer' && params[1] === id) rerender();
    }, function (err) {
      if (S.uid !== uid || !onBilling() || viewName() !== 'customer' || params[1] !== id) return;
      ctx.page().innerHTML = frame('customer', '<div class="shell">' + C.state({ icon: 'alert', title: 'Could not open this customer', text: say(err),
        action: '<a class="btn btn--outline btn--sm" href="/billing/customers">Back to customers</a>' }) + '</div>');
    });
  }

  function renderCustomer(page, id) {
    var data = S.customerCache[id];
    if (!data) {
      page.innerHTML = frame('customer', '<div class="shell qb-billview">' + C.skelRows(4) + '</div>');
      loadCustomer(id);
      return;
    }
    var c = data.customer, ins = data.insights;
    var tile = function (label, value, cls) {
      return '<div class="qb-kpi"><span class="qb-kpi__l">' + label + '</span><b' + (cls ? ' class="' + cls + '"' : '') + '>' + value + '</b></div>';
    };
    var info = function (label, value) {
      return value ? '<div class="qb-trow"><span>' + label + '</span><span>' + esc(value) + '</span></div>' : '';
    };
    page.innerHTML = frame('customer',
      '<div class="shell qb-billview">' +
      '<div class="qb-billview__bar"><a class="btn btn--ghost btn--sm" href="/billing/customers">' + icon('chevronLeft') + 'Customers</a>' +
      '<div class="qb-billview__no grow"><h2 class="qb-cname">' + esc(c.name || c.mobile) + '</h2>' +
      (ins.firstTime ? '<span class="pill">First-time</span>' : '<span class="pill pill--ok">Repeat</span>') +
      (c.status === 'inactive' ? '<span class="pill">Inactive</span>' : '') + '</div>' +
      '<button class="btn btn--outline btn--sm" data-qb="cust-edit" data-id="' + esc(c.id) + '">' + icon('edit') + 'Edit</button></div>' +
      '<div class="qb-kpis">' + tile('Total purchases', inr(c.totalPaise)) + tile('Bills', c.billCount) + tile('Days purchased', ins.visits) +
      tile('Average bill', inr(c.averageBillPaise)) + tile('Paid', inr(c.paidPaise)) + tile('Outstanding', inr(c.outstandingPaise), c.outstandingPaise ? 'qb-due' : '') + '</div>' +
      '<div class="qb-billview__grid"><div class="qb-billview__side">' +
      '<div class="qb-card2"><div class="qb-sec"><span class="qb-lab">Purchase history</span>' +
      '<span class="qb-range"><label>From <input class="input qb-in" type="date" id="qbHistFrom" data-qbi="hist-range" /></label>' +
      '<label>To <input class="input qb-in" type="date" id="qbHistTo" data-qbi="hist-range" /></label></span></div>' +
      '<div id="qbCustHist">' + historyHTML(data.bills, '', '') + '</div></div>' +
      '</div><div class="qb-billview__side">' +
      '<div class="qb-card2"><span class="qb-lab">Details</span><div class="qb-rows">' +
      info('Mobile', c.mobile) + info('WhatsApp', c.whatsapp) + info('Address', c.address) + info('GSTIN', c.gstin) + info('Notes', c.notes) +
      info('Customer since', dateOnly(c.createdAt)) + info('First purchase', dateOnly(c.firstBillAt)) + info('Last purchase', dateOnly(c.lastBillAt)) + '</div></div>' +
      (ins.topProducts.length ? '<div class="qb-card2"><span class="qb-lab">Most purchased</span><div class="qb-rows">' + ins.topProducts.map(function (p) {
        return '<div class="qb-trow"><span>' + esc(p.name) + '</span><b>× ' + p.qty + '</b></div>';
      }).join('') + '</div></div>' : '') +
      '<div class="qb-card2"><span class="qb-lab">Payment history</span>' + (data.payments.length
        ? '<ul class="qb-hist">' + data.payments.map(function (p) {
          return '<li><a class="qb-link" href="/billing/bills/' + encodeURIComponent(p.billId) + '">' + esc(p.number) + '</a> ' + inr(p.receivedPaise) + ' received<span>' + esc(when(p.at)) + '</span></li>';
        }).join('') + '</ul>'
        : '<p class="qb-sub">Payments recorded after a bill was saved appear here.</p>') + '</div>' +
      '</div></div></div>');
  }

  function historyHTML(bills, from, to) {
    var list = bills.filter(function (b) { return (!from || b.day >= from) && (!to || b.day <= to); });
    if (!list.length) return '<p class="qb-sub">' + (bills.length ? 'No bills in these dates.' : 'No bills yet.') + '</p>';
    var cell = function (label, value, cls) {
      return '<span class="qb-curow__s"><em>' + label + '</em><b' + (cls ? ' class="' + cls + '"' : '') + '>' + value + '</b></span>';
    };
    return '<div class="qb-hrows">' + list.map(function (b) {
      var live = b.status !== 'void';
      return '<a class="qb-hrow' + (live ? '' : ' is-void') + '" href="/billing/bills/' + encodeURIComponent(b.id) + '">' +
        '<span class="qb-hrow__top"><span class="qb-brow__no">' + esc(b.number) + '</span><span class="qb-sub">' + esc(dateOnly(b.createdAt)) + '</span>' +
        statusPill(live ? b.paymentStatus : 'void') + '</span>' +
        '<span class="qb-hrow__items">' + b.items.map(function (it) {
          return esc(it.name) + (it.variantLabel ? ' (' + esc(it.variantLabel) + ')' : '') + ' × ' + it.qty +
            (it.selectedModelName ? ' <em>for ' + esc(it.selectedModelName) + '</em>' : '');
        }).join(', ') + '</span>' +
        '<span class="qb-curow__stats">' + cell('Qty', b.itemCount) + cell('Amount', inr(b.totalPaise)) + cell('Discount', inr(b.discountPaise)) +
        cell('Paid', inr(b.receivedPaise)) + cell('Outstanding', inr(b.balancePaise), b.balancePaise ? 'qb-due' : '') + '</span></a>';
    }).join('') + '</div>';
  }

  /* -------------------------------------------------------- customer sheet */
  function openCustomerForm(id) {
    var c = id && S.customerCache[id] ? S.customerCache[id].customer : null;
    S.sheet = { type: 'customer', id: id || API.newId('c_'), mode: id ? 'edit' : 'create', busy: false };
    openSheet('customer',
      '<div class="sheet__grab"></div><div class="sheet__head"><h3 class="t-h3 grow">' + (id ? 'Edit customer' : 'New customer') + '</h3>' +
      '<button class="iconbtn" data-qb="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<form class="sheet__body qb-form" data-qbf="customer" novalidate>' +
      fieldHTML('qbUName', 'uname', 'Name', true, '<input class="input qb-in" id="qbUName" maxlength="60" autocomplete="off" value="' + esc(c ? c.name : '') + '" />') +
      '<div class="qb-form__row">' +
      fieldHTML('qbUMobile', 'umobile', 'Mobile', false, '<input class="input qb-in" id="qbUMobile" type="tel" inputmode="tel" autocomplete="off" value="' + esc(c ? c.mobile : '') + '" />') +
      fieldHTML('qbUWhats', 'uwhats', 'WhatsApp', false, '<input class="input qb-in" id="qbUWhats" type="tel" inputmode="tel" autocomplete="off" placeholder="Optional" value="' + esc(c ? c.whatsapp : '') + '" />') +
      '</div>' +
      fieldHTML('qbUAddr', 'uaddr', 'Address', false, '<input class="input qb-in" id="qbUAddr" maxlength="200" autocomplete="off" placeholder="Optional" value="' + esc(c ? c.address : '') + '" />') +
      fieldHTML('qbUGst', 'ugst', 'GSTIN', false, '<input class="input qb-in" id="qbUGst" maxlength="15" autocomplete="off" placeholder="Optional" value="' + esc(c ? c.gstin : '') + '" />') +
      fieldHTML('qbUNotes', 'unotes', 'Notes', false, '<textarea class="input qb-in qb-notes" id="qbUNotes" rows="2" maxlength="300" placeholder="Optional">' + esc(c ? c.notes : '') + '</textarea>') +
      (id ? fieldHTML('qbUStatus', 'ustatus', 'Status', false, '<select class="input qb-in" id="qbUStatus"><option value="active">Active</option><option value="inactive"' + (c && c.status === 'inactive' ? ' selected' : '') + '>Inactive</option></select>') : '') +
      '<small class="qb-err" id="qbUErr"></small><button type="submit" hidden></button></form>' +
      '<div class="sheet__foot"><button class="btn btn--ghost" data-qb="close-sheet">Cancel</button>' +
      '<button class="btn qb-btn grow" data-qb="cust-go" id="qbUGo">' + icon('check') + 'Save customer</button></div>',
      id ? 'Edit customer' : 'New customer');
  }
  function submitCustomer() {
    var sh = S.sheet;
    if (!sh || sh.type !== 'customer' || sh.busy) return;
    var val = function (id) { var n = el(id); return n ? n.value.trim() : ''; };
    var name = val('qbUName');
    formError('uname', name ? '' : 'Enter the customer’s name');
    if (!name) return;
    var body = {
      action: sh.mode === 'edit' ? 'update' : 'create', customerId: sh.id, name: name,
      mobile: val('qbUMobile'), whatsapp: val('qbUWhats'), address: val('qbUAddr'), gstin: val('qbUGst'), notes: val('qbUNotes')
    };
    if (sh.mode === 'edit') body.status = val('qbUStatus');
    sh.busy = true;
    var go2 = el('qbUGo'); if (go2) go2.disabled = true;
    API.customerSave(body).then(function (r) {
      sh.busy = false;
      delete S.customerCache[r.customer.id];
      S.customers.loaded = false;
      if (sh.mode !== 'edit') S.customerCount++;
      closeSheet();
      toast('Customer saved', 'checkCircle');
      if (viewName() === 'customers' || viewName() === 'customer') rerender();
    }, function (e) {
      sh.busy = false;
      if (go2) go2.disabled = false;
      var er = el('qbUErr'); if (er) er.textContent = say(e);
    });
  }

  /* ============================================================== OVERVIEW

     Every figure comes from the server's day documents, so this screen never
     reads a bill and a year of trading costs the same as a week to open. */
  var PRESETS = [['today', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['month', 'This month'], ['prev', 'Previous month'], ['custom', 'Custom']];
  var IST_MS = 5.5 * 3600 * 1000;

  function istDay() { return new Date(Date.now() + IST_MS).toISOString().slice(0, 10); }
  function dayShift(key, n) {
    var d = new Date(key + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function dayStart(key) { return Date.parse(key + 'T00:00:00+05:30'); }
  function dayName(key) {
    return new Date(key + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  function rangeName(from, to) { return from === to ? dayName(from) : dayName(from) + ' – ' + dayName(to); }
  function presetRange(o) {
    var t = istDay();
    switch (o.preset) {
      case 'today': return { from: t, to: t };
      case '7': return { from: dayShift(t, -6), to: t };
      case '30': return { from: dayShift(t, -29), to: t };
      case 'month': return { from: t.slice(0, 8) + '01', to: t };
      case 'prev': {
        var end = dayShift(t.slice(0, 8) + '01', -1);
        return { from: end.slice(0, 8) + '01', to: end };
      }
    }
    return o.from && o.to ? { from: o.from, to: o.to } : null;
  }

  function renderOverview(page) {
    var o = S.overview;
    page.innerHTML = frame('overview',
      '<div class="qb-over shell">' +
      '<div class="qb-chips" role="group" aria-label="Period">' + PRESETS.map(function (p) {
        var on = o.preset === p[0];
        return '<button class="qb-chip' + (on ? ' is-on' : '') + '" data-qb="over-preset" data-id="' + p[0] + '" aria-pressed="' + on + '">' + p[1] + '</button>';
      }).join('') + '</div>' +
      (o.preset === 'custom'
        ? '<div class="qb-range"><label>From <input class="input qb-in" type="date" id="qbOverFrom" max="' + istDay() + '" value="' + esc(o.from) + '" data-qbi="over-range" /></label>' +
          '<label>To <input class="input qb-in" type="date" id="qbOverTo" max="' + istDay() + '" value="' + esc(o.to) + '" data-qbi="over-range" /></label></div>'
        : '') +
      '<div id="qbOverBody">' + overviewBodyHTML() + '</div></div>');
    if (!o.data && !o.loading && !o.error) loadOverview();
  }

  function loadOverview() {
    var o = S.overview;
    var r = presetRange(o);
    if (!r) { paint('qbOverBody', overviewBodyHTML()); return; }
    var ticket = ++o.ticket;
    var uid = S.uid;
    o.loading = true;
    o.error = null;
    paint('qbOverBody', overviewBodyHTML());
    API.overview({ from: r.from, to: r.to }).then(function (d) {
      if (ticket !== o.ticket || S.uid !== uid) return;
      o.data = d;
    }, function (err) {
      if (ticket !== o.ticket || S.uid !== uid) return;
      o.error = err;
    }).then(function () {
      if (ticket !== o.ticket) return;
      o.loading = false;
      paint('qbOverBody', overviewBodyHTML());
    });
  }

  function changeText(c, fmt) {
    if (c.pct == null) return c.cur ? 'New' : 'No change';
    var sign = c.delta > 0 ? '+' : c.delta < 0 ? '−' : '';
    return sign + fmt(Math.abs(c.delta)) + ' (' + sign + Math.abs(Math.round(c.pct * 100)) + '%)';
  }
  function count(n) { return String(n); }

  function overviewBodyHTML() {
    var o = S.overview;
    if (o.error) {
      return C.state({ icon: 'alert', title: 'Could not load the figures', text: say(o.error),
        action: '<button class="btn btn--outline btn--sm" data-qb="over-retry">' + icon('refresh') + 'Try again</button>' });
    }
    if (o.loading || !o.data) {
      return o.preset === 'custom' && !presetRange(o) ? '<p class="qb-sub">Choose both dates.</p>' : C.skelRows(6);
    }
    var d = o.data;
    var p = d.period, cm = d.customers;
    var tile = function (label, value, sub, drill, cls) {
      var inner = '<span class="qb-kpi__l">' + label + '</span><b' + (cls ? ' class="' + cls + '"' : '') + '>' + value + '</b>' + (sub ? '<span class="qb-kpi__s">' + sub + '</span>' : '');
      return drill
        ? '<button class="qb-kpi qb-kpi--go" data-qb="drill" data-id="' + drill + '">' + inner + '</button>'
        : '<div class="qb-kpi">' + inner + '</div>';
    };
    var prevName = rangeName(d.range.prevFrom, d.range.prevTo);
    var growth = d.compare.period.net;
    var money = function (label, value, cls) {
      return '<div class="qb-trow' + (cls || '') + '"><span>' + label + '</span><b>' + inr(value) + '</b></div>';
    };
    var empty = !S.billCount
      ? '<div class="qb-compatbar"><span>These figures fill in as bills are saved.</span><a class="qb-link" href="/billing">' + icon('plus') + 'New Bill</a></div>' : '';

    return empty +
      '<h2 class="qb-h">Sales</h2><div class="qb-kpis">' +
      tile('Today’s sales', inr(d.today.netPaise), d.today.bills + (d.today.bills === 1 ? ' bill' : ' bills'), 'bills-today') +
      tile('This month’s sales', inr(d.month.netPaise), d.month.bills + (d.month.bills === 1 ? ' bill' : ' bills'), 'bills-month') +
      tile('Today’s bills', d.today.bills, '', 'bills-today') +
      tile('Bills this month', d.month.bills, '', 'bills-month') +
      tile('Average bill value', inr(p.averageBillPaise), esc(rangeName(d.range.from, d.range.to))) +
      tile('Growth', growth.pct == null ? (growth.cur ? 'New' : '—') : (growth.delta < 0 ? '−' : '+') + Math.abs(Math.round(growth.pct * 100)) + '%', 'against ' + esc(prevName)) +
      tile('Amount collected', inr(p.collectedNetPaise), esc(rangeName(d.range.from, d.range.to))) +
      tile('Outstanding', inr(d.shop.outstandingPaise), 'all unpaid bills', 'cust-outstanding', d.shop.outstandingPaise ? 'qb-due' : '') +
      '</div>' +
      '<div class="qb-card2"><span class="qb-lab">Money in this period</span><div class="qb-rows qb-moneyrows">' +
      money('Gross sales', p.grossPaise) + money('Discounts', -p.discountPaise) + money('Tax', p.taxPaise) +
      money('Net sales', p.netPaise, ' qb-trow--net') +
      money('Voided bills', p.voidedPaise) + money('Collected', p.collectedPaise) + money('Refunds', p.refundedPaise) +
      money('Collected after refunds', p.collectedNetPaise, ' qb-trow--net') +
      money('Outstanding today', d.shop.outstandingPaise) + '</div>' +
      '<small class="qb-help">Net sales already leave out voided bills.</small></div>' +
      '<h2 class="qb-h">Customers</h2><div class="qb-kpis">' +
      tile('Total customers', d.shop.customerCount, '', 'cust-all') +
      tile('New today', cm.today.newCustomers, '', 'cust-new-today') +
      tile('New this month', cm.month.newCustomers, '', 'cust-new-month') +
      tile('Repeat customers', cm.period.repeat, 'in this period', 'cust-repeat') +
      tile('Average daily unique', String(Math.round(cm.period.avgDailyUnique * 100) / 100), 'customers a day') +
      tile('Average spend', inr(cm.period.avgSpendPaise), 'per customer') +
      tile('Returning rate', cm.period.returningRate == null ? '—' : Math.round(cm.period.returningRate * 100) + '%', cm.period.walkIns + (cm.period.walkIns === 1 ? ' walk-in bill' : ' walk-in bills') + ' not counted') +
      '</div>' +
      trendsHTML(d) +
      compareHTML(d) +
      productFiguresHTML(d);
  }

  /* --------------------------------------------------------------- trends */
  function mondayOf(key) {
    var wd = (new Date(key + 'T00:00:00Z').getUTCDay() + 6) % 7;
    return dayShift(key, -wd);
  }
  /** The daily series gathered into days, weeks or months. */
  function buckets(series, grain) {
    var out = [], at = {};
    series.forEach(function (d) {
      var key = grain === 'day' ? d.day : grain === 'week' ? mondayOf(d.day) : d.day.slice(0, 7);
      var b = at[key];
      if (!b) {
        var label = grain === 'month' ? new Date(key + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })
          : grain === 'week' ? 'Week of ' + dayName(key < d.day ? d.day : key) : dayName(key);
        b = at[key] = { label: label, netPaise: 0, bills: 0, collectedPaise: 0, newCustomers: 0, repeatCustomers: 0 };
        out.push(b);
      }
      b.netPaise += d.netPaise; b.bills += d.bills; b.collectedPaise += d.collectedPaise;
      b.newCustomers += d.newCustomers; b.repeatCustomers += d.repeatCustomers;
    });
    var running = 0;
    out.forEach(function (b) {
      b.averageBillPaise = b.bills ? Math.round(b.netPaise / b.bills) : 0;
      running += b.newCustomers;
      b.running = running;
    });
    return out;
  }

  function niceMax(n) {
    if (n <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log(n) / Math.LN10));
    var r = n / mag;
    return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * mag;
  }
  /**
   * One bar chart. One axis, thin marks with a rounded end, a tooltip on hover or
   * focus, a table for anyone who wants the numbers. `stack` draws two series on
   * one bar, with a legend.
   */
  function chartHTML(opts) {
    var rows = opts.rows;
    var series = opts.series;
    var top = niceMax(rows.reduce(function (m, r) {
      return Math.max(m, series.reduce(function (s, x) { return s + (r[x.key] || 0); }, 0));
    }, 0));
    var bars = rows.map(function (r) {
      var parts = series.map(function (x, i) {
        var v = r[x.key] || 0;
        return v ? '<span class="qb-bar__seg qb-bar__seg--' + (i + 1) + '" style="height:' + (v / top * 100) + '%"></span>' : '';
      }).join('');
      var tip = r.label + ': ' + series.map(function (x) { return (series.length > 1 ? x.name + ' ' : '') + opts.fmt(r[x.key] || 0); }).join(', ');
      return '<button class="qb-bar" type="button" aria-label="' + esc(tip) + '">' + parts + '</button>';
    }).join('');
    var head = series.map(function (x) { return '<th scope="col">' + esc(x.name) + '</th>'; }).join('');
    var body = rows.map(function (r) {
      return '<tr><th scope="row">' + esc(r.label) + '</th>' + series.map(function (x) { return '<td>' + esc(opts.fmt(r[x.key] || 0)) + '</td>'; }).join('') + '</tr>';
    }).join('');
    return '<figure class="qb-chart"><figcaption><b>' + esc(opts.title) + '</b><span>' + esc(opts.total) + '</span></figcaption>' +
      (series.length > 1 ? '<div class="qb-legend">' + series.map(function (x, i) {
        return '<span><i class="qb-key qb-key--' + (i + 1) + '"></i>' + esc(x.name) + '</span>';
      }).join('') + '</div>' : '') +
      '<div class="qb-plot"><div class="qb-tip" hidden></div>' +
      '<div class="qb-plot__axis" aria-hidden="true"><span>' + esc(opts.short(top)) + '</span><span>' + esc(opts.short(top / 2)) + '</span><span>0</span></div>' +
      '<div class="qb-plot__bars">' + bars + '</div></div>' +
      '<div class="qb-plot__x" aria-hidden="true"><span>' + esc(rows[0].label) + '</span><span>' + esc(rows.length > 1 ? rows[rows.length - 1].label : '') + '</span></div>' +
      '<details class="qb-tablev"><summary>View as table</summary><div class="qb-tablev__in"><table><thead><tr><th scope="col">' + esc(opts.grainName) + '</th>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div></details>' +
      '</figure>';
  }
  function shortMoney(paise) {
    var r = paise / 100;
    if (r >= 100000) return '₹' + (r / 100000).toFixed(r % 100000 ? 1 : 0) + 'L';
    if (r >= 1000) return '₹' + (r / 1000).toFixed(r % 1000 ? 1 : 0) + 'k';
    return '₹' + Math.round(r);
  }
  function trendsHTML(d) {
    var o = S.overview;
    var grains = [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']];
    var grain = o.trend === 'day' && d.series.length > 92 ? 'week' : o.trend;
    var rows = buckets(d.series, grain);
    var grainName = grain === 'day' ? 'Day' : grain === 'week' ? 'Week' : 'Month';
    var sum = function (k) { return rows.reduce(function (n, r) { return n + r[k]; }, 0); };
    var money = function (title, key, total, name) {
      return chartHTML({ title: title, rows: rows, series: [{ key: key, name: name }], fmt: inr, short: shortMoney, total: total, grainName: grainName });
    };
    var plain = function (title, series, total) {
      return chartHTML({ title: title, rows: rows, series: series, fmt: count, short: function (n) { return n % 1 ? '' : String(n); }, total: total, grainName: grainName });
    };
    return '<div class="qb-sec qb-sec--h"><h2 class="qb-h">Trends</h2><div class="qb-seg qb-seg--sm" role="group" aria-label="Group the charts by">' +
      grains.map(function (g) {
        return '<button class="' + (grain === g[0] ? 'is-on' : '') + '" data-qb="over-grain" data-id="' + g[0] + '" aria-pressed="' + (grain === g[0]) + '">' + g[1] + '</button>';
      }).join('') + '</div></div>' +
      '<div class="qb-charts">' +
      money('Sales', 'netPaise', inr(sum('netPaise')), 'Net sales') +
      plain('Bills', [{ key: 'bills', name: 'Bills' }], sum('bills') + ' bills') +
      money('Average bill value', 'averageBillPaise', inr(d.period.averageBillPaise), 'Average bill') +
      money('Payments collected', 'collectedPaise', inr(sum('collectedPaise')), 'Collected') +
      plain('New and repeat customers', [{ key: 'newCustomers', name: 'New' }, { key: 'repeatCustomers', name: 'Repeat' }], sum('newCustomers') + ' new, ' + sum('repeatCustomers') + ' repeat') +
      plain('Customer growth', [{ key: 'running', name: 'New customers so far' }], rows[rows.length - 1].running + ' gained') +
      '</div>';
  }

  /* ---------------------------------------------------------- comparisons */
  function compareHTML(d) {
    var table = function (title, set, now, before) {
      var row = function (label, c, fmt) {
        return '<tr><th scope="row">' + label + '</th><td>' + esc(fmt(c.cur)) + '</td><td>' + esc(fmt(c.prev)) + '</td><td>' + esc(changeText(c, fmt)) + '</td></tr>';
      };
      return '<table class="qb-table"><caption>' + esc(title) + '</caption><thead><tr><th scope="col">Measure</th><th scope="col">' + esc(now) + '</th><th scope="col">' + esc(before) + '</th><th scope="col">Change</th></tr></thead><tbody>' +
        row('Net sales', set.net, inr) + row('Bills', set.bills, count) + row('Average bill', set.average, inr) + row('Collected', set.collected, inr) + '</tbody></table>';
    };
    return '<h2 class="qb-h">Comparisons</h2><div class="qb-card2 qb-tables">' +
      table('This month so far, against the same days last month', d.compare.month, 'This month', 'Last month') +
      table('This week so far, against the same days last week', d.compare.week, 'This week', 'Last week') +
      table('This period, against the one before it', d.compare.period, rangeName(d.range.from, d.range.to), rangeName(d.range.prevFrom, d.range.prevTo)) +
      '</div>';
  }

  /* ----------------------------------------------------- what is selling */
  function rankHTML(title, rows, value, sub, none, id) {
    var top = rows.reduce(function (m, r) { return Math.max(m, value(r)); }, 0) || 1;
    return '<div class="qb-card2"' + (id ? ' id="' + id + '"' : '') + '><span class="qb-lab">' + title + '</span>' +
      (rows.length ? '<ol class="qb-rank">' + rows.slice(0, 8).map(function (r) {
        return '<li><span class="qb-rank__t"><b>' + esc(r.name) + '</b><span>' + esc(sub(r)) + '</span></span>' +
          '<span class="qb-rank__bar"><i style="width:' + (Math.max(value(r), 0) / top * 100) + '%"></i></span></li>';
      }).join('') + '</ol>' : '<p class="qb-sub">' + none + '</p>') + '</div>';
  }
  function stockListHTML(title, rows, none, drill) {
    return '<div class="qb-card2"><div class="qb-sec"><span class="qb-lab">' + title + ' <em>(' + rows.length + ')</em></span>' +
      (rows.length ? '<button class="qb-link" data-qb="drill" data-id="' + drill + '">Open stock</button>' : '') + '</div>' +
      (rows.length ? '<div class="qb-rows">' + rows.slice(0, 8).map(function (p) {
        return '<div class="qb-trow"><span>' + esc(p.name) + '</span><b>' + p.qty + '</b></div>';
      }).join('') + '</div>' : '<p class="qb-sub">' + none + '</p>') + '</div>';
  }
  function productFiguresHTML(d) {
    var live = activeProducts();
    var sold = {};
    d.products.forEach(function (r) { sold[r.id] = r.qty; });
    var low = live.filter(function (p) { return p.qty > 0 && p.qty <= p.lowStockAt; });
    var out = live.filter(function (p) { return p.qty <= 0; });
    var byQty = d.products.filter(function (r) { return r.qty > 0; }).sort(function (a, b) { return b.qty - a.qty; });
    var slow = live.filter(function (p) { return p.qty > 0; }).map(function (p) {
      return { name: p.name, qty: p.qty, sold: sold[p.id] || 0 };
    }).sort(function (a, b) { return a.sold - b.sold || b.qty - a.qty; }).slice(0, 8);
    var perDay = function (n) { return Math.round(n / d.range.days * 100) / 100; };
    var rev = function (r) { return r.revenuePaise; };
    var line = function (r) { return r.qty + ' sold · ' + inr(r.revenuePaise); };
    return '<h2 class="qb-h">Products</h2><div class="qb-reports">' +
      rankHTML('Best-selling products', d.products, rev, line, 'Nothing sold in this period.', 'qbBest') +
      rankHTML('Revenue by category', d.categories, rev, line, 'Nothing sold in this period.') +
      rankHTML('Sales by phone model', d.models, rev, line, 'No sale in this period was found through a phone model.') +
      rankHTML('Fast moving', byQty, function (r) { return r.qty; }, function (r) { return r.qty + ' sold · ' + perDay(r.qty) + ' a day'; }, 'Nothing sold in this period.') +
      rankHTML('Slow moving', slow, function (r) { return r.qty; }, function (r) { return r.sold + ' sold · ' + r.qty + ' in stock'; }, 'No products in stock.') +
      stockListHTML('Low stock', low, 'Nothing is running low.', 'stock-low') +
      stockListHTML('Out of stock', out, 'Nothing is out of stock.', 'stock-out') +
      '</div>';
  }

  /* --------------------------------------------------------- the drill-downs */
  function showBills(from, to, label) {
    var b = S.bills;
    b.filter = { period: 'custom', from: from, to: to, status: 'all', label: label };
    b.q = ''; b.loaded = false;
    go('/billing/bills');
  }
  function showCustomers(filter, since, label) {
    var cu = S.customers;
    cu.filter = filter; cu.since = since || 0; cu.range = label || ''; cu.q = ''; cu.loaded = false;
    go('/billing/customers');
  }
  function showProducts(filter) {
    S.prodFilter = Object.assign(PF.blankFilter(), filter);
    S.prodLimit = PRODUCT_PAGE;
    go('/billing/products');
  }
  function drill(id) {
    var d = S.overview.data;
    var today = (d && d.todayKey) || istDay();
    var month = today.slice(0, 8) + '01';
    switch (id) {
      case 'bills-today': showBills(today, today, 'Today’s bills'); break;
      case 'bills-month': showBills(month, today, 'Bills this month'); break;
      case 'cust-all': showCustomers('all'); break;
      case 'cust-outstanding': showCustomers('outstanding'); break;
      case 'cust-repeat': showCustomers('repeat'); break;
      case 'cust-new-today': showCustomers('new', dayStart(today), 'New customers today'); break;
      case 'cust-new-month': showCustomers('new', dayStart(month), 'New customers this month'); break;
      case 'stock-low': showProducts({ stock: 'low' }); break;
      case 'stock-out': showProducts({ stock: 'out' }); break;
    }
  }

  /* the bar under the pointer or the keyboard says what it is */
  function barTip(bar) {
    var plot = bar.closest('.qb-plot');
    var tip = plot && plot.querySelector('.qb-tip');
    if (!tip) return;
    tip.textContent = bar.getAttribute('aria-label');
    tip.hidden = false;
    var x = bar.offsetLeft + bar.offsetWidth / 2 - tip.offsetWidth / 2;
    tip.style.left = Math.max(0, Math.min(plot.clientWidth - tip.offsetWidth, x)) + 'px';
  }
  function barTipOff(bar) {
    var tip = bar.closest('.qb-plot').querySelector('.qb-tip');
    if (tip) tip.hidden = true;
  }

  /* ================================================================ SHEETS */
  function openSheet(kind, html, title) {
    var host = el('overlay');
    if (!host) return;
    host.innerHTML = '<div class="scrim" data-qb="close-sheet"></div>' +
      '<div class="sheet qb-sheet qb-sheet--' + kind + '" role="dialog" aria-modal="true" aria-label="' + esc(title || '') + '">' + html + '</div>';
    document.body.style.overflow = 'hidden';
  }
  function closeSheet() {
    if (S && S.sheet && S.sheet.busy) return;
    if (S) S.sheet = null;
    var host = el('overlay');
    if (host && host.querySelector('.qb-sheet')) host.innerHTML = '';
    document.body.style.overflow = '';
  }


  /* ----------------------------------------------- Quick Product Add / Edit

     The category is chosen first and decides the rest of the form. A category
     with a device list asks which device this is; one with compatibility asks
     which groups the product fits. Those parts repaint on their own, so nothing
     already typed elsewhere in the form is lost.

     Four things stay separate: the master device (read from the catalogue, never
     changed), the shop's product, its sellable variants with their own stock, and
     the links to compatibility groups. */
  var KIND_WORD = { phone: 'mobile', tablet: 'tablet', watch: 'watch' };

  function variantRow(v) {
    return {
      id: v.id, ram: v.ram || '', storage: v.storage || '', label: v.label || '', sku: v.sku || '', shelf: v.shelf || '',
      price: M.toInput(v.pricePaise), cost: v.costPaise == null ? '' : M.toInput(v.costPaise), qty: String(v.qty)
    };
  }
  function blankVariant(price, qty) {
    return { id: API.newId('v_'), ram: '', storage: '', label: '', sku: '', shelf: '', price: price || '', cost: '', qty: qty || '0' };
  }

  function openProductForm(mode, id, prefill) {
    var p = mode === 'edit' ? productById(id) : null;
    var lastCat = store('mpf.qb.lastcat');
    var cat = p ? p.categoryId
      : (S.filter.cat !== 'all' && S.filter.cat !== 'frequent' && catById(S.filter.cat)) ? S.filter.cat
      : (lastCat && catById(lastCat)) ? lastCat
      : (S.categories[0] && S.categories[0].id) || '';
    S.sheet = {
      type: 'product', mode: mode, id: p ? p.id : API.newId('p_'),
      img: null, removeImage: false, busy: false, fromLine: prefill && prefill.lineKey || null, added: 0,
      cat: cat, master: p && p.master ? p.master : null, noMaster: !!(p && !p.master), masterQ: '', autoName: '',
      useVariants: !!(p && hasVariants(p)), variants: p ? p.variants.map(variantRow) : [],
      groups: p ? (p.groupIds || []).slice() : [],
      linkBy: 'group', linkQ: '', linkModel: null, previews: {}
    };
    var v = {
      name: p ? p.name : (prefill && prefill.name) || '',
      price: p ? M.toInput(p.pricePaise) : (prefill && prefill.price) || '',
      qty: p ? String(p.qty) : (prefill && prefill.qty ? String(prefill.qty) : '1'),
      cost: p && p.costPaise != null ? M.toInput(p.costPaise) : '',
      shelf: p ? p.shelf : '', sku: p ? p.sku : '', low: p ? String(p.lowStockAt) : '1',
      description: p ? p.description : '', active: !p || p.active
    };
    openSheet('product', productFormHTML(mode, p, v, cat), mode === 'edit' ? 'Edit product' : 'Add product');
    var first = el(el('qbFMaster') ? 'qbFMaster' : 'qbFName');
    if (first && mode !== 'edit' && !isTouch()) first.focus();
  }
  function isTouch() { return global.matchMedia && global.matchMedia('(pointer: coarse)').matches; }

  function photoURL() {
    var sh = S.sheet;
    var p = sh.mode === 'edit' && !sh.removeImage ? productById(sh.id) : null;
    return { own: (p && p.imageUrl) || '', model: (sh.master && sh.master.image) || '' };
  }

  function productFormHTML(mode, p, v, cat) {
    var hasCats = S.categories.length > 0;
    var ph = photoURL();
    var shown = ph.own || ph.model;
    var cats = S.categories.filter(function (c) { return c.status !== 'inactive' || c.id === cat; });
    var plainHidden = S.sheet.useVariants ? ' hidden' : '';
    return '<div class="sheet__grab"></div>' +
      '<div class="sheet__head"><h3 class="t-h3 grow">' + (mode === 'edit' ? 'Edit product' : 'Add product') + '</h3>' +
      '<button class="iconbtn" data-qb="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<form class="sheet__body qb-form" id="qbProdForm" data-qbf="product" novalidate>' +
      '<div class="qb-ok" id="qbFDone" hidden></div>' +
      fieldHTML('qbFCat', 'cat', 'Category', true,
        (hasCats
          ? '<select class="input qb-in" id="qbFCat" name="cat" data-qbi="fcat">' +
            cats.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === cat ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') +
            '<option value="__new">+ New category…</option></select>'
          : '') +
        '<input class="input qb-in" id="qbFNewCat" name="newCat" maxlength="40" autocomplete="off" list="qbSuggestList" placeholder="New category name"' + (hasCats ? ' hidden' : '') + ' />' +
        '<datalist id="qbSuggestList">' + (S.suggested || []).map(function (n) { return '<option value="' + esc(n) + '"></option>'; }).join('') + '</datalist>') +
      '<div id="qbFDevice">' + deviceHTML() + '</div>' +
      '<div class="qb-photo">' +
      '<div class="qb-photo__box" id="qbFPhoto">' + (shown ? '<img src="' + esc(shown) + '" alt="" referrerpolicy="no-referrer" />' : icon('camera')) + '</div>' +
      '<div class="qb-photo__acts"><span class="qb-lab">Photo <em>(optional)</em></span>' +
      '<label class="btn btn--outline btn--sm qb-file">' + icon('camera') + '<span id="qbFPhotoBtn">' + (ph.own ? 'Change photo' : 'Add photo') + '</span>' +
      '<input type="file" accept="image/*" id="qbPhoto" data-qbi="photo" /></label>' +
      '<button type="button" class="qb-link" data-qb="photo-remove" id="qbFPhotoRm"' + (ph.own ? '' : ' hidden') + '>Remove</button></div></div>' +
      fieldHTML('qbFName', 'name', 'Product name', true, '<input class="input qb-in" id="qbFName" name="name" maxlength="80" autocomplete="off" placeholder="e.g. Redmi 13C Tempered Glass" value="' + esc(v.name) + '" />') +
      '<div id="qbFVariants">' + variantsHTML() + '</div>' +
      '<div id="qbFPlain"' + plainHidden + '>' +
      '<div class="qb-form__row">' +
      fieldHTML('qbFPrice', 'price', 'Selling price', true, '<label class="qb-prefix"><span>₹</span><input class="input qb-in" id="qbFPrice" name="price" inputmode="decimal" autocomplete="off" placeholder="0.00" value="' + esc(v.price) + '" /></label>') +
      fieldHTML('qbFCost', 'cost', 'Purchase price', false, '<label class="qb-prefix"><span>₹</span><input class="input qb-in" id="qbFCost" name="cost" inputmode="decimal" autocomplete="off" placeholder="Optional" value="' + esc(v.cost) + '" /></label>') +
      '</div>' +
      fieldHTML('qbFQty', 'qty', mode === 'edit' ? 'Quantity in stock' : 'Opening stock', true, '<div class="qb-qty qb-qty--form"><button type="button" data-qb="fqty-dec" aria-label="Decrease">' + icon('minus') + '</button>' +
        '<input class="qb-qty__in" id="qbFQty" name="qty" inputmode="numeric" autocomplete="off" value="' + esc(v.qty) + '" />' +
        '<button type="button" data-qb="fqty-inc" aria-label="Increase">' + icon('plus') + '</button></div>') +
      '</div>' +
      '<div class="qb-form__row">' +
      fieldHTML('qbFShelf', 'shelf', 'Shelf location', false, '<input class="input qb-in" id="qbFShelf" name="shelf" maxlength="24" autocomplete="off" placeholder="e.g. A3 or Drawer 2" value="' + esc(v.shelf) + '" />') +
      fieldHTML('qbFSku', 'sku', 'SKU / barcode', false, '<input class="input qb-in" id="qbFSku" name="sku" maxlength="40" autocomplete="off" placeholder="Optional" value="' + esc(v.sku) + '" />') +
      '</div>' +
      '<div id="qbFCompat">' + compatFormHTML() + '</div>' +
      fieldHTML('qbFDesc', 'description', 'Description', false, '<textarea class="input qb-in qb-notes" id="qbFDesc" name="description" rows="2" maxlength="300" placeholder="Optional">' + esc(v.description) + '</textarea>') +
      '<div class="qb-form__row">' +
      fieldHTML('qbFLow', 'low', 'Low-stock alert at', false, '<input class="input qb-in" id="qbFLow" name="low" inputmode="numeric" autocomplete="off" value="' + esc(v.low) + '" />') +
      fieldHTML('qbFStatus', 'status', 'Status', false, '<select class="input qb-in" id="qbFStatus" name="status"><option value="active"' + (v.active ? ' selected' : '') + '>Active</option><option value="inactive"' + (v.active ? '' : ' selected') + '>Inactive</option></select>') +
      '</div>' +
      '<button type="submit" hidden></button>' +
      '</form>' +
      '<div class="sheet__foot qb-formfoot">' +
      '<div class="qb-progress" id="qbFProg" hidden><span></span><em></em></div>' +
      '<div class="qb-formfoot__btns">' +
      '<button class="btn btn--ghost" data-qb="close-sheet">Cancel</button>' +
      (mode === 'edit' ? '' : '<button class="btn btn--outline" data-qb="product-save" data-id="again">Save &amp; add another</button>') +
      '<button class="btn qb-btn" data-qb="product-save" data-id="close">' + icon('check') + (mode === 'edit' ? 'Save changes' : 'Save product') + '</button>' +
      '</div></div>';
  }
  function modelInfo(m) {
    var b = SM.db && SM.db.brandById[m.brandId];
    return [b ? b.name : '', m.displaySize ? m.displaySize + '″' : '', m.releaseYear || ''].filter(Boolean).join(' · ');
  }
  function modelThumb(url) {
    return url ? '<span class="qb-thumb qb-thumb--sm"><img src="' + esc(url) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" /></span>'
      : '<span class="qb-thumb qb-thumb--sm qb-thumb--none">' + icon('phone') + '</span>';
  }

  /* the device a product is, in a category that has a device list */
  function deviceHTML() {
    var sh = S.sheet;
    var c = catById(sh.cat);
    var kind = c && c.deviceKind;
    if (!kind) return '';
    var word = KIND_WORD[kind];
    if (sh.master) {
      var m = SM.db && SM.db.modelById[sh.master.id];
      var twin = S.products.filter(function (p) { return p.active && p.id !== sh.id && p.master && p.master.id === sh.master.id; })[0];
      return '<div class="qb-ff" data-ff="device"><span class="qb-lab">Model</span>' +
        '<div class="qb-picked">' + modelThumb(sh.master.image || (m && m.image)) +
        '<span class="grow"><b>' + esc(sh.master.name) + '</b>' + (m ? '<span>' + esc(modelInfo(m)) + '</span>' : '') + '</span>' +
        '<button type="button" class="qb-link" data-qb="master-clear">Change</button></div>' +
        (twin ? '<small class="qb-help">You already have “' + esc(twin.name) + '”. <button type="button" class="qb-link" data-qb="edit-product" data-id="' + esc(twin.id) + '">Add a variant to it</button></small>' : '') +
        '</div>';
    }
    return fieldHTML('qbFMaster', 'device', 'Which ' + word + ' is this?', false,
      '<input class="input qb-in" id="qbFMaster" type="search" autocomplete="off" placeholder="Search model or brand" value="' + esc(sh.masterQ) + '" data-qbi="master-q" />') +
      '<div class="qb-hits" id="qbFMasterHits">' + masterHitsHTML() + '</div>' +
      '<label class="qb-check"><input type="checkbox" data-qbi="no-master"' + (sh.noMaster ? ' checked' : '') + ' />Not in the list. Save it as my own product.</label>';
  }
  function masterHitsHTML() {
    var sh = S.sheet;
    var c = catById(sh.cat);
    if (sh.masterQ.length < 2 || !c) return '';
    var hits = modelMatches(sh.masterQ, c.deviceKind, 6);
    if (!hits.length) return '<p class="qb-sub">No ' + KIND_WORD[c.deviceKind] + ' matches “' + esc(sh.masterQ) + '”. Nothing is added to the master list.</p>';
    return hits.map(function (m) {
      return '<button type="button" class="qb-hit" data-qb="master-pick" data-id="' + esc(m.id) + '">' + modelThumb(m.image) +
        '<span class="grow"><b>' + esc(m.fullName) + '</b><span>' + esc(modelInfo(m)) + '</span></span></button>';
    }).join('');
  }

  /* RAM and storage for phones and tablets, a name for anything else */
  function variantsHTML() {
    var sh = S.sheet;
    var c = catById(sh.cat);
    var kind = c && c.deviceKind;
    if (!kind && !sh.useVariants) return '';
    var byName = kind === 'watch' || !kind;
    var box = function (i, k, label, hint, attrs) {
      return '<label class="qb-vf"><span>' + label + '</span><input class="input qb-in" autocomplete="off" data-qbi="var" data-i="' + i + '" data-k="' + k + '" value="' + esc(sh.variants[i][k]) + '"' +
        (hint ? ' placeholder="' + esc(hint) + '"' : '') + (attrs || '') + ' /></label>';
    };
    var rows = sh.variants.map(function (v, i) {
      return '<fieldset class="qb-var"><legend>Variant ' + (i + 1) + '</legend>' +
        '<button type="button" class="qb-var__x" data-qb="var-remove" data-id="' + i + '" aria-label="Remove variant ' + (i + 1) + '">' + icon('close') + '</button>' +
        '<div class="qb-var__grid">' +
        (byName
          ? box(i, 'label', 'Name', 'e.g. 44 mm Black', ' maxlength="40"')
          : box(i, 'ram', 'RAM', 'e.g. 4 GB', ' maxlength="16"') + box(i, 'storage', 'Storage', 'e.g. 128 GB', ' maxlength="16"')) +
        box(i, 'price', 'Selling price ₹', '', ' inputmode="decimal"') +
        box(i, 'cost', 'Purchase price ₹', 'Optional', ' inputmode="decimal"') +
        box(i, 'qty', 'Stock', '', ' inputmode="numeric"') +
        box(i, 'sku', 'SKU', 'Optional', ' maxlength="40"') +
        box(i, 'shelf', 'Shelf', 'Optional', ' maxlength="24"') +
        '</div></fieldset>';
    }).join('');
    return '<div class="qb-ff" data-ff="variants">' +
      '<label class="qb-check"><input type="checkbox" data-qbi="use-variants"' + (sh.useVariants ? ' checked' : '') + ' />' +
      (byName ? 'Sold in more than one version' : 'Sold in more than one RAM and storage') + '</label>' +
      (sh.useVariants
        ? '<div class="qb-vars">' + rows + '</div>' +
          '<button type="button" class="btn btn--outline btn--sm" data-qb="var-add">' + icon('plus') + 'Add variant</button>'
        : '') +
      '<small class="qb-err" data-ferr="variants"></small></div>';
  }
  function paintVariants() {
    paint('qbFVariants', variantsHTML());
    var plain = el('qbFPlain');
    if (plain) plain.hidden = !!S.sheet.useVariants;
  }

  /* which compatibility groups the product fits. Groups are only ever linked,
     never made here: the list is the catalogue's. */
  function partCategory() {
    var c = catById(S.sheet.cat);
    return (c && c.compat && c.compat.partCategory) || null;
  }
  function groupBrief(id) {
    var g = SM.db && SM.db.groupById[id];
    var seen = S.sheet.previews[id];
    var r = seen && seen.group;
    return {
      id: id,
      master: g ? g.masterModelName : r ? r.masterModelName : id,
      code: (g && g.partCode) || (r && r.partCode) || '',
      count: g ? g.compatibleCount : r ? r.memberCount : null
    };
  }
  function groupHitHTML(b) {
    var on = S.sheet.groups.indexOf(b.id) > -1;
    return '<button type="button" class="qb-hit' + (on ? ' is-on' : '') + '" data-qb="link-toggle" data-id="' + esc(b.id) + '" aria-pressed="' + on + '">' +
      '<span class="qb-hit__tick">' + icon(on ? 'check' : 'plus') + '</span>' +
      '<span class="grow"><b>' + esc(b.master) + '</b><span>' + [b.code, b.count != null ? b.count + (b.count === 1 ? ' model' : ' models') : ''].filter(Boolean).map(esc).join(' · ') + '</span></span></button>';
  }
  function compatFormHTML() {
    var sh = S.sheet;
    var c = catById(sh.cat);
    if (!compatOn(c)) {
      return sh.groups.length && sh.mode === 'edit'
        ? '<p class="qb-sub">Compatibility is off for this category. This product keeps its ' + sh.groups.length + (sh.groups.length === 1 ? ' link' : ' links') + ' for when it is turned on.</p>'
        : '';
    }
    var seg = function (v, t) {
      return '<button type="button" class="' + (sh.linkBy === v ? 'is-on' : '') + '" data-qb="link-by" data-id="' + v + '" aria-pressed="' + (sh.linkBy === v) + '">' + t + '</button>';
    };
    return '<div class="qb-ff" data-ff="groups"><span class="qb-lab">Compatibility groups</span>' +
      '<div class="qb-inrow"><div class="qb-seg qb-seg--sm" role="group" aria-label="Find groups by">' + seg('group', 'By group') + seg('model', 'By model') + '</div></div>' +
      '<input class="input qb-in" id="qbFLinkQ" type="search" autocomplete="off" value="' + esc(sh.linkQ) + '" data-qbi="link-q" aria-label="Find compatibility groups" placeholder="' +
      (sh.linkBy === 'group' ? 'Search a group by its model or part code' : 'Search a model to see its groups') + '" />' +
      '<div class="qb-hits" id="qbFLinkHits">' + linkHitsHTML() + '</div>' +
      '<div id="qbFLinked">' + linkedHTML() + '</div></div>';
  }
  function linkHitsHTML() {
    var sh = S.sheet;
    var part = partCategory();
    if (sh.linkBy === 'model') {
      var lm = sh.linkModel;
      if (lm) {
        var head = '<div class="qb-picked"><span class="grow"><b>' + esc(lm.name) + '</b><span>Groups this model is in</span></span>' +
          '<button type="button" class="qb-link" data-qb="link-model-clear">Change</button></div>';
        if (lm.loading) return head + C.skelRows(2);
        if (lm.error) return head + '<p class="qb-err">' + esc(say(lm.error)) + '</p>';
        if (!lm.groups.length) return head + '<p class="qb-sub">This model is not in a group of this type.</p>';
        return head + lm.groups.map(groupHitHTML).join('');
      }
      if (sh.linkQ.length < 2) return '';
      var models = modelMatches(sh.linkQ, null, 6);
      if (!models.length) return '<p class="qb-sub">No model matches “' + esc(sh.linkQ) + '”.</p>';
      return models.map(function (m) {
        return '<button type="button" class="qb-hit" data-qb="link-model" data-id="' + esc(m.id) + '">' + modelThumb(m.image) +
          '<span class="grow"><b>' + esc(m.fullName) + '</b><span>' + esc(modelInfo(m)) + '</span></span></button>';
      }).join('');
    }
    if (sh.linkQ.length < 2) return '';
    var words = sh.linkQ.toLowerCase().split(/\s+/).filter(Boolean);
    var list = (SM.db && SM.db.groups) || [];
    var whole = sh.linkQ.toLowerCase();
    var named = [], hits = [];
    list.forEach(function (g) {
      if (part && g.categoryId !== part) return;
      var name = g.masterModelName.toLowerCase();
      var hay = name + ' ' + (g.partCode || '').toLowerCase() + ' ' + String(g.groupNumber || '').toLowerCase();
      if (name === whole) named.unshift(g.groupId);
      else if (name.indexOf(whole) === 0) named.push(g.groupId);
      else if (words.every(function (w) { return hay.indexOf(w) > -1; })) hits.push(g.groupId);
    });
    hits = named.concat(hits).slice(0, 12).map(groupBrief);
    if (!hits.length) return '<p class="qb-sub">No group matches “' + esc(sh.linkQ) + '”. Try searching by model.</p>';
    return hits.map(groupHitHTML).join('');
  }
  function linkedHTML() {
    var sh = S.sheet;
    if (!sh.groups.length) return '<p class="qb-sub">No groups linked. Without one, this product does not appear when a phone model is searched.</p>';
    return '<span class="qb-lab">Linked <em>(' + sh.groups.length + ')</em></span><ul class="qb-links">' + sh.groups.map(function (id) {
      var b = groupBrief(id);
      var pv = sh.previews[id];
      return '<li><div class="qb-links__row"><span class="grow"><b>' + esc(b.master) + '</b><span>' +
        [b.code, b.count != null ? b.count + (b.count === 1 ? ' model' : ' models') : ''].filter(Boolean).map(esc).join(' · ') + '</span></span>' +
        '<button type="button" class="qb-link" data-qb="link-preview" data-id="' + esc(id) + '" aria-expanded="' + !!(pv && pv.open) + '">Models</button>' +
        '<button type="button" class="qb-link qb-danger" data-qb="link-toggle" data-id="' + esc(id) + '" aria-label="Remove ' + esc(b.master) + '">Remove</button></div>' +
        (pv && pv.open ? '<div class="qb-links__pv">' + previewHTML(pv) + '</div>' : '') + '</li>';
    }).join('') + '</ul>';
  }
  /* what the shop's plan shows of a group; the rest is a count */
  function previewHTML(pv) {
    if (pv.loading) return C.skelRows(1);
    if (pv.error) return '<p class="qb-err">' + esc(say(pv.error)) + '</p>';
    var g = pv.group;
    var names = (g.members && g.members.length ? g.members : g.preview || []).map(function (m) { return m.name || m.id || m; });
    var more = Math.max(0, g.memberCount - names.length);
    return '<p class="qb-sub"><b>' + esc(g.masterModelName) + '</b> · ' + g.memberCount + (g.memberCount === 1 ? ' model' : ' models') + '</p>' +
      (names.length ? '<p class="qb-sub">' + names.map(esc).join(', ') + (more ? ' and ' + more + ' more' : '') + '</p>' : '') +
      (more && g.requiresPlan ? '<small class="qb-help">A plan shows every model in the group. The link works the same without one.</small>' : '');
  }
  function paintLinks() {
    paint('qbFLinkHits', linkHitsHTML());
    paint('qbFLinked', linkedHTML());
  }
  function loadLinkModel(id) {
    var sh = S.sheet;
    var m = SM.db && SM.db.modelById[id];
    if (!m) return;
    sh.linkModel = { id: id, name: m.fullName, loading: true, error: null, groups: [] };
    paint('qbFLinkHits', linkHitsHTML());
    API.modelGroups(id, partCategory()).then(function (r) {
      if (S.sheet !== sh || !sh.linkModel || sh.linkModel.id !== id) return;
      var out = [];
      (r.categories || []).forEach(function (c) {
        c.groups.forEach(function (g) {
          sh.previews[g.groupId] = sh.previews[g.groupId] || { group: g, open: false };
          out.push(groupBrief(g.groupId));
        });
      });
      sh.linkModel.loading = false;
      sh.linkModel.groups = out;
      paintLinks();
    }, function (err) {
      if (S.sheet !== sh || !sh.linkModel) return;
      sh.linkModel.loading = false;
      sh.linkModel.error = err;
      paint('qbFLinkHits', linkHitsHTML());
    });
  }
  function togglePreview(id) {
    var sh = S.sheet;
    var pv = sh.previews[id] || (sh.previews[id] = {});
    pv.open = !pv.open;
    if (pv.open && !pv.group) {
      pv.loading = true;
      API.group(id).then(function (r) {
        pv.loading = false; pv.error = null; pv.group = r.group;
        if (S.sheet === sh) paintLinks();
      }, function (err) {
        pv.loading = false; pv.error = err;
        if (S.sheet === sh) paintLinks();
      });
    }
    paint('qbFLinked', linkedHTML());
  }
  function productCategoryChanged(value) {
    var sh = S.sheet;
    sh.cat = value === '__new' ? '' : value;
    var c = catById(sh.cat);
    var kind = (c && c.deviceKind) || null;
    if (sh.master && sh.master.kind !== kind) sh.master = null;
    sh.masterQ = ''; sh.noMaster = false;
    sh.linkQ = ''; sh.linkModel = null;
    var part = partCategory();
    if (sh.mode !== 'edit' && !compatOn(c)) sh.groups = [];
    if (part) {
      sh.groups = sh.groups.filter(function (id) {
        var g = SM.db && SM.db.groupById[id];
        return !g || g.categoryId === part;
      });
    }
    paint('qbFDevice', deviceHTML());
    paintVariants();
    paint('qbFCompat', compatFormHTML());
    resetPhoto();
  }

  function fieldHTML(id, key, text, req, control) {
    return '<div class="qb-ff" data-ff="' + key + '"><label class="qb-lab" for="' + id + '">' + text + (req ? ' <b class="qb-req">*</b>' : '') + '</label>' +
      control + '<small class="qb-err" data-ferr="' + key + '"></small></div>';
  }

  function formError(key, msg) {
    var f = document.querySelector('[data-ff="' + key + '"]');
    if (!f) return;
    f.classList.toggle('is-bad', !!msg);
    var e = f.querySelector('[data-ferr]');
    if (e) e.textContent = msg || '';
  }

  function submitProduct(again) {
    var sh = S.sheet;
    if (!sh || sh.type !== 'product' || sh.busy) return;
    var val = function (id) { var n = el(id); return n ? n.value : ''; };
    var name = val('qbFName').replace(/\s+/g, ' ').trim();
    var useV = sh.useVariants;
    var price = M.parseRupees(val('qbFPrice'));
    var qtyT = val('qbFQty').trim();
    var qty = /^\d{1,6}$/.test(qtyT) ? Number(qtyT) : null;
    var costT = val('qbFCost').trim();
    var cost = costT === '' ? null : M.parseRupees(costT);
    var lowT = val('qbFLow').trim();
    var low = lowT === '' ? 1 : (/^\d{1,6}$/.test(lowT) ? Number(lowT) : null);
    var sel = el('qbFCat');
    var newCatBox = el('qbFNewCat');
    var useNew = !sel || sel.value === '__new';
    var catId = useNew ? '' : sel.value;
    var newCat = useNew && newCatBox ? newCatBox.value.replace(/\s+/g, ' ').trim() : '';
    var cat = catById(catId);
    var kind = (cat && cat.deviceKind) || null;

    var bad = [];
    formError('name', name ? '' : (bad.push('qbFName'), 'Enter a product name'));
    formError('cat', catId || newCat ? '' : (bad.push(useNew ? 'qbFNewCat' : 'qbFCat'), 'Choose or name a category'));
    formError('low', low != null ? '' : (bad.push('qbFLow'), 'Enter a whole number'));
    formError('device', kind && !sh.master && !sh.noMaster
      ? (bad.push('qbFMaster'), 'Choose the model, or tick “Not in the list”') : '');
    if (useV) {
      var vErr = '';
      if (!sh.variants.length) vErr = 'Add at least one variant, or untick this.';
      sh.variants.forEach(function (v, i) {
        if (vErr) return;
        var n = 'Variant ' + (i + 1) + ': ';
        var cv = v.cost.trim();
        if (!v.ram.trim() && !v.storage.trim() && !v.label.trim()) vErr = n + 'say which one it is.';
        else if (!(M.parseRupees(v.price) > 0)) vErr = n + 'enter a selling price.';
        else if (cv && M.parseRupees(cv) == null) vErr = n + 'enter a purchase price, or leave it empty.';
        else if (!/^\d{1,6}$/.test(v.qty.trim())) vErr = n + 'enter the stock as a whole number.';
      });
      formError('variants', vErr);
      if (vErr) bad.push('qbFVariants');
    } else {
      formError('price', price && price > 0 ? '' : (bad.push('qbFPrice'), 'Enter a selling price, e.g. 199 or 199.50'));
      formError('cost', costT === '' || cost != null ? '' : (bad.push('qbFCost'), 'Enter a price, or leave it empty'));
      formError('qty', qty != null ? '' : (bad.push('qbFQty'), 'Enter a whole number, 0 or more'));
    }
    if (bad.length) {
      var f = el(bad[0]);
      if (f) { f.scrollIntoView({ block: 'center' }); if (f.focus) f.focus(); }
      return;
    }

    var body = {
      action: sh.mode === 'edit' ? 'update' : 'create',
      productId: sh.id, name: name, shelf: val('qbFShelf'), sku: val('qbFSku'), lowStockAt: low,
      description: val('qbFDesc'), active: val('qbFStatus') !== 'inactive',
      master: kind && sh.master ? { id: sh.master.id, kind: kind, image: sh.master.image || undefined } : null,
      variants: useV ? sh.variants.map(function (v) {
        return {
          id: v.id, ram: v.ram, storage: v.storage, label: v.label, sku: v.sku, shelf: v.shelf,
          pricePaise: M.parseRupees(v.price), costPaise: v.cost.trim() ? M.parseRupees(v.cost) : null, qty: Number(v.qty.trim())
        };
      }) : []
    };
    if (!useV) { body.pricePaise = price; body.qty = qty; body.costPaise = cost; }
    if (compatOn(cat)) body.groupIds = sh.groups;
    if (catId) body.categoryId = catId; else body.newCategory = newCat;
    if (sh.img) body.image = { type: sh.img.type, data: sh.img.data };
    if (sh.removeImage && !sh.img) body.removeImage = true;

    sh.busy = true;
    setFormBusy(true, sh.img ? 0 : null);
    var uid = S.uid;
    API.product(body, sh.img ? function (p) { setFormBusy(true, p); } : null).then(function (r) {
      if (S.uid !== uid) return;
      upsertProduct(r.product);
      upsertCategory(r.category);
      store('mpf.qb.lastcat', r.product.categoryId);
      sh.busy = false;
      var line = sh.fromLine && lineByKey(sh.fromLine);
      if (line) {
        /* the custom line was explicitly saved as a product: from now on it
           is that product, and finalising the bill takes it out of stock */
        line.productId = r.product.id; line.shelf = r.product.shelf; line.sku = r.product.sku;
        saveCart();
      }
      if (again && sh.mode !== 'edit') {
        toast('Added “' + r.product.name + '”', 'checkCircle');
        sh.id = API.newId('p_');
        sh.img = null; sh.removeImage = false; sh.added++;
        sh.master = null; sh.noMaster = false; sh.masterQ = ''; sh.autoName = '';
        sh.useVariants = false; sh.variants = [];
        sh.groups = []; sh.linkQ = ''; sh.linkModel = null; sh.previews = {};
        ['qbFName', 'qbFPrice', 'qbFCost', 'qbFShelf', 'qbFSku', 'qbFDesc'].forEach(function (id) { var n = el(id); if (n) n.value = ''; });
        var q = el('qbFQty'); if (q) q.value = '1';
        if (sel && r.category) {
          var o = document.createElement('option'); o.value = r.category.id; o.textContent = r.category.name;
          sel.insertBefore(o, sel.querySelector('option[value="__new"]'));
          sel.value = r.category.id;
          sh.cat = r.category.id;
          if (newCatBox) { newCatBox.hidden = true; newCatBox.value = ''; }
        }
        paint('qbFDevice', deviceHTML());
        paintVariants();
        paint('qbFCompat', compatFormHTML());
        resetPhoto();
        var done = el('qbFDone');
        if (done) { done.hidden = false; done.className = 'qb-ok'; done.innerHTML = icon('checkCircle') + '<span>' + sh.added + (sh.added === 1 ? ' product' : ' products') + ' added. Add the next one.</span>'; }
        setFormBusy(false);
        var nm = el(el('qbFMaster') ? 'qbFMaster' : 'qbFName'); if (nm) nm.focus();
      } else {
        toast(sh.mode === 'edit' ? 'Product updated' : 'Added “' + r.product.name + '”', 'checkCircle');
        closeSheet();
        if (sh.mode !== 'edit') S.prodFlash = r.product.id;
      }
      softAfterProductChange();
    }, function (err) {
      sh.busy = false;
      setFormBusy(false);
      var done = el('qbFDone');
      if (done) {
        done.hidden = false; done.className = 'qb-ok qb-ok--bad'; done.innerHTML = icon('alert') + '<span>' + esc(say(err)) + '</span>';
        done.scrollIntoView({ block: 'center' });
      }
      if (err.code === 'product-name') formError('name', 'Enter a product name');
      if (err.code === 'product-price') formError('price', 'Enter a valid price');
    });
  }

  function softAfterProductChange() {
    if (!onBilling()) return;
    var v = viewName();
    if (v === 'pos') {
      if (!el('qbCatalog')) { rerender(); return; }
      if (!document.querySelector('.qb-quickadd') && S.products.length) { rerender(); return; }
      paintCatalog();
      if (el('qbLines')) paint('qbLines', linesHTML(draft()));
    } else if (v === 'products') paintProductList();
    else if (v === 'categories') rerender();
    else if (v === 'overview') paint('qbOverBody', overviewBodyHTML());
  }

  function setFormBusy(on, progress) {
    var form = el('qbProdForm');
    var foot = document.querySelector('.qb-formfoot');
    if (foot) Array.prototype.forEach.call(foot.querySelectorAll('button'), function (b) { b.disabled = !!on; });
    if (form) form.classList.toggle('is-busy', !!on);
    var bar = el('qbFProg');
    if (!bar) return;
    bar.hidden = !on;
    if (!on) return;
    var span = bar.querySelector('span'), em = bar.querySelector('em');
    if (progress == null) { bar.classList.add('is-indet'); em.textContent = 'Saving…'; }
    else {
      bar.classList.remove('is-indet');
      var pctv = Math.round(progress * 100);
      span.style.width = pctv + '%';
      em.textContent = pctv < 100 ? 'Uploading photo… ' + pctv + '%' : 'Saving…';
    }
  }

  function resetPhoto() {
    var box = el('qbFPhoto');
    if (!S.sheet) return;
    var ph = photoURL();
    var url = ph.own || ph.model;
    if (box) box.innerHTML = url ? '<img src="' + esc(url) + '" alt="" referrerpolicy="no-referrer" />' : icon('camera');
    var rm = el('qbFPhotoRm'); if (rm) rm.hidden = !ph.own;
    var btn = el('qbFPhotoBtn'); if (btn) btn.textContent = ph.own ? 'Change photo' : 'Add photo';
    var input = el('qbPhoto'); if (input) input.value = '';
  }

  function onPhotoPicked(input) {
    var file = input.files && input.files[0];
    if (!file || !S.sheet || S.sheet.type !== 'product') return;
    var box = el('qbFPhoto');
    if (box) box.innerHTML = '<span class="qb-spin qb-spin--dark"></span>';
    API.prepareImage(file).then(function (img) {
      if (!S.sheet || S.sheet.type !== 'product') return;
      S.sheet.img = img;
      S.sheet.removeImage = false;
      if (box) box.innerHTML = '<img src="' + img.preview + '" alt="" />';
      var rm = el('qbFPhotoRm'); if (rm) rm.hidden = false;
      var btn = el('qbFPhotoBtn'); if (btn) btn.textContent = 'Change photo';
    }, function (err) {
      resetPhoto();
      toast(say(err), 'alert');
    });
  }

  /* -------------------------------------------------------- stock sheet */
  function openStockSheet(id) {
    var p = productById(id);
    if (!p) return;
    S.sheet = { type: 'stock', id: id, adjustId: API.newId('a_'), busy: false, moves: null };
    openSheet('stock', stockSheetHTML(p), 'Stock for ' + p.name);
    var uid = S.uid;
    API.moves(id).then(function (r) {
      if (!S.sheet || S.sheet.type !== 'stock' || S.sheet.id !== id || S.uid !== uid) return;
      S.sheet.moves = r.moves;
      paint('qbMoves', movesHTML(r.moves));
    }, function (err) { paint('qbMoves', '<p class="qb-err">' + esc(say(err)) + '</p>'); });
  }
  function stockSheetHTML(p) {
    return '<div class="sheet__grab"></div>' +
      '<div class="sheet__head">' + thumbHTML(p, 'qb-thumb--sm') + '<div class="grow"><h3 class="t-h3">' + esc(p.name) + '</h3>' +
      '<span class="qb-sub">In stock: <b id="qbStockNow">' + p.qty + '</b></span></div>' +
      '<button class="iconbtn" data-qb="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<form class="sheet__body qb-form" data-qbf="adjust" novalidate>' +
      '<span class="qb-lab">Adjust stock</span>' +
      (hasVariants(p)
        ? '<select class="input qb-in" id="qbAdjVar" aria-label="Variant">' + p.variants.map(function (v) {
          return '<option value="' + esc(v.id) + '">' + esc(variantLabel(v)) + ' · ' + v.qty + ' in stock</option>';
        }).join('') + '</select>'
        : '') +
      '<div class="qb-inrow">' +
      '<div class="qb-seg qb-seg--sm" role="group" aria-label="Add or remove">' +
      '<button type="button" class="is-on" data-qb="adj-dir" data-id="in" aria-pressed="true">+ Add</button>' +
      '<button type="button" data-qb="adj-dir" data-id="out" aria-pressed="false">− Remove</button></div>' +
      '<input class="input qb-in qb-in--qty" id="qbAdjN" inputmode="numeric" autocomplete="off" placeholder="Qty" aria-label="Quantity to adjust" />' +
      '</div>' +
      '<select class="input qb-in" id="qbAdjWhy" aria-label="Reason">' + ADJUST_REASONS.map(function (r) { return '<option>' + esc(r) + '</option>'; }).join('') + '</select>' +
      '<input class="input qb-in" id="qbAdjNote" maxlength="100" autocomplete="off" placeholder="Note (optional)" aria-label="Note" />' +
      '<small class="qb-err" id="qbAdjErr"></small>' +
      '<button class="btn qb-btn" type="submit" id="qbAdjGo">' + icon('check') + 'Apply</button>' +
      '<span class="qb-lab">Stock movements</span><div id="qbMoves">' + C.skelRows(3) + '</div>' +
      '</form>';
  }
  function movesHTML(moves) {
    if (!moves.length) return '<p class="qb-sub">No movements yet.</p>';
    var why = { opening: 'Opening stock', sale: 'Sold', void: 'Bill voided', adjust: 'Adjusted', edit: 'Quantity edited' };
    return '<ul class="qb-moves">' + moves.map(function (m) {
      return '<li><span class="qb-moves__d ' + (m.delta < 0 ? 'is-out' : 'is-in') + '">' + (m.delta > 0 ? '+' : '') + m.delta + '</span>' +
        '<span class="qb-moves__w"><b>' + esc(why[m.reason] || m.reason) + (m.billNumber ? ' · <a href="/billing/bills/' + encodeURIComponent(m.billId) + '">' + esc(m.billNumber) + '</a>' : '') + '</b>' +
        '<span>' + esc(when(m.at)) + (m.variantLabel ? ' · ' + esc(m.variantLabel) : '') + (m.note ? ' · ' + esc(m.note) : '') + '</span></span>' +
        '<span class="qb-moves__q">→ ' + m.qtyAfter + '</span></li>';
    }).join('') + '</ul>';
  }
  function submitAdjust() {
    var sh = S.sheet;
    if (!sh || sh.type !== 'stock' || sh.busy) return;
    var n = String((el('qbAdjN') || {}).value || '').trim();
    var err = el('qbAdjErr');
    if (!/^\d{1,6}$/.test(n) || Number(n) === 0) { if (err) err.textContent = 'Enter how many, e.g. 5'; return; }
    var outDir = !!document.querySelector('[data-qb="adj-dir"][data-id="out"].is-on');
    var delta = outDir ? -Number(n) : Number(n);
    var note = [(el('qbAdjWhy') || {}).value, (el('qbAdjNote') || {}).value].filter(Boolean).join(' — ');
    sh.busy = true;
    var go2 = el('qbAdjGo'); if (go2) go2.disabled = true;
    var vbox = el('qbAdjVar');
    API.product({ action: 'adjust', productId: sh.id, adjustId: sh.adjustId, delta: delta, note: note, variantId: vbox ? vbox.value : undefined }).then(function (r) {
      sh.busy = false;
      upsertProduct(r.product);
      toast('Stock is now ' + r.product.qty, 'checkCircle');
      closeSheet();
      softAfterProductChange();
    }, function (e) {
      sh.busy = false;
      if (go2) go2.disabled = false;
      if (err) err.textContent = say(e);
    });
  }

  /* ------------------------------------------------------ variant picker */
  function openVariantPicker(p, model, qty) {
    S.sheet = { type: 'variant', id: p.id, model: model || null, qty: qty || 1 };
    openSheet('variant',
      '<div class="sheet__grab"></div><div class="sheet__head">' + thumbHTML(p, 'qb-thumb--sm') +
      '<div class="grow"><h3 class="t-h3">' + esc(p.name) + '</h3><span class="qb-sub">Choose the variant being sold</span></div>' +
      '<button class="iconbtn" data-qb="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<div class="sheet__body qb-form"><div class="qb-hits">' + p.variants.map(function (v) {
        var left = v.qty - inCart(p.id, v.id);
        var meta = [v.shelf ? 'Shelf ' + v.shelf : '', v.sku].filter(Boolean).map(esc).join(' · ');
        return '<button type="button" class="qb-hit" data-qb="pick-variant" data-id="' + esc(v.id) + '"' + (left <= 0 ? ' disabled' : '') + '>' +
          '<span class="grow"><b>' + esc(variantLabel(v)) + '</b><span>' + (meta || '&nbsp;') + '</span></span>' +
          '<span class="qb-hit__n"><b>' + inr(v.pricePaise) + '</b>' +
          '<span class="qb-stock' + (left <= 0 ? ' qb-stock--out' : '') + '">' + (v.qty <= 0 ? 'Out of stock' : left <= 0 ? 'All on the bill' : left + ' in stock') + '</span></span></button>';
      }).join('') + '</div></div>', 'Choose a variant');
  }

  /* ------------------------------------------------------- labels sheet */
  function labelEntriesFromBill(b) {
    return (b.items || []).map(function (it) {
      var p = it.productId ? productById(it.productId) : null;
      return {
        name: it.name + (it.variantLabel ? ' ' + it.variantLabel : ''), pricePaise: p && !it.variantId ? p.pricePaise : it.unitPaise,
        shelf: p && !it.variantId ? p.shelf : it.shelf, sku: p && !it.variantId ? p.sku : it.sku, count: it.qty, custom: !it.productId
      };
    });
  }
  function openLabels(entries, title) {
    S.sheet = { type: 'labels', entries: entries };
    openSheet('labels',
      '<div class="sheet__grab"></div><div class="sheet__head"><h3 class="t-h3 grow">' + esc(title || 'Print Product Labels') + '</h3>' +
      '<button class="iconbtn" data-qb="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<div class="sheet__body qb-form">' +
      '<p class="qb-sub">Choose the items and how many labels of each. Each label shows the name, price, shelf and SKU.</p>' +
      '<div class="qb-lblrows">' + entries.map(function (e, i) {
        return '<label class="qb-lblrow"><input type="checkbox" data-lbl-on="' + i + '"' + (e.custom ? '' : ' checked') + ' />' +
          '<span class="grow"><b>' + esc(e.name) + '</b><span>' + inr(e.pricePaise) + (e.shelf ? ' · Shelf ' + esc(e.shelf) : '') + (e.sku ? ' · ' + esc(e.sku) : '') + '</span></span>' +
          '<input class="input qb-in qb-in--qty" inputmode="numeric" data-lbl-n="' + i + '" value="' + e.count + '" aria-label="Labels for ' + esc(e.name) + '" /></label>';
      }).join('') + '</div>' +
      '<span class="qb-lab">Label paper</span>' +
      '<div class="qb-seg" role="group" aria-label="Label paper">' +
      '<button class="is-on" data-qb="lbl-layout" data-id="a4" aria-pressed="true">A4 sheet (3 × 8)</button>' +
      '<button data-qb="lbl-layout" data-id="roll" aria-pressed="false">Label roll 50 × 25 mm</button></div>' +
      '</div>' +
      '<div class="sheet__foot"><button class="btn btn--ghost" data-qb="close-sheet">Cancel</button>' +
      '<button class="btn qb-btn grow" data-qb="lbl-print">' + icon('printer') + 'Print Labels</button></div>',
      'Print Product Labels');
  }
  function printChosenLabels() {
    var sh = S.sheet;
    if (!sh || sh.type !== 'labels') return;
    var out = [];
    sh.entries.forEach(function (e, i) {
      var on = document.querySelector('[data-lbl-on="' + i + '"]');
      var n = document.querySelector('[data-lbl-n="' + i + '"]');
      var count = n && /^\d{1,3}$/.test(n.value.trim()) ? Number(n.value.trim()) : 0;
      if (on && on.checked && count > 0) out.push(Object.assign({}, e, { count: Math.min(count, 300) }));
    });
    if (!out.length) { toast('Choose at least one label', 'alert'); return; }
    var layout = document.querySelector('[data-qb="lbl-layout"].is-on');
    printLabels(out, layout ? layout.getAttribute('data-id') : 'a4');
  }

  /* ---------------------------------------------------- void / payment */
  function openVoid(id) {
    var b = S.billCache[id];
    if (!b) return;
    var products = (b.items || []).filter(function (i) { return i.productId; }).reduce(function (n, i) { return n + i.qty; }, 0);
    S.sheet = { type: 'void', id: id, busy: false };
    openSheet('void',
      '<div class="sheet__grab"></div><div class="sheet__head"><h3 class="t-h3 grow">Void ' + esc(b.number) + '?</h3>' +
      '<button class="iconbtn" data-qb="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<form class="sheet__body qb-form" data-qbf="void" novalidate>' +
      '<div class="qb-alert">' + icon('alert') + '<span>The bill stays in your history, marked VOID. ' +
      (products ? products + (products === 1 ? ' item goes' : ' items go') + ' back into stock.' : 'No stock to restore (custom items only).') +
      ' This cannot be undone.</span></div>' +
      '<label class="qb-lab" for="qbVoidWhy">Reason <b class="qb-req">*</b></label>' +
      '<select class="input qb-in" id="qbVoidWhy">' + VOID_REASONS.map(function (r) { return '<option>' + esc(r) + '</option>'; }).join('') + '</select>' +
      '<input class="input qb-in" id="qbVoidNote" maxlength="150" autocomplete="off" placeholder="Details (optional)" aria-label="Details" />' +
      '<small class="qb-err" id="qbVoidErr"></small>' +
      '</form>' +
      '<div class="sheet__foot"><button class="btn btn--ghost" data-qb="close-sheet">Keep bill</button>' +
      '<button class="btn qb-btn--danger grow" data-qb="void-go" id="qbVoidGo">' + icon('alert') + 'Void bill</button></div>',
      'Void bill');
  }
  function submitVoid() {
    var sh = S.sheet;
    if (!sh || sh.type !== 'void' || sh.busy) return;
    var why = (el('qbVoidWhy') || {}).value || '';
    var note = String((el('qbVoidNote') || {}).value || '').trim();
    var reason = note ? why + ' — ' + note : why;
    sh.busy = true;
    var btn = el('qbVoidGo'); if (btn) btn.disabled = true;
    API.bill({ action: 'void', billId: sh.id, reason: reason }).then(function (r) {
      sh.busy = false;
      S.billCache[sh.id] = r.bill;
      markFiguresStale(r.bill);
      closeSheet();
      toast(r.bill.number + ' voided · stock restored', 'checkCircle');
      load();
      rerender();
    }, function (e) {
      sh.busy = false;
      if (btn) btn.disabled = false;
      var er = el('qbVoidErr'); if (er) er.textContent = say(e);
    });
  }

  function openPayment(id) {
    var b = S.billCache[id];
    if (!b) return;
    S.sheet = { type: 'payment', id: id, busy: false, method: b.payment.method };
    openSheet('payment',
      '<div class="sheet__grab"></div><div class="sheet__head"><h3 class="t-h3 grow">Record payment · ' + esc(b.number) + '</h3>' +
      '<button class="iconbtn" data-qb="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<form class="sheet__body qb-form" data-qbf="payment" novalidate>' +
      '<p class="qb-sub">Total ' + inr(b.totalPaise) + ' · received so far ' + inr(b.payment.receivedPaise) + '</p>' +
      '<span class="qb-lab">Payment method</span><div class="qb-seg" role="group" aria-label="Payment method">' +
      METHODS.map(function (m) { return '<button type="button" class="' + (m[0] === b.payment.method ? 'is-on' : '') + '" data-qb="pp-method" data-id="' + m[0] + '" aria-pressed="' + (m[0] === b.payment.method) + '">' + m[1] + '</button>'; }).join('') + '</div>' +
      '<label class="qb-lab" for="qbPPRecv">Total amount received now</label>' +
      '<label class="qb-prefix"><span>₹</span><input class="input qb-in" id="qbPPRecv" inputmode="decimal" autocomplete="off" value="' + esc(M.toInput(b.totalPaise)) + '" /></label>' +
      '<small class="qb-err" id="qbPPErr"></small>' +
      '</form>' +
      '<div class="sheet__foot"><button class="btn btn--ghost" data-qb="close-sheet">Cancel</button>' +
      '<button class="btn qb-btn grow" data-qb="pp-go" id="qbPPGo">' + icon('check') + 'Save payment</button></div>',
      'Record payment');
  }
  function submitPayment() {
    var sh = S.sheet;
    if (!sh || sh.type !== 'payment' || sh.busy) return;
    var b = S.billCache[sh.id];
    var v = M.parseRupees(String((el('qbPPRecv') || {}).value || ''));
    var er = el('qbPPErr');
    if (v == null) { if (er) er.textContent = 'Enter the amount received'; return; }
    sh.busy = true;
    var btn = el('qbPPGo'); if (btn) btn.disabled = true;
    API.bill({ action: 'payment', billId: sh.id, payment: { method: sh.method, status: M.statusFor(b.totalPaise, v), receivedPaise: v } }).then(function (r) {
      sh.busy = false;
      S.billCache[sh.id] = r.bill;
      markFiguresStale(r.bill);
      closeSheet();
      toast('Payment saved · ' + label(STATUSES, r.bill.payment.status), 'checkCircle');
      rerender();
    }, function (e) {
      sh.busy = false;
      if (btn) btn.disabled = false;
      if (er) er.textContent = say(e);
    });
  }

  /* ------------------------------------------------- category delete sheet */
  function openCatDelete(id) {
    var c = catById(id);
    if (!c) return;
    var n = S.products.filter(function (p) { return p.categoryId === id; }).length;
    var others = S.categories.filter(function (x) { return x.id !== id; });
    S.sheet = { type: 'catdel', id: id, busy: false };
    openSheet('catdel',
      '<div class="sheet__grab"></div><div class="sheet__head"><h3 class="t-h3 grow">Delete “' + esc(c.name) + '”?</h3>' +
      '<button class="iconbtn" data-qb="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<div class="sheet__body qb-form">' +
      (n
        ? (others.length
          ? '<p>This category has <b>' + n + (n === 1 ? ' product' : ' products') + '</b>. Products are never deleted — choose where to move them first.</p>' +
            '<label class="qb-lab" for="qbCatMove">Move products to <b class="qb-req">*</b></label>' +
            '<select class="input qb-in" id="qbCatMove">' + others.map(function (o) { return '<option value="' + esc(o.id) + '">' + esc(o.name) + '</option>'; }).join('') + '</select>'
          : '<div class="qb-alert">' + icon('alert') + '<span>This is your only category and it has ' + n + (n === 1 ? ' product' : ' products') + '. Create another category to move them to first.</span></div>')
        : '<p>This category has no products. It will be removed.</p>') +
      '<small class="qb-err" id="qbCatDelErr"></small></div>' +
      '<div class="sheet__foot"><button class="btn btn--ghost" data-qb="close-sheet">Cancel</button>' +
      ((n && !others.length) ? '' : '<button class="btn qb-btn--danger grow" data-qb="cat-delete-go" id="qbCatDelGo">' + icon('trash') + (n ? 'Move & delete' : 'Delete category') + '</button>') +
      '</div>', 'Delete category');
  }
  function submitCatDelete() {
    var sh = S.sheet;
    if (!sh || sh.type !== 'catdel' || sh.busy) return;
    var move = el('qbCatMove');
    sh.busy = true;
    var btn = el('qbCatDelGo'); if (btn) btn.disabled = true;
    API.category({ action: 'delete', categoryId: sh.id, moveTo: move ? move.value : undefined }).then(function (r) {
      sh.busy = false;
      S.categories = S.categories.filter(function (c) { return c.id !== r.deleted; });
      if (r.moveTo) S.products.forEach(function (p) { if (p.categoryId === r.deleted) p.categoryId = r.moveTo; });
      if (S.filter.cat === r.deleted) S.filter.cat = 'all';
      if (S.prodFilter.cat === r.deleted) S.prodFilter.cat = 'all';
      closeSheet();
      toast(r.moved ? 'Category deleted · ' + r.moved + ' moved to ' + catName(r.moveTo) : 'Category deleted', 'checkCircle');
      rerender();
    }, function (e) {
      sh.busy = false;
      if (btn) btn.disabled = false;
      var er = el('qbCatDelErr'); if (er) er.textContent = say(e);
    });
  }

  /* -------------------------------------------------------- category sheet */
  function openCatForm(id, name) {
    var c = id ? catById(id) : null;
    S.sheet = { type: 'catform', id: id || null, busy: false, was: c ? compatOn(c) : false };
    var parts = (SM.db && SM.db.categories) || [];
    var position = c ? S.categories.indexOf(c) + 1 : S.categories.length + 1;
    var kinds = [['', 'None'], ['phone', 'Mobile phones'], ['tablet', 'Tablets'], ['watch', 'Smart watches']];
    var on = compatOn(c);
    var part = c && c.compat ? c.compat.partCategory : null;
    openSheet('catform',
      '<div class="sheet__grab"></div><div class="sheet__head"><h3 class="t-h3 grow">' + (c ? 'Edit category' : 'Add category') + '</h3>' +
      '<button class="iconbtn" data-qb="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<form class="sheet__body qb-form" data-qbf="cat-form" novalidate>' +
      fieldHTML('qbCFName', 'cname', 'Name', true, '<input class="input qb-in" id="qbCFName" maxlength="40" autocomplete="off" value="' + esc(c ? c.name : name || '') + '" />') +
      fieldHTML('qbCFDesc', 'cdesc', 'Description', false, '<input class="input qb-in" id="qbCFDesc" maxlength="200" autocomplete="off" placeholder="Optional" value="' + esc(c ? c.description : '') + '" />') +
      (c ? fieldHTML('qbCFOrder', 'corder', 'Display order', false, '<input class="input qb-in" id="qbCFOrder" inputmode="numeric" autocomplete="off" value="' + position + '" />') : '') +
      '<label class="qb-check"><input type="checkbox" id="qbCFOn" data-qbi="cat-compat"' + (on ? ' checked' : '') + ' />Products here are matched to phones by compatibility group</label>' +
      '<div class="qb-ff" id="qbCFPartBox"' + (on ? '' : ' hidden') + ' data-ff="cpart"><label class="qb-lab" for="qbCFPart">Compatibility type <b class="qb-req">*</b></label>' +
      '<select class="input qb-in" id="qbCFPart"><option value="">Choose a type</option>' + parts.map(function (p) {
        return '<option value="' + esc(p.id) + '"' + (p.id === part ? ' selected' : '') + '>' + esc(p.name) + '</option>';
      }).join('') + '</select><small class="qb-err" data-ferr="cpart"></small></div>' +
      '<small class="qb-help" id="qbCFNote">' + (on ? 'Turning this off keeps every link. They apply again if it is turned back on.' : '') + '</small>' +
      '<div class="qb-form__row">' +
      fieldHTML('qbCFKind', 'ckind', 'Device list', false, '<select class="input qb-in" id="qbCFKind">' + kinds.map(function (k) {
        return '<option value="' + k[0] + '"' + ((c && c.deviceKind || '') === k[0] ? ' selected' : '') + '>' + k[1] + '</option>';
      }).join('') + '</select>') +
      fieldHTML('qbCFStatus', 'cstatus', 'Status', false, '<select class="input qb-in" id="qbCFStatus"><option value="active">Active</option><option value="inactive"' + (c && c.status === 'inactive' ? ' selected' : '') + '>Inactive</option></select>') +
      '</div><small class="qb-err" id="qbCFErr"></small>' +
      '<button type="submit" hidden></button></form>' +
      '<div class="sheet__foot"><button class="btn btn--ghost" data-qb="close-sheet">Cancel</button>' +
      '<button class="btn qb-btn grow" data-qb="cat-form-go" id="qbCFGo">' + icon('check') + 'Save category</button></div>',
      c ? 'Edit category' : 'Add category');
  }
  function submitCatForm() {
    var sh = S.sheet;
    if (!sh || sh.type !== 'catform' || sh.busy) return;
    var val = function (id) { var n = el(id); return n ? n.value : ''; };
    var name = val('qbCFName').replace(/\s+/g, ' ').trim();
    var on = !!(el('qbCFOn') && el('qbCFOn').checked);
    var part = val('qbCFPart');
    var orderT = val('qbCFOrder').trim();
    formError('cname', name ? '' : 'Enter a category name');
    formError('cpart', on && !part ? 'Choose what this category is matched by' : '');
    formError('corder', orderT && !/^\d{1,4}$/.test(orderT) ? 'Enter a position, e.g. 3' : '');
    if (!name || (on && !part) || (orderT && !/^\d{1,4}$/.test(orderT))) return;

    var body = {
      action: sh.id ? 'update' : 'create', name: name, description: val('qbCFDesc'),
      compatEnabled: on, partCategory: part || null, deviceKind: val('qbCFKind') || null, status: val('qbCFStatus')
    };
    var moved = false;
    if (sh.id) {
      body.categoryId = sh.id;
      var cur = catById(sh.id);
      moved = orderT && Number(orderT) !== S.categories.indexOf(cur) + 1;
      if (moved) body.order = Math.max(1, Number(orderT));
    }
    sh.busy = true;
    var go2 = el('qbCFGo'); if (go2) go2.disabled = true;
    API.category(body).then(function (r) {
      sh.busy = false;
      upsertCategory(r.category);
      closeSheet();
      toast(sh.id ? 'Category saved' : 'Category “' + r.category.name + '” added', 'checkCircle');
      /* a new position moves the others too, so read them all back */
      if (moved) load().then(rerender); else rerender();
    }, function (e) {
      sh.busy = false;
      if (go2) go2.disabled = false;
      var er = el('qbCFErr'); if (er) er.textContent = say(e);
    });
  }

  /* ---------------------------------------------------- category actions */
  function catRequest(body, okMsg) {
    return API.category(body).then(function (r) {
      if (r.category) upsertCategory(r.category);
      (r.created || []).forEach(upsertCategory);
      if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'checkCircle');
      rerender();
      return r;
    }, function (e) { toast(say(e), 'alert'); throw e; });
  }
  function moveCat(id, dir) {
    var i = -1;
    S.categories.forEach(function (c, k) { if (c.id === id) i = k; });
    var j = i + dir;
    if (i < 0 || j < 0 || j >= S.categories.length) return;
    var list = S.categories.slice();
    var t = list[i]; list[i] = list[j]; list[j] = t;
    list.forEach(function (c, k) { c.order = k + 1; });
    S.categories = list;
    rerender();
    API.category({ action: 'reorder', ids: list.map(function (c) { return c.id; }) }).catch(function (e) {
      toast(say(e), 'alert');
      load();
    });
  }

  /* ================================================================ EVENTS */
  function onClick(e) {
    if (S && S.prodPop && e.target.closest && !e.target.closest('.qb-pop,[data-qb="pop"]')) closePop();
    var t = e.target.closest && e.target.closest('[data-qb]');
    if (!t || !onBilling()) return;
    if (t.disabled || t.getAttribute('aria-disabled') === 'true') {
      if (t.getAttribute('data-qb') === 'add') {
        var px = productById(t.getAttribute('data-id'));
        if (px) addToCart(px, null, compatContext(px));
      }
      return;
    }
    var a = t.getAttribute('data-qb');
    var id = t.getAttribute('data-id');
    var line = id && S.cart ? lineByKey(id) : null;

    switch (a) {
      case 'sign-in': ctx.signIn(); break;
      case 'reload': S.loadError = null; rerender(); break;
      case 'add': {
        var p = productById(id);
        var pickBox = document.querySelector('[data-qbi="pick-qty"][data-id="' + id + '"]');
        var pickNow = pickBox ? Number(pickBox.value) : 1;
        if (p) addToCart(p, null, compatContext(p), pickNow >= 1 ? pickNow : 1);
        break;
      }
      case 'pick-inc': setPick(id, (S.pickQty[id] || 1) + 1); break;
      case 'pick-dec': setPick(id, (S.pickQty[id] || 1) - 1); break;
      case 'cat-more': S.catLimit += 60; paint('qbCatalog', catalogHTML()); break;
      case 'to-cart': { var cb = el('qbBill'); if (cb) cb.scrollIntoView({ block: 'start' }); break; }
      case 'pick-variant': {
        var sv = S.sheet;
        if (!sv || sv.type !== 'variant') break;
        var vp = productById(sv.id);
        var vv = vp && variantOf(vp, id);
        closeSheet();
        if (vv) addToCart(vp, vv, sv.model, sv.qty);
        break;
      }
      case 'pick-model': pickModel(id); break;
      case 'clear-model': clearModel(); break;
      case 'cat': S.filter.cat = id; S.catLimit = 60; paintCatalog(); break;
      case 'qty-inc':
        if (line) {
          var pp = lineStock(line);
          if (pp && pp.used >= pp.qty) { toast('Only ' + pp.qty + ' of “' + pp.name + '” in stock', 'alert'); break; }
          if (line.qty < M.MAX_QTY) line.qty++;
          var qi = document.querySelector('[data-qbi="line-qty"][data-id="' + id + '"]');
          if (qi) qi.value = line.qty;
          cartChanged(false); paintCatalog();
        }
        break;
      case 'qty-dec':
        if (line) {
          if (line.qty <= 1) { removeLine(id); break; }
          line.qty--;
          var qd = document.querySelector('[data-qbi="line-qty"][data-id="' + id + '"]');
          if (qd) qd.value = line.qty;
          cartChanged(false); paintCatalog();
        }
        break;
      case 'remove': removeLine(id); break;
      case 'clear-cart':
        if (!global.confirm('Clear all items from this bill?')) break;
        S.cart.lines = [];
        S.saveError = null;
        cartChanged(true);
        break;
      case 'custom-add': {
        var nm = (el('qbXName') || {}).value || '';
        var pr = (el('qbXPrice') || {}).value || '';
        var qt = String((el('qbXQty') || {}).value || '1').trim();
        var cerr = document.querySelector('[data-err="custom"]');
        nm = nm.replace(/\s+/g, ' ').trim();
        var unit = M.parseRupees(pr);
        var q = /^\d{1,4}$/.test(qt) && Number(qt) > 0 ? Number(qt) : null;
        var msg = !nm ? 'Enter the item name' : unit == null ? 'Enter a price, e.g. 150' : q == null ? 'Enter a quantity' : '';
        if (cerr) cerr.textContent = msg;
        if (msg) break;
        addCustom(nm.slice(0, 80), pr, q);
        ['qbXName', 'qbXPrice'].forEach(function (k) { var n = el(k); if (n) n.value = ''; });
        var xq = el('qbXQty'); if (xq) xq.value = '1';
        var xn = el('qbXName'); if (xn) xn.focus();
        break;
      }
      case 'custom-save':
        if (line) openProductForm('create', null, { name: line.name, price: line.priceText, qty: line.qty, lineKey: line.key });
        break;
      case 'disc-mode':
        S.cart.discount.mode = id;
        Array.prototype.forEach.call(t.parentNode.querySelectorAll('button'), function (b) {
          b.classList.toggle('is-on', b === t); b.setAttribute('aria-pressed', String(b === t));
        });
        cartChanged(false);
        break;
      case 'tax-toggle':
        S.cart.tax.on = !S.cart.tax.on;
        saveCart();
        paint('qbTax', taxHTML(draft()));
        paintDerived();
        if (S.cart.tax.on) { var tr = el('qbTaxRate'); if (tr) tr.focus(); }
        break;
      case 'pay-method':
        S.cart.payment.method = id;
        Array.prototype.forEach.call(t.parentNode.querySelectorAll('button'), function (b) {
          b.classList.toggle('is-on', b === t); b.setAttribute('aria-pressed', String(b === t));
        });
        saveCart(); paintDerived();
        break;
      case 'pay-status': {
        S.cart.payment.status = id;
        var rcv = el('qbRecv');
        if (id !== 'partial') { S.cart.payment.received = ''; if (rcv) rcv.value = ''; }
        saveCart(); paintDerived();
        if (id === 'partial' && rcv) rcv.focus();
        break;
      }
      case 'confirm-bill': saveBill(); break;
      case 'print-saved': { var sb = billById(id); if (sb) printInvoice(sb, S.printSize); break; }
      case 'inv-pdf': { var pb = billById(id); if (pb) downloadInvoice(pb); break; }
      case 'inv-wa': { var wb = billById(id); if (wb) openWhatsApp(wb); break; }
      case 'inv-share': { var hb = billById(id); if (hb) shareInvoice(hb); break; }
      case 'wa-file': shareFile(); break;
      case 'new-bill': newBill(); break;
      case 'labels': {
        var lb = billById(id);
        if (lb) openLabels(labelEntriesFromBill(lb), 'Print Product Labels · ' + lb.number);
        break;
      }
      case 'lbl-layout':
      case 'adj-dir':
      case 'pp-method':
        Array.prototype.forEach.call(t.parentNode.querySelectorAll('button'), function (b) {
          b.classList.toggle('is-on', b === t); b.setAttribute('aria-pressed', String(b === t));
        });
        if (a === 'pp-method' && S.sheet) S.sheet.method = id;
        break;
      case 'lbl-print': printChosenLabels(); break;
      case 'close-sheet': closeSheet(); break;
      case 'review': openReview(); break;
      case 'edit-bill': S.saveError = null; go('/billing'); global.scrollTo(0, 0); break;
      case 'add-product': openProductForm('create'); break;
      case 'edit-product': openProductForm('edit', id); break;
      case 'product-save': submitProduct(id === 'again'); break;
      case 'photo-remove':
        if (S.sheet && S.sheet.type === 'product') { S.sheet.img = null; S.sheet.removeImage = true; resetPhoto(); }
        break;
      case 'fqty-inc': case 'fqty-dec': {
        var fq = el('qbFQty');
        if (fq) {
          var cur = /^\d+$/.test(fq.value.trim()) ? Number(fq.value.trim()) : 0;
          fq.value = Math.max(0, Math.min(999999, cur + (a === 'fqty-inc' ? 1 : -1)));
        }
        break;
      }
      case 'master-pick': {
        var sm = S.sheet, mm = SM.db && SM.db.modelById[id], mc = sm && catById(sm.cat);
        if (!mm || !mc) break;
        sm.master = { id: mm.id, name: mm.fullName, brandId: mm.brandId, kind: mc.deviceKind, image: mm.image || null };
        sm.noMaster = false; sm.masterQ = '';
        var nmb = el('qbFName');
        if (nmb && (!nmb.value.trim() || nmb.value === sm.autoName)) { nmb.value = mm.fullName; sm.autoName = mm.fullName; }
        paint('qbFDevice', deviceHTML());
        if (!sm.img) resetPhoto();
        break;
      }
      case 'master-clear':
        S.sheet.master = null;
        paint('qbFDevice', deviceHTML());
        if (!S.sheet.img) resetPhoto();
        var mq = el('qbFMaster'); if (mq) mq.focus();
        break;
      case 'var-add':
        S.sheet.variants.push(blankVariant());
        paintVariants();
        break;
      case 'var-remove':
        S.sheet.variants.splice(Number(id), 1);
        paintVariants();
        break;
      case 'link-by':
        S.sheet.linkBy = id; S.sheet.linkQ = ''; S.sheet.linkModel = null;
        paint('qbFCompat', compatFormHTML());
        var lq = el('qbFLinkQ'); if (lq) lq.focus();
        break;
      case 'link-model': loadLinkModel(id); break;
      case 'link-model-clear': S.sheet.linkModel = null; paint('qbFLinkHits', linkHitsHTML()); break;
      case 'link-toggle': {
        var gs = S.sheet.groups, gi = gs.indexOf(id);
        if (gi > -1) gs.splice(gi, 1); else gs.push(id);
        paintLinks();
        break;
      }
      case 'link-preview': togglePreview(id); break;
      case 'stock': openStockSheet(id); break;
      case 'of-new': openOfferForm(); break;
      case 'of-edit': closeSheet(); openOfferForm(id); break;
      case 'of-view': openOfferView(id); break;
      case 'of-remove': removeOffer(id); break;
      case 'sales-preset':
        S.sales.preset = id; S.sales.data = null; S.sales.error = null; S.sales.loading = false; S.sales.ticket++;
        paint('qbSales', salesHTML());
        loadSales();
        break;
      case 'sales-retry': loadSales(); break;
      case 'of-settings': openOfferSettings(); break;
      case 'of-settings-go': submitOfferSettings(); break;
      case 'of-save': submitOffer(); break;
      case 'of-tab': S.offerFilter.status = id; rerender(); break;
      case 'of-status': {
        var to = t.getAttribute('data-to');
        var oo = offerById(id);
        if (to === 'expired' && !global.confirm('End “' + (oo && oo.name) + '” now? It stops applying to new bills. Saved bills keep their discount.')) break;
        changeOffer({ action: 'status', offerId: id, status: to }, to === 'paused' ? 'Offer paused' : to === 'active' ? 'Offer activated' : 'Offer ended');
        break;
      }
      case 'of-seg':
        S.sheet[t.getAttribute('data-k')] = id;
        paint('qbOValue', offerValueHTML({}));
        break;
      case 'of-quick': { var ov = el('qbOValueIn'); if (ov) ov.value = id; break; }
      case 'of-target':
        S.sheet.target = id; S.sheet.q = ''; S.sheet.variantProduct = null;
        paint('qbOTarget', offerTargetHTML());
        break;
      case 'of-prod': {
        var ids = S.sheet.productIds, at = ids.indexOf(id);
        if (at > -1) ids.splice(at, 1); else ids.push(id);
        paint('qbOHits', offerHitsHTML());
        paint('qbOChosen', offerChosenHTML());
        break;
      }
      case 'of-var-prod': S.sheet.variantProduct = id; paint('qbOHits', offerHitsHTML()); break;
      case 'of-var-back': S.sheet.variantProduct = null; paint('qbOHits', offerHitsHTML()); break;
      case 'of-drop':
        S.sheet.productIds = S.sheet.productIds.filter(function (x) { return x !== id; });
        S.sheet.variants = S.sheet.variants.filter(function (x) { return x.productId + '|' + x.variantId !== id; });
        paint('qbOHits', offerHitsHTML());
        paint('qbOChosen', offerChosenHTML());
        break;
      case 'line-offers': openLineOffers(id); break;
      case 'line-cancel':
        if (line) { line.offerPick = 'none'; cartChanged(false); }
        break;
      case 'line-restore':
        if (line) restoreOffer(line);
        break;
      case 'line-price-edit': {
        S.priceEdit[id] = true;
        paintDerived();
        var pin = document.querySelector('[data-qbi="line-price"][data-id="' + id + '"]');
        if (pin) pin.focus();
        break;
      }
      case 'line-pick': {
        var lp = S.sheet && S.sheet.key ? lineByKey(S.sheet.key) : null;
        if (lp) { lp.offerPick = id || null; closeSheet(); cartChanged(false); }
        break;
      }
      case 'pop': openPop(id); break;
      case 'pv': setProductView(id); break;
      case 'pv-rows': S.prodOpen[id] = !S.prodOpen[id]; paintProductList(); break;
      case 'prod-more': S.prodLimit += PRODUCT_PAGE; paintProductList(); break;
      case 'pq-clear': {
        S.prodFilter.q = '';
        var pq = el('qbProdQ');
        if (pq) { pq.value = ''; pq.focus(); }
        t.hidden = true;
        filterChanged();
        break;
      }
      case 'pf-clear': case 'pf-reset': {
        var kept = S.prodFilter.q;
        S.prodFilter = a === 'pf-clear' ? PF.clearedFilter() : PF.blankFilter();
        if (a === 'pf-clear') S.prodFilter.q = kept;
        var sq = el('qbProdQ'), sc = el('qbProdClear');
        if (sq) sq.value = S.prodFilter.q;
        if (sc) sc.hidden = !S.prodFilter.q;
        if (S.prodPop) paintPops();
        filterChanged();
        break;
      }
      case 'pc-reset':
        S.prodCols = PF.defaultColumns();
        store('mpf.qb.columns', null);
        paintPops();
        paintProductList();
        break;
      case 'qty-edit': startStockEdit(id, t.getAttribute('data-vid') || ''); break;
      case 'qty-cancel': endStockEdit(); break;
      case 'bills-more': loadBills(false); break;
      case 'bills-retry': loadBills(true); break;
      case 'record-payment': openPayment(id); break;
      case 'pp-go': submitPayment(); break;
      case 'void': openVoid(id); break;
      case 'void-go': submitVoid(); break;
      case 'bills-filter': openBillFilter(); break;
      case 'bills-reset': case 'bf-reset': resetBillFilter(); break;
      case 'bf-go': applyBillFilter(); break;
      case 'bf-date': S.sheet.period = id; paint('qbBFBody', billFilterBodyHTML()); break;
      case 'bf-status': S.sheet.status = id; paint('qbBFBody', billFilterBodyHTML()); break;
      case 'cat-suggest-all': catRequest({ action: 'suggested' }, function (r) { return r.created.length ? r.created.length + ' categories added' : 'You already have them all'; }); break;
      case 'cat-suggest': catRequest({ action: 'suggested', names: [id] }, 'Category added'); break;
      case 'cat-edit': openCatForm(id); break;
      case 'cat-form-go': submitCatForm(); break;
      case 'cat-links': showProducts({ cat: id, compat: 'none' }); break;
      case 'cat-up': moveCat(id, -1); break;
      case 'cat-down': moveCat(id, 1); break;
      case 'cat-delete': openCatDelete(id); break;
      case 'cat-delete-go': submitCatDelete(); break;
      case 'cat-view': showProducts({ cat: id }); break;
      case 'cust-new': openCustomerForm(); break;
      case 'cust-edit': openCustomerForm(id); break;
      case 'cust-go': submitCustomer(); break;
      case 'cust-more': loadCustomers(false); break;
      case 'cust-retry': loadCustomers(true); break;
      case 'cust-filter': {
        var cf = S.customers;
        cf.filter = id; cf.since = 0; cf.range = ''; cf.q = ''; cf.loaded = false;
        rerender();
        break;
      }
      case 'cust-pick': {
        var hit = (S.custHits || []).filter(function (x) { return x.id === id; })[0];
        if (!hit) break;
        Object.assign(S.cart.customer, {
          id: hit.id, name: hit.name, mobile: hit.mobile, whatsapp: hit.whatsapp || '', address: hit.address || '', gstin: hit.gstin || ''
        });
        S.custPicked = hit;
        S.custHits = [];
        paint('qbCustSec', customerSecHTML());
        cartChanged(false);
        break;
      }
      case 'cust-clear':
        Object.assign(S.cart.customer, { id: '', name: '', mobile: '', whatsapp: '', address: '', gstin: '' });
        S.custPicked = null;
        paint('qbCustSec', customerSecHTML());
        cartChanged(false);
        var cn = el('qbCName'); if (cn) cn.focus();
        break;
      case 'over-preset': S.overview.preset = id; S.overview.data = null; S.overview.error = null; rerender(); break;
      case 'over-retry': loadOverview(); break;
      case 'over-grain': S.overview.trend = id; paint('qbOverBody', overviewBodyHTML()); break;
      case 'drill': drill(id); break;
    }
  }

  function removeLine(key) {
    S.cart.lines = S.cart.lines.filter(function (l) { return l.key !== key; });
    S.saveError = null;
    cartChanged(true);
  }

  /* Back to what the rules give the line. If they give it nothing, because this
     offer does not apply itself, the offer that was usable is chosen for it. */
  function restoreOffer(l) {
    l.offerPick = null;
    var r = draft().offers.lines[S.cart.lines.indexOf(l)];
    if (!r.applied.length) {
      var open = r.options.filter(function (o) { return o.state === 'available'; })[0];
      if (open) l.offerPick = open.id;
    }
    cartChanged(false);
  }

  var billSearchTimer = null;
  function onInput(e) {
    var t = e.target;
    /* a field flagged by validation clears as soon as it is corrected */
    var ff = t.closest && t.closest('.qb-ff.is-bad');
    if (ff) formError(ff.getAttribute('data-ff'), '');
    var k = t.getAttribute && t.getAttribute('data-qbi');
    if (!k || !onBilling()) return;
    var c = S.cart;
    switch (k) {
      case 'q':
        S.filter.q = t.value.trim();
        S.catLimit = 60;
        if (S.compat && S.compat.q !== S.filter.q) S.compat = null;
        paint('qbCatalog', catalogHTML());
        clearTimeout(modelHitTimer);
        modelHitTimer = setTimeout(modelSearchSettled, 280);
        break;
      case 'pick-qty': {
        var want = t.value.trim();
        if (/^\d{1,4}$/.test(want) && Number(want) >= 1) S.pickQty[t.getAttribute('data-id')] = Math.min(Number(want), pickRoom(t.getAttribute('data-id')));
        break;
      }
      case 'cwhats': c.customer.whatsapp = t.value; cartChanged(false); break;
      case 'caddr': c.customer.address = t.value; cartChanged(false); break;
      case 'cgstin': c.customer.gstin = t.value.toUpperCase(); cartChanged(false); break;
      case 'wa-to':
        if (S.sheet) { S.sheet.to = t.value; paint('qbWaFoot', waFootHTML()); }
        break;
      case 'wa-text':
        if (S.sheet) { S.sheet.text = t.value; var go1 = el('qbWaGo'); if (go1 && !go1.classList.contains('is-off')) go1.href = waHref(); }
        break;
      case 'line-qty': {
        var l = lineByKey(t.getAttribute('data-id'));
        var v = t.value.trim();
        if (l && /^\d{1,4}$/.test(v) && Number(v) >= 1) { l.qty = Number(v); cartChanged(false); }
        break;
      }
      case 'line-price': {
        var lp = lineByKey(t.getAttribute('data-id'));
        if (lp) { lp.priceText = t.value; lp.unitPaise = M.parseRupees(t.value); cartChanged(false); }
        break;
      }
      case 'disc': c.discount.text = t.value; cartChanged(false); break;
      case 'tax-rate': c.tax.rate = t.value; cartChanged(false); break;
      case 'tax-label': c.tax.label = t.value; cartChanged(false); break;
      case 'cname': c.customer.name = t.value; cartChanged(false); searchCustomers(t.value); break;
      case 'cmobile': c.customer.mobile = t.value; cartChanged(false); searchCustomers(t.value); break;
      case 'cnotes': c.customer.notes = t.value; cartChanged(false); break;
      case 'recv': {
        c.payment.received = t.value;
        var rv = M.parseRupees(t.value);
        if (t.value.trim() && rv != null) c.payment.status = M.statusFor(draft().totals.totalPaise, rv);
        cartChanged(false);
        break;
      }
      case 'bills-q':
        S.bills.q = t.value.trim();
        clearTimeout(billSearchTimer);
        billSearchTimer = setTimeout(function () { loadBills(true); }, 350);
        break;
      case 'prod-q': {
        S.prodFilter.q = t.value.trim();
        var pc = el('qbProdClear');
        if (pc) pc.hidden = !t.value;
        clearTimeout(billSearchTimer);
        billSearchTimer = setTimeout(filterChanged, 150);
        break;
      }
      case 'bf-from': if (S.sheet) S.sheet.from = t.value; break;
      case 'bf-to': if (S.sheet) S.sheet.to = t.value; break;
      case 'of-search':
        S.offerFilter.q = t.value.trim();
        clearTimeout(billSearchTimer);
        billSearchTimer = setTimeout(function () { paint('qbOfferList', offerListHTML()); }, 150);
        break;
      case 'of-find':
        if (S.sheet) { S.sheet.q = t.value.trim(); S.sheet.variantProduct = null; paint('qbOHits', offerHitsHTML()); }
        break;
      case 'pf-price':
        S.prodFilter[t.getAttribute('data-k')] = t.value;
        clearTimeout(billSearchTimer);
        billSearchTimer = setTimeout(filterChanged, 250);
        break;
      case 'qty-edit':
        if (S.stockEdit) { S.stockEdit.value = t.value; S.stockEdit.error = ''; }
        break;
      case 'cust-q':
        S.customers.q = t.value.trim();
        clearTimeout(billSearchTimer);
        billSearchTimer = setTimeout(function () { loadCustomers(true); }, 350);
        break;
      case 'master-q':
        if (S.sheet) { S.sheet.masterQ = t.value.trim(); paint('qbFMasterHits', masterHitsHTML()); }
        break;
      case 'link-q':
        if (S.sheet) { S.sheet.linkQ = t.value.trim(); S.sheet.linkModel = null; paint('qbFLinkHits', linkHitsHTML()); }
        break;
      case 'var': {
        var row = S.sheet && S.sheet.variants[Number(t.getAttribute('data-i'))];
        if (row) row[t.getAttribute('data-k')] = t.value;
        break;
      }
    }
  }

  function onChange(e) {
    var t = e.target;
    var k = t.getAttribute && t.getAttribute('data-qbi');
    if (!k || !onBilling()) return;
    switch (k) {
      case 'pick-qty': setPick(t.getAttribute('data-id'), S.pickQty[t.getAttribute('data-id')] || 1); break;
      case 'line-qty': {
        /* on leaving the field, an unreadable quantity goes back to what it was */
        var l = lineByKey(t.getAttribute('data-id'));
        if (l) t.value = l.qty;
        var p = l && lineStock(l);
        if (p && p.used > p.qty) toast('Only ' + p.qty + ' of “' + p.name + '” in stock', 'alert');
        paint('qbLines', linesHTML(draft()));
        paintCatalog();
        break;
      }
      case 'line-price': {
        var lp = lineByKey(t.getAttribute('data-id'));
        if (lp && lp.unitPaise != null) { lp.priceText = M.toInput(lp.unitPaise); t.value = lp.priceText; saveCart(); }
        break;
      }
      case 'tax-incl': S.cart.tax.inclusive = t.checked; cartChanged(false); break;
      case 'size': S.printSize = t.value; store('mpf.qb.size', t.value);
        Array.prototype.forEach.call(document.querySelectorAll('[data-qbi="size"]'), function (s) { s.value = t.value; });
        break;
      case 'fcat': {
        var box = el('qbFNewCat');
        if (box) { box.hidden = t.value !== '__new'; if (!box.hidden) box.focus(); }
        if (S.sheet && S.sheet.type === 'product') productCategoryChanged(t.value);
        break;
      }
      case 'no-master':
        if (S.sheet) { S.sheet.noMaster = t.checked; formError('device', ''); }
        break;
      case 'use-variants': {
        var fs = S.sheet;
        if (!fs) break;
        fs.useVariants = t.checked;
        if (t.checked && !fs.variants.length) fs.variants.push(blankVariant((el('qbFPrice') || {}).value, (el('qbFQty') || {}).value));
        paintVariants();
        break;
      }
      case 'cat-compat': {
        var pb = el('qbCFPartBox'), nt = el('qbCFNote'), cs = S.sheet;
        if (pb) pb.hidden = !t.checked;
        if (nt && cs) {
          var idle = cs.id ? S.products.filter(function (x) { return x.active && x.categoryId === cs.id && !(x.groupIds && x.groupIds.length); }).length : 0;
          nt.textContent = t.checked
            ? (idle ? idle + (idle === 1 ? ' product here has' : ' products here have') + ' no groups yet. After saving, use the link on this category to add them.' : '')
            : 'Turning this off keeps every link. They apply again if it is turned back on.';
        }
        break;
      }
      case 'over-range': {
        var ov = S.overview;
        ov.from = (el('qbOverFrom') || {}).value || '';
        ov.to = (el('qbOverTo') || {}).value || '';
        if (ov.from && ov.to && ov.from > ov.to) { var sw = ov.from; ov.from = ov.to; ov.to = sw; rerender(); break; }
        loadOverview();
        break;
      }
      case 'sales-range': {
        var sr = S.sales;
        sr.from = (el('qbSalesFrom') || {}).value || '';
        sr.to = (el('qbSalesTo') || {}).value || '';
        if (sr.from && sr.to && sr.from > sr.to) { var st = sr.from; sr.from = sr.to; sr.to = st; }
        paint('qbSales', salesHTML());
        loadSales();
        break;
      }
      case 'hist-range': {
        var ch = S.customerCache[params[1]];
        if (ch) paint('qbCustHist', historyHTML(ch.bills, (el('qbHistFrom') || {}).value || '', (el('qbHistTo') || {}).value || ''));
        break;
      }
      case 'photo': onPhotoPicked(t); break;
      case 'bill-auto':
        /* this bill only: the shop's setting and each offer's stay as they are */
        S.cart.autoOffers = t.checked;
        cartChanged(false);
        break;
      case 'of-auto':
        changeOffer({ action: 'auto', offerId: t.getAttribute('data-id'), autoApply: t.checked }, t.checked ? 'Auto Apply on' : 'Auto Apply off');
        break;
      case 'of-cat': {
        var cats = S.sheet.categoryIds, cid = t.getAttribute('data-id'), ci = cats.indexOf(cid);
        if (t.checked && ci < 0) cats.push(cid);
        if (!t.checked && ci > -1) cats.splice(ci, 1);
        break;
      }
      case 'of-var': {
        var sh = S.sheet, vid = t.getAttribute('data-id');
        sh.variants = sh.variants.filter(function (x) { return !(x.productId === sh.variantProduct && x.variantId === vid); });
        if (t.checked) sh.variants.push({ productId: sh.variantProduct, variantId: vid });
        paint('qbOChosen', offerChosenHTML());
        break;
      }
      case 'pf': S.prodFilter[t.getAttribute('data-k')] = t.value; filterChanged(); break;
      case 'pc':
        S.prodCols[t.getAttribute('data-k')] = t.checked;
        store('mpf.qb.columns', JSON.stringify(S.prodCols));
        paintProductList();
        break;
    }
  }

  function onSubmit(e) {
    var f = e.target;
    var k = f.getAttribute && f.getAttribute('data-qbf');
    if (!k || !onBilling()) return;
    e.preventDefault();
    if (k === 'product') submitProduct(false);
    else if (k === 'adjust') submitAdjust();
    else if (k === 'void') submitVoid();
    else if (k === 'payment') submitPayment();
    else if (k === 'customer') submitCustomer();
    else if (k === 'qty') saveStockEdit();
    else if (k === 'offer') submitOffer();
    else if (k === 'offer-settings') submitOfferSettings();
    else if (k === 'cat-form') submitCatForm();
    else if (k === 'cat-new') {
      var n = el('qbNewCat');
      var name = n ? n.value.replace(/\s+/g, ' ').trim() : '';
      if (!name) { if (n) n.focus(); return; }
      openCatForm(null, name);
    }
  }

  function onKey(e) {
    if (!onBilling()) return;
    if (e.key === 'Escape' && S.sheet) { closeSheet(); return; }
    if (e.key === 'Escape' && S.prodPop) { closePop(); return; }
    if (e.key === 'Escape' && S.stockEdit && !S.stockEdit.busy) { endStockEdit(); return; }
    /* Enter in the custom-item row adds it, rather than doing nothing */
    if (e.key === 'Enter' && e.target && /^qbX(Name|Price|Qty)$/.test(e.target.id || '')) {
      e.preventDefault();
      var b = document.querySelector('[data-qb="custom-add"]');
      if (b) b.click();
    }
  }

  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('keydown', onKey);
  setInterval(function () {
    if (!S || !S.loaded || !onBilling()) return;
    var key = activeOfferKey();
    if (key === S.offerKey) return;
    S.offerKey = key;
    if (viewName() === 'offers') rerender();
    else if ((viewName() === 'pos' || viewName() === 'review') && S.cart.lines.length) cartChanged(false);
  }, 30000);
  /* A window dragged across the line, or a tablet turned: the bill stays, in the
     shape that now fits. */
  WIDE.addEventListener('change', function () {
    if (!S || !S.loaded || !onBilling()) return;
    var v = viewName();
    if (v !== 'pos' && v !== 'review') return;
    if (S.lastSaved && !wide()) { ctx.replace('/billing/invoice/' + encodeURIComponent(S.lastSaved.id)); return; }
    rerender();
  });
  ['mouseover', 'focusin'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      var b = e.target.closest && e.target.closest('.qb-bar');
      if (b) barTip(b);
    });
  });
  ['mouseout', 'focusout'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      var b = e.target.closest && e.target.closest('.qb-bar');
      if (b) barTipOff(b);
    });
  });
  SM.quickBilling = {
    render: render,
    /* exposed for the console and for tests, not for the app */
    _state: function () { return S; },
    _invoiceHTML: invoiceHTML
  };
})(window);
