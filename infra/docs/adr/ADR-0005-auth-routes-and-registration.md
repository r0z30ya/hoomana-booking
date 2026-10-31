# ADR-0005 — Auth routes, session cookie, and registration grants

- **Status:** Approved — owner delegation to AutoClaw as PM (2026-10-12)
- **Date:** 2026-10-12
- **Depends on:** ADR-0004 (identity & auth, approved 2026-10-12), ADR-0003 (RLS)

## Context

Phase 4 step 1 is complete: the D-C migration (five identity tables, UserRole enum
swap, per-table grants) is applied to the local database, all 160 tests are green,
and the scrypt hashing module (U4) plus the SMS adapter are ready. The next step is
the API routes that make authentication real.

This ADR covers the route surface, the session cookie contract, and the one grant
change that self-service registration needs. Everything else inherits from ADR-0004.

## Decisions

### D-A — Route surface

| Route | Method | Purpose | Auth |
|---|---|---|---|
| `/auth/register` | POST | Self-service: creates user + credential + tenant + OWNER membership + trial subscription | none (rate-limited) |
| `/auth/login` | POST | Staff sign-in: mobile + password → session cookie | none (rate-limited) |
| `/auth/logout` | POST | Revokes the current session, clears the cookie | session |
| `/auth/me` | GET | Returns the current user + active tenant | session |
| `/auth/otp/send` | POST | Sends an OTP via SMS (for patient flows and recovery) | none (rate-limited) |
| `/auth/otp/verify` | POST | Verifies an OTP code | none (rate-limited) |

Error responses follow the existing `ErrorResponseBody` shape in `apps/api/src/server.ts`.

### D-B — Session cookie

| Property | Value |
|---|---|
| Name | `hmn_session` |
| Value | The raw session token (opaque, 32 random bytes, base64url) |
| HttpOnly | Always |
| Secure | Yes outside development |
| SameSite | Lax |
| Path | `/` |
| Max-Age | Matches the session's `expiresAt` (30 d absolute) |

The raw token is **never stored server-side** — only its SHA-256 hash (ADR-0004 A-4).
On logout the session is revoked and the cookie is cleared.

### D-C — Registration grants (the one grant change)

Self-service registration creates a `users` row and a `tenants` row. The runtime role
`hmn_app` currently holds **SELECT-only** on both (ADR-0003 D5). This ADR grants:

- `INSERT` on `users` and `tenants` to `hmn_app` (via a new forward-only migration).
- The S9 guard (`platform-least-privilege.integration.test.ts`) is extended to expect
  INSERT on these two tables — still SELECT-only on `subscription_plans`.

Nothing else changes: `hmn_app` still cannot UPDATE or DELETE on global tables, still
cannot touch `_prisma_migrations`, and still has no access to platform tables.

### D-D — Rate limiting

Login, registration and OTP endpoints check `auth_attempts` **before** processing:

- 10 failed attempts per 15 min per identifier + IP → HTTP 429.
- Every attempt (success or failure) is recorded in `auth_attempts`.
- The counter is a plain PostgreSQL query — no Redis dependency for correctness.

### D-E — Plugins

| Plugin | Purpose |
|---|---|
| `@fastify/cookie` | Parse/sign the session cookie |
| `@fastify/csrf-protection` | Layered CSRF (synchroniser token + SameSite=Lax + Origin) before any state-changing route ships |

No other plugins. `@fastify/rate-limit` is not used — the PostgreSQL-backed
`auth_attempts` counter is the rate limiter (ADR-0004 D-B).

## Consequences

- **Positive.** The auth routes have a fixed, testable contract; the cookie shape is
  locked; the grant gap for registration is resolved in the same slice.
- **Negative.** Three new files in `apps/api/src/auth/` and two new repositories in
  `packages/db/src/repositories/identity/`; one new migration.
- **Risks.** The registration grant widens `hmn_app` from SELECT-only to INSERT on
  two global tables — S9 must be updated in the same change, never left red.

## Test plan

- Repository tests: create/find/update credentials; create/find/touch/revoke sessions.
- Route tests: register → login → me → logout happy path; wrong password → 401 with
  identical timing to unknown-account; rate limit → 429 after 10 failures.
- S9 update: INSERT on users/tenants is expected; everything else unchanged.
