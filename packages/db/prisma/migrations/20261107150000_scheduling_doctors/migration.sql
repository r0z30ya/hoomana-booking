CREATE TABLE "scheduling_doctors" (
  "id" UUID NOT NULL PRIMARY KEY,
  "tenantId" UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" VARCHAR(200) NOT NULL,
  "engineUserId" INTEGER NOT NULL,
  "keyCiphertext" BYTEA NOT NULL,
  "keyIv" BYTEA NOT NULL,
  "keyAuthTag" BYTEA NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "scheduling_doctors_tenantId_idx" ON "scheduling_doctors"("tenantId");
ALTER TABLE "scheduling_doctors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scheduling_doctors" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "scheduling_doctors"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON "scheduling_doctors" TO hmn_app;
