/* ============================================================================
   Mobile Parts Finder · api/_services/content/poster.js
   ----------------------------------------------------------------------------
   Instagram posters for @proglide_9h_screenguard, drawn from a compatibility
   group: one part, and every phone it fits.

   The account's best posts by far were dense "universal list" charts: one part,
   its picture, and the models it fits, brand by brand. Shop owners save them
   as a reference and pass them on. So every poster here is that chart, in one
   of six designs and three colours (designs.js), with the same footer: the
   ProGlide logo and name, Google's Play badge, and "Comment LINK".

   A single poster is one 4:5 picture. A carousel is the same poster as its
   cover, as many list pages as the group needs, and a last page for the app.

   The words on a poster are always the catalogue's own, drawn here. A picture
   model may make the part's photo (picture-ai.js); it never writes a model
   name, because a misspelt name on a compatibility chart is a wrong purchase.
   ========================================================================== */
'use strict';

const path = require('path');
const draw = require('./draw');
const designs = require('./designs');

const CUTOUTS = path.join(__dirname, '..', '..', '..', 'assets', 'categories', 'cutout');
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_MS = 5.5 * 60 * 60 * 1000;

const PARTS = {
  'screen-guards': { en: 'TEMPERED GLASS', word: 'tempered glass', unit: 'GLASS', ta: 'டெம்பர் கிளாஸ்', price: true },
  'back-cover': { en: 'BACK COVER', word: 'back cover', unit: 'COVER', ta: 'பேக் கவர்' },
  'combo-display': { en: 'COMBO DISPLAY', word: 'display', unit: 'DISPLAY', ta: 'காம்போ டிஸ்ப்ளே' },
  'middle-frame': { en: 'MIDDLE FRAME', word: 'middle frame', unit: 'FRAME', ta: 'மிடில் ஃப்ரேம்' },
  'cc-board': { en: 'CC BOARD', word: 'CC board', unit: 'BOARD', ta: 'சிசி போர்டு' },
  battery: { en: 'BATTERY', word: 'battery', unit: 'BATTERY', ta: 'பேட்டரி' },
  'button-flex': { en: 'BUTTON FLEX', word: 'button flex', unit: 'FLEX', ta: 'பட்டன் ஃப்ளெக்ஸ்' },
  'sim-tray': { en: 'SIM TRAY', word: 'SIM tray', unit: 'TRAY', ta: 'சிம் ட்ரே' }
};
const PREFIX = { sg: 'screen-guards', bc: 'back-cover', cd: 'combo-display', mf: 'middle-frame', cc: 'cc-board', bt: 'battery', bf: 'button-flex', st: 'sim-tray' };
const categoryOf = groupId => PREFIX[String(groupId || '').split('-')[0]] || null;

/** A running day number in India, for the daily design and colour. */
const dayNumber = now => Math.floor((now + IST_MS) / DAY_MS);

/** Members grouped by brand, biggest brand first, each with its colour. */
function byBrand(group, brandOf) {
  const brands = new Map();
  group.members.forEach(m => {
    const b = brandOf(m) || m.name.split(' ')[0];
    if (!brands.has(b)) brands.set(b, []);
    brands.get(b).push(m.name);
  });
  return Array.from(brands.entries()).map(([name, models]) => ({ name, models }))
    .sort((a, b) => b.models.length - a.models.length)
    .map((b, i) => Object.assign(b, { color: designs.brandColor(b.name, i) }));
}

/**
 * Everything a design draws from.
 * opts: design, palette (ids; today's when absent), picture (a data URI of the
 *       part's photo), tag (the label over the master), day
 */
function context(group, brandOf, opts = {}) {
  const category = categoryOf(group.groupId);
  const part = PARTS[category];
  const plan = designs.planFor(opts.day != null ? opts.day : dayNumber(Date.now()));
  const master = group.masterModelName || (group.members[0] || {}).name || '';
  const masterMember = group.members.find(m => m.name === master) || group.members[0];
  const masterBrand = (masterMember && brandOf(masterMember)) || master.split(' ')[0];
  const masterShort = master.toLowerCase().indexOf(masterBrand.toLowerCase() + ' ') === 0 ? master.slice(masterBrand.length + 1) : master;
  const n = group.members.length;
  return {
    group, category, part, master, masterBrand, masterShort, n,
    brands: byBrand(group, brandOf),
    pal: designs.PALETTES.find(p => p.id === opts.palette) || designs.PALETTES.find(p => p.id === plan.palette),
    design: designs.DESIGNS.find(x => x.id === opts.design) || designs.DESIGNS.find(x => x.id === plan.design),
    pic: opts.picture || null,
    cutout: draw.asset(path.join(CUTOUTS, category + '.png')),
    tag: opts.tag || 'COMPATIBILITY UPDATE',
    taLine: `ஒரே ${part.ta} • ${n} மொபைல்களுக்கு!`
  };
}

/** One poster. */
function single(group, brandOf, opts) {
  const ctx = context(group, brandOf, opts);
  return draw.page(() => ctx.design.draw(ctx) + designs.footer(ctx));
}

/**
 * A carousel: the poster as its cover, list pages until every model is shown,
 * and a last page for the app; ten slides at most, as Instagram allows.
 */
function carousel(group, brandOf, opts) {
  const ctx = context(group, brandOf, opts);
  const slides = [draw.page(() => ctx.design.draw(ctx) + designs.footer(ctx))];
  let at = { brand: 0, model: 0 };
  let shown = 0;
  while (at.brand < ctx.brands.length && slides.length < 9) {
    let next = at;
    let drawn = 0;
    slides.push(draw.page(() => {
      const r = designs.listPage(ctx, at);
      next = r.next;
      drawn = r.drawn;
      return r.svg;
    }));
    if (!drawn) { slides.pop(); break; }
    shown += drawn;
    at = next;
  }
  slides.push(draw.page(() => designs.appPage(ctx, ctx.n - shown)));
  return slides;
}

module.exports = {
  PARTS, categoryOf, dayNumber, single, carousel,
  DESIGNS: designs.DESIGNS.map(x => ({ id: x.id, name: x.name })),
  PALETTES: designs.PALETTES.map(p => ({ id: p.id, name: p.name, color: p.primary })),
  planFor: designs.planFor,
  ready: draw.ready, toJpeg: draw.toJpeg, W: draw.W, H: draw.H
};
