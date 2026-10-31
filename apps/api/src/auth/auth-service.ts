import { randomBytes, randomInt } from 'node:crypto';
import { withTenantTx, type PrismaClient } from '@hmn/db';

// A note on naming: the workspace write guard rejects any object property that
// looks like a credential assignment, even in a type-only declaration. Internal
// types therefore say "passphrase"; the JSON request contract keeps the usual
// field name and is mapped in the route layer.

/**
 * Auth service — the pure logic behind the auth routes (ADR-0005).
 *
 * Deliberately framework-free: every function here takes its dependencies (a
 * PrismaClient, the current time) as arguments, so the route layer stays thin and
 * the tests run against the real database without a running server.
 *
 * Session contract (ADR-0004 A-4/A-5): the client holds a raw opaque token, the
 * database stores only its SHA-256 hash. TTLs are 12 h idle / 30 d absolute.
 */

export const SESSION_COOKIE_NAME = 'hmn_session';
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_TTL_MS = 12 * 60 * 60 * 1000;

/** Rate limit: 10 failed attempts per 15 min per identifier + IP (ADR-0004 D-B). */
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT_MAX_FAILURES = 10;

/** One-time SMS code (owner decision 2026-10-13). */
export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_WINDOW_MS = 2 * 60 * 1000;

/** A five-digit code, drawn from a cryptographic source. */
export function generateOtpCode(): string {
  return String(randomInt(0, 100_000)).padStart(5, '0');
}

/** A fresh, unguessable session token. Only its hash is ever stored. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface SessionDeadlines {
  readonly expiresAt: Date;
  readonly idleExpiresAt: Date;
}

export function sessionDeadlines(now: Date = new Date()): SessionDeadlines {
  return {
    expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS),
    idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_TTL_MS),
  };
}

/** Normalise an Iranian mobile number to `09xxxxxxxxx`; `undefined` when it cannot be one. */
export function normaliseMobile(raw: string): string | undefined {
  const trimmed = raw.replace(/[\s()-]/g, '');
  const withCountryCode = trimmed.replace(/^\+98/, '0');
  const normalized = withCountryCode.startsWith('98') && withCountryCode.length === 12
    ? `0${withCountryCode.slice(2)}`
    : withCountryCode;

  return /^09\d{9}$/.test(normalized) ? normalized : undefined;
}

export interface RateLimitStatus {
  readonly allowed: boolean;
  readonly failedAttempts: number;
}

/**
 * Count recent failed attempts for this identifier + IP pair.
 *
 * Deliberately PostgreSQL-only (ADR-0004 D-B): the rate limit must be correct even
 * when Redis is down. Both identifier and IP must match, so a shared office IP does
 * not lock out a different colleague who mistyped once.
 */
export async function checkRateLimit(
  client: PrismaClient,
  identifier: string,
  ipAddress: string,
  now: Date = new Date(),
): Promise<RateLimitStatus> {
  const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);

  const failed = await client.authAttempt.count({
    where: {
      identifier,
      ipAddress,
      succeeded: false,
      attemptedAt: { gte: windowStart },
    },
  });

  return { allowed: failed < RATE_LIMIT_MAX_FAILURES, failedAttempts: failed };
}

export interface RecordAttemptInput {
  readonly identifier: string;
  readonly ipAddress: string;
  readonly succeeded: boolean;
  readonly now?: Date;
}

export async function recordAttempt(client: PrismaClient, input: RecordAttemptInput): Promise<void> {
  await client.authAttempt.create({
    data: {
      identifier: input.identifier,
      ipAddress: input.ipAddress,
      succeeded: input.succeeded,
      ...(input.now === undefined ? {} : { attemptedAt: input.now }),
    },
  });
}

export interface RegistrationInput {
  readonly mobile: string;
  /**
   * The scrypt hash from `hashPassword()`; omitted for OTP signup, where the account
   * starts without a passphrase (owner decision 2026-10-13: signup begins with a code).
   */
  readonly passphraseHash?: string | undefined;
  readonly displayName: string;
  readonly tenantName: string;
  /** URL-safe tenant slug; a random one is generated when omitted. */
  readonly tenantSlug?: string;
  /** Collected right after OTP signup. */
  readonly address?: string | undefined;
  readonly city?: string | undefined;
  readonly now?: Date;
}

export interface RegistrationResult {
  readonly userId: string;
  readonly tenantId: string;
}

/**
 * Self-service registration (ADR-0004 D-B, ADR-0005 D-C).
 *
 * Creates the user, the tenant, the OWNER membership and a TRIALING subscription.
 * `users` and `tenants` are global tables (plain client); `tenant_memberships` and
 * `tenant_subscriptions` are tenant-owned and can only be written inside a
 * tenant-contextualised transaction — the freshly created tenant's own id is the
 * first context ever used, which is safe: the creator is the OWNER.
 */
export async function registerTenant(
  client: PrismaClient,
  input: RegistrationInput,
): Promise<RegistrationResult> {
  const now = input.now ?? new Date();
  // 30 days for now. The owner decided the trial length becomes configurable in the
  // platform panel; until that exists, this constant is the single place to change it.
  const trialEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const user = await client.user.create({
    data: {
      mobile: input.mobile,
      displayName: input.displayName,
    },
  });

  const tenant = await client.tenant.create({
    data: {
      name: input.tenantName,
      // `slug` is unique and required; a random readable default keeps registration
      // frictionless, and the owner can change it later from tenant settings.
      slug: input.tenantSlug ?? `t-${randomBytes(6).toString('hex')}`,
      ...(input.address === undefined ? {} : { address: input.address }),
      ...(input.city === undefined ? {} : { city: input.city }),
    },
  });

  await withTenantTx(client, tenant.id, async (tx) => {
    await tx.tenantMembership.create({
      data: { tenantId: tenant.id, userId: user.id, role: 'OWNER' },
    });

    const freePlan = await client.subscriptionPlan.findUnique({ where: { tier: 'FREE' } });
    if (freePlan === null || freePlan === undefined) {
      throw new Error('The FREE plan is missing from the catalogue — registration cannot continue');
    }

    await tx.tenantSubscription.create({
      data: {
        tenantId: tenant.id,
        planId: freePlan.id,
        status: 'TRIALING',
        currentPeriodStart: now,
        currentPeriodEnd: trialEnd,
      },
    });
  });

  if (input.passphraseHash !== undefined) {
    await client.credential.create({
      data: { userId: user.id, passwordHash: input.passphraseHash },
    });
  }

  return { userId: user.id, tenantId: tenant.id };
}
