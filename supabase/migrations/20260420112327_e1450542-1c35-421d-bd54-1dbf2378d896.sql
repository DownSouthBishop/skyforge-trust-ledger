CREATE TABLE public.forge_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL DEFAULT '',
  ui text,
  arsenal_item_id uuid,
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_forge_messages_user_created ON public.forge_messages(user_id, created_at);

ALTER TABLE public.forge_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own forge_messages"
  ON public.forge_messages FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own forge_messages"
  ON public.forge_messages FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own forge_messages"
  ON public.forge_messages FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own forge_messages"
  ON public.forge_messages FOR DELETE
  USING (auth.uid() = user_id);