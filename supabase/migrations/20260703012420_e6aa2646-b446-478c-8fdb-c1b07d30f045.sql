CREATE TABLE public.meeting_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  meeting_date date NOT NULL,
  title text,
  notes text,
  outcome text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meeting_logs TO authenticated;
GRANT ALL ON public.meeting_logs TO service_role;
ALTER TABLE public.meeting_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own_meeting_logs" ON public.meeting_logs;
CREATE POLICY "own_meeting_logs" ON public.meeting_logs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.skyforge_agents
  ADD COLUMN IF NOT EXISTS user_notes text,
  ADD COLUMN IF NOT EXISTS identity_notes text;