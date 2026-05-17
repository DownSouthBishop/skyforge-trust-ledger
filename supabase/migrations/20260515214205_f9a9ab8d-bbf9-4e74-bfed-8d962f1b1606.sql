-- forge_dossier: rich persistent operator profile
CREATE TABLE IF NOT EXISTS public.forge_dossier (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  trade TEXT,
  market TEXT,
  years_in_business INT,
  team_size TEXT,
  money_beliefs TEXT,
  risk_posture TEXT,
  decision_pattern TEXT,
  follow_through_pattern TEXT,
  avoidance_pattern TEXT,
  current_phase TEXT,
  current_focus TEXT,
  emotional_baseline TEXT,
  current_emotional_signal TEXT,
  last_heavy_exchange TEXT,
  last_heavy_exchange_at TIMESTAMPTZ,
  conversation_count_at_last_update INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.forge_dossier ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own dossier" ON public.forge_dossier FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own dossier" ON public.forge_dossier FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own dossier" ON public.forge_dossier FOR UPDATE USING (auth.uid() = user_id);
CREATE TRIGGER update_forge_dossier_updated_at BEFORE UPDATE ON public.forge_dossier FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- forge_commitments
CREATE TABLE IF NOT EXISTS public.forge_commitments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  made_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  target_date DATE,
  resolution_status TEXT NOT NULL DEFAULT 'open' CHECK (resolution_status IN ('open','kept','missed','abandoned')),
  resolution_at TIMESTAMPTZ,
  follow_up_count INT NOT NULL DEFAULT 0,
  last_followed_up_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_forge_commitments_user_status ON public.forge_commitments(user_id, resolution_status);
CREATE INDEX IF NOT EXISTS idx_forge_commitments_user_made ON public.forge_commitments(user_id, made_at DESC);
ALTER TABLE public.forge_commitments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own commitments" ON public.forge_commitments FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own commitments" ON public.forge_commitments FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own commitments" ON public.forge_commitments FOR UPDATE USING (auth.uid() = user_id);