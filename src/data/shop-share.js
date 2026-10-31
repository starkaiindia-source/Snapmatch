/* ============================================================================
   Mobile Parts Finder · shop-share.js — sending an invoice over WhatsApp
   ----------------------------------------------------------------------------
   What the Share button needs and nothing else: a number WhatsApp will accept,
   the message, and the click-to-chat link. The link only opens WhatsApp with
   the message filled in. Whoever is at the counter presses send, and nothing
   here can send anything by itself.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SM = root.SM || {}).shopShare = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /**
   * A number as WhatsApp wants it: country code and digits, nothing else. A
   * shop here types ten digits, so those are taken as Indian.
   *
   * @returns {string} '' when it cannot be a phone number
   */
  function whatsappNumber(raw) {
    var d = String(raw == null ? '' : raw).replace(/\D/g, '').replace(/^0+/, '');
    if (d.length === 10) return '91' + d;
    return d.length >= 11 && d.length <= 15 ? d : '';
  }

  /** Click-to-chat. Without a number WhatsApp asks who to send it to. */
  function whatsappUrl(number, text) {
    return 'https://wa.me/' + (number || '') + '?text=' + encodeURIComponent(text || '');
  }

  /**
   * The message, from the saved bill. A line that would be untrue is left out:
   * no link line without a working link, no greeting by a name nobody gave.
   *
   * @param {{customerName?:string, shopName:string, number:string, total:string,
   *          paid:string, balance:string, url?:string}} i  amounts already formatted
   */
  function invoiceMessage(i) {
    var lines = [
      i.customerName ? 'Hello ' + i.customerName + ',' : 'Hello,',
      '',
      'Thank you for shopping with ' + i.shopName + '.',
      '',
      'Your invoice ' + i.number + ' is ready.',
      '',
      'Invoice Total: ' + i.total,
      'Amount Paid: ' + i.paid,
      'Balance Due: ' + i.balance
    ];
    if (i.url) lines.push('', 'View your invoice:', i.url);
    lines.push('', 'Thank you for your purchase!');
    return lines.join('\n');
  }

  return { whatsappNumber: whatsappNumber, whatsappUrl: whatsappUrl, invoiceMessage: invoiceMessage };
});
