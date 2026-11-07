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
const promos = require('./promos');

const CUTOUTS = path.join(__dirname, '..', '..', '..', 'assets', 'categories', 'cutout');
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_MS = 5.5 * 60 * 60 * 1000;

/* English only: the account is read worldwide, and Instagram translates for the reader */
const PARTS = {
  'screen-guards': { en: 'TEMPERED GLASS', word: 'tempered glass', unit: 'GLASS', price: true },
  'back-cover': { en: 'BACK COVER', word: 'back cover', unit: 'COVER' },
  'combo-display': { en: 'COMBO DISPLAY', word: 'display', unit: 'DISPLAY' },
  'middle-frame': { en: 'MIDDLE FRAME', word: 'middle frame', unit: 'FRAME' },
  'cc-board': { en: 'CC BOARD', word: 'CC board', unit: 'BOARD' },
  battery: { en: 'BATTERY', word: 'battery', unit: 'BATTERY' },
  'button-flex': { en: 'BUTTON FLEX', word: 'button flex', unit: 'FLEX' },
  'sim-tray': { en: 'SIM TRAY', word: 'SIM tray', unit: 'TRAY' }
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
 *       part's photo), tag (the label over the master), day, brand (whose
 *       account: 'proglide' when absent, or 'mpf'), keyword (the word the
 *       poster asks for in the comments: LINK, PROGLIDE or TOOL), models (how
 *       many phones the catalogue holds, for the marketing posters)
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
    brand: designs.brandFor(opts.brand),
    pic: opts.picture || null,
    cutout: draw.asset(path.join(CUTOUTS, category + '.png')),
    tag: opts.tag || 'COMPATIBILITY UPDATE',
    oneLine: `One ${part.word} • ${n} phones`,
    keyword: designs.KEYWORDS.indexOf(opts.keyword) > -1 ? opts.keyword : 'LINK',
    models: Number(opts.models) || 0,
    /* the real things, fetched before drawing (phones.js): the master's photo,
       a photo a brand, the store's rating; each may be missing */
    phone: opts.phone || null,
    brandPhones: opts.brandPhones || {},
    play: opts.play || null,
    inches: opts.inches || null,
    cta: designs.CTAS.indexOf(opts.cta) > -1 ? opts.cta : 'bar'
  };
}

const page = (ctx, build) => draw.page(() => designs.framed(ctx, build()) + designs.footer(ctx));

/** One poster. */
function single(group, brandOf, opts) {
  const ctx = context(group, brandOf, opts);
  return page(ctx, () => ctx.design.draw(ctx));
}

/** A marketing poster for the app or the website, its numbers from a real group. */
function promo(group, brandOf, opts) {
  const ctx = context(group, brandOf, opts);
  const t = promos.TEMPLATES.find(x => x.id === (opts && opts.template)) || promos.TEMPLATES[0];
  return page(ctx, () => t.draw(ctx));
}

/**
 * Every other part of one master on one poster: the biggest first and
 * largest, each part its own card of model chips.
 * @param {object[]} groups  the parts, biggest first; the first names the master
 */
function combo(groups, brandOf, opts) {
  const ctxs = groups.map(g => context(g, brandOf, opts));
  const ctx = ctxs[0];
  return page(ctx, () => comboDraw(ctx, ctxs));
}

function comboDraw(ctx, ctxs) {
  const { W: PW } = draw;
  const { M, BOTTOM, rect, shadow, partIcon, mark, chipOf } = designs.kit;
  const { line, fit, width, clip, image, gradient, tint } = draw;
  const p = ctx.pal;
  let s = rect(0, 0, PW, draw.H, p.bg) + `<circle cx="${PW - 60}" cy="120" r="330" fill="${p.soft}"/>` + mark(ctx, M, 30, p.ink);
  const tag = 'ONE PHONE  •  EVERY PART';
  const tagO = { size: 24, font: 'archivo', fill: '#FFFFFF', spacing: 1 };
  const tw = width(tag, tagO) + 48;
  const [td, tf] = gradient([p.hot, p.primary], M, 0, M + tw, 0);
  s += td + rect(M, 116, tw, 52, tf, 26) + line(M + 24, 152, tag, tagO);
  const colW = 640;
  s += line(M, 246, ctx.master, fit(ctx.master, colW, { size: 72, font: 'archivo', fill: p.ink }));
  const [hd, hf] = gradient([p.primary, p.primary2], M, 0, M + colW, 0);
  s += hd + line(M, 334, 'COMPATIBLE PARTS', fit('COMPATIBLE PARTS', colW, { size: 86, font: 'anton', fill: hf }));
  const sub = `${ctxs.length} parts of the ${ctx.master} and every phone that takes each one.`;
  s += line(M, 380, sub, fit(sub, colW, { size: 24, weight: 700, fill: p.dim }));
  /* the master's phone, beside the title */
  s += shadow(736, 96, 288, 300, 30) + rect(736, 96, 288, 300, '#FFFFFF', 30);
  if (ctx.phone) {
    const k = Math.min(250 / ctx.phone.w, 270 / ctx.phone.h);
    s += image(ctx.phone.uri, 736 + (288 - ctx.phone.w * k) / 2, 96 + (300 - ctx.phone.h * k) / 2, ctx.phone.w * k, ctx.phone.h * k);
  } else {
    s += image(ctx.cutout, 756, 116, 248, 260);
  }

  /* the parts, each a card; the biggest gets the most room */
  const top = 420, bottom = BOTTOM - 6, gap = 14;
  const weights = ctxs.map((c, i) => Math.sqrt(c.n) * (i === 0 ? 1.25 : 1));
  const sum = weights.reduce((a, b) => a + b, 0);
  const room = bottom - top - gap * (ctxs.length - 1);
  let y = top;
  ctxs.forEach((c, i) => {
    const h = Math.max(118, Math.floor(room * weights[i] / sum));
    const hh = Math.min(h, bottom - y);
    if (hh < 100) return;
    const first = i === 0;
    const [cd, cf] = gradient([p.primary, p.primary2], M, 0, PW - M, 0);
    s += rect(M, y, PW - 2 * M, hh, '#FFFFFF', 24, ` stroke="${tint(p.primary, 0.75)}" stroke-width="2"`) +
      (first ? cd + `<path d="M${M} ${y + 24}a24 24 0 0 1 24-24h${PW - 2 * M - 48}a24 24 0 0 1 24 24v30h-${PW - 2 * M}z" fill="${cf}"/>`
        : `<path d="M${M} ${y + 24}a24 24 0 0 1 24-24h${PW - 2 * M - 48}a24 24 0 0 1 24 24v30h-${PW - 2 * M}z" fill="${tint(p.primary, 0.86)}"/>`) +
      partIcon(c.category, M + 16, y + 11, 32, first ? '#FFFFFF' : p.primary) +
      line(M + 58, y + 39, c.part.en, fit(c.part.en, 520, { size: 28, font: 'archivo', fill: first ? '#FFFFFF' : p.ink })) +
      line(PW - M - 20, y + 39, `fits ${c.n} phones`, { size: 24, weight: 900, fill: first ? p.accent : p.primary, anchor: 'end' });
    /* the models as chips, in their brand's colour */
    const chipO = { size: 20, weight: 700, fill: p.ink };
    const names = designs.roundRobin(c.brands);
    let x = M + 16, cy = y + 66, shown = 0;
    for (const m of names) {
      const t = clip(m.name, 300, chipO);
      const w = width(t, chipO) + 26;
      const end = y + hh - 8;
      if (x + w > PW - M - 16) {
        if (cy + 42 + 36 > end) break;
        x = M + 16; cy += 42;
      }
      /* on the last row, keep room for the +N more pill */
      const lastRow = cy + 42 + 36 > end;
      if (lastRow && shown < names.length - 1 && x + w + 8 + 130 > PW - M - 16) break;
      s += rect(x, cy, w, 34, tint(m.brand.color, 0.9), 17, ` stroke="${tint(m.brand.color, 0.5)}" stroke-width="1.5"`) + line(x + 13, cy + 24, t, chipO);
      x += w + 8;
      shown++;
    }
    if (shown < names.length) {
      const t = '+' + (names.length - shown) + ' more';
      const w = width(t, { size: 20, weight: 900 }) + 26;
      const mx = Math.min(x, PW - M - 16 - w);
      s += rect(mx, cy, w, 34, p.primary, 17) + line(mx + 13, cy + 24, t, { size: 20, weight: 900, fill: '#FFFFFF' });
    }
    y += hh + gap;
  });
  return s;
}

/**
 * A carousel: the poster as its cover, list pages until every model is shown,
 * and a last page for the app; ten slides at most, as Instagram allows.
 */
function carousel(group, brandOf, opts, also) {
  const ctx = context(group, brandOf, opts);
  const extra = (also || []).slice(0, 5);
  const slides = [page(ctx, () => ctx.design.draw(ctx))];
  let at = { brand: 0, model: 0 };
  let shown = 0;
  /* the master's other parts, one slide each, follow the list pages */
  while (at.brand < ctx.brands.length && slides.length < 9 - extra.length) {
    let next = at;
    let drawn = 0;
    slides.push(draw.page(() => {
      const r = designs.listPage(ctx, at);
      next = r.next;
      drawn = r.drawn;
      return designs.framed(ctx, r.svg) + designs.footer(ctx);
    }));
    if (!drawn) { slides.pop(); break; }
    shown += drawn;
    at = next;
  }
  extra.forEach(g => {
    const c = context(g, brandOf, Object.assign({}, opts, { design: 'update' }));
    slides.push(page(c, () => c.design.draw(c)));
  });
  slides.push(draw.page(() => designs.appPage(ctx, ctx.n - shown)));
  return slides;
}

module.exports = {
  PARTS, categoryOf, dayNumber, single, carousel, promo, combo,
  PROMOS: promos.TEMPLATES.map(x => ({ id: x.id, name: x.name, about: x.about })),
  KEYWORDS: designs.KEYWORDS,
  DESIGNS: designs.DESIGNS.map(x => ({ id: x.id, name: x.name })),
  PALETTES: designs.PALETTES.map(p => ({ id: p.id, name: p.name, color: p.primary })),
  BRANDS: Object.keys(designs.BRANDS),
  planFor: designs.planFor,
  ready: draw.ready, toJpeg: draw.toJpeg, W: draw.W, H: draw.H
};
