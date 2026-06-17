CREATE TABLE public.chamber_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text,
  content text NOT NULL,
  entry_type text DEFAULT 'thought',
  created_at timestamptz DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chamber_entries TO authenticated;
GRANT ALL ON public.chamber_entries TO service_role;
ALTER TABLE public.chamber_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own" ON public.chamber_entries FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.chamber_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entry_id uuid REFERENCES public.chamber_entries(id) ON DELETE SET NULL,
  agent_slugs text[] NOT NULL,
  title text,
  created_at timestamptz DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chamber_sessions TO authenticated;
GRANT ALL ON public.chamber_sessions TO service_role;
ALTER TABLE public.chamber_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own" ON public.chamber_sessions FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.chamber_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.chamber_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL,
  agent_slug text,
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chamber_messages TO authenticated;
GRANT ALL ON public.chamber_messages TO service_role;
ALTER TABLE public.chamber_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own" ON public.chamber_messages FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.agent_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_slug text NOT NULL,
  about_agent_slug text NOT NULL,
  observation text NOT NULL,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, agent_slug, about_agent_slug)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_relationships TO authenticated;
GRANT ALL ON public.agent_relationships TO service_role;
ALTER TABLE public.agent_relationships ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own" ON public.agent_relationships FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);