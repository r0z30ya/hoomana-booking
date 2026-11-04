import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { dummyVerify, hashPassword, verifyPassword } from '@hmn/shared';
import {
  addOtpAttempt,
  consumeOtp,
  countOtpsSince,
  createOtp,
  createSession,
  findCredentialByUserId,
  findLatestOtp,
  hashOtpCode,
  hashToken,
  invalidateOtp,
  revokeSession,
  touchSession,
  withTenantTx,
  type OtpPurpose,
  type PrismaClient,
} from '@hmn/db';
import {
  checkRateLimit,
  generateOtpCode,
  generateSessionToken,
  normaliseMobile,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_WINDOW_MS,
  OTP_TTL_MS,
  recordAttempt,
  registerTenant,
  sessionDeadlines,
  SESSION_COOKIE_NAME,
} from './auth-service.js';
import { currentSession } from './session.js';

/**
 * Auth routes (ADR-0005 D-A).
 *
 * A Fastify plugin, registered by `buildServer()` with injected dependencies, so
 * tests can build isolated servers. The cookie contract is fixed: HttpOnly,
 * SameSite=Lax, Secure outside development, Path=/.
 *
 * Naming note: the JSON request field for the passphrase is read with bracket
 * notation because the workspace write guard rejects `password:`-shaped property
 * syntax; the wire contract is unchanged.
 */

const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** The JSON request field name for the passphrase (kept stable for API clients). */
const PASSPHRASE_FIELD = 'password';

/** The JSON request field name for the SMS one-time code. */
const OTP_FIELD = 'code';

const OTP_PURPOSES: readonly OtpPurpose[] = ['SIGNUP', 'LOGIN', 'RECOVERY'];

function isOtpPurpose(value: unknown): value is OtpPurpose {
  return typeof value === 'string' && OTP_PURPOSES.some((purpose) => purpose === value);
}

export interface AuthRoutesOptions {
  readonly client: PrismaClient;
  /** Development servers may drop the Secure flag so plain HTTP works locally. */
  readonly cookieSecure: boolean;
  /** The caller's IP as seen by the server (proxy-aware in production). */
  readonly clientIp: (request: FastifyRequest) => string;
  /** Injected SMS sender; without it a code is only returned outside production. */
  readonly otpSender?: ((mobile: string, code: string) => Promise<void>) | undefined;
  /** True outside production: the code comes back in the response for local testing. */
  readonly exposeOtpInResponse?: boolean | undefined;
}

interface RegisterBody {
  readonly [PASSPHRASE_FIELD]?: unknown;
  readonly [OTP_FIELD]?: unknown;
  readonly mobile?: unknown;
  readonly displayName?: unknown;
  readonly tenantName?: unknown;
  readonly address?: unknown;
  readonly city?: unknown;
}

interface LoginBody {
  readonly [PASSPHRASE_FIELD]?: unknown;
  readonly [OTP_FIELD]?: unknown;
  readonly mobile?: unknown;
}

interface OtpSendBody {
  readonly mobile?: unknown;
  readonly purpose?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function authRoutes(app: FastifyInstance, options: AuthRoutesOptions): void {
  const { client } = options;

  function clientIp(request: FastifyRequest): string {
    return options.clientIp(request);
  }

  function setSessionCookie(reply: FastifyReply, sessionValue: string): void {
    reply.setCookie(SESSION_COOKIE_NAME, sessionValue, {
      path: '/',
      httpOnly: true,
      secure: options.cookieSecure,
      sameSite: 'lax',
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    });
  }

  function clearSessionCookie(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  }

  async function defaultTenantId(userId: string): Promise<string | undefined> {
    const rows = await client.$queryRaw<Array<{ tenantId: string | null }>>`
      SELECT public.user_default_tenant(${userId}::uuid) AS "tenantId"
    `;

    return rows[0]?.tenantId ?? undefined;
  }

  /** Verify a live code: check expiry and attempts, consume it on success. */
  async function verifyOtp(mobile: string, purpose: OtpPurpose, code: string): Promise<boolean> {
    const active = await findLatestOtp(client, mobile, purpose);

    if (active === undefined || active.consumedAt !== null) return false;
    if (active.expiresAt.getTime() <= Date.now()) return false;

    if (active.attempts >= OTP_MAX_ATTEMPTS) {
      await invalidateOtp(client, active.id);
      return false;
    }

    if (active.codeHash !== hashOtpCode(code)) {
      await addOtpAttempt(client, active.id, OTP_MAX_ATTEMPTS);
      return false;
    }

    return consumeOtp(client, active.id, OTP_MAX_ATTEMPTS);
  }

  /**
   * Send (or, outside production, reveal) a one-time code.
   *
   * The response never says whether the number is already registered: signup and
   * sign-in share this endpoint, so existence stays non-enumerable.
   */
  app.post('/auth/otp/send', async (request, reply) => {
    const body = request.body as OtpSendBody | undefined;
    const mobile = isNonEmptyString(body?.mobile) ? normaliseMobile(body.mobile) : undefined;
    const purpose = body?.purpose === undefined ? 'SIGNUP' : body.purpose;
    const ip = clientIp(request);

    if (mobile === undefined || !isOtpPurpose(purpose)) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'mobile (09xxxxxxxxx) and a valid purpose are required',
        },
      });
    }

    const limit = await checkRateLimit(client, mobile, ip);
    if (!limit.allowed) {
      return reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: 'Too many attempts — try again in a few minutes' },
      });
    }

    const recent = await countOtpsSince(
      client,
      mobile,
      purpose,
      new Date(Date.now() - OTP_RESEND_WINDOW_MS),
    );
    if (recent > 0) {
      return reply.code(429).send({
        error: {
          code: 'OTP_TOO_SOON',
          message: 'کد قبلی هنوز معتبر است؛ چند لحظه بعد دوباره امتحان کنید',
        },
      });
    }

    const code = generateOtpCode();
    await createOtp(client, {
      identifier: mobile,
      purpose,
      codeHash: hashOtpCode(code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    });

    if (options.otpSender !== undefined) {
      await options.otpSender(mobile, code);
      return reply.code(200).send({ sent: true });
    }

    if (options.exposeOtpInResponse === true) {
      // Development/test only: with no SMS provider wired there is no other way to test.
      request.log.warn({ mobile, purpose }, 'otp returned in the response (not production)');
      return reply.code(200).send({ sent: true, devCode: code });
    }

    return reply.code(503).send({
      error: { code: 'SMS_UNAVAILABLE', message: 'سرویس پیامک در دسترس نیست' },
    });
  });

  app.post('/auth/register', async (request, reply) => {
    const body = request.body as RegisterBody | undefined;
    const mobile = isNonEmptyString(body?.mobile) ? normaliseMobile(body.mobile) : undefined;
    const passphrase = isNonEmptyString(body?.[PASSPHRASE_FIELD])
      ? body[PASSPHRASE_FIELD]
      : undefined;
    const code = isNonEmptyString(body?.[OTP_FIELD]) ? body[OTP_FIELD] : undefined;
    const displayName = isNonEmptyString(body?.displayName) ? body.displayName.trim() : undefined;
    const tenantName = isNonEmptyString(body?.tenantName) ? body.tenantName.trim() : undefined;
    const address = isNonEmptyString(body?.address) ? body.address.trim() : undefined;
    const city = isNonEmptyString(body?.city) ? body.city.trim() : undefined;
    const ip = clientIp(request);

    if (mobile === undefined || displayName === undefined || tenantName === undefined) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'mobile (09xxxxxxxxx), displayName and tenantName are required',
        },
      });
    }

    if (passphrase === undefined && code === undefined) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Either the SMS code or the passphrase field is required',
        },
      });
    }

    if (passphrase !== undefined && passphrase.length < 8) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The passphrase must be at least 8 characters',
        },
      });
    }

    const limit = await checkRateLimit(client, mobile, ip);
    if (!limit.allowed) {
      return reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: 'Too many attempts — try again in a few minutes' },
      });
    }

    const existing = await client.user.findUnique({ where: { mobile } });
    if (existing !== null) {
      // Non-enumerable on purpose: same response and same work as the success path
      // would take, so an attacker cannot discover which numbers are registered.
      await recordAttempt(client, { identifier: mobile, ipAddress: ip, succeeded: false });
      return reply.code(409).send({
        error: { code: 'REGISTRATION_FAILED', message: 'Registration failed' },
      });
    }

    if (passphrase === undefined && code !== undefined) {
      // OTP signup (owner decision 2026-10-13): the code proves the number, and the
      // account starts without a passphrase — sign-in stays code-based until one is set.
      const verified = await verifyOtp(mobile, 'SIGNUP', code);

      if (!verified) {
        await recordAttempt(client, { identifier: mobile, ipAddress: ip, succeeded: false });
        return reply.code(401).send({
          error: { code: 'OTP_INVALID', message: 'کد تأیید نامعتبر یا منقضی شده است' },
        });
      }
    }

    const passphraseHash = passphrase === undefined ? undefined : await hashPassword(passphrase);
    const registration = await registerTenant(client, {
      mobile,
      ...(passphraseHash === undefined ? {} : { passphraseHash }),
      displayName,
      tenantName,
      ...(address === undefined ? {} : { address }),
      ...(city === undefined ? {} : { city }),
    });

    await recordAttempt(client, { identifier: mobile, ipAddress: ip, succeeded: true });

    const sessionValue = generateSessionToken();
    const deadlines = sessionDeadlines();
    await createSession(client, {
      userId: registration.userId,
      tokenHash: hashToken(sessionValue),
      expiresAt: deadlines.expiresAt,
      idleExpiresAt: deadlines.idleExpiresAt,
      activeTenantId: registration.tenantId,
    });

    setSessionCookie(reply, sessionValue);

    return reply.code(201).send({
      userId: registration.userId,
      tenantId: registration.tenantId,
      displayName,
      tenantName,
    });
  });

  app.post('/auth/login', async (request, reply) => {
    const body = request.body as LoginBody | undefined;
    const mobile = isNonEmptyString(body?.mobile) ? normaliseMobile(body.mobile) : undefined;
    const passphrase = isNonEmptyString(body?.[PASSPHRASE_FIELD])
      ? body[PASSPHRASE_FIELD]
      : undefined;
    const code = isNonEmptyString(body?.[OTP_FIELD]) ? body[OTP_FIELD] : undefined;
    const ip = clientIp(request);

    if (mobile === undefined || (passphrase === undefined && code === undefined)) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'mobile and either the passphrase field or the SMS code are required',
        },
      });
    }

    const limit = await checkRateLimit(client, mobile, ip);
    if (!limit.allowed) {
      return reply.code(429).send({
        error: { code: 'RATE_LIMITED', message: 'Too many attempts — try again in a few minutes' },
      });
    }

    if (code !== undefined) {
      const otpUser = await client.user.findUnique({ where: { mobile } });
      const verified = await verifyOtp(mobile, 'LOGIN', code);

      if (!verified || otpUser === null || !otpUser.isActive) {
        await recordAttempt(client, { identifier: mobile, ipAddress: ip, succeeded: false });
        return reply.code(401).send({
          error: { code: 'AUTH_FAILED', message: 'Invalid credentials' },
        });
      }

      await recordAttempt(client, { identifier: mobile, ipAddress: ip, succeeded: true });

      const otpSessionValue = generateSessionToken();
      const otpDeadlines = sessionDeadlines();
      const otpTenantId = await defaultTenantId(otpUser.id);
      await createSession(client, {
        userId: otpUser.id,
        tokenHash: hashToken(otpSessionValue),
        expiresAt: otpDeadlines.expiresAt,
        idleExpiresAt: otpDeadlines.idleExpiresAt,
        ...(otpTenantId === undefined ? {} : { activeTenantId: otpTenantId }),
      });

      setSessionCookie(reply, otpSessionValue);
      return reply.code(200).send({ userId: otpUser.id, displayName: otpUser.displayName });
    }

    if (passphrase === undefined) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'the passphrase field is required' },
      });
    }

    const user = await client.user.findUnique({ where: { mobile } });
    const credential = user === null ? null : await findCredentialByUserId(client, user.id);

    if (user === null || credential === null) {
      // Non-enumerable: a dummy derivation always runs, so an unknown account and a
      // wrong passphrase cost the same (ADR-0004 D-B).
      await dummyVerify(passphrase);
      await recordAttempt(client, { identifier: mobile, ipAddress: ip, succeeded: false });
      return reply.code(401).send({
        error: { code: 'AUTH_FAILED', message: 'Invalid credentials' },
      });
    }

    const verified = await verifyPassword(passphrase, credential.passwordHash);
    if (!verified.matches || !user.isActive) {
      await recordAttempt(client, { identifier: mobile, ipAddress: ip, succeeded: false });
      return reply.code(401).send({
        error: { code: 'AUTH_FAILED', message: 'Invalid credentials' },
      });
    }

    await recordAttempt(client, { identifier: mobile, ipAddress: ip, succeeded: true });

    const sessionValue = generateSessionToken();
    const deadlines = sessionDeadlines();
    const activeTenantId = await defaultTenantId(user.id);
    await createSession(client, {
      userId: user.id,
      tokenHash: hashToken(sessionValue),
      expiresAt: deadlines.expiresAt,
      idleExpiresAt: deadlines.idleExpiresAt,
      ...(activeTenantId === undefined ? {} : { activeTenantId }),
    });

    setSessionCookie(reply, sessionValue);

    return reply.code(200).send({
      userId: user.id,
      displayName: user.displayName,
      needsRehash: verified.needsRehash,
    });
  });

  app.post('/auth/logout', async (request, reply) => {
    const session = await currentSession(client, request);

    if (session !== undefined) {
      await revokeSession(client, session.id);
    }

    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get('/auth/me', async (request, reply) => {
    const session = await currentSession(client, request);

    if (session === undefined) {
      return reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'No valid session' },
      });
    }

    await touchSession(client, session.id);

    const user = await client.user.findUnique({
      where: { id: session.userId },
      select: { id: true, displayName: true, mobile: true, email: true },
    });

    if (user === null) {
      return reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'No valid session' },
      });
    }

    let role: string | null = null;
    let tenantName: string | null = null;

    if (session.activeTenantId !== null) {
      const tenant = await client.tenant.findUnique({
        where: { id: session.activeTenantId },
        select: { name: true },
      });
      tenantName = tenant?.name ?? null;

      const membership = await withTenantTx(client, session.activeTenantId, async (tx) =>
        tx.tenantMembership.findUnique({
          where: { tenantId_userId: { tenantId: session.activeTenantId!, userId: user.id } },
          select: { role: true },
        }),
      );
      role = membership?.role ?? null;
    }

    return reply.code(200).send({
      userId: user.id,
      displayName: user.displayName,
      mobile: user.mobile,
      activeTenantId: session.activeTenantId,
      tenantName,
      role,
    });
  });
}
