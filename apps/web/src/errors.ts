const messages: Readonly<Record<string, string>> = {
  INTERNAL_ERROR: 'خطای داخلی سرور رخ داد. لطفاً بعداً دوباره تلاش کنید.',
  AUTH_FAILED: 'شماره موبایل یا رمز عبور درست نیست.',
  UNAUTHORIZED: 'برای ادامه وارد حساب خود شوید.',
  UNAUTHENTICATED: 'برای ادامه وارد حساب خود شوید.',
  FORBIDDEN: 'دسترسی به این بخش مجاز نیست.',
  NOT_FOUND: 'مورد درخواستی پیدا نشد.',
  VALIDATION_ERROR: 'اطلاعات واردشده معتبر نیست؛ آن‌ها را بررسی کنید.',
  RATE_LIMITED: 'تلاش‌های زیادی انجام شده است؛ چند دقیقه بعد دوباره تلاش کنید.',
  MOBILE_REQUIRED: 'شماره موبایل را وارد کنید.',
  MOBILE_INVALID: 'شماره موبایل معتبر نیست.',
  MFA_FAILED: 'کد تأیید دومرحله‌ای یا بازیابی معتبر نیست.',
  MFA_UNAVAILABLE: 'احراز هویت دومرحله‌ای در حال حاضر در دسترس نیست.',
  DOMAIN_REQUIRED: 'نام دامنه را وارد کنید.',
  DOMAIN_INVALID: 'نام دامنه معتبر نیست.',
  DOMAIN_FEATURE_DISABLED: 'امکان ثبت دامنه اختصاصی هنوز فعال نشده است.',
  DOMAIN_PAID_PLAN_REQUIRED: 'برای ثبت دامنه اختصاصی به اشتراک پولی فعال نیاز است.',
  PAID_SUBSCRIPTION_REQUIRES_ACTIVATION: 'فعال‌سازی اشتراک پولی توسط مدیریت پلتفرم انجام می‌شود.',
  DOMAIN_EXISTS: 'این دامنه قبلاً ثبت شده است.',
  DOMAIN_CHANGED: 'دامنه تغییر کرده است؛ دوباره بررسی کنید.',
  DOMAIN_NOT_VERIFIED: 'رکورد تأیید دامنه پیدا نشد یا مقدار آن درست نیست.',
  DNS_UNAVAILABLE: 'بررسی DNS موقتاً در دسترس نیست؛ دوباره تلاش کنید.',
  SMS_CONNECTION_INVALID: 'اطلاعات اتصال پیامک یا خط ارسال معتبر نیست.',
  SMS_ENCRYPTION_UNAVAILABLE: 'امکان ثبت امن تنظیمات پیامک در حال حاضر وجود ندارد.',
  SMS_PLATFORM_MANAGED: 'تنظیمات اتصال پیامک توسط مدیریت هومانا انجام می‌شود.',
  PLAN_INVALID: 'پلن انتخاب‌شده معتبر نیست.',
  OWNER_REQUIRED: 'فقط مدیر کلینیک به این بخش دسترسی دارد.',
  TENANT_NOT_SELECTED: 'ابتدا کلینیک را انتخاب کنید.',
  SUBSCRIPTION_DURATION_INVALID: 'مدت اشتراک معتبر نیست.',
};

/** Never show unrecognised English server errors or implementation details to users. */
export function persianError(body: Record<string, unknown>, fallback: string): string {
  const error = body.error;
  if (typeof error !== 'object' || error === null) return fallback;
  const fields = error as { code?: unknown; message?: unknown };
  const translated = typeof fields.code === 'string' ? messages[fields.code] : undefined;
  if (translated !== undefined) return translated;
  if (typeof fields.message === 'string' && /[\u0600-\u06ff]/.test(fields.message))
    return fields.message;
  return fallback;
}
