/* ============================================================================
   GET /api/admin/content?view=ideas            what is worth a post, by source
   GET /api/admin/content?view=model&id=        a model's groups, one a part
   GET /api/admin/content?view=find&q=          models matching what was typed
   GET /api/admin/content?view=poster&group=&kind=single|carousel&slide=&design=&palette=&brand=
                                                one poster picture, as JPEG
   POST /api/admin/content {action:'photo', group}
                                                makes the part's AI photo
   GET /api/admin/content?view=accounts         what the publish token reaches
   GET /api/admin/content?view=caption&group=&account=
                                                the default caption for a post
   GET /api/admin/content?view=posts            the last posts made from here
   POST /api/admin/content {action:'publish', account, group, kind, design, palette, caption}
                                                posts the poster to Instagram
   ----------------------------------------------------------------------------
   The owner's page for Instagram posters. A section of the one admin function,
   like every other: the project is at Vercel Hobby's 12-function limit.

   autoreply.manage on every request, the permission of everything else the
   owner does on the Instagram account. Two writes: the AI photo, which costs
   a Gemini image call, and publish, which posts to Instagram for everyone to
   see. Both run only when the owner presses their button.
   ========================================================================== */
'use strict';

const { requirePermission } = require('../_lib/admin-auth');
const { PERMISSIONS } = require('../_schema/roles');
const { ok, bad, json, fail, notAllowed, body } = require('../_lib/http');
const content = require('../_services/content/service');
const publisher = require('../_services/content/publish');

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') return notAllowed(res);
    const admin = await requirePermission(req, res, PERMISSIONS.AUTO_REPLY_MANAGE);
    if (!admin) return;
    if (req.method === 'POST') {
      const input = body(req);
      if (input.action === 'publish') {
        const r = await publisher.publish({
          account: String(input.account || ''), group: String(input.group || ''), kind: input.kind,
          design: input.design || undefined, palette: input.palette || undefined, caption: input.caption, uid: admin.uid,
          check: input.check === true
        });
        return r.ok ? ok(res, r) : json(res, r.code === 'missing' ? 404 : 409, { error: r.message, code: r.code });
      }
      if (input.action !== 'photo') return bad(res, 'unknown action');
      const r = await content.makePhoto(String(input.group || ''), admin.uid);
      return r.ok ? ok(res, r) : json(res, r.code === 'missing' ? 404 : 409, { error: r.message, code: r.code });
    }
    const q = req.query || {};
    if (q.view === 'ideas') return ok(res, await content.ideas());
    if (q.view === 'accounts') return ok(res, await publisher.check());
    if (q.view === 'posts') return ok(res, { posts: await publisher.recent() });
    if (q.view === 'caption') {
      const acct = publisher.ACCOUNTS[q.account];
      const group = acct ? await content.groupOf(q.group) : null;
      return group ? ok(res, { caption: publisher.captionFor(group, content.brandOf, acct.brand) }) : json(res, 404, { error: 'no such group or account' });
    }
    if (q.view === 'find') return ok(res, { models: content.find(q.q) });
    if (q.view === 'model') {
      const r = typeof q.id === 'string' ? await content.groupsOf(q.id) : null;
      return r ? ok(res, r) : json(res, 404, { error: 'no such model' });
    }
    if (q.view === 'poster') {
      const r = await content.picture(q.group, { kind: q.kind, slide: q.slide, design: q.design, palette: q.palette, brand: q.brand });
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
