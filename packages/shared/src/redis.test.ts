import { afterAll, describe, expect, it } from 'vitest';
import { loadEnvironment } from './env.js';
import { checkRedis, createRedisClient } from './redis.js';

/**
 * Queue-specific connection options are tested in apps/worker, where BullMQ is a
 * dependency. This package stays limited to the generic client and probe.
 */
const environment = loadEnvironment();
const client = createRedisClient({ url: environment.REDIS_URL });

afterAll(() => {
  client.disconnect();
});

describe('createRedisClient', () => {
  it('does not connect eagerly, so startup never blocks on Redis', () => {
    expect(client.status).toBe('wait');
  });
});

describe('redis connectivity', () => {
  it('reports the live Redis instance as reachable', async ({ skip }) => {
    const probe = await checkRedis(client, 3_000);

    if (probe.status !== 'ok') {
      skip(
        `Redis unreachable at ${environment.REDIS_URL} (${probe.error ?? 'unknown'}). Run \`npm run infra:up\`.`,
      );
      return;
    }

    expect(probe.dependency).toBe('redis');
    expect(probe.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
