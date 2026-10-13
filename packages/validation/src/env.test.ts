import { describe, expect, it } from 'vitest';
import { environmentSchema } from './env.js';

const validInput = {
  DATABASE_URL: 'postgresql://hmn_migrator:secret@127.0.0.1:5432/hmn_saas?schema=public',
  DATABASE_APP_URL: 'postgresql://hmn_app:secret@127.0.0.1:5432/hmn_saas?schema=public',
  REDIS_URL: 'redis://127.0.0.1:6379',
};

describe('environmentSchema', () => {
  it('applies development defaults when only the required values are present', () => {
    const parsed = environmentSchema.parse(validInput);

    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.LOG_LEVEL).toBe('info');
    expect(parsed.API_HOST).toBe('127.0.0.1');
    expect(parsed.API_PORT).toBe(3001);
  });

  it('coerces API_PORT from its string form to a number', () => {
    const parsed = environmentSchema.parse({ ...validInput, API_PORT: '4321' });

    expect(parsed.API_PORT).toBe(4321);
    expect(typeof parsed.API_PORT).toBe('number');
  });

  it('rejects a malformed DATABASE_URL', () => {
    const result = environmentSchema.safeParse({ ...validInput, DATABASE_URL: 'not-a-url' });

    expect(result.success).toBe(false);
  });

  it('rejects a missing REDIS_URL', () => {
    const { REDIS_URL: _omitted, ...withoutRedis } = validInput;
    const result = environmentSchema.safeParse(withoutRedis);

    expect(result.success).toBe(false);
  });

  it('rejects an unknown NODE_ENV', () => {
    const result = environmentSchema.safeParse({ ...validInput, NODE_ENV: 'staging' });

    expect(result.success).toBe(false);
  });

  it('rejects a port outside the valid TCP range', () => {
    expect(environmentSchema.safeParse({ ...validInput, API_PORT: '70000' }).success).toBe(false);
    expect(environmentSchema.safeParse({ ...validInput, API_PORT: '0' }).success).toBe(false);
  });

  it('accepts a rediss:// URL so TLS deployments do not need a schema change', () => {
    const result = environmentSchema.safeParse({ ...validInput, REDIS_URL: 'rediss://cache:6379' });

    expect(result.success).toBe(true);
  });

  it('rejects a missing DATABASE_APP_URL — runtime has no fallback to migration credentials', () => {
    const { DATABASE_APP_URL: _omitted, ...withoutAppUrl } = validInput;

    expect(environmentSchema.safeParse(withoutAppUrl).success).toBe(false);
  });

  it('accepts an optional DATABASE_PLATFORM_URL for the audited platform path', () => {
    const result = environmentSchema.safeParse({
      ...validInput,
      DATABASE_PLATFORM_URL:
        'postgresql://hmn_platform:secret@127.0.0.1:5432/hmn_saas?schema=public',
    });

    expect(result.success).toBe(true);
  });

  it('applies the proposed scrypt defaults when no tuning is provided', () => {
    const parsed = environmentSchema.parse(validInput);

    expect(parsed.AUTH_SCRYPT_N).toBe(32_768);
    expect(parsed.AUTH_SCRYPT_R).toBe(8);
    expect(parsed.AUTH_SCRYPT_P).toBe(1);
    expect(parsed.AUTH_SCRYPT_KEYLEN).toBe(64);
    expect(parsed.AUTH_SCRYPT_MAXMEM).toBeUndefined();
  });

  it('rejects scrypt parameters below the hard floors instead of trusting them', () => {
    expect(environmentSchema.safeParse({ ...validInput, AUTH_SCRYPT_N: '1024' }).success).toBe(
      false,
    );
    expect(environmentSchema.safeParse({ ...validInput, AUTH_SCRYPT_R: '1' }).success).toBe(false);
    expect(environmentSchema.safeParse({ ...validInput, AUTH_SCRYPT_P: '0' }).success).toBe(false);
    expect(
      environmentSchema.safeParse({ ...validInput, AUTH_SCRYPT_KEYLEN: '16' }).success,
    ).toBe(false);
  });

  it('boots without the platform SMS panel and defaults the provider name', () => {
    const parsed = environmentSchema.parse(validInput);

    expect(parsed.SMS_PROVIDER).toBe('melipayamak');
    expect(parsed.SMS_MELIPAYAMAK_PANEL_REF).toBeUndefined();
    expect(parsed.SMS_MELIPAYAMAK_SENDER).toBeUndefined();
  });

  it('accepts a valid sender line and rejects a malformed one', () => {
    // No panel credential is written into this file (workspace rule), so the key's
    // `min(16)` rule is exercised through the integration factory tests instead.
    expect(
      environmentSchema.safeParse({ ...validInput, SMS_MELIPAYAMAK_SENDER: '50002710077565' })
        .success,
    ).toBe(true);
    expect(
      environmentSchema.safeParse({ ...validInput, SMS_MELIPAYAMAK_SENDER: 'not-a-number' })
        .success,
    ).toBe(false);
    expect(environmentSchema.safeParse({ ...validInput, SMS_PROVIDER: 'other' }).success).toBe(
      false,
    );
  });
});
