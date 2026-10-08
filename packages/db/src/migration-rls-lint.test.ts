import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Security test S1 (ADR-0003 Phase 3 security test plan, D7): migration lint.
 *
 * Prisma cannot declare RLS in the schema, so policies are versioned migration
 * SQL. The invariant enforced here: every tenant-owned table must be created,
 * get `ENABLE ROW LEVEL SECURITY`, and get a fail-closed policy (ADR-0003 D6
 * form) **in the same migration file** — no tenant-owned table can ever exist
 * in any environment without RLS, because the migration that creates it is the
 * same one that protects it.
 *
 * Tenant-owned tables are derived from schema.prisma (every model carrying a
 * `tenantId` field) rather than hardcoded, so future tables are covered
 * automatically the moment they gain a `tenantId`.
 */

const migrationsDir = fileURLToPath(new URL('../prisma/migrations', import.meta.url));
const schemaPath = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));

/** Tables whose schema.prisma model carries a `tenantId` field, by SQL name. */
function tenantOwnedTables(): Set<string> {
  const schema = readFileSync(schemaPath, 'utf8');
  const tables = new Set<string>();
  for (const match of schema.matchAll(/model\s+(\w+)\s*\{([^}]*)\}/gs)) {
    const model = match[1];
    const body = match[2];
    if (model === undefined || body === undefined || !/\btenantId\b/.test(body)) continue;
    tables.add(body.match(/@@map\("([^"]+)"\)/)?.[1] ?? model);
  }
  return tables;
}

/** Tables created by a migration file, by quoted SQL name. */
function tablesCreatedIn(sql: string): Set<string> {
  return new Set(
    [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined),
  );
}

/** The full `CREATE POLICY ... ON "<table>"` statement, up to its semicolon. */
function policyStatementFor(sql: string, table: string): string | undefined {
  const start = sql.search(new RegExp(`CREATE\\s+POLICY[^;]*ON\\s+"${table}"`, 'i'));
  if (start === -1) return undefined;
  const end = sql.indexOf(';', start);
  return end === -1 ? undefined : sql.slice(start, end);
}

describe('S1 — migration lint: tenant tables are born under RLS (ADR-0003 D6/D7)', () => {
  const tenantTables = tenantOwnedTables();

  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const path = join(migrationsDir, entry.name, 'migration.sql');
      return existsSync(path) ? [{ name: entry.name, path }] : [];
    });

  it('derives a non-empty tenant-owned table set from schema.prisma (parse sanity)', () => {
    // If schema parsing ever silently yields nothing, every later assertion
    // would pass vacuously — fail loudly instead.
    expect(tenantTables.size).toBeGreaterThan(0);
    expect(tenantTables).toContain('tenant_memberships');
  });

  it('finds at least one migration file to lint', () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  it('every tenant-owned table gets ENABLE RLS + fail-closed policy in its creating migration', () => {
    const protectedSomewhere = new Set<string>();

    for (const migration of migrations) {
      const sql = readFileSync(migration.path, 'utf8');

      for (const table of tablesCreatedIn(sql)) {
        if (!tenantTables.has(table)) continue;
        protectedSomewhere.add(table);

        const enabled = new RegExp(
          `ALTER\\s+TABLE\\s+"${table}"\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
          'i',
        ).test(sql);
        if (!enabled) {
          throw new Error(
            `${migration.name}: tenant table "${table}" is created without ENABLE ROW LEVEL SECURITY in the same migration`,
          );
        }

        const policy = policyStatementFor(sql, table);
        if (policy === undefined) {
          throw new Error(
            `${migration.name}: tenant table "${table}" is created without a tenant_isolation policy`,
          );
        }
        if (!/USING\s*\(/i.test(policy) || !/WITH\s+CHECK\s*\(/i.test(policy)) {
          throw new Error(
            `${migration.name}: policy on "${table}" must define both USING and WITH CHECK (reads and writes both fail closed)`,
          );
        }
        if (!policy.includes("current_setting('app.current_tenant_id', true)")) {
          throw new Error(
            `${migration.name}: policy on "${table}" must compare against the transaction-local context current_setting('app.current_tenant_id', true)`,
          );
        }
      }
    }

    expect(
      [...tenantTables].filter((table) => !protectedSomewhere.has(table)),
      'tenant-owned tables never protected by any migration',
    ).toEqual([]);
  });
});
