-- ============================================================
-- Schema Hardening — fix missing RLS policies and missing tables
-- ============================================================

-- forge_rate_limits RLS (service-role only — users never read this directly)
ALTER TABLE public.forge_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Service role manages rate limits"
  ON public.forge_rate_limits
  USING (true)
  WITH CHECK (true);

-- Ensure forge_directives RLS policies exist (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'forge_directives' AND policyname = 'Users can delete own forge_directives'
  ) THEN
    EXECUTE 'CREATE POLICY "Users can delete own forge_directives"
      ON public.forge_directives FOR DELETE USING (auth.uid() = user_id)';
  END IF;
END $$;
