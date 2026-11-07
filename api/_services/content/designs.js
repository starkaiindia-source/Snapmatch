/* ============================================================================
   Mobile Parts Finder · api/_services/content/designs.js
   ----------------------------------------------------------------------------
   The poster designs, the colours they come in, and the footer they share.

   SIX DESIGNS, after the owner's reference posters

     update      "NEW MODEL UPDATE": the master and the part in big type, the
                 picture beside it, then every brand as a row of model chips
     universal   "UNIVERSAL <PART>" in a dark title box, four brand cards
     splash      a dark poster: the master on a brush stroke, a "compatible
                 with N" sticker, numbered brand cards
     numbered    a clean light page: the master, the part box, a numbered list
     series      "<PART> COMPATIBILITY", four brand cards with the part beside
     checklist   "ONE <PART>. MULTIPLE MODELS." with a ticked list

   THREE COLOURS, ONE A DAY IN TURN

   A design is drawn in one of three colour sets. Posted one a day in turn, the
   same colour always lands in the same column of the profile grid, so the
   page reads as three coloured stripes rather than a jumble. The design
   changes every three posts, so a grid row is one design in three colours.

   THE FOOTER IS THE SAME ON EVERY DESIGN, and names whose account it is for
   (BRANDS): ProGlide's logo, Google's Play badge and "Comment LINK", or
   Mobile Parts Finder's logo and its website. No phone brand's logo is drawn
   anywhere; a phone brand is its name in a colour.
   ========================================================================== */
'use strict';

const d = require('./draw');
const { W, H, line, fit, wrap, clip, width, image, gradient, tint, asset } = d;

const M = 56;
const FOOT = 200;
const BOTTOM = H - FOOT - 16;

const PALETTES = [
  { id: 'royal', name: 'Royal blue', primary: '#5B2EE8', primary2: '#2F7BFF', accent: '#FFC531', hot: '#FF3D6E',
    dark: '#170F4D', bg: '#F4F2FF', soft: '#E6E0FF', ink: '#15123B', dim: '#5B5880' },
  { id: 'sunset', name: 'Sunset orange', primary: '#FF5A1F', primary2: '#FF2E63', accent: '#FFD23F', hot: '#1F6BFF',
    dark: '#3B1010', bg: '#FFF4EC', soft: '#FFE0CF', ink: '#2A1210', dim: '#7B5B52' },
  { id: 'mint', name: 'Mint green', primary: '#0E9F84', primary2: '#0B78A0', accent: '#FFB800', hot: '#FF5A36',
    dark: '#073836', bg: '#EEFAF5', soft: '#D2F1E6', ink: '#0B2B29', dim: '#4E6D69' }
];

/* a brand is its name in its own colour, the same on every poster */
const BRAND_COLORS = {
  vivo: '#3D5AFE', realme: '#C99A00', oppo: '#0E8A4C', samsung: '#1A3DB8', xiaomi: '#F26A00', redmi: '#E8412C', poco: '#B8860B',
  apple: '#3A3A3C', tecno: '#0A6FD6', infinix: '#159947', itel: '#E2231A', motorola: '#4A72E8', oneplus: '#E0002A',
  nothing: '#D71921', iqoo: '#2B50D8', honor: '#2A63D4', huawei: '#C8102E', nokia: '#124191', google: '#4285F4', lava: '#C2185B'
};
const SPARE = ['#7B3FE4', '#00A0B0', '#D9480F', '#2F9E44', '#C2255C', '#1971C2'];
function brandColor(name, i) {
  return BRAND_COLORS[String(name).toLowerCase().split(' ')[0]] || SPARE[i % SPARE.length];
}

/* ------------------------------------------------------------------ icons
   Plain shapes on a 24-unit square, drawn here; none of them is a logo. */
const ICONS = {
  chat: ['fill', 'M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'],
  check: ['stroke', 'M5 12.5l4.5 4.5L19 7.5'],
  search: ['stroke', 'M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13z M15.5 15.5L21 21'],
  bolt: ['fill', 'M13.5 2L4 14h7l-1.5 8L19 10h-7z'],
  target: ['stroke', 'M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18z M12 7.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 1 1 0-9z M12 11a1 1 0 1 1 0 2a1 1 0 1 1 0-2z'],
  box: ['stroke', 'M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z M3 7.5L12 12l9-4.5 M12 12v9'],
  stack: ['stroke', 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6'],
  arrow: ['stroke', 'M4 12h15 M13 6l6 6-6 6']
};
function icon(name, x, y, size, color) {
  const [mode, path] = ICONS[name];
  const k = size / 24;
  return `<g transform="translate(${x} ${y}) scale(${k})"><path d="${path}" ${mode === 'fill' ? `fill="${color}"` :
    `fill="none" stroke="${color}" stroke-width="${(2.4).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"`}/></g>`;
}

const rect = (x, y, w, h, fill, rx, extra) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"${rx ? ` rx="${rx}"` : ''} fill="${fill}"${extra || ''}/>`;
const shadow = (x, y, w, h, rx, color) => rect(x + 6, y + 10, w, h, color || '#000000', rx, ' opacity=".10"');

/* -------------------------------------------------------------- the brands
   Whose account the poster is for. Everything that names an owner is here,
   so a poster for one account never carries the other's name, logo or way in:
   ProGlide sends people to its Play app through "Comment LINK" (the reply bot
   answers it); Mobile Parts Finder sends them to its website. */
const BRANDS = {
  proglide: {
    id: 'proglide', logo: 'proglide.png', name: 'PRO-GLIDE', tagline: 'Compatible Device Finder app', play: true,
    lead: 'Comment LINK',
    rest: part => (part.price ? 'for the app   •   Comment 9H for price' : 'get the ProGlide app link in your DM'),
    chip: 'Comment "LINK"', chipIcon: 'chat',
    more: n => `+ ${n} more models in the ProGlide app`,
    moreLast: (n, part) => `+ ${n} more ${part.word} matches in the app`
  },
  mpf: {
    id: 'mpf', logo: 'mpf.png', name: 'MOBILE PARTS FINDER', tagline: 'Spare parts compatibility for every phone', play: false,
    site: 'www.mobilepartsfinder.com',
    lead: 'Search any phone',
    rest: () => 'free at www.mobilepartsfinder.com',
    chip: 'Search free', chipIcon: 'search',
    more: n => `+ ${n} more models on mobilepartsfinder.com`,
    moreLast: (n, part) => `+ ${n} more ${part.word} matches on the website`
  }
};
const brandFor = id => BRANDS[id] || BRANDS.proglide;

/** The logo and the name, small, at the top of a design. */
function mark(ctx, x, y, color, sub, subColor) {
  const b = ctx.brand;
  return image(asset(b.logo), x, y, 60, 60, { rx: 12 }) +
    line(x + 74, y + 40, b.name, fit(b.name, 520, { size: 30, font: 'archivo', fill: color, spacing: 1 })) +
    (sub ? line(x + 76, y + 70, sub, { size: 17, weight: 700, fill: subColor || color, spacing: 4 }) : '');
}

/** The part: the owner's AI picture when there is one, else the cut-out on white. */
function hero(ctx, x, y, w, h, rx, frame) {
  const back = frame ? rect(x - frame, y - frame, w + 2 * frame, h + 2 * frame, '#FFFFFF', rx + frame) : '';
  if (ctx.pic) return back + image(ctx.pic, x, y, w, h, { rx, fit: 'slice' });
  const pad = Math.round(Math.min(w, h) * 0.08);
  return back + rect(x, y, w, h, '#FFFFFF', rx) + image(ctx.cutout, x + pad, y + pad, w - 2 * pad, h - 2 * pad);
}

/* ----------------------------------------------------------------- footer */
function footer(ctx) {
  const p = ctx.pal;
  const y = H - FOOT;
  const [gd, gf] = gradient([p.primary, p.primary2], 0, 0, W, 0);
  const b = ctx.brand;
  const badgeH = 86;
  const badgeW = Math.round(badgeH * 646 / 250);
  const lead = b.lead;
  const rest = b.rest(ctx.part);
  const leadO = { size: 28, font: 'archivo', fill: '#161616' };
  const restO = { size: 23, weight: 700, fill: '#161616' };
  const total = 40 + width(lead, leadO) + 16 + width(rest, restO);
  const sx = W / 2 - total / 2;
  const nameRoom = W - M - 126 - M - (b.play ? badgeW + 10 : 0);
  return gd + rect(0, y, W, FOOT, gf) +
    rect(M, y + 18, 104, 104, '#FFFFFF', 24) + image(asset(b.logo), M + 7, y + 25, 90, 90) +
    line(M + 126, y + 70, b.name, fit(b.name, nameRoom, { size: 44, font: 'archivo', fill: '#FFFFFF', spacing: 1 })) +
    line(M + 128, y + 106, b.tagline, fit(b.tagline, nameRoom, { size: 23, weight: 700, fill: '#FFFFFF', opacity: 0.9 })) +
    (b.play ? image(asset('google-play-badge.png'), W - M - badgeW + 10, y + 26, badgeW, badgeH) : '') +
    rect(M - 6, y + 136, W - 2 * M + 12, 52, p.accent, 26) +
    icon(b.chipIcon, sx, y + 147, 30, '#161616') +
    line(sx + 40, y + 172, lead, leadO) + line(sx + 40 + width(lead, leadO) + 16, y + 171, rest, restO);
}

/* ------------------------------------------------------------------ lists */
/** Models in turn from each brand, so a short list still shows the range. */
function roundRobin(brands) {
  const out = [];
  for (let i = 0; out.length < brands.reduce((n, b) => n + b.models.length, 0); i++) {
    brands.forEach(b => { if (b.models[i]) out.push({ name: b.models[i], brand: b }); });
  }
  return out;
}

/**
 * Brands as rows of model chips, from a starting point, until the space ends.
 * o.maxLines caps a brand's chip lines (the rest of it is skipped, for a
 * single poster); without it a brand runs on to the next page.
 */
function chipRows(ctx, brands, start, top, bottom, o = {}) {
  const p = ctx.pal;
  const tileW = 176;
  const chipO = { size: 22, weight: 700, fill: p.ink };
  const chipH = 40;
  const gap = 9;
  const areaX = M + tileW + 22;
  const areaW = W - M - areaX - 14;
  let y = top;
  let out = '';
  let drawn = 0;
  let bi = start.brand;
  let mi = start.model;
  while (bi < brands.length) {
    const b = brands[bi];
    const room = bottom - y;
    if (room < chipH + 24) break;
    const maxLines = Math.min(o.maxLines || 99, Math.floor((room - 24 + gap) / (chipH + gap)));
    let cx = 0;
    let lines = 1;
    const chips = [];
    let j = mi;
    for (; j < b.models.length; j++) {
      const name = clip(b.models[j], areaW - 30, chipO);
      const w = width(name, chipO) + 30;
      if (cx && cx + w > areaW) { if (lines >= maxLines) break; lines++; cx = 0; }
      chips.push({ name, x: cx, line: lines - 1, w });
      cx += w + gap;
    }
    const h = Math.max(90, lines * (chipH + gap) - gap + 26);
    const c = b.color;
    out += rect(M, y, W - 2 * M, h, '#FFFFFF', 22) +
      rect(M + 8, y + 8, tileW, h - 16, tint(c, 0.86), 16) +
      line(M + 8 + tileW / 2, y + h / 2 + (h >= 90 ? 4 : 10), b.name, fit(b.name, tileW - 24, { size: 32, font: 'archivo', fill: c, anchor: 'middle' })) +
      (h >= 90 ? line(M + 8 + tileW / 2, y + h / 2 + 34, b.models.length + ' models', { size: 19, weight: 700, fill: p.dim, anchor: 'middle' }) : '') +
      chips.map(ch => {
        const cy = y + 13 + ch.line * (chipH + gap);
        return rect(areaX + ch.x, cy, ch.w, chipH, tint(c, 0.9), 20, ` stroke="${tint(c, 0.55)}" stroke-width="1.5"`) +
          line(areaX + ch.x + 15, cy + 28, ch.name, chipO);
      }).join('');
    drawn += chips.length;
    y += h + 10;
    if (j < b.models.length && !o.maxLines) return { svg: out, next: { brand: bi, model: j }, drawn, y };
    bi++;
    mi = 0;
  }
  return { svg: out, next: { brand: bi, model: mi }, drawn, y };
}

/** A model's full name when it fits, else without its brand ("Galaxy A02"), else cut. */
function fitName(name, brand, maxWidth, o) {
  if (width(name, o) <= maxWidth) return name;
  const b = String(brand).toLowerCase() + ' ';
  const bare = String(name).toLowerCase().indexOf(b) === 0 ? name.slice(b.length) : name;
  return clip(bare, maxWidth, o);
}

const more = (ctx, left, x, y, color, size) => (left > 0
  ? line(x, y, ctx.brand.more(left), { size: size || 28, font: 'archivo', fill: color, anchor: 'middle' }) : '');

/* ---------------------------------------------------------------- designs */
function update(ctx) {
  const p = ctx.pal;
  const colW = 570;
  let s = rect(0, 0, W, H, p.bg) + `<circle cx="${W - 40}" cy="70" r="300" fill="${p.soft}"/>` + mark(ctx, M, 30, p.ink);
  const tagO = { size: 24, font: 'archivo', fill: '#FFFFFF' };
  const tw = width(ctx.tag, tagO) + 48;
  const [td, tf] = gradient([p.hot, p.primary], M, 0, M + tw, 0);
  s += td + rect(M, 116, tw, 52, tf, 26) + line(M + 24, 152, ctx.tag, tagO);
  s += line(M, 244, ctx.master, fit(ctx.master, colW, { size: 66, font: 'archivo', fill: p.ink }));
  const [pd, pf] = gradient([p.primary, p.primary2], M, 0, M + colW, 0);
  s += pd + line(M, 358, ctx.part.en, fit(ctx.part.en, colW, { size: 116, font: 'anton', fill: pf }));
  s += line(M, 420, 'COMPATIBLE MODELS', fit('COMPATIBLE MODELS', colW, { size: 50, font: 'archivo', fill: p.ink }));
  const sub = { size: 24, weight: 400, fill: p.dim };
  wrap(`Same ${ctx.part.word} fits ${ctx.n} phones. Check before you buy and avoid wrong parts.`, colW, sub).slice(0, 2)
    .forEach((t, i) => { s += line(M, 464 + i * 33, t, sub); });
  s += line(M, 548, ctx.taLine, fit(ctx.taLine, colW, { size: 27, fill: p.primary }));
  s += shadow(660, 100, 364, 456, 34) + hero(ctx, 660, 100, 364, 456, 34);

  const by = 584;
  const [bd, bf] = gradient([p.primary, p.primary2], 0, 0, W, 0);
  s += bd + rect(M - 16, by, W - 2 * M + 32, 116, bf, 28) +
    rect(M, by + 14, 88, 88, '#FFFFFF', 18) + image(ctx.cutout, M + 6, by + 20, 76, 76) +
    line(M + 112, by + 72, ctx.master, fit(ctx.master, 400, { size: 48, font: 'archivo', fill: '#FFFFFF' })) +
    rect(M + 530, by + 22, 3, 72, '#FFFFFF', 0, ' opacity=".5"') +
    line(M + 556, by + 52, 'Compatible Models', { size: 30, font: 'archivo', fill: '#FFFFFF' }) +
    line(M + 556, by + 90, `${ctx.n} Models  •  ${ctx.brands.length} Brand${ctx.brands.length === 1 ? '' : 's'}`, { size: 25, weight: 700, fill: p.accent });

  /* fewer brands, more lines each, so a one-brand group fills the space */
  const lines = [0, 8, 4, 3][ctx.brands.length] || 2;
  const rows = chipRows(ctx, ctx.brands, { brand: 0, model: 0 }, by + 134, BOTTOM - 46, { maxLines: lines });
  return s + rows.svg + more(ctx, ctx.n - rows.drawn, W / 2, BOTTOM - 8, p.primary);
}

function universal(ctx) {
  const p = ctx.pal;
  let s = rect(0, 0, W, H, p.bg);
  s += rect(M - 20, 34, W - 2 * M + 40, 312, p.dark, 36) +
    line(W / 2, 200, 'UNIVERSAL', { size: 168, font: 'anton', fill: '#FFFFFF', anchor: 'middle', spacing: 4 }) +
    rect(M + 10, 222, W - 2 * M - 20, 104, tint(p.primary2, 0.72), 24) +
    line(W / 2, 298, ctx.part.en, fit(ctx.part.en, W - 2 * M - 80, { size: 76, font: 'archivo', fill: p.dark, anchor: 'middle' }));
  const info = `Master model: ${ctx.master}   •   ${ctx.n} models`;
  s += line(W / 2, 394, info, fit(info, W - 2 * M, { size: 30, weight: 900, fill: p.ink, anchor: 'middle' }));

  const cards = ctx.brands.slice(0, 4);
  const rows = cards.length > 2 ? 2 : 1;
  const half = (W - 2 * M - 24) / 2;
  const top = 420;
  const ch = (BOTTOM - 44 - top - (rows - 1) * 22) / rows;
  let drawn = 0;
  cards.forEach((b, i) => {
    const x = M + (i % 2) * (half + 24);
    const y = top + Math.floor(i / 2) * (ch + 22);
    const c = b.color;
    const cw = i === cards.length - 1 && i % 2 === 0 ? W - 2 * M : half;
    const rowO = { size: 26, weight: 700, fill: p.ink };
    const fits = Math.max(1, Math.floor((ch - 120) / 39));
    const list = b.models.length > fits ? b.models.slice(0, fits - 1) : b.models;
    drawn += list.length;
    s += rect(x, y, cw, ch, '#FFFFFF', 26, ` stroke="${tint(c, 0.6)}" stroke-width="3"`) +
      `<path d="M${x} ${y + 26}a26 26 0 0 1 26-26h${cw - 52}a26 26 0 0 1 26 26v52h-${cw}z" fill="${c}"/>` +
      line(x + cw / 2, y + 58, b.name.toUpperCase(), fit(b.name.toUpperCase(), cw - 40, { size: 44, font: 'archivo', fill: '#FFFFFF', anchor: 'middle' })) +
      image(ctx.cutout, x + cw - 168, y + 96, 150, ch - 116) +
      list.map((m, k) => line(x + 28, y + 122 + k * 39, fitName(m, b.name, cw - 210, rowO), rowO)).join('') +
      (b.models.length > list.length ? line(x + 28, y + 122 + list.length * 39, `+ ${b.models.length - list.length} more`, { size: 24, font: 'archivo', fill: c }) : '');
  });
  return s + more(ctx, ctx.n - drawn, W / 2, BOTTOM - 8, p.primary);
}

function splash(ctx) {
  const p = ctx.pal;
  const [bd, bf] = gradient([p.dark, '#08070F'], 0, 0, 0, H);
  let s = bd + rect(0, 0, W, H, bf);
  if (ctx.pic) {
    s += `<filter id="soft"><feGaussianBlur stdDeviation="16"/></filter>` +
      `<image href="${ctx.pic}" x="-80" y="-80" width="${W + 160}" height="${H + 160}" preserveAspectRatio="xMidYMid slice" filter="url(#soft)" opacity=".55"/>` +
      rect(0, 0, W, H, p.dark, 0, ' opacity=".55"');
  }
  s += `<polygon points="0,560 ${W},300 ${W},380 0,700" fill="#FFFFFF" opacity=".05"/><polygon points="0,900 ${W},640 ${W},690 0,980" fill="#FFFFFF" opacity=".04"/>`;
  s += mark(ctx, M, 30, '#FFFFFF') +
    line(W - M, 96, 'Smart choice for mobile shops', { size: 40, font: 'script', fill: '#FFFFFF', anchor: 'end', rotate: -5 });

  const nameO = fit(ctx.master, 650, { size: 128, font: 'anton', fill: '#FFFFFF' });
  s += `<polygon points="${M - 24},170 ${M + 700},150 ${M + 716},310 ${M - 10},326" fill="#000000" opacity=".55"/>` +
    line(M, 292, ctx.master, nameO);
  s += `<polygon points="${M - 10},336 ${M + 640},318 ${M + 652},402 ${M - 2},418" fill="${p.accent}"/>` +
    line(M + 24, 394, ctx.part.en, fit(ctx.part.en, 600, { size: 58, font: 'archivo', fill: '#161616', rotate: -1.6 }));
  s += `<polygon points="${M + 40},420 ${M + 470},408 ${M + 476},480 ${M + 46},490" fill="${p.hot}"/>` +
    line(M + 70, 470, 'Master Model', { size: 60, font: 'script', fill: '#FFFFFF', rotate: -1.6 });

  const sx = 780;
  const sy = 182;
  s += `<g transform="rotate(-6 ${sx + 120} ${sy + 150})">` + rect(sx, sy, 250, 300, p.accent, 30) +
    line(sx + 125, sy + 62, 'Compatible with', { size: 40, font: 'script', fill: '#161616', anchor: 'middle' }) +
    line(sx + 125, sy + 222, String(ctx.n), fit(String(ctx.n), 220, { size: 160, font: 'anton', fill: p.hot, anchor: 'middle' })) +
    line(sx + 125, sy + 272, 'Mobile Models', { size: 30, font: 'archivo', fill: '#161616', anchor: 'middle' }) + '</g>';

  s += hero(ctx, M, 530, 392, 452, 30, 6);
  [['target', 'Exact model', 'matching'], ['stack', 'Wide', 'compatibility']].forEach((f, i) => {
    const x = M + i * 210;
    s += `<circle cx="${x + 28}" cy="1050" r="28" fill="#FFFFFF"/>` + icon(f[0], x + 14, 1036, 28, p.primary) +
      line(x + 66, 1044, f[1], { size: 20, weight: 900, fill: '#FFFFFF' }) + line(x + 66, 1070, f[2], { size: 20, weight: 900, fill: '#FFFFFF' });
  });

  const x0 = 480;
  const cw = W - M - x0;
  let y = 530;
  let drawn = 0;
  const rowO = { size: 21, weight: 700, fill: '#1B1B24' };
  for (const b of ctx.brands) {
    const room = BOTTOM - 40 - y;
    const rowsFit = Math.floor((room - 64) / 32);
    if (rowsFit < 1) break;
    const rowsUsed = Math.min(Math.ceil(b.models.length / 2), rowsFit, 4);
    const list = b.models.slice(0, rowsUsed * 2);
    const h = 64 + rowsUsed * 32;
    s += rect(x0, y, cw, h, '#FFFFFF', 18) +
      `<path d="M${x0} ${y + 18}a18 18 0 0 1 18-18h${cw - 36}a18 18 0 0 1 18 18v34h-${cw}z" fill="${b.color}"/>` +
      line(x0 + 20, y + 37, b.name.toUpperCase(), { size: 26, font: 'archivo', fill: '#FFFFFF' }) +
      line(x0 + 30 + width(b.name.toUpperCase(), { size: 26, font: 'archivo' }), y + 36, `(${b.models.length} Models)`, { size: 21, weight: 700, fill: '#FFFFFF', opacity: 0.9 }) +
      `<line x1="${x0 + cw / 2}" y1="${y + 62}" x2="${x0 + cw / 2}" y2="${y + h - 10}" stroke="#E2E2EA" stroke-width="2"/>` +
      list.map((m, k) => line(x0 + 18 + (k % 2) * (cw / 2), y + 82 + Math.floor(k / 2) * 32,
        `${k + 1}. ` + fitName(m, b.name, cw / 2 - 58, rowO), rowO)).join('');
    drawn += list.length;
    y += h + 12;
  }
  return s + more(ctx, ctx.n - drawn, x0 + cw / 2, BOTTOM - 6, p.accent, 24);
}

function numbered(ctx) {
  const p = ctx.pal;
  const [bd, bf] = gradient(['#FFFFFF', p.soft], 0, 0, 0, H);
  let s = bd + rect(0, 0, W, H, bf) + `<circle cx="${W + 60}" cy="560" r="330" fill="${tint(p.primary, 0.9)}"/>`;
  s += mark(ctx, M, 30, p.ink, 'FIND WHAT FITS', p.dim);
  ['MOBILE PARTS', 'MADE EASY FOR', 'REPAIR SHOPS'].forEach((t, i) => {
    s += line(W - M, 50 + i * 24, t, { size: 16, weight: 700, fill: p.dim, anchor: 'end', spacing: 3 });
  });
  s += rect(W - M - 210, 38, 3, 64, p.primary);
  s += shadow(M, 150, 430, 440, 30) + hero(ctx, M, 150, 430, 440, 30);
  const x = 520;
  const cw = W - M - x;
  s += line(x, 222, ctx.masterBrand.toUpperCase(), { size: 34, font: 'archivo', fill: p.primary, spacing: 6 }) +
    line(x, 314, ctx.masterShort.length > 3 ? ctx.masterShort : ctx.master,
      fit(ctx.masterShort.length > 3 ? ctx.masterShort : ctx.master, cw, { size: 84, font: 'archivo', fill: p.ink })) +
    rect(x, 340, 120, 8, p.primary, 4) +
    line(x, 390, 'MASTER MODEL', { size: 22, weight: 700, fill: p.dim, spacing: 7 });
  const [gd, gf] = gradient([p.primary, p.primary2], x, 0, x + cw, 0);
  s += gd + rect(x, 420, cw, 168, gf, 26) +
    line(x + cw / 2, 502, ctx.part.en, fit(ctx.part.en, cw - 40, { size: 66, font: 'archivo', fill: '#FFFFFF', anchor: 'middle' })) +
    line(x + cw / 2, 552, 'COMPATIBILITY', { size: 24, weight: 700, fill: '#FFFFFF', anchor: 'middle', spacing: 9 });

  const top = 622;
  s += rect(M, top, W - 2 * M, BOTTOM - top, '#FFFFFF', 30, ' opacity=".95"') +
    line(W / 2, top + 50, 'COMPATIBLE MODELS', { size: 24, weight: 700, fill: p.dim, anchor: 'middle', spacing: 8 });
  const all = roundRobin(ctx.brands);
  const listTop = top + 78;
  const two = all.length > 7;
  const rowH = two ? 52 : 60;
  const per = Math.floor((BOTTOM - 18 - listTop) / rowH);
  const capacity = two ? per * 2 : per;
  const shown = all.length > capacity ? all.slice(0, capacity - 1) : all;
  const colW = two ? (W - 2 * M - 64) / 2 : W - 2 * M - 48;
  const nameO = { size: two ? 24 : 30, weight: 900, fill: p.ink };
  shown.forEach((m, i) => {
    const col = two ? Math.floor(i / per) : 0;
    const row = two ? i % per : i;
    const rx = M + 24 + col * (colW + 16);
    const ry = listTop + row * rowH;
    const r = two ? 17 : 20;
    s += rect(rx, ry, colW, rowH - 10, tint(p.primary, 0.93), 14) +
      `<circle cx="${rx + 12 + r}" cy="${ry + (rowH - 10) / 2}" r="${r}" fill="${p.primary}"/>` +
      line(rx + 12 + r, ry + (rowH - 10) / 2 + (two ? 7 : 8), String(i + 1), { size: two ? 18 : 22, font: 'archivo', fill: '#FFFFFF', anchor: 'middle' }) +
      line(rx + 24 + 2 * r, ry + (rowH - 10) / 2 + (two ? 8 : 10), clip(m.name, colW - 40 - 2 * r, nameO), nameO);
  });
  if (shown.length < all.length) {
    const i = shown.length;
    const col = two ? Math.floor(i / per) : 0;
    const row = two ? i % per : i;
    s += line(M + 24 + col * (colW + 16) + colW / 2, listTop + row * rowH + (rowH - 10) / 2 + 8,
      `+ ${all.length - shown.length} more in the app`, { size: 24, font: 'archivo', fill: p.primary, anchor: 'middle' });
  }
  return s;
}

function series(ctx) {
  const p = ctx.pal;
  const [bd, bf] = gradient(['#FFFFFF', p.soft], 0, 0, 0, H);
  let s = bd + rect(0, 0, W, H, bf) + `<circle cx="880" cy="270" r="200" fill="${tint(p.primary, 0.85)}"/>`;
  s += mark(ctx, M, 30, p.ink, 'FIND COMPATIBLE PARTS', p.dim);
  const [td, tf] = gradient([p.ink, p.primary], M, 0, M + 640, 0);
  s += td + line(M, 262, ctx.part.en, fit(ctx.part.en, 640, { size: 136, font: 'anton', fill: tf })) +
    line(M, 368, 'COMPATIBILITY', fit('COMPATIBILITY', 640, { size: 108, font: 'anton', fill: p.primary }));
  const pill = `ONE ${ctx.part.unit}. MULTIPLE COMPATIBLE MODELS.`;
  s += rect(M, 392, 640, 60, p.dark, 30) + line(M + 320, 432, pill, fit(pill, 600, { size: 24, font: 'archivo', fill: '#FFFFFF', anchor: 'middle' }));
  s += shadow(716, 100, 310, 340, 28) + hero(ctx, 716, 100, 310, 340, 28);

  const cards = ctx.brands.slice(0, 4);
  const half = (W - 2 * M - 22) / 2;
  const rowsY = [[478, 760], [862, BOTTOM]];
  s += rect(M, 774, W - 2 * M, 72, p.dark, 36) +
    `<circle cx="${M + 38}" cy="810" r="28" fill="#FFFFFF"/>` + image(asset(ctx.brand.logo), M + 14, 786, 48, 48) +
    line(M + 80, 820, `${ctx.n} MODELS`, { size: 28, font: 'archivo', fill: '#FFFFFF' }) +
    line(M + 96 + width(`${ctx.n} MODELS`, { size: 28, font: 'archivo' }), 819, `•  ${ctx.brands.length} brands  •  one ${ctx.part.word}`, { size: 22, weight: 700, fill: '#FFFFFF', opacity: 0.85 }) +
    icon(ctx.brand.chipIcon, W - M - 66 - width(ctx.brand.chip, { size: 24, font: 'archivo' }), 796, 28, p.accent) +
    line(W - M - 28, 820, ctx.brand.chip, { size: 24, font: 'archivo', fill: p.accent, anchor: 'end' });
  cards.forEach((b, i) => {
    const x = M + (i % 2) * (half + 22);
    const cw = i === cards.length - 1 && i % 2 === 0 ? W - 2 * M : half;
    const [y, y2] = rowsY[Math.floor(i / 2)];
    const ch = y2 - y;
    const [hd, hf] = gradient([p.primary, p.primary2], x, 0, x + cw, 0);
    const rowO = { size: 25, weight: 700, fill: p.ink };
    const fits = Math.max(1, Math.floor((ch - 78) / 35));
    const list = b.models.length > fits ? b.models.slice(0, fits - 1) : b.models;
    s += rect(x, y, cw, ch, '#FFFFFF', 24, ` stroke="${tint(p.primary, 0.75)}" stroke-width="2"`) + hd +
      `<path d="M${x} ${y + 24}a24 24 0 0 1 24-24h${cw - 48}a24 24 0 0 1 24 24v34h-${cw}z" fill="${hf}"/>` +
      line(x + 22, y + 41, b.name.toUpperCase(), fit(b.name.toUpperCase(), cw - 150, { size: 30, font: 'archivo', fill: '#FFFFFF' })) +
      line(x + cw - 22, y + 40, b.models.length + ' models', { size: 21, weight: 700, fill: '#FFFFFF', anchor: 'end', opacity: 0.9 }) +
      image(ctx.cutout, x + cw - 134, y + 70, 116, ch - 86) +
      list.map((m, k) => `<circle cx="${x + 30}" cy="${y + 90 + k * 35}" r="5" fill="${p.primary}"/>` +
        line(x + 46, y + 99 + k * 35, fitName(m, b.name, cw - 196, rowO), rowO)).join('') +
      (b.models.length > list.length ? line(x + 46, y + 99 + list.length * 35, `+ ${b.models.length - list.length} more`, { size: 23, font: 'archivo', fill: p.primary }) : '');
  });
  return s;
}

function checklist(ctx) {
  const p = ctx.pal;
  let s = rect(0, 0, W, H, p.bg) + `<circle cx="${W - 60}" cy="150" r="320" fill="${tint(p.primary, 0.86)}" opacity=".7"/>`;
  s += mark(ctx, M, 30, p.ink, 'FIND  •  MATCH  •  GROW', p.dim) +
    line(W - M - 10, 112, 'For mobile shop owners', { size: 46, font: 'script', fill: p.ink, anchor: 'end', rotate: -8 }) +
    `<path d="M${W - M - 372} 184 q 180 -16 352 -58" fill="none" stroke="${p.primary}" stroke-width="4" stroke-linecap="round"/>`;
  const one = `ONE ${ctx.part.en}.`;
  s += line(M, 248, one, fit(one, W - 2 * M - 40, { size: 74, font: 'archivo', fill: p.ink })) +
    line(M, 338, 'MULTIPLE MODELS.', fit('MULTIPLE MODELS.', W - 2 * M - 40, { size: 84, font: 'archivo', fill: p.primary }));
  const pillO = { size: 28, font: 'archivo', fill: '#FFFFFF' };
  s += rect(M, 364, width('Compatible Model Group', pillO) + 56, 60, p.primary, 30) + line(M + 28, 405, 'Compatible Model Group', pillO);

  const top = 448;
  const h = 560;
  const all = roundRobin(ctx.brands);
  const per = Math.floor((h - 40) / 46);
  const shown = all.length > per ? all.slice(0, per - 1) : all;
  const rowO = { size: 27, weight: 700, fill: p.ink };
  s += shadow(M, top, 520, h, 28) + rect(M, top, 520, h, '#FFFFFF', 28) +
    shown.map((m, i) => {
      const y = top + 46 + i * 46;
      return `<circle cx="${M + 40}" cy="${y - 9}" r="16" fill="${p.primary}"/>` + icon('check', M + 29, y - 20, 22, '#FFFFFF') +
        line(M + 70, y, clip(m.name, 420, rowO), rowO);
    }).join('') +
    (shown.length < all.length ? line(M + 70, top + 46 + shown.length * 46, `+ ${all.length - shown.length} more in the app`, { size: 26, font: 'archivo', fill: p.primary }) : '');
  s += line(W - M - 20, top - 14, 'Same perfect fit', { size: 44, font: 'script', fill: p.ink, anchor: 'end', rotate: -6 });
  s += shadow(600, top + 20, 424, h - 20, 30) + hero(ctx, 600, top + 20, 424, h - 20, 30);

  const iy = top + h + 26;
  [['bolt', 'Find the right', 'match in seconds'], ['target', 'Accurate', 'model matching'], ['box', 'Save time,', 'serve customers']].forEach((f, i) => {
    const x = M + i * 330;
    s += `<circle cx="${x + 38}" cy="${iy + 40}" r="38" fill="${tint(p.primary, 0.84)}"/>` + icon(f[0], x + 20, iy + 22, 36, p.primary) +
      line(x + 92, iy + 34, f[1], { size: 23, weight: 900, fill: p.ink }) + line(x + 92, iy + 64, f[2], { size: 21, weight: 400, fill: p.dim }) +
      (i < 2 ? rect(x + 316, iy + 10, 2, 60, tint(p.ink, 0.8)) : '');
  });
  return s;
}

const DESIGNS = [
  { id: 'update', name: 'Model update', draw: update },
  { id: 'universal', name: 'Universal', draw: universal },
  { id: 'splash', name: 'Master splash', draw: splash },
  { id: 'numbered', name: 'Numbered list', draw: numbered },
  { id: 'series', name: 'Brand cards', draw: series },
  { id: 'checklist', name: 'Checklist', draw: checklist }
];

/* ------------------------------------------------------------- the list pages
   A carousel's middle pages: the brands as chip rows, in the cover's colours. */
function listPage(ctx, start) {
  const p = ctx.pal;
  const head = `${ctx.master} group  •  ${ctx.part.en}`;
  const rows = chipRows(ctx, ctx.brands, start, 128, BOTTOM);
  return {
    svg: rect(0, 0, W, H, p.bg) + mark(ctx, M, 30, p.ink) +
      line(W - M, 70, head, fit(head, 560, { size: 26, weight: 900, fill: p.primary, anchor: 'end' })) + rows.svg + footer(ctx),
    next: rows.next,
    drawn: rows.drawn
  };
}

/** The carousel's last page: the app. */
function appPage(ctx, left) {
  const p = ctx.pal;
  const b = ctx.brand;
  const [bd, bf] = gradient([p.primary, p.primary2], 0, 0, W, H);
  const lineA = 'Find the matching part for any phone in seconds';
  return bd + rect(0, 0, W, H - FOOT, bf) + `<circle cx="${W}" cy="0" r="360" fill="#FFFFFF" opacity=".08"/>` +
    rect(W / 2 - 160, 120, 320, 320, '#FFFFFF', 60) + image(asset(b.logo), W / 2 - 140, 140, 280, 280) +
    line(W / 2, 560, b.name, fit(b.name, W - 2 * M, { size: 92, font: 'archivo', fill: '#FFFFFF', anchor: 'middle', spacing: 2 })) +
    line(W / 2, 630, lineA, fit(lineA, W - 2 * M, { size: 40, font: 'archivo', fill: p.accent, anchor: 'middle' })) +
    line(W / 2, 690, 'எந்த மொபைலுக்கும் பொருந்தும் பார்ட்ஸ் • ஒரு நொடியில்!', { size: 30, fill: '#FFFFFF', anchor: 'middle' }) +
    (left > 0 ? line(W / 2, 766, b.moreLast(left, ctx.part), { size: 30, weight: 900, fill: '#FFFFFF', anchor: 'middle' }) : '') +
    (b.play ? image(asset('google-play-badge.png'), W / 2 - 233, 820, 466, 180)
      : rect(W / 2 - 400, 846, 800, 110, '#FFFFFF', 55) + icon('search', W / 2 - 400 + 40, 877, 48, p.primary) +
        line(W / 2 + 30, 917, b.site, fit(b.site, 640, { size: 44, font: 'archivo', fill: p.ink, anchor: 'middle' }))) + footer(ctx);
}

/**
 * The design and colour for a day: the colour turns every day, the design
 * every three days.
 * @param {number} day  a running day number
 */
function planFor(day) {
  const n = Math.max(0, Math.floor(day));
  return { design: DESIGNS[Math.floor(n / 3) % DESIGNS.length].id, palette: PALETTES[n % PALETTES.length].id };
}

module.exports = { DESIGNS, PALETTES, BRANDS, brandFor, brandColor, footer, listPage, appPage, planFor, roundRobin };
