ALTER TABLE public.receipts_ledger ADD COLUMN IF NOT EXISTS business_vertical TEXT;

CREATE TABLE IF NOT EXISTS public.income_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_vertical TEXT,
  period TEXT NOT NULL CHECK (period IN ('daily','weekly','monthly','quarterly','annual')),
  target_amount NUMERIC(12,2) NOT NULL,
  label TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.income_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own goals" ON public.income_goals FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER update_income_goals_updated_at BEFORE UPDATE ON public.income_goals FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.income_pipeline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  client_name TEXT,
  estimated_value NUMERIC(12,2),
  stage TEXT NOT NULL DEFAULT 'quoted' CHECK (stage IN ('quoted','in_progress','closing','won','lost')),
  business_vertical TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_income_pipeline_user_stage ON public.income_pipeline(user_id, stage);
ALTER TABLE public.income_pipeline ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own pipeline" ON public.income_pipeline FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER update_income_pipeline_updated_at BEFORE UPDATE ON public.income_pipeline FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.forge_dossier
  ADD COLUMN IF NOT EXISTS businesses JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS active_ideas JSONB DEFAULT '[]'::jsonb;

-- forge_alerts
CREATE TABLE IF NOT EXISTS public.forge_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL,
  message TEXT NOT NULL,
  data JSONB DEFAULT '{}'::jsonb,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.forge_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users can manage own alerts" ON public.forge_alerts FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS forge_alerts_user_unread ON public.forge_alerts (user_id, created_at DESC) WHERE read_at IS NULL;

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS atlas_weekly_review TEXT,
  ADD COLUMN IF NOT EXISTS atlas_weekly_review_at TIMESTAMPTZ;