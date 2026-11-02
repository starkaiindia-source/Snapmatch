/* ============================================================================
   Mobile Parts Finder · api/_lib/shop-secrets.js
   ----------------------------------------------------------------------------
   A shop's own payment keys, sealed before they are stored. Firestore is closed
   to browsers, but a key that is readable in a database export or an admin
   screen is a key anyone with that access can spend, so what is stored is
   AES-256-GCM over the secret, under a key that lives only in SHOP_SECRETS_KEY
   in the server's environment.

   Without that variable nothing can be sealed, and connecting is refused rather
   than falling back to storing the secret as it was typed.

   Nothing here logs or returns a secret. GCM's tag means a blob that was changed
   in the database fails to open instead of opening as nonsense.
   ========================================================================== */
'use strict';

const crypto = require('crypto');

function key() {
  const raw = process.env.SHOP_SECRETS_KEY || '';
  return raw.length >= 32 ? crypto.createHash('sha256').update(raw).digest() : null;
}

const available = () => !!key();

/** @param {string} text  @returns {string} "v1.iv.tag.data", all base64url */
function seal(text) {
  const k = key();
  if (!k) throw new Error('SHOP_SECRETS_KEY is not set');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

/** The text sealed in a blob, or null if it cannot be opened. */
function unseal(blob) {
  const k = key();
  const parts = String(blob || '').split('.');
  if (!k || parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(parts[1], 'base64url'));
    d.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([d.update(Buffer.from(parts[3], 'base64url')), d.final()]).toString('utf8');
  } catch (err) {
    return null;
  }
}

module.exports = { available, seal, unseal };
