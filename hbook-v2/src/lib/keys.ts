/**
 * hbook — API key utilities.
 *
 * Keys look like:  hbk_<32 url-safe random chars>
 * Only a SHA-256 hash is persisted; the raw key is shown exactly once
 * (at creation time) and cannot be recovered afterwards.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface GeneratedApiKey {
  /** Full key — return to the caller once, never store in plaintext. */
  key: string;
  /** First 12 characters, safe for display/identification. */
  prefix: string;
  /** SHA-256 hex digest, stored in the database with a unique index. */
  hashedKey: string;
}

export function generateApiKey(): GeneratedApiKey {
  const secret = randomBytes(24).toString('base64url'); // 32 chars
  const key = `hbk_${secret}`;
  return {
    key,
    prefix: key.slice(0, 12),
    hashedKey: hashApiKey(key),
  };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

export function generateBookingUid(): string {
  return randomBytes(9).toString('base64url'); // 12 chars
}

/** Constant-time string comparison (used for the setup token). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
