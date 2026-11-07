/* ============================================================================
   Mobile Parts Finder · api/_services/content/promos.js
   ----------------------------------------------------------------------------
   The marketing posters: one of the three posts a day sells the app (on the
   ProGlide account) or the website (on Mobile Parts Finder's), to mobile shop
   owners anywhere. English only; Instagram translates for the reader.

   Every number on them is real. The group a promo is drawn with is a real
   compatibility group (the scheduler hands it the biggest one), so "1 glass,
   38 phones" is that group's own count, and the model names are its own.
   The catalogue's size is the search index's.

   Each template draws everything above the shared footer (designs.footer),
   which carries the account's logo, name, and the comment word the post asks
   for. Add a template here and the scheduler picks it up on its own.
   ========================================================================== */
'use strict';

const d = require('./draw');
const designs = require('./designs');
const { W, line, fit, wrap, clip, width, image, gradient, tint, asset } = d;
const { M, FOOT, rect, shadow, icon, partIcon, mark, disc } = designs.kit;

const TOP = d.H - FOOT; /* where the footer starts */
const ALL_PARTS = ['Tempered glass', 'Back cover', 'Combo display', 'Middle frame', 'CC board', 'Battery', 'Button flex', 'SIM tray'];

/* the way in, said the account's way: the app for ProGlide, the website for MPF */
const where = ctx => (ctx.brand.play ? 'in the app' : 'on the website');

/** Model names as chips, centred rows, in their brand's colour. */
function chipCloud(ctx, top, bottom, o = {}) {
  const chipO = { size: o.size || 23, weight: 700, fill: ctx.pal.ink };
  const h = (o.size || 23) + 19;
  const gap = 10;
  const maxW = o.width || W - 2 * M;
  const names = designs.roundRobin(ctx.brands);
  const rows = [];
  let row = [];
  let rw = 0;
  let i = 0;
  for (; i < names.length; i++) {
    const text = clip(names[i].name, 300, chipO);
    const w = width(text, chipO) + 30;
    if (rw && rw + w > maxW) {
      rows.push({ chips: row, w: rw - gap });
      if (top + rows.length * (h + gap) + h > bottom) break;
      row = [];
      rw = 0;
    }
    row.push({ text, w, color: names[i].brand.color });
    rw += w + gap;
  }
  if (row.length && top + rows.length * (h + gap) + h <= bottom) { rows.push({ chips: row, w: rw - gap }); }
  else if (row.length) i -= row.length;
  const shown = rows.reduce((n, r) => n + r.chips.length, 0);
  const cx = o.x != null ? o.x : W / 2;
  let svg = '';
  rows.forEach((r, k) => {
    let x = cx - r.w / 2;
    const y = top + k * (h + gap);
    r.chips.forEach(c => {
      svg += rect(x, y, c.w, h, tint(c.color, 0.9), h / 2, ` stroke="${tint(c.color, 0.5)}" stroke-width="1.5"`) +
        line(x + 15, y + h / 2 + chipO.size * 0.36, c.text, chipO);
      x += c.w + gap;
    });
  });
  return { svg, shown, y: top + rows.length * (h + gap) };
}

/* ------------------------------------------------------------- templates */

/* The two ways in, drawn as they really look: ProGlide's app (white, blue,
   the six part tiles, a group card) and Mobile Parts Finder's website (dark
   teal, the photo cards, the group in mint). Screenshots of both are kept in
   D:\PosterAssets\<account>\app-ui. */
const CATS = [
  ['screen-guards', 'Tempered Glass'], ['back-cover', 'Back Cover'], ['combo-display', 'Combo / Display'],
  ['middle-frame', 'Middle Frame'], ['cc-board', 'CC Board'], ['battery', 'Battery']
];
const APP = { blue: '#3B7BF6', blueSoft: '#EAF1FF', ink: '#1F2430', dim: '#6B7280', line: '#E3E6EC', chip: '#F3F4F6', red: '#E0262F', crown: '#F59E0B' };
const WEB = { bg: '#09130F', top: '#0F3D35', card: '#0F1F1B', edge: '#1F3A34', mint: '#2DD4BF', peach: '#F6B26B', ink: '#E8F3F0', dim: '#93ABA5' };

/** The phone's frame; returns where its screen is. */
function phoneFrame(px, py, pw, ph, glass) {
  return shadow(px, py, pw, ph, 64, '#000000') + rect(px, py, pw, ph, '#101018', 64) + rect(px + 14, py + 14, pw - 28, ph - 28, glass, 52);
}

/** ProGlide's app: search, the part tiles, and the group card the search finds. */
function appScreen(ctx, sx, sy, sw, bottom) {
  let s = '';
  s += disc(ctx, sx + 26, sy + 30, 24, APP.blueSoft) +
    line(sx + 62, sy + 26, ctx.brand.name, { size: 22, font: 'archivo', fill: APP.ink }) +
    line(sx + 62, sy + 50, 'Compatible Device Finder', { size: 16, weight: 700, fill: APP.dim });
  /* the search box, the master typed in */
  const by = sy + 76;
  const typed = clip(ctx.master, sw - 90, { size: 24, weight: 700 });
  s += rect(sx, by, sw, 58, '#FFFFFF', 29, ` stroke="${APP.blue}" stroke-width="3"`) + icon('search', sx + 18, by + 16, 26, APP.blue) +
    line(sx + 56, by + 38, typed, { size: 24, weight: 700, fill: APP.ink }) +
    rect(sx + 60 + width(typed, { size: 24, weight: 700 }), by + 14, 3, 30, APP.blue);
  /* the six part tiles, this poster's part chosen */
  const tw = (sw - 16) / 3, th = 54;
  CATS.forEach(([id, name], i) => {
    const x = sx + (i % 3) * (tw + 8), y = by + 76 + Math.floor(i / 3) * (th + 8);
    const on = id === ctx.category;
    s += rect(x, y, tw, th, on ? APP.blueSoft : '#FFFFFF', 16, ` stroke="${on ? APP.blue : APP.line}" stroke-width="${on ? 3 : 1.5}"`) +
      partIcon(id, x + 10, y + 15, 24, on ? APP.blue : APP.ink) +
      line(x + 40, y + 35, name, fit(name, tw - 48, { size: 17, weight: 700, fill: on ? APP.blue : APP.ink }));
  });
  /* the group card */
  const cy = by + 76 + 2 * (th + 8) + 14;
  const ch = bottom - cy + 40;
  s += rect(sx, cy, sw, ch, '#FFFFFF', 22, ` stroke="${APP.line}" stroke-width="2"`);
  if (ctx.inches) {
    const t = ctx.inches + '"';
    s += `<path d="M${sx + sw - 96} ${cy}h74a22 22 0 0 1 22 22v38h-60a36 36 0 0 1-36-36z" fill="${APP.red}"/>` +
      line(sx + sw - 50, cy + 40, t, { size: 21, weight: 900, fill: '#FFFFFF', anchor: 'middle' });
  }
  s += `<circle cx="${sx + 20}" cy="${cy + 30}" r="5" fill="${APP.blue}"/>` + line(sx + 32, cy + 37, ctx.category === 'screen-guards' ? 'Flat Screen' : 'Group', { size: 17, weight: 700, fill: APP.blue });
  const imgW = 150;
  if (ctx.phone) {
    const k = Math.min(imgW / ctx.phone.w, 210 / ctx.phone.h);
    s += image(ctx.phone.uri, sx + 14 + (imgW - ctx.phone.w * k) / 2, cy + 56, ctx.phone.w * k, ctx.phone.h * k);
  } else {
    s += image(ctx.cutout, sx + 14, cy + 56, imgW, 200);
  }
  const lx = sx + imgW + 28, lw = sw - imgW - 44;
  s += rect(lx, cy + 16, 34, 34, '#FEF3C7', 9) + `<path d="M${lx + 7} ${cy + 41}l3-15 7 7 7-7 3 15z" fill="${APP.crown}"/>` +
    line(lx + 44, cy + 42, ctx.master, fit(ctx.master, lw - 100, { size: 25, weight: 900, fill: APP.ink }));
  const names = designs.roundRobin(ctx.brands).filter(m => m.name !== ctx.master);
  const rows = Math.max(1, Math.floor((bottom - (cy + 64) - 50) / 48));
  names.slice(0, rows).forEach((m, i) => {
    const y = cy + 64 + i * 48;
    s += rect(lx, y, lw, 40, APP.chip, 12, ` stroke="${APP.line}" stroke-width="1.5"`) +
      rect(lx + 8, y + 8, 14, 24, m.brand.color, 4) +
      line(lx + 32, y + 28, clip(m.name, lw - 44, { size: 19, weight: 700 }), { size: 19, weight: 700, fill: APP.ink });
  });
  const left = ctx.n - 1 - Math.min(rows, names.length);
  if (left > 0) {
    const y = cy + 64 + Math.min(rows, names.length) * 48;
    s += rect(lx, y, lw, 40, APP.blueSoft, 12, ` stroke="${APP.blue}" stroke-width="1.5"`) +
      line(lx + lw / 2, y + 27, '+' + left + ' more', { size: 19, weight: 900, fill: APP.blue, anchor: 'middle' });
  }
  return s;
}

/** Mobile Parts Finder's website: the question, the search, the part photos, the group. */
function webScreen(ctx, sx, sy, sw, bottom, px, pw) {
  const [hd, hf] = gradient([WEB.top, WEB.bg], 0, sy - 30, 0, sy + 330);
  let s = hd + rect(px + 14, sy - 30, pw - 28, 360, hf, 0);
  s += disc(ctx, sx + 24, sy + 24, 22, WEB.mint) +
    line(sx + 58, sy + 32, 'Mobile Parts', { size: 22, font: 'archivo', fill: '#FFFFFF' }) +
    line(sx + 58 + width('Mobile Parts ', { size: 22, font: 'archivo' }), sy + 32, 'Finder', { size: 22, font: 'archivo', fill: WEB.mint });
  s += line(sx, sy + 98, 'Which parts fit', { size: 36, font: 'archivo', fill: '#FFFFFF' }) +
    line(sx, sy + 140, 'this phone?', { size: 36, font: 'archivo', fill: WEB.peach });
  const by = sy + 166;
  const typed = clip(ctx.master, sw - 80, { size: 22, weight: 700 });
  s += rect(sx, by, sw, 56, WEB.card, 18, ` stroke="${WEB.mint}" stroke-width="2"`) + icon('search', sx + 16, by + 15, 26, WEB.mint) +
    line(sx + 54, by + 36, typed, { size: 22, weight: 700, fill: WEB.ink }) + rect(sx + 58 + width(typed, { size: 22, weight: 700 }), by + 13, 3, 30, WEB.mint);
  /* the part photos, this poster's part first and chosen */
  const order = [ctx.category].concat(CATS.map(c => c[0]).filter(c => c !== ctx.category)).slice(0, 3);
  const cw = (sw - 20) / 3;
  order.forEach((id, i) => {
    const x = sx + i * (cw + 10), y = by + 74;
    s += rect(x, y, cw, 110, '#FFFFFF', 16, i === 0 ? ` stroke="${WEB.mint}" stroke-width="4"` : '') +
      image(require('./draw').asset(require('path').join(__dirname, '..', '..', '..', 'assets', 'categories', 'cutout', id + '.png')), x + 10, y + 8, cw - 20, 94);
  });
  /* the group, as the site lists it */
  const gy = by + 202;
  s += rect(sx, gy, sw, bottom - gy + 40, WEB.card, 18, ` stroke="${WEB.edge}" stroke-width="2"`) +
    line(sx + 18, gy + 40, ctx.master, fit(ctx.master, sw - 170, { size: 25, weight: 900, fill: '#FFFFFF' })) +
    rect(sx + sw - 140, gy + 16, 124, 32, 'none', 16, ` stroke="${WEB.mint}" stroke-width="2"`) +
    line(sx + sw - 78, gy + 38, 'MASTER', { size: 16, font: 'archivo', fill: WEB.mint, anchor: 'middle' }) +
    line(sx + 18, gy + 72, `${ctx.part.word[0].toUpperCase() + ctx.part.word.slice(1)} · fits ${ctx.n} phones`, fit(`${ctx.part.word} · fits ${ctx.n} phones`, sw - 36, { size: 20, weight: 700, fill: WEB.mint }));
  const chipO = { size: 18, weight: 700, fill: WEB.ink };
  let x = sx + 18, y = gy + 92;
  for (const m of designs.roundRobin(ctx.brands)) {
    const t = clip(m.name, sw - 60, chipO);
    const w = width(t, chipO) + 26;
    if (x + w > sx + sw - 18) { x = sx + 18; y += 44; }
    if (y + 36 > bottom) break;
    s += rect(x, y, w, 36, 'none', 18, ` stroke="${WEB.mint}" stroke-width="1.5" stroke-opacity=".55"`) + line(x + 13, y + 24, t, chipO);
    x += w + 8;
  }
  return s;
}

/** The app's (or site's) search, in a phone: type a model, see what fits. */
function search(ctx) {
  const p = ctx.pal;
  const web = !ctx.brand.play;
  const [bd, bf] = gradient(web ? ['#0B2A25', '#07120F'] : [p.primary, p.primary2], 0, 0, W, TOP);
  let s = bd + rect(0, 0, W, TOP, bf) +
    `<circle cx="${W - 40}" cy="40" r="340" fill="#FFFFFF" opacity=".07"/><circle cx="0" cy="${TOP}" r="300" fill="#FFFFFF" opacity=".06"/>` +
    mark(ctx, M, 30, '#FFFFFF');
  const accent = web ? WEB.mint : p.accent;
  s += line(M, 236, 'FIND MATCHING', fit('FIND MATCHING', W - 2 * M, { size: 124, font: 'anton', fill: '#FFFFFF' })) +
    line(M, 356, 'PARTS IN SECONDS', fit('PARTS IN SECONDS', W - 2 * M, { size: 124, font: 'anton', fill: accent })) +
    line(M, 414, web ? 'Type any phone on the website. See every part that fits.' : 'Type any phone in the app. See every part that fits.',
      fit(web ? 'Type any phone on the website. See every part that fits.' : 'Type any phone in the app. See every part that fits.', W - 2 * M, { size: 32, weight: 700, fill: '#FFFFFF', opacity: 0.92 }));
  const px = 230, pw = 620, py = 452, ph = 860;
  s += phoneFrame(px, py, pw, ph, web ? WEB.bg : '#F7F8FA') + rect(px + pw / 2 - 60, py + 26, 120, 26, '#101018', 13);
  const sx = px + 38, sw = pw - 76, sy = py + 66;
  s += web ? webScreen(ctx, sx, sy, sw, TOP - 10, px, pw) : appScreen(ctx, sx, sy, sw, TOP - 10);
  /* a few of the phones it found, either side */
  const names = designs.roundRobin(ctx.brands).slice(0, 6);
  const chipO = { size: 21, weight: 900, fill: '#FFFFFF' };
  names.forEach((m, i) => {
    const leftSide = i % 2 === 0;
    const room = leftSide ? px - 36 - 16 : W - 16 - (px + pw + 20);
    const text = clip(m.name, room - 34, chipO);
    const w = width(text, chipO) + 34;
    const x = leftSide ? px - 16 - w : px + pw + 16;
    const y = 560 + Math.floor(i / 2) * 150 + (leftSide ? 0 : 70);
    s += rect(x, y, w, 46, m.brand.color, 23, ' stroke="#FFFFFF" stroke-width="3"') + line(x + 17, y + 31, text, chipO);
  });
  return s;
}

/** One part, many phones: the group's own count, its models as chips. */
function oneglass(ctx) {
  const p = ctx.pal;
  const unit = ctx.part.unit;
  let s = rect(0, 0, W, TOP, p.bg) + `<circle cx="${W / 2}" cy="430" r="430" fill="${p.soft}"/>` + mark(ctx, M, 30, p.ink);
  const tag = `UNIVERSAL ${ctx.part.en}`;
  const tagO = { size: 26, font: 'archivo', fill: '#FFFFFF', spacing: 1 };
  const tw = width(tag, tagO) + 56;
  s += rect(W / 2 - tw / 2, 120, tw, 56, p.dark, 28) + line(W / 2, 158, tag, Object.assign({ anchor: 'middle' }, tagO));

  /* 1 GLASS = 38 PHONES */
  const big = { size: 300, font: 'anton' };
  const n = String(ctx.n);
  const oneW = width('1', big), nW = width(n, big);
  const eqW = 110;
  const total = oneW + eqW + nW + 120;
  const x0 = W / 2 - total / 2;
  const [nd, nf] = gradient([p.primary, p.primary2], x0 + oneW + eqW + 60, 0, x0 + total, 0);
  s += line(x0 + oneW / 2 + 30, 500, '1', Object.assign({ fill: p.hot, anchor: 'middle' }, big)) +
    line(x0 + oneW / 2 + 30, 556, unit, fit(unit, 260, { size: 44, font: 'archivo', fill: p.ink, anchor: 'middle' })) +
    rect(x0 + oneW + 60, 330, eqW - 30, 26, p.ink, 13) + rect(x0 + oneW + 60, 390, eqW - 30, 26, p.ink, 13) +
    nd + line(x0 + oneW + eqW + 60 + nW / 2, 500, n, Object.assign({ fill: nf, anchor: 'middle' }, big)) +
    line(x0 + oneW + eqW + 60 + nW / 2, 556, 'PHONES', { size: 44, font: 'archivo', fill: p.ink, anchor: 'middle' });

  const head = 'Stock one. Fit many. Sell more.';
  s += line(W / 2, 640, head, fit(head, W - 2 * M, { size: 46, font: 'archivo', fill: p.ink, anchor: 'middle' }));
  const cloud = chipCloud(ctx, 680, 1010);
  s += cloud.svg;
  const left = ctx.n - cloud.shown;
  const tail = left > 0 ? `+ ${left} more, every one ${where(ctx)}` : `Find universal ${ctx.part.word} for any phone`;
  return s + line(W / 2, TOP - 34, tail, fit(tail, W - 2 * M, { size: 34, font: 'archivo', fill: p.primary, anchor: 'middle' }));
}

/** Stop ordering the wrong part: every part the finder knows, checked. */
function wrongpart(ctx) {
  const p = ctx.pal;
  let s = rect(0, 0, W, TOP, p.dark) + `<circle cx="${W}" cy="0" r="420" fill="${p.primary}" opacity=".55"/>` +
    `<circle cx="0" cy="${TOP}" r="260" fill="${p.primary2}" opacity=".35"/>` + mark(ctx, M, 30, '#FFFFFF');
  s += line(M, 300, 'STOP', { size: 210, font: 'anton', fill: p.accent }) +
    line(M + 10 + width('STOP', { size: 210, font: 'anton' }) + 24, 196, 'ORDERING', { size: 84, font: 'anton', fill: '#FFFFFF' }) +
    line(M + 10 + width('STOP', { size: 210, font: 'anton' }) + 24, 296, 'THE WRONG', { size: 84, font: 'anton', fill: '#FFFFFF' }) +
    line(M, 420, 'SPARE PART', fit('SPARE PART', W - 2 * M, { size: 136, font: 'anton', fill: '#FFFFFF' }));
  const sub = 'Check what fits before you buy. Every part, every model, one search.';
  wrap(sub, W - 2 * M, { size: 32, weight: 700 }).slice(0, 2).forEach((t, i) => {
    s += line(M, 486 + i * 42, t, { size: 32, weight: 700, fill: '#FFFFFF', opacity: 0.88 });
  });

  const colW = (W - 2 * M - 20) / 2;
  ALL_PARTS.forEach((name, i) => {
    const x = M + (i % 2) * (colW + 20);
    const y = 600 + Math.floor(i / 2) * 112;
    const mine = name.toUpperCase() === ctx.part.en;
    s += rect(x, y, colW, 92, mine ? p.accent : '#FFFFFF', 22, mine ? '' : ' opacity=".96"') +
      `<circle cx="${x + 48}" cy="${y + 46}" r="26" fill="${mine ? p.dark : p.primary}"/>` + icon('check', x + 34, y + 32, 28, '#FFFFFF') +
      line(x + 92, y + 56, name, fit(name, colW - 110, { size: 32, font: 'archivo', fill: p.ink }));
  });
  const tail = `${ctx.part.en === 'TEMPERED GLASS' ? 'Tempered glass' : ctx.part.word[0].toUpperCase() + ctx.part.word.slice(1)} for ${ctx.master} fits ${ctx.n} phones`;
  return s + line(W / 2, TOP - 34, tail, fit(tail, W - 2 * M, { size: 32, font: 'archivo', fill: p.accent, anchor: 'middle' }));
}

/** How a shop finds the right part: three steps. */
function steps(ctx) {
  const p = ctx.pal;
  const [bd, bf] = gradient(['#FFFFFF', p.soft], 0, 0, 0, TOP);
  let s = bd + rect(0, 0, W, TOP, bf) + `<circle cx="${W - 80}" cy="190" r="240" fill="${tint(p.primary, 0.82)}"/>` +
    mark(ctx, M, 30, p.ink, 'FOR MOBILE SHOP OWNERS', p.dim);
  const [td, tf] = gradient([p.primary, p.primary2], M, 0, M + 760, 0);
  s += line(M, 230, '3 STEPS TO THE', { size: 62, font: 'archivo', fill: p.ink }) +
    td + line(M, 380, 'RIGHT PART', fit('RIGHT PART', W - 2 * M, { size: 168, font: 'anton', fill: tf }));
  const list = [
    ['search', 'Type the phone model', `e.g. ${ctx.master}`],
    ['target', 'See every part that fits', `${ctx.part.en === 'TEMPERED GLASS' ? 'Tempered glass' : ctx.part.word}: ${ctx.n} matching phones`],
    ['check', 'Sell the right one, first time', 'No wrong orders. No returns.']
  ];
  list.forEach(([ic, title, sub], i) => {
    const y = 420 + i * 214;
    const [cd, cf] = gradient([p.primary, p.primary2], M, y, M + 150, y + 150);
    s += shadow(M, y, W - 2 * M, 190, 30) + rect(M, y, W - 2 * M, 190, '#FFFFFF', 30) +
      cd + rect(M + 24, y + 25, 150, 150, cf, 28) +
      line(M + 99, y + 145, String(i + 1), { size: 120, font: 'anton', fill: '#FFFFFF', anchor: 'middle' }) +
      line(M + 206, y + 92, title, fit(title, W - 2 * M - 330, { size: 42, font: 'archivo', fill: p.ink })) +
      line(M + 206, y + 140, clip(sub, W - 2 * M - 330, { size: 27, weight: 700 }), { size: 27, weight: 700, fill: p.dim }) +
      `<circle cx="${W - M - 80}" cy="${y + 95}" r="48" fill="${tint(p.primary, 0.86)}"/>` + icon(ic, W - M - 106, y + 74, 52, p.primary);
  });
  return s;
}

/** The finder in numbers, every one of them counted. */
function numbers(ctx) {
  const p = ctx.pal;
  const [bd, bf] = gradient([p.primary2, p.primary], 0, 0, W, TOP);
  let s = bd + rect(0, 0, W, TOP, bf) + `<circle cx="${W}" cy="${TOP}" r="420" fill="#FFFFFF" opacity=".07"/>` + mark(ctx, M, 30, '#FFFFFF');
  const head = ctx.brand.play ? 'THE PARTS FINDER APP' : 'THE PARTS FINDER WEBSITE';
  s += line(M, 210, head, fit(head, W - 2 * M, { size: 64, font: 'archivo', fill: '#FFFFFF' })) +
    line(M, 330, 'FOR MOBILE SHOPS', fit('FOR MOBILE SHOPS', W - 2 * M, { size: 130, font: 'anton', fill: p.accent }));
  const models = ctx.models >= 100 ? Math.floor(ctx.models / 100) * 100 : ctx.models;
  const tiles = [
    [models ? models.toLocaleString('en-US') + '+' : 'ALL', 'phone models to search'],
    ['8', 'part types: glass, cover, display & more'],
    [String(ctx.n), `phones share one ${ctx.part.word}`],
    ctx.brand.play ? ['177', 'countries on Google Play'] : ['FREE', 'to search, from anywhere']
  ];
  const tw = (W - 2 * M - 24) / 2;
  tiles.forEach(([big, label], i) => {
    const x = M + (i % 2) * (tw + 24);
    const y = 400 + Math.floor(i / 2) * 330;
    s += shadow(x, y, tw, 300, 34) + rect(x, y, tw, 300, '#FFFFFF', 34) +
      line(x + 40, y + 170, big, fit(big, tw - 80, { size: 140, font: 'anton', fill: i % 2 ? p.primary2 : p.primary })) +
      wrap(label, tw - 80, { size: 30, weight: 700 }).slice(0, 2).map((t, k) => line(x + 40, y + 222 + k * 38, t, { size: 30, weight: 700, fill: p.ink })).join('');
  });
  const tail = 'Every phone. Every part. One search.';
  return s + line(W / 2, TOP - 34, tail, fit(tail, W - 2 * M, { size: 36, font: 'archivo', fill: '#FFFFFF', anchor: 'middle' }));
}

const TEMPLATES = [
  { id: 'search', name: 'Search in a phone', about: 'The finder\'s search with a real model typed in and the part it finds.', draw: search },
  { id: 'oneglass', name: 'One part, many phones', about: '"1 glass = 38 phones", the group\'s own count and its models.', draw: oneglass },
  { id: 'wrongpart', name: 'Stop the wrong part', about: 'Every part the finder knows, for shops tired of wrong orders.', draw: wrongpart },
  { id: 'steps', name: 'Three steps', about: 'Type the model, see what fits, sell the right one.', draw: steps },
  { id: 'numbers', name: 'In numbers', about: 'Models, part types, one group\'s reach, and where it is used.', draw: numbers }
];

module.exports = { TEMPLATES };
