-- Cross-agent shared memory
-- Each agent writes a brief entry after every session.
-- Every agent reads the last N entries before responding so all agents
-- share awareness of what Bishop has been doing with each other.

CREATE TABLE IF NOT EXISTS public.agent_cross_memory (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_agent text NOT NULL,
  summary      text NOT NULL,
  topic        text,
  created_at   timestamptz DEFAULT now()
);

CREATE INDEX idx_cross_memory_user_time
  ON public.agent_cross_memory (user_id, created_at DESC);

ALTER TABLE public.agent_cross_memory ENABLE ROW LEVEL SECURITY;

-- Authenticated users read/write their own rows
CREATE POLICY "Users manage own cross memory"
  ON public.agent_cross_memory FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Service role writes on behalf of server-side edge functions
CREATE POLICY "Service role manages cross memory"
  ON public.agent_cross_memory FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
