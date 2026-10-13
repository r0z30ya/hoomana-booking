import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import {
  PANEL_ROLE_LABEL,
  mobileBarItems,
  navItemsForRole,
  pageFromHash,
  type PanelNavItem,
  type PanelPageId,
  type PanelRole,
} from './navigation';
import './panel.css';

/**
 * The panel shell: sidebar, top bar, page body, and the mobile bottom bar plus drawer.
 *
 * Approved design: `infra/docs/design/proposals/shell-navigation.html`.
 *
 * What this first slice does not do yet, on purpose:
 *   - the global search and «ثبت نوبت جدید» are placeholders until the appointments
 *     module exists, so the button only opens the appointments section;
 *   - the SMS credit is shown as «—» instead of an invented number: it arrives with the
 *     Melipayamak integration;
 *   - the role comes from the session profile. Until the API exposes it, the shell shows
 *     the owner menu **and says so in a notice**, so a missing role can never quietly
 *     look like a working permission system.
 */

export interface PanelProfile {
  readonly displayName: string;
  readonly mobile?: string | null;
  readonly role?: PanelRole | null;
}

export interface PanelShellProps {
  readonly profile: PanelProfile;
  /** Clinic name for the sidebar; falls back to a neutral label until `/auth/me` carries it. */
  readonly tenantName?: string | undefined;
  readonly onSignOut: () => void;
}

const THEME_KEY = 'hmn.theme';

function applyStoredTheme(): void {
  const stored = window.localStorage.getItem(THEME_KEY);
  document.documentElement.dataset.theme = stored === 'dark' ? 'dark' : 'light';
}

function NavIcon({ item }: { readonly item: PanelNavItem }): JSX.Element {
  // The icon markup is a constant from `navigation.ts`, never user input.
  return <svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: item.icon }} />;
}

function PageBody({ item }: { readonly item: PanelNavItem }): JSX.Element {
  if (item.id === 'dashboard') {
    return (
      <>
        <h1 className="pnl-page-title">داشبورد</h1>
        <p className="pnl-page-sub">ساختار تأییدشده؛ اعداد پس از اتصال ماژول‌های نوبت و پیامک پر می‌شوند.</p>

        <div className="pnl-tiles">
          <div className="pnl-tile neu">
            <p className="pnl-tile-value">—</p>
            <p className="pnl-tile-label">نوبت امروز</p>
          </div>
          <div className="pnl-tile neu">
            <p className="pnl-tile-value">—</p>
            <p className="pnl-tile-label">بیمار امروز</p>
          </div>
          <div className="pnl-tile neu">
            <p className="pnl-tile-value">—</p>
            <p className="pnl-tile-label">درآمد امروز (تومان)</p>
          </div>
          <div className="pnl-tile neu">
            <p className="pnl-tile-value">—</p>
            <p className="pnl-tile-label">اعتبار پیامک</p>
          </div>
        </div>

        <section className="pnl-card neu" style={{ marginTop: 16 }}>
          <h2>برنامهٔ امروز</h2>
          <div className="pnl-empty">
            تا وقتی ماژول نوبت‌ها ساخته نشود، اینجا خالی است. پس از آن: تایم‌لاین ساعتی، ظرفیت آزاد و
            اقدام سریع روی هر نوبت.
          </div>
        </section>

        <section className="pnl-card neu">
          <h2>اقدام لازم</h2>
          <div className="pnl-empty">
            مواردی مثل «بیمار بدون شمارهٔ پرونده»، «نوبت بدون یادآوری» و «پزشک بدون شمارهٔ پیامک» از
            داده‌های واقعی ساخته می‌شوند؛ فعلاً داده‌ای برای بررسی نیست.
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <h1 className="pnl-page-title">{item.label}</h1>
      <p className="pnl-page-sub">{item.summary}</p>

      <section className="pnl-card neu">
        <h2>آن‌چه این صفحه خواهد داشت</h2>
        <ul className="pnl-list">
          {item.planned.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section className="pnl-card neu">
        <h2>وضعیت پیاده‌سازی</h2>
        <div className="pnl-empty">
          پوسته و منو آماده است؛ این بخش در مرحلهٔ بعدی ساخته می‌شود. طراحی تأییدشده‌اش در
          <code> infra/docs/design/proposals/</code> نگه‌داری می‌شود.
        </div>
      </section>
    </>
  );
}

export function PanelShell({ profile, tenantName, onSignOut }: PanelShellProps): JSX.Element {
  // `eqeqeq` is enforced repo-wide, and the role may legitimately be absent.
  const roleKnown = profile.role !== null && profile.role !== undefined;
  const role: PanelRole = profile.role ?? 'OWNER';

  const items = useMemo(() => navItemsForRole(role), [role]);
  const barItems = useMemo(() => mobileBarItems(role), [role]);

  const [collapsed, setCollapsed] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hash, setHash] = useState<string>(() => window.location.hash);

  useEffect(() => {
    applyStoredTheme();

    const onHashChange = (): void => {
      setHash(window.location.hash);
    };

    window.addEventListener('hashchange', onHashChange);

    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  // A hash that names a section this role may not see falls back to the first allowed
  // section, so a bookmarked link can never open a page the menu hides.
  const current = pageFromHash(hash, items) ?? items[0]?.id ?? 'dashboard';
  const currentItem = items.find((item) => item.id === current) ?? items[0];

  const toggleTheme = useCallback((): void => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';

    document.documentElement.dataset.theme = next;
    window.localStorage.setItem(THEME_KEY, next);
  }, []);

  const go = useCallback((id: PanelPageId): void => {
    window.location.hash = `#/${id}`;
    // Some environments do not fire `hashchange` for a programmatic change; keeping the
    // state in step here makes navigation deterministic without double-rendering.
    setHash(`#/${id}`);
    setDrawerOpen(false);
  }, []);

  const navList = (onPick?: () => void): JSX.Element => (
    <nav className="pnl-nav" aria-label="منوی اصلی">
      {items.map((item) => (
        <a
          key={item.id}
          href={`#/${item.id}`}
          title={item.label}
          aria-current={item.id === current ? 'page' : undefined}
          onClick={(event) => {
            // The href keeps the link deep-linkable; the handler makes the switch
            // deterministic in every environment (a synthetic click fires no hashchange).
            event.preventDefault();
            go(item.id);
            onPick?.();
          }}
        >
          <NavIcon item={item} />
          <span className="pnl-nav-label">{item.label}</span>
        </a>
      ))}
    </nav>
  );

  return (
    <div className={`pnl-app${collapsed ? ' is-collapsed' : ''}`} data-role={role}>
      <aside className="pnl-sidebar" aria-label="پنل هومانا">
        <div className="pnl-brand">
          <span className="pnl-mark" aria-hidden="true">
            هـ
          </span>
          <div className="pnl-brand-text">
            <p className="pnl-brand-name">{tenantName ?? 'پنل هومانا'}</p>
            <p className="pnl-brand-sub">{PANEL_ROLE_LABEL[role]}</p>
          </div>
        </div>

        {navList()}

        <div className="pnl-spacer" />

        <div className="pnl-credit neu-in">
          <p>
            <span className="pnl-credit-full">اعتبار پیامک: </span>—
          </p>
          <small className="pnl-credit-full">پس از اتصال پنل پیامکی</small>
        </div>

        <div className="pnl-user">
          <span className="pnl-avatar" aria-hidden="true">
            {profile.displayName.trim().charAt(0) || 'ه'}
          </span>
          <div className="pnl-user-text">
            <p>{profile.displayName}</p>
            <small>{PANEL_ROLE_LABEL[role]}</small>
          </div>
          <button type="button" className="pnl-signout" onClick={onSignOut}>
            خروج
          </button>
        </div>
      </aside>

      <div className="pnl-main">
        <header className="pnl-topbar">
          <button
            type="button"
            className="pnl-toggle icon-btn neu-sm"
            aria-label="باز یا بستن منو"
            aria-expanded={!collapsed}
            onClick={() => {
              setCollapsed((value) => !value);
            }}
          >
            {collapsed ? '⟨' : '⟩'}
          </button>

          <div className="pnl-search neu-in">
            <span aria-hidden="true" style={{ color: 'var(--sub)' }}>
              ⌕
            </span>
            <input
              type="search"
              placeholder="جستجوی بیمار، نوبت یا شمارهٔ تماس…"
              aria-label="جستجوی سراسری"
              disabled
              title="پس از ساخت ماژول بیماران فعال می‌شود"
            />
          </div>

          <div className="pnl-grow" />

          <button
            type="button"
            className="pnl-cta cta"
            onClick={() => {
              go('appointments');
            }}
          >
            ＋ ثبت نوبت جدید
          </button>

          <button type="button" className="icon-btn neu-sm" aria-label="تعویض تم" onClick={toggleTheme}>
            ◐
          </button>
        </header>

        <main className="pnl-page">
          {!roleKnown && (
            <p className="pnl-notice" role="status" data-testid="role-notice">
              نقش این کاربر از سرور دریافت نشد؛ فعلاً منوی «مدیر کلینیک» نمایش داده می‌شود. محدودسازی منو
              وقتی فعال می‌شود که پاسخ ورود، نقش کاربر را برگرداند.
            </p>
          )}

          {currentItem && <PageBody item={currentItem} />}
        </main>
      </div>

      <nav className="pnl-bottomnav" aria-label="منوی موبایل">
        {barItems.map((item) => (
          <a
            key={item.id}
            href={`#/${item.id}`}
            aria-current={item.id === current ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              go(item.id);
            }}
          >
            <NavIcon item={item} />
            {item.label}
          </a>
        ))}
        <button
          type="button"
          aria-expanded={drawerOpen}
          onClick={() => {
            setDrawerOpen((value) => !value);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
          بیشتر
        </button>
      </nav>

      {drawerOpen && (
        <div className="pnl-drawer" role="dialog" aria-modal="true" aria-label="منوی کامل">
          <div className="pnl-drawer-panel neu" data-testid="panel-drawer">
            <div className="pnl-brand">
              <span className="pnl-mark" aria-hidden="true">
                هـ
              </span>
              <div className="pnl-brand-text">
                <p className="pnl-brand-name">{tenantName ?? 'پنل هومانا'}</p>
                <p className="pnl-brand-sub">{PANEL_ROLE_LABEL[role]}</p>
              </div>
            </div>

            {navList(() => {
              setDrawerOpen(false);
            })}

            <div className="pnl-spacer" />

            <button type="button" className="pnl-cta cta" onClick={() => setDrawerOpen(false)}>
              بستن منو
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
