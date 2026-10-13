import { useEffect, useState, type JSX } from 'react';
import { LoginPage, type SessionProfile } from './auth/LoginPage';
import { RegisterPage } from './auth/RegisterPage';
import { PlansPage } from './plans/PlansPage';

/**
 * Client shell.
 *
 * Phase 2 proved the browser client, the Vite dev proxy and the API are wired
 * together with a health check. Phase 4 replaces the placeholder with the real
 * entry point: the login screen. The health check stays — it is the connection
 * indicator at the bottom of the screen and the reason a broken API is visible
 * before anyone tries to sign in.
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
      return development ? 'Checking…' : null;
    case 'ok':
      return development ? 'API is ok' : null;
    case 'error':
      return development ? `API is unavailable: ${health.message}` : 'اتصال به سرور برقرار نیست';
  }
}

interface SessionHomeProps {
  readonly profile: SessionProfile;
  readonly onSignOut: () => void;
}

function SessionHome({ profile, onSignOut }: SessionHomeProps): JSX.Element {
  return (
    <div className="auth-shell">
      <div className="glow glow-teal" />

      <section className="auth-card neu">
        <header className="brand">
          <p className="brand-fa">هومانا</p>
        </header>

        <p className="field-label">خوش آمدید</p>
        <p className="session-name">{profile.displayName}</p>

        <button type="button" className="btn-cta cta" onClick={onSignOut}>
          خروج
        </button>

        <p className="auth-note">داشبورد، نوبت‌ها و بیماران در گام بعدی</p>
      </section>
    </div>
  );
}

export function App(): JSX.Element {
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [screen, setScreen] = useState<'login' | 'register' | 'plans'>('login');

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
      {profile !== null ? (
        <SessionHome
          profile={profile}
          onSignOut={() => {
            void signOut();
          }}
        />
      ) : screen === 'register' ? (
        <RegisterPage
          onAuthenticated={setProfile}
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
          onAuthenticated={setProfile}
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
