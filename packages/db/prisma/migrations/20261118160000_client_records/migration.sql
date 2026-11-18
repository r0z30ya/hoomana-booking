CREATE TABLE "client_records" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
 "firstName" VARCHAR(80) NOT NULL, "lastName" VARCHAR(80) NOT NULL, "fatherName" VARCHAR(80),
 "birthDate" VARCHAR(10), "nationalId" VARCHAR(10), "fileNumber" VARCHAR(80), "mobile" VARCHAR(11) NOT NULL,
 "address" VARCHAR(500), "occupation" VARCHAR(120), "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE ("tenantId", "id")
);
CREATE INDEX ON "client_records" ("tenantId", "mobile");
CREATE UNIQUE INDEX "client_records_tenant_file_number_key" ON "client_records" ("tenantId", "fileNumber") WHERE "fileNumber" IS NOT NULL;
CREATE UNIQUE INDEX "client_records_tenant_national_id_key" ON "client_records" ("tenantId", "nationalId") WHERE "nationalId" IS NOT NULL;
CREATE TABLE "client_booking_links" (
 "tenantId" UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE, "clientId" UUID NOT NULL,
 "doctorId" UUID NOT NULL, "bookingUid" VARCHAR(100) NOT NULL, PRIMARY KEY ("tenantId", "bookingUid"),
 FOREIGN KEY ("tenantId", "clientId") REFERENCES "client_records"("tenantId", "id") ON DELETE CASCADE,
 FOREIGN KEY ("tenantId", "doctorId") REFERENCES "scheduling_doctors"("tenantId", "id") ON DELETE CASCADE
);
CREATE INDEX ON "client_booking_links" ("tenantId", "clientId");
ALTER TABLE "client_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "client_records" USING ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
ALTER TABLE "client_booking_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_booking_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "client_booking_links" USING ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON "client_records", "client_booking_links" TO hmn_app;

CREATE TABLE "client_payments" ("id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE, "clientId" UUID NOT NULL, "amountTomans" INTEGER NOT NULL CHECK ("amountTomans" > 0), "paidAt" TIMESTAMPTZ(6) NOT NULL, "method" VARCHAR(30) NOT NULL, "note" VARCHAR(500), "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY ("tenantId", "clientId") REFERENCES "client_records"("tenantId", "id") ON DELETE CASCADE);
CREATE INDEX ON "client_payments" ("tenantId", "clientId");
ALTER TABLE "client_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "client_payments" USING ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON "client_payments" TO hmn_app;
