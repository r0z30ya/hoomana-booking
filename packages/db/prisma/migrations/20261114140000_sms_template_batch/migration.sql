ALTER TABLE public.central_sms_templates ALTER COLUMN body_id DROP NOT NULL;
INSERT INTO public.central_sms_templates (event, body_id)
SELECT 'OTP', otp_body_id FROM public.central_sms_settings WHERE otp_body_id IS NOT NULL
ON CONFLICT (event) DO NOTHING;

CREATE FUNCTION public.platform_save_sms_templates(p_actor uuid, p_templates jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE item jsonb; event_name text; body_id_value integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa JOIN public.users u ON u.id = pa."userId" WHERE pa."userId" = p_actor AND u."isActive" IS TRUE AND pa."mfaEnrolled" IS TRUE) THEN RAISE EXCEPTION 'platform administrator required' USING ERRCODE = '42501'; END IF;
  IF jsonb_typeof(p_templates) <> 'array' OR jsonb_array_length(p_templates) <> 6 OR (SELECT count(DISTINCT v->>'event') FROM jsonb_array_elements(p_templates) v) <> 6 THEN RAISE EXCEPTION 'invalid templates'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_templates) LOOP
    event_name := item->>'event';
    IF event_name IS NULL OR event_name NOT IN ('OTP', 'BOOKING', 'RESCHEDULE', 'CANCELLATION', 'REMINDER', 'DOCTOR_BOOKING') THEN RAISE EXCEPTION 'invalid event'; END IF;
    body_id_value := (item->>'bodyId')::integer;
    IF body_id_value IS NOT NULL AND body_id_value <= 0 THEN RAISE EXCEPTION 'invalid body id'; END IF;
    INSERT INTO public.central_sms_templates (event, body_id) VALUES (event_name, body_id_value) ON CONFLICT (event) DO UPDATE SET body_id = EXCLUDED.body_id;
  END LOOP;
  INSERT INTO public.audit_logs ("actorUserId", action, "targetType", "targetId", details) VALUES (p_actor, 'platform.settings.sms_templates', 'central_sms_templates', '1', p_templates);
END; $$;
REVOKE ALL ON FUNCTION public.platform_save_sms_templates(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_save_sms_templates(uuid, jsonb) TO hmn_platform;
