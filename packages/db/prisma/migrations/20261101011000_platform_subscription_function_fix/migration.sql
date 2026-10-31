-- Fix ambiguous output-column references in the platform subscription gate.
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
  SELECT sp.id INTO plan_id FROM public.subscription_plans sp WHERE sp.tier::text = p_plan_tier AND sp."isActive" IS TRUE;
  IF plan_id IS NULL THEN RAISE EXCEPTION 'platform_set_tenant_subscription: plan not found' USING ERRCODE = 'P0002'; END IF;
  SELECT s.id INTO current_id FROM public.tenant_subscriptions s WHERE s."tenantId" = p_tenant_id ORDER BY s."createdAt" DESC LIMIT 1;
  new_status := CASE WHEN p_plan_tier = 'FREE' THEN 'TRIALING'::"SubscriptionStatus" ELSE 'ACTIVE'::"SubscriptionStatus" END;
  IF current_id IS NULL THEN
    INSERT INTO public.tenant_subscriptions ("tenantId", "planId", status, "currentPeriodStart", "currentPeriodEnd") VALUES (p_tenant_id, plan_id, new_status, start_at, end_at) RETURNING tenant_subscriptions.id INTO current_id;
  ELSE
    UPDATE public.tenant_subscriptions SET "planId" = plan_id, status = new_status, "currentPeriodStart" = start_at, "currentPeriodEnd" = end_at, "cancelAtPeriodEnd" = false, "updatedAt" = clock_timestamp() WHERE tenant_subscriptions.id = current_id;
  END IF;
  INSERT INTO public.audit_logs ("tenantId", "actorUserId", action, "targetType", "targetId", details) VALUES (p_tenant_id, p_actor_user_id, 'platform.subscription.change', 'tenant_subscription', current_id::text, jsonb_build_object('planTier', p_plan_tier, 'months', p_months));
  RETURN QUERY SELECT current_id, new_status::text, start_at, end_at, p_plan_tier, sp.name FROM public.subscription_plans sp WHERE sp.id = plan_id;
END;
$$;
