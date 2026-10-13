# ADR-0004 — Identity and authentication (platform separation, tenant auth)

- **Status:** **Approved** — owner approval recorded 2026-10-12 (see "Owner approval" below); implementation may start.
- **Date:** 2026-10-10
- **Phase:** 4 step 1 — design only (issued as WO-0001; design-only, no code,
  migration or dependency change)
- **Deciders:** Project owner (WO-0001 approved 2026-10-10; Addendum §6), Lead
  Developer
- **Depends on:** [ADR-0002](ADR-0002-project-foundation.md),
  [ADR-0003](ADR-0003-tenant-isolation-rls.md) (esp. D2–D7, the D5 prohibition
  "Platform authority must not come from tenant membership", the D5 MFA owner
  decision, and the "Future privileged-function gate")

## Owner approval (2026-10-12)

The project owner approved this ADR on 2026-10-12 and delegated day-to-day
project management for the remainder of Phase 4 to AutoClaw (the previous
project manager is unavailable). Approval was given in-session and is recorded
here per §2.1; implementation may start.

Decisions taken on approval (previously open):

- **A-2 — registration identifier:** Option 1, email + password. `users.email`
  keeps its current shape; a nullable `mobile` column is added now so Option 2
  stays reachable without a data migration.
- **A-3 — password hashing:** built-in `scrypt` (`node:crypto`), zero
  dependencies; this supersedes the WO-0001 `argon2id` wording for now.
- **A-4 — session storage shape:** global, non-RLS `sessions` and
  `auth_attempts`; per-table grants (`hmn_app` DML, `hmn_platform` nothing) with
  the ADR-0003 review rationale recorded in the creating migration.
- **A-5 — session TTLs and rate limits:** 12 h idle / 30 d absolute; rotation
  on login and on privilege change with a 60 s single-use grace; 10 failed
  attempts per 15 min per identifier + IP.
- **A-6 — CSRF:** layered — synchronizer token (`@fastify/csrf-protection`) +
  `SameSite=Lax` + Origin check — required before the first cookie-authenticated
  state-changing route ships.
- **A-7 — tenant role set:** canonical `OWNER | DOCTOR | RECEPTION`; the
  separate `TENANT_ADMIN` is dropped (the in-clinic `OWNER` carries
  administration) and `OPERATOR`/`STAFF` are not introduced. This resolves the
  D-A/D-B versus A-7 wording conflict; `audit_logs.actorRole` inherits the set.
- **A-1** stays open as proposed (tenant-scoped auth events now; global events
  deferred to the platform panel phase). **A-8** is settled by the A-7 set.

### Amendment — no email channel (owner, 2026-10-12)

The product uses **no email service at all**: there is no outbound email provider,
so email can never be a delivery channel (no verification links, no recovery
emails, no notifications). This supersedes the A-2 resolution recorded above;
the rest of the approval stands.

- **A-2 (amended) — login identifier: mobile.** Staff and platform admins are
  identified by `mobile`. `email` becomes an optional profile field and is never
  a channel. Verification, recovery and OTP flows go over SMS through the
  provider-agnostic adapter — the consequences D-B lists for Option 2 therefore
  now apply in full (rate-limited OTP, delivery-agnostic sender interface).
- Password sign-in (scrypt) stays for clinic staff; patients keep the
  no-account OTP booking path (unchanged).
- Schema consequence: `users.mobile` gains a unique index; `users.email`
  becomes nullable. The Phase-4 migration is not applied in any environment
  yet, so this lands in the same unapplied migration rather than a new one.

### Amendment 2 — access model: patient accounts and custom users (owner, 2026-10-12)

The panel serves two purposes (clinic/practice management **and** patient
self-service), across two tenant modes (solo practice vs multi-doctor clinic).
This refines the A-7 role set; the rest of the approval stands.

- **Patient access.** A patient may hold an account and see only their own
  appointments and own data. Patients do **not** join `tenant_memberships`:
  access resolves through a link between the account (`users`) and the patient
  record inside the tenant, and is never broader than that record. Patients sign
  in with mobile OTP (no password); booking without an account stays possible.
- **Custom users.** The clinic owner creates staff users and chooses which
  modules each one may use. Implementation model: **base role + per-user module
grants**, enforced in the application layer (RLS answers *which rows*, never
  *which actions* — ADR-0003 D5). `DOCTOR` gets own-patient scope plus every
  module the owner grants.
- **Enum impact.** `tenant_memberships.role` keeps `OWNER | DOCTOR | RECEPTION`
  for now; a `CUSTOM` value is added **additively** (`ALTER TYPE ... ADD VALUE`)
  when the module-grant slice lands, because adding an enum value is cheap and
  removing one would require another swap.

## Context

Phase 3 is closed (commits `24b8359`, `391b1d3`, `c551634`; 130/130 tests per the
ADR-0003 execution record). Today there is no authentication at all: `users`
(global), `tenant_memberships` (RLS) and the subscription tables exist, but
`PLATFORM_OWNER` still sits inside the `UserRole` enum that types
`tenant_memberships.role` — the exact defect ADR-0003/D5 declares an architecture
defect and defers to this ADR. The API exposes only health endpoints. Zero
business rows exist, so enum changes are cheap.

This ADR is design-only. Implementation starts only after the owner approves this
document and that approval is recorded here (static rule §2.1).

### D-A — Platform identity separation (Required by WO-0001, owner-approved)

**Decision.** Platform authority becomes structurally separate from tenant
membership:

- New global table `platform_admins` (`userId` unique, `mfaEnrolled`,
  timestamps) — the _only_ expression of platform-owner authority.
- `PLATFORM_OWNER` is removed from the `UserRole` enum; the enum becomes
  `TENANT_ADMIN | DOCTOR | RECEPTION`… plus an in-clinic `OWNER` role (D-B).
  `tenant_memberships.role` and `audit_logs.actorRole` are re-typed by the new
  enum. With zero rows today, the migration is a non-destructive type swap
  (create new enum, swap columns, drop old enum).
- No combination of `tenant_memberships` rows can ever yield platform
  authority (verified by new test S10 below); a platform session is recognised
  only by joining `platform_admins`, and platform write paths stay behind the
  ADR-0003 "Future privileged-function gate" — **out of scope here** (audit is
  not designed in this ADR; only its boundary is noted, per WO-0001 D-A).
- MFA for platform-owner sign-in is an owner requirement (ADR-0003, decision
  2026-10-08): TOTP (RFC 6238), enrolment on first platform login (no grace
  period), recovery codes. The secret must be recoverable, so it is encrypted
  — AES-256-GCM with an environment-provided key (`AUTH_SECRET_KEY`, never in
  the DB or logs), fresh 12-byte IV per encryption, `AAD = userId || factorId`,
  a `keyVersion` column for rotation. Recovery codes are single-use and stored
  hashed.

_Alternatives rejected._ Keeping `PLATFORM_OWNER` in the enum (the defect
itself); a `isPlatformOwner` boolean on `users` (weaker, still a shared-table
concept); HMAC-keyed TOTP secrets (not recoverable). MFA via SMS OTP is
rejected for this path because SMS is deferred and the adapter rule (Addendum
§6.2) has no provider yet.

### D-B — Tenant authentication (Required by WO-0001, owner-approved)

**Registration from the public site.** Self-service registration creates
`users` + `credentials`, a `tenant`, an `OWNER` membership for the creator, and
connects a trial subscription.

- **Registration identifier — both options designed; the owner decides
  (Addendum §6.3).**
  - _Option 1 — email + password (PROPOSED)._ Password hashing is required
    regardless; email verification needs only outbound **email**, not SMS; no
    dependency on the deferred SMS adapter. Consequence: the login identifier
    is email; password recovery goes through email.
  - _Option 2 — mobile + OTP._ Consequences: requires live SMS sending, which
    is currently deferred (WO-0001 D-B), so OTP registration would block the
    whole auth phase on the SMS adapter; requires OTP rate-limiting and a
    delivery-agnostic OTP sender interface; login identifier becomes the
    mobile number; recovery and MFA-via-SMS paths become provider-coupled.
    Because of §2.10, Option 2 also mandates the provider-agnostic SMS adapter
    before any registration flow can ship.
  - **PROPOSAL: start with Option 1 and keep the identifier abstract in the
    schema** (a nullable `email` / nullable `mobile` pair, both neutral
    columns) so Option 2 can be added later without a data migration.
- **Trial provision hook (design only; real provision is Phase 5).** At the end
  of the registration transaction, the flow inserts a `tenant_subscriptions`
  row for the chosen plan with `status = 'TRIALING'` and a computed
  `currentPeriodEnd`. No quota enforcement, no SMS credit, no plan catalogue
  logic is designed here — only the connection point and initial state,
  exactly as WO-0001 D-B scopes it. `subscription_plans` and
  `tenant_subscriptions` already exist from Phase 3.

**Password hashing — deviation from the WO text, flagged.** WO-0001 D-B names
`argon2id`. ADR-0004 previously PROPOSED Node's built-in `scrypt`. The
difference is material: `argon2` requires a native module (the known Windows
native-file lock / install fragility class recorded in this project), while
`scrypt` is built into `node:crypto` with zero dependencies. **PROPOSED:
`scrypt`** unless the owner explicitly prefers `argon2id`; final parameters
(N, r, p, keyLen, maxmem) are set after a benchmark, not guessed; the storage
format is self-describing (`scrypt$N$r$p$salt$hash`), env-driven with hard
floors validated at boot, and `needsRehash` upgrades transparently.

**Login, sessions.**

- Identifier: email or mobile (per the owner decision above); rate-limited
  with `auth_attempts` counters on PostgreSQL; non-enumerable responses
  (identical body/timing for unknown account vs wrong password — a dummy hash
  verify always runs); password recovery flow via the chosen identifier's
  channel (email link for Option 1).
- Sessions are **opaque, server-side, PostgreSQL-backed** — **PROPOSED and
  consistent with the owner's earlier opaque-session decision** — over JWT
  (rejected: no server-side revocation, and logout-everywhere becomes
  impossible). Cookie `HttpOnly` + `SameSite=Lax` (+ `Secure` outside dev);
  only `SHA-256(token)` is stored, never the raw token; rotation on login;
  logout is single-session or all-sessions; TTLs are proposals pending owner
  numbers.
- Tenant-scoped session data (`activeTenantId`) lives server-side and is
  re-validated against a live membership on every request; any client-supplied
  `tenant_id` is ignored as authority.
- **Tenant-facing tables of this ADR and RLS:** `sessions` and `auth_attempts`
  are designed as **global** (user-keyed, not tenant-keyed) because a session
  must exist _before_ a tenant is chosen and users may hold several
  memberships; carrying a `tenantId` there would make pre-choice sessions
  unrepresentable. They therefore get no RLS — with the explicit rationale that
  this is a deliberate, recorded decision (ADR-0003 review rule: "no tenantId"
  alone is not sufficient), access being controlled by per-table grants
  (`hmn_app` DML, `hmn_platform` **nothing**) plus application checks. If the
  owner prefers tenant-scoped session tables, the alternative is an explicit
  RLS design and the S1 lint extension — flagged as an open question rather
  than silently assumed.
- **In-clinic roles:** minimum set `OWNER | OPERATOR | STAFF` (PROPOSED) on the
  tenant enum; permitted actions per role are enforced in the application
  layer — RLS answers "which rows", never "which actions" (ADR-0003/D5).

**Auth events audit.** Registration, login success/failure, password change
and MFA events are recorded in `audit_logs` **only for tenant-scoped events**
(inside the same `withTenantTx` as the operation they describe). Global events
(platform sign-in, bootstrap) have no runtime-writeable representation today —
the current `audit_logs` RLS policy rejects tenant-less rows for any runtime
role (ADR-0003 D5 Implementation note) — so they are **deferred to the
platform-owner panel phase** behind the privileged-function gate. Recorded as
**open item A-1** below with a proposal for the owner.

### D-C — Migrations (Required by WO-0001, owner-approved)

- Applied migrations are append-only; this ADR adds a **new** forward-only
  migration and touches no existing one.
- The migration (single file) creates `platform_admins`,
  `platform_mfa_factors`, `credentials`, `sessions`, `auth_attempts`; swaps the
  `UserRole` enum without data loss; and ships **grants in the same file**:
  `hmn_app` DML only where flows need it, `hmn_platform` **SELECT-only where
  required — nothing on `credentials`/`sessions`/`platform_mfa_factors`**.
- `platform_admins`, `platform_mfa_factors`, `credentials`, `sessions` and
  `auth_attempts` are global tables without RLS (D-B rationale). **No new
  tenant-owned table is introduced by this ADR**; if the owner redirects the
  session design to tenant-scoped tables, they would be created with
  `ENABLE ROW LEVEL SECURITY` + the fail-closed
  `NULLIF(current_setting('app.current_tenant_id', true), '')` policy on both
  USING and WITH CHECK in the same migration, per static rule §2.2.
- `migration-rls-lint.test.ts` must keep passing without exception, and its
  table-set scope guard is extended (not weakened) with the new tables.

### D-D — Impact and test plan (Required by WO-0001, owner-approved)

- `packages/db`: new repositories (`platform`, `identity` module families per
  the ESLint boundary), `TenantTx` unchanged, boundary rules extended.
- `apps/api` (Fastify): auth routes + plugins. **PROPOSED plugins:**
  `@fastify/cookie` (session cookie), `@fastify/csrf-protection` (layered
  CSRF), `@fastify/rate-limit` as a thin front over the PostgreSQL-backed
  `auth_attempts` counters. New env vars: `AUTH_SECRET_KEY` (TOTP), optional
  scrypt tuning; **no new connection strings** — role separation
  (`DATABASE_URL` CLI-only / `DATABASE_APP_URL` runtime / `DATABASE_PLATFORM_URL`
  platform/tests) is preserved, no runtime uses `hmn_migrator` (rule §2.5).
- Tests — new: **S10** no combination of `tenant_memberships` rows yields
  platform authority (incl. `platform_admins` grants audit);
  **S11** auth routes reject requests without a valid session (negative path);
  **S12** session security (forged/expired/revoked/rotated tokens; raw token
  never persisted or logged); **S13** tenant extraction (unauthenticated → 401,
  forged client `tenant_id` ignored, no membership → zero rows);
  **S14** platform MFA (no `mfaSatisfied` session reaches a platform path;
  wrong TOTP rejected; recovery codes single-use; bootstrap is one-time);
  **U4** scrypt vectors, wrong password, malformed hash, parameter floors,
  timing band. Tests — preserved: **S1–S9, S1b, S1c, U1–U3 must never be
  removed, skipped or weakened**; if any change breaks one, either the design
  is wrong or a test update requires owner approval — report and wait
  (static rule §2.3).

## Consequences

- **Positive.** Platform authority becomes structurally unreachable from
  tenant membership; credentials, session tokens and MFA secrets are invisible
  to `hmn_platform`; registration connects cleanly to the Phase 5 trial hook
  with `TRIALING` initial state; the existing isolation and lint guarantees
  remain intact.
- **Negative.** Five new tables and enum re-typing widen migration surface;
  scrypt vs argon2id is a deliberate deviation from the WO text requiring owner
  sign-off; global (non-RLS) session/attempt tables are a recorded design
  decision that depends on grant discipline plus S9/S14 assertions; trial
  provisioning remains a stub until Phase 5.
- **Risks.** `AUTH_SECRET_KEY` loss disables TOTP verification (recovery codes
  - `keyVersion` rotation mitigate); the identifier-abstraction adds two
    nullable columns to `users` (a documented cost of keeping both options open);
    mis-scoped grants on the new tables would widen `hmn_app` (S9/S14 guard).

## Open questions for the owner

_(A-2 to A-7 were resolved by the owner on 2026-10-12 — see "Owner approval"
above. A-1 remains open; A-8 is settled by the A-7 role set.)_

- **A-1 — Global auth events audit (per WO-0001 D-B + ADR-0003 D5 note).**
  Tenant-scoped auth events are auditable now; global ones (platform login,
  bootstrap) are not writeable by any runtime role under the current RLS.
  **PROPOSAL:** ship tenant-scoped audit events in this phase; defer global
  event auditing to the panel phase, behind the ADR-0003
  privileged-function gate, so no policy weakening happens here.
- A-2 — Registration identifier: email+password (proposed) vs mobile+OTP.
- A-3 — Password hashing: built-in scrypt (proposed; the WO named argon2id) —
  owner sign-off required for the deviation.
- A-4 — Session storage shape: global non-RLS tables (proposed) vs
  tenant-scoped RLS tables.
- A-5 — Session TTLs, rotation grace, rate-limit numbers.
- A-6 — CSRF mechanism confirmation (layered: synchronizer token + SameSite +
  Origin).
- A-7 — In-clinic role set confirmation (`OWNER | OPERATOR | STAFF`).
- A-8 — `audit_logs.actorRole` representation after the enum change.

## Phase 4 test plan (numbering continues from ADR-0003)

S10 platform-authority impossibility via memberships · S11 unauthenticated
rejection · S12 session security · S13 tenant extraction negatives · S14 MFA
and bootstrap · U4 hashing unit suite — full table to be expanded at
implementation time; S1–S9/S1b/S1c/U1–U3 preserved unconditionally.

## SMS and domain constraints (Addendum §6 — recorded, no design)

- **Domain:** no domain design, selection or implementation is done here; the
  choice is deferred to launch time and the project runs locally until then.
  The Phase 3 `domains` table stays untouched.
- **SMS:** any future SMS code is built **behind a provider-agnostic adapter**
  so switching providers (ملی‌پیامک ↔ پنا) is a **config-only** change. This
  ADR records only the constraint; SMS architecture is out of scope here.
