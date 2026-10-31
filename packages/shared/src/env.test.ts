import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from './errors.js';
import { findEnvFile, loadEnvironment } from './env.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'hmn-env-test-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('findEnvFile', () => {
  it('returns the .env in the starting directory', () => {
    const envFile = join(workspace, '.env');
    writeFileSync(envFile, 'NODE_ENV=development\n');

    expect(findEnvFile(workspace)).toBe(envFile);
  });

  it('walks upwards to find a .env in a parent directory', () => {
    const envFile = join(workspace, '.env');
    writeFileSync(envFile, 'NODE_ENV=development\n');
    const nested = join(workspace, 'apps', 'api');
    mkdirSync(nested, { recursive: true });

    expect(findEnvFile(nested)).toBe(envFile);
  });

  it('returns undefined when no .env exists anywhere above', () => {
    const orphan = join(tmpdir(), `hmn-no-env-${Date.now()}`);
    mkdirSync(orphan, { recursive: true });

    try {
      // Searching from a temp directory must not accidentally pick up a real file.
      expect(findEnvFile(orphan)).toBeUndefined();
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });

  it('does not throw when the starting directory does not exist', () => {
    expect(() => findEnvFile(join(workspace, 'does', 'not', 'exist'))).not.toThrow();
  });
});

/**
 * Apply process-environment overrides for the duration of a callback, then restore.
 * `undefined` removes the key, because assigning undefined to process.env would store
 * the literal string "undefined" rather than unsetting it.
 */
function withProcessEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) saved.set(key, process.env[key]);

  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('loadEnvironment', () => {
  it('fills gaps from the env file but lets the real environment win', () => {
    const envFile = join(workspace, '.env');
    writeFileSync(envFile, 'NODE_ENV=production\nLOG_LEVEL=trace\n');

    withProcessEnv(
      {
        NODE_ENV: 'test',
        LOG_LEVEL: undefined,
        DATABASE_URL: 'postgresql://hmn_migrator:pw@127.0.0.1:5432/hmn_saas',
        DATABASE_APP_URL: 'postgresql://hmn_app:pw@127.0.0.1:5432/hmn_saas',
        REDIS_URL: 'redis://127.0.0.1:6379',
      },
      () => {
        const environment = loadEnvironment({ envFile, searchForEnvFile: false });

        // A real environment variable must not be overwritten by the file...
        expect(environment.NODE_ENV).toBe('test');
        // ...while a variable missing from the environment is taken from the file.
        expect(environment.LOG_LEVEL).toBe('trace');
      },
    );
  });

  it('rejects an invalid configuration instead of starting with bad values', () => {
    expect(() =>
      loadEnvironment({
        searchForEnvFile: false,
        source: { DATABASE_URL: 'not-a-url', REDIS_URL: 'redis://127.0.0.1:6379' },
      }),
    ).toThrow(ConfigurationError);
  });

  it('names the offending variables in the failure message', () => {
    try {
      loadEnvironment({ searchForEnvFile: false, source: {} });
      expect.unreachable('loadEnvironment should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).message).toContain('DATABASE_URL');
      expect((error as ConfigurationError).code).toBe('INVALID_ENVIRONMENT');
    }
  });

  it('does not require an env file when the real environment is complete', () => {
    const environment = loadEnvironment({
      searchForEnvFile: false,
      source: {
        DATABASE_URL: 'postgresql://hmn_migrator:pw@127.0.0.1:5432/hmn_saas',
        DATABASE_APP_URL: 'postgresql://hmn_app:pw@127.0.0.1:5432/hmn_saas',
        REDIS_URL: 'redis://127.0.0.1:6379',
      },
    });

    expect(environment.API_PORT).toBe(3001);
  });

  it('validates the repository root .env that the application actually loads', () => {
    // Guards the real local configuration: if this breaks, nothing else will run.
    const environment = loadEnvironment({ startDirectory: process.cwd() });

    expect(environment.DATABASE_URL).toMatch(/^postgresql:\/\//);
    expect(environment.REDIS_URL).toMatch(/^redis:\/\//);
  });
});
