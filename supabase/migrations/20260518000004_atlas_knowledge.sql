-- Atlas Knowledge Vault — Obsidian-style personal knowledge graph
-- Each row is a note/insight/concept that Atlas or the user has saved.

CREATE TABLE IF NOT EXISTS public.atlas_knowledge (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title      text NOT NULL,
  content    text NOT NULL DEFAULT '',
  tags       text[] DEFAULT '{}',
  links      text[] DEFAULT '{}',            -- titles of linked notes (wikilinks)
  node_type  text NOT NULL DEFAULT 'note'
             CHECK (node_type IN ('note','insight','pattern','lesson','concept','trade_thesis','entity')),
  source     text NOT NULL DEFAULT 'manual'
             CHECK (source IN ('manual','atlas','conversation')),
  pinned     boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.atlas_knowledge ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own knowledge"
  ON public.atlas_knowledge FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_atlas_knowledge_user ON public.atlas_knowledge(user_id, updated_at DESC);
CREATE INDEX idx_atlas_knowledge_tags ON public.atlas_knowledge USING GIN(tags);
CREATE INDEX idx_atlas_knowledge_type ON public.atlas_knowledge(user_id, node_type);
CREATE INDEX idx_atlas_knowledge_pinned ON public.atlas_knowledge(user_id, pinned) WHERE pinned = true;

CREATE OR REPLACE FUNCTION public.set_atlas_knowledge_updated()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER atlas_knowledge_updated
  BEFORE UPDATE ON public.atlas_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.set_atlas_knowledge_updated();
