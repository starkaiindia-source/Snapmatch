/* ============================================================================
   Mobile Parts Finder · api/_services/chatbot-service.js
   ----------------------------------------------------------------------------
   The assistant pipeline. Database first, model last, and never the other way
   round.

   ----------------------------------------------------------------------------
   THE PIPELINE

       user message
            |
       classify intent          <- rules, not a model. Cheap and predictable.
            |
       extract the subject      <- the handset name or part code in the message
            |
       search-service           <- exact, then partial, then fuzzy
            |
       +----+------------------------------------+
       |                                          |
     found                                    not found
       |                                          |
     answer from the database                 record a missing-model request
     (part codes, member lists,                    |
      real compatibility)                      ask the AI to phrase it well
       |                                          |  (only if configured)
       +----------------+-------------------------+
                        |
                    response

   ----------------------------------------------------------------------------
   WHAT THE MODEL IS AND IS NOT ALLOWED TO SUPPLY

   NOT allowed: a model name, a part code, a compatibility claim, a
   specification, a price, a stock level, a date. Every one of those is a fact
   about the database, and a fluent guess about part compatibility costs a shop
   a wrong order.

   Allowed: the wording. "We do not have that handset yet — I have added it to
   the list for review" is a sentence, and a model writes a better one in the
   reader's own register than a template does.

   The enforcement is structural rather than a plea in a prompt: the answer
   object carries `facts` built HERE from search results, and the model is only
   ever handed a `phrasing` task whose output goes into the `message` field. A
   model that hallucinates "the MPF-SG-9999 fits your phone" writes that into a
   sentence that sits beside the real, empty fact list — and the client renders
   facts, not prose, for anything a shop would act on.

   ----------------------------------------------------------------------------
   WITH NO MODEL CONFIGURED

   Everything above still works. Intent classification is rules, search is
   deterministic, and the phrasing falls back to a written template. The
   chatbot is fully functional without an LLM; the LLM makes it read better.
   That ordering is the point — a feature that cannot work without a GPU is a
   feature that is down whenever the GPU is.
   ========================================================================== */
'use strict';

const search = require('./search-service');
const ai = require('./ai-service');
const missingModels = require('./missing-model-service');
const v = require('../_lib/validate');

/* ---------------------------------------------------------------- intents

   Rules, not a classifier. Six intents, recognisable by the words people
   actually use, and a default that behaves sensibly for everything else. A
   model for this would be slower, cost money per message, and be wrong in ways
   nobody can debug. */

const INTENTS = {
  AVAILABILITY: 'availability',       /* "do you have Realme 5" */
  COMPATIBILITY: 'compatibility',     /* "which models match this glass" */
  PART_CODE: 'part_code',             /* "MPF-SG-0167" */
  NOT_FOUND_REPORT: 'not_found',      /* "I searched but could not find it" */
  GREETING: 'greeting',
  UNKNOWN: 'unknown'
};

const PATTERNS = [
  [INTENTS.PART_CODE, /\b(?:mpf[- ]?)?(?:sg|bc|cd|mf|cc|bt)[- ]?\d{3,5}\b/i],
  [INTENTS.NOT_FOUND_REPORT,
    /\b(?:cannot|can't|could ?n[o']t|unable to|did ?n[o']t|not able to)\s+(?:find|see|locate)\b|\bnot (?:found|available|listed|there)\b|\bmissing\b/i],
  [INTENTS.COMPATIBILITY,
    /\b(?:compatib|which models|what else fits|same (?:glass|cover|display|part)|match(?:es|ing)?|fits?)\b/i],
  [INTENTS.AVAILABILITY,
    /\b(?:do you have|is there|available|got|stock|in your (?:database|list)|have you got)\b/i],
  [INTENTS.GREETING, /^\s*(?:hi|hello|hey|good (?:morning|afternoon|evening)|namaste)\b/i]
];

function classify(message) {
  const text = String(message || '');
  for (const [intent, pattern] of PATTERNS) {
    if (pattern.test(text)) return intent;
  }
  /* A bare handset name with no question around it is an availability
     question — it is how most people actually ask. */
  return text.trim().length ? INTENTS.AVAILABILITY : INTENTS.UNKNOWN;
}

/* -------------------------------------------------------------- extraction

   Pulling the handset name out of a sentence.

   Stop words are removed rather than the sentence being parsed, because the
   search ladder normalises anyway: "do you have realme 5 in stock" reduces to
   "realme 5" and the exact match fires. Over-removal is safe — the fuzzy
   fallback catches it — and under-removal is safe too, because a leftover
   "the" changes the normalised key and drops to fuzzy, which still finds it. */

const STOP_WORDS = new Set([
  'do', 'you', 'have', 'has', 'is', 'are', 'the', 'a', 'an', 'any', 'got',
  'in', 'stock', 'available', 'availability', 'your', 'database', 'list',
  'please', 'pls', 'sir', 'bro', 'me', 'my', 'i', 'we', 'for', 'of', 'with',
  'which', 'what', 'models', 'model', 'match', 'matches', 'matching', 'fits',
  'fit', 'compatible', 'compatibility', 'same', 'this', 'that', 'it', 'and',
  'or', 'can', 'could', 'not', 'cant', 'want', 'need', 'show', 'tell', 'find',
  'searched', 'search', 'looking', 'look', 'phone', 'mobile', 'handset',
  'tempered', 'glass', 'cover', 'display', 'combo', 'battery', 'frame', 'board'
]);

function extractSubject(message) {
  const cleaned = String(message || '')
    .replace(/[?!.,;:"'()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const kept = cleaned.split(' ').filter(word => {
    const w = word.toLowerCase();
    if (!w) return false;
    /* A digit is almost always part of the model name — "5", "14", "M21" —
       so it survives even if it would otherwise be a stop word. */
    if (/\d/.test(w)) return true;
    return !STOP_WORDS.has(w);
  });

  return kept.join(' ').trim();
}

/** The part code in a message, if there is one. */
function extractPartCode(message) {
  const m = /\b(?:mpf[- ]?)?((?:sg|bc|cd|mf|cc|bt)[- ]?\d{3,5})\b/i.exec(String(message || ''));
  return m ? m[1].replace(/[- ]/g, '').toUpperCase() : null;
}

/**
 * Is this leftover text plausibly a handset, or is it a sentence fragment?
 *
 * The bar a real model name clears: it carries a digit ("Realme 5",
 * "iPhone 14"), or it names a brand the catalogue knows ("Nothing Phone"), or
 * it is simply long enough that a fragment is unlikely.
 *
 * Set deliberately low. A false positive costs one row in a review queue that
 * an admin can dismiss; a false negative refuses to look up a phone somebody
 * actually asked about.
 */
function looksLikeModelName(subject) {
  const s = String(subject || '').trim();
  if (s.length < 3) return false;
  if (/\d/.test(s)) return true;

  const first = s.toLowerCase().split(' ')[0];
  try {
    if (search.loadIndex().brands.has(first)) return true;
  } catch { /* index unavailable — fall through to the length test */ }

  return s.length >= 6;
}

/* ----------------------------------------------------------------- answers

   Every branch returns the same shape:

     intent      what the message was taken to be asking
     answeredFrom  'database' | 'alias' | 'fuzzy' | 'llm' | 'template'
     facts       structured, from the catalogue. What the UI renders.
     message     prose. Never load-bearing.
     suggestions what to try next
     missingModelRecorded  whether this went into the review queue
*/

function reply({ intent, answeredFrom, facts, message, suggestions, missingModelRecorded }) {
  return {
    intent,
    answeredFrom,
    facts: facts || null,
    message,
    suggestions: suggestions || [],
    missingModelRecorded: !!missingModelRecorded
  };
}

/**
 * Answers one message.
 *
 * @param {object} args
 * @param {string} args.message
 * @param {string|null} args.userId
 * @param {number} args.now
 * @returns {Promise<object>} the reply shape above
 */
async function respond({ message, userId, now }) {
  const text = v.searchTerm(message, 500);
  const intent = classify(text);

  if (intent === INTENTS.GREETING) {
    return reply({
      intent,
      answeredFrom: 'template',
      message: 'Ask me about a handset and I will tell you which compatibility ' +
               'groups it belongs to, and what else takes the same part.',
      suggestions: ['Do you have Realme 5?', 'Which models match MPF-SG-0167?']
    });
  }

  /* ---- a printed part code is the most precise question there is ---- */
  const partCode = extractPartCode(text);
  if (partCode) {
    const group = search.findByPartCode(partCode);
    if (group) {
      return reply({
        intent: INTENTS.PART_CODE,
        answeredFrom: 'database',
        facts: { kind: 'group', group },
        message: `${group.partCode} fits ${group.memberCount} ` +
                 `${group.memberCount === 1 ? 'model' : 'models'}.`
      });
    }
    return reply({
      intent: INTENTS.PART_CODE,
      answeredFrom: 'database',
      facts: null,
      message: `I have no group with the code ${partCode}. Check the code on the ` +
               'part, or tell me the handset instead.'
    });
  }

  const subject = extractSubject(text);

  /* "I searched a model but could not find it" is a report with no handset in
     it. Recording "but" as a missing model would put noise in the review queue
     that an admin then has to read past, so the assistant asks which one.

     This guard sits in front of every branch, not just the not-found one,
     because a message with no recognisable handset cannot be answered by any
     of them. */
  if (!looksLikeModelName(subject)) {
    return reply({
      intent,
      answeredFrom: 'template',
      message: intent === INTENTS.NOT_FOUND_REPORT
        ? 'Tell me the handset you were looking for and I will check, and add it ' +
          'to the review list if it is genuinely missing.'
        : 'Tell me the handset — brand and model — and I will look it up.',
      suggestions: ['Realme 5', 'Samsung Galaxy M21', 'Apple iPhone 14 Pro Max']
    });
  }

  /* ---- the deterministic ladder ---- */
  const found = search.findModels(subject, { limit: 6 });

  if (found.matchType === 'none') {
    return await notFound({ subject, intent, userId, now });
  }

  /* An unconfident match is a list to choose from, never a guess presented as
     an answer. This is where a chatbot normally goes wrong: it picks the top
     result and states it as fact. */
  if (!found.confident) {
    return reply({
      intent,
      answeredFrom: found.matchType === 'fuzzy' ? 'fuzzy' : 'database',
      facts: { kind: 'candidates', models: found.models.map(publicModel) },
      message: found.matchType === 'fuzzy'
        ? `I could not find "${subject}" exactly. Did you mean one of these?`
        : `Several models match "${subject}". Which one?`,
      suggestions: found.models.slice(0, 4).map(m => m.name)
    });
  }

  const model = found.models[0];
  const compatibility = search.compatibilityFor(model.id);

  if (!compatibility || !compatibility.categories.length) {
    /* The handset is in the catalogue and has no recorded fitments. That is a
       real state and it is said plainly — inventing a group here would be the
       single most damaging thing this file could do. */
    return reply({
      intent,
      answeredFrom: 'database',
      facts: { kind: 'model', model: publicModel(model), categories: [] },
      message: `${model.name} is in the catalogue, but no compatibility groups ` +
               'are recorded for it yet.'
    });
  }

  const totalGroups = compatibility.categories.reduce((n, c) => n + c.groups.length, 0);

  return reply({
    intent,
    answeredFrom: found.matchType === 'fuzzy' ? 'fuzzy' : 'database',
    facts: {
      kind: 'model',
      model: publicModel(model),
      categories: compatibility.categories
    },
    message: `${model.name} belongs to ${totalGroups} compatibility ` +
             `${totalGroups === 1 ? 'group' : 'groups'} across ` +
             `${compatibility.categories.length} part ` +
             `${compatibility.categories.length === 1 ? 'category' : 'categories'}.`
  });
}

function publicModel(m) {
  return { id: m.id, name: m.name, brandId: m.brandId, year: m.year || null };
}

/**
 * Nothing matched.
 *
 * Two things happen, in this order: the request is recorded so the queue
 * learns there is demand, and only then is the AI asked to phrase the refusal.
 * The recording is the part that matters and it does not depend on the model
 * being available.
 */
async function notFound({ subject, intent, userId, now }) {
  const recorded = await missingModels.recordRequest({
    raw: subject, userId, source: 'chatbot', now
  });

  const template =
    `I could not find "${subject}" in the catalogue. ` +
    (recorded.recorded
      ? 'I have added it to the list for review, so it can be checked and added.'
      : 'Try the full name, including the brand — for example "Realme 5" rather than "5".');

  /* The model gets the SUBJECT and nothing else — no user id, no session, no
     history. And it is asked for wording, not for an answer. */
  const phrased = await ai.invoke({
    capability: 'assist_zero_result',
    systemHint:
      'Reply in at most two sentences. The handset is NOT in the catalogue. ' +
      'Do not invent models, part codes, specifications or compatibility. ' +
      'You may suggest that the user check the spelling or give the full brand name.',
    input: { query: subject, recorded: recorded.recorded }
  });

  const message = phrased.ok && typeof phrased.output.message === 'string'
    ? v.string(phrased.output.message, 400)
    : template;

  return reply({
    intent,
    answeredFrom: phrased.ok ? 'llm' : 'template',
    facts: null,
    message: message || template,
    /* Real neighbours from the catalogue, not the model's suggestions. */
    suggestions: search.partialMatch(subject.split(' ')[0] || subject, 4).map(m => m.name),
    missingModelRecorded: recorded.recorded
  });
}

module.exports = {
  INTENTS, STOP_WORDS,
  classify, extractSubject, extractPartCode, looksLikeModelName, respond
};
