-- Atlas Projects and Conversations — persistent chat history
-- Replaces single-session brainiac_sessions approach with proper conversation management.

-- Projects: user-defined topic buckets (Trading, Real Estate, etc.)
CREATE TABLE IF NOT EXISTS public.atlas_projects (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  color       text DEFAULT 'orange',
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

ALTER TABLE public.atlas_projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own projects"
  ON public.atlas_projects
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_atlas_projects_user ON public.atlas_projects(user_id, updated_at DESC);

-- Conversations: individual chat threads, optionally assigned to a project
CREATE TABLE IF NOT EXISTS public.atlas_conversations (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id  uuid REFERENCES public.atlas_projects(id) ON DELETE SET NULL,
  title       text NOT NULL DEFAULT 'New conversation',
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

ALTER TABLE public.atlas_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own conversations"
  ON public.atlas_conversations
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_atlas_conversations_user    ON public.atlas_conversations(user_id, updated_at DESC);
CREATE INDEX idx_atlas_conversations_project ON public.atlas_conversations(project_id, updated_at DESC);

-- Messages: individual turns stored per conversation (append-only in practice)
CREATE TABLE IF NOT EXISTS public.atlas_messages (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES public.atlas_conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL,
  created_at      timestamptz DEFAULT now()
);

ALTER TABLE public.atlas_messages ENABLE ROW LEVEL SECURITY;

-- Messages inherit access from their conversation's owner
CREATE POLICY "Users read own messages"
  ON public.atlas_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.atlas_conversations c
      WHERE c.id = conversation_id AND c.user_id = auth.uid()
    )
  );

CREATE POLICY "Users insert own messages"
  ON public.atlas_messages FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.atlas_conversations c
      WHERE c.id = conversation_id AND c.user_id = auth.uid()
    )
  );

CREATE INDEX idx_atlas_messages_conv ON public.atlas_messages(conversation_id, created_at DESC);
