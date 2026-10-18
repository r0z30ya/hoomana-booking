import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  buildTotpUri,
  decryptMfaSecret,
  encryptMfaSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  mfaConfigFromEnvironment,
  RECOVERY_CODE_COUNT,
  TOTP_STEP_SECONDS,
  totpCode,
  verifyTotpCode,
} from './mfa.js';

/** The RFC 6238 reference secret: ASCII "12345678901234567890". */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const buffer = Buffer.from([0, 1, 2, 250, 255]);
    const decoded = base32Decode(base32Encode(buffer));
    expect(decoded?.equals(buffer)).toBe(true);
  });

  it('encodes the RFC example secret like the published vectors assume', () => {
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('returns undefined for invalid or empty input', () => {
    expect(base32Decode('not base32!')).toBeUndefined();
    expect(base32Decode('')).toBeUndefined();
  });

  it('accepts the tolerated input shapes (lowercase, spaces, dashes, padding)', () => {
    const decoded = base32Decode('gezd gnbv-gy3tqojq====');
    expect(decoded?.equals(RFC_SECRET.subarray(0, 10))).toBe(true);
  });
});

describe('TOTP (published RFC 6238 vectors, 6-digit truncation)', () => {
  it('matches every reference value', () => {
    const vectors: ReadonlyArray<readonly [number, string]> = [
      [59, '287082'],
      [1_111_111_109, '081804'],
      [1_111_111_111, '050471'],
      [1_234_567_890, '005924'],
      [2_000_000_000, '279037'],
      [20_000_000_000, '353130'],
    ];

    for (const [seconds, expected] of vectors) {
      expect(totpCode(RFC_SECRET, seconds * 1000), `t=${seconds}`).toBe(expected);
    }
  });

  it('verifies a correct code and rejects a wrong one', () => {
    const timestampMs = 1_111_111_109 * 1000;
    const code = totpCode(RFC_SECRET, timestampMs);
    expect(verifyTotpCode(RFC_SECRET, code, { timestampMs })).toBe(true);
    expect(verifyTotpCode(RFC_SECRET, '000000', { timestampMs })).toBe(false);
  });

  it('accepts one step of clock drift and nothing more', () => {
    const timestampMs = 1_111_111_109 * 1000;
    const code = totpCode(RFC_SECRET, timestampMs);
    const oneStepLater = timestampMs + TOTP_STEP_SECONDS * 1000;
    const twoStepsLater = timestampMs + 2 * TOTP_STEP_SECONDS * 1000;

    expect(verifyTotpCode(RFC_SECRET, code, { timestampMs: oneStepLater })).toBe(true);
    expect(verifyTotpCode(RFC_SECRET, code, { timestampMs: twoStepsLater })).toBe(false);
  });

  it('rejects malformed codes without throwing', () => {
    const timestampMs = 1_111_111_109 * 1000;
    expect(verifyTotpCode(RFC_SECRET, '', { timestampMs })).toBe(false);
    expect(verifyTotpCode(RFC_SECRET, '12345', { timestampMs })).toBe(false);
    expect(verifyTotpCode(RFC_SECRET, 'abcdef', { timestampMs })).toBe(false);
  });

  it('generates fresh 20-byte secrets', () => {
    const first = generateTotpSecret();
    const second = generateTotpSecret();
    expect(first.length).toBe(20);
    expect(first.equals(second)).toBe(false);
  });
});

describe('MFA secret encryption (AES-256-GCM)', () => {
  const config = { key: Buffer.alloc(32, 7), keyVersion: 3 };

  it('round-trips with the matching AAD and carries the key version', () => {
    const secret = generateTotpSecret();
    const encrypted = encryptMfaSecret(secret, 'user-1|factor-1', config);

    expect(encrypted.keyVersion).toBe(3);
    expect(decryptMfaSecret(encrypted, 'user-1|factor-1', config).equals(secret)).toBe(true);
  });

  it('uses a fresh IV per encryption', () => {
    const secret = generateTotpSecret();
    const first = encryptMfaSecret(secret, 'a', config);
    const second = encryptMfaSecret(secret, 'a', config);

    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it('fails closed on a wrong AAD or a wrong key', () => {
    const secret = generateTotpSecret();
    const encrypted = encryptMfaSecret(secret, 'user-1|factor-1', config);

    expect(() => decryptMfaSecret(encrypted, 'user-2|factor-1', config)).toThrowError();
    expect(() =>
      decryptMfaSecret(encrypted, 'user-1|factor-1', {
        key: Buffer.alloc(32, 9),
        keyVersion: 1,
      }),
    ).toThrowError();
  });
});

describe('recovery codes', () => {
  it('generates unique, well-formed codes with one hash each', () => {
    const set = generateRecoveryCodes();

    expect(set.plain).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(set.plain).size).toBe(RECOVERY_CODE_COUNT);
    expect(set.hashes).toHaveLength(RECOVERY_CODE_COUNT);

    for (const code of set.plain) {
      expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    }
  });

  it('normalizes before hashing (case, spaces, dashes)', () => {
    const set = generateRecoveryCodes(1);
    const code = set.plain[0] ?? '';
    const expected = set.hashes[0];

    expect(hashRecoveryCode(code.toLowerCase())).toBe(expected);
    expect(hashRecoveryCode(code.replace('-', ' '))).toBe(expected);
    expect(hashRecoveryCode(` ${code} `)).toBe(expected);
  });
});

describe('mfaConfigFromEnvironment', () => {
  it('returns undefined when no key is configured (MFA unavailable, fail closed)', () => {
    expect(mfaConfigFromEnvironment({ AUTH_MFA_KEY_VERSION: 1 })).toBeUndefined();
    expect(
      mfaConfigFromEnvironment({ AUTH_MFA_ENCRYPTION_KEY: '   ', AUTH_MFA_KEY_VERSION: 1 }),
    ).toBeUndefined();
  });

  it('accepts base64 of exactly 32 bytes and carries the key version', () => {
    const key = Buffer.alloc(32, 3).toString('base64');
    const config = mfaConfigFromEnvironment({
      AUTH_MFA_ENCRYPTION_KEY: key,
      AUTH_MFA_KEY_VERSION: 2,
    });

    expect(config?.key.length).toBe(32);
    expect(config?.keyVersion).toBe(2);
  });

  it('refuses a key of the wrong length', () => {
    const short = Buffer.alloc(16, 3).toString('base64');
    expect(() =>
      mfaConfigFromEnvironment({ AUTH_MFA_ENCRYPTION_KEY: short, AUTH_MFA_KEY_VERSION: 1 }),
    ).toThrowError();
  });
});

describe('buildTotpUri', () => {
  it('builds a standards-shaped otpauth URI', () => {
    const uri = buildTotpUri(RFC_SECRET, '09121234567', 'Hoomana');

    expect(uri.startsWith('otpauth://totp/Hoomana:09121234567?')).toBe(true);
    expect(uri).toContain('secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    expect(uri).toContain('issuer=Hoomana');
  });
});
