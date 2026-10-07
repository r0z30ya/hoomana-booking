import { performance } from 'node:perf_hooks';
import { DependencyUnavailableError } from './errors.js';

/**
 * Health-probe primitives.
 *
 * Probes always resolve, never reject: a dependency being down is a health *state*,
 * not an exception, so callers can report it without a try/catch at every call site.
 */

export type HealthStatus = 'ok' | 'error';

export interface HealthProbeResult {
  readonly dependency: string;
  readonly status: HealthStatus;
  readonly latencyMs: number;
  /** Present only when the probe failed. */
  readonly error?: string;
}

/**
 * Reject if `operation` has not settled within `timeoutMs`.
 *
 * Every external probe is bounded, so a hung dependency cannot hang a health
 * endpoint, a startup check or a test run.
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new DependencyUnavailableError(`${label} did not respond within ${timeoutMs}ms`, {
              code: 'DEPENDENCY_TIMEOUT',
            }),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function probeDependency(
  dependency: string,
  operation: () => Promise<unknown>,
  timeoutMs = 2_000,
): Promise<HealthProbeResult> {
  const startedAt = performance.now();

  try {
    await withTimeout(operation(), timeoutMs, dependency);
    return {
      dependency,
      status: 'ok',
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      dependency,
      status: 'error',
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
