-- 20260620000003_council_decompose_consolidate.sql
-- Council sessions log, operator profile, objective entry type

-- 1. council_log — records of autonomous multi-agent deliberations
CREATE TABLE IF NOT EXISTS public.council_log (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  topic       text        NOT NULL,
  agents      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  synthesis   text,
  created_at  timestamptz DEFAULT now()
);

ALTER TABLE public.council_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their council_log" ON public.council_log FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Service role full access on council_log" ON public.council_log FOR ALL TO service_role USING (true);
CREATE INDEX IF NOT EXISTS idx_council_log_user ON public.council_log(user_id, created_at DESC);

-- 2. operator_profile — distilled memory, rebuilt weekly
CREATE TABLE IF NOT EXISTS public.operator_profile (
  user_id      uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  profile_text text,
  key_facts    jsonb       DEFAULT '[]'::jsonb,
  generated_at timestamptz DEFAULT now()
);

ALTER TABLE public.operator_profile ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their operator_profile" ON public.operator_profile FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Service role full access on operator_profile" ON public.operator_profile FOR ALL TO service_role USING (true);

-- 3. Add 'objective' to dossier_suggestions entry_type
ALTER TABLE public.dossier_suggestions DROP CONSTRAINT IF EXISTS dossier_suggestions_entry_type_check;
ALTER TABLE public.dossier_suggestions
  ADD CONSTRAINT dossier_suggestions_entry_type_check
  CHECK (entry_type IN ('goal', 'task', 'journal', 'trade', 'objective'));

-- 4. pg_cron: memory_consolidate weekly (Sunday 2am)
SELECT cron.schedule(
  'memory_consolidate',
  '0 2 * * 0',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/memory_consolidate',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'::jsonb
  ) AS request_id;
  $$
);

-- 5. pg_cron: goal_decompose daily (6am)
SELECT cron.schedule(
  'goal_decompose',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/goal_decompose',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
