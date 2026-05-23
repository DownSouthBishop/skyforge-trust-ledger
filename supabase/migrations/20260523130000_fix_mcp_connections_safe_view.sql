-- Fix: atlas_mcp_connections_safe view was created with security_invoker = true,
-- which causes PostgreSQL to enforce the column-level REVOKE on env_vars against
-- the authenticated role. The jsonb_object_keys(env_vars) call in the view
-- therefore fails with "permission denied for column env_vars", breaking the
-- entire MCP connections UI.
--
-- Fix: remove security_invoker (defaults to security_definer so the view owner
-- can read env_vars), and enforce row isolation explicitly via WHERE user_id = auth.uid().

CREATE OR REPLACE VIEW public.atlas_mcp_connections_safe AS
SELECT
  id,
  user_id,
  name,
  slug,
  transport,
  url,
  command,
  args,
  is_active,
  is_verified,
  last_ping_at,
  capabilities,
  notes,
  created_at,
  updated_at,
  COALESCE(ARRAY(SELECT jsonb_object_keys(env_vars)), '{}'::text[]) AS env_var_keys
FROM public.atlas_mcp_connections
WHERE user_id = auth.uid();

GRANT SELECT ON public.atlas_mcp_connections_safe TO authenticated, anon;
