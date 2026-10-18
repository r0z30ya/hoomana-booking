/**
 * Hostname classification for the multi-origin product surface (ADR-0006).
 *
 * The product is served from one root domain with three kinds of origins:
 *
 *   - `admin.<root-domain>`  -> platform admin panel (vendor) — never a tenant
 *   - `<slug>.<root-domain>` -> tenant (clinic) panel / booking page
 *   - `<root-domain>`        -> public site (landing, self-service signup)
 *
 * Everything else is `external`: today that is mostly noise, later it is a custom
 * clinic domain that must be resolved against the `domains` table. Grammar alone
 * can never prove domain ownership, so a custom host is never guessed as a tenant.
 *
 * Pure, framework-free helpers shared by API request handling, signup validation
 * and tests. The tenant is ALWAYS taken from the request's Host header (controlled
 * by the edge), never from client-supplied input.
 */

/** Subdomains that belong to the platform and can never become tenant slugs. */
export const RESERVED_SUBDOMAINS: readonly string[] = ['admin', 'www', 'api', 'panel'];

/** The reserved label that serves the platform admin panel. */
export const PLATFORM_ADMIN_LABEL = 'admin';

/** What a hostname means for routing. */
export type HostContext =
  | { readonly kind: 'platform' }
  | { readonly kind: 'tenant'; readonly slug: string }
  | { readonly kind: 'root' }
  | { readonly kind: 'external' };

/** Lower-cases, strips the port and one trailing dot; `''` for empty input. */
export function normalizeHostname(host: string | null | undefined): string {
  let value = (host ?? '').trim().toLowerCase();
  if (value.length === 0) {
    return '';
  }
  if (value.startsWith('[')) {
    // Bracketed IPv6 literal: keep `[...]`, drop any `:port` after the bracket.
    const end = value.indexOf(']');
    value = end === -1 ? value : value.slice(0, end + 1);
  } else {
    const port = value.indexOf(':');
    if (port !== -1) {
      value = value.slice(0, port);
    }
  }
  if (value.endsWith('.')) {
    value = value.slice(0, -1);
  }
  return value;
}

/** RFC-1123-style label used for tenant slugs: 1–63 chars, `a-z0-9-`, no edge dash. */
const TENANT_SLUG_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** True when the label belongs to the platform and must be refused as a slug. */
export function isReservedSubdomain(label: string): boolean {
  return RESERVED_SUBDOMAINS.includes(label.toLowerCase());
}

/** `admin.<root-domain>` — for composing platform URLs (redirects, messages, docs). */
export function platformAdminHostname(rootDomain: string): string {
  const root = normalizeHostname(rootDomain);
  return root.length === 0 ? PLATFORM_ADMIN_LABEL : `${PLATFORM_ADMIN_LABEL}.${root}`;
}

/**
 * Classifies a request host against the configured root domain.
 * `external` means "not decidable by grammar" — custom domains are resolved later,
 * via the `domains` table.
 */
export function classifyHost(host: string | null | undefined, rootDomain: string): HostContext {
  const normalized = normalizeHostname(host);
  const root = normalizeHostname(rootDomain);
  if (normalized.length === 0 || root.length === 0) {
    return { kind: 'external' };
  }
  if (normalized === root) {
    return { kind: 'root' };
  }
  const suffix = `.${root}`;
  if (!normalized.endsWith(suffix)) {
    return { kind: 'external' };
  }
  const label = normalized.slice(0, -suffix.length);
  if (label.includes('.')) {
    // Deep subdomains (`a.b.<root>`) are not part of the scheme.
    return { kind: 'external' };
  }
  if (label === PLATFORM_ADMIN_LABEL) {
    return { kind: 'platform' };
  }
  if (isReservedSubdomain(label) || !TENANT_SLUG_LABEL.test(label)) {
    return { kind: 'external' };
  }
  return { kind: 'tenant', slug: label };
}
