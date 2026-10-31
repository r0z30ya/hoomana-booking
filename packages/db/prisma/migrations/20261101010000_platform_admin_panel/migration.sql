-- Phase 5 platform-admin panel: MFA/session gates and audited customer operations.
-- hmn_platform remains SELECT-only. All credential/session/factor writes and all
-- cross-tenant writes are SECURITY DEFINER functions owned by the migrator.

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "blockedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "blockedReason" VARCHAR(500);

CREATE OR REPLACE FUNCTION public.platform_auth_lookup(p_mobile varchar)
RETURNS TABLE (
  "userId" uuid,
  "displayName" varchar,
  "passwordHash" varchar,
  "platformAdminId" uuid,
  "mfaEnrolled" boolean,
  "userActive" boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u."displayName", c."passwordHash", pa.id, pa."mfaEnrolled", u."isActive"
  FROM public.users u
  INNER JOIN public.platform_admins pa ON pa."userId" = u.id
  LEFT JOIN public.credentials c ON c."userId" = u.id
  WHERE u.mobile = p_mobile;
$$;

CREATE OR REPLACE FUNCTION public.platform_auth_factors(p_user_id uuid)
RETURNS TABLE (
  id uuid,
  kind varchar,
  "secretCiphertext" bytea,
  "secretIv" bytea,
  "secretAuthTag" bytea,
  "keyVersion" integer,
  "codeHash" varchar,
  "usedAt" timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT f.id, f.kind, f."secretCiphertext", f."secretIv", f."secretAuthTag",
         f."keyVersion", f."codeHash", f."usedAt"
  FROM public.platform_mfa_factors f
  INNER JOIN public.platform_admins pa ON pa.id = f."platformAdminId"
  WHERE pa."userId" = p_user_id;
$$;

CREATE OR REPLACE FUNCTION public.platform_auth_enroll_mfa(
  p_user_id uuid, p_factor_id uuid, p_ciphertext bytea, p_iv bytea,
  p_auth_tag bytea, p_key_version integer, p_recovery_hashes text[]
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  admin_id uuid;
  recovery_hash text;
BEGIN
  SELECT pa.id INTO admin_id
  FROM public.platform_admins pa
  INNER JOIN public.users u ON u.id = pa."userId"
  WHERE pa."userId" = p_user_id AND u."isActive" IS TRUE;
  IF admin_id IS NULL THEN
    RAISE EXCEPTION 'platform_auth_enroll_mfa: platform admin not found' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.platform_admins WHERE id = admin_id AND "mfaEnrolled" IS TRUE) THEN
    RAISE EXCEPTION 'platform_auth_enroll_mfa: MFA already enrolled' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.platform_mfa_factors
    (id, "platformAdminId", kind, "secretCiphertext", "secretIv", "secretAuthTag", "keyVersion")
  VALUES (p_factor_id, admin_id, 'TOTP', p_ciphertext, p_iv, p_auth_tag, p_key_version);

  FOREACH recovery_hash IN ARRAY p_recovery_hashes LOOP
    INSERT INTO public.platform_mfa_factors ("platformAdminId", kind, "codeHash")
    VALUES (admin_id, 'RECOVERY', recovery_hash);
  END LOOP;

  UPDATE public.platform_admins SET "mfaEnrolled" = TRUE, "updatedAt" = clock_timestamp()
  WHERE id = admin_id;
  INSERT INTO public.audit_logs ("actorUserId", action, "targetType", "targetId", details)
  VALUES (p_user_id, 'platform.auth.mfa_enroll', 'platform_admin', p_user_id::text,
          jsonb_build_object('recoveryCodeCount', cardinality(p_recovery_hashes)));
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_auth_consume_recovery(p_user_id uuid, p_code_hash varchar)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE changed integer;
BEGIN
  UPDATE public.platform_mfa_factors f
  SET "usedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
  FROM public.platform_admins pa
  INNER JOIN public.users u ON u.id = pa."userId"
  WHERE f."platformAdminId" = pa.id AND pa."userId" = p_user_id
    AND u."isActive" IS TRUE AND f.kind = 'RECOVERY'
    AND f."codeHash" = p_code_hash AND f."usedAt" IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_auth_create_session(
  p_user_id uuid, p_token_hash varchar, p_expires_at timestamptz, p_idle_expires_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE session_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admins pa
    INNER JOIN public.users u ON u.id = pa."userId"
    WHERE pa."userId" = p_user_id AND u."isActive" IS TRUE AND pa."mfaEnrolled" IS TRUE
  ) THEN
    RAISE EXCEPTION 'platform_auth_create_session: MFA is not enrolled' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.sessions ("userId", "tokenHash", "expiresAt", "idleExpiresAt")
  VALUES (p_user_id, p_token_hash, p_expires_at, p_idle_expires_at)
  RETURNING id INTO session_id;
  INSERT INTO public.audit_logs ("actorUserId", action, "targetType", "targetId")
  VALUES (p_user_id, 'platform.auth.login', 'platform_session', session_id::text);
  RETURN session_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_auth_find_session(p_token_hash varchar)
RETURNS TABLE (
  id uuid, "userId" uuid, "displayName" varchar, mobile varchar,
  "expiresAt" timestamptz, "idleExpiresAt" timestamptz,
  "revokedAt" timestamptz, "lastSeenAt" timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s."userId", u."displayName", u.mobile, s."expiresAt", s."idleExpiresAt",
         s."revokedAt", s."lastSeenAt"
  FROM public.sessions s
  INNER JOIN public.users u ON u.id = s."userId"
  INNER JOIN public.platform_admins pa ON pa."userId" = u.id
  WHERE s."tokenHash" = p_token_hash AND u."isActive" IS TRUE AND pa."mfaEnrolled" IS TRUE;
$$;

CREATE OR REPLACE FUNCTION public.platform_auth_touch_session(p_session_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.sessions s SET "lastSeenAt" = clock_timestamp()
  WHERE s.id = p_session_id
    AND EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa."userId" = s."userId")
  RETURNING TRUE;
$$;

CREATE OR REPLACE FUNCTION public.platform_auth_revoke_session(p_session_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.sessions s SET "revokedAt" = COALESCE(s."revokedAt", clock_timestamp())
  WHERE s.id = p_session_id
    AND EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa."userId" = s."userId")
  RETURNING TRUE;
$$;

CREATE OR REPLACE FUNCTION public.platform_auth_failed_attempts(
  p_identifier varchar, p_ip inet, p_window_start timestamptz
)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer FROM public.auth_attempts
  WHERE identifier = p_identifier AND "ipAddress" = p_ip
    AND succeeded IS FALSE AND "attemptedAt" >= p_window_start;
$$;

CREATE OR REPLACE FUNCTION public.platform_auth_record_attempt(
  p_identifier varchar, p_ip inet, p_succeeded boolean
)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.auth_attempts (identifier, "ipAddress", succeeded)
  VALUES (p_identifier, p_ip, p_succeeded)
  RETURNING TRUE;
$$;

DROP FUNCTION IF EXISTS public.platform_list_customers();

CREATE FUNCTION public.platform_list_customers()
RETURNS TABLE (
  id uuid, name varchar, slug varchar, address varchar, city varchar,
  "isSuspended" boolean, "blockedAt" timestamptz, "blockedReason" varchar,
  "createdAt" timestamptz, "ownerUserId" uuid, "ownerName" varchar,
  "ownerMobile" varchar, "ownerActive" boolean, "planTier" text, "planName" varchar,
  "subscriptionStatus" text, "currentPeriodEnd" timestamptz,
  "domainCount" bigint, "verifiedDomainCount" bigint,
  "smsConfigured" boolean, "smsActive" boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT t.id, t.name, t.slug, t.address, t.city, t."isSuspended", t."blockedAt",
         t."blockedReason", t."createdAt", u.id, u."displayName", u.mobile, u."isActive",
         sp.tier::text, sp.name, ts.status::text, ts."currentPeriodEnd",
         COALESCE(d.domain_count, 0), COALESCE(d.verified_domain_count, 0),
         (sa.id IS NOT NULL), COALESCE(sa."isActive", false)
  FROM public.tenants t
  LEFT JOIN LATERAL (
    SELECT m."userId" FROM public.tenant_memberships m
    WHERE m."tenantId" = t.id AND m.role = 'OWNER'
    ORDER BY m."createdAt" ASC LIMIT 1
  ) owner_m ON true
  LEFT JOIN public.users u ON u.id = owner_m."userId"
  LEFT JOIN LATERAL (
    SELECT s."planId", s.status, s."currentPeriodEnd" FROM public.tenant_subscriptions s
    WHERE s."tenantId" = t.id ORDER BY s."createdAt" DESC LIMIT 1
  ) ts ON true
  LEFT JOIN public.subscription_plans sp ON sp.id = ts."planId"
  LEFT JOIN LATERAL (
    SELECT count(*) AS domain_count,
           count(*) FILTER (WHERE d."isVerified" IS TRUE) AS verified_domain_count
    FROM public.domains d WHERE d."tenantId" = t.id
  ) d ON true
  LEFT JOIN public.tenant_sms_accounts sa ON sa."tenantId" = t.id
  ORDER BY t."createdAt" DESC;
$$;

CREATE OR REPLACE FUNCTION public.platform_create_tenant(
  p_name varchar, p_slug varchar, p_owner_name varchar, p_owner_mobile varchar,
  p_plan_tier text, p_actor_user_id uuid
)
RETURNS TABLE ("tenantId" uuid, "ownerUserId" uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  new_user uuid := gen_random_uuid();
  new_tenant uuid := gen_random_uuid();
  plan_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa INNER JOIN public.users u ON u.id = pa."userId" WHERE pa."userId" = p_actor_user_id AND u."isActive" IS TRUE) THEN
    RAISE EXCEPTION 'platform_create_tenant: actor is not an active platform admin' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO plan_id FROM public.subscription_plans WHERE tier::text = p_plan_tier AND "isActive" IS TRUE;
  IF plan_id IS NULL THEN RAISE EXCEPTION 'platform_create_tenant: plan not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.users (id, mobile, "displayName") VALUES (new_user, p_owner_mobile, p_owner_name);
  INSERT INTO public.tenants (id, name, slug) VALUES (new_tenant, p_name, p_slug);
  INSERT INTO public.tenant_memberships ("tenantId", "userId", role) VALUES (new_tenant, new_user, 'OWNER');
  INSERT INTO public.tenant_subscriptions ("tenantId", "planId", status, "currentPeriodStart", "currentPeriodEnd")
  VALUES (new_tenant, plan_id, CASE WHEN p_plan_tier = 'FREE' THEN 'TRIALING'::"SubscriptionStatus" ELSE 'ACTIVE'::"SubscriptionStatus" END, clock_timestamp(), clock_timestamp() + interval '30 days');
  INSERT INTO public.audit_logs ("tenantId", "actorUserId", action, "targetType", "targetId", details)
  VALUES (new_tenant, p_actor_user_id, 'platform.tenant.create', 'tenant', new_tenant::text, jsonb_build_object('planTier', p_plan_tier));
  RETURN QUERY SELECT new_tenant, new_user;
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_update_tenant(
  p_tenant_id uuid, p_name varchar, p_slug varchar, p_owner_name varchar,
  p_owner_mobile varchar, p_actor_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE owner_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa INNER JOIN public.users u ON u.id = pa."userId" WHERE pa."userId" = p_actor_user_id AND u."isActive" IS TRUE) THEN
    RAISE EXCEPTION 'platform_update_tenant: actor is not an active platform admin' USING ERRCODE = '42501';
  END IF;
  SELECT m."userId" INTO owner_id FROM public.tenant_memberships m WHERE m."tenantId" = p_tenant_id AND m.role = 'OWNER' ORDER BY m."createdAt" ASC LIMIT 1;
  IF owner_id IS NULL THEN RAISE EXCEPTION 'platform_update_tenant: tenant not found' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.tenants SET name = p_name, slug = p_slug, "updatedAt" = clock_timestamp() WHERE id = p_tenant_id;
  UPDATE public.users SET "displayName" = p_owner_name, mobile = p_owner_mobile, "updatedAt" = clock_timestamp() WHERE id = owner_id;
  INSERT INTO public.audit_logs ("tenantId", "actorUserId", action, "targetType", "targetId")
  VALUES (p_tenant_id, p_actor_user_id, 'platform.tenant.update', 'tenant', p_tenant_id::text);
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_set_tenant_state(
  p_tenant_id uuid, p_state text, p_reason varchar, p_actor_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_state NOT IN ('ACTIVE', 'SUSPENDED', 'BLOCKED') THEN RAISE EXCEPTION 'platform_set_tenant_state: invalid state' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa INNER JOIN public.users u ON u.id = pa."userId" WHERE pa."userId" = p_actor_user_id AND u."isActive" IS TRUE) THEN RAISE EXCEPTION 'platform_set_tenant_state: actor is not an active platform admin' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id) THEN RAISE EXCEPTION 'platform_set_tenant_state: tenant not found' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.tenants
  SET "isSuspended" = (p_state <> 'ACTIVE'),
      "blockedAt" = CASE WHEN p_state = 'BLOCKED' THEN COALESCE("blockedAt", clock_timestamp()) ELSE NULL END,
      "blockedReason" = CASE WHEN p_state = 'ACTIVE' THEN NULL ELSE p_reason END,
      "updatedAt" = clock_timestamp()
  WHERE id = p_tenant_id;
  INSERT INTO public.audit_logs ("tenantId", "actorUserId", action, "targetType", "targetId", details)
  VALUES (p_tenant_id, p_actor_user_id, 'platform.tenant.state_change', 'tenant', p_tenant_id::text, jsonb_build_object('state', p_state, 'reason', p_reason));
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_set_tenant_subscription(
  p_tenant_id uuid, p_plan_tier text, p_months integer, p_actor_user_id uuid
)
RETURNS TABLE (id uuid, status text, "currentPeriodStart" timestamptz, "currentPeriodEnd" timestamptz, "planTier" text, "planName" varchar)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  plan_id uuid;
  current_id uuid;
  start_at timestamptz := clock_timestamp();
  end_at timestamptz := clock_timestamp() + make_interval(months => p_months);
  new_status "SubscriptionStatus";
BEGIN
  IF p_months < 1 OR p_months > 36 THEN RAISE EXCEPTION 'platform_set_tenant_subscription: invalid duration' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa INNER JOIN public.users u ON u.id = pa."userId" WHERE pa."userId" = p_actor_user_id AND u."isActive" IS TRUE) THEN RAISE EXCEPTION 'platform_set_tenant_subscription: actor is not an active platform admin' USING ERRCODE = '42501'; END IF;
  SELECT id INTO plan_id FROM public.subscription_plans WHERE tier::text = p_plan_tier AND "isActive" IS TRUE;
  IF plan_id IS NULL THEN RAISE EXCEPTION 'platform_set_tenant_subscription: plan not found' USING ERRCODE = 'P0002'; END IF;
  SELECT s.id INTO current_id FROM public.tenant_subscriptions s WHERE s."tenantId" = p_tenant_id ORDER BY s."createdAt" DESC LIMIT 1;
  new_status := CASE WHEN p_plan_tier = 'FREE' THEN 'TRIALING'::"SubscriptionStatus" ELSE 'ACTIVE'::"SubscriptionStatus" END;
  IF current_id IS NULL THEN
    INSERT INTO public.tenant_subscriptions ("tenantId", "planId", status, "currentPeriodStart", "currentPeriodEnd") VALUES (p_tenant_id, plan_id, new_status, start_at, end_at) RETURNING public.tenant_subscriptions.id INTO current_id;
  ELSE
    UPDATE public.tenant_subscriptions SET "planId" = plan_id, status = new_status, "currentPeriodStart" = start_at, "currentPeriodEnd" = end_at, "cancelAtPeriodEnd" = false, "updatedAt" = clock_timestamp() WHERE public.tenant_subscriptions.id = current_id;
  END IF;
  INSERT INTO public.audit_logs ("tenantId", "actorUserId", action, "targetType", "targetId", details) VALUES (p_tenant_id, p_actor_user_id, 'platform.subscription.change', 'tenant_subscription', current_id::text, jsonb_build_object('planTier', p_plan_tier, 'months', p_months));
  RETURN QUERY SELECT current_id, new_status::text, start_at, end_at, p_plan_tier, (SELECT name FROM public.subscription_plans WHERE id = plan_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_list_audit_logs(p_tenant_id uuid, p_limit integer DEFAULT 100)
RETURNS TABLE (id uuid, "actorUserId" uuid, action varchar, "targetType" varchar, "targetId" varchar, details jsonb, "createdAt" timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT a.id, a."actorUserId", a.action, a."targetType", a."targetId", a.details, a."createdAt"
  FROM public.audit_logs a WHERE a."tenantId" = p_tenant_id
  ORDER BY a."createdAt" DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
$$;

REVOKE ALL ON FUNCTION public.platform_auth_lookup(varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_auth_factors(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_auth_enroll_mfa(uuid, uuid, bytea, bytea, bytea, integer, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_auth_consume_recovery(uuid, varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_auth_create_session(uuid, varchar, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_auth_find_session(varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_auth_touch_session(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_auth_revoke_session(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_auth_failed_attempts(varchar, inet, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_auth_record_attempt(varchar, inet, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_list_customers() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_create_tenant(varchar, varchar, varchar, varchar, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_update_tenant(uuid, varchar, varchar, varchar, varchar, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_set_tenant_state(uuid, text, varchar, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_set_tenant_subscription(uuid, text, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_list_audit_logs(uuid, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.platform_auth_lookup(varchar) TO hmn_platform;
GRANT EXECUTE ON FUNCTION public.platform_auth_factors(uuid) TO hmn_platform;
GRANT EXECUTE ON FUNCTION public.platform_auth_enroll_mfa(uuid, uuid, bytea, bytea, bytea, integer, text[]) TO hmn_platform;
GRANT EXECUTE ON FUNCTION public.platform_auth_consume_recovery(uuid, varchar) TO hmn_platform;
GRANT EXECUTE ON FUNCTION public.platform_auth_create_session(uuid, varchar, timestamptz, timestamptz) TO hmn_platform;
GRANT EXECUTE ON FUNCTION public.platform_auth_find_session(varchar) TO hmn_platform;
GRANT EXECUTE ON FUNCTION public.platform_auth_touch_session(uuid) TO hmn_platform;
GRANT EXECUTE ON FUNCTION public.platform_auth_revoke_session(uuid) TO hmn_platform;
GRANT EXECUTE ON FUNCTION public.platform_auth_failed_attempts(varchar, inet, timestamptz) TO hmn_platform;
GRANT EXECUTE ON FUNCTION public.platform_auth_record_attempt(varchar, inet, boolean) TO hmn_platform;
GRANT EXECUTE ON FUNCTION public.platform_list_customers() TO hmn_platform;
GRANT EXECUTE ON FUNCTION public.platform_create_tenant(varchar, varchar, varchar, varchar, text, uuid) TO hmn_platform;
GRANT EXECUTE ON FUNCTION public.platform_update_tenant(uuid, varchar, varchar, varchar, varchar, uuid) TO hmn_platform;
GRANT EXECUTE ON FUNCTION public.platform_set_tenant_state(uuid, text, varchar, uuid) TO hmn_platform;
GRANT EXECUTE ON FUNCTION public.platform_set_tenant_subscription(uuid, text, integer, uuid) TO hmn_platform;
GRANT EXECUTE ON FUNCTION public.platform_list_audit_logs(uuid, integer) TO hmn_platform;
