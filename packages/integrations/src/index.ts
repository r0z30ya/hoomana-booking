/**
 * HMN integration adapters.
 *
 * Defined today: the provider-agnostic **SMS port** (`SmsProvider`) with the
 * Melipayamak console adapter behind it — the product sells an SMS panel per tenant
 * and a central panel with credit, and switching providers must stay a configuration
 * change, not a code change.
 *
 * The scheduling engine will be reached through a `SchedulingProvider` port with a
 * `CalAdapter` implementation in front of Cal.com / Cal.diy, so that HMN Core is never
 * coupled to Cal internals and the adapter stays replaceable. That port is NOT defined
 * yet, and deliberately so: defining it before the scheduling use cases exist would
 * freeze an interface based on guesses. It arrives in Phase 5 alongside the
 * requirements that shape it.
 *
 * Dependency rule for this package: adapters may depend on `@hmn/domain` and
 * `@hmn/shared`, and external services may depend on it. HMN's database remains the
 * source of truth; external identifiers (for example a Cal booking id) are stored as
 * references and must never be used as HMN primary keys.
 */

export * from './sms/index.js';
