/**
 * Panel navigation model.
 *
 * The shell was approved by the owner on 2026-10-13 (design reference:
 * `infra/docs/design/proposals/shell-navigation.html`): a right-hand sidebar that is
 * collapsed to an icon rail by default, a top bar that always carries the primary
 * action, a bottom bar plus a drawer on mobile, and a menu whose items depend on the
 * signed-in user's role.
 *
 * The role map below mirrors the permission matrix designed in
 * Settings → Users. It is a navigation filter only: hiding a menu item is not
 * authorization, so the API must enforce the same rules on every request.
 */

export type PanelRole = 'OWNER' | 'DOCTOR' | 'RECEPTION';

export type PanelPageId =
  | 'dashboard'
  | 'appointments'
  | 'patients'
  | 'doctors'
  | 'accounting'
  | 'sms'
  | 'settings';

export interface PanelNavItem {
  readonly id: PanelPageId;
  readonly label: string;
  /** Inner markup of a 24×24 outline icon; stroke and size come from CSS. */
  readonly icon: string;
  /** Roles whose menu shows this item (owner decision, 2026-10-13). */
  readonly roles: readonly PanelRole[];
  /** One-line description used on the section page. */
  readonly summary: string;
  /** The sections the approved design puts on this page. */
  readonly planned: readonly string[];
}

export const PANEL_ROLE_LABEL: Readonly<Record<PanelRole, string>> = {
  OWNER: 'مدیر کلینیک',
  DOCTOR: 'پزشک',
  RECEPTION: 'منشی',
};

const ALL_ROLES: readonly PanelRole[] = ['OWNER', 'DOCTOR', 'RECEPTION'];

export const PANEL_NAV: readonly PanelNavItem[] = [
  {
    id: 'dashboard',
    label: 'داشبورد',
    icon: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    roles: ALL_ROLES,
    summary: 'برنامهٔ امروز، کارهای فوری و وضعیت پیامک — قلب پنل.',
    planned: ['برنامهٔ امروز (تایم‌لاین ساعتی)', 'اقدام لازم', 'پیامک امروز', 'روند هفته و آخرین بیماران'],
  },
  {
    id: 'appointments',
    label: 'نوبت‌ها',
    icon: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/>',
    roles: ALL_ROLES,
    summary: 'نماهای روز، هفته و فهرست روی تقویم شمسی، با ظرفیت آزاد و نشانهٔ پرداخت.',
    planned: ['تقویم شمسی ماهانه', 'نمای روز (تایم‌لاین ساعتی)', 'نمای هفته (ظرفیت)', 'نمای فهرست (جدول کامل)'],
  },
  {
    id: 'patients',
    label: 'بیماران',
    icon: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><path d="M16 5.5a3 3 0 0 1 0 5.6M17 20c0-2.2-.6-3.8-1.6-5"/>',
    roles: ALL_ROLES,
    summary: 'جستجو با موبایل یا نام، پروندهٔ بیمار و ایمپورت اکسل.',
    planned: ['فهرست بیماران با فیلترهای واقعی', 'پروندهٔ بیمار (سابقهٔ نوبت و پیامک)', 'ایمپورت از اکسل', 'نام‌های نزدیک به تکراری'],
  },
  {
    id: 'doctors',
    label: 'پزشکان و خدمات',
    icon: '<path d="M6 3v6a4 4 0 0 0 8 0V3"/><path d="M10 13v3a4 4 0 0 0 8 0v-2"/><circle cx="18" cy="11" r="2"/>',
    roles: ['OWNER', 'RECEPTION'],
    summary: 'ساعت کاری، ظرفیت هر نوبت، خدمات و تعرفه — پیش‌نیاز اسلات‌های نوبت.',
    planned: ['کارت هر پزشک با ساعت کاری و ظرفیت', 'جدول ساعت کاری هفتگی', 'پیش‌نمایش اسلات‌های ساخته‌شده', 'خدمات با مدت و تعرفه'],
  },
  {
    id: 'accounting',
    label: 'حسابداری',
    icon: '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18"/><path d="M16 14.5h2"/>',
    roles: ['OWNER', 'RECEPTION'],
    summary: 'درآمد از «نوبت × تعرفه»، دفتر پرداخت‌ها و نوبت‌های پرداخت‌نشده.',
    planned: ['درآمد به تفکیک خدمت و پزشک', 'دفتر پرداخت‌ها و ثبت پرداخت', 'نوبت‌های پرداخت‌نشده', 'خروجی اکسل برای حسابدار'],
  },
  {
    id: 'sms',
    label: 'پیامک',
    icon: '<path d="M4 5.5h16v10H9l-5 4z"/>',
    roles: ['OWNER', 'RECEPTION'],
    summary: 'پنل پیامکی اختصاصی کلینیک: لاگ ارسال، الگوها، تنظیمات و شارژ.',
    planned: ['لاگ ارسال با وضعیت تحویل', 'الگوها با پیش‌نمایش', 'تنظیمات ارسال خودکار', 'اعتبار و شارژ با مبلغ دلخواه'],
  },
  {
    id: 'settings',
    label: 'تنظیمات',
    icon: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v2M12 18.5v2M4.9 7.5l1.7 1M17.4 15.5l1.7 1M4.9 16.5l1.7-1M17.4 8.5l1.7-1"/>',
    roles: ['OWNER'],
    summary: 'پروفایل کلینیک، کاربران و نقش‌ها، دامنه، امنیت و اشتراک.',
    planned: ['پروفایل کلینیک و لوگو', 'کاربران و نقش‌ها + دعوت با پیامک', 'ماتریس دسترسی نقش‌ها', 'دامنهٔ اختصاصی، امنیت و اشتراک'],
  },
];

/** Menu items a role may see. */
export function navItemsForRole(role: PanelRole): readonly PanelNavItem[] {
  return PANEL_NAV.filter((item) => item.roles.includes(role));
}

/** The page a hash points at, or `null` when it names nothing (or nothing allowed). */
export function pageFromHash(hash: string, allowed: readonly PanelNavItem[]): PanelPageId | null {
  const raw = hash.replace(/^#\/?/, '').trim();
  const match = allowed.find((item) => item.id === raw);

  return match?.id ?? null;
}

/** Bottom bar on mobile: the four most used sections that the role may see. */
export function mobileBarItems(role: PanelRole): readonly PanelNavItem[] {
  return navItemsForRole(role).slice(0, 4);
}
