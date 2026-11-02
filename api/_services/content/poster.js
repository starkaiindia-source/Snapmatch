/* ============================================================================
   Mobile Parts Finder · api/_services/content/poster.js
   ----------------------------------------------------------------------------
   Instagram posters for @proglide_9h_screenguard, drawn from a compatibility
   group: one part, and every phone it fits.

   WHAT THEY LOOK LIKE, AND WHY

   The account's best posts by far were dense "universal list" charts: one part,
   its picture, and the models it fits listed brand by brand. Shop owners save
   them as a reference and pass them on. So every poster here is that chart:

     header   the part's picture, "ONE 9H GLASS · 325 MODELS", the master model,
              and the same in Tamil
     body     the models, brand by brand, in columns
     footer   always the same: the ProGlide logo and name, Google's Play badge,
              and "Comment LINK" (and "Comment 9H" for glass)

   A single poster is one 4:5 picture. A carousel is a cover, as many list pages
   as the group needs, and a last page asking for the app.

   HOW THEY ARE DRAWN

   SVG, laid out here, rendered by resvg and encoded as JPEG, the only picture
   Instagram's publishing API takes. The text is not left to resvg: its shaping
   drops Tamil letters before a vowel sign (டெ came out as ெ), and it does not fall
   back between fonts inside a line. Every run is shaped by HarfBuzz instead, with
   the Noto fonts in api/_assets, and drawn as the glyphs' own outlines, so Tamil
   is right and every width is exact. Call ready() once before drawing.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', '..', '_assets');
const CUTOUTS = path.join(__dirname, '..', '..', '..', 'assets', 'categories', 'cutout');
/* the font for a run: Tamil, or Latin by weight */
const FONT_FILES = { ta: 'NotoSansTamil-Bold.ttf', 400: 'NotoSans-Regular.ttf', 700: 'NotoSans-Bold.ttf', 900: 'NotoSans-Black.ttf' };

const W = 1080;
const H = 1350;
const M = 56;
const COLORS = {
  bg1: '#0A1730', bg2: '#132A52', panel: '#16305C', ink: '#FFFFFF', dim: '#B9C6DD',
  orange: '#F26A1B', amber: '#FFB547', navy: '#0A1730', line: '#2A4A7E'
};
/* one colour a brand, the same on every poster */
const BRAND_COLORS = ['#F26A1B', '#2F80ED', '#27AE60', '#9B51E0', '#EB5757', '#00A3A3', '#D4A017', '#E056A0'];

const PARTS = {
  'screen-guards': { en: 'TEMPERED GLASS', one: 'ONE 9H GLASS', ta: 'டெம்பர் கிளாஸ்', price: true },
  'back-cover': { en: 'BACK COVER', one: 'ONE BACK COVER', ta: 'பேக் கவர்' },
  'combo-display': { en: 'COMBO DISPLAY', one: 'ONE DISPLAY', ta: 'காம்போ டிஸ்ப்ளே' },
  'middle-frame': { en: 'MIDDLE FRAME', one: 'ONE MIDDLE FRAME', ta: 'மிடில் ஃப்ரேம்' },
  'cc-board': { en: 'CC BOARD', one: 'ONE CC BOARD', ta: 'சிசி போர்டு' },
  battery: { en: 'BATTERY', one: 'ONE BATTERY', ta: 'பேட்டரி' },
  'button-flex': { en: 'BUTTON FLEX', one: 'ONE BUTTON FLEX', ta: 'பட்டன் ஃப்ளெக்ஸ்' },
  'sim-tray': { en: 'SIM TRAY', one: 'ONE SIM TRAY', ta: 'சிம் ட்ரே' }
};
const PREFIX = { sg: 'screen-guards', bc: 'back-cover', cd: 'combo-display', mf: 'middle-frame', cc: 'cc-board', bt: 'battery', bf: 'button-flex', st: 'sim-tray' };
const categoryOf = groupId => PREFIX[String(groupId || '').split('-')[0]] || null;

let lib = null;
function libs() {
  if (!lib) lib = { Resvg: require('@resvg/resvg-js').Resvg, jpeg: require('jpeg-js') };
  return lib;
}

const pictures = new Map();
function picture(file) {
  if (!pictures.has(file)) pictures.set(file, fs.existsSync(file) ? 'data:image/png;base64,' + fs.readFileSync(file).toString('base64') : null);
  return pictures.get(file);
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------------ text */
let hb = null;
const fonts = {};

/** Loads HarfBuzz and the fonts, once. */
async function ready() {
  if (hb) return;
  const mod = await import('harfbuzzjs');
  Object.keys(FONT_FILES).forEach(key => {
    const face = new mod.Face(new mod.Blob(fs.readFileSync(path.join(ASSETS, 'fonts', FONT_FILES[key]))));
    fonts[key] = { font: new mod.Font(face), upem: face.upem, glyphs: new Map() };
  });
  hb = mod;
}

const TAMIL = /[\u0B80-\u0BFF]/;
const fontKey = (tamil, weight) => (tamil ? 'ta' : weight >= 850 ? '900' : weight >= 600 ? '700' : '400');

/** "ஒரே Glass" -> [[true, 'ஒரே '], [false, 'Glass']] */
function runs(text) {
  const out = [];
  let cur = '';
  let ta = null;
  for (const ch of String(text)) {
    const kind = /\s/.test(ch) && cur ? ta : TAMIL.test(ch);
    if (ta !== null && kind !== ta) { out.push([ta, cur]); cur = ''; }
    ta = kind;
    cur += ch;
  }
  if (cur) out.push([ta, cur]);
  return out;
}

const shaped = new Map();
/** Glyph ids and advances, in font units. */
function shape(text, key) {
  const k = key + '|' + text;
  if (shaped.has(k)) return shaped.get(k);
  const buf = new hb.Buffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  hb.shape(fonts[key].font, buf);
  const pos = buf.getGlyphPositions();
  const out = buf.getGlyphInfos().map((g, i) => ({ gid: g.codepoint, adv: pos[i].xAdvance, dx: pos[i].xOffset, dy: pos[i].yOffset }));
  shaped.set(k, out);
  return out;
}

/* The glyphs a document uses, each drawn once in <defs> and placed with <use>. */
let used = new Map();
function glyphRef(key, gid) {
  const id = 'g' + key + '_' + gid;
  if (!used.has(id)) {
    const f = fonts[key];
    if (!f.glyphs.has(gid)) f.glyphs.set(gid, f.font.glyphToPath(gid));
    used.set(id, f.glyphs.get(gid));
  }
  return id;
}

function runWidth(text, size, weight, tamil, spacing) {
  const key = fontKey(tamil, weight);
  const g = shape(text, key);
  return g.reduce((n, x) => n + x.adv, 0) * size / fonts[key].upem + (spacing || 0) * g.length;
}

function textWidth(text, size, weight, spacing) {
  return runs(text).reduce((n, [ta, s]) => n + runWidth(s, size, weight || 700, ta, spacing), 0);
}

/** A line of text as glyph outlines. anchor: start, middle or end. */
function line(x, y, text, o) {
  const size = o.size;
  const weight = o.weight || 700;
  const spacing = o.spacing || 0;
  const total = textWidth(text, size, weight, spacing);
  let at = o.anchor === 'middle' ? x - total / 2 : o.anchor === 'end' ? x - total : x;
  let out = '';
  runs(text).forEach(([ta, s]) => {
    const key = fontKey(ta, weight);
    const k = size / fonts[key].upem;
    shape(s, key).forEach(g => {
      if (g.gid) {
        const id = glyphRef(key, g.gid);
        out += `<use href="#${id}" transform="translate(${(at + g.dx * k).toFixed(1)},${(y - g.dy * k).toFixed(1)}) scale(${k.toFixed(5)},${(-k).toFixed(5)})"/>`;
      }
      at += g.adv * k + spacing;
    });
  });
  return `<g fill="${o.fill || COLORS.ink}">${out}</g>`;
}

/** The largest size up to max at which a line fits a width. */
function fit(text, max, width, weight) {
  let size = max;
  while (size > 14 && textWidth(text, size, weight || 700) > width) size -= 2;
  return size;
}

const shorten = (name, n) => (name.length > n ? name.slice(0, n - 1) + '…' : name);

/* --------------------------------------------------------------- pieces */
function background() {
  return `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${COLORS.bg1}"/><stop offset="1" stop-color="${COLORS.bg2}"/></linearGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>` +
    `<circle cx="${W - 40}" cy="40" r="220" fill="${COLORS.orange}" fill-opacity=".10"/>`;
}

/** Brand and category, across the top. */
function topBar(category, note) {
  const part = PARTS[category];
  const pill = part.en;
  const pw = textWidth(pill, 24, 800) + 40;
  return `<image href="${picture(path.join(ASSETS, 'proglide.png'))}" x="${M}" y="26" width="64" height="64"/>` +
    line(M + 76, 68, 'PRO-GLIDE', { size: 30, weight: 900, fill: COLORS.ink, spacing: 1 }) +
    `<rect x="${W - M - pw}" y="34" width="${pw}" height="46" rx="23" fill="${COLORS.orange}"/>` +
    line(W - M - pw / 2, 66, pill, { size: 24, weight: 800, anchor: 'middle' }) +
    (note ? line(W - M - pw - 18, 66, note, { size: 22, weight: 700, fill: COLORS.dim, anchor: 'end' }) : '');
}

/** The part, the count and the master model. */
function hero(group, category, y, tall) {
  const part = PARTS[category];
  const h = tall ? 520 : 360;
  const img = picture(path.join(CUTOUTS, category + '.png'));
  const box = tall ? 380 : 300;
  const tx = M + box + 56;
  const tw = W - M - tx;
  const n = group.memberCount;
  const master = 'Master model: ' + group.masterModelName;
  const ta = `ஒரே ${part.ta} • ${n} மொபைல்களுக்கு!`;
  const top = y + (tall ? 70 : 40);
  return `<rect x="${M - 16}" y="${y}" width="${W - 2 * M + 32}" height="${h}" rx="28" fill="${COLORS.panel}"/>` +
    `<rect x="${M + 8}" y="${y + (h - box) / 2}" width="${box}" height="${box}" rx="24" fill="#FFFFFF"/>` +
    (img ? `<image href="${img}" x="${M + 18}" y="${y + (h - box) / 2 + 10}" width="${box - 20}" height="${box - 20}" preserveAspectRatio="xMidYMid meet"/>` : '') +
    line(tx, top + 30, part.one, { size: fit(part.one, 40, tw, 800), weight: 800, fill: COLORS.amber, spacing: 1 }) +
    line(tx, top + (tall ? 190 : 160), String(n), { size: tall ? 170 : 140, weight: 900, fill: COLORS.ink }) +
    line(tx + textWidth(String(n), tall ? 170 : 140, 900) + 16, top + (tall ? 190 : 160), 'MODELS', { size: 44, weight: 900, fill: COLORS.ink }) +
    line(tx, top + (tall ? 250 : 215), master, { size: fit(master, 30, tw, 700), weight: 700, fill: COLORS.dim }) +
    line(tx, top + (tall ? 310 : 270), ta, { size: fit(ta, 30, tw, 700), weight: 700, fill: COLORS.amber });
}

/** The same on every poster: who we are, where to get the app, what to comment. */
function footer(category) {
  const y = H - 196;
  const badgeH = 84;
  const badgeW = Math.round(badgeH * 646 / 250);
  const cta = PARTS[category].price ? 'Comment LINK for the app  •  Comment 9H for price' : 'Comment LINK  •  get the ProGlide app in your DM';
  return `<rect x="0" y="${y}" width="${W}" height="196" fill="#FFFFFF"/>` +
    `<image href="${picture(path.join(ASSETS, 'proglide.png'))}" x="${M - 6}" y="${y + 14}" width="96" height="96"/>` +
    line(M + 104, y + 58, 'PRO-GLIDE', { size: 38, weight: 900, fill: COLORS.navy, spacing: 1 }) +
    line(M + 104, y + 92, 'Compatible Device Finder app', { size: 22, weight: 700, fill: '#4B5B78' }) +
    `<image href="${picture(path.join(ASSETS, 'google-play-badge.png'))}" x="${W - M - badgeW + 12}" y="${y + 20}" width="${badgeW}" height="${badgeH}"/>` +
    `<rect x="${M - 6}" y="${y + 124}" width="${W - 2 * M + 12}" height="56" rx="28" fill="${COLORS.orange}"/>` +
    line(W / 2, y + 162, cta, { size: fit(cta, 28, W - 2 * M - 40, 800), weight: 800, anchor: 'middle' });
}

/* ------------------------------------------------------------- the list */
/** Members grouped by brand, biggest brand first, the master first in its own. */
function byBrand(group, brandOf) {
  const brands = new Map();
  group.members.forEach(m => {
    const b = brandOf(m) || m.name.split(' ')[0];
    if (!brands.has(b)) brands.set(b, []);
    brands.get(b).push(m.name);
  });
  return Array.from(brands.entries()).map(([name, models], i) => ({ name, models, color: BRAND_COLORS[i % BRAND_COLORS.length] }))
    .sort((a, b) => b.models.length - a.models.length)
    .map((b, i) => Object.assign(b, { color: BRAND_COLORS[i % BRAND_COLORS.length] }));
}

/**
 * Lays brand blocks into columns from a starting point, as many as fit. Returns
 * the drawing and where it stopped, so a carousel's next page carries on.
 */
function columns(brands, start, top, bottom, cols) {
  const colW = (W - 2 * M - (cols - 1) * 24) / cols;
  const rowH = 33;
  const headH = 46;
  let col = 0;
  let y = top;
  let out = '';
  let bi = start.brand;
  let mi = start.model;
  let drawn = 0;
  const chars = Math.floor(colW / 12.4);
  while (bi < brands.length && col < cols) {
    const b = brands[bi];
    const x = M + col * (colW + 24);
    if (y + headH + rowH > bottom) { col++; y = top; continue; }
    const label = (mi > 0 ? b.name + ' (contd.)' : b.name) + '  ' + (b.total || b.models.length);
    out += `<rect x="${x}" y="${y}" width="${colW}" height="38" rx="10" fill="${b.color}"/>` +
      line(x + 14, y + 27, shorten(label, chars), { size: 22, weight: 800 });
    y += headH;
    while (mi < b.models.length && y + rowH <= bottom) {
      out += `<circle cx="${x + 10}" cy="${y + 15}" r="4" fill="${b.color}"/>` +
        line(x + 24, y + 23, shorten(b.models[mi], chars - 2), { size: 22, weight: 700, fill: COLORS.ink });
      y += rowH;
      mi++;
      drawn++;
    }
    if (mi >= b.models.length) { bi++; mi = 0; y += 10; } else { col++; y = top; }
  }
  return { svg: out, next: { brand: bi, model: mi }, drawn };
}

const remaining = (brands, at) => brands.slice(at.brand).reduce((n, b, i) => n + b.models.length - (i === 0 ? at.model : 0), 0);

/* --------------------------------------------------------------- render */
/* a page's glyphs start afresh; the body is built first, then its <defs> */
function page(build) {
  used = new Map();
  const body = build();
  const defs = Array.from(used.entries()).map(([id, d]) => `<path id="${id}" d="${d}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${body}</svg>`;
}

/** SVG to JPEG, the only picture Instagram's publishing API takes. */
function toJpeg(svg, quality) {
  const { Resvg, jpeg } = libs();
  const img = new Resvg(svg, { font: { loadSystemFonts: false }, fitTo: { mode: 'width', value: W } }).render();
  return jpeg.encode({ data: img.pixels, width: img.width, height: img.height }, quality || 88).data;
}

/**
 * One poster: the part, the count, and a share of every brand's models, so the
 * reader sees Vivo, Realme and Oppo all at once, then "+N more".
 * @param {{groupId, masterModelName, memberCount, members:{id,name}[]}} group
 * @param {(member) => string} brandOf
 */
function single(group, brandOf) {
  const category = categoryOf(group.groupId);
  const brands = byBrand(group, brandOf);
  /* the six biggest brands, two a column, each as many models as still fit */
  const top = 528;
  const bottom = H - 196 - 70;
  const picked = brands.slice(0, 6);
  let shown = picked;
  for (let each = 40; each >= 1; each--) {
    shown = picked.map(b => Object.assign({}, b, { total: b.models.length, models: b.models.slice(0, each) }));
    const fill = columns(shown, { brand: 0, model: 0 }, top, bottom, 3);
    if (!remaining(shown, fill.next)) break;
  }
  /* a short list is balanced across the columns and centred in the space */
  let low = bottom;
  while (low - 33 > top + 80 && !remaining(shown, columns(shown, { brand: 0, model: 0 }, top, low - 33, 3).next)) low -= 33;
  const shift = Math.floor((bottom - low) / 2);
  return page(() => {
    const list = columns(shown, { brand: 0, model: 0 }, top + shift, low + shift, 3);
    const left = group.members.length - list.drawn;
    return background() + topBar(category) + hero(group, category, 120, false) + list.svg +
      (left > 0 ? line(W / 2, H - 196 - 26, `+ ${left} more models in the ProGlide app`, { size: 28, weight: 800, fill: COLORS.amber, anchor: 'middle' }) : '') +
      footer(category);
  });
}

/**
 * A carousel: a cover, list pages until every model is shown (ten slides at
 * most, as Instagram allows), and a last page for the app.
 */
function carousel(group, brandOf) {
  const category = categoryOf(group.groupId);
  const part = PARTS[category];
  const brands = byBrand(group, brandOf);
  const slides = [];
  slides.push(page(() => background() + topBar(category) + hero(group, category, 130, true) +
    line(W / 2, 760, 'Swipe to see every model', { size: 40, weight: 900, anchor: 'middle' }) +
    line(W / 2, 812, 'எல்லா மாடல்களையும் பார்க்க ஸ்வைப் செய்யுங்கள்', { size: 28, weight: 700, fill: COLORS.amber, anchor: 'middle' }) +
    brands.slice(0, 6).map((b, i) => {
      const cw = (W - 2 * M) / 3;
      const x = M + (i % 3) * cw;
      const y = 880 + Math.floor(i / 3) * 90;
      return `<rect x="${x}" y="${y}" width="${cw - 16}" height="70" rx="16" fill="${b.color}"/>` +
        line(x + (cw - 16) / 2, y + 46, shorten(b.name, 12) + '  ' + b.models.length, { size: 28, weight: 800, anchor: 'middle' });
    }).join('') + footer(category)));

  let at = { brand: 0, model: 0 };
  while (at.brand < brands.length && slides.length < 9) {
    let drawn = 0;
    let next = at;
    slides.push(page(() => {
      const list = columns(brands, at, 150, H - 196 - 30, 3);
      drawn = list.drawn;
      next = list.next;
      return background() + topBar(category, `${group.masterModelName} group`) + list.svg + footer(category);
    }));
    if (!drawn) break;
    at = next;
  }
  const left = remaining(brands, at);

  const appLine = 'Find the matching part for any phone in seconds';
  slides.push(page(() => background() + topBar(category) +
    `<image href="${picture(path.join(ASSETS, 'proglide.png'))}" x="${W / 2 - 150}" y="170" width="300" height="300"/>` +
    line(W / 2, 560, 'PRO-GLIDE', { size: 80, weight: 900, anchor: 'middle', spacing: 2 }) +
    line(W / 2, 630, appLine, { size: fit(appLine, 40, W - 2 * M, 800), weight: 800, fill: COLORS.amber, anchor: 'middle' }) +
    line(W / 2, 690, 'எந்த மொபைலுக்கும் பொருந்தும் பார்ட்ஸ் • ஒரு நொடியில்!', { size: 30, weight: 700, fill: COLORS.dim, anchor: 'middle' }) +
    (left ? line(W / 2, 770, `+ ${left} more ${part.en.toLowerCase()} matches in the app`, { size: 30, weight: 800, anchor: 'middle' }) : '') +
    `<image href="${picture(path.join(ASSETS, 'google-play-badge.png'))}" x="${W / 2 - 233}" y="820" width="466" height="180"/>` +
    footer(category)));
  return slides;
}

module.exports = { PARTS, categoryOf, ready, single, carousel, toJpeg, W, H };
