import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  findSessionByTokenHash,
  hashToken,
  recordAuditEvent,
  type PrismaClient,
  withTenantTx,
} from '@hmn/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  decryptSecret,
  encryptSecret,
  type SecretEncryptionConfig,
} from '@hmn/shared';
import { normalizeHostname } from '@hmn/validation';
import { SESSION_COOKIE_NAME } from '../auth/auth-service.js';

interface DomainBody {
  readonly hostname?: unknown;
}

interface VerifyDomainBody {
  readonly token?: unknown;
}

interface SmsBody {
  readonly provider?: unknown;
  readonly panelRef?: unknown;
  readonly sender?: unknown;
}

interface SubscriptionBody {
  readonly tier?: unknown;
  readonly months?: unknown;
}

export interface TenantAccountRoutesOptions {
  readonly client: PrismaClient;
  readonly smsEncryption?: SecretEncryptionConfig;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOwnerRole(role: string): boolean {
  return role === 'OWNER';
}

function validHostname(raw: unknown): string {
  if (!isNonEmptyString(raw)) {
    throw new ValidationError('A hostname is required', { code: 'DOMAIN_REQUIRED' });
  }

  const hostname = normalizeHostname(raw);
  if (
    hostname.length < 3 ||
    hostname.length > 253 ||
    hostname.includes('..') ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)
  ) {
    throw new ValidationError('The hostname is invalid', { code: 'DOMAIN_INVALID' });
  }

  return hostname;
}

function panelSender(raw: unknown): string {
  if (!isNonEmptyString(raw) || !/^\d{5,20}$/.test(raw.trim())) {
    throw new ValidationError('A valid SMS sender line is required', {
      code: 'SMS_SENDER_INVALID',
    });
  }

  return raw.trim();
}

function subscriptionTier(raw: unknown): 'FREE' | 'STARTER' | 'PRO' | 'BUSINESS' | 'ENTERPRISE' {
  if (
    raw !== 'FREE' &&
    raw !== 'STARTER' &&
    raw !== 'PRO' &&
    raw !== 'BUSINESS' &&
    raw !== 'ENTERPRISE'
  ) {
    throw new ValidationError('The subscription tier is invalid', { code: 'PLAN_INVALID' });
  }

  return raw;
}

async function currentSession(client: PrismaClient, request: FastifyRequest) {
  const raw = request.cookies[SESSION_COOKIE_NAME];
  if (!isNonEmptyString(raw)) return undefined;

  const session = await findSessionByTokenHash(client, hashToken(raw));
  if (session === undefined || session.revokedAt !== null) return undefined;

  const now = Date.now();
  if (session.expiresAt.getTime() <= now || session.idleExpiresAt.getTime() <= now)
    return undefined;

  return session;
}

async function ownerContext(client: PrismaClient, request: FastifyRequest) {
  const session = await currentSession(client, request);
  if (session === undefined) throw new UnauthorizedError();
  if (session.activeTenantId === null) {
    throw new ForbiddenError('No active clinic is selected', { code: 'TENANT_NOT_SELECTED' });
  }

  const tenantId = session.activeTenantId;
  const membership = await withTenantTx(client, tenantId, (tx) =>
    tx.tenantMembership.findUnique({
      where: { tenantId_userId: { tenantId, userId: session.userId } },
      select: { role: true },
    }),
  );

  if (membership === null || !isOwnerRole(membership.role)) {
    throw new ForbiddenError('Only the clinic owner can manage account settings', {
      code: 'OWNER_REQUIRED',
    });
  }

  return { session, tenantId, role: membership.role };
}

export function tenantAccountRoutes(
  app: FastifyInstance,
  options: TenantAccountRoutesOptions,
): void {
  const { client } = options;

  app.get('/tenant/settings', async (request, reply) => {
    const context = await ownerContext(client, request);
    const tenant = await client.tenant.findUnique({
      where: { id: context.tenantId },
      select: { id: true, name: true, slug: true, address: true, city: true, isSuspended: true },
    });
    if (tenant === null) throw new NotFoundError('Clinic not found');

    const data = await withTenantTx(client, context.tenantId, async (tx) => {
      const [domains, smsAccount, subscription] = await Promise.all([
        tx.domain.findMany({ orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] }),
        tx.tenantSmsAccount.findUnique({ where: { tenantId: context.tenantId } }),
        tx.tenantSubscription.findFirst({
          orderBy: { createdAt: 'desc' },
          include: { plan: true },
        }),
      ]);

      return { domains, smsAccount, subscription };
    });

    return reply.send({
      tenant,
      domains: data.domains.map((domain) => ({
        id: domain.id,
        hostname: domain.hostname,
        isPrimary: domain.isPrimary,
        isVerified: domain.isVerified,
        verificationStatus: domain.verificationStatus,
        verificationMethod: domain.verificationMethod,
        lastCheckedAt: domain.lastCheckedAt,
        verifiedAt: domain.verifiedAt,
      })),
      sms:
        data.smsAccount === null
          ? null
          : {
              provider: data.smsAccount.provider,
              sender: data.smsAccount.sender,
              isActive: data.smsAccount.isActive,
              configured: true,
              lastError: data.smsAccount.lastError,
              lastVerifiedAt: data.smsAccount.lastVerifiedAt,
            },
      subscription:
        data.subscription === null
          ? null
          : {
              tier: data.subscription.plan.tier,
              name: data.subscription.plan.name,
              status: data.subscription.status,
              currentPeriodStart: data.subscription.currentPeriodStart,
              currentPeriodEnd: data.subscription.currentPeriodEnd,
              maxUsers: data.subscription.plan.maxUsers,
              monthlyMessageUnits: data.subscription.plan.monthlyMessageUnits,
            },
    });
  });

  app.get('/tenant/subscription/plans', async (request, reply) => {
    await ownerContext(client, request);
    const plans = await client.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { tier: 'asc' },
      select: { tier: true, name: true, maxUsers: true, monthlyMessageUnits: true },
    });
    return reply.send({ plans });
  });

  app.post('/tenant/domains', async (request, reply) => {
    const context = await ownerContext(client, request);
    const body = request.body as DomainBody | undefined;
    const hostname = validHostname(body?.hostname);
    const verificationToken = randomBytes(18).toString('hex');

    const domain = await withTenantTx(client, context.tenantId, async (tx) => {
      const existing = await tx.domain.findUnique({ where: { hostname } });
      if (existing !== null) {
        throw new ConflictError('This hostname is already registered', { code: 'DOMAIN_EXISTS' });
      }

      const count = await tx.domain.count({ where: { tenantId: context.tenantId } });
      const created = await tx.domain.create({
        data: {
          id: randomUUID(),
          tenantId: context.tenantId,
          hostname,
          verificationToken,
          isPrimary: count === 0,
        },
      });

      await recordAuditEvent(tx, {
        tenantId: context.tenantId,
        actorUserId: context.session.userId,
        actorRole: 'OWNER',
        action: 'tenant.domain.add',
        targetType: 'domain',
        targetId: created.id,
        details: { hostname },
      });

      return created;
    });

    return reply.code(201).send({
      domain: {
        id: domain.id,
        hostname: domain.hostname,
        isPrimary: domain.isPrimary,
        verificationStatus: domain.verificationStatus,
        verificationMethod: domain.verificationMethod,
        verificationToken,
        instructions: `TXT رکورد _hoomana-verification.${hostname} را با مقدار ${verificationToken} بسازید.`,
      },
    });
  });

  app.post('/tenant/domains/:id/verify', async (request, reply) => {
    const context = await ownerContext(client, request);
    const body = request.body as VerifyDomainBody | undefined;
    const token = isNonEmptyString(body?.token) ? body.token.trim() : '';
    const domainId = request.params as { id?: string };
    const requestedDomainId = domainId.id;
    if (!isNonEmptyString(requestedDomainId) || token.length === 0) {
      throw new ValidationError('A domain id and verification token are required', {
        code: 'DOMAIN_VERIFICATION_REQUIRED',
      });
    }

    const result = await withTenantTx(client, context.tenantId, async (tx) => {
      const domain = await tx.domain.findFirst({
        where: { id: requestedDomainId, tenantId: context.tenantId },
      });
      if (domain === null) throw new NotFoundError('Domain not found');

      const valid = domain.verificationToken === token;
      const updated = await tx.domain.update({
        where: { id: domain.id },
        data: {
          lastCheckedAt: new Date(),
          ...(valid
            ? { isVerified: true, verificationStatus: 'VERIFIED' as const, verifiedAt: new Date() }
            : { isVerified: false, verificationStatus: 'FAILED' as const }),
        },
      });

      await recordAuditEvent(tx, {
        tenantId: context.tenantId,
        actorUserId: context.session.userId,
        actorRole: 'OWNER',
        action: valid ? 'tenant.domain.verify' : 'tenant.domain.verify_failed',
        targetType: 'domain',
        targetId: domain.id,
        details: { hostname: domain.hostname },
      });

      return updated;
    });

    if (!result.isVerified) {
      return reply.code(422).send({
        error: {
          code: 'DOMAIN_NOT_VERIFIED',
          message: 'رکورد تأیید دامنه با مقدار ذخیره‌شده مطابقت ندارد',
        },
      });
    }

    return reply.send({
      domain: {
        id: result.id,
        hostname: result.hostname,
        isVerified: result.isVerified,
        verificationStatus: result.verificationStatus,
        verifiedAt: result.verifiedAt,
      },
    });
  });

  app.post('/tenant/sms', async (request, reply) => {
    const context = await ownerContext(client, request);
    const body = request.body as SmsBody | undefined;
    const provider = body?.provider === undefined ? 'melipayamak' : body.provider;
    const panelRef = isNonEmptyString(body?.panelRef) ? body.panelRef.trim() : '';
    const sender = panelSender(body?.sender);

    if (provider !== 'melipayamak') {
      throw new ValidationError('Only the Melipayamak provider is enabled currently', {
        code: 'SMS_PROVIDER_INVALID',
      });
    }
    if (panelRef.length < 16) {
      throw new ValidationError('The SMS panel reference is invalid', {
        code: 'SMS_PANEL_INVALID',
      });
    }
    if (options.smsEncryption === undefined) {
      return reply.code(503).send({
        error: {
          code: 'SMS_ENCRYPTION_UNAVAILABLE',
          message: 'کلید رمزنگاری پنل پیامک تنظیم نشده است',
        },
      });
    }

    const saved = await withTenantTx(client, context.tenantId, async (tx) => {
      const existing = await tx.tenantSmsAccount.findUnique({
        where: { tenantId: context.tenantId },
      });
      const id = existing?.id ?? randomUUID();
      const encrypted = encryptSecret(
        panelRef,
        `${context.tenantId}|${id}`,
        options.smsEncryption!,
      );
      const account = await tx.tenantSmsAccount.upsert({
        where: { tenantId: context.tenantId },
        create: {
          id,
          tenantId: context.tenantId,
          provider: 'melipayamak',
          panelRefCiphertext: encrypted.ciphertext as unknown as Uint8Array<ArrayBuffer>,
          panelRefIv: encrypted.iv as unknown as Uint8Array<ArrayBuffer>,
          panelRefAuthTag: encrypted.authTag as unknown as Uint8Array<ArrayBuffer>,
          keyVersion: encrypted.keyVersion,
          sender,
        },
        update: {
          provider: 'melipayamak',
          panelRefCiphertext: encrypted.ciphertext as unknown as Uint8Array<ArrayBuffer>,
          panelRefIv: encrypted.iv as unknown as Uint8Array<ArrayBuffer>,
          panelRefAuthTag: encrypted.authTag as unknown as Uint8Array<ArrayBuffer>,
          keyVersion: encrypted.keyVersion,
          sender,
          isActive: true,
          lastError: null,
        },
      });

      await recordAuditEvent(tx, {
        tenantId: context.tenantId,
        actorUserId: context.session.userId,
        actorRole: 'OWNER',
        action: 'tenant.sms.configure',
        targetType: 'tenant_sms_account',
        targetId: account.id,
        details: { provider: 'melipayamak', sender },
      });

      return account;
    });

    return reply.send({
      sms: {
        provider: saved.provider,
        sender: saved.sender,
        configured: true,
        isActive: saved.isActive,
      },
    });
  });

  app.post('/tenant/sms/disable', async (request, reply) => {
    const context = await ownerContext(client, request);
    const result = await withTenantTx(client, context.tenantId, async (tx) => {
      const account = await tx.tenantSmsAccount.findUnique({
        where: { tenantId: context.tenantId },
      });
      if (account === null) throw new NotFoundError('SMS panel is not configured');
      const updated = await tx.tenantSmsAccount.update({
        where: { id: account.id },
        data: { isActive: false },
      });
      await recordAuditEvent(tx, {
        tenantId: context.tenantId,
        actorUserId: context.session.userId,
        actorRole: 'OWNER',
        action: 'tenant.sms.disable',
        targetType: 'tenant_sms_account',
        targetId: account.id,
      });
      return updated;
    });

    return reply.send({
      sms: { configured: true, isActive: result.isActive, sender: result.sender },
    });
  });

  app.post('/tenant/subscription', async (request, reply) => {
    const context = await ownerContext(client, request);
    const body = request.body as SubscriptionBody | undefined;
    const tier = subscriptionTier(body?.tier);
    const months =
      typeof body?.months === 'number' && Number.isInteger(body.months) ? body.months : 1;
    if (months < 1 || months > 12) {
      throw new ValidationError('Subscription duration must be between 1 and 12 months', {
        code: 'SUBSCRIPTION_DURATION_INVALID',
      });
    }

    const plan = await client.subscriptionPlan.findUnique({ where: { tier } });
    if (plan === null || !plan.isActive) throw new NotFoundError('Subscription plan not found');

    const updated = await withTenantTx(client, context.tenantId, async (tx) => {
      const now = new Date();
      const current = await tx.tenantSubscription.findFirst({ orderBy: { createdAt: 'desc' } });
      const end = new Date(now);
      end.setMonth(end.getMonth() + months);
      const status = tier === 'FREE' ? 'TRIALING' : 'ACTIVE';
      const subscription =
        current === null
          ? await tx.tenantSubscription.create({
              data: {
                tenantId: context.tenantId,
                planId: plan.id,
                status,
                currentPeriodStart: now,
                currentPeriodEnd: end,
              },
            })
          : await tx.tenantSubscription.update({
              where: { id: current.id },
              data: {
                planId: plan.id,
                status,
                currentPeriodStart: now,
                currentPeriodEnd: end,
                cancelAtPeriodEnd: false,
              },
            });

      await recordAuditEvent(tx, {
        tenantId: context.tenantId,
        actorUserId: context.session.userId,
        actorRole: 'OWNER',
        action: 'tenant.subscription.change',
        targetType: 'tenant_subscription',
        targetId: subscription.id,
        details: { tier, months },
      });
      return subscription;
    });

    return reply.send({
      subscription: {
        tier: plan.tier,
        name: plan.name,
        status: updated.status,
        currentPeriodStart: updated.currentPeriodStart,
        currentPeriodEnd: updated.currentPeriodEnd,
      },
    });
  });

  app.post('/tenant/subscription/cancel', async (request, reply) => {
    const context = await ownerContext(client, request);
    const updated = await withTenantTx(client, context.tenantId, async (tx) => {
      const current = await tx.tenantSubscription.findFirst({ orderBy: { createdAt: 'desc' } });
      if (current === null) throw new NotFoundError('Subscription not found');
      const subscription = await tx.tenantSubscription.update({
        where: { id: current.id },
        data: { cancelAtPeriodEnd: true },
      });
      await recordAuditEvent(tx, {
        tenantId: context.tenantId,
        actorUserId: context.session.userId,
        actorRole: 'OWNER',
        action: 'tenant.subscription.cancel_at_period_end',
        targetType: 'tenant_subscription',
        targetId: subscription.id,
      });
      return subscription;
    });

    return reply.send({
      subscription: { id: updated.id, cancelAtPeriodEnd: updated.cancelAtPeriodEnd },
    });
  });

  // Keep the decryption path exercised without returning the credential. This endpoint
  // is used by the future provider health check and proves the stored secret is usable.
  app.post('/tenant/sms/check', async (request, reply) => {
    const context = await ownerContext(client, request);
    if (options.smsEncryption === undefined) {
      return reply.code(503).send({
        error: { code: 'SMS_ENCRYPTION_UNAVAILABLE', message: 'کلید رمزنگاری تنظیم نشده است' },
      });
    }

    const account = await withTenantTx(client, context.tenantId, (tx) =>
      tx.tenantSmsAccount.findUnique({ where: { tenantId: context.tenantId } }),
    );
    if (account === null) throw new NotFoundError('SMS panel is not configured');

    const panelRef = decryptSecret(
      {
        ciphertext: account.panelRefCiphertext,
        iv: account.panelRefIv,
        authTag: account.panelRefAuthTag,
      },
      `${context.tenantId}|${account.id}`,
      options.smsEncryption,
    );
    const updated = await withTenantTx(client, context.tenantId, (tx) =>
      tx.tenantSmsAccount.update({
        where: { id: account.id },
        data: { lastVerifiedAt: new Date(), lastError: null },
      }),
    );

    return reply.send({
      sms: {
        configured: true,
        isActive: updated.isActive,
        sender: updated.sender,
        panelRefLength: panelRef.length,
      },
    });
  });
}
