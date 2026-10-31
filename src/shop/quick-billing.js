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
     /billing                   the counter: products, the bill, the summary
     /billing/review            the full-screen bill preview (phones)
     /billing/bills             saved bills: search, history
     /billing/bills/<id>        one saved bill: reprint, labels, payment, void
     /billing/products          stock: edit, adjust, archive, low stock
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
  var SM = global.SM, C = SM.C, icon = SM.icon, M = SM.shopMoney, API = SM.shopApi;
  var esc = C.esc, inr = M.inr;

  var DESK_MQ = global.matchMedia ? global.matchMedia('(min-width: 1100px)') : null;
  function isDesk() { return !!(DESK_MQ && DESK_MQ.matches); }

  var METHODS = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['other', 'Other']];
  var STATUSES = [['unpaid', 'Unpaid'], ['partial', 'Partially Paid'], ['paid', 'Paid']];
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
  function reset(uid) {
    S = {
      uid: uid || null,
      loaded: false, loading: null, loadError: null,
      categories: [], products: [], suggested: [], billCount: 0,
      filter: { cat: 'all', q: '' },
      cart: null, saving: false, saveError: null, lastSaved: null,
      bills: { items: [], cursor: null, q: '', from: 0, to: 0, range: '', loading: false, loaded: false, error: null, ticket: 0 },
      prodFilter: { q: '', cat: 'all', show: 'active' },
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

  var ctx = null;          /* app.js: { go, toast, signIn, routeName, page } */
  var params = [];

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
      customer: { id: '', name: '', mobile: '', notes: '' },
      payment: { method: 'cash', status: 'paid', received: '' }
    };
  }
  function cartKey() { return 'mpf.qb.cart.' + S.uid; }
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
          customer: Object.assign(e.customer, c.customer),
          payment: Object.assign(e.payment, c.payment)
        };
      }
    } catch (err) { /* a corrupt draft is replaced, not trusted */ }
    return emptyCart();
  }
  function saveCart() { if (S.uid && S.cart) store(cartKey(), JSON.stringify(S.cart)); }
  function lineByKey(k) { for (var i = 0; i < S.cart.lines.length; i++) if (S.cart.lines[i].key === k) return S.cart.lines[i]; return null; }

  /**
   * Puts a product on the bill. `v` is the variant; `model` is the phone the
   * customer asked about, when the product was found through compatibility. The
   * model is a note on the line: the stock that moves is always this product's.
   */
  function addToCart(p, v, model) {
    if (hasVariants(p) && !v) { openVariantPicker(p, model); return; }
    var stock = v ? v.qty : p.qty;
    var used = v ? inCart(p.id, v.id) : inCart(p.id);
    var title = v ? p.name + ' (' + variantLabel(v) + ')' : p.name;
    if (stock - used <= 0) { toast(stock <= 0 ? '“' + title + '” is out of stock' : 'All ' + stock + ' in stock are already on the bill', 'alert'); return; }
    var vid = v ? v.id : null;
    var mid = model ? model.id : null;
    var line = null;
    S.cart.lines.forEach(function (l) {
      if (!line && l.productId === p.id && (l.variantId || null) === vid && (l.modelId || null) === mid) line = l;
    });
    if (line) line.qty += 1;
    else {
      var price = v ? v.pricePaise : p.pricePaise;
      S.cart.lines.push({
        key: API.newId('l'), productId: p.id, variantId: vid, variantLabel: v ? variantLabel(v) : '',
        name: p.name, shelf: (v && v.shelf) || p.shelf || '', sku: (v && v.sku) || p.sku || '',
        unitPaise: price, priceText: M.toInput(price), qty: 1,
        modelId: mid, modelName: model ? model.name : '', groupId: model ? model.groupId || null : null
      });
    }
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
  function draft() {
    var c = S.cart;
    var lines = c.lines.map(function (l) { return { unitPaise: l.unitPaise == null ? 0 : l.unitPaise, qty: l.qty }; });
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
    var ok = c.lines.length > 0 && Object.keys(errors).length === 0;
    return { totals: totals, pay: pay, discount: discount, tax: tax, received: rv || 0, errors: errors, ok: ok };
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

  function draftBill(d) {
    var c = S.cart;
    d = d || draft();
    return {
      number: null, status: 'draft', createdAt: Date.now(),
      items: c.lines.map(function (l, i) {
        var u = l.unitPaise == null ? 0 : l.unitPaise;
        return {
          lineNo: i + 1, name: l.name, variantLabel: l.variantLabel || '', selectedModelName: l.modelName || '',
          shelf: l.shelf, sku: l.sku, custom: !l.productId, unitPaise: u, qty: l.qty, totalPaise: u * l.qty
        };
      }),
      subtotalPaise: d.totals.subtotalPaise, discount: d.discount, discountPaise: d.totals.discountPaise,
      tax: c.tax.on ? d.tax : { rateBp: 0 }, taxPaise: d.totals.taxPaise, totalPaise: d.totals.totalPaise,
      payment: { method: c.payment.method, status: d.pay.status, receivedPaise: d.pay.receivedPaise,
        balancePaise: d.pay.balancePaise, changePaise: d.pay.changePaise },
      customer: c.customer
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
      payment: { method: c.payment.method, status: c.payment.status, receivedPaise: d.received },
      customer: { id: c.customer.id || undefined, name: c.customer.name, mobile: c.customer.mobile, notes: c.customer.notes }
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
      mobile: p.mobile || p.mobileNumber || ''
    };
  }
  function when(ms) {
    try {
      return new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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
      (shop.mobile ? '<span>Mobile: ' + esc(shop.mobile) + '</span>' : '') + '</div>' +
      '<div class="inv__meta"><b>' + (b.number ? 'INVOICE' : 'BILL PREVIEW') + '</b>' +
      '<span>' + (b.number ? 'No. ' + esc(b.number) : 'Not saved yet') + '</span>' +
      '<span>' + esc(when(b.createdAt || Date.now())) + '</span></div>' +
      '</header>';
    var cust = b.customer || {};
    var to = (cust.name || cust.mobile || cust.notes)
      ? '<div class="inv__to"><span class="inv__lab">Bill to</span>' +
        (cust.name ? '<b>' + esc(cust.name) + '</b>' : '') +
        (cust.mobile ? '<span>' + esc(cust.mobile) + '</span>' : '') +
        (cust.notes ? '<span class="inv__note">' + esc(cust.notes) + '</span>' : '') + '</div>'
      : '';

    var rows = (b.items || []).map(function (it, i) {
      var meta = [it.shelf ? 'Shelf ' + it.shelf : '', it.sku || ''].filter(Boolean).join(' · ');
      var title = it.name + (it.variantLabel ? ' (' + it.variantLabel + ')' : '');
      var fits = it.selectedModelName ? '<span class="inv__dim">For ' + esc(it.selectedModelName) + '</span>' : '';
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
    var totals = '<div class="inv__totals">' +
      t('Subtotal', M.format(b.subtotalPaise || 0)) +
      (b.discountPaise ? t('Discount' + (b.discount && b.discount.mode === 'percent' ? ' (' + pct(b.discount.value) + ')' : ''), '−' + M.format(b.discountPaise)) : '') +
      (tax.rateBp ? t(esc(tax.label || 'Tax') + ' ' + pct(tax.rateBp) + (tax.inclusive ? ' (incl.)' : ''), (tax.inclusive ? '' : '+') + M.format(b.taxPaise || 0)) : '') +
      t('Total', inr(b.totalPaise || 0), 'inv__grand') +
      (pay.receivedPaise ? t('Received (' + esc(label(METHODS, pay.method)) + ')', M.format(pay.receivedPaise)) : '') +
      (pay.balancePaise ? t('Balance due', M.format(pay.balancePaise), 'inv__due') : '') +
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
        action: '<button class="btn qb-btn" data-qb="sign-in">' + icon('user') + 'Sign in</button>'
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
    if (p === 'review' || p === 'products' || p === 'categories' || p === 'overview') return p;
    return 'pos';
  }

  function renderView(page) {
    var v = viewName();
    if (v === 'pos') return renderPos(page);
    if (v === 'review') return renderReview(page);
    if (v === 'bills') return renderBills(page);
    if (v === 'bill') return renderBillView(page, params[1]);
    if (v === 'products') return renderProducts(page);
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
      paintCartBar();
      /* fresh stock can change which lines are over it — but a line being
         typed in is left alone */
      var lines = el('qbLines');
      if (lines && !lines.contains(document.activeElement)) paint('qbLines', linesHTML(draft()));
    }
    else if (v === 'products') paintProductList();
    else if (v === 'categories') rerender();
  }

  function skeleton() {
    return '<div class="shell qb-skel">' + C.skelRows(6) + '</div>';
  }

  /** The page frame every billing screen shares: title, sub-navigation, actions. */
  function frame(view, inner, extraCls) {
    var tab = function (id, href, text, ic) {
      var on = view === id || (id === 'bills' && view === 'bill') || (id === 'pos' && view === 'review') ||
        (id === 'customers' && view === 'customer');
      return '<a class="qb-tab' + (on ? ' is-on' : '') + '" href="' + href + '"' + (on ? ' aria-current="page"' : '') + '>' +
        icon(ic) + '<span>' + text + '</span></a>';
    };
    return '<div class="qb qb--' + view + (extraCls ? ' ' + extraCls : '') + '" id="qb">' +
      '<div class="qb-head"><div class="qb-head__in">' +
      '<div class="qb-title"><span class="qb-title__ico">' + icon('receipt') + '</span>' +
      '<div><h1>Quick Billing</h1><p>Your shop’s own stock, bills and customers</p></div></div>' +
      '<nav class="qb-tabs" aria-label="Quick Billing">' +
      tab('pos', '/billing', 'New Bill', 'receipt') +
      tab('bills', '/billing/bills', 'Bills', 'history') +
      tab('products', '/billing/products', 'Products', 'box') +
      tab('categories', '/billing/categories', 'Categories', 'layers') +
      tab('customers', '/billing/customers', 'Customers', 'user') +
      tab('overview', '/billing/overview', 'Overview', 'chart') +
      '</nav>' +
      '<button class="btn qb-btn btn--sm qb-head__add" data-qb="add-product" aria-label="Add product">' + icon('plus') + '<span>Add product</span></button>' +
      '</div></div>' +
      inner + '</div>';
  }

  /* ============================================================ POS (counter) */
  function renderPos(page) {
    var desk = isDesk();
    page.innerHTML = frame('pos',
      '<div class="qb-pos">' +
      '<section class="qb-pane qb-pane--cat" aria-label="Products">' + catalogPaneHTML() + '</section>' +
      (desk
        ? '<section class="qb-pane qb-pane--bill" aria-label="Bill" id="qbBill">' + billEditorHTML() + '</section>' +
          '<aside class="qb-pane qb-pane--sum" aria-label="Invoice and payment" id="qbSum">' + summaryHTML() + '</aside>'
        : '') +
      '</div>' +
      (desk ? '' : '<div class="qb-cartbar" id="qbCartBar">' + cartBarHTML() + '</div>'),
      desk ? 'qb--desk' : 'qb--mobile');
    if (!desk && S.openCart) { S.openCart = false; openCartSheet(); }
  }

  function catalogPaneHTML() {
    var none = !S.products.length;
    return '<div class="qb-find">' +
      '<label class="qb-search">' + icon('search') +
      '<input id="qbQ" type="search" autocomplete="off" placeholder="Search a phone model, product or SKU…" ' +
      'value="' + esc(S.filter.q) + '" aria-label="Search your products or a phone model" data-qbi="q" /></label>' +
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
      S.categories.map(function (c) { return chip(c.id, c.name, counts[c.id] || 0); }).join('');
  }

  function frequentProducts() {
    return activeProducts().filter(function (p) { return p.soldCount > 0; })
      .sort(function (a, b) { return b.soldCount - a.soldCount; }).slice(0, 8);
  }

  function matches(p, q) {
    if (!q) return true;
    var hay = (p.name + ' ' + (p.shelf || '') + ' ' + (p.sku || '') + ' ' + catName(p.categoryId) + ' ' +
      (p.master ? p.master.name : '') + ' ' +
      (p.variants || []).map(function (v) { return variantLabel(v) + ' ' + (v.sku || ''); }).join(' ')).toLowerCase();
    return q.toLowerCase().split(/\s+/).every(function (w) { return hay.indexOf(w) > -1; });
  }

  function catalogHTML() {
    if (S.compat) return compatHTML();
    if (!S.products.length) return setupHTML();
    var f = S.filter;
    var list = f.cat === 'frequent' ? frequentProducts() : activeProducts().filter(function (p) {
      return f.cat === 'all' || p.categoryId === f.cat;
    });
    list = list.filter(function (p) { return matches(p, f.q); });
    if (f.cat !== 'frequent') list.sort(function (a, b) { return a.name.localeCompare(b.name); });

    var freq = (f.cat === 'all' && !f.q && isDesk()) ? frequentProducts().slice(0, 6) : [];
    var freqHTML = freq.length
      ? '<div class="qb-freq"><span class="t-lab">Frequently used</span><div class="qb-freq__row">' +
        freq.map(function (p) {
          return '<button class="qb-fchip" data-qb="add" data-id="' + esc(p.id) + '"' + (p.qty - inCart(p.id) <= 0 ? ' disabled' : '') + '>' +
            '<b>' + esc(p.name) + '</b><span>' + inr(p.pricePaise) + '</span></button>';
        }).join('') + '</div></div>'
      : '';

    if (!list.length) {
      return freqHTML + '<div class="qb-empty">' + icon('search') +
        '<p>' + (f.q ? 'No product matches “' + esc(f.q) + '”.' : 'No products in this category yet.') + '</p>' +
        '<button class="btn btn--outline btn--sm" data-qb="add-product">' + icon('plus') + 'Add product</button></div>';
    }
    return freqHTML + '<div class="qb-grid">' + list.map(function (p) { return cardHTML(p); }).join('') + '</div>';
  }

  function thumbHTML(p, cls) {
    var url = p.imageUrl || (p.master && p.master.image) || '';
    if (url) return '<span class="qb-thumb ' + (cls || '') + '"><img src="' + esc(url) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" /></span>';
    var letters = String(p.name || '?').split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase();
    return '<span class="qb-thumb qb-thumb--none ' + (cls || '') + '" aria-hidden="true">' + esc(letters) + '</span>';
  }

  function cardHTML(p, fits) {
    var used = inCart(p.id);
    var left = p.qty - used;
    var st = stockState(p);
    var from = hasVariants(p) && p.variants.length > 1;
    return '<button class="qb-card' + (used ? ' is-in' : '') + '" data-qb="add" data-id="' + esc(p.id) + '"' +
      (left <= 0 ? ' aria-disabled="true"' : '') + ' aria-label="Add ' + esc(p.name) + ' to the bill">' +
      thumbHTML(p) +
      '<span class="qb-card__name">' + esc(p.name) + '</span>' +
      (fits ? '<span class="qb-card__fits">Fits ' + esc(fits) + '</span>' : '') +
      '<span class="qb-card__price">' + (from ? 'From ' : '') + inr(p.pricePaise) + '</span>' +
      '<span class="qb-card__meta">' +
      '<span class="qb-stock qb-stock--' + st + '">' + (p.qty <= 0 ? 'Out of stock' : p.qty + ' in stock') + '</span>' +
      (hasVariants(p) ? '<span class="qb-shelf">' + p.variants.length + (p.variants.length === 1 ? ' variant' : ' variants') + '</span>'
        : p.shelf ? '<span class="qb-shelf">' + icon('tag') + esc(p.shelf) + '</span>' : '') + '</span>' +
      (used ? '<span class="qb-card__in" aria-label="' + used + ' on the bill">' + used + '</span>' : '') +
      '</button>';
  }

  /* ----------------------------------------------- finding stock by phone

     The search box takes a phone model as well as a product. Picking one asks
     the server which of this shop's products are linked to a group that phone
     is in, so the answer can only ever be real links, never a similar name. */
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
    if (S.compat || q.length < 2) return '';
    var hits = modelMatches(q, null, 6);
    if (!hits.length) return '';
    return '<span class="qb-mhits__l">Find stock that fits</span>' + hits.map(function (m) {
      return '<button class="qb-mhit" data-qb="pick-model" data-id="' + esc(m.id) + '">' + esc(m.fullName) + '</button>';
    }).join('');
  }
  function paintModelHits() { paint('qbModelHits', modelHitsHTML()); }

  function pickModel(id) {
    var m = SM.db && SM.db.modelById[id];
    if (!m) return;
    var uid = S.uid;
    S.compat = { id: id, name: m.fullName, loading: true, error: null, matches: [], groupCount: 0 };
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
  /** What a card tap means while a phone is selected, or null for a plain sale. */
  function compatContext(p) {
    var c = S.compat;
    if (!c) return null;
    var hit = c.matches.filter(function (m) { return m.productId === p.id; })[0];
    return hit ? { id: c.id, name: c.name, groupId: hit.groupId } : null;
  }

  function compatHTML() {
    var c = S.compat;
    var banner = '<div class="qb-compatbar" role="status"><span class="qb-compatbar__l">Selected model</span>' +
      '<b>' + esc(c.name) + '</b>' +
      '<button class="qb-link" data-qb="clear-model">' + icon('close') + 'Clear</button></div>';
    if (c.loading) return banner + C.skelRows(3);
    if (c.error) {
      return banner + C.state({ icon: 'alert', title: 'Could not check compatibility', text: say(c.error),
        action: '<button class="btn btn--outline btn--sm" data-qb="pick-model" data-id="' + esc(c.id) + '">' + icon('refresh') + 'Try again</button>' });
    }
    /* The phone itself, when the shop sells it, is not a compatibility match. */
    var own = activeProducts().filter(function (p) { return p.master && p.master.id === c.id; });
    var linked = c.matches.map(function (m) { return productById(m.productId); }).filter(Boolean)
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
      (own.length ? '<p class="qb-gridlab">This phone</p><div class="qb-grid">' + own.map(function (p) { return cardHTML(p); }).join('') + '</div>' : '') +
      (linked.length ? '<p class="qb-gridlab">Fits this phone</p><div class="qb-grid">' + linked.map(function (p) { return cardHTML(p, c.name); }).join('') + '</div>' : '');
  }

  function setupHTML() {
    return '<div class="qb-setup">' +
      '<span class="qb-setup__ico">' + icon('box') + '</span>' +
      '<h2>Set up your counter</h2>' +
      '<p>Add the products you sell — a photo, a price, where it sits on the shelf and how many you have. ' +
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

  /* ------------------------------------------------------- the bill editor */
  function billEditorHTML() {
    var c = S.cart;
    var d = draft();
    var count = c.lines.reduce(function (n, l) { return n + l.qty; }, 0);
    return '<div class="qb-sec"><h2>Bill</h2><span class="qb-count" id="qbCount">' + count + (count === 1 ? ' item' : ' items') + '</span>' +
      (c.lines.length ? '<button class="qb-link" data-qb="clear-cart">' + icon('trash') + 'Clear</button>' : '') + '</div>' +
      '<div class="qb-lines" id="qbLines">' + linesHTML(d) + '</div>' +
      customFormHTML() +
      '<div class="qb-adj">' +
      '<div class="qb-field"><span class="qb-lab">Discount</span><div class="qb-inrow">' +
      '<div class="qb-seg qb-seg--sm" role="group" aria-label="Discount type">' +
      '<button class="' + (c.discount.mode === 'amount' ? 'is-on' : '') + '" data-qb="disc-mode" data-id="amount" aria-pressed="' + (c.discount.mode === 'amount') + '">₹</button>' +
      '<button class="' + (c.discount.mode === 'percent' ? 'is-on' : '') + '" data-qb="disc-mode" data-id="percent" aria-pressed="' + (c.discount.mode === 'percent') + '">%</button></div>' +
      '<input class="input qb-in" id="qbDisc" inputmode="decimal" autocomplete="off" placeholder="0" value="' + esc(c.discount.text) + '" data-qbi="disc" aria-label="Discount" /></div>' +
      '<small class="qb-err" data-err="disc">' + esc(d.errors.disc || '') + '</small></div>' +
      '<div class="qb-field" id="qbTax">' + taxHTML(d) + '</div>' +
      '</div>' +
      '<div class="qb-cust">' +
      '<span class="qb-lab">Customer <em>(optional)</em></span>' +
      '<div id="qbCust">' + customerPickHTML() + '</div>' +
      '<textarea class="input qb-in qb-notes" id="qbCNotes" rows="2" placeholder="Notes — e.g. warranty, delivery" data-qbi="cnotes" aria-label="Notes">' + esc(c.customer.notes) + '</textarea>' +
      '</div>';
  }

  /* Choosing who the bill is for. Empty is a walk-in. A full mobile number makes
     or finds a customer when the bill is saved; a name alone stays a walk-in. */
  function customerPickHTML() {
    var c = S.cart.customer;
    if (c.id) {
      return '<div class="qb-custpick"><span class="qb-custpick__who"><b>' + esc(c.name || c.mobile) + '</b>' +
        (c.name && c.mobile ? '<span>' + esc(c.mobile) + '</span>' : '') + '</span>' +
        '<button class="qb-link" data-qb="cust-clear">' + icon('close') + 'Change</button></div>';
    }
    return '<div class="qb-cust__row">' +
      '<input class="input qb-in" id="qbCName" autocomplete="off" placeholder="Name, or search customers" value="' + esc(c.name) + '" data-qbi="cname" aria-label="Customer name" />' +
      '<input class="input qb-in" id="qbCMob" type="tel" inputmode="tel" autocomplete="off" placeholder="Mobile number" value="' + esc(c.mobile) + '" data-qbi="cmobile" aria-label="Customer mobile number" /></div>' +
      '<div class="qb-custhits" id="qbCustHits"></div>' +
      '<small class="qb-help">Leave empty for a walk-in. A mobile number saves them as a customer.</small>';
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

  function linesHTML(d) {
    var c = S.cart;
    if (!c.lines.length) {
      return '<div class="qb-empty qb-empty--bill">' + icon('receipt') +
        '<p>' + (isDesk() ? 'Click a product on the left to add it.' : 'Tap a product to add it.') + '<br>Or add a custom item below.</p></div>';
    }
    return c.lines.map(function (l) {
      var p = l.productId ? productById(l.productId) : null;
      var stock = lineStock(l);
      var over = stock && stock.used > stock.qty;
      var err = d.errors['line:' + l.key];
      return '<div class="qb-line' + (err || over ? ' is-bad' : '') + '" data-key="' + esc(l.key) + '">' +
        '<div class="qb-line__main"><b>' + esc(l.name) + (l.variantLabel ? ' · ' + esc(l.variantLabel) : '') + '</b><span>' +
        (l.modelName ? '<em class="qb-fits">For ' + esc(l.modelName) + '</em> · ' : '') +
        (l.productId ? (l.shelf ? 'Shelf ' + esc(l.shelf) : catName(p && p.categoryId)) : '<em class="qb-tagc">Custom item</em>') +
        (over ? ' · <em class="qb-warn">only ' + stock.qty + ' in stock</em>' : '') +
        (!l.productId ? ' · <button class="qb-link" data-qb="custom-save" data-id="' + esc(l.key) + '">Save as product</button>' : '') +
        '</span></div>' +
        '<div class="qb-qty" role="group" aria-label="Quantity">' +
        '<button data-qb="qty-dec" data-id="' + esc(l.key) + '" aria-label="Decrease">' + icon('minus') + '</button>' +
        '<input class="qb-qty__in" inputmode="numeric" autocomplete="off" value="' + l.qty + '" data-qbi="line-qty" data-id="' + esc(l.key) + '" aria-label="Quantity of ' + esc(l.name) + '" />' +
        '<button data-qb="qty-inc" data-id="' + esc(l.key) + '" aria-label="Increase">' + icon('plus') + '</button></div>' +
        '<label class="qb-price"><span>₹</span><input inputmode="decimal" autocomplete="off" value="' + esc(l.priceText) + '" data-qbi="line-price" data-id="' + esc(l.key) + '" aria-label="Price of ' + esc(l.name) + '" /></label>' +
        '<b class="qb-line__total" data-total="' + esc(l.key) + '">' + (l.unitPaise == null ? '—' : M.format(l.unitPaise * l.qty)) + '</b>' +
        '<button class="qb-line__x" data-qb="remove" data-id="' + esc(l.key) + '" aria-label="Remove ' + esc(l.name) + '">' + icon('close') + '</button>' +
        '</div>';
    }).join('');
  }

  function customFormHTML() {
    return '<details class="qb-custom" id="qbCustom"><summary>' + icon('plus') + 'Custom item <em>— not saved as a product</em></summary>' +
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

  /* ------------------------------------------------- summary (right pane) */
  function summaryHTML() {
    if (S.lastSaved) return savedCardHTML(S.lastSaved);
    var d = draft();
    return '<div class="qb-sumsec"><div class="qb-sec"><h2>Invoice</h2>' + sizeSelectHTML('qbSize') + '</div>' +
      '<div class="qb-preview" id="qbPreview">' + invoiceHTML(draftBill(d), 'preview') + '</div></div>' +
      '<div class="qb-totals" id="qbTotals">' + totalsHTML(d) + '</div>' +
      '<div class="qb-pay" id="qbPay">' + payHTML(d) + '</div>' +
      '<div class="qb-acts" id="qbActs">' + actsHTML(d) + '</div>';
  }

  function sizeSelectHTML(id) {
    return '<label class="qb-size"><span class="sr">Paper size</span><select class="input" id="' + id + '" data-qbi="size">' +
      SIZES.map(function (s) { return '<option value="' + s[0] + '"' + (S.printSize === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') +
      '</select></label>';
  }

  function totalsHTML(d) {
    var t = d.totals, c = S.cart;
    var row = function (k, v, cls) { return '<div class="qb-trow' + (cls ? ' ' + cls : '') + '"><span>' + k + '</span><b>' + v + '</b></div>'; };
    return row('Subtotal', inr(t.subtotalPaise)) +
      (t.discountPaise ? row('Discount', '−' + inr(t.discountPaise)) : '') +
      (c.tax.on && d.tax.rateBp ? row(esc(d.tax.label) + ' ' + pct(d.tax.rateBp) + (d.tax.inclusive ? ' (included)' : ''), (d.tax.inclusive ? '' : '+') + inr(t.taxPaise)) : '') +
      row('Grand total', inr(t.totalPaise), 'qb-trow--grand');
  }

  function payHTML(d) {
    var c = S.cart;
    var seg = function (list, cur, act) {
      return list.map(function (x) {
        return '<button class="' + (cur === x[0] ? 'is-on' : '') + '" data-qb="' + act + '" data-id="' + x[0] + '" aria-pressed="' + (cur === x[0]) + '">' + x[1] + '</button>';
      }).join('');
    };
    return '<span class="qb-lab">Payment method</span>' +
      '<div class="qb-seg" role="group" aria-label="Payment method">' + seg(METHODS, c.payment.method, 'pay-method') + '</div>' +
      '<span class="qb-lab">Status</span>' +
      '<div class="qb-seg" role="group" aria-label="Payment status" id="qbStatus">' + seg(STATUSES, c.payment.status, 'pay-status') + '</div>' +
      '<div class="qb-field"><label class="qb-lab" for="qbRecv">Amount received</label>' +
      '<label class="qb-prefix"><span>₹</span><input class="input qb-in" id="qbRecv" inputmode="decimal" autocomplete="off" ' +
      'placeholder="' + (c.payment.status === 'paid' ? M.toInput(d.totals.totalPaise) + ' (full)' : '0') + '" value="' + esc(c.payment.received) + '" data-qbi="recv" /></label>' +
      '<small class="qb-err" data-err="recv">' + esc(d.errors.recv || '') + '</small></div>' +
      '<div class="qb-bal" id="qbBal">' + balanceHTML(d) + '</div>';
  }

  function balanceHTML(d) {
    if (d.pay.changePaise) return '<span>Change to return</span><b class="qb-good">' + inr(d.pay.changePaise) + '</b>';
    if (d.pay.balancePaise) return '<span>Balance due</span><b class="qb-due">' + inr(d.pay.balancePaise) + '</b>';
    return '<span>Balance</span><b>' + inr(0) + '</b>';
  }

  function actsHTML(d) {
    var dis = !d.ok || S.saving;
    return (S.saveError ? '<div class="qb-alert" role="alert">' + icon('alert') + '<span>' + esc(S.saveError) + '</span></div>' : '') +
      '<button class="btn qb-btn btn--lg btn--block" data-qb="save-bill"' + (dis ? ' disabled' : '') + '>' +
      (S.saving ? '<span class="qb-spin"></span>Saving…' : icon('check') + 'Save Bill') + '</button>' +
      '<button class="btn btn--outline btn--block" data-qb="print-bill"' + (dis ? ' disabled' : '') + '>' + icon('printer') + 'Print Bill</button>' +
      (S.cart.lines.length ? '' : '<p class="qb-hint">Add a product or a custom item to start a bill.</p>');
  }

  function savedCardHTML(b) {
    return '<div class="qb-saved">' +
      '<span class="qb-saved__ico">' + icon('checkCircle') + '</span>' +
      '<h2>Bill saved</h2><p class="qb-saved__no">' + esc(b.number) + ' · ' + inr(b.totalPaise) + ' · ' + esc(label(STATUSES, b.payment.status)) + '</p>' +
      '<div class="qb-preview">' + invoiceHTML(b, 'preview') + '</div>' +
      '<div class="qb-saved__acts">' +
      '<div class="qb-inrow">' + sizeSelectHTML('qbSizeSaved') +
      '<button class="btn qb-btn grow" data-qb="print-saved" data-id="' + esc(b.id) + '">' + icon('printer') + 'Print Bill</button></div>' +
      '<button class="btn btn--outline btn--block" data-qb="labels" data-id="' + esc(b.id) + '">' + icon('tag') + 'Print Product Labels</button>' +
      '<a class="btn btn--ghost btn--block" href="/billing/bills/' + encodeURIComponent(b.id) + '">' + icon('linkOut') + 'Open bill</a>' +
      '<button class="btn btn--soft btn--block qb-btn--soft" data-qb="new-bill">' + icon('plus') + 'New Bill</button>' +
      '</div></div>';
  }

  /* ---------------------------------------------------- mobile cart pieces */
  function cartBarHTML() {
    var c = S.cart;
    var n = c.lines.reduce(function (k, l) { return k + l.qty; }, 0);
    if (!n) return '<div class="qb-cartbar__in is-empty">' + icon('receipt') + '<span>Tap products to start a bill</span>' +
      '<button class="btn btn--sm btn--outline" data-qb="open-cart">Custom item</button></div>';
    var d = draft();
    return '<button class="qb-cartbar__in" data-qb="open-cart" aria-label="Open the bill">' +
      '<span class="qb-cartbar__n">' + n + '</span>' +
      '<span class="qb-cartbar__t"><b>' + inr(d.totals.totalPaise) + '</b><em>' + n + (n === 1 ? ' item' : ' items') + ' on the bill</em></span>' +
      '<span class="qb-cartbar__go">View bill' + icon('chevronRight') + '</span></button>';
  }
  function paintCartBar() { paint('qbCartBar', cartBarHTML()); }

  function cartSheetHTML() {
    var d = draft();
    return '<div class="sheet__grab"></div>' +
      '<div class="sheet__head"><h3 class="t-h3 grow">Current bill</h3>' +
      '<button class="iconbtn" data-qb="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<div class="sheet__body qb-sheetbody" id="qbBill">' + billEditorHTML() + '</div>' +
      '<div class="sheet__foot qb-sheetfoot"><div class="qb-sheetfoot__t"><span>Grand total</span><b id="qbSheetTotal">' + inr(d.totals.totalPaise) + '</b></div>' +
      '<button class="btn qb-btn grow" data-qb="review"' + (S.cart.lines.length ? '' : ' disabled') + '>Review Bill' + icon('arrowRight') + '</button></div>';
  }
  function openCartSheet() {
    S.sheet = { type: 'cart' };
    openSheet('cart', cartSheetHTML(), 'Current bill');
  }

  /* ----------------------------------------------- after the cart changes */
  /** `structure` true: lines were added or removed, so the list is redrawn. */
  function cartChanged(structure) {
    saveCart();
    /* The next bill has begun: the "saved" card gives way to its preview. */
    if (S.lastSaved && viewName() === 'pos') {
      S.lastSaved = null;
      if (el('qbSum')) paint('qbSum', summaryHTML());
    }
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
        if (t) t.textContent = l.unitPaise == null ? '—' : M.format(l.unitPaise * l.qty);
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
    if (S.lastSaved) return;
    paint('qbPreview', invoiceHTML(draftBill(d), 'preview'));
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
    ['disc', 'tax', 'recv'].forEach(function (k) {
      var e = document.querySelector('[data-err="' + k + '"]');
      if (e) e.textContent = d.errors[k] || '';
    });
    paint('qbSheetTotal', inr(d.totals.totalPaise));
    var rv = document.querySelector('.qb-sheetfoot [data-qb="review"]');
    if (rv) rv.disabled = !S.cart.lines.length;
    paintCartBar();
    if (viewName() === 'review') paintReview(d);
  }

  /* ================================================================ REVIEW */
  function renderReview(page) {
    if (!S.cart.lines.length && !S.lastSaved) { go('/billing'); return; }
    page.innerHTML = frame('review',
      '<div class="qb-review shell">' +
      '<div class="qb-review__bar"><button class="btn btn--ghost btn--sm" data-qb="edit-bill">' + icon('chevronLeft') + 'Edit Bill</button>' +
      sizeSelectHTML('qbSize') + '</div>' +
      '<div id="qbReview">' + reviewInnerHTML() + '</div></div>');
  }
  function reviewInnerHTML() {
    if (S.lastSaved) return savedCardHTML(S.lastSaved);
    var d = draft();
    return '<div class="qb-preview qb-preview--full" id="qbPreview">' + invoiceHTML(draftBill(d), 'preview') + '</div>' +
      '<div class="qb-pay qb-pay--review" id="qbPay">' + payHTML(d) + '</div>' +
      '<div class="qb-review__foot" id="qbActs">' + actsHTML(d) + '</div>';
  }
  function paintReview(d) { paint('qbPreview', invoiceHTML(draftBill(d), 'preview')); }

  /* ================================================================ SAVING */
  function saveBill(thenPrint) {
    if (S.saving) return;
    var d = draft();
    if (!d.ok) {
      if (!S.cart.lines.length) toast('Add something to the bill first', 'alert');
      else toast('Check the highlighted fields', 'alert');
      paintDerived(d);
      return;
    }
    var p = S.cart.lines.filter(function (l) { return l.productId && !productById(l.productId); })[0];
    if (p) { S.saveError = '“' + p.name + '” is no longer in your products. Remove it from the bill.'; paintDerived(d); return; }

    S.saving = true;
    S.saveError = null;
    paintDerived(d);
    var size = S.printSize;
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
      markFiguresStale();
      S.cart = emptyCart();
      S.compat = null;
      S.filter.q = '';
      saveCart();
      S.lastSaved = bill;
      S.saving = false;
      /* replayed: an earlier attempt of THIS bill had already reached the
         server (a double tap, or a reply lost to the connection) — it is the
         same bill, saved once */
      toast(r.replayed ? 'Bill ' + bill.number + ' saved (it had already reached the server)' : 'Bill ' + bill.number + ' saved', 'checkCircle');
      load();
      if (thenPrint) printInvoice(bill, size);
      if (onBilling()) {
        closeSheet();
        if (isDesk() && viewName() === 'pos') { paint('qbSum', summaryHTML()); paint('qbBill', billEditorHTML()); paintCatalog(); }
        else rerender();
      }
    }, function (err) {
      if (S.uid !== uid) return;
      S.saving = false;
      S.saveError = say(err);
      if (err.code === 'insufficient-stock' || err.code === 'product-archived' || err.code === 'product-missing') load();
      if (onBilling()) {
        paintDerived();
        if (err.code === 'insufficient-stock') paint('qbLines', linesHTML(draft()));
      }
    });
  }

  /** Anything that changes a bill changes these; they are read again when next shown. */
  function markFiguresStale() {
    S.bills.loaded = false;
    S.customers.loaded = false;
    S.customerCache = {};
    S.overview.data = null;
  }

  function newBill() {
    S.lastSaved = null;
    S.saveError = null;
    if (!S.cart.lines.length) S.cart = emptyCart();
    saveCart();
    if (viewName() !== 'pos') { go('/billing'); return; }
    rerender();
  }

  /* ============================================================ BILLS LIST */
  function renderBills(page) {
    var b = S.bills;
    page.innerHTML = frame('bills',
      '<div class="qb-list shell">' +
      '<div class="qb-list__head"><label class="qb-search">' + icon('search') +
      '<input id="qbBillQ" type="search" autocomplete="off" placeholder="Bill number, customer name or mobile" value="' + esc(b.q) + '" data-qbi="bills-q" aria-label="Search bills" /></label></div>' +
      (b.range ? '<div class="qb-compatbar"><span class="qb-compatbar__l">Showing</span><b>' + esc(b.range) + '</b>' +
        '<button class="qb-link" data-qb="bills-all">' + icon('close') + 'All bills</button></div>' : '') +
      '<div id="qbBillList">' + billListHTML() + '</div></div>');
    if (!b.loaded && !b.loading) loadBills(true);
  }

  function loadBills(fresh) {
    var b = S.bills;
    var ticket = ++b.ticket;
    var uid = S.uid;
    b.loading = true;
    if (fresh) { b.items = []; b.cursor = null; }
    paint('qbBillList', billListHTML());
    API.bills({ q: b.q, from: b.q ? null : b.from || null, to: b.q ? null : b.to || null, cursor: fresh ? null : b.cursor }).then(function (r) {
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
    if (!b.items.length) {
      if (b.loading) return C.skelRows(5);
      return C.state({ icon: 'receipt', title: b.q ? 'No bills match “' + b.q + '”' : b.range ? 'No bills in this period' : 'No bills yet',
        text: b.q ? 'Search by bill number (QB-0012 or 12), customer name, or mobile number.' : 'Saved bills appear here, newest first.',
        action: b.q ? '' : '<a class="btn qb-btn btn--sm" href="/billing">' + icon('plus') + 'New Bill</a>' });
    }
    return '<div class="qb-bills">' + b.items.map(function (x) {
      var st = x.status === 'void' ? 'void' : x.paymentStatus;
      return '<a class="qb-brow" href="/billing/bills/' + encodeURIComponent(x.id) + '">' +
        '<span class="qb-brow__no">' + esc(x.number) + '</span>' +
        '<span class="qb-brow__who"><b>' + esc(x.customerName || 'Walk-in') + '</b>' +
        '<span>' + esc(when(x.createdAt)) + ' · ' + x.itemCount + (x.itemCount === 1 ? ' item' : ' items') + (x.customerMobile ? ' · ' + esc(x.customerMobile) : '') + '</span></span>' +
        '<span class="qb-brow__amt">' + inr(x.totalPaise) + statusPill(st) + '</span></a>';
    }).join('') + '</div>' +
      (b.cursor ? '<div class="qb-more"><button class="btn btn--outline" data-qb="bills-more"' + (b.loading ? ' disabled' : '') + '>' +
        (b.loading ? 'Loading…' : 'Load older bills') + '</button></div>' : '');
  }

  function statusPill(st) {
    var map = { paid: ['pill--ok', 'Paid'], partial: ['pill--warn', 'Partially Paid'], unpaid: ['pill--bad', 'Unpaid'], void: ['qb-pill--void', 'VOID'] };
    var m = map[st] || ['', st];
    return '<span class="pill ' + m[0] + '">' + m[1] + '</span>';
  }

  /* ============================================================= ONE BILL */
  function renderBillView(page, id) {
    var b = S.billCache[id];
    if (!b) {
      page.innerHTML = frame('bill', '<div class="shell qb-billview">' + C.skelRows(4) + '</div>');
      var uid = S.uid;
      API.getBill(id).then(function (r) {
        if (S.uid !== uid) return;
        S.billCache[id] = r.bill;
        if (onBilling() && params[1] === id) rerender();
      }, function (err) {
        if (onBilling() && params[1] === id) {
          ctx.page().innerHTML = frame('bill', '<div class="shell">' + C.state({ icon: 'alert', title: 'Could not open this bill', text: say(err),
            action: '<a class="btn btn--outline btn--sm" href="/billing/bills">' + icon('chevronLeft') + 'All bills</a>' }) + '</div>');
        }
      });
      return;
    }
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
      '<div class="qb-card2"><span class="qb-lab">Print</span>' +
      '<div class="qb-inrow">' + sizeSelectHTML('qbSize') +
      '<button class="btn qb-btn grow" data-qb="print-saved" data-id="' + esc(b.id) + '">' + icon('printer') + 'Print Bill</button></div>' +
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
      (S.lastSaved && S.lastSaved.id === b.id ? '<button class="btn btn--soft btn--block qb-btn--soft" data-qb="new-bill">' + icon('plus') + 'New Bill</button>' : '') +
      '</div></div></div>');
  }

  /* ============================================================== PRODUCTS */
  function renderProducts(page) {
    var f = S.prodFilter;
    var low = S.products.filter(function (p) { return p.active && p.qty <= p.lowStockAt; }).length;
    var unlinked = S.products.filter(needsLinks).length;
    var opt = function (v, t) { return '<option value="' + esc(v) + '"' + (f.cat === v ? ' selected' : '') + '>' + esc(t) + '</option>'; };
    var show = function (v, t, n) {
      return '<button class="qb-chip' + (f.show === v ? ' is-on' : '') + '" data-qb="prod-show" data-id="' + v + '" aria-pressed="' + (f.show === v) + '">' + t + (n != null ? '<em>' + n + '</em>' : '') + '</button>';
    };
    page.innerHTML = frame('products',
      '<div class="qb-list shell">' +
      '<div class="qb-list__head">' +
      '<label class="qb-search">' + icon('search') + '<input id="qbProdQ" type="search" autocomplete="off" placeholder="Search name, shelf or SKU" value="' + esc(f.q) + '" data-qbi="prod-q" aria-label="Search products" /></label>' +
      '<select class="input qb-catsel" data-qbi="prod-cat" aria-label="Category">' + opt('all', 'All categories') +
      S.categories.map(function (c) { return opt(c.id, c.name); }).join('') + '</select>' +
      '</div>' +
      '<div class="qb-chips qb-chips--wrap">' + show('active', 'Active', activeProducts().length) + show('low', 'Low stock', low) +
      (unlinked || f.show === 'links' ? show('links', 'Needs compatibility', unlinked) : '') +
      show('archived', 'Archived', S.products.filter(function (p) { return !p.active; }).length) + '</div>' +
      '<div id="qbProdList">' + productListHTML() + '</div></div>');
  }

  function productListHTML() {
    var f = S.prodFilter;
    if (!S.products.length) {
      return C.state({ icon: 'box', title: 'No products yet', text: 'Add what you sell with a photo, price, shelf and quantity.',
        action: '<button class="btn qb-btn btn--sm" data-qb="add-product">' + icon('plus') + 'Add product</button>' });
    }
    var list = S.products.filter(function (p) {
      if (f.show === 'archived' ? p.active : !p.active) return false;
      if (f.show === 'low' && p.qty > p.lowStockAt) return false;
      if (f.show === 'links' && !needsLinks(p)) return false;
      if (f.cat !== 'all' && p.categoryId !== f.cat) return false;
      return matches(p, f.q);
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    if (!list.length) return '<div class="qb-empty">' + icon('search') + '<p>No products match these filters.</p></div>';
    return '<div class="qb-prods">' + list.map(function (p) {
      var st = stockState(p);
      return '<div class="qb-prow' + (p.active ? '' : ' is-archived') + '">' + thumbHTML(p, 'qb-thumb--sm') +
        '<div class="qb-prow__main"><b>' + esc(p.name) + '</b><span>' + esc(catName(p.categoryId)) +
        (p.shelf ? ' · Shelf ' + esc(p.shelf) : '') + (p.sku ? ' · ' + esc(p.sku) : '') +
        (hasVariants(p) ? ' · ' + p.variants.length + (p.variants.length === 1 ? ' variant' : ' variants') : '') + '</span>' +
        (p.groupIds && p.groupIds.length
          ? '<span class="qb-linked">' + p.groupIds.length + (p.groupIds.length === 1 ? ' compatibility group' : ' compatibility groups') + '</span>'
          : needsLinks(p) ? '<span class="qb-linked qb-linked--need">Needs compatibility groups</span>' : '') +
        '</div>' +
        '<div class="qb-prow__nums"><b>' + (hasVariants(p) && p.variants.length > 1 ? 'From ' : '') + inr(p.pricePaise) + '</b>' +
        '<span class="qb-stock qb-stock--' + st + '">' + (p.qty <= 0 ? 'Out of stock' : p.qty + ' in stock') + (st === 'low' ? ' · low' : '') + '</span></div>' +
        '<div class="qb-prow__acts">' +
        '<button class="btn btn--outline btn--sm" data-qb="edit-product" data-id="' + esc(p.id) + '">' + icon('edit') + '<span>Edit</span></button>' +
        '<button class="btn btn--outline btn--sm" data-qb="stock" data-id="' + esc(p.id) + '">' + icon('box') + '<span>Stock</span></button>' +
        (p.active
          ? '<button class="btn btn--ghost btn--sm" data-qb="archive" data-id="' + esc(p.id) + '" aria-label="Archive ' + esc(p.name) + '">' + icon('inbox') + '<span>Archive</span></button>'
          : '<button class="btn btn--ghost btn--sm" data-qb="restore" data-id="' + esc(p.id) + '">' + icon('refresh') + '<span>Restore</span></button>') +
        '</div></div>';
    }).join('') + '</div>';
  }
  function paintProductList() { paint('qbProdList', productListHTML()); }

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
      info('Mobile', c.mobile) + info('WhatsApp', c.whatsapp) + info('Address', c.address) + info('Notes', c.notes) +
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
      mobile: val('qbUMobile'), whatsapp: val('qbUWhats'), address: val('qbUAddr'), notes: val('qbUNotes')
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
    b.from = dayStart(from); b.to = dayStart(dayShift(to, 1)); b.range = label; b.q = ''; b.loaded = false;
    go('/billing/bills');
  }
  function showCustomers(filter, since, label) {
    var cu = S.customers;
    cu.filter = filter; cu.since = since || 0; cu.range = label || ''; cu.q = ''; cu.loaded = false;
    go('/billing/customers');
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
      case 'stock-low': S.prodFilter = { q: '', cat: 'all', show: 'low' }; go('/billing/products'); break;
      case 'stock-out': S.prodFilter = { q: '', cat: 'all', show: 'low' }; go('/billing/products'); break;
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
      fieldHTML('qbFStatus', 'status', 'Status', false, '<select class="input qb-in" id="qbFStatus" name="status"><option value="active"' + (v.active ? ' selected' : '') + '>Active</option><option value="inactive"' + (v.active ? '' : ' selected') + '>Archived</option></select>') +
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
      if (!el('qbCatalog') || !document.querySelector('.qb-quickadd')) { rerender(); return; }
      paintCatalog();
      if (el('qbLines')) paint('qbLines', linesHTML(draft()));
    } else if (v === 'products' || v === 'categories') rerender();
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
  function openVariantPicker(p, model) {
    S.sheet = { type: 'variant', id: p.id, model: model || null };
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
      markFiguresStale();
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
      markFiguresStale();
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
      case 'add': { var p = productById(id); if (p) addToCart(p, null, compatContext(p)); break; }
      case 'pick-variant': {
        var sv = S.sheet;
        if (!sv || sv.type !== 'variant') break;
        var vp = productById(sv.id);
        var vv = vp && variantOf(vp, id);
        closeSheet();
        if (vv) addToCart(vp, vv, sv.model);
        break;
      }
      case 'pick-model': pickModel(id); break;
      case 'clear-model': clearModel(); break;
      case 'cat': S.filter.cat = id; paintCatalog(); break;
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
      case 'save-bill': saveBill(false); break;
      case 'print-bill': saveBill(true); break;
      case 'print-saved': { var sb = S.billCache[id] || S.lastSaved; if (sb) printInvoice(sb, S.printSize); break; }
      case 'new-bill': newBill(); break;
      case 'labels': {
        var lb = S.billCache[id] || S.lastSaved;
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
      case 'open-cart': openCartSheet(); break;
      case 'close-sheet': closeSheet(); break;
      case 'review': closeSheet(); go('/billing/review'); break;
      case 'edit-bill': S.openCart = !isDesk(); go('/billing'); break;
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
      case 'archive': case 'restore': {
        var ap = productById(id);
        if (!ap) break;
        if (a === 'archive' && !global.confirm('Archive “' + ap.name + '”? It disappears from the counter but stays on old bills, and you can restore it.')) break;
        API.product({ action: 'archive', productId: id, archived: a === 'archive' }).then(function (r) {
          upsertProduct(r.product);
          toast(a === 'archive' ? 'Archived' : 'Restored', 'checkCircle');
          softAfterProductChange();
        }, function (er) { toast(say(er), 'alert'); });
        break;
      }
      case 'prod-show': S.prodFilter.show = id; rerender(); break;
      case 'bills-more': loadBills(false); break;
      case 'bills-retry': loadBills(true); break;
      case 'record-payment': openPayment(id); break;
      case 'pp-go': submitPayment(); break;
      case 'void': openVoid(id); break;
      case 'void-go': submitVoid(); break;
      case 'cat-suggest-all': catRequest({ action: 'suggested' }, function (r) { return r.created.length ? r.created.length + ' categories added' : 'You already have them all'; }); break;
      case 'cat-suggest': catRequest({ action: 'suggested', names: [id] }, 'Category added'); break;
      case 'cat-edit': openCatForm(id); break;
      case 'cat-form-go': submitCatForm(); break;
      case 'cat-links': S.prodFilter = { q: '', cat: id, show: 'links' }; go('/billing/products'); break;
      case 'cat-up': moveCat(id, -1); break;
      case 'cat-down': moveCat(id, 1); break;
      case 'cat-delete': openCatDelete(id); break;
      case 'cat-delete-go': submitCatDelete(); break;
      case 'cat-view': S.prodFilter.cat = id; S.prodFilter.show = 'active'; go('/billing/products'); break;
      case 'bills-all': S.bills.from = 0; S.bills.to = 0; S.bills.range = ''; S.bills.loaded = false; rerender(); break;
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
        S.cart.customer.id = hit.id; S.cart.customer.name = hit.name; S.cart.customer.mobile = hit.mobile;
        S.custHits = [];
        paint('qbCust', customerPickHTML());
        cartChanged(false);
        break;
      }
      case 'cust-clear':
        S.cart.customer.id = ''; S.cart.customer.name = ''; S.cart.customer.mobile = '';
        paint('qbCust', customerPickHTML());
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
        paint('qbCatalog', catalogHTML());
        clearTimeout(modelHitTimer);
        modelHitTimer = setTimeout(paintModelHits, 120);
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
      case 'prod-q': S.prodFilter.q = t.value.trim(); paintProductList(); break;
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
      case 'hist-range': {
        var ch = S.customerCache[params[1]];
        if (ch) paint('qbCustHist', historyHTML(ch.bills, (el('qbHistFrom') || {}).value || '', (el('qbHistTo') || {}).value || ''));
        break;
      }
      case 'photo': onPhotoPicked(t); break;
      case 'prod-cat': S.prodFilter.cat = t.value; paintProductList(); break;
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
  if (DESK_MQ) {
    var onMq = function () { if (onBilling()) { if (S.sheet && S.sheet.type === 'cart') closeSheet(); rerender(); } };
    if (DESK_MQ.addEventListener) DESK_MQ.addEventListener('change', onMq);
    else if (DESK_MQ.addListener) DESK_MQ.addListener(onMq);
  }

  SM.quickBilling = {
    render: render,
    /* exposed for the console and for tests, not for the app */
    _state: function () { return S; },
    _invoiceHTML: invoiceHTML
  };
})(window);
