/* ============================================================================
   GET /api/admin/content?view=ideas            what is worth a post, by source
   GET /api/admin/content?view=model&id=        a model's groups, one a part
   GET /api/admin/content?view=find&q=          models matching what was typed
   GET /api/admin/content?view=poster&group=&kind=single|carousel&slide=&design=&palette=
                                                one poster picture, as JPEG
   POST /api/admin/content {action:'photo', group}
                                                makes the part's AI photo
   ----------------------------------------------------------------------------
   The owner's page for Instagram posters. A section of the one admin function,
   like every other: the project is at Vercel Hobby's 12-function limit.

   autoreply.manage on every request, the permission of everything else the
   owner does on the Instagram account. Nothing here posts. The one write is
   the AI photo, which costs a Gemini image call, so it runs only when asked.
   ========================================================================== */
'use strict';

const { requirePermission } = require('../_lib/admin-auth');
const { PERMISSIONS } = require('../_schema/roles');
const { ok, bad, json, fail, notAllowed, body } = require('../_lib/http');
const content = require('../_services/content/service');

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') return notAllowed(res);
    const admin = await requirePermission(req, res, PERMISSIONS.AUTO_REPLY_MANAGE);
    if (!admin) return;
    if (req.method === 'POST') {
      const input = body(req);
      if (input.action !== 'photo') return bad(res, 'unknown action');
      const r = await content.makePhoto(String(input.group || ''), admin.uid);
      return r.ok ? ok(res, r) : json(res, r.code === 'missing' ? 404 : 409, { error: r.message, code: r.code });
    }
    const q = req.query || {};
    if (q.view === 'ideas') return ok(res, await content.ideas());
    if (q.view === 'find') return ok(res, { models: content.find(q.q) });
    if (q.view === 'model') {
      const r = typeof q.id === 'string' ? await content.groupsOf(q.id) : null;
      return r ? ok(res, r) : json(res, 404, { error: 'no such model' });
    }
    if (q.view === 'poster') {
      const r = await content.picture(q.group, { kind: q.kind, slide: q.slide, design: q.design, palette: q.palette });
      if (!r) return json(res, 404, { error: 'no such group' });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Slides', String(r.slides));
      res.setHeader('X-Photo', r.photo ? '1' : '0');
      return res.end(r.jpeg);
    }
    return bad(res, 'unknown view');
  } catch (err) {
    return fail(res, err, 'admin-content');
  }
};
