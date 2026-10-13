-- Owner decision 2026-10-13: signup and sign-in start with an SMS one-time code, and
-- the clinic address is collected right after.
--
-- `auth_otps` is global (keyed by the identifier, not by a user) because signup has no
-- user yet and a code must be verifiable before any session exists. It therefore gets no
-- RLS — the same recorded reasoning as `sessions` / `auth_attempts` (ADR-0004 A-4).
--
-- Only the SHA-256 of the code is stored, never the code itself. `hmn_platform` receives
-- NOTHING on this table: a live code is a credential (ADR-0004 D-C fence).

CREATE TABLE "auth_otps" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "identifier" VARCHAR(320) NOT NULL,
  "purpose"    VARCHAR(20)  NOT NULL,
  "codeHash"   VARCHAR(64)  NOT NULL,
  "expiresAt"  TIMESTAMPTZ(6) NOT NULL,
  "attempts"   INTEGER      NOT NULL DEFAULT 0,
  "consumedAt" TIMESTAMPTZ(6),
  "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "auth_otps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auth_otps_purpose_check" CHECK ("purpose" IN ('SIGNUP', 'LOGIN', 'RECOVERY'))
);

CREATE INDEX "auth_otps_identifier_purpose_createdAt_idx"
  ON "auth_otps"("identifier", "purpose", "createdAt");

-- The clinic address captured after signup lives on the tenant itself.
ALTER TABLE "tenants" ADD COLUMN "address" VARCHAR(500);
ALTER TABLE "tenants" ADD COLUMN "city" VARCHAR(120);

-- Tenant runtime: the signup/sign-in flows run as hmn_app.
GRANT SELECT, INSERT, UPDATE, DELETE ON "auth_otps" TO hmn_app;
