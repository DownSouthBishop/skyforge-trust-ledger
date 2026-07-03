-- VeilPage.tsx subscribes to postgres_changes on agent_cross_memory for live
-- cross-agent signal updates, but the table was never added to the
-- supabase_realtime publication -- the subscription has been a silent no-op,
-- new signals only ever appeared after a manual page refresh.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'agent_cross_memory'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_cross_memory;
  END IF;
END $$;
