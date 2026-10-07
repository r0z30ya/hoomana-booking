import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { environmentSchema, type Environment } from '@hmn/validation';
import { ConfigurationError } from './errors.js';

const ENV_FILE_NAME = '.env';
const MAX_SEARCH_DEPTH = 6;

/**
 * Walk upwards looking for a `.env` file.
 *
 * The monorepo runs commands from several working directories (repo root, apps/api,
 * packages/db), so a fixed relative path would break depending on where a command was
 * started. Searching upwards makes the repository root the single source of truth.
 */
export function findEnvFile(startDirectory: string): string | undefined {
  let directory = resolve(startDirectory);

  for (let depth = 0; depth < MAX_SEARCH_DEPTH; depth += 1) {
    const candidate = resolve(directory, ENV_FILE_NAME);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return undefined;
}

export interface LoadEnvironmentOptions {
  /** Explicit env file. Overrides the upwards search when provided. */
  readonly envFile?: string;
  readonly startDirectory?: string;
  /** Set false to read only the real process environment. */
  readonly searchForEnvFile?: boolean;
  /** Injectable for tests. Defaults to `process.env`. */
  readonly source?: Record<string, string | undefined>;
}

/**
 * Load and validate environment configuration.
 *
 * Precedence is deliberate: real process environment variables win over `.env` file
 * values (Node's own `loadEnvFile` semantics), so a container or CI can override any
 * value without editing a file. The file only fills gaps.
 *
 * Results are not cached — each caller receives a validated value, and tests can call
 * this repeatedly without shared state.
 */
export function loadEnvironment(options: LoadEnvironmentOptions = {}): Environment {
  const { startDirectory = process.cwd(), searchForEnvFile = true, source = process.env } = options;

  const envFile = options.envFile ?? (searchForEnvFile ? findEnvFile(startDirectory) : undefined);

  if (envFile !== undefined) {
    process.loadEnvFile(envFile);
  }

  const parsed = environmentSchema.safeParse(source);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');

    throw new ConfigurationError(`Invalid environment configuration — ${problems}`, {
      code: 'INVALID_ENVIRONMENT',
      details: { problems: parsed.error.issues.length },
    });
  }

  return parsed.data;
}
