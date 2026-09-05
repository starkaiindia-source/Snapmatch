# The admin backend

How to switch it on, and what each page does.

---

## Who can get in

**One account: `Stark.ai.India@gmail.com`.**

It is named once, in `OWNER_EMAIL` in [`api/_schema/roles.js`](../api/_schema/roles.js),
and recognised from the `email` claim on the verified Firebase ID token — what
Google asserts the signed-in person's address is, not anything the browser
sends. Comparison is trimmed and lower-cased, and `email_verified` must be true.

`OWNER_ONLY` in the same file is `true`, so the owner is the **only** identity
with admin access. The `adminUsers` registry is not consulted at all: a document
in it grants nothing, and a stale custom claim grants nothing. There is no path
by which an account gives itself access.

The owner needs **no registry document**. That is deliberate — they cannot be
locked out of their own backend by a missing record or a write that failed.

`OWNER_EMAIL` is not a credential. Knowing the address grants nothing; access
requires a Google sign-in *as* that account, verified on every request.

### Getting in

Sign in to the site normally, open **Account**, and click **Admin Panel** — the
button appears beside **Edit** for the owner and for nobody else.

### Turning on staff roles later

Set `OWNER_ONLY = false`. The registry path (`support`, `analyst`, …) comes
back, and only the owner can grant a role — `admins.write` belongs to
`super_admin`, and the owner is the only one. While `OWNER_ONLY` is true, the
grant form is hidden and `/api/admin/admins` refuses a grant rather than
writing a role that every request would then ignore.

---

## Switching it on

Three steps, in this order.

### 1. Deploy the rules and indexes

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

**Do this first.** The rules close the new admin collections to every client;
the indexes are what make the user table and the dashboard aggregations work.
Without the indexes the dashboard still loads — it shows an em dash and a
banner naming the problem, rather than failing — but nothing is counted.

Firestore takes a few minutes to build indexes over an existing collection.

### 2. Nothing — the owner already has access

`Stark.ai.India@gmail.com` is recognised from its Google sign-in, so there is
no role to grant and no bootstrap step. Sign in and open `/admin`.

`scripts/grant-admin.js` still exists for staff roles once `OWNER_ONLY` is
turned off:

```bash
node scripts/grant-admin.js list          # who has a registry role
node scripts/grant-admin.js grant helper@example.com support
node scripts/grant-admin.js revoke helper@example.com
```

While `OWNER_ONLY` is `true` those roles are written but never consulted, so
there is no reason to run it yet.

### 3. Backfill the search mirrors

```bash
node scripts/backfill-user-search.js          # dry run — reports, changes nothing
node scripts/backfill-user-search.js --write
```

Adds lower-cased copies of the shop name, proprietor name and phone number to
profiles written before those fields existed, so the admin table can find every
account by name.

**Not required for correctness.** Until a record is backfilled it is still found
by uid and by email — both exact paths that need no mirror. The backfill adds
search by name and phone number.

**Safe to re-run.** It changes no value a user entered; it recomputes five
derived fields and writes them only if they differ. Run it twice and the second
run writes nothing.

Then open `https://your-site/admin` and sign in with the same Google account.

---

## How access works

There is no admin password. You sign in with the same Google account you would
use as a customer; what makes the session the owner's is the verified email
claim on the token, checked on the server on every request.

A customer who finds the URL sees *"Not an administrator"* and is returned to
the site after a few seconds. That redirect is a courtesy, not the control:

- every `/api/admin/*` route answers 403 for a non-admin
- every admin collection is `allow read, write: if false` in `firestore.rules`,
  so an ordinary Firebase ID token cannot read one document of admin data —
  **including an administrator's own token.** Their authority lives on the
  server; the browser only renders what it is sent.

Hiding a button is not a security control, and nothing here relies on it.

### Roles

The owner is `super_admin` and holds every permission. The rest of the table is
dormant until `OWNER_ONLY` is set to `false`.

| Role | Sees | Cannot |
| --- | --- | --- |
| `super_admin` | everything | — |
| `admin` | all business data, all approvals | change roles |
| `support` | users incl. contact details, subscriptions | revenue totals, edits |
| `analyst` | aggregate analytics + revenue | any individual user record |
| `user` | nothing | open the admin area |

`support` and `analyst` are mirror images on purpose: one can help a named
customer without seeing the business's revenue; the other can analyse the
business without seeing the customer list.

Refusals enforced server-side:

- **The owner account cannot be changed from the Settings page.** Its access
  comes from the Google identity, not a registry row, so a write there would do
  nothing while implying a demotion.
- **You cannot change your own role.**
- **The last `super_admin` cannot be removed.**
- **No staff role can be granted while `OWNER_ONLY` is true**, because the role
  would be written and then ignored by every request.

---

## The pages

### Dashboard

Users, subscriptions, revenue, growth charts, website activity, and what people
searched for.

**Every figure is counted from production data or shown as an em dash.** There
is no seeded chart, no baseline, no smoothing, and no `Math.random()` anywhere
in this project.

A dash and a zero mean different things and are drawn differently:

- **0** — counted, and the answer is zero
- **—** — could not be counted, usually a Firestore index still building

A month with no payments draws a flat chart. That flat chart is the correct
answer; a plausible curve would be a decision someone makes on a number that
was never true.

Website activity only exists from the day the collector was switched on. Before
that it says *"No data yet"*, which is a different statement from zero.

### Users

Every registered account, joined from Firebase Authentication and the stored
shop profile.

**Search:**

| You type | How it matches |
| --- | --- |
| an email | exactly |
| a Firebase UID | exactly |
| a phone number | exactly, digits only — `+91 98765 43210` finds `9876543210` |
| a shop or proprietor name | from the **start** of the name |

`sri bal` finds *Sri Balaji Mobiles*. `balaji` does not — Firestore cannot do
mid-word matching at index speed, and the alternative is downloading the entire
customer list into the browser. When mid-word search becomes necessary the
answer is a search index (Algolia, Typesense), not a bigger download.

**Filters:** all · new · active · inactive · profile incomplete · profile
complete · free · active subscription · expired subscription · monthly ·
yearly · country · joined date range · last-seen date range.

**Sorts:** newest · oldest · recently active · longest inactive · highest
revenue · most payments.

The last two sort **within the page**, and the footer says so — revenue is
derived from the payments collection rather than stored on the user document,
so Firestore cannot order by it. Denormalising it onto the user would be a
number that drifts.

When a filter has to be applied after the query, the response says
`approximate: true` and the footer reads "matching rows" rather than a total.

### User detail

Overview, shop profile, authentication, subscription, full payment history and
a timeline merging account facts, billing records and analytics events.

Every field prints what is stored and an em dash for what is not. Nothing on
this page is computed as "probably" — an admin reading it is often about to tell
a customer something.

Two banners worth knowing:

- **"No profile record"** — the account exists in Firebase Authentication with
  no `users/{uid}` document. Real, and it has a cause: the tab was closed before
  `/api/profile-sync` finished. It is created on their next sign-in.
- **"Profile incomplete"** — names exactly which of the three business details
  is missing. Address is optional and is never counted.

**Opening this page is audited.** Reading one customer's contact details is a
legitimate support action and also the exact shape of misuse; the difference is
only visible as a pattern. The entry records who opened which uid — never a copy
of what they saw.

Razorpay payment and order ids are shown as references. No card, UPI or bank
detail is stored by this system or reachable from it.

### Missing models

Handsets people searched for and did not find, **aggregated per model** — one
row per handset, not one per search. Ordered by demand, because "which model
should we add next" is the question the page exists to answer.

Move a request through the workflow with the drop-down. `published` is final
and asks for confirmation. The server checks the transition table before
writing, so an illegal jump is refused even if the request were crafted by hand.

### Local AI

Gateway connection state, the capability list, and the approval queue.

There is no chat box, deliberately — see `docs/AI-ARCHITECTURE.md`. Every AI
proposal arrives as a draft; approving records the decision and **does not
publish**. Applying a catalogue change is a separate step.

With no gateway configured the page names the environment variables that are
missing. It does not demo anything.

### Settings

Administrator accounts and the audit trail. The trail is append-only and closed
to clients in the rules, so not even a `super_admin` can edit an entry from a
browser — a log its subject can rewrite proves nothing.

---

## Troubleshooting

**"Not an administrator" for an account you just granted.**
The role is on the server; their token still carries the old claim. `setRole`
revokes their sessions, so signing out and back in fixes it. The registry check
means they are refused correctly in the meantime, never wrongly allowed.

**Dashboard tiles showing em dashes.**
Firestore indexes are still building. `firebase deploy --only
firestore:indexes`, then wait. The banner at the top of the dashboard says this
when it detects it.

**A user cannot be found by shop name.**
Their profile predates the search mirrors. Run
`node scripts/backfill-user-search.js --write`. They are findable by email and
uid in the meantime.

**`/admin` shows the customer site.**
The `/admin(?:/.*)?$` route in `vercel.json` is missing or ordered after the
catch-all. It must come before `"src": "/(.*)"`.

**Analytics not appearing.**
`/api/events` answers `503 analytics-unconfigured` when
`FIREBASE_SERVICE_ACCOUNT` is unset — check `/api/health`. The browser drops a
failed batch and never retries, so nothing surfaces to the visitor either way.
