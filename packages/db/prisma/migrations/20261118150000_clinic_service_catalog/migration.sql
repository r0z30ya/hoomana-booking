CREATE TABLE "clinic_services" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
 "title" VARCHAR(120) NOT NULL, "duration" INTEGER NOT NULL CHECK ("duration" BETWEEN 5 AND 480),
 "interval" INTEGER NOT NULL CHECK ("interval" BETWEEN 5 AND 480), "capacity" INTEGER NOT NULL CHECK ("capacity" BETWEEN 1 AND 100),
 "totalTomans" INTEGER NOT NULL CHECK ("totalTomans" >= 0), "depositTomans" INTEGER,
 "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ("depositTomans" IS NULL OR ("depositTomans" >= 0 AND "depositTomans" <= "totalTomans")),
 UNIQUE ("tenantId", "id")
);
CREATE INDEX ON "clinic_services" ("tenantId");
CREATE UNIQUE INDEX "scheduling_doctors_tenant_id_id_key" ON "scheduling_doctors" ("tenantId", "id");
CREATE TABLE "doctor_service_assignments" (
 "tenantId" UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
 "doctorId" UUID NOT NULL,
 "clinicServiceId" UUID NOT NULL, "engineServiceId" VARCHAR(64) NOT NULL,
 "active" BOOLEAN NOT NULL DEFAULT TRUE,
 PRIMARY KEY ("doctorId", "clinicServiceId"), UNIQUE ("tenantId", "engineServiceId"),
 FOREIGN KEY ("tenantId", "doctorId") REFERENCES "scheduling_doctors"("tenantId", "id") ON DELETE CASCADE,
 FOREIGN KEY ("tenantId", "clinicServiceId") REFERENCES "clinic_services"("tenantId", "id") ON DELETE CASCADE
);
CREATE INDEX ON "doctor_service_assignments" ("tenantId");
ALTER TABLE "clinic_services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clinic_services" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "clinic_services" USING ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
ALTER TABLE "doctor_service_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "doctor_service_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "doctor_service_assignments" USING ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON "clinic_services", "doctor_service_assignments" TO hmn_app;
