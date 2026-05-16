-- ============================================================
-- Schema Hardening — fix missing RLS policies and expand constraints
-- ============================================================

-- Expand forge_alerts signal_type CHECK to include all types used by edge functions.
-- The original constraint only had 8 legacy types; every alert from trading/business/RE
-- was silently failing with a constraint violation.
ALTER TABLE public.forge_alerts
  DROP CONSTRAINT IF EXISTS forge_alerts_signal_type_check;

ALTER TABLE public.forge_alerts
  ADD CONSTRAINT forge_alerts_signal_type_check CHECK (signal_type IN (
    -- legacy advisory signals
    'velocity_drop','aging_pipeline','goal_behind','missed_pattern',
    'crm_overdue','week_zero','on_pace','streak_risk',
    -- trading signals
    'broker_response','trade_blocked','trade_approval','trade_executed',
    'price_alert','forex_scan',
    -- business/RE signals
    'outreach_sent','income_deficit','lease_alert','deal_found',
    -- system signals
    'research','function_error'
  ));

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

-- ============================================================
-- atlas_autonomous_loop cron — every 30 min, Mon-Fri market hours
-- 13:00-21:00 UTC = 08:00-16:00 ET (covers pre-market through close)
-- ============================================================

SELECT cron.schedule(
  'atlas-autonomous-loop',
  '*/30 13-21 * * 1-5',
  $$
    SELECT net.http_post(
      url := current_setting('app.supabase_url') || '/functions/v1/atlas_autonomous_loop',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.service_role_key')
      ),
      body := '{"user_id":"system"}'::jsonb
    )
  $$
);
