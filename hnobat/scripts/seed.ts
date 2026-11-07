/**
 * hnobat seed — demo host with a Tehran-timezone schedule, event types and an API key.
 * Idempotent: safe to run repeatedly (upserts by email/slug).
 *
 * Run:  bunx tsx scripts/seed.ts   (or bun scripts/seed.ts)
 */
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, scryptSync } from "crypto";

const db = new PrismaClient();

const DEMO_EMAIL = "demo@hnobat.io";
const DEMO_PASSWORD = "hnobat1234";
const DEMO_USERNAME = "demo";

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

async function main() {
  console.log("Seeding hnobat demo data...");

  // ---- demo host (timezone: Asia/Tehran, like a real Iranian customer) ----
  const user = await db.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: {
      username: DEMO_USERNAME,
      name: "کاربر نمونه hnobat",
      email: DEMO_EMAIL,
      passwordHash: hashPassword(DEMO_PASSWORD),
      timeZone: "Asia/Tehran",
      weekStart: "Saturday",
      timeFormat: 24,
    },
  });

  // ---- schedule: Sat-Wed 09:00-17:00 Tehran (Iranian work week), Thursday 09:00-13:00 ----
  let schedule = await db.schedule.findFirst({ where: { userId: user.id, name: "ساعات کاری هفتگی" } });
  if (!schedule) {
    schedule = await db.schedule.create({
      data: {
        userId: user.id,
        name: "ساعات کاری هفتگی",
        timeZone: "Asia/Tehran",
        availability: {
          create: [
            // JS weekday: 0=Sunday 1=Monday 2=Tuesday 3=Wednesday 4=Thursday 5=Friday 6=Saturday
            { days: JSON.stringify([6, 0, 1, 2, 3]), startTime: new Date(Date.UTC(1970, 0, 1, 9, 0)), endTime: new Date(Date.UTC(1970, 0, 1, 17, 0)) },
            { days: JSON.stringify([4]), startTime: new Date(Date.UTC(1970, 0, 1, 9, 0)), endTime: new Date(Date.UTC(1970, 0, 1, 13, 0)) },
          ],
        },
      },
    });
  }
  await db.user.update({ where: { id: user.id }, data: { defaultScheduleId: schedule.id } });

  // ---- event types ----
  const consultation = await db.eventType.upsert({
    where: { userId_slug: { userId: user.id, slug: "consultation-30" } },
    update: {},
    create: {
      userId: user.id,
      title: "مشاوره ۳۰ دقیقه‌ای",
      slug: "consultation-30",
      description: "جلسهٔ مشاورهٔ کوتاه ۳۰ دقیقه‌ای",
      length: 30,
      scheduleId: schedule.id,
      minimumBookingNotice: 120,
      afterBufferTime: 0,
      locations: JSON.stringify(["integrations:daily"]),
    },
  });

  const meeting = await db.eventType.upsert({
    where: { userId_slug: { userId: user.id, slug: "team-meeting-60" } },
    update: {},
    create: {
      userId: user.id,
      title: "جلسهٔ تیمی ۶۰ دقیقه‌ای",
      slug: "team-meeting-60",
      description: "جلسهٔ کامل یک‌ساعته با تأیید میزبان",
      length: 60,
      scheduleId: schedule.id,
      requiresConfirmation: true,
      slotInterval: 60,
      minimumBookingNotice: 180,
    },
  });

  // ---- API key for the demo user (printed once) ----
  const existingKey = await db.apiKey.findFirst({ where: { userId: user.id, name: "demo-key" } });
  let demoKey: string | null = null;
  if (!existingKey) {
    demoKey = `hnb_${randomBytes(24).toString("base64url")}`;
    await db.apiKey.create({
      data: {
        userId: user.id,
        name: "demo-key",
        hashedKey: createHash("sha256").update(demoKey).digest("hex"),
      },
    });
  }

  console.log(`
================= hnobat seed complete =================
Host login (JWT):     ${DEMO_EMAIL} / ${DEMO_PASSWORD}
Public booking page:  username="${DEMO_USERNAME}"
Event types:          #${consultation.id} /${consultation.slug} (30 min)
                      #${meeting.id} /${meeting.slug} (60 min, requiresConfirmation)
Schedule:             #${schedule.id} Sat-Wed 09:00-17:00, Thu 09:00-13:00 (${schedule.timeZone})
${demoKey ? `Demo API key (once):   ${demoKey}` : "Demo API key:        (already exists — create a new one via POST /api/v2/api-keys)"}
========================================================`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
