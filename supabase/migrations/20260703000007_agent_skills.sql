-- Skills catalog + agent assignment. Toggling a skill on for an agent makes
-- its description part of that agent's live system prompt (a roster of what
-- it has active), and its full content fetchable on demand via a use_skill
-- tool -- not always injected in full, since skill content varies from a
-- one-line description to a full reference doc.

CREATE TABLE IF NOT EXISTS public.agent_skills (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill_name  text NOT NULL,
  category    text NOT NULL,
  description text NOT NULL DEFAULT '',
  content     text NOT NULL DEFAULT '',
  agent_slug  text,
  enabled     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, skill_name)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_skills TO authenticated;
GRANT ALL ON public.agent_skills TO service_role;

ALTER TABLE public.agent_skills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own_agent_skills" ON public.agent_skills;
CREATE POLICY "own_agent_skills" ON public.agent_skills
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_agent_skills_agent_enabled ON public.agent_skills (user_id, agent_slug, enabled);
CREATE INDEX IF NOT EXISTS idx_agent_skills_category ON public.agent_skills (user_id, category);
