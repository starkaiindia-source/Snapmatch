/* ============================================================================
   GET /api/poster?g=&k=&s=&d=&p=&b=&e=&sig=
   ----------------------------------------------------------------------------
   One poster picture, as JPEG, for Instagram to fetch while the owner posts.
   Instagram's publishing API takes a picture only by URL, and this project
   has nowhere public to put a file, so the picture is drawn again here.

   Only a URL signed by api/_services/content/publish.js is answered, and only
   until it expires (two hours), so this cannot be used to make the server draw.
   The poster shows nothing the public site does not: a group's model list.
   ========================================================================== */
'use strict';

const { json, fail } = require('../_lib/http');

module.exports = async function poster(req, res) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    const publish = require('../_services/content/publish');
    const want = publish.verify(req.query || {});
    if (!want) return json(res, 403, { error: 'not a valid poster link' });
    const content = require('../_services/content/service');
    const r = await content.picture(want.groupId, want);
    if (!r) return json(res, 404, { error: 'no such group' });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', String(r.jpeg.length));
    /* Instagram may fetch the same slide more than once */
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.end(req.method === 'HEAD' ? undefined : r.jpeg);
  } catch (err) {
    return fail(res, err, 'poster');
  }
};
