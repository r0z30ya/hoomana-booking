import { useEffect, useState, type JSX } from 'react';
import { LoginPage, type SessionProfile } from './auth/LoginPage';
import { RegisterPage } from './auth/RegisterPage';
import { PlansPage } from './plans/PlansPage';
import { PanelShell } from './panel/PanelShell';
import { PlatformAdminPage } from './platform/PlatformAdminPage';

/**
 * Client shell.
 *
 * Phase 2 proved the browser client, the Vite dev proxy and the API are wired
 * together with a health check. Phase 4 replaces the placeholder with the real
 * entry point: the login screen. The health check stays — it is the connection
 * indicator at the bottom of the screen and the reason a broken API is visible
 * before anyone tries to sign in.
 * Phase 5 (owner approval, 2026-10-13) adds the panel shell behind the session: the
 * approved design is `infra/docs/design/proposals/shell-navigation.html`. The shell owns
 * the sidebar, the top bar and the mobile navigation; each section grows into it from here.
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

function isSessionProfile(body: unknown): body is SessionProfile {
  if (typeof body !== 'object' || body === null) return false;

  const candidate = body as Partial<SessionProfile>;
  return typeof candidate.userId === 'string' && typeof candidate.displayName === 'string';
}

/**
 * The connection indicator.
 *
 * Development builds show the technical reason (that is what makes a broken API
 * debuggable). A production build shows a plain Persian sentence and nothing at all
 * while the API is healthy — an end user is not served by "API responded with 502".
 */
function statusText(health: HealthState): string | null {
  const development = import.meta.env.MODE !== 'production';

  switch (health.kind) {
    case 'loading':
      return development ? 'در حال بررسی اتصال…' : null;
    case 'ok':
      return development ? 'اتصال به سرور برقرار است' : null;
    case 'error':
      return 'اتصال به سرور برقرار نیست';
  }
}

export function App(): JSX.Element {
  const platformHost =
    window.location.hostname === 'admin.localhost' || window.location.hostname.startsWith('admin.');
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [screen, setScreen] = useState<'login' | 'register' | 'plans'>('login');

  async function acceptAuthenticated(next: SessionProfile): Promise<void> {
    setProfile(next);
    try {
      const response = await fetch('/auth/me', { credentials: 'same-origin' });
      const body: unknown = response.ok ? await response.json() : undefined;
      if (isSessionProfile(body)) setProfile(body);
    } catch {
      // The authenticated response is still usable if profile hydration is unavailable.
    }
  }

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

  useEffect(() => {
    const controller = new AbortController();

    async function restoreSession(): Promise<void> {
      try {
        const response = await fetch('/auth/me', {
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (isSessionProfile(body)) setProfile(body);
      } catch {
        if (!controller.signal.aborted) return;
      }
    }

    void restoreSession();
    return () => controller.abort();
  }, []);

  async function signOut(): Promise<void> {
    try {
      await fetch('/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: '{}',
      });
    } catch {
      // Clearing the local session is enough: the API session expires on its own.
    }

    setProfile(null);
  }

  return (
    <>
      {platformHost ? (
        <PlatformAdminPage />
      ) : profile !== null ? (
        <PanelShell
          profile={profile}
          tenantName={profile.tenantName ?? undefined}
          onSignOut={() => {
            void signOut();
          }}
        />
      ) : screen === 'register' ? (
        <RegisterPage
          onAuthenticated={(next) => {
            void acceptAuthenticated(next);
          }}
          onBackToLogin={() => {
            setScreen('login');
          }}
        />
      ) : screen === 'plans' ? (
        <PlansPage
          onStartFree={() => {
            setScreen('register');
          }}
          onBackToLogin={() => {
            setScreen('login');
          }}
        />
      ) : (
        <LoginPage
          onAuthenticated={(next) => {
            void acceptAuthenticated(next);
          }}
          onShowPlans={() => {
            setScreen('plans');
          }}
        />
      )}

      {statusText(health) !== null && (
        <p className="status-chip" data-testid="health-status">
          {statusText(health)}
        </p>
      )}
    </>
  );
}
