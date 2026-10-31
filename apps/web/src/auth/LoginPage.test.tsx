import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

/**
 * `fetch` is stubbed with the same minimal shape the other web tests use: the
 * component only reads `ok`, `status` and `json()`.
 */
interface FetchStubResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

type FetchStub = (input: string, init?: RequestInit) => Promise<FetchStubResponse>;

const fetchMock = vi.fn<FetchStub>();
const onAuthenticated = vi.fn();
const onShowPlans = vi.fn();

function jsonResponse(body: unknown, status = 200): FetchStubResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function bodyOf(init?: RequestInit): unknown {
  const body = init?.body;
  if (typeof body !== 'string') throw new Error('expected a JSON string body');
  return JSON.parse(body) as unknown;
}

function submit(): void {
  const button = screen
    .getAllByRole('button')
    .find((candidate) => candidate.getAttribute('type') === 'submit');
  if (button === undefined) throw new Error('no submit button');
  const form = button.closest('form');
  if (form === null) throw new Error('the submit button is not inside a form');
  fireEvent.submit(form);
}

function fillPassphrase(mobile: string, passphrase: string): void {
  fireEvent.change(screen.getByLabelText('شمارهٔ موبایل'), { target: { value: mobile } });
  fireEvent.change(screen.getByLabelText('رمز عبور'), { target: { value: passphrase } });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  onAuthenticated.mockReset();
  onShowPlans.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LoginPage', () => {
  it('renders the passphrase form with both fields and the submit button', () => {
    render(<LoginPage onAuthenticated={onAuthenticated} />);

    expect(screen.getByLabelText('شمارهٔ موبایل')).toBeInTheDocument();
    expect(screen.getByLabelText('شمارهٔ موبایل')).toHaveAttribute('placeholder', '09123456789');
    expect(screen.getByLabelText('رمز عبور')).toBeInTheDocument();
    expect(screen.getByText('ورود به پنل مدیریت هومانا')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ورود به پنل' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ورود با کد پیامکی' })).toBeInTheDocument();
  });

  it('refuses an empty form without calling the API', async () => {
    render(<LoginPage onAuthenticated={onAuthenticated} />);

    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent('شمارهٔ موبایل و رمز عبور');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the mobile number and the passphrase to /auth/login', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ userId: 'u-1', displayName: 'سارا', mobile: '09120000000' }),
    );
    render(<LoginPage onAuthenticated={onAuthenticated} />);

    fillPassphrase('09120000000', 'a-long-enough-passphrase');
    submit();

    await waitFor(() => {
      expect(onAuthenticated).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u-1', displayName: 'سارا' }),
      );
    });

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('/auth/login');
    expect(bodyOf(call?.[1])).toEqual({
      mobile: '09120000000',
      ['password']: 'a-long-enough-passphrase',
    });
  });

  it('shows one generic message for rejected credentials', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'AUTH_FAILED', message: 'Invalid credentials' } }, 401),
    );
    render(<LoginPage onAuthenticated={onAuthenticated} />);

    fillPassphrase('09120000000', 'whatever-value');
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent('درست نیست');
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('explains the rate limit and connection failures', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'RATE_LIMITED' } }, 429));
    render(<LoginPage onAuthenticated={onAuthenticated} />);

    fillPassphrase('09120000000', 'whatever-value');
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('تلاش‌های ناموفق');

    fetchMock.mockRejectedValue(new Error('network down'));
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('ارتباط با سرور برقرار نشد');
  });

  it('toggles the visibility of the passphrase field', () => {
    render(<LoginPage onAuthenticated={onAuthenticated} />);

    const field = screen.getByLabelText('رمز عبور');
    expect(field).toHaveAttribute('type', 'password');

    fireEvent.click(screen.getByRole('button', { name: 'نمایش رمز' }));
    expect(field).toHaveAttribute('type', 'text');

    fireEvent.click(screen.getByRole('button', { name: 'پنهان‌کردن رمز' }));
    expect(field).toHaveAttribute('type', 'password');
  });

  it('signs in with an SMS code: request, then verify', async () => {
    render(<LoginPage onAuthenticated={onAuthenticated} />);

    fireEvent.click(screen.getByRole('button', { name: 'ورود با کد پیامکی' }));
    expect(screen.getByRole('button', { name: 'ارسال کد ورود' })).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(jsonResponse({ sent: true, devCode: '12345' }));
    fireEvent.change(screen.getByLabelText('شمارهٔ موبایل'), { target: { value: '09123456789' } });
    submit();

    await waitFor(() => {
      expect(screen.getByLabelText('کد تأیید پیامک‌شده')).toBeInTheDocument();
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ userId: 'u-7', displayName: 'دکتر نیما' }, 200),
    );
    fireEvent.change(screen.getByLabelText('کد تأیید پیامک‌شده'), { target: { value: '12345' } });
    fireEvent.click(screen.getByRole('button', { name: 'ورود با کد' }));

    await waitFor(() => {
      expect(onAuthenticated).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u-7', displayName: 'دکتر نیما' }),
      );
    });

    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      mobile: '09123456789',
      purpose: 'LOGIN',
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/auth/login');
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({
      mobile: '09123456789',
      code: '12345',
    });
  });

  it('reports an invalid or expired code and can go back to the passphrase form', async () => {
    render(<LoginPage onAuthenticated={onAuthenticated} />);

    fireEvent.click(screen.getByRole('button', { name: 'ورود با کد پیامکی' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ sent: true, devCode: '12345' }));
    fireEvent.change(screen.getByLabelText('شمارهٔ موبایل'), { target: { value: '09123456789' } });
    submit();

    await waitFor(() => {
      expect(screen.getByLabelText('کد تأیید پیامک‌شده')).toBeInTheDocument();
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'AUTH_FAILED' } }, 401));
    fireEvent.change(screen.getByLabelText('کد تأیید پیامک‌شده'), { target: { value: '00000' } });
    fireEvent.click(screen.getByRole('button', { name: 'ورود با کد' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('کد نامعتبر یا منقضی');

    fireEvent.click(screen.getByRole('button', { name: 'ورود با رمز عبور' }));
    expect(screen.getByLabelText('رمز عبور')).toBeInTheDocument();
    expect(screen.queryByLabelText('کد تأیید پیامک‌شده')).not.toBeInTheDocument();
  });

  it('routes both footer links to the plans screen', () => {
    render(<LoginPage onAuthenticated={onAuthenticated} onShowPlans={onShowPlans} />);

    fireEvent.click(screen.getByRole('button', { name: 'دمو رایگان' }));
    fireEvent.click(screen.getByRole('button', { name: 'ثبت‌نام رایگان' }));

    expect(onShowPlans).toHaveBeenCalledTimes(2);
  });
});
