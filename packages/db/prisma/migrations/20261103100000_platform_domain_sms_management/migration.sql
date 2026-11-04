-- Platform mutations remain behind audited SECURITY DEFINER functions; no table
-- write privileges are granted to the platform runtime role.
CREATE FUNCTION public.platform_save_domain(
  p_tenant_id uuid, p_domain_id uuid, p_hostname varchar, p_token varchar,
  p_is_update boolean, p_actor uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa JOIN public.users u ON u.id = pa."userId" WHERE pa."userId" = p_actor AND u."isActive" IS TRUE) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id) THEN RETURN FALSE; END IF;
  PERFORM set_config('app.current_tenant_id', p_tenant_id::text, true);
  IF p_is_update THEN
    UPDATE public.domains SET hostname = p_hostname, "verificationToken" = p_token,
      "isVerified" = false, "verificationStatus" = 'PENDING', "verifiedAt" = NULL,
      "lastCheckedAt" = NULL, "updatedAt" = clock_timestamp()
    WHERE id = p_domain_id AND "tenantId" = p_tenant_id;
    IF NOT FOUND THEN RETURN FALSE; END IF;
  ELSE
    INSERT INTO public.domains (id, "tenantId", hostname, "verificationToken", "updatedAt")
    VALUES (p_domain_id, p_tenant_id, p_hostname, p_token, clock_timestamp());
  END IF;
  INSERT INTO public.audit_logs ("tenantId", "actorUserId", action, "targetType", "targetId", details)
  VALUES (p_tenant_id, p_actor, 'platform.domain.save', 'domain', p_domain_id::text,
          jsonb_build_object('hostname', p_hostname));
  RETURN TRUE;
END;
$$;

CREATE FUNCTION public.platform_check_domain(
  p_tenant_id uuid, p_domain_id uuid, p_hostname varchar, p_token varchar,
  p_verified boolean, p_actor uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa JOIN public.users u ON u.id = pa."userId" WHERE pa."userId" = p_actor AND u."isActive" IS TRUE) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.current_tenant_id', p_tenant_id::text, true);
  UPDATE public.domains SET "isVerified" = p_verified,
    "verificationStatus" = CASE WHEN p_verified THEN 'VERIFIED'::public."DomainVerificationStatus" ELSE 'FAILED'::public."DomainVerificationStatus" END,
    "verifiedAt" = CASE WHEN p_verified THEN clock_timestamp() ELSE NULL END,
    "lastCheckedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
  WHERE id = p_domain_id AND "tenantId" = p_tenant_id AND hostname = p_hostname
    AND "verificationToken" IS NOT DISTINCT FROM p_token;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  INSERT INTO public.audit_logs ("tenantId", "actorUserId", action, "targetType", "targetId", details)
  VALUES (p_tenant_id, p_actor, 'platform.domain.check', 'domain', p_domain_id::text,
          jsonb_build_object('hostname', p_hostname, 'verified', p_verified));
  RETURN TRUE;
END;
$$;

CREATE FUNCTION public.platform_save_sms(
  p_tenant_id uuid, p_account_id uuid, p_ciphertext bytea, p_iv bytea,
  p_tag bytea, p_key_version integer, p_sender varchar, p_actor uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa JOIN public.users u ON u.id = pa."userId" WHERE pa."userId" = p_actor AND u."isActive" IS TRUE) THEN
    RAISE EXCEPTION 'platform admin required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id) THEN RETURN FALSE; END IF;
  PERFORM set_config('app.current_tenant_id', p_tenant_id::text, true);
  INSERT INTO public.tenant_sms_accounts
    (id, "tenantId", provider, "panelRefCiphertext", "panelRefIv", "panelRefAuthTag", "keyVersion", sender, "isActive", "updatedAt")
  VALUES (p_account_id, p_tenant_id, 'melipayamak', p_ciphertext, p_iv, p_tag, p_key_version, p_sender, true, clock_timestamp())
  ON CONFLICT ("tenantId") DO UPDATE SET id = EXCLUDED.id, provider = EXCLUDED.provider,
    "panelRefCiphertext" = EXCLUDED."panelRefCiphertext", "panelRefIv" = EXCLUDED."panelRefIv",
    "panelRefAuthTag" = EXCLUDED."panelRefAuthTag", "keyVersion" = EXCLUDED."keyVersion",
    sender = EXCLUDED.sender, "isActive" = true, "lastError" = NULL, "lastVerifiedAt" = NULL,
    "updatedAt" = clock_timestamp();
  INSERT INTO public.audit_logs ("tenantId", "actorUserId", action, "targetType", "targetId", details)
  VALUES (p_tenant_id, p_actor, 'platform.sms.configure', 'tenant_sms_account', p_account_id::text,
          jsonb_build_object('provider', 'melipayamak', 'sender', p_sender));
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_save_domain(uuid, uuid, varchar, varchar, boolean, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_check_domain(uuid, uuid, varchar, varchar, boolean, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_save_sms(uuid, uuid, bytea, bytea, bytea, integer, varchar, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_save_domain(uuid, uuid, varchar, varchar, boolean, uuid) TO hmn_platform;
GRANT EXECUTE ON FUNCTION public.platform_check_domain(uuid, uuid, varchar, varchar, boolean, uuid) TO hmn_platform;
GRANT EXECUTE ON FUNCTION public.platform_save_sms(uuid, uuid, bytea, bytea, bytea, integer, varchar, uuid) TO hmn_platform;
