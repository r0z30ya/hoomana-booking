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
 * Phase 2 deliberately contains no tenant, auth or SMS configuration: those arrive
 * with the phases that actually use them, so that a missing variable can never be
 * mistaken for a configured one.
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

  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
});

export type Environment = z.infer<typeof environmentSchema>;
