/* ============================================================================
   Mobile Parts Finder · quick-billing.js — Quick Billing & Inventory screens
   ----------------------------------------------------------------------------
   A shop's own counter: its products and stock, a bill being built, saved
   bills, categories, printing. Loaded on demand by app.js the first time
   /billing is opened, so the Finder never pays for it.

   It is NOT the Device Finder catalogue. A master model or a compatibility
   group never appears here and nothing here is added to the catalogue.

   ROUTES (all under /billing, rendered into the app's #page)
     /billing                   the counter: products, the bill, the summary
     /billing/review            the full-screen bill preview (phones)
     /billing/bills             saved bills: search, history
     /billing/bills/<id>        one saved bill: reprint, labels, payment, void
     /billing/products          stock: edit, adjust, archive, low stock
     /billing/categories        create, rename, reorder, delete-with-move

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
      bills: { items: [], cursor: null, q: '', loading: false, loaded: false, error: null, ticket: 0 },
      prodFilter: { q: '', cat: 'all', show: 'active' },
      billCache: {},
      sheet: null,
      openCart: false,
      editingCat: null,
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
  function inCart(pid) {
    var n = 0;
    (S.cart ? S.cart.lines : []).forEach(function (l) { if (l.productId === pid) n += l.qty; });
    return n;
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
      customer: { name: '', mobile: '', notes: '' },
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

  function addToCart(p) {
    var free = p.qty - inCart(p.id);
    if (free <= 0) { toast(p.qty <= 0 ? '“' + p.name + '” is out of stock' : 'All ' + p.qty + ' in stock are already on the bill', 'alert'); return; }
    var line = null;
    S.cart.lines.forEach(function (l) { if (l.productId === p.id && !line) line = l; });
    if (line) line.qty += 1;
    else {
      S.cart.lines.push({
        key: API.newId('l'), productId: p.id, name: p.name, shelf: p.shelf || '', sku: p.sku || '',
        unitPaise: p.pricePaise, priceText: M.toInput(p.pricePaise), qty: 1
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
        return { lineNo: i + 1, name: l.name, shelf: l.shelf, sku: l.sku, custom: !l.productId, unitPaise: u, qty: l.qty, totalPaise: u * l.qty };
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
          ? { productId: l.productId, qty: l.qty, unitPaise: l.unitPaise }
          : { name: l.name, qty: l.qty, unitPaise: l.unitPaise };
      }),
      discount: d.discount,
      tax: c.tax.on ? d.tax : { rateBp: 0 },
      payment: { method: c.payment.method, status: c.payment.status, receivedPaise: d.received },
      customer: { name: c.customer.name, mobile: c.customer.mobile, notes: c.customer.notes }
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
      if (thermal) {
        return '<tr><td colspan="2"><b>' + esc(it.name) + '</b><br><span class="inv__dim">' +
          it.qty + ' × ' + M.format(it.unitPaise) + '</span></td><td class="inv__num">' + M.format(it.totalPaise) + '</td></tr>';
      }
      return '<tr><td class="inv__i">' + (i + 1) + '</td><td><b>' + esc(it.name) + '</b>' +
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
  }

  function rerender() {
    if (!onBilling()) return;
    render(ctx.page(), params, ctx);
  }

  function viewName() {
    var p = params[0];
    if (p === 'bills') return params[1] ? 'bill' : 'bills';
    if (p === 'review' || p === 'products' || p === 'categories') return p;
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
      var on = view === id || (id === 'bills' && view === 'bill') || (id === 'pos' && view === 'review');
      return '<a class="qb-tab' + (on ? ' is-on' : '') + '" href="' + href + '"' + (on ? ' aria-current="page"' : '') + '>' +
        icon(ic) + '<span>' + text + '</span></a>';
    };
    return '<div class="qb qb--' + view + (extraCls ? ' ' + extraCls : '') + '" id="qb">' +
      '<div class="qb-head"><div class="qb-head__in">' +
      '<div class="qb-title"><span class="qb-title__ico">' + icon('receipt') + '</span>' +
      '<div><h1>Quick Billing</h1><p>Your shop’s own stock and bills · separate from the Device Finder</p></div></div>' +
      '<nav class="qb-tabs" aria-label="Quick Billing">' +
      tab('pos', '/billing', 'New Bill', 'receipt') +
      tab('bills', '/billing/bills', 'Bills', 'history') +
      tab('products', '/billing/products', 'Products', 'box') +
      tab('categories', '/billing/categories', 'Categories', 'layers') +
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
      '<input id="qbQ" type="search" autocomplete="off" placeholder="Search products, shelf, SKU…" ' +
      'value="' + esc(S.filter.q) + '" aria-label="Search your products" data-qbi="q" /></label>' +
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
    var hay = (p.name + ' ' + (p.shelf || '') + ' ' + (p.sku || '') + ' ' + catName(p.categoryId)).toLowerCase();
    return q.toLowerCase().split(/\s+/).every(function (w) { return hay.indexOf(w) > -1; });
  }

  function catalogHTML() {
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
    return freqHTML + '<div class="qb-grid">' + list.map(cardHTML).join('') + '</div>';
  }

  function thumbHTML(p, cls) {
    if (p.imageUrl) return '<span class="qb-thumb ' + (cls || '') + '"><img src="' + esc(p.imageUrl) + '" alt="" loading="lazy" decoding="async" /></span>';
    var letters = String(p.name || '?').split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase();
    return '<span class="qb-thumb qb-thumb--none ' + (cls || '') + '" aria-hidden="true">' + esc(letters) + '</span>';
  }

  function cardHTML(p) {
    var used = inCart(p.id);
    var left = p.qty - used;
    var st = stockState(p);
    return '<button class="qb-card' + (used ? ' is-in' : '') + '" data-qb="add" data-id="' + esc(p.id) + '"' +
      (left <= 0 ? ' aria-disabled="true"' : '') + ' aria-label="Add ' + esc(p.name) + ' to the bill">' +
      thumbHTML(p) +
      '<span class="qb-card__name">' + esc(p.name) + '</span>' +
      '<span class="qb-card__price">' + inr(p.pricePaise) + '</span>' +
      '<span class="qb-card__meta">' +
      '<span class="qb-stock qb-stock--' + st + '">' + (p.qty <= 0 ? 'Out of stock' : p.qty + ' in stock') + '</span>' +
      (p.shelf ? '<span class="qb-shelf">' + icon('tag') + esc(p.shelf) + '</span>' : '') + '</span>' +
      (used ? '<span class="qb-card__in" aria-label="' + used + ' on the bill">' + used + '</span>' : '') +
      '</button>';
  }

  function setupHTML() {
    var hasCats = S.categories.length > 0;
    return '<div class="qb-setup">' +
      '<span class="qb-setup__ico">' + icon('box') + '</span>' +
      '<h2>Set up your counter</h2>' +
      '<p>Add the products you sell — a photo, a price, where it sits on the shelf and how many you have. ' +
      'They are yours alone and separate from the Device Finder.</p>' +
      '<div class="qb-setup__acts">' +
      (hasCats ? '' : '<button class="btn btn--outline" data-qb="cat-suggest-all">' + icon('layers') + 'Add suggested categories</button>') +
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
      '<div class="qb-cust__row">' +
      '<input class="input qb-in" id="qbCName" autocomplete="off" placeholder="Customer name" value="' + esc(c.customer.name) + '" data-qbi="cname" aria-label="Customer name" />' +
      '<input class="input qb-in" id="qbCMob" type="tel" inputmode="tel" autocomplete="off" placeholder="Mobile number" value="' + esc(c.customer.mobile) + '" data-qbi="cmobile" aria-label="Customer mobile number" /></div>' +
      '<textarea class="input qb-in qb-notes" id="qbCNotes" rows="2" placeholder="Notes — e.g. warranty, delivery" data-qbi="cnotes" aria-label="Notes">' + esc(c.customer.notes) + '</textarea>' +
      '</div>';
  }

  function linesHTML(d) {
    var c = S.cart;
    if (!c.lines.length) {
      return '<div class="qb-empty qb-empty--bill">' + icon('receipt') +
        '<p>' + (isDesk() ? 'Click a product on the left to add it.' : 'Tap a product to add it.') + '<br>Or add a custom item below.</p></div>';
    }
    return c.lines.map(function (l) {
      var p = l.productId ? productById(l.productId) : null;
      var over = p && inCart(p.id) > p.qty;
      var err = d.errors['line:' + l.key];
      return '<div class="qb-line' + (err || over ? ' is-bad' : '') + '" data-key="' + esc(l.key) + '">' +
        '<div class="qb-line__main"><b>' + esc(l.name) + '</b><span>' +
        (l.productId ? (l.shelf ? 'Shelf ' + esc(l.shelf) : catName(p && p.categoryId)) : '<em class="qb-tagc">Custom item</em>') +
        (over ? ' · <em class="qb-warn">only ' + p.qty + ' in stock</em>' : '') +
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
          if (prod) { prod.qty = Math.max(0, prod.qty - l.qty); prod.soldCount = (prod.soldCount || 0) + l.qty; }
        });
      }
      S.billCount = Math.max(S.billCount, bill.seq || 0);
      S.bills.loaded = false;
      S.cart = emptyCart();
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
    API.bills({ q: b.q, cursor: fresh ? null : b.cursor }).then(function (r) {
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
      return C.state({ icon: 'receipt', title: b.q ? 'No bills match “' + b.q + '”' : 'No bills yet',
        text: b.q ? 'Search by bill number (QB-0012 or 12), customer name, or mobile number.' : 'Saved bills appear here, newest first.',
        action: b.q ? '' : '<a class="btn qb-btn btn--sm" href="/billing">' + icon('plus') + 'New Bill</a>' });
    }
    return '<div class="qb-bills">' + b.items.map(function (x) {
      var st = x.status === 'void' ? 'void' : x.paymentStatus;
      return '<a class="qb-brow" href="/billing/bills/' + encodeURIComponent(x.id) + '">' +
        '<span class="qb-brow__no">' + esc(x.number) + '</span>' +
        '<span class="qb-brow__who"><b>' + esc(x.customerName || 'Walk-in customer') + '</b>' +
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
      if (f.cat !== 'all' && p.categoryId !== f.cat) return false;
      return matches(p, f.q);
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    if (!list.length) return '<div class="qb-empty">' + icon('search') + '<p>No products match these filters.</p></div>';
    return '<div class="qb-prods">' + list.map(function (p) {
      var st = stockState(p);
      return '<div class="qb-prow' + (p.active ? '' : ' is-archived') + '">' + thumbHTML(p, 'qb-thumb--sm') +
        '<div class="qb-prow__main"><b>' + esc(p.name) + '</b><span>' + esc(catName(p.categoryId)) +
        (p.shelf ? ' · Shelf ' + esc(p.shelf) : '') + (p.sku ? ' · ' + esc(p.sku) : '') + '</span></div>' +
        '<div class="qb-prow__nums"><b>' + inr(p.pricePaise) + '</b>' +
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
    var counts = {};
    S.products.forEach(function (p) { counts[p.categoryId] = (counts[p.categoryId] || 0) + 1; });
    var have = {};
    S.categories.forEach(function (c) { have[c.name.toLowerCase()] = 1; });
    var missing = (S.suggested || []).filter(function (n) { return !have[n.toLowerCase()]; });
    var rows = S.categories.map(function (c, i) {
      var editing = S.editingCat === c.id;
      return '<div class="qb-crow" data-id="' + esc(c.id) + '">' +
        '<div class="qb-crow__ord">' +
        '<button data-qb="cat-up" data-id="' + esc(c.id) + '" aria-label="Move ' + esc(c.name) + ' up"' + (i === 0 ? ' disabled' : '') + '>' + icon('chevronUp') + '</button>' +
        '<button data-qb="cat-down" data-id="' + esc(c.id) + '" aria-label="Move ' + esc(c.name) + ' down"' + (i === S.categories.length - 1 ? ' disabled' : '') + '>' + icon('chevronDown') + '</button></div>' +
        (editing
          ? '<form class="qb-crow__edit" data-qbf="cat-rename" data-id="' + esc(c.id) + '"><input class="input qb-in" id="qbCatRen" value="' + esc(c.name) + '" maxlength="40" aria-label="New name" />' +
            '<button class="btn qb-btn btn--sm" type="submit">Save</button><button class="btn btn--ghost btn--sm" type="button" data-qb="cat-cancel">Cancel</button></form>'
          : '<div class="qb-crow__main"><b>' + esc(c.name) + '</b><span>' + (counts[c.id] || 0) + ((counts[c.id] || 0) === 1 ? ' product' : ' products') + '</span></div>' +
            '<div class="qb-crow__acts">' +
            '<button class="btn btn--ghost btn--sm" data-qb="cat-view" data-id="' + esc(c.id) + '">' + icon('box') + '<span>View products</span></button>' +
            '<button class="btn btn--ghost btn--sm" data-qb="cat-rename" data-id="' + esc(c.id) + '">' + icon('edit') + '<span>Rename</span></button>' +
            '<button class="btn btn--ghost btn--sm qb-danger" data-qb="cat-delete" data-id="' + esc(c.id) + '" aria-label="Delete ' + esc(c.name) + '">' + icon('trash') + '<span>Delete</span></button></div>') +
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
    var ren = el('qbCatRen');
    if (ren) { ren.focus(); ren.select(); }
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

  /* ----------------------------------------------- Quick Product Add / Edit */
  function openProductForm(mode, id, prefill) {
    var p = mode === 'edit' ? productById(id) : null;
    var lastCat = store('mpf.qb.lastcat');
    var cat = p ? p.categoryId
      : (S.filter.cat !== 'all' && S.filter.cat !== 'frequent' && catById(S.filter.cat)) ? S.filter.cat
      : (lastCat && catById(lastCat)) ? lastCat
      : (S.categories[0] && S.categories[0].id) || '';
    S.sheet = {
      type: 'product', mode: mode, id: p ? p.id : API.newId('p_'),
      img: null, removeImage: false, busy: false, fromLine: prefill && prefill.lineKey || null, added: 0
    };
    var v = {
      name: p ? p.name : (prefill && prefill.name) || '',
      price: p ? M.toInput(p.pricePaise) : (prefill && prefill.price) || '',
      qty: p ? String(p.qty) : (prefill && prefill.qty ? String(prefill.qty) : '1'),
      shelf: p ? p.shelf : '', sku: p ? p.sku : '', low: p ? String(p.lowStockAt) : '1'
    };
    openSheet('product', productFormHTML(mode, p, v, cat), mode === 'edit' ? 'Edit product' : 'Quick Product Add');
    var first = el('qbFName');
    if (first && mode !== 'edit' && !isTouch()) first.focus();
  }
  function isTouch() { return global.matchMedia && global.matchMedia('(pointer: coarse)').matches; }

  function productFormHTML(mode, p, v, cat) {
    var hasCats = S.categories.length > 0;
    var photo = p && p.imageUrl ? p.imageUrl : '';
    return '<div class="sheet__grab"></div>' +
      '<div class="sheet__head"><h3 class="t-h3 grow">' + (mode === 'edit' ? 'Edit product' : 'Quick Product Add') + '</h3>' +
      '<button class="iconbtn" data-qb="close-sheet" aria-label="Close">' + icon('close') + '</button></div>' +
      '<form class="sheet__body qb-form" id="qbProdForm" data-qbf="product" novalidate>' +
      '<div class="qb-ok" id="qbFDone" hidden></div>' +
      '<div class="qb-photo">' +
      '<div class="qb-photo__box" id="qbFPhoto">' + (photo ? '<img src="' + esc(photo) + '" alt="" />' : icon('camera')) + '</div>' +
      '<div class="qb-photo__acts"><span class="qb-lab">Photo <em>(optional)</em></span>' +
      '<label class="btn btn--outline btn--sm qb-file">' + icon('camera') + '<span id="qbFPhotoBtn">' + (photo ? 'Change photo' : 'Add photo') + '</span>' +
      '<input type="file" accept="image/*" id="qbPhoto" data-qbi="photo" /></label>' +
      '<button type="button" class="qb-link" data-qb="photo-remove" id="qbFPhotoRm"' + (photo ? '' : ' hidden') + '>Remove</button></div></div>' +
      fieldHTML('qbFName', 'name', 'Product name', true, '<input class="input qb-in" id="qbFName" name="name" maxlength="80" autocomplete="off" placeholder="e.g. Redmi 13C Tempered Glass" value="' + esc(v.name) + '" />') +
      '<div class="qb-form__row">' +
      fieldHTML('qbFPrice', 'price', 'Selling price', true, '<label class="qb-prefix"><span>₹</span><input class="input qb-in" id="qbFPrice" name="price" inputmode="decimal" autocomplete="off" placeholder="0.00" value="' + esc(v.price) + '" /></label>') +
      fieldHTML('qbFQty', 'qty', mode === 'edit' ? 'Quantity in stock' : 'Quantity', true, '<div class="qb-qty qb-qty--form"><button type="button" data-qb="fqty-dec" aria-label="Decrease">' + icon('minus') + '</button>' +
        '<input class="qb-qty__in" id="qbFQty" name="qty" inputmode="numeric" autocomplete="off" value="' + esc(v.qty) + '" />' +
        '<button type="button" data-qb="fqty-inc" aria-label="Increase">' + icon('plus') + '</button></div>') +
      '</div>' +
      fieldHTML('qbFCat', 'cat', 'Category', true,
        (hasCats
          ? '<select class="input qb-in" id="qbFCat" name="cat" data-qbi="fcat">' +
            S.categories.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === cat ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') +
            '<option value="__new">+ New category…</option></select>'
          : '') +
        '<input class="input qb-in" id="qbFNewCat" name="newCat" maxlength="40" autocomplete="off" list="qbSuggestList" placeholder="New category, e.g. Tempered Glass"' + (hasCats ? ' hidden' : '') + ' />' +
        '<datalist id="qbSuggestList">' + (S.suggested || []).map(function (n) { return '<option value="' + esc(n) + '"></option>'; }).join('') + '</datalist>') +
      '<div class="qb-form__row">' +
      fieldHTML('qbFShelf', 'shelf', 'Shelf location', false, '<input class="input qb-in" id="qbFShelf" name="shelf" maxlength="24" autocomplete="off" placeholder="e.g. A3 or Drawer 2" value="' + esc(v.shelf) + '" />') +
      fieldHTML('qbFSku', 'sku', 'SKU / barcode', false, '<input class="input qb-in" id="qbFSku" name="sku" maxlength="40" autocomplete="off" placeholder="Optional" value="' + esc(v.sku) + '" />') +
      '</div>' +
      fieldHTML('qbFLow', 'low', 'Low-stock alert at', false, '<input class="input qb-in qb-in--qty" id="qbFLow" name="low" inputmode="numeric" autocomplete="off" value="' + esc(v.low) + '" /><small class="qb-help">Flagged “low” when stock is at or below this.</small>') +
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
    var price = M.parseRupees(val('qbFPrice'));
    var qtyT = val('qbFQty').trim();
    var qty = /^\d{1,6}$/.test(qtyT) ? Number(qtyT) : null;
    var lowT = val('qbFLow').trim();
    var low = lowT === '' ? 1 : (/^\d{1,6}$/.test(lowT) ? Number(lowT) : null);
    var sel = el('qbFCat');
    var newCatBox = el('qbFNewCat');
    var useNew = !sel || sel.value === '__new';
    var catId = useNew ? '' : sel.value;
    var newCat = useNew && newCatBox ? newCatBox.value.replace(/\s+/g, ' ').trim() : '';

    var bad = [];
    formError('name', name ? '' : (bad.push('qbFName'), 'Enter a product name'));
    formError('price', price && price > 0 ? '' : (bad.push('qbFPrice'), 'Enter a selling price, e.g. 199 or 199.50'));
    formError('qty', qty != null ? '' : (bad.push('qbFQty'), 'Enter a whole number, 0 or more'));
    formError('cat', catId || newCat ? '' : (bad.push(useNew ? 'qbFNewCat' : 'qbFCat'), 'Choose or name a category'));
    formError('low', low != null ? '' : (bad.push('qbFLow'), 'Enter a whole number'));
    if (bad.length) { var f = el(bad[0]); if (f) f.focus(); return; }

    var body = {
      action: sh.mode === 'edit' ? 'update' : 'create',
      productId: sh.id, name: name, pricePaise: price, qty: qty,
      shelf: val('qbFShelf'), sku: val('qbFSku'), lowStockAt: low
    };
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
        ['qbFName', 'qbFPrice', 'qbFShelf', 'qbFSku'].forEach(function (id) { var n = el(id); if (n) n.value = ''; });
        var q = el('qbFQty'); if (q) q.value = '1';
        if (sel && r.category) {
          var o = document.createElement('option'); o.value = r.category.id; o.textContent = r.category.name;
          sel.insertBefore(o, sel.querySelector('option[value="__new"]'));
          sel.value = r.category.id;
          if (newCatBox) { newCatBox.hidden = true; newCatBox.value = ''; }
        }
        resetPhoto();
        var done = el('qbFDone');
        if (done) { done.hidden = false; done.innerHTML = icon('checkCircle') + '<span>' + sh.added + (sh.added === 1 ? ' product' : ' products') + ' added. Add the next one.</span>'; }
        setFormBusy(false);
        var nm = el('qbFName'); if (nm) nm.focus();
      } else {
        toast(sh.mode === 'edit' ? 'Product updated' : 'Added “' + r.product.name + '”', 'checkCircle');
        closeSheet();
      }
      softAfterProductChange();
    }, function (err) {
      sh.busy = false;
      setFormBusy(false);
      var done = el('qbFDone');
      if (done) { done.hidden = false; done.className = 'qb-ok qb-ok--bad'; done.innerHTML = icon('alert') + '<span>' + esc(say(err)) + '</span>'; }
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
    } else if (v === 'products') rerender();
    else if (v === 'categories') rerender();
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
    var p = S.sheet && S.sheet.mode === 'edit' && !S.sheet.removeImage ? productById(S.sheet.id) : null;
    if (box) box.innerHTML = p && p.imageUrl ? '<img src="' + esc(p.imageUrl) + '" alt="" />' : icon('camera');
    var rm = el('qbFPhotoRm'); if (rm) rm.hidden = !(p && p.imageUrl);
    var btn = el('qbFPhotoBtn'); if (btn) btn.textContent = p && p.imageUrl ? 'Change photo' : 'Add photo';
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
        '<span>' + esc(when(m.at)) + (m.note ? ' · ' + esc(m.note) : '') + '</span></span>' +
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
    API.product({ action: 'adjust', productId: sh.id, adjustId: sh.adjustId, delta: delta, note: note }).then(function (r) {
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

  /* ------------------------------------------------------- labels sheet */
  function labelEntriesFromBill(b) {
    return (b.items || []).map(function (it) {
      var p = it.productId ? productById(it.productId) : null;
      return { name: it.name, pricePaise: p ? p.pricePaise : it.unitPaise, shelf: p ? p.shelf : it.shelf, sku: p ? p.sku : it.sku, count: it.qty, custom: !it.productId };
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
      S.bills.loaded = false;
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
      S.bills.loaded = false;
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

  /* ---------------------------------------------------- category actions */
  function catRequest(body, okMsg) {
    return API.category(body).then(function (r) {
      if (r.category) upsertCategory(r.category);
      (r.created || []).forEach(upsertCategory);
      if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'checkCircle');
      S.editingCat = null;
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
        if (px) addToCart(px);
      }
      return;
    }
    var a = t.getAttribute('data-qb');
    var id = t.getAttribute('data-id');
    var line = id && S.cart ? lineByKey(id) : null;

    switch (a) {
      case 'sign-in': ctx.signIn(); break;
      case 'reload': S.loadError = null; rerender(); break;
      case 'add': { var p = productById(id); if (p) addToCart(p); break; }
      case 'cat': S.filter.cat = id; paintCatalog(); break;
      case 'qty-inc':
        if (line) {
          var pp = line.productId && productById(line.productId);
          if (pp && inCart(pp.id) >= pp.qty) { toast('Only ' + pp.qty + ' of “' + pp.name + '” in stock', 'alert'); break; }
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
      case 'cat-rename': S.editingCat = id; rerender(); break;
      case 'cat-cancel': S.editingCat = null; rerender(); break;
      case 'cat-up': moveCat(id, -1); break;
      case 'cat-down': moveCat(id, 1); break;
      case 'cat-delete': openCatDelete(id); break;
      case 'cat-delete-go': submitCatDelete(); break;
      case 'cat-view': S.prodFilter.cat = id; S.prodFilter.show = 'active'; go('/billing/products'); break;
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
      case 'cname': c.customer.name = t.value; cartChanged(false); break;
      case 'cmobile': c.customer.mobile = t.value; cartChanged(false); break;
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
        var p = l && l.productId && productById(l.productId);
        if (p && inCart(p.id) > p.qty) toast('Only ' + p.qty + ' of “' + p.name + '” in stock', 'alert');
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
    else if (k === 'cat-new') {
      var n = el('qbNewCat');
      var name = n ? n.value.replace(/\s+/g, ' ').trim() : '';
      if (!name) { if (n) n.focus(); return; }
      catRequest({ action: 'create', name: name }, 'Category “' + name + '” added');
    } else if (k === 'cat-rename') {
      var r = el('qbCatRen');
      var nn = r ? r.value.replace(/\s+/g, ' ').trim() : '';
      if (!nn) return;
      catRequest({ action: 'rename', categoryId: f.getAttribute('data-id'), name: nn }, 'Renamed');
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
