import { loadEnvironment } from '@hmn/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { checkDatabase, createDatabaseClient } from './database.js';

const environment = loadEnvironment();
const client = createDatabaseClient({ connectionString: environment.DATABASE_URL });

afterAll(async () => {
  await client.$disconnect();
});

describe('database connectivity', () => {
  it('reports a reachable PostgreSQL instance and runs a real query', async ({ skip }) => {
    const probe = await checkDatabase(client, 5_000);

    if (probe.status !== 'ok') {
      skip(
        `PostgreSQL unreachable at ${new URL(environment.DATABASE_URL).host} (${probe.error ?? 'unknown'}). Run \`npm run infra:up\`.`,
      );
      return;
    }

    expect(probe.dependency).toBe('database');
    expect(probe.latencyMs).toBeGreaterThanOrEqual(0);

    const rows = await client.$queryRaw<Array<{ answer: number }>>`SELECT 1 AS answer`;

    expect(rows[0]?.answer).toBe(1);
  });

  it('reports the server version so a mismatch is visible', async ({ skip }) => {
    const probe = await checkDatabase(client, 5_000);
    if (probe.status !== 'ok') {
      skip('PostgreSQL unreachable — run `npm run infra:up`.');
      return;
    }

    const rows = await client.$queryRaw<Array<{ version: string }>>`SELECT version() AS version`;

    expect(rows[0]?.version).toMatch(/^PostgreSQL /);
  });
});

describe('phase 2 scope guard', () => {
  it('creates no application tables — the schema is deliberately model-free', async ({ skip }) => {
    const probe = await checkDatabase(client, 5_000);
    if (probe.status !== 'ok') {
      skip('PostgreSQL unreachable — run `npm run infra:up`.');
      return;
    }

    const tables = await client.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;

    const tableNames = tables.map((table) => table.table_name);

    // These belong to Phase 3+. If one appears, an entity was added before review.
    for (const forbidden of [
      'users',
      'tenants',
      'tenant_memberships',
      'subscription_plans',
      'tenant_subscriptions',
      'domains',
      'audit_logs',
    ]) {
      expect(tableNames).not.toContain(forbidden);
    }
  });
});
