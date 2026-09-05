/* ============================================================================
   Mobile Parts Finder · api/_schema/missing-model-request.js
   ----------------------------------------------------------------------------
   "Someone searched for a phone we do not have."

   ----------------------------------------------------------------------------
   ONE RECORD PER MODEL, NOT ONE PER SEARCH

   Forty shops looking for the same handset in a week is one piece of
   information — add this model — not forty rows to read through. So the
   document id is the NORMALISED name, and a second search for the same phone
   increments a counter rather than creating a row.

   Normalisation has to be aggressive enough to collapse the ways people
   actually type:

       "Realme 5"   "realme5"   "REALME  5"   "Realme-5"   "realme 5 "

   all become `realme5`, and all land on the same document. The variants people
   typed are kept in `searchVariants`, because "which spelling do shops use" is
   worth knowing when the model is eventually added.

   It has to stop short of collapsing DIFFERENT phones. "Realme 5" and
   "Realme 5i" are separate handsets with separate parts, so the trailing
   letter survives — a normaliser that strips it would merge two requests into
   a wrong one, and the fix is invisible until someone orders the wrong glass.

   ----------------------------------------------------------------------------
   STATUS IS A WORKFLOW, AND IT ENDS AT A HUMAN

     new              first seen, nobody has looked
     under_review     an admin has picked it up
     researching      information is being gathered, by a person or the AI
     draft_found      a candidate record exists and is waiting for approval
     approved         an admin has said yes; not yet in the catalogue
     published        it is in the production catalogue
     not_a_valid_model  a typo, a laptop, a joke
     duplicate        the same handset under another name; points at the real one

   `published` is reachable only from `approved`, and only through an admin
   action. Nothing automatic may set it — see docs/AI-ARCHITECTURE.md for why
   that particular door stays locked.
   ========================================================================== */
'use strict';

const STATUSES = [
  'new',
  'under_review',
  'researching',
  'draft_found',
  'approved',
  'published',
  'not_a_valid_model',
  'duplicate'
];

/**
 * Which status may follow which.
 *
 * A transition table rather than "any status may be set to any other" because
 * the whole point of the workflow is that `published` has exactly one way in.
 * A free-form status field would let a stray PATCH publish an unreviewed
 * record, which is the failure this table exists to make impossible.
 */
const ALLOWED_TRANSITIONS = {
  new: ['under_review', 'researching', 'not_a_valid_model', 'duplicate'],
  under_review: ['researching', 'draft_found', 'not_a_valid_model', 'duplicate', 'new'],
  researching: ['draft_found', 'under_review', 'not_a_valid_model', 'duplicate'],
  draft_found: ['approved', 'researching', 'not_a_valid_model', 'duplicate'],
  approved: ['published', 'draft_found'],
  published: [],
  not_a_valid_model: ['new'],
  duplicate: ['new']
};

function canTransition(from, to) {
  if (!STATUSES.includes(to)) return false;
  if (!from) return to === 'new';
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

/**
 * The aggregation key.
 *
 * Lower-cased, accents folded, every separator removed. Keeps digits and
 * letters and nothing else, so "Realme-5 (2019)" and "realme 5 2019" meet.
 *
 * @param {string} raw what the user typed
 * @returns {string} '' when there is nothing usable left
 */
function normaliseModelName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')     /* strip combining accents */
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')          /* spaces, hyphens, brackets, plus signs */
    .slice(0, 80);
}

/**
 * A display form for the admin table: the raw text, tidied but not mangled.
 * The normalised key is for grouping; a person needs to read the original.
 */
function displayModelName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Is this worth recording at all?
 *
 * A single character, or a string of punctuation, is a keystroke rather than a
 * model. Recording those fills the queue with noise an admin has to read past
 * to find the real requests.
 */
function isRecordableQuery(raw) {
  const key = normaliseModelName(raw);
  if (key.length < 3) return false;
  /* Digits alone are usually a part code typed into the model box, and those
     have their own event type. */
  if (/^\d+$/.test(key)) return false;
  return true;
}

/** The document as first created. */
function buildRequest({ raw, now, source, userId }) {
  return {
    normalisedName: normaliseModelName(raw),
    requestedName: displayModelName(raw),
    requestCount: 1,
    firstRequestedAt: now,
    lastRequestedAt: now,
    searchVariants: [displayModelName(raw)],
    status: 'new',
    /* Who asked, only ever as a count and a most-recent uid — the queue needs
       to know a real signed-in shop wants this, not to profile them. */
    signedInRequesters: userId ? 1 : 0,
    lastRequestedByUid: userId || null,
    sources: [source || 'search'],
    /* Filled by the AI pipeline, never by it alone — see aiTasks. */
    candidateBrandId: null,
    candidateModelName: null,
    reviewNotes: null,
    duplicateOfModelId: null,
    publishedModelId: null,
    reviewedByUid: null,
    reviewedAt: null,
    updatedAt: now
  };
}

module.exports = {
  STATUSES,
  ALLOWED_TRANSITIONS,
  canTransition,
  normaliseModelName,
  displayModelName,
  isRecordableQuery,
  buildRequest
};
