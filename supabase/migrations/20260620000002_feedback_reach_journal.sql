-- 20260620000002_feedback_reach_journal.sql
-- Feedback signal, external reach queue, and agent identity journal

-- 1. agent_journal — first-person identity state per agent
CREATE TABLE IF NOT EXISTS public.agent_journal (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_slug text        NOT NULL,
  task_id    uuid        REFERENCES public.agent_tasks(id) ON DELETE SET NULL,
  entry      text        NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.agent_journal ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their agent_journal"
  ON public.agent_journal FOR ALL
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access on agent_journal"
  ON public.agent_journal FOR ALL
  TO service_role USING (true);

CREATE INDEX IF NOT EXISTS idx_agent_journal_user_agent
  ON public.agent_journal(user_id, agent_slug, created_at DESC);

-- 2. outbound_actions — approval queue for external actions (email/calendar)
CREATE TABLE IF NOT EXISTS public.outbound_actions (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_slug  text        NOT NULL,
  action_type text        NOT NULL CHECK (action_type IN ('email_draft', 'calendar_event')),
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status      text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'executed', 'dismissed')),
  created_at  timestamptz DEFAULT now(),
  actioned_at timestamptz
);

ALTER TABLE public.outbound_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their outbound_actions"
  ON public.outbound_actions FOR ALL
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access on outbound_actions"
  ON public.outbound_actions FOR ALL
  TO service_role USING (true);

CREATE INDEX IF NOT EXISTS idx_outbound_actions_user_status
  ON public.outbound_actions(user_id, status, created_at DESC);

-- 3. Add feedback column to proactive_alerts
ALTER TABLE public.proactive_alerts
  ADD COLUMN IF NOT EXISTS feedback text CHECK (feedback IN ('useful', 'noise'));

-- 4. Expand dossier_suggestions entry_type to include 'trade'
ALTER TABLE public.dossier_suggestions
  DROP CONSTRAINT IF EXISTS dossier_suggestions_entry_type_check;

ALTER TABLE public.dossier_suggestions
  ADD CONSTRAINT dossier_suggestions_entry_type_check
  CHECK (entry_type IN ('goal', 'task', 'journal', 'trade'));
