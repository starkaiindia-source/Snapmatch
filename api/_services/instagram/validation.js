/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/validation.js
   ----------------------------------------------------------------------------
   The second opinion: WHEN to ask for one, WHAT to ask, and what its answer
   may change. Pure — the call itself is media-processor.validateExtraction.

   ----------------------------------------------------------------------------
   CLAUDE IS NOT A SECOND PIPELINE

   Every list Gemini reads does not go to Claude. A list goes only when
   something is actually in doubt:

     · the reader's own confidence is below INSTAGRAM_VALIDATE_BELOW
     · an entry fits more than one catalogue record, or none, and there are
       records it might be                       ("Vivo Y20A / Y20 A / Y20?")
     · the product category could not be told
     · an AI-read entry collides with an existing group — worth checking the
       entry was read correctly before a person is asked to resolve a
       conflict that may be a misreading

   A list with every entry resolved, a clear product and a confident reading
   costs nothing here.

   ----------------------------------------------------------------------------
   WHAT ITS ANSWER MAY DO — AND MAY NOT

   It may SUGGEST a catalogue record for a doubtful entry (one of the records
   it was offered — anything else is discarded), say an entry was misread, say
   an entry is not in the image, and suggest a category. A suggestion is shown
   on the card for a person to confirm with one click.

   It may never resolve an entry by itself, never add an entry, never create a
   model, never touch the group comparison, the one-group-per-category rule or
   a production write. An entry it disputes moves to "needs review" — the only
   direction it can move anything. If the call fails, the extraction it was
   asked about is kept exactly as it was, marked VALIDATION_FAILED.
   ========================================================================== */
'use strict';

const taxonomy = require('../taxonomy-service');
const S = require('../../_schema/instagram');

const MAX_ENTRIES = 25;
const MAX_CANDIDATES = 6;

function aiRead(p) {
  return p.extractedBy === 'ai' || ['vision', 'ocr', 'frame'].indexOf(p.evidence && p.evidence.source) > -1;
}

/** The catalogue records an entry might be: the matcher's own alternatives,
    then the picker's neighbours. Never more than a handful. */
function candidatesFor(member) {
  const out = [];
  const seen = new Set();
  const add = (id, name) => { if (id && !seen.has(id) && out.length < MAX_CANDIDATES) { seen.add(id); out.push({ id, name }); } };
  const m = member.match || {};
  if (m.modelId) add(m.modelId, m.modelName);
  (m.alternatives || []).forEach(a => add(a.modelId, a.modelName));
  if (out.length < 3) {
    try { taxonomy.searchModels(member.text, { limit: MAX_CANDIDATES }).forEach(x => add(x.modelId, x.modelName)); }
    catch { /* an empty offer is an honest one */ }
  }
  return out;
}

function doubtful(p) {
  return (p.members || []).filter(m => m.state === 'needs_review' || m.state === 'unmatched');
}

/**
 * @param {object} p                       a group proposal
 * @param {object} ctx
 * @param {number|null} ctx.aiConfidence   the reader's own confidence, when an AI read it
 * @param {object} ctx.cfg
 * @returns {{needed:boolean, reasons:string[]}}
 */
function needsValidation(p, { aiConfidence, cfg }) {
  const reasons = [];
  if (p.status !== 'pending') return { needed: false, reasons, lowConfidence: false };
  const lowConfidence = aiConfidence != null && aiConfidence < cfg.confidenceValidate && aiRead(p);
  if (lowConfidence) {
    reasons.push(`the reader's confidence was ${Math.round(aiConfidence * 100)}%, below ${Math.round(cfg.confidenceValidate * 100)}%`);
  }
  const open = doubtful(p).filter(m => candidatesFor(m).length > 0);
  if (open.length) reasons.push(`${open.length} entr${open.length === 1 ? 'y' : 'ies'} could be more than one catalogue record`);
  if (!p.categoryId) reasons.push('the product category is unclear');
  const collisions = (p.members || []).filter(m => m.state === 'conflict' && !m.decision);
  if (collisions.length && aiRead(p)) reasons.push(`${collisions.length} machine-read entr${collisions.length === 1 ? 'y collides' : 'ies collide'} with an existing group`);
  return { needed: reasons.length > 0, reasons, lowConfidence };
}

/**
 * What the validator is shown: the doubtful entries with the records each
 * might be, never the whole catalogue.
 */
function buildRequest(p, { lowConfidence = false } = {}) {
  /* a reading the reader itself doubted: every entry it would act on is
     checked against the image, not only the ones matching stumbled on */
  const rest = lowConfidence ? (p.members || []).filter(m => m.state === 'add' || m.state === 'existing') : [];
  const ask = doubtful(p).concat((p.members || []).filter(m => m.state === 'conflict' && !m.decision && aiRead(p)), rest)
    .slice(0, MAX_ENTRIES);
  const tax = taxonomy.taxonomy();
  return {
    product_title: p.productName || '',
    current_category_id: p.categoryId || '',
    evidence_lines: (p.evidenceLines || []).slice(0, 12),
    categories: Array.from(tax.categories.values()).map(c => ({ id: c.id, name: c.name })),
    entries: ask.map(m => ({
      key: m.key,
      text_as_read: m.text,
      other_spellings: (m.texts || []).filter(t => t !== m.text).slice(0, 4),
      line: (m.evidence && m.evidence[0] && m.evidence[0].line) || '',
      why: m.state === 'conflict' ? 'resolved, but already in another compatibility group — confirm it was read correctly'
        : m.state === 'unmatched' ? 'no catalogue record matched'
        : m.state === 'add' || m.state === 'existing' ? 'the reader was not confident — confirm this is what is printed'
        : (m.matchStatus || 'needs review'),
      candidates: candidatesFor(m)
    }))
  };
}

/**
 * Applies a validated answer to the proposal's entries. MUTATES `p.members`.
 *
 * @param {object} p
 * @param {object} output      the validator's JSON
 * @param {object} request     what it was asked (buildRequest)
 * @param {object} ctx         { resolve, visual, model, cached }
 * @returns {object} the summary stored as p.validation
 */
function apply(p, output, request, { resolve, visual, model, cached }) {
  const asked = new Map(request.entries.map(e => [e.key, e]));
  const byKey = new Map((p.members || []).map(m => [m.key, m]));
  const summary = { status: 'confirmed', checked: 0, suggested: 0, disputed: 0, discarded: 0, visual: !!visual, model: model || null, cached: !!cached };

  (Array.isArray(output.entries) ? output.entries : []).slice(0, MAX_ENTRIES * 2).forEach(e => {
    const q = e && asked.get(e.key);
    const m = e && byKey.get(e.key);
    if (!q || !m) { summary.discarded++; return; }      /* an entry it was not asked about */
    summary.checked++;
    const note = typeof e.note === 'string' ? e.note.slice(0, 200) : null;

    if (e.decision === 'candidate') {
      const offered = q.candidates.find(c => c.id === e.model_id);
      if (!offered) { summary.discarded++; return; }    /* an id it was not offered: never used */
      if (m.state === 'conflict' || m.state === 'add' || m.state === 'existing') return;   /* it read the same thing: nothing changes */
      m.suggestion = { modelId: offered.id, modelName: offered.name, by: 'validator', note };
      summary.suggested++;
    } else if (e.decision === 'misread' && typeof e.printed_text === 'string' && e.printed_text.trim()) {
      const printed = e.printed_text.replace(/\s+/g, ' ').trim().slice(0, 80);
      const match = resolve(printed, null);
      m.disputed = true;
      m.suggestion = S.memberIsCertain(match)
        ? { modelId: match.modelId, modelName: match.modelName, by: 'validator', printedText: printed, note }
        : { modelId: null, modelName: null, by: 'validator', printedText: printed, note };
      summary.disputed++;
    } else if (e.decision === 'not_visible' && visual) {
      m.disputed = true;
      m.suggestion = { modelId: null, modelName: null, by: 'validator', note: note || 'not printed in the image' };
      summary.disputed++;
    }
  });

  const cat = typeof output.product_category_id === 'string' ? output.product_category_id : '';
  if (!p.categoryId && cat && taxonomy.isKnownCategory(cat)) summary.categorySuggestion = cat;
  summary.listIsCompatibility = output.list_is_compatibility !== false;
  summary.note = typeof output.summary === 'string' ? output.summary.slice(0, 300) : null;
  if (!summary.listIsCompatibility || summary.disputed) summary.status = 'disputed';
  return summary;
}

module.exports = { needsValidation, buildRequest, apply, candidatesFor, MAX_ENTRIES };
