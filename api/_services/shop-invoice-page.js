/* ============================================================================
   api/_services/shop-invoice-page.js — the page behind a shared invoice link
   ----------------------------------------------------------------------------
   What a customer sees when they open the link from WhatsApp. It is built here,
   field by field, from the saved bill, so what a bill holds for the shop alone
   (cost prices, list prices, the shelf, its history) cannot reach this page by
   being forgotten: only what is named below is ever written out.

   There is no account behind this page and nothing on it links to anything else.
   ========================================================================== */
'use strict';

const money = require('../../src/data/shop-money');

const METHODS = { cash: 'Cash', upi: 'UPI', card: 'Card', other: 'Other' };
const STATUSES = { unpaid: 'Unpaid', partial: 'Partially Paid', paid: 'Paid' };

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function when(ms) {
  return new Date(ms).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata'
  });
}

const STYLE = `
*{box-sizing:border-box}
body{margin:0;padding:16px;background:#F1F3F2;color:#0B1412;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif}
main{max-width:720px;margin:0 auto;padding:20px;background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.12);position:relative}
header{display:flex;justify-content:space-between;gap:16px;padding-bottom:12px;border-bottom:2px solid #0B1412}
h1{margin:0;font-size:21px;line-height:1.2}
.dim{display:block;color:#5B6B67;font-size:13px}
.meta{text-align:right;flex:none}
.meta b{letter-spacing:.12em;font-size:13px}
.to{padding:10px 0;border-bottom:1px solid #D9E0DE}
.lab{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#5B6B67}
table{width:100%;border-collapse:collapse;margin:8px 0}
th{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#5B6B67;text-align:left;padding:6px 4px;border-bottom:1px solid #D9E0DE}
td{padding:7px 4px;border-bottom:1px solid #D9E0DE;vertical-align:top}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.totals{margin-left:auto;width:min(100%,300px)}
.t{display:flex;justify-content:space-between;gap:12px;padding:2px 0}
.grand{border-top:2px solid #0B1412;margin-top:4px;padding-top:6px;font-weight:800;font-size:18px}
.due b{color:#B42318}
.pay{margin-top:8px;text-align:right;color:#5B6B67;font-size:13px}
footer{margin-top:14px;padding-top:10px;border-top:1px dashed #D9E0DE;text-align:center;color:#5B6B67;font-size:13px}
.void{position:absolute;top:38%;left:50%;transform:translate(-50%,-50%) rotate(-18deg);padding:6px 18px;border:4px solid #C0262D;border-radius:10px;color:#C0262D;font-size:44px;font-weight:800;letter-spacing:.12em;opacity:.85;background:rgba(255,255,255,.6)}
.acts{max-width:720px;margin:12px auto 0;text-align:center}
button{height:44px;padding:0 20px;border:0;border-radius:10px;background:#1D4ED8;color:#fff;font:inherit;font-weight:700;cursor:pointer}
@media print{body{background:#fff;padding:0}main{box-shadow:none;max-width:none}.acts{display:none}}
`;

/**
 * @param {object} bill  the saved bill
 * @param {{name:string, place?:string, mobile?:string, gstin?:string}} shop
 * @returns {string} a whole HTML document
 */
function invoicePage(bill, shop) {
  const c = bill.customer || {};
  const pay = bill.payment || {};
  const tax = bill.tax || {};
  const paid = Math.min(pay.receivedPaise || 0, bill.totalPaise || 0);

  const rows = (bill.items || []).map(it => {
    const name = it.name + (it.variantLabel ? ' (' + it.variantLabel + ')' : '');
    return '<tr><td><b>' + esc(name) + '</b>' +
      (it.selectedModelName ? '<span class="dim">For ' + esc(it.selectedModelName) + '</span>' : '') + '</td>' +
      '<td class="num">' + esc(it.qty) + '</td>' +
      '<td class="num">' + money.format(it.unitPaise) + '</td>' +
      '<td class="num">' + money.format(it.totalPaise) + '</td></tr>';
  }).join('');

  const t = (label, value, cls) => '<div class="t' + (cls ? ' ' + cls : '') + '"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';

  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow">' +
    '<title>Invoice ' + esc(bill.number) + ' · ' + esc(shop.name) + '</title>' +
    '<style>' + STYLE + '</style></head><body><main>' +
    '<header><div><h1>' + esc(shop.name) + '</h1>' +
    (shop.place ? '<span class="dim">' + esc(shop.place) + '</span>' : '') +
    (shop.mobile ? '<span class="dim">Mobile: ' + esc(shop.mobile) + '</span>' : '') +
    (shop.gstin ? '<span class="dim">GSTIN: ' + esc(shop.gstin) + '</span>' : '') + '</div>' +
    '<div class="meta"><b>INVOICE</b><span class="dim">No. ' + esc(bill.number) + '</span>' +
    '<span class="dim">' + esc(when(bill.createdAt)) + '</span></div></header>' +
    (c.name || c.mobile
      ? '<div class="to"><span class="lab">Bill to</span>' + (c.name ? '<div><b>' + esc(c.name) + '</b></div>' : '') +
        (c.mobile ? '<span class="dim">' + esc(c.mobile) + '</span>' : '') +
        (c.address ? '<span class="dim">' + esc(c.address) + '</span>' : '') +
        (c.gstin ? '<span class="dim">GSTIN: ' + esc(c.gstin) + '</span>' : '') + '</div>'
      : '') +
    '<table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>' +
    '<div class="totals">' + t('Subtotal', money.format(bill.subtotalPaise || 0)) +
    (bill.discountPaise ? t('Discount', '−' + money.format(bill.discountPaise)) : '') +
    (tax.rateBp ? t((tax.label || 'Tax') + ' ' + (tax.rateBp / 100) + '%' + (tax.inclusive ? ' (incl.)' : ''), money.format(bill.taxPaise || 0)) : '') +
    t('Total', money.inr(bill.totalPaise || 0), 'grand') +
    t('Amount paid', money.format(paid)) +
    t('Balance due', money.format(pay.balancePaise || 0), pay.balancePaise ? 'due' : '') + '</div>' +
    '<div class="pay">' + esc(STATUSES[pay.status] || pay.status) + ' · ' + esc(METHODS[pay.method] || pay.method) + '</div>' +
    (bill.status === 'void' ? '<div class="void">VOID</div>' : '') +
    '<footer>Thank you for your purchase</footer></main>' +
    '<div class="acts"><button type="button" onclick="window.print()">Print or save as PDF</button></div>' +
    '</body></html>';
}

module.exports = { invoicePage };
