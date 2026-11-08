# hbook

**Fast, secure, multi-tenant booking engine API** — inspired by [cal.com / cal.diy](https://github.com/calcom/cal.diy), rebuilt as a lean, frontend-free service.

No UI. No bloat. Just a scheduling engine your product talks to over HTTP, with PostgreSQL doing the heavy lifting.

[راهنمای سریع به فارسی](docs/QUICKSTART.fa.md)

---

## Why hbook

| | hbook | cal.diy |
| --- | --- | --- |
| Footprint | ~1 service, 10 endpoints domains, API-only | Full monorepo (Next.js + frontend + apps) |
| Double-booking | **Physically impossible** — PostgreSQL `EXCLUDE` GiST constraint + advisory locks | App-level checks |
| Auth | Hashed API keys (SHA-256, shown once) | Sessions/JWT |
| Slots | In-memory timezone-aware engine, 3 queries per request | Per-app logic |
| Docs | OpenAPI 3 + Swagger UI at `/docs` | — |
| Deployment | `docker compose up -d --build` | Heavy compose |

## Features

- **Event types** — duration, slot interval, buffers, lead times, confirmation flow
- **Availability** — weekly windows per weekday + date overrides (holidays / custom days), full IANA timezone support (`Intl`, zero heavy libs)
- **Slot discovery** — `GET /v1/slots` returns free UTC instants; range capped at 62 days
- **Booking lifecycle** — create / confirm / cancel / reschedule, cursor-paginated listing with filters
- **Race-proof booking** — 3 layers: engine validation → `pg_advisory_xact_lock` → `EXCLUDE USING gist` constraint (see `prisma/migrations/*_init/migration.sql`)
- **Multi-tenancy** — every table is tenant-scoped; API keys never cross tenants
- **Signed webhooks** — `X-HBook-Signature: t=<ts>,v1=HMAC_SHA256(secret, "<ts>.<body>")`, exponential-backoff retries, delivery log
- **Security** — Helmet headers, opt-in CORS, rate limiting, 64 KB body cap, response schemas that strip undeclared fields, keys stored as SHA-256 hashes
- **OpenAPI docs** — interactive Swagger UI at `/docs`

## Quick start (Docker)

```bash
cp .env.example .env
# edit .env →  HBOOK_SETUP_TOKEN=$(openssl rand -hex 32)  and a strong POSTGRES_PASSWORD
docker compose up -d --build
docker compose exec api npm run db:seed        # demo clinic data (optional)
```

- API: `http://localhost:3000`
- Swagger UI: `http://localhost:3000/docs`
- Health: `http://localhost:3000/health`

## Local development (without Docker)

```bash
npm install
export DATABASE_URL="postgresql://hbook:hbook@localhost:5432/hbook?connection_limit=10"
npm run db:migrate     # prisma migrate deploy
npm run db:seed        # demo data, prints an API key
npm run dev            # tsx watch
```

## First run

```bash
# 1) create a tenant (requires the master setup token)
curl -s -X POST http://localhost:3000/v1/tenants \
  -H "X-Setup-Token: $HBOOK_SETUP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Clinic",
    "slug": "my-clinic",
    "timezone": "Asia/Tehran",
    "owner": { "name": "Dr. Sara", "email": "sara@clinic.test" }
  }'
# → { tenant, owner, apiKey: { key: "hbk_…" } }   ← store the key NOW, it is never shown again
```

```bash
export KEY="hbk_…"   # from the response (or from `npm run db:seed`)

# 2) add a host's weekly availability (Sat–Wed 9–13 & 14–17, Tehran)
curl -s -X PUT http://localhost:3000/v1/users/<userId>/availability \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{ "weekly": [
    { "weekday": 6, "windows": [ { "start": "09:00", "end": "13:00" }, { "start": "14:00", "end": "17:00" } ] },
    { "weekday": 0, "windows": [ { "start": "09:00", "end": "13:00" }, { "start": "14:00", "end": "17:00" } ] }
  ]}'

# 3) create an event type
curl -s -X POST http://localhost:3000/v1/event-types \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{ "slug": "quick-visit", "title": "Quick visit", "hostId": "<userId>", "durationMin": 15 }'

# 4) free slots
curl -s "http://localhost:3000/v1/slots?eventTypeId=quick-visit&from=2026-11-10&to=2026-11-12" \
  -H "X-API-Key: $KEY"
# → { "slots": ["2026-11-10T05:30:00.000Z", …] }

# 5) book one of them (exact instant!)
curl -s -X POST http://localhost:3000/v1/bookings \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{ "eventTypeId": "quick-visit", "start": "2026-11-10T05:30:00.000Z",
        "attendee": { "name": "Ali", "email": "ali@example.com", "timezone": "Asia/Tehran" } }'
```

## API overview

All tenant routes require `X-API-Key` (or `Authorization: Bearer hbk_…`). Full reference: **`/docs`** (OpenAPI JSON: `/docs/json`).

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | liveness + DB check (no auth) |
| POST | `/v1/tenants` | **X-Setup-Token** master token, rate-limited 5/min |
| GET | `/v1/me` | tenant + key info |
| POST/GET | `/v1/users` · GET/PATCH/DELETE `/v1/users/:id` | hosts & members |
| POST/GET | `/v1/event-types` · GET/PATCH/DELETE `/v1/event-types/:id` | id **or** slug |
| GET/PUT | `/v1/users/:id/availability` | weekly windows `HH:MM` |
| POST/DELETE | `/v1/users/:id/availability/overrides[/:date]` | day off / custom window |
| GET | `/v1/slots` | `eventTypeId, from, to, timezone?` |
| POST/GET | `/v1/bookings` · GET `/v1/bookings/:uid` | filters + cursor pagination |
| POST | `/v1/bookings/:uid/confirm` · `/cancel` · `/reschedule` | lifecycle |
| POST/GET | `/v1/webhooks` · DELETE `/v1/webhooks/:id` | secret shown once |
| GET | `/v1/webhooks/:id/deliveries` | delivery log |
| POST | `/v1/webhooks/:id/ping` | signed test event |
| POST/GET | `/v1/api-keys` · DELETE `/v1/api-keys/:id` | revoke is immediate |

Error envelope (stable, machine-readable):

```json
{ "error": { "code": "SLOT_TAKEN", "message": "This slot has just been booked. …" } }
```

Key codes: `UNAUTHORIZED`, `INVALID_API_KEY`, `API_KEY_REVOKED`, `SETUP_TOKEN_INVALID`, `VALIDATION_ERROR`, `SLOT_UNAVAILABLE` (422), `SLOT_TAKEN` (409), `RATE_LIMITED` (429).

## Webhook signature verification (Node)

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyHbookSignature(rawBody, header, secret) {
  // header: "t=1761912345,v1=ab3f…"  — sign the EXACT raw body, not re-serialized JSON
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(parts.v1, 'hex'), Buffer.from(expected, 'hex'));
}
```

Events: `booking.created`, `booking.confirmed`, `booking.cancelled`, `booking.rescheduled`, `ping`.
Retries: 3 attempts (1s → 4s → 16s), each attempt logged in `GET /v1/webhooks/:id/deliveries`.

## Security notes

- API keys are generated with `crypto.randomBytes(24)`, persisted **only** as SHA-256; `prefix` (12 chars) is for display.
- `POST /v1/tenants` is the sole unauthenticated write; it is protected by the `HBOOK_SETUP_TOKEN` (constant-time compare) and a hard 5 req/min limit. In production the server refuses to start without this token.
- Response bodies are declared as JSON Schemas → fast-json-stringify **cannot** serialize fields you did not declare (defense in depth against data leaks).
- All writes validate tenant ownership before mutating; every list endpoint is tenant-scoped.
- Webhooks are fire-and-forget from the request path and never block responses; failures are retried with backoff and logged.
- Behind nginx/traefik set `TRUST_PROXY=true` so rate limiting keys on the real client IP.

## Performance notes

- Fastify 5 + compiled JSON Schema validation/serialization on every route.
- Slot engine is pure arithmetic — a 62-day, 15-min-grid request costs ~1,700 integer comparisons and exactly **3 queries** (availability, overrides, busy bookings — parallel).
- Cursor pagination everywhere (no OFFSET scans); every filter path is backed by an index (`hostId+startsAt`, `tenantId+startsAt`, `eventTypeId`, `attendeeEmail`).
- Double-booking is resolved by the database (`EXCLUDE` GiST), so no application-level locking tables or polling.
- Connection pool is tuned via `DATABASE_URL` (`?connection_limit=10&pool_timeout=10`).

## Project structure

```
src/
  config.ts            env parsing, fail-fast validation
  app.ts               plugins, OpenAPI, error handler, route wiring
  server.ts            bootstrap + graceful shutdown
  lib/
    prisma.ts  keys.ts  time.ts  slots.ts  booking.ts  webhooks.ts  paginate.ts  errors.ts
  plugins/auth.ts      API-key auth (hashed lookup, lastUsedAt throttle)
  schemas/             JSON Schemas = validation + serialization + docs
  routes/              system, tenants, me, users, eventTypes, availability, slots, bookings, webhooks, apiKeys
prisma/
  schema.prisma        9 models, tenant-scoped, cascade rules
  migrations/          init SQL + booking_no_host_overlap EXCLUDE constraint
  seed.ts              demo clinic
scripts/
  e2e.mjs              full end-to-end test suite (Node, no deps)
  webhook-receiver.js  local receiver that verifies HMAC signatures
```

## Scripts

```bash
npm run dev          # tsx watch
npm run build        # tsc → dist/
npm start            # node dist/server.js
npm run db:migrate   # prisma migrate deploy
npm run db:seed      # demo clinic (idempotent)
npm run typecheck    # tsc --noEmit
npm run test:e2e     # boots nothing itself — run against a live server (see script header)
```

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — (required) | append `?connection_limit=10` |
| `HBOOK_SETUP_TOKEN` | required in prod | `openssl rand -hex 32` |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `CORS_ORIGINS` | *(empty = no CORS)* | comma-separated |
| `RATE_LIMIT_MAX` | `300` | per key/IP per minute |
| `TRUST_PROXY` | `false` | `true` behind a reverse proxy |
| `LOG_LEVEL` | `info` (dev) / `warn` (prod) | pino level |
| `WEBHOOK_TIMEOUT_MS` | `10000` | per attempt |
| `WEBHOOK_MAX_ATTEMPTS` | `3` | with backoff |

## License

MIT — booking logic inspired by the cal.com community (cal.diy); this codebase is an independent, from-scratch implementation.
