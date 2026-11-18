ALTER TABLE public.platform_settings
  ADD COLUMN "soloTrialDays" integer NOT NULL DEFAULT 14 CHECK ("soloTrialDays" BETWEEN 1 AND 365),
  ADD COLUMN "clinicTrialDays" integer NOT NULL DEFAULT 14 CHECK ("clinicTrialDays" BETWEEN 1 AND 365);
UPDATE public.platform_settings SET "soloTrialDays" = "trialDays", "clinicTrialDays" = "trialDays";

CREATE FUNCTION public.platform_set_practice_trial_days(p_actor uuid, p_type text, p_days integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_type NOT IN ('SOLO', 'CLINIC') OR p_days NOT BETWEEN 1 AND 365 THEN RAISE EXCEPTION 'invalid trial duration'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa JOIN public.users u ON u.id = pa."userId" WHERE pa."userId" = p_actor AND u."isActive" IS TRUE AND pa."mfaEnrolled" IS TRUE) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.platform_settings SET
    "soloTrialDays" = CASE WHEN p_type = 'SOLO' THEN p_days ELSE "soloTrialDays" END,
    "clinicTrialDays" = CASE WHEN p_type = 'CLINIC' THEN p_days ELSE "clinicTrialDays" END
  WHERE id = 1;
  INSERT INTO public.audit_logs ("actorUserId", action, "targetType", "targetId", details)
  VALUES (p_actor, 'platform.settings.practice_trial_days', 'platform_settings', p_type, jsonb_build_object('trialDays', p_days));
END;
$$;
REVOKE ALL ON FUNCTION public.platform_set_practice_trial_days(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_set_practice_trial_days(uuid, text, integer) TO hmn_platform;

CREATE OR REPLACE FUNCTION public.platform_set_practice_price(p_actor uuid, p_type text, p_months integer, p_price integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_type NOT IN ('SOLO', 'CLINIC') OR p_months NOT IN (3, 6, 12) OR p_price < 0 OR p_price > 2000000000 THEN RAISE EXCEPTION 'invalid price'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa JOIN public.users u ON u.id = pa."userId" WHERE pa."userId" = p_actor AND u."isActive" IS TRUE AND pa."mfaEnrolled" IS TRUE) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.practice_prices ("practiceType", "durationMonths", "priceTomans") VALUES (p_type, p_months, p_price)
  ON CONFLICT ("practiceType", "durationMonths") DO UPDATE SET "priceTomans" = EXCLUDED."priceTomans";
  INSERT INTO public.audit_logs ("actorUserId", action, "targetType", "targetId", details)
  VALUES (p_actor, 'platform.settings.practice_price', 'practice_price', p_type, jsonb_build_object('durationMonths', p_months, 'priceTomans', p_price));
END;
$$;
