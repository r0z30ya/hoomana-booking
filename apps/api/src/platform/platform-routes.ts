import { randomBytes, randomUUID } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashToken, withTenantTx, type PrismaClient } from '@hmn/db';
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  buildTotpUri,
  base32Encode,
  decryptMfaSecret,
  encryptMfaSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyTotpCode,
  verifyPassword,
  dummyVerify,
  encryptSecret,
  type MfaConfig,
  type SecretEncryptionConfig,
} from '@hmn/shared';
import { normalizeHostname } from '@hmn/validation';
import {
  generateSessionToken,
  RATE_LIMIT_MAX_FAILURES,
  RATE_LIMIT_WINDOW_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
} from '../auth/auth-service.js';

export const PLATFORM_SESSION_COOKIE = 'hmn_admin_session';

interface LoginBody {
  readonly mobile?: unknown;
  readonly code?: unknown;
  readonly challengeToken?: unknown;
}

interface EnrollBody {
  readonly enrollmentToken?: unknown;
  readonly code?: unknown;
}

interface AccountBody {
  readonly name?: unknown;
  readonly slug?: unknown;
  readonly ownerName?: unknown;
  readonly ownerMobile?: unknown;
  readonly planTier?: unknown;
  readonly months?: unknown;
  readonly state?: unknown;
  readonly reason?: unknown;
}

export interface PlatformRoutesOptions {
  readonly client: PrismaClient;
  readonly mfa?: MfaConfig;
  readonly smsEncryption?: SecretEncryptionConfig;
}

type TokenPayload = {
  readonly purpose: 'challenge' | 'enrollment';
  readonly userId: string;
  readonly expiresAt: number;
  readonly factorId?: string;
  readonly secret?: string;
  readonly recoveryHashes?: readonly string[];
};

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)[name]
    : undefined;
}

function validMobile(raw: unknown): string {
  if (!nonEmpty(raw))
    throw new ValidationError('A mobile number is required', { code: 'MOBILE_REQUIRED' });
  const mobile = raw.replace(/[\s()-]/g, '').replace(/^\+98/, '0');
  if (!/^09\d{9}$/.test(mobile))
    throw new ValidationError('The mobile number is invalid', { code: 'MOBILE_INVALID' });
  return mobile;
}

function validText(raw: unknown, code: string): string {
  if (!nonEmpty(raw)) throw new ValidationError('A required value is missing', { code });
  return raw.trim();
}

function validSlug(raw: unknown): string {
  const slug = validText(raw, 'SLUG_REQUIRED').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) || slug.length > 120) {
    throw new ValidationError('The slug is invalid', { code: 'SLUG_INVALID' });
  }
  return slug;
}

function validTier(raw: unknown): 'FREE' | 'STARTER' | 'PRO' | 'BUSINESS' | 'ENTERPRISE' {
  if (
    raw !== 'FREE' &&
    raw !== 'STARTER' &&
    raw !== 'PRO' &&
    raw !== 'BUSINESS' &&
    raw !== 'ENTERPRISE'
  ) {
    throw new ValidationError('The plan is invalid', { code: 'PLAN_INVALID' });
  }
  return raw;
}

function validId(raw: unknown): string {
  const value = validText(raw, 'ACCOUNT_ID_REQUIRED');
  if (!/^[0-9a-f-]{36}$/i.test(value))
    throw new ValidationError('The account id is invalid', { code: 'ACCOUNT_ID_INVALID' });
  return value;
}

function encodePart(value: Buffer): string {
  return value.toString('base64url');
}

function decodePart(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function sealTokenWithUser(payload: TokenPayload, config: MfaConfig): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = encryptMfaSecret(
    body,
    `platform-token|${payload.purpose}|${payload.userId}`,
    config,
  );
  return `${payload.userId}.${encodePart(encrypted.iv)}.${encodePart(encrypted.ciphertext)}.${encodePart(encrypted.authTag)}`;
}

function openTokenWithUser(
  token: unknown,
  purpose: TokenPayload['purpose'],
  config: MfaConfig,
): TokenPayload {
  if (!nonEmpty(token)) throw new UnauthorizedError('The authentication challenge is invalid');
  const parts = token.split('.');
  if (parts.length !== 4 || !nonEmpty(parts[0]))
    throw new UnauthorizedError('The authentication challenge is invalid');
  const userId = parts[0];
  try {
    const decrypted = decryptMfaSecret(
      {
        iv: decodePart(parts[1] ?? ''),
        ciphertext: decodePart(parts[2] ?? ''),
        authTag: decodePart(parts[3] ?? ''),
        keyVersion: config.keyVersion,
      },
      `platform-token|${purpose}|${userId}`,
      config,
    );
    const payload = JSON.parse(decrypted.toString('utf8')) as TokenPayload;
    if (
      payload.userId !== userId ||
      payload.purpose !== purpose ||
      payload.expiresAt < Date.now()
    ) {
      throw new UnauthorizedError('The authentication challenge has expired');
    }
    return payload;
  } catch (error) {
    if (error instanceof UnauthorizedError) throw error;
    throw new UnauthorizedError('The authentication challenge is invalid');
  }
}

type AuthRow = {
  userId: string;
  displayName: string;
  passwordHash: string | null;
  platformAdminId: string;
  mfaEnrolled: boolean;
  userActive: boolean;
};

type FactorRow = {
  id: string;
  kind: string;
  secretCiphertext: Buffer | null;
  secretIv: Buffer | null;
  secretAuthTag: Buffer | null;
  keyVersion: number | null;
  codeHash: string | null;
  usedAt: Date | null;
};

type CustomerRow = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly ownerName: string | null;
  readonly ownerMobile: string | null;
  readonly city: string | null;
  readonly planTier: string | null;
  readonly isSuspended: boolean;
  readonly blockedAt: Date | null;
  readonly [key: string]: unknown;
};

async function authRow(client: PrismaClient, mobile: string): Promise<AuthRow | undefined> {
  const rows = await client.$queryRaw<
    AuthRow[]
  >`SELECT * FROM public.platform_auth_lookup(${mobile})`;
  return rows[0];
}

async function factors(client: PrismaClient, userId: string): Promise<FactorRow[]> {
  return client.$queryRaw<FactorRow[]>`SELECT * FROM public.platform_auth_factors(${userId}::uuid)`;
}

async function platformRateLimited(
  client: PrismaClient,
  identifier: string,
  ip: string,
): Promise<boolean> {
  const rows = await client.$queryRaw<Array<{ platform_auth_failed_attempts: number }>>`
    SELECT public.platform_auth_failed_attempts(${identifier}, ${ip}::inet, ${new Date(Date.now() - RATE_LIMIT_WINDOW_MS)})
  `;
  return (rows[0]?.platform_auth_failed_attempts ?? 0) >= RATE_LIMIT_MAX_FAILURES;
}

async function recordPlatformAttempt(
  client: PrismaClient,
  identifier: string,
  ip: string,
  succeeded: boolean,
): Promise<void> {
  await client.$queryRaw`SELECT public.platform_auth_record_attempt(${identifier}, ${ip}::inet, ${succeeded})`;
}

async function createPlatformSession(client: PrismaClient, userId: string): Promise<string> {
  const token = generateSessionToken();
  const now = Date.now();
  await client.$queryRaw`SELECT public.platform_auth_create_session(${userId}::uuid, ${hashToken(token)}, ${new Date(now + SESSION_ABSOLUTE_TTL_MS)}, ${new Date(now + SESSION_IDLE_TTL_MS)})`;
  return token;
}

function setPlatformCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(PLATFORM_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(SESSION_IDLE_TTL_MS / 1000),
  });
}

function clearPlatformCookie(reply: FastifyReply): void {
  reply.clearCookie(PLATFORM_SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/' });
}

async function currentPlatformSession(client: PrismaClient, request: FastifyRequest) {
  const token = request.cookies[PLATFORM_SESSION_COOKIE];
  if (!nonEmpty(token)) return undefined;
  const rows = await client.$queryRaw<
    Array<{
      id: string;
      userId: string;
      displayName: string;
      mobile: string;
      expiresAt: Date;
      idleExpiresAt: Date;
      revokedAt: Date | null;
    }>
  >`SELECT * FROM public.platform_auth_find_session(${hashToken(token)})`;
  const session = rows[0];
  if (
    session === undefined ||
    session.revokedAt !== null ||
    session.expiresAt.getTime() <= Date.now() ||
    session.idleExpiresAt.getTime() <= Date.now()
  )
    return undefined;
  await client.$queryRaw`SELECT public.platform_auth_touch_session(${session.id}::uuid)`;
  return session;
}

async function requirePlatformSession(client: PrismaClient, request: FastifyRequest) {
  const session = await currentPlatformSession(client, request);
  if (session === undefined) throw new UnauthorizedError('Platform authentication is required');
  return session;
}

async function listCustomers(client: PrismaClient) {
  const rows = await client.$queryRaw<
    CustomerRow[]
  >`SELECT * FROM public.platform_list_customers()`;
  return rows.map(
    (row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === 'bigint' ? Number(value) : value,
        ]),
      ) as CustomerRow,
  );
}

function mapCustomer(row: CustomerRow): CustomerRow & { readonly state: string } {
  const state =
    row.blockedAt !== null && row.blockedAt !== undefined
      ? 'BLOCKED'
      : row.isSuspended === true
        ? 'SUSPENDED'
        : 'ACTIVE';
  return { ...row, state };
}

export function platformRoutes(app: FastifyInstance, options: PlatformRoutesOptions): void {
  const { client, mfa } = options;

  app.post('/platform/auth/login', async (request, reply) => {
    if (mfa === undefined)
      return reply
        .code(503)
        .send({ error: { code: 'MFA_UNAVAILABLE', message: 'Platform MFA is not configured' } });
    const body = request.body as LoginBody | undefined;
    const mobile = validMobile(field(body, 'mobile'));
    const passphrase = field(body, 'password');
    const challengeToken = field(body, 'challengeToken');
    const code = field(body, 'code');
    if (await platformRateLimited(client, mobile, request.ip)) {
      return reply
        .code(429)
        .send({ error: { code: 'RATE_LIMITED', message: 'Too many attempts' } });
    }
    const row = await authRow(client, mobile);
    if (
      row === undefined ||
      !row.userActive ||
      row.passwordHash === null ||
      !nonEmpty(passphrase)
    ) {
      await dummyVerify(nonEmpty(passphrase) ? passphrase : 'platform-login-placeholder');
      await recordPlatformAttempt(client, mobile, request.ip, false);
      return reply
        .code(401)
        .send({ error: { code: 'AUTH_FAILED', message: 'Invalid credentials' } });
    }
    const passwordResult = await verifyPassword(passphrase, row.passwordHash);
    if (!passwordResult.matches) {
      await recordPlatformAttempt(client, mobile, request.ip, false);
      return reply
        .code(401)
        .send({ error: { code: 'AUTH_FAILED', message: 'Invalid credentials' } });
    }

    if (!row.mfaEnrolled) {
      const factorId = randomUUID();
      const secret = generateTotpSecret();
      const recovery = generateRecoveryCodes();
      const enrollmentToken = sealTokenWithUser(
        {
          purpose: 'enrollment',
          userId: row.userId,
          factorId,
          expiresAt: Date.now() + 10 * 60 * 1000,
          secret: secret.toString('base64url'),
          recoveryHashes: recovery.hashes,
        },
        mfa,
      );
      return reply.send({
        mfaEnrollmentRequired: true,
        enrollmentToken,
        secret: base32Encode(secret),
        otpauthUri: buildTotpUri(secret, mobile, 'Hoomana Platform'),
        recoveryCodes: recovery.plain,
      });
    }

    if (challengeToken === undefined) {
      return reply.code(202).send({
        mfaRequired: true,
        challengeToken: sealTokenWithUser(
          { purpose: 'challenge', userId: row.userId, expiresAt: Date.now() + 5 * 60 * 1000 },
          mfa,
        ),
      });
    }
    const challenge = openTokenWithUser(challengeToken, 'challenge', mfa);
    if (challenge.userId !== row.userId)
      throw new UnauthorizedError('The authentication challenge is invalid');
    const factorRows = await factors(client, row.userId);
    const totp = factorRows.find((factor) => factor.kind === 'TOTP');
    let verified = false;
    if (nonEmpty(code) && totp?.secretCiphertext && totp.secretIv && totp.secretAuthTag) {
      const secret = decryptMfaSecret(
        {
          ciphertext: totp.secretCiphertext,
          iv: totp.secretIv,
          authTag: totp.secretAuthTag,
          keyVersion: totp.keyVersion ?? mfa.keyVersion,
        },
        `${row.userId}|${totp.id}`,
        mfa,
      );
      verified = verifyTotpCode(secret, code);
    }
    if (!verified && nonEmpty(code)) {
      const recovery = await client.$queryRaw<
        Array<{ platform_auth_consume_recovery: boolean }>
      >`SELECT public.platform_auth_consume_recovery(${row.userId}::uuid, ${hashRecoveryCode(code)})`;
      verified = recovery[0]?.platform_auth_consume_recovery === true;
    }
    if (!verified) {
      await recordPlatformAttempt(client, mobile, request.ip, false);
      return reply.code(401).send({ error: { code: 'MFA_FAILED', message: 'Invalid MFA code' } });
    }
    await recordPlatformAttempt(client, mobile, request.ip, true);
    const token = await createPlatformSession(client, row.userId);
    setPlatformCookie(reply, token);
    return reply.send({ userId: row.userId, displayName: row.displayName });
  });

  app.post('/platform/auth/enroll', async (request, reply) => {
    if (mfa === undefined)
      return reply
        .code(503)
        .send({ error: { code: 'MFA_UNAVAILABLE', message: 'Platform MFA is not configured' } });
    const body = request.body as EnrollBody | undefined;
    const enrollment = openTokenWithUser(field(body, 'enrollmentToken'), 'enrollment', mfa);
    const code = validText(field(body, 'code'), 'MFA_CODE_REQUIRED');
    const secret = Buffer.from(enrollment.secret ?? '', 'base64url');
    if (!enrollment.factorId || secret.length === 0 || !verifyTotpCode(secret, code))
      return reply.code(401).send({ error: { code: 'MFA_FAILED', message: 'Invalid MFA code' } });
    const encrypted = encryptMfaSecret(secret, `${enrollment.userId}|${enrollment.factorId}`, mfa);
    await client.$queryRaw`SELECT public.platform_auth_enroll_mfa(${enrollment.userId}::uuid, ${enrollment.factorId}::uuid, ${encrypted.ciphertext}, ${encrypted.iv}, ${encrypted.authTag}, ${encrypted.keyVersion}, ${enrollment.recoveryHashes ?? []}::text[])`;
    const token = await createPlatformSession(client, enrollment.userId);
    setPlatformCookie(reply, token);
    return reply.send({ userId: enrollment.userId, mfaEnrolled: true });
  });

  app.get('/platform/auth/me', async (request, reply) => {
    const session = await requirePlatformSession(client, request);
    return reply.send({
      userId: session.userId,
      displayName: session.displayName,
      mobile: session.mobile,
    });
  });

  app.post('/platform/auth/logout', async (request, reply) => {
    const token = request.cookies[PLATFORM_SESSION_COOKIE];
    if (nonEmpty(token)) {
      const rows = await client.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM public.platform_auth_find_session(${hashToken(token)})`;
      if (rows[0])
        await client.$queryRaw`SELECT public.platform_auth_revoke_session(${rows[0].id}::uuid)`;
    }
    clearPlatformCookie(reply);
    return reply.code(204).send();
  });

  app.get('/platform/settings/trial', async (request) => {
    await requirePlatformSession(client, request);
    const setting = await client.platformSetting.findUnique({ where: { id: 1 } });
    if (!setting) throw new NotFoundError('Trial settings not found');
    return { trialDays: setting.trialDays };
  });

  app.post('/platform/settings/trial', async (request) => {
    const actor = await requirePlatformSession(client, request);
    let sameOrigin = false;
    try { const origin = new URL(request.headers.origin ?? ''); sameOrigin = ['http:', 'https:'].includes(origin.protocol) && origin.host === request.headers.host; } catch { /* reject */ }
    if (!sameOrigin) throw new ValidationError('A same-origin request is required');
    const days = field(request.body, 'trialDays');
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) throw new ValidationError('Trial duration must be between 1 and 365 days');
    await client.$queryRaw`SELECT public.platform_set_trial_days(${actor.userId}::uuid, ${days}::integer)`;
    return { trialDays: days };
  });

  app.get('/platform/accounts', async (request, reply) => {
    await requirePlatformSession(client, request);
    const rows = await listCustomers(client);
    const query = request.query as { search?: string; state?: string; plan?: string };
    const search = query.search?.trim().toLowerCase();
    const data = rows.map(mapCustomer).filter((row) => {
      if (
        search &&
        ![row.name, row.slug, row.ownerName, row.ownerMobile, row.city].some((value) =>
          String(value ?? '')
            .toLowerCase()
            .includes(search),
        )
      )
        return false;
      if (query.state && row.state !== query.state) return false;
      if (query.plan && row.planTier !== query.plan) return false;
      return true;
    });
    return reply.send({ accounts: data, total: data.length });
  });

  app.get('/platform/accounts/:id', async (request, reply) => {
    await requirePlatformSession(client, request);
    const tenantId = validId((request.params as { id?: unknown }).id);
    const row = (await listCustomers(client)).map(mapCustomer).find((item) => item.id === tenantId);
    if (!row) throw new NotFoundError('Account not found');
    const details = await withTenantTx(client, tenantId, async (tx) => {
      const [domains, sms, subscription] = await Promise.all([
        tx.domain.findMany({ orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] }),
        tx.tenantSmsAccount.findUnique({ where: { tenantId } }),
        tx.tenantSubscription.findFirst({
          orderBy: { createdAt: 'desc' },
          include: { plan: true },
        }),
      ]);
      return { domains, sms, subscription };
    });
    const audit = await client.$queryRaw<
      Array<Record<string, unknown>>
    >`SELECT * FROM public.platform_list_audit_logs(${tenantId}::uuid, 200)`;
    return reply.send({
      account: row,
      domains: details.domains,
      sms: details.sms
        ? {
            provider: details.sms.provider,
            sender: details.sms.sender,
            isActive: details.sms.isActive,
            lastError: details.sms.lastError,
            lastVerifiedAt: details.sms.lastVerifiedAt,
          }
        : null,
      subscription: details.subscription,
      activity: audit,
    });
  });

  app.post('/platform/accounts/:id/domains', async (request, reply) => {
    const actor = await requirePlatformSession(client, request);
    const tenantId = validId((request.params as { id?: unknown }).id);
    const raw = validText(field(request.body, 'hostname'), 'DOMAIN_REQUIRED');
    const hostname = normalizeHostname(raw);
    if (
      raw.includes(':') ||
      hostname.length > 253 ||
      !hostname.includes('.') ||
      hostname.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ) {
      throw new ValidationError('Invalid domain', { code: 'DOMAIN_INVALID' });
    }
    const requestedId = field(request.body, 'domainId');
    const domainId = requestedId === undefined ? randomUUID() : validId(requestedId);
    const token = randomBytes(18).toString('hex');
    const rows = await client.$queryRaw<Array<{ changed: boolean }>>`
      SELECT public.platform_save_domain(${tenantId}::uuid, ${domainId}::uuid, ${hostname}, ${token}, ${requestedId !== undefined}, ${actor.userId}::uuid) AS changed`;
    if (!rows[0]?.changed) throw new NotFoundError('Clinic or domain not found');
    return reply.send({ ok: true });
  });

  app.post('/platform/accounts/:id/domains/:domainId/verify', async (request, reply) => {
    const actor = await requirePlatformSession(client, request);
    const params = request.params as { id?: unknown; domainId?: unknown };
    const tenantId = validId(params.id);
    const domainId = validId(params.domainId);
    const domain = await withTenantTx(client, tenantId, (tx) =>
      tx.domain.findFirst({ where: { id: domainId, tenantId } }),
    );
    if (domain === null) throw new NotFoundError('Domain not found');
    let records: string[][];
    try {
      records = await resolveTxt(`_hoomana-verification.${domain.hostname}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENODATA' || code === 'ENOTFOUND' || code === 'ENONAME') records = [];
      else
        return reply.code(503).send({
          error: { code: 'DNS_UNAVAILABLE', message: 'DNS lookup is temporarily unavailable' },
        });
    }
    const verified =
      domain.verificationToken !== null &&
      records.some((record) => record.join('') === domain.verificationToken);
    const rows = await client.$queryRaw<Array<{ changed: boolean }>>`
      SELECT public.platform_check_domain(${tenantId}::uuid, ${domainId}::uuid, ${domain.hostname}, ${domain.verificationToken}, ${verified}, ${actor.userId}::uuid) AS changed`;
    if (!rows[0]?.changed)
      return reply
        .code(409)
        .send({ error: { code: 'DOMAIN_CHANGED', message: 'Domain changed; retry verification' } });
    if (!verified)
      return reply
        .code(422)
        .send({ error: { code: 'DOMAIN_NOT_VERIFIED', message: 'DNS record does not match' } });
    return reply.send({ ok: true });
  });

  app.post('/platform/accounts/:id/sms', async (request, reply) => {
    const actor = await requirePlatformSession(client, request);
    const tenantId = validId((request.params as { id?: unknown }).id);
    const panelRef = validText(field(request.body, 'panelRef'), 'SMS_PANEL_REQUIRED');
    const sender = validText(field(request.body, 'sender'), 'SMS_SENDER_REQUIRED');
    if (panelRef.length < 16 || panelRef.length > 512 || !/^\d{5,20}$/.test(sender)) {
      throw new ValidationError('Invalid SMS connection', { code: 'SMS_CONNECTION_INVALID' });
    }
    if (options.smsEncryption === undefined) {
      return reply.code(503).send({
        error: {
          code: 'SMS_ENCRYPTION_UNAVAILABLE',
          message: 'SMS encryption is not configured',
        },
      });
    }
    const accountId = randomUUID();
    const encrypted = encryptSecret(panelRef, `${tenantId}|${accountId}`, options.smsEncryption);
    const rows = await client.$queryRaw<Array<{ changed: boolean }>>`
      SELECT public.platform_save_sms(${tenantId}::uuid, ${accountId}::uuid, ${encrypted.ciphertext}, ${encrypted.iv}, ${encrypted.authTag}, ${encrypted.keyVersion}, ${sender}, ${actor.userId}::uuid) AS changed`;
    if (!rows[0]?.changed) throw new NotFoundError('Clinic not found');
    return reply.send({ ok: true });
  });

  app.post('/platform/accounts', async (request, reply) => {
    const actor = await requirePlatformSession(client, request);
    const body = request.body as AccountBody | undefined;
    const name = validText(field(body, 'name'), 'NAME_REQUIRED');
    const slug = validSlug(field(body, 'slug'));
    const ownerName = validText(field(body, 'ownerName'), 'OWNER_NAME_REQUIRED');
    const ownerMobile = validMobile(field(body, 'ownerMobile'));
    const planTier = validTier(field(body, 'planTier') ?? 'FREE');
    const rows = await client.$queryRaw<
      Array<{ tenantId: string; ownerUserId: string }>
    >`SELECT * FROM public.platform_create_tenant(${name}, ${slug}, ${ownerName}, ${ownerMobile}, ${planTier}, ${actor.userId}::uuid)`;
    return reply.code(201).send({ account: rows[0] });
  });

  app.patch('/platform/accounts/:id', async (request, reply) => {
    const actor = await requirePlatformSession(client, request);
    const tenantId = validId((request.params as { id?: unknown }).id);
    const body = request.body as AccountBody | undefined;
    await client.$queryRaw`SELECT public.platform_update_tenant(${tenantId}::uuid, ${validText(field(body, 'name'), 'NAME_REQUIRED')}, ${validSlug(field(body, 'slug'))}, ${validText(field(body, 'ownerName'), 'OWNER_NAME_REQUIRED')}, ${validMobile(field(body, 'ownerMobile'))}, ${actor.userId}::uuid)`;
    return reply.send({ ok: true });
  });

  app.post('/platform/accounts/:id/state', async (request, reply) => {
    const actor = await requirePlatformSession(client, request);
    const tenantId = validId((request.params as { id?: unknown }).id);
    const body = request.body as AccountBody | undefined;
    const state = field(body, 'state');
    if (state !== 'ACTIVE' && state !== 'SUSPENDED' && state !== 'BLOCKED')
      throw new ValidationError('The account state is invalid', { code: 'STATE_INVALID' });
    const reason = field(body, 'reason');
    if (reason !== undefined && typeof reason !== 'string')
      throw new ValidationError('The reason is invalid', { code: 'REASON_INVALID' });
    await client.$queryRaw`SELECT public.platform_set_tenant_state(${tenantId}::uuid, ${state}, ${reason ?? ''}, ${actor.userId}::uuid)`;
    return reply.send({ ok: true, state });
  });

  app.delete('/platform/accounts/:id', async (request, reply) => {
    const actor = await requirePlatformSession(client, request);
    const tenantId = validId((request.params as { id?: unknown }).id);
    await client.$queryRaw`SELECT public.platform_set_tenant_state(${tenantId}::uuid, 'BLOCKED', 'Deleted by platform administrator', ${actor.userId}::uuid)`;
    return reply.send({ ok: true, state: 'BLOCKED' });
  });

  app.post('/platform/accounts/:id/subscription', async (request, reply) => {
    const actor = await requirePlatformSession(client, request);
    const tenantId = validId((request.params as { id?: unknown }).id);
    const body = request.body as AccountBody | undefined;
    const tier = validTier(field(body, 'planTier'));
    const months = typeof field(body, 'months') === 'number' ? Number(field(body, 'months')) : 1;
    const rows = await client.$queryRaw<
      Array<Record<string, unknown>>
    >`SELECT * FROM public.platform_set_tenant_subscription(${tenantId}::uuid, ${tier}, ${months}, ${actor.userId}::uuid)`;
    return reply.send({ subscription: rows[0] });
  });
}
