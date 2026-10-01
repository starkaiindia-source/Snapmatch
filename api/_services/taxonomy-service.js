/* ============================================================================
   Mobile Parts Finder · api/_services/taxonomy-service.js
   ----------------------------------------------------------------------------
   The taxonomy layer: turns a model name or a product word, as a person or a
   post wrote it, into a record that ALREADY EXISTS in the catalogue — or says
   plainly that it cannot.

   ----------------------------------------------------------------------------
   WHAT THIS IS BUILT FROM (and why it is not a second engine)

   There was no single module by this name. The pieces were spread across the
   codebase, and this file composes them instead of re-deriving any:

     · the catalogue index         search-service.loadIndex() — assets/search-index.json
     · the search ladder           search-service.findModels() — exact/partial/fuzzy
     · the fuzzy distance          search-service.editDistance() — Damerau-Levenshtein
     · slug + alias keys           backend/schema.js slug() / aliasKey() — "+" survives as "plus"
     · the alias bridge            Firestore /aliases (read by the caller, passed in)
     · category spellings          src/data/category-assets.js ALIASES (drift-tested)
     · brand display fixes         scripts/build-dataset.js BRAND_FIX

   What it adds is the ORDER, the qualifier rules, and a result that says HOW
   it matched — because "matched" alone is the sentence that ships the wrong
   glass.

   ----------------------------------------------------------------------------
   THE LADDER

     normalise
       -> exact            "Samsung Galaxy A15"          the record's own full name
       -> official name    "Galaxy A15", "Redmi 13C"     the name without / with a sub-brand
       -> alias            /aliases, admin-verified spellings
       -> synonym          "Pro Max" / "ProMax", "II" / "2"
       -> keyword          "A15 Galaxy"                  same words, another order
       -> alternate spell  "Redmi13C", "Galaxy-A15"      same letters, other spacing
       -> market term      "Samsung A15"                 the trade drops "Galaxy"
       -> misspelling      "Samsang Glaxy A15"           curated list, model number exact
       -> similarity       fuzzy on WORDS only           never on a model number
       -> taxonomy         the existing search ladder    unique containment only
       -> AI               done by the caller, batched, and never above "weak"

   ----------------------------------------------------------------------------
   THE RULES THAT MAKE IT SAFE

   1. A MODEL NUMBER IS NEVER FUZZY. "A15" and "A16" are one edit apart and are
      different phones; so are "A15" and "A15s". Every token that contains a
      digit must match exactly, in every rung, or there is no match.

   2. A NETWORK, YEAR OR REGION IS NEVER INFERRED. "Samsung A15 4G" finds the
      record "Samsung Galaxy A15" — whose NAME says nothing about 4G — so it is
      returned with requiresVariantConfirmation and capped at "good". It is not
      promoted because a sibling called "…A15 5G" exists: a network is never
      inferred from a sibling's name. A person confirms it.
      A text that says "5G" against a record that does not is not a match at
      all; it is ambiguous, because the 5G phone may simply not be catalogued.

   3. MORE THAN ONE ANSWER IS "AMBIGUOUS", NEVER THE FIRST ONE. "C65" is a
      Realme and a Poco; which one is a question for a person.

   4. NOTHING HERE WRITES ANYTHING. No model, brand, category or alias is
      created by this file. Learning a new spelling is an explicit, audited
      admin action in the review service.
   ========================================================================== */
'use strict';

const search = require('./search-service');
const { slug, aliasKey } = require('../../backend/schema');

/* ================================================================== terms */

/** Words a brand is written as. `keep`: the word is ALSO part of the model's
    own name ("Redmi 13C" is "Xiaomi Redmi 13C"), so it stays in the query. */
const BRAND_TERMS = {
  apple: { brandId: 'apple' }, iphone: { brandId: 'apple', keep: true }, ipad: { brandId: 'apple', keep: true },
  asus: { brandId: 'asus' }, zenfone: { brandId: 'asus', keep: true }, rog: { brandId: 'asus', keep: true },
  coolpad: { brandId: 'coolpad' },
  google: { brandId: 'google' }, pixel: { brandId: 'google', keep: true },
  hmd: { brandId: 'hmd' },
  honor: { brandId: 'honor' },
  huawei: { brandId: 'huawei' },
  infinix: { brandId: 'infinix' },
  itel: { brandId: 'itel' },
  lava: { brandId: 'lava' },
  lenovo: { brandId: 'lenovo' },
  motorola: { brandId: 'motorola' }, moto: { brandId: 'motorola', keep: true },
  nokia: { brandId: 'nokia' },
  nothing: { brandId: 'nothing' }, cmf: { brandId: 'nothing', keep: true },
  oneplus: { brandId: 'oneplus' }, nord: { brandId: 'oneplus', keep: true },
  oppo: { brandId: 'oppo' },
  realme: { brandId: 'realme' }, narzo: { brandId: 'realme', keep: true },
  samsung: { brandId: 'samsung' }, galaxy: { brandId: 'samsung', keep: true },
  tecno: { brandId: 'tecno' }, camon: { brandId: 'tecno', keep: true }, pova: { brandId: 'tecno', keep: true },
  vivo: { brandId: 'vivo' }, iqoo: { brandId: 'vivo', keep: true },
  xiaomi: { brandId: 'xiaomi' }, redmi: { brandId: 'xiaomi', keep: true }, poco: { brandId: 'xiaomi', keep: true },
  mi: { brandId: 'xiaomi', keep: true },
  zte: { brandId: 'zte' }, nubia: { brandId: 'zte', keep: true }
};

/** Series words the trade routinely drops: "Samsung A15" for "Samsung Galaxy
    A15". Deliberately short — a series word added here that is NOT routinely
    dropped turns into a wrong match. */
const MARKET_SERIES = {
  samsung: ['galaxy'],
  apple: ['iphone'],
  motorola: ['moto'],
  oneplus: ['nord'],
  google: ['pixel']
};

/** Curated misspellings of brand and series WORDS. Never model numbers. */
const MISSPELLINGS = {
  samsang: 'samsung', sumsung: 'samsung', samsng: 'samsung', samsumg: 'samsung', samung: 'samsung',
  galexy: 'galaxy', galaxi: 'galaxy', glaxy: 'galaxy', galax: 'galaxy', gelaxy: 'galaxy',
  redme: 'redmi', redmee: 'redmi', readmi: 'redmi', remdi: 'redmi',
  xiomi: 'xiaomi', xaomi: 'xiaomi', xiami: 'xiaomi', shaomi: 'xiaomi',
  iphon: 'iphone', ifone: 'iphone', iphne: 'iphone',
  realmi: 'realme', relme: 'realme', realmy: 'realme',
  techno: 'tecno', tekno: 'tecno',
  infinx: 'infinix', infinics: 'infinix', infnix: 'infinix',
  motorolla: 'motorola', motrola: 'motorola',
  nokiya: 'nokia', onepluse: 'oneplus', onplus: 'oneplus',
  vevo: 'vivo', opo: 'oppo', oppoo: 'oppo', huwei: 'huawei', huwave: 'huawei', huawai: 'huawei',
  honour: 'honor', lenevo: 'lenovo'
};

/** Pure notation variants, tried as whole-token rewrites. */
const SYNONYMS = [
  [['promax'], ['pro', 'max']],
  [['proplus'], ['pro', 'plus']],
  [['ii'], ['2']],
  [['iii'], ['3']],
  [['iv'], ['4']],
  [['2nd', 'gen'], ['2020']],
  [['3rd', 'gen'], ['2022']]
];

/** Words that are never part of a model reference. */
const NOISE = new Set([
  'mobile', 'mobiles', 'phone', 'phones', 'smartphone', 'new', 'original', 'orignal', 'oem',
  'model', 'models', 'for', 'compatible', 'compatibility', 'with', 'the', 'only', 'pcs', 'pc',
  'set', 'price', 'rs', 'inr', 'available', 'stock', 'wholesale', 'best', 'quality', 'premium',
  'hd', 'full', 'glue', 'series', 'use', 'fits', 'fit', 'same', 'also', 'and', 'or', 'of', 'in'
]);

const NETWORK_TOKENS = { '3g': '3g', '4g': '4g', lte: '4g', '5g': '5g' };
const REGION_TOKENS = new Set(['china', 'global', 'india', 'international', 'cn']);

/* ------------------------------------------------------------- categories

   Every spelling that means one of the catalogue's categories. The first
   eight groups mirror src/data/category-assets.js ALIASES exactly (a test
   fails if they drift) and add the trade words shops actually post.

   `weak` terms ("glass", "cover", "frame") are single words that also mean
   other things; they can map a category but only as a keyword, which keeps a
   candidate out of "ready for approval". The 2-letter codes (sg, bc, cd, mf…)
   are NOT scanned in free text — "cd" and "st" are not categories in a
   caption. */
const CATEGORY_TERMS = {
  'screen-guards': {
    strong: ['screen guards', 'screen guard', 'screenguard', 'tempered glass', 'temperedglass',
      'universal tempered glass', 'temper glass', 'toughened glass', 'screen protector',
      'screen protection', 'tempered', '9d glass', '10d glass', '11d glass', '21d glass',
      '5d glass', '6d glass', '9h glass', 'privacy glass', 'matte glass', 'uv glass',
      'hydrogel', 'ceramic guard', 'full glue glass', 'edge to edge glass'],
    weak: ['glass', 'screen', 'screens', 'tg']
  },
  'back-cover': {
    strong: ['back cover', 'backcover', 'back covers', 'universal back cover', 'back case',
      'mobile cover', 'phone cover', 'phone case', 'mobile case', 'silicone cover', 'silicon cover',
      'silicone case', 'tpu cover', 'tpu case', 'transparent cover', 'clear case', 'hard case',
      'soft case', 'bumper case', 'shockproof case'],
    weak: ['cover', 'case', 'covers']
  },
  'combo-display': {
    strong: ['combo display', 'combodisplay', 'combo/display', 'display combo', 'lcd combo',
      'oled combo', 'amoled combo', 'incell combo', 'touch combo', 'display folder', 'lcd folder',
      'folder', 'combo', 'display with touch', 'lcd with touch'],
    weak: ['display', 'lcd', 'oled', 'amoled', 'incell']
  },
  'middle-frame': {
    strong: ['middle frame', 'middleframe', 'mid frame', 'body frame'],
    weak: ['frame']
  },
  'cc-board': {
    strong: ['cc board', 'ccboard', 'charging board', 'charging connector board', 'connector board',
      'charging port board', 'charging pcb', 'sub board', 'usb board', 'type c board'],
    weak: ['charging port']
  },
  battery: {
    strong: ['battery', 'batteries', 'batt', 'bettery', 'battry'],
    weak: []
  },
  'button-flex': {
    strong: ['button flex', 'buttonflex', 'power flex', 'volume flex', 'power volume flex',
      'on off flex', 'switch flex', 'power button flex', 'side key flex', 'power on off flex'],
    weak: []
  },
  'sim-tray': {
    strong: ['sim tray', 'simtray', 'sim holder', 'sim slot', 'sim card tray', 'sim tray holder'],
    weak: ['tray']
  }
};

/** Products this catalogue has NO category for. Found, reported, never
    mapped to the nearest thing — "back glass" is not a screen guard. */
const UNMAPPED_PRODUCT_TERMS = [
  'camera glass', 'camera lens', 'lens protector', 'camera protector', 'back glass', 'back panel',
  'back door', 'battery door', 'housing', 'charger', 'adapter', 'data cable', 'cable', 'earphone',
  'earphones', 'earbuds', 'headphone', 'speaker', 'ringer', 'loudspeaker', 'microphone',
  'vibrator', 'motherboard', 'touch glass', 'front glass', 'og glass', 'digitizer', 'flip cover',
  'lcd flex', 'main flex', 'power bank', 'smart watch', 'pop socket', 'back skin', 'lamination'
];

/** Category names exactly as the catalogue names them — a hit on one of these
    is an "exact" category match rather than a synonym. */
const CATEGORY_EXACT = {
  'screen-guards': ['screen guards', 'screen guard'], 'back-cover': ['back cover'],
  'combo-display': ['combo display', 'combo/display'], 'middle-frame': ['middle frame'],
  'cc-board': ['cc board'], battery: ['battery'], 'button-flex': ['button flex'], 'sim-tray': ['sim tray']
};

/* ============================================================ normalising */

function basicTokens(text) {
  let s = String(text == null ? '' : text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/\+/g, ' plus ').replace(/&/g, ' and ');
  s = s.replace(/\bone\s*plus\b/g, 'oneplus').replace(/\bi\s*-?\s*phone\b/g, 'iphone').replace(/\btype\s*-?\s*c\b/g, 'type c');
  const raw = s.split(/[^a-z0-9]+/).filter(Boolean);
  /* "5 G" -> "5g" */
  const out = [];
  raw.forEach(t => {
    if (t === 'g' && out.length && /^[345]$/.test(out[out.length - 1])) out[out.length - 1] += 'g';
    else out.push(t);
  });
  return out;
}

/** A name split into what identifies the handset and the qualifiers that
    distinguish its variants. Used identically on catalogue names and on text,
    so the two can be compared token for token. */
function analyse(tokens) {
  const base = [];
  let network = null, year = null, region = null;
  tokens.forEach(t => {
    if (NETWORK_TOKENS[t]) { network = NETWORK_TOKENS[t]; return; }
    if (/^(19|20)\d{2}$/.test(t)) { year = t; return; }
    if (REGION_TOKENS.has(t)) { region = t; return; }
    base.push(t);
  });
  return { tokens, base, network, year, region };
}

function strictKey(a) {
  return a.base.join(' ') + '|' + (a.network || '') + '|' + (a.year || '') + '|' + (a.region || '');
}
function baseKey(a) { return a.base.join(' '); }
function sortedKey(a) { return a.base.slice().sort().join(' ') + '|' + (a.network || '') + '|' + (a.year || ''); }
function compactKey(a) { return a.base.join('') + '|' + (a.network || '') + '|' + (a.year || '') + '|' + (a.region || ''); }

/** Tokens that carry a digit — the part of a name that is never fuzzy. */
function digitTokens(tokens) {
  return tokens.filter(t => /\d/.test(t) && !NETWORK_TOKENS[t]).sort();
}

/* ================================================================= index */

let TAXONOMY = null;

function brandNameFor(idx, brandId) {
  const b = idx.brands && idx.brands.get ? idx.brands.get(brandId) : null;
  return b ? b.name : brandId;
}

/**
 * Builds the matching tables over the catalogue. Once per warm instance.
 * @param {object} [idx] a search-service index; defaults to the real one
 */
function buildTaxonomy(idx) {
  idx = idx || search.loadIndex();
  const entries = [];
  const maps = {
    strictFull: new Map(), strictName: new Map(), baseFull: new Map(), baseName: new Map(),
    sortedFull: new Map(), sortedName: new Map(), compactFull: new Map(), compactName: new Map(),
    /* the name with its leading series / sub-brand word removed ("poco c65"
       -> "c65"), consulted only when a reference names NO brand, so that
       "C65" finds both the Realme and the Poco and is reported ambiguous */
    strictBare: new Map(), baseBare: new Map(),
    byBrand: new Map(), byId: new Map()
  };
  const push = (map, key, e) => { if (!key) return; if (!map.has(key)) map.set(key, []); map.get(key).push(e); };

  idx.models.forEach(m => {
    const brandName = brandNameFor(idx, m.brandId);
    const fullTokens = basicTokens(m.name);
    const brandTokens = basicTokens(brandName);
    let nameTokens = fullTokens;
    if (brandTokens.length && brandTokens.every((t, i) => fullTokens[i] === t)) nameTokens = fullTokens.slice(brandTokens.length);
    const e = {
      id: m.id, name: m.name, brandId: m.brandId, brandName,
      full: analyse(fullTokens), nameOnly: analyse(nameTokens)
    };
    entries.push(e);
    maps.byId.set(e.id, e);
    push(maps.strictFull, strictKey(e.full), e);
    push(maps.strictName, strictKey(e.nameOnly), e);
    push(maps.baseFull, baseKey(e.full), e);
    push(maps.baseName, baseKey(e.nameOnly), e);
    push(maps.sortedFull, sortedKey(e.full), e);
    push(maps.sortedName, sortedKey(e.nameOnly), e);
    push(maps.compactFull, compactKey(e.full), e);
    push(maps.compactName, compactKey(e.nameOnly), e);
    const lead = nameTokens[0];
    if (lead && BRAND_TERMS[lead] && BRAND_TERMS[lead].keep && nameTokens.length > 1) {
      const bare = analyse(nameTokens.slice(1));
      push(maps.strictBare, strictKey(bare), e);
      push(maps.baseBare, baseKey(bare), e);
    }
    push(maps.byBrand, e.brandId, e);
  });

  const brands = new Map();
  (idx.brands ? Array.from(idx.brands.values()) : []).forEach(b => brands.set(b.id, b));
  const categories = new Map();
  (idx.categories ? Array.from(idx.categories.values()) : []).forEach(c => categories.set(c.id, c));

  return { entries, maps, brands, categories, idx };
}

function taxonomy() {
  if (!TAXONOMY) TAXONOMY = buildTaxonomy();
  return TAXONOMY;
}

/* ================================================================ brands */

/**
 * Which brand a reference names, if any. The first brand word wins; a
 * sub-brand word ("redmi") is kept in the name, a brand word ("xiaomi") is
 * removed from it.
 */
function detectBrand(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const hit = BRAND_TERMS[tokens[i]];
    if (hit) return { brandId: hit.brandId, index: i, token: tokens[i], keep: !!hit.keep };
  }
  return null;
}

/* ================================================================ match */

const STRENGTH = {
  exact: 'strong', official_name: 'strong', alias: 'strong', synonym: 'strong',
  alternate_spelling: 'strong', market_term: 'strong',
  keyword: 'good', misspelling: 'good',
  similarity: 'weak', taxonomy: 'weak', ai_classification: 'weak',
  admin_selected: 'strong'
};
const RANK = { strong: 3, good: 2, weak: 1, none: 0 };

function publicModel(e) {
  return e ? { modelId: e.id, modelName: e.name, brandId: e.brandId } : null;
}

function unmatched(normalizedText, notes, alternatives) {
  return {
    status: 'unmatched', modelId: null, modelName: null, brandId: null, method: null,
    strength: 'none', normalizedText, requiresVariantConfirmation: false,
    notes: notes || [], alternatives: (alternatives || []).slice(0, 6), siblings: []
  };
}

/**
 * Resolves one model reference against the catalogue.
 *
 * @param {string} text          the reference as written ("Samsung A15 4G")
 * @param {object} [opts]
 * @param {string} [opts.brandHint]      a brand stated elsewhere in the same content
 * @param {(key:string)=>({canonicalId:string, confidence?:string}|null)} [opts.aliasLookup]
 *        sync lookup over /aliases entries the caller has already fetched
 * @param {object} [opts.tax]            a taxonomy (tests); defaults to the real one
 * @returns {object} status 'matched' | 'ambiguous' | 'unmatched', with method,
 *          strength, qualifier notes and alternatives
 */
function matchModel(text, opts = {}) {
  const tax = opts.tax || taxonomy();
  const tokens0 = basicTokens(text).filter(t => !NOISE.has(t));
  const normalizedText = tokens0.join(' ');
  if (!tokens0.length) return unmatched(normalizedText, ['nothing left after removing noise words']);
  if (!tokens0.some(t => /\d/.test(t)) && tokens0.length < 2) {
    return unmatched(normalizedText, ['no model number in the reference']);
  }

  const strictPass = runLadder(tax, tokens0, opts, false);
  if (strictPass) return finish(tax, strictPass, normalizedText, tokens0);

  const relaxedPass = runLadder(tax, tokens0, opts, true);
  if (relaxedPass) return finish(tax, relaxedPass, normalizedText, tokens0);

  /* `ladderOnly`: the caller wants a yes/no from the deterministic rungs and
     nothing fuzzy — the extractor uses it to find where a model name ENDS in a
     caption, where a fuzzy "close enough" would swallow the words after it. */
  if (opts.ladderOnly) return unmatched(normalizedText, ['no deterministic rung matched']);

  const sim = similarity(tax, tokens0, opts);
  if (sim) return finish(tax, sim, normalizedText, tokens0);

  const taxo = taxonomyRung(tax, text, tokens0, opts);
  if (taxo) return finish(tax, taxo, normalizedText, tokens0);

  return unmatched(normalizedText, ['no catalogue record matches by any method'], nearest(tax, tokens0, opts));
}

/**
 * The strict (or qualifier-relaxed) rungs exact -> market term, then the
 * same again after misspelling correction. Returns the first rung with an
 * answer: {method, hits, relaxed, brand, brandFromContext}.
 */
function runLadder(tax, tokens0, opts, relaxed) {
  const first = ladderOnce(tax, tokens0, opts, relaxed, null);
  if (first) return first;

  const corrected = tokens0.map(t => MISSPELLINGS[t] || t);
  if (corrected.some((t, i) => t !== tokens0[i])) {
    const second = ladderOnce(tax, corrected, opts, relaxed, 'misspelling');
    if (second) return second;
  }
  return null;
}

function ladderOnce(tax, tokens, opts, relaxed, forceMethod) {
  const detected = detectBrand(tokens);
  const brandId = detected ? detected.brandId : (opts.brandHint || null);
  const brandFromContext = !detected && !!opts.brandHint;
  const brandName = brandId ? brandNameFor(tax.idx, brandId) : null;
  const brandTokens = brandName ? basicTokens(brandName) : [];

  /* The reference without any pure brand words, and with its canonical brand
     in front. "Redmi 13C" -> name "redmi 13c", full "xiaomi redmi 13c". */
  const nameTokens = tokens.filter((t, i) => !(detected && i === detected.index && !detected.keep) &&
    !(brandTokens.length === 1 && t === brandTokens[0]));
  const fullTokens = brandTokens.length && !brandTokens.every((t, i) => tokens[i] === t)
    ? brandTokens.concat(nameTokens) : tokens;
  const textHasBrand = brandTokens.length > 0 && brandTokens.every((t, i) => tokens[i] === t);

  const qFull = analyse(fullTokens);
  const qName = analyse(nameTokens);
  const qText = analyse(tokens);
  const withinBrand = list => (brandId ? list.filter(e => e.brandId === brandId) : list);

  const rungs = [];
  /* exact: the text itself is the record's full name */
  rungs.push(['exact', () => textHasBrand ? get(tax.maps, relaxed, 'Full', qText) : []]);
  /* official name: the name without the brand, or with the brand restored */
  rungs.push(['official_name', () => {
    const viaFull = !textHasBrand && brandId ? get(tax.maps, relaxed, 'Full', qFull) : [];
    if (viaFull.length) return viaFull;
    const viaName = withinBrand(get(tax.maps, relaxed, 'Name', qName));
    /* No brand anywhere: every brand's bare model number competes. */
    if (!brandId && viaName.length) return viaName.concat(get(tax.maps, relaxed, 'Bare', qName));
    return viaName;
  }]);
  /* alias: /aliases entries, by the same key backend/schema.js writes */
  rungs.push(['alias', () => aliasHits(tax, tokens, brandName, opts)]);
  /* synonym: notation variants */
  rungs.push(['synonym', () => {
    const rewritten = applySynonyms(nameTokens);
    if (!rewritten) return [];
    const a = analyse(rewritten);
    const viaName = withinBrand(get(tax.maps, relaxed, 'Name', a));
    if (viaName.length) return viaName;
    return brandId ? get(tax.maps, relaxed, 'Full', analyse(brandTokens.concat(rewritten))) : [];
  }]);
  /* keyword: the same words in another order */
  rungs.push(['keyword', () => {
    const viaFull = relaxed ? [] : (tax.maps.sortedFull.get(sortedKey(qFull)) || []);
    return withinBrand(viaFull.length ? viaFull : (relaxed ? [] : (tax.maps.sortedName.get(sortedKey(qName)) || [])));
  }]);
  /* alternate spelling: the same characters, other spacing / hyphenation */
  rungs.push(['alternate_spelling', () => {
    if (relaxed) return [];
    const viaFull = tax.maps.compactFull.get(compactKey(qFull)) || [];
    return withinBrand(viaFull.length ? viaFull : (tax.maps.compactName.get(compactKey(qName)) || []));
  }]);
  /* market term: the series word the trade drops */
  rungs.push(['market_term', () => {
    const series = brandId ? (MARKET_SERIES[brandId] || []) : [];
    for (const word of series) {
      if (nameTokens.indexOf(word) > -1) continue;
      const hits = withinBrand(get(tax.maps, relaxed, 'Name', analyse([word].concat(nameTokens))));
      if (hits.length) return hits;
    }
    return [];
  }]);

  for (const [method, fn] of rungs) {
    let hits = dedupe(fn());
    if (!hits.length) continue;
    if (relaxed) {
      hits = qualifierFilter(hits, method === 'exact' ? qText : qFull);
      if (!hits.accepted.length && !hits.rejected.length) continue;
      return { method: forceMethod || method, relaxedResult: hits, relaxed: true, brandId, brandFromContext, query: qFull };
    }
    return { method: forceMethod || method, hits, relaxed: false, brandId, brandFromContext, query: qFull };
  }
  return null;
}

function get(maps, relaxed, which, a) {
  if (relaxed) return maps['base' + which].get(baseKey(a)) || [];
  return maps['strict' + which].get(strictKey(a)) || [];
}

function dedupe(list) {
  const seen = new Set();
  return (list || []).filter(e => { if (!e || seen.has(e.id)) return false; seen.add(e.id); return true; });
}

function applySynonyms(tokens) {
  let out = tokens.slice();
  let changed = false;
  SYNONYMS.forEach(([from, to]) => {
    for (let i = 0; i + from.length <= out.length; i++) {
      if (from.every((t, j) => out[i + j] === t)) {
        out = out.slice(0, i).concat(to, out.slice(i + from.length));
        changed = true;
      }
    }
  });
  return changed ? out : null;
}

function aliasHits(tax, tokens, brandName, opts) {
  if (typeof opts.aliasLookup !== 'function') return [];
  const text = tokens.join(' ');
  const keys = Array.from(new Set([aliasKey(brandName || '', text), aliasKey('', text)].filter(Boolean)));
  const hits = [];
  keys.forEach(k => {
    const found = opts.aliasLookup(k);
    if (found && found.canonicalId && tax.maps.byId.has(found.canonicalId)) {
      const e = tax.maps.byId.get(found.canonicalId);
      hits.push(Object.assign({}, e, { aliasConfidence: found.confidence || null }));
    }
  });
  return hits;
}

/**
 * Qualifier-relaxed hits, sorted into what may be proposed (with a
 * confirmation note) and what contradicts the text outright.
 */
function qualifierFilter(hits, q) {
  const accepted = [];
  const rejected = [];
  hits.forEach(e => {
    const r = e.full;
    const notes = [];
    let diffs = 0;
    let contradiction = null;

    if (q.network !== r.network) {
      if (q.network && r.network) contradiction = `the text says ${q.network.toUpperCase()}, the record says ${r.network.toUpperCase()}`;
      else if (q.network === '5g' && !r.network) contradiction = 'the text says 5G and this record\'s name does not; the 5G model may not be catalogued';
      else if (q.network) { notes.push(`the text says ${q.network.toUpperCase()}; the record's name carries no network`); diffs++; }
      else { notes.push(`the record is the ${r.network.toUpperCase()} model; the text names no network`); diffs++; }
    }
    if (q.year !== r.year) {
      if (q.year && r.year) contradiction = contradiction || `the text says ${q.year}, the record says ${r.year}`;
      else if (q.year) { notes.push(`the text says ${q.year}; the record's name carries no year`); diffs++; }
      else { notes.push(`the record is the ${r.year} model; the text names no year`); diffs++; }
    }
    if (q.region !== r.region) {
      if (q.region && r.region) contradiction = contradiction || `the text says ${q.region}, the record says ${r.region}`;
      else if (r.region) { notes.push(`the record is the ${r.region} variant`); diffs++; }
      else { notes.push(`the text says ${q.region}; the record's name does not`); diffs++; }
    }
    if (contradiction) rejected.push({ e, reason: contradiction });
    else accepted.push({ e, notes, diffs });
  });
  accepted.sort((a, b) => a.diffs - b.diffs);
  return { accepted, rejected };
}

/**
 * Fuzzy, but only on WORDS. Every digit-bearing token and the network must be
 * identical, so "Galexy A15" can find "Galaxy A15" and "A16" never can.
 */
function similarity(tax, tokens0, opts) {
  const detected = detectBrand(tokens0.map(t => MISSPELLINGS[t] || t));
  const brandId = detected ? detected.brandId : (opts.brandHint || null);
  const q = analyse(tokens0);
  const qDigits = digitTokens(q.base).join(' ');
  if (!qDigits) return null;
  /* Pure brand words are not part of a record's name-without-brand, so they
     are left out of the comparison; sub-brand words ("galaxy") are part of
     it and stay in. */
  const pureBrand = t => { const b = BRAND_TERMS[MISSPELLINGS[t] || t]; return !!b && !b.keep; };
  const qWords = q.base.filter(t => !/\d/.test(t) && !pureBrand(t)).join('');

  const pool = brandId ? (tax.maps.byBrand.get(brandId) || []) : tax.entries;
  const scored = [];
  pool.forEach(e => {
    const r = e.nameOnly;
    if (digitTokens(r.base).join(' ') !== qDigits) return;
    if ((r.network || null) !== (q.network || null) || (r.year || null) !== (q.year || null)) return;
    const rWords = r.base.filter(t => !/\d/.test(t)).join('');
    const ceiling = Math.max(qWords.length, rWords.length) <= 6 ? 1 : 2;
    const d = qWords === rWords ? 0 : search.editDistance(qWords, rWords, ceiling);
    if (d <= ceiling) scored.push({ e, d });
  });
  if (!scored.length) return null;
  scored.sort((a, b) => a.d - b.d);
  const best = scored.filter(s => s.d === scored[0].d).map(s => s.e);
  return { method: 'similarity', hits: best, relaxed: false, brandId, brandFromContext: !detected && !!opts.brandHint, query: q };
}

/**
 * The existing search ladder, as the last deterministic rung. Accepted only
 * when every hit has the same model-number tokens and network as the text.
 */
function taxonomyRung(tax, text, tokens0, opts) {
  const q = analyse(tokens0);
  const qDigits = digitTokens(q.base).join(' ');
  if (!qDigits) return null;
  let found;
  try { found = search.findModels(text, { limit: 8 }); } catch { return null; }
  const brandId = opts.brandHint || (detectBrand(tokens0) || {}).brandId || null;
  const hits = (found.models || [])
    .map(m => tax.maps.byId.get(m.id))
    .filter(Boolean)
    .filter(e => !brandId || e.brandId === brandId)
    .filter(e => digitTokens(e.full.base).join(' ') === qDigits && (e.full.network || null) === (q.network || null));
  if (!hits.length) return null;
  return { method: 'taxonomy', hits, relaxed: false, brandId, brandFromContext: false, query: q };
}

/** Closest records by the existing search, for an unmatched reference. */
function nearest(tax, tokens0) {
  try {
    const found = search.findModels(tokens0.join(' '), { limit: 5 });
    return (found.models || []).map(m => tax.maps.byId.get(m.id)).filter(Boolean)
      .map(e => Object.assign(publicModel(e), { method: 'nearest' }));
  } catch { return []; }
}

function finish(tax, r, normalizedText, tokens0) {
  const baseNotes = r.brandFromContext ? ['brand taken from elsewhere in the same content'] : [];

  if (r.relaxedResult) {
    const { accepted, rejected } = r.relaxedResult;
    const alternatives = accepted.slice(1).map(a => Object.assign(publicModel(a.e), { note: a.notes.join('; ') }))
      .concat(rejected.map(x => Object.assign(publicModel(x.e), { note: x.reason })));
    if (!accepted.length) {
      return Object.assign(unmatched(normalizedText, baseNotes.concat(rejected.map(x => `${x.e.name}: ${x.reason}`)), alternatives), {
        status: 'ambiguous', method: r.method
      });
    }
    const top = accepted.filter(a => a.diffs === accepted[0].diffs);
    if (top.length > 1) {
      return Object.assign(unmatched(normalizedText, baseNotes.concat(['more than one record differs from the text only by a variant qualifier']),
        accepted.map(a => Object.assign(publicModel(a.e), { note: a.notes.join('; ') }))), { status: 'ambiguous', method: r.method });
    }
    const chosen = accepted[0];
    const strength = RANK[STRENGTH[r.method]] > RANK.good ? 'good' : STRENGTH[r.method];
    return {
      status: 'matched', ...publicModel(chosen.e), method: r.method, strength,
      normalizedText, requiresVariantConfirmation: true,
      variantNote: chosen.notes.join('; ') + ' — confirm this is the right record (a variant is never inferred from a sibling\'s name)',
      notes: baseNotes.concat(chosen.notes),
      alternatives: alternatives.slice(0, 6),
      siblings: siblingsOf(tax, chosen.e)
    };
  }

  const hits = r.hits;
  if (hits.length > 1) {
    return Object.assign(unmatched(normalizedText, baseNotes.concat([`${hits.length} catalogue records fit this reference`]),
      hits.map(e => Object.assign(publicModel(e), { method: r.method }))), { status: 'ambiguous', method: r.method });
  }
  const e = hits[0];
  let strength = STRENGTH[r.method] || 'weak';
  if (r.method === 'alias' && e.aliasConfidence && e.aliasConfidence !== 'verified') strength = 'good';
  return {
    status: 'matched', ...publicModel(e), method: r.method, strength, normalizedText,
    requiresVariantConfirmation: false, variantNote: null,
    notes: baseNotes, alternatives: [], siblings: siblingsOf(tax, e)
  };
}

/** Records that share this one's name apart from a qualifier — shown, never merged. */
function siblingsOf(tax, e) {
  return (tax.maps.baseFull.get(baseKey(e.full)) || []).filter(s => s.id !== e.id).slice(0, 6).map(publicModel);
}

/* ============================================================ categories */

const CATEGORY_TABLE = (() => {
  const rows = [];
  Object.keys(CATEGORY_TERMS).forEach(id => {
    CATEGORY_TERMS[id].strong.forEach(t => rows.push({ term: basicTokens(t).join(' '), categoryId: id, weak: false }));
    CATEGORY_TERMS[id].weak.forEach(t => rows.push({ term: basicTokens(t).join(' '), categoryId: id, weak: true }));
  });
  UNMAPPED_PRODUCT_TERMS.forEach(t => rows.push({ term: basicTokens(t).join(' '), categoryId: null, weak: false }));
  /* longest first, so "battery door" beats "battery" and "back glass" beats "glass" */
  rows.sort((a, b) => b.term.length - a.term.length);
  return rows;
})();

/**
 * Finds the product category a text is about.
 *
 * @returns {{categoryId:string|null, method:string|null, strength:string,
 *            term:string|null, unmappedTerm:string|null, alternatives:string[]}}
 */
function resolveCategory(text, opts = {}) {
  const known = opts.categories || taxonomy().categories;
  let hay = ' ' + basicTokens(text).join(' ') + ' ';
  const hits = [];
  CATEGORY_TABLE.forEach(row => {
    if (!row.term) return;
    const needle = ' ' + row.term + ' ';
    let at = hay.indexOf(needle);
    while (at > -1) {
      hits.push({ ...row, at });
      /* blank it out so a shorter term inside it cannot match again */
      hay = hay.slice(0, at + 1) + '#'.repeat(row.term.length) + hay.slice(at + 1 + row.term.length);
      at = hay.indexOf(needle);
    }
  });

  const mapped = hits.filter(h => h.categoryId && (!known.size || known.has(h.categoryId)));
  const unmappedHit = hits.find(h => !h.categoryId);
  if (!mapped.length) {
    return { categoryId: null, method: null, strength: 'none', term: null,
             unmappedTerm: unmappedHit ? unmappedHit.term : null, alternatives: [] };
  }

  const strong = mapped.filter(h => !h.weak);
  const pool = strong.length ? strong : mapped;
  const counts = new Map();
  pool.forEach(h => counts.set(h.categoryId, (counts.get(h.categoryId) || 0) + 1));
  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] ||
    pool.findIndex(h => h.categoryId === a[0]) - pool.findIndex(h => h.categoryId === b[0]));
  const winner = ranked[0][0];
  const alternatives = ranked.slice(1).map(r => r[0]);
  const hit = pool.filter(h => h.categoryId === winner).sort((a, b) => a.at - b.at)[0];

  const exact = (CATEGORY_EXACT[winner] || []).map(t => basicTokens(t).join(' ')).indexOf(hit.term) > -1;
  const method = hit.weak ? 'keyword' : exact ? 'exact' : 'synonym';
  let strength = hit.weak ? 'good' : 'strong';
  /* Two categories named with equal weight is not a category, it is a list. */
  if (ranked.length > 1 && ranked[1][1] === ranked[0][1]) strength = 'weak';

  return {
    categoryId: winner, method, strength, term: hit.term,
    unmappedTerm: unmappedHit ? unmappedHit.term : null, alternatives
  };
}

/** Is this id one of the catalogue's categories? Never creates one. */
function isKnownCategory(categoryId, opts = {}) {
  const known = opts.categories || taxonomy().categories;
  return !!categoryId && known.has(categoryId);
}

/** The model record for an id, or null. Validates every foreign key. */
function modelById(modelId, opts = {}) {
  const tax = opts.tax || taxonomy();
  const e = tax.maps.byId.get(String(modelId || ''));
  return e ? publicModel(e) : null;
}

/**
 * The admin's model picker: whatever the matcher resolves plus the existing
 * search ladder's list, so a person can always find the right record by hand.
 */
function searchModels(q, { limit = 12, brandHint } = {}) {
  const tax = taxonomy();
  const out = [];
  const seen = new Set();
  const add = (e, method) => {
    if (!e || seen.has(e.id) || out.length >= limit) return;
    seen.add(e.id);
    out.push(Object.assign(publicModel(e), { method }));
  };
  const m = matchModel(q, { brandHint });
  if (m.modelId) add(tax.maps.byId.get(m.modelId), m.method);
  (m.alternatives || []).forEach(a => add(tax.maps.byId.get(a.modelId), a.method || 'alternative'));
  try {
    const found = search.findModels(q, { limit });
    (found.models || []).forEach(x => add(tax.maps.byId.get(x.id), found.matchType));
    /* A picker must show the neighbours too — "vivo Y27" is one of four Y27
       records, and the person choosing needs to see all of them. */
    search.partialMatch(q, limit).forEach(x => add(tax.maps.byId.get(x.id), 'partial'));
    search.fuzzyMatch(q, 5).forEach(x => add(tax.maps.byId.get(x.id), 'fuzzy'));
  } catch { /* the index is required elsewhere; an empty picker is the honest answer */ }
  return out;
}

/** For tests and the extractor: is this token a brand word? */
function brandForToken(token) {
  const t = MISSPELLINGS[token] || token;
  return BRAND_TERMS[t] ? BRAND_TERMS[t].brandId : null;
}

/** Aliases from src/data/category-assets.js, for the drift test. */
function categoryTermsFor(categoryId) {
  const t = CATEGORY_TERMS[categoryId];
  return t ? t.strong.concat(t.weak) : [];
}

module.exports = {
  BRAND_TERMS, MARKET_SERIES, MISSPELLINGS, SYNONYMS, NOISE, CATEGORY_TERMS, UNMAPPED_PRODUCT_TERMS,
  basicTokens, analyse, digitTokens, detectBrand, brandForToken,
  buildTaxonomy, taxonomy,
  matchModel, resolveCategory, isKnownCategory, modelById, searchModels, categoryTermsFor,
  aliasKeyFor: (brandName, text) => aliasKey(brandName || '', text),
  slug
};
