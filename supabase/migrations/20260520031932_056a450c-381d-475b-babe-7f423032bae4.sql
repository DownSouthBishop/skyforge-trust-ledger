DO $$
DECLARE
  v_user RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='skyforge_agents'
  ) THEN
    RAISE NOTICE 'skyforge_agents table missing — skipping backfill';
    RETURN;
  END IF;

  FOR v_user IN
    SELECT u.id FROM auth.users u
    WHERE NOT EXISTS (
      SELECT 1 FROM public.skyforge_agents a WHERE a.user_id = u.id AND a.slug = 'atlas'
    )
  LOOP
    PERFORM public.seed_default_agents(v_user.id);
  END LOOP;
END $$;