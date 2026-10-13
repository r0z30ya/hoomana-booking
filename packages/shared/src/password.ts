import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { ConfigurationError } from './errors.js';

/**
 * Password hashing (ADR-0004 A-3, owner-approved 2026-10-12).
 *
 * `scrypt` from `node:crypto` — zero dependencies, which is why the project chose it
 * over `argon2id` (no native module, so none of the recorded Windows install
 * fragility). The stored value is self-describing (`scrypt$N$r$p$salt$hash`), and
 * that is what makes transparent rehashing possible once the parameters are raised.
 *
 * Two different rule sets apply on purpose:
 *   - writing a hash must never use parameters below the hard floors;
 *   - reading an existing hash must keep working for weaker-but-sane parameters,
 *     otherwise a parameter increase would lock every existing account out.
 * `verifyPassword` reports `needsRehash` so the caller can upgrade on success.
 */
export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keyLen: number;
  readonly maxMem: number;
}

/** Hard floors. The environment schema enforces the same numbers at boot. */
export const SCRYPT_FLOORS = {
  N: 16_384,
  r: 8,
  p: 1,
  keyLen: 32,
} as const;

/**
 * Proposed parameters pending the ADR-0004 A-3 benchmark. `maxMem` is derived, not
 * guessed: scrypt needs roughly `128 * N * r` bytes, and the doubling leaves headroom.
 */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = {
  N: 32_768,
  r: 8,
  p: 1,
  keyLen: 64,
  maxMem: 64 * 1024 * 1024,
};

/** Sanity envelope for values read back from storage (they are attacker-influenced input). */
const SANITY = {
  maxN: 1_048_576,
  maxR: 32,
  maxP: 16,
  minSaltBytes: 8,
  minHashBytes: 16,
  maxHashBytes: 128,
} as const;

const SCRYPT_PREFIX = 'scrypt';
const SALT_BYTES = 16;

/** Base64url of a 16-byte salt; the dummy path only needs a stable, non-secret salt. */
const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 0x5a);

export interface ScryptParamOverrides {
  readonly N?: number;
  readonly r?: number;
  readonly p?: number;
  readonly keyLen?: number;
  readonly maxMem?: number;
}

/** The shape `loadEnvironment()` returns for the AUTH_SCRYPT_* family. */
export interface ScryptEnvironment {
  readonly AUTH_SCRYPT_N: number;
  readonly AUTH_SCRYPT_R: number;
  readonly AUTH_SCRYPT_P: number;
  readonly AUTH_SCRYPT_KEYLEN: number;
  readonly AUTH_SCRYPT_MAXMEM?: number | undefined;
}

function requiredMaxMem(N: number, r: number): number {
  return 128 * N * r;
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

function deriveKey(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      params.keyLen,
      { N: params.N, r: params.r, p: params.p, maxmem: params.maxMem },
      (error, derivedKey) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

/**
 * Reject weak parameters before any hash is produced (defence in depth: the
 * environment schema already refuses to boot with values below these floors).
 */
export function assertScryptParams(params: ScryptParams): void {
  const problems: string[] = [];

  if (!Number.isSafeInteger(params.N) || params.N < SCRYPT_FLOORS.N) {
    problems.push(`N must be an integer >= ${SCRYPT_FLOORS.N}`);
  } else if (!isPowerOfTwo(params.N)) {
    problems.push('N must be a power of two');
  }
  if (!Number.isSafeInteger(params.r) || params.r < SCRYPT_FLOORS.r) {
    problems.push(`r must be an integer >= ${SCRYPT_FLOORS.r}`);
  }
  if (!Number.isSafeInteger(params.p) || params.p < SCRYPT_FLOORS.p) {
    problems.push(`p must be an integer >= ${SCRYPT_FLOORS.p}`);
  }
  if (!Number.isSafeInteger(params.keyLen) || params.keyLen < SCRYPT_FLOORS.keyLen) {
    problems.push(`keyLen must be an integer >= ${SCRYPT_FLOORS.keyLen}`);
  }
  if (!Number.isSafeInteger(params.maxMem) || params.maxMem < requiredMaxMem(params.N, params.r)) {
    problems.push('maxMem is below the 128 * N * r the derivation needs');
  }

  if (problems.length > 0) {
    throw new ConfigurationError(`Invalid scrypt parameters — ${problems.join('; ')}`, {
      code: 'INVALID_SCRYPT_PARAMS',
      details: { N: params.N, r: params.r, p: params.p, keyLen: params.keyLen },
    });
  }
}

/** Merge overrides onto the defaults, derive `maxMem`, and enforce the floors. */
export function scryptParams(overrides: ScryptParamOverrides = {}): ScryptParams {
  const merged: ScryptParams = {
    N: overrides.N ?? DEFAULT_SCRYPT_PARAMS.N,
    r: overrides.r ?? DEFAULT_SCRYPT_PARAMS.r,
    p: overrides.p ?? DEFAULT_SCRYPT_PARAMS.p,
    keyLen: overrides.keyLen ?? DEFAULT_SCRYPT_PARAMS.keyLen,
    maxMem:
      overrides.maxMem ??
      Math.max(2 * requiredMaxMem(overrides.N ?? DEFAULT_SCRYPT_PARAMS.N, overrides.r ?? DEFAULT_SCRYPT_PARAMS.r), DEFAULT_SCRYPT_PARAMS.maxMem),
  };

  assertScryptParams(merged);

  return merged;
}

/** Build the parameters the API should use from a validated environment. */
export function scryptParamsFromEnvironment(environment: ScryptEnvironment): ScryptParams {
  return scryptParams({
    N: environment.AUTH_SCRYPT_N,
    r: environment.AUTH_SCRYPT_R,
    p: environment.AUTH_SCRYPT_P,
    keyLen: environment.AUTH_SCRYPT_KEYLEN,
    ...(environment.AUTH_SCRYPT_MAXMEM === undefined
      ? {}
      : { maxMem: environment.AUTH_SCRYPT_MAXMEM }),
  });
}

interface ParsedHash {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

/**
 * Parse a stored hash. Returns `undefined` for anything malformed or outside the
 * sanity envelope — a stored value is attacker-influenced input, so it is never
 * trusted to drive an unbounded derivation.
 */
export function parseStoredHash(stored: string): ParsedHash | undefined {
  const parts = stored.split('$');
  if (parts.length !== 6) return undefined;

  const [prefix, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  if (prefix !== SCRYPT_PREFIX) return undefined;

  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);

  if (!Number.isSafeInteger(N) || !isPowerOfTwo(N) || N > SANITY.maxN) return undefined;
  if (!Number.isSafeInteger(r) || r < 1 || r > SANITY.maxR) return undefined;
  if (!Number.isSafeInteger(p) || p < 1 || p > SANITY.maxP) return undefined;

  const salt = Buffer.from(saltRaw ?? '', 'base64url');
  const hash = Buffer.from(hashRaw ?? '', 'base64url');

  if (salt.length < SANITY.minSaltBytes) return undefined;
  if (hash.length < SANITY.minHashBytes || hash.length > SANITY.maxHashBytes) return undefined;

  return {
    params: {
      N,
      r,
      p,
      keyLen: hash.length,
      maxMem: Math.max(2 * requiredMaxMem(N, r), DEFAULT_SCRYPT_PARAMS.maxMem),
    },
    salt,
    hash,
  };
}

/** True when `stored` is weaker than the current parameters and should be upgraded. */
function isWeakerThan(stored: ScryptParams, current: ScryptParams): boolean {
  return (
    stored.N < current.N ||
    stored.r < current.r ||
    stored.p < current.p ||
    stored.keyLen < current.keyLen
  );
}

/** Hash a password into the self-describing storage format. */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  assertScryptParams(params);

  const salt = randomBytes(SALT_BYTES);
  const derived = await deriveKey(password, salt, params);

  return [
    SCRYPT_PREFIX,
    String(params.N),
    String(params.r),
    String(params.p),
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export interface VerifyResult {
  readonly matches: boolean;
  readonly needsRehash: boolean;
}

/**
 * Verify a password against a stored hash.
 *
 * Never throws on malformed input: an unknown account and a corrupt stored hash must
 * not be observable. Both run the same derivation, so the response time of "no such
 * account" and "wrong password" stay in the same band (ADR-0004 D-B).
 */
export async function verifyPassword(
  password: string,
  stored: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<VerifyResult> {
  const parsed = parseStoredHash(stored);

  if (parsed === undefined) {
    await dummyVerify(password);
    return { matches: false, needsRehash: false };
  }

  const derived = await deriveKey(password, parsed.salt, parsed.params);
  const matches =
    derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);

  return { matches, needsRehash: matches && isWeakerThan(parsed.params, params) };
}

/**
 * Spend one derivation and discard it, so paths that have nothing to compare against
 * still cost the same as a real comparison.
 */
export async function dummyVerify(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<void> {
  await deriveKey(password, DUMMY_SALT, params);
}
