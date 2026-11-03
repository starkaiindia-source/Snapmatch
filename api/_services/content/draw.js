/* ============================================================================
   Mobile Parts Finder · api/_services/content/draw.js
   ----------------------------------------------------------------------------
   The drawing kit the poster designs share: text, pictures, a page, a JPEG.

   Text is not left to resvg: its shaping drops Tamil letters before a vowel
   sign (டெ came out as ெ), and it does not fall back between fonts inside a
   line. Every run is shaped by HarfBuzz instead and drawn as the glyphs' own
   outlines, so Tamil is right and every width is exact. Call ready() once
   before drawing.

   Fonts, all from Google Fonts under the SIL Open Font License, in
   api/_assets/fonts:
     Noto Sans 400/700/900   lists and body text
     Noto Sans Tamil Bold    every Tamil run, whatever the line asked for
     Archivo Black           headings
     Anton                   tall condensed display words
     Caveat Bold             the hand-written notes
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', '..', '_assets');
const W = 1080;
const H = 1350;

const FONT_FILES = {
  ta: 'NotoSansTamil-Bold.ttf', 400: 'NotoSans-Regular.ttf', 700: 'NotoSans-Bold.ttf', 900: 'NotoSans-Black.ttf',
  archivo: 'ArchivoBlack-Regular.ttf', anton: 'Anton-Regular.ttf', script: 'Caveat.ttf'
};

let lib = null;
function libs() {
  if (!lib) lib = { Resvg: require('@resvg/resvg-js').Resvg, jpeg: require('jpeg-js') };
  return lib;
}

const files = new Map();
/** A PNG from api/_assets (or any path) as a data URI, read once. */
function asset(file) {
  const full = path.isAbsolute(file) ? file : path.join(ASSETS, file);
  if (!files.has(full)) files.set(full, fs.existsSync(full) ? 'data:image/png;base64,' + fs.readFileSync(full).toString('base64') : null);
  return files.get(full);
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
    const font = new mod.Font(face);
    if (key === 'script') font.setVariations([new mod.Variation('wght', 700)]);
    fonts[key] = { font, upem: face.upem, glyphs: new Map() };
  });
  hb = mod;
}

const TAMIL = /[஀-௿]/;
const fontKey = (tamil, o) => (tamil ? 'ta' : o.font && FONT_FILES[o.font] ? o.font
  : (o.weight || 700) >= 850 ? '900' : (o.weight || 700) >= 600 ? '700' : '400');

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

/* The glyphs and clips a page uses; page() starts them afresh. */
let used = new Map();
let ids = 0;
const uid = prefix => prefix + (++ids);

function glyphRef(key, gid) {
  const id = 'g' + key + '_' + gid;
  if (!used.has(id)) {
    const f = fonts[key];
    if (!f.glyphs.has(gid)) f.glyphs.set(gid, f.font.glyphToPath(gid));
    used.set(id, f.glyphs.get(gid));
  }
  return id;
}

/** The width of a line at a size, in pixels. */
function width(text, o) {
  return runs(text).reduce((n, [ta, s]) => {
    const key = fontKey(ta, o);
    const g = shape(s, key);
    return n + g.reduce((m, x) => m + x.adv, 0) * o.size / fonts[key].upem + (o.spacing || 0) * g.length;
  }, 0);
}

/**
 * A line of text as glyph outlines.
 * o: size, weight | font (archivo, anton, script), fill, anchor (start, middle,
 *    end), spacing, opacity, rotate (degrees, about x,y)
 */
function line(x, y, text, o) {
  const spacing = o.spacing || 0;
  const total = width(text, o);
  let at = o.anchor === 'middle' ? x - total / 2 : o.anchor === 'end' ? x - total : x;
  let out = '';
  runs(text).forEach(([ta, s]) => {
    const key = fontKey(ta, o);
    const k = o.size / fonts[key].upem;
    shape(s, key).forEach(g => {
      if (g.gid) {
        out += `<use href="#${glyphRef(key, g.gid)}" transform="translate(${(at + g.dx * k).toFixed(1)},${(y - g.dy * k).toFixed(1)}) scale(${k.toFixed(5)},${(-k).toFixed(5)})"/>`;
      }
      at += g.adv * k + spacing;
    });
  });
  const extra = (o.opacity != null ? ` opacity="${o.opacity}"` : '') + (o.rotate ? ` transform="rotate(${o.rotate} ${x} ${y})"` : '');
  return `<g fill="${o.fill || '#FFFFFF'}"${extra}>${out}</g>`;
}

/** The largest size up to o.size at which a line fits a width. */
function fit(text, maxWidth, o) {
  let size = o.size;
  while (size > 12 && width(text, Object.assign({}, o, { size })) > maxWidth) size -= 2;
  return Object.assign({}, o, { size });
}

/** Words broken into lines no wider than maxWidth. */
function wrap(text, maxWidth, o) {
  const out = [];
  let cur = '';
  String(text).split(/\s+/).forEach(word => {
    const next = cur ? cur + ' ' + word : word;
    if (cur && width(next, o) > maxWidth) { out.push(cur); cur = word; } else cur = next;
  });
  if (cur) out.push(cur);
  return out;
}

/** The longest start of a name that fits, with an ellipsis when cut. */
function clip(text, maxWidth, o) {
  if (width(text, o) <= maxWidth) return text;
  let s = String(text);
  while (s.length > 1 && width(s + '…', o) > maxWidth) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}

/* -------------------------------------------------------------- pictures */
/**
 * A picture in a box, cut to its rounded corners.
 * fit: 'slice' fills the box, 'meet' shows all of it.
 */
function image(href, x, y, w, h, o = {}) {
  if (!href) return '';
  const fitMode = o.fit === 'slice' ? 'xMidYMid slice' : 'xMidYMid meet';
  if (!o.rx) return `<image href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="${fitMode}"${o.opacity != null ? ` opacity="${o.opacity}"` : ''}/>`;
  const id = uid('c');
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.rx}"/></clipPath>` +
    `<image href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="${fitMode}" clip-path="url(#${id})"/>`;
}

/** A linear gradient, defined where it is used; returns [defs, fill]. */
function gradient(stops, x1, y1, x2, y2) {
  const id = uid('lg');
  return [`<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">` +
    stops.map((c, i) => `<stop offset="${stops.length > 1 ? i / (stops.length - 1) : 0}" stop-color="${c}"/>`).join('') +
    '</linearGradient></defs>', `url(#${id})`];
}

/** A colour mixed toward white (amount 0..1). */
function tint(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const mix = c => Math.round(c + (255 - c) * amount);
  return '#' + [n >> 16, (n >> 8) & 255, n & 255].map(mix).map(c => c.toString(16).padStart(2, '0')).join('');
}

/* ---------------------------------------------------------------- render */
/** One page: the body is built first, then the glyphs it used go in <defs>. */
function page(build) {
  used = new Map();
  ids = 0;
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

module.exports = { W, H, ASSETS, ready, asset, esc, width, line, fit, wrap, clip, image, gradient, tint, page, toJpeg };
