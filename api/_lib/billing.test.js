/* ============================================================================
   Mobile Parts Finder · api/_lib/billing.test.js
   ----------------------------------------------------------------------------
   The parts of the payment system that can be proven without a Razorpay
   account: signature verification, expiry arithmetic, plan/amount validation.

   Everything here is real. The HMACs are computed with node:crypto against a
   synthetic secret, exactly as Razorpay computes them, so a passing test means
   the verification code is correct — not that it was stubbed out.

   What these tests deliberately do NOT cover: an actual payment. That needs
   live test-mode keys in the deployment. See docs/RAZORPAY.md for the
   end-to-end checklist that picks up where this file stops.

       node --test api/_lib/billing.test.js
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { verifyCheckoutSignature, verifyWebhookSignature, hmacHex } =
  require('./razorpay-signature');
const { addMonths, periodFor, isActive, derive } = require('./billing-period');
const { getPlan, amountMatches, publicCatalogue } = require('./plans');

const SECRET = 'test_secret_do_not_use_in_production';
const utc = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h);

/* ========================================================== checkout signature */
test('checkout signature accepts what Razorpay would really send', () => {
  const orderId = 'order_ABC123';
  const paymentId = 'pay_XYZ789';
  const signature = crypto.createHmac('sha256', SECRET)
    .update(`${orderId}|${paymentId}`).digest('hex');

  assert.equal(verifyCheckoutSignature({ orderId, paymentId, signature, secret: SECRET }), true);
});

test('checkout signature rejects a tampered payment id', () => {
  const orderId = 'order_ABC123';
  const signature = hmacHex(`${orderId}|pay_XYZ789`, SECRET);

  /* the attacker swaps in a payment they made against a cheaper order */
  assert.equal(verifyCheckoutSignature({
    orderId, paymentId: 'pay_SOMEONE_ELSE', signature, secret: SECRET
  }), false);
});

test('checkout signature rejects a forged signature and the wrong secret', () => {
  const orderId = 'order_ABC123';
  const paymentId = 'pay_XYZ789';

  assert.equal(verifyCheckoutSignature({
    orderId, paymentId, signature: 'f'.repeat(64), secret: SECRET
  }), false);

  assert.equal(verifyCheckoutSignature({
    orderId, paymentId,
    signature: hmacHex(`${orderId}|${paymentId}`, 'a_different_secret'),
    secret: SECRET
  }), false);
});

test('checkout signature rejects missing pieces rather than throwing', () => {
  for (const bad of [
    { orderId: '', paymentId: 'p', signature: 's', secret: SECRET },
    { orderId: 'o', paymentId: '', signature: 's', secret: SECRET },
    { orderId: 'o', paymentId: 'p', signature: '', secret: SECRET },
    { orderId: 'o', paymentId: 'p', signature: 's', secret: '' }
  ]) {
    assert.equal(verifyCheckoutSignature(bad), false);
  }
});

/* =========================================================== webhook signature */
test('webhook signature verifies against the RAW body', () => {
  const rawBody = JSON.stringify({ event: 'payment.captured', payload: { x: 1 } });
  const signature = hmacHex(rawBody, SECRET);

  assert.equal(verifyWebhookSignature({ rawBody, signature, secret: SECRET }), true);
  assert.equal(verifyWebhookSignature({ rawBody: Buffer.from(rawBody), signature, secret: SECRET }), true);
});

test('webhook signature fails once the body is re-serialised', () => {
  /* This is the classic bug: parse the JSON, stringify it again, and the key
     order or spacing shifts. Same data, different bytes, different digest. */
  const rawBody = '{"event":"payment.captured","payload":{"a":1,"b":2}}';
  const signature = hmacHex(rawBody, SECRET);
  const reSerialised = JSON.stringify(JSON.parse('{"payload":{"b":2,"a":1},"event":"payment.captured"}'));

  assert.equal(verifyWebhookSignature({ rawBody: reSerialised, signature, secret: SECRET }), false);
});

/* ============================================================== expiry arithmetic */
test('monthly expiry lands on the same day of the next month', () => {
  const now = utc(2026, 3, 15);
  const { startedAt, expiresAt } = periodFor({ now, periodMonths: 1 });

  assert.equal(startedAt, now);
  assert.equal(new Date(expiresAt).toISOString().slice(0, 10), '2026-04-15');
});

test('yearly expiry lands on the same day next year', () => {
  const now = utc(2026, 3, 15);
  const { expiresAt } = periodFor({ now, periodMonths: 12 });
  assert.equal(new Date(expiresAt).toISOString().slice(0, 10), '2027-03-15');
});

test('a 31st clamps to the last day of a shorter month, and does not roll over', () => {
  assert.equal(new Date(addMonths(utc(2026, 1, 31), 1)).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(new Date(addMonths(utc(2028, 1, 31), 1)).toISOString().slice(0, 10), '2028-02-29');
  assert.equal(new Date(addMonths(utc(2026, 5, 31), 1)).toISOString().slice(0, 10), '2026-06-30');
});

test('29 February renews to 28 February in a common year', () => {
  assert.equal(new Date(addMonths(utc(2028, 2, 29), 12)).toISOString().slice(0, 10), '2029-02-28');
});

test('renewing early extends from the existing expiry, not from today', () => {
  const now = utc(2026, 3, 10);
  const currentExpiresAt = utc(2026, 3, 20);          /* 10 days still paid for */

  const { expiresAt, extendedFromExisting } = periodFor({ now, periodMonths: 1, currentExpiresAt });

  assert.equal(extendedFromExisting, true);
  assert.equal(new Date(expiresAt).toISOString().slice(0, 10), '2026-04-20');
});

test('renewing after a lapse starts from today, not from the stale expiry', () => {
  const now = utc(2026, 6, 1);
  const currentExpiresAt = utc(2026, 3, 20);          /* lapsed in March */

  const { expiresAt, extendedFromExisting } = periodFor({ now, periodMonths: 1, currentExpiresAt });

  assert.equal(extendedFromExisting, false);
  assert.equal(new Date(expiresAt).toISOString().slice(0, 10), '2026-07-01');
});

test('periodFor refuses nonsense rather than inventing a period', () => {
  assert.throws(() => periodFor({ now: NaN, periodMonths: 1 }));
  assert.throws(() => periodFor({ now: Date.now(), periodMonths: 0 }));
  assert.throws(() => periodFor({ now: Date.now(), periodMonths: 1.5 }));
});

/* ================================================================ access state */
test('access is granted only while an active subscription has not expired', () => {
  const now = utc(2026, 3, 15);
  assert.equal(isActive({ status: 'active', expiresAt: now + 1000 }, now), true);
  assert.equal(isActive({ status: 'active', expiresAt: now - 1000 }, now), false);
  assert.equal(isActive({ status: 'pending', expiresAt: now + 1000 }, now), false);
  assert.equal(isActive({ status: 'cancelled', expiresAt: now + 1000 }, now), false);
  assert.equal(isActive(null, now), false);
});

test('a cancelled subscription still runs to the date it was paid for', () => {
  const now = utc(2026, 3, 15);
  assert.equal(derive({ status: 'cancelled', expiresAt: now + 86400000 }, now), 'cancelling');
  assert.equal(derive({ status: 'cancelled', expiresAt: now - 86400000 }, now), 'expired');
  assert.equal(derive({ status: 'active', expiresAt: now - 1 }, now), 'expired');
  assert.equal(derive(null, now), 'none');
});

/* ============================================================ plans and amounts */
test('only known, active plans resolve', () => {
  assert.equal(getPlan('monthly').amountPaise, 9900);
  assert.equal(getPlan('yearly').amountPaise, 79900);
  assert.equal(getPlan('free'), null);
  assert.equal(getPlan('MONTHLY'), null);            /* ids are case sensitive */
  assert.equal(getPlan(''), null);
  assert.equal(getPlan(null), null);
  assert.equal(getPlan({ id: 'monthly' }), null);    /* no object smuggling */
});

test('the amount is checked against the catalogue, not against the request', () => {
  const monthly = getPlan('monthly');
  assert.equal(amountMatches(monthly, 9900, 'INR'), true);
  assert.equal(amountMatches(monthly, 100, 'INR'), false);      /* paid ₹1 for ₹99 */
  assert.equal(amountMatches(monthly, 9900, 'USD'), false);     /* wrong currency */
  assert.equal(amountMatches(getPlan('yearly'), 9900, 'INR'), false); /* monthly price, yearly plan */
});

test('the public catalogue exposes prices but no internal fields', () => {
  const list = publicCatalogue();
  assert.equal(list.length, 2);
  for (const p of list) {
    assert.ok(p.id && p.amountPaise && p.amountDisplay);
    assert.equal('active' in p, false);
  }
});
