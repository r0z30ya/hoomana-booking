import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

/**
 * `fetch` is stubbed with the same minimal shape the other web tests use: the
 * component only reads `ok`, `status` and `json()`.
 *
 * `fireEvent` rather than `user-event`: the extra dependency would need owner
 * approval, and these interactions are simple value changes plus clicks.
 */
interface FetchStubResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

type FetchStub = (input: string, init?: RequestInit) => Promise<FetchStubResponse>;

const fetchMock = vi.fn<FetchStub>();
const onAuthenticated = vi.fn();

function jsonResponse(body: unknown, status = 200): FetchStubResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

/** The request body the component produced, decoded for assertions. */
function bodyOf(init?: RequestInit): unknown {
  const body = init?.body;
  if (typeof body !== 'string') throw new Error('expected a JSON string body');
  return JSON.parse(body) as unknown;
}

function form(): HTMLFormElement {
  const element = screen.getByRole('button', { name: 'ورود به پنل' }).closest('form');
  if (element === null) throw new Error('the submit button is not inside a form');
  return element;
}

function fill(mobile: string, passphrase: string): void {
  fireEvent.change(screen.getByLabelText('شمارهٔ موبایل'), { target: { value: mobile } });
  fireEvent.change(screen.getByLabelText('رمز عبور'), { target: { value: passphrase } });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  onAuthenticated.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LoginPage', () => {
  it('renders both fields and the submit button', () => {
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

    fireEvent.submit(form());

    expect(await screen.findByRole('alert')).toHaveTextContent('شمارهٔ موبایل و رمز عبور');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the mobile number and the passphrase to /auth/login', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ userId: 'u-1', displayName: 'سارا', mobile: '09120000000' }),
    );
    render(<LoginPage onAuthenticated={onAuthenticated} />);

    fill('09120000000', 'a-long-enough-passphrase');
    fireEvent.submit(form());

    await waitFor(() => {
      expect(onAuthenticated).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u-1', displayName: 'سارا' }),
      );
    });

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('/auth/login');
    expect(call?.[1]?.method).toBe('POST');
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

    fill('09120000000', 'whatever-value');
    fireEvent.submit(form());

    expect(await screen.findByRole('alert')).toHaveTextContent('درست نیست');
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('explains the rate limit when the API answers 429', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'RATE_LIMITED' } }, 429));
    render(<LoginPage onAuthenticated={onAuthenticated} />);

    fill('09120000000', 'whatever-value');
    fireEvent.submit(form());

    expect(await screen.findByRole('alert')).toHaveTextContent('تلاش‌های ناموفق');
  });

  it('reports a connection failure instead of failing silently', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    render(<LoginPage onAuthenticated={onAuthenticated} />);

    fill('09120000000', 'whatever-value');
    fireEvent.submit(form());

    expect(await screen.findByRole('alert')).toHaveTextContent('ارتباط با سرور برقرار نشد');
  });

  it('toggles the visibility of the passphrase field', () => {
    render(<LoginPage onAuthenticated={onAuthenticated} />);

    const field = screen.getByLabelText('رمز عبور');
    expect(field).toHaveAttribute('type', 'password');

    const toggle = screen.getByRole('button', { name: 'نمایش رمز' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);
    expect(field).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'پنهان‌کردن رمز' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'پنهان‌کردن رمز' }));
    expect(field).toHaveAttribute('type', 'password');
  });

  it('keeps the placeholder path honest and routes the free demo to the plans screen', async () => {
    const onShowPlans = vi.fn();
    render(<LoginPage onAuthenticated={onAuthenticated} onShowPlans={onShowPlans} />);

    fireEvent.click(screen.getByRole('button', { name: 'ورود با کد پیامکی' }));
    expect(await screen.findByRole('status')).toHaveTextContent('به‌زودی');

    fireEvent.click(screen.getByRole('button', { name: 'رمزم را فراموش کردم' }));
    expect(await screen.findByRole('status')).toHaveTextContent('بازیابی رمز');

    fireEvent.click(screen.getByRole('button', { name: 'دمو رایگان' }));
    expect(onShowPlans).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'ثبت‌نام رایگان' }));
    expect(onShowPlans).toHaveBeenCalledTimes(2);
  });
});
