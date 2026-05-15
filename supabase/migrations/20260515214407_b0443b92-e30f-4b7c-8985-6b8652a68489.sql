CREATE TABLE IF NOT EXISTS public.trade_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry_price NUMERIC(18,8) NOT NULL,
  exit_price NUMERIC(18,8),
  quantity NUMERIC(18,8) NOT NULL,
  broker TEXT NOT NULL,
  broker_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  pnl_usd NUMERIC(12,2),
  pnl_pct NUMERIC(8,4),
  thesis TEXT,
  tags TEXT[],
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.trade_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their trades" ON public.trade_ledger FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.market_watchlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  display_name TEXT,
  notes TEXT,
  alert_price_high NUMERIC(18,8),
  alert_price_low NUMERIC(18,8),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.market_watchlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their watchlist" ON public.market_watchlist FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.research_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  note_type TEXT NOT NULL,
  obsidian_path TEXT,
  synced_to_obsidian BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.research_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their research" ON public.research_notes FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.trading_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  broker TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_type TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  balance_usd NUMERIC(12,2),
  buying_power_usd NUMERIC(12,2),
  last_sync_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.trading_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their trading accounts" ON public.trading_accounts FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.atlas_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  result JSONB,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.atlas_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their tasks" ON public.atlas_tasks FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.forge_dossier
  ADD COLUMN IF NOT EXISTS preferred_asset_classes TEXT,
  ADD COLUMN IF NOT EXISTS risk_tolerance TEXT,
  ADD COLUMN IF NOT EXISTS trading_goals TEXT,
  ADD COLUMN IF NOT EXISTS max_drawdown_pct TEXT,
  ADD COLUMN IF NOT EXISTS preferred_pairs TEXT;

CREATE OR REPLACE FUNCTION public.correct_dossier_field(_field_name TEXT, _new_value TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _allowed TEXT[] := ARRAY['money_beliefs','risk_posture','decision_pattern','follow_through_pattern','avoidance_pattern','current_phase','current_focus','emotional_baseline','current_emotional_signal','last_heavy_exchange','preferred_asset_classes','risk_tolerance','trading_goals','max_drawdown_pct','preferred_pairs'];
BEGIN
  IF NOT (_field_name = ANY(_allowed)) THEN
    RAISE EXCEPTION 'Field % is not editable', _field_name;
  END IF;
  INSERT INTO public.forge_dossier (user_id) VALUES (auth.uid()) ON CONFLICT (user_id) DO NOTHING;
  EXECUTE format('UPDATE public.forge_dossier SET %I = $1, updated_at = now() WHERE user_id = $2', _field_name)
    USING _new_value, auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.export_operator_data()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
BEGIN
  RETURN jsonb_build_object(
    'profile',     (SELECT to_jsonb(p) FROM public.user_profiles p WHERE p.user_id = _uid),
    'dossier',     (SELECT to_jsonb(d) FROM public.forge_dossier d WHERE d.user_id = _uid),
    'receipts',    (SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM public.receipts_ledger r WHERE r.provider_id = _uid),
    'commitments', (SELECT coalesce(jsonb_agg(c), '[]'::jsonb) FROM public.forge_commitments c WHERE c.user_id = _uid),
    'arsenal',     (SELECT coalesce(jsonb_agg(a), '[]'::jsonb) FROM public.arsenal_items a WHERE a.user_id = _uid),
    'clients',     (SELECT coalesce(jsonb_agg(s), '[]'::jsonb) FROM public.skyforge_clients s WHERE s.user_id = _uid),
    'exported_at', now()
  );
END;
$$;