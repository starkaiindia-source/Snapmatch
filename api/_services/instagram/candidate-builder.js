/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/candidate-builder.js
   ----------------------------------------------------------------------------
   Resolved relationships -> review candidates and their evidence. Pure.

   Every candidate carries the whole chain that produced it, so the review
   card — and a person asking in a year "why does this fitment exist?" — can
   see all of it without another lookup:

     source post -> source media -> extracted text -> extracted model text
       -> normalised text -> catalogue match (id, name, METHOD, strength,
          qualifier notes, alternatives) -> category (term, method)
       -> compatibility type + polarity -> confidence FACTORS -> section

   A candidate is never "approved" here. The strongest thing this file can say
   is `reviewSection: 'ready'`, which means a person may approve it in one
   click — not that anything has been written.
   ========================================================================== */
'use strict';

const S = require('../../_schema/instagram');
const taxonomy = require('../taxonomy-service');

const TEXT_CAP = 2000;

function slimMatch(m) {
  if (!m) return null;
  return {
    status: m.status, modelId: m.modelId || null, modelName: m.modelName || null, brandId: m.brandId || null,
    method: m.method || null, strength: m.strength || 'none', normalizedText: m.normalizedText || null,
    requiresVariantConfirmation: !!m.requiresVariantConfirmation, variantNote: m.variantNote || null,
    notes: (m.notes || []).slice(0, 8),
    alternatives: (m.alternatives || []).slice(0, 6).map(a => ({ modelId: a.modelId, modelName: a.modelName, note: a.note || null })),
    siblings: (m.siblings || []).slice(0, 6).map(s => ({ modelId: s.modelId, modelName: s.modelName })),
    aiProposedModelId: m.aiProposedModelId || null
  };
}

function segmentText(segments, predicate) {
  return segments.filter(predicate).map(s => s.text).join('\n').slice(0, TEXT_CAP) || null;
}

/**
 * @param {object} args
 * @param {Array} args.relationships   extractor output, each with sourceMatch / compatibleMatch attached
 * @param {Array} args.aiRejected      AI relationships that failed validation
 * @param {Array} args.references      extractor references, each with `match`
 * @param {Array} args.segments        the source texts
 * @param {object} args.ctx            { job, content, extractionId, version, now, aiModel }
 * @returns {{candidates:object[], evidence:object[], stats:object}}
 */
function buildCandidates({ relationships, aiRejected, references, segments, ctx }) {
  const candidates = [];
  const evidence = [];
  const inRelationships = new Set();
  const stats = { relationships: 0, selfPairsDropped: 0, systemRejected: 0, references: 0 };

  const base = () => ({
    jobId: ctx.job.jobId,
    sourceKey: ctx.job.sourceKey,
    sourceUsername: ctx.job.username || null,
    contentKey: ctx.content.contentKey,
    extractionId: ctx.extractionId,
    contentVersion: ctx.version,
    sourcePost: {
      permalink: ctx.content.permalink || null,
      mediaId: ctx.content.mediaId || null,
      contentType: ctx.content.contentType || null,
      publishedAt: ctx.content.publishedAt || null,
      collectionMethod: ctx.content.collectionMethod || null
    },
    processingVersion: S.PROCESSING_VERSION,
    extractedAt: ctx.now,
    duplicateOf: null, duplicateReason: null,
    conflict: null, productionState: null,
    reviewer: null, reviewedAt: null, approvedBy: null, approvedAt: null,
    rejectReason: null, rejectNote: null,
    corroborations: 0,
    createdAt: ctx.now, updatedAt: ctx.now
  });

  (relationships || []).forEach(rel => {
    const sm = rel.sourceMatch;
    const cm = rel.compatibleMatch;
    inRelationships.add(rel.sourceText.toLowerCase());
    inRelationships.add(rel.compatibleText.toLowerCase());

    /* "A15 4G tempered glass, compatible: A15 4G / A15 5G" lists the master
       again. Once both sides resolve to one record it is not a relationship. */
    if (sm && cm && sm.status === 'matched' && cm.status === 'matched' && sm.modelId === cm.modelId) {
      stats.selfPairsDropped++;
      return;
    }

    const category = rel.category || { categoryId: null, strength: 'none' };
    const categoryId = category.categoryId && taxonomy.isKnownCategory(category.categoryId) ? category.categoryId : null;
    const evidenceSeg = rel.evidence || { source: 'caption', ref: null, confidence: null };

    const confidence = S.evaluateConfidence({
      sourceMatch: sm, compatibleMatch: cm,
      category: categoryId ? { categoryId, strength: category.strength } : null,
      compatibilityType: rel.compatibilityType, polarity: rel.polarity,
      evidence: evidenceSeg, extractedByAi: rel.extractedBy === 'ai'
    });

    const candidateId = S.candidateIdFor({
      extractionId: ctx.extractionId, kind: 'relationship',
      sourceText: rel.sourceText, compatibleText: rel.compatibleText, polarity: rel.polarity
    });

    const relKey = sm && cm && sm.status === 'matched' && cm.status === 'matched'
      ? S.relKeyFor(categoryId, sm.modelId, cm.modelId) : null;

    let status = 'pending';
    let rejectReason = null, rejectNote = null;
    if (S.IMPORTABLE_TYPES.indexOf(rel.compatibilityType) < 0) {
      status = 'rejected';
      rejectReason = 'not_a_compatibility_claim';
      rejectNote = `A "${String(rel.compatibilityType).replace(/_/g, ' ')}" statement is not evidence that two models take the same part.`;
    }

    const doc = Object.assign(base(), {
      candidateId,
      kind: 'relationship',
      sourceMedia: evidenceSeg.ref ? [evidenceSeg.ref] : [],
      extractedText: String(rel.evidenceText || '').slice(0, TEXT_CAP),
      evidenceLines: (rel.evidenceLines || [rel.evidenceText]).slice(0, 12).map(l => String(l).slice(0, 500)),
      evidence: {
        source: evidenceSeg.source, ref: evidenceSeg.ref || null,
        confidence: evidenceSeg.confidence == null ? null : evidenceSeg.confidence
      },
      captionText: segmentText(segments, s => s.source === 'caption' || s.source === 'manual'),
      ocrText: segmentText(segments, s => (s.source === 'ocr' || s.source === 'frame') &&
        (!evidenceSeg.ref || String(s.ref || '').split('@')[0] === String(evidenceSeg.ref).split('@')[0])),
      transcriptText: segmentText(segments, s => s.source === 'transcript'),
      sourceText: rel.sourceText,
      compatibleText: rel.compatibleText,
      sourceMatch: slimMatch(sm),
      compatibleMatch: slimMatch(cm),
      brandId: (sm && sm.brandId) || (cm && cm.brandId) || null,
      categoryId,
      categoryText: category.term || null,
      categoryMethod: categoryId ? category.method || null : null,
      categoryStrength: categoryId ? category.strength || null : 'none',
      unmappedCategoryText: categoryId ? null : (category.unmappedTerm || category.term || null),
      compatibilityType: rel.compatibilityType,
      polarity: rel.polarity,
      confidence,
      relKey,
      status,
      rejectReason, rejectNote,
      reviewer: status === 'rejected' ? 'system' : null,
      extractedBy: rel.extractedBy || 'rules',
      aiModel: rel.extractedBy === 'ai' ? (ctx.aiModel || null) : null,
      history: [{ at: ctx.now, by: 'system', action: status === 'rejected' ? 'rejected' : 'created',
                  note: status === 'rejected' ? rejectNote : `extracted by ${rel.extractedBy || 'rules'}` }]
    });
    doc.reviewSection = S.reviewSectionFor(doc);
    if (status === 'rejected') stats.systemRejected++;
    stats.relationships++;
    candidates.push(doc);
    evidence.push(evidenceFor(doc, ctx));
  });

  /* AI relationships that failed validation: kept, visibly, as rejected. An
     admin should be able to see what the model tried to claim and why it was
     refused — that is how a bad prompt or a bad model gets noticed. */
  (aiRejected || []).forEach(r => {
    const rel = r.relationship;
    if (!rel) return;
    const candidateId = S.candidateIdFor({
      extractionId: ctx.extractionId, kind: 'relationship',
      sourceText: 'ai:' + rel.sourceModelText, compatibleText: rel.compatibleModelText, polarity: rel.polarity || 'positive'
    });
    const doc = Object.assign(base(), {
      candidateId, kind: 'relationship', sourceMedia: [],
      extractedText: rel.evidenceText, evidenceLines: [rel.evidenceText],
      evidence: { source: 'ai', ref: null, confidence: null },
      captionText: segmentText(segments, s => s.source === 'caption' || s.source === 'manual'),
      ocrText: null, transcriptText: null,
      sourceText: rel.sourceModelText, compatibleText: rel.compatibleModelText,
      sourceMatch: { status: 'unmatched', modelId: null, modelName: null, method: null, strength: 'none', notes: [], alternatives: [], siblings: [] },
      compatibleMatch: { status: 'unmatched', modelId: null, modelName: null, method: null, strength: 'none', notes: [], alternatives: [], siblings: [] },
      brandId: null, categoryId: null, categoryText: rel.categoryText, categoryMethod: null, categoryStrength: 'none',
      unmappedCategoryText: null,
      compatibilityType: S.COMPAT_TYPES.indexOf(rel.compatibilityType) > -1 ? rel.compatibilityType : 'uncertain',
      polarity: S.POLARITIES.indexOf(rel.polarity) > -1 ? rel.polarity : 'positive',
      confidence: { band: 'low', score: 0, factors: {}, reasons: r.reasons },
      relKey: null, status: 'rejected', rejectReason: 'unsupported_by_evidence',
      rejectNote: 'AI output failed validation: ' + r.reasons.join('; '),
      reviewer: 'system', extractedBy: 'ai', aiModel: ctx.aiModel || null,
      history: [{ at: ctx.now, by: 'system', action: 'rejected', note: 'AI output failed validation' }]
    });
    doc.reviewSection = S.reviewSectionFor(doc);
    stats.systemRejected++;
    candidates.push(doc);
  });

  /* References that are in no relationship but could not be matched: an
     admin should see "XYZ 999" was mentioned and is not in the catalogue.
     Hashtags are excluded — "#a15glass" is marketing, not a model name. */
  (references || []).forEach(ref => {
    if (ref.fromHashtag) return;
    if (inRelationships.has(ref.text.toLowerCase())) return;
    const m = ref.match;
    stats.references++;
    if (!m || m.status === 'matched') return;
    const candidateId = S.candidateIdFor({ extractionId: ctx.extractionId, kind: 'model_reference', referenceText: ref.text });
    const doc = Object.assign(base(), {
      candidateId, kind: 'model_reference',
      sourceMedia: ref.ref ? [ref.ref] : [],
      extractedText: String(ref.line || ref.text).slice(0, TEXT_CAP),
      evidenceLines: [String(ref.line || ref.text).slice(0, 500)],
      evidence: { source: ref.source, ref: ref.ref || null, confidence: null },
      captionText: segmentText(segments, s => s.source === 'caption' || s.source === 'manual'),
      ocrText: null, transcriptText: null,
      referenceText: ref.text,
      referenceMatch: slimMatch(m),
      sourceText: null, compatibleText: null, sourceMatch: null, compatibleMatch: null,
      brandId: m.brandId || null, categoryId: null, categoryText: null,
      compatibilityType: null, polarity: null,
      confidence: { band: 'low', score: 0, factors: {}, reasons: [m.status === 'ambiguous' ? 'more than one catalogue record fits' : 'no catalogue record matches'] },
      relKey: null, status: 'pending', extractedBy: 'rules',
      history: [{ at: ctx.now, by: 'system', action: 'created', note: 'unmatched model reference' }]
    });
    doc.reviewSection = S.reviewSectionFor(doc);
    candidates.push(doc);
  });

  return { candidates, evidence, stats };
}

function evidenceFor(doc, ctx) {
  return {
    evidenceId: doc.candidateId,
    candidateId: doc.candidateId,
    relKey: doc.relKey,
    polarity: doc.polarity,
    compatibilityType: doc.compatibilityType,
    categoryId: doc.categoryId,
    sourceKey: doc.sourceKey,
    sourceUsername: doc.sourceUsername,
    contentKey: doc.contentKey,
    contentVersion: doc.contentVersion,
    permalink: doc.sourcePost.permalink,
    evidenceText: doc.extractedText,
    evidenceSource: doc.evidence.source,
    evidenceRef: doc.evidence.ref,
    evidenceConfidence: doc.evidence.confidence,
    sourceModelId: doc.sourceMatch && doc.sourceMatch.modelId,
    compatibleModelId: doc.compatibleMatch && doc.compatibleMatch.modelId,
    createdAt: ctx.now
  };
}

module.exports = { buildCandidates, slimMatch };
