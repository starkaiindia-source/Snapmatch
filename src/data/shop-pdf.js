/* ============================================================================
   Mobile Parts Finder · shop-pdf.js — an invoice as a PDF file
   ----------------------------------------------------------------------------
   Two halves, and no library. pdfFromJpegs writes the file; it is plain bytes,
   so it runs and is tested without a browser. invoicePages draws the saved bill
   on canvases, one A4 page each.

   WHY PICTURES OF PAGES. A PDF's built-in fonts have no ₹ and no Tamil, and a
   shop's or a customer's name may well be in Tamil. Embedding a font that covers
   them means shipping megabytes for one button. The browser already has fonts
   for all of it, so the page is drawn with those and stored as a JPEG. The text
   cannot be selected, and in exchange it always looks right.

   Everything drawn comes from the saved bill. Nothing is worked out here.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SM = root.SM || {}).shopPdf = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var A4_WIDTH = 595.28, A4_HEIGHT = 841.89;   /* points */

  function bytesOf(text) {
    var out = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }

  /** The title as a PDF string: printable ASCII, with its delimiters escaped. */
  function pdfString(text) {
    return '(' + String(text).replace(/[^\x20-\x7e]/g, '').replace(/([\\()])/g, '\\$1') + ')';
  }

  /**
   * @param {Array<{bytes:Uint8Array, width:number, height:number}>} pages  JPEGs
   * @param {string} [title]
   * @returns {Uint8Array} a complete PDF, one A4 page per image
   */
  function pdfFromJpegs(pages, title) {
    var parts = [];
    var size = 0;
    var offsets = [];
    var push = function (p) {
      var b = typeof p === 'string' ? bytesOf(p) : p;
      parts.push(b);
      size += b.length;
    };
    var object = function (id, write) {
      offsets[id] = size;
      push(id + ' 0 obj\n');
      write();
      push('\nendobj\n');
    };

    var pageId = function (i) { return 4 + i * 3; };
    var kids = pages.map(function (p, i) { return pageId(i) + ' 0 R'; }).join(' ');
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    object(1, function () { push('<< /Type /Catalog /Pages 2 0 R >>'); });
    object(2, function () { push('<< /Type /Pages /Kids [' + kids + '] /Count ' + pages.length + ' >>'); });
    object(3, function () { push('<< /Title ' + pdfString(title || 'Invoice') + ' /Producer (Mobile Parts Finder) >>'); });
    pages.forEach(function (p, i) {
      var id = pageId(i);
      object(id, function () {
        push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + A4_WIDTH + ' ' + A4_HEIGHT + '] ' +
          '/Resources << /XObject << /Im0 ' + (id + 1) + ' 0 R >> >> /Contents ' + (id + 2) + ' 0 R >>');
      });
      object(id + 1, function () {
        push('<< /Type /XObject /Subtype /Image /Width ' + p.width + ' /Height ' + p.height +
          ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.bytes.length + ' >>\nstream\n');
        push(p.bytes);
        push('\nendstream');
      });
      var draw = 'q ' + A4_WIDTH + ' 0 0 ' + A4_HEIGHT + ' 0 0 cm /Im0 Do Q';
      object(id + 2, function () {
        push('<< /Length ' + draw.length + ' >>\nstream\n' + draw + '\nendstream');
      });
    });

    var count = 4 + pages.length * 3;
    var xref = size;
    var table = 'xref\n0 ' + count + '\n0000000000 65535 f \n';
    for (var n = 1; n < count; n++) table += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
    push(table + 'trailer\n<< /Size ' + count + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');

    var out = new Uint8Array(size);
    var at = 0;
    parts.forEach(function (b) { out.set(b, at); at += b.length; });
    return out;
  }

  /* ------------------------------------------------------------ the drawing */
  var W = 1240, H = 1754, MARGIN = 80;
  var FACE = '"Segoe UI", Roboto, "Noto Sans", "Noto Sans Tamil", Arial, sans-serif';
  var INK = '#0B1412', DIM = '#5B6B67', LINE = '#D9E0DE';

  function font(px, bold) { return (bold ? 'bold ' : '') + px + 'px ' + FACE; }

  function newPage() {
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    return { canvas: canvas, g: g };
  }

  function wrap(g, text, width) {
    var out = [], line = '';
    String(text).split(/\s+/).forEach(function (word) {
      var next = line ? line + ' ' + word : word;
      if (line && g.measureText(next).width > width) { out.push(line); line = word; } else line = next;
    });
    if (line) out.push(line);
    return out;
  }

  function put(g, text, x, y, size, opts) {
    opts = opts || {};
    g.font = font(size, opts.bold);
    g.fillStyle = opts.color || INK;
    g.textAlign = opts.align || 'left';
    g.fillText(String(text), x, y);
  }

  function rule(g, y, color, weight) {
    g.fillStyle = color || LINE;
    g.fillRect(MARGIN, y, W - MARGIN * 2, weight || 2);
  }

  /**
   * @param {object} bill  the saved bill
   * @param {{name:string, place?:string, mobile?:string, gstin?:string}} shop
   * @param {{money:function(number):string, when:function(number):string,
   *          method:string, status:string}} words  how amounts and labels read
   * @returns {Array<HTMLCanvasElement>}
   */
  function invoicePages(bill, shop, words) {
    var pages = [];
    var page = newPage();
    pages.push(page);
    var g = page.g;
    var y = MARGIN + 30;
    var right = W - MARGIN;

    var columns = function () {
      put(g, '#', MARGIN, y, 20, { color: DIM, bold: true });
      put(g, 'ITEM', MARGIN + 50, y, 20, { color: DIM, bold: true });
      put(g, 'QTY', right - 400, y, 20, { color: DIM, bold: true, align: 'right' });
      put(g, 'RATE', right - 200, y, 20, { color: DIM, bold: true, align: 'right' });
      put(g, 'AMOUNT', right, y, 20, { color: DIM, bold: true, align: 'right' });
      y += 14;
      rule(g, y);
      y += 34;
    };
    var room = function (need) {
      if (y + need <= H - MARGIN) return;
      page = newPage();
      pages.push(page);
      g = page.g;
      y = MARGIN + 30;
      put(g, 'Invoice ' + bill.number + ' (continued)', MARGIN, y, 22, { color: DIM });
      y += 44;
    };

    /* who it is from, and which invoice */
    put(g, shop.name, MARGIN, y, 38, { bold: true });
    put(g, 'INVOICE', right, y - 4, 26, { bold: true, align: 'right' });
    y += 36;
    put(g, 'No. ' + bill.number, right, y, 22, { color: DIM, align: 'right' });
    put(g, words.when(bill.createdAt), right, y + 30, 22, { color: DIM, align: 'right' });
    [shop.place, shop.mobile ? 'Mobile: ' + shop.mobile : '', shop.gstin ? 'GSTIN: ' + shop.gstin : ''].filter(Boolean).forEach(function (text) {
      g.font = font(22);
      wrap(g, text, 640).forEach(function (l) { put(g, l, MARGIN, y, 22, { color: DIM }); y += 30; });
    });
    y = Math.max(y, MARGIN + 130) + 8;
    rule(g, y, INK, 4);
    y += 40;

    /* who it is for */
    var c = bill.customer || {};
    if (c.name || c.mobile) {
      put(g, 'BILL TO', MARGIN, y, 18, { color: DIM, bold: true });
      y += 32;
      if (c.name) { put(g, c.name, MARGIN, y, 26, { bold: true }); y += 32; }
      [c.mobile, c.address, c.gstin ? 'GSTIN: ' + c.gstin : ''].filter(Boolean).forEach(function (text) {
        g.font = font(22);
        wrap(g, text, W - MARGIN * 2).forEach(function (l) { put(g, l, MARGIN, y, 22, { color: DIM }); y += 30; });
      });
      y += 10;
      rule(g, y);
      y += 40;
    }

    /* what was sold */
    columns();
    (bill.items || []).forEach(function (it, i) {
      var title = it.name + (it.variantLabel ? ' (' + it.variantLabel + ')' : '');
      g.font = font(24, true);
      var lines = wrap(g, title, right - 460 - (MARGIN + 50));
      /* a file goes to the customer, so the shelf stays out of it */
      var extra = [it.selectedModelName ? 'For ' + it.selectedModelName : '', it.sku || ''].filter(Boolean);
      (it.offers || []).forEach(function (o) { extra.push('Offer: ' + words.offer(o)); });
      if (it.offerPaise) extra.push('Discount ' + words.money(it.offerPaise) + ' · Final ' + words.money(it.finalUnitPaise) + ' each');
      room(lines.length * 32 + extra.length * 28 + 30);
      put(g, i + 1, MARGIN, y, 22, { color: DIM });
      put(g, it.qty, right - 400, y, 24, { align: 'right' });
      put(g, words.money(it.unitPaise), right - 200, y, 24, { align: 'right' });
      put(g, words.money(it.totalPaise), right, y, 24, { align: 'right' });
      lines.forEach(function (l) { put(g, l, MARGIN + 50, y, 24, { bold: true }); y += 32; });
      extra.forEach(function (l) { put(g, l, MARGIN + 50, y - 4, 20, { color: DIM }); y += 28; });
      y -= 14;
      rule(g, y);
      y += 38;
    });

    /* what it came to */
    room(400);
    var pay = bill.payment || {};
    var tax = bill.tax || {};
    var row = function (label, value, opts) {
      opts = opts || {};
      var size = opts.size || 24;
      put(g, label, right - 480, y, size, { bold: opts.bold, color: opts.color });
      put(g, value, right, y, size, { bold: opts.bold, align: 'right', color: opts.color });
      y += size + 14;
    };
    row('Subtotal', words.money(bill.originalSubtotalPaise || bill.subtotalPaise || 0));
    if (bill.offerDiscountPaise) row('Product discounts', '−' + words.money(bill.offerDiscountPaise));
    if (bill.discountPaise) row('Additional discount', '−' + words.money(bill.discountPaise));
    if (tax.rateBp) {
      row((tax.label || 'Tax') + ' ' + (tax.rateBp / 100) + '%' + (tax.inclusive ? ' (incl.)' : ''),
        (tax.inclusive ? '' : '+') + words.money(bill.taxPaise || 0));
    }
    g.fillStyle = INK;
    g.fillRect(right - 480, y - 18, 480, 4);
    y += 22;
    row('Total', '₹' + words.money(bill.totalPaise || 0), { size: 32, bold: true });
    if (bill.offerDiscountPaise) row('Total discount', words.money(bill.offerDiscountPaise + (bill.discountPaise || 0)));
    row('Amount paid', words.money(Math.min(pay.receivedPaise || 0, bill.totalPaise || 0)));
    row('Balance due', words.money(pay.balancePaise || 0), pay.balancePaise ? { color: '#B42318', bold: true } : null);
    if (bill.emi) row('Monthly EMI', words.money(bill.emi.emiPaise) + ' x ' + bill.emi.months);
    put(g, words.status + ' · ' + words.method, right, y + 6, 22, { color: DIM, align: 'right' });

    if (bill.status === 'void') {
      g.save();
      g.translate(W / 2, H * 0.42);
      g.rotate(-0.3);
      put(g, 'VOID', 0, 0, 180, { bold: true, color: 'rgba(192,38,45,.55)', align: 'center' });
      g.restore();
    }

    pages.forEach(function (p, i) {
      put(p.g, 'Thank you for your purchase', W / 2, H - 56, 20, { color: DIM, align: 'center' });
      if (pages.length > 1) put(p.g, 'Page ' + (i + 1) + ' of ' + pages.length, right, H - 56, 20, { color: DIM, align: 'right' });
    });
    return pages.map(function (p) { return p.canvas; });
  }

  /** Drawn pages as a PDF file, ready to download or share. */
  function invoiceBlob(bill, shop, words) {
    var pages = invoicePages(bill, shop, words).map(function (canvas) {
      var raw = atob(canvas.toDataURL('image/jpeg', 0.88).split(',')[1]);
      return { bytes: bytesOf(raw), width: canvas.width, height: canvas.height };
    });
    return new Blob([pdfFromJpegs(pages, 'Invoice ' + bill.number)], { type: 'application/pdf' });
  }

  return { pdfFromJpegs: pdfFromJpegs, invoiceBlob: invoiceBlob };
});
