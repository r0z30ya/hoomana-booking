/**
 * hbook — webhook signing secret encryption at rest (AES-256-GCM).
 *
 * Secrets are stored as  enc.v1.<iv>.<tag>.<ciphertext>  (url-safe base64).
 * The key comes from HBOOK_WEBHOOK_ENC_KEY:
 *   - 32-byte base64/hex value, or
 *   - any passphrase (derived with scrypt, fixed app salt).
 * Required in production. In development an ephemeral key is generated per
 * process (legacy plaintext rows are then unreadable — re-create webhooks).
 *
 * Legacy plaintext secrets (starting with "whsec_") are transparently
 * re-encrypted on first successful use.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from '../config';

const PREFIX = 'enc.v1.';
const SALT = 'hbook:webhook-secret:v1';

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = config.webhook.encKey;
  if (raw) {
    // 32-byte key material given as base64 or hex?
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === 32 && /^[\w+/=-]+$/.test(raw) && raw.length >= 43) {
      cachedKey = b64;
      return cachedKey;
    }
    const hex = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : null;
    if (hex && hex.length === 32) {
      cachedKey = hex;
      return cachedKey;
    }
    cachedKey = scryptSync(raw, SALT, 32);
    return cachedKey;
  }
  // dev fallback: ephemeral per-process key (production fails fast in config)
  cachedKey = scryptSync(`ephemeral:${process.pid}:${randomBytes(8).toString('hex')}`, SALT, 32);
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', loadKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64 = (b: Buffer) => b.toString('base64url');
  return `${PREFIX}${b64(iv)}.${b64(tag)}.${b64(ct)}`;
}

export function decryptSecret(stored: string): { secret: string; legacy: boolean } {
  if (!stored.startsWith(PREFIX)) {
    return { secret: stored, legacy: true }; // legacy plaintext — caller re-encrypts
  }
  const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('malformed encrypted webhook secret');
  const decipher = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]);
  return { secret: pt.toString('utf8'), legacy: false };
}

/** Constant-time comparison for signature verification helpers. */
export function safeHexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
