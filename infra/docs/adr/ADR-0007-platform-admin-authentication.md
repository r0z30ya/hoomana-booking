# ADR-0007 — Platform admin authentication: sessions, MFA and secret handling

- **Status:** Proposed (implementation proceeds under the owner-approved work plan rev 1, 2026-10-13)
- **Date:** 2026-10-13
- **Phase:** 5 — platform panel MVP (step 1: sign-in)
- **Deciders:** Project owner, Lead Developer
- **Related:** ADR-0003 (isolation), ADR-0004 D-A/D-C (platform identity, MFA requirement), ADR-0006 (admin origin), `infra/docs/design/platform-panel-spec.md`

## Context

- The platform panel is the vendor console; sign-in is restricted to `platform_admins` and MFA is mandatory (ADR-0004 D-A). `platform_mfa_factors` already models both factor shapes: TOTP (AES-256-GCM ciphertext, fresh 12-byte IV, `AAD = userId || factorId`, `keyVersion` for rotation) and single-use recovery codes (SHA-256 only).
- The Phase-4 tenant auth stack provides reviewed, reusable pieces: scrypt hashing (`@hmn/shared`), `credentials`, `auth_attempts` rate limiting, opaque server-side `sessions` (only the SHA-256 token hash is stored).
- `hmn_platform` holds SELECT-only grants (ADR-0003 D5/D6): every write — including audit rows — must go through `SECURITY DEFINER` functions owned by the migrator.

## Decisions

### D1 — Sign-in flow (mobile + passphrase + mandatory TOTP)

- Step 1: mobile + passphrase, verified with the same scrypt contract and the same non-enumerable responses as tenant sign-in (unknown account and wrong passphrase are indistinguishable).
- Step 2: TOTP. **First sign-in enrols MFA**: the server generates the secret, returns the `otpauth://` URI plus the base32 secret, and the sign-in completes only after a correct code confirms enrolment.
- Recovery: 8 single-use codes stored as SHA-256 hashes; consuming one marks only that row (`usedAt`).

### D2 — Sessions and cookies

- Dedicated host-only cookie `hmn_admin_session` (HttpOnly; SameSite=Lax; Secure in production) on the admin origin only (ADR-0006).
- Same `sessions` table: a session is a _platform_ session iff its user has an active `platform_admins` row; `activeTenantId` stays NULL for platform sessions.
- Platform TTLs: 4 h idle / 24 h absolute — deliberately shorter than the tenant 12 h / 30 d; both remain tunable constants.
- Rate limiting reuses `auth_attempts` (identifier + IP) with the same lockout policy as tenant sign-in.

### D3 — Secret handling

- AES-256-GCM, 12-byte IV, `AAD = "<userId>|<factorId>"`; key material from `AUTH_MFA_ENCRYPTION_KEY` (base64 of exactly 32 bytes) with `AUTH_MFA_KEY_VERSION`; rotation works because each row carries the version it was written with.
- Missing or invalid key: MFA features **fail closed** — platform sign-in refuses to run; there is no half-configured path. Boot does not require the key, so the tenant stack keeps working without MFA configuration.

### D4 — Implementation choices (no new dependency)

- TOTP is implemented in-house (RFC 6238: HMAC-SHA1, 6 digits, 30 s step, ±1 step window) together with base32 — same rationale as scrypt: `node:crypto` only, no native module, nothing extra to keep patched; unit-tested against the published RFC 4226/6238 vectors.
- Enrolment returns an `otpauth://` URI and the base32 secret for manual entry; a QR image can be added later behind a reviewed, client-side-only dependency.
- Security events (sign-in success/failure, MFA enrol/verify failure) are recorded into `audit_logs` through a `SECURITY DEFINER` function (the ADR-0003 privileged-function gate).

## Consequences

- One new environment variable; platform sign-in cannot start without it (by design).
- The tenant auth stack is untouched; the platform boundary is enforced by explicit grants plus tests (a tenant user must never be able to sign in via platform routes, and vice versa).
- Follow-ups: decide on a QR dependency when the enrolment UI lands; review platform-session TTLs after the panel is in daily use.
