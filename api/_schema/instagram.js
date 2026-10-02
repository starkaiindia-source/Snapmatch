/* ============================================================================
   Mobile Parts Finder · api/_schema/instagram.js
   ----------------------------------------------------------------------------
   Shapes, keys, state machines and the confidence rules for the Instagram
   compatibility importer. Pure: no I/O, no Firestore, no network.

   ----------------------------------------------------------------------------
   THE AUTHORITY ORDER, WHICH EVERYTHING HERE FOLLOWS

     1. the catalogue (assets/search-index.json — every model, brand, category)
     2. the taxonomy layer (api/_services/taxonomy-service.js) and /aliases
     3. what an Instagram post actually says, verbatim
     4. what an AI made of it

   A lower level never overrides a higher one. An AI answer can suggest; it
   cannot produce a model id the catalogue does not hold, and it cannot raise
   a candidate above "medium". A post can claim; it cannot create a model, a
   brand or a category. When in doubt the answer is the review queue.

   ----------------------------------------------------------------------------
   ONE RELATIONSHIP, ONE KEY

   This catalogue stores exactly one kind of compatibility: two devices take
   the SAME PART in a category (they are members of one group). That relation
   is symmetric — "A15 glass fits the A15 5G" and "A15 5G glass fits the A15"
   are the same fact — so the key sorts the pair:

       <categoryId>__<modelId>__<modelId>__same_part

   A different kind of claim (a charger, a camera lens) has no category here
   and never gets a key; it goes to review as "unmapped category".
   ========================================================================== */
'use strict';

const crypto = require('crypto');

/** Bump when extraction or matching logic changes in a way that should make
    already-processed content eligible for reprocessing. Stored on every
    extraction, so "which logic produced this" is always answerable. */
/* ig-extract-2 (2026-10-01): a model reference is bounded to the longest span
   the catalogue recognises, so "Realme c65 no baseband problem" is the Realme
   C65 and not an unmatched five-word "model". Content read by ig-extract-1 is
   reprocessed on its next import, as a new version. */
/* ig-extract-3 (2026-10-01): every content item is CLASSIFIED before anything
   is queued — a repair or jumper post that happens to name a phone is ignored,
   not turned into "unmatched model" cards — and a compatibility LIST becomes
   one group proposal compared against the existing groups, instead of sixty
   pairwise claims. */
/* ig-extract-4 (2026-10-01): the cost pipeline. A weighted cheap filter
   decides how much is spent on each post; Gemini screens and reads media
   (including the video itself); Claude is asked only where matching left
   doubt. Prompts and the vision schema changed, so cached readings from
   ig-extract-3 are not reused. */
/* ig-extract-5 (2026-10-02): Instagram Intelligence. A list that passes every
   check is applied without a person approving it, and the category matcher
   learned the trade's "on off patta". The prompts did NOT change, so every
   cached reading is reused: a post read under ig-extract-4 is classified and
   compared again for free. */
const PROCESSING_VERSION = 'ig-extract-5';

/* ================================================================== URLs */

const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am', 'www.instagr.am']);

/* First path segments that are Instagram's own pages, never a username. */
const RESERVED = new Set([
  'p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct', 'about',
  'legal', 'developer', 'developers', 'web', 'api', 'graphql', 'challenge', 'privacy',
  'terms', 'session', 'login', 'signup', 'emails', 'oauth', 'static', 'hashtag',
  'locations', 's', 'ar', 'nametag', 'your_activity', 'settings', 'invites', 'lite',
  'qr', 'create', 'topics', 'directory', 'popular', 'threads'
]);

/* Instagram usernames: letters, digits, periods and underscores, at most 30,
   no leading/trailing period and no two in a row. */
const USERNAME_RE = /^(?!\.)(?!.*\.\.)[a-z0-9._]{1,30}(?<!\.)$/;
const SHORTCODE_RE = /^[A-Za-z0-9_-]{5,64}$/;

/**
 * Validates and classifies an Instagram URL.
 *
 * Accepts a profile URL, a post/reel/tv URL (with or without the username
 * segment newer share links carry), or "@handle". Tracking parameters
 * (igsh=…) and fragments are dropped. Anything else — another host, a
 * lookalike host, stories, a hashtag page, a non-http scheme — is refused
 * with a reason a person can act on.
 *
 * @returns {{ok:true, kind:'profile'|'post', username:string|null,
 *            shortcode:string|null, mediaPath:string|null, canonicalUrl:string}
 *          |{ok:false, reason:string}}
 */
function parseInstagramUrl(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'Enter an Instagram URL.' };
  const input = raw.trim();
  if (!input) return { ok: false, reason: 'Enter an Instagram URL.' };
  if (input.length > 500) return { ok: false, reason: 'That URL is too long to be an Instagram link.' };

  /* "@handle" shorthand. */
  const handle = /^@([A-Za-z0-9._]{1,30})$/.exec(input);
  if (handle) return profileResult(handle[1]);

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : 'https://' + input);
  } catch {
    return { ok: false, reason: 'That is not a valid URL.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'Only http(s) Instagram links are accepted.' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'A URL carrying credentials is not accepted.' };
  }
  const host = url.hostname.toLowerCase();
  if (!INSTAGRAM_HOSTS.has(host)) {
    return { ok: false, reason: `"${host}" is not instagram.com.` };
  }
  if (url.port && url.port !== '443' && url.port !== '80') {
    return { ok: false, reason: 'Unexpected port on an Instagram URL.' };
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (!parts.length) return { ok: false, reason: 'The URL has no profile or post in it.' };

  const first = parts[0].toLowerCase();

  if (first === 'stories' || first === 'highlights') {
    return { ok: false, reason: 'Stories and highlights are not available through the Instagram API, so they cannot be imported.' };
  }
  if (first === 'explore' || first === 'hashtag') {
    return { ok: false, reason: 'Hashtag and explore pages are not a single source. Enter a profile or a post.' };
  }

  /* /p/{code}  /reel/{code}  /reels/{code}  /tv/{code} */
  if (['p', 'reel', 'reels', 'tv'].indexOf(first) > -1) {
    return postResult(null, first, parts[1]);
  }
  if (RESERVED.has(first)) {
    return { ok: false, reason: `"/${parts[0]}" is an Instagram page, not a profile or a post.` };
  }

  const username = first;
  if (!USERNAME_RE.test(username)) return { ok: false, reason: `"${parts[0]}" is not a valid Instagram username.` };

  /* /{username}/p/{code} — the share-link form. */
  if (parts.length >= 3 && ['p', 'reel', 'reels', 'tv'].indexOf(parts[1].toLowerCase()) > -1) {
    return postResult(username, parts[1].toLowerCase(), parts[2]);
  }
  if (parts.length > 1 && ['tagged', 'reels', 'saved', 'feed', 'guides', 'channel'].indexOf(parts[1].toLowerCase()) < 0) {
    return { ok: false, reason: 'Enter the profile URL itself (instagram.com/<username>/) or a post URL.' };
  }
  return profileResult(username);
}

function profileResult(username) {
  const u = String(username).toLowerCase();
  if (!USERNAME_RE.test(u)) return { ok: false, reason: `"${username}" is not a valid Instagram username.` };
  return {
    ok: true, kind: 'profile', username: u, shortcode: null, mediaPath: null,
    canonicalUrl: `https://www.instagram.com/${u}/`
  };
}

function postResult(username, segment, shortcode) {
  if (!shortcode || !SHORTCODE_RE.test(shortcode)) {
    return { ok: false, reason: 'The post URL has no valid post code in it.' };
  }
  const path = segment === 'reels' ? 'reel' : segment;
  return {
    ok: true, kind: 'post', username: username ? username.toLowerCase() : null,
    shortcode, mediaPath: path,
    canonicalUrl: `https://www.instagram.com/${path}/${shortcode}/`
  };
}

/** The shortcode of a permalink the API returned, for matching a post URL. */
function shortcodeFromPermalink(permalink) {
  const parsed = parseInstagramUrl(permalink || '');
  return parsed.ok && parsed.kind === 'post' ? parsed.shortcode : null;
}

/* ================================================================== keys */

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : Buffer.from(value)).digest('hex');
}

/** Whitespace-normalised caption, so a re-save that only changed a newline
    is not "changed content". Case is kept: it can be evidence. */
function normaliseCaption(caption) {
  return String(caption == null ? '' : caption).replace(/\s+/g, ' ').trim();
}

function captionHash(caption) {
  return sha256(normaliseCaption(caption));
}

/**
 * What identifies a post's CONTENT before anything is downloaded: the
 * caption, and which media it holds. Instagram does not let a published
 * post's image be swapped, so a changed caption or a removed carousel item is
 * the change there is to detect. Media URLs are NOT included — they are signed
 * CDN links that rotate on every API call and would make every post look new.
 */
function contentSignature({ caption, mediaType, mediaIds }) {
  return sha256(JSON.stringify({
    c: captionHash(caption),
    t: String(mediaType || ''),
    m: (mediaIds || []).map(String).sort()
  }));
}

function sourceKeyFor(username) {
  return 'ig_' + String(username || '').toLowerCase();
}

function contentKeyFor({ mediaId, manualHash }) {
  if (mediaId) return 'igm_' + String(mediaId).replace(/[^A-Za-z0-9_-]/g, '');
  return 'man_' + String(manualHash || '').slice(0, 32);
}

function extractionIdFor(contentKey, version) {
  return `${contentKey}__v${version}`;
}

const RELATION_KIND = 'same_part';

/** The duplicate-detection key. Null unless both models and the category are
    known — an unresolved side has no identity to deduplicate on. */
function relKeyFor(categoryId, modelA, modelB, kind = RELATION_KIND) {
  if (!categoryId || !modelA || !modelB || modelA === modelB) return null;
  const [a, b] = [String(modelA), String(modelB)].sort();
  return `${categoryId}__${a}__${b}__${kind}`;
}

/** Deterministic, so reprocessing one content version never duplicates a candidate. */
function candidateIdFor({ extractionId, sourceText, compatibleText, polarity, referenceText, kind }) {
  const basis = kind === 'model_reference'
    ? `ref|${normaliseCaption(referenceText).toLowerCase()}`
    : `rel|${normaliseCaption(sourceText).toLowerCase()}|${normaliseCaption(compatibleText).toLowerCase()}|${polarity}`;
  return `${extractionId}__${sha256(basis).slice(0, 16)}`;
}

/* ============================================================ vocabularies */

const CONTENT_TYPES = ['image', 'carousel', 'video', 'reel', 'text'];

/** How a statement relates two models. Only the first three can become an
    import candidate, and only `explicit` can ever be "ready for approval". */
const COMPAT_TYPES = [
  'explicit',        /* "Compatible: A15 / A15 5G", "same glass", "fits"      */
  'implied',         /* "A15 / A15 5G Tempered Glass" — a listing, not a claim */
  'same_chassis',    /* "same body", "same size" — a hint, not a part claim   */
  'same_family',     /* "Galaxy A series" — never a compatibility claim       */
  'similar_name',    /* two names that look alike — never evidence            */
  'uncertain'
];
const IMPORTABLE_TYPES = ['explicit', 'implied', 'same_chassis'];
const POLARITIES = ['positive', 'negative'];

const CANDIDATE_KINDS = ['relationship', 'model_reference', 'group_proposal'];

const CANDIDATE_STATUSES = ['pending', 'approved', 'rejected', 'duplicate', 'ignored', 'superseded', 'resolved',
  /* an applied change a person undid: the models it added are out again */
  'reverted'];

/**
 * Who may follow whom. `approved` is final HERE: undoing a production fitment
 * is a catalogue decision, and this feature never deletes compatibility data.
 */
const CANDIDATE_TRANSITIONS = {
  pending: ['approved', 'rejected', 'duplicate', 'ignored', 'superseded', 'resolved'],
  rejected: ['pending'],
  duplicate: ['pending'],
  ignored: ['pending'],
  resolved: ['pending'],
  superseded: [],
  /* Approval is final for the QUEUE — it is not re-reviewed. A person can
     still undo what it did to the compatibility data (review-service.undoProposal). */
  approved: ['reverted'],
  reverted: []
};

function canTransitionCandidate(from, to) {
  return (CANDIDATE_TRANSITIONS[from] || []).indexOf(to) > -1;
}

const REJECT_REASONS = [
  'wrong_model', 'not_compatible', 'not_a_compatibility_claim', 'poor_ocr',
  'wrong_category', 'unsupported_by_evidence', 'spam_or_irrelevant', 'other'
];

/** The review queue's sections, in the order the UI shows them. */
const REVIEW_SECTIONS = [
  { id: 'group_updates', label: 'Existing group — proposed update' },
  { id: 'new_groups', label: 'New group proposals' },
  { id: 'ready', label: 'High confidence — ready for approval' },
  { id: 'review', label: 'Medium / low confidence — review required' },
  { id: 'unmatched', label: 'Unmatched models' },
  { id: 'ambiguous', label: 'Ambiguous models' },
  { id: 'conflicts', label: 'Compatibility conflicts' },
  { id: 'duplicates', label: 'Duplicate relationships' },
  { id: 'rejected', label: 'Invalid / rejected extractions' }
];
const REVIEW_SECTION_IDS = REVIEW_SECTIONS.map(s => s.id).concat(['closed']);

/* ---------------------------------------------------------------- jobs */

const JOB_STATUSES = [
  'queued', 'discovering',
  /* the page has been listed and scored for free; nothing has been spent, and
     a person presses Continue to start the analysis */
  'scanned',
  'processing', 'paused',
  'rate_limited', 'quota_exhausted',
  /* this sync's AI budget is spent; the items that still need a model wait */
  'budget_reached',
  'completed', 'completed_with_errors', 'failed', 'cancelled', 'unable_to_collect'
];
/** A job in one of these can be resumed where it stopped. */
const RESUMABLE = ['paused', 'rate_limited', 'quota_exhausted', 'budget_reached', 'failed', 'discovering', 'processing', 'queued'];
const TERMINAL = ['completed', 'completed_with_errors', 'cancelled', 'unable_to_collect'];

const ITEM_STATUSES = ['queued', 'processing', 'done', 'failed', 'skipped_unchanged', 'skipped_duplicate', 'cancelled',
  /* set aside because the sync's AI budget ran out; back in the queue on resume */
  'deferred_ai'];

/** Where one content item stands in the pipeline. Stored on the item and its
    extraction, with the stages it passed — a failure is a state, never a gap. */
const PIPELINE_STATES = [
  'INGESTED', 'CHEAP_FILTERED', 'SCREENED', 'QUEUED_FOR_AI', 'AI_PROCESSING', 'AI_EXTRACTED',
  'MODEL_MATCHING', 'GROUP_MATCHING', 'CONFLICT_DETECTED', 'READY_FOR_REVIEW', 'APPROVED', 'REJECTED',
  'IGNORED', 'FAILED', 'RETRY_REQUIRED', 'VIDEO_UNAVAILABLE', 'API_KEY_MISSING', 'RATE_LIMITED', 'VALIDATION_FAILED'
];

/* =========================================================== confidence

   Evidence first. A confidence band is DERIVED from named factors, and the
   factors are stored beside it — so an admin reading "medium" can see that it
   is medium because the 4G in the text is not in the record's name, not
   because a number said so. `score` exists only to sort a list; it is not a
   probability and the UI says so. */

const STRENGTH_RANK = { strong: 3, good: 2, weak: 1, none: 0 };

/**
 * @param {object} c
 * @param {object} c.sourceMatch      matcher result for the master side
 * @param {object} c.compatibleMatch  matcher result for the other side
 * @param {{strength:string}|null} c.category
 * @param {string} c.compatibilityType
 * @param {string} c.polarity
 * @param {{source:string, confidence:number|null}} c.evidence
 * @param {boolean} [c.extractedByAi]
 */
function evaluateConfidence(c) {
  const reasons = [];
  const factors = {
    sourceMatch: sideStrength(c.sourceMatch),
    compatibleMatch: sideStrength(c.compatibleMatch),
    category: c.category && c.category.categoryId ? (c.category.strength || 'good') : 'none',
    statement: statementStrength(c.compatibilityType),
    evidence: evidenceStrength(c.evidence)
  };

  [['sourceMatch', 'master model'], ['compatibleMatch', 'compatible model']].forEach(([k, label]) => {
    const m = c[k] || {};
    if (m.status === 'unmatched') reasons.push(`${label} is not in the catalogue`);
    else if (m.status === 'ambiguous') reasons.push(`${label} fits more than one catalogue record`);
    else if (m.requiresVariantConfirmation) reasons.push(`${label}: ${m.variantNote || 'the variant in the text is not in the record name'}`);
    else if (factors[k] !== 'strong') reasons.push(`${label} matched by ${String(m.method || 'a weak method').replace(/_/g, ' ')}`);
  });
  if (factors.category === 'none') reasons.push('product category could not be mapped to the catalogue');
  else if (factors.category !== 'strong') reasons.push('category inferred from a generic word');
  if (c.compatibilityType !== 'explicit') reasons.push(`compatibility is ${String(c.compatibilityType).replace(/_/g, ' ')}, not explicit`);
  if (factors.evidence !== 'strong') reasons.push(`evidence is ${c.evidence && c.evidence.source === 'ocr' ? 'OCR text' : (c.evidence && c.evidence.source) || 'weak'} of ${factors.evidence} quality`);
  if (c.extractedByAi) reasons.push('relationship was proposed by the AI, not found by the rules');

  const minMatch = Math.min(STRENGTH_RANK[factors.sourceMatch], STRENGTH_RANK[factors.compatibleMatch]);
  let band;
  if (minMatch === 3 && factors.category === 'strong' && factors.statement === 'strong' &&
      factors.evidence === 'strong' && !c.extractedByAi) {
    band = 'high';
  } else if (minMatch >= 2 && STRENGTH_RANK[factors.category] >= 2 &&
             c.compatibilityType === 'explicit' && STRENGTH_RANK[factors.evidence] >= 2) {
    band = 'medium';
  } else {
    band = 'low';
  }
  /* AI can suggest; it cannot certify. */
  if (c.extractedByAi && band === 'high') band = 'medium';

  const score = Math.round((
    STRENGTH_RANK[factors.sourceMatch] + STRENGTH_RANK[factors.compatibleMatch] +
    STRENGTH_RANK[factors.category] + STRENGTH_RANK[factors.statement] +
    STRENGTH_RANK[factors.evidence]) / 15 * 100) / 100;

  return { band, score, factors, reasons };
}

function sideStrength(m) {
  if (!m || m.status !== 'matched') return 'none';
  if (m.requiresVariantConfirmation && m.strength === 'strong') return 'good';
  return m.strength || 'weak';
}

function statementStrength(type) {
  if (type === 'explicit') return 'strong';
  if (type === 'implied') return 'weak';
  if (type === 'same_chassis') return 'weak';
  return 'none';
}

/** Caption and admin-entered text are what the page said; OCR is only as
    good as the engine's own confidence; a transcript is speech-to-text. */
function evidenceStrength(e) {
  if (!e) return 'none';
  if (e.source === 'caption' || e.source === 'manual') return 'strong';
  if (e.source === 'ocr' || e.source === 'frame') {
    const conf = Number(e.confidence);
    if (!Number.isFinite(conf)) return 'good';
    if (conf >= 0.85) return 'strong';
    if (conf >= 0.6) return 'good';
    return 'weak';
  }
  if (e.source === 'transcript') return 'good';
  /* AI vision reads what OCR missed, and can also read what is not there:
     never better than "good", and only when OCR agreed with it. */
  if (e.source === 'vision') return Number(e.confidence) >= 0.85 ? 'good' : 'weak';
  return 'weak';
}

/**
 * Where a candidate sits in the review queue. Precedence matters: a
 * rejected candidate is rejected whatever its band, and a conflict is shown as
 * a conflict before it is shown as anything else.
 */
function reviewSectionFor(c) {
  if (['approved', 'ignored', 'superseded', 'resolved', 'reverted'].indexOf(c.status) > -1) return 'closed';
  if (c.status === 'rejected') return 'rejected';
  if (c.status === 'duplicate') return 'duplicates';
  if (c.conflict && c.conflict.active) return 'conflicts';

  if (c.kind === 'group_proposal') {
    switch (c.proposedAction) {
      case 'UPDATE_EXISTING_GROUP': return 'group_updates';
      case 'CREATE_NEW_GROUP': return 'new_groups';
      case 'MERGE_REQUIRED': case 'CONFLICT_REVIEW': return 'conflicts';
      case 'NO_CHANGE': return 'duplicates';
      default: return 'review';
    }
  }

  if (c.kind === 'model_reference') {
    return c.referenceMatch && c.referenceMatch.status === 'ambiguous' ? 'ambiguous' : 'unmatched';
  }
  const sides = [c.sourceMatch, c.compatibleMatch];
  if (sides.some(m => !m || m.status === 'unmatched')) return 'unmatched';
  if (sides.some(m => m.status === 'ambiguous')) return 'ambiguous';

  const confidence = c.confidence || {};
  if (confidence.band === 'high' && c.polarity === 'positive' && c.compatibilityType === 'explicit' &&
      c.categoryId && !sides.some(m => m.requiresVariantConfirmation)) {
    return 'ready';
  }
  return 'review';
}

/* ============================================================ relevance

   What a content item IS, decided before anything is queued for a person.
   A repair tutorial names phones too; naming a phone is not a compatibility
   claim. Only the first three reach the actionable lists. The rest are kept —
   with the reason — for audit, behind the "Ignored" filter. */

const RELEVANCE = [
  'RELEVANT_COMPATIBILITY',   /* a compatibility statement or list, and its product */
  'PARTIALLY_RELEVANT',       /* compatibility evidence, but the product is unclear or only implied */
  'NEEDS_REVIEW',             /* compatibility and repair signals both, or nothing matched */
  'INSUFFICIENT_EVIDENCE',    /* the media could not be read, so it cannot be judged */
  'IRRELEVANT_REPAIR',        /* jumper, bypass, fault diagnosis, board-level repair */
  'IRRELEVANT_GENERAL',       /* greetings, promotions, anything else */
  'DUPLICATE_SOURCE'          /* the same content as another post already processed */
];
const ACTIONABLE_RELEVANCE = ['RELEVANT_COMPATIBILITY', 'PARTIALLY_RELEVANT', 'NEEDS_REVIEW'];
const IGNORED_RELEVANCE = ['IRRELEVANT_REPAIR', 'IRRELEVANT_GENERAL', 'DUPLICATE_SOURCE'];

function isActionableRelevance(r) { return ACTIONABLE_RELEVANCE.indexOf(r) > -1; }

/** The source page's counters: one bucket per content item, moved (never
    double counted) when a re-import classifies it differently. */
function relevanceBucket(r) {
  if (r === 'RELEVANT_COMPATIBILITY' || r === 'PARTIALLY_RELEVANT') return 'relevant';
  if (r === 'NEEDS_REVIEW' || r === 'INSUFFICIENT_EVIDENCE') return 'needsReview';
  if (IGNORED_RELEVANCE.indexOf(r) > -1) return 'ignored';
  return null;
}

/* ====================================================== group proposals

   A compatibility LIST is one claim about one part: "these models take this
   display". It is compared with the existing groups as a set, and becomes ONE
   proposal — never sixty pairwise candidates. */

const PROPOSED_ACTIONS = [
  'NO_CHANGE',               /* an existing group already says all of it */
  'UPDATE_EXISTING_GROUP',   /* an existing group, plus models it does not hold yet */
  'CREATE_NEW_GROUP',        /* no listed model has a group in this category */
  'MERGE_REQUIRED',          /* the list spans groups the catalogue keeps apart */
  'CONFLICT_REVIEW',         /* a listed model already belongs to another group */
  'MODEL_REVIEW',            /* too few models resolved to catalogue records */
  'PRODUCT_CATEGORY_REVIEW', /* the product is not one of the catalogue's categories */
  'REJECT'
];

/** How one list entry stands against the target group. */
const MEMBER_STATES = ['existing', 'add', 'conflict', 'needs_review', 'unmatched', 'excluded'];

/** What an admin may decide about one entry. `reassign_request` is recorded
    for the master catalogue; this tool never moves a model between groups. */
const MEMBER_DECISIONS = ['include', 'exclude', 'reassign_request'];

/** What the automatic engine may decide about one entry — never offered to a
    person. `merge`: the entry's group is the same part as the target and the
    two are merged. `skip`: the entry stays where it is and is not applied. */
const AUTO_DECISIONS = ['merge', 'skip'];

/** Who an automatic change is recorded as. Not an account: it cannot sign in. */
const SYSTEM_ACTOR = Object.freeze({ uid: 'instagram-intelligence', email: null, label: 'Instagram Intelligence' });

/** Groups created from Instagram are numbered from here, per category, so a
    number the catalogue build issues (0001…) and one issued at run time can
    never be the same. */
const ISSUED_GROUP_BASE = 9000;

/** What the approved-compatibility ledger holds besides pairwise fitments. */
const LEDGER_KINDS = ['same_part', 'new_group', 'merge_groups', 'master_change_request'];

/**
 * One merge of two groups, keyed by the category and the two groups' anchor
 * models — so the same merge found by ten posts is one ledger entry.
 */
function mergeKeyFor(categoryId, survivorAnchorId, absorbedAnchorId) {
  if (!categoryId || !survivorAnchorId || !absorbedAnchorId) return null;
  return `mrg__${categoryId}__${sha256([survivorAnchorId, absorbedAnchorId].join('|')).slice(0, 28)}`;
}

/** A matcher result in the words the review card uses. */
function matchStatusFor(m) {
  if (!m || m.status === 'unmatched') return 'Unknown / Not Found';
  if (m.status === 'ambiguous' || m.requiresVariantConfirmation) return 'Needs Review';
  switch (m.method) {
    case 'exact': return 'Exact Match';
    case 'alias': return 'Alias Match';
    case 'admin_selected': return 'Selected by admin';
    case 'similarity': case 'taxonomy': return 'Similarity Match';
    case 'ai_classification': return 'Needs Review';
    default: return 'Normalized Match';   /* official name, synonym, word order, spacing, series word, known misspelling */
  }
}

/** A list entry may be written to production only on a deterministic match
    with nothing left to confirm. */
function memberIsCertain(m) {
  return !!(m && m.status === 'matched' && m.modelId && !m.requiresVariantConfirmation &&
    (m.strength === 'strong' || m.strength === 'good'));
}

/**
 * The key two proposals share when they make the same claim: the category,
 * the group they target, and the resolved models. Stored in `relKey`, so the
 * existing index and duplicate lookup serve proposals too.
 */
function setKeyFor(categoryId, targetGroupId, modelIds) {
  const ids = Array.from(new Set((modelIds || []).filter(Boolean).map(String))).sort();
  if (!categoryId || ids.length < 2) return null;
  return `grp__${categoryId}__${targetGroupId || 'new'}__${sha256(ids.join('|')).slice(0, 24)}`;
}

function proposalIdFor(extractionId, memberTexts) {
  const basis = (memberTexts || []).map(t => normaliseCaption(t).toLowerCase()).sort().join('|');
  return `${extractionId}__grp_${sha256(basis).slice(0, 16)}`;
}

/**
 * Confidence of a list as a whole. Same rule as a pairwise claim: named
 * factors, and an AI-read list can never be "high".
 *
 * @param {object} p
 * @param {{categoryId:string|null, strength:string}|null} p.category
 * @param {boolean} p.explicit          a compatibility heading or statement introduces the list
 * @param {{source:string, confidence:number|null}} p.evidence
 * @param {number} p.matched            entries resolved with certainty
 * @param {number} p.total              entries read
 * @param {number} [p.supportingRefs]   distinct images / frames the list was read from
 * @param {boolean} [p.readByAi]        the list came from AI vision, not OCR or text
 * @param {string}  [p.validation]      'confirmed' | 'disputed' | 'failed' — the second opinion, if one was asked
 */
function evaluateSetConfidence(p) {
  const reasons = [];
  const share = p.total ? p.matched / p.total : 0;
  const factors = {
    category: p.category && p.category.categoryId ? (p.category.strength || 'good') : 'none',
    statement: p.explicit ? 'strong' : 'weak',
    evidence: evidenceStrength(p.evidence),
    models: share >= 0.9 ? 'strong' : share >= 0.6 ? 'good' : share > 0 ? 'weak' : 'none'
  };
  if (factors.category === 'none') reasons.push('product category could not be mapped to the catalogue');
  else if (factors.category !== 'strong') reasons.push('category inferred from a generic word or from the picture');
  if (!p.explicit) reasons.push('the list has no compatibility heading or statement');
  if (factors.evidence !== 'strong') reasons.push(`evidence is ${(p.evidence && p.evidence.source) || 'weak'} of ${factors.evidence} quality`);
  if (factors.models !== 'strong') reasons.push(`${p.matched} of ${p.total} listed models resolved to a catalogue record with certainty`);
  if (p.readByAi) reasons.push('the list was read by AI vision, not confirmed by OCR');
  if ((p.supportingRefs || 0) > 1) reasons.push(`seen in ${p.supportingRefs} images or frames`);
  if (p.validation === 'confirmed') reasons.push('checked by a second model, which agreed');
  if (p.validation === 'disputed') reasons.push('a second model disputed part of this reading');
  if (p.validation === 'failed') reasons.push('a second opinion was wanted but could not be obtained');

  const rank = k => STRENGTH_RANK[factors[k]];
  let band;
  if (rank('category') === 3 && rank('statement') === 3 && rank('evidence') === 3 && rank('models') === 3 && !p.readByAi) band = 'high';
  else if (rank('category') >= 2 && rank('statement') === 3 && rank('evidence') >= 2 && rank('models') >= 2) band = 'medium';
  else band = 'low';
  /* a disputed reading goes to a person as low confidence, whatever else is true */
  if (p.validation === 'disputed') band = 'low';
  const score = Math.round((rank('category') + rank('statement') + rank('evidence') + rank('models')) / 12 * 100) / 100;
  return { band, score, factors, reasons };
}

/* ====================================================== extraction filters

   The tabs on Extraction Results. Stored on the extraction as tags, so each
   tab is one indexed query and no page ever loads everything to filter it. */

const EXTRACTION_FILTERS = [
  { id: 'relevant', label: 'Relevant' },
  { id: 'all', label: 'All' },
  { id: 'group_updates', label: 'Existing Group Updates' },
  { id: 'new_groups', label: 'New Groups' },
  { id: 'needs_review', label: 'Needs Review' },
  { id: 'conflicts', label: 'Conflicts' },
  { id: 'ignored', label: 'Ignored' },
  { id: 'errors', label: 'Errors' }
];

/**
 * @param {object} x
 * @param {string} x.relevance
 * @param {boolean} [x.compatSignal]   the content talks about compatibility at all
 * @param {object[]} [x.candidates]    every candidate built from it (proposals and pairs)
 * @param {object[]} [x.mediaItems]
 */
function extractionFiltersFor(x) {
  /* "all" is a tag too: the current version of every post carries it, and a
     version a newer one replaced carries none — so no tab lists stale rows. */
  const tags = new Set(['all']);
  const candidates = x.candidates || [];
  if (x.relevance === 'RELEVANT_COMPATIBILITY' || x.relevance === 'PARTIALLY_RELEVANT') tags.add('relevant');
  if (IGNORED_RELEVANCE.indexOf(x.relevance) > -1) tags.add('ignored');
  if (x.relevance === 'NEEDS_REVIEW') tags.add('needs_review');
  /* Unreadable media is worth a person's time only when the post talks about
     compatibility; otherwise it is a reading failure, listed under Errors. */
  if (x.relevance === 'INSUFFICIENT_EVIDENCE') tags.add(x.compatSignal ? 'needs_review' : 'errors');
  candidates.forEach(c => {
    if (c.status !== 'pending') return;
    if (c.reviewSection === 'group_updates') tags.add('group_updates');
    if (c.reviewSection === 'new_groups') tags.add('new_groups');
    if (c.reviewSection === 'conflicts') tags.add('conflicts');
    if (['review', 'unmatched', 'ambiguous'].indexOf(c.reviewSection) > -1) tags.add('needs_review');
    if (c.kind === 'group_proposal' && c.counts && (c.counts.unmatched || c.counts.needsReview)) tags.add('needs_review');
  });
  if ((x.mediaItems || []).some(m => m.ocrStatus === 'failed')) tags.add('errors');
  return Array.from(tags);
}

/** One proposal as an Extraction Results row shows it. */
function proposalSummary(p) {
  return {
    candidateId: p.candidateId, status: p.status, proposedAction: p.proposedAction, categoryId: p.categoryId || null,
    productName: p.productName || null,
    targetGroupId: p.target && p.target.groupId || null, targetGroupNo: p.target && p.target.groupNo || null,
    masterModelName: p.proposedMaster ? p.proposedMaster.modelName : null, masterReviewRequired: !!p.masterReviewRequired,
    counts: p.counts || {}, confidence: p.confidence ? p.confidence.band : null
  };
}

/* ================================================================ hashtags */

function hashtagsIn(text) {
  const out = [];
  String(text || '').replace(/#([\p{L}\p{N}_]{2,60})/gu, (_, tag) => { out.push(tag.toLowerCase()); return _; });
  return Array.from(new Set(out)).slice(0, 60);
}

/** YYYY-MM-DD in India, the day the usage caps roll over on. */
function usageDay(now) {
  const d = new Date(now + 330 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  PROCESSING_VERSION,
  parseInstagramUrl, shortcodeFromPermalink, USERNAME_RE,
  sha256, normaliseCaption, captionHash, contentSignature,
  sourceKeyFor, contentKeyFor, extractionIdFor, relKeyFor, candidateIdFor, RELATION_KIND,
  CONTENT_TYPES, COMPAT_TYPES, IMPORTABLE_TYPES, POLARITIES,
  CANDIDATE_KINDS, CANDIDATE_STATUSES, CANDIDATE_TRANSITIONS, canTransitionCandidate,
  REJECT_REASONS, REVIEW_SECTIONS, REVIEW_SECTION_IDS,
  JOB_STATUSES, RESUMABLE, TERMINAL, ITEM_STATUSES, PIPELINE_STATES,
  evaluateConfidence, evidenceStrength, reviewSectionFor,
  RELEVANCE, ACTIONABLE_RELEVANCE, IGNORED_RELEVANCE, isActionableRelevance, relevanceBucket,
  PROPOSED_ACTIONS, MEMBER_STATES, MEMBER_DECISIONS, matchStatusFor, memberIsCertain,
  AUTO_DECISIONS, SYSTEM_ACTOR, ISSUED_GROUP_BASE, LEDGER_KINDS, mergeKeyFor,
  setKeyFor, proposalIdFor, evaluateSetConfidence,
  EXTRACTION_FILTERS, extractionFiltersFor, proposalSummary,
  hashtagsIn, usageDay
};
