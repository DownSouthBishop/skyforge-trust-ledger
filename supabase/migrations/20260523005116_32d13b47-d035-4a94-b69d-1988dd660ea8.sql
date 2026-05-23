
CREATE TABLE public.atlas_mcp_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  transport text NOT NULL CHECK (transport IN ('sse','stdio')),
  url text,
  command text,
  args text[] DEFAULT '{}'::text[],
  env_vars jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  is_verified boolean NOT NULL DEFAULT false,
  last_ping_at timestamptz,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

ALTER TABLE public.atlas_mcp_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own mcp connections" ON public.atlas_mcp_connections
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own mcp connections" ON public.atlas_mcp_connections
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own mcp connections" ON public.atlas_mcp_connections
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users delete own mcp connections" ON public.atlas_mcp_connections
  FOR DELETE USING (auth.uid() = user_id);

-- Hide env_vars column from API clients. Service role still reads it.
REVOKE SELECT (env_vars) ON public.atlas_mcp_connections FROM authenticated, anon;

CREATE TRIGGER atlas_mcp_connections_set_updated_at
  BEFORE UPDATE ON public.atlas_mcp_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Safe view: everything except env_vars, plus env_var_keys list.
CREATE OR REPLACE VIEW public.atlas_mcp_connections_safe
WITH (security_invoker = true) AS
SELECT
  id, user_id, name, slug, transport, url, command, args,
  is_active, is_verified, last_ping_at, capabilities, notes,
  created_at, updated_at,
  COALESCE(ARRAY(SELECT jsonb_object_keys(env_vars)), '{}'::text[]) AS env_var_keys
FROM public.atlas_mcp_connections;

GRANT SELECT ON public.atlas_mcp_connections_safe TO authenticated, anon;

-- Memory sync: write capability entry on insert/update/delete
CREATE OR REPLACE FUNCTION public.mcp_to_memory()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  tool_list text;
  summary text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.shared_operator_memory
      WHERE user_id = OLD.user_id AND key = 'mcp_' || OLD.slug;
    PERFORM public.upsert_shared_memory(
      OLD.user_id, 'system', 'event',
      'mcp_removed:' || OLD.slug,
      format('Removed MCP connection: %s', OLD.name),
      'mcp', 1.0, now() + interval '30 days');
    RETURN OLD;
  END IF;

  IF NEW.is_active AND NEW.is_verified THEN
    SELECT string_agg(t->>'name', ', ')
      INTO tool_list
      FROM jsonb_array_elements(NEW.capabilities) t;
    summary := format('%s connected — Atlas has access to %s via MCP%s',
      NEW.name,
      COALESCE(NULLIF(tool_list, ''), 'configured tools'),
      CASE WHEN NEW.notes IS NOT NULL THEN ' — ' || NEW.notes ELSE '' END);
    PERFORM public.upsert_shared_memory(
      NEW.user_id, 'system', 'capability',
      'mcp_' || NEW.slug, summary, 'mcp', 1.0, NULL);
  ELSE
    DELETE FROM public.shared_operator_memory
      WHERE user_id = NEW.user_id AND key = 'mcp_' || NEW.slug;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER atlas_mcp_connections_memory
  AFTER INSERT OR UPDATE OR DELETE ON public.atlas_mcp_connections
  FOR EACH ROW EXECUTE FUNCTION public.mcp_to_memory();
