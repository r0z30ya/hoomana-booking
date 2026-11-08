LOCK TABLE "Booking", "SlotInstance", "EventType" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "EventType"
  ADD CONSTRAINT "EventType_host_tenant_fkey"
  FOREIGN KEY ("hostId", "tenantId") REFERENCES "User" ("id", "tenantId");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Booking" b
    JOIN "EventType" e ON e."id" = b."eventTypeId"
    WHERE b."status" IN ('PENDING', 'CONFIRMED')
    GROUP BY b."hostId", b."eventTypeId", b."startsAt", e."capacity"
    HAVING count(*) > e."capacity"
  ) THEN
    RAISE EXCEPTION 'Cannot reconcile seat counters: active bookings exceed service capacity';
  END IF;
END $$;

UPDATE "SlotInstance" SET "taken" = 0, "updatedAt" = now();

INSERT INTO "SlotInstance" (
  "id", "tenantId", "hostId", "eventTypeId", "startsAt", "endsAt",
  "capacity", "taken", "createdAt", "updatedAt"
)
SELECT gen_random_uuid()::text, b."tenantId", b."hostId", b."eventTypeId",
       b."startsAt", max(b."endsAt"), e."capacity", count(*)::int, now(), now()
FROM "Booking" b
JOIN "EventType" e ON e."id" = b."eventTypeId"
WHERE b."status" IN ('PENDING', 'CONFIRMED')
GROUP BY b."tenantId", b."hostId", b."eventTypeId", b."startsAt", e."capacity"
ON CONFLICT ("hostId", "eventTypeId", "startsAt")
DO UPDATE SET "taken" = EXCLUDED."taken", "capacity" = EXCLUDED."capacity",
              "endsAt" = EXCLUDED."endsAt", "updatedAt" = now();
