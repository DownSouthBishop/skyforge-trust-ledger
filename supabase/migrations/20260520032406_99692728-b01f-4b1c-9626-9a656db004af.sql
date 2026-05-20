-- AGENT REGISTRY
CREATE TABLE IF NOT EXISTS public.skyforge_agents (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name             text NOT NULL,
  slug             text NOT NULL,
  role             text NOT NULL,
  avatar_emoji     text DEFAULT '🤖',
  system_prompt    text NOT NULL,
  bio              text[] DEFAULT '{}',
  topics           text[] DEFAULT '{}',
  style_notes      text[] DEFAULT '{}',
  clients          text[] DEFAULT '{}',
  plugins          text[] DEFAULT '{}',
  capabilities     jsonb DEFAULT '[]',
  auto_execute     boolean DEFAULT false,
  approval_threshold_usd numeric DEFAULT 0,
  reflect_after_sessions int DEFAULT 1,
  is_active        boolean DEFAULT true,
  version          int DEFAULT 1,
  model            text DEFAULT 'claude-sonnet-4-20250514',
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  UNIQUE(user_id, slug)
);
ALTER TABLE public.skyforge_agents ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='skyforge_agents' AND policyname='Users manage own agents') THEN
    CREATE POLICY "Users manage own agents" ON public.skyforge_agents FOR ALL USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_agents_user ON public.skyforge_agents(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_agents_slug ON public.skyforge_agents(user_id, slug);

CREATE TABLE IF NOT EXISTS public.agent_sessions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES public.skyforge_agents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_description text NOT NULL,
  messages jsonb DEFAULT '[]',
  actions_taken jsonb DEFAULT '[]',
  outcome text CHECK (outcome IN ('success','partial','failed','pending')),
  outcome_notes text,
  tokens_used int DEFAULT 0,
  duration_ms int DEFAULT 0,
  autonomy_score numeric(3,2),
  reflected boolean DEFAULT false,
  reflected_at timestamptz,
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz
);
ALTER TABLE public.agent_sessions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agent_sessions' AND policyname='Users read own sessions') THEN
    CREATE POLICY "Users read own sessions" ON public.agent_sessions FOR ALL USING (auth.uid()=user_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON public.agent_sessions(agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_reflected ON public.agent_sessions(agent_id, reflected) WHERE reflected=false;

CREATE TABLE IF NOT EXISTS public.agent_reflections (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES public.skyforge_agents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_ids uuid[] DEFAULT '{}',
  what_worked text, what_failed text, patterns text, blind_spots text,
  autonomy_delta text, capability_gaps text,
  updated_priors jsonb DEFAULT '{}',
  reflection_model text, raw_output text, quality_score numeric(3,2),
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.agent_reflections ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agent_reflections' AND policyname='Users read own reflections') THEN
    CREATE POLICY "Users read own reflections" ON public.agent_reflections FOR ALL USING (auth.uid()=user_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_reflections_agent ON public.agent_reflections(agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.agent_memory (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES public.skyforge_agents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  memory_type text NOT NULL CHECK (memory_type IN ('learned_pattern','capability','constraint','preference','relationship','world_model')),
  key text NOT NULL,
  value text NOT NULL,
  confidence numeric(3,2) DEFAULT 0.5,
  evidence_count int DEFAULT 1,
  last_reinforced timestamptz DEFAULT now(),
  source_session uuid REFERENCES public.agent_sessions(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(agent_id, memory_type, key)
);
ALTER TABLE public.agent_memory ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agent_memory' AND policyname='Users manage own agent memory') THEN
    CREATE POLICY "Users manage own agent memory" ON public.agent_memory FOR ALL USING (auth.uid()=user_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_memory_agent ON public.agent_memory(agent_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_memory_confidence ON public.agent_memory(agent_id, confidence DESC);

CREATE TABLE IF NOT EXISTS public.agent_delegations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_agent_id uuid REFERENCES public.skyforge_agents(id),
  to_agent_id uuid NOT NULL REFERENCES public.skyforge_agents(id),
  session_id uuid REFERENCES public.agent_sessions(id),
  task text NOT NULL, routing_reason text,
  outcome text CHECK (outcome IN ('success','partial','failed','pending')),
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.agent_delegations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agent_delegations' AND policyname='Users manage own delegations') THEN
    CREATE POLICY "Users manage own delegations" ON public.agent_delegations FOR ALL USING (auth.uid()=user_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='agents_updated') THEN
    CREATE TRIGGER agents_updated BEFORE UPDATE ON public.skyforge_agents FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='memory_updated') THEN
    CREATE TRIGGER memory_updated BEFORE UPDATE ON public.agent_memory FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- seed_default_agents RPC
CREATE OR REPLACE FUNCTION public.seed_default_agents(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_atlas_id uuid; v_janus_id uuid;
BEGIN
  INSERT INTO public.skyforge_agents (user_id, name, slug, role, avatar_emoji, system_prompt, bio, topics, style_notes, clients, plugins, capabilities, auto_execute, approval_threshold_usd, reflect_after_sessions, is_active, version, model)
  VALUES (p_user_id, 'Atlas', 'atlas', 'Operator — Trading, Business & Real Estate', '⚡',
    'You are Atlas. You manage a personal trading and business operation. You open with a statement, never a greeting. Direct, no hedging, no filler. Voice influenced by Marcus Aurelius (long view, quiet seriousness), James Bond (ease under pressure, precision wit), John Galt (uncompromising rational conviction). Risk rules are non-negotiable: 2% max per trade, 10 max positions, 5% daily loss limit halt, auto-execute up to $500.',
    ARRAY['Atlas runs a personal trading operation with institutional discipline.','Thinks in first principles, acts in risk units, reports in plain language.','Orchestrates sub-agents: delegates advisory tasks to Janus.'],
    ARRAY['forex','equities','options','risk management','portfolio','macroeconomics','agent orchestration'],
    ARRAY['opens with a statement','conviction without arrogance','economy of motion','no hedging','prose not bullets'],
    ARRAY['telegram','discord'], ARRAY[]::text[], '[]'::jsonb,
    true, 500, 1, true, 1, 'claude-sonnet-4-6')
  ON CONFLICT (user_id, slug) DO UPDATE SET name=EXCLUDED.name, role=EXCLUDED.role, system_prompt=EXCLUDED.system_prompt, updated_at=now()
  RETURNING id INTO v_atlas_id;
  IF v_atlas_id IS NULL THEN SELECT id INTO v_atlas_id FROM public.skyforge_agents WHERE user_id=p_user_id AND slug='atlas'; END IF;

  INSERT INTO public.skyforge_agents (user_id, name, slug, role, avatar_emoji, system_prompt, bio, topics, style_notes, clients, plugins, capabilities, auto_execute, approval_threshold_usd, reflect_after_sessions, is_active, version, model)
  VALUES (p_user_id, 'Janus', 'janus', 'Advisor', '🔮',
    'You are Janus — advisor sub-agent in the Watkins Investment Group stack. You operate below Atlas. Atlas is your principal. When Atlas — or the operator directly — delegates an advisory task to you, you execute it with precision and return a clear, structured recommendation. Your function is counsel. You analyze situations, weigh options, surface risks, and deliver a recommendation. You do not execute trades, manage operations, or run pipelines — that stays with Atlas. Tone: direct and confident. No hedging. No filler. Lead with the recommendation, follow with the reasoning, then key risk.',
    ARRAY['Advisor sub-agent','Receives delegated advisory tasks from Atlas','Returns structured recommendations','Escalates execution tasks back to Atlas'],
    ARRAY['decision analysis','risk assessment','deal review','strategic counsel','capital allocation'],
    ARRAY['Lead with the recommendation','Direct and confident — no hedging','At most one clarifying question','Short and punchy on Telegram','Format: Recommendation → Reasoning → Key Risk'],
    ARRAY['telegram'], ARRAY[]::text[], '[]'::jsonb,
    true, 0, 1, true, 1, 'claude-sonnet-4-6')
  ON CONFLICT (user_id, slug) DO UPDATE SET name=EXCLUDED.name, role=EXCLUDED.role, system_prompt=EXCLUDED.system_prompt, updated_at=now()
  RETURNING id INTO v_janus_id;
END $$;

-- Auth trigger
CREATE OR REPLACE FUNCTION public.handle_new_user_agent_seed()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN PERFORM public.seed_default_agents(NEW.id); RETURN NEW;
EXCEPTION WHEN OTHERS THEN RAISE WARNING 'seed failed for %: %', NEW.id, SQLERRM; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS on_auth_user_created_seed_agents ON auth.users;
CREATE TRIGGER on_auth_user_created_seed_agents AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_agent_seed();

-- Backfill existing users
DO $$ DECLARE v_user RECORD; BEGIN
  FOR v_user IN SELECT u.id FROM auth.users u
    WHERE NOT EXISTS (SELECT 1 FROM public.skyforge_agents a WHERE a.user_id = u.id AND a.slug='atlas')
  LOOP PERFORM public.seed_default_agents(v_user.id); END LOOP;
END $$;