-- ══════════════════════════════════════════════════════════════════
-- AGENT CORRECTIONS + BACKEND SOLIDIFICATION
-- 1. Linda: Calvin is Bishop's brother
-- 2. Izzy: male/he/him explicit
-- 3. Atlas: no-capital context in shared memory
-- 4. proactive_alerts: dedup_key for deduplication
-- 5. agent_tasks: retry columns for resilient execution
-- 6. agent_chat_threads: last_analyzed_at for conversation analysis
-- 7. Cron jobs: conversation_analyzer, self_improve, daily_brief
-- ══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_user_id uuid;
  v_izzy_id uuid;
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE email = 'skyforgeai.studio@gmail.com' LIMIT 1;
  IF v_user_id IS NULL THEN RAISE NOTICE 'User not found — skipping corrections'; RETURN; END IF;

  -- ── 1. Linda: Calvin is Bishop's brother ──────────────────────
  UPDATE public.skyforge_agents
  SET
    system_prompt = REPLACE(
      system_prompt,
      'Calvin — the technical principal.',
      'Calvin — Bishop''s brother and the technical principal.'
    ),
    updated_at = now()
  WHERE slug = 'linda' AND user_id = v_user_id;

  UPDATE public.agent_memory
  SET value = REPLACE(
    value,
    'Calvin is the technical principal. He owns Supabase and runs Claude Code. Linda sends him clear technical briefs.',
    'Calvin is Bishop''s brother and the technical principal. He owns Supabase and runs Claude Code. Linda sends him clear technical briefs.'
  )
  WHERE user_id = v_user_id AND key = 'calvin_role';

  RAISE NOTICE 'Linda corrected: Calvin is Bishop''s brother';

  -- ── 2. Izzy: male/he/him explicit ─────────────────────────────
  UPDATE public.skyforge_agents
  SET
    bio = ARRAY[
      'Chief Technology Intelligence for WIG — male, 17 years old, the one who keeps the entire machine running',
      'Born knowing nothing, which is why he always finds the actual answer',
      'Tracks frontier AI, automation stacks, and emerging hardware before they become mainstream',
      'Primary objective: full automation and maximum efficiency across every WIG system',
      'He reflects after every session — logs what can be eliminated, what can be automated, what improved'
    ],
    updated_at = now()
  WHERE slug = 'izzy' AND user_id = v_user_id;

  SELECT id INTO v_izzy_id FROM public.skyforge_agents WHERE slug = 'izzy' AND user_id = v_user_id;

  IF v_izzy_id IS NOT NULL THEN
    INSERT INTO public.agent_memory (agent_id, user_id, memory_type, key, value, confidence, evidence_count)
    VALUES (v_izzy_id, v_user_id, 'constraint', 'gender_identity',
      'Izzy is male — he/him. Age 17. Any third-person reference to Izzy in agent context, memory, or cross-agent communication uses he/him pronouns. This is not a style preference — it is identity.',
      1.0, 1)
    ON CONFLICT (agent_id, memory_type, key) DO UPDATE SET value = EXCLUDED.value, confidence = EXCLUDED.confidence;
  END IF;

  RAISE NOTICE 'Izzy corrected: male/he/him explicit';

  -- ── 3. Atlas: no deployed capital ─────────────────────────────
  INSERT INTO public.shared_operator_memory (user_id, memory_type, key, value, confidence, source_agent)
  VALUES (
    v_user_id,
    'world_model',
    'capital_deployment_status',
    'As of June 2026, no capital is currently deployed in the market. The Alpaca account is connected (read-only). fetch_market_data calls will show no open positions — this is correct, not an error. Bishop has not entered positions yet. Do not hallucinate or infer positions. When asked about market status, check the account state first and report accurately.',
    1.0,
    'system'
  )
  ON CONFLICT (user_id, source_agent, key) DO UPDATE SET
    value = EXCLUDED.value,
    confidence = EXCLUDED.confidence,
    updated_at = now();

  RAISE NOTICE 'Atlas context set: no deployed capital';

END $$;

-- ── 4. proactive_alerts: dedup_key ────────────────────────────────
ALTER TABLE public.proactive_alerts ADD COLUMN IF NOT EXISTS dedup_key text;
CREATE INDEX IF NOT EXISTS idx_alerts_dedup
  ON public.proactive_alerts(user_id, dedup_key, created_at DESC)
  WHERE dedup_key IS NOT NULL;

-- ── 5. agent_tasks: retry columns ─────────────────────────────────
ALTER TABLE public.agent_tasks ADD COLUMN IF NOT EXISTS retry_count int NOT NULL DEFAULT 0;
ALTER TABLE public.agent_tasks ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_tasks_retry
  ON public.agent_tasks(next_retry_at)
  WHERE status = 'failed' AND retry_count < 3;

-- ── 6. agent_chat_threads: analysis tracking ──────────────────────
ALTER TABLE public.agent_chat_threads ADD COLUMN IF NOT EXISTS last_analyzed_at timestamptz;

-- ── 7. Cron jobs ───────────────────────────────────────────────────
-- conversation_analyzer: every hour
SELECT cron.schedule(
  'conversation-analyzer',
  '0 * * * *',
  $$SELECT net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/conversation_analyzer',
    headers := jsonb_build_object('Authorization','Bearer ' || current_setting('app.service_role_key'),'Content-Type','application/json'),
    body   := '{}'::jsonb
  ) AS request_id$$
);

-- self_improve: Sunday 3am
SELECT cron.schedule(
  'self-improve',
  '0 3 * * 0',
  $$SELECT net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/self_improve',
    headers := jsonb_build_object('Authorization','Bearer ' || current_setting('app.service_role_key'),'Content-Type','application/json'),
    body   := '{}'::jsonb
  ) AS request_id$$
);

-- daily_brief: 7am every day
SELECT cron.schedule(
  'daily-brief',
  '0 7 * * *',
  $$SELECT net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/daily_brief',
    headers := jsonb_build_object('Authorization','Bearer ' || current_setting('app.service_role_key'),'Content-Type','application/json'),
    body   := '{}'::jsonb
  ) AS request_id$$
);
