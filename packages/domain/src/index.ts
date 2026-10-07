/**
 * HMN domain kernel — intentionally empty.
 *
 * Phase 2 is scoped to project foundation only. Entities and business rules
 * (tenant, membership, appointment, accounting, SMS ledger) are introduced in the
 * phases that own them, each behind an architecture decision record.
 *
 * This module exists so that the workspace, build graph and dependency direction are
 * already in place when the first real domain concepts arrive. Adding speculative
 * types here now would make those decisions by accident rather than by review.
 *
 * Dependency rule for this package: it must not import from `@hmn/db`,
 * `@hmn/integrations`, `@hmn/shared` or any HTTP framework. Domain logic stays
 * independent of transport, storage and third-party adapters.
 */

export {};
