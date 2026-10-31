-- Suspended and blocked tenants must not receive a fresh tenant session.
CREATE OR REPLACE FUNCTION public.user_default_tenant(p_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m."tenantId"
  FROM public.tenant_memberships m
  INNER JOIN public.tenants t ON t.id = m."tenantId"
  WHERE m."userId" = p_user_id
    AND t."isSuspended" IS FALSE
    AND t."blockedAt" IS NULL
  ORDER BY m."createdAt" ASC
  LIMIT 1;
$$;
