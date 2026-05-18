-- ══════════════════════════════════════════════════════════════════
-- SKYFORGE AGENT REGISTRY
-- Multi-agent infrastructure: registry, sessions, reflections, memory
-- Every agent spawned here inherits the same self-reflection baseline.
-- ══════════════════════════════════════════════════════════════════

-- ─── 1. Agent Registry ────────────────────────────────────────────
-- One row per agent. Stores the character definition Atlas uses to
-- boot the ElizaOS runtime for that agent.

CREATE TABLE IF NOT EXISTS public.skyforge_agents (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Identity
  name             text NOT NULL,
  slug             text NOT NULL,                     -- URL-safe handle e.g. "social", "legal"
  role             text NOT NULL,                     -- one-line role description
  avatar_emoji     text DEFAULT '🤖',

  -- Character definition (maps 1:1 to ElizaOS character JSON fields)
  system_prompt    text NOT NULL,                     -- core identity & mission
  bio              text[] DEFAULT '{}',               -- background bullets
  topics           text[] DEFAULT '{}',               -- domain knowledge areas
  style_notes      text[] DEFAULT '{}',               -- voice/communication style
  clients          text[] DEFAULT '{}',               -- e.g. ["twitter","telegram"]
  plugins          text[] DEFAULT '{}',               -- e.g. ["@elizaos/plugin-browser"]

  -- Capabilities declared at spawn time (agent uses these to self-route)
  capabilities     jsonb DEFAULT '[]',                -- [{name, description, examples[]}]

  -- Autonomy config
  auto_execute     boolean DEFAULT false,             -- can act without approval
  approval_threshold_usd numeric DEFAULT 0,           -- $0 = always ask
  reflect_after_sessions int DEFAULT 1,               -- reflect every N sessions

  -- Status
  is_active        boolean DEFAULT true,
  version          int DEFAULT 1,                     -- bumped on each major update
  model            text DEFAULT 'claude-sonnet-4-20250514',

  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),

  UNIQUE(user_id, slug)
);

ALTER TABLE public.skyforge_agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own agents"
  ON public.skyforge_agents FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_agents_user    ON public.skyforge_agents(user_id, is_active);
CREATE INDEX idx_agents_slug    ON public.skyforge_agents(user_id, slug);

-- ─── 2. Agent Sessions ────────────────────────────────────────────
-- Each invocation of an agent is a session. Sessions are the raw
-- material for the post-session reflection cycle.

CREATE TABLE IF NOT EXISTS public.agent_sessions (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id        uuid NOT NULL REFERENCES public.skyforge_agents(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- What happened
  task_description text NOT NULL,                     -- what the agent was asked to do
  messages         jsonb DEFAULT '[]',                -- [{role, content, ts}] full transcript
  actions_taken    jsonb DEFAULT '[]',                -- [{action, input, output, success}]
  outcome          text CHECK (outcome IN ('success','partial','failed','pending')),
  outcome_notes    text,                              -- human or agent summary of what occurred

  -- Metrics
  tokens_used      int DEFAULT 0,
  duration_ms      int DEFAULT 0,
  autonomy_score   numeric(3,2),                      -- 0–1: how much agent self-directed

  -- Reflection trigger
  reflected        boolean DEFAULT false,
  reflected_at     timestamptz,

  started_at       timestamptz DEFAULT now(),
  completed_at     timestamptz
);

ALTER TABLE public.agent_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own sessions"
  ON public.agent_sessions FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX idx_sessions_agent       ON public.agent_sessions(agent_id, started_at DESC);
CREATE INDEX idx_sessions_reflected   ON public.agent_sessions(agent_id, reflected) WHERE reflected = false;

-- ─── 3. Agent Reflections ─────────────────────────────────────────
-- After N sessions the agent runs a structured self-eval.
-- Reflections accumulate into the agent's evolving self-model.

CREATE TABLE IF NOT EXISTS public.agent_reflections (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id        uuid NOT NULL REFERENCES public.skyforge_agents(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_ids     uuid[] DEFAULT '{}',                -- sessions this reflection covers

  -- Structured reflection output (agent fills these in)
  what_worked     text,
  what_failed     text,
  patterns        text,                               -- recurring behaviours noticed
  blind_spots     text,                               -- what I consistently miss
  autonomy_delta  text,                               -- how to be more self-directed next time
  capability_gaps text,                               -- tools or knowledge I'm missing
  updated_priors  jsonb DEFAULT '{}',                 -- key-value beliefs updated this cycle

  -- Meta
  reflection_model text,                             -- model that ran the reflection
  raw_output      text,                              -- full LLM response before parsing
  quality_score   numeric(3,2),                      -- 0–1 self-assessed quality

  created_at      timestamptz DEFAULT now()
);

ALTER TABLE public.agent_reflections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own reflections"
  ON public.agent_reflections FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX idx_reflections_agent ON public.agent_reflections(agent_id, created_at DESC);

-- ─── 4. Agent Memory ──────────────────────────────────────────────
-- Persistent beliefs, learned patterns, and distilled knowledge
-- that survive across sessions. Each reflection can upsert entries here.

CREATE TABLE IF NOT EXISTS public.agent_memory (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id        uuid NOT NULL REFERENCES public.skyforge_agents(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  memory_type     text NOT NULL CHECK (memory_type IN (
                    'learned_pattern',    -- repeated behaviour Atlas noticed
                    'capability',         -- something the agent can now reliably do
                    'constraint',         -- hard limit discovered through failure
                    'preference',         -- operator preference inferred from feedback
                    'relationship',       -- inter-agent collaboration pattern
                    'world_model'         -- factual update about its domain
                  )),
  key             text NOT NULL,                      -- short label
  value           text NOT NULL,                      -- the belief/knowledge
  confidence      numeric(3,2) DEFAULT 0.5,           -- 0–1
  evidence_count  int DEFAULT 1,                      -- number of sessions supporting this
  last_reinforced timestamptz DEFAULT now(),
  source_session  uuid REFERENCES public.agent_sessions(id),

  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),

  UNIQUE(agent_id, memory_type, key)
);

ALTER TABLE public.agent_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own agent memory"
  ON public.agent_memory FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX idx_memory_agent      ON public.agent_memory(agent_id, memory_type);
CREATE INDEX idx_memory_confidence ON public.agent_memory(agent_id, confidence DESC);

-- ─── 5. Agent-to-Agent Delegation Log ────────────────────────────
-- Atlas routes tasks to sub-agents. This table tracks every delegation.

CREATE TABLE IF NOT EXISTS public.agent_delegations (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_agent_id   uuid REFERENCES public.skyforge_agents(id),   -- null = Atlas/operator
  to_agent_id     uuid NOT NULL REFERENCES public.skyforge_agents(id),
  session_id      uuid REFERENCES public.agent_sessions(id),

  task            text NOT NULL,
  routing_reason  text,                               -- why this agent was chosen
  outcome         text CHECK (outcome IN ('success','partial','failed','pending')),

  created_at      timestamptz DEFAULT now()
);

ALTER TABLE public.agent_delegations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own delegations"
  ON public.agent_delegations FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX idx_delegations_user  ON public.agent_delegations(user_id, created_at DESC);
CREATE INDEX idx_delegations_agent ON public.agent_delegations(to_agent_id, created_at DESC);

-- ─── 6. Updated-at triggers ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agents_updated
  BEFORE UPDATE ON public.skyforge_agents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER memory_updated
  BEFORE UPDATE ON public.agent_memory
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 7. Helper RPC — export character JSON ────────────────────────
-- Frontend calls this to get the ElizaOS-ready character.json for any agent.

CREATE OR REPLACE FUNCTION public.export_agent_character(p_agent_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT jsonb_build_object(
    'name',          a.name,
    'clients',       to_jsonb(a.clients),
    'modelProvider', 'anthropic',
    'model',         a.model,
    'plugins',       to_jsonb(array_cat(ARRAY['@elizaos/plugin-bootstrap'], a.plugins)),
    'system',        a.system_prompt,
    'bio',           to_jsonb(a.bio),
    'topics',        to_jsonb(a.topics),
    'style',         jsonb_build_object('all', to_jsonb(a.style_notes)),
    'actions',       a.capabilities,
    'settings',      jsonb_build_object(
      'autoExecute',       a.auto_execute,
      'approvalThreshold', a.approval_threshold_usd,
      'reflectAfter',      a.reflect_after_sessions
    )
  )
  FROM public.skyforge_agents a
  WHERE a.id = p_agent_id
    AND a.user_id = auth.uid();
$$;
