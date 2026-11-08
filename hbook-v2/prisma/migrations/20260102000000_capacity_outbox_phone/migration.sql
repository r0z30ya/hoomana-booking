-- hbook v2 — capacity, mobile-first patients, webhook outbox, tenant isolation.
-- Written to PRESERVE all existing data (no table is dropped; legacy rows are
-- migrated in place).

-- ───────────────────────── 1. capacity ─────────────────────────
ALTER TABLE "EventType" ADD COLUMN "capacity" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "EventType" ADD COLUMN "externalId" VARCHAR(128);
ALTER TABLE "User" ADD COLUMN "externalId" VARCHAR(128);
ALTER TABLE "Booking" ADD COLUMN "externalId" VARCHAR(128);

CREATE UNIQUE INDEX "User_tenantId_externalId_key" ON "User"("tenantId", "externalId");
CREATE UNIQUE INDEX "EventType_tenantId_externalId_key" ON "EventType"("tenantId", "externalId");
CREATE UNIQUE INDEX "Booking_tenantId_externalId_key" ON "Booking"("tenantId", "externalId");

-- ───────────────────── 2. patient = mobile first ─────────────────────
ALTER TABLE "Booking" ALTER COLUMN "attendeeEmail" DROP NOT NULL;
CREATE INDEX "Booking_attendeePhone_idx" ON "Booking"("attendeePhone");

-- Owner/doctor email becomes optional (multiple NULLs are allowed by PG unique).
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;

-- ─────────────────────── 3. API key scopes ───────────────────────
ALTER TABLE "ApiKey" ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY['admin']::text[];

-- ─────────────────────── 4. slot seat accounting ───────────────────────
CREATE TABLE "SlotInstance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "eventTypeId" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "taken" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SlotInstance_pkey" PRIMARY KEY ("id"),
    -- Hard DB guarantee: active seats can never exceed capacity.
    CONSTRAINT "SlotInstance_taken_bounds" CHECK ("taken" >= 0 AND "taken" <= "capacity")
);
CREATE UNIQUE INDEX "SlotInstance_hostId_eventTypeId_startsAt_key" ON "SlotInstance"("hostId", "eventTypeId", "startsAt");
CREATE INDEX "SlotInstance_tenantId_idx" ON "SlotInstance"("tenantId");

-- Seed one instance per existing active booking group so the counter stays exact.
INSERT INTO "SlotInstance" ("id", "tenantId", "hostId", "eventTypeId", "startsAt", "endsAt", "capacity", "taken", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  b."tenantId",
  b."hostId",
  b."eventTypeId",
  b."startsAt",
  b."endsAt",
  e."capacity",
  count(*)::int,
  now(),
  now()
FROM "Booking" b
JOIN "EventType" e ON e."id" = b."eventTypeId"
WHERE b."status" IN ('PENDING', 'CONFIRMED')
GROUP BY b."tenantId", b."hostId", b."eventTypeId", b."startsAt", b."endsAt", e."capacity";

-- ─────────────── 5. composite (id, tenantId) uniques for FKs ───────────────
ALTER TABLE "User" ADD CONSTRAINT "User_id_tenantId_key" UNIQUE ("id", "tenantId");
ALTER TABLE "EventType" ADD CONSTRAINT "EventType_id_tenantId_key" UNIQUE ("id", "tenantId");
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_id_tenantId_key" UNIQUE ("id", "tenantId");

-- Composite FKs: a child row can only reference parents of the SAME tenant.
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_eventTypeId_fkey";
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_eventType_tenant_fkey" FOREIGN KEY ("eventTypeId", "tenantId") REFERENCES "EventType"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Booking" DROP CONSTRAINT "Booking_hostId_fkey";
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_host_tenant_fkey" FOREIGN KEY ("hostId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Availability" DROP CONSTRAINT "Availability_userId_fkey";
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_user_tenant_fkey" FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DateOverride" DROP CONSTRAINT "DateOverride_userId_fkey";
ALTER TABLE "DateOverride" ADD CONSTRAINT "DateOverride_user_tenant_fkey" FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SlotInstance" ADD CONSTRAINT "SlotInstance_eventType_tenant_fkey" FOREIGN KEY ("eventTypeId", "tenantId") REFERENCES "EventType"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SlotInstance" ADD CONSTRAINT "SlotInstance_host_tenant_fkey" FOREIGN KEY ("hostId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Booking_hostId_eventTypeId_startsAt_idx" ON "Booking"("hostId", "eventTypeId", "startsAt");

-- ─────────────────── 6. webhook outbox + queue ───────────────────
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED');

CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WebhookEvent_tenantId_createdAt_idx" ON "WebhookEvent"("tenantId", "createdAt");
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WebhookDelivery" ADD COLUMN "eventId" TEXT;
ALTER TABLE "WebhookDelivery" ADD COLUMN "eventType" VARCHAR(40);
ALTER TABLE "WebhookDelivery" ADD COLUMN "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "WebhookDelivery" ADD COLUMN "nextAttemptAt" TIMESTAMPTZ(3);
ALTER TABLE "WebhookDelivery" ADD COLUMN "lastAttemptAt" TIMESTAMPTZ(3);
ALTER TABLE "WebhookDelivery" ADD COLUMN "lastStatusCode" INTEGER;
ALTER TABLE "WebhookDelivery" ADD COLUMN "lastError" VARCHAR(300);
ALTER TABLE "WebhookDelivery" ADD COLUMN "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now();

-- Preserve legacy delivery log rows: each becomes an outbox event + a
-- finished delivery row (DELIVERED or FAILED).
DO $$
DECLARE
  r RECORD;
  v_event_id TEXT;
BEGIN
  FOR r IN SELECT * FROM "WebhookDelivery" LOOP
    INSERT INTO "WebhookEvent" ("id", "tenantId", "type", "data", "createdAt")
    VALUES (gen_random_uuid()::text, r."tenantId", r."event", r."payload", r."createdAt")
    RETURNING "id" INTO v_event_id;

    UPDATE "WebhookDelivery" SET
      "eventId" = v_event_id,
      "eventType" = r."event",
      "status" = (CASE WHEN r."success" THEN 'DELIVERED' ELSE 'FAILED' END)::"DeliveryStatus",
      "attempt" = r."attempt",
      "nextAttemptAt" = CASE WHEN r."success" THEN NULL ELSE now() END,
      "lastAttemptAt" = r."createdAt",
      "lastStatusCode" = r."statusCode",
      "lastError" = r."error"
    WHERE "id" = r."id";
  END LOOP;
END $$;

ALTER TABLE "WebhookDelivery" ALTER COLUMN "eventId" SET NOT NULL;
ALTER TABLE "WebhookDelivery" ALTER COLUMN "eventType" SET NOT NULL;
ALTER TABLE "WebhookDelivery" DROP COLUMN "payload";
ALTER TABLE "WebhookDelivery" DROP COLUMN "success";
ALTER TABLE "WebhookDelivery" DROP COLUMN "statusCode";
ALTER TABLE "WebhookDelivery" DROP COLUMN "error";
ALTER TABLE "WebhookDelivery" RENAME COLUMN "attempt" TO "attempts";
ALTER TABLE "WebhookDelivery" DROP COLUMN "event";

ALTER TABLE "WebhookDelivery" DROP CONSTRAINT "WebhookDelivery_webhookId_fkey";
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "WebhookEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_webhook_tenant_fkey" FOREIGN KEY ("webhookId", "tenantId") REFERENCES "Webhook"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "WebhookDelivery_webhookId_eventId_key" ON "WebhookDelivery"("webhookId", "eventId");
CREATE INDEX "WebhookDelivery_queue_idx" ON "WebhookDelivery"("status", "nextAttemptAt");
CREATE INDEX "WebhookDelivery_tenantId_eventType_idx" ON "WebhookDelivery"("tenantId", "eventType");

-- ─────────────────────── 7. idempotency ───────────────────────
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "endpoint" VARCHAR(120) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IdempotencyKey_tenantId_key_key" ON "IdempotencyKey"("tenantId", "key");
CREATE INDEX "IdempotencyKey_createdAt_idx" ON "IdempotencyKey"("createdAt");
ALTER TABLE "IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────── 8. capacity/overlap guard (defense in depth) ───────────
-- The old EXCLUDE constraint allowed exactly ONE active booking per host
-- overlap window — it cannot express capacity > 1, so it is replaced by:
--   * SlotInstance CHECK (taken <= capacity)      → hard capacity guarantee
--   * this constraint trigger                      → full re-check for any
--     writer that bypasses the engine (raw SQL), incl. per-booking buffers
--   * pg_advisory_xact_lock(hostId) taken by the API BEFORE its checks
-- Note: btree_gist is no longer required and may be dropped safely.
ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS "booking_no_host_overlap";

CREATE OR REPLACE FUNCTION "hbook_assert_booking_fit"() RETURNS trigger AS $fn$
DECLARE
  v_capacity INTEGER;
  v_before INTEGER;
  v_after INTEGER;
  v_same INTEGER;
  v_overlap INTEGER;
BEGIN
  IF NEW."status" NOT IN ('PENDING', 'CONFIRMED') THEN
    RETURN NULL;
  END IF;

  SELECT "capacity", "bufferBeforeMin", "bufferAfterMin"
    INTO v_capacity, v_before, v_after
    FROM "EventType" WHERE "id" = NEW."eventTypeId";

  -- Same advisory lock the API path takes: serializes writers per host.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."hostId", 0));

  -- (a) same-group capacity: (host, event type, exact start)
  SELECT count(*) INTO v_same FROM "Booking" b
   WHERE b."hostId" = NEW."hostId"
     AND b."eventTypeId" = NEW."eventTypeId"
     AND b."startsAt" = NEW."startsAt"
     AND b."status" IN ('PENDING', 'CONFIRMED')
     AND b."id" <> NEW."id";
  IF v_same + 1 > v_capacity THEN
    RAISE EXCEPTION 'HBOOK_CAPACITY_EXCEEDED: active bookings for this slot would exceed capacity %', v_capacity;
  END IF;

  -- (b) cross-group overlap with per-booking buffers (different event type
  --     or different start is always a conflict).
  SELECT count(*) INTO v_overlap
    FROM "Booking" b
    JOIN "EventType" e ON e."id" = b."eventTypeId"
   WHERE b."hostId" = NEW."hostId"
     AND b."status" IN ('PENDING', 'CONFIRMED')
     AND (b."eventTypeId" <> NEW."eventTypeId" OR b."startsAt" <> NEW."startsAt")
     AND tstzrange(b."startsAt" - make_interval(mins => e."bufferBeforeMin"),
                   b."endsAt" + make_interval(mins => e."bufferAfterMin"), '[)')
         &&
         tstzrange(NEW."startsAt" - make_interval(mins => v_before),
                   NEW."endsAt" + make_interval(mins => v_after), '[)');
  IF v_overlap > 0 THEN
    RAISE EXCEPTION 'HBOOK_OVERLAP: buffered window overlaps an existing booking';
  END IF;

  RETURN NULL;
END $fn$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "booking_fit_guard"
  AFTER INSERT OR UPDATE OF "hostId", "eventTypeId", "startsAt", "endsAt", "status"
  ON "Booking"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION "hbook_assert_booking_fit"();
