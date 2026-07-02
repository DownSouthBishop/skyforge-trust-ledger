-- Notebook — NotebookLM-style research tool, built natively (not the standalone
-- Open Notebook app, which is Python/SurrealDB and a different tech stack entirely).
-- Notebooks group sources; chat is grounded in whatever sources are attached.

CREATE TABLE IF NOT EXISTS public.notebooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

ALTER TABLE public.notebooks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own notebooks" ON public.notebooks;
CREATE POLICY "Users manage own notebooks"
  ON public.notebooks FOR ALL USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notebook_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notebook_id   uuid NOT NULL REFERENCES public.notebooks(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  title         text NOT NULL,
  source_type   text NOT NULL CHECK (source_type IN ('file', 'url', 'text')),
  storage_path  text,   -- Supabase Storage path, for source_type='file'
  media_type    text,   -- MIME type, for source_type='file'
  content_text  text,   -- fetched/pasted text, for source_type='url'|'text'
  source_url    text,   -- original URL, for source_type='url'

  created_at    timestamptz DEFAULT now()
);

ALTER TABLE public.notebook_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own notebook sources" ON public.notebook_sources;
CREATE POLICY "Users manage own notebook sources"
  ON public.notebook_sources FOR ALL USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_notebook_sources_notebook ON public.notebook_sources (notebook_id, created_at);

-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notebook_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notebook_id   uuid NOT NULL REFERENCES public.notebooks(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  role          text NOT NULL CHECK (role IN ('user', 'assistant')),
  content       text NOT NULL,

  created_at    timestamptz DEFAULT now()
);

ALTER TABLE public.notebook_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own notebook messages" ON public.notebook_messages;
CREATE POLICY "Users manage own notebook messages"
  ON public.notebook_messages FOR ALL USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_notebook_messages_notebook ON public.notebook_messages (notebook_id, created_at);

-- Reuses public.touch_updated_at() defined in 20260601000006_linda_domain.sql
DROP TRIGGER IF EXISTS notebooks_updated ON public.notebooks;
CREATE TRIGGER notebooks_updated
  BEFORE UPDATE ON public.notebooks
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- Storage bucket for uploaded source files. Path convention: <user_id>/<notebook_id>/<filename>

INSERT INTO storage.buckets (id, name, public)
VALUES ('notebook-sources', 'notebook-sources', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Users manage own notebook files" ON storage.objects;
CREATE POLICY "Users manage own notebook files"
  ON storage.objects FOR ALL
  USING (bucket_id = 'notebook-sources' AND auth.uid()::text = (storage.foldername(name))[1])
  WITH CHECK (bucket_id = 'notebook-sources' AND auth.uid()::text = (storage.foldername(name))[1]);
