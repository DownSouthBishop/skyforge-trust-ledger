-- Phase A: Personal HUD — income log, goals, pipeline, multi-business tracking

-- Add business vertical dimension to income log
ALTER TABLE public.receipts_ledger
  ADD COLUMN IF NOT EXISTS business_vertical TEXT;

-- income_goals: revenue targets by period and optionally by business
CREATE TABLE IF NOT EXISTS public.income_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_vertical TEXT,           -- null = applies to all businesses combined
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly', 'quarterly', 'annual')),
  target_amount NUMERIC(12,2) NOT NULL,
  label TEXT,                       -- optional display label e.g. "Monthly baseline"
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.income_goals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own goals"
  ON public.income_goals FOR ALL USING (auth.uid() = user_id);

CREATE TRIGGER update_income_goals_updated_at
  BEFORE UPDATE ON public.income_goals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- income_pipeline: quotes and opportunities in motion
CREATE TABLE IF NOT EXISTS public.income_pipeline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  client_name TEXT,
  estimated_value NUMERIC(12,2),
  stage TEXT NOT NULL DEFAULT 'quoted'
    CHECK (stage IN ('quoted', 'in_progress', 'closing', 'won', 'lost')),
  business_vertical TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_income_pipeline_user_stage
  ON public.income_pipeline(user_id, stage);

ALTER TABLE public.income_pipeline ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own pipeline"
  ON public.income_pipeline FOR ALL USING (auth.uid() = user_id);

CREATE TRIGGER update_income_pipeline_updated_at
  BEFORE UPDATE ON public.income_pipeline
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- Updated get_forge_context: adds income_today, income_week, income_month,
-- business_breakdown, active_goals (with progress), pipeline summary
CREATE OR REPLACE FUNCTION public.get_forge_context(_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_trust_score NUMERIC;
  v_verified_count INT;
  v_pending_count INT;
  v_disputed_count INT;
  v_total_count INT;
  v_total_volume NUMERIC;
  v_completion_rate NUMERIC;
  v_dispute_rate NUMERIC;
  v_current_streak INT := 0;
  v_bottleneck TEXT;
  v_recent JSONB;
  v_crm JSONB;
  v_check_date DATE := current_date;
  v_has_day BOOLEAN;
  v_trajectory TEXT;
  v_stage INT;
  v_turn_count INT;
  v_sticky JSONB;
  v_reengagement TEXT;
  v_dossier JSONB;
  v_open_commitments JSONB;
  v_missed_commitments JSONB;
  v_income_today NUMERIC;
  v_income_week NUMERIC;
  v_income_month NUMERIC;
  v_business_breakdown JSONB;
  v_active_goals JSONB;
  v_pipeline JSONB;
BEGIN
  SELECT full_name, trajectory_sentence, atlas_relationship_stage, atlas_reengagement_message
    INTO v_full_name, v_trajectory, v_stage, v_reengagement
  FROM public.user_profiles WHERE user_id = _user_id;

  v_trust_score := public.calculate_trust_score(_user_id);

  SELECT
    count(*) FILTER (WHERE verification_state = 'VERIFIED'),
    count(*) FILTER (WHERE verification_state = 'PENDING'),
    count(*) FILTER (WHERE verification_state = 'DISPUTED'),
    count(*),
    coalesce(sum(action_value_usd) FILTER (WHERE verification_state = 'VERIFIED'), 0)
  INTO v_verified_count, v_pending_count, v_disputed_count, v_total_count, v_total_volume
  FROM public.receipts_ledger
  WHERE provider_id = _user_id;

  v_completion_rate := CASE WHEN v_total_count > 0
    THEN round((v_verified_count::NUMERIC / v_total_count) * 100, 1) ELSE 0 END;
  v_dispute_rate := CASE WHEN v_total_count > 0
    THEN round((v_disputed_count::NUMERIC / v_total_count) * 100, 1) ELSE 0 END;

  -- Streak calculation
  LOOP
    SELECT EXISTS(
      SELECT 1 FROM public.receipts_ledger
      WHERE provider_id = _user_id
        AND verification_state = 'VERIFIED'
        AND created_at::date = v_check_date
    ) INTO v_has_day;
    IF v_has_day THEN
      v_current_streak := v_current_streak + 1;
      v_check_date := v_check_date - 1;
    ELSE
      IF v_check_date = current_date THEN
        v_check_date := v_check_date - 1;
      ELSE
        EXIT;
      END IF;
    END IF;
    EXIT WHEN v_current_streak > 365;
  END LOOP;

  -- Bottleneck determination
  v_bottleneck := CASE
    WHEN v_total_count = 0 THEN 'no_activity'
    WHEN v_pending_count > v_verified_count THEN 'verification'
    WHEN v_dispute_rate > 10 THEN 'disputes'
    WHEN v_completion_rate < 50 THEN 'closing'
    WHEN v_total_volume < 1000 THEN 'pricing'
    WHEN v_verified_count < 10 THEN 'volume'
    ELSE 'scale'
  END;

  -- Recent receipts (last 5)
  SELECT coalesce(jsonb_agg(r), '[]'::jsonb) INTO v_recent
  FROM (
    SELECT action_description AS job, action_value_usd AS amount,
           verification_state AS state, business_vertical, created_at
    FROM public.receipts_ledger
    WHERE provider_id = _user_id
    ORDER BY created_at DESC LIMIT 5
  ) r;

  -- CRM opportunities (top 3)
  SELECT coalesce(jsonb_agg(o), '[]'::jsonb) INTO v_crm
  FROM (
    SELECT
      client_name,
      last_job_type AS last_job,
      CASE WHEN last_job_date IS NOT NULL
        THEN (current_date - last_job_date)
        ELSE NULL END AS days_since_contact,
      CASE WHEN job_count > 0
        THEN round(total_spend / job_count, 2)
        ELSE 0 END AS estimated_value
    FROM public.get_crm_opportunities(_user_id)
    LIMIT 3
  ) o;

  -- Turn count
  SELECT count(*) INTO v_turn_count
  FROM public.forge_messages WHERE user_id = _user_id;

  -- Sticky memory (backward compat)
  SELECT jsonb_build_object(
    'goal', goal, 'obstacle', obstacle, 'commitment', commitment
  ) INTO v_sticky FROM public.forge_sticky_memory WHERE user_id = _user_id;

  -- Dossier
  SELECT jsonb_build_object(
    'trade', trade,
    'market', market,
    'years_in_business', years_in_business,
    'team_size', team_size,
    'money_beliefs', money_beliefs,
    'risk_posture', risk_posture,
    'decision_pattern', decision_pattern,
    'follow_through_pattern', follow_through_pattern,
    'avoidance_pattern', avoidance_pattern,
    'current_phase', current_phase,
    'current_focus', current_focus,
    'emotional_baseline', emotional_baseline,
    'current_emotional_signal', current_emotional_signal,
    'last_heavy_exchange', last_heavy_exchange,
    'last_heavy_exchange_at', last_heavy_exchange_at
  ) INTO v_dossier FROM public.forge_dossier WHERE user_id = _user_id;

  -- Open commitments (most recent 5)
  SELECT coalesce(jsonb_agg(c ORDER BY c.made_at DESC), '[]'::jsonb) INTO v_open_commitments
  FROM (
    SELECT id, description, made_at, target_date, follow_up_count
    FROM public.forge_commitments
    WHERE user_id = _user_id AND resolution_status = 'open'
    ORDER BY made_at DESC
    LIMIT 5
  ) c;

  -- Missed commitments (most recent 3)
  SELECT coalesce(jsonb_agg(c ORDER BY c.resolution_at DESC NULLS LAST), '[]'::jsonb) INTO v_missed_commitments
  FROM (
    SELECT id, description, made_at, resolution_at
    FROM public.forge_commitments
    WHERE user_id = _user_id AND resolution_status = 'missed'
    ORDER BY resolution_at DESC NULLS LAST
    LIMIT 3
  ) c;

  -- Income periods (all entries count as verified — personal log, no ceremony)
  SELECT
    coalesce(sum(action_value_usd) FILTER (WHERE created_at::date = current_date), 0),
    coalesce(sum(action_value_usd) FILTER (WHERE created_at >= date_trunc('week', current_date)), 0),
    coalesce(sum(action_value_usd) FILTER (WHERE created_at >= date_trunc('month', current_date)), 0)
  INTO v_income_today, v_income_week, v_income_month
  FROM public.receipts_ledger
  WHERE provider_id = _user_id;

  -- Business breakdown (last 30 days, by vertical)
  SELECT coalesce(jsonb_agg(b ORDER BY b.total DESC), '[]'::jsonb) INTO v_business_breakdown
  FROM (
    SELECT
      coalesce(business_vertical, 'Untagged') AS vertical,
      count(*) AS job_count,
      round(coalesce(sum(action_value_usd), 0)::NUMERIC, 2) AS total
    FROM public.receipts_ledger
    WHERE provider_id = _user_id
      AND created_at >= current_date - 30
    GROUP BY business_vertical
    ORDER BY total DESC
  ) b;

  -- Active goals with current period progress
  SELECT coalesce(jsonb_agg(g), '[]'::jsonb) INTO v_active_goals
  FROM (
    SELECT
      g.id,
      g.period,
      g.target_amount,
      g.business_vertical,
      coalesce(g.label, g.period || CASE WHEN g.business_vertical IS NOT NULL THEN ' / ' || g.business_vertical ELSE '' END) AS label,
      round(coalesce(
        (SELECT sum(r.action_value_usd)
         FROM public.receipts_ledger r
         WHERE r.provider_id = _user_id
           AND (g.business_vertical IS NULL OR r.business_vertical = g.business_vertical)
           AND r.created_at >= CASE g.period
             WHEN 'daily'     THEN date_trunc('day', now())
             WHEN 'weekly'    THEN date_trunc('week', now())
             WHEN 'monthly'   THEN date_trunc('month', now())
             WHEN 'quarterly' THEN date_trunc('quarter', now())
             WHEN 'annual'    THEN date_trunc('year', now())
           END),
        0
      )::NUMERIC, 2) AS current_amount
    FROM public.income_goals g
    WHERE g.user_id = _user_id AND g.is_active = true
    ORDER BY g.period, g.created_at
  ) g;

  -- Pipeline: open items (quoted + in_progress + closing)
  SELECT coalesce(jsonb_agg(p ORDER BY p.estimated_value DESC NULLS LAST), '[]'::jsonb) INTO v_pipeline
  FROM (
    SELECT id, description, client_name, estimated_value, stage, business_vertical, created_at
    FROM public.income_pipeline
    WHERE user_id = _user_id
      AND stage NOT IN ('won', 'lost')
    ORDER BY estimated_value DESC NULLS LAST
    LIMIT 10
  ) p;

  -- Auto-advance relationship stage
  v_stage := coalesce(v_stage, 1);
  IF v_verified_count > 75 AND v_turn_count > 100 THEN
    v_stage := 3;
  ELSIF v_verified_count >= 15 AND v_turn_count >= 20 THEN
    v_stage := greatest(v_stage, 2);
  END IF;

  RETURN jsonb_build_object(
    'full_name',          coalesce(v_full_name, 'Operator'),
    'trust_score',        v_trust_score,
    'verified_count',     v_verified_count,
    'total_volume',       v_total_volume,
    'completion_rate',    v_completion_rate,
    'dispute_rate',       v_dispute_rate,
    'current_streak',     v_current_streak,
    'bottleneck',         v_bottleneck,
    'recent_receipts',    v_recent,
    'crm_opportunities',  v_crm,
    'trajectory_sentence', v_trajectory,
    'relationship_stage', v_stage,
    'turn_count',         v_turn_count,
    'sticky_memory',      coalesce(v_sticky, '{}'::jsonb),
    'reengagement_message', v_reengagement,
    'dossier',            coalesce(v_dossier, '{}'::jsonb),
    'open_commitments',   coalesce(v_open_commitments, '[]'::jsonb),
    'missed_commitments', coalesce(v_missed_commitments, '[]'::jsonb),
    'income_today',       v_income_today,
    'income_week',        v_income_week,
    'income_month',       v_income_month,
    'business_breakdown', coalesce(v_business_breakdown, '[]'::jsonb),
    'active_goals',       coalesce(v_active_goals, '[]'::jsonb),
    'pipeline',           coalesce(v_pipeline, '[]'::jsonb)
  );
END;
$$;
