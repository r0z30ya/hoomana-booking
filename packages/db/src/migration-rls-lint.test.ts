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

/**
 * Security test S1 (extended) — migration lint for the platform role's privileges
 * (ADR-0003 D5, amended 2026-10-08).
 *
 * The least-privilege narrowing lives in migration
 * `20261008000002_platform_least_privilege`. That migration fixes the live
 * database, but it cannot stop a *future* migration from re-introducing the
 * blanket grant — which is exactly how the over-privilege arose. This block is
 * the source-level guard, and it needs no database, so it runs everywhere:
 *
 *   - no migration may grant `hmn_platform` a write privilege;
 *   - no migration may use the schema-wide `ON ALL TABLES` form for it;
 *   - no migration may give it access to `_prisma_migrations` (migrator-only, D7);
 *   - no migration may grant `SUPERUSER` or `BYPASSRLS` to any application role.
 *
 * The *effective* privileges in a live database are audited separately by
 * `platform-least-privilege.integration.test.ts` (S9). The two layers mirror the
 * D1 principle: a source rule and a live-database assertion, with different
 * failure modes.
 */
const PLATFORM_ROLE = 'hmn_platform';
const LEAST_PRIVILEGE_MIGRATION = '20261008000002_platform_least_privilege';
const MIGRATION_BOOKKEEPING_TABLE = '_prisma_migrations';
const WRITE_PRIVILEGES = new Set([
  'insert',
  'update',
  'delete',
  'truncate',
  'all',
  'all privileges',
]);

function migrationDirectories(): Array<{ name: string; path: string }> {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const path = join(migrationsDir, entry.name, 'migration.sql');
      return existsSync(path) ? [{ name: entry.name, path }] : [];
    });
}

/** Every model table declared in schema.prisma, by SQL name (`@@map` aware). */
function modelTables(): Set<string> {
  const schema = readFileSync(schemaPath, 'utf8');
  const tables = new Set<string>();
  for (const match of schema.matchAll(/model\s+(\w+)\s*\{([^}]*)\}/gs)) {
    const model = match[1];
    const body = match[2];
    if (model === undefined || body === undefined) continue;
    tables.add(body.match(/@@map\("([^"]+)"\)/)?.[1] ?? model);
  }
  return tables;
}

/**
 * Remove SQL comments before statement parsing.
 *
 * This is load-bearing, not cosmetic: the narrowing migration's header *quotes* the
 * historical offending statement (`GRANT ... ON ALL TABLES ... TO hmn_platform`) in
 * order to document what it corrects. A parser that reads comments as SQL would flag
 * that quotation as a live grant. Comments must therefore be stripped first, which
 * also makes the lint correct for any future migration that quotes SQL in a comment.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n\r]*/g, '');
}

/**
 * Extract privileged statements from comment-free SQL. Statements may span lines
 * (none do today), so the pattern runs to the terminating semicolon.
 */
function statementsMatching(sql: string, keyword: RegExp): string[] {
  return [...stripSqlComments(sql).matchAll(keyword)]
    .map((match) => match[0].trim())
    .filter((statement) => statement !== '');
}

/**
 * Guards against the lint silently passing because its regexes stopped matching
 * (e.g. after a refactor). Each pattern is asserted against a representative
 * statement, so a broken parser fails loudly instead of vacuously succeeding.
 */
const PARSER_SELFTEST = 'GRANT SELECT, INSERT ON "domains" TO hmn_platform';

describe('S1 — migration lint: the platform-privilege parser itself works', () => {
  it('parses privileges, targets and grantees out of a GRANT statement', () => {
    expect(privilegeListOf(PARSER_SELFTEST)).toEqual(['select', 'insert']);
    expect(targetsOf(PARSER_SELFTEST).map((target) => target.replace(/"/g, ''))).toEqual([
      'domains',
    ]);
    expect(granteesOf(PARSER_SELFTEST)).toEqual(['hmn_platform']);
  });

  it('strips line and block comments so a quoted statement is not mistaken for a live one', () => {
    const quoted = [
      '-- GRANT INSERT ON "domains" TO hmn_platform',
      '/* REVOKE ALL ON "domains" FROM hmn_platform */',
      'REVOKE UPDATE ON "domains" FROM hmn_platform;',
    ].join('\n');

    const grants = statementsMatching(quoted, /GRANT\b[^;]*/gi);
    expect(grants).toEqual([]);
    expect(statementsMatching(quoted, /REVOKE\b[^;]*/gi)).toEqual([
      'REVOKE UPDATE ON "domains" FROM hmn_platform',
    ]);
  });
});

function privilegeListOf(statement: string): string[] {
  const match = /^(?:GRANT|REVOKE)\s+(.+?)\s+ON\s+/i.exec(statement);
  return (match?.[1] ?? '')
    .toLowerCase()
    .split(/\s*,\s*/)
    .map((privilege) => privilege.trim());
}

function targetsOf(statement: string): string[] {
  const match = /^(?:GRANT|REVOKE)\s+.+?\s+ON\s+(.+?)\s+(?:TO|FROM)\s+/i.exec(statement);
  return (match?.[1] ?? '').split(/\s*,\s*/).map((target) => target.trim());
}

function granteesOf(statement: string): string[] {
  const match = /\s(?:TO|FROM)\s+(.+)$/i.exec(statement);
  return (match?.[1] ?? '')
    .split(/\s*,\s*/)
    .map((grantee) => grantee.trim().replace(/"/g, '').toLowerCase());
}

describe('S1 — migration lint: platform-role privileges stay least-privilege (ADR-0003 D5)', () => {
  const migrations = migrationDirectories();

  it('the least-privilege narrowing migration is present', () => {
    expect(migrations.map((migration) => migration.name)).toContain(LEAST_PRIVILEGE_MIGRATION);
  });

  it('no migration from the narrowing migration onward re-grants hmn_platform a write, schema-wide, or bookkeeping privilege', () => {
    // The blanket grant sits in the historical `..._init_phase3_foundation`
    // migration, which is already applied and must never be rewritten
    // (forward-only history). It is superseded by the narrowing migration, whose
    // completeness is verified by the next test rather than assumed. From the
    // narrowing migration onward, the rule is absolute.
    const guarded = migrations.filter((migration) => migration.name >= LEAST_PRIVILEGE_MIGRATION);
    expect(guarded.length).toBeGreaterThan(0);

    const violations: string[] = [];

    for (const migration of guarded) {
      const sql = readFileSync(migration.path, 'utf8');

      for (const statement of statementsMatching(sql, /GRANT\b[^;\n]*/gi)) {
        if (!granteesOf(statement).includes(PLATFORM_ROLE)) continue;

        const writePrivileges = privilegeListOf(statement).filter((privilege) =>
          WRITE_PRIVILEGES.has(privilege),
        );
        if (writePrivileges.length > 0) {
          violations.push(
            `${migration.name}: write privilege (${writePrivileges.join(', ')}) granted to ${PLATFORM_ROLE}: ${statement}`,
          );
        }

        const targets = targetsOf(statement);
        if (targets.some((target) => /\ball\s+tables\b/i.test(target))) {
          violations.push(
            `${migration.name}: schema-wide "ON ALL TABLES" grant to ${PLATFORM_ROLE} — use explicit per-table grants: ${statement}`,
          );
        }
        if (targets.some((target) => target.includes(MIGRATION_BOOKKEEPING_TABLE))) {
          violations.push(
            `${migration.name}: grant on ${MIGRATION_BOOKKEEPING_TABLE} to ${PLATFORM_ROLE} — migrator-only (ADR-0003 D7): ${statement}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('the narrowing migration revokes the historical blanket grant completely, per table (supersession is verified, not assumed)', () => {
    // The historical `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA
    // public TO hmn_platform` ran BEFORE any table existed, so PostgreSQL recorded
    // no direct table grants from it and no default ACL. The revokes therefore had
    // to name every table explicitly. This test proves they cover the full grant.
    const narrowing = migrations.find((migration) => migration.name === LEAST_PRIVILEGE_MIGRATION);
    expect(narrowing).toBeDefined();
    const sql = readFileSync(narrowing!.path, 'utf8');

    const revokes = statementsMatching(sql, /REVOKE\b[^;\n]*/gi).filter((statement) =>
      granteesOf(statement).includes(PLATFORM_ROLE),
    );

    const revokedFor = (table: string): Set<string> => {
      const privileges = new Set<string>();
      for (const statement of revokes) {
        if (!targetsOf(statement).some((target) => target.replace(/"/g, '') === table)) continue;
        for (const privilege of privilegeListOf(statement)) privileges.add(privilege);
      }
      return privileges;
    };

    // Every application table that existed when the blanket grant ran loses the
    // write privileges it gave. That set is the tables created by migrations up to
    // and including the narrowing migration: tables added later never received the
    // grant (it ran before they existed), and the migration history is
    // append-only, so demanding revokes for future tables would fail forever.
    const tables = [
      ...new Set(
        migrationDirectories()
          .filter((migration) => migration.name <= LEAST_PRIVILEGE_MIGRATION)
          .flatMap((migration) => [...tablesCreatedIn(readFileSync(migration.path, 'utf8'))]),
      ),
    ];
    expect(tables.length).toBeGreaterThan(0);

    // Those tables must still be modelled: if a model were deleted while its table
    // stayed, the revoke check below would silently stop covering it.
    const modelled = modelTables();
    for (const table of tables) {
      expect(modelled.has(table), `schema.prisma no longer models "${table}"`).toBe(true);
    }
    for (const table of tables) {
      const privileges = revokedFor(table);
      for (const write of ['insert', 'update', 'delete']) {
        expect(
          privileges.has(write),
          `the narrowing migration must revoke ${write.toUpperCase()} on "${table}" from ${PLATFORM_ROLE}`,
        ).toBe(true);
      }
    }

    // Migration bookkeeping loses everything, including its read.
    const bookkeeping = revokedFor(MIGRATION_BOOKKEEPING_TABLE);
    for (const privilege of ['select', 'insert', 'update', 'delete']) {
      expect(
        bookkeeping.has(privilege),
        `the narrowing migration must revoke ${privilege.toUpperCase()} on ${MIGRATION_BOOKKEEPING_TABLE} from ${PLATFORM_ROLE}`,
      ).toBe(true);
    }

    // Reads on application tables are intentionally KEPT (the audited platform
    // path and security test S7 need them): the narrowing migration must not have
    // used the table-wide `ALL` form, which would have removed SELECT too.
    for (const statement of revokes) {
      expect(
        /\bALL\b/i.test(statement),
        `the narrowing migration must revoke named privileges, not ALL: ${statement}`,
      ).toBe(false);
    }
  });

  it('no migration grants SUPERUSER or BYPASSRLS to any application role', () => {
    const violations: string[] = [];

    for (const migration of migrations) {
      const sql = readFileSync(migration.path, 'utf8');

      for (const statement of statementsMatching(sql, /ALTER\s+ROLE\b[^;\n]*/gi)) {
        if (!/hmn_/i.test(statement)) continue;
        if (/\bSUPERUSER\b/i.test(statement) || /\bBYPASSRLS\b/i.test(statement)) {
          violations.push(`${migration.name}: ${statement}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
