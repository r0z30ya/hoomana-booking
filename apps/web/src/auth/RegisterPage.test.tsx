import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegisterPage } from './RegisterPage';

afterEach(() => vi.unstubAllGlobals());
describe('staged signup', () => {
  it('collects owner, organisation and multiple phones and submits verified-number signup', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ devCode: '12345' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ verified: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ userId: '1', displayName: 'مالک' }) });
    vi.stubGlobal('fetch', fetchMock);
    const done = vi.fn();
    render(<RegisterPage onAuthenticated={done} initialPracticeType="CLINIC" />);
    fireEvent.change(screen.getByLabelText('شمارهٔ موبایل مدیر مجموعه'), { target: { value: '۰۹۱۲۳۴۵۶۷۸۹' } });
    fireEvent.click(screen.getByRole('button', { name: 'دریافت کد تأیید' }));
    await screen.findByLabelText('کد تأیید پیامک‌شده');
    fireEvent.change(screen.getByLabelText('کد تأیید پیامک‌شده'), { target: { value: '۱۲۳۴۵' } });
    fireEvent.change(screen.getByLabelText('نام و نام خانوادگی مالک'), { target: { value: 'مالک' } });
    fireEvent.change(screen.getByLabelText('نام مجموعه'), { target: { value: 'درمانگاه' } });
    expect(screen.getByLabelText('نوع پکیج')).toHaveValue('CLINIC');
    fireEvent.click(screen.getByRole('button', { name: 'ادامه' }));
    await screen.findByLabelText('شهر مجموعه');
    fireEvent.change(screen.getByLabelText('شهر مجموعه'), { target: { value: 'تهران' } });
    fireEvent.change(screen.getByLabelText('آدرس مجموعه'), { target: { value: 'خیابان اول' } });
    fireEvent.change(screen.getByLabelText('شماره تلفن مجموعه 1'), { target: { value: '۰۲۱۱۲۳۴۵۶۷۸' } });
    fireEvent.click(screen.getByRole('button', { name: /افزودن شماره/ }));
    fireEvent.change(screen.getByLabelText('شماره تلفن مجموعه 2'), { target: { value: '02187654321' } });
    fireEvent.click(screen.getByRole('button', { name: /ساخت حساب و شروع رایگان/ }));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    const call = fetchMock.mock.calls[2];
    expect(call).toBeDefined();
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toMatchObject({ mobile: '09123456789', code: '12345', practiceType: 'CLINIC', contactPhones: ['02112345678', '02187654321'] });
  });
  it('reports an existing account before asking for the address and offers sign-in', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ devCode: '12345' }) })
      .mockResolvedValueOnce({ ok: false, status: 409 }));
    const login = vi.fn();
    render(<RegisterPage onAuthenticated={vi.fn()} onBackToLogin={login} />);
    fireEvent.change(screen.getByLabelText('شمارهٔ موبایل مدیر مجموعه'), { target: { value: '09123456789' } });
    fireEvent.click(screen.getByRole('button', { name: 'دریافت کد تأیید' }));
    await screen.findByLabelText('کد تأیید پیامک‌شده');
    fireEvent.change(screen.getByLabelText('کد تأیید پیامک‌شده'), { target: { value: '12345' } });
    fireEvent.change(screen.getByLabelText('نام و نام خانوادگی مالک'), { target: { value: 'مالک' } });
    fireEvent.change(screen.getByLabelText('نام مجموعه'), { target: { value: 'مطب' } });
    fireEvent.click(screen.getByRole('button', { name: 'ادامه' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('از قبل حساب دارد');
    expect(screen.queryByLabelText('آدرس مجموعه')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ورود به حساب' }));
    expect(login).toHaveBeenCalledOnce();
  });
  it('does not advance with a rejected verification code', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 401 }));
    render(<RegisterPage onAuthenticated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('شمارهٔ موبایل مدیر مجموعه'), { target: { value: '09123456789' } });
    fireEvent.click(screen.getByRole('button', { name: 'دریافت کد تأیید' }));
    await screen.findByLabelText('کد تأیید پیامک‌شده');
    fireEvent.change(screen.getByLabelText('کد تأیید پیامک‌شده'), { target: { value: '12345' } });
    fireEvent.change(screen.getByLabelText('نام و نام خانوادگی مالک'), { target: { value: 'مالک' } });
    fireEvent.change(screen.getByLabelText('نام مجموعه'), { target: { value: 'مطب' } });
    fireEvent.click(screen.getByRole('button', { name: 'ادامه' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('نامعتبر یا منقضی');
    expect(screen.queryByLabelText('آدرس مجموعه')).not.toBeInTheDocument();
  });
  it('rejects an invalid manager mobile before requesting a code', () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    render(<RegisterPage onAuthenticated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('شمارهٔ موبایل مدیر مجموعه'), { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: 'دریافت کد تأیید' }));
    expect(screen.getByRole('alert')).toHaveTextContent('۰۹');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
