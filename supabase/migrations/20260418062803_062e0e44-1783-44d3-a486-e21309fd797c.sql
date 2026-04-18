-- 1. skyforge_clients table
CREATE TABLE public.skyforge_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_name text NOT NULL,
  client_email text,
  client_phone text,
  total_spend numeric NOT NULL DEFAULT 0,
  job_count integer NOT NULL DEFAULT 0,
  last_job_date date,
  last_job_type text,
  next_followup_date date,
  followup_status text NOT NULL DEFAULT 'pending',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_name)
);

ALTER TABLE public.skyforge_clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own clients"
  ON public.skyforge_clients FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own clients"
  ON public.skyforge_clients FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own clients"
  ON public.skyforge_clients FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own clients"
  ON public.skyforge_clients FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX idx_skyforge_clients_user ON public.skyforge_clients(user_id);
CREATE INDEX idx_skyforge_clients_followup ON public.skyforge_clients(user_id, next_followup_date);

-- 2. Trigger: auto-upsert client on verified receipt
CREATE OR REPLACE FUNCTION public.sync_client_from_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text;
  v_amount numeric;
  v_date date;
  v_type text;
BEGIN
  -- Only act when receipt is VERIFIED
  IF NEW.verification_state <> 'VERIFIED' THEN
    RETURN NEW;
  END IF;

  -- For UPDATEs, only run when the state changed into VERIFIED
  IF TG_OP = 'UPDATE' AND OLD.verification_state = 'VERIFIED' THEN
    RETURN NEW;
  END IF;

  v_name := NULLIF(TRIM(COALESCE(NEW.client_name, '')), '');
  IF v_name IS NULL THEN
    RETURN NEW;
  END IF;

  v_amount := COALESCE(NEW.action_value_usd, 0);
  v_date := NEW.created_at::date;
  v_type := NEW.action_description;

  INSERT INTO public.skyforge_clients (
    user_id, client_name, total_spend, job_count, last_job_date, last_job_type
  )
  VALUES (NEW.provider_id, v_name, v_amount, 1, v_date, v_type)
  ON CONFLICT (user_id, client_name) DO UPDATE
    SET total_spend = public.skyforge_clients.total_spend + EXCLUDED.total_spend,
        job_count = public.skyforge_clients.job_count + 1,
        last_job_date = GREATEST(COALESCE(public.skyforge_clients.last_job_date, EXCLUDED.last_job_date), EXCLUDED.last_job_date),
        last_job_type = EXCLUDED.last_job_type;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_client_from_receipt
AFTER INSERT OR UPDATE OF verification_state ON public.receipts_ledger
FOR EACH ROW
EXECUTE FUNCTION public.sync_client_from_receipt();

-- 3. get_crm_opportunities
CREATE OR REPLACE FUNCTION public.get_crm_opportunities(_user_id uuid)
RETURNS SETOF public.skyforge_clients
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT *
  FROM public.skyforge_clients
  WHERE user_id = _user_id
    AND followup_status <> 'completed'
    AND (
      (next_followup_date IS NOT NULL
        AND next_followup_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days')
      OR (last_job_date IS NOT NULL
        AND last_job_date < CURRENT_DATE - INTERVAL '90 days')
    )
  ORDER BY
    CASE WHEN next_followup_date IS NOT NULL THEN next_followup_date END ASC NULLS LAST,
    last_job_date ASC NULLS LAST;
$$;

-- 4. Update get_forge_context to include CRM opportunities
CREATE OR REPLACE FUNCTION public.get_forge_context(_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
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
  v_crm jsonb;
  v_check_date date := CURRENT_DATE;
  v_has_day boolean;
BEGIN
  SELECT full_name INTO v_full_name FROM public.user_profiles WHERE user_id = _user_id;
  v_trust_score := public.calculate_trust_score(_user_id);

  SELECT
    COUNT(*) FILTER (WHERE verification_state = 'VERIFIED'),
    COUNT(*) FILTER (WHERE verification_state = 'PENDING'),
    COUNT(*) FILTER (WHERE verification_state = 'DISPUTED'),
    COUNT(*),
    COALESCE(SUM(action_value_usd) FILTER (WHERE verification_state = 'VERIFIED'), 0)
  INTO v_verified_count, v_pending_count, v_disputed_count, v_total_count, v_total_volume
  FROM public.receipts_ledger
  WHERE provider_id = _user_id;

  v_completion_rate := CASE WHEN v_total_count > 0
    THEN ROUND((v_verified_count::numeric / v_total_count) * 100, 1) ELSE 0 END;
  v_dispute_rate := CASE WHEN v_total_count > 0
    THEN ROUND((v_disputed_count::numeric / v_total_count) * 100, 1) ELSE 0 END;

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
      IF v_check_date = CURRENT_DATE THEN
        v_check_date := v_check_date - 1;
      ELSE
        EXIT;
      END IF;
    END IF;
    EXIT WHEN v_current_streak > 365;
  END LOOP;

  v_bottleneck := CASE
    WHEN v_total_count = 0 THEN 'no_activity'
    WHEN v_pending_count > v_verified_count THEN 'verification'
    WHEN v_dispute_rate > 10 THEN 'disputes'
    WHEN v_completion_rate < 50 THEN 'closing'
    WHEN v_total_volume < 1000 THEN 'pricing'
    WHEN v_verified_count < 10 THEN 'volume'
    ELSE 'scale'
  END;

  SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_recent
  FROM (
    SELECT action_description AS job, action_value_usd AS amount,
           verification_state AS state, created_at
    FROM public.receipts_ledger
    WHERE provider_id = _user_id
    ORDER BY created_at DESC LIMIT 5
  ) r;

  -- Top 3 CRM opportunities with estimated re-engagement value (avg job size)
  SELECT COALESCE(jsonb_agg(o), '[]'::jsonb) INTO v_crm
  FROM (
    SELECT
      client_name,
      last_job_type AS last_job,
      CASE WHEN last_job_date IS NOT NULL
        THEN (CURRENT_DATE - last_job_date)
        ELSE NULL END AS days_since_contact,
      CASE WHEN job_count > 0
        THEN ROUND(total_spend / job_count, 2)
        ELSE 0 END AS estimated_value
    FROM public.get_crm_opportunities(_user_id)
    LIMIT 3
  ) o;

  RETURN jsonb_build_object(
    'full_name', COALESCE(v_full_name, 'Operator'),
    'trust_score', v_trust_score,
    'verified_count', v_verified_count,
    'total_volume', v_total_volume,
    'completion_rate', v_completion_rate,
    'dispute_rate', v_dispute_rate,
    'current_streak', v_current_streak,
    'bottleneck', v_bottleneck,
    'recent_receipts', v_recent,
    'crm_opportunities', v_crm
  );
END;
$$;