-- Prices are stored in tomans. A duration column leaves room for future terms.
CREATE TABLE public.practice_prices (
  "practiceType" varchar(10) NOT NULL CHECK ("practiceType" IN ('SOLO', 'CLINIC')),
  "durationMonths" integer NOT NULL CHECK ("durationMonths" BETWEEN 1 AND 36),
  "priceTomans" integer NOT NULL CHECK ("priceTomans" BETWEEN 0 AND 2000000000),
  PRIMARY KEY ("practiceType", "durationMonths")
);
INSERT INTO public.practice_prices ("practiceType", "durationMonths", "priceTomans")
VALUES ('SOLO', 12, 25000000), ('CLINIC', 12, 35000000);
GRANT SELECT ON public.practice_prices TO hmn_app, hmn_platform;

CREATE FUNCTION public.platform_set_practice_price(p_actor uuid, p_type text, p_months integer, p_price integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_type NOT IN ('SOLO', 'CLINIC') OR p_months <> 12 OR p_price < 0 OR p_price > 2000000000 THEN
    RAISE EXCEPTION 'invalid price';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa JOIN public.users u ON u.id = pa."userId" WHERE pa."userId" = p_actor AND u."isActive" IS TRUE AND pa."mfaEnrolled" IS TRUE) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.practice_prices SET "priceTomans" = p_price WHERE "practiceType" = p_type AND "durationMonths" = p_months;
  INSERT INTO public.audit_logs ("actorUserId", action, "targetType", "targetId", details)
  VALUES (p_actor, 'platform.settings.practice_price', 'practice_price', p_type, jsonb_build_object('durationMonths', p_months, 'priceTomans', p_price));
END;
$$;
REVOKE ALL ON FUNCTION public.platform_set_practice_price(uuid, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_set_practice_price(uuid, text, integer, integer) TO hmn_platform;
