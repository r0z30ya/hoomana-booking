import { InternalError, NotFoundError, ValidationError, createLogger } from '@hmn/shared';
import type { HealthProbeResult } from '@hmn/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, type HealthChecks } from './server.js';

type ApiServer = ReturnType<typeof buildServer>;

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

const logger = createLogger({ name: 'hmn-api-test', level: 'silent', environment: 'test' });

function healthyCheck(dependency: string): () => Promise<HealthProbeResult> {
  return () => Promise.resolve({ dependency, status: 'ok', latencyMs: 3 });
}

function failingCheck(dependency: string): () => Promise<HealthProbeResult> {
  return () =>
    Promise.resolve({ dependency, status: 'error', latencyMs: 7, error: 'connection refused' });
}

let openServers: ApiServer[] = [];

function serverWith(health: Partial<HealthChecks> = {}, exposeDependencyErrors = true): ApiServer {
  const server = buildServer({
    logger,
    exposeDependencyErrors,
    health: {
      database: health.database ?? healthyCheck('database'),
      redis: health.redis ?? healthyCheck('redis'),
    },
  });

  openServers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(openServers.map(async (server) => server.close()));
  openServers = [];
});

describe('GET /health', () => {
  it('returns exactly the liveness contract', async () => {
    const response = await serverWith().inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('stays 200 when dependencies are down, so an outage cannot restart a healthy process', async () => {
    const server = serverWith({
      database: failingCheck('database'),
      redis: failingCheck('redis'),
    });

    const response = await server.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /health/db', () => {
  it('reports ok with latency when the database answers', async () => {
    const response = await serverWith().inject({ method: 'GET', url: '/health/db' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', dependency: 'database', latencyMs: 3 });
  });

  it('returns 503 and names the failing dependency', async () => {
    const server = serverWith({ database: failingCheck('database') });

    const response = await server.inject({ method: 'GET', url: '/health/db' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'error',
      dependency: 'database',
      error: 'connection refused',
    });
  });

  it('suppresses dependency error text when errors are not exposed', async () => {
    const server = serverWith({ database: failingCheck('database') }, false);

    const response = await server.inject({ method: 'GET', url: '/health/db' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', dependency: 'database', latencyMs: 7 });
  });

  it('does not report the redis state on the database endpoint', async () => {
    const server = serverWith({ redis: failingCheck('redis') });

    const response = await server.inject({ method: 'GET', url: '/health/db' });

    expect(response.statusCode).toBe(200);
  });
});

describe('GET /health/redis', () => {
  it('reports ok with latency when Redis answers', async () => {
    const response = await serverWith().inject({ method: 'GET', url: '/health/redis' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', dependency: 'redis', latencyMs: 3 });
  });

  it('returns 503 and names the failing dependency', async () => {
    const server = serverWith({ redis: failingCheck('redis') });

    const response = await server.inject({ method: 'GET', url: '/health/redis' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'error', dependency: 'redis' });
  });
});

describe('error handling', () => {
  it('maps an AppError subclass to its status code and code', async () => {
    const server = serverWith();
    server.get('/__test/missing', () => {
      throw new NotFoundError('patient missing');
    });

    const response = await server.inject({ method: 'GET', url: '/__test/missing' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'patient missing' },
    });
  });

  it('includes structured details when the error carries them', async () => {
    const server = serverWith();
    server.get('/__test/validation', () => {
      throw new ValidationError('invalid body', { details: { field: 'email' } });
    });

    const response = await server.inject({ method: 'GET', url: '/__test/validation' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'invalid body', details: { field: 'email' } },
    });
  });

  it('hides the message of a non-exposing 5xx error', async () => {
    const server = serverWith();
    server.get('/__test/internal', () => {
      throw new InternalError('secret stack detail');
    });

    const response = await server.inject({ method: 'GET', url: '/__test/internal' });
    const body = response.json<ErrorBody>();

    expect(response.statusCode).toBe(500);
    expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(JSON.stringify(body)).not.toContain('secret stack detail');
  });

  it('never leaks an unexpected error message to the client', async () => {
    const server = serverWith();
    server.get('/__test/unexpected', () => {
      throw new Error('password=hunter2 connecting to 10.0.0.5');
    });

    const response = await server.inject({ method: 'GET', url: '/__test/unexpected' });
    const body = response.json<ErrorBody>();

    expect(response.statusCode).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });

  it('returns a coded 404 for an unknown route', async () => {
    const response = await serverWith().inject({ method: 'GET', url: '/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Cannot GET /does-not-exist' },
    });
  });
});
