-- ============================================================
-- Wayne Protocol: audit trail, rate limiting, message archive,
-- field constraints, operator corrections, data export
-- ============================================================

-- 1. dossier_versions: immutable audit log of every field change
CREATE TABLE IF NOT EXISTS public.dossier_versions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  field_name  TEXT        NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  source      TEXT        NOT NULL DEFAULT 'extraction', -- extraction | user_correction | system
  confidence  TEXT        NOT NULL DEFAULT 'inferred',   -- low_signal | inferred | confirmed
  session_id  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dossier_versions_user_field
  ON public.dossier_versions(user_id, field_name, created_at DESC);

ALTER TABLE public.dossier_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own dossier versions" ON public.dossier_versions;
CREATE POLICY "Users see own dossier versions" ON public.dossier_versions
  FOR SELECT USING (auth.uid() = user_id);

-- 2. forge_message_archive: cold storage of compressed conversations
CREATE TABLE IF NOT EXISTS public.forge_message_archive (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_date  DATE        NOT NULL DEFAULT CURRENT_DATE,
  messages      JSONB       NOT NULL DEFAULT '[]',
  message_count INT         NOT NULL DEFAULT 0,
  archived_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS forge_message_archive_user_date
  ON public.forge_message_archive(user_id, session_date DESC);

ALTER TABLE public.forge_message_archive ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own message archive" ON public.forge_message_archive;
CREATE POLICY "Users see own message archive" ON public.forge_message_archive
  FOR SELECT USING (auth.uid() = user_id);

-- 3. forge_rate_limits: per-user per-minute token bucket
CREATE TABLE IF NOT EXISTS public.forge_rate_limits (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  function_name TEXT        NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  request_count INT         NOT NULL DEFAULT 1,
  CONSTRAINT forge_rate_limits_user_fn_window UNIQUE (user_id, function_name, window_start)
);

CREATE INDEX IF NOT EXISTS forge_rate_limits_lookup
  ON public.forge_rate_limits(user_id, function_name, window_start DESC);

-- 4. Field-length constraints on psychological TEXT columns (500 bytes max)
--    Use NOT VALID so existing rows are not scanned — new writes are enforced.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_money_beliefs_len') THEN
    ALTER TABLE public.forge_dossier
      ADD CONSTRAINT chk_money_beliefs_len CHECK (octet_length(money_beliefs) <= 500) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_avoidance_pattern_len') THEN
    ALTER TABLE public.forge_dossier
      ADD CONSTRAINT chk_avoidance_pattern_len CHECK (octet_length(avoidance_pattern) <= 500) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_decision_pattern_len') THEN
    ALTER TABLE public.forge_dossier
      ADD CONSTRAINT chk_decision_pattern_len CHECK (octet_length(decision_pattern) <= 500) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_follow_through_len') THEN
    ALTER TABLE public.forge_dossier
      ADD CONSTRAINT chk_follow_through_len CHECK (octet_length(follow_through_pattern) <= 500) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_emotional_baseline_len') THEN
    ALTER TABLE public.forge_dossier
      ADD CONSTRAINT chk_emotional_baseline_len CHECK (octet_length(emotional_baseline) <= 500) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_emotional_signal_len') THEN
    ALTER TABLE public.forge_dossier
      ADD CONSTRAINT chk_emotional_signal_len CHECK (octet_length(current_emotional_signal) <= 500) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_last_heavy_exchange_len') THEN
    ALTER TABLE public.forge_dossier
      ADD CONSTRAINT chk_last_heavy_exchange_len CHECK (octet_length(last_heavy_exchange) <= 500) NOT VALID;
  END IF;
END $$;

-- 5. Per-user rate-limit check function
--    Returns TRUE if request is allowed, FALSE if limit exceeded.
--    Prunes stale windows to keep the table lean.
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  _user_id    UUID,
  _function   TEXT,
  _max_req    INT,
  _window_sec INT DEFAULT 60
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _window_start TIMESTAMPTZ := date_trunc('minute', now());
  _total        INT;
BEGIN
  DELETE FROM public.forge_rate_limits
  WHERE user_id = _user_id
    AND function_name = _function
    AND window_start < now() - (_window_sec * 2 || ' seconds')::INTERVAL;

  SELECT COALESCE(SUM(request_count), 0) INTO _total
  FROM public.forge_rate_limits
  WHERE user_id = _user_id
    AND function_name = _function
    AND window_start >= now() - (_window_sec || ' seconds')::INTERVAL;

  IF _total >= _max_req THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.forge_rate_limits (user_id, function_name, window_start, request_count)
  VALUES (_user_id, _function, _window_start, 1)
  ON CONFLICT ON CONSTRAINT forge_rate_limits_user_fn_window
  DO UPDATE SET request_count = forge_rate_limits.request_count + 1;

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_rate_limit(UUID, TEXT, INT, INT) TO service_role;

-- 6. User-initiated dossier field correction
--    Called by authenticated users — rewrites a single psychological field
--    and writes an audit trail entry with source='user_correction'.
CREATE OR REPLACE FUNCTION public.correct_dossier_field(
  _field_name TEXT,
  _new_value  TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id       UUID   := auth.uid();
  _allowed_fields TEXT[] := ARRAY[
    'money_beliefs','risk_posture','decision_pattern','follow_through_pattern',
    'avoidance_pattern','current_phase','current_focus','emotional_baseline',
    'current_emotional_signal','last_heavy_exchange'
  ];
  _old_val TEXT;
  _trimmed TEXT;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (_field_name = ANY(_allowed_fields)) THEN
    RAISE EXCEPTION 'Field % is not user-editable', _field_name;
  END IF;

  _trimmed := left(COALESCE(_new_value, ''), 500);

  INSERT INTO public.forge_dossier (user_id) VALUES (_user_id) ON CONFLICT (user_id) DO NOTHING;

  EXECUTE format('SELECT %I FROM public.forge_dossier WHERE user_id = $1', _field_name)
  INTO _old_val USING _user_id;

  INSERT INTO public.dossier_versions (user_id, field_name, old_value, new_value, source, confidence)
  VALUES (_user_id, _field_name, _old_val, _trimmed, 'user_correction', 'confirmed');

  EXECUTE format(
    'UPDATE public.forge_dossier SET %I = $1, updated_at = now() WHERE user_id = $2',
    _field_name
  ) USING _trimmed, _user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.correct_dossier_field(TEXT, TEXT) TO authenticated;

-- 7. Operator data export — returns a full JSON bundle for download
CREATE OR REPLACE FUNCTION public.export_operator_data(_user_id UUID DEFAULT auth.uid())
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _dossier  JSONB;
  _goals    JSONB;
  _pipeline JSONB;
  _commits  JSONB;
  _receipts JSONB;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() != _user_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT row_to_json(d)::jsonb INTO _dossier
  FROM public.forge_dossier d WHERE user_id = _user_id;

  SELECT COALESCE(jsonb_agg(row_to_json(g)), '[]') INTO _goals
  FROM public.income_goals g WHERE user_id = _user_id;

  SELECT COALESCE(jsonb_agg(row_to_json(p)), '[]') INTO _pipeline
  FROM public.income_pipeline p WHERE user_id = _user_id;

  SELECT COALESCE(jsonb_agg(row_to_json(c) ORDER BY c.made_at DESC), '[]') INTO _commits
  FROM public.forge_commitments c WHERE user_id = _user_id;

  SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.created_at DESC), '[]') INTO _receipts
  FROM (
    SELECT * FROM public.receipts_ledger WHERE provider_id = _user_id ORDER BY created_at DESC LIMIT 500
  ) r;

  RETURN jsonb_build_object(
    'exported_at', now(),
    'dossier',     COALESCE(_dossier, '{}'),
    'goals',       COALESCE(_goals, '[]'),
    'pipeline',    COALESCE(_pipeline, '[]'),
    'commitments', COALESCE(_commits, '[]'),
    'receipts',    COALESCE(_receipts, '[]')
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.export_operator_data(UUID) TO authenticated;

-- 8. Replace merge_dossier_updates with new signature:
--    adds _session_id TEXT and _is_intake BOOLEAN for audit trail + confidence tagging.
--    Drop old 6-param signature first to avoid overload ambiguity.
DROP FUNCTION IF EXISTS public.merge_dossier_updates(UUID, JSONB, JSONB, JSONB, JSONB, BOOLEAN);

CREATE OR REPLACE FUNCTION public.merge_dossier_updates(
  _user_id        UUID,
  _scalar_updates JSONB    DEFAULT '{}'::jsonb,
  _businesses     JSONB    DEFAULT '[]'::jsonb,
  _ideas          JSONB    DEFAULT '[]'::jsonb,
  _commitments    JSONB    DEFAULT '[]'::jsonb,
  _extraction_ok  BOOLEAN  DEFAULT true,
  _session_id     TEXT     DEFAULT NULL,
  _is_intake      BOOLEAN  DEFAULT false
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
  _confidence        TEXT;
  _scalar_fields     TEXT[] := ARRAY[
    'money_beliefs','risk_posture','decision_pattern','follow_through_pattern',
    'avoidance_pattern','current_phase','current_focus','emotional_baseline',
    'current_emotional_signal','last_heavy_exchange'
  ];
  _field             TEXT;
  _new_val           TEXT;
  _old_val           TEXT;
BEGIN
  _confidence := CASE WHEN _is_intake THEN 'low_signal' ELSE 'inferred' END;

  INSERT INTO public.forge_dossier (user_id)
  VALUES (_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO _current
  FROM public.forge_dossier
  WHERE user_id = _user_id
  FOR UPDATE;

  -- ── Audit trail: record changed scalar fields ─────────────────
  IF _extraction_ok AND _scalar_updates != '{}'::jsonb THEN
    FOREACH _field IN ARRAY _scalar_fields LOOP
      _new_val := NULLIF(_scalar_updates ->> _field, '');
      IF _new_val IS NOT NULL THEN
        _old_val := (row_to_json(_current)::jsonb) ->> _field;
        IF COALESCE(_old_val, '') IS DISTINCT FROM _new_val THEN
          INSERT INTO public.dossier_versions
            (user_id, field_name, old_value, new_value, source, confidence, session_id)
          VALUES
            (_user_id, _field, _old_val, left(_new_val, 500), 'extraction', _confidence, _session_id);
        END IF;
      END IF;
    END LOOP;
  END IF;

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

  -- ── Apply scalar updates with 500-byte length guard ───────────
  UPDATE public.forge_dossier SET
    money_beliefs            = COALESCE(NULLIF(left(_scalar_updates->>'money_beliefs',          500), ''), money_beliefs),
    risk_posture             = COALESCE(NULLIF(     _scalar_updates->>'risk_posture',                  ''), risk_posture),
    decision_pattern         = COALESCE(NULLIF(left(_scalar_updates->>'decision_pattern',        500), ''), decision_pattern),
    follow_through_pattern   = COALESCE(NULLIF(left(_scalar_updates->>'follow_through_pattern',  500), ''), follow_through_pattern),
    avoidance_pattern        = COALESCE(NULLIF(left(_scalar_updates->>'avoidance_pattern',       500), ''), avoidance_pattern),
    current_phase            = COALESCE(NULLIF(     _scalar_updates->>'current_phase',                 ''), current_phase),
    current_focus            = COALESCE(NULLIF(left(_scalar_updates->>'current_focus',           500), ''), current_focus),
    emotional_baseline       = COALESCE(NULLIF(left(_scalar_updates->>'emotional_baseline',      500), ''), emotional_baseline),
    current_emotional_signal = COALESCE(NULLIF(left(_scalar_updates->>'current_emotional_signal',500), ''), current_emotional_signal),
    last_heavy_exchange      = COALESCE(NULLIF(left(_scalar_updates->>'last_heavy_exchange',     500), ''), last_heavy_exchange),
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

GRANT EXECUTE ON FUNCTION
  public.merge_dossier_updates(UUID, JSONB, JSONB, JSONB, JSONB, BOOLEAN, TEXT, BOOLEAN)
  TO service_role;
