# ADR-0001 — Local development infrastructure

- **Status:** Accepted
- **Date:** 2026-10-07
- **Phase:** 0 (environment audit) and 1 (toolchain)
- **Deciders:** Project owner, Lead Developer

## Context

HMN SaaS is a new multi-tenant SaaS platform to be built in controlled phases. The
existing product is a WordPress plugin (`hmn-crm` v5.1.3, "پنل هومانا") which is used
only as a _business-requirements reference_; none of its architecture is carried over.

Phase 0 audited the machine. Phase 1 provisions the minimum local infrastructure for
PostgreSQL and Redis. No application code, schema, or business logic is in scope yet.

### Environment facts (Phase 0 audit)

- Windows 10 (build 19045), x86_64, 8 cores, 52 GB free on C:
- Git Bash (MINGW64) as the shell
- Node.js **v24.21.0** (Node 24 LTS), npm 11.19.0, corepack 0.36.0
- Docker Desktop 29.8.1 (per-user install), Compose v5.5.1 — engine initially stopped
- PostgreSQL and Redis **not** installed natively
- Ports 3000, 3001, 5432, 6379 all free
- The project workspace was empty and **not** a Git repository

## Decisions

### D1 — Use Docker Compose for PostgreSQL and Redis

**Decision.** Run both infrastructure dependencies as containers via
`infra/docker/docker-compose.yml` (`postgres:17-alpine`, `redis:7-alpine`).

**Why.** Docker Desktop was already installed, so this adds no new host dependency and
keeps the machine clean and reproducible. Native installs of both servers would create a
second, divergent stack that the team would then have to keep in sync.

**Alternatives considered.**

- _Native Windows installs_ — rejected: two services to install, patch and uninstall
  manually, and no reproducibility for other developers or CI.
- _Managed cloud databases in development_ — rejected: adds latency, cost, and network
  dependency to the inner dev loop, and risks pointing dev tooling at real data.

### D2 — Pin explicit image versions

**Decision.** `postgres:17-alpine` and `redis:7-alpine`. No `latest` tags.

**Why.** Reproducible environments and predictable upgrade points. Alpine keeps pull
size and memory footprint small on a machine with limited disk headroom.

### D3 — Named volumes, not bind mounts, for data

**Decision.** `hmn_pgdata` and `hmn_redisdata` are Docker named volumes.

**Why.** Bind-mounting a PostgreSQL data directory across the Windows/NTFS boundary
causes permission and I/O problems inside the Linux VM. Named volumes avoid this
entirely. Source code will be bind-mounted only where hot reload genuinely needs it.

### D4 — Bind infrastructure to loopback only

**Decision.** Publish as `127.0.0.1:5432:5432` and `127.0.0.1:6379:6379`.

**Why.** A development database with a local password must never be reachable from the
LAN or a public network. Verified: both ports listen on `127.0.0.1` only.

### D5 — Redis configured for queue workloads

**Decision.** `--appendonly yes` and `--maxmemory-policy noeviction`.

**Why.** Redis will back BullMQ for SMS sending and other background work. Under memory
pressure, an eviction policy would silently discard queued jobs, and losing the queue on
restart would lose unsent messages. AOF is enabled for durability.

### D6 — Secrets convention: committed `.env.example`, git-ignored `.env`

**Decision.** `infra/docker/.env.example` is committed with an empty password.
`infra/docker/.env` holds the real local password and is git-ignored.

**Why.** No credential ever enters version control, while the required variable names
remain self-documenting. A root `.gitignore` is created now — before `git init` — so
`.env`, `node_modules/`, build output and `legacy/` can never be committed by accident.

### D7 — `legacy/` is a read-only reference copy

**Decision.** The legacy plugin source was copied into `legacy/hmn-crm` (plus `legacy/tests`,
the deployment script, and `archives/hmn-crm-4.9.8.tar.gz`) and is git-ignored.

**Why.** The prompt states the legacy ZIP lives in the workspace; it did not. The owner
chose to copy it in. Keeping it ignored makes the boundary explicit: it is a source of
business requirements, never a build input. Its WordPress architecture is not carried over.

### D8 — Node.js 24.21.0 and npm, as installed

**Decision.** Keep the installed Node 24 LTS and use npm; do not add pnpm or yarn.

**Why.** The requirements specify Node 24 LTS and npm when the available package manager
is reliable. Node 24.21.0 already satisfies this and npm 11 satisfies the latter, so
installing an alternative package manager would be unnecessary churn.

**Note.** Node 24's bundled npm workspaces are sufficient for the planned monorepo.

## Consequences

- **Positive.** One command brings up both dependencies; versions pinned; no secrets
  committed; machine stays clean; the same compose file can serve CI later.
- **Negative.** Docker Desktop must be running before backend or worker processes start.
  This is a documented prerequisite, not a defect.
- **Follow-up.** Production will use managed PostgreSQL and Redis. This compose file is
  local-development only and is never a reference for production topology.

## Verification (Phase 1)

| Check                              | Result                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `docker compose config` validation | valid                                                                       |
| Container health                   | `hmn-postgres` healthy, `hmn-redis` healthy                                 |
| PostgreSQL server                  | 17.11, Alpine, UTF-8, database `hmn_saas`                                   |
| PostgreSQL write path              | `CREATE TABLE` / `INSERT` / `SELECT` succeeded, rolled back, no residue     |
| Redis server                       | 7.4.11, `PING` -> `PONG`, `SET`/`GET`/`DEL` succeeded                       |
| Redis queue config                 | `maxmemory-policy=noeviction`, `appendonly=yes`, `aof_last_write_status=ok` |
| Host reachability                  | 127.0.0.1:5432 and 127.0.0.1:6379 reachable from the host                   |
| Bind scope                         | loopback only; nothing on 0.0.0.0                                           |
| Data durability                    | survives a container restart (named volumes)                                |

## Not in scope for this ADR

Cal.com / Cal.diy, the `SchedulingProvider` abstraction, auth/session strategy, the
tenant-isolation model, the SMS ledger, and the full schema are all deliberately deferred
to later phases.
