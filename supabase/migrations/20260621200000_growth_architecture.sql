-- ══════════════════════════════════════════════════════════════════
-- GROWTH ARCHITECTURE
-- 1. agent_character_state  — who each agent is becoming
-- 2. agent_relationship_ledger — inter-agent relationships
-- 3. agent_formative_events — experiences that shaped agents
-- 4. operator_directives    — live behavioral injections
-- 5. Cron jobs: daily reflect sweep, weekly character synthesis
-- ══════════════════════════════════════════════════════════════════

-- ── 1. agent_character_state ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_character_state (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id             uuid NOT NULL REFERENCES public.skyforge_agents(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  developmental_stage  text NOT NULL DEFAULT 'early'
                         CHECK (developmental_stage IN ('early','developing','mature','senior')),
  domain_confidence    jsonb NOT NULL DEFAULT '{}'::jsonb,
  voice_evolution      text,
  earned_strengths     text[] DEFAULT '{}',
  known_blind_spots    text[] DEFAULT '{}',
  formative_event_count int NOT NULL DEFAULT 0,
  sycophancy_score     numeric(4,3) DEFAULT 0.5,
  calibration_score    numeric(4,3) DEFAULT 0.5,
  character_summary    text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id)
);

ALTER TABLE public.agent_character_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner" ON public.agent_character_state
  USING (auth.uid() = user_id);
CREATE POLICY "service" ON public.agent_character_state
  TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_agent_char_state_agent
  ON public.agent_character_state(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_char_state_user
  ON public.agent_character_state(user_id);

-- ── 2. agent_relationship_ledger ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_relationship_ledger (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_a_slug         text NOT NULL,
  agent_b_slug         text NOT NULL,
  interaction_count    int NOT NULL DEFAULT 0,
  agreement_count      int NOT NULL DEFAULT 0,
  disagreement_count   int NOT NULL DEFAULT 0,
  domain_deference     jsonb NOT NULL DEFAULT '{}'::jsonb,
  influence_events     jsonb NOT NULL DEFAULT '[]'::jsonb,
  current_dynamic      text DEFAULT 'peer'
                         CHECK (current_dynamic IN ('peer','mentor_a','mentor_b','challenger','collaborator','rival')),
  relationship_summary text,
  last_interaction_at  timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, agent_a_slug, agent_b_slug)
);

ALTER TABLE public.agent_relationship_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner" ON public.agent_relationship_ledger
  USING (auth.uid() = user_id);
CREATE POLICY "service" ON public.agent_relationship_ledger
  TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_rel_ledger_user
  ON public.agent_relationship_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_rel_ledger_agents
  ON public.agent_relationship_ledger(user_id, agent_a_slug, agent_b_slug);

-- ── 3. agent_formative_events ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_formative_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id             uuid NOT NULL REFERENCES public.skyforge_agents(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_summary        text NOT NULL,
  belief_before        text,
  belief_after         text,
  character_implication text,
  agents_involved      text[] DEFAULT '{}',
  domain               text,
  impact_score         numeric(3,2) DEFAULT 0.5,
  session_id           uuid,
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_formative_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner" ON public.agent_formative_events
  USING (auth.uid() = user_id);
CREATE POLICY "service" ON public.agent_formative_events
  TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_formative_agent
  ON public.agent_formative_events(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_formative_user
  ON public.agent_formative_events(user_id, created_at DESC);

-- ── 4. operator_directives ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.operator_directives (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  prompt_text text NOT NULL,
  is_active   boolean NOT NULL DEFAULT false,
  scope       text NOT NULL DEFAULT 'all'
                CHECK (scope = 'all' OR scope ~ '^agent:'),
  category    text NOT NULL DEFAULT 'communication'
                CHECK (category IN ('communication','reasoning','output_format','persona','epistemic')),
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.operator_directives ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner" ON public.operator_directives
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "service" ON public.operator_directives
  TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_directives_user_active
  ON public.operator_directives(user_id, is_active, scope)
  WHERE is_active = true;

-- Seed preset directives (inactive by default)
-- These get inserted on first user login via the app; seeded here as reference rows
-- with a dummy user_id that gets replaced. Instead we insert them in the app on first load.

-- ── 5. Cron: daily agent reflect sweep (2am UTC) ──────────────────
SELECT cron.schedule(
  'daily-agent-reflect',
  '0 2 * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.supabase_url') || '/functions/v1/atlas_daily_reflect',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type',  'application/json'
    ),
    body    := '{"trigger":"cron"}'::jsonb
  ) AS request_id;
  $$
);

-- ── 6. Cron: weekly character synthesis (Sunday 4am UTC) ──────────
SELECT cron.schedule(
  'weekly-character-synthesis',
  '0 4 * * 0',
  $$
  SELECT net.http_post(
    url     := current_setting('app.supabase_url') || '/functions/v1/atlas_weekly_character_synthesis',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type',  'application/json'
    ),
    body    := '{"trigger":"cron"}'::jsonb
  ) AS request_id;
  $$
);
