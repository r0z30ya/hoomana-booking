import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RegisterPage } from './RegisterPage';

interface FetchStubResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

type FetchStub = (input: string, init?: RequestInit) => Promise<FetchStubResponse>;

const fetchMock = vi.fn<FetchStub>();
const onAuthenticated = vi.fn();
const onBackToLogin = vi.fn();

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
  fireEvent.submit(button.closest('form') ?? document.createElement('form'));
}

/** Step 1 → step 2, with the code request stubbed. */
async function reachDetailsStep(mobile = '09123456789', devCode = '12345'): Promise<void> {
  fetchMock.mockResolvedValueOnce(jsonResponse({ sent: true, devCode }));
  render(<RegisterPage onAuthenticated={onAuthenticated} onBackToLogin={onBackToLogin} />);

  fireEvent.change(screen.getByLabelText('شمارهٔ موبایل'), { target: { value: mobile } });
  submit();

  await waitFor(() => {
    expect(screen.getByLabelText('کد تأیید پیامک‌شده')).toBeInTheDocument();
  });
}

function fillDetails(values: {
  readonly code?: string;
  readonly name?: string;
  readonly clinic?: string;
  readonly address?: string;
  readonly city?: string;
}): void {
  fireEvent.change(screen.getByLabelText('کد تأیید پیامک‌شده'), {
    target: { value: values.code ?? '12345' },
  });
  fireEvent.change(screen.getByLabelText('نام و نام خانوادگی'), {
    target: { value: values.name ?? 'سارا محمدی' },
  });
  fireEvent.change(screen.getByLabelText('نام مطب یا کلینیک'), {
    target: { value: values.clinic ?? 'کلینیک سلامت پارس' },
  });
  fireEvent.change(screen.getByLabelText('آدرس مطب یا کلینیک'), {
    target: { value: values.address ?? 'تهران، خیابان ولیعصر، پلاک ۱' },
  });
  if (values.city !== undefined) {
    fireEvent.change(screen.getByLabelText('شهر (اختیاری)'), { target: { value: values.city } });
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  onAuthenticated.mockReset();
  onBackToLogin.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RegisterPage', () => {
  it('starts with the mobile step only', () => {
    render(<RegisterPage onAuthenticated={onAuthenticated} />);

    expect(screen.getByLabelText('شمارهٔ موبایل')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'دریافت کد تأیید' })).toBeInTheDocument();
    expect(screen.queryByLabelText('نام مطب یا کلینیک')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('آدرس مطب یا کلینیک')).not.toBeInTheDocument();
  });

  it('rejects a mobile that is not 09xxxxxxxxx without calling the API', async () => {
    render(<RegisterPage onAuthenticated={onAuthenticated} />);

    fireEvent.change(screen.getByLabelText('شمارهٔ موبایل'), { target: { value: '123' } });
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent('۰۹');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requests a SIGNUP code and moves on to the clinic details', async () => {
    await reachDetailsStep();

    expect(screen.getByLabelText('آدرس مطب یا کلینیک')).toBeInTheDocument();
    expect(screen.getByLabelText('شهر (اختیاری)')).toBeInTheDocument();

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('/auth/otp/send');
    expect(bodyOf(call?.[1])).toEqual({ mobile: '09123456789', purpose: 'SIGNUP' });
  });

  it('creates the account with the code and the clinic address', async () => {
    await reachDetailsStep();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ userId: 'u-1', tenantId: 't-1', displayName: 'سارا محمدی' }, 201),
    );

    fillDetails({ city: 'تهران' });
    submit();

    await waitFor(() => {
      expect(onAuthenticated).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u-1', tenantId: 't-1' }),
      );
    });

    const call = fetchMock.mock.calls[1];
    expect(call?.[0]).toBe('/auth/register');
    expect(bodyOf(call?.[1])).toEqual({
      mobile: '09123456789',
      code: '12345',
      displayName: 'سارا محمدی',
      tenantName: 'کلینیک سلامت پارس',
      address: 'تهران، خیابان ولیعصر، پلاک ۱',
      city: 'تهران',
    });
  });

  it('requires the code, the clinic name and the address before submitting', async () => {
    await reachDetailsStep();

    fillDetails({ code: '1', name: '', clinic: '', address: '' });
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('پنج‌رقمی');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fillDetails({ code: '12345', clinic: '', address: '' });
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('آدرس را کامل کنید');
  });

  it('reports an invalid or expired code', async () => {
    await reachDetailsStep();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'OTP_INVALID' } }, 401));

    fillDetails({});
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent('نامعتبر یا منقضی');
  });

  it('says so when the number is already registered', async () => {
    await reachDetailsStep();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'REGISTRATION_FAILED' } }, 409));

    fillDetails({});
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent('قبلاً ثبت شده');
  });

  it('can resend the code from the details step', async () => {
    await reachDetailsStep();

    fetchMock.mockResolvedValueOnce(jsonResponse({ sent: true, devCode: '54321' }));
    fireEvent.click(screen.getByRole('button', { name: 'ارسال دوبارهٔ کد' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/auth/otp/send');
  });

  it('offers a way back to the login screen', () => {
    render(<RegisterPage onAuthenticated={onAuthenticated} onBackToLogin={onBackToLogin} />);

    fireEvent.click(screen.getByRole('button', { name: 'ورود به پنل' }));

    expect(onBackToLogin).toHaveBeenCalledTimes(1);
  });
});
