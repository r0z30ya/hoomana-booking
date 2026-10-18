# ADR-0006 — Hostname strategy and the platform admin origin

- **Status:** Proposed (recorded at the owner's request; direction approved by the owner in conversation on 2026-10-13)
- **Date:** 2026-10-13
- **Phase:** 5 — platform panel MVP (preparation)
- **Deciders:** Project owner, Lead Developer
- **Related:** ADR-0001 (local infrastructure), ADR-0003 (tenant isolation), ADR-0004 (identity and auth), `infra/docs/design/platform-panel-spec.md`

## Context

- The product is multi-tenant **by hostname**: a tenant is recognized from the request
  host, never from client input (architecture §2–§3). The documented example is
  `<clinic>.humana.app`; custom clinic domains are resolved via the `domains` table.
- The platform owner (vendor) panel manages customer accounts and must be “separate and
  safer than the tenant panel” (architecture §1). On 2026-10-13 the owner approved a
  **dedicated subdomain** for it, with the final domain to be purchased later.
- Until the domain is purchased, everything must run locally with the same shape, and
  **no domain may be hard-coded** anywhere.
- Local development is loopback-only (ADR-0001); this ADR adds the origin scheme on top
  of that baseline.

## Decisions

### D1 — Origin scheme

- `<root-domain>` → public site (landing, self-service signup).
- `<slug>.<root-domain>` → the tenant (clinic) panel and booking page.
- `admin.<root-domain>` → the platform admin panel (vendor).
- Custom clinic domains remain possible later; ownership is proven by the `domains`
  table, never by grammar, so an unknown host is never guessed as a tenant.

### D2 — One configuration switch

The root domain lives in a single environment variable `APP_ROOT_DOMAIN` (default
`localhost` in development). Buying the real domain is a configuration change, not a
code change.

### D3 — Local development uses the special-use `localhost` zone

- Root `localhost:3000`, tenant `clinic.localhost:3000`, platform `admin.localhost:3000`.
  Modern browsers resolve `*.localhost` to loopback; non-browser tools may need
  `127.0.0.1 admin.localhost clinic.localhost` in the hosts file.
- The Vite dev server explicitly allows `.localhost` subdomains
  (`allowedHosts: ['127.0.0.1', '.localhost']`); API and dev server stay loopback-only.
- No reverse proxy is introduced for local development at this stage.

### D4 — Reserved subdomains

`admin`, `www`, `api`, `panel` are reserved and can never become tenant slugs. The
classification lives in `@hmn/validation` (`classifyHost`, `RESERVED_SUBDOMAINS`) so
request routing and signup validation share one source of truth.

### D5 — Session and cookie scoping

Platform sessions are host-only cookies on the admin origin; tenant sessions are
host-only cookies on tenant origins. No cookie is set on the shared root domain. The
platform cookie name is fixed when the platform auth routes are built (ADR-0004’s D-C
fence already keeps platform credentials out of tenant paths).

### D6 — Deployment (deferred until the domain is purchased)

At deployment: DNS `A/AAAA` for `admin` plus a wildcard `*.<root-domain>`; TLS for both;
a reverse proxy routes `admin.<root>` to platform routes and `*.<root>` to tenant
routes. Until then this ADR is satisfied by the local behavior above.

## Consequences

- **Positive:** one switch to go live; local parity with the production shape; the admin
  area gets its own origin, its own cookies and a smaller attack surface; the routing
  rules are unit-tested.
- **Costs:** two certificates and proxy rules at deployment; the reserved-name list must
  be enforced wherever tenant slugs are accepted.
- **Follow-ups:** enforce `RESERVED_SUBDOMAINS` in tenant signup slug validation when
  Phase 5 lands; wire `classifyHost` into request handling when platform routes are
  built; revisit `www`/apex behavior at deployment.
