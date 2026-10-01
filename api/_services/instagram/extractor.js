/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/extractor.js
   ----------------------------------------------------------------------------
   Reads compatibility claims out of source text: captions, OCR, transcripts.

   ----------------------------------------------------------------------------
   RULES FIRST, AI SECOND, AND THE AI IS CHECKED AGAINST THE TEXT

   The deterministic pass reads the way shops actually post:

       Samsung A15 4G Tempered Glass
       Compatible: A15 4G / A15 5G

   — a title line naming the product and its model, then a "compatible" line
   listing the rest, with the brand stated once and the network written as a
   bare "5G". It knows "same glass", "fits", "suitable for", and the Hinglish
   the trade uses ("lagega", "same hai", "nahi chalega").

   It separates what the text SAYS from what it merely LISTS:

     explicit     a compatibility word ties the models together
     implied      a slash-list in a product title — "iPhone 13 / 13 Pro Back
                  Cover" is two products on one listing as often as one part
                  that fits both, so it is never more than "low"
     same_chassis "same body" / "same size" — a hint, not a part claim
     negative     "not compatible", "different glass" — kept, because a
                  negative claim is what makes a conflict visible

   The AI is asked only when the rules leave something on the table, and its
   answer is validated before anything is kept: fixed enums, ids that exist,
   and — the one that matters — every relationship's evidenceText must appear
   VERBATIM in the source. An AI that invents "A15 fits A16" has to quote the
   post saying so, and the post does not.
   ========================================================================== */
'use strict';

const taxonomy = require('../taxonomy-service');
const { COMPAT_TYPES, POLARITIES, hashtagsIn, sha256 } = require('../../_schema/instagram');

/* ------------------------------------------------------------- patterns */

const EXPLICIT_RE = new RegExp('\\b(' + [
  'compatible\\s+with', 'compatible\\s+models?', 'compatible\\s+for', 'compatible',
  'compatibility', 'compatable', 'compitable', 'compatiable',
  'same\\s+(?:as|glass|guard|display|combo|folder|battery|frame|cover|case|board|part|flex|tray)',
  'also\\s+fits', 'fits', 'fit\\s+for', 'fitting\\s+for', 'suitable\\s+for', 'suits',
  'works?\\s+(?:with|on|for)', 'use(?:d|able)?\\s+(?:for|in|on)', 'common\\s+(?:for|in|glass|part|models?)',
  'interchangeable', 'supported\\s+models?', 'support\\s+models?',
  'lagega', 'lag\\s+jayega', 'lagta\\s+hai', 'chalega', 'chal\\s+jayega', 'fit\\s+hoga', 'aayega', 'ayega',
  'same\\s+hai', 'same\\s+he'
].join('|') + ')\\b', 'i');

const NEGATIVE_RE = new RegExp('\\b(' + [
  'not\\s+(?:compatible|same|suitable|fit|fitting|working|interchangeable)', 'incompatible',
  "doesn'?t\\s+fit", 'does\\s+not\\s+fit', "won'?t\\s+fit", 'will\\s+not\\s+fit', "don'?t\\s+fit", 'do\\s+not\\s+fit',
  'different\\s+(?:glass|size|display|combo|folder|battery|frame|cover|case|board|part|flex|tray)',
  'nahi\\s+(?:lagega|chalega|aayega|ayega)', 'nhi\\s+(?:lagega|chalega|aayega|ayega)',
  'alag\\s+(?:hai|he)'
].join('|') + ')\\b', 'i');

const CHASSIS_RE = /\bsame\s+(?:body|chassis|size|dimensions?|design|cutout|camera\s+cutout)\b/i;

/* A line that is only a heading for the list below it. */
const HEADER_RE = /^\s*(?:compatible(?:\s+(?:models?|with|for|devices?|list))?|also\s+(?:fits|compatible\s+with)|fits|suitable\s+for|supported\s+models?|same\s+(?:glass|display|combo|folder|battery|part)(?:\s+(?:for|models?))?)\s*[:\-–]*\s*$/i;

/* List separators, including the Hinglish the trade writes in: "A15 me A15
   5G ka glass lagega" is "A15 / A15 5G glass fits". */
const SEPARATOR_RE = /\s*(?:\/|\||,|;|&|\s\+\s|\band\b|\bor\b|\baur\b|\bya\b|\bme\b|\bmein\b|\s[-–]\s|•|·)\s*/i;
const HINGLISH_FILLER = new Set(['ka', 'ki', 'ke', 'ko', 'hai', 'he', 'bhi', 'wala', 'wali']);

const VARIANT_WORDS = new Set(['pro', 'max', 'plus', 'lite', 'mini', 'ultra', 'neo', 'prime', 'power', 'play', 'fe', 'edge', 'turbo', 'speed', 'star']);

/* Tokens that carry a digit but are not model numbers: glass grades, pack
   sizes, capacities, prices. */
const NOT_A_MODEL_NUMBER = /^(?:\d+(?:d|h|pcs|pc|mah|gb|tb|mm|w|x|k|rs|inr|%)|\d{5,})$/;

/* ================================================================ public */

/**
 * The deterministic pass.
 *
 * @param {Array<{source:'caption'|'ocr'|'frame'|'transcript'|'manual', ref:string|null,
 *                text:string, confidence:number|null}>} segments
 * @returns {{category:object, brandHint:string|null, references:Array,
 *            relationships:Array, hashtags:string[], warnings:string[]}}
 */
function extractDeterministic(segments) {
  const all = (segments || []).filter(s => s && typeof s.text === 'string' && s.text.trim());
  const joined = all.map(s => s.text).join('\n');
  const contentCategory = taxonomy.resolveCategory(joined);
  const contentBrand = firstBrand(joined);

  const references = [];
  const relationships = [];
  const warnings = [];
  const seenRefs = new Map();

  all.forEach(seg => {
    const segBrand = firstBrand(seg.text) || contentBrand;
    const segCategory = taxonomy.resolveCategory(seg.text);
    const lines = seg.text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    let lastTitle = null;          /* {items, line} from the most recent title-like line */
    let collecting = null;         /* an open "Compatible:" heading waiting for its list */
    let brand = segBrand;

    const addRef = (item, line) => {
      const key = item.text.toLowerCase();
      if (!seenRefs.has(key)) {
        seenRefs.set(key, true);
        references.push({ text: item.text, brandHint: item.brandHint, source: seg.source, ref: seg.ref, line, fromHashtag: false });
      }
    };

    const emit = (master, others, polarity, type, evidenceLines, category) => {
      others.forEach(other => {
        if (!master || !other || master.text.toLowerCase() === other.text.toLowerCase()) return;
        relationships.push({
          sourceText: master.text, sourceBrandHint: master.brandHint,
          compatibleText: other.text, compatibleBrandHint: other.brandHint,
          polarity, compatibilityType: type,
          evidenceText: evidenceLines.join(' / '),
          evidenceLines: evidenceLines.slice(),
          evidence: { source: seg.source, ref: seg.ref, confidence: seg.confidence == null ? null : seg.confidence },
          category: category && category.categoryId ? category
            : (segCategory.categoryId ? segCategory : contentCategory),
          extractedBy: 'rules'
        });
      });
    };

    lines.forEach((line, i) => {
      /* A heading on its own line opens a list. */
      if (HEADER_RE.test(line)) {
        collecting = { header: line, title: lastTitle, items: [], lines: [line] };
        return;
      }

      const lineCategory = taxonomy.resolveCategory(line);
      const neg = NEGATIVE_RE.exec(line);
      const pos = neg ? null : EXPLICIT_RE.exec(line);
      const chassis = !neg && !pos ? CHASSIS_RE.exec(line) : null;
      const marker = neg || pos || chassis;

      if (collecting && !marker) {
        const parsed = parseItems(line, brand);
        if (parsed.items.length) {
          brand = parsed.brand || brand;
          collecting.items.push(...parsed.items);
          collecting.lines.push(line);
          parsed.items.forEach(it => addRef(it, line));
          /* the list ends at the last line of the segment or at a line with no models */
          if (i === lines.length - 1) flush();
          return;
        }
        flush();
      } else if (collecting) {
        /* a new statement closes the list that was open */
        flush();
      }

      if (marker) {
        const before = line.slice(0, marker.index);
        const after = line.slice(marker.index + marker[0].length);
        const b = parseItems(before, brand);
        const a = parseItems(after, b.brand || brand);
        brand = a.brand || b.brand || brand;
        b.items.concat(a.items).forEach(it => addRef(it, line));

        const polarity = neg ? 'negative' : 'positive';
        const type = chassis ? 'same_chassis' : 'explicit';
        let title = b.items;
        let evidence = [line];
        if (!title.length && lastTitle) { title = lastTitle.items; evidence = [lastTitle.line, line]; }

        if (!a.items.length && !b.items.length && /[:\-–]\s*$/.test(line)) {
          /* "Samsung A15 glass — compatible:" with the list on the next lines */
          collecting = { header: line, title: lastTitle, items: [], lines: [line], polarity, type };
          return;
        }
        const master = title[0] || a.items[0];
        const others = title.slice(1).concat(a.items).filter(it => it !== master);
        emit(master, others, polarity, type, evidence, lineCategory);
        return;
      }

      /* No compatibility word. A title-like line: remember it; a slash-list is
         a listing, recorded as implied at most. */
      const parsed = parseItems(line, brand);
      brand = parsed.brand || brand;
      parsed.items.forEach(it => addRef(it, line));
      if (!parsed.items.length) return;
      if (parsed.items.length >= 2 && parsed.listSeparated &&
          (lineCategory.categoryId || segCategory.categoryId)) {
        emit(parsed.items[0], parsed.items.slice(1), 'positive', 'implied', [line], lineCategory);
      }
      lastTitle = { items: parsed.items, line };
    });
    flush();

    function flush() {
      if (!collecting) return;
      const c = collecting;
      collecting = null;
      if (!c.items.length) return;
      const title = c.title && c.title.items.length ? c.title.items : [];
      const master = title[0] || c.items[0];
      const others = title.slice(1).concat(c.items).filter(it => it !== master);
      const evidence = (c.title ? [c.title.line] : []).concat(c.lines);
      emit(master, others, c.polarity || 'positive', c.type || 'explicit', evidence,
        taxonomy.resolveCategory(evidence.join(' ')));
    }
  });

  /* Hashtags are marketing, not claims: their model names are kept as
     references (so an admin sees them) and never enter a relationship. */
  const hashtags = hashtagsIn(joined);
  hashtags.forEach(tag => {
    if (!/\d/.test(tag) || tag.length < 3) return;
    const text = tag.replace(/_/g, ' ');
    if (seenRefs.has(text)) return;
    seenRefs.set(text, true);
    references.push({ text, brandHint: contentBrand, source: 'hashtag', ref: null, line: '#' + tag, fromHashtag: true });
  });

  if (!contentCategory.categoryId) {
    warnings.push(contentCategory.unmappedTerm
      ? `product "${contentCategory.unmappedTerm}" has no category in the catalogue`
      : 'no product category named in the content');
  }

  return {
    category: contentCategory,
    brandHint: contentBrand,
    references,
    relationships: dedupeRelationships(relationships),
    hashtags,
    warnings
  };
}

/* ------------------------------------------------------------ list items */

/**
 * Splits a fragment into model references, carrying the brand, a series
 * prefix ("iPhone 13 / 13 Pro"), a bare network ("A15 4G / 5G") or a bare
 * variant word ("iPhone 13 / Pro / Pro Max") from the item before.
 */
function parseItems(fragment, brandHint) {
  const cleaned = cleanFragment(fragment);
  const parts = cleaned.split(SEPARATOR_RE).map(s => s.trim()).filter(Boolean);
  const items = [];
  let brand = brandHint || null;
  let prev = null;

  parts.forEach(part => {
    let tokens = taxonomy.basicTokens(part)
      .filter(t => !taxonomy.NOISE.has(t) && !HINGLISH_FILLER.has(t) && !NOT_A_MODEL_NUMBER.test(t));
    if (!tokens.length) return;

    const detected = tokens.map(t => taxonomy.brandForToken(t)).find(Boolean);
    if (detected) brand = detected;

    /* "5G" alone: the previous model, that network */
    if (prev && tokens.length === 1 && /^[345]g$|^lte$/.test(tokens[0])) {
      tokens = prev.base.concat(tokens[0]);
    } else if (prev && tokens.every(t => VARIANT_WORDS.has(t))) {
      /* "Pro Max" alone: the previous model's name up to its number, plus this */
      tokens = prev.upToNumber.concat(tokens);
    } else if (prev && /\d/.test(tokens[0]) && !detected && prev.prefix.length &&
               !/^[a-z]+\d/.test(tokens[0])) {
      /* "13 Pro" after "iPhone 13": inherit "iPhone" */
      tokens = prev.prefix.concat(tokens);
    }

    const hasNumber = tokens.some(t => /\d/.test(t) && !NOT_A_MODEL_NUMBER.test(t) && !/^[345]g$/.test(t));
    const hasBrandWord = tokens.some(t => taxonomy.brandForToken(t));
    const pureNumberOnly = tokens.every(t => /^\d+$/.test(t) || /^[345]g$/.test(t));
    if (!hasNumber && !(hasBrandWord && tokens.length >= 2)) return;
    if (pureNumberOnly && !hasBrandWord && !brand) return;

    tokens = boundModelSpan(tokens, brand);

    const text = tokens.join(' ');
    const firstNum = tokens.findIndex(t => /\d/.test(t) && !/^[345]g$/.test(t));
    items.push({ text: displayText(text), brandHint: brand });
    prev = {
      base: tokens.filter(t => !/^[345]g$|^lte$/.test(t)),
      prefix: firstNum > 0 ? tokens.slice(0, firstNum).filter(t => !taxonomy.brandForToken(t) || isKeepBrand(t)) : [],
      upToNumber: firstNum > -1 ? tokens.slice(0, firstNum + 1) : tokens.slice()
    };
  });

  /* "implied" is reserved for a product LISTING — models joined by a slash
     or a bar in one title. Commas and "and" are prose ("A15 glass, also
     A25 in stock") and never imply that two models share a part. */
  return { items, brand, listSeparated: parts.length > 1 && /[\/|]/.test(cleaned) };
}

function isKeepBrand(t) {
  const b = taxonomy.BRAND_TERMS[t];
  return !!(b && b.keep);
}

const QUALIFIER_RE = /^(?:[345]g|lte|(?:19|20)\d{2})$/;

/**
 * Where the model name ends inside a caption fragment.
 *
 * Shops write the model and keep going: "Samsung galaxy A14 5g display light
 * jumper", "Realme c65 no baseband problem". Taking the whole fragment made
 * every one of those "unmatched" on the first live import. The model name is
 * the LONGEST leading span the catalogue itself recognises — by the
 * deterministic rungs only, never a fuzzy one.
 *
 * What is never cut: the variant words and qualifiers that directly follow
 * the model number. "A15 Prime" is not trimmed to "A15", and "A15 5G" is not
 * trimmed to "A15" — dropping one to force a match would merge two phones.
 * If no span is in the catalogue, the reference is the number plus those
 * words, and it goes to review as unmatched.
 */
function boundModelSpan(tokens, brand) {
  const firstNum = tokens.findIndex(t => /\d/.test(t) && !QUALIFIER_RE.test(t) && !NOT_A_MODEL_NUMBER.test(t));
  const brandIdx = tokens.findIndex(t => taxonomy.brandForToken(t));

  /* the shortest acceptable end: the number, then every variant / qualifier
     word that immediately follows it */
  let minEnd = firstNum > -1 ? firstNum + 1 : Math.min(2, tokens.length);
  while (minEnd < tokens.length && (VARIANT_WORDS.has(tokens[minEnd]) || QUALIFIER_RE.test(tokens[minEnd]))) minEnd++;
  const maxEnd = Math.min(tokens.length, minEnd + 4);

  /* where it may start: at the brand word when one precedes the number,
     otherwise at the start, then closer to the number ("solution a15 5g") */
  const anchor = firstNum > -1 ? firstNum : 0;
  const starts = brandIdx > -1 && brandIdx <= anchor ? [brandIdx]
    : Array.from({ length: anchor + 1 }, (_, i) => i);

  for (const start of starts) {
    for (let end = maxEnd; end >= minEnd; end--) {
      if (end - start < 1) continue;
      const span = tokens.slice(start, end);
      const m = taxonomy.matchModel(span.join(' '), { brandHint: brand || undefined, ladderOnly: true });
      if (m.status === 'matched') return span;
    }
  }
  const start = brandIdx > -1 && brandIdx <= anchor ? brandIdx : Math.max(0, anchor - 1);
  return tokens.slice(start, minEnd);
}

/** Title-cased back from tokens, so a reference reads like a model name. */
const DISPLAY = { iphone: 'iPhone', ipad: 'iPad', oneplus: 'OnePlus', poco: 'POCO', iqoo: 'iQOO', zte: 'ZTE', hmd: 'HMD', cmf: 'CMF' };

function displayText(text) {
  return text.split(' ').map(t => DISPLAY[t] ? DISPLAY[t] : /^[345]g$/.test(t) ? t.toUpperCase()
    : /\d/.test(t) ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1)).join(' ');
}

/** Removes everything in a fragment that is not a model name: category
    words, hashtags, prices, emoji, compatibility words. */
function cleanFragment(fragment) {
  let s = String(fragment || '');
  s = s.replace(/#[\p{L}\p{N}_]+/gu, ' ');
  s = s.replace(/(?:₹|rs\.?|inr)\s*\d[\d,]*(?:\.\d+)?/gi, ' ').replace(/\d[\d,]*\s*(?:₹|rs\b|\/-)/gi, ' ');
  s = s.replace(/\+?\b\d{10,}\b/g, ' ');
  s = s.replace(/[\p{Extended_Pictographic}‍️]/gu, ' ');
  s = s.replace(/[()[\]{}"“”'‘’!?*_=]/g, ' ');
  s = s.replace(EXPLICIT_RE, ' ').replace(NEGATIVE_RE, ' ').replace(CHASSIS_RE, ' ');
  s = s.replace(/\b(?:with|for|models?|devices?|list|available|now|in\s+stock)\b\s*:?/gi, ' ');
  s = stripCategoryTerms(s);
  return s.replace(/\s*:\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function stripCategoryTerms(s) {
  const terms = [];
  Object.keys(taxonomy.CATEGORY_TERMS).forEach(id => {
    terms.push(...taxonomy.CATEGORY_TERMS[id].strong, ...taxonomy.CATEGORY_TERMS[id].weak);
  });
  terms.push(...taxonomy.UNMAPPED_PRODUCT_TERMS);
  terms.sort((a, b) => b.length - a.length);
  let out = ' ' + s + ' ';
  terms.forEach(t => {
    const pattern = t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/\s+/g, '\\s*');
    out = out.replace(new RegExp('(^|[^a-z0-9])' + pattern + '(?=$|[^a-z0-9])', 'gi'), '$1 ');
  });
  return out;
}

function firstBrand(text) {
  const tokens = taxonomy.basicTokens(text);
  for (const t of tokens) {
    const b = taxonomy.brandForToken(t);
    if (b) return b;
  }
  return null;
}

/** One statement per (pair, polarity): explicit beats implied beats chassis. */
function dedupeRelationships(list) {
  const rank = { explicit: 3, same_chassis: 2, implied: 1 };
  const out = new Map();
  list.forEach(r => {
    const pair = [r.sourceText.toLowerCase(), r.compatibleText.toLowerCase()].sort().join('|');
    const key = pair + '|' + r.polarity;
    const have = out.get(key);
    if (!have || (rank[r.compatibilityType] || 0) > (rank[have.compatibilityType] || 0)) out.set(key, r);
  });
  return Array.from(out.values());
}

/* ==================================================================== AI */

/** The instruction the extraction model receives, verbatim from the brief,
    followed by the output contract. Changing it is a PROCESSING_VERSION bump. */
const AI_SYSTEM_PROMPT = [
  'You are extracting mobile-part compatibility information from source content.',
  'Extract only information supported by the provided source.',
  'Do not invent models, compatibility relationships, categories, or specifications.',
  'Every model must be resolved against the provided ProGlide Mobile Model Database.',
  'If no confident match exists, return UNMATCHED.',
  'Separate explicit compatibility from inference.',
  'Return structured JSON only.',
  '',
  'Output: {"relationships":[{"sourceModelText":string,"sourceModelId":string|"UNMATCHED",',
  '"compatibleModelText":string,"compatibleModelId":string|"UNMATCHED",',
  '"categoryText":string|null,"categoryId":string|"UNMATCHED"|null,',
  '"compatibilityType":"explicit"|"implied"|"same_chassis"|"same_family"|"similar_name"|"uncertain",',
  '"polarity":"positive"|"negative","evidenceText":string}],',
  '"modelMentions":[{"text":string,"modelId":string|"UNMATCHED"}]}',
  'evidenceText MUST be copied exactly from sourceText. Model ids MUST come from candidateModels.',
  'Category ids MUST come from categories.'
].join('\n');

/**
 * Should the AI be asked at all? Only when the rules left something:
 *   · a compatibility word or a category, and two or more model-like
 *     references, but no relationship came out; or
 *   · a relationship member the matcher could not resolve.
 * `always` asks every time; `off` never.
 */
function shouldAskAi(mode, deterministic, resolvedRefs) {
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  const refs = deterministic.references.filter(r => !r.fromHashtag).length;
  if (!deterministic.relationships.length && refs >= 2 && deterministic.category.categoryId) return true;
  const relMembers = new Set();
  deterministic.relationships.forEach(r => {
    relMembers.add(r.sourceText.toLowerCase());
    relMembers.add(r.compatibleText.toLowerCase());
  });
  return (resolvedRefs || []).some(r => relMembers.has(r.text.toLowerCase()) && r.match.status !== 'matched');
}

/** What the model is shown: the source, and the catalogue records it may choose from. */
function buildAiInput({ segments, candidateModels, categories }) {
  return {
    sourceText: segments.map(s => `[${s.source}${s.ref ? ':' + s.ref : ''}] ${s.text}`).join('\n'),
    candidateModels: candidateModels.slice(0, 80),
    categories: categories.map(c => ({ id: c.id, name: c.name }))
  };
}

function inputHash(input) {
  return sha256(JSON.stringify(input));
}

/**
 * Pulls the JSON out of whatever the gateway returned. The contract is a JSON
 * object; a model that wrapped it in prose or a ```json fence still gets one
 * chance to be read, and nothing more.
 */
function unwrapAiOutput(output) {
  if (!output || typeof output !== 'object') return null;
  const inner = output.result && typeof output.result === 'object' ? output.result : output;
  if (Array.isArray(inner.relationships)) return inner;
  if (typeof inner.message === 'string') {
    const m = /\{[\s\S]*\}/.exec(inner.message);
    if (m) { try { const parsed = JSON.parse(m[0]); if (parsed && Array.isArray(parsed.relationships)) return parsed; } catch { /* not JSON */ } }
  }
  return null;
}

function squash(s) {
  return String(s || '').toLowerCase().replace(/[\s‍️]+/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
}

/**
 * Schema validation. Nothing the AI returns is stored until it passes this.
 *
 * @param {*} raw          the gateway's output
 * @param {object} ctx
 * @param {string} ctx.sourceText      everything the model was shown
 * @param {Set<string>} ctx.modelIds   ids the model was allowed to use
 * @param {Set<string>} ctx.categoryIds
 * @returns {{ok:boolean, error?:string, valid:Array, rejected:Array}}
 */
function validateAiExtraction(raw, ctx) {
  const out = unwrapAiOutput(raw);
  if (!out) return { ok: false, error: 'AI output is not the required JSON object', valid: [], rejected: [] };
  const source = squash(ctx.sourceText);
  const valid = [];
  const rejected = [];

  out.relationships.slice(0, 60).forEach(r => {
    const reasons = [];
    if (!r || typeof r !== 'object') { rejected.push({ relationship: null, reasons: ['not an object'] }); return; }
    const str = (v, max) => typeof v === 'string' && v.trim() && v.length <= max;
    if (!str(r.sourceModelText, 120)) reasons.push('sourceModelText missing or too long');
    if (!str(r.compatibleModelText, 120)) reasons.push('compatibleModelText missing or too long');
    if (!str(r.evidenceText, 600)) reasons.push('evidenceText missing or too long');
    if (COMPAT_TYPES.indexOf(r.compatibilityType) < 0) reasons.push('compatibilityType not in the allowed list');
    if (POLARITIES.indexOf(r.polarity) < 0) reasons.push('polarity not in the allowed list');
    ['sourceModelId', 'compatibleModelId'].forEach(k => {
      if (typeof r[k] !== 'string' || !r[k]) reasons.push(`${k} missing`);
      else if (r[k] !== 'UNMATCHED' && !ctx.modelIds.has(r[k])) reasons.push(`${k} "${r[k].slice(0, 60)}" is not a catalogue record it was offered`);
    });
    if (r.categoryId != null && r.categoryId !== 'UNMATCHED' && !ctx.categoryIds.has(r.categoryId)) {
      reasons.push(`categoryId "${String(r.categoryId).slice(0, 40)}" is not a catalogue category`);
    }
    /* The anti-invention check: the quote must be in the source. */
    if (str(r.evidenceText, 600) && source.indexOf(squash(r.evidenceText)) < 0) {
      reasons.push('evidenceText does not appear in the source content');
    }
    const clean = {
      sourceModelText: String(r.sourceModelText || '').slice(0, 120),
      compatibleModelText: String(r.compatibleModelText || '').slice(0, 120),
      sourceModelId: typeof r.sourceModelId === 'string' ? r.sourceModelId.slice(0, 120) : null,
      compatibleModelId: typeof r.compatibleModelId === 'string' ? r.compatibleModelId.slice(0, 120) : null,
      categoryText: typeof r.categoryText === 'string' ? r.categoryText.slice(0, 80) : null,
      categoryId: typeof r.categoryId === 'string' ? r.categoryId.slice(0, 60) : null,
      compatibilityType: r.compatibilityType,
      polarity: r.polarity,
      evidenceText: String(r.evidenceText || '').slice(0, 600)
    };
    if (reasons.length) rejected.push({ relationship: clean, reasons });
    else valid.push(clean);
  });

  return { ok: true, valid, rejected };
}

module.exports = {
  EXPLICIT_RE, NEGATIVE_RE, CHASSIS_RE, HEADER_RE,
  extractDeterministic, parseItems, cleanFragment,
  AI_SYSTEM_PROMPT, shouldAskAi, buildAiInput, inputHash, unwrapAiOutput, validateAiExtraction
};
