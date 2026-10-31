import { describe, expect, it } from 'vitest';
import { DependencyUnavailableError } from './errors.js';
import { probeDependency, withTimeout } from './health.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('probeDependency', () => {
  it('reports ok with a latency for a successful operation', async () => {
    const result = await probeDependency('database', () => Promise.resolve('row'));

    expect(result.status).toBe('ok');
    expect(result.dependency).toBe('database');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('reports error instead of throwing when the operation rejects', async () => {
    const result = await probeDependency('database', () =>
      Promise.reject(new Error('connection refused')),
    );

    expect(result.status).toBe('error');
    expect(result.error).toBe('connection refused');
  });

  it('times out rather than hanging on an unresponsive dependency', async () => {
    const result = await probeDependency(
      'redis',
      async () => {
        await delay(500);
      },
      50,
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('did not respond within 50ms');
  });

  it('does not leak a rejection when the losing promise settles after the timeout', async () => {
    const result = await probeDependency(
      'redis',
      async () => {
        await delay(60);
        throw new Error('late failure');
      },
      20,
    );

    expect(result.status).toBe('error');

    // Give the abandoned promise time to reject; an unhandled rejection would fail
    // the test run, which is exactly what this assertion guards against.
    await delay(100);
    expect(result.status).toBe('error');
  });
});

describe('withTimeout', () => {
  it('resolves with the operation value when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve('value'), 100, 'probe')).resolves.toBe('value');
  });

  it('rejects with a DependencyUnavailableError carrying a timeout code', async () => {
    const pending = withTimeout(
      delay(200).then(() => 'late'),
      20,
      'database',
    );

    await expect(pending).rejects.toBeInstanceOf(DependencyUnavailableError);
    await expect(pending).rejects.toMatchObject({ code: 'DEPENDENCY_TIMEOUT' });
  });

  it('propagates the original rejection unchanged', async () => {
    const failure = new Error('boom');

    await expect(withTimeout(Promise.reject(failure), 100, 'probe')).rejects.toBe(failure);
  });
});
