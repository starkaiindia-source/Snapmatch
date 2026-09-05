/* ============================================================================
   Mobile Parts Finder · api/_schema/analytics-event.js
   ----------------------------------------------------------------------------
   The event contract: what may be recorded, and what may travel with it.

   ----------------------------------------------------------------------------
   WHY THIS IS AN ALLOWLIST AND NOT A FREE-FORM LOG

   A `POST /api/events` that accepts any event name and any metadata is three
   problems wearing a trenchcoat:

     · a public write endpoint that lets anyone fill the database
     · a PII leak the moment some future frontend passes a whole form object
     · an analytics table that cannot be queried, because nothing agrees on
       what an event is called

   So the event type must be one of the names below, and the metadata is
   filtered field by field against a per-type schema. Anything not listed is
   dropped silently — not rejected, because a browser running a stale build
   should keep sending its events, it should just not be able to invent fields.

   ----------------------------------------------------------------------------
   WHAT IS DELIBERATELY NOT COLLECTED

   No IP address. No user agent string. No screen fingerprint, no canvas hash,
   no font enumeration, nothing that identifies a device across sites. The
   session id is a random string the browser generates for itself and forgets;
   it is not derived from anything about the visitor.

   The purpose is business analytics — which models are searched, which
   searches find nothing, where the funnel leaks — and every field here earns
   its place against that purpose. "It might be useful later" is not a reason
   to store something about a person.

   ----------------------------------------------------------------------------
   THE EVENT

     eventId     the document id; server-generated, never client-supplied
     userId      the Firebase uid when authenticated, else null
     sessionId   an opaque random string from the browser, else null
     eventType   one of EVENT_TYPES
     timestamp   SERVER time, always. A device clock is not evidence.
     source      'web' | 'admin' | 'server' | 'chatbot'
     metadata    filtered per type, below
   ========================================================================== */
'use strict';

/**
 * Every event type the system will accept, grouped by what it is for.
 *
 * Adding one is a deliberate act: put it here, give it a metadata schema
 * below, and the ingest route starts accepting it. The list is what makes the
 * dashboard's queries possible — a type nobody declared is a type nothing can
 * count.
 */
const EVENT_TYPES = {
  /* ---- visit lifecycle --------------------------------------------- */
  first_visit: 'first_visit',
  return_visit: 'return_visit',
  page_view: 'page_view',

  /* ---- catalogue use ----------------------------------------------- */
  model_search: 'model_search',
  search_zero_result: 'search_zero_result',
  model_opened: 'model_opened',
  compatibility_group_opened: 'compatibility_group_opened',
  part_code_search: 'part_code_search',
  category_selected: 'category_selected',
  brand_selected: 'brand_selected',

  /* ---- account funnel ---------------------------------------------- */
  signin_started: 'signin_started',
  signin_completed: 'signin_completed',
  login: 'login',
  logout: 'logout',
  profile_completed: 'profile_completed',
  profile_updated: 'profile_updated',

  /* ---- money funnel ------------------------------------------------ */
  plan_page_viewed: 'plan_page_viewed',
  plan_selected: 'plan_selected',
  payment_started: 'payment_started',
  payment_completed: 'payment_completed',
  payment_failed: 'payment_failed',
  payment_cancelled: 'payment_cancelled',
  subscription_activated: 'subscription_activated',
  subscription_expired: 'subscription_expired',
  subscription_cancelled: 'subscription_cancelled',

  /* ---- assistance -------------------------------------------------- */
  chatbot_question: 'chatbot_question',
  chatbot_answered: 'chatbot_answered',
  chatbot_no_answer: 'chatbot_no_answer',
  missing_model_reported: 'missing_model_reported'
};

const EVENT_TYPE_LIST = Object.keys(EVENT_TYPES);

/** Where an event came from. Anything else is recorded as 'web'. */
const SOURCES = ['web', 'admin', 'server', 'chatbot'];

/* -------------------------------------------------------------- metadata

   Per type, the fields that may travel and how each is cleaned.

     str(n)   trimmed string, capped at n characters
     int      finite integer, clamped to a sane range
     bool     true/false only
     enum(..) one of a fixed set

   A field absent from a type's schema is dropped. A field present but of the
   wrong shape is dropped, not coerced — coercing "undefined" into the string
   "undefined" is how a dashboard ends up with a top search term of undefined. */

const str = max => ({ kind: 'str', max });
const int = (min, max) => ({ kind: 'int', min, max });
const bool = () => ({ kind: 'bool' });
const enumOf = values => ({ kind: 'enum', values });

/**
 * `searchQuery` is capped hard at 120 characters and is the one genuinely
 * user-typed field here. It is a phone model name — that is the whole point of
 * recording it — and a shop typing their own phone number into the search box
 * would be stored. The cap limits the blast radius; the redaction pass in
 * sanitiseMetadata removes anything that looks like a contact detail.
 */
const METADATA_SCHEMA = {
  first_visit: { landingPath: str(200), referrerHost: str(120) },
  return_visit: { landingPath: str(200), referrerHost: str(120) },
  page_view: { path: str(200), routeName: str(40) },

  model_search: {
    searchQuery: str(120),
    searchType: enumOf(['model', 'brand', 'part_code', 'group', 'free_text']),
    matchedResultCount: int(0, 100000),
    categoryId: str(40),
    brandId: str(40)
  },
  search_zero_result: {
    searchQuery: str(120),
    searchType: enumOf(['model', 'brand', 'part_code', 'group', 'free_text']),
    categoryId: str(40)
  },
  model_opened: { modelId: str(80), brandId: str(40), source: str(40) },
  compatibility_group_opened: { groupId: str(80), categoryId: str(40), memberCount: int(0, 100000) },
  part_code_search: { searchQuery: str(120), matchedResultCount: int(0, 100000) },
  category_selected: { categoryId: str(40) },
  brand_selected: { brandId: str(40) },

  signin_started: { provider: enumOf(['google']) },
  signin_completed: { provider: enumOf(['google']), isNewAccount: bool() },
  login: { provider: enumOf(['google']) },
  logout: {},
  profile_completed: { hasAddress: bool(), country: str(60) },
  profile_updated: { fields: str(200) },

  plan_page_viewed: {},
  plan_selected: { planId: enumOf(['monthly', 'yearly']) },
  payment_started: { planId: enumOf(['monthly', 'yearly']), amountPaise: int(0, 100000000) },
  payment_completed: {
    planId: enumOf(['monthly', 'yearly']),
    amountPaise: int(0, 100000000),
    providerPaymentId: str(60)
  },
  payment_failed: { planId: enumOf(['monthly', 'yearly']), reason: str(200) },
  payment_cancelled: { planId: enumOf(['monthly', 'yearly']) },
  subscription_activated: { planId: enumOf(['monthly', 'yearly']), periodMonths: int(1, 120) },
  subscription_expired: { planId: enumOf(['monthly', 'yearly']) },
  subscription_cancelled: { planId: enumOf(['monthly', 'yearly']) },

  chatbot_question: { intent: str(40), queryLength: int(0, 4000) },
  chatbot_answered: { intent: str(40), answeredFrom: enumOf(['database', 'alias', 'fuzzy', 'llm']) },
  chatbot_no_answer: { intent: str(40) },
  missing_model_reported: { normalisedName: str(120), source: enumOf(['search', 'chatbot', 'admin']) }
};

/* ------------------------------------------------------------- redaction

   A last line of defence over the free-text fields. The event schema already
   decides WHICH fields may travel; this decides what may be inside one.

   These patterns are deliberately blunt. A false positive costs one redacted
   search term in a report; a false negative puts a customer's phone number in
   an analytics table that a future LLM will read. */
const REDACTIONS = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]'],
  [/\b(?:\+?\d[\d\s-]{8,15}\d)\b/g, '[phone]'],
  [/\b\d{12,19}\b/g, '[number]']
];

function redact(text) {
  return REDACTIONS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

function cleanValue(spec, value) {
  if (value === undefined || value === null) return undefined;

  if (spec.kind === 'bool') {
    return typeof value === 'boolean' ? value : undefined;
  }
  if (spec.kind === 'int') {
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    return Math.min(spec.max, Math.max(spec.min, Math.round(n)));
  }
  if (spec.kind === 'enum') {
    const s = String(value);
    return spec.values.indexOf(s) > -1 ? s : undefined;
  }
  /* str */
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const t = redact(String(value).trim()).slice(0, spec.max);
  return t === '' ? undefined : t;
}

/** @returns {boolean} is this a type the system will record at all? */
function isKnownEventType(type) {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(METADATA_SCHEMA, type);
}

/**
 * Keeps only the fields this event type declares, cleaned to their spec.
 * Everything else is dropped without comment.
 *
 * @returns {object} never null — an event with no valid metadata gets {}
 */
function sanitiseMetadata(eventType, metadata) {
  const schema = METADATA_SCHEMA[eventType];
  if (!schema || !metadata || typeof metadata !== 'object') return {};

  const out = {};
  Object.keys(schema).forEach(key => {
    const cleaned = cleanValue(schema[key], metadata[key]);
    if (cleaned !== undefined) out[key] = cleaned;
  });
  return out;
}

/** 'web' unless the caller named a source we recognise. */
function normaliseSource(source) {
  return SOURCES.indexOf(source) > -1 ? source : 'web';
}

/**
 * The stored document.
 *
 * `timestamp` comes from the caller because the caller is the server — every
 * route passes its own Date.now(). Nothing here reads a client clock.
 */
function buildEvent({ userId, sessionId, eventType, source, metadata, now }) {
  return {
    userId: userId || null,
    sessionId: sessionId || null,
    eventType,
    source: normaliseSource(source),
    metadata: sanitiseMetadata(eventType, metadata),
    timestamp: now,
    /* The day bucket the rollups and the date-range filters key on. Stored
       rather than computed at read time so a range query is one index scan
       instead of a full pass with a date function over every row. */
    day: dayKey(now)
  };
}

/** UTC YYYY-MM-DD. One timezone everywhere, or two reports disagree by a day. */
function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

module.exports = {
  EVENT_TYPES,
  EVENT_TYPE_LIST,
  METADATA_SCHEMA,
  SOURCES,
  isKnownEventType,
  sanitiseMetadata,
  normaliseSource,
  buildEvent,
  dayKey,
  redact
};
