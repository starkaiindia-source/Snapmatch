/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/relevance.js
   ----------------------------------------------------------------------------
   Is this post ABOUT compatibility at all?

   A technician's page is mostly repair: "Samsung A14 5G display light
   jumper", "Realme C65 no baseband problem", "Redmi 9 Power dead — remove
   this capacitor". Every one of those names a phone, and "display" is a word
   the catalogue knows. Before this file existed that was enough to put them
   in front of an admin as "unmatched model" cards and to read "display light
   jumper" as the product Display.

   Naming a phone is not a compatibility claim. The claim is a STATEMENT —
   "compatible with", "universal", "लग जाएगा 68 models में", a headed list —
   and this file looks for that, and for the vocabulary of board-level repair,
   and decides which the post is.

   ----------------------------------------------------------------------------
   PRECISION AND RECALL, AND WHICH WAY EACH RULE LEANS

     · A compatibility list wins over a repair caption. A reel captioned with
       a jumper tip that SHOWS a headed model list is compatibility content,
       and only the list is extracted.
     · A statement that is itself about repair is not a list. "Charging ways
       same: Redmi 9 / 9 Prime" ties two models together — by a repair route,
       not by a part. It is dropped.
     · A generic caption decides nothing. "Universal combo…" over a reel whose
       frames could not be read is INSUFFICIENT_EVIDENCE, not irrelevant: it
       stays visible so a person can supply what the API withheld.
     · Nothing is deleted. An ignored post keeps its classification, the terms
       that decided it, and its text, behind the "Ignored" filter.

   Pure: no I/O. The vocabulary is data, so adding a word is a one-line change
   and a PROCESSING_VERSION bump.
   ========================================================================== */
'use strict';

/* Words that are repair on their own. */
const REPAIR_STRONG = [
  'jumper', 'jumpers', 'jumpar', 'jamper', 'jumper solution', 'bypass', 'by pass', 'ways', 'way solution',
  'baseband', 'no network', 'network problem', 'no service', 'emergency call', 'no signal',
  'reball', 'reballing', 'schematic', 'diagram', 'borneo', 'shorting', 'shorted', 'full short', 'half short',
  'dead', 'dead solution', 'dead phone', 'no power', 'auto on off', 'bootloop', 'boot loop', 'hang on logo', 'stuck on logo',
  'capacitor', 'remove cap', 'remove capacitor', 'coil', 'diode', 'resistor', 'mosfet', 'transistor',
  'ic', 'charging ic', 'power ic', 'light ic', 'backlight ic', 'ovp', 'ovp ic', 'pmic', 'cpu', 'emmc', 'ufs', 'isp', 'test point', 'testpoint',
  'display light', 'lcd light', 'backlight', 'back light', 'no display', 'no light', 'graphic', 'graphics problem',
  'charging error', 'charging problem', 'not charging', 'no charging', 'fake charging', 'charging paused', 'moisture',
  'temperature', 'temp warning', 'temperature warning', 'overheat', 'overheating', 'heating problem',
  'water damage', 'water damaged', 'repair', 'repairing', 'repaired', 'soldering', 'hot air', 'multimeter', 'voltage', 'dc power',
  'frp', 'frp bypass', 'firmware', 'flashing', 'flash file', 'imei', 'unbrick',
  'mic problem', 'mic ways', 'speaker problem', 'ringer problem', 'touch not working', 'not working', 'power button jumper',
  'on off ways', 'volume ways', 'sim ways', 'sim not working', 'network jumper', 'light jumper', 'charging jumper',
  /* Devanagari and Tamil, as technicians caption them */
  'जम्पर', 'जंपर', 'रिपेयर', 'शॉर्ट', 'डेड', 'बाईपास', 'ஜம்பர்', 'பழுது', 'ரிப்பேர்'
];

/* Words that lean repair but appear in ordinary sentences too. */
const REPAIR_WEAK = [
  'problem', 'solution', 'error', 'fault', 'faulty', 'issue', 'hang', 'restart', 'unlock', 'flash', 'trick', 'tutorial',
  'short', 'fix', 'fixed', 'damage', 'damaged', 'warning', 'kharab', 'thik', 'समस्या', 'சரி செய்'
];

/* A compatibility STATEMENT about a part. "same as" alone is not one: a
   technician writes "charging ways same as Redmi 9" too, and that ties two
   phones together by a repair route. */
const COMPAT_STRONG = [
  'compatible', 'compatable', 'compitable', 'compatiable', 'compatibility', 'compatible with', 'compatible models',
  'universal', 'all in one', 'also fits', 'fits', 'fit for', 'suitable for', 'works with', 'work with',
  'applicable models', 'applicable for', 'supported models', 'support models', 'interchangeable',
  'same display', 'same combo', 'same folder', 'same lcd', 'same glass', 'same guard', 'same battery', 'same frame',
  'same cover', 'same board', 'same part', 'common for', 'common models',
  'lagega', 'lag jayega', 'lag jaega', 'lag jaayega', 'chalega', 'chal jayega', 'fit hoga',
  'लग जाएगा', 'लग जायेगा', 'लग जाएगी', 'लगेगा', 'लगेगी', 'चलेगा', 'பொருந்தும்', 'பொருந்தக்கூடிய'
];

/* "68 models", "12+ models": a count of models is a list announcing itself. */
const MODEL_COUNT_RE = /(?:^|[^a-z0-9])(\d{1,3})\s*\+?\s*models?(?![a-z])/i;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* Latin terms need word boundaries ("ic" is not in "price"); Indic scripts
   have none a JS regex understands, so they match as substrings. */
function compile(terms) {
  const latin = terms.filter(t => /^[\x00-\x7f]+$/.test(t)).sort((a, b) => b.length - a.length);
  const other = terms.filter(t => !/^[\x00-\x7f]+$/.test(t));
  const parts = [];
  if (latin.length) parts.push('(?<![a-z0-9])(?:' + latin.map(t => escapeRe(t).replace(/\s+/g, '\\s+')).join('|') + ')(?![a-z0-9])');
  if (other.length) parts.push('(?:' + other.map(t => escapeRe(t).replace(/\s+/g, '\\s*')).join('|') + ')');
  return new RegExp(parts.join('|'), 'giu');
}

const REPAIR_STRONG_RE = compile(REPAIR_STRONG);
const REPAIR_WEAK_RE = compile(REPAIR_WEAK);
const COMPAT_STRONG_RE = compile(COMPAT_STRONG);

function hits(re, text) {
  const out = new Set();
  String(text || '').replace(re, m => { out.add(m.toLowerCase().replace(/\s+/g, ' ').trim()); return m; });
  return Array.from(out);
}

/**
 * What a piece of text sounds like.
 * @returns {{repair:{score:number, terms:string[]}, compat:{strong:boolean, terms:string[], modelCount:number|null}}}
 */
function scan(text) {
  const t = String(text || '');
  const strong = hits(REPAIR_STRONG_RE, t);
  const weak = hits(REPAIR_WEAK_RE, t);
  const compat = hits(COMPAT_STRONG_RE, t);
  const count = MODEL_COUNT_RE.exec(t);
  if (count) compat.push(count[0].replace(/^[^0-9]+/, '').trim().toLowerCase());
  return {
    repair: { score: strong.length * 2 + weak.length, terms: strong.concat(weak).slice(0, 12) },
    compat: { strong: compat.length > 0, terms: compat.slice(0, 12), modelCount: count ? Number(count[1]) : null }
  };
}

/** Repair decides only when nothing in the same text states compatibility. */
function isRepairText(text) {
  const s = scan(text);
  return s.repair.score >= 2 && !s.compat.strong;
}

/**
 * Stage 1, before any paid call: what the CAPTION alone says.
 *   repair   a repair post by its own words — its media is not read
 *   compat   it talks about compatibility — read everything
 *   generic  it decides nothing — read the media, the answer is in there
 */
function captionGate(caption) {
  const s = scan(caption);
  if (s.compat.strong) return 'compat';
  if (s.repair.score >= 2) return 'repair';
  return 'generic';
}

/* ============================================================ the cheap filter

   STAGE 1 OF THE COST PIPELINE: A SCORE, NOT A VERDICT

   Before any model is paid for, every post gets a score from what costs
   nothing — its caption, its type, and how this page's earlier posts turned
   out. The score decides only HOW MUCH is spent finding out:

     HIGH     the caption talks about compatibility -> straight to the deep read
     MEDIUM   a product or a model, nothing against it -> a cheap visual screen first
     LOW      nothing useful, or mixed signals        -> a cheap visual screen first
     REJECT   repair by its own words, no product compatibility wording at all
              -> nothing is spent

   It is deliberately lopsided. A word like "jumper" LOWERS the score; it does
   not end the matter — "Vivo Y20 display jumper" still gets screened, because
   the same post may carry a compatibility table. REJECT needs a strong repair
   term, no compatibility wording and a clearly negative total. And a generic
   caption ("Universal combo…", "New stock") is never a reason to skip: that
   is exactly the caption a 68-model reel is posted under.

   What the page did before nudges the score by one point either way, shown
   among the reasons, and can never produce a REJECT: no page and no word is
   ever blacklisted. */

const PRODUCT_RE = compile([
  'combo', 'display', 'lcd', 'amoled', 'oled', 'folder', 'tempered glass', 'tempered', 'screen guard', 'glass', 'screen',
  'back cover', 'cover', 'case', 'battery', 'middle frame', 'frame', 'cc board', 'charging board', 'sub board', 'sim tray',
  'button flex'
]);
/* "Y20", "A03s", "13C", or a series word and a number ("Redmi 9", "Note 10") */
const MODELISH_RE = /(?<![a-z0-9])(?:[a-z]{1,3}\d{1,3}[a-z]{0,2}|\d{1,2}[a-z]{1,2}|(?:redmi|note|iphone|pixel|narzo|nord|moto|galaxy|poco|realme|oppo|vivo|iqoo|samsung|mi)\s+\d{1,3}[a-z]{0,2})(?![a-z0-9])/gi;

const WEIGHTS = { compat: 4, modelCount: 3, product: 2, model: 1, list: 3, repairStrong: -3, repairWeak: -1 };
const TIER = { HIGH: 4, MEDIUM: 1, REJECT: -2 };

/**
 * @param {object} args
 * @param {string} args.caption
 * @param {string} [args.contentType]   image | carousel | video | reel | text
 * @param {{content?:number, relevant?:number}} [args.sourceStats]  this page's earlier posts
 * @returns {{score:number, tier:'HIGH'|'MEDIUM'|'LOW'|'REJECT', reasons:Array<{signal:string, weight:number, terms?:string[]}>}}
 */
function scoreCandidate({ caption, contentType, sourceStats }) {
  const text = String(caption || '');
  const s = scan(text);
  const reasons = [];
  const add = (signal, weight, terms) => { if (weight) reasons.push(Object.assign({ signal, weight }, terms && terms.length ? { terms: terms.slice(0, 5) } : {})); };

  const compatTerms = s.compat.terms.filter(t => !/^\d+\s*\+?\s*models?$/.test(t));
  add('compatibility wording', Math.min(2, compatTerms.length) * WEIGHTS.compat, compatTerms);
  if (s.compat.modelCount) add('a count of models', WEIGHTS.modelCount, [s.compat.modelCount + ' models']);
  const products = hits(PRODUCT_RE, text);
  if (products.length) add('a product', WEIGHTS.product, products);
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const modelLines = lines.filter(l => l.length <= 40 && /[a-z]/i.test(l) && /\d/.test(l)).length;
  if (modelLines >= 3) add('several lines that look like model names', WEIGHTS.list);
  const strong = hits(REPAIR_STRONG_RE, text);
  const weak = hits(REPAIR_WEAK_RE, text);
  /* naming a phone is exactly what a repair post does: beside repair wording,
     and with no compatibility wording, a model name earns nothing */
  const models = (text.match(MODELISH_RE) || []).filter(m => !/^\d+\s*(?:d|h|g|gb|mm|pc|rs)$/i.test(m));
  if (models.length && !(strong.length && !s.compat.strong)) {
    add('a model-looking name', Math.min(2, new Set(models.map(m => m.toLowerCase())).size) * WEIGHTS.model);
  }
  add('repair or fault wording', Math.max(-9, strong.length * WEIGHTS.repairStrong), strong);
  add('problem / solution wording', Math.max(-3, weak.length * WEIGHTS.repairWeak), weak);

  /* what this page has posted before: a nudge, never a decision */
  const seen = Number(sourceStats && sourceStats.content) || 0;
  if (seen >= 20) {
    const rate = (Number(sourceStats.relevant) || 0) / seen;
    if (rate >= 0.3) add('this page often posts compatibility content', 1);
    else if (rate <= 0.02 && seen >= 50) add('this page has rarely posted compatibility content', -1);
  }

  const score = reasons.reduce((n, r) => n + r.weight, 0);
  let tier;
  if (s.compat.strong && score >= TIER.MEDIUM) tier = score >= TIER.HIGH ? 'HIGH' : 'MEDIUM';
  else if (score >= TIER.HIGH) tier = 'HIGH';
  else if (score >= TIER.MEDIUM) tier = 'MEDIUM';
  else if (score <= TIER.REJECT && strong.length && !s.compat.strong) tier = 'REJECT';
  else tier = 'LOW';
  return { score, tier, reasons, contentType: contentType || null };
}

/** Is OCR text worth sending to the (costlier) vision model? A compatibility
    word, or several lines that each look like a model name. */
function looksLikeCompatibility(text) {
  const s = scan(text);
  if (s.compat.strong) return true;
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const modelish = lines.filter(l => l.length <= 40 && /[a-z]/i.test(l) && /\d/.test(l)).length;
  return modelish >= 4 && s.repair.score < 2;
}

function tainted(evidenceLines) {
  return isRepairText((evidenceLines || []).join('\n'));
}

/**
 * @param {object} args
 * @param {Array<{source:string, text:string}>} args.segments
 * @param {{relationships:Array, sets:Array}} args.det      extractor output
 * @param {Array<{ocrStatus:string, kind:string}>} [args.mediaItems]
 * @param {number} [args.certainMembers]   list entries resolved to catalogue records
 * @returns {{relevance:string, reason:string, compatSignal:boolean,
 *            signals:object, sets:Array, relationships:Array}}
 *          `sets` and `relationships` are the ones that survive: a statement
 *          tied together by repair wording is removed here.
 */
function classify({ segments, det, mediaItems, certainMembers }) {
  const texts = (segments || []).map(s => s.text).join('\n');
  const all = scan(texts);
  const sets = ((det && det.sets) || []).filter(s => !tainted(s.evidenceLines));
  const relationships = ((det && det.relationships) || []).filter(r => !tainted(r.evidenceLines || [r.evidenceText]));
  const droppedForRepair = ((det && det.sets) || []).length - sets.length +
    ((det && det.relationships) || []).length - relationships.length;

  const explicit = relationships.filter(r => r.compatibilityType === 'explicit' || r.compatibilityType === 'same_chassis');
  const implied = relationships.filter(r => r.compatibilityType === 'implied');
  const hasCategory = sets.some(s => s.category && s.category.categoryId) ||
    explicit.some(r => r.category && r.category.categoryId);
  const unread = (mediaItems || []).filter(m => m.ocrStatus !== 'ok' && m.ocrStatus !== 'skipped' && m.ocrStatus !== 'empty');
  const mediaUnread = unread.length > 0;
  /* AI vision looked at an image and saw a jumper diagram or a board */
  const picturedRepair = (mediaItems || []).some(m => m.vision && m.vision.contentClass === 'repair');

  const signals = {
    repairTerms: all.repair.terms, repairScore: all.repair.score,
    compatTerms: all.compat.terms, announcedModels: all.compat.modelCount,
    lists: sets.length, listEntries: sets.reduce((n, s) => n + s.members.length, 0),
    statements: explicit.length, listings: implied.length,
    droppedAsRepair: droppedForRepair, mediaUnread: unread.length, picturedRepair
  };
  const out = (relevance, reason) => ({ relevance, reason, compatSignal: all.compat.strong, signals, sets, relationships });

  if (sets.length || explicit.length) {
    if (sets.length && certainMembers != null && certainMembers < 2 && !explicit.length) {
      return out('NEEDS_REVIEW', 'A compatibility list was found, but fewer than two of its models resolved to catalogue records.');
    }
    if (!hasCategory) {
      return out('PARTIALLY_RELEVANT', 'A compatibility statement was found, but the product is not named or is not one of the catalogue\'s categories.');
    }
    return out('RELEVANT_COMPATIBILITY', sets.length
      ? `A compatibility list of ${signals.listEntries} entr${signals.listEntries === 1 ? 'y' : 'ies'} for a catalogue product.`
      : 'An explicit compatibility statement for a catalogue product.');
  }

  /* A repair post by its own words: decided whatever the media holds, which
     is why its media was not read. */
  if (all.repair.score >= 2 && !all.compat.strong) {
    return out('IRRELEVANT_REPAIR', 'Repair or technical content (' + all.repair.terms.slice(0, 4).join(', ') +
      '). It names a phone, but makes no compatibility claim.');
  }

  if (picturedRepair && !all.compat.strong) {
    return out('IRRELEVANT_REPAIR', 'The image shows repair or diagnostic content, and nothing states compatibility.');
  }

  if (implied.length) {
    return out('PARTIALLY_RELEVANT', 'A product listing names several models together. That is not a compatibility statement, so it is low confidence.');
  }

  if (all.compat.strong) {
    if (mediaUnread) {
      return out('INSUFFICIENT_EVIDENCE', 'The post talks about compatibility (' + all.compat.terms.slice(0, 3).join(', ') +
        '), but its ' + (unread.some(m => m.kind === 'video') ? 'video' : 'image') + ' could not be read, so the model list is unknown. Add screenshots or the text to analyse it.');
    }
    if (all.repair.score >= 2) {
      return out('NEEDS_REVIEW', 'Both compatibility wording and repair wording, and no model list could be read.');
    }
    return out('INSUFFICIENT_EVIDENCE', 'The post talks about compatibility (' + all.compat.terms.slice(0, 3).join(', ') +
      '), but no list of models could be read from it.');
  }

  if (mediaUnread) {
    return out('INSUFFICIENT_EVIDENCE', 'The caption decides nothing and the media could not be read (' +
      String(unread[0].reason || unread[0].ocrStatus).slice(0, 160) + ').');
  }
  if (all.repair.score >= 1) {
    return out('IRRELEVANT_REPAIR', 'Technical content (' + all.repair.terms.slice(0, 3).join(', ') + ') with no compatibility claim.');
  }
  return out('IRRELEVANT_GENERAL', 'No compatibility statement and no model list.');
}

module.exports = {
  REPAIR_STRONG, REPAIR_WEAK, COMPAT_STRONG, MODEL_COUNT_RE,
  scan, isRepairText, captionGate, scoreCandidate, looksLikeCompatibility, classify
};
