/* ============================================================================
   GET /api/admin/content?view=ideas            what is worth a post, by source
   GET /api/admin/content?view=model&id=        a model's groups, one a part
   GET /api/admin/content?view=find&q=          models matching what was typed
   GET /api/admin/content?view=poster&group=&kind=single|carousel|promo&slide=&design=&palette=&brand=&template=&keyword=
                                                one poster picture, as JPEG
   POST /api/admin/content {action:'photo', group}
                                                makes the part's AI photo
   GET /api/admin/content?view=accounts         what the publish token reaches
   GET /api/admin/content?view=caption&group=&account=&kind=&template=&keyword=
                                                the default caption for a post
   GET /api/admin/content?view=posts            the last posts made from here
   POST /api/admin/content {action:'publish', account, group, kind, design, palette, template, keyword, caption}
                                                posts the poster to Instagram

   The schedule (nine posts a day an account, a week at once, content/schedule.js):
   GET /api/admin/content?view=board&account=   the week, its posting hours, and
                                                the groups ready to put in a slot
   GET /api/admin/content?view=insights&account=[&fresh=1]
                                                how each post did, and why
   GET /api/admin/content?view=templates        every design, colour and
                                                marketing template, and the
                                                order of the grid's colours
   POST {action:'plan', account, fresh}         plans the week (fresh: every
                                                waiting slot again, hours read again)
   POST {action:'auto', account, on}            auto posting on or off
   POST {action:'slot', id, op:'skip'|'restore'|'group', group}
                                                the owner's change to a slot
   POST {action:'postSlot', id}                 posts a planned slot now
   ----------------------------------------------------------------------------
   The owner's page for Instagram posters. A section of the one admin function,
   like every other: the project is at Vercel Hobby's 12-function limit.

   autoreply.manage on every request, the permission of everything else the
   owner does on the Instagram account. The writes: the AI photo (a Gemini
   image call), publish and postSlot (each posts to Instagram for everyone to
   see, only when the owner presses their button), auto posting (which lets
   the schedule post on its own), and the plan itself.
   ========================================================================== */
'use strict';

const { requirePermission } = require('../_lib/admin-auth');
const { PERMISSIONS } = require('../_schema/roles');
const { ok, bad, json, fail, notAllowed, body } = require('../_lib/http');
const { db } = require('../_lib/firebase');
const content = require('../_services/content/service');
const publisher = require('../_services/content/publish');
const schedule = require('../_services/content/schedule');
const insights = require('../_services/content/insights');
const poster = require('../_services/content/poster');

const deps = () => schedule.liveDeps();

async function post(req, res, admin) {
  const input = body(req);
  const a = input.action;
  if (a === 'publish') {
    const r = await publisher.publish({
      account: String(input.account || ''), group: String(input.group || ''), kind: input.kind,
      design: input.design || undefined, palette: input.palette || undefined, template: input.template || undefined,
      keyword: input.keyword || undefined, caption: input.caption, uid: admin.uid, check: input.check === true,
      cta: input.cta || undefined, also: Array.isArray(input.also) ? input.also.map(String).slice(0, 5) : undefined
    });
    return r.ok ? ok(res, r) : json(res, r.code === 'missing' ? 404 : 409, { error: r.message, code: r.code });
  }
  if (a === 'photo') {
    const r = await content.makePhoto(String(input.group || ''), admin.uid);
    return r.ok ? ok(res, r) : json(res, r.code === 'missing' ? 404 : 409, { error: r.message, code: r.code });
  }
  if (a === 'plan') return ok(res, await schedule.plan(deps(), String(input.account || ''), Date.now(), { fresh: input.fresh === true }));
  if (a === 'auto') {
    const s = await schedule.setAuto(db, String(input.account || ''), input.on === true, admin.uid, Date.now());
    return s ? ok(res, { auto: s.auto }) : bad(res, 'unknown account');
  }
  if (a === 'slot') {
    const r = await schedule.change(deps(), String(input.id || ''), String(input.op || ''), input.group ? String(input.group) : undefined);
    return r.ok ? ok(res, r) : json(res, 409, { error: r.error });
  }
  if (a === 'postSlot') {
    const r = await schedule.postSlot(deps(), String(input.id || ''), Date.now());
    if (!r) return json(res, 409, { error: 'That slot is not waiting to be posted.' });
    return r.ok ? ok(res, r) : json(res, 409, { error: r.error || 'Not posted.' });
  }
  return bad(res, 'unknown action');
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') return notAllowed(res);
    const admin = await requirePermission(req, res, PERMISSIONS.AUTO_REPLY_MANAGE);
    if (!admin) return;
    if (req.method === 'POST') return post(req, res, admin);

    const q = req.query || {};
    if (q.view === 'ideas') return ok(res, await content.ideas());
    if (q.view === 'accounts') return ok(res, await publisher.check());
    if (q.view === 'posts') return ok(res, { posts: await publisher.recent() });
    if (q.view === 'board') {
      const r = await schedule.board(deps(), String(q.account || ''), Date.now());
      return r ? ok(res, r) : bad(res, 'unknown account');
    }
    if (q.view === 'insights') {
      if (!publisher.token()) return json(res, 409, { error: 'INSTAGRAM_PUBLISH_ACCESS_TOKEN is not set in Vercel.' });
      const r = await insights.read({ graph: publisher.graph, accounts: publisher.ACCOUNTS, db }, String(q.account || ''), Date.now(), q.fresh === '1');
      return r ? ok(res, r) : bad(res, 'unknown account');
    }
    if (q.view === 'templates') {
      const cands = await schedule.candidates(content, Date.now()).catch(() => ({ stat: null }));
      return ok(res, {
        designs: poster.DESIGNS, palettes: poster.PALETTES, promos: poster.PROMOS, keywords: poster.KEYWORDS,
        slots: schedule.SLOTS, sample: cands.stat
      });
    }
    if (q.view === 'caption') {
      const acct = publisher.ACCOUNTS[q.account];
      const group = acct ? await content.groupOf(q.group) : null;
      if (!group) return json(res, 404, { error: 'no such group or account' });
      const keyword = acct.brand === 'proglide' && poster.KEYWORDS.indexOf(q.keyword) > -1 ? q.keyword : undefined;
      return ok(res, { caption: q.kind === 'promo'
        ? publisher.promoCaption(q.template, group, acct.brand, keyword, content.modelCount())
        : publisher.captionFor(group, content.brandOf, acct.brand, keyword) });
    }
    if (q.view === 'find') return ok(res, { models: content.find(q.q) });
    if (q.view === 'model') {
      const r = typeof q.id === 'string' ? await content.groupsOf(q.id) : null;
      return r ? ok(res, r) : json(res, 404, { error: 'no such model' });
    }
    if (q.view === 'poster') {
      const r = await content.picture(q.group, { kind: q.kind, slide: q.slide, design: q.design, palette: q.palette, brand: q.brand, template: q.template, keyword: q.keyword, also: q.also, cta: q.cta });
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
