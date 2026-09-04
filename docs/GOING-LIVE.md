# What is code, and what is configuration

Three problems were reported: no profile in Firestore, a phone that returns to
the sign-in page after choosing a Google account, and **Payment server is not
configured yet**.

Two of them were code, and are fixed. One of them is a value only you can set.

| | Cause | Where it is fixed |
|---|---|---|
| Profile missing from Firestore | the document was only ever written when someone completed the sign-up form; every other path wrote nothing | code — `api/profile-sync.js` |
| Phone returns to the sign-in page | redirect sign-in state lives on `authDomain`, a third-party origin phones discard; and the screen painted "signed out" before auth had answered | code — `src/data/firebase.js`, `src/app.js` |
| "Payment server is not configured yet" | `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` are not set on the deployment | **configuration — section 2 below** |

---

## 1. Check what is configured, without guessing

```bash
curl https://www.mobilepartsfinder.com/api/health
```

```json
{
  "ok": false,
  "payments": { "configured": false, "mode": null, "webhook": false },
  "firebaseAdmin": { "configured": true },
  "firebaseWeb": { "configured": true },
  "missing": ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"]
}
```

`missing` names the variables to go and set. The route returns **presence only** —
never a value. The one derived detail is `payments.mode`, read from the key id's
public prefix (`rzp_test_...` / `rzp_live_...`), which is sent to every browser
to open Checkout anyway.

`ok: true` means every route can do its job.

---

## 2. Set the Razorpay keys — the payment error

**Vercel -> mobile-parts-finder -> Settings -> Environment Variables.** Add to
Production, Preview and Development, then **redeploy** — a function only picks
up an environment variable on a new deployment.

| Variable | Where it comes from |
|---|---|
| `RAZORPAY_KEY_ID` | Razorpay Dashboard -> Settings -> API Keys |
| `RAZORPAY_KEY_SECRET` | the same screen, shown once at generation |
| `RAZORPAY_WEBHOOK_SECRET` | Dashboard -> Settings -> Webhooks — a *separate* string you choose |

Start with `rzp_test_*`. Swap to `rzp_live_*` only after section 5 passes.

Webhook URL: `https://www.mobilepartsfinder.com/api/razorpay-webhook`
Events: `payment.captured`, `payment.authorized`, `payment.failed`, `order.paid`

**Do not paste any of these into a chat, a file, or a commit.** The secret never
appears in a response body, in `src/`, or in any log line — and it must never
reach anywhere that it could.

Without the webhook secret, payments still work: the browser's own verified
callback activates the subscription. What you lose is reconciliation — a payment
the browser fails to report will not activate on its own. `/api/health` reports
that as a warning rather than a failure.

---

## 3. Deploy the Firestore rules and indexes

These are **not** deployed by Vercel. They go through the Firebase CLI, and a
rules change that is committed but not deployed changes nothing.

```bash
npx firebase-tools deploy --only firestore:rules,firestore:indexes,storage
```

The `users/{uid}` rules were rewritten. A browser may write its own shop
details; every field about money is refused and belongs to the Admin SDK:

```
subscription, subscriptionStatus, activeSubscriptionStatus, subscriptionPlan,
currentPlanId, currentSubscriptionId, subscriptionStartedAt,
subscriptionExpiresAt, plan, status, role, accountStatus, lastVerifiedAt,
lastLoginAt, emailVerified
```

---

## 4. Where the data actually lives

**Firebase Authentication creating a user does not create anything in
Firestore.** They are separate products. That is why an account could appear
under Authentication -> Users with nothing in the `users` collection.

`POST /api/profile-sync` is what closes that gap. It runs on every sign-in and
every restored session, through the Admin SDK, so no security rule can silently
swallow it.

```
users/{firebase uid}
  uid, email, emailVerified, displayName, googleDisplayName,
  profilePhotoURL, googlePhotoURL, authProvider, accountStatus,
  mobileShopName, proprietorName, mobileNumber, mobileNumberE164,
  country, countryCode, address, profileCompleted,
  subscriptionStatus, subscriptionPlan, currentPlanId,      <- server-written only
  subscriptionStartedAt, subscriptionExpiresAt,             <- server-written only
  createdAt, updatedAt, lastLoginAt
```

`createdAt` is written once. `lastLoginAt` is stamped every sign-in. A missing
mobile number stays missing — it is how the app knows to ask, and a fabricated
one would end up on a real invoice.

Purchases are recorded separately, written only after the server has verified
the payment signature:

```
subscriptions/{razorpayOrderId}   uid, planId, planName, amount, currency,
                                  status, paymentId, startedAt, expiresAt, ...
payments/{razorpayPaymentId}      the idempotency key and the audit trail
```

**Checking it in the console:** the project has two Firestore databases —
`(default)` (Standard, asia-south1) and `default` (Enterprise, nam5). Both the
web SDK and the Admin SDK use **`(default)`**. If the console opens the
Enterprise one it will look empty however much data has been written, so check
which database the Data tab is showing before concluding anything is missing.

---

## 5. Test plan

Turn diagnostics on first — add `?debug=1` to the URL. It sticks, so it survives
the trip to Google and back, which is where the interesting part happens.
`SM.debug.dump()` copies the whole log as text, which works on a phone with no
console.

**Sign-in**

1. Desktop: sign in -> account page shows the shop, not the sign-in form.
2. **Phone: sign in -> the app opens, it does not return to the sign-in page.**
   Sign-in now uses a popup on phones too; the redirect flow's pending state
   lives on `mobilepartsfinder.firebaseapp.com`, and mobile browsers discard
   third-party storage, which is what lost the session.
3. Firestore -> `users` -> a document whose id is the Firebase UID, with the
   shop fields and a fresh `lastLoginAt`.
4. Sign in again: `lastLoginAt` moves, `createdAt` does not, and there is still
   exactly one document.
5. Same account on a second device: the same UID, the same one document.

**Payment** (test keys)

6. Monthly -> Razorpay Checkout opens. If it says *Payments are not switched on
   for this site yet*, section 2 is not done — check `/api/health`.
7. Dismiss the sheet -> "Payment cancelled", the button comes back, nothing in
   Firestore changed.
8. Pay with a test card -> `subscriptions/{orderId}` is `active`, and
   `users/{uid}` carries the plan and expiry.
9. Pay again on the same order id -> `alreadyProcessed`, and the expiry does not
   move twice. One payment buys one period, whether the browser or the webhook
   reports it first.

---

## 6. Optional: same-origin redirect sign-in

The popup path needs nothing extra. If you also want the *redirect* fallback to
be reliable on phones, make it same-origin:

1. Set `FIREBASE_AUTH_DOMAIN=www.mobilepartsfinder.com` in Vercel.
2. `vercel.json` already proxies `/__/auth/*` to
   `mobilepartsfinder.firebaseapp.com`, which is what makes that work.
3. Keep `www.mobilepartsfinder.com` in **Authentication -> Settings -> Authorised
   domains**, or Google closes the window with `auth/unauthorized-domain`.

---

## 7. Local development

```bash
cp .env.example .env.local
npm run dev
```

Use TEST keys only in `.env.local`. The dev server now runs the `api/*.js`
functions in-process, so sign-in and the payment flow can be exercised locally
instead of only in production. It prints how many variables it loaded and a link
to `/api/health` at `http://localhost:4321`.


---

## 8. The catalogue is open

The finder, the group sheets and the model pages now serve the real data from
the six category exports, unlocked for everyone. That was a deliberate choice,
and it is worth writing down what it means.

`assets/dataset.json` is a static file. Anyone who opens the site downloads it —
signed in or not — and it contains every part code, every serial number and all
12,239 fitments. Copies already fetched cannot be recalled. Firestore's
`groupDetails`, `modelGroups` and `deviceGroups` were opened to match, because a
rule guarding a copy while the original is public is not a control.

**To put the paywall back**, in this order:

1. Narrow `GROUP_COLS` in `scripts/build-runtime-bundle.js` — drop `part`,
   `oem` and `mem`, and ship per-category counts instead of group ids.
2. Rebuild: `node scripts/build-dataset.js && node scripts/build-runtime-bundle.js`
3. Put `hasActivePlan()` back on `groupDetails`, `modelGroups` and
   `deviceGroups` in `firestore.rules`, and deploy them.
4. Move the four entries in `PRO_ONLY` (`src/app.js`) back out of
   `freeIncluded()`.

Doing 3 before 1 tightens a rule around data the browser already has, which
looks like it worked and does nothing.

---

## 9. Part numbers

Every group has a part code — **ours**, issued by the build: `MPF-BT-0001`,
`MPF-SG-0144`. It is stable, unique, and printed on the group sheet.

The manufacturer's own code is a separate field, and it is kept only where the
source genuinely has one. Measured across the six exports:

| Category | Groups | Real manufacturer part numbers |
|---|---:|---:|
| Battery | 287 | **287** — `EB-BA115ABY`, `NT01`, `GVYZ7`, `B-V7` |
| Back Cover | 709 | 0 |
| CC Board | 715 | 0 |
| Combo/Display | 720 | 0 |
| Middle Frame | 742 | 0 |
| Screen Guards | 167 | 0 |

The other five categories' `modelNo` column holds test data — `"1"` 567 times in
combo-display, `"1"` 675 times in middle-frame, `"asdf"` 56 times in cc-board,
`"adsf"` 26 times in back-cover — or device names rather than part numbers
(`"OnePlus 15R"`, `"Asus ROG Phone 6"`). Screen guards is empty throughout.

Those are not shown. A shop reading `asdf` down the phone to a supplier, or
ordering against `1`, is worse off than one seeing no manufacturer code at all.

**`data/build/missing-part-numbers.csv`** lists all 3,054 groups still without
one, with the rejected source value in its own column so a genuine code that was
wrongly thrown out is visible. Fill the column in your source, re-export, and
re-run the build — nothing else has to change.

---

## 10. Rebuilding after a new export

```bash
node scripts/build-dataset.js --src "C:/Users/stark/Downloads"
node scripts/build-runtime-bundle.js
node scripts/import-firestore.js --project mobilepartsfinder
```

The first reads the six `*_export.json` files and the model workbook and writes
`data/build/`. The second packs `assets/dataset.json`, which is what the browser
downloads. The third pushes the same records to Firestore; it is idempotent and
overwrites by id.
