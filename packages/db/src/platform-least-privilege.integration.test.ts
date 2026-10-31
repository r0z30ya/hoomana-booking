import { loadEnvironment } from '@hmn/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { checkDatabase, createDatabaseClient } from './database.js';

/**
 * Security test S9 (ADR-0003 D5, amended 2026-10-08) — least-privilege audit of the
 * platform role, plus a live-database assertion of the RLS/policy invariants.
 *
 * Two independent guarantees are checked against the real PostgreSQL, connecting as
 * the least-privilege runtime role `hmn_app`:
 *
 * 1. **Effective privileges.** `hmn_platform` must hold SELECT-only on the
 *    application tables — except the ADR-0004 fenced identity-secret tables
 *    (`credentials`, `sessions`, `platform_mfa_factors`), where it must hold nothing
 *    at all — and nothing at all on `_prisma_migrations`. The previous
 *    state (a blanket `GRANT ... ON ALL TABLES`, which had put INSERT/UPDATE/DELETE
 *    on every table and handed the platform role read access to the migration
 *    bookkeeping table) is exactly what migration
 *    `20261008000002_platform_least_privilege` removes; this test is what keeps it
 *    removed.
 *
 * 2. **RLS invariants are defined, not accidental.** Which tables must be protected
 *    is derived from `schema.prisma` (any model carrying `tenantId`), so a future
 *    tenant-owned table cannot slip through; the *effective* policy expression is
 *    read from `pg_policy` and must contain the NULLIF empty-context safeguard
 *    (ADR-0003 D6) on both USING and WITH CHECK. This complements the offline
 *    source lint (S1) and the behavioural tests (S2–S5): those prove behaviour,
 *    this proves the definition the database is actually enforcing.
 *
 * Deliberate design note: the table list for the privilege audit is derived from the
 * database itself (`pg_class`, live, no ordering assumption — this is what catches an
 * unexpected extra table), while the *expected* privilege shape is derived from
 * `schema.prisma` (any model carrying `tenantId`). The two sources cross-check each
 * other, so neither can drift silently.
 *
 * Every probe is a parameterized SQL PREPARE/EXECUTE ($1/$2/$3) because Prisma's
 * tagged templates cannot carry catalogue object names as bound parameters.
 */

const environment = loadEnvironment();
const app = createDatabaseClient({ connectionString: environment.DATABASE_APP_URL });

// Availability probe at module load — the tests skip loudly (with the reason) when
// PostgreSQL is unreachable; they never silently pass.
const probe = await checkDatabase(app, 3_000);
const dbAvailable = probe.status === 'ok';

interface TableRow {
  readonly tableName: string;
}

interface PrivilegeRow {
  readonly allowed: boolean;
}

interface CountRow {
  readonly count: bigint;
}

interface PolicyRow {
  readonly tableName: string;
  readonly policyName: string;
  readonly usingExpression: string | null;
  readonly checkExpression: string | null;
}

interface RoleRow {
  readonly roleName: string;
  readonly isSuperuser: boolean;
  readonly bypassRls: boolean;
}

/**
 * Privileges a platform operator legitimately needs: reads only, so a support or
 * reporting path can read through RLS. Global-table writes are forbidden by D5, and
 * the migration bookkeeping table stays migrator-only (D7).
 */
const PRIVILEGES_TO_AUDIT = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;
const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;
const AUDITED_ROLES = ['hmn_app', 'hmn_platform', 'hmn_migrator'] as const;

async function liveTables(): Promise<string[]> {
  const rows = await app.$queryRaw<TableRow[]>`
    SELECT c.relname AS "tableName"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `;
  return rows.map((row) => row.tableName);
}

/**
 * @returns table names, from schema.prisma, whose model carries a `tenantId`.
 */
function tenantOwnedTablesFromSchema(schema: string): string[] {
  const tables: string[] = [];
  for (const match of schema.matchAll(/model\s+(\w+)\s*\{([^}]*)\}/gs)) {
    const model = match[1];
    const body = match[2];
    if (model === undefined || body === undefined) continue;
    if (!/\btenantId\b/.test(body)) continue;
    tables.push(body.match(/@@map\("([^"]+)"\)/)?.[1] ?? model);
  }
  return tables;
}

describe.skipIf(!dbAvailable)('S9 — platform role holds least privilege (ADR-0003 D5)', () => {
  it('the runtime connection really is the least-privilege role, so the audit is trustworthy', async () => {
    const rows = await app.$queryRaw<Array<{ who: string }>>`SELECT current_user AS who`;
    expect(rows[0]?.who).toBe('hmn_app');

    const owned = await app.$queryRaw<CountRow[]>`
      SELECT count(*) AS count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    `;
    // A non-owner is unconditionally subject to RLS; ownership would be a bypass.
    expect(owned[0]?.count).toBe(0n);
  });

  it('hmn_platform can read every application table (the audited path needs reads)', async () => {
    const schema = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8'),
    );
    const tables = (await liveTables()).filter((table) => table !== '_prisma_migrations');

    // Cross-check: the live application tables are exactly the schema models.
    const modelTables = [...schema.matchAll(/model\s+(\w+)\s*\{([^}]*)\}/gs)]
      .map((match) => match[2]?.match(/@@map\("([^"]+)"\)/)?.[1] ?? match[1])
      .filter((name): name is string => name !== undefined)
      .sort();

    expect(tables.length).toBe(modelTables.length);
    expect([...tables].sort()).toEqual(modelTables);

    // ADR-0004 D-C / A-4 fence (extended 2026-10-13): these identity tables deliberately
    // receive no grant to hmn_platform at all (asserted negatively below), so the audited
    // platform path can never read password hashes, session tokens, MFA secrets, one-time
    // codes, or login-attempt identifiers and IPs.
    const fencedTables = [
      'auth_attempts',
      'auth_otps',
      'credentials',
      'platform_mfa_factors',
      'sessions',
    ];

    for (const table of tables.filter((candidate) => !fencedTables.includes(candidate))) {
      const rows = await app.$queryRaw<PrivilegeRow[]>`
        SELECT has_table_privilege('hmn_platform', 'public.' || quote_ident(${table}), 'SELECT') AS allowed
      `;
      expect(rows[0]?.allowed, `hmn_platform must retain SELECT on ${table}`).toBe(true);
    }

    for (const table of fencedTables) {
      for (const privilege of PRIVILEGES_TO_AUDIT) {
        const rows = await app.$queryRaw<PrivilegeRow[]>`
          SELECT has_table_privilege('hmn_platform', 'public.' || quote_ident(${table}), ${privilege}) AS allowed
        `;
        expect(
          rows[0]?.allowed,
          `hmn_platform must hold no ${privilege} on the ADR-0004 fenced table ${table}`,
        ).toBe(false);
      }
    }
  });

  it('hmn_platform holds no write privilege on ANY table, and nothing at all on the migration bookkeeping table', async () => {
    const tables = await liveTables();
    expect(tables.length).toBeGreaterThan(0);

    const violations: string[] = [];

    for (const table of tables) {
      for (const privilege of PRIVILEGES_TO_AUDIT) {
        const rows = await app.$queryRaw<PrivilegeRow[]>`
          SELECT has_table_privilege('hmn_platform', 'public.' || quote_ident(${table}), ${privilege}) AS allowed
        `;
        if (rows[0]?.allowed !== true) continue;

        if (table === '_prisma_migrations') {
          violations.push(`hmn_platform.${privilege} on _prisma_migrations (migrator-only, D7)`);
          continue;
        }
        if ((WRITE_PRIVILEGES as readonly string[]).includes(privilege)) {
          violations.push(
            `hmn_platform.${privilege} on ${table} (writes are not part of the D5 platform path)`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('hmn_app: SELECT-only on the plan catalogue, SELECT+INSERT on identity tables, DML on tenant and auth tables, fenced from platform tables', async () => {
    // ADR-0005 D-C: self-service registration creates users and tenants, so the
    // runtime role holds INSERT on exactly these two global tables. Everything
    // else on global tables stays SELECT-only.
    const selectOnlyTables = ['subscription_plans'];
    const selectAndInsertTables = ['users', 'tenants'];
    const tenantTables = ['tenant_memberships', 'tenant_subscriptions', 'domains', 'audit_logs'];

    for (const table of selectOnlyTables) {
      const selectRows = await app.$queryRaw<PrivilegeRow[]>`
        SELECT has_table_privilege('hmn_app', 'public.' || quote_ident(${table}), 'SELECT') AS allowed
      `;
      expect(selectRows[0]?.allowed, `hmn_app must read global table ${table}`).toBe(true);

      for (const privilege of WRITE_PRIVILEGES) {
        const rows = await app.$queryRaw<PrivilegeRow[]>`
          SELECT has_table_privilege('hmn_app', 'public.' || quote_ident(${table}), ${privilege}) AS allowed
        `;
        expect(
          rows[0]?.allowed,
          `hmn_app must not hold ${privilege} on global table ${table}`,
        ).toBe(false);
      }
    }

    for (const table of selectAndInsertTables) {
      for (const privilege of ['SELECT', 'INSERT'] as const) {
        const rows = await app.$queryRaw<PrivilegeRow[]>`
          SELECT has_table_privilege('hmn_app', 'public.' || quote_ident(${table}), ${privilege}) AS allowed
        `;
        expect(rows[0]?.allowed, `hmn_app must hold ${privilege} on identity table ${table}`).toBe(
          true,
        );
      }

      // The ADR-0005 boundary: INSERT only. The runtime role never updates or
      // deletes global identity rows — corrections go through the platform path.
      for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE'] as const) {
        const rows = await app.$queryRaw<PrivilegeRow[]>`
          SELECT has_table_privilege('hmn_app', 'public.' || quote_ident(${table}), ${privilege}) AS allowed
        `;
        expect(
          rows[0]?.allowed,
          `hmn_app must not hold ${privilege} on identity table ${table}`,
        ).toBe(false);
      }
    }

    for (const table of tenantTables) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const) {
        const rows = await app.$queryRaw<PrivilegeRow[]>`
          SELECT has_table_privilege('hmn_app', 'public.' || quote_ident(${table}), ${privilege}) AS allowed
        `;
        expect(rows[0]?.allowed, `hmn_app must hold ${privilege} on tenant table ${table}`).toBe(
          true,
        );
      }
    }

    // Phase 4 identity tables (ADR-0004 A-4): global by design yet app-writable,
    // because the auth flows run as the tenant runtime role.
    const appWritableGlobalTables = ['credentials', 'sessions', 'auth_attempts'];
    for (const table of appWritableGlobalTables) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const) {
        const rows = await app.$queryRaw<PrivilegeRow[]>`
          SELECT has_table_privilege('hmn_app', 'public.' || quote_ident(${table}), ${privilege}) AS allowed
        `;
        expect(rows[0]?.allowed, `hmn_app must hold ${privilege} on ${table}`).toBe(true);
      }
    }

    // Platform authority must stay unreachable from the tenant runtime: no grant
    // at all, not even SELECT (ADR-0004 D-A/D-C).
    const appFencedTables = ['platform_admins', 'platform_mfa_factors'];
    for (const table of appFencedTables) {
      for (const privilege of PRIVILEGES_TO_AUDIT) {
        const rows = await app.$queryRaw<PrivilegeRow[]>`
          SELECT has_table_privilege('hmn_app', 'public.' || quote_ident(${table}), ${privilege}) AS allowed
        `;
        expect(
          rows[0]?.allowed,
          `hmn_app must hold no ${privilege} on platform table ${table}`,
        ).toBe(false);
      }
    }
  });

  it('no application role is a superuser, holds BYPASSRLS, or owns tables', async () => {
    // The role list is a fixed constant, so it is inlined: this keeps the probe
    // independent of driver-level array parameter serialization.
    const roles = await app.$queryRaw<RoleRow[]>`
      SELECT rolname AS "roleName", rolsuper AS "isSuperuser", rolbypassrls AS "bypassRls"
      FROM pg_roles
      WHERE rolname IN ('hmn_app', 'hmn_migrator', 'hmn_platform')
      ORDER BY rolname
    `;

    expect(roles.map((role) => role.roleName)).toEqual([...AUDITED_ROLES].sort());

    for (const role of roles) {
      expect(role.isSuperuser, `${role.roleName} must not be a superuser`).toBe(false);
      expect(role.bypassRls, `${role.roleName} must not hold BYPASSRLS`).toBe(false);
    }

    const owners = await app.$queryRaw<Array<{ roleName: string; owned: bigint }>>`
      SELECT r.rolname AS "roleName",
             (SELECT count(*)
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relowner = r.oid) AS owned
      FROM pg_roles r
      WHERE r.rolname IN ('hmn_app', 'hmn_migrator', 'hmn_platform')
      ORDER BY r.rolname
    `;

    for (const row of owners) {
      if (row.roleName === 'hmn_migrator') continue; // the migrator owns tables by design (D2)
      expect(row.owned, `${row.roleName} must not own tables`).toBe(0n);
    }

    // The migrator's ownership is intended, and it is still not a bypass role.
    const migrator = owners.find((row) => row.roleName === 'hmn_migrator');
    expect(migrator?.owned ?? 0n).toBeGreaterThan(0n);
  });

  it('no default privileges exist, so future tables are not silently granted to any role', async () => {
    const rows = await app.$queryRaw<CountRow[]>`SELECT count(*) AS count FROM pg_default_acl`;
    expect(rows[0]?.count).toBe(0n);
  });

  it('every tenant-owned table has RLS enabled and a fail-closed policy with the NULLIF safeguard', async () => {
    const schema = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8'),
    );
    const tenantOwned = tenantOwnedTablesFromSchema(schema);
    expect(tenantOwned.length).toBeGreaterThan(0);

    const stateRows = await app.$queryRaw<Array<{ tableName: string; rlsEnabled: boolean }>>`
      SELECT c.relname AS "tableName", c.relrowsecurity AS "rlsEnabled"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = true
    `;
    const rlsEnabled = new Set(stateRows.map((row) => row.tableName));

    expect([...tenantOwned].filter((table) => !rlsEnabled.has(table))).toEqual([]);

    const policies = await app.$queryRaw<PolicyRow[]>`
      SELECT c.relname AS "tableName",
             p.polname AS "policyName",
             pg_get_expr(p.polqual, p.polrelid) AS "usingExpression",
             pg_get_expr(p.polwithcheck, p.polrelid) AS "checkExpression"
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
      ORDER BY c.relname
    `;

    const violations: string[] = [];

    for (const table of tenantOwned) {
      const policy = policies.find((row) => row.tableName === table);
      if (policy === undefined) {
        violations.push(`${table}: no RLS policy defined`);
        continue;
      }

      // The effective expressions, straight from the catalogue.
      for (const [label, expression] of [
        ['USING', policy.usingExpression],
        ['WITH CHECK', policy.checkExpression],
      ] as const) {
        if (expression === null || expression === undefined) {
          violations.push(`${table}: policy ${policy.policyName} has no ${label} expression`);
          continue;
        }
        // Fail-closed context source (D6).
        if (!expression.includes("current_setting('app.current_tenant_id'")) {
          violations.push(`${table}: ${label} does not read app.current_tenant_id — ${expression}`);
        }
        // NULLIF empty-context safeguard (D6 amendment): without it, the
        // pool-reuse empty-string placeholder throws on the ::uuid cast instead of
        // yielding zero rows.
        if (!expression.includes('NULLIF')) {
          violations.push(
            `${table}: ${label} lacks the NULLIF empty-context safeguard — ${expression}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

afterAll(async () => {
  await app.$disconnect();
});
