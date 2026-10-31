import { randomUUID } from 'node:crypto';
import { createDatabaseClient, disconnectDatabase } from '@hmn/db';
import { encryptSecret, hashPassword, loadEnvironment } from '@hmn/shared';

const environment = loadEnvironment({ startDirectory: process.cwd() });
const database = createDatabaseClient({ connectionString: environment.DATABASE_URL });

const adminMobile = process.env.DEMO_PLATFORM_ADMIN_MOBILE ?? '09120000001';
const adminPassword = process.env.DEMO_PLATFORM_ADMIN_PASSWORD ?? 'HoomanaAdmin!2026';

const plans = [
  { tier: 'FREE', name: 'رایگان', maxUsers: 1, monthlyMessageUnits: 100 },
  { tier: 'STARTER', name: 'شروع', maxUsers: 3, monthlyMessageUnits: 500 },
  { tier: 'PRO', name: 'حرفه‌ای', maxUsers: 10, monthlyMessageUnits: 2_000 },
  { tier: 'BUSINESS', name: 'سازمانی', maxUsers: 25, monthlyMessageUnits: 10_000 },
  { tier: 'ENTERPRISE', name: 'سازمانی پلاس', maxUsers: 100, monthlyMessageUnits: 50_000 },
] as const;

const clinics = [
  {
    name: 'کلینیک دمو ۱',
    slug: 'demo-clinic-1',
    city: 'تهران',
    state: 'ACTIVE',
    plan: 'PRO',
    verified: true,
  },
  {
    name: 'کلینیک دمو ۲',
    slug: 'demo-clinic-2',
    city: 'مشهد',
    state: 'ACTIVE',
    plan: 'STARTER',
    verified: true,
  },
  {
    name: 'کلینیک دمو ۳',
    slug: 'demo-clinic-3',
    city: 'شیراز',
    state: 'SUSPENDED',
    plan: 'BUSINESS',
    verified: true,
  },
  {
    name: 'کلینیک دمو ۴',
    slug: 'demo-clinic-4',
    city: 'اصفهان',
    state: 'BLOCKED',
    plan: 'FREE',
    verified: false,
  },
  {
    name: 'کلینیک دمو ۵',
    slug: 'demo-clinic-5',
    city: 'تبریز',
    state: 'ACTIVE',
    plan: 'ENTERPRISE',
    verified: false,
  },
] as const;

function periodEnd(months: number): Date {
  const result = new Date();
  result.setMonth(result.getMonth() + months);
  return result;
}

async function seedAdmin(): Promise<void> {
  const user = await database.user.upsert({
    where: { mobile: adminMobile },
    update: { displayName: 'مدیر تست پلتفرم', isActive: true },
    create: { mobile: adminMobile, displayName: 'مدیر تست پلتفرم', isActive: true },
  });

  await database.credential.upsert({
    where: { userId: user.id },
    update: { passwordHash: await hashPassword(adminPassword), passwordUpdatedAt: new Date() },
    create: { userId: user.id, passwordHash: await hashPassword(adminPassword) },
  });

  const admin = await database.platformAdmin.upsert({
    where: { userId: user.id },
    update: { mfaEnrolled: false },
    create: { userId: user.id, mfaEnrolled: false },
  });

  await database.platformMfaFactor.deleteMany({ where: { platformAdminId: admin.id } });
  await database.session.deleteMany({ where: { userId: user.id } });
}

async function seedPlans(): Promise<Map<string, string>> {
  const planIds = new Map<string, string>();
  for (const plan of plans) {
    const saved = await database.subscriptionPlan.upsert({
      where: { tier: plan.tier },
      update: {
        name: plan.name,
        maxUsers: plan.maxUsers,
        monthlyMessageUnits: plan.monthlyMessageUnits,
        isActive: true,
      },
      create: plan,
    });
    planIds.set(plan.tier, saved.id);
  }
  return planIds;
}

async function seedClinic(
  clinic: (typeof clinics)[number],
  planIds: Map<string, string>,
  index: number,
): Promise<void> {
  const ownerMobile = `0912111100${index}`;
  const owner = await database.user.upsert({
    where: { mobile: ownerMobile },
    update: { displayName: `مالک ${clinic.name}`, isActive: true },
    create: { mobile: ownerMobile, displayName: `مالک ${clinic.name}`, isActive: true },
  });

  const tenant = await database.tenant.upsert({
    where: { slug: clinic.slug },
    update: {
      name: clinic.name,
      city: clinic.city,
      isSuspended: clinic.state === 'SUSPENDED',
      blockedAt: clinic.state === 'BLOCKED' ? new Date() : null,
      blockedReason: clinic.state === 'BLOCKED' ? 'داده دمو برای تست پنل مدیریت' : null,
    },
    create: {
      name: clinic.name,
      slug: clinic.slug,
      city: clinic.city,
      isSuspended: clinic.state === 'SUSPENDED',
      blockedAt: clinic.state === 'BLOCKED' ? new Date() : null,
      blockedReason: clinic.state === 'BLOCKED' ? 'داده دمو برای تست پنل مدیریت' : null,
    },
  });

  await database.tenantMembership.upsert({
    where: { tenantId_userId: { tenantId: tenant.id, userId: owner.id } },
    update: { role: 'OWNER' },
    create: { tenantId: tenant.id, userId: owner.id, role: 'OWNER' },
  });

  const planId = planIds.get(clinic.plan);
  if (!planId) throw new Error(`Plan ${clinic.plan} was not seeded`);
  const subscription = await database.tenantSubscription.findFirst({
    where: { tenantId: tenant.id },
    orderBy: { createdAt: 'desc' },
  });
  const subscriptionData = {
    planId,
    status: clinic.state === 'BLOCKED' ? 'PAST_DUE' : 'ACTIVE',
    currentPeriodStart: new Date(),
    currentPeriodEnd: periodEnd(index + 1),
  };
  if (subscription) {
    await database.tenantSubscription.update({
      where: { id: subscription.id },
      data: subscriptionData,
    });
  } else {
    await database.tenantSubscription.create({
      data: { tenantId: tenant.id, ...subscriptionData },
    });
  }

  const hostname = `${clinic.slug}.example.test`;
  await database.domain.upsert({
    where: { hostname },
    update: {
      tenantId: tenant.id,
      isVerified: clinic.verified,
      verificationStatus: clinic.verified ? 'VERIFIED' : 'PENDING',
      isPrimary: true,
      verifiedAt: clinic.verified ? new Date() : null,
    },
    create: {
      tenantId: tenant.id,
      hostname,
      isVerified: clinic.verified,
      verificationStatus: clinic.verified ? 'VERIFIED' : 'PENDING',
      verificationToken: `demo-${clinic.slug}`,
      isPrimary: true,
      verifiedAt: clinic.verified ? new Date() : null,
    },
  });

  if (environment.SMS_ENCRYPTION_KEY) {
    const smsExisting = await database.tenantSmsAccount.findUnique({
      where: { tenantId: tenant.id },
    });
    const smsId = smsExisting?.id ?? randomUUID();
    const encrypted = encryptSecret(`DEMO-PANEL-REF-${index}`, `${tenant.id}|${smsId}`, {
      key: Buffer.from(environment.SMS_ENCRYPTION_KEY, 'base64'),
      keyVersion: environment.SMS_ENCRYPTION_KEY_VERSION,
    });
    await database.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenant.id}, true)`;
      await transaction.tenantSmsAccount.upsert({
        where: { tenantId: tenant.id },
        update: {
          panelRefCiphertext: encrypted.ciphertext,
          panelRefIv: encrypted.iv,
          panelRefAuthTag: encrypted.authTag,
          keyVersion: encrypted.keyVersion,
          sender: `500000000${index}`,
          isActive: index !== 4,
          lastError: index === 4 ? 'اتصال دمو نیاز به تأیید دارد' : null,
          lastVerifiedAt: clinic.verified ? new Date() : null,
        },
        create: {
          id: smsId,
          tenantId: tenant.id,
          provider: 'KAVENEGAR',
          panelRefCiphertext: encrypted.ciphertext,
          panelRefIv: encrypted.iv,
          panelRefAuthTag: encrypted.authTag,
          keyVersion: encrypted.keyVersion,
          sender: `500000000${index}`,
          isActive: index !== 4,
          lastError: index === 4 ? 'اتصال دمو نیاز به تأیید دارد' : null,
          lastVerifiedAt: clinic.verified ? new Date() : null,
        },
      });
    });
  }
}

try {
  await seedAdmin();
  const planIds = await seedPlans();
  for (const [index, clinic] of clinics.entries()) await seedClinic(clinic, planIds, index + 1);
  console.log(
    JSON.stringify(
      {
        adminMobile,
        adminPassword,
        clinics: clinics.map(({ name, slug, state }) => ({ name, slug, state })),
      },
      null,
      2,
    ),
  );
} finally {
  await disconnectDatabase(database);
}
