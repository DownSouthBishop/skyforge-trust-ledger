-- Atlas persistent preferences — what Atlas has learned about this person over time

CREATE TABLE IF NOT EXISTS public.atlas_user_preferences (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category         text NOT NULL CHECK (category IN (
    'communication',    -- how they like to be spoken to
    'trading_style',    -- risk appetite, timeframe, asset preferences
    'interest',         -- topics that engage them
    'dislike',          -- things that frustrate or bore them
    'behavioral',       -- observed patterns in how they operate
    'emotional'         -- recurrent emotional patterns
  )),
  key              text NOT NULL,         -- e.g. 'prefers_brevity', 'dislikes_jargon'
  value            text NOT NULL,         -- human-readable description
  confidence       numeric DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  evidence         text,                  -- what triggered this observation
  source           text DEFAULT 'conversation',
  last_confirmed_at timestamptz DEFAULT now(),
  created_at       timestamptz DEFAULT now(),
  UNIQUE (user_id, category, key)
);

ALTER TABLE public.atlas_user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pref_own" ON public.atlas_user_preferences FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_atlas_prefs_user ON public.atlas_user_preferences(user_id);

GRANT SELECT, INSERT, UPDATE ON public.atlas_user_preferences TO service_role;

-- Update get_forge_context to include top preferences
CREATE OR REPLACE FUNCTION public.get_forge_context(_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _result         JSONB := '{}'::jsonb;
  _profile        RECORD;
  _dossier        RECORD;
  _income_today   NUMERIC := 0;
  _income_week    NUMERIC := 0;
  _income_month   NUMERIC := 0;
  _breakdown      JSONB := '[]'::jsonb;
  _goals          JSONB := '[]'::jsonb;
  _pipeline       JSONB := '[]'::jsonb;
  _open_commits   JSONB := '[]'::jsonb;
  _missed_commits JSONB := '[]'::jsonb;
  _crm            JSONB := '[]'::jsonb;
  _alerts         JSONB := '[]'::jsonb;
  _prefs          JSONB := '[]'::jsonb;
  _monthly_goal   NUMERIC := 0;
  _days_in_month  INT;
  _days_elapsed   INT;
  _days_remaining INT;
  _projected_end  NUMERIC := 0;
  _gap            NUMERIC := 0;
  _per_day_needed NUMERIC := 0;
  _on_pace        BOOLEAN := false;
  _show_trajectory BOOLEAN := false;
BEGIN
  SELECT * INTO _profile FROM public.user_profiles WHERE user_id = _user_id;
  SELECT * INTO _dossier FROM public.forge_dossier     WHERE user_id = _user_id;

  SELECT COALESCE(SUM(action_value_usd),0) INTO _income_today
  FROM public.receipts_ledger
  WHERE provider_id = _user_id AND created_at >= date_trunc('day', now());

  SELECT COALESCE(SUM(action_value_usd),0) INTO _income_week
  FROM public.receipts_ledger
  WHERE provider_id = _user_id AND created_at >= date_trunc('week', now());

  SELECT COALESCE(SUM(action_value_usd),0) INTO _income_month
  FROM public.receipts_ledger
  WHERE provider_id = _user_id AND created_at >= date_trunc('month', now());

  SELECT COALESCE(jsonb_agg(row_to_json(b)), '[]'::jsonb) INTO _breakdown
  FROM (
    SELECT COALESCE(business_vertical,'Untagged') AS vertical,
           SUM(action_value_usd) AS total,
           COUNT(*) AS job_count
    FROM public.receipts_ledger
    WHERE provider_id = _user_id AND created_at >= now() - INTERVAL '30 days'
    GROUP BY 1 ORDER BY 2 DESC LIMIT 10
  ) b;

  SELECT COALESCE(jsonb_agg(row_to_json(g)), '[]'::jsonb) INTO _goals
  FROM (
    SELECT ig.id, ig.label, ig.period, ig.target_amount, ig.business_vertical,
      COALESCE((
        SELECT SUM(r.action_value_usd)
        FROM public.receipts_ledger r
        WHERE r.provider_id = _user_id
          AND (ig.business_vertical IS NULL OR r.business_vertical = ig.business_vertical)
          AND r.created_at >= CASE ig.period
            WHEN 'daily'     THEN date_trunc('day',    now())
            WHEN 'weekly'    THEN date_trunc('week',   now())
            WHEN 'monthly'   THEN date_trunc('month',  now())
            WHEN 'quarterly' THEN date_trunc('quarter',now())
            WHEN 'yearly'    THEN date_trunc('year',   now())
            ELSE date_trunc('month', now()) END
      ), 0) AS current_amount
    FROM public.income_goals ig
    WHERE ig.user_id = _user_id AND ig.active = true
  ) g;

  SELECT COALESCE(jsonb_agg(row_to_json(p)), '[]'::jsonb) INTO _pipeline
  FROM (
    SELECT client_name, estimated_value, stage, follow_up_date, notes
    FROM public.crm_pipeline
    WHERE user_id = _user_id
    ORDER BY estimated_value DESC NULLS LAST
    LIMIT 10
  ) p;

  SELECT COALESCE(jsonb_agg(row_to_json(c)), '[]'::jsonb) INTO _open_commits
  FROM (
    SELECT id, description, made_at, target_date, follow_up_count
    FROM public.forge_commitments
    WHERE user_id = _user_id AND resolution_status = 'open'
    ORDER BY made_at DESC
    LIMIT 10
  ) c;

  SELECT COALESCE(jsonb_agg(row_to_json(c)), '[]'::jsonb) INTO _missed_commits
  FROM (
    SELECT id, description, resolution_at
    FROM public.forge_commitments
    WHERE user_id = _user_id AND resolution_status = 'missed'
    ORDER BY resolution_at DESC
    LIMIT 5
  ) c;

  -- CRM re-engagement opportunities
  BEGIN
    SELECT COALESCE(jsonb_agg(row_to_json(o)), '[]'::jsonb) INTO _crm
    FROM (SELECT * FROM public.get_crm_opportunities(_user_id) LIMIT 5) o;
  EXCEPTION WHEN OTHERS THEN
    _crm := '[]'::jsonb;
  END;

  -- Unread forge alerts
  SELECT COALESCE(jsonb_agg(row_to_json(a)), '[]'::jsonb) INTO _alerts
  FROM (
    SELECT id, signal_type, message, created_at
    FROM public.forge_alerts
    WHERE user_id = _user_id AND read_at IS NULL
    ORDER BY created_at DESC
    LIMIT 5
  ) a;

  -- Top preferences (high confidence, recent)
  SELECT COALESCE(jsonb_agg(row_to_json(p)), '[]'::jsonb) INTO _prefs
  FROM (
    SELECT category, key, value, confidence, last_confirmed_at
    FROM public.atlas_user_preferences
    WHERE user_id = _user_id AND confidence >= 0.4
    ORDER BY confidence DESC, last_confirmed_at DESC
    LIMIT 20
  ) p;

  -- Trajectory
  _days_in_month  := EXTRACT(DAY FROM (date_trunc('month', now()) + INTERVAL '1 month - 1 day'))::INT;
  _days_elapsed   := GREATEST(EXTRACT(DAY FROM now())::INT, 1);
  _days_remaining := _days_in_month - _days_elapsed;

  SELECT COALESCE(target_amount, 0) INTO _monthly_goal
  FROM public.income_goals
  WHERE user_id = _user_id AND period = 'monthly' AND active = true
  ORDER BY created_at DESC LIMIT 1;

  _show_trajectory := _monthly_goal > 0 AND _days_elapsed > 1;

  IF _show_trajectory THEN
    _projected_end := CASE WHEN _days_elapsed > 0
      THEN (_income_month / _days_elapsed) * _days_in_month ELSE 0 END;
    _gap            := _monthly_goal - _projected_end;
    _on_pace        := _projected_end >= _monthly_goal;
    _per_day_needed := CASE WHEN _days_remaining > 0 AND NOT _on_pace
      THEN (_monthly_goal - _income_month) / _days_remaining ELSE 0 END;
  END IF;

  -- Relationship stage
  DECLARE
    _stage INT := 1;
    _turn_count INT := 0;
    _streak INT := 0;
    _verified_count INT := 0;
    _total_volume NUMERIC := 0;
    _trust_score NUMERIC := 0;
    _recent_receipts JSONB := '[]'::jsonb;
    _sticky JSONB := '{}';
    _active_goals JSONB := '[]'::jsonb;
  BEGIN
    SELECT COUNT(*) INTO _turn_count FROM public.forge_messages
    WHERE user_id = _user_id AND role = 'assistant';

    SELECT COALESCE(current_streak, 0), COALESCE(verified_count, 0),
           COALESCE(total_revenue_usd, 0), COALESCE(trust_score, 0)
    INTO _streak, _verified_count, _total_volume, _trust_score
    FROM public.user_profiles WHERE user_id = _user_id;

    IF _turn_count >= 30 AND _verified_count >= 10 THEN _stage := 3;
    ELSIF _turn_count >= 10 OR _verified_count >= 3 THEN _stage := 2;
    END IF;

    SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO _recent_receipts
    FROM (
      SELECT description AS job, action_value_usd AS amount, state, created_at
      FROM public.receipts_ledger
      WHERE provider_id = _user_id
      ORDER BY created_at DESC LIMIT 5
    ) r;

    SELECT COALESCE(to_jsonb(s), '{}') INTO _sticky
    FROM public.forge_sticky_memory s
    WHERE user_id = _user_id LIMIT 1;

    SELECT COALESCE(jsonb_agg(row_to_json(g)), '[]'::jsonb) INTO _active_goals
    FROM (
      SELECT ig.id, ig.label, ig.period, ig.target_amount, ig.business_vertical,
        COALESCE((
          SELECT SUM(r.action_value_usd)
          FROM public.receipts_ledger r
          WHERE r.provider_id = _user_id
            AND (ig.business_vertical IS NULL OR r.business_vertical = ig.business_vertical)
            AND r.created_at >= date_trunc('month', now())
        ), 0) AS current_amount
      FROM public.income_goals ig
      WHERE ig.user_id = _user_id AND ig.active = true
    ) g;

    _result := jsonb_build_object(
      'full_name',          _profile.full_name,
      'relationship_stage', _stage,
      'conversation_turns', _turn_count,
      'current_streak',     _streak,
      'verified_count',     _verified_count,
      'total_volume',       _total_volume,
      'trust_score',        _trust_score,
      'bottleneck',         _profile.bottleneck,
      'completion_rate',    _profile.completion_rate,
      'income_today',       _income_today,
      'income_week',        _income_week,
      'income_month',       _income_month,
      'income_breakdown',   _breakdown,
      'active_goals',       _active_goals,
      'pipeline',           _pipeline,
      'recent_receipts',    _recent_receipts,
      'open_commitments',   _open_commits,
      'missed_commitments', _missed_commits,
      'crm_opportunities',  _crm,
      'sticky_memory',      _sticky,
      'alerts',             _alerts,
      'preferences',        _prefs,
      'dossier',            CASE WHEN _dossier IS NOT NULL THEN to_jsonb(_dossier) ELSE '{}'::jsonb END,
      'trajectory', CASE WHEN _show_trajectory THEN jsonb_build_object(
        'monthly_goal',       _monthly_goal,
        'projected_end_month', _projected_end,
        'on_pace',            _on_pace,
        'gap',                _gap,
        'per_day_needed',     _per_day_needed,
        'days_remaining',     _days_remaining
      ) ELSE NULL END,
      'trajectory_sentence', CASE WHEN _show_trajectory THEN
        CASE WHEN _on_pace
          THEN 'On pace — projected ' || to_char(_projected_end, 'FM$999,999') || ' vs ' || to_char(_monthly_goal, 'FM$999,999') || ' goal'
          ELSE 'Behind — need ' || to_char(_per_day_needed, 'FM$999,999') || '/day to hit ' || to_char(_monthly_goal, 'FM$999,999') || ' goal'
        END
      ELSE NULL END
    );
  END;

  RETURN _result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_forge_context(UUID) TO service_role, authenticated;
