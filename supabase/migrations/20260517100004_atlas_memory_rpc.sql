-- Match atlas_memories by vector similarity
CREATE OR REPLACE FUNCTION public.match_atlas_memories(
  query_embedding vector(1536),
  match_domain text DEFAULT NULL,
  match_limit int DEFAULT 5,
  min_importance float DEFAULT 0.3
)
RETURNS TABLE (
  id uuid,
  session_id uuid,
  content text,
  domain text,
  emotional_valence float,
  importance_score float,
  created_at timestamptz,
  last_accessed timestamptz,
  access_count int,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    m.id,
    m.session_id,
    m.content,
    m.domain,
    m.emotional_valence,
    m.importance_score,
    m.created_at,
    m.last_accessed,
    m.access_count,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM public.atlas_memory m
  WHERE
    (match_domain IS NULL OR m.domain = match_domain)
    AND m.importance_score >= min_importance
    AND m.embedding IS NOT NULL
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_limit;
$$;

-- Update last_accessed and access_count for recalled memories
CREATE OR REPLACE FUNCTION public.touch_atlas_memories(memory_ids uuid[])
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.atlas_memory
  SET
    last_accessed = now(),
    access_count = access_count + 1
  WHERE id = ANY(memory_ids);
$$;

-- brainiac_sessions upsert support (add unique constraint if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brainiac_sessions_user_session_key'
  ) THEN
    ALTER TABLE public.brainiac_sessions
    ADD CONSTRAINT brainiac_sessions_user_session_key
    UNIQUE (user_id, session_key);
  END IF;
EXCEPTION WHEN others THEN
  NULL; -- Table may not have session_key column yet, handled gracefully
END $$;
