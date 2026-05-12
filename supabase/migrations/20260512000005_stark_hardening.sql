-- ============================================================
-- Stark Hardening Pass
-- ============================================================

-- 1. Deduplication columns + unique constraints
-- forge_directives: one directive per user per day
ALTER TABLE public.forge_directives
  ADD COLUMN IF NOT EXISTS generated_date DATE NOT NULL DEFAULT CURRENT_DATE;

CREATE UNIQUE INDEX IF NOT EXISTS forge_directives_user_day
  ON public.forge_directives (user_id, generated_date);

-- forge_alerts: one alert per user per signal per day
ALTER TABLE public.forge_alerts
  ADD COLUMN IF NOT EXISTS alert_date DATE NOT NULL DEFAULT CURRENT_DATE;

CREATE UNIQUE INDEX IF NOT EXISTS forge_alerts_user_signal_day
  ON public.forge_alerts (user_id, signal_type, alert_date);

-- 2. Extraction failure tracking on forge_dossier
ALTER TABLE public.forge_dossier
  ADD COLUMN IF NOT EXISTS extraction_failure_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_extraction_at TIMESTAMPTZ;

-- 3. Atomic dossier merge — eliminates TypeScript race condition
-- Called from forge_compress instead of the raw REST PATCH
CREATE OR REPLACE FUNCTION public.merge_dossier_updates(
  _user_id        UUID,
  _scalar_updates JSONB    DEFAULT '{}'::jsonb,
  _businesses     JSONB    DEFAULT '[]'::jsonb,
  _ideas          JSONB    DEFAULT '[]'::jsonb,
  _commitments    JSONB    DEFAULT '[]'::jsonb,
  _extraction_ok  BOOLEAN  DEFAULT true
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _current           RECORD;
  _merged_businesses JSONB;
  _merged_ideas      JSONB;
  _upd               JSONB;
  _existing_idx      INT;
  _upd_name          TEXT;
BEGIN
  -- Ensure a row exists then lock it for the duration of this transaction.
  -- ON CONFLICT ensures we never create duplicates even under concurrent inserts.
  INSERT INTO public.forge_dossier (user_id)
  VALUES (_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO _current
  FROM public.forge_dossier
  WHERE user_id = _user_id
  FOR UPDATE;

  -- ── Merge businesses by name ──────────────────────────────────
  _merged_businesses := COALESCE(_current.businesses, '[]'::jsonb);
  IF jsonb_typeof(_businesses) = 'array' THEN
    FOR _upd IN SELECT value FROM jsonb_array_elements(_businesses) LOOP
      _upd_name := lower(_upd->>'name');
      IF _upd_name IS NULL OR _upd_name = '' THEN CONTINUE; END IF;

      SELECT idx - 1 INTO _existing_idx
      FROM (
        SELECT ordinality AS idx
        FROM jsonb_array_elements(_merged_businesses) WITH ORDINALITY
        WHERE lower(value->>'name') = _upd_name
        LIMIT 1
      ) t;

      IF _existing_idx IS NOT NULL THEN
        _merged_businesses := jsonb_set(
          _merged_businesses,
          ARRAY[_existing_idx::text],
          (_merged_businesses -> _existing_idx) || _upd || jsonb_build_object('last_discussed', now())
        );
      ELSE
        _merged_businesses := _merged_businesses
          || jsonb_build_array(_upd || jsonb_build_object('last_discussed', now()));
      END IF;
    END LOOP;
  END IF;

  -- ── Merge ideas by name ───────────────────────────────────────
  _merged_ideas := COALESCE(_current.active_ideas, '[]'::jsonb);
  IF jsonb_typeof(_ideas) = 'array' THEN
    FOR _upd IN SELECT value FROM jsonb_array_elements(_ideas) LOOP
      _upd_name := lower(_upd->>'name');
      IF _upd_name IS NULL OR _upd_name = '' THEN CONTINUE; END IF;

      SELECT idx - 1 INTO _existing_idx
      FROM (
        SELECT ordinality AS idx
        FROM jsonb_array_elements(_merged_ideas) WITH ORDINALITY
        WHERE lower(value->>'name') = _upd_name
        LIMIT 1
      ) t;

      IF _existing_idx IS NOT NULL THEN
        _merged_ideas := jsonb_set(
          _merged_ideas,
          ARRAY[_existing_idx::text],
          (_merged_ideas -> _existing_idx) || _upd || jsonb_build_object('last_discussed', now())
        );
      ELSE
        _merged_ideas := _merged_ideas
          || jsonb_build_array(_upd || jsonb_build_object('last_discussed', now()));
      END IF;
    END LOOP;
  END IF;

  -- ── Apply scalar updates ──────────────────────────────────────
  UPDATE public.forge_dossier SET
    money_beliefs            = COALESCE(NULLIF(_scalar_updates->>'money_beliefs', ''), money_beliefs),
    risk_posture             = COALESCE(NULLIF(_scalar_updates->>'risk_posture', ''), risk_posture),
    decision_pattern         = COALESCE(NULLIF(_scalar_updates->>'decision_pattern', ''), decision_pattern),
    follow_through_pattern   = COALESCE(NULLIF(_scalar_updates->>'follow_through_pattern', ''), follow_through_pattern),
    avoidance_pattern        = COALESCE(NULLIF(_scalar_updates->>'avoidance_pattern', ''), avoidance_pattern),
    current_phase            = COALESCE(NULLIF(_scalar_updates->>'current_phase', ''), current_phase),
    current_focus            = COALESCE(NULLIF(_scalar_updates->>'current_focus', ''), current_focus),
    emotional_baseline       = COALESCE(NULLIF(_scalar_updates->>'emotional_baseline', ''), emotional_baseline),
    current_emotional_signal = COALESCE(NULLIF(_scalar_updates->>'current_emotional_signal', ''), current_emotional_signal),
    last_heavy_exchange      = COALESCE(NULLIF(_scalar_updates->>'last_heavy_exchange', ''), last_heavy_exchange),
    last_heavy_exchange_at   = CASE
      WHEN _scalar_updates->>'last_heavy_exchange' IS NOT NULL
        AND _scalar_updates->>'last_heavy_exchange' != ''
      THEN now()
      ELSE last_heavy_exchange_at
    END,
    businesses               = _merged_businesses,
    active_ideas             = _merged_ideas,
    extraction_failure_count = CASE WHEN _extraction_ok THEN 0 ELSE extraction_failure_count + 1 END,
    last_extraction_at       = CASE WHEN _extraction_ok THEN now() ELSE last_extraction_at END,
    updated_at               = now()
  WHERE user_id = _user_id;

  -- ── Insert new commitments ────────────────────────────────────
  IF jsonb_typeof(_commitments) = 'array' THEN
    FOR _upd IN SELECT value FROM jsonb_array_elements(_commitments) LOOP
      CONTINUE WHEN (_upd->>'description') IS NULL OR (_upd->>'description') = '';
      INSERT INTO public.forge_commitments (user_id, description, target_date)
      VALUES (
        _user_id,
        left(_upd->>'description', 300),
        CASE WHEN (_upd->>'target_date') ~ '^\d{4}-\d{2}-\d{2}$'
             THEN (_upd->>'target_date')::date ELSE NULL END
      );
    END LOOP;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.merge_dossier_updates(UUID, JSONB, JSONB, JSONB, JSONB, BOOLEAN)
  TO service_role;

-- 4. Fix trajectory projection: don't surface on day 1 of month
-- Update get_forge_context to guard against division by zero and day-1 false negatives.
-- Re-create the function with the fix inline.
CREATE OR REPLACE FUNCTION public.get_forge_context(_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
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
            WHEN 'annual'    THEN date_trunc('year',   now())
            ELSE                  date_trunc('month',  now())
          END
      ), 0) AS current_amount
    FROM public.income_goals ig
    WHERE ig.user_id = _user_id AND ig.is_active = true
    ORDER BY ig.created_at
  ) g;

  SELECT COALESCE(jsonb_agg(row_to_json(p)), '[]'::jsonb) INTO _pipeline
  FROM (
    SELECT id, description, stage, estimated_value, business_vertical, client_name, created_at
    FROM public.income_pipeline
    WHERE user_id = _user_id AND stage NOT IN ('won','lost')
    ORDER BY estimated_value DESC NULLS LAST LIMIT 10
  ) p;

  SELECT COALESCE(jsonb_agg(row_to_json(c)), '[]'::jsonb) INTO _open_commits
  FROM (
    SELECT id, description, made_at, target_date, follow_up_count
    FROM public.forge_commitments
    WHERE user_id = _user_id AND resolution_status = 'open'
    ORDER BY made_at ASC LIMIT 10
  ) c;

  SELECT COALESCE(jsonb_agg(row_to_json(c)), '[]'::jsonb) INTO _missed_commits
  FROM (
    SELECT id, description, made_at, resolved_at
    FROM public.forge_commitments
    WHERE user_id = _user_id AND resolution_status = 'missed'
      AND made_at >= now() - INTERVAL '30 days'
    ORDER BY resolved_at DESC LIMIT 5
  ) c;

  SELECT COALESCE(jsonb_agg(row_to_json(cr)), '[]'::jsonb) INTO _crm
  FROM (
    SELECT c.id,
           c.full_name AS client_name,
           c.business_name,
           EXTRACT(DAY FROM now() - MAX(COALESCE(ci.interaction_date, c.created_at)))::INT AS days_since_contact
    FROM public.clients c
    LEFT JOIN public.client_interactions ci ON ci.client_id = c.id
    WHERE c.user_id = _user_id
    GROUP BY c.id, c.full_name, c.business_name, c.created_at
    HAVING EXTRACT(DAY FROM now() - MAX(COALESCE(ci.interaction_date, c.created_at))) >= 14
    ORDER BY days_since_contact DESC LIMIT 5
  ) cr;

  SELECT COALESCE(jsonb_agg(row_to_json(a)), '[]'::jsonb) INTO _alerts
  FROM (
    SELECT id, signal_type, message, data, created_at
    FROM public.forge_alerts
    WHERE user_id = _user_id AND read_at IS NULL
      AND created_at >= now() - INTERVAL '7 days'
    ORDER BY created_at DESC LIMIT 10
  ) a;

  -- Trajectory: only surface if >= 3 days elapsed AND monthly goal set
  SELECT COALESCE(target_amount,0) INTO _monthly_goal
  FROM public.income_goals
  WHERE user_id = _user_id AND period = 'monthly' AND is_active = true
  ORDER BY created_at DESC LIMIT 1;

  _days_in_month  := EXTRACT(DAY FROM (date_trunc('month', now()) + INTERVAL '1 month - 1 day'))::INT;
  _days_elapsed   := EXTRACT(DAY FROM now())::INT;
  _days_remaining := _days_in_month - _days_elapsed;
  _show_trajectory := _monthly_goal > 0 AND _days_elapsed >= 3;

  IF _show_trajectory THEN
    _projected_end  := ROUND((_income_month / _days_elapsed) * _days_in_month, 2);
    _gap            := GREATEST(0, _monthly_goal - _income_month);
    _per_day_needed := CASE WHEN _days_remaining > 0 THEN ROUND(_gap / _days_remaining, 2) ELSE 0 END;
    _on_pace        := _projected_end >= _monthly_goal;
  END IF;

  _result := jsonb_build_object(
    'full_name',           COALESCE(_profile.full_name,''),
    'relationship_stage',  COALESCE(_profile.atlas_relationship_stage, 1),
    'current_streak',      COALESCE(_profile.current_streak, 0),
    'bottleneck',          COALESCE(_profile.bottleneck,'unknown'),
    'trajectory_sentence', COALESCE(_profile.trajectory_sentence,''),
    'weekly_review',       _profile.atlas_weekly_review,
    'weekly_review_at',    _profile.atlas_weekly_review_at,
    'income_today',        _income_today,
    'income_week',         _income_week,
    'income_month',        _income_month,
    'trajectory', CASE WHEN _show_trajectory THEN jsonb_build_object(
      'monthly_goal',   _monthly_goal,
      'projected_end',  _projected_end,
      'gap',            _gap,
      'days_remaining', _days_remaining,
      'per_day_needed', _per_day_needed,
      'on_pace',        _on_pace
    ) ELSE NULL END,
    'business_breakdown',  _breakdown,
    'active_goals',        _goals,
    'pipeline',            _pipeline,
    'crm_opportunities',   _crm,
    'open_commitments',    _open_commits,
    'missed_commitments',  _missed_commits,
    'alerts',              _alerts,
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
      'active_ideas',             COALESCE(_dossier.active_ideas, '[]'::jsonb),
      'extraction_failure_count', _dossier.extraction_failure_count,
      'last_extraction_at',       _dossier.last_extraction_at
    ) END
  );

  RETURN _result;
END;
$$;
