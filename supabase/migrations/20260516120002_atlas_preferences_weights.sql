-- atlas_preferences: system-level agent configuration per user
-- Stores RL feedback data: play_type_weights learned from atlas_play_ranker

CREATE TABLE IF NOT EXISTS public.atlas_preferences (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  play_type_weights JSONB DEFAULT '{}',
  agent_config    JSONB DEFAULT '{}',
  updated_at      timestamptz DEFAULT now(),
  UNIQUE (user_id)
);

ALTER TABLE public.atlas_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "prefs_own_select" ON public.atlas_preferences
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY IF NOT EXISTS "prefs_service_all" ON public.atlas_preferences
  FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_atlas_preferences_user ON public.atlas_preferences(user_id);

GRANT SELECT, INSERT, UPDATE ON public.atlas_preferences TO service_role;
GRANT SELECT ON public.atlas_preferences TO authenticated;
