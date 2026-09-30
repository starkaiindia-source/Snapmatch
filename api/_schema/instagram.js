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
const PROCESSING_VERSION = 'ig-extract-1';

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

const CANDIDATE_KINDS = ['relationship', 'model_reference'];

const CANDIDATE_STATUSES = ['pending', 'approved', 'rejected', 'duplicate', 'ignored', 'superseded', 'resolved'];

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
  approved: []
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
  'queued', 'discovering', 'processing', 'paused',
  'rate_limited', 'quota_exhausted',
  'completed', 'completed_with_errors', 'failed', 'cancelled', 'unable_to_collect'
];
/** A job in one of these can be resumed where it stopped. */
const RESUMABLE = ['paused', 'rate_limited', 'quota_exhausted', 'failed', 'discovering', 'processing', 'queued'];
const TERMINAL = ['completed', 'completed_with_errors', 'cancelled', 'unable_to_collect'];

const ITEM_STATUSES = ['queued', 'processing', 'done', 'failed', 'skipped_unchanged', 'skipped_duplicate', 'cancelled'];

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
  return 'weak';
}

/**
 * Where a candidate sits in the review queue. Precedence matters: a
 * rejected candidate is rejected whatever its band, and a conflict is shown as
 * a conflict before it is shown as anything else.
 */
function reviewSectionFor(c) {
  if (['approved', 'ignored', 'superseded', 'resolved'].indexOf(c.status) > -1) return 'closed';
  if (c.status === 'rejected') return 'rejected';
  if (c.status === 'duplicate') return 'duplicates';
  if (c.conflict && c.conflict.active) return 'conflicts';

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
  JOB_STATUSES, RESUMABLE, TERMINAL, ITEM_STATUSES,
  evaluateConfidence, evidenceStrength, reviewSectionFor,
  hashtagsIn, usageDay
};
