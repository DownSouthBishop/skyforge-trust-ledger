
CREATE TABLE public.agent_chat_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_slug text NOT NULL,
  title text NOT NULL DEFAULT 'New conversation',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_chat_threads_user_agent_idx ON public.agent_chat_threads(user_id, agent_slug, updated_at DESC);
ALTER TABLE public.agent_chat_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own threads" ON public.agent_chat_threads FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.agent_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.agent_chat_threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_chat_messages_thread_idx ON public.agent_chat_messages(thread_id, created_at);
ALTER TABLE public.agent_chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own messages" ON public.agent_chat_messages FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
