/* ============================================================================
   src/data/shop-share.test.js
   ----------------------------------------------------------------------------
   The WhatsApp link and message, and the PDF writer. The PDF is checked the way
   a reader opens one: from the end of the file, through the cross-reference
   table, to objects that have to be where the table says.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./shop-share');
const Pdf = require('./shop-pdf');

test('a number becomes what WhatsApp accepts', () => {
  assert.equal(S.whatsappNumber('98765 43210'), '919876543210');
  assert.equal(S.whatsappNumber('098765-43210'), '919876543210');
  assert.equal(S.whatsappNumber('+91 98765 43210'), '919876543210');
  assert.equal(S.whatsappNumber('919876543210'), '919876543210');
  assert.equal(S.whatsappNumber('+1 415 555 2671'), '14155552671', 'a foreign number keeps its code');
  assert.equal(S.whatsappNumber('12345'), '');
  assert.equal(S.whatsappNumber(''), '');
  assert.equal(S.whatsappNumber(null), '');
});

test('the link opens WhatsApp with the message and sends nothing', () => {
  const url = S.whatsappUrl('919876543210', 'Total: ₹299 & more');
  assert.equal(url, 'https://wa.me/919876543210?text=Total%3A%20%E2%82%B9299%20%26%20more');
  assert.ok(S.whatsappUrl('', 'Hi').startsWith('https://wa.me/?text='), 'no number lets the shop choose');
});

test('the message carries the saved figures', () => {
  const text = S.invoiceMessage({
    customerName: 'Ravi Kumar', shopName: 'Ozo', number: 'QB-0007',
    total: '₹598.00', paid: '₹500.00', balance: '₹98.00', url: 'https://x.test/i/abc'
  });
  assert.ok(text.startsWith('Hello Ravi Kumar,'));
  ['Thank you for shopping with Ozo.', 'QB-0007', 'Invoice Total: ₹598.00', 'Amount Paid: ₹500.00',
    'Balance Due: ₹98.00', 'https://x.test/i/abc'].forEach(part => assert.ok(text.includes(part), part));
});

test('with no link there is no link line, and no name means no name', () => {
  const text = S.invoiceMessage({ shopName: 'Ozo', number: 'QB-1', total: '₹1', paid: '₹1', balance: '₹0' });
  assert.ok(text.startsWith('Hello,'));
  assert.equal(text.includes('View your invoice'), false);
});

function latin1(bytes) { return Buffer.from(bytes).toString('latin1'); }

test('the PDF is well formed from the cross-reference table down', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 0xff, 0xd9]);
  const pdf = Pdf.pdfFromJpegs([
    { bytes: jpeg, width: 1240, height: 1754 },
    { bytes: jpeg, width: 1240, height: 1754 }
  ], 'Invoice QB-0001');
  const text = latin1(pdf);

  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.ok(text.includes('/Count 2'));
  assert.ok(text.includes('/Title (Invoice QB-0001)'));
  assert.equal(text.match(/\/Type \/Page /g).length, 2);
  assert.equal(text.match(/\/Filter \/DCTDecode/g).length, 2);

  const start = Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]);
  assert.ok(text.slice(start).startsWith('xref\n'));
  const entries = text.slice(start).split('\n').filter(l => /^\d{10} \d{5} n $/.test(l));
  assert.equal(entries.length, 9, 'three shared objects and three for each page');
  entries.forEach((line, i) => {
    const at = Number(line.slice(0, 10));
    assert.ok(text.slice(at).startsWith((i + 1) + ' 0 obj\n'), 'object ' + (i + 1) + ' is where the table says');
  });
});

test('the image data is stored untouched, at the length declared', () => {
  const jpeg = new Uint8Array(256).map((_, i) => i);
  const pdf = Pdf.pdfFromJpegs([{ bytes: jpeg, width: 10, height: 10 }]);
  const text = latin1(pdf);
  const declared = Number(/\/Filter \/DCTDecode \/Length (\d+)/.exec(text)[1]);
  assert.equal(declared, 256);
  const from = text.indexOf('stream\n') + 'stream\n'.length;
  assert.deepEqual(Array.from(pdf.slice(from, from + declared)), Array.from(jpeg));
});

test('a title cannot break out of its string', () => {
  const pdf = Pdf.pdfFromJpegs([{ bytes: new Uint8Array([1]), width: 1, height: 1 }], 'A (b) \\ தமிழ்');
  assert.ok(latin1(pdf).includes('/Title (A \\(b\\) \\\\ )'));
});
