-- Phase 4, step 1 — identity and authentication (ADR-0004, owner approval recorded
-- 2026-10-12). Forward-only migration: it creates nothing that existed before and
-- modifies no applied migration.
--
-- Contents:
--   1. Fail-closed guard for the enum re-typing (zero legacy role rows required).
--   2. `UserRole` re-typing (ADR-0004 D-A): OWNER | DOCTOR | RECEPTION | CUSTOM.
--   2b. `tenant_memberships.permissions` — per-module access for custom users.
--   3. Identity identifier (ADR-0004 A-2 amendment, 2026-10-12: the product uses
--      no email service). `users.mobile` gets a unique index; `users.email`
--      becomes nullable (optional profile field, never a channel).
--   4. The five global identity tables (ADR-0004 D-C).
--   5. Explicit per-table grants (ADR-0003 D5/D7: no schema-wide GRANT, no
--      DEFAULT PRIVILEGES, `_prisma_migrations` untouched).
--
-- RLS: none of these tables is tenant-owned — a session must exist *before* a
-- tenant is chosen and may span several memberships, so there is no tenant_id to
-- filter on. This is the recorded A-4 decision, not an omission (ADR-0003 review
-- rule: "no tenantId" alone is not sufficient rationale). Access is controlled by
-- the grants below plus application checks:
--
--   hmn_app      → DML on credentials, sessions, auth_attempts.
--                  NOTHING on platform_admins / platform_mfa_factors: platform
--                  authority must not be reachable from the tenant runtime.
--   hmn_platform → SELECT on platform_admins and auth_attempts only.
--                  NOTHING on credentials / sessions / platform_mfa_factors
--                  (ADR-0004 D-C): the audited platform path never reads password
--                  hashes, session tokens or MFA secrets.

-- ---------------------------------------------------------------------------
-- 1) Fail closed before the enum swap.
--
-- ADR-0004 D-A calls the re-typing "a non-destructive type swap" because the
-- project holds zero business rows today. That precondition is asserted rather
-- than assumed: if a legacy role row ever exists, this migration stops instead of
-- silently dropping authority that no longer has an enum value.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "tenant_memberships" WHERE "role"::text NOT IN ('OWNER', 'DOCTOR', 'RECEPTION', 'CUSTOM'))
     OR EXISTS (SELECT 1 FROM "audit_logs" WHERE "actorRole"::text NOT IN ('OWNER', 'DOCTOR', 'RECEPTION')) THEN
    RAISE EXCEPTION 'ADR-0004 D-A: legacy role rows found; resolve before applying this migration';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) UserRole re-typing (PostgreSQL cannot remove enum values in place).
-- ---------------------------------------------------------------------------
CREATE TYPE "UserRole_v2" AS ENUM ('OWNER', 'DOCTOR', 'RECEPTION', 'CUSTOM');

ALTER TABLE "tenant_memberships"
  ALTER COLUMN "role" TYPE "UserRole_v2" USING ("role"::text::"UserRole_v2");

ALTER TABLE "audit_logs"
  ALTER COLUMN "actorRole" TYPE "UserRole_v2" USING ("actorRole"::text::"UserRole_v2");

DROP TYPE "UserRole";
ALTER TYPE "UserRole_v2" RENAME TO "UserRole";

-- ---------------------------------------------------------------------------
-- 2b) Per-module access for custom users (owner requirement, 2026-10-12: "a user
--     created by the manager with the access to each module chosen"). Built-in
--     roles keep their defaults; `CUSTOM` must carry an explicit array, so a
--     custom user can never be created accidentally with no (or with all)
--     permissions.
--     Allowed module keys are validated in the application layer:
--     appointments | patients | doctors | scheduling | accounting | sms |
--     settings | reports
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_memberships" ADD COLUMN "permissions" JSONB;

ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_permissions_shape_check"
  CHECK ("permissions" IS NULL OR jsonb_typeof("permissions") = 'array');

-- A CUSTOM user must carry at least one module grant: an empty array would be a
-- user who can sign in and do nothing — a configuration mistake, not a state to
-- store silently.
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_custom_permissions_check"
  CHECK ("role" <> 'CUSTOM' OR ("permissions" IS NOT NULL AND jsonb_typeof("permissions") = 'array' AND jsonb_array_length("permissions") > 0));

-- ---------------------------------------------------------------------------
-- 3) Identity identifier (ADR-0004 A-2 amendment, 2026-10-12).
--    `mobile` is the login identifier and gains a unique index; it stays nullable
--    so partial rows are representable and the app layer enforces presence for
--    staff. `email` becomes an optional profile field — never a channel.
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN "mobile" VARCHAR(20);
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
CREATE UNIQUE INDEX "users_mobile_key" ON "users"("mobile");

-- ---------------------------------------------------------------------------
-- 4) Global identity tables.
-- ---------------------------------------------------------------------------

-- The only expression of platform-owner authority (ADR-0004 D-A).
CREATE TABLE "platform_admins" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "userId"      UUID         NOT NULL,
  "mfaEnrolled" BOOLEAN      NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_admins_userId_key" UNIQUE ("userId"),
  CONSTRAINT "platform_admins_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- MFA material (ADR-0004 D-A). Two row shapes:
--   TOTP     — AES-256-GCM ciphertext, fresh 12-byte IV per encryption,
--              AAD = userId || factorId, keyVersion for rotation.
--   RECOVERY — single-use code stored only as SHA-256 (hex).
CREATE TABLE "platform_mfa_factors" (
  "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
  "platformAdminId"  UUID         NOT NULL,
  "kind"             VARCHAR(20)  NOT NULL,
  "secretCiphertext" BYTEA,
  "secretIv"         BYTEA,
  "secretAuthTag"    BYTEA,
  "keyVersion"       INTEGER,
  "codeHash"         VARCHAR(64),
  "usedAt"           TIMESTAMPTZ(6),
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_mfa_factors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_mfa_factors_platformAdminId_fkey" FOREIGN KEY ("platformAdminId")
    REFERENCES "platform_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "platform_mfa_factors_kind_check" CHECK ("kind" IN ('TOTP', 'RECOVERY')),
  CONSTRAINT "platform_mfa_factors_shape_check" CHECK (
    ("kind" = 'TOTP'     AND "secretCiphertext" IS NOT NULL AND "secretIv" IS NOT NULL
                          AND "secretAuthTag" IS NOT NULL AND "keyVersion" IS NOT NULL
                          AND "codeHash" IS NULL)
    OR
    ("kind" = 'RECOVERY' AND "codeHash" IS NOT NULL AND "secretCiphertext" IS NULL
                          AND "secretIv" IS NULL AND "secretAuthTag" IS NULL)
  )
);

CREATE INDEX "platform_mfa_factors_platformAdminId_idx" ON "platform_mfa_factors"("platformAdminId");

-- Password credential (ADR-0004 A-2/A-3). Hash format: scrypt$N$r$p$salt$hash.
CREATE TABLE "credentials" (
  "id"                UUID         NOT NULL DEFAULT gen_random_uuid(),
  "userId"            UUID         NOT NULL,
  "passwordHash"      VARCHAR(255) NOT NULL,
  "passwordUpdatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credentials_userId_key" UNIQUE ("userId"),
  CONSTRAINT "credentials_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Opaque server-side session (ADR-0004 A-4/A-5). Only SHA-256(token) is stored.
-- TTLs: 12 h idle / 30 d absolute. Rotation chain via "rotatedFromId" with a 60 s
-- single-use grace. "activeTenantId" is re-validated against a live membership on
-- every request and is never accepted from the client as authority.
CREATE TABLE "sessions" (
  "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
  "userId"         UUID         NOT NULL,
  "tokenHash"      VARCHAR(64)  NOT NULL,
  "activeTenantId" UUID,
  "rotatedFromId"  UUID,
  "expiresAt"      TIMESTAMPTZ(6) NOT NULL,
  "idleExpiresAt"  TIMESTAMPTZ(6) NOT NULL,
  "lastSeenAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "revokedAt"      TIMESTAMPTZ(6),
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sessions_tokenHash_key" UNIQUE ("tokenHash"),
  CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sessions_activeTenantId_fkey" FOREIGN KEY ("activeTenantId")
    REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "sessions_rotatedFromId_fkey" FOREIGN KEY ("rotatedFromId")
    REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- Rate-limiting counters (ADR-0004 D-B): 10 failed attempts / 15 min per
-- identifier + IP. Keyed by identifier so unknown accounts are counted too.
CREATE TABLE "auth_attempts" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "identifier"  VARCHAR(320) NOT NULL,
  "ipAddress"   INET,
  "succeeded"   BOOLEAN      NOT NULL DEFAULT false,
  "attemptedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "auth_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "auth_attempts_identifier_attemptedAt_idx" ON "auth_attempts"("identifier", "attemptedAt");

-- ---------------------------------------------------------------------------
-- 5) Explicit grants (ADR-0003 D5/D7). Per-table only; no `ON ALL TABLES` and no
--    DEFAULT PRIVILEGES, so this migration cannot widen a future table either.
-- ---------------------------------------------------------------------------

-- Tenant runtime: full DML where the auth flows need it.
GRANT SELECT, INSERT, UPDATE, DELETE ON "credentials" TO hmn_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "sessions" TO hmn_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "auth_attempts" TO hmn_app;

-- Audited platform path (ADR-0003 D5): reads only, and only where support/audit
-- needs them. Deliberately NO grant on credentials, sessions, auth_attempts or
-- platform_mfa_factors (ADR-0004 D-C / A-4): password hashes, session tokens,
-- MFA secrets and login-attempt identifiers/IPs are not part of the platform
-- path. hmn_app likewise gets nothing on the platform tables — platform
-- authority must stay unreachable from tenant code.
GRANT SELECT ON "platform_admins" TO hmn_platform;
