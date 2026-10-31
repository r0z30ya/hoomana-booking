import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelShell, type PanelProfile } from './PanelShell';
import type { PanelRole } from './navigation';

/**
 * The shell is the frame every other screen lives in, so these tests pin the behaviour
 * the owner approved: a role-shaped menu, a collapsed rail by default, hash navigation
 * (including a forbidden link falling back), and the sign-out path.
 */

function renderShell(profile: Partial<PanelProfile> = {}): { readonly onSignOut: ReturnType<typeof vi.fn> } {
  const onSignOut = vi.fn();

  render(
    <PanelShell
      profile={{ displayName: 'سارا رضایی', ...profile }}
      tenantName="کلینیک سلامت پارس"
      onSignOut={onSignOut}
    />,
  );

  return { onSignOut };
}

const sidebar = (): HTMLElement => screen.getByLabelText('منوی اصلی');

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '';
});

afterEach(() => {
  document.documentElement.dataset.theme = 'light';
});

describe('PanelShell navigation', () => {
  it('shows every section to the clinic owner', () => {
    renderShell({ role: 'OWNER' });

    const links = within(sidebar()).getAllByRole('link');

    expect(links).toHaveLength(7);
    expect(within(sidebar()).getByTitle('تنظیمات')).toBeDefined();
    expect(links.map((link) => link.textContent)).toContain('حسابداری');
  });

  it('hides owner-only sections from the reception desk', () => {
    renderShell({ role: 'RECEPTION' });

    const links = within(sidebar()).getAllByRole('link');

    expect(links.map((link) => link.textContent)).toContain('پزشکان و خدمات');
    expect(links.map((link) => link.textContent)).toContain('پیامک');
    expect(links.map((link) => link.textContent)).not.toContain('تنظیمات');
    expect(links).toHaveLength(6);
  });

  it('gives a doctor only the three sections that concern them', () => {
    renderShell({ role: 'DOCTOR' });

    const labels = within(sidebar())
      .getAllByRole('link')
      .map((link) => link.textContent);

    expect(labels).toEqual(['داشبورد', 'نوبت‌ها', 'بیماران']);
  });

  it('marks the section named by the hash as the current page', () => {
    window.location.hash = '#/patients';

    renderShell({ role: 'OWNER' });

    expect(screen.getByRole('heading', { name: 'بیماران' })).toBeDefined();
    expect(within(sidebar()).getByRole('link', { name: 'بیماران' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('falls back to the first allowed section when the hash names a hidden one', () => {
    window.location.hash = '#/settings';

    renderShell({ role: 'DOCTOR' });

    expect(screen.getByRole('heading', { name: 'داشبورد' })).toBeDefined();
  });

  it('switches the page when a menu item is clicked', () => {
    renderShell({ role: 'OWNER' });

    fireEvent.click(within(sidebar()).getByRole('link', { name: 'حسابداری' }));

    expect(screen.getByRole('heading', { name: 'حسابداری' })).toBeDefined();
    expect(window.location.hash).toBe('#/accounting');
  });
});

describe('PanelShell chrome', () => {
  it('starts collapsed and expands on the top-bar toggle', () => {
    renderShell({ role: 'OWNER' });

    const toggle = screen.getByRole('button', { name: 'باز یا بستن منو' });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('signs out through the session callback', () => {
    const { onSignOut } = renderShell({ role: 'OWNER' });

    fireEvent.click(screen.getByRole('button', { name: 'خروج' }));

    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('remembers the theme it switches to', () => {
    renderShell({ role: 'OWNER' });

    fireEvent.click(screen.getByRole('button', { name: 'تعویض تم' }));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('hmn.theme')).toBe('dark');
  });

  it('opens the appointments section from the primary action', () => {
    renderShell({ role: 'OWNER' });

    fireEvent.click(screen.getByRole('button', { name: '＋ ثبت نوبت جدید' }));

    expect(screen.getByRole('heading', { name: 'نوبت‌ها' })).toBeDefined();
  });

  it('says so when the session carries no role', () => {
    renderShell();

    expect(screen.getByTestId('role-notice')).toBeDefined();
  });

  it('stays quiet once the role is known', () => {
    renderShell({ role: 'OWNER' satisfies PanelRole });

    expect(screen.queryByTestId('role-notice')).toBeNull();
  });

  it('opens the mobile drawer with the full menu', () => {
    renderShell({ role: 'OWNER' });

    expect(screen.queryByTestId('panel-drawer')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'بیشتر' }));

    const drawer = screen.getByTestId('panel-drawer');

    expect(within(drawer).getAllByRole('link')).toHaveLength(7);
  });
});
