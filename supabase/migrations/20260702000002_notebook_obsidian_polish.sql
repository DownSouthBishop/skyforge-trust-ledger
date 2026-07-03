-- Notebook Obsidian-style polish: hierarchy, tags, write-a-note-directly,
-- bidirectional [[links]], and pinned Knowledge/MOC notebooks.
-- No existing linking convention to reuse (research_notes/Vault only has
-- obsidian_path for syncing OUT to an external Obsidian vault on disk, not
-- an in-app link graph) -- notebook_links is a clean, new table.

ALTER TABLE public.notebooks
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.notebooks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_pinned boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_notebooks_parent ON public.notebooks (parent_id);

ALTER TABLE public.notebook_sources
  ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS body text;

CREATE TABLE IF NOT EXISTS public.notebook_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_source_id uuid NOT NULL REFERENCES public.notebook_sources(id) ON DELETE CASCADE,
  to_source_id   uuid NOT NULL REFERENCES public.notebook_sources(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_source_id, to_source_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.notebook_links TO authenticated;
GRANT ALL ON public.notebook_links TO service_role;

ALTER TABLE public.notebook_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own_notebook_links" ON public.notebook_links;
CREATE POLICY "own_notebook_links" ON public.notebook_links
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_notebook_links_from ON public.notebook_links (from_source_id);
CREATE INDEX IF NOT EXISTS idx_notebook_links_to ON public.notebook_links (to_source_id);
