# Instagram Compatibility Data Intelligence

Instagram posts from parts sellers say things like *"Samsung A15 4G Tempered
Glass — Compatible: A15 4G / A15 5G"*. This feature reads those claims, matches
every model to the catalogue, compares each list with the existing
compatibility groups, and **applies the lists that pass every check** — a
model joins the group it belongs in, a group is created when none matches, two
groups one list shows to be the same part are merged (§6b). What does not pass
waits for a person, with the reason. Nothing is ever removed by a scan.

**This is Mobile Parts Finder's own data.** Everything here reads and writes
the Mobile Parts Finder project and no other (§0). **Instagram is a source of
claims, never an authority.** The order of trust:

1. the catalogue — every model, brand and category (`assets/search-index.json`)
2. the taxonomy layer — `api/_services/taxonomy-service.js` and `/aliases`
3. what a post actually says, verbatim
4. what an AI made of it

A lower level never overrides a higher one. Nothing in this feature creates a
model, a brand or a category, merges two variants, or removes a fitment.

Three things it is built around:

- **Most of a technician's page is not compatibility.** A repair or jumper post
  names a phone too. Every post is *classified* first (§5a); only a post that
  makes a compatibility claim reaches an administrator.
- **A compatibility list is one claim.** "This display fits these 68 models" is
  compared with the existing groups as a set and becomes one *group proposal*
  (§5b) — not sixty-seven pairwise cards.
- **One category + one model = at most one group.** Enforced on the server, in
  the approval transaction and in the catalogue import (§6a).
- **Cheap first, expensive only when necessary.** A free caption filter, then a
  low-cost visual screen, then one deep read by Gemini, then a second opinion
  from Claude for the few lists that are still doubtful (§3). Everything that
  decides production — model matching, group matching, the one-group rule, the
  writes — is deterministic code, not a model.

---

## 0. Whose data this is — three projects, one write target

Three projects hold mobile-model data that looks alike. They are separate
databases, and this code writes to exactly one of them.

| Project | What it is here | Access from this code |
| --- | --- | --- |
| **Mobile Parts Finder** — this repository, Firebase `mobilepartsfindercom`, Vercel `mobile-parts-finder` | the active product; its compatibility groups, categories and model references are **its own master data** | read and write |
| **Dashboard** — a separate repository and Firebase project | historical reference: its category exports seeded this catalogue once | **none at run time.** No credential for it is configured here, and no code calls it |
| **ProGlide** — a separate project | nothing | none |

How the boundary is held, not merely intended:

- **One database handle.** There is one Firebase Admin app (`api/_lib/firebase.js`)
  built from one service account (`FIREBASE_SERVICE_ACCOUNT`). Every
  compatibility service takes its handle from
  `api/_services/instagram/firestore.js`, which calls
  `projects.assertWritable()` (`api/_schema/projects.js`): a service account
  that belongs to the Dashboard or to ProGlide — pasted into the wrong
  environment — is refused before a document is written, and so is one that
  does not match `FIREBASE_PROJECT_ID`.
- **A test that fails the build.** `api/_lib/isolation.test.js` scans every
  source file: no other project's Firebase id, no second Admin app, no other
  credential variable, no call to another project's Cloud Functions or
  Firestore REST endpoint. It then runs an Instagram extraction, a group
  update, a category creation and a merge, and asserts a Dashboard store and a
  ProGlide store saw **zero writes**.
- **No foreign keys.** A group, a category or a ledger entry carries no id of
  another project's record. Across a catalogue build, a change is identified
  by the device it was anchored on.
- **The baseline is a file, not a connection.** The category files the build
  reads (`*_export.json`) are the snapshot this catalogue started from. The
  build never calls the Dashboard. Do not re-export from it to "refresh" a
  category: every change since lives in this project's ledger and is replayed
  over the baseline (§6); a fresh export would not contain it.

One thing that is NOT this project's own: the Instagram Graph API token
belongs to the Instagram professional account it was issued for. It is used
for reading only (Business Discovery) and nothing is ever written through it.

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
change?    same caption + media + processing version + same readers -> skip (no OCR, no AI)
   │
   ▼       FREE
filter     a weighted score from the caption: HIGH · MEDIUM · LOW · REJECT   relevance.scoreCandidate
   │                                   └─ REJECT: no media is read (kept, "Analyse anyway" overrules)
   ▼       CHEAP                                                         media-processor.js
screen     Gemini screen model, low resolution, one word of an answer:
           LIKELY_COMPATIBILITY · UNCERTAIN · LIKELY_IRRELEVANT
   │                                   └─ LIKELY_IRRELEVANT: stops here
   ▼       THE ONE DEEP CALL
read       Gemini: an image, each carousel image, or the video itself
           (two passes: a cheap look, then the full read) -> lists, product, confidence
   │                                   └─ this sync's AI budget spent: the post is QUEUED, not failed
   ▼
extract    rules first; statements AND whole lists                      extractor.js
   │
   ▼
classify   RELEVANT / PARTIALLY / NEEDS_REVIEW / INSUFFICIENT /
           IRRELEVANT_REPAIR / IRRELEVANT_GENERAL / DUPLICATE_SOURCE    relevance.classify
   │                                   └─ ignored: stored, tagged, nothing queued, no reads spent
   ▼
match      every model -> an EXISTING catalogue record, or review      taxonomy-service.js
   │
   ├─ a list (3+ models) ─► compared with the existing groups ─► ONE group proposal
   │                                                                    group-proposals.js
   └─ a pair            ─► candidate: evidence, match method, confidence candidate-builder.js
   │
   ▼       ONLY WHEN IN DOUBT
validate   Claude checks the doubtful entries of a proposal against the image    validation.js
           and may only pick from catalogue records it is offered
   │
   ▼
dedupe     same claim earlier? already true in production?  -> duplicate (kept as evidence)
conflict   opposite claim, production disagrees, or a listed model already
           belongs to another group in the category          -> Compatibility Conflict
   │
   ▼
compatibilityCandidates  ── Admin: Compatibility Review ──  approve / reject / edit / …
   │
   ▼  approve (compat.approve), one Firestore transaction      review-service.approve / approveProposal
production groupDetails / groups / modelGroups — ADDITIVE ONLY, one group per category
approvedCompatibilities/{relKey} — the ledger: who, when, why, previous and new value
```

### Files

| File | Role |
| --- | --- |
| `api/_schema/instagram.js` | URL validation, keys, hashes, state machines, confidence rules, review sections. Pure. |
| `api/_services/taxonomy-service.js` | The model and category matcher (see §4). |
| `api/_services/instagram/graph-client.js` | The only Instagram access: Meta's Graph API. |
| `api/_services/instagram/ai-providers.js` | The two hosted models: Gemini (Interactions API + Files API) and Claude (the official SDK). Error mapping, token usage, cost estimation. |
| `api/_services/instagram/media-processor.js` | OCR, the visual screen, the deep image and video reads, the second opinion; caching by content hash; budgets and retries. |
| `api/_services/instagram/validation.js` | When a proposal needs a second opinion, what is asked, and how the answer is applied. Pure. |
| `api/_services/instagram/provider-check.js` | "Is it working?" — real calls with the configured keys. |
| `api/_services/instagram/relevance.js` | Is the post about compatibility at all? The repair and compatibility vocabularies, the cheap-filter score, the classifier. Pure. |
| `api/_services/instagram/extractor.js` | Rule-based extraction of statements and whole lists, the AI prompt, AI output validation. |
| `api/_services/instagram/group-proposals.js` | A list against the existing groups: target group, master, ADD / CONFLICT / UNMATCHED, the proposed action. |
| `api/_services/instagram/candidate-builder.js` | Relationships → review candidates + evidence. Pure. |
| `api/_services/instagram/job-service.js` | Jobs: create, tick, resume, retry, cancel; dedupe and conflicts; evidence an admin adds. |
| `api/_services/instagram/review-service.js` | Review actions, proposal edits, and the two approval transactions. |
| `api/_services/instagram/production.js` | Reads what production already says about two models. |
| `api/_services/instagram/config.js` | Every knob, clamped. |
| `api/_admin/instagram.js` | `/api/admin/instagram` — a section of the one admin function. |
| `src/admin/pages/instagram.js` | Importer, Sources, Import Jobs, Extraction Results, Import History. |
| `src/admin/pages/compat-review.js` | Compatibility Review. |
| `scripts/instagram-worker.js` | Runs jobs without a browser. |
| `scripts/instagram-verify-providers.js` | Calls each provider for real and prints VERIFIED / NOT VERIFIED. |
| `scripts/instagram-ai-smoke.js` | Runs the real AI pipeline on local image / video files against the built catalogue (nothing is written to production). |
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
| A reel with copyrighted audio | Meta omits `media_url` | its cover if Meta gives one; otherwise **Insufficient evidence** until an admin adds screenshots (below) |

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

**Reel covers.** Business Discovery's documented field list has no
`thumbnail_url`. The first discovery call of a job asks for it anyway; if Meta
answers `(#100) nonexisting field`, the field is dropped for the rest of the
job (one extra call, remembered in `discovery.coverField`). It is the same
official endpoint either way — not a different route.

**Evidence an admin adds.** Most reels carry licensed audio, so the API hands
over neither the video nor (often) a cover, and the compatibility list is on a
screen nothing here can read. An administrator who has watched the reel can
attach screenshots of it — or type the list — under *Extraction Results → Add
evidence*. The screenshots are shrunk in the browser, read by the same OCR and
vision, stored on the post as `manualEvidence` (who, when, which reader), and
the post is analysed again as a new version. Every model read that way carries
the reference `evidence:<id>`, shown as "a screenshot added by an admin". This
fetches nothing from Instagram; it records what a person saw.

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

## 3. Reading the media — cheap first, expensive only when necessary

Reading a page costs money per post, and most posts are not compatibility
content. So a post climbs a ladder and stops at the first rung that can decide
it. Each rung is more expensive than the one before.

| # | Stage | Costs | Decides |
| --- | --- | --- | --- |
| 0 | **Unchanged?** Same caption, media, processing version and readers as last time | nothing | skipped outright |
| 1 | **Cheap filter** — a weighted score from the caption | nothing | `REJECT` stops here; `HIGH` goes straight to the deep read |
| 2 | **OCR** (optional) — plain text off an image | one OCR call | text that is clearly repair, or clearly not a list, stops here |
| 3 | **Visual screen** — Gemini's small model, low resolution | a few hundred tokens | `LIKELY_IRRELEVANT` stops here |
| 4 | **Deep read** — Gemini's main model, the image at full resolution or the video itself | the one real cost | lists, product, the reader's confidence |
| 5 | **Second opinion** — Claude, on the doubtful entries of one proposal | only when in doubt | suggestions and disputes for a person |
| 6 | **The backend** — matching, group comparison, one-group rule, writes | Firestore reads | everything that reaches production |

### Stage 1 — the cheap filter (`relevance.scoreCandidate`)

A score, not a keyword list:

| Signal | Weight |
| --- | --- |
| compatibility wording (the vocabulary in `relevance.js`) | +4 per term, two terms counted |
| a count of models ("68 models") | +3 |
| three or more short lines that look like model names | +3 |
| a product is named | +2 |
| a model-looking name ("Y20", "Redmi 9") | +1 per distinct name, two counted |
| strong repair or fault wording | −3 per term, to −9 |
| problem / solution wording | −1 per term, to −3 |
| the page's own record: ≥ 30 % of 20+ posts were relevant / ≤ 2 % of 50+ | +1 / −1 |

The exact vocabularies and weights are `WEIGHTS`, `TIER` and the word lists in
`relevance.js`; the score and the signals behind it are stored on every post.

`HIGH` (≥ 4) · `MEDIUM` (≥ 1) · `LOW` · `REJECT` (≤ −2 **and** strong repair
wording **and** no compatibility wording).

- **Repair words lower the score; they are not a veto.** "Charging jumper —
  same flex fits A12 / A13 / M12" scores as a candidate, and is read.
- **A model name beside repair wording earns nothing** — every repair post
  names a phone.
- **Uncertain is not rejected.** `LOW` and `MEDIUM` go to the visual screen;
  only `REJECT` skips the media, and it is never discarded: it is stored under
  *Ignored* with the score and the words that decided it, and **Analyse anyway**
  on that card sends that one post to the deep read regardless.
- **A page is never blacklisted.** Its history moves the score by one point.

### Stages 3–4 — Gemini, the primary media reader

`GEMINI_API_KEY`, through the Interactions API (`ai-providers.js`). Requests are
sent with `store: false`, so Google does not retain them as a conversation.

| | Model | Input | Output |
| --- | --- | --- | --- |
| Screen | `INSTAGRAM_GEMINI_SCREEN_MODEL` (default `gemini-3.1-flash-lite`) | the image at **low** resolution; a video at low resolution, one frame every two seconds | `LIKELY_COMPATIBILITY` / `UNCERTAIN` / `LIKELY_IRRELEVANT`, a kind, a reason |
| Deep read | `INSTAGRAM_GEMINI_MODEL` (default `gemini-3.8-flash`) | the image at **high** resolution; a video at high resolution, `INSTAGRAM_VIDEO_FPS` frames a second | `contentClass`, `product`, `confidence`, and **every list** with its heading, its models as printed and (video) the second it is on screen |

- **Carousels:** each image is screened and read on its own; the same list on
  two images is merged by the backend, not by the model.
- **Video is read as video**, not as a thumbnail: the file Instagram returns is
  sent whole (inline up to 14 MB, through the Files API above that and deleted
  afterwards; `INSTAGRAM_MAX_VIDEO_BYTES` is the ceiling). Two passes — the
  screen over the whole clip, then the deep read only if the screen does not
  say no. A `HIGH` caption skips the screen.
- **A cover is not a video.** When Instagram returns no `media_url` the item is
  marked `VIDEO_MEDIA_UNAVAILABLE`; the cover, if there is one, is read *as a
  cover* and the reel stays "partly read". Nothing reports a video as analysed
  that was not.
- **Thinking is kept as low as the model allows.** The screen asks for
  `minimal`, the deep read for `low`. Models differ in the levels they have
  (`gemini-3.8-flash` has no `minimal`); a level a model refuses is stepped up
  by one, remembered, and the level actually used is shown by the provider
  check.
- **The model's answer is text, not truth.** It is forced into a JSON schema,
  validated, and handed to the same extractor and catalogue matcher as a
  caption. A name the catalogue lacks is `unmatched`; it never becomes a model.

### Stage 5 — Claude, the second opinion (`validation.js`)

`ANTHROPIC_API_KEY`, model `INSTAGRAM_CLAUDE_MODEL` (default `claude-opus-5-5`),
effort `INSTAGRAM_CLAUDE_EFFORT` (default `medium`), structured output. Asked
**per proposal, and only when**:

- the reader's confidence is below `INSTAGRAM_VALIDATE_BELOW` (default 0.70);
- an entry fits several catalogue records, or none but there are near ones;
- the product category could not be told;
- a machine-read entry collides with an existing group (worth checking the
  entry was read correctly before a person is asked to resolve a conflict).

It receives the doubtful entries (at most 25), up to six catalogue records for
each, and the image. It may **suggest** one of the offered records, say an
entry was misread or is not in the image, and suggest a category. It cannot
resolve an entry, add one, name a record it was not offered, or touch the group
comparison. A suggestion appears on the review card for one-click confirmation;
a disputed entry moves to *needs review*. If the call fails the extraction is
kept untouched and the proposal says **VALIDATION FAILED**; with no key it says
a second opinion was wanted and none is configured.

Confidence routing: **≥ 0.90** straight to database matching · **0.70 – 0.89**
matched, validated only if matching turns up doubt · **< 0.70** validated, and
never better than *medium* in the review queue.

### Budgets, caching, cost

| Per import (resettable by *Resume*) | Default | Variable |
| --- | --- | --- |
| posts that may use AI | 40 | `INSTAGRAM_MAX_AI_ITEMS_PER_SYNC` |
| Gemini calls | 60 | `INSTAGRAM_MAX_GEMINI_CALLS_PER_SYNC` |
| Claude calls | 10 | `INSTAGRAM_MAX_CLAUDE_VALIDATION_CALLS_PER_SYNC` |
| minutes of video | 20 | `INSTAGRAM_MAX_VIDEO_MINUTES_PER_SYNC` |

When a budget is spent the post is **queued** (`deferred_ai`, state
`QUEUED_FOR_AI`), the rest of the page is still classified for free, and the
job ends as **AI processing budget reached — remaining items queued**. *Resume*
starts a new budget. The daily caps (`INSTAGRAM_DAILY_*`) sit above these and
pause the job as `quota_exhausted`; a provider's own rate limit pauses it as
`rate_limited`.

Everything is cached in `instagramMediaCache`: OCR, screen and deep read by the
SHA-256 of the image bytes, a video by its media id, a validation by the hash
of the question, the image and the model. A repost, a re-import and a second
scan of the same page cost nothing.

Every call records provider, model, input / output tokens and an **estimated**
cost (list prices in `ai-providers.js`, dated `PRICES_AS_OF`; override with
`INSTAGRAM_AI_PRICES`). A model with no known price is counted as "unpriced",
not as free. The totals are kept per job, per day and per source, and shown on
the job, the source list and the review card.

In the tests, a 150-post page of a repair channel spends 59 Gemini calls (40
screens, 19 deep reads) and a second scan spends none. Those are fixture
numbers; a real page's are on its job page.

### Is it actually working?

`node scripts/instagram-verify-providers.js`, or **Verify the providers with a
real call** on the importer page, calls each provider with the configured key:
a model listing and a one-pixel image for Gemini (both models), a model lookup
and a tiny structured answer for Claude, the account's own profile for the
Graph API. Each is reported `VERIFIED` or `NOT_VERIFIED` with the reason
(`API_KEY_MISSING`, `API_KEY_INVALID`, `MODEL_NOT_FOUND`, `RATE_LIMITED`,
`ERROR`). Nothing reports success without a successful call, and the check says
what it does not prove (video understanding needs a real reel).

`node scripts/instagram-ai-smoke.js --image <file> [--video <file>]` runs the
real pipeline on local files against the built catalogue, in memory.

There is no stand-in model in a production path. A missing or rejected key
makes the item `INSUFFICIENT_EVIDENCE` with the code `API_KEY_MISSING` /
`API_KEY_INVALID`, and it is read again once a working key exists.

### Other providers

| Key | Role |
| --- | --- |
| `GOOGLE_VISION_API_KEY` | **Optional OCR** (`DOCUMENT_TEXT_DETECTION`). Lets stage 2 stop a repair diagram before any model is asked, and cross-checks a deep read: the share of the model's entries OCR also saw sets the evidence confidence. |
| `AI_GATEWAY_URL` / `AI_GATEWAY_TOKEN` | The self-hosted route (`docs/AI-ARCHITECTURE.md`): `media_ocr`, `vision_understand`, `video_analyze` (key frames + transcript), `extract_compatibility`. Used when chosen with `INSTAGRAM_VISION_PROVIDER` / `INSTAGRAM_VIDEO_PROVIDER` / `INSTAGRAM_OCR_PROVIDER`, or when it is the only thing configured. |
| `ANTHROPIC_API_KEY` alone | Claude reads the images itself (no screen stage, no second opinion — a model does not validate itself). |

**Without any reader** an image is recorded as unread and a video as
unavailable; a post whose caption decides nothing is **Insufficient evidence**,
not "irrelevant", and is read again on the next import once a reader exists.

### Pipeline states

Every item and extraction carries one: `INGESTED` · `CHEAP_FILTERED` ·
`SCREENED` · `QUEUED_FOR_AI` · `AI_PROCESSING` · `AI_EXTRACTED` ·
`MODEL_MATCHING` · `GROUP_MATCHING` · `CONFLICT_DETECTED` · `READY_FOR_REVIEW` ·
`APPROVED` · `REJECTED` · `FAILED` · `RETRY_REQUIRED` · `VIDEO_UNAVAILABLE` ·
`API_KEY_MISSING` · `RATE_LIMITED`. The extraction also keeps the trace — which
rungs the post climbed, the cheap-filter score with its signals, and the
reader's confidence — shown on its card.

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

## 5a. Is the post about compatibility at all?

`relevance.js` decides, from two vocabularies and from what the extractor
found:

| Class | Meaning | Where it shows |
| --- | --- | --- |
| `RELEVANT_COMPATIBILITY` | a compatibility statement or list, for a catalogue product | Relevant |
| `PARTIALLY_RELEVANT` | a statement with no mapped product, or only an implied listing | Relevant |
| `NEEDS_REVIEW` | compatibility and repair wording both; or a list whose models did not resolve | Needs Review |
| `INSUFFICIENT_EVIDENCE` | the media could not be read, so it cannot be judged | Needs Review (if the caption talks about compatibility), else Errors |
| `IRRELEVANT_REPAIR` | jumper, bypass, IC, dead / shorting, baseband, charging or temperature error, board-level repair | Ignored |
| `IRRELEVANT_GENERAL` | no statement and no list — stock announcements, greetings | Ignored |
| `DUPLICATE_SOURCE` | the same page posting the same caption and the same text again | Ignored |

Rules that decide the hard cases:

- **A list wins over a repair caption.** A reel captioned with a jumper tip that
  shows a headed model list is compatibility content; only the list is used.
- **A statement tied together by repair wording is not a list.** *"Samsung A14
  5G display light jumper same as A15"* joins two phones — by a repair route.
  It is dropped, and "display" there is not the product Display.
- **A generic caption decides nothing** (see §3).
- **Nothing is deleted.** An ignored post keeps its class, the words that
  decided it and its text, behind the *Ignored* tab. An ignored post costs no
  alias read, no production read and no AI call.

Extraction Results has one tab per tag — **Relevant** (the default), All,
Existing Group Updates, New Groups, Needs Review, Conflicts, Ignored, Errors.
The tags are stored on the extraction and recomputed on every decision and
edit, so a tab is one indexed query and lists what is true *now*. A version a
newer one replaced carries no tags.

---

## 5b. Lists and group proposals

The extractor returns each explicit statement whole: its product title (a line
naming **one** model and a product — "Vivo Y20 Combo"), every model it lists,
and the line each was read from. It reads lists as posters and reels print
them: a heading with a count or a brand in brackets ("COMPATIBLE WITH (68)",
"COMPATIBLE MODELS (VIVO)"), numbering ("1. Vivo Y20", "5 Vivo Y12s"), two OCR
columns on one line ("Vivo Y15a Vivo Y15c"), a watermark between columns, a
brand written once ("Realme 5, 5s, 5i"), and a Hindi or Tamil sentence above
an English heading ("यह एक Display लग जाएगा 68 models में").

`group-proposals.js` then:

1. **Resolves and merges entries on the catalogue record.** "Y20 A", "vivo y
   20a" and "Vivo Y20a" are one entry with three spellings as evidence. The
   same list in another frame or carousel image is merged into it; a list with
   no title of its own takes the one product title the post gives elsewhere.
2. **Reads production**: one `modelGroups` document per distinct model, one
   `groups` document per group touched, the target group's `groupDetails` —
   each once per tick. Never a collection.
3. **Chooses the target group**: the group of the product the post names; else
   the group most of the list is already in; a tie chooses none.
4. **Chooses the master**: an existing group keeps its master. A new group's
   master is the product the post names; with no such line it is **MASTER MODEL
   REVIEW REQUIRED** and approval waits. It is never "the first model listed".
5. **Places every entry**: `existing` · `add` (no group in the category) ·
   `conflict` (already in another group) · `needs_review` (ambiguous, a
   variant to confirm, or a weak match) · `unmatched` · `excluded`.

| Proposed action | When |
| --- | --- |
| `NO_CHANGE` | the group already holds every resolved model — kept as evidence |
| `UPDATE_EXISTING_GROUP` | an existing group, plus models that have no group yet |
| `CREATE_NEW_GROUP` | no listed model has a group in the category |
| `CONFLICT_REVIEW` | a listed model already belongs to another group, or two groups tie |
| `MERGE_REQUIRED` | the list holds most (≥ half, ≥ 2) of another group — the post treats two groups as one part |
| `MODEL_REVIEW` | fewer than two models resolved with certainty |
| `PRODUCT_CATEGORY_REVIEW` | the product is not one of the catalogue's categories |

Each entry's match is shown in plain words — Exact Match, Normalized Match,
Alias Match, Similarity Match, Needs Review, Unknown / Not Found — with the
frame or image, the OCR line and the OCR confidence it came from.

**Editing a proposal** (each is a server call; the proposal is recomputed
against production before the card is redrawn): pick the catalogue record for
an entry · exclude an entry / put it back · add a catalogue model the post did
not list · choose the master of a new group · choose the target group or "a
new group" · change the category · re-check production.

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
| Existing group — proposed update | a list that matches a group and names models it lacks |
| New group proposals | a list none of whose models has a group in the category |
| High confidence — ready | exact matches, clear category, explicit, strong evidence, no variant question, no conflict |
| Medium / low — review required | everything else that is matched, with the reasons named |
| Unmatched models | a side, or a reference, with no catalogue record |
| Ambiguous models | a side that fits several records |
| Compatibility conflicts | sources disagree, a source disagrees with production, or a list names a model already assigned to another group |
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

### 6a. One category + one model = one group

A search for "Samsung A14 · tempered glass" must return one part. So:

- **Approving a group proposal** re-reads the `modelGroups` document of every
  listed model *inside the transaction* and plans again from that. Any model
  that has a group in the category other than the target is **BLOCKED — MODEL
  ALREADY ASSIGNED**; the whole approval is refused (`category-conflict`, with
  the model, its existing group and the proposed group), nothing is written,
  the refusal is audited, and the card is updated to show the conflict. It makes
  no difference what the card said when it was drawn.
- **What a blocked model needs** is a person: *Keep it where it is* (excluded
  from this proposal) or *Request reassignment*. A request is recorded with the
  approval as `approved_pending_master` — the model is **not** moved here.
- **What approval writes** is additive: models with no group in the category
  join the target group, and one ledger entry is written per added model in the
  same shape a pairwise approval writes — so the build overlay and the import
  guard below cover it unchanged. A **new group** is created in the live data
  under a number from the issued range (9001 upward per category — the build
  numbers from 0001, so the two never meet) and recorded in the ledger as
  `new_group`; the build carries it under that number. Its serial is the
  build's to issue and is left empty until then.
- **The catalogue import** (`scripts/import-firestore.js`) refuses to publish a
  build in which any device sits in two groups of one category
  (`--allow-duplicate-assignments` overrides, deliberately awkward);
  `build-dataset.js` lists them in `report.json`.
- **The pairwise approval** already refused "different groups" and a model in
  several groups.

Moving ONE model between two groups, changing an existing group's master and
removing a member are never done by an approval. A person does them in
**Compatibility Management** (§6c) — in this project, on this project's data.

### 6b. Instagram Intelligence — applied without a person

`auto-apply.js` decides whether a list passes, and applies it through the
**same transaction** a person's approval runs (`approveProposal`, with
`auto: true`). There is no second write path: the catalogue foreign keys, the
one-group rule and the ledger are enforced there for both.

| What the list says | What happens | When |
| --- | --- | --- |
| a model with no group in the category, in a list that describes an existing group | it is **added** to that group | live at once |
| none of its models has a group | a **group is created**, numbered from the issued range (`BF-9001`, `MPF-BF-9001`) so it can never collide with a number the build issues | live at once |
| it holds at least half of another group **and** at least two of its models, or all of a group of one | that group is **merged** into the target: its models move, and its two documents are kept, marked `mergedInto`, so a page still holding the old group id is answered with the group it became | live at once (a merge too large for one transaction is recorded for the build instead) |
| the product is a part type there is no category for ("camera glass") | the **category is created** in the compatibility data, and the group in it | live at once in the admin panel; on the public site once the category is in the site build |
| one of its models is in a group the list barely touches | the model **stays where it is**; the rest of the list goes ahead | never |
| an entry is unmatched, ambiguous, a variant to confirm, or disputed | it is **skipped and reported**; the rest goes ahead | never |

The public *search bundle* and the generated pages are static files built with
the catalogue: they list a new group, and drop a merged one, at the next
catalogue build. The part lookup itself (`/api/device-parts`) reads the live
data and is right at once.

**A visual box is not a database group.** Two boxes of one image that share
models are one list (`consolidateSets`), and a list whose models already have
a group joins that group — a post with four boxes does not create four groups.

**What stops a whole list** (it stays in the review queue, marked
`autoApply.status: attention`, with the reason): the product is not one of the
site's categories · the reading is weak (a low confidence band — an unclear
picture read by a model alone, or a second reader's dispute) · fewer than two
of its models are catalogue records for certain · the post mixes compatibility
with repair content · anything the transaction refuses.

**The master of a new group** is the product the post names; else the base
model the other names in the list extend ("Realme 5" for 5s and 5i); else the
shortest catalogue name, then alphabetical. Deterministic, stored with its
reason, and never "the first one printed". An existing group keeps its master.

**Who.** A scan applies automatically only when the administrator who started
it holds `compat.approve` and `INSTAGRAM_AUTO_APPLY` is not `off` — decided in
`createJob` from the verified role and stored on the job; no request can ask
for it. Every change is recorded as `instagram-intelligence` acting
`onBehalfOf` that administrator: on the proposal, in the ledger
(`automatic: true`), on the group (`lastChange`) and in the audit log
(`compat.auto_applied`).

**Undo.** *Compatibility Management → Recent changes → Undo* takes back what
one list did: the models it added come out of the group, a group it created is
removed (refused if it has gained models since), and a group it merged is a
group again with its models back in it. The ledger entries are kept
and marked `reverted` / `cancelled`, so the next build does not restore them.
Needs `compat.approve`. No model is ever deleted from the catalogue.

**Categories.** Eight are the SITE's: each has a part-code prefix, a picture
and generated pages, and is declared in `scripts/build-dataset.js`. A category
can also be created in the compatibility data itself (`compatCategories`,
`compat/category-service.js`) — by a scan, or by an administrator.

- A scan creates one only for a closed list of fitted part types
  (`CREATABLE_CATEGORIES` in `taxonomy-service.js`: Camera Glass, Back Glass,
  Touch Glass, Main Flex, Speaker, Housing, Flip Cover), each with the words
  that mean it. A charger or a power bank is not a fitment category, and a
  word nobody listed never becomes one. `INSTAGRAM_AUTO_CREATE_CATEGORIES=off`
  turns this off.
- It gets a part-code prefix nobody else has (`CG`), and its groups are
  numbered `CG-9001` onward.
- It is complete in the compatibility data at once — groups, the one-group
  rule, the admin panel — and is **not served to the public site** until it is
  added to the build's register: the public lookup filters to site
  categories, and the build writes its groups to their own files
  (`groups-runtime.ndjson`), which none of the public outputs read.

### 6c. Compatibility Management — changing a group by hand

`api/_services/compat/management.js`, behind `compat.approve`, from the
*Compatibility Management* page:

| Action | What it does | What it refuses |
| --- | --- | --- |
| Add a model | the model joins the group | a model that is not in All Brands & Models; one that already has a group in the category (**BLOCKED — MODEL ALREADY ASSIGNED**) |
| Remove a model | the relationship goes; the model stays in the catalogue | the master (choose another first); the last member (delete the group) |
| Make master | the model becomes the master and leads the list | a model that is not in the group |
| Merge into this group | the other group's models move here; this group keeps its master and part code | groups of different categories |
| New group | created under the next issued number | any model that already has a group in the category |
| Delete group | the relationship goes; every model stays in the catalogue | — (the request must repeat the group number) |
| Create / rename / delete category | run-time categories only | a site category (it is code); a category that still has groups |

Every one is a single transaction over `groups`, `groupDetails` and
`modelGroups`, writes its ledger entry in the same transaction, and is
recorded in the audit log.

### Keeping approvals through the next import

`scripts/import-firestore.js` rewrites groups from the build, which would undo
an approval. So:

1. `node scripts/export-approved-compatibilities.js --project <id>` →
   `data/raw/approved-compatibilities.json`. It also prints the merges the
   build will fold in and the reassignments requested of the master.
2. `node scripts/build-dataset.js` replays the ledger over the baseline, in
   the order the changes were made: models added and removed, masters changed,
   groups created (under the number issued then), merged (the absorbed group
   leaves the build) and deleted. Each is found by the device it was anchored
   on. An undone or cancelled entry is skipped. Anything that no longer fits
   is listed in `report.json`, never guessed.
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
  crash goes back to the queue. Done items are never redone. On a job that
  ended as `budget_reached`, Resume starts a **new AI budget** and re-queues
  the posts that were waiting for a model (the page asks first).
- **Analyse anyway** — a one-post job with `forceDeep`: the cheap filter and
  the "unchanged" skip are bypassed for that post only, and it is stored as a
  new version. Only ever with a single post URL.
- **Retry failed** — an item is retried up to `INSTAGRAM_MAX_ATTEMPTS`, then
  marked failed; this re-queues the failed ones.
- **Cancel** — stops the job and cancels its queued items; processed items stay.
- **View errors** — the last 50, with the item and the cause.
- **Scan first** — a scan of a whole page lists it and scores every post from
  its caption (free), then stops as `scanned` with a summary: likely relevant,
  needs a visual check, likely irrelevant, already processed. Nothing is read
  by a model and nothing changes until **Continue**. One post, or text typed by
  hand, has nothing to summarise and goes straight on.
- **How many posts** — up to `INSTAGRAM_MAX_ITEMS_PER_JOB` (default 500), paged
  through the API. What a scan may *spend* is the AI budget; the posts it does
  not reach are queued for Resume.
- **Re-import** — unchanged posts are skipped; a changed caption or carousel is
  a new *version*: the old extraction is kept and its open candidates are
  marked superseded.

---

## 8. Data

All server-only (`allow read, write: if false` in `firestore.rules`). No collection was added for classification, lists or proposals: they extend the ones below.

| Collection | Key | Holds |
| --- | --- | --- |
| `instagramSources` | `ig_<username>` | access verdict + reason, account type, followers (metadata), reputation, ignored; `stats` (content / relevant / ignored / needsReview / errors — one bucket per post, moved on re-classification), last scan, last successful scan |
| `instagramImportJobs` (+ `/items`) | auto / media id | status, cursor, counters (the funnel: cheap-rejected, screened, deep-analysed, validated, queued for AI…), `usage` (calls, tokens, video seconds, estimated cost in micro-USD), `budget` spent, errors, lease; the work queue, each item with its `pipelineState` |
| `instagramContent` | `igm_<mediaId>` / `man_<hash>` | caption, hashes, per-media OCR / vision status, versions, duplicate status, relevance + reason, what could read media when it was processed, `manualEvidence` |
| `instagramExtractions` | `<contentKey>__v<n>` | texts (caption, OCR, vision, frames, admin-entered), relevance + reason + the signals that decided it, `filters` (the tabs), proposal summaries, references, relationships, AI use |
| `compatibilityCandidates` | deterministic | the review queue, with the whole evidence chain and history — pairs, unmatched references and **group proposals** (`kind: group_proposal`) |
| `compatibilityEvidence` | = candidate id | every statement, linked by `relKey` |
| `approvedCompatibilities` | `relKey` | the ledger: status, applied change, evidence, approver; also `new_group` and `master_change_request` entries |
| `instagramMediaCache` | content hash | OCR / screen / deep read / video / validation / AI results; previews of admin screenshots |
| `instagramUsageDaily` | `YYYY-MM-DD` | call counters for the caps, tokens and estimated cost per provider |

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

The Graph token, app secret, Gemini key, Anthropic key, Vision key and AI
gateway token are read from the environment by the services and never sent to
the browser; the overview reports only whether each is set, and the provider
check reports only whether each was accepted. A provider's error message is
never passed through with a key in it. A test asserts no secret appears in any
response and that the admin UI makes no call to Instagram, Gemini, Anthropic,
Vision or the gateway.

Images and videos of public posts are sent to Google (Gemini) for reading, and
the doubtful ones to Anthropic (Claude). Gemini requests are sent with
`store: false`; a video uploaded through the Files API is deleted after the
read.

---

## 10. Deploying

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

Then set the environment in Vercel (see `.env.example`): at minimum
`INSTAGRAM_GRAPH_ACCESS_TOKEN` and `INSTAGRAM_BUSINESS_ACCOUNT_ID`; to read
images and video, `GEMINI_API_KEY`; for the second opinion, `ANTHROPIC_API_KEY`
(optional — without it doubtful lists simply go to manual review);
`GOOGLE_VISION_API_KEY` for OCR is optional. Redeploy, then press **Verify the
providers with a real call** on the importer page: a key that is set is not a
key that works. No new serverless function is added — the project stays at 12.

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
- **Copyrighted reels** come without `media_url` — most reels. Their lists are
  read from the cover if Meta provides one, or from screenshots an admin adds.
- **Full-video analysis needs a video reader** (Gemini, or the gateway's
  `video_analyze`) *and* the video itself. Having a key does not get the video:
  Meta decides per reel. Without both, a reel is its caption, its cover and
  whatever an admin attaches, and it is marked `VIDEO_MEDIA_UNAVAILABLE`.
- **Gemini video is sent whole.** The documented clipping offsets have no
  stated unit, so they are not used; pass 2 re-reads the clip rather than only
  the seconds pass 1 pointed at. Audio is read by Gemini with the video; there
  is no separate transcript.
- **Costs are estimates** from the tokens each provider reports and a price
  table with a date on it. The provider's invoice is the truth.
- **The real provider calls are only as verified as the last check.** The unit
  tests use injected providers; `instagram-verify-providers.js` is what proves
  a key, a model and image input.
- **The public search bundle is a build artefact.** A group created or merged
  in the live data is in the part lookup at once; the static search bundle and
  the generated pages follow at the next catalogue build + deploy. There is no
  automated build yet.
- **A run-time category is not on the public site** until it is added to the
  build's register, with its picture and pages.
- **A scan never removes a model, deletes a group or changes a master.** A
  person does, in Compatibility Management.
- **The catalogue baseline files live outside the repository** (the build's
  `--src` folder). They are this project's own snapshot; keep them.
- **Stories are not available** through Business Discovery.
- **Media URLs expire**: previews in the review card work for a while; the
  permalink is the lasting reference. Media is not stored.
- **OCR, vision, frames and speech need a provider**; without one, an image
  post is "Insufficient evidence" and the job says so.
- **Model-number codes** (e.g. SM-A155F) match only once an admin teaches the
  alias; the catalogue holds no model codes.
- **New groups are not created here**: an approved pair or list with no
  existing group waits for the catalogue build.
