
-- Shared persistent knowledge base (any agent can read/write)
CREATE TABLE IF NOT EXISTS public.agent_shared_knowledge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_agent text NOT NULL,
  topic text,
  fact text NOT NULL,
  importance numeric DEFAULT 0.5,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_shared_knowledge TO authenticated;
GRANT ALL ON public.agent_shared_knowledge TO service_role;

ALTER TABLE public.agent_shared_knowledge ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agent_shared_knowledge' AND policyname='Users manage own shared knowledge') THEN
    CREATE POLICY "Users manage own shared knowledge"
      ON public.agent_shared_knowledge FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agent_shared_knowledge' AND policyname='Service role manages shared knowledge') THEN
    CREATE POLICY "Service role manages shared knowledge"
      ON public.agent_shared_knowledge FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shared_knowledge_user_time
  ON public.agent_shared_knowledge (user_id, updated_at DESC);

-- Unified conversation history view across mediums
CREATE OR REPLACE VIEW public.agent_unified_history
WITH (security_invoker = on) AS
  SELECT
    user_id,
    'mental_forge'::text AS medium,
    'atlas'::text AS agent_slug,
    role,
    content,
    created_at
  FROM public.forge_messages
  UNION ALL
  SELECT
    m.user_id,
    'agent_chat'::text AS medium,
    COALESCE(t.agent_slug, 'unknown') AS agent_slug,
    m.role,
    m.content,
    m.created_at
  FROM public.agent_chat_messages m
  LEFT JOIN public.agent_chat_threads t ON t.id = m.thread_id
  UNION ALL
  SELECT
    t.user_id,
    'atlas_chat'::text AS medium,
    t.agent_slug,
    msg->>'role' AS role,
    COALESCE(msg->>'content', '') AS content,
    t.updated_at AS created_at
  FROM public.chat_threads t
  CROSS JOIN LATERAL jsonb_array_elements(t.messages) AS msg
  WHERE msg ? 'role' AND msg ? 'content';

GRANT SELECT ON public.agent_unified_history TO authenticated;
GRANT SELECT ON public.agent_unified_history TO service_role;
