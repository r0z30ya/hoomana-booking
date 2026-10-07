import { useEffect, useState } from 'react';
import type { JSX } from 'react';

/**
 * Phase 2 shell.
 *
 * This exists to prove the browser client, the Vite dev proxy and the API are wired
 * together. It intentionally contains no login, tenant switching or navigation: those
 * belong to the phases that introduce authentication and tenant context.
 */

type HealthState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok' }
  | { readonly kind: 'error'; readonly message: string };

function readStatus(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('status' in body)) return undefined;

  // The `in` check above already narrows `body` to carry `status`, so no assertion is
  // needed here; the value itself is still unknown until the typeof check below.
  const { status } = body;

  return typeof status === 'string' ? status : undefined;
}

export function App(): JSX.Element {
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    async function checkHealth(): Promise<void> {
      try {
        const response = await fetch('/health', { signal: controller.signal });

        if (!response.ok) {
          setHealth({ kind: 'error', message: `API responded with ${response.status}` });
          return;
        }

        const status = readStatus(await response.json());

        setHealth(
          status === 'ok'
            ? { kind: 'ok' }
            : { kind: 'error', message: 'Unexpected health response' },
        );
      } catch (error) {
        if (controller.signal.aborted) return;

        setHealth({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    void checkHealth();

    return () => {
      controller.abort();
    };
  }, []);

  return (
    <main>
      <h1>HMN SaaS</h1>
      <p>
        Phase 2 — project foundation. Authentication, tenants, appointments, accounting and SMS are
        not implemented yet.
      </p>

      <section>
        <h2>API status</h2>
        {health.kind === 'loading' && <p data-testid="health-status">Checking…</p>}
        {health.kind === 'ok' && <p data-testid="health-status">API is ok</p>}
        {health.kind === 'error' && (
          <p data-testid="health-status">API is unavailable: {health.message}</p>
        )}
      </section>
    </main>
  );
}
