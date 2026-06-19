-- ══════════════════════════════════════════════════════════════════
-- NO-CONNECTOR ENHANCEMENTS
-- 1. Fix dossier_suggestions constraint (add market_brief, prompt_refinement)
-- 2. Add applied_at to dossier_suggestions
-- 3. Add progress_score + updated_at to goals
-- 4. Add last_alerted_at to market_watchlist (dedup watchlist alerts)
-- 5. Service role policy on goals (edge functions need it)
-- 6. Cron jobs: apply_refinements, watchlist_monitor, memory_cleanup,
--              system_health, linda_pipeline, goal_scorer
-- ══════════════════════════════════════════════════════════════════

-- ── 1. dossier_suggestions: fix entry_type constraint ─────────────
ALTER TABLE public.dossier_suggestions
  DROP CONSTRAINT IF EXISTS dossier_suggestions_entry_type_check;

ALTER TABLE public.dossier_suggestions
  ADD CONSTRAINT dossier_suggestions_entry_type_check
  CHECK (entry_type IN (
    'goal', 'task', 'journal', 'trade', 'objective',
    'market_brief', 'prompt_refinement'
  ));

-- ── 2. dossier_suggestions: applied_at for prompt refinements ─────
ALTER TABLE public.dossier_suggestions
  ADD COLUMN IF NOT EXISTS applied_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_dossier_refinements_pending
  ON public.dossier_suggestions(user_id, agent_slug, status)
  WHERE entry_type = 'prompt_refinement' AND applied_at IS NULL;

-- ── 3. goals: progress_score + updated_at ─────────────────────────
ALTER TABLE public.goals
  ADD COLUMN IF NOT EXISTS progress_score numeric(5,2) DEFAULT 0;

ALTER TABLE public.goals
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_goals_user_active
  ON public.goals(user_id, status, updated_at DESC)
  WHERE status = 'active';

-- ── 4. market_watchlist: last_alerted_at for dedup ────────────────
-- Create table if it doesn't exist in this project, then add column
CREATE TABLE IF NOT EXISTS public.market_watchlist (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol         text        NOT NULL,
  asset_class    text        NOT NULL,
  display_name   text,
  notes          text,
  alert_price_high numeric(18,8),
  alert_price_low  numeric(18,8),
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.market_watchlist ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'market_watchlist' AND policyname = 'Users own their watchlist'
  ) THEN
    CREATE POLICY "Users own their watchlist" ON public.market_watchlist FOR ALL
      USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'market_watchlist' AND policyname = 'Service role full access market_watchlist'
  ) THEN
    CREATE POLICY "Service role full access market_watchlist" ON public.market_watchlist FOR ALL
      TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_market_watchlist_user_symbol
  ON public.market_watchlist(user_id, symbol) WHERE is_active = true;

ALTER TABLE public.market_watchlist
  ADD COLUMN IF NOT EXISTS last_alerted_at timestamptz;

-- ── 5. Service role policy on goals ───────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'goals' AND policyname = 'Service role full access goals'
  ) THEN
    CREATE POLICY "Service role full access goals"
      ON public.goals FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ── 6. Cron jobs ───────────────────────────────────────────────────

-- apply_refinements: every 2 hours — applies approved prompt refinements
SELECT cron.schedule(
  'apply_refinements',
  '0 */2 * * *',
  $$SELECT net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/apply_refinements',
    headers := jsonb_build_object('Authorization','Bearer ' || current_setting('app.service_role_key'),'Content-Type','application/json'),
    body   := '{}'::jsonb
  ) AS request_id$$
);

-- watchlist_monitor: every 30 minutes — Alpaca quote threshold checks
SELECT cron.schedule(
  'watchlist_monitor',
  '*/30 * * * *',
  $$SELECT net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/watchlist_monitor',
    headers := jsonb_build_object('Authorization','Bearer ' || current_setting('app.service_role_key'),'Content-Type','application/json'),
    body   := '{}'::jsonb
  ) AS request_id$$
);

-- memory_cleanup: Sunday 1am — prune stale agent_cross_memory and agent_journal
SELECT cron.schedule(
  'memory_cleanup',
  '0 1 * * 0',
  $$SELECT net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/memory_cleanup',
    headers := jsonb_build_object('Authorization','Bearer ' || current_setting('app.service_role_key'),'Content-Type','application/json'),
    body   := '{}'::jsonb
  ) AS request_id$$
);

-- system_health: Sunday 4am — weekly Telegram health report
SELECT cron.schedule(
  'system_health',
  '0 4 * * 0',
  $$SELECT net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/system_health',
    headers := jsonb_build_object('Authorization','Bearer ' || current_setting('app.service_role_key'),'Content-Type','application/json'),
    body   := '{}'::jsonb
  ) AS request_id$$
);

-- linda_pipeline: daily 8am — stale lead detection + outreach drafts
SELECT cron.schedule(
  'linda_pipeline',
  '0 8 * * *',
  $$SELECT net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/linda_pipeline',
    headers := jsonb_build_object('Authorization','Bearer ' || current_setting('app.service_role_key'),'Content-Type','application/json'),
    body   := '{}'::jsonb
  ) AS request_id$$
);

-- goal_scorer: daily 6:50am — recalculates goal progress before morning brief
SELECT cron.schedule(
  'goal_scorer',
  '50 6 * * *',
  $$SELECT net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/goal_scorer',
    headers := jsonb_build_object('Authorization','Bearer ' || current_setting('app.service_role_key'),'Content-Type','application/json'),
    body   := '{}'::jsonb
  ) AS request_id$$
);
