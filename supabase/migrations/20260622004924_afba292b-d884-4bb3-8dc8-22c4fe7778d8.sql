
-- operator_directives
CREATE TABLE IF NOT EXISTS public.operator_directives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  title text NOT NULL,
  prompt_text text NOT NULL,
  category text NOT NULL DEFAULT 'communication',
  scope text NOT NULL DEFAULT 'all',
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.operator_directives TO authenticated;
GRANT ALL ON public.operator_directives TO service_role;
ALTER TABLE public.operator_directives ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own directives" ON public.operator_directives FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- agent_character_state
CREATE TABLE IF NOT EXISTS public.agent_character_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  developmental_stage text NOT NULL DEFAULT 'early',
  character_summary text,
  voice_evolution text,
  earned_strengths text[] NOT NULL DEFAULT '{}',
  known_blind_spots text[] NOT NULL DEFAULT '{}',
  sycophancy_score numeric NOT NULL DEFAULT 0.5,
  calibration_score numeric NOT NULL DEFAULT 0.5,
  formative_event_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, agent_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_character_state TO authenticated;
GRANT ALL ON public.agent_character_state TO service_role;
ALTER TABLE public.agent_character_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own character" ON public.agent_character_state FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- agent_formative_events
CREATE TABLE IF NOT EXISTS public.agent_formative_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  event_summary text NOT NULL,
  belief_before text,
  belief_after text,
  character_implication text,
  domain text,
  impact_score numeric NOT NULL DEFAULT 0.5,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_formative_events TO authenticated;
GRANT ALL ON public.agent_formative_events TO service_role;
ALTER TABLE public.agent_formative_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own formative events" ON public.agent_formative_events FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- agent_relationship_ledger
CREATE TABLE IF NOT EXISTS public.agent_relationship_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  agent_a_slug text NOT NULL,
  agent_b_slug text NOT NULL,
  interaction_count int NOT NULL DEFAULT 0,
  agreement_count int NOT NULL DEFAULT 0,
  disagreement_count int NOT NULL DEFAULT 0,
  current_dynamic text NOT NULL DEFAULT 'peer',
  relationship_summary text,
  domain_deference jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_interaction_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, agent_a_slug, agent_b_slug)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_relationship_ledger TO authenticated;
GRANT ALL ON public.agent_relationship_ledger TO service_role;
ALTER TABLE public.agent_relationship_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own rel ledger" ON public.agent_relationship_ledger FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- dossier_suggestions
CREATE TABLE IF NOT EXISTS public.dossier_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  agent_slug text NOT NULL,
  entry_type text NOT NULL DEFAULT 'journal',
  title text NOT NULL,
  context text,
  importance text NOT NULL DEFAULT 'medium',
  suggested_date date,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dossier_suggestions TO authenticated;
GRANT ALL ON public.dossier_suggestions TO service_role;
ALTER TABLE public.dossier_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own dossier suggestions" ON public.dossier_suggestions FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
