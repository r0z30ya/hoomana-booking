import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformAdminPage } from './PlatformAdminPage';

const account = {
  id: 'tenant-1',
  name: 'کلینیک نمونه',
  slug: 'sample',
  ownerName: 'مدیر',
  ownerMobile: '09120000000',
  city: null,
  state: 'ACTIVE',
  planTier: 'PRO',
  planName: 'حرفه‌ای',
  subscriptionStatus: 'ACTIVE',
  currentPeriodEnd: null,
  domainCount: 1,
  verifiedDomainCount: 0,
  smsConfigured: false,
  smsActive: false,
};

afterEach(() => vi.unstubAllGlobals());

describe('platform account settings', () => {
  it('renders a scannable QR code and the manual key during MFA enrollment', async () => {
    const uri = 'otpauth://totp/Hoomana:test?secret=JBSWY3DPEHPK3PXP&issuer=Hoomana';
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve({
        ok: url !== '/platform/auth/me',
        json: () =>
          Promise.resolve(
            url === '/platform/auth/login'
              ? {
                  mfaEnrollmentRequired: true,
                  enrollmentToken: 'test',
                  secret: 'JBSWY3DPEHPK3PXP',
                  otpauthUri: uri,
                  recoveryCodes: [],
                }
              : {},
          ),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<PlatformAdminPage />);
    fireEvent.change(screen.getByLabelText('موبایل'), { target: { value: '09107756548' } });
    fireEvent.change(screen.getByLabelText('رمز ورود'), { target: { value: 'example' } });
    fireEvent.click(screen.getByRole('button', { name: 'ورود امن' }));
    const qr = await screen.findByRole('img', { name: 'کد QR برای اتصال برنامه احراز هویت' });
    expect(qr.tagName.toLowerCase()).toBe('svg');
    expect(qr.querySelector('path')).not.toBeNull();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([url]) => !url.includes('otpauth'))).toBe(true);
  });

  it('shows a Persian message for an internal login error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve({
          ok: false,
          json: () =>
            Promise.resolve(
              url === '/platform/auth/me'
                ? {}
                : { error: { code: 'INTERNAL_ERROR', message: 'Internal error' } },
            ),
        }),
      ),
    );
    render(<PlatformAdminPage />);
    fireEvent.change(screen.getByLabelText('موبایل'), { target: { value: '09107756548' } });
    fireEvent.change(screen.getByLabelText('رمز ورود'), { target: { value: 'example' } });
    fireEvent.click(screen.getByRole('button', { name: 'ورود امن' }));
    expect(
      await screen.findByText('خطای داخلی سرور رخ داد. لطفاً بعداً دوباره تلاش کنید.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Internal error')).not.toBeInTheDocument();
  });

  it('shows DNS instructions and sends the SMS connection only on submit', async () => {
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      const body =
        url === '/platform/auth/me'
          ? {}
          : url.startsWith('/platform/accounts?')
            ? { accounts: [account] }
            : url === '/platform/accounts/tenant-1'
              ? {
                  account,
                  domains: [
                    {
                      id: 'domain-1',
                      hostname: 'clinic.example.com',
                      isVerified: false,
                      verificationStatus: 'PENDING',
                      verificationToken: 'test-token',
                    },
                  ],
                  sms: null,
                  subscription: null,
                  activity: [],
                }
              : {};
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body), options });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<PlatformAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: /کلینیک نمونه/ }));
    expect(await screen.findByText(/TXT _hoomana-verification/)).toHaveTextContent('test-token');
    fireEvent.change(screen.getByLabelText('شناسه پنل ملی‌پیامک'), {
      target: { value: 'panel-reference-123456' },
    });
    fireEvent.change(screen.getByLabelText('خط ارسال'), { target: { value: '50001234' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره تنظیمات پیامک' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/platform/accounts/tenant-1/sms',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ panelRef: 'panel-reference-123456', sender: '50001234' }),
        }),
      ),
    );
  });
});
