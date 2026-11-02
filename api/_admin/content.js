/* ============================================================================
   GET /api/admin/content?view=ideas            what is worth a post, by source
   GET /api/admin/content?view=model&id=        a model's groups, one a part
   GET /api/admin/content?view=find&q=          models matching what was typed
   GET /api/admin/content?view=poster&group=&kind=single|carousel&slide=
                                                one poster picture, as JPEG
   ----------------------------------------------------------------------------
   The owner's page for Instagram posters. A section of the one admin function,
   like every other: the project is at Vercel Hobby's 12-function limit.

   autoreply.manage on every request, the permission of everything else the
   owner does on the Instagram account. Read only: nothing here writes or posts.
   ========================================================================== */
'use strict';

const { requirePermission } = require('../_lib/admin-auth');
const { PERMISSIONS } = require('../_schema/roles');
const { ok, bad, json, fail, notAllowed } = require('../_lib/http');
const content = require('../_services/content/service');

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') return notAllowed(res);
    const admin = await requirePermission(req, res, PERMISSIONS.AUTO_REPLY_MANAGE);
    if (!admin) return;
    const q = req.query || {};
    if (q.view === 'ideas') return ok(res, await content.ideas());
    if (q.view === 'find') return ok(res, { models: content.find(q.q) });
    if (q.view === 'model') {
      const r = typeof q.id === 'string' ? await content.groupsOf(q.id) : null;
      return r ? ok(res, r) : json(res, 404, { error: 'no such model' });
    }
    if (q.view === 'poster') {
      const r = await content.picture(q.group, q.kind, q.slide);
      if (!r) return json(res, 404, { error: 'no such group' });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Slides', String(r.slides));
      return res.end(r.jpeg);
    }
    return bad(res, 'unknown view');
  } catch (err) {
    return fail(res, err, 'admin-content');
  }
};
