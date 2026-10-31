import { describe, expect, it } from 'vitest';
import { buildRedisConnectionOptions } from './connection.js';

describe('buildRedisConnectionOptions', () => {
  it('parses host and port', () => {
    expect(buildRedisConnectionOptions('redis://127.0.0.1:6380')).toMatchObject({
      host: '127.0.0.1',
      port: 6380,
    });
  });

  it('defaults to port 6379 when the URL omits it', () => {
    expect(buildRedisConnectionOptions('redis://cache.internal')).toMatchObject({ port: 6379 });
  });

  it('disables the retry ceiling, which BullMQ requires', () => {
    // Without this, queued work would be abandoned when a command hits the retry limit.
    expect(buildRedisConnectionOptions('redis://127.0.0.1:6379').maxRetriesPerRequest).toBeNull();
  });

  it('extracts credentials and the database index', () => {
    const options = buildRedisConnectionOptions('redis://app:s3cret@127.0.0.1:6379/3');

    expect(options).toMatchObject({ username: 'app', password: 's3cret', db: 3 });
  });

  it('url-decodes credentials so special characters survive a round trip', () => {
    const options = buildRedisConnectionOptions('redis://app:p%40ss%3Aword@127.0.0.1:6379');

    expect(options.password).toBe('p@ss:word');
  });

  it('omits credential and database keys entirely when absent', () => {
    const options = buildRedisConnectionOptions('redis://127.0.0.1:6379');

    expect(options).not.toHaveProperty('username');
    expect(options).not.toHaveProperty('password');
    expect(options).not.toHaveProperty('db');
  });

  it('enables TLS for rediss:// URLs and leaves it off otherwise', () => {
    expect(buildRedisConnectionOptions('rediss://cache.internal:6380').tls).toEqual({});
    expect(buildRedisConnectionOptions('redis://127.0.0.1:6379')).not.toHaveProperty('tls');
  });

  it('rejects a malformed URL rather than producing a broken connection', () => {
    expect(() => buildRedisConnectionOptions('not-a-url')).toThrow();
  });
});
