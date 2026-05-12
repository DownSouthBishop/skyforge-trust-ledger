-- Phase 1 & 3: forge_dossier (rich persistent operator profile) + forge_commitments (structured commitment tracking)

-- forge_dossier: one row per operator, built incrementally over the relationship
CREATE TABLE IF NOT EXISTS public.forge_dossier (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Identity: what kind of operator this is
  trade TEXT,                        -- "HVAC technician", "roofer", "plumber", "electrician"
  market TEXT,                       -- geographic or market context
  years_in_business INT,
  team_size TEXT,                    -- "solo", "2-person", "small team (3-5)", "growing team"

  -- Financial psychology: how they actually relate to money (observed, not claimed)
  money_beliefs TEXT,
  risk_posture TEXT,                 -- "conservative", "aggressive", "avoidant", "calculated"
  decision_pattern TEXT,             -- how they actually make decisions, not how they say they do

  -- Behavioral patterns: what Atlas has noticed across time
  follow_through_pattern TEXT,       -- do they execute on what they commit to?
  avoidance_pattern TEXT,            -- what do they reliably defer, avoid, rationalize away?

  -- Current state: where they are right now
  current_phase TEXT,                -- "growing", "stabilizing", "rebuilding", "first hire", etc.
  current_focus TEXT,                -- what is consuming their attention

  -- Emotional context: invisible infrastructure
  emotional_baseline TEXT,           -- how they typically show up in conversation
  current_emotional_signal TEXT,     -- what they seem to be carrying right now
  last_heavy_exchange TEXT,          -- summary of last emotionally significant moment
  last_heavy_exchange_at TIMESTAMPTZ,

  -- Metadata
  conversation_count_at_last_update INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.forge_dossier ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own dossier"
  ON public.forge_dossier FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own dossier"
  ON public.forge_dossier FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own dossier"
  ON public.forge_dossier FOR UPDATE USING (auth.uid() = user_id);

CREATE TRIGGER update_forge_dossier_updated_at
  BEFORE UPDATE ON public.forge_dossier
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- forge_commitments: each commitment is a row with its own lifecycle
-- Replaces the single-string commitment field in forge_sticky_memory
CREATE TABLE IF NOT EXISTS public.forge_commitments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  made_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  target_date DATE,
  resolution_status TEXT NOT NULL DEFAULT 'open'
    CHECK (resolution_status IN ('open', 'kept', 'missed', 'abandoned')),
  resolution_at TIMESTAMPTZ,
  follow_up_count INT NOT NULL DEFAULT 0,
  last_followed_up_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forge_commitments_user_status
  ON public.forge_commitments(user_id, resolution_status);

CREATE INDEX IF NOT EXISTS idx_forge_commitments_user_made
  ON public.forge_commitments(user_id, made_at DESC);

ALTER TABLE public.forge_commitments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own commitments"
  ON public.forge_commitments FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own commitments"
  ON public.forge_commitments FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own commitments"
  ON public.forge_commitments FOR UPDATE USING (auth.uid() = user_id);


-- Updated get_forge_context: now returns dossier + full commitment history
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
           verification_state AS state, created_at
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

  -- Dossier (rich persistent profile)
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

  -- Open commitments (most recent 5, for Atlas context)
  SELECT coalesce(jsonb_agg(c ORDER BY c.made_at DESC), '[]'::jsonb) INTO v_open_commitments
  FROM (
    SELECT id, description, made_at, target_date, follow_up_count
    FROM public.forge_commitments
    WHERE user_id = _user_id AND resolution_status = 'open'
    ORDER BY made_at DESC
    LIMIT 5
  ) c;

  -- Missed commitments (most recent 3 — patterns Atlas should know)
  SELECT coalesce(jsonb_agg(c ORDER BY c.resolution_at DESC NULLS LAST), '[]'::jsonb) INTO v_missed_commitments
  FROM (
    SELECT id, description, made_at, resolution_at
    FROM public.forge_commitments
    WHERE user_id = _user_id AND resolution_status = 'missed'
    ORDER BY resolution_at DESC NULLS LAST
    LIMIT 3
  ) c;

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
    'missed_commitments', coalesce(v_missed_commitments, '[]'::jsonb)
  );
END;
$$;
