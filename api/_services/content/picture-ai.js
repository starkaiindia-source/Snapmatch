/* ============================================================================
   Mobile Parts Finder · api/_services/content/picture-ai.js
   ----------------------------------------------------------------------------
   The product photo on a poster: a phone and its part, made by Gemini's image
   model (GEMINI_API_KEY, the key the reply bot already uses).

   ONLY THE PHOTO. The prompt asks for no text, no letters and no logos: model
   names on a poster are drawn from the catalogue (poster.js), never by a
   picture model, which misspells them; and no brand's logo is ever recreated.

   One photo for each part and master model, made when the owner asks and kept
   in Firestore (contentPictures), so a poster drawn again is the same poster
   and a photo is paid for once. It is stored as a JPEG of about 100 KB, well
   inside a document's 1 MB.
   ========================================================================== */
'use strict';

const C = require('../../_schema/collections');
const { db } = require('../../_lib/firebase');

const MODEL = 'gemini-2.5-flash-image';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const SIDE = 768;
const TIMEOUT_MS = 50000;

const SUBJECT = {
  'screen-guards': 'a clear 9H tempered glass screen protector with thin black edges, floating just in front of the phone screen',
  'back-cover': 'a matte black soft back cover case standing beside the phone',
  'combo-display': 'a replacement phone display assembly (LCD screen with its flex cable) shown front and back',
  'middle-frame': 'a bare metal phone middle frame chassis standing beside the phone',
  'cc-board': 'a small phone charging port circuit board with a USB-C connector, close up beside the phone',
  battery: 'a slim lithium phone battery cell beside the phone',
  'button-flex': 'a power and volume button flex cable (orange ribbon) beside the phone',
  'sim-tray': 'a black SIM card tray beside the phone'
};

const keyOf = (category, master) => (category + '__' + String(master || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 140);
const col = () => db().collection(C.CONTENT_PICTURES);

function prompt(category, master) {
  return `Photorealistic studio product photo for a mobile phone parts shop. A modern smartphone in the style of the ${master}, ` +
    `and ${SUBJECT[category] || 'its replacement part beside it'}. Clean light grey studio background with a soft gradient, ` +
    'gentle reflections, sharp detail, centred, generous space around the products. ' +
    'Absolutely no text, letters, numbers, logos, brand marks or watermarks anywhere in the image.';
}

/** Any picture (PNG or JPEG bytes) as a JPEG no wider than SIDE. */
function toJpeg(buf) {
  const jpeg = require('jpeg-js');
  let img;
  if (buf[0] === 0x89) {
    const { PNG } = require('pngjs');
    const png = PNG.sync.read(buf);
    img = { width: png.width, height: png.height, data: png.data };
  } else {
    img = jpeg.decode(buf, { useTArray: true });
  }
  const step = Math.max(1, Math.ceil(img.width / SIDE));
  if (step > 1) {
    const w = Math.floor(img.width / step);
    const h = Math.floor(img.height / step);
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sum = [0, 0, 0];
        for (let dy = 0; dy < step; dy++) {
          for (let dx = 0; dx < step; dx++) {
            const i = ((y * step + dy) * img.width + x * step + dx) * 4;
            sum[0] += img.data[i]; sum[1] += img.data[i + 1]; sum[2] += img.data[i + 2];
          }
        }
        const o = (y * w + x) * 4;
        out[o] = sum[0] / (step * step); out[o + 1] = sum[1] / (step * step); out[o + 2] = sum[2] / (step * step); out[o + 3] = 255;
      }
    }
    img = { width: w, height: h, data: out };
  }
  return Buffer.from(jpeg.encode(img, 84).data);
}

/** The kept photo for a part and master, as a data URI, or null. */
async function stored(category, master) {
  const snap = await col().doc(keyOf(category, master)).get();
  return snap.exists && snap.data().jpeg ? 'data:image/jpeg;base64,' + snap.data().jpeg : null;
}

/**
 * Makes the photo and keeps it, replacing an earlier one.
 * @returns {Promise<{ok:true}|{ok:false, code:string, message:string}>}
 */
async function make(category, master, uid) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: false, code: 'no-key', message: 'GEMINI_API_KEY is not set on the server.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  let json = null;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST', signal: controller.signal,
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt(category, master) }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } }
      })
    });
    json = await res.json().catch(() => null);
  } catch (err) {
    return { ok: false, code: 'unreachable', message: err && err.name === 'AbortError' ? 'Gemini took too long to make the picture.' : 'Gemini could not be reached.' };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const e = (json && json.error) || {};
    const quota = res.status === 429 || e.status === 'RESOURCE_EXHAUSTED';
    return {
      ok: false, code: quota ? 'quota' : 'refused',
      message: quota ? 'The Gemini key has no image quota. Image pictures need billing turned on for this key in Google AI Studio.'
        : 'Gemini refused: ' + String(e.message || res.status).slice(0, 200)
    };
  }
  const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
  const inline = parts.map(p => p.inlineData || p.inline_data).find(Boolean);
  if (!inline || !inline.data) return { ok: false, code: 'no-picture', message: 'Gemini answered without a picture. Try again.' };
  const jpeg = toJpeg(Buffer.from(inline.data, 'base64'));
  await col().doc(keyOf(category, master)).set({
    category, master: String(master), model: MODEL, jpeg: jpeg.toString('base64'), bytes: jpeg.length, madeBy: uid || null, madeAt: Date.now()
  });
  return { ok: true, bytes: jpeg.length };
}

module.exports = { stored, make, prompt, keyOf, toJpeg, MODEL };
