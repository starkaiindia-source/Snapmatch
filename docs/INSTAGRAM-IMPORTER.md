# Instagram Compatibility Data Intelligence

Instagram posts from parts sellers say things like *"Samsung A15 4G Tempered
Glass — Compatible: A15 4G / A15 5G"*. This feature reads those claims, matches
every model to the catalogue, and queues them for an administrator. Only what
an administrator approves reaches the production fitment data.

**Instagram is a source of claims, never an authority.** The order of trust:

1. the catalogue — every model, brand and category (`assets/search-index.json`)
2. the taxonomy layer — `api/_services/taxonomy-service.js` and `/aliases`
3. what a post actually says, verbatim
4. what an AI made of it

A lower level never overrides a higher one. Nothing in this feature creates a
model, a brand or a category, merges two variants, or removes a fitment.

---

## 1. The pipeline

```
Admin: Instagram Data Importer  ──  "Analyze Source"
   │
   ▼  POST /api/admin/instagram {action:"analyze"}            job-service.createJob
instagramImportJobs/{jobId}           status: queued | unable_to_collect
   │
   ▼  POST {action:"tick"}  (the open page, or scripts/instagram-worker.js)
discover   Graph API page -> items/{mediaId}, cursor saved     graph-client.js
   │
   ▼  one item at a time, under a lease
change?    same caption + media + processing version -> skip (no OCR, no AI)
   │
   ▼
text       caption · OCR per image · key frames + transcript per video   media-processor.js
   │
   ▼
extract    rules first; AI only if the rules left something            extractor.js
   │
   ▼
match      every model -> an EXISTING catalogue record, or review      taxonomy-service.js
   │
   ▼
candidate  evidence, match method, category, confidence factors         candidate-builder.js
   │
   ▼
dedupe     same claim earlier? already true in production?  -> duplicate (kept as evidence)
conflict   opposite claim, or production disagrees          -> Compatibility Conflict
   │
   ▼
compatibilityCandidates  ── Admin: Compatibility Review ──  approve / reject / edit match / …
   │
   ▼  approve (compat.approve), one Firestore transaction      review-service.approve
production groupDetails / groups / modelGroups — ADDITIVE ONLY
approvedCompatibilities/{relKey} — the ledger: who, when, why, previous and new value
```

### Files

| File | Role |
| --- | --- |
| `api/_schema/instagram.js` | URL validation, keys, hashes, state machines, confidence rules, review sections. Pure. |
| `api/_services/taxonomy-service.js` | The model and category matcher (see §4). |
| `api/_services/instagram/graph-client.js` | The only Instagram access: Meta's Graph API. |
| `api/_services/instagram/media-processor.js` | OCR, video key frames, transcripts, caching by content hash. |
| `api/_services/instagram/extractor.js` | Rule-based extraction, the AI prompt, AI output validation. |
| `api/_services/instagram/candidate-builder.js` | Relationships → review candidates + evidence. Pure. |
| `api/_services/instagram/job-service.js` | Jobs: create, tick, resume, retry, cancel; dedupe and conflicts. |
| `api/_services/instagram/review-service.js` | Review actions and the approval transaction. |
| `api/_services/instagram/production.js` | Reads what production already says about two models. |
| `api/_services/instagram/config.js` | Every knob, clamped. |
| `api/_admin/instagram.js` | `/api/admin/instagram` — a section of the one admin function. |
| `src/admin/pages/instagram.js` | Importer, Sources, Import Jobs, Extraction Results, Import History. |
| `src/admin/pages/compat-review.js` | Compatibility Review. |
| `scripts/instagram-worker.js` | Runs jobs without a browser. |
| `scripts/export-approved-compatibilities.js` | Ledger → `data/raw/` for the catalogue build. |

---

## 2. What can be collected — and what cannot

The importer reads Instagram **only** through Meta's official Graph API
(`graph.facebook.com`), with a token held server-side:

| Target | How | Result |
| --- | --- | --- |
| The business's own professional account | `GET /{ig-user-id}/media` | captions, media URLs, video covers, carousel children |
| Another **public professional** (Business/Creator) account | Business Discovery | captions, media URLs, carousel children |
| A personal account, a private account, an age-gated account | — | **Unable to collect**, with Meta's reason |
| Stories, highlights, hashtag pages | — | refused at URL validation |
| A reel with copyrighted audio | Meta omits `media_url` | read from its caption only, and the item says so |

`instagram.com` itself is never fetched: `backend/sources.js` registers
`instagram-web` as `allowed: false`, and `fetchAllowed()` throws for it. There
is no scraping, no logged-in session, no headless browser, and no attempt to get
past a login wall, CAPTCHA, private account or rate limit. A Graph rate limit
(codes 4, 17, 32, 613, 80002, HTTP 429) **pauses** the job until the time Meta
reports; resuming earlier is refused.

A specific post URL is found by listing the account's media (the Graph API has
no lookup by URL for other accounts), up to `INSTAGRAM_MAX_DISCOVERY_PAGES` pages.
A post older than that is reported as not found — not guessed.

**Manual entry** is the other route: an administrator pastes text they read
themselves. It is labelled `manual_admin_entry` everywhere, never "collected".

### Meta app setup

1. A Meta app with Facebook Login for Business.
2. The business's Instagram **professional** account linked to a Facebook Page.
3. Permissions `instagram_basic` and `pages_read_engagement` (Business
   Discovery needs them approved through App Review for a live app).
4. A token: a Business Manager **system-user** token (does not expire) is the
   right choice for a server; a long-lived user token lasts ~60 days.
5. `INSTAGRAM_GRAPH_ACCESS_TOKEN`, `INSTAGRAM_BUSINESS_ACCOUNT_ID` (the numeric
   IG user id), and ideally `INSTAGRAM_APP_SECRET` (adds `appsecret_proof`).

---

## 3. Reading the media

The work runs on hardware you control — the Local AI service from
`docs/AI-ARCHITECTURE.md` — never inside a Vercel function (no GPU, no ffmpeg,
a hard time limit). Three gateway capabilities, each validated before use:

```
POST {AI_GATEWAY_URL}/v1/task   Authorization: Bearer {AI_GATEWAY_TOKEN}

capability "media_ocr"
  input  { imageBase64 | mediaUrl, mimeType, languageHints: ["en","hi"] }
  output { text, lines?: [{text, confidence}], confidence?, engine? }

capability "video_analyze"
  input  { mediaUrl, maxSampledFrames, sceneThreshold, transcribe, languageHints }
  output { frames: [{timeMs, text, confidence?, sceneScore?}],
           transcript?: {text, language}, engine? }

capability "extract_compatibility"
  systemHint  the strict instruction (extractor.js AI_SYSTEM_PROMPT)
  input       { sourceText, candidateModels: [{id,name}], categories: [{id,name}] }
  output      { relationships: [{sourceModelText, sourceModelId|"UNMATCHED",
                  compatibleModelText, compatibleModelId|"UNMATCHED",
                  categoryText, categoryId|"UNMATCHED"|null,
                  compatibilityType, polarity, evidenceText}], modelMentions: [...] }
```

Images can use Google Cloud Vision instead (`INSTAGRAM_OCR_PROVIDER=google_vision`,
`GOOGLE_VISION_API_KEY`; the Cloud project needs billing).

**Key frames.** The gateway samples on scene change; `selectKeyFrames()` then
keeps only frames whose on-screen text changed (under 60% token overlap), keeps
the clearest read of repeated text, and caps at `INSTAGRAM_MAX_FRAMES_PER_VIDEO`,
preferring frames that add new words.

**Without a provider** an image is recorded as "OCR unavailable" and the post
is read from its caption; a video without a processor is read from its caption
and cover image. Nothing is filled in to look processed.

**Cost control.** OCR results are cached by the SHA-256 of the image bytes
(a repost costs nothing), a video by its media id, an AI extraction by the hash
of its input. Unchanged content is skipped *before* any paid call. Each call
kind has a daily cap (`INSTAGRAM_DAILY_*`); at the cap the item is deferred and
the job pauses as `quota_exhausted` — it is not failed and not skipped. Usage is
counted per job and per day in `instagramUsageDaily`.

---

## 4. Matching to the catalogue

No module called the "ProGlide Taxonomy Intelligence Layer" existed in the
codebase. Its pieces did, spread across files, and `taxonomy-service.js`
composes them rather than building a second engine:

| Existing piece | Used for |
| --- | --- |
| `search-service.loadIndex()` | the 4,933-model catalogue index |
| `search-service.findModels / partialMatch / fuzzyMatch / editDistance` | the "taxonomy" rung, the picker, fuzzy distance |
| `backend/schema.js` `slug()` / `aliasKey()` | normalisation ("+" survives as "plus") and alias keys |
| Firestore `/aliases` | the alias rung — admin-verified spellings |
| `src/data/category-assets.js` ALIASES | category spellings (a test fails if they drift) |

The ladder, stopping at the first rung that answers:

```
normalise -> exact -> official name -> alias -> synonym -> keyword
          -> alternate spelling -> market term -> misspelling
          -> similarity -> existing search ladder -> AI (weak, batched, validated)
```

| Text | Result |
| --- | --- |
| Samsung Galaxy A15 | Samsung Galaxy A15 — exact |
| Samsung A15 | Samsung Galaxy A15 — market term ("Galaxy" dropped) |
| Redmi 13C | Xiaomi Redmi 13C — official name |
| POCO C65 | Xiaomi Poco C65 — official name (not the Realme C65) |
| C65 | **ambiguous**: Realme C65, Xiaomi Poco C65 |
| Samsung A15 4G | Samsung Galaxy A15 — **needs confirmation** (the record's name has no network) |
| Vivo Y27 4G | vivo Y27 — **needs confirmation**; vivo Y27 (2014) and vivo Y27 5G listed |
| Oppo A15 5G | **ambiguous** — no 5G record; never matched to the 4G one |
| Samsung A15s / XYZ 999 | **unmatched** — never created |

Three rules make it safe:

- **A model number is never fuzzy.** Every token with a digit must match
  exactly; "A15" never becomes "A16" or "A15s".
- **A network, year or region is never inferred** — least of all from a
  sibling's name. A qualifier in the text that the record's name lacks makes
  the match "needs confirmation", capped at *good*, and keeps the candidate out
  of *ready*.
- **More than one answer is "ambiguous"**, never the first one.

---

## 5. Candidates, confidence and the review queue

Statements are classified as **explicit** ("compatible", "same glass", "fits",
"lagega"), **implied** (a `/`-separated product title — *"iPhone 13 / 13 Pro
Back Cover"* is never more than low), **same chassis** ("same body"), or
**negative** ("not compatible", "different glass", "nahi lagega"). Similar names
are never evidence.

Confidence is derived from named factors, stored with the band: both matches,
the category, the statement, and the evidence (caption and manual text are
strong; OCR is as good as the engine's own confidence; transcripts are good).
AI-proposed relationships are capped at *medium*. The score only sorts; the UI
says it is not a probability. Follower counts are stored as metadata and are
**not** a factor.

| Section | What lands there |
| --- | --- |
| High confidence — ready | exact matches, clear category, explicit, strong evidence, no variant question, no conflict |
| Medium / low — review required | everything else that is matched, with the reasons named |
| Unmatched models | a side, or a reference, with no catalogue record |
| Ambiguous models | a side that fits several records |
| Compatibility conflicts | sources disagree, or a source disagrees with production |
| Duplicate relationships | already in production, already approved, or the same claim pending elsewhere |
| Invalid / rejected | rejected by a person, or AI output that failed validation |

**Duplicates** use `categoryId + modelA + modelB + same_part` (the pair sorted:
"A fits B" and "B fits A" are one fact). A duplicate is not discarded: its
evidence row stays, linked by that key, so a relationship shows every page that
claimed it. **Conflicts** show both sides; neither is applied.

**Actions:** Approve · Reject (with a reason) · Edit match / Select correct
model (catalogue records only; optionally remember the spelling in `/aliases`)
· Change category (catalogue categories only) · Mark duplicate · Ignore source
· Approve all valid (the *ready* section only, each in its own transaction) ·
Reopen · Send to Missing models.

**Learning** happens only through an explicit admin action: a remembered alias
(audited, never overwriting an alias that points elsewhere) and a source's
approved/rejected counts. Nothing is learned from the AI.

---

## 6. What approval writes

One transaction that re-reads everything, then exactly one of:

| Production state | Written |
| --- | --- |
| already one group | nothing; recorded as **Already Existing** evidence |
| one model grouped, the other not | the other is **added** to that group: `groupDetails` members + count, `groups` count, `modelGroups[m].byCategory[c]`; the ledger records the previous member list and count |
| different groups | **refused** — merging groups is a catalogue decision |
| neither grouped | ledger only, `approved_pending_build` — a new group needs the build's part code and serial |
| catalogue not in Firestore | ledger only, `approved_pending_build` |

A negative claim cannot be approved (acting on it would delete data). A
low-confidence candidate needs an explicit acknowledgement. An unconfirmed
variant, an unmatched side or an active conflict is refused.

### Keeping approvals through the next import

`scripts/import-firestore.js` rewrites groups from the build, which would undo
an approval. So:

1. `node scripts/export-approved-compatibilities.js --project <id>` →
   `data/raw/approved-compatibilities.json`
2. `node scripts/build-dataset.js` folds every `applied` entry back into its
   group — additively, and only if the group still holds the model the approval
   was anchored on; anything else is listed in `report.json`.
3. `import-firestore.js` checks every `applied` approval against the build and
   **refuses to import** if one would be dropped (`--allow-dropping-approved`
   overrides, deliberately awkward).

`api/_services/entitlement-service.js` caches group members per warm function
instance, so a paying shop can see the old list until that instance recycles.

---

## 7. Jobs: background, resumable, cancellable

A job advances in **ticks**: each takes a lease on the job (one worker at a
time — two open tabs cannot race), works for `INSTAGRAM_TICK_BUDGET_MS`, saves
its position and releases. The importer page drives ticks while it is open;
`scripts/instagram-worker.js --all` drives them from any machine with the
service account.

- **Resume** — from the next unprocessed item; an item left mid-processing by a
  crash goes back to the queue. Done items are never redone.
- **Retry failed** — an item is retried up to `INSTAGRAM_MAX_ATTEMPTS`, then
  marked failed; this re-queues the failed ones.
- **Cancel** — stops the job and cancels its queued items; processed items stay.
- **View errors** — the last 50, with the item and the cause.
- **Re-import** — unchanged posts are skipped; a changed caption or carousel is
  a new *version*: the old extraction is kept and its open candidates are
  marked superseded.

---

## 8. Data

All server-only (`allow read, write: if false` in `firestore.rules`).

| Collection | Key | Holds |
| --- | --- | --- |
| `instagramSources` | `ig_<username>` | access verdict + reason, account type, followers (metadata), reputation, ignored |
| `instagramImportJobs` (+ `/items`) | auto / media id | status, cursor, counters, usage, errors, lease; the work queue |
| `instagramContent` | `igm_<mediaId>` / `man_<hash>` | caption, hashes, per-media OCR status, versions, duplicate status |
| `instagramExtractions` | `<contentKey>__v<n>` | texts, category, references with matches, relationships, AI use |
| `compatibilityCandidates` | deterministic | the review queue, with the whole evidence chain and history |
| `compatibilityEvidence` | = candidate id | every statement, linked by `relKey` |
| `approvedCompatibilities` | `relKey` | the ledger: status, applied change, evidence, approver |
| `instagramMediaCache` | content hash | OCR / video / AI results |
| `instagramUsageDaily` | `YYYY-MM-DD` | call counters for the caps |

Reused, not duplicated: `adminAuditLog` (every action, with previous and new
value), `aliases` (learned spellings), `missingModelRequests` (unmatched models
sent there), `groupDetails` / `groups` / `modelGroups` (production), `catalog/meta`.

---

## 9. Security

Four permissions in `api/_schema/roles.js`: `instagram.read`,
`instagram.import`, `compat.review`, `compat.approve`. `super_admin` and
`admin` hold all four; `support` and `analyst` none. While `OWNER_ONLY` is
true only the owner's Google account passes the gate at all. Every route
checks its permission server-side on every request.

The Graph token, app secret, Vision key and AI gateway token are read from the
environment by the services and never sent to the browser; the overview reports
only whether each is set. A test asserts no secret appears in any response and
that the admin UI makes no call to Instagram, Vision or the gateway.

---

## 10. Deploying

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

Then set the environment in Vercel (see `.env.example`): at minimum
`INSTAGRAM_GRAPH_ACCESS_TOKEN` and `INSTAGRAM_BUSINESS_ACCOUNT_ID`; for OCR,
video and AI, `AI_GATEWAY_URL` / `AI_GATEWAY_TOKEN` with a gateway that
implements the three capabilities above (or `GOOGLE_VISION_API_KEY` for images).
Redeploy. No new serverless function is added — the project stays at 12.

The production catalogue must be imported into Firestore (`catalog/meta`,
`groupDetails`, `modelGroups`) for approvals to reach production; until it is,
approvals are recorded as `approved_pending_build`.

---

## 11. Limitations

- **Only professional accounts are readable**, and only through an approved
  Meta app. Personal and private accounts cannot be imported at all.
- **Business Discovery is rate-limited by Meta** (roughly 200 calls per hour per
  app user); a large page is imported over several runs.
- **No post lookup by URL** for other accounts: a specific post is found by
  paging the account's recent media.
- **Copyrighted reels** come without `media_url`; only their captions are read.
- **Stories are not available** through Business Discovery.
- **Media URLs expire**: previews in the review card work for a while; the
  permalink is the lasting reference. Media is not stored.
- **OCR, frames and speech need a provider**; without one, content is read from
  captions and covers, and the job says so.
- **Model-number codes** (e.g. SM-A155F) match only once an admin teaches the
  alias; the catalogue holds no model codes.
- **New groups are not created here**: an approved pair with no existing group
  waits for the catalogue build.
