# ADR-0002 — Project foundation (monorepo, toolchain, health endpoints)

- **Status:** Accepted
- **Date:** 2026-10-07
- **Phase:** 2 (project foundation)
- **Deciders:** Project owner, Lead Developer
- **Depends on:** [ADR-0001](ADR-0001-local-development-infrastructure.md)

## Context

Phase 2 establishes the skeleton of the platform: repository layout, build system,
type checking, linting, logging, error handling, environment validation, test
infrastructure and health endpoints.

Scope was explicitly limited to foundation. **No authentication, tenants, patients,
appointments, accounting, SMS, billing, Cal.com integration or database migrations.**
Two packages therefore ship deliberately empty (see D8).

## Decisions

### D1 — npm workspaces monorepo with TypeScript project references

**Decision.** `apps/{web,api,worker}` and `packages/{domain,db,integrations,shared,validation}`
as npm workspaces. Internal packages build to `dist/` and are consumed through their
`package.json` `exports` field. A root solution `tsconfig.json` drives `tsc -b`.

**Why.** npm 11 already provides workspaces, so no additional package manager is needed
(consistent with ADR-0001/D8). Project references give correct, incremental build
ordering and make `tsc -b` a real type check over the whole dependency graph rather than
per-package isolation.

**Alternatives considered.**

- _Turborepo / Nx_ — rejected: orchestration overhead with no payoff at this size. Revisit
  if build times become the bottleneck.
- _pnpm workspaces_ — would be reasonable, but npm is already present and adequate.

### D2 — TypeScript 5.9.3, not the current 7.x

**Decision.** Pin `typescript@5.9.3` exactly.

**Why.** `typescript-eslint@8.71.1` declares `typescript: ">=4.8.4 <6.1.0"`. The current
TypeScript release is **7.0.2**, a native port that the type-aware lint toolchain does
not yet support. Choosing the newest compiler at the cost of type-aware linting would
trade a working safety net for a version number. 5.9.3 is the newest release fully
supported across the chosen tooling.

**Revisit when** `typescript-eslint` widens its peer range.

### D3 — Strict TypeScript configuration

**Decision.** `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
`noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`,
`noUnusedParameters`, `allowUnreachableCode: false`, `useUnknownInCatchVariables`,
`verbatimModuleSyntax`, `isolatedModules`.

**Why.** These catch the failure classes that matter in a multi-tenant system: unchecked
array/index access, unsafe `catch` handling and accidental implicit types.

**Known, deliberate omission.** `exactOptionalPropertyTypes` is **off**. It conflicts
most often with third-party optional-property types, and enabling it would add churn
without addressing a current defect. It is a one-line change and should be enabled
deliberately, with the resulting errors fixed rather than suppressed.

### D4 — ESM everywhere, with two specifier conventions

**Decision.** Every workspace is `"type": "module"`.

- `apps/api`, `apps/worker`, `packages/*` use **NodeNext** resolution with explicit
  `.js` extensions on relative imports (required by Node ESM).
- `apps/web` uses **bundler** resolution with extensionless imports (Vite's convention).

**Why.** Each side uses the idiom its resolver actually requires. Forcing `.js`
extensions into browser code would be noise; omitting them in Node output would not
resolve at runtime. The split is a consequence of Node vs bundler resolution, not an
inconsistency to fix.

### D5 — Prisma 7 with a driver adapter; `prisma.config.ts` instead of a schema URL

**Decision.** `prisma@7.10.0` and `@prisma/client@7.10.0`, pinned **exactly**, with
`@prisma/adapter-pg` and `pg`. The datasource in `schema.prisma` carries no `url`;
the connection string is resolved in `packages/db/prisma.config.ts` for CLI commands and
passed as an adapter at runtime.

**Why.** Prisma 7 removed `url` from the datasource block and is Rust-free: the query
compiler runs in-process and connections come from a driver adapter. This was confirmed
empirically — `prisma validate` fails with P1012 if `url` is present.

**Why pinned exactly.** npm's `latest` dist-tag for the `prisma` CLI currently points at
**`8.0.0-rc.21`**, a release candidate, while `@prisma/client` is `7.10.0`. A caret range
would be safe, but an exact pin removes any chance of a CLI/client major mismatch or an
accidental RC install.

**Consequence.** `packages/db/prisma.config.ts` loads the repository-root `.env`
explicitly, because Prisma commands must run with the working directory set to
`packages/db`. This is why `npm run prisma:generate` exists at the root.

### D6 — Queue-specific Redis configuration lives in `apps/worker`, not `@hmn/shared`

**Decision.** `@hmn/shared` exposes a generic Redis client factory and probe. BullMQ
connection options (including the mandatory `maxRetriesPerRequest: null`) live in
`apps/worker/src/connection.ts`.

**Why.** An initial implementation put the BullMQ helper in `@hmn/shared`, which forced
the shared package to depend on the queue library's option contract and produced a type
conflict — BullMQ v6 defines its own structurally permissive `RedisOptions`, distinct
from ioredis's. Moving it removes a coupling that had no business being there and keeps
the queue technology replaceable. The generic probe stays shared because both the API and
the worker need it.

**Related.** `@hmn/shared` is not a dependency of `apps/web`: it contains Node-only code
(pino, ioredis). Keeping the browser client free of it preserves that boundary.

### D7 — Health endpoints separate liveness from readiness

**Decision.**

- `GET /health` → `{"status":"ok"}`, touches **no** dependency.
- `GET /health/db` and `GET /health/redis` → probe one dependency each; `200` when
  reachable, `503` with an attributable body when not.

**Why.** A liveness endpoint that queries the database turns a dependency outage into a
process restart loop, which makes an incident worse. Readiness is reported per
dependency so a failure points at a cause instead of a blob. Both behaviours are covered
by tests, including the explicit assertion that `/health` stays `200` while dependencies
are down.

**Dependency error text** is returned only when `NODE_ENV !== 'production'`. Locally the
message ("connection refused", "password authentication failed") is what makes debugging
possible; in production it describes internal topology.

### D8 — `packages/domain` and `packages/integrations` ship empty, on purpose

**Decision.** Both export nothing. Each documents its dependency rules and why it is
empty.

**Why.** The workspace graph should exist before the concepts that fill it. Defining
`SchedulingProvider` now, before the scheduling use cases exist, would freeze an interface
based on guesses — exactly the premature coupling the Cal.com guidance warns against.
Creating the package boundary now means Phase 5 adds an adapter without moving code.

### D9 — Tests run against built output; integration tests skip with a reason

**Decision.** Node workspace tests import through package `exports`, so they exercise
`dist/`. The root `test` script builds first. Tests requiring PostgreSQL or Redis call
`skip()` with an explicit message when the dependency is unreachable.

**Why.** Testing the published artifact rather than source means a broken build cannot be
masked by tests that only ever ran against source. Skipping _with a reason_ keeps "infra
not started" distinguishable from "endpoint broken" — and a skip is visible in the
Vitest output rather than passing silently. Verified: with the stack up, no test skips.

**Test isolation against live consumers.** The queue round-trip test enqueues on a queue
name unique to each run (`system-test-<uuid>`), never the production `system` queue. This
was found the hard way: with a worker process running, the test's job was consumed by
that worker instead of the test's own, and the assertion timed out at 10s even though
Redis and the queue were healthy. The factories therefore accept an overridable queue
name, and the test wipes only its own queue during cleanup.

### D10 — Type-aware ESLint, with build configs excluded

**Decision.** ESLint 10 flat config with `typescript-eslint` `recommendedTypeChecked` and
`projectService`. `*.config.{js,ts,mts}` files are excluded from linting.

**Why.** Type-aware rules catch real defects (unhandled promises, unsafe `any`
propagation). Build configuration files sit outside any `tsconfig` project, so including
them would require padding the project graph purely to satisfy the linter. Prettier still
formats them.

## Accepted risks and known limitations

1. **Four high-severity advisories, dev-tool only.** `mysql2` and `deepmerge-ts` are
   pulled in by the `prisma` CLI (`@hmn/db` devDependency) via `@prisma/config`. They are
   not reachable from application code paths: the runtime client is
   `@prisma/client` + `@prisma/adapter-pg` over PostgreSQL, and the CLI is only run
   manually for generate/migrate. **Not fixed**, because the only automated remedy npm
   offers is `npm audit fix --force`, which downgrades to `prisma@6.19.3` — a breaking
   major change applied to silence a warning instead of fixing a defect. Revisit when
   Prisma 8 ships stable, and reassess whether an `overrides` entry for `deepmerge-ts@^8`
   is safe.
2. **`engine-strict=true`** enforces the Node 24 pin on dependencies as well as the root
   project. This is intentional but can reject a transitive dependency whose `engines`
   range excludes Node 24.
3. **`apps/web` has no styling layer or router.** Deliberate: those choices belong with
   the tenant UI in a later phase.
4. **No migrations exist.** `schema.prisma` declares zero models, and a test asserts that
   none of the Phase 3 tables appear in the database.

## Verification (Phase 2)

| Check                                 | Result                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `tsc -b` (all Node projects)          | clean, exit 0                                                             |
| `tsc --noEmit` (web)                  | clean                                                                     |
| `vite build` (web)                    | succeeded, 220.81 kB / 69.15 kB gzip                                      |
| `eslint .`                            | clean, 0 problems                                                         |
| `vitest run`                          | **12 files, 85 tests, all passing, 0 skipped**                            |
| `prisma validate` / `prisma generate` | valid; client generated to `packages/db/src/generated/prisma`             |
| PostgreSQL                            | live query + `SELECT 1` through the adapter; server version reported      |
| Redis                                 | live `PING`; BullMQ enqueue → process → complete round trip               |
| `GET /health`                         | `200 {"status":"ok"}`                                                     |
| `GET /health/db`                      | `200 {"status":"ok","dependency":"database","latencyMs":72}`              |
| `GET /health/redis`                   | `200 {"status":"ok","dependency":"redis","latencyMs":11}`                 |
| Unknown route                         | `404 {"error":{"code":"NOT_FOUND",...}}`                                  |
| Worker startup                        | `redis connection verified` (26 ms), `worker ready` queue `system`        |
| Browser (Vite dev proxy)              | page renders "API is ok"; no console errors                               |
| Secret hygiene                        | `.env`, `legacy/`, `dist/`, `node_modules/`, generated Prisma all ignored |

## Not in scope for this ADR

Authentication, sessions, tenant context, RBAC, the tenant-scoped schema, migrations,
seed data, the scheduling adapter, the SMS ledger and the subscription/entitlement model.
