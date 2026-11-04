import { randomBytes, randomUUID } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { recordAuditEvent, type PrismaClient, withTenantTx } from '@hmn/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  type SecretEncryptionConfig,
} from '@hmn/shared';
import { normalizeHostname } from '@hmn/validation';
import { currentSession } from '../auth/session.js';

interface DomainBody {
  readonly hostname?: unknown;
}

interface SubscriptionBody {
  readonly tier?: unknown;
  readonly months?: unknown;
}

export interface TenantAccountRoutesOptions {
  readonly client: PrismaClient;
  readonly smsEncryption?: SecretEncryptionConfig;
  readonly customDomainsEnabled?: boolean;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOwnerRole(role: string): boolean {
  return role === 'OWNER';
}

function mayUseCustomDomain(
  subscription: {
    status: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    plan: { tier: string; isActive: boolean };
  } | null,
): boolean {
  const now = new Date();
  return (
    subscription !== null &&
    subscription.status === 'ACTIVE' &&
    subscription.plan.tier !== 'FREE' &&
    subscription.plan.isActive &&
    subscription.currentPeriodStart <= now &&
    subscription.currentPeriodEnd > now
  );
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
      customDomainsEnabled: options.customDomainsEnabled === true,
      customDomainsAvailable:
        options.customDomainsEnabled === true && mayUseCustomDomain(data.subscription),
      domains: data.domains.map((domain) => ({
        id: domain.id,
        hostname: domain.hostname,
        isPrimary: domain.isPrimary,
        isVerified: domain.isVerified,
        verificationStatus: domain.verificationStatus,
        verificationMethod: domain.verificationMethod,
        verificationToken: domain.isVerified ? null : domain.verificationToken,
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
    if (options.customDomainsEnabled !== true) {
      throw new ForbiddenError('Custom domains are not enabled', {
        code: 'DOMAIN_FEATURE_DISABLED',
      });
    }
    const body = request.body as DomainBody | undefined;
    const hostname = validHostname(body?.hostname);
    const verificationToken = randomBytes(18).toString('hex');

    const domain = await withTenantTx(client, context.tenantId, async (tx) => {
      const subscription = await tx.tenantSubscription.findFirst({
        orderBy: { createdAt: 'desc' },
        include: { plan: true },
      });
      if (!mayUseCustomDomain(subscription)) {
        throw new ForbiddenError('A current paid subscription is required', {
          code: 'DOMAIN_PAID_PLAN_REQUIRED',
        });
      }
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
    if (options.customDomainsEnabled !== true) {
      throw new ForbiddenError('Custom domains are not enabled', {
        code: 'DOMAIN_FEATURE_DISABLED',
      });
    }
    const requestedDomainId = (request.params as { id?: string }).id;
    if (!isNonEmptyString(requestedDomainId)) {
      throw new ValidationError('A domain id is required', {
        code: 'DOMAIN_VERIFICATION_REQUIRED',
      });
    }
    const domain = await withTenantTx(client, context.tenantId, async (tx) => {
      const subscription = await tx.tenantSubscription.findFirst({
        orderBy: { createdAt: 'desc' },
        include: { plan: true },
      });
      if (!mayUseCustomDomain(subscription))
        throw new ForbiddenError('A current paid subscription is required', {
          code: 'DOMAIN_PAID_PLAN_REQUIRED',
        });
      return tx.domain.findFirst({ where: { id: requestedDomainId, tenantId: context.tenantId } });
    });
    if (domain === null) throw new NotFoundError('Domain not found');
    let records: string[][];
    try {
      records = await resolveTxt(`_hoomana-verification.${domain.hostname}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENODATA' || code === 'ENOTFOUND' || code === 'ENONAME') records = [];
      else
        return reply.code(503).send({
          error: {
            code: 'DNS_UNAVAILABLE',
            message: 'DNS lookup is temporarily unavailable; please retry',
          },
        });
    }
    const originalHostname = domain.hostname;
    const domainToken = domain.verificationToken;
    const valid = domainToken !== null && records.some((record) => record.join('') === domainToken);

    const result = await withTenantTx(client, context.tenantId, async (tx) => {
      const subscription = await tx.tenantSubscription.findFirst({
        orderBy: { createdAt: 'desc' },
        include: { plan: true },
      });
      if (!mayUseCustomDomain(subscription))
        throw new ForbiddenError('A current paid subscription is required', {
          code: 'DOMAIN_PAID_PLAN_REQUIRED',
        });
      const domain = await tx.domain.findFirst({
        where: { id: requestedDomainId, tenantId: context.tenantId },
      });
      if (domain === null) throw new NotFoundError('Domain not found');

      if (domain.verificationToken !== domainToken || domain.hostname !== originalHostname)
        throw new ConflictError('Domain verification changed; retry', { code: 'DOMAIN_CHANGED' });
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

  for (const path of ['/tenant/sms', '/tenant/sms/disable', '/tenant/sms/check']) {
    app.post(path, async (request) => {
      await ownerContext(client, request);
      throw new ForbiddenError('SMS connection is managed by the platform', {
        code: 'SMS_PLATFORM_MANAGED',
      });
    });
  }

  app.post('/tenant/subscription', async (request, reply) => {
    const context = await ownerContext(client, request);
    const body = request.body as SubscriptionBody | undefined;
    const tier = subscriptionTier(body?.tier);
    if (tier !== 'FREE') {
      throw new ForbiddenError('Paid subscriptions require authorized activation', {
        code: 'PAID_SUBSCRIPTION_REQUIRES_ACTIVATION',
      });
    }
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
}
