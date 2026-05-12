-- forge_alerts: proactive signal engine output
CREATE TABLE IF NOT EXISTS public.forge_alerts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL CHECK (signal_type IN (
    'velocity_drop','aging_pipeline','goal_behind','missed_pattern',
    'crm_overdue','week_zero','on_pace','streak_risk'
  )),
  message     TEXT NOT NULL,
  data        JSONB DEFAULT '{}'::jsonb,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.forge_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users can manage own alerts"
  ON public.forge_alerts FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS forge_alerts_user_unread
  ON public.forge_alerts (user_id, created_at DESC)
  WHERE read_at IS NULL;

-- Weekly review storage on user_profiles
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS atlas_weekly_review      TEXT,
  ADD COLUMN IF NOT EXISTS atlas_weekly_review_at   TIMESTAMPTZ;

-- Update get_forge_context to include trajectory projection + unread alerts
CREATE OR REPLACE FUNCTION public.get_forge_context(_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _result        JSONB := '{}'::jsonb;
  _profile       RECORD;
  _dossier       RECORD;
  _income_today  NUMERIC := 0;
  _income_week   NUMERIC := 0;
  _income_month  NUMERIC := 0;
  _breakdown     JSONB := '[]'::jsonb;
  _goals         JSONB := '[]'::jsonb;
  _pipeline      JSONB := '[]'::jsonb;
  _open_commits  JSONB := '[]'::jsonb;
  _missed_commits JSONB := '[]'::jsonb;
  _crm           JSONB := '[]'::jsonb;
  _alerts        JSONB := '[]'::jsonb;
  -- trajectory
  _monthly_goal  NUMERIC := 0;
  _days_in_month INT;
  _days_elapsed  INT;
  _days_remaining INT;
  _projected_end NUMERIC := 0;
  _gap           NUMERIC := 0;
  _per_day_needed NUMERIC := 0;
  _on_pace       BOOLEAN := false;
BEGIN
  -- Profile
  SELECT * INTO _profile
  FROM public.user_profiles
  WHERE user_id = _user_id;

  -- Dossier
  SELECT * INTO _dossier
  FROM public.forge_dossier
  WHERE user_id = _user_id;

  -- Income aggregates
  SELECT COALESCE(SUM(action_value_usd), 0) INTO _income_today
  FROM public.receipts_ledger
  WHERE provider_id = _user_id
    AND created_at >= date_trunc('day', now());

  SELECT COALESCE(SUM(action_value_usd), 0) INTO _income_week
  FROM public.receipts_ledger
  WHERE provider_id = _user_id
    AND created_at >= date_trunc('week', now());

  SELECT COALESCE(SUM(action_value_usd), 0) INTO _income_month
  FROM public.receipts_ledger
  WHERE provider_id = _user_id
    AND created_at >= date_trunc('month', now());

  -- 30-day breakdown by vertical
  SELECT COALESCE(jsonb_agg(row_to_json(b)), '[]'::jsonb) INTO _breakdown
  FROM (
    SELECT
      COALESCE(business_vertical, 'Untagged') AS vertical,
      SUM(action_value_usd) AS total,
      COUNT(*) AS job_count
    FROM public.receipts_ledger
    WHERE provider_id = _user_id
      AND created_at >= now() - INTERVAL '30 days'
    GROUP BY 1
    ORDER BY 2 DESC
    LIMIT 10
  ) b;

  -- Active goals with progress
  SELECT COALESCE(jsonb_agg(row_to_json(g)), '[]'::jsonb) INTO _goals
  FROM (
    SELECT
      ig.id,
      ig.label,
      ig.period,
      ig.target_amount,
      ig.business_vertical,
      COALESCE((
        SELECT SUM(r.action_value_usd)
        FROM public.receipts_ledger r
        WHERE r.provider_id = _user_id
          AND (ig.business_vertical IS NULL OR r.business_vertical = ig.business_vertical)
          AND r.created_at >= CASE ig.period
            WHEN 'daily'     THEN date_trunc('day', now())
            WHEN 'weekly'    THEN date_trunc('week', now())
            WHEN 'monthly'   THEN date_trunc('month', now())
            WHEN 'quarterly' THEN date_trunc('quarter', now())
            WHEN 'annual'    THEN date_trunc('year', now())
            ELSE date_trunc('month', now())
          END
      ), 0) AS current_amount
    FROM public.income_goals ig
    WHERE ig.user_id = _user_id
      AND ig.is_active = true
    ORDER BY ig.created_at
  ) g;

  -- Open pipeline
  SELECT COALESCE(jsonb_agg(row_to_json(p)), '[]'::jsonb) INTO _pipeline
  FROM (
    SELECT id, description, stage, estimated_value, business_vertical, client_name, created_at
    FROM public.income_pipeline
    WHERE user_id = _user_id
      AND stage NOT IN ('won', 'lost')
    ORDER BY estimated_value DESC NULLS LAST
    LIMIT 10
  ) p;

  -- Open commitments
  SELECT COALESCE(jsonb_agg(row_to_json(c)), '[]'::jsonb) INTO _open_commits
  FROM (
    SELECT id, description, made_at, target_date, follow_up_count
    FROM public.forge_commitments
    WHERE user_id = _user_id
      AND resolution_status = 'open'
    ORDER BY made_at ASC
    LIMIT 10
  ) c;

  -- Missed commitments (last 30 days)
  SELECT COALESCE(jsonb_agg(row_to_json(c)), '[]'::jsonb) INTO _missed_commits
  FROM (
    SELECT id, description, made_at, resolved_at
    FROM public.forge_commitments
    WHERE user_id = _user_id
      AND resolution_status = 'missed'
      AND made_at >= now() - INTERVAL '30 days'
    ORDER BY resolved_at DESC
    LIMIT 5
  ) c;

  -- CRM follow-ups (people not contacted in 14+ days)
  SELECT COALESCE(jsonb_agg(row_to_json(cr)), '[]'::jsonb) INTO _crm
  FROM (
    SELECT
      c.id,
      c.full_name AS client_name,
      c.business_name,
      EXTRACT(DAY FROM now() - MAX(COALESCE(ci.interaction_date, c.created_at)))::INT AS days_since_contact
    FROM public.clients c
    LEFT JOIN public.client_interactions ci ON ci.client_id = c.id
    WHERE c.user_id = _user_id
    GROUP BY c.id, c.full_name, c.business_name, c.created_at
    HAVING EXTRACT(DAY FROM now() - MAX(COALESCE(ci.interaction_date, c.created_at))) >= 14
    ORDER BY days_since_contact DESC
    LIMIT 5
  ) cr;

  -- Unread alerts (last 7 days)
  SELECT COALESCE(jsonb_agg(row_to_json(a)), '[]'::jsonb) INTO _alerts
  FROM (
    SELECT id, signal_type, message, data, created_at
    FROM public.forge_alerts
    WHERE user_id = _user_id
      AND read_at IS NULL
      AND created_at >= now() - INTERVAL '7 days'
    ORDER BY created_at DESC
    LIMIT 10
  ) a;

  -- Trajectory projection against monthly goal
  SELECT COALESCE(target_amount, 0) INTO _monthly_goal
  FROM public.income_goals
  WHERE user_id = _user_id
    AND period = 'monthly'
    AND is_active = true
  ORDER BY created_at DESC
  LIMIT 1;

  _days_in_month  := EXTRACT(DAY FROM (date_trunc('month', now()) + INTERVAL '1 month - 1 day'))::INT;
  _days_elapsed   := EXTRACT(DAY FROM now())::INT;
  _days_remaining := _days_in_month - _days_elapsed;

  IF _days_elapsed > 0 THEN
    _projected_end := ROUND((_income_month / _days_elapsed) * _days_in_month, 2);
  END IF;

  IF _monthly_goal > 0 THEN
    _gap := _monthly_goal - _income_month;
    IF _days_remaining > 0 THEN
      _per_day_needed := ROUND(_gap / _days_remaining, 2);
    END IF;
    _on_pace := _projected_end >= _monthly_goal;
  END IF;

  -- Assemble result
  _result := jsonb_build_object(
    -- identity
    'full_name',              COALESCE(_profile.full_name, ''),
    'relationship_stage',     COALESCE(_profile.atlas_relationship_stage, 1),
    'current_streak',         COALESCE(_profile.current_streak, 0),
    'bottleneck',             COALESCE(_profile.bottleneck, 'unknown'),
    'trajectory_sentence',    COALESCE(_profile.trajectory_sentence, ''),
    'weekly_review',          _profile.atlas_weekly_review,
    'weekly_review_at',       _profile.atlas_weekly_review_at,
    -- income
    'income_today',           _income_today,
    'income_week',            _income_week,
    'income_month',           _income_month,
    -- trajectory
    'trajectory', jsonb_build_object(
      'monthly_goal',     _monthly_goal,
      'projected_end',    _projected_end,
      'gap',              _gap,
      'days_remaining',   _days_remaining,
      'per_day_needed',   _per_day_needed,
      'on_pace',          _on_pace
    ),
    -- breakdown & planning
    'business_breakdown',     _breakdown,
    'active_goals',           _goals,
    'pipeline',               _pipeline,
    'crm_opportunities',      _crm,
    -- commitments
    'open_commitments',       _open_commits,
    'missed_commitments',     _missed_commits,
    -- alerts
    'alerts',                 _alerts,
    -- dossier
    'dossier', CASE WHEN _dossier IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
      'full_name',                _dossier.full_name,
      'location',                 _dossier.location,
      'life_context',             _dossier.life_context,
      'money_beliefs',            _dossier.money_beliefs,
      'risk_tolerance',           _dossier.risk_tolerance,
      'decision_style',           _dossier.decision_style,
      'avoidance_pattern',        _dossier.avoidance_pattern,
      'follow_through_pattern',   _dossier.follow_through_pattern,
      'communication_style',      _dossier.communication_style,
      'current_focus',            _dossier.current_focus,
      'current_emotional_signal', _dossier.current_emotional_signal,
      'north_star',               _dossier.north_star,
      'businesses',               COALESCE(_dossier.businesses, '[]'::jsonb),
      'active_ideas',             COALESCE(_dossier.active_ideas, '[]'::jsonb)
    ) END
  );

  RETURN _result;
END;
$$;
