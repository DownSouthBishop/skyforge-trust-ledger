CREATE TABLE public.forge_subject_chats (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  subject_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_forge_subject_chats_subject ON public.forge_subject_chats(subject_id, created_at);
CREATE INDEX idx_forge_subject_chats_user ON public.forge_subject_chats(user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.forge_subject_chats TO authenticated;
GRANT ALL ON public.forge_subject_chats TO service_role;

ALTER TABLE public.forge_subject_chats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users manage own subject chats"
  ON public.forge_subject_chats
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);