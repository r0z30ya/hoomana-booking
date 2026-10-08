import { ConfigurationError } from '@hmn/shared';
import { Pool } from 'pg';

/**
 * Runtime credential validation (ADR-0003 D7).
 *
 * The API and worker must connect as `hmn_app` — a non-owner role that is
 * unconditionally subject to RLS. The migration role `hmn_migrator` owns the
 * tables and can bypass RLS via ownership, so its credentials must never reach
 * runtime configuration. Rather than trusting variable names, the process
 * connects and asks the database what it actually is:
 *
 *   (a) `current_user` must not be `hmn_migrator`;
 *   (b) the runtime role must hold NO CREATE privilege on the `public` schema
 *       (an owner or superuser would have both, and both break isolation).
 *
 * Either check failing raises `ConfigurationError`, which stops the process at
 * boot — misconfiguration fails closed here instead of into a data leak later
 * (security test S8).
 */
const MIGRATOR_ROLE = 'hmn_migrator';

export async function validateRuntimeDatabaseRole(
  config: { readonly connectionString: string },
  timeoutMs = 5_000,
): Promise<void> {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: 1,
    connectionTimeoutMillis: timeoutMs,
  });

  try {
    const result = await pool.query<{
      current_user: string;
      can_create: boolean;
    }>(
      "SELECT current_user AS current_user, has_schema_privilege(current_user, 'public', 'CREATE') AS can_create",
    );

    const row = result.rows[0];

    if (row === undefined) {
      throw new ConfigurationError(
        'Runtime database credential validation failed: no identity returned',
        { code: 'INVALID_RUNTIME_DB_ROLE' },
      );
    }

    if (row.current_user === MIGRATOR_ROLE) {
      throw new ConfigurationError(
        'Runtime database credentials use the migration role — refusing to start',
        { code: 'INVALID_RUNTIME_DB_ROLE', details: { current_user: row.current_user } },
      );
    }

    if (row.can_create) {
      throw new ConfigurationError(
        'Runtime database role must not hold CREATE privilege on schema public — refusing to start',
        { code: 'INVALID_RUNTIME_DB_ROLE', details: { current_user: row.current_user } },
      );
    }
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError('Runtime database credential validation could not connect', {
      code: 'INVALID_RUNTIME_DB_ROLE',
      cause: error,
    });
  } finally {
    await pool.end();
  }
}
