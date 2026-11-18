import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  it('directs new accounts to verified signup without submitting an incomplete admin form', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve({ ok: true, json: () => Promise.resolve(url.startsWith('/platform/accounts?') ? { accounts: [] } : {}) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<PlatformAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'اکانت جدید' }));
    expect(screen.getByRole('region', { name: 'راهنمای ساخت اکانت' })).toHaveTextContent('کد پیامکی');
    expect(screen.getByRole('link', { name: 'باز کردن صفحه ثبت‌نام' })).toHaveAttribute('target', '_blank');
    expect(screen.queryByRole('button', { name: 'ساخت اکانت' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url === '/platform/accounts')).toBe(false);
  });
  it('loads and saves appointment template IDs on the central SMS page', async () => {
    const fetchMock = vi.fn((url: string, options?: RequestInit) => Promise.resolve({ ok: true, json: () => Promise.resolve(
      url === '/platform/sms/central' ? { configured: true, sender: '500012345', otpConfigured: false, otpBodyId: null, canEdit: true }
        : url === '/platform/sms/templates' && options?.method !== 'POST' ? { templates: [{ event: 'BOOKING', bodyId: 123 }] }
          : url.startsWith('/platform/accounts?') ? { accounts: [] } : {},
    ) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<PlatformAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'پنل پیامکی' }));
    const input = await screen.findByLabelText('شناسه الگوی ثبت نوبت');
    await waitFor(() => expect(input).toHaveValue(123));
    expect(screen.queryByRole('heading', { name: 'اکانت‌ها و کلینیک‌ها' })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '456' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/platform/sms/templates/batch', expect.objectContaining({ method: 'POST', body: expect.stringContaining('"event":"BOOKING","bodyId":456') })));
  });
  it('saves the central panel settings without keeping the key in the form', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve({ ok: true, json: () => Promise.resolve(
      url === '/platform/sms/central' ? { configured: true, sender: '500012345', otpConfigured: true, otpBodyId: 321, canEdit: true }
        : url.startsWith('/platform/accounts?') ? { accounts: [] } : {},
    ) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<PlatformAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'پنل پیامکی' }));
    fireEvent.click(await screen.findByRole('button', { name: 'تنظیمات اتصال' }));
    const key = await screen.findByLabelText('کلید API پنل مرکزی');
    fireEvent.change(key, { target: { value: 'new-panel-reference-12345' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره تنظیمات' }));
    expect(await screen.findByText(/تنظیمات پنل مرکزی ذخیره شد/)).toBeInTheDocument();
    expect(key).toHaveValue('');
    expect(fetchMock).toHaveBeenCalledWith('/platform/sms/central', expect.objectContaining({ method: 'POST', body: expect.stringContaining('new-panel-reference-12345') }));
  });
  it('shows the central panel status and checks its balance on demand', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve({ ok: true, json: () => Promise.resolve(
      url === '/platform/sms/central' ? { configured: true, sender: '500012345', otpConfigured: true }
        : url === '/platform/sms/central/check' ? { connected: true, credit: 12345 }
          : url.startsWith('/platform/accounts?') ? { accounts: [] } : {},
    ) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<PlatformAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'پنل پیامکی' }));
    const check = await screen.findByRole('button', { name: 'بررسی اتصال و اعتبار' });
    expect(check).toBeEnabled();
    fireEvent.click(check);
    expect(await screen.findByText(/۱۲٬۳۴۵/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/platform/sms/central/check', expect.objectContaining({ method: 'POST' }));
  });
  it('loads and saves the annual price for each practice type', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url === '/platform/settings/prices'
        ? { prices: [{ practiceType: 'SOLO', durationMonths: 12, priceTomans: 25000000 }, { practiceType: 'CLINIC', durationMonths: 12, priceTomans: 35000000 }] }
        : url.startsWith('/platform/accounts?') ? { accounts: [] } : {}),
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(<PlatformAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'پکیج‌ها و اشتراک' }));
    const input = await screen.findByLabelText('قیمت مطب پرو 3 ماهه (تومان)');
    expect(input).toHaveValue(null);
    expect(screen.getByLabelText('قیمت کلینیک پرو 12 ماهه (تومان)')).toHaveValue(35000000);
    fireEvent.change(input, { target: { value: '27000000' } });
    fireEvent.change(screen.getByLabelText('قیمت مطب پرو 6 ماهه (تومان)'), { target: { value: '30000000' } });
    expect(screen.getAllByRole('button', { name: 'ذخیره قیمت‌ها' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'ذخیره قیمت‌ها' })[0]!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/platform/settings/prices/batch', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ practiceType: 'SOLO', prices: [{ durationMonths: 3, priceTomans: 27000000 }, { durationMonths: 6, priceTomans: 30000000 }, { durationMonths: 12, priceTomans: 25000000 }] }),
    })));
  });

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
    expect(screen.queryByLabelText('مدت آزمایشی ثبت‌نام‌های جدید (روز)')).not.toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole('button', { name: 'دامنه' }));
    expect(await screen.findByText(/TXT _hoomana-verification/)).toHaveTextContent('test-token');
    fireEvent.click(screen.getByRole('button', { name: 'پیامک' }));
    expect(screen.queryByText(/TXT _hoomana-verification/)).not.toBeInTheDocument();
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

  it('shows and saves trial settings only inside the authenticated panel', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url === '/platform/settings/trial'
              ? { trialDays: 21, soloTrialDays: 21, clinicTrialDays: 10 }
              : url.startsWith('/platform/accounts?')
                ? { accounts: [] }
                : {},
          ),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<PlatformAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'پکیج‌ها و اشتراک' }));
    const input = await screen.findByLabelText('مدت دوره مطب رایگان (روز)');
    await waitFor(() => expect(input).toHaveValue(21));
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'ذخیره مدت' })[0]!);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/platform/settings/trial',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ practiceType: 'SOLO', trialDays: 30 }) }),
      ),
    );
  });

  it('shows Persian account statuses and marks only current paid subscriptions', async () => {
    const pro = { ...account, currentPeriodEnd: '2099-01-01T00:00:00.000Z' };
    const expired = { ...account, id: 'tenant-2', name: 'مطب دیگر', state: 'SUSPENDED', currentPeriodEnd: '2020-01-01T00:00:00.000Z' };
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.startsWith('/platform/accounts?') ? { accounts: [pro, expired] } : {}),
    })));
    render(<PlatformAdminPage />);
    expect(await screen.findByRole('button', { name: /مطب دیگر.*تعلیق‌شده/ })).toBeInTheDocument();
    expect(screen.getAllByLabelText('اشتراک پرو فعال')).toHaveLength(1);
    expect(screen.getByText(/اشتراک منقضی/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('فیلتر پلن'), { target: { value: 'PRO' } });
    expect(screen.getByText('کلینیک نمونه')).toBeInTheDocument();
    expect(screen.queryByText('مطب دیگر')).not.toBeInTheDocument();
  });

  it('counts expired free trials separately and keeps totals when searching', async () => {
    const free = { ...account, id: 'free', name: 'مطب آزاد', planTier: 'FREE', subscriptionStatus: 'TRIALING', currentPeriodEnd: '2099-01-01T00:00:00.000Z' };
    const expired = { ...free, id: 'expired', name: 'مطب منقضی', currentPeriodEnd: '2020-01-01T00:00:00.000Z' };
    const pro = { ...account, currentPeriodEnd: '2099-01-01T00:00:00.000Z' };
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({ ok: true, json: () => Promise.resolve(url.startsWith('/platform/accounts?') ? { accounts: [free, expired, pro] } : {}) })));
    render(<PlatformAdminPage />);
    const summary = await screen.findByLabelText('خلاصه وضعیت اکانت‌ها');
    await screen.findByRole('button', { name: /مطب منقضی.*تعلیق‌شده/ });
    const cards = within(summary).getAllByRole('article');
    expect(cards.map((card) => card.querySelector('strong')?.textContent)).toEqual(['3', '1', '1', '1']);
    fireEvent.change(screen.getByPlaceholderText('جست‌وجوی کلینیک، مالک یا موبایل'), { target: { value: 'مطب آزاد' } });
    expect(screen.queryByText('مطب منقضی')).not.toBeInTheDocument();
    expect(within(summary).getAllByRole('article')[0]).toHaveTextContent('3');
  });

  it('uses the success style after an account status change', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.startsWith('/platform/accounts?') ? { accounts: [account] } : url === '/platform/accounts/tenant-1' ? { account, domains: [], sms: null, subscription: null, activity: [] } : {}),
    })));
    render(<PlatformAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: /کلینیک نمونه/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'فعال' }));
    expect(await screen.findByRole('status')).toHaveClass('platform-notice-success');
  });
});
