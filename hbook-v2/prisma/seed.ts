/**
 * hbook — seed: demo clinic scenario (bilingual output).
 *
 * Creates: tenant "Demo Clinic" with owner Dr. Sara Ahmadi (Asia/Tehran),
 * weekly availability Sat–Wed with a lunch break, three event types,
 * and the first API key. The API key is printed ONCE to stdout.
 *
 * Idempotent: re-running exits gracefully if the tenant already exists.
 * Run:  npm run db:seed
 */
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

const prisma = new PrismaClient();

function generateKey() {
  const secret = randomBytes(24).toString('base64url');
  const key = `hbk_${secret}`;
  return {
    key,
    prefix: key.slice(0, 12),
    hashedKey: createHash('sha256').update(key).digest('hex'),
  };
}

// Sat..Wed = weekdays 6,0,1,2,3 with a lunch break 13:00–14:00
const WORKING_DAYS = [6, 0, 1, 2, 3];
const MORNING = { startMinute: 9 * 60, endMinute: 13 * 60 };
const AFTERNOON = { startMinute: 14 * 60, endMinute: 17 * 60 };

async function main(): Promise<void> {
  const slug = 'demo-clinic';
  const existing = await prisma.tenant.findUnique({ where: { slug } });
  if (existing) {
    console.log(`\nℹ️  Tenant "${slug}" already exists — seed skipped.`);
    console.log('   Create a new API key via the API:  POST /v1/api-keys\n');
    return;
  }

  const { key, prefix, hashedKey } = generateKey();

  const tenant = await prisma.tenant.create({
    data: {
      name: 'Demo Clinic (hbook)',
      slug,
      timezone: 'Asia/Tehran',
    },
  });

  const doctor = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      name: 'Dr. Sara Ahmadi',
      email: 'sara@demo-clinic.local',
      timezone: 'Asia/Tehran',
      role: 'OWNER',
      isHost: true,
    },
  });

  await prisma.apiKey.create({
    data: { tenantId: tenant.id, name: 'default', hashedKey, prefix },
  });

  await prisma.availability.createMany({
    data: WORKING_DAYS.flatMap((weekday) =>
      [MORNING, AFTERNOON].map((w) => ({
        tenantId: tenant.id,
        userId: doctor.id,
        weekday,
        startMinute: w.startMinute,
        endMinute: w.endMinute,
      })),
    ),
  });

  const eventTypes = [
    {
      slug: 'quick-visit',
      title: 'Quick visit (ویزیت سریع)',
      description: 'Short in-person check-up, 15 minutes — 3 patients share each slot (capacity 3).',
      durationMin: 15,
      slotIntervalMin: 15,
      capacity: 3,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
      location: 'Clinic room 1',
    },
    {
      slug: 'consultation',
      title: 'Consultation (ویزیت تخصصی)',
      description: 'Full consultation with 5-minute buffers, 30 minutes.',
      durationMin: 30,
      slotIntervalMin: 30,
      capacity: 1,
      bufferBeforeMin: 5,
      bufferAfterMin: 5,
      location: 'Online (video link sent after booking)',
    },
    {
      slug: 'follow-up',
      title: 'Follow-up (پیگیری)',
      description: 'Longer follow-up session, 45 minutes, requires confirmation.',
      durationMin: 45,
      slotIntervalMin: 45,
      capacity: 1,
      bufferBeforeMin: 0,
      bufferAfterMin: 10,
      requiresConfirmation: true,
      location: 'Clinic room 2',
    },
  ];

  for (const et of eventTypes) {
    await prisma.eventType.create({
      data: { tenantId: tenant.id, hostId: doctor.id, ...et },
    });
  }

  console.log(
    [
      '',
      '╭──────────────────────────────────────────────────────────────╮',
      '│  hbook seed ✔  —  demo clinic is ready                        │',
      '╰──────────────────────────────────────────────────────────────╯',
      '',
      '  Tenant slug   : demo-clinic',
      `  Owner/host    : ${doctor.name}  (${doctor.email})`,
      '  Availability  : Sat–Wed  09:00–13:00 + 14:00–17:00  (Asia/Tehran)',
      '  Event types   : quick-visit (15m) · consultation (30m) · follow-up (45m, needs confirm)',
      '',
      '  API KEY (shown only once — store it now!):',
      '',
      `    ${key}`,
      '',
      '  Quick try:',
      '',
      '    curl -s http://localhost:3000/v1/me -H "X-API-Key: <key>"',
      '    curl -s "http://localhost:3000/v1/slots?eventTypeId=quick-visit&from=<YYYY-MM-DD>&to=<YYYY-MM-DD>" -H "X-API-Key: <key>"',
      '',
    ].join('\n'),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
