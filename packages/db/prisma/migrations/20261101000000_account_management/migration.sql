-- Phase 5 account management: domain verification metadata, tenant SMS credentials
-- and a safe default-tenant lookup for authenticated staff sessions.

CREATE TYPE "DomainVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED');

ALTER TABLE "domains"
  ADD COLUMN "verificationStatus" "DomainVerificationStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "verificationToken" VARCHAR(128),
  ADD COLUMN "verificationMethod" VARCHAR(20) NOT NULL DEFAULT 'DNS_TXT',
  ADD COLUMN "lastCheckedAt" TIMESTAMPTZ(6),
  ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "domains_verificationToken_key" ON "domains"("verificationToken");

CREATE TABLE "tenant_sms_accounts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "provider" VARCHAR(40) NOT NULL,
  "panelRefCiphertext" BYTEA NOT NULL,
  "panelRefIv" BYTEA NOT NULL,
  "panelRefAuthTag" BYTEA NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "sender" VARCHAR(20) NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "lastError" VARCHAR(500),
  "lastVerifiedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenant_sms_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_sms_accounts_tenantId_key" UNIQUE ("tenantId"),
  CONSTRAINT "tenant_sms_accounts_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "tenant_sms_accounts_tenantId_idx" ON "tenant_sms_accounts"("tenantId");

ALTER TABLE "tenant_sms_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_sms_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenant_sms_accounts"
  USING ("tenantId"::text = NULLIF(current_setting('app.current_tenant_id', true), ''))
  WITH CHECK ("tenantId"::text = NULLIF(current_setting('app.current_tenant_id', true), ''));

GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_sms_accounts" TO hmn_app;
GRANT SELECT ON "tenant_sms_accounts" TO hmn_platform;

-- A session created by password/OTP login needs a safe tenant to activate. The
-- function exposes only the caller-supplied user's first active membership and
-- does not grant table access to the runtime role.
CREATE FUNCTION public.user_default_tenant(p_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m."tenantId"
  FROM public.tenant_memberships m
  INNER JOIN public.tenants t ON t.id = m."tenantId"
  INNER JOIN public.users u ON u.id = m."userId"
  WHERE m."userId" = p_user_id
    AND u."isActive" IS TRUE
    AND t."isSuspended" IS FALSE
  ORDER BY m."createdAt" ASC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.user_default_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_default_tenant(uuid) TO hmn_app;
