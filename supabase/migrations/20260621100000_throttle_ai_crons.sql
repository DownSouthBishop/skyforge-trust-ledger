-- Throttle high-frequency AI cron jobs to preserve Gemini free-tier quota.
-- proactive_monitor: 30min → every 4 hours  (48/day → 6/day)
-- session_reflect:   1hr   → every 6 hours  (24/day → 4/day)
-- conversation_analyzer: 1hr → every 6 hours (24/day → 4/day)

SELECT cron.unschedule('proactive_monitor');
SELECT cron.schedule(
  'proactive_monitor',
  '0 */4 * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/proactive_monitor',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{}'::jsonb
  ) AS request_id$$
);

SELECT cron.unschedule('session_reflect');
SELECT cron.schedule(
  'session_reflect',
  '0 */6 * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/session_reflect',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{}'::jsonb
  ) AS request_id$$
);

SELECT cron.unschedule('conversation-analyzer');
SELECT cron.schedule(
  'conversation-analyzer',
  '0 */6 * * *',
  $$SELECT net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/conversation_analyzer',
    headers := jsonb_build_object('Authorization','Bearer ' || current_setting('app.service_role_key'),'Content-Type','application/json'),
    body   := '{}'::jsonb
  ) AS request_id$$
);
