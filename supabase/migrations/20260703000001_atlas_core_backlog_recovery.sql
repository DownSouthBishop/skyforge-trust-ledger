-- Recovery migration: re-applies tables that were defined in earlier migrations
-- (20260515000001_atlas_trading_schema.sql, 20260515000005_atlas_plays.sql,
-- 20260515000006_brainiac_tables.sql, 20260517100002_atlas_core_tables.sql)
-- but never actually took effect on the live database, despite showing as
-- "applied" in the CLI's migration tracking. Confirmed via direct API checks
-- (404 on every table below) and a live test insert -- the original SQL is
-- valid, it just never ran. One likely contributor found: atlas_core_tables
-- opened with `CREATE EXTENSION IF NOT EXISTS pg_audit`, which errors on this
-- Supabase instance (extension not installed) -- omitted here. All
-- CREATE POLICY/CREATE TRIGGER statements below get DROP-IF-EXISTS guards
-- added (missing in the originals) so this migration stays re-runnable.

-- ═══════════════════════════════════════════════════════════════════════════
-- From 20260515000001_atlas_trading_schema.sql (research_notes, trading_accounts,
-- atlas_tasks -- trade_ledger and market_watchlist from this same file already exist)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.research_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  note_type TEXT NOT NULL CHECK (note_type IN ('thesis', 'morning_brief', 'weekly_review', 'research', 'trade_log')),
  obsidian_path TEXT,
  synced_to_obsidian BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.research_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own their research" ON public.research_notes;
CREATE POLICY "Users own their research"
  ON public.research_notes FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_research_notes_user_type
  ON public.research_notes(user_id, note_type, created_at DESC);

CREATE TABLE IF NOT EXISTS public.trading_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  broker TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('live', 'paper')),
  currency TEXT NOT NULL DEFAULT 'USD',
  balance_usd NUMERIC(12,2),
  buying_power_usd NUMERIC(12,2),
  last_sync_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.trading_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own their trading accounts" ON public.trading_accounts;
CREATE POLICY "Users own their trading accounts"
  ON public.trading_accounts FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_accounts_user_broker
  ON public.trading_accounts(user_id, broker, account_id);

CREATE TABLE IF NOT EXISTS public.atlas_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL CHECK (task_type IN ('research', 'patrol', 'morning_brief', 'trade_check', 'forex_scan', 'watchlist_patrol', 'news_alert', 'opportunity_candidate')),
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'active', 'monitoring', 'rejected', 'completed')),
  result JSONB,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.atlas_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users own their tasks" ON public.atlas_tasks;
CREATE POLICY "Users own their tasks"
  ON public.atlas_tasks FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_atlas_tasks_user_status
  ON public.atlas_tasks(user_id, status, scheduled_for);

-- ═══════════════════════════════════════════════════════════════════════════
-- From 20260515000005_atlas_plays.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.atlas_plays (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id           uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  play_type         text NOT NULL,
  title             text NOT NULL,
  description       text,
  status            text NOT NULL DEFAULT 'active',
  capital_deployed  numeric,
  expected_roi_pct  numeric,
  actual_roi_pct    numeric,
  opened_at         timestamptz DEFAULT now(),
  closed_at         timestamptz,
  outcome_notes     text,
  source            text,
  legal_basis       text,
  created_at        timestamptz DEFAULT now()
);
ALTER TABLE public.atlas_plays ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "atlas_plays_own" ON public.atlas_plays;
CREATE POLICY "atlas_plays_own" ON public.atlas_plays
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- From 20260515000006_brainiac_tables.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.atlas_state (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          uuid REFERENCES auth.users ON DELETE CASCADE,
  regime           text NOT NULL,
  confidence_score numeric,
  detected_at      timestamptz DEFAULT now(),
  indicators_json  jsonb
);
ALTER TABLE public.atlas_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "atlas_state_own" ON public.atlas_state;
CREATE POLICY "atlas_state_own" ON public.atlas_state FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.atlas_strategy_weights (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid REFERENCES auth.users ON DELETE CASCADE,
  setup_type    text NOT NULL,
  confidence    numeric DEFAULT 0.5,
  sample_count  integer DEFAULT 0,
  last_updated  timestamptz DEFAULT now()
);
ALTER TABLE public.atlas_strategy_weights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "strategy_weights_own" ON public.atlas_strategy_weights;
CREATE POLICY "strategy_weights_own" ON public.atlas_strategy_weights FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.atlas_knowledge_nodes (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid REFERENCES auth.users ON DELETE CASCADE,
  entity_type     text NOT NULL,
  entity_name     text NOT NULL,
  properties_json jsonb
);
ALTER TABLE public.atlas_knowledge_nodes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "knowledge_nodes_own" ON public.atlas_knowledge_nodes;
CREATE POLICY "knowledge_nodes_own" ON public.atlas_knowledge_nodes FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.atlas_knowledge_edges (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  source_node_id    uuid REFERENCES public.atlas_knowledge_nodes ON DELETE CASCADE,
  target_node_id    uuid REFERENCES public.atlas_knowledge_nodes ON DELETE CASCADE,
  relationship_type text NOT NULL,
  weight            numeric DEFAULT 1.0,
  last_updated      timestamptz DEFAULT now()
);

ALTER TABLE public.atlas_tasks
  DROP CONSTRAINT IF EXISTS atlas_tasks_task_type_check;
ALTER TABLE public.atlas_tasks
  ADD CONSTRAINT atlas_tasks_task_type_check
  CHECK (task_type IN (
    'research', 'patrol', 'morning_brief', 'trade_check',
    'forex_scan', 'watchlist_patrol', 'news_alert', 'opportunity_candidate'
  ));

ALTER TABLE public.atlas_tasks
  DROP CONSTRAINT IF EXISTS atlas_tasks_status_check;
ALTER TABLE public.atlas_tasks
  ADD CONSTRAINT atlas_tasks_status_check
  CHECK (status IN (
    'queued', 'running', 'done', 'failed',
    'active', 'monitoring', 'rejected', 'completed'
  ));

-- ═══════════════════════════════════════════════════════════════════════════
-- From 20260517100002_atlas_core_tables.sql (pg_audit line intentionally omitted --
-- that extension isn't available on this Supabase instance and was the likely
-- reason this entire file never took effect)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.atlas_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid,
  content text NOT NULL,
  embedding vector(1536),
  domain text CHECK (domain IN ('trading', 'realestate', 'business', 'culture', 'music', 'history', 'philosophy', 'personal', 'financial')),
  emotional_valence float,
  importance_score float DEFAULT 0.5,
  created_at timestamptz DEFAULT now(),
  last_accessed timestamptz DEFAULT now(),
  access_count integer DEFAULT 0
);
CREATE INDEX IF NOT EXISTS atlas_memory_embedding_idx
  ON public.atlas_memory USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS atlas_memory_domain_idx ON public.atlas_memory (domain);
CREATE INDEX IF NOT EXISTS atlas_memory_importance_idx ON public.atlas_memory (importance_score DESC);
CREATE INDEX IF NOT EXISTS atlas_memory_created_at_idx ON public.atlas_memory (created_at DESC);

CREATE TABLE IF NOT EXISTS public.atlas_dossier_full (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users,
  entry_type text CHECK (entry_type IN ('financial_decision', 'avoidance_pattern', 'cultural_preference', 'conversation_insight', 'behavioral_pattern', 'growth_moment', 'recurring_theme')),
  content jsonb NOT NULL,
  domain text,
  linked_memory_ids uuid[],
  financial_outcome jsonb,
  pattern_strength float DEFAULT 0.5,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS atlas_dossier_full_user_id_idx ON public.atlas_dossier_full (user_id);
CREATE INDEX IF NOT EXISTS atlas_dossier_full_entry_type_idx ON public.atlas_dossier_full (entry_type);
CREATE INDEX IF NOT EXISTS atlas_dossier_full_domain_idx ON public.atlas_dossier_full (domain);

CREATE TABLE IF NOT EXISTS public.atlas_decision_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_type text NOT NULL CHECK (decision_type IN ('GREEN', 'YELLOW', 'ORANGE', 'RED')),
  business_context text,
  recommendation jsonb NOT NULL,
  supporting_data jsonb,
  capital_at_stake numeric DEFAULT 0,
  time_sensitivity text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'AUTO_EXECUTED')),
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz,
  resolution_note text
);
CREATE INDEX IF NOT EXISTS atlas_decision_queue_status_idx ON public.atlas_decision_queue (status, created_at DESC);
CREATE INDEX IF NOT EXISTS atlas_decision_queue_decision_type_idx ON public.atlas_decision_queue (decision_type, status);

CREATE TABLE IF NOT EXISTS public.atlas_portfolio_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_at timestamptz DEFAULT now(),
  operating_reserve jsonb DEFAULT '{}',
  liquid_trading jsonb DEFAULT '{}',
  real_assets jsonb DEFAULT '{}',
  venture_allocation jsonb DEFAULT '{}',
  total_value numeric DEFAULT 0,
  monthly_cashflow numeric DEFAULT 0,
  annual_return_rate float DEFAULT 0,
  investment_policy_version integer DEFAULT 1,
  rebalancing_needed boolean DEFAULT false
);
CREATE INDEX IF NOT EXISTS atlas_portfolio_state_snapshot_at_idx ON public.atlas_portfolio_state (snapshot_at DESC);

CREATE TABLE IF NOT EXISTS public.atlas_business_pipeline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage text NOT NULL DEFAULT 'SCOUTING' CHECK (stage IN ('SCOUTING', 'EVALUATION', 'APPROVED', 'BUILDING', 'OPERATING', 'MONITORING', 'EXITING')),
  business_type text CHECK (business_type IN ('DIGITAL_ARBITRAGE', 'SERVICE_CONTRACTOR', 'DATA_PRODUCT', 'ACQUISITION')),
  thesis text,
  capital_required numeric DEFAULT 0,
  projected_monthly_revenue numeric DEFAULT 0,
  execution_compatibility_score float DEFAULT 0,
  evaluation_memo jsonb,
  decision_type text,
  entity_structure jsonb,
  contractor_network jsonb,
  performance_metrics jsonb,
  created_at timestamptz DEFAULT now(),
  last_updated timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS atlas_business_pipeline_stage_idx ON public.atlas_business_pipeline (stage, created_at DESC);
CREATE INDEX IF NOT EXISTS atlas_business_pipeline_type_idx ON public.atlas_business_pipeline (business_type, stage);

CREATE TABLE IF NOT EXISTS public.atlas_report_archive (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date date UNIQUE NOT NULL,
  full_content text NOT NULL,
  free_content text,
  signal_content text,
  institutional_content text,
  signal_claims jsonb DEFAULT '[]',
  markets_covered text[] DEFAULT '{}',
  operator_count_anonymous integer DEFAULT 0,
  verified_predictions jsonb DEFAULT '{}',
  published_at timestamptz,
  subscriber_tier text DEFAULT 'FREE' CHECK (subscriber_tier IN ('FREE', 'PAID', 'INSTITUTIONAL'))
);
CREATE INDEX IF NOT EXISTS atlas_report_archive_report_date_idx ON public.atlas_report_archive (report_date DESC);

CREATE TABLE IF NOT EXISTS public.atlas_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  stripe_customer_id text,
  tier text NOT NULL DEFAULT 'FREE' CHECK (tier IN ('FREE', 'SIGNAL', 'COPYTRADE', 'INSTITUTIONAL')),
  monthly_amount numeric DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  subscribed_at timestamptz DEFAULT now(),
  last_billed timestamptz
);
CREATE INDEX IF NOT EXISTS atlas_subscribers_email_idx ON public.atlas_subscribers (email);
CREATE INDEX IF NOT EXISTS atlas_subscribers_tier_status_idx ON public.atlas_subscribers (tier, status);

CREATE TABLE IF NOT EXISTS public.atlas_trade_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id uuid,
  timestamp timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL,
  instrument text NOT NULL,
  quantity numeric NOT NULL,
  price numeric NOT NULL,
  signal_source text,
  operator_signal_contribution jsonb,
  regime_at_entry text,
  thesis_at_entry text,
  outcome jsonb,
  sharpe_contribution float,
  signed_hash text
);
CREATE INDEX IF NOT EXISTS atlas_trade_audit_timestamp_idx ON public.atlas_trade_audit (timestamp DESC);
CREATE INDEX IF NOT EXISTS atlas_trade_audit_instrument_idx ON public.atlas_trade_audit (instrument, timestamp DESC);
CREATE INDEX IF NOT EXISTS atlas_trade_audit_trade_id_idx ON public.atlas_trade_audit (trade_id);

CREATE TABLE IF NOT EXISTS public.atlas_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type text NOT NULL,
  decision_id uuid REFERENCES public.atlas_decision_queue(id),
  message text NOT NULL,
  sent_at timestamptz DEFAULT now(),
  acknowledged_at timestamptz
);
CREATE INDEX IF NOT EXISTS atlas_alerts_alert_type_idx ON public.atlas_alerts (alert_type, sent_at DESC);
CREATE INDEX IF NOT EXISTS atlas_alerts_acknowledged_idx ON public.atlas_alerts (acknowledged_at) WHERE acknowledged_at IS NULL;

CREATE OR REPLACE FUNCTION public.generate_trade_hash(
  p_trade_id uuid,
  p_timestamp timestamptz,
  p_price numeric
) RETURNS text AS $$
DECLARE
  v_secret text;
  v_payload text;
BEGIN
  v_secret := current_setting('app.trade_signing_secret', true);
  IF v_secret IS NULL OR v_secret = '' THEN
    v_secret := 'atlas-default-signing-key-change-in-production';
  END IF;
  v_payload := p_trade_id::text || '|' || extract(epoch from p_timestamp)::text || '|' || p_price::text;
  RETURN encode(hmac(v_payload, v_secret, 'sha256'), 'hex');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.set_trade_signed_hash()
RETURNS TRIGGER AS $$
BEGIN
  NEW.signed_hash := public.generate_trade_hash(NEW.id, NEW.timestamp, NEW.price);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS atlas_trade_audit_hash ON public.atlas_trade_audit;
CREATE TRIGGER atlas_trade_audit_hash
  BEFORE INSERT ON public.atlas_trade_audit
  FOR EACH ROW EXECUTE FUNCTION public.set_trade_signed_hash();

DROP RULE IF EXISTS no_delete_trade_audit ON public.atlas_trade_audit;
CREATE RULE no_delete_trade_audit AS ON DELETE TO public.atlas_trade_audit
  DO INSTEAD (
    INSERT INTO public.atlas_alerts (alert_type, message)
    VALUES ('UNAUTHORIZED_DELETE_ATTEMPT', 'Attempted DELETE on atlas_trade_audit rejected at ' || now()::text)
  );

CREATE OR REPLACE FUNCTION public.handle_decision_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.decision_type = 'GREEN' THEN
    NEW.status := 'AUTO_EXECUTED';
  END IF;
  IF NEW.decision_type = 'RED' THEN
    INSERT INTO public.atlas_alerts (alert_type, decision_id, message)
    VALUES ('RED_DECISION', NEW.id, 'RED decision requires immediate attention: ' || COALESCE(NEW.business_context, 'No context provided'));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_queue_handler ON public.atlas_decision_queue;
CREATE TRIGGER decision_queue_handler
  BEFORE INSERT ON public.atlas_decision_queue
  FOR EACH ROW EXECUTE FUNCTION public.handle_decision_insert();

CREATE OR REPLACE FUNCTION public.check_portfolio_rebalancing()
RETURNS TRIGGER AS $$
DECLARE
  v_total numeric;
  v_trading_pct float;
  v_re_pct float;
  v_business_pct float;
  v_needs_rebalance boolean := false;
BEGIN
  v_total := COALESCE(NEW.total_value, 0);
  IF v_total <= 0 THEN RETURN NEW; END IF;

  v_trading_pct  := COALESCE((NEW.liquid_trading->>'value')::float, 0)     / v_total * 100;
  v_re_pct       := COALESCE((NEW.real_assets->>'value')::float, 0)         / v_total * 100;
  v_business_pct := COALESCE((NEW.venture_allocation->>'value')::float, 0)  / v_total * 100;

  IF ABS(v_trading_pct  - 40) > 15 THEN v_needs_rebalance := true; END IF;
  IF ABS(v_re_pct       - 25) > 15 THEN v_needs_rebalance := true; END IF;
  IF ABS(v_business_pct - 30) > 15 THEN v_needs_rebalance := true; END IF;

  IF v_needs_rebalance THEN
    NEW.rebalancing_needed := true;
    INSERT INTO public.atlas_decision_queue (decision_type, business_context, recommendation, capital_at_stake)
    VALUES (
      'YELLOW',
      'Portfolio rebalancing required',
      jsonb_build_object(
        'reason',        'Layer deviation exceeds 15% threshold',
        'trading_pct',   v_trading_pct,
        're_pct',        v_re_pct,
        'business_pct',  v_business_pct,
        'targets',       '{"trading": 40, "re": 25, "business": 30, "cash": 5}'
      ),
      NEW.total_value
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS portfolio_rebalancing_check ON public.atlas_portfolio_state;
CREATE TRIGGER portfolio_rebalancing_check
  BEFORE INSERT OR UPDATE ON public.atlas_portfolio_state
  FOR EACH ROW EXECUTE FUNCTION public.check_portfolio_rebalancing();

ALTER TABLE public.atlas_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role manages atlas_memory" ON public.atlas_memory;
CREATE POLICY "Service role manages atlas_memory"
  ON public.atlas_memory
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE public.atlas_dossier_full ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own dossier entries" ON public.atlas_dossier_full;
CREATE POLICY "Users can read own dossier entries"
  ON public.atlas_dossier_full FOR SELECT
  USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Service role manages dossier" ON public.atlas_dossier_full;
CREATE POLICY "Service role manages dossier"
  ON public.atlas_dossier_full FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE public.atlas_decision_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read decision queue" ON public.atlas_decision_queue;
CREATE POLICY "Authenticated users can read decision queue"
  ON public.atlas_decision_queue FOR SELECT
  USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');
DROP POLICY IF EXISTS "Service role manages decision queue" ON public.atlas_decision_queue;
CREATE POLICY "Service role manages decision queue"
  ON public.atlas_decision_queue FOR INSERT
  WITH CHECK (auth.role() = 'service_role');
DROP POLICY IF EXISTS "Service role can update decision queue" ON public.atlas_decision_queue;
CREATE POLICY "Service role can update decision queue"
  ON public.atlas_decision_queue FOR UPDATE
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE public.atlas_trade_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read trade audit" ON public.atlas_trade_audit;
CREATE POLICY "Authenticated users can read trade audit"
  ON public.atlas_trade_audit FOR SELECT
  USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');
DROP POLICY IF EXISTS "Service role inserts trade audit" ON public.atlas_trade_audit;
CREATE POLICY "Service role inserts trade audit"
  ON public.atlas_trade_audit FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE public.atlas_subscribers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own subscriber record" ON public.atlas_subscribers;
CREATE POLICY "Users can read own subscriber record"
  ON public.atlas_subscribers FOR SELECT
  USING (
    email = (SELECT email FROM auth.users WHERE id = auth.uid())
  );
DROP POLICY IF EXISTS "Service role manages subscribers" ON public.atlas_subscribers;
CREATE POLICY "Service role manages subscribers"
  ON public.atlas_subscribers FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE public.atlas_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read alerts" ON public.atlas_alerts;
CREATE POLICY "Authenticated users can read alerts"
  ON public.atlas_alerts FOR SELECT
  USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');
DROP POLICY IF EXISTS "Service role manages alerts" ON public.atlas_alerts;
CREATE POLICY "Service role manages alerts"
  ON public.atlas_alerts FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE public.atlas_portfolio_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role manages portfolio state" ON public.atlas_portfolio_state;
CREATE POLICY "Service role manages portfolio state"
  ON public.atlas_portfolio_state FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE public.atlas_business_pipeline ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role manages business pipeline" ON public.atlas_business_pipeline;
CREATE POLICY "Service role manages business pipeline"
  ON public.atlas_business_pipeline FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE public.atlas_report_archive ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Free reports are publicly readable" ON public.atlas_report_archive;
CREATE POLICY "Free reports are publicly readable"
  ON public.atlas_report_archive FOR SELECT
  USING (subscriber_tier = 'FREE' OR auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION public.check_regulatory_boundary()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.atlas_alerts (alert_type, message)
  VALUES (
    'REGULATORY_BOUNDARY_VIOLATION',
    'Attempted join of subscriber data with trade recommendations blocked at ' || now()::text
  );
  RAISE EXCEPTION 'Regulatory boundary violation: subscriber data cannot be joined with trade recommendations until REGULATORY_BOUNDARY_MODE=REVIEWED_AND_APPROVED';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
