import { describe, expect, it } from 'vitest';
import { environmentSchema } from './env.js';

const validInput = {
  DATABASE_URL: 'postgresql://hmn:secret@127.0.0.1:5432/hmn_saas?schema=public',
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
});
