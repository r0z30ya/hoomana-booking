# ADR-0003 — Tenant isolation: PostgreSQL Row-Level Security with application-level scoping as defense in depth

- **Status:** Accepted (project owner approved 2026-10-08; Phase 3 implemented and security-verified the same day — see the execution record at the end; `hmn_platform` least-privilege follow-up applied the same day as migration `20261008000002_platform_least_privilege`)
- **Date:** 2026-10-08
- **Phase:** Pre-Phase-3 hardening (approved before any business schema exists)
- **Deciders:** Project owner, Lead Developer

## Context

HMN SaaS is a multi-tenant clinic CRM. Tenant boundaries separate unrelated medical
businesses: patients, appointments, invoices and SMS ledgers of clinic A must be
unreadable — and unwritable — from clinic B, even in the presence of an application
bug, a forgotten `WHERE` clause, or a compromised API process. A leak is not an
inconvenience here; it is a regulatory (medical-data) and trust catastrophe.

Application-level scoping alone (every Prisma query manually filtered by `tenant_id`)
is a single point of failure: one missing filter silently returns another tenant's
data. PostgreSQL 17 offers Row-Level Security (RLS), which enforces isolation inside
the database engine regardless of what the application sends.

This ADR defines the isolation model **before** Phase 3 creates any tenant-owned
table, so every future table is born under the policy instead of being retrofitted.
Phase 3 implementation starts only after the project owner approves this document.

Reference framework (from prior decisions): Prisma 7 with `@prisma/adapter-pg`
([database.ts](../../../packages/db/src/database.ts)), migrations via Prisma CLI,
local PostgreSQL 17 in Docker (ADR-0001). The legacy WordPress plugin carries no
isolation worth copying.

## Decisions

### D1 — RLS is the primary isolation boundary; application scoping is defense in depth

**Decision.** Every tenant-owned table gets RLS enabled with a default-deny policy.
The application additionally filters by `tenant_id` (a typed repository layer will
make this the path of least resistance), but correctness never _depends_ on that
filter — the database rejects cross-tenant rows even if application code forgets.

**Why.** Two independent layers with different failure modes. An application bug
(forgotten `WHERE`) is caught by RLS; an RLS misconfiguration (policy typo) is caught
by application tests and code review. Neither layer alone is sufficient for medical
data.

**Alternatives considered.**

- _Application-level filtering only_ — rejected: one forgotten clause in one handler
  leaks tenant data silently; there is no safety net.
- _Schema-per-tenant_ — rejected: thousands of schemas make migrations, connection
  pooling and cross-tenant platform reporting (aggregates for platform owner)
  disproportionately painful; industry practice for this class of SaaS is RLS.
- _Database-per-tenant_ — rejected: operationally infeasible for a clinic CRM with
  platform-level reporting and a small ops team.

### D2 — Three database roles: `hmn_migrator` (owner, DDL), `hmn_app` (runtime), `hmn_platform` (audited platform ops) — none with `BYPASSRLS`

**Decision.** PostgreSQL will have three non-superuser roles:

| Role           | Owns tables? | RLS bypasses? | Used by                                    |
| -------------- | ------------ | ------------- | ------------------------------------------ |
| `hmn_migrator` | Yes          | Yes (owner)   | Prisma CLI migrations, seeding, ops tasks  |
| `hmn_app`      | No           | No            | API, worker — all runtime traffic          |
| `hmn_platform` | No           | No            | Explicitly-marked platform operations only |

- **No runtime role holds `BYPASSRLS`.** Only a superuser-level attribute can
  escape RLS; none of the three application roles is a superuser or carries
  `BYPASSRLS`. `hmn_app` and `hmn_platform` are additionally **non-owners**, so
  they are unconditionally subject to every tenant policy — there is no query,
  setting, or session command they can issue that reads a tenant row their context
  does not authorize.
- `hmn_migrator` owns the tables. Prisma migrations (which need DDL and full data
  access) connect as this role. Ownership deliberately carries RLS-bypass; we accept
  this because migrations run only from controlled CI/ops paths with
  `DATABASE_URL`, never from request handling.
- Table owners get `FORCE ROW LEVEL SECURITY` **not** applied (i.e. RLS is `ENABLED`
  but not `FORCED`): the migrator must be able to backfill and reshape data during
  migrations without faking tenant context. The safety argument is role separation,
  not `FORCE`: the runtime role is a non-owner, and non-owners cannot bypass RLS at
  all.
- Local dev provisions all roles in the Postgres init script
  (`docker-entrypoint-initdb.d/`); connection strings are split into
  `DATABASE_URL` (migrator, CLI) and `DATABASE_APP_URL` (runtime). Startup
  validation rejects migrator credentials in runtime configuration (D7).

**Why not one role.** A single role that both migrates and serves requests means the
request path inherits DDL rights and RLS bypass — precisely the accident this ADR
exists to prevent.

### D3 — Transaction-local tenant context via `set_config(..., is_local => true)`

**Decision.** The tenant identity travels to the database as a custom GUC,
`app.current_tenant_id`, set **only inside a transaction** with
`SELECT set_config('app.current_tenant_id', $1, true)` — the parameterized,
transaction-local form of `SET LOCAL`. The application exposes this exclusively
through one helper (conceptually):

```ts
await withTenantTx(client, tenantId, async (tx) => {
  // every query inside this scope is tenant-scoped by RLS
});
```

which (a) opens a transaction, (b) validates `tenantId` is a UUID, (c) runs
`set_config(..., is_local => true)` as the transaction's first statement, and (d)
runs the caller's queries. Plain `SET` (session-scoped) is forbidden in application
code and reviewed against in code review.

**Why `SET LOCAL` / `set_config(..., true)` rather than a session variable.** The API
and worker use connection pools (Prisma's pool over `@prisma/adapter-pg`). A
session-scoped setting survives the connection's return to the pool, so the next
borrower — a different request, possibly a different tenant — inherits stale tenant
context: a cross-tenant leak by pool reuse. `is_local => true` makes the setting
vanish at `COMMIT`/`ROLLBACK`, so a pooled connection is always returned clean. The
value is bound as a query parameter, so there is no injection surface (in contrast to
string-interpolated `SET`). (PostgreSQL detail: afterwards the custom GUC reads as
the empty string rather than NULL — the D6 policies account for this with `NULLIF`.)

### D4 — Pool safety: tenant-scoped operations must run inside one transaction

**Decision.** RLS policies read `app.current_tenant_id` at statement execution time.
Therefore:

1. Every tenant-scoped query must execute within the same transaction that set the
   context — this is mandatory, not stylistic. The repository layer takes a
   transaction handle as its argument and does not accept a bare client, making the
   unsafe call unrepresentable in normal code.
2. Multi-statement business operations (e.g. "book appointment + bill SMS units")
   use one `withTenantTx` block: consistency _and_ correct context in a single
   construct.
3. Non-tenant-scoped work (health checks, global tables) uses the plain client and
   must never call `set_config` at all — if a query's results depend on tenant
   context, it belongs in `withTenantTx`.
4. **Repository boundary (exact rule).** The `packages/db` client module exports
   the `PrismaClient` type for wiring (API/worker construction, health checks) but
   application modules that touch tenant-owned data must never receive a raw
   client. Concretely:
   - A `TenantTx` type (Prisma's transaction client) is the **only** argument type
     accepted by tenant-scoped repository methods. `TenantTx` is obtainable only
     from `withTenantTx` — it is structurally just a transaction handle, but the
     repository signatures make the unsafe call a type error, not a convention.
   - Tenant-scoped repositories live in dedicated modules (`repositories/*`) that
     do not import or receive `PrismaClient`; the composition root (API/worker
     bootstrap) passes the client into `withTenantTx`, and repositories never see
     it.
   - Platform-level repositories are a **separate module family**
     (`repositories/platform/*`): they operate on non-tenant tables via the plain
     client, or enter tenant data exclusively through an audited `withTenantTx`
     call with an explicitly chosen tenant ID (D5). They must not be importable
     from tenant-facing request handlers (enforced by module placement and ESLint
     boundary rules in Phase 3).

**Why.** `SET LOCAL` outside a transaction is silently promoted to session scope in
some client patterns; a transaction boundary makes the contract explicit and the
pool-reuse hazard structurally impossible. A type-level handle boundary converts
"remember to wrap in a transaction" from code review into a compile error.

### D5 — Platform-owner operations and non-tenant-scoped tables

**Decision.**

- **Non-tenant tables** (`subscription_plans`, and platform-level config) have **no
  RLS** — they are global by definition. They are readable by `hmn_app` via explicit
  grants; writes to global tables from tenant code paths are forbidden by the
  repository layer.
- **Platform-owner access to tenant data** (support, billing disputes, aggregate
  reporting) never uses `hmn_app` and never disables or circumvents RLS.
  `hmn_platform` is a **non-owner, non-`BYPASSRLS` role**: it cannot silently
  bypass tenant policies — the database would return zero rows, same as any other
  context-less session. Legitimate platform access to a tenant's data therefore
  goes through the _same_ transaction-context mechanism as ordinary code
  (`withTenantTx` over a separate `hmn_platform` pool) with the tenant ID chosen
  explicitly per operation and written to `audit_logs` together with the acting
  platform user, the target tenant, and the operation performed, inside the same
  transaction. Isolation of the platform path is procedural (separate module
  family per D4, code review, audit entries), not a database privilege: nothing
  about `hmn_platform` weakens the policy layer, and the audit record is written
  atomically with the data access it describes. Platform _aggregates_ (counts,
  revenue rollups) prefer SQL views/functions marked `SECURITY DEFINER` owned by
  `hmn_migrator`, exposing numbers without exposing rows.
- **Least privilege for `hmn_platform` (amended 2026-10-08; see the third bullet
  for the change and the D5 rationale note below).** The platform role holds
  **`SELECT` only** — on the seven application tables, and **no privilege at all**
  on `_prisma_migrations`. It holds zero write privileges anywhere in `public`.
  This is the minimum consistent with the platform operations D5 describes:
  support and billing investigation are _reads_, and D5 already forbids writes to
  global tables from non-migrator code paths. Read access is kept (rather than
  dropped entirely) because the audited path is a read path, and because dropping
  it would leave no way to exercise D5's mechanism at all — it is what security
  test S7 uses to demonstrate that the audited `withTenantTx` path works over an
  `hmn_platform` pool.
  - The blanket Phase 3 grant
    (`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hmn_platform`)
    exceeded this in two ways. First, it covered `_prisma_migrations`, so an
    operator using the platform connection could read migration history while the
    runtime role is deliberately denied it (S6) — an access path D5 never granted;
    verified live before the fix (3 bookkeeping rows readable as `hmn_platform`,
    `permission denied` as `hmn_app`). Second, `ALL TABLES` was _latent_
    over-privilege: had it run after tables existed it would have materialized
    direct grants on each one, and a later migration that simply forgot to scope
    its grants would have silently widened the role again.
  - **No `SECURITY DEFINER` object was created, deliberately.** A `SECURITY
DEFINER` aggregate function/view owned by `hmn_migrator` would have to be
    written with its own `search_path` discipline, execution grants and test
    coverage, and it is only justified once a real aggregate consumer exists. A
    repository-wide search found `hmn_platform` referenced **only** in this ADR, the
    env examples, the role-provisioning script and the security tests — never in
    application code. Creating such an object now would add privileged, untested
    surface area with no caller. D5's preference for `SECURITY DEFINER` aggregates
    stands as the pattern to adopt when a platform reporting feature first appears,
    and that change must ship with its own migration and tests.
  - **Why narrowing is safe for D5 as written.** D5 says platform access _never
    disables or circumvents RLS_ and that the privilege layer must not be the
    enforcement mechanism. Keeping `SELECT` + RLS satisfies both: every read is
    still filtered by `tenant_isolation`, and a context-less platform session
    still sees zero rows. Nothing in D5 requires the platform role to hold write or
    bookkeeping access.
- **Tenant membership** (`tenant_memberships`) decides which `tenant_id` values a
  user may set as context; the _authorization_ of "may this user act on this tenant"
  happens in the application before `withTenantTx` is entered. RLS answers "which
  rows", the application answers "which tenant is this session allowed to name" —
  conflating them in a policy would require RLS to query `tenant_memberships`
  recursively, which is slower and harder to test.

**Why a separate role instead of a magic tenant ID.** A magic ID (e.g. empty string
= "platform") makes bypass a one-line app bug and pollutes every policy with a
special case. A separate role makes the privilege visible in `pg_roles`, auditable,
and unusable by ordinary request handling even if the app tries.

**Why the platform role's privileges are held to `SELECT`.** A separate role whose
grants are blanket re-creates the same hazard one level down: the role is only as
narrow as its privileges. Because writes are not part of any platform operation D5
describes, and because the migration bookkeeping table is not application data at
all, the enforceable statement of D5 is "`hmn_platform` reads application tables
through RLS and can do nothing else." That is now a test assertion (S9), not a
convention.

### D6 — Fail closed when tenant context is absent

**Decision.** Tenant-table policies have the form (amended 2026-10-08 during Phase 3
security verification — see the second bullet):

```sql
CREATE POLICY tenant_isolation ON <table>
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
```

- `current_setting(..., true)` returns **NULL** (not an error) when the GUC is
  unset. `tenant_id = NULL` evaluates to NULL → row not visible, insert rejected:
  **no context means no rows, both for reads and writes.**
- **Amendment (pool-reuse placeholder).** After a transaction-local `set_config`
  commits, PostgreSQL keeps a session placeholder for the custom GUC that reads as
  the **empty string**, not NULL. The original form (`current_setting(...)::uuid`
  without `NULLIF`) then made every context-less query on that pooled connection
  fail with `invalid input syntax for type uuid: ""` — still fail-closed (no leak),
  but an error instead of zero rows, breaking the S5 contract. `NULLIF(..., '')`
  treats NULL and `''` identically as no-context, restoring the zero-rows contract
  while keeping fail-closed semantics. Applied by migration
  `20261008000001_rls_pool_safe_context`; all future tenant-table policies must use
  this form.
- A malformed (non-UUID) context value makes the cast fail with an error, which also
  fails closed (query errors, never leaks).
- The application independently fails closed: `withTenantTx` throws
  `ForbiddenError`/`ValidationError` if handed a missing or non-UUID tenant ID, and
  API routes are required to resolve tenant context server-side (per the existing
  architecture rule: never trust `tenant_id` from the frontend).

**Why fail closed rather than a platform fallback.** A "no context = see everything
or platform rows" rule converts a missing `set_config` call — the most likely
programming error — into a data leak. Absence of context must be the least-privileged
outcome. Any legitimately context-free access to tenant data belongs to D5's explicit
platform path, which is loud and reviewed, not silent.

### D7 — Migration, testing, and local-development implications

**Decision.**

- **Migrations.** Prisma CLI connects as `hmn_migrator` (owner) and can therefore
  create/alter/seed tables that RLS would otherwise constrain. Phase 3's initial
  migration will create the tables, enable RLS, and attach the policies in the same
  migration, so no table ever exists unprotected. Migration SQL also (re)grants
  runtime privileges to `hmn_app`, keeping role permissions versioned with the
  schema.
- **RLS policies in Prisma schema.** Prisma has no native RLS declaration; policies
  are added as migration SQL. A lint/test step greps generated migrations: any
  `CREATE TABLE` for a tenant-owned table must be followed by `ENABLE ROW LEVEL
SECURITY` and a fail-closed policy (D6 form) in the same file — i.e. **no
  tenant-owned table can exist in any environment without RLS enabled**, because the
  migration that creates the table is the same one that protects it. The lint has a
  second half (added 2026-10-08) that guards the platform role's privileges at the
  source: from migration `20261008000002_platform_least_privilege` onward, no
  migration may grant `hmn_platform` a write privilege, use the schema-wide
  `ON ALL TABLES` form for it, or grant it access to `_prisma_migrations`, and no
  migration may give any `hmn_*` role `SUPERUSER` or `BYPASSRLS`. The historical
  blanket grant in `20261008000000_init_phase3_foundation` is not edited (it is
  already applied and migration history is append-only); its supersession is instead
  _verified_ by the lint, which asserts the narrowing migration revokes
  INSERT/UPDATE/DELETE on every table declared in `schema.prisma` and all four
  privileges on `_prisma_migrations` — so an incomplete narrowing fails the build
  rather than being trusted.
- **Migrator credential isolation.** `DATABASE_URL` (the `hmn_migrator` connection
  string) exists only where the Prisma CLI reads it: `packages/db/prisma.config.ts`
  and the migration/CI environment. It is never placed in the API's or worker's
  environment, never logged, and never part of the runtime compose env for app
  services. At startup, the API and worker **validate their runtime credentials**:
  a startup probe connects and asserts (a) `current_user` is not `hmn_migrator`,
  and (b) the runtime role holds no table-creation privilege
  (`has_schema_privilege(current_user, 'public', 'CREATE') = false`). Either check
  failing raises `ConfigurationError` and the process refuses to start —
  misconfiguration fails closed at boot, not into a data leak later. A unit/integration
  test feeds the migrator URL to the validator and asserts the rejection.
- **Testing.** Integration tests must cover, once Phase 3 lands, the negative
  cases explicitly:
  1. _Missing context_ — a transaction with no `set_config` sees **zero rows** on
     every tenant table (fail-closed proof, reads and writes both).
  2. _Wrong-tenant read_ — tenant A's context sees none of tenant B's rows.
  3. _Wrong-tenant write_ — an `INSERT`/`UPDATE` whose row `tenant_id` differs
     from the session context is rejected by `WITH CHECK`.
  4. _Pool context leakage_ — a transaction sets context for tenant A, commits,
     and the next transaction on the pool (fresh, no `set_config`) sees zero rows:
     proving `is_local => true` returns connections clean.
  5. _Role capability_ — `hmn_app` cannot `CREATE TABLE` and cannot read
     platform-only tables; `hmn_platform` without explicit context sees zero rows
     (no silent bypass).
  6. _Effective least privilege (added 2026-10-08)_ — `hmn_platform` holds `SELECT`
     and nothing else on every application table, and **no** privilege on
     `_prisma_migrations`; `hmn_app` retains SELECT-only on global tables and full
     DML on tenant tables; none of the three roles is a superuser, holds
     `BYPASSRLS`, or (other than `hmn_migrator`) owns a table; `pg_default_acl` is
     empty, so future tables are not silently granted to anyone.

  These run against the real PostgreSQL from `docker compose` (already an
  ADR-0001 deliverable), not mocked. Unit tests of repository code inject an
  in-transaction handle so the contract "tenant ops need a transaction handle"
  is testable without a database too. The full plan is the Phase 3 security test
  plan below.

- **Local development.** Nothing changes for the developer's inner loop: compose
  provisions all three roles with dev passwords from `infra/docker/.env`
  (`.env.example` gains `DATABASE_APP_URL`/migrator URL entries, git-ignored real
  values as per ADR-0001's convention). A developer who forgets the transaction
  wrapper gets an immediate empty result or error, which is the fail-closed design
  making mistakes visible rather than a debugging burden.
- **Production.** Managed PostgreSQL provisions the same three roles via
  infrastructure-as-code; this compose file remains
  local-only per ADR-0001.

## Consequences

- **Positive.** Cross-tenant leakage requires defeating both the application
  scoping _and_ the database policy; pool reuse cannot leak context; missing context
  cannot read or write; platform access is a distinct, auditable path; every future
  table inherits the model by default.
- **Negative.** Every tenant-scoped operation pays one transaction boundary and one
  `set_config` (negligible for this workload, and multi-statement operations wanted
  the transaction anyway). RLS adds a policy predicate per query — indexes on
  `tenant_id` (planned for Phase 3) keep this cheap. There is a non-trivial amount
  of supporting code (`withTenantTx`, role provisioning, migration lint, RLS tests)
  that must exist _before_ the first tenant table.
- **Accepted trade-off.** The migrator role bypasses RLS via ownership. This is
  inherent to running migrations at all; the mitigation is that migrations never run
  from request handling and `DATABASE_URL` never reaches the API/worker runtime.
- **Follow-ups (Phase 3+).** `withTenantTx` and role provisioning in
  `packages/db` (`DONE`); connection-string assertions at API startup (`DONE`); the
  migration-lint rules above, including the platform-privilege lint (`DONE`);
  platform-role least privilege (`DONE` — migration
  `20261008000002_platform_least_privilege`). **Remaining:** adopt `SECURITY
DEFINER` views/functions owned by `hmn_migrator` for platform _aggregate_
  reporting when the first such feature exists, shipping with its own migration,
  `search_path` discipline and tests; and write the first platform code path over
  the audited `withTenantTx` mechanism, which then earns its own coverage beyond
  the S7/S9 mechanism tests.

## Phase 3 security test plan (exact, to be executed before Phase 3 closes)

Integration tests (S1–S8) run against real PostgreSQL via `docker compose`, using
the `hmn_app` runtime role except where noted. Unit tests (U1–U3) need no database.

| #   | Layer   | Test                                                                                       | Expected result                                          |
| --- | ------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| S1  | RLS     | Migration lint: every `CREATE TABLE` of a tenant-owned table carries `ENABLE RLS` + policy | Build/test step fails if any tenant table is unprotected |
| S2  | RLS     | Transaction with **no** context: `SELECT` count and `INSERT` on each tenant table          | 0 rows returned; write rejected (fail-closed)            |
| S3  | RLS     | Tenant A context reads tenant B's rows                                                     | Zero rows                                                |
| S4  | RLS     | Tenant A context writes a row with tenant B's `tenant_id`                                  | Rejected by `WITH CHECK`                                 |
| S5  | Pool    | Tx1 sets context (tenant A), commits; Tx2 on same pool without context selects             | Zero rows — no leakage across pool reuse                 |
| S6  | Roles   | As `hmn_app`: `CREATE TABLE`, reads of platform-only tables                                | Permission denied                                        |
| S7  | Roles   | As `hmn_platform` (no context) selects tenant rows                                         | Zero rows — no silent bypass                             |
| S8  | Startup | Runtime validator given the migrator `DATABASE_URL`                                        | `ConfigurationError`, process refuses to start           |
| U1  | Types   | Tenant-scoped repository method called with a raw client instead of a `TenantTx` handle    | TypeScript compile error                                 |
| U2  | Helper  | `withTenantTx` given missing / non-UUID tenant ID                                          | Throws before any query executes                         |
| U3  | Helper  | `withTenantTx` issues `set_config(..., is_local => true)` as first statement               | Asserted via query log/spy in unit test                  |
| S9  | Roles   | Effective privileges: `hmn_platform` is SELECT-only, nothing on `_prisma_migrations`       | Least privilege held; no write anywhere                  |
| S1b | Lint    | Offline source lint: platform-role grants, `ON ALL TABLES`, `SUPERUSER`/`BYPASSRLS`        | Build fails on regression (incl. parser self-test)       |
| S1c | Lint    | Live catalogue: RLS enabled + effective policy has `NULLIF` on USING and WITH CHECK        | Definition, not just behaviour, is enforced              |

## Phase 3 execution record (2026-10-08)

Environment: PostgreSQL 17 (local `docker compose`, container `hmn-postgres`), roles
`hmn_migrator`/`hmn_app`/`hmn_platform` with real connections — the integration
tests run against the live RLS policies, not mocks. U1 is verified by `tsc -b`
(the boundary check file fails the build if the repository boundary regresses).
Run by the Phase 3 completion session after project-owner approval of this ADR and
of the D6 pool-safety amendment (migration `20261008000001_rls_pool_safe_context`).

**Evidence types (distinct, not interchangeable).** `AUTOMATED` = asserted by a
committed test that runs in `npm test` and fails the build on regression.
`MANUAL` = a one-off observation made by an engineer against the live database
during review; it is recorded for the audit trail but is **not** continuously
enforced, and it is deliberately not presented as a passing test.

| #   | Test                                                                                                | Result | Evidence  |
| --- | --------------------------------------------------------------------------------------------------- | ------ | --------- |
| S1  | Migration lint: every tenant-owned `CREATE TABLE` carries `ENABLE RLS` + fail-closed policy         | PASS   | AUTOMATED |
| S2  | No context: reads return 0 rows, writes rejected on every tenant table                              | PASS   | AUTOMATED |
| S3  | Tenant A context sees none of tenant B's rows (find, findUnique, raw count)                         | PASS   | AUTOMATED |
| S4  | Tenant A cannot insert/update rows into tenant B (WITH CHECK)                                       | PASS   | AUTOMATED |
| S5  | Pool reuse: no residual context, zero rows for a context-less query                                 | PASS   | AUTOMATED |
| S6  | `hmn_app`: no CREATE TABLE, no migration-table read, no global-table writes                         | PASS   | AUTOMATED |
| S7  | `hmn_platform` without context: 0 tenant rows, writes rejected; audited `withTenantTx` path works   | PASS   | AUTOMATED |
| S8  | Runtime validator rejects `hmn_migrator`, accepts `hmn_app`, fails closed when unreachable          | PASS   | AUTOMATED |
| U1  | Raw `PrismaClient` rejected where `TenantTx` is required (compile-time, branded handle)             | PASS   | AUTOMATED |
| U2  | `withTenantTx` throws before any query on missing/non-UUID tenant IDs                               | PASS   | AUTOMATED |
| U3  | `set_config('app.current_tenant_id', $1, true)` is the transaction's first statement, parameterized | PASS   | AUTOMATED |

Full suite at close of Phase 3: 117/117 Vitest tests passing, `tsc -b` clean,
ESLint clean, Prettier clean.

## Migration execution history (actual, as recorded in `_prisma_migrations`)

Recorded because the initial apply did **not** succeed first time, and the recovery
is part of the audit trail. Read directly from `_prisma_migrations`; the log
text contains no credentials or connection strings.

| #   | Migration                                 | Started (UTC)                  | Outcome                                                         |
| --- | ----------------------------------------- | ------------------------------ | --------------------------------------------------------------- |
| 1   | `20261008000000_init_phase3_foundation`   | 2026-10-08 09:05:28            | **FAILED** — rolled back at 09:06:21, `applied_steps_count = 0` |
| 2   | `20261008000000_init_phase3_foundation`   | 2026-10-08 09:06:24            | Applied in 0.245 s                                              |
| 3   | `20261008000001_rls_pool_safe_context`    | 2026-10-08 10:39:07            | Applied in 0.039 s                                              |
| 4   | `20261008000002_platform_least_privilege` | 2026-10-08 (Phase 3 follow-up) | Applied                                                         |

The failure (#1) is recorded verbatim as:

```text
Database error code: 42501
ERROR: permission denied for database hmn_saas
DbError { severity: "ERROR", code: SqlState(E42501), message: "permission denied for database hmn_saas",
  file: Some("aclchk.c"), line: Some(2843), routine: Some("aclcheck_error") }
  ... sql_schema_connector::apply_migration::apply_script
```

**Interpretation and residual unknown.** The first attempt connected with a role that
lacked `CREATE`/`TEMPORARY` on the database (or lacked `CREATE` on schema `public`),
which is consistent with a connection made as `hmn_app` instead of `hmn_migrator` — the
exact class of misconfiguration D7's startup probe exists to catch. The failure was
fail-closed: `applied_steps_count = 0`, the transaction rolled back, and the
subsequent attempt as the correct role applied cleanly. The failed row was **not**
deleted or rewritten (that would be history tampering); Prisma recorded a new row for
the successful attempt. It is **not** now an obstacle: `prisma migrate status` reports
the schema up to date, and `migrate deploy` applies new migrations without a resolve
step, which was confirmed by successfully applying `20261008000002`. What remains
unknown is why a mistyped role was used for the first attempt; the ADR records
`DATABASE_URL` must be the migrator's connection string and that the apply path is the
Prisma CLI only.

## Phase 3 security follow-up (2026-10-08): platform-role least privilege

Trigger: the post-commit review of Phase 3 found that `hmn_platform` held
`SELECT, INSERT, UPDATE, DELETE` on **every** table in `public`, including
`_prisma_migrations`. Migration `20261008000002_platform_least_privilege` narrows
this to `SELECT` on the seven application tables and nothing on the bookkeeping
table. The option analysis and the decision rationale are in D5 above; the grants
before and after are recorded here because they are the substance of the change.

Granted privileges for `hmn_platform`, before and after (one row per table):

| Table                  | Before                         | After    |
| ---------------------- | ------------------------------ | -------- |
| `users`                | SELECT, INSERT, UPDATE, DELETE | SELECT   |
| `tenants`              | SELECT, INSERT, UPDATE, DELETE | SELECT   |
| `subscription_plans`   | SELECT, INSERT, UPDATE, DELETE | SELECT   |
| `tenant_memberships`   | SELECT, INSERT, UPDATE, DELETE | SELECT   |
| `tenant_subscriptions` | SELECT, INSERT, UPDATE, DELETE | SELECT   |
| `domains`              | SELECT, INSERT, UPDATE, DELETE | SELECT   |
| `audit_logs`           | SELECT, INSERT, UPDATE, DELETE | SELECT   |
| `_prisma_migrations`   | SELECT, INSERT, UPDATE, DELETE | **none** |

`hmn_app` and `hmn_migrator` grants were not modified by this migration (verified
after applying: `hmn_app` still SELECT-only on the three global tables and full DML on
the four tenant tables; `hmn_migrator` still owns all eight tables and holds no
`BYPASSRLS`). No role gained `BYPASSRLS`, `SUPERUSER`, or table ownership, and no RLS
policy was disabled or altered.

Weakness proven before the fix, then re-proven closed after it (**MANUAL** live
observations, captured during the review):

| Probe                                                             | Before fix                                     | After fix                                        |
| ----------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| `SELECT count(*) FROM "_prisma_migrations"` as `hmn_platform`     | 3 rows returned                                | `permission denied for table _prisma_migrations` |
| `INSERT` into `domains` as `hmn_platform` (no context)            | privilege present (RLS still rejected the row) | `permission denied for table domains`            |
| `has_table_privilege('hmn_platform', 'public.domains', 'INSERT')` | `true`                                         | `false`                                          |

Evidence after the fix:

| #   | Check                                                                                                                                                                                      | Result | Evidence  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --------- |
| S9  | `hmn_platform` effective privileges: SELECT-only, no writes anywhere, nothing on `_prisma_migrations`                                                                                      | PASS   | AUTOMATED |
| S9  | `hmn_app` privilege shape unchanged (SELECT-only global, DML tenant)                                                                                                                       | PASS   | AUTOMATED |
| S9  | No `hmn_*` role is superuser, holds `BYPASSRLS`, or (except migrator) owns a table                                                                                                         | PASS   | AUTOMATED |
| S9  | `pg_default_acl` empty — future tables are not silently granted to any role                                                                                                                | PASS   | AUTOMATED |
| S1c | Live `pg_policy`: RLS enabled on all tenant tables; effective USING **and** WITH CHECK contain the `NULLIF` empty-context safeguard                                                        | PASS   | AUTOMATED |
| S1b | Offline source lint: no post-narrowing write/`ON ALL TABLES`/bookkeeping grant to `hmn_platform`; narrowing revokes all seven tables + bookkeeping; no `SUPERUSER`/`BYPASSRLS` for `hmn_*` | PASS   | AUTOMATED |
| —   | Parser self-test: the lint's regexes match a representative statement and ignore commented-out SQL                                                                                         | PASS   | AUTOMATED |
| —   | Both new tests are non-vacuous: re-granting `INSERT` and dropping the `domains` policy each made the suite fail, then were reverted                                                        | PASS   | MANUAL    |

Full suite after the follow-up: **130/130 Vitest tests passing** across 18 files
(was 117; +13 from S1b, S1c and S9), `tsc -b` clean, ESLint clean, Prettier clean.

**Assumption corrected during the follow-up (recorded so it is not repeated).** The
header comment of `20261008000002_platform_least_privilege` contains an inaccurate
parenthetical: it claims PostgreSQL "recorded direct (non-inherited) per-table grants
on all eight application tables" and that `REVOKE ... ON ALL TABLES` "would remove
nothing for the existing tables." Both halves are wrong. A scratch probe on
PostgreSQL 17 (inside a rolled-back transaction, with a throwaway role, since
deleted) showed the actual behaviour: a `GRANT ... ON ALL TABLES` executed while
tables **exist** materializes direct per-table grants (40 rows recorded for two
scratch tables), and a matching `REVOKE ... ON ALL TABLES` **does** remove them.

The operative facts are still consistent with this migration's design, which is why
the grants are correct in the database:

- The Phase 3 `GRANT ... ON ALL TABLES` ran **before any table existed**, so it
  recorded **no** direct table grants and no default ACL. The later per-table grants
  that `hmn_platform` actually held came from that same statement being resolved
  against the tables that came into existence by the end of that migration — which
  is why the narrowing migration had to name every table, as it does.
- Because the statement ran before the tables existed, it also did not leave a
  default privilege (`pg_default_acl` verified empty), so future tables are not
  silently granted to `hmn_platform`. The assertion in the migration's
  "post-migration enforcement" note therefore holds even though its explanation of
  _why_ was wrong.

**The migration file was deliberately NOT edited after application.** Correcting the
comment would change the file's bytes, and the checksum recorded in
`_prisma_migrations` is a SHA-256 over the file content
(`40638ece44f961f2cc95ed350bd6ec24082b5d52c9b6233370d08cc99c17fe63`, verified to match
the file on disk); editing an applied migration is prohibited by this ADR's own
forward-only rule, even for a comment. The correction therefore lives here, in the
authoritative document, and the file-vs-checksum invariant is intact. A future
migration may supersede the policy/grants, but the applied file's text is
immutable.
