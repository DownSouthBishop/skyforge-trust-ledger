-- 20260620000001_autonomous_executor.sql
-- Autonomous execution layer: agent_tasks queue + agent_execution_log audit trail

-- 1. agent_tasks — work queue for autonomous agent execution
CREATE TABLE IF NOT EXISTS public.agent_tasks (
  id             uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        uuid        NOT NULL,
  agent_slug     text        NOT NULL CHECK (agent_slug IN ('atlas', 'janus', 'linda', 'izzy')),
  task_type      text        NOT NULL,
  task_description text      NOT NULL,
  context        jsonb       DEFAULT '{}'::jsonb,
  status         text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  priority       text        NOT NULL DEFAULT 'medium'
                             CHECK (priority IN ('high', 'medium', 'low')),
  scheduled_for  timestamptz DEFAULT now(),
  created_at     timestamptz DEFAULT now(),
  started_at     timestamptz,
  completed_at   timestamptz,
  result_summary text,
  triggered_by   text        DEFAULT 'proactive_monitor',
  steps_taken    int         DEFAULT 0,
  max_steps      int         DEFAULT 8
);

ALTER TABLE public.agent_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their agent_tasks"
  ON public.agent_tasks FOR ALL
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access on agent_tasks"
  ON public.agent_tasks FOR ALL
  TO service_role USING (true);

-- 2. agent_execution_log — full audit trail of autonomous actions
CREATE TABLE IF NOT EXISTS public.agent_execution_log (
  id               uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id          uuid        REFERENCES public.agent_tasks(id) ON DELETE CASCADE,
  user_id          uuid        NOT NULL,
  agent_slug       text        NOT NULL,
  step_number      int         NOT NULL DEFAULT 0,
  action_type      text        NOT NULL,
  action_description text,
  result           text,
  created_at       timestamptz DEFAULT now()
);

ALTER TABLE public.agent_execution_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their execution_log"
  ON public.agent_execution_log FOR ALL
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access on execution_log"
  ON public.agent_execution_log FOR ALL
  TO service_role USING (true);

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_agent_tasks_user_status
  ON public.agent_tasks(user_id, status);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_scheduled_pending
  ON public.agent_tasks(scheduled_for)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_exec_log_task_step
  ON public.agent_execution_log(task_id, step_number);

CREATE INDEX IF NOT EXISTS idx_exec_log_user_recent
  ON public.agent_execution_log(user_id, created_at DESC);

-- 4. pg_cron: run agent_executor every 10 minutes
SELECT cron.schedule(
  'agent_executor',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/agent_executor',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
