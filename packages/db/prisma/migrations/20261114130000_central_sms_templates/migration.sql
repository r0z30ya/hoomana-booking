ALTER TABLE public.central_sms_settings ALTER COLUMN otp_body_id DROP NOT NULL;
CREATE OR REPLACE FUNCTION public.platform_save_central_sms(p_actor uuid, p_ciphertext bytea, p_iv bytea, p_tag bytea, p_version integer, p_sender text, p_body_id integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa JOIN public.users u ON u.id = pa."userId" WHERE pa."userId" = p_actor AND u."isActive" IS TRUE AND pa."mfaEnrolled" IS TRUE) THEN RAISE EXCEPTION 'platform administrator required' USING ERRCODE = '42501'; END IF;
  IF (p_body_id IS NOT NULL AND p_body_id <= 0) OR p_sender !~ '^[0-9]{5,20}$' THEN RAISE EXCEPTION 'invalid SMS settings'; END IF;
  INSERT INTO public.central_sms_settings (id, ciphertext, iv, auth_tag, key_version, sender, otp_body_id) VALUES (1, p_ciphertext, p_iv, p_tag, p_version, p_sender, p_body_id)
  ON CONFLICT (id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag, key_version = EXCLUDED.key_version, sender = EXCLUDED.sender, otp_body_id = EXCLUDED.otp_body_id;
  INSERT INTO public.audit_logs ("actorUserId", action, "targetType", "targetId", details) VALUES (p_actor, 'platform.settings.central_sms', 'central_sms_settings', '1', jsonb_build_object('sender', p_sender, 'otpBodyId', p_body_id));
END; $$;

CREATE TABLE public.central_sms_templates (event text PRIMARY KEY, body_id integer NOT NULL CHECK (body_id > 0));
REVOKE ALL ON public.central_sms_templates FROM PUBLIC, hmn_app, hmn_platform;
GRANT SELECT ON public.central_sms_templates TO hmn_platform;
CREATE FUNCTION public.platform_save_central_sms_template(p_actor uuid, p_event text, p_body_id integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa JOIN public.users u ON u.id = pa."userId" WHERE pa."userId" = p_actor AND u."isActive" IS TRUE AND pa."mfaEnrolled" IS TRUE) THEN RAISE EXCEPTION 'platform administrator required' USING ERRCODE = '42501'; END IF;
  IF p_event NOT IN ('BOOKING', 'RESCHEDULE', 'CANCELLATION', 'REMINDER') OR (p_body_id IS NOT NULL AND p_body_id <= 0) THEN RAISE EXCEPTION 'invalid SMS template'; END IF;
  IF p_body_id IS NULL THEN DELETE FROM public.central_sms_templates WHERE event = p_event;
  ELSE INSERT INTO public.central_sms_templates (event, body_id) VALUES (p_event, p_body_id) ON CONFLICT (event) DO UPDATE SET body_id = EXCLUDED.body_id; END IF;
  INSERT INTO public.audit_logs ("actorUserId", action, "targetType", "targetId", details) VALUES (p_actor, 'platform.settings.sms_template', 'central_sms_template', p_event, jsonb_build_object('bodyId', p_body_id));
END; $$;
REVOKE ALL ON FUNCTION public.platform_save_central_sms_template(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_save_central_sms_template(uuid, text, integer) TO hmn_platform;
