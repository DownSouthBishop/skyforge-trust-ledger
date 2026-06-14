INSERT INTO public.atlas_mcp_connections (user_id, name, slug, transport, url, env_vars, is_active, category)
SELECT u.id, 'Alpaca', 'alpaca', 'sse',
  'https://efpdhwqhitfccfccnlhm.supabase.co/functions/v1/mcp-alpaca',
  '{}'::jsonb, true, 'trading'
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.atlas_mcp_connections c WHERE c.user_id = u.id AND c.slug = 'alpaca');

INSERT INTO public.atlas_mcp_connections (user_id, name, slug, transport, url, env_vars, is_active, category)
SELECT u.id, 'OANDA', 'oanda', 'sse',
  'https://efpdhwqhitfccfccnlhm.supabase.co/functions/v1/mcp-oanda',
  '{}'::jsonb, true, 'trading'
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.atlas_mcp_connections c WHERE c.user_id = u.id AND c.slug = 'oanda');