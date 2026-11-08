/**
 * hbook — phone normalization (mobile-first patient identity).
 *
 * Iranian mobile numbers are the primary identifier for Homana patients.
 * Accepted input forms (all become 09xxxxxxxxx):
 *   09123456789 · +989123456789 · 00989123456789 · 989123456789
 *   9123456789 · ۰۹۱۲۳۴۵۶۷۸۹ (Persian digits) · ٠٩١٢٣٤٥٦٧٨٩ (Arabic digits)
 *   with arbitrary spaces, dashes, dots or parentheses.
 * Other countries: explicit +/00 prefix with 8–15 digits → E.164 (+…).
 */

const EASTERN_DIGITS: Record<string, string> = {};
for (let i = 0; i <= 9; i++) {
  EASTERN_DIGITS[String.fromCodePoint(0x06f0 + i)] = String(i); // Persian ۰..۹
  EASTERN_DIGITS[String.fromCodePoint(0x0660 + i)] = String(i); // Arabic ٠..٩
}

export const IR_MOBILE_RE = /^09\d{9}$/;
export const E164_RE = /^\+\d{8,15}$/;

/** Convert Persian/Arabic-Indic digits to ASCII, trim separators. */
export function toAsciiDigits(input: string): string {
  let out = '';
  for (const ch of input) out += EASTERN_DIGITS[ch] ?? ch;
  return out;
}

/**
 * Normalize a phone number.
 * Returns the canonical form (09xxxxxxxxx for Iranian mobiles, +E.164
 * otherwise) or null when the input cannot be a phone number.
 */
export function normalizePhone(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let s = toAsciiDigits(raw).trim();
  if (!s) return null;

  const hasPlus = s.startsWith('+') || s.startsWith('00');
  // strip everything that is not a digit or leading +
  const plus = s.startsWith('+');
  if (s.startsWith('00')) s = s.slice(2);
  else if (plus) s = s.slice(1);
  s = s.replace(/[\s\-()./\\–—]/g, '');
  if (!/^\d+$/.test(s)) return null;

  // Iranian mobile forms
  if (!hasPlus || s.startsWith('98')) {
    let n = s;
    if (n.startsWith('0098')) n = n.slice(4);
    else if (n.startsWith('98') && n.length === 12) n = n.slice(2);
    if (/^9\d{9}$/.test(n)) return `0${n}`; // 9xxxxxxxxx → 09xxxxxxxxx
    if (IR_MOBILE_RE.test(n)) return n; // already 09…
    if (hasPlus && s.startsWith('98')) return `+${s}`; // +98 but not a mobile shape
  } else if (IR_MOBILE_RE.test(s)) {
    return s;
  }

  // other countries — require an explicit international prefix
  if (hasPlus && s.length >= 8 && s.length <= 15) return `+${s}`;
  return null;
}

/** Strict Iranian mobile normalization (09xxxxxxxxx) — null otherwise. */
export function normalizeIrMobile(raw: string): string | null {
  const p = normalizePhone(raw);
  return p && IR_MOBILE_RE.test(p) ? p : null;
}

/**
 * Mask a phone number for logs / non-essential displays:
 * 09123456789 → 09123***789. Never log unmasked patient data.
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  if (phone.length < 7) return '***';
  return `${phone.slice(0, 5)}***${phone.slice(-3)}`;
}
