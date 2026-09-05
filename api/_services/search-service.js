/* ============================================================================
   Mobile Parts Finder · api/_services/search-service.js
   ----------------------------------------------------------------------------
   Deterministic model lookup. The layer the chatbot must exhaust before an AI
   is allowed to say anything.

   ----------------------------------------------------------------------------
   WHY THE SEARCH IS NOT THE AI'S JOB

   "Do you have Realme 5?" has a correct answer that is a fact about a
   database. A language model asked that question will produce a fluent answer
   whether or not it knows, and a fluent wrong answer about part compatibility
   is how a shop orders the wrong tempered glass for a customer standing at the
   counter.

   So the pipeline is: normalise, exact match, alias, fuzzy — and only if all
   of those come back empty does the AI get involved, and then only to phrase
   "we do not have this" helpfully. The AI never supplies a model, a part code
   or a compatibility claim. Those come from here or they do not exist.

   ----------------------------------------------------------------------------
   WHERE THE DATA COMES FROM

   The same build output the site ships: assets/search-index.json for the model
   and brand list, api/_data/parts.json for the compatibility groups. Both are
   written by scripts/build-dataset.js from the source workbook, and the same
   export is what the Firestore importer writes.

   Loaded once per warm serverless instance and held in module scope. 4,933
   models is a few megabytes of objects — trivial to hold, and it turns every
   lookup into an in-memory map read instead of a Firestore query. A chatbot
   that costs a database read per keystroke is a chatbot that gets switched off
   when the bill arrives.

   ----------------------------------------------------------------------------
   FUZZY MATCHING IS BOUNDED, NOT CLEVER

   Damerau-Levenshtein over a candidate set narrowed by a cheap key, with a
   distance ceiling that scales with the length of the term. It catches
   "samgung galxy" and "reame 5". It does NOT try to be a search engine, and it
   deliberately refuses to guess when two candidates are equally close — an
   ambiguous match is reported as a list for the person to choose from, which
   is the honest answer and also the more useful one.
   ========================================================================== */
'use strict';

const { normaliseModelName } = require('../_schema/missing-model-request');

/* -------------------------------------------------------------- the index

   Built lazily on first use and cached for the life of the instance. A cold
   start pays the parse once; every request after that is free. */

let INDEX = null;

function loadIndex() {
  if (INDEX) return INDEX;

  /* Required rather than read from disk so Vercel's dependency tracing bundles
     them with the function. A fs.readFileSync of a relative path is invisible
     to the tracer and 404s in production. */
  const searchIndex = require('../../assets/search-index.json');
  const parts = require('../_data/parts.json');

  /* The index stores models as compact arrays to keep the file small:
       [ id, fullName, brandId, releaseYear, screenInches, ?, ? ]
     Naming the columns here means nothing downstream indexes by number. */
  const models = searchIndex.models.map(row => ({
    id: row[0],
    name: row[1],
    brandId: row[2],
    year: row[3] || null,
    key: normaliseModelName(row[1])
  }));

  const byId = new Map();
  const byKey = new Map();
  models.forEach(m => {
    byId.set(m.id, m);
    /* Two handsets can normalise to the same key — different regional names
       for one phone. The map holds a list so neither is silently dropped. */
    if (!byKey.has(m.key)) byKey.set(m.key, []);
    byKey.get(m.key).push(m);
  });

  const brands = new Map();
  (searchIndex.brands || []).forEach(b => brands.set(b.id, b));

  const categories = new Map();
  (searchIndex.categories || []).forEach(c => categories.set(c.id, c));

  INDEX = {
    models,
    byId,
    byKey,
    brands,
    categories,
    groups: parts.groups || {},
    deviceGroups: parts.deviceGroups || {},
    generatedAt: searchIndex.generatedAt || null,
    version: searchIndex.version || null
  };
  return INDEX;
}

/* ------------------------------------------------------------------ lookup */

/** Exact, after normalisation. The overwhelmingly common case. */
function exactMatch(query) {
  const idx = loadIndex();
  const key = normaliseModelName(query);
  if (!key) return [];
  return (idx.byKey.get(key) || []).slice();
}

/**
 * Prefix and containment over the normalised key.
 *
 * "realme5" finds "realme5g" and "realme5pro"; "galaxym21" finds
 * "samsunggalaxym21". The second is why containment is here and not just
 * prefix — people leave the brand off constantly.
 */
function partialMatch(query, limit = 12) {
  const idx = loadIndex();
  const key = normaliseModelName(query);
  if (key.length < 3) return [];

  const starts = [];
  const contains = [];
  for (const m of idx.models) {
    if (m.key === key) continue;
    if (m.key.startsWith(key)) starts.push(m);
    else if (m.key.indexOf(key) > -1) contains.push(m);
    if (starts.length >= limit) break;
  }
  return starts.concat(contains).slice(0, limit);
}

/**
 * Damerau-Levenshtein with an early exit.
 *
 * The early exit is what makes this affordable across 4,933 models: once the
 * best possible remaining distance exceeds the ceiling, the row stops.
 */
function editDistance(a, b, ceiling) {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > ceiling) return ceiling + 1;

  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  let prevPrev = new Array(bl + 1);

  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = curr[0];

    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        curr[j - 1] + 1,        /* insertion */
        prev[j] + 1,            /* deletion */
        prev[j - 1] + cost      /* substitution */
      );
      /* Transposition: "raelme" against "realme" is one mistake, not two. */
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prevPrev[j - 2] + 1);
      }
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }

    if (rowMin > ceiling) return ceiling + 1;

    const spare = prevPrev;
    prevPrev = prev;
    prev = curr;
    curr = spare;
  }

  return prev[bl];
}

/** The ceiling scales with length: one mistake in six characters, two in ten. */
function ceilingFor(key) {
  if (key.length <= 4) return 1;
  if (key.length <= 8) return 2;
  return 3;
}

/**
 * Nearest models by edit distance.
 *
 * The candidate set is narrowed first by a cheap filter — a length window and
 * a shared first character — because running a full edit distance against five
 * thousand strings on every chatbot message is a second of CPU nobody needs to
 * spend.
 */
function fuzzyMatch(query, limit = 5) {
  const idx = loadIndex();
  const key = normaliseModelName(query);
  if (key.length < 3) return [];

  const ceiling = ceilingFor(key);
  const scored = [];

  for (const m of idx.models) {
    if (Math.abs(m.key.length - key.length) > ceiling) continue;
    /* A first-character mismatch costs one of the allowed edits, so requiring
       it when only one edit is allowed loses nothing and skips most rows. */
    if (ceiling === 1 && m.key[0] !== key[0]) continue;

    const distance = editDistance(key, m.key, ceiling);
    if (distance <= ceiling) scored.push({ model: m, distance });
  }

  scored.sort((a, b) => a.distance - b.distance || a.model.name.localeCompare(b.model.name));
  return scored.slice(0, limit).map(s => ({ ...s.model, distance: s.distance }));
}

/**
 * The whole ladder, in order, stopping at the first rung that answers.
 *
 * @returns {{matchType:'exact'|'partial'|'fuzzy'|'none', models:Array, confident:boolean}}
 */
function findModels(query, { limit = 8 } = {}) {
  const exact = exactMatch(query);
  if (exact.length) return { matchType: 'exact', models: exact.slice(0, limit), confident: true };

  const partial = partialMatch(query, limit);
  if (partial.length) {
    return {
      matchType: 'partial',
      models: partial,
      /* One partial hit is an answer; six is a list to choose from. Saying
         which stops the chatbot presenting a guess as a finding. */
      confident: partial.length === 1
    };
  }

  const fuzzy = fuzzyMatch(query, Math.min(limit, 5));
  if (fuzzy.length) {
    const best = fuzzy[0].distance;
    const tied = fuzzy.filter(f => f.distance === best);
    return { matchType: 'fuzzy', models: fuzzy, confident: tied.length === 1 && best <= 1 };
  }

  return { matchType: 'none', models: [], confident: false };
}

/* ------------------------------------------------------------ compatibility */

/**
 * Which compatibility groups a device belongs to, and what else fits.
 *
 * Read straight from the built parts data — the same records the site serves.
 * Nothing is inferred: if a device has no recorded group in a category, the
 * answer is that there is none, not a plausible-looking one.
 */
function compatibilityFor(modelId) {
  const idx = loadIndex();
  const model = idx.byId.get(modelId);
  if (!model) return null;

  const byCategory = idx.deviceGroups[modelId] || {};
  const categories = Object.keys(byCategory).map(categoryId => {
    const groupIds = byCategory[categoryId] || [];
    const groups = groupIds.map(groupId => {
      const g = idx.groups[groupId];
      if (!g) return null;
      const memberIds = g.memberIds || [];
      return {
        groupId,
        partCode: g.partCode || null,
        oemPartNo: g.oemPartNo || null,
        masterModelName: g.drawingName || null,
        memberCount: memberIds.length,
        /* Capped: a group with sixty members is a list, not a chat message.
           The full list is one click away on the site. */
        members: memberIds.slice(0, 40).map(id => {
          const m = idx.byId.get(id);
          return { id, name: m ? m.name : id };
        }),
        truncated: memberIds.length > 40
      };
    }).filter(Boolean);

    const category = idx.categories.get(categoryId);
    return {
      categoryId,
      categoryName: category ? category.name : categoryId,
      groups
    };
  });

  return { model, categories };
}

/** One group by its id, with everything that fits it. */
function groupDetail(groupId) {
  const idx = loadIndex();
  const g = idx.groups[groupId];
  if (!g) return null;
  const memberIds = g.memberIds || [];
  return {
    groupId,
    partCode: g.partCode || null,
    oemPartNo: g.oemPartNo || null,
    masterModelName: g.drawingName || null,
    memberCount: memberIds.length,
    members: memberIds.map(id => {
      const m = idx.byId.get(id);
      return { id, name: m ? m.name : id };
    })
  };
}

/**
 * Find a group by its printed part code — "MPF-SG-0001", or just "SG-0001".
 * This is the search a technician does with the part in their hand.
 */
function findByPartCode(code) {
  const idx = loadIndex();
  const wanted = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (wanted.length < 4) return null;

  for (const groupId of Object.keys(idx.groups)) {
    const g = idx.groups[groupId];
    const candidates = [g.partCode, g.oemPartNo].filter(Boolean)
      .map(c => String(c).toUpperCase().replace(/[^A-Z0-9]/g, ''));
    if (candidates.some(c => c === wanted || c.endsWith(wanted))) {
      return groupDetail(groupId);
    }
  }
  return null;
}

/** Diagnostics: proves the index loaded and says which build it is. */
function indexStatus() {
  try {
    const idx = loadIndex();
    return {
      loaded: true,
      models: idx.models.length,
      groups: Object.keys(idx.groups).length,
      devicesWithGroups: Object.keys(idx.deviceGroups).length,
      brands: idx.brands.size,
      generatedAt: idx.generatedAt,
      version: idx.version
    };
  } catch (err) {
    return { loaded: false, error: err && err.message };
  }
}

module.exports = {
  loadIndex, indexStatus,
  exactMatch, partialMatch, fuzzyMatch, findModels,
  compatibilityFor, groupDetail, findByPartCode,
  editDistance, normaliseModelName
};
