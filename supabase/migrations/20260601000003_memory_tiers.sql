-- Episodic and semantic memory tiers
-- Layered on top of existing agent_memory (belief/working memory)
-- Uses existing pgvector extension

CREATE TABLE IF NOT EXISTS public.agent_memory_episodic (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES public.skyforge_agents(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  event_type      text NOT NULL,
  event_summary   text NOT NULL,
  event_context   jsonb DEFAULT '{}',
  embedding       vector(1536),

  significance    numeric(3,2) DEFAULT 0.5,
  vertical        text CHECK (vertical IN (
    'trading', 'marine', 'prymalai', 'book', 'realestate', 'wig_ops'
  )),
  linked_prediction_id uuid REFERENCES public.agent_predictions(id),

  occurred_at     timestamptz DEFAULT now(),
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_episodic_agent ON public.agent_memory_episodic (agent_id, occurred_at DESC);
CREATE INDEX idx_episodic_significance ON public.agent_memory_episodic (agent_id, significance DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'agent_memory_episodic' AND indexname = 'idx_episodic_embedding'
  ) THEN
    CREATE INDEX idx_episodic_embedding ON public.agent_memory_episodic
      USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  END IF;
END $$;

ALTER TABLE public.agent_memory_episodic ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own episodic memory"
  ON public.agent_memory_episodic FOR ALL USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.agent_memory_semantic (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES public.skyforge_agents(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  domain          text NOT NULL,
  knowledge_key   text NOT NULL,
  knowledge_value text NOT NULL,
  embedding       vector(1536),

  confidence      numeric(3,2) DEFAULT 0.5,
  evidence_count  int DEFAULT 1,
  last_reinforced timestamptz DEFAULT now(),
  last_contradicted timestamptz,
  contradiction_count int DEFAULT 0,

  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),

  UNIQUE(agent_id, domain, knowledge_key)
);

CREATE INDEX idx_semantic_agent ON public.agent_memory_semantic (agent_id, domain);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'agent_memory_semantic' AND indexname = 'idx_semantic_embedding'
  ) THEN
    CREATE INDEX idx_semantic_embedding ON public.agent_memory_semantic
      USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  END IF;
END $$;

ALTER TABLE public.agent_memory_semantic ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own semantic memory"
  ON public.agent_memory_semantic FOR ALL USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.retrieve_agent_memories(
  p_agent_id     uuid,
  p_embedding    vector(1536),
  p_limit_each   int DEFAULT 5
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH episodic AS (
    SELECT 'episodic' as tier, event_summary as content,
           event_context as context, significance as weight,
           1 - (embedding <=> p_embedding) as similarity
    FROM public.agent_memory_episodic
    WHERE agent_id = p_agent_id AND embedding IS NOT NULL
    ORDER BY embedding <=> p_embedding
    LIMIT p_limit_each
  ),
  semantic AS (
    SELECT 'semantic' as tier, knowledge_value as content,
           jsonb_build_object('domain', domain, 'key', knowledge_key) as context,
           confidence as weight,
           1 - (embedding <=> p_embedding) as similarity
    FROM public.agent_memory_semantic
    WHERE agent_id = p_agent_id AND embedding IS NOT NULL
    ORDER BY embedding <=> p_embedding
    LIMIT p_limit_each
  ),
  belief AS (
    SELECT 'belief' as tier, value as content,
           jsonb_build_object('type', memory_type, 'key', key) as context,
           confidence as weight,
           1.0 as similarity
    FROM public.agent_memory
    WHERE agent_id = p_agent_id
    ORDER BY confidence DESC
    LIMIT p_limit_each
  )
  SELECT jsonb_build_object(
    'episodic', (SELECT jsonb_agg(row_to_json(e)) FROM episodic e),
    'semantic',  (SELECT jsonb_agg(row_to_json(s)) FROM semantic s),
    'beliefs',   (SELECT jsonb_agg(row_to_json(b)) FROM belief b)
  );
$$;
