/* ============================================================================
   Mobile Parts Finder · api/_services/content/phones.js
   ----------------------------------------------------------------------------
   The real things a poster shows besides its words:

     phone(modelId)   the phone's own photo, the one the app and the site show
                      (the catalogue's picture, assets/dataset.json "img"), with
                      its white background taken out, as a PNG data URI
     play()           ProGlide's rating and downloads on Google Play, read from
                      the store page, so a poster never shows a made-up number

   Both are fetched while a poster is drawn and kept in memory: a warm function
   draws the slides of a carousel from one fetch. When a fetch fails the poster
   is drawn without it (the part's own picture, no rating); nothing is stored
   in Firestore and nothing is written anywhere.
   ========================================================================== */
'use strict';

const zlib = require('zlib');

const FETCH_MS = 4000;
const KEEP = 240;
const PLAY_MS = 12 * 60 * 60 * 1000;
const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.jeeva.proglide&hl=en&gl=IN';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/* ------------------------------------------------------------- catalogue */
let models = null;
function catalogue() {
  if (models) return models;
  const d = require('../../../assets/dataset.json');
  const col = name => d.modelCols.indexOf(name);
  const [ID, IMG, SZ, NAME] = [col('id'), col('img'), col('sz'), col('n')];
  models = new Map();
  d.models.forEach(r => models.set(r[ID], { img: r[IMG] || null, inches: r[SZ] || null, name: r[NAME] }));
  return models;
}

/** What the catalogue knows of a model's look: its picture's address and its screen size. */
function infoOf(modelId) {
  return catalogue().get(modelId) || null;
}

/* ---------------------------------------------------------------- photos */
const kept = new Map();

/** A model's photo with its background taken out, or null. */
async function phone(modelId, fetchImpl) {
  if (!modelId) return null;
  if (kept.has(modelId)) return kept.get(modelId);
  const info = infoOf(modelId);
  let out = null;
  if (info && info.img && /^https:\/\/fdn2?\.gsmarena\.com\//.test(info.img)) {
    try {
      const res = await (fetchImpl || globalThis.fetch)(info.img, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(FETCH_MS) });
      if (res.ok) out = cutOut(Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      console.warn('[phones] photo', modelId, err && err.message);
    }
  }
  if (kept.size >= KEEP) kept.delete(kept.keys().next().value);
  kept.set(modelId, out);
  return out;
}

/**
 * The catalogue's photos are a phone on white. The white that touches the
 * edge is made clear (a flood from the border, so a white phone's own body
 * stays), the edge is softened, and the picture is cut to the phone.
 * @returns {{uri:string, w:number, h:number}|null}
 */
function cutOut(jpegBytes) {
  const jpeg = require('jpeg-js');
  const img = jpeg.decode(jpegBytes, { useTArray: true, formatAsRGBA: true });
  const { width: w, height: h, data } = img;
  if (!w || !h) return null;
  const bgLike = i => {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lo = Math.min(r, g, b), hi = Math.max(r, g, b);
    return lo > 226 && hi - lo < 22;
  };
  const bg = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    const k = y * w + x;
    if (bg[k] || !bgLike(k * 4)) return;
    bg[k] = 1;
    stack.push(k);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const k = stack.pop();
    const x = k % w, y = (k - x) / w;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (bg[k]) { data[k * 4 + 3] = 0; continue; }
      /* a pixel next to the clear area takes a softer edge */
      const edge = (x > 0 && bg[k - 1]) || (x < w - 1 && bg[k + 1]) || (y > 0 && bg[k - w]) || (y < h - 1 && bg[k + w]);
      if (edge) {
        const lo = Math.min(data[k * 4], data[k * 4 + 1], data[k * 4 + 2]);
        data[k * 4 + 3] = lo > 200 ? 120 : 220;
      }
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < x0 || y1 < y0) return null;
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const rows = Buffer.alloc((cw * 4 + 1) * ch);
  for (let y = 0; y < ch; y++) {
    const at = y * (cw * 4 + 1);
    rows[at] = 0;
    Buffer.from(data.buffer, data.byteOffset + ((y + y0) * w + x0) * 4, cw * 4).copy(rows, at + 1);
  }
  return { uri: 'data:image/png;base64,' + png(cw, ch, rows).toString('base64'), w: cw, h: ch };
}

/* A PNG from filtered RGBA rows: the four chunks it needs, nothing more. */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}
function png(w, h, rows) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/* ------------------------------------------------------------------ play */
let playKept = null;

/** ProGlide on Google Play: { rating: 4.2, reviews: 205, downloads: '10K+' }, or null when it cannot be read. */
async function play(fetchImpl, now = Date.now()) {
  if (playKept && now - playKept.at < (playKept.value ? PLAY_MS : 30 * 60 * 1000)) return playKept.value;
  let value = null;
  try {
    const res = await (fetchImpl || globalThis.fetch)(PLAY_URL, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(FETCH_MS) });
    if (res.ok) value = readPlay(await res.text());
  } catch (err) {
    console.warn('[phones] play', err && err.message);
  }
  playKept = { at: now, value };
  return value;
}

/** The numbers from a store page; null when the page does not carry a rating. */
function readPlay(html) {
  const r = /"ratingValue":"([0-9.]+)"/.exec(html);
  if (!r) return null;
  const rating = Math.round(Number(r[1]) * 10) / 10;
  if (!(rating > 0 && rating <= 5)) return null;
  const c = /"ratingCount":"(\d+)"/.exec(html);
  const d = />([0-9.,]+[KMB]?\+)<\/div><div[^>]*>Downloads/.exec(html);
  return { rating, reviews: c ? Number(c[1]) : null, downloads: d ? d[1] : null };
}

module.exports = { infoOf, phone, play, cutOut, readPlay, _reset: () => { kept.clear(); playKept = null; } };
