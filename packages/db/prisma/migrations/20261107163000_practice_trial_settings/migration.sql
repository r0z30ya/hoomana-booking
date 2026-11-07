-- Preserve existing tenants as clinic accounts; new registrations specify their choice.
ALTER TABLE "tenants" ADD COLUMN "practiceType" VARCHAR(10) NOT NULL DEFAULT 'CLINIC';
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_practiceType_check" CHECK ("practiceType" IN ('SOLO', 'CLINIC'));
CREATE TABLE "platform_settings" (
  "id" INTEGER PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "trialDays" INTEGER NOT NULL DEFAULT 14 CHECK ("trialDays" BETWEEN 1 AND 365)
);
INSERT INTO "platform_settings" ("id", "trialDays") VALUES (1, 14);
GRANT SELECT ON "platform_settings" TO hmn_app, hmn_platform;

CREATE FUNCTION public.platform_set_trial_days(p_actor uuid, p_days integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_days < 1 OR p_days > 365 THEN RAISE EXCEPTION 'invalid trial duration'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa JOIN public.users u ON u.id = pa."userId" WHERE pa."userId" = p_actor AND u."isActive" IS TRUE AND pa."mfaEnrolled" IS TRUE) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.platform_settings SET "trialDays" = p_days WHERE id = 1;
  INSERT INTO public.audit_logs ("actorUserId", action, "targetType", "targetId", details)
  VALUES (p_actor, 'platform.settings.trial_days', 'platform_settings', '1', jsonb_build_object('trialDays', p_days));
END;
$$;
REVOKE ALL ON FUNCTION public.platform_set_trial_days(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_set_trial_days(uuid, integer) TO hmn_platform;
