-- Atlas autonomous opportunity signals and execution log

CREATE TABLE IF NOT EXISTS public.atlas_opportunity_signals (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id             uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  raw_title           text,
  raw_source          text,
  source_url          text,
  extracted_logic     text NOT NULL,
  target_audience     text,
  play_type           text CHECK (play_type IN ('content','service_offer','trade','arbitrage','automation','research')),
  feasibility_score   numeric CHECK (feasibility_score BETWEEN 0 AND 1),
  time_to_prod_hours  numeric,
  liquidity_window_hrs numeric,
  marginal_cost_est   numeric DEFAULT 0,
  expected_yield_usd  numeric DEFAULT 0,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','executing','completed','rejected','failed')),
  rejection_reason    text,
  atlas_reasoning     text,
  execution_plan      text,
  play_id             uuid REFERENCES public.atlas_plays(id),
  scanned_at          timestamptz DEFAULT now(),
  evaluated_at        timestamptz,
  executed_at         timestamptz,
  created_at          timestamptz DEFAULT now()
);

ALTER TABLE public.atlas_opportunity_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "signals_own" ON public.atlas_opportunity_signals
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_signals_user_status
  ON public.atlas_opportunity_signals(user_id, status);
CREATE INDEX IF NOT EXISTS idx_signals_scanned_at
  ON public.atlas_opportunity_signals(scanned_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.atlas_opportunity_signals TO service_role;

-- Execution log — every action Atlas took autonomously

CREATE TABLE IF NOT EXISTS public.atlas_execution_log (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  signal_id     uuid REFERENCES public.atlas_opportunity_signals(id),
  play_id       uuid REFERENCES public.atlas_plays(id),
  action_type   text NOT NULL,
  action_detail jsonb DEFAULT '{}'::jsonb,
  result        text,
  revenue_usd   numeric DEFAULT 0,
  created_at    timestamptz DEFAULT now()
);

ALTER TABLE public.atlas_execution_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "exec_log_own" ON public.atlas_execution_log
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT ON public.atlas_execution_log TO service_role;

-- Schedule opportunity scan every 12 hours
SELECT cron.schedule(
  'atlas-opportunity-scan',
  '0 */12 * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_opportunity_scan',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id$$
);
