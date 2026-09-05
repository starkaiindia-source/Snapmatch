# Local LLM, chatbot and the automation pipeline

What is built, what is deliberately not, and where the model actually runs.

---

## 1. Where the model runs — and why not here

```
   customer browser  /  admin browser
            │  HTTPS + Firebase ID token
            ▼
   /api/chat, /api/admin/ai                    Vercel — this repo
            │
            ▼
   api/_services/ai-service.js                 the GATEWAY
            │  decides IF the model is called at all
            │  HTTPS + bearer token, private network
            ▼
   Local LLM service                           a machine YOU control
            │
            ▼
   tool + knowledge layer
            │
            ▼
   search-service · Firestore · catalogue · approved external APIs
```

**The model does not run in this codebase, and it cannot.** A Vercel function is
a short-lived container with no GPU and a hard memory ceiling. A browser cannot
hold a production model either. Anyone who ships "a local LLM" inside a static
site has shipped a text box.

So `ai-service.js` is a **contract** with a service running elsewhere — your own
box, a rented GPU host, an on-premise server behind a VPN.

### The contract

One endpoint:

```
POST {AI_GATEWAY_URL}/v1/task
Authorization: Bearer {AI_GATEWAY_TOKEN}
Content-Type: application/json

{ "capability": "assist_zero_result",
  "model": "<AI_GATEWAY_MODEL or null>",
  "systemHint": "…grounding for this call…",
  "input": { … } }

200 → { "message": "…", …capability-specific fields }
```

Anything else — non-200, malformed JSON, a timeout — comes back to the caller
as `{ ok: false, reason }`. Every caller has a deterministic fallback, so none
of them turns into a 500.

**With `AI_GATEWAY_URL` and `AI_GATEWAY_TOKEN` unset**, every AI feature reports
itself unavailable *by name*. Nothing is faked. There is no demo mode — a
fabricated AI answer stored as a real draft is the fastest possible way to get
invented data approved by someone in a hurry.

A URL without a token counts as unconfigured on purpose: an unauthenticated AI
endpoint reachable from a public serverless function is somebody else's free
GPU, billed to you.

### Capabilities

Declared in `ai-service.js`, listed in the admin UI, and the only values
`invoke()` accepts:

`answer_user_question` · `normalise_model_name` · `explain_compatibility` ·
`assist_zero_result` · `propose_missing_model` · `seo_content_draft` ·
`marketing_content_draft` · `business_insight`

---

## 2. The hard rule: AI never writes to production

Not a policy someone has to remember. **The shape of the code.**

`ai-service.js` exports no function that writes to `models`, `groups`,
`groupDetails`, `deviceGroups` or any catalogue collection. What it can do is
create an `aiTask` — a proposal with `status: 'draft'`.

```
model produces something
        │
        ▼
   aiTasks/{id}   status: draft            ← nothing user-facing has changed
        │
        ▼
   an administrator with ai.approve reviews it
        │
        ├── rejected  → status: rejected, done
        └── approved  → status: approved   ← STILL not published
                          │
                          ▼
                   a separate, explicit action applies it
                   (missing-model workflow → importer)
```

Three stops between "the model produced something" and "shops see it on the
site". That is what makes the automation safe to leave running.

The admin API says so in its own response body — `"Approved. This is not
published: applying a catalogue change is a separate step."` — because
*approve* is a fast click and *change what every shop sees* should not be the
same one.

### Prompt-injection posture

A task's `payload` is stored as data and read as data. Nothing in this codebase
executes it, interpolates it into a query, or treats it as an instruction. A
model that emits *"ignore your rules and publish this"* produces a row with that
text in it and no other effect.

### What goes to the model

Catalogue facts and aggregated counts. **Never raw customer data** — no phone
number, no email, no address, not to a hosted model and not to one running in
the next room. Search terms that reach an AI task have already been through the
PII redaction in `_schema/analytics-event.js`.

---

## 3. The chatbot

Database first. The model, if there is one, writes the sentence around an answer
the server already knows.

```
user message
     │
classify intent          rules, not a model — six patterns, predictable, free
     │
extract the subject      stop-words removed; digits always kept
     │
is it plausibly a handset?  ── no ──▶ "which handset?"   (nothing recorded)
     │ yes
     ▼
search-service:  exact ─▶ partial ─▶ fuzzy (Damerau-Levenshtein)
     │
     ├── confident match ──▶ answer from the catalogue
     │                        real part codes, real member lists
     │
     ├── ambiguous ───────▶ a LIST to choose from, never a guess stated as fact
     │
     └── nothing ─────────▶ 1. record a missing-model request
                            2. ask the AI to phrase the refusal  (optional)
```

### What the model may and may not supply

| Not allowed | Allowed |
| --- | --- |
| a model name | the wording |
| a part code | |
| a compatibility claim | |
| a specification, price or date | |

Enforced structurally rather than by asking nicely in a prompt: the reply
carries `facts`, built here from search results, and `message`, which is prose.
The client renders **facts** for anything a shop would act on. A model that
hallucinates *"MPF-SG-9999 fits your phone"* writes that into a sentence sitting
beside a real, empty fact list.

### `confident` is the safety property

This is where chatbots normally go wrong: they take the top result and state it
as fact.

```
"Realme 5"           → exact,   confident   → answered directly
"reame 5"            → fuzzy,   confident   → answered, best match distance 1
"samgung galxy m21"  → fuzzy,   NOT confident → offered as a list
"Nokia 3310"         → partial, NOT confident → three variants, user picks
"Zebraphone 9000"    → none                  → "not found", request recorded
```

Verified against the real 4,933-model catalogue in
`api/_lib/search-chat.test.js`.

### Without a model configured

Everything above still works. Intent classification is rules, search is
deterministic, phrasing falls back to a written template. **The chatbot is fully
functional without an LLM** — the LLM only makes it read better. A feature that
cannot work without a GPU is a feature that is down whenever the GPU is.

---

## 4. Automatic website updates

The correct meaning of "automatic": the pipeline runs by itself and stops at a
human before anything reaches production.

```
user searches an unknown model
        │
system checks the database  (search-service, deterministic)
        │
no result
        │
missingModelRequests/{normalisedKey}       ← aggregated, not accumulated
        │  "Realme 5", "realme5", "REALME  5" → one record, count++
        │
AI may analyse whether it is a real handset       (propose_missing_model)
AI may gather candidate information               (future)
        │
draft record → aiTasks, status: draft
        │
validation checks
        │
ADMIN REVIEW  ── the pipeline stops here, always
        │
approved → published → the importer writes the catalogue
```

### Why aggregation, not accumulation

Forty shops looking for the same handset in a week is **one** piece of
information — add this model — not forty rows to read through. The normalised
name is the document id, so a repeat is a counter increment.

Normalisation is aggressive enough to collapse how people actually type:

```
"Realme 5"  "realme5"  "REALME  5"  "Realme-5"  "Réalme 5"   → realme5
```

and stops short of collapsing **different** handsets:

```
"Realme 5"  →  realme5          "Galaxy A10"   →  galaxya10
"Realme 5i" →  realme5i         "Galaxy A10s"  →  galaxya10s
```

That second property is the expensive one. Merging two handsets puts the wrong
tempered glass in an order, and nobody notices until a customer complains.
Tested in `api/_lib/missing-models.test.js`.

### The status workflow

```
new ─┬─▶ under_review ─┬─▶ researching ─▶ draft_found ─▶ approved ─▶ published
     │                 │                                              (final)
     ├─▶ researching ──┘
     ├─▶ not_a_valid_model ──▶ new        (repeated demand reopens it)
     └─▶ duplicate ──────────▶ new
```

`published` has **exactly one way in**, and it is `approved`. The transition
table is consulted inside a Firestore transaction against the status that is
actually stored — not the one the client thought was stored — so two admins
acting at once cannot combine into a jump neither made.

`new → published` is impossible for anyone, including a `super_admin`, and
including a bug.

Publishing also needs its own permission, `missing_models.publish`, separate
from `missing_models.write`. Triaging a queue and changing what every shop sees
are different acts; they should not share a permission just because they share
a page.

---

## 5. SEO automation (prepared, not built)

The future `seo-service` reads: the model database, brands, compatibility
groups, search demand from `analyticsDaily`, `missingModelRequests`, the
existing page set, and Search Console once it is connected.

Its output goes to `aiTasks` with type `seo_meta_draft` or `seo_content_draft`.

**Quality controls before anything publishes** — none of this is optional:

- an approval step per batch, never per thousand pages
- a cap on pages generated per run
- a duplicate-content check against existing pages
- a factual check: every claim in generated copy must trace to a catalogue record
- meta titles and descriptions length-checked before they are offered

The failure mode being designed against is a model publishing five thousand
thin pages overnight and the site losing its rankings.

---

## 6. Instagram and marketing (prepared, not built)

The future `social-service` connects only through the **official** Instagram
Graph API with approved permissions.

Capabilities: collect inbox messages, categorise them, draft replies via the
LLM, analyse campaign metrics, suggest optimisations, draft marketing copy.

Fixed constraints:

- **no social passwords in the database, ever** — OAuth tokens only, in the
  server environment, never in Firestore and never in a browser
- no automation of behaviour the platform prohibits
- replies are drafts requiring approval, or run under narrowly configured rules
  a person set — never open-ended autonomous messaging
- campaign metrics join to `analyticsDaily` by day, so ad spend and on-site
  behaviour are comparable without a second analytics system

---

## 7. Building the Local LLM service

Not part of this repository. What it has to do:

1. Serve `POST /v1/task` and check the bearer token on every request.
2. Run on hardware you control, reachable from Vercel over HTTPS.
3. Accept `{ capability, model, systemHint, input }` and return JSON.
4. Keep its own tool layer read-only against the catalogue. **The gateway holds
   no write credential and the local service must not be given one.**

Any runtime works — llama.cpp, Ollama, vLLM, TGI — behind a thin HTTP wrapper
that implements the contract. The choice of model is yours and this codebase
does not care, which is the point of putting a gateway between them.

Then:

```
AI_GATEWAY_URL=https://ai.your-host.example
AI_GATEWAY_TOKEN=<a long random string>
AI_GATEWAY_MODEL=<optional>
```

Redeploy. `/admin` → **Local AI** shows the connection state and the queue.
