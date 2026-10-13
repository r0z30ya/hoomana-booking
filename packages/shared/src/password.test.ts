import { describe, expect, it } from 'vitest';
import { ConfigurationError } from './errors.js';
import {
  DEFAULT_SCRYPT_PARAMS,
  dummyVerify,
  hashPassword,
  parseStoredHash,
  scryptParams,
  scryptParamsFromEnvironment,
  verifyPassword,
  type ScryptParams,
} from './password.js';

/**
 * U4 — password hashing unit suite (ADR-0004 D-D test plan).
 *
 * Runs on the floor parameters so the suite stays fast; the floors themselves are
 * asserted to be enforced, and one case runs on the defaults to prove the shipped
 * configuration works.
 */
const floorParams: ScryptParams = scryptParams({ N: 16_384, keyLen: 32 });

const PASSWORD = 'correct horse battery staple';

describe('password hashing (U4)', () => {
  it('hashes into a self-describing format and verifies the correct password', async () => {
    const stored = await hashPassword(PASSWORD, floorParams);
    const parts = stored.split('$');

    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).toBe('16384');
    expect(parts[2]).toBe('8');
    expect(parts[3]).toBe('1');

    const result = await verifyPassword(PASSWORD, stored, floorParams);

    expect(result.matches).toBe(true);
    expect(result.needsRehash).toBe(false);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword(PASSWORD, floorParams);

    expect((await verifyPassword('wrong password', stored, floorParams)).matches).toBe(false);
  });

  it('uses a fresh salt, so two hashes of the same password differ', async () => {
    const first = await hashPassword(PASSWORD, floorParams);
    const second = await hashPassword(PASSWORD, floorParams);

    expect(first).not.toBe(second);
    expect((await verifyPassword(PASSWORD, second, floorParams)).matches).toBe(true);
  });

  it('fails closed on a malformed stored hash without throwing', async () => {
    for (const malformed of ['', 'not-a-hash', 'scrypt$16384$8$1$onlyfourparts', 'scrypt$0$8$1$AA$AA']) {
      const result = await verifyPassword(PASSWORD, malformed, floorParams);

      expect(result.matches).toBe(false);
      expect(result.needsRehash).toBe(false);
    }
  });

  it('refuses to hash with parameters below the hard floors', async () => {
    const weak = { N: 1024, r: 8, p: 1, keyLen: 32, maxMem: 64 * 1024 * 1024 };

    await expect(hashPassword(PASSWORD, weak)).rejects.toThrow(ConfigurationError);
    expect(() => scryptParams({ N: 1024 })).toThrow(ConfigurationError);
    expect(() => scryptParams({ keyLen: 16 })).toThrow(ConfigurationError);
  });

  it('flags needsRehash when the stored parameters are weaker than the current ones', async () => {
    const stored = await hashPassword(PASSWORD, floorParams);
    const result = await verifyPassword(PASSWORD, stored, DEFAULT_SCRYPT_PARAMS);

    expect(result.matches).toBe(true);
    expect(result.needsRehash).toBe(true);

    const upgraded = await hashPassword(PASSWORD, DEFAULT_SCRYPT_PARAMS);

    expect((await verifyPassword(PASSWORD, upgraded, DEFAULT_SCRYPT_PARAMS)).needsRehash).toBe(
      false,
    );
  });

  it('spends real work on the dummy path, so unknown accounts are not distinguishable by time', async () => {
    const startedAt = Date.now();
    await dummyVerify('anything', floorParams);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(1);

    const startedAtMalformed = Date.now();
    await verifyPassword(PASSWORD, 'not-a-hash', floorParams);
    const elapsedMalformed = Date.now() - startedAtMalformed;

    // A malformed hash must not return before the derivation budget is spent.
    expect(elapsedMalformed).toBeGreaterThanOrEqual(1);
  });

  it('derives the parameters from a validated environment and honours an explicit maxMem', () => {
    const params = scryptParamsFromEnvironment({
      AUTH_SCRYPT_N: 16_384,
      AUTH_SCRYPT_R: 8,
      AUTH_SCRYPT_P: 1,
      AUTH_SCRYPT_KEYLEN: 32,
    });

    expect(params.N).toBe(16_384);
    expect(params.keyLen).toBe(32);
    expect(params.maxMem).toBeGreaterThanOrEqual(128 * 16_384 * 8);

    const withCeiling = scryptParamsFromEnvironment({
      AUTH_SCRYPT_N: 16_384,
      AUTH_SCRYPT_R: 8,
      AUTH_SCRYPT_P: 1,
      AUTH_SCRYPT_KEYLEN: 32,
      AUTH_SCRYPT_MAXMEM: 33_554_432,
    });

    expect(withCeiling.maxMem).toBe(33_554_432);
  });

  it('rejects a stored hash whose parameters fall outside the sanity envelope', () => {
    expect(parseStoredHash('scrypt$1073741824$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBeUndefined();
    expect(parseStoredHash('argon2id$65536$3$1$AAAA$AAAA')).toBeUndefined();
  });
});
