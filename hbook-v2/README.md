# hbook — headless booking engine API

Fast, secure, **multi-tenant booking engine** (no frontend, API only) in the
spirit of [cal.com/cal.diy](https://github.com/calcom/cal.diy), built for
**PostgreSQL as the engine** — designed to be driven server-to-server by a
host platform (e.g. [Homana](docs/INTEGRATION.md)) that owns the UI, user
accounts and panels. The engine is swappable: everything Homana needs is a
documented, machine-readable contract.

**Stack:** Fastify 5 · Prisma 6 · PostgreSQL (timestamptz/UTC) · zero
runtime deps beyond the framework.

```
                    ┌──────────────────┐
  Homana backend ──▶│  hbook API :3000 │──▶ PostgreSQL (schema "hbook")
  (holds the keys)  │  + webhook worker│      shared DB, separate schema
                    └──────────────────┘
```

## Highlights (v2)

- **Concurrent capacity per service** — `capacity: 3` on an event type lets
  3 patients share one exact slot. Enforced at the database level:
  a `SlotInstance` seat counter with `CHECK (taken <= capacity)` guarded by
  `SELECT … FOR UPDATE`, a per-host `pg_advisory_xact_lock`, and a
  constraint trigger (`booking_fit_guard`) as defense in depth — safe across
  processes and instances (verified by a 3-instance race test).
- **Precise buffer semantics** — every booking reserves
  `[startsAt − bufferBefore, endsAt + bufferAfter]` with *its own* service's
  buffers. Slot listing, booking and reschedule share ONE engine, so they
  can never disagree (regression-tested for the "slot list hides the next
  interval but direct booking was accepted" bug).
- **Mobile-first patients** — booking requires only a name + mobile number;
  Iranian formats (`09…`, `+98…`, `0098…`, `98…`, `9…`, Persian/Arabic
  digits, arbitrary separators) are normalized to `09xxxxxxxxx` / `+E.164`.
  Email is optional everywhere (owners, doctors, patients).
- **Reliable webhooks** — transactional outbox (`WebhookEvent` committed in
  the same transaction as the change) + persistent queue with bounded
  backoff, replay endpoint, stable event id across attempts, at-least-once
  semantics, restart recovery — plus SSRF-guarded destinations (public IPs
  only, HTTPS mandatory in production, DNS re-validated per hop), and
  signing secrets **encrypted at rest** (AES-256-GCM, `HBOOK_WEBHOOK_ENC_KEY`).
- **Tenant isolation to the bone** — every query is tenant-scoped AND
  composite `(id, tenantId)` foreign keys make cross-tenant references
  impossible even via raw SQL. Full isolation matrix covered by tests.
- **API key scopes & rotation** — `admin ⊃ manage ⊃ book ⊃ read`; keys are
  SHA-256-hashed, shown once, revocable, rotatable, and brute-forcing random
  keys is rate-limited per IP (XFF-spoof safe behind a proxy).
- **Idempotent mutations** — `Idempotency-Key` on booking create/confirm/
  cancel/reschedule: retries after timeouts replay the stored response
  instead of double-booking.
- **Timezone correctness** — UTC storage, `Asia/Tehran` and DST zones
  unit-tested (ambiguous/nonexistent wall times), Jalali rendering left to
  the host platform.

## Quick start (development)

```bash
cp .env.example .env      # fill HBOOK_SETUP_TOKEN, HBOOK_WEBHOOK_ENC_KEY
docker compose up -d --build
# …or locally:
npm ci && npx prisma migrate deploy && npm run db:seed && npm run dev
```

Seed output prints the one-time demo API key. Try:

```bash
curl -s http://localhost:3000/v1/me -H "X-API-Key: <key>"
curl -s "http://localhost:3000/v1/slots?eventTypeId=quick-visit&from=2026-01-10&to=2026-01-17" -H "X-API-Key: <key>"
```

Interactive OpenAPI docs: `http://localhost:3000/docs`

## API surface (summary)

| Area | Endpoints |
| --- | --- |
| System | `GET /health`, `GET /docs/json` |
| Tenants (setup token) | `POST /v1/tenants` |
| Users/hosts | `POST/GET /v1/users`, `GET/PATCH/DELETE /v1/users/:id` |
| Availability | `GET/PUT /v1/users/:id/availability`, `POST /v1/users/:id/availability/overrides`, `DELETE …/overrides/:date` |
| Event types | `POST/GET /v1/event-types`, `GET/PATCH/DELETE /v1/event-types/:id` (capacity, buffers, lead times) |
| Slots | `GET /v1/slots?eventTypeId&from&to[&timezone]` → `{startsAt, seatsRemaining}[]` |
| Bookings | `POST /v1/bookings`, `GET /v1/bookings`, `GET /v1/bookings/:uid`, `POST …/confirm`, `POST …/cancel`, `POST …/reschedule` (all with `Idempotency-Key`) |
| Webhooks | `POST/GET /v1/webhooks`, `DELETE /v1/webhooks/:id`, `POST /v1/webhooks/:id/ping`, `GET /v1/webhooks/:id/deliveries[?status=]`, `POST /v1/webhooks/:id/deliveries/:deliveryId/replay` |
| API keys | `POST/GET /v1/api-keys`, `DELETE /v1/api-keys/:id`, `POST /v1/api-keys/:id/rotate` (scopes) |

Error envelope everywhere:
`{"error": {"code": "SLOT_TAKEN", "message": "…", "details": …}}` — stable
codes mapped to Persian UI strings in [`docs/INTEGRATION.md`](docs/INTEGRATION.md).

## Tests

```bash
npm test                     # unit (59) + e2e (112) against a real PostgreSQL
npm run test:multi           # 3-instance capacity race, HTTP-level SSRF, restart recovery
npm run test:shared-schema   # shared-DB / separate-schema deployment proof
npm run test:fresh-install   # migrate deploy from scratch + trigger/CHECK present
npm run test:load            # realistic load scenario (see below)
```

Latest results (2-vCPU dev container, embedded PostgreSQL 18, real HTTP):

| Suite | Result |
| --- | --- |
| unit | **59/59** |
| e2e | **112/112** |
| multi-instance (3 processes) | **19/19** — capacity 1 → exactly 1/9 wins; capacity 3 → exactly 3/12; DB invariants hold; queued webhook delivered after server+receiver restart with stable event id |
| shared-schema deploy | **6/6** — Homana data untouched, engine role denied on Homana schema |
| fresh install | **5/5** |

Load test (10 doctors × 2 services, ~1,400 seeded bookings, 2 vCPU container):

| Phase | Volume | p50 | p95 | p99 | errors |
| --- | --- | --- | --- | --- | --- |
| A — slot range queries (7/30/60 d), c=25 | 3,000 | 368 ms | 496 ms | 604 ms | 0 |
| B — concurrent bookings on 20 hot slots, c=30 | 600 → **exactly 60 wins** (= seats, zero overbook) | 100 ms | 241 ms | 290 ms | 0 5xx |
| C — mixed list/create/cancel, c=20 | 1,200 | 68 ms | 163 ms | 193 ms | 0 5xx |

> Sequential localhost probes (p95 ≈ 14 ms for 30-day slot queries) are NOT
> used as production-capacity evidence; the numbers above are the reference
> point for a 2-vCPU box. Scale horizontally (stateless) or vertically.

## Deployment

- Development: `docker compose up -d --build` (see [`docker-compose.yml`](docker-compose.yml)).
- Production next to Homana on ONE PostgreSQL: separate schema, dedicated
  role, grants, pooling, backup/restore and a security checklist —
  **[`docs/DEPLOY.md`](docs/DEPLOY.md)** (فارسی).
- Homana adapter contract, id mapping, error-code → Persian messages table,
  webhook consumer pattern: **[`docs/INTEGRATION.md`](docs/INTEGRATION.md)**.
- Persian quick start: [`docs/QUICKSTART.fa.md`](docs/QUICKSTART.fa.md).

## Security posture

- Keys: hashed (SHA-256), one-time display, revocable, rotatable, redacted
  in logs; setup token is server-to-server only and never belongs in a frontend.
- Rate limiting: per key (authenticated) / per client IP (anonymous),
  plus a dedicated per-IP limiter for failed authentications (key-rotation
  brute force and XFF spoofing are tested).
- SSRF: webhook destinations must be public; localhost/private/link-local
  (incl. cloud metadata) are blocked; DNS is re-validated on every
  connection and redirect hop; HTTPS enforced in production; test
  escape-hatches exist but are ignored in production.
- PII: webhook payloads carry ids/times/status only; contact data never
  appears in logs.
- Response schemas are JSON-Schema-serialized — undeclared fields cannot leak.
