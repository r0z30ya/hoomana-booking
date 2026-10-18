import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { ConfigurationError, InternalError } from './errors.js';

/**
 * Platform-admin MFA: TOTP, recovery codes and secret encryption
 * (ADR-0004 D-A, ADR-0007).
 *
 * `node:crypto` only — zero dependencies — for the same reason as `password.ts`:
 * no native module to install or keep patched. The algorithms are small and fully
 * specified (RFC 4226/6238); the tests pin them to the published vectors.
 *
 * Storage contract (`platform_mfa_factors`, enforced by a CHECK constraint):
 *   - TOTP rows keep the secret as AES-256-GCM ciphertext with a fresh 12-byte IV,
 *     `AAD = "<userId>|<factorId>"`, plus the `keyVersion` it was written with;
 *   - RECOVERY rows keep only the SHA-256 hash of the normalized code.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const RECOVERY_CODE_COUNT = 8;

const TOTP_SECRET_BYTES = 20; // 160-bit, RFC 4226 §4 recommendation
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const RECOVERY_CODE_LENGTH = 10;

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/** The shape `loadEnvironment()` exposes for the AUTH_MFA_* family. */
export interface MfaEnvironment {
  readonly AUTH_MFA_ENCRYPTION_KEY?: string | undefined;
  readonly AUTH_MFA_KEY_VERSION: number;
}

export interface MfaConfig {
  readonly key: Buffer;
  readonly keyVersion: number;
}

/**
 * Build the MFA config from a validated environment.
 *
 * Returns `undefined` when no key is configured — every caller must treat that as
 * "MFA is unavailable" and fail closed, never as "skip the check".
 */
export function mfaConfigFromEnvironment(environment: MfaEnvironment): MfaConfig | undefined {
  const raw = environment.AUTH_MFA_ENCRYPTION_KEY;
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) {
    throw new ConfigurationError('AUTH_MFA_ENCRYPTION_KEY must be base64 of exactly 32 bytes', {
      code: 'INVALID_MFA_KEY',
    });
  }

  return { key, keyVersion: environment.AUTH_MFA_KEY_VERSION };
}

/* -------------------------------------------------------------------------- */
/* Secret encryption (AES-256-GCM)                                            */
/* -------------------------------------------------------------------------- */

export interface EncryptedMfaSecret {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly keyVersion: number;
}

export function encryptMfaSecret(
  secret: Buffer,
  aad: string,
  config: MfaConfig,
): EncryptedMfaSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);

  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: config.keyVersion };
}

/**
 * Decrypt a stored secret. A failure here is corruption or tampering — never a
 * client-input problem — so it surfaces as an internal error and never as a
 * user-visible one.
 */
export function decryptMfaSecret(
  encrypted: EncryptedMfaSecret,
  aad: string,
  config: MfaConfig,
): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', config.key, encrypted.iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(encrypted.authTag);
    return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
  } catch (error) {
    throw new InternalError('Stored MFA secret could not be decrypted', {
      code: 'MFA_SECRET_DECRYPT_FAILED',
      cause: error,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Base32 (RFC 4648) and TOTP (RFC 6238)                                      */
/* -------------------------------------------------------------------------- */

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31] ?? '';
  }

  return output;
}

export function base32Decode(value: string): Buffer | undefined {
  const normalized = value.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');

  if (normalized.length === 0) {
    return undefined;
  }

  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];

  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      return undefined;
    }
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/** Fresh 160-bit secret. The caller shows it once (enrolment) and stores it encrypted. */
export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

function hotp(secret: Buffer, counter: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const mac = createHmac('sha1', secret).update(counterBuffer).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** The 6-digit TOTP for the step that contains `timestampMs`. */
export function totpCode(secret: Buffer, timestampMs: number = Date.now()): string {
  const counter = Math.floor(timestampMs / 1000 / TOTP_STEP_SECONDS);
  return hotp(secret, counter);
}

export interface VerifyTotpOptions {
  readonly timestampMs?: number;
  /** Steps of allowed clock drift on each side. Default 1 (±30 s). */
  readonly window?: number;
}

/**
 * Verify a user-entered TOTP. Comparison is constant-time; the drift window
 * defaults to ±1 step so a slightly fast client clock still works.
 */
export function verifyTotpCode(
  secret: Buffer,
  code: string,
  options: VerifyTotpOptions = {},
): boolean {
  const normalized = code.replace(/[\s-]/g, '');
  if (normalized.length !== TOTP_DIGITS || !/^\d+$/.test(normalized)) {
    return false;
  }

  const timestampMs = options.timestampMs ?? Date.now();
  const window = options.window ?? 1;

  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = Buffer.from(
      totpCode(secret, timestampMs + offset * TOTP_STEP_SECONDS * 1000),
      'utf8',
    );
    const provided = Buffer.from(normalized, 'utf8');
    if (candidate.length === provided.length && timingSafeEqual(candidate, provided)) {
      return true;
    }
  }

  return false;
}

/** `otpauth://` enrolment URI for authenticator apps (manual entry or QR). */
export function buildTotpUri(secret: Buffer, account: string, issuer = 'Hoomana'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const parameters = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });

  return `otpauth://totp/${label}?${parameters.toString()}`;
}

/* -------------------------------------------------------------------------- */
/* Recovery codes                                                             */
/* -------------------------------------------------------------------------- */

export interface RecoveryCodeSet {
  /** Shown to the admin exactly once, at enrolment. */
  readonly plain: readonly string[];
  /** SHA-256 hex of the normalized code — the only form that is stored. */
  readonly hashes: readonly string[];
}

function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_LENGTH);
  let code = '';

  for (const byte of bytes) {
    code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length] ?? '';
  }

  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): RecoveryCodeSet {
  const plain: string[] = [];
  while (plain.length < count) {
    const candidate = generateRecoveryCode();
    if (!plain.includes(candidate)) {
      plain.push(candidate);
    }
  }

  return { plain, hashes: plain.map(hashRecoveryCode) };
}

/** Uppercase, keep only A–Z and 2–9 — tolerant of how the user retypes the code. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code), 'utf8').digest('hex');
}
