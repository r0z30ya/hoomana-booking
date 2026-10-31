-- Pool-safe fail-closed tenant context (ADR-0003 D6, amended).
--
-- The initial migration installed the D6 policy form:
--   tenant_id = current_setting('app.current_tenant_id', true)::uuid
--
-- That form has a pool-reuse flaw this migration corrects: PostgreSQL keeps a
-- session placeholder for a custom GUC once it has EVER been set, and after a
-- transaction-local set_config commits, the setting reads as the EMPTY STRING
-- (''), not NULL. On a pool-reused connection, the original form then makes
-- every context-less query fail with
--   ERROR: invalid input syntax for type uuid: ""
-- which is still fail-closed (no rows can leak), but it is an error instead of
-- the "zero rows" contract of ADR-0003 D6 and security test S5.
--
-- NULLIF treats BOTH "never set" (NULL) and "reset placeholder" ('') as
-- no-context: the comparison becomes NULL and the row is invisible. Fail-closed
-- semantics are unchanged; they are now pool-safe. A malformed (non-UUID)
-- context value still fails the ::uuid cast, which also fails closed.
--
-- Scope: policy definitions ONLY. No table, column, row, role, or grant is
-- touched; the migration is instant and safe to re-run via Prisma's history.

ALTER POLICY "tenant_isolation" ON "tenant_memberships"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER POLICY "tenant_isolation" ON "tenant_subscriptions"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER POLICY "tenant_isolation" ON "domains"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER POLICY "tenant_isolation" ON "audit_logs"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
