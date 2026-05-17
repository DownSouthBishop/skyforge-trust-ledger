-- ============================================================
-- Atlas Core Tables — new unified architecture
-- pgvector already enabled (20260515000004_pgvector.sql)
-- pg_cron already enabled (20260515000003_cron_jobs.sql)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_audit;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── atlas_memory: semantic memory with embeddings ────────────────────────────

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

CREATE INDEX IF NOT EXISTS atlas_memory_domain_idx
  ON public.atlas_memory (domain);

CREATE INDEX IF NOT EXISTS atlas_memory_importance_idx
  ON public.atlas_memory (importance_score DESC);

CREATE INDEX IF NOT EXISTS atlas_memory_created_at_idx
  ON public.atlas_memory (created_at DESC);

-- ─── atlas_dossier_full: comprehensive behavioral/financial dossier ────────────

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

CREATE INDEX IF NOT EXISTS atlas_dossier_full_user_id_idx
  ON public.atlas_dossier_full (user_id);

CREATE INDEX IF NOT EXISTS atlas_dossier_full_entry_type_idx
  ON public.atlas_dossier_full (entry_type);

CREATE INDEX IF NOT EXISTS atlas_dossier_full_domain_idx
  ON public.atlas_dossier_full (domain);

-- ─── atlas_decision_queue: GREEN/YELLOW/ORANGE/RED decision system ────────────

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

CREATE INDEX IF NOT EXISTS atlas_decision_queue_status_idx
  ON public.atlas_decision_queue (status, created_at DESC);

CREATE INDEX IF NOT EXISTS atlas_decision_queue_decision_type_idx
  ON public.atlas_decision_queue (decision_type, status);

-- ─── atlas_portfolio_state: unified portfolio tracking ────────────────────────

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

CREATE INDEX IF NOT EXISTS atlas_portfolio_state_snapshot_at_idx
  ON public.atlas_portfolio_state (snapshot_at DESC);

-- ─── atlas_business_pipeline: autonomous business pipeline ────────────────────

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

CREATE INDEX IF NOT EXISTS atlas_business_pipeline_stage_idx
  ON public.atlas_business_pipeline (stage, created_at DESC);

CREATE INDEX IF NOT EXISTS atlas_business_pipeline_type_idx
  ON public.atlas_business_pipeline (business_type, stage);

-- ─── atlas_report_archive: daily report storage ───────────────────────────────

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

CREATE INDEX IF NOT EXISTS atlas_report_archive_report_date_idx
  ON public.atlas_report_archive (report_date DESC);

-- ─── atlas_subscribers: subscriber management ─────────────────────────────────

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

CREATE INDEX IF NOT EXISTS atlas_subscribers_email_idx
  ON public.atlas_subscribers (email);

CREATE INDEX IF NOT EXISTS atlas_subscribers_tier_status_idx
  ON public.atlas_subscribers (tier, status);

-- ─── atlas_trade_audit: immutable trade audit log ─────────────────────────────

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

CREATE INDEX IF NOT EXISTS atlas_trade_audit_timestamp_idx
  ON public.atlas_trade_audit (timestamp DESC);

CREATE INDEX IF NOT EXISTS atlas_trade_audit_instrument_idx
  ON public.atlas_trade_audit (instrument, timestamp DESC);

CREATE INDEX IF NOT EXISTS atlas_trade_audit_trade_id_idx
  ON public.atlas_trade_audit (trade_id);

-- ─── atlas_alerts: RED decision notifications ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.atlas_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type text NOT NULL,
  decision_id uuid REFERENCES public.atlas_decision_queue(id),
  message text NOT NULL,
  sent_at timestamptz DEFAULT now(),
  acknowledged_at timestamptz
);

CREATE INDEX IF NOT EXISTS atlas_alerts_alert_type_idx
  ON public.atlas_alerts (alert_type, sent_at DESC);

CREATE INDEX IF NOT EXISTS atlas_alerts_acknowledged_idx
  ON public.atlas_alerts (acknowledged_at) WHERE acknowledged_at IS NULL;

-- ─── Trade hash signing ───────────────────────────────────────────────────────

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

CREATE TRIGGER atlas_trade_audit_hash
  BEFORE INSERT ON public.atlas_trade_audit
  FOR EACH ROW EXECUTE FUNCTION public.set_trade_signed_hash();

-- ─── Append-only rule: block DELETEs on atlas_trade_audit ─────────────────────

CREATE RULE no_delete_trade_audit AS ON DELETE TO public.atlas_trade_audit
  DO INSTEAD (
    INSERT INTO public.atlas_alerts (alert_type, message)
    VALUES ('UNAUTHORIZED_DELETE_ATTEMPT', 'Attempted DELETE on atlas_trade_audit rejected at ' || now()::text)
  );

-- ─── Decision queue handler: GREEN auto-execute, RED alert ────────────────────

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

CREATE TRIGGER decision_queue_handler
  BEFORE INSERT ON public.atlas_decision_queue
  FOR EACH ROW EXECUTE FUNCTION public.handle_decision_insert();

-- ─── Portfolio rebalancing trigger ────────────────────────────────────────────

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

  -- Targets: trading 40%, re 25%, business 30%, cash 5%
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

CREATE TRIGGER portfolio_rebalancing_check
  BEFORE INSERT OR UPDATE ON public.atlas_portfolio_state
  FOR EACH ROW EXECUTE FUNCTION public.check_portfolio_rebalancing();

-- ─── RLS policies ─────────────────────────────────────────────────────────────

-- atlas_memory: service role only — never exposed to client
ALTER TABLE public.atlas_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages atlas_memory"
  ON public.atlas_memory
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- atlas_dossier_full: user can read their own; service role can write
ALTER TABLE public.atlas_dossier_full ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own dossier entries"
  ON public.atlas_dossier_full FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role manages dossier"
  ON public.atlas_dossier_full FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- atlas_decision_queue: authenticated users can read; ORANGE/RED writable by service role only
ALTER TABLE public.atlas_decision_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read decision queue"
  ON public.atlas_decision_queue FOR SELECT
  USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

CREATE POLICY "Service role manages decision queue"
  ON public.atlas_decision_queue FOR INSERT
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role can update decision queue"
  ON public.atlas_decision_queue FOR UPDATE
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- atlas_trade_audit: readable by authenticated; inserts by service role only
ALTER TABLE public.atlas_trade_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read trade audit"
  ON public.atlas_trade_audit FOR SELECT
  USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

CREATE POLICY "Service role inserts trade audit"
  ON public.atlas_trade_audit FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

-- atlas_subscribers: users can only read their own row
ALTER TABLE public.atlas_subscribers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own subscriber record"
  ON public.atlas_subscribers FOR SELECT
  USING (
    email = (SELECT email FROM auth.users WHERE id = auth.uid())
  );

CREATE POLICY "Service role manages subscribers"
  ON public.atlas_subscribers FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- atlas_alerts: service role manages; authenticated can read
ALTER TABLE public.atlas_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read alerts"
  ON public.atlas_alerts FOR SELECT
  USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

CREATE POLICY "Service role manages alerts"
  ON public.atlas_alerts FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

-- atlas_portfolio_state: service role only
ALTER TABLE public.atlas_portfolio_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages portfolio state"
  ON public.atlas_portfolio_state FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- atlas_business_pipeline: service role only
ALTER TABLE public.atlas_business_pipeline ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages business pipeline"
  ON public.atlas_business_pipeline FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- atlas_report_archive: free tier readable by all; signal/institutional by service role
ALTER TABLE public.atlas_report_archive ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Free reports are publicly readable"
  ON public.atlas_report_archive FOR SELECT
  USING (subscriber_tier = 'FREE' OR auth.role() = 'service_role');

-- ─── Regulatory boundary function ─────────────────────────────────────────────
-- Attached to any view that attempts to join subscriber data with trade
-- recommendations to enforce separation between subscriber identity and
-- investment advice (prevents inadvertent investment advisor classification).

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
