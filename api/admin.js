/* ============================================================================
   /api/admin/<section>
   ----------------------------------------------------------------------------
   One serverless function for the whole admin API. It reads the section from
   the URL and hands the request to the matching module in api/_admin/.

   ----------------------------------------------------------------------------
   WHY ONE FUNCTION AND NOT EIGHT

   The immediate reason is a hard platform limit: Vercel's Hobby plan allows 12
   Serverless Functions per deployment, and the site already had 11. Eight
   separate admin routes made 19, and the deploy failed at the point where the
   build output is registered — after a completely successful build, which is
   why it looked like a code error and was not one.

       exceeded_serverless_functions_per_deployment
       No more than 12 Serverless Functions can be added to a Deployment
       on the Hobby plan.

   But it is the better shape regardless. The eight sections share every
   dependency — Firebase Admin, the auth gate, the service layer — so as
   separate functions they were eight cold starts, eight copies of the same
   bundle, and eight instances each warming up independently. An admin who
   opens the dashboard and then the user table now pays for one.

   HEADROOM: this leaves the project at exactly 12 of 12. The next new endpoint
   under api/*.js will fail the deploy the same way. Either add it as a section
   here, or move the project to a Pro plan.

   ----------------------------------------------------------------------------
   THE SECTIONS ARE UNCHANGED

   Each file in api/_admin/ is the same handler it always was, still
   `module.exports = async (req, res)`, still calling requireAdmin or
   requirePermission for itself. This file adds no authorisation of its own and
   deliberately makes no decisions — an unknown section is a 404 and that is
   the whole of its logic.

   The underscore on _admin/ keeps those files out of the function namespace:
   vercel.json builds api/*.js, so api/_admin/session.js is a module that gets
   traced into this bundle rather than a route of its own.
   ========================================================================== */
'use strict';

const { json, notAllowed } = require('./_lib/http');

/* Required at module load, not per request, so a warm instance resolves a
   section by map lookup. They all share the same dependency graph, so there is
   nothing to gain by deferring any of them. */
const SECTIONS = {
  session: require('./_admin/session'),
  users: require('./_admin/users'),
  user: require('./_admin/user'),
  metrics: require('./_admin/metrics'),
  'missing-models': require('./_admin/missing-models'),
  admins: require('./_admin/admins'),
  audit: require('./_admin/audit'),
  ai: require('./_admin/ai')
};

/**
 * Which section was asked for.
 *
 * `section` arrives as a query parameter, put there by the rewrite in
 * vercel.json. The URL path is read as a fallback so the route works when it
 * is reached directly — the local dev server calls this file by path, and a
 * rewrite that stops matching should degrade to the right handler rather than
 * to a confusing 404.
 */
function sectionFrom(req) {
  const fromQuery = req.query && req.query.section;
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;

  const path = String(req.url || '').split('?')[0].replace(/\/+$/, '');
  const match = /\/api\/admin\/([A-Za-z0-9_-]+)$/.exec(path);
  return match ? match[1] : '';
}

module.exports = async function handler(req, res) {
  const name = sectionFrom(req);
  const section = Object.prototype.hasOwnProperty.call(SECTIONS, name) ? SECTIONS[name] : null;

  if (!section) {
    /* 404 rather than 403: this is "no such endpoint", and it is answered
       before any authorisation runs. Nothing about who is asking has been
       established at this point and nothing about the admin area is revealed —
       the section names are in the client bundle already. */
    return json(res, 404, { error: 'no such admin section', section: name || null });
  }

  if (typeof section !== 'function') return notAllowed(res);
  return section(req, res);
};
