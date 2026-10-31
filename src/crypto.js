'use strict';
const crypto = require('node:crypto');

/**
 * Authenticated encryption for OAuth tokens at rest.
 * AES-256-GCM, random 96-bit IV, and the tenant id bound as AAD so a token
 * row copied into another tenant cannot be decrypted there.
 * Format: v1:<iv>:<tag>:<ciphertext> (base64url). The version prefix allows
 * key rotation / KMS envelope encryption later without a data migration.
 */
function makeCipher(keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('Token key must be 32 bytes (base64).');
  return {
    encrypt(plain, aad) {
      if (plain == null) return null;
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      if (aad) c.setAAD(Buffer.from(String(aad)));
      const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
    },
    decrypt(blob, aad) {
      if (!blob) return null;
      const [v, iv, tag, ct] = String(blob).split(':');
      if (v !== 'v1') throw new Error('Unknown token format');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      if (aad) d.setAAD(Buffer.from(String(aad)));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    },
  };
}

const id = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function pkcePair() {
  const verifier = token(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { makeCipher, id, token, sha256, pkcePair, safeEqual };
