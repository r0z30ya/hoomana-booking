-- Phase 5 MVP — platform owner panel: list paying/trial clinics and suspend them.
--
-- This is the first use of the ADR-0003 "privileged-function gate":
--   * hmn_platform stays SELECT-only on tables (S1/S9 unchanged);
--   * writes go through SECURITY DEFINER functions owned by hmn_migrator;
--   * EXECUTE is revoked from PUBLIC and granted only to hmn_platform;
--   * search_path is pinned; identifiers are schema-qualified; parameters are bound.
--
-- `tenants.isSuspended` is a global-table column (no RLS). The runtime role may
-- INSERT tenants at signup but must never UPDATE them (S9); suspension therefore
-- cannot be a plain Prisma update from hmn_app.

ALTER TABLE "tenants"
  ADD COLUMN "isSuspended" BOOLEAN NOT NULL DEFAULT false;

-- Cross-tenant customer list for the platform panel. SECURITY DEFINER is required
-- because owner memberships and subscriptions are RLS-bound and a single query
-- must see every clinic. hmn_app is deliberately denied EXECUTE.
CREATE FUNCTION public.platform_list_customers()
RETURNS TABLE (
  id uuid,
  name varchar,
  slug varchar,
  address varchar,
  city varchar,
  "isSuspended" boolean,
  "createdAt" timestamptz,
  "ownerUserId" uuid,
  "ownerName" varchar,
  "ownerMobile" varchar,
  "planTier" text,
  "planName" varchar,
  "subscriptionStatus" text,
  "currentPeriodEnd" timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    t.id,
    t.name,
    t.slug,
    t.address,
    t.city,
    t."isSuspended",
    t."createdAt",
    u.id,
    u."displayName",
    u.mobile,
    sp.tier::text,
    sp.name,
    ts.status::text,
    ts."currentPeriodEnd"
  FROM public.tenants t
  LEFT JOIN LATERAL (
    SELECT m."userId"
    FROM public.tenant_memberships m
    WHERE m."tenantId" = t.id AND m.role = 'OWNER'
    ORDER BY m."createdAt" ASC
    LIMIT 1
  ) owner_m ON true
  LEFT JOIN public.users u ON u.id = owner_m."userId"
  LEFT JOIN LATERAL (
    SELECT s."planId", s.status, s."currentPeriodEnd"
    FROM public.tenant_subscriptions s
    WHERE s."tenantId" = t.id
    ORDER BY s."createdAt" DESC
    LIMIT 1
  ) ts ON true
  LEFT JOIN public.subscription_plans sp ON sp.id = ts."planId"
  ORDER BY t."createdAt" DESC;
$$;

REVOKE ALL ON FUNCTION public.platform_list_customers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_list_customers() TO hmn_platform;

-- Audited suspend/activate. Must run inside withTenantTx so the GUC matches
-- p_tenant_id (ADR-0003 privileged-function gate). The actor must be an active
-- platform_admins row — tenant OWNER membership is never enough.
CREATE FUNCTION public.platform_set_tenant_suspended(
  p_tenant_id uuid,
  p_suspended boolean,
  p_actor_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  context_tenant uuid;
  actor_ok boolean;
  tenant_ok boolean;
BEGIN
  BEGIN
    context_tenant := NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'platform_set_tenant_suspended: tenant context mismatch'
      USING ERRCODE = '42501';
  END;

  IF context_tenant IS NULL OR context_tenant IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'platform_set_tenant_suspended: tenant context mismatch'
      USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    INNER JOIN public.platform_admins pa ON pa."userId" = u.id
    WHERE u.id = p_actor_user_id AND u."isActive" IS TRUE
  ) INTO actor_ok;

  IF NOT actor_ok THEN
    RAISE EXCEPTION 'platform_set_tenant_suspended: actor is not an active platform admin'
      USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id
  ) INTO tenant_ok;

  IF NOT tenant_ok THEN
    RAISE EXCEPTION 'platform_set_tenant_suspended: tenant not found'
      USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.tenants
  SET "isSuspended" = p_suspended,
      "updatedAt" = clock_timestamp()
  WHERE id = p_tenant_id;

  INSERT INTO public.audit_logs (
    "tenantId", "actorUserId", "action", "targetType", "targetId", "details"
  ) VALUES (
    p_tenant_id,
    p_actor_user_id,
    CASE WHEN p_suspended THEN 'platform.tenant.suspend' ELSE 'platform.tenant.activate' END,
    'tenant',
    p_tenant_id::text,
    jsonb_build_object('suspended', p_suspended)
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_set_tenant_suspended(uuid, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_set_tenant_suspended(uuid, boolean, uuid) TO hmn_platform;
