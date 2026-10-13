import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlansPage } from './PlansPage';

const onStartFree = vi.fn();
const onBackToLogin = vi.fn();

beforeEach(() => {
  onStartFree.mockReset();
  onBackToLogin.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PlansPage', () => {
  it('shows the three packages with their badges and calls to action', () => {
    render(<PlansPage onStartFree={onStartFree} onBackToLogin={onBackToLogin} />);

    expect(screen.getByRole('heading', { name: 'آزمایشی' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'مطب' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'کلینیک' })).toBeInTheDocument();

    expect(screen.getByText('شروع')).toBeInTheDocument();
    expect(screen.getByText('محبوب')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'شروع دورهٔ آزمایشی' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'انتخاب پکیج مطب' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'انتخاب پکیج کلینیک' })).toBeInTheDocument();
  });

  it('explains what Hoomana is for, in the owner\u2019s words', () => {
    render(<PlansPage onStartFree={onStartFree} />);

    expect(screen.getByText(/پنل مدیریت پزشکان و کلینیک‌های درمانی/)).toBeInTheDocument();
    expect(screen.getByText(/ارسال پیامک نوبت و یادآوری برای بیمار و پزشک/)).toBeInTheDocument();
    expect(screen.getByText(/هر دو پکیج مطب و کلینیک یک‌ساله/)).toBeInTheDocument();
  });

  it('compares every feature group and states the plans have no quantity caps', () => {
    render(<PlansPage onStartFree={onStartFree} />);

    for (const title of [
      'پایه و کاربران',
      'نوبت‌دهی',
      'بیماران',
      'مالی',
      'پیامک',
      'برند، دامنه و پشتیبانی',
    ]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }

    expect(screen.getByText('محدودیت تعداد بیمار یا پیامک')).toBeInTheDocument();
    expect(screen.getByText('مدت اعتبار')).toBeInTheDocument();
    expect(screen.getByText('تعداد شعبه')).toBeInTheDocument();
    expect(screen.getByText('هدیهٔ اعتبار پیامک')).toBeInTheDocument();
    expect(screen.getAllByText('۱ ساله')).toHaveLength(2);
  });

  it('does not advertise a trial length and does not describe SMS top-up', () => {
    render(<PlansPage onStartFree={onStartFree} />);

    // The owner asked to drop the "30 days" emphasis; the length is a platform setting.
    expect(screen.queryByText(/۳۰ روز/)).not.toBeInTheDocument();
    // SMS top-up exists in the panel but must not appear in the plan descriptions.
    expect(screen.queryByText(/شارژ اعتباری/)).not.toBeInTheDocument();
  });

  it('gives both paid plans a custom domain and the SMS gift', () => {
    render(<PlansPage onStartFree={onStartFree} />);

    expect(screen.getByText('دامنهٔ اختصاصی')).toBeInTheDocument();
    expect(screen.getAllByText(/۳۰۰٬۰۰۰ تومان شارژ هدیه/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/۱۰۰ پیامک هدیه/).length).toBeGreaterThanOrEqual(1);
  });

  it('starts the trial from the trial card', () => {
    render(<PlansPage onStartFree={onStartFree} onBackToLogin={onBackToLogin} />);

    fireEvent.click(screen.getByRole('button', { name: 'شروع دورهٔ آزمایشی' }));

    expect(onStartFree).toHaveBeenCalledTimes(1);
  });

  it('is honest that paid checkout does not exist yet', async () => {
    render(<PlansPage onStartFree={onStartFree} onBackToLogin={onBackToLogin} />);

    fireEvent.click(screen.getByRole('button', { name: 'انتخاب پکیج کلینیک' }));

    expect(await screen.findByRole('status')).toHaveTextContent('به‌زودی');
    expect(onStartFree).not.toHaveBeenCalled();
  });

  it('offers a way back to the login screen', () => {
    render(<PlansPage onStartFree={onStartFree} onBackToLogin={onBackToLogin} />);

    fireEvent.click(screen.getByRole('button', { name: 'بازگشت به صفحهٔ ورود' }));

    expect(onBackToLogin).toHaveBeenCalledTimes(1);
  });
});
