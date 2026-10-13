-- ADR-0005 D-C: self-service registration creates users and tenants, and the
-- runtime role hmn_app is the one that performs it. Until now hmn_app held
-- SELECT-only on every global table (ADR-0003 D5); this migration grants the
-- single INSERT it needs and nothing more.
--
-- Forward-only. Applied after 20261012000000_phase4_identity_and_auth.
--
-- What stays forbidden for hmn_app after this migration:
--   UPDATE / DELETE on any global table
--   any write on subscription_plans (plan catalogue is platform-managed)
--   anything at all on platform_admins / platform_mfa_factors
--   anything on _prisma_migrations (migrator-only, ADR-0003 D7)

GRANT INSERT ON "users", "tenants" TO hmn_app;
