/* ============================================================================
   /api/firebase-config · /api/plans · /api/health
   ----------------------------------------------------------------------------
   Three public GETs behind one serverless function.

   ----------------------------------------------------------------------------
   WHY

   Vercel's Hobby plan allows 12 Serverless Functions per deployment and the
   project was at exactly 12. Adding the entitlement route meant freeing a slot,
   and these three were the right ones to take: no authentication, no writes,
   no money, and between them about seventy lines of logic.

   The URLs do not change. vercel.json rewrites each one to this file with a
   `section` parameter, exactly as it does for the admin API, so
   /api/firebase-config is still /api/firebase-config to every browser that has
   ever cached it.

   ----------------------------------------------------------------------------
   THE HANDLERS ARE UNTOUCHED

   Each file under api/_public/ is the same handler it always was. This adds
   no behaviour: it looks up a section and calls it. /api/firebase-config in
   particular is fetched on every page load by every visitor, so it was worth
   being sure that folding it cost one property lookup and nothing else.
   ========================================================================== */
'use strict';

const { json } = require('./_lib/http');

const SECTIONS = {
  'firebase-config': require('./_public/firebase-config'),
  plans: require('./_public/plans'),
  health: require('./_public/health')
};

function sectionFrom(req) {
  const fromQuery = req.query && req.query.section;
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;

  /* Fallback for a direct call — the local dev server routes by path, and a
     rewrite that stops matching should reach the right handler rather than a
     confusing 404. */
  const path = String(req.url || '').split('?')[0].replace(/\/+$/, '');
  const match = /\/api\/([A-Za-z0-9_-]+)$/.exec(path);
  return match ? match[1] : '';
}

module.exports = async function handler(req, res) {
  const name = sectionFrom(req);
  const section = Object.prototype.hasOwnProperty.call(SECTIONS, name) ? SECTIONS[name] : null;
  if (!section) return json(res, 404, { error: 'no such endpoint', section: name || null });
  return section(req, res);
};
