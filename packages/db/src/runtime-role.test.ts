import { ConfigurationError, loadEnvironment } from '@hmn/shared';
import { describe, expect, it } from 'vitest';
import { checkDatabase, createDatabaseClient } from './database.js';
import { validateRuntimeDatabaseRole } from './runtime-role.js';

/**
 * Security test S8 (ADR-0003 Phase 3 security test plan, D7).
 *
 * The validator is exercised against the real PostgreSQL with the real roles,
 * not mocks: feeding it the migration credential must be rejected (the process
 * would otherwise boot with RLS-bypassing table ownership), feeding it the
 * runtime credential must succeed, and an unreachable database must fail
 * closed rather than let an unvalidated process start.
 */

const environment = loadEnvironment();

// Availability probe at module load — the role probes skip (loudly) when
// PostgreSQL is unreachable; the unreachable-endpoint test always runs because
// it asserts a failure and needs no database.
const probeClient = createDatabaseClient({ connectionString: environment.DATABASE_APP_URL });
const dbAvailable = (await checkDatabase(probeClient, 3_000)).status === 'ok';
await probeClient.$disconnect();

describe.skipIf(!dbAvailable)('S8 — runtime credential validator (real roles)', () => {
  it('rejects the migration credential (hmn_migrator) with ConfigurationError', async () => {
    const error = await validateRuntimeDatabaseRole({
      connectionString: environment.DATABASE_URL,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).code).toBe('INVALID_RUNTIME_DB_ROLE');
  });

  it('accepts the runtime credential (hmn_app)', async () => {
    await expect(
      validateRuntimeDatabaseRole({ connectionString: environment.DATABASE_APP_URL }),
    ).resolves.toBeUndefined();
  });
});

describe('S8 — validator fails closed when the database is unreachable', () => {
  it('raises ConfigurationError instead of letting an unvalidated process start', async () => {
    await expect(
      validateRuntimeDatabaseRole(
        { connectionString: 'postgresql://hmn_app:invalid@127.0.0.1:59999/hmn_saas' },
        1_000,
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});
