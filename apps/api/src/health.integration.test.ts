import { checkDatabase, createDatabaseClient } from '@hmn/db';
import { checkRedis, createLogger, createRedisClient, loadEnvironment } from '@hmn/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

type ApiServer = ReturnType<typeof buildServer>;

/**
 * Integration coverage: the health endpoints against the real Docker Compose stack.
 *
 * When a dependency is unreachable the test skips with an explicit reason instead of
 * failing, so "infra not started" is distinguishable from "endpoint broken".
 */
const environment = loadEnvironment();

const logger = createLogger({
  name: 'hmn-api-integration',
  level: 'silent',
  environment: 'test',
});

const database = createDatabaseClient({ connectionString: environment.DATABASE_URL });
const redis = createRedisClient({ url: environment.REDIS_URL });

let server: ApiServer | undefined;

function integrationServer(): ApiServer {
  server ??= buildServer({
    logger,
    exposeDependencyErrors: true,
    health: {
      database: () => checkDatabase(database),
      redis: () => checkRedis(redis),
    },
  });

  return server;
}

afterAll(async () => {
  if (server !== undefined) await server.close();
  await database.$disconnect();
  redis.disconnect();
});

describe('live health endpoints', () => {
  it('GET /health returns the liveness contract', async () => {
    const response = await integrationServer().inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/db returns 200 against the real database', async ({ skip }) => {
    const probe = await checkDatabase(database, 5_000);
    if (probe.status !== 'ok') {
      skip(`PostgreSQL unreachable (${probe.error ?? 'unknown'}). Run \`npm run infra:up\`.`);
      return;
    }

    const response = await integrationServer().inject({ method: 'GET', url: '/health/db' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', dependency: 'database' });
  });

  it('GET /health/redis returns 200 against the real Redis', async ({ skip }) => {
    const probe = await checkRedis(redis, 5_000);
    if (probe.status !== 'ok') {
      skip(`Redis unreachable (${probe.error ?? 'unknown'}). Run \`npm run infra:up\`.`);
      return;
    }

    const response = await integrationServer().inject({ method: 'GET', url: '/health/redis' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', dependency: 'redis' });
  });
});
