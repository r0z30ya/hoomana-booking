-- Apply ONLY to a backed-up SQLite database with this exact original schema.
-- Stop all hnobat processes first. This is a one-time table rebuild, not an
-- automatically tracked Prisma migration. Verify PRAGMA foreign_key_check after.
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;
CREATE TABLE "new_Attendee" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "bookingId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "timeZone" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "noShow" BOOLEAN NOT NULL DEFAULT false,
    "phone" TEXT,
    CONSTRAINT "Attendee_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Attendee" ("id", "bookingId", "name", "email", "timeZone", "locale", "noShow", "phone")
SELECT "id", "bookingId", "name", "email", "timeZone", "locale", "noShow", "phone" FROM "Attendee";
DROP TABLE "Attendee";
ALTER TABLE "new_Attendee" RENAME TO "Attendee";
COMMIT;
PRAGMA foreign_keys=ON;
