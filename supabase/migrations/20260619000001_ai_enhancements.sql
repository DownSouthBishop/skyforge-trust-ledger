-- AI Enhancements Migration
-- Adds vector embeddings, memory hygiene, dossier suggestions, and proactive alerts

-- 1. Add embedding columns to shared_operator_memory
ALTER TABLE public.shared_operator_memory
  ADD COLUMN IF NOT EXISTS embedding vector(768),
  ADD COLUMN IF NOT EXISTS decay_rate float8 DEFAULT 0.05;

-- 2. Add embedding column to agent_cross_memory
ALTER TABLE public.agent_cross_memory
  ADD COLUMN IF NOT EXISTS embedding vector(768);

-- 3. HNSW indexes for fast cosine similarity search
CREATE INDEX IF NOT EXISTS idx_shared_mem_embedding
  ON public.shared_operator_memory
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_cross_mem_embedding
  ON public.agent_cross_memory
  USING hnsw (embedding vector_cosine_ops);

-- 4. dossier_suggestions table
CREATE TABLE IF NOT EXISTS public.dossier_suggestions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_slug      text NOT NULL,
  entry_type      text NOT NULL CHECK (entry_type IN ('goal','task','journal')),
  title           text NOT NULL,
  context         text,
  importance      text DEFAULT 'medium' CHECK (importance IN ('high','medium','low')),
  suggested_date  text,
  target_goal_id  uuid REFERENCES public.goals(id) ON DELETE SET NULL,
  status          text DEFAULT 'pending' CHECK (status IN ('pending','approved','dismissed')),
  created_at      timestamptz DEFAULT now()
);

ALTER TABLE public.dossier_suggestions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'dossier_suggestions' AND policyname = 'Users can manage own dossier suggestions'
  ) THEN
    CREATE POLICY "Users can manage own dossier suggestions"
      ON public.dossier_suggestions
      FOR ALL
      TO authenticated
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'dossier_suggestions' AND policyname = 'Service role full access dossier_suggestions'
  ) THEN
    CREATE POLICY "Service role full access dossier_suggestions"
      ON public.dossier_suggestions
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- 5. proactive_alerts table
CREATE TABLE IF NOT EXISTS public.proactive_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_slug  text NOT NULL DEFAULT 'atlas',
  alert_type  text NOT NULL CHECK (alert_type IN ('goal_stall','deadline','opportunity','pattern','recommendation')),
  title       text NOT NULL,
  content     text NOT NULL,
  priority    text DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  status      text DEFAULT 'unread' CHECK (status IN ('unread','read','dismissed')),
  created_at  timestamptz DEFAULT now()
);

ALTER TABLE public.proactive_alerts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'proactive_alerts' AND policyname = 'Users can manage own proactive alerts'
  ) THEN
    CREATE POLICY "Users can manage own proactive alerts"
      ON public.proactive_alerts
      FOR ALL
      TO authenticated
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'proactive_alerts' AND policyname = 'Service role full access proactive_alerts'
  ) THEN
    CREATE POLICY "Service role full access proactive_alerts"
      ON public.proactive_alerts
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- 6. match_memories — semantic search over shared_operator_memory
CREATE OR REPLACE FUNCTION public.match_memories(
  query_embedding vector(768),
  p_user_id       uuid,
  match_count     int DEFAULT 15
)
RETURNS TABLE (
  id           uuid,
  memory_type  text,
  key          text,
  value        text,
  source_agent text,
  updated_at   timestamptz,
  similarity   float8
)
LANGUAGE sql STABLE
AS $$
  SELECT
    m.id,
    m.memory_type,
    m.key,
    m.value,
    m.source_agent,
    m.updated_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM public.shared_operator_memory m
  WHERE m.user_id = p_user_id
    AND m.embedding IS NOT NULL
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- 7. match_cross_memory — semantic search over agent_cross_memory
CREATE OR REPLACE FUNCTION public.match_cross_memory(
  query_embedding vector(768),
  p_user_id       uuid,
  match_count     int DEFAULT 10
)
RETURNS TABLE (
  source_agent text,
  summary      text,
  topic        text,
  created_at   timestamptz,
  similarity   float8
)
LANGUAGE sql STABLE
AS $$
  SELECT
    c.source_agent,
    c.summary,
    c.topic,
    c.created_at,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.agent_cross_memory c
  WHERE c.user_id = p_user_id
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- 8. pg_cron jobs
-- proactive_monitor every 30 minutes
SELECT cron.schedule(
  'proactive_monitor',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/proactive_monitor',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id;
  $$
);

-- session_reflect every hour
SELECT cron.schedule(
  'session_reflect',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/session_reflect',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id;
  $$
);
