# Razorpay billing — setup and test plan

Everything in `api/` is written and the security-critical logic is covered by
tests that pass today. What is **not** done is anything needing your accounts:
the credentials, and the end-to-end payment runs that need them.

You set the credentials yourself, in the Vercel dashboard. They should never be
pasted into a chat, a file, or a commit — including to me.

---

## 1. What is already true

| | |
|---|---|
| `api/create-order` | creates an order priced from the server catalogue |
| `api/verify-payment` | verifies the signature, then activates |
| `api/razorpay-webhook` | verifies the webhook signature, reconciles |
| `api/subscription` | server-authoritative access check |
| `api/cancel-subscription` | stops renewal, keeps paid-for access |
| `api/plans` | public pricing, same source as the charge |

`node --test api/_lib/billing.test.js` — 18 tests, all passing. They cover
signature verification (genuine, forged, tampered, wrong secret, re-serialised
body), calendar-month expiry including 31st→28th/29th clamping, early renewal
extending from the existing expiry, lapsed renewal starting fresh, access
derivation, and plan/amount validation.

---

## 2. Credentials you need to set

**Vercel → mobile-parts-finder → Settings → Environment Variables.** Add each to
Production, Preview and Development, then redeploy — a function only picks up an
environment variable on a new deployment.

Names are in `.env.example`. Values come from:

- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` — Razorpay Dashboard → Settings →
  API Keys. **Start with `rzp_test_*`.**
- `RAZORPAY_WEBHOOK_SECRET` — Dashboard → Settings → Webhooks. A *separate*
  string you choose when creating the webhook.
  - URL: `https://www.mobilepartsfinder.com/api/razorpay-webhook`
  - Events: `payment.captured`, `payment.authorized`, `payment.failed`, `order.paid`
- `FIREBASE_SERVICE_ACCOUNT` — Firebase console → Project settings → Service
  accounts → Generate new private key. Paste the whole JSON as one value. If the
  dashboard mangles the private key's newlines, base64 the file and use
  `FIREBASE_SERVICE_ACCOUNT_B64` instead; the code accepts either.

Then the **public** Firebase web config, which goes in
`src/data/firebase.js` (`FIREBASE_CONFIG`), not in an environment variable —
it ships to the browser by design. Firebase console → Project settings →
General → Your apps → SDK setup.

Also add `www.mobilepartsfinder.com` under **Authentication → Settings →
Authorised domains**, or the Google popup closes instantly with
`auth/unauthorized-domain`.

---

## 3. Why a browser cannot grant itself a subscription

Five checks, in order, in `api/verify-payment.js`:

1. **Caller is a real Firebase user.** Identity comes from a verified ID token,
   never from a uid in the body.
2. **Signature is genuine** — HMAC over `order_id|payment_id` with the key
   secret, which exists only on the server.
3. **The order is ours, and is this user's.** This is what stops the
   substitution attack: pay ₹99 for your own monthly order, then replay that
   valid pair against someone's yearly order. The signature is real, so checks
   1 and 2 pass; the uid stored on the order refuses it.
4. **The amount matches the catalogue** — read from Razorpay's own record of the
   payment, not from the request body.
5. **Only then** does access change.

The price is never sent by the client. `{ planId: "monthly", amount: 1 }` still
creates a ₹99 order, because `amount` is not read.

**Duplicates.** The browser posts the payment to `/api/verify-payment` and
Razorpay posts the same payment to the webhook. Both call the same activation,
which runs in a Firestore transaction keyed on `payments/{razorpayPaymentId}`.
Whichever arrives first activates; the rest read the existing record and report
`alreadyProcessed`. One ₹99 payment cannot buy two months.

---

## 4. Test plan — Razorpay test mode

Run these before switching to live keys. Test cards are at
<https://razorpay.com/docs/payments/payments/test-card-details/>.

| # | Test | Expected |
|---|---|---|
| 1 | Successful payment (`4111 1111 1111 1111`) | Button: Preparing → Opening → Verifying → "Payment verified". `users/{uid}` shows `active` with the right expiry. |
| 2 | Failed payment (use a failure card) | Toast reports the failure. Button returns to normal. **No** change to access. |
| 3 | Close the Checkout sheet | "Payment cancelled". Button returns to normal. Nothing written. |
| 4 | Verification failure | Temporarily set a wrong `RAZORPAY_KEY_SECRET`, pay. Expect 403 and no activation. **Restore the key afterwards.** |
| 5 | Duplicate webhook | Redeliver the same event from the Razorpay dashboard. Response says `alreadyProcessed: true`; `expiresAt` does **not** move. |
| 6 | Monthly expiry | Pay monthly, check `subscriptionExpiresAt` is the same day next month. |
| 7 | Yearly expiry | Same day next year. |
| 8 | Early renewal | Pay again before expiry. New expiry = old expiry + period, not today + period. |
| 9 | Signed-out | `/api/create-order` returns 401. |
| 10 | Tampered amount | Post `{planId:"yearly", amount:100}`. Order is still ₹799. |
| 11 | Expiry enforcement | Set `subscriptionExpiresAt` to the past in Firestore, reload. Access drops to expired; the stored status is rewritten. |

**Before going live:** swap `rzp_test_*` for `rzp_live_*`, create a **new**
webhook against the live mode with its own secret, update
`RAZORPAY_WEBHOOK_SECRET`, redeploy, and make one small real payment.

---

## 5. Firestore rules

`firestore.rules` already closes `users/{uid}/billing` to clients. The new
top-level collections need the same treatment before go-live — `subscriptions`
and `payments` must be **server-write-only**, readable only by their owner:

```
match /subscriptions/{id} {
  allow read: if request.auth != null && resource.data.uid == request.auth.uid;
  allow write: if false;          // Admin SDK only
}
match /payments/{id} {
  allow read: if request.auth != null && resource.data.uid == request.auth.uid;
  allow write: if false;
}
```

Deploy with `firebase deploy --only firestore:rules`.

---

## 6. What I could not test

Anything that needs a real Razorpay account or a live Firebase service account:
an actual Checkout run, a real webhook delivery, and Firestore writes. Those are
items 1–11 above, and they are yours to run once the credentials are set.

The parts that do not need credentials — signature verification, expiry maths,
plan and amount validation, idempotency logic — are tested and passing.
