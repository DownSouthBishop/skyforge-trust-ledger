CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE public.research_notes ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX IF NOT EXISTS research_notes_embedding_idx ON public.research_notes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
