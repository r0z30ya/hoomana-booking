import { probeDependency, type HealthProbeResult } from '@hmn/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export interface DatabaseConfig {
  readonly connectionString: string;
}

/**
 * Build a Prisma client.
 *
 * Prisma 7 is Rust-free: the query compiler runs in-process and the database
 * connection is supplied through a driver adapter rather than a `url` in the schema.
 * PostgreSQL therefore connects via `@prisma/adapter-pg`.
 *
 * A factory rather than a module-level singleton: the caller owns the lifecycle, which
 * is what lets tests build isolated clients and lets the API shut its pool down in an
 * orderly way.
 */
export function createDatabaseClient(config: DatabaseConfig): PrismaClient {
  const adapter = new PrismaPg({ connectionString: config.connectionString });

  return new PrismaClient({ adapter });
}

/**
 * Verify the database answers a real query.
 *
 * `SELECT 1` is used rather than a model query because Phase 2 declares no models;
 * this exercises connection, authentication and the query path without depending on
 * any entity existing. Probe failures are reported as a health state, never thrown.
 */
export async function checkDatabase(
  client: PrismaClient,
  timeoutMs = 2_000,
): Promise<HealthProbeResult> {
  return probeDependency(
    'database',
    async () => {
      await client.$queryRaw`SELECT 1`;
    },
    timeoutMs,
  );
}

/** Close the pool. Safe to call more than once. */
export async function disconnectDatabase(client: PrismaClient): Promise<void> {
  await client.$disconnect();
}
