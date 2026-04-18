-- ============================================
-- FORGE: arsenal_items
-- ============================================
CREATE TABLE public.arsenal_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'asset',
  title text NOT NULL,
  content text NOT NULL,
  source text NOT NULL DEFAULT 'forge_generated',
  confidence_score integer NOT NULL DEFAULT 0,
  use_count integer NOT NULL DEFAULT 0,
  win_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.arsenal_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own arsenal_items"
  ON public.arsenal_items FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own arsenal_items"
  ON public.arsenal_items FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own arsenal_items"
  ON public.arsenal_items FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own arsenal_items"
  ON public.arsenal_items FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX idx_arsenal_items_user ON public.arsenal_items(user_id);

-- ============================================
-- FORGE: forge_directives
-- ============================================
CREATE TABLE public.forge_directives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  directive text NOT NULL,
  confidence_score integer NOT NULL DEFAULT 0,
  generated_at timestamptz NOT NULL DEFAULT now(),
  dismissed boolean NOT NULL DEFAULT false
);

ALTER TABLE public.forge_directives ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own forge_directives"
  ON public.forge_directives FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own forge_directives"
  ON public.forge_directives FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own forge_directives"
  ON public.forge_directives FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own forge_directives"
  ON public.forge_directives FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX idx_forge_directives_user_date ON public.forge_directives(user_id, generated_at DESC);

-- ============================================
-- FORGE: arsenal_results
-- ============================================
CREATE TABLE public.arsenal_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  arsenal_item_id uuid NOT NULL REFERENCES public.arsenal_items(id) ON DELETE CASCADE,
  receipt_id uuid REFERENCES public.receipts_ledger(id) ON DELETE SET NULL,
  converted boolean NOT NULL DEFAULT false,
  logged_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.arsenal_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own arsenal_results"
  ON public.arsenal_results FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own arsenal_results"
  ON public.arsenal_results FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own arsenal_results"
  ON public.arsenal_results FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own arsenal_results"
  ON public.arsenal_results FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX idx_arsenal_results_user ON public.arsenal_results(user_id);

-- ============================================
-- FORGE: get_forge_context function
-- ============================================
CREATE OR REPLACE FUNCTION public.get_forge_context(_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name text;
  v_trust_score numeric;
  v_verified_count int;
  v_pending_count int;
  v_disputed_count int;
  v_total_count int;
  v_total_volume numeric;
  v_completion_rate numeric;
  v_dispute_rate numeric;
  v_current_streak int := 0;
  v_bottleneck text;
  v_recent jsonb;
  v_check_date date := CURRENT_DATE;
  v_has_day boolean;
BEGIN
  -- Operator name
  SELECT full_name INTO v_full_name
  FROM public.user_profiles
  WHERE user_id = _user_id;

  -- Trust score
  v_trust_score := public.calculate_trust_score(_user_id);

  -- Aggregate counts/volume
  SELECT
    COUNT(*) FILTER (WHERE verification_state = 'VERIFIED'),
    COUNT(*) FILTER (WHERE verification_state = 'PENDING'),
    COUNT(*) FILTER (WHERE verification_state = 'DISPUTED'),
    COUNT(*),
    COALESCE(SUM(action_value_usd) FILTER (WHERE verification_state = 'VERIFIED'), 0)
  INTO v_verified_count, v_pending_count, v_disputed_count, v_total_count, v_total_volume
  FROM public.receipts_ledger
  WHERE provider_id = _user_id;

  -- Rates
  v_completion_rate := CASE WHEN v_total_count > 0
    THEN ROUND((v_verified_count::numeric / v_total_count) * 100, 1)
    ELSE 0 END;
  v_dispute_rate := CASE WHEN v_total_count > 0
    THEN ROUND((v_disputed_count::numeric / v_total_count) * 100, 1)
    ELSE 0 END;

  -- Current streak: consecutive days (ending today or yesterday) with at least one VERIFIED receipt
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
      -- Allow today to be empty without breaking the streak (use yesterday as anchor once)
      IF v_check_date = CURRENT_DATE THEN
        v_check_date := v_check_date - 1;
      ELSE
        EXIT;
      END IF;
    END IF;

    EXIT WHEN v_current_streak > 365;
  END LOOP;

  -- Bottleneck heuristic
  v_bottleneck := CASE
    WHEN v_total_count = 0 THEN 'no_activity'
    WHEN v_pending_count > v_verified_count THEN 'verification'
    WHEN v_dispute_rate > 10 THEN 'disputes'
    WHEN v_completion_rate < 50 THEN 'closing'
    WHEN v_total_volume < 1000 THEN 'pricing'
    WHEN v_verified_count < 10 THEN 'volume'
    ELSE 'scale'
  END;

  -- 5 most recent receipts
  SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_recent
  FROM (
    SELECT action_description AS job, action_value_usd AS amount,
           verification_state AS state, created_at
    FROM public.receipts_ledger
    WHERE provider_id = _user_id
    ORDER BY created_at DESC
    LIMIT 5
  ) r;

  RETURN jsonb_build_object(
    'full_name', COALESCE(v_full_name, 'Operator'),
    'trust_score', v_trust_score,
    'verified_count', v_verified_count,
    'total_volume', v_total_volume,
    'completion_rate', v_completion_rate,
    'dispute_rate', v_dispute_rate,
    'current_streak', v_current_streak,
    'bottleneck', v_bottleneck,
    'recent_receipts', v_recent
  );
END;
$$;