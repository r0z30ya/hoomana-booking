import { z } from 'zod';

/**
 * Runtime environment names. `test` is used by Vitest so that logging and error
 * detail behave differently from real development and production runs.
 */
export const nodeEnvironmentSchema = z.enum(['development', 'test', 'production']);

export type NodeEnvironment = z.infer<typeof nodeEnvironmentSchema>;

export const logLevelSchema = z.enum([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

export type LogLevel = z.infer<typeof logLevelSchema>;

/**
 * The complete set of environment variables the backend reads.
 *
 * Phase 2 deliberately contained no tenant, auth or SMS configuration. The auth
 * tuning below arrived with Phase 4 (ADR-0004 A-3); tenant and SMS configuration
 * still wait for the phases that actually use them, so a missing variable can
 * never be mistaken for a configured one.
 *
 * Values are validated at process start. An invalid or missing variable is a
 * configuration failure and must stop the process rather than fail on first use.
 */
export const environmentSchema = z.object({
  NODE_ENV: nodeEnvironmentSchema.default('development'),
  LOG_LEVEL: logLevelSchema.default('info'),

  /** Bind address for apps/api. Defaults to loopback so local runs stay private. */
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),

  /** Migration credentials: Prisma CLI ONLY. Runtime processes reject them (ADR-0003 D7). */
  DATABASE_URL: z.url(),
  /** API/worker runtime connection as the RLS-bound hmn_app role. */
  DATABASE_APP_URL: z.url(),
  /** Audited platform operations (hmn_platform). Optional: only ops/tests use it. */
  DATABASE_PLATFORM_URL: z.url().optional(),
  REDIS_URL: z.url(),

  /**
   * Password hashing tuning (ADR-0004 A-3). The floors are hard: a weaker value is
   * rejected at boot instead of silently producing weak hashes. Defaults are the
   * proposed parameters — raise them after the benchmark; existing hashes rehash
   * transparently on the next successful sign-in (`needsRehash`).
   */
  AUTH_SCRYPT_N: z.coerce.number().int().min(16_384).max(1_048_576).default(32_768),
  AUTH_SCRYPT_R: z.coerce.number().int().min(8).max(32).default(8),
  AUTH_SCRYPT_P: z.coerce.number().int().min(1).max(16).default(1),
  AUTH_SCRYPT_KEYLEN: z.coerce.number().int().min(32).max(128).default(64),
  /** Optional explicit memory ceiling; derived from `N` and `r` when absent. */
  AUTH_SCRYPT_MAXMEM: z.coerce.number().int().min(33_554_432).optional(),

  /**
   * Platform SMS panel (§2.10). Optional at boot on purpose: tenants may bring their
   * own panel credentials (stored per tenant, never here), and the platform panel is
   * only needed by the features that send on our own line. A missing key therefore
   * fails closed where it is used (`isSmsConfigured`), never silently.
   */
  SMS_PROVIDER: z.enum(['melipayamak']).default('melipayamak'),
  /** Panel credential. Never logged, never in an error message, never in a repo file. */
  SMS_MELIPAYAMAK_PANEL_REF: z.string().min(16).optional(),
  /** The panel's sender line, e.g. a 14-digit service number. */
  SMS_MELIPAYAMAK_SENDER: z.string().regex(/^\d{5,20}$/).optional(),
});

export type Environment = z.infer<typeof environmentSchema>;
