-- daily-agent-reflect has been failing every night since it was scheduled:
-- "function net.http_post(url => text, headers => text, body => unknown)
-- does not exist". The real signature (pg_net on this instance) requires
-- headers and body as jsonb; the original migration passed them as raw
-- string concatenation with no cast. Re-scheduling both jobs with explicit
-- ::jsonb casts. This is why agent_character_state/agent_formative_events
-- have stayed empty -- the mechanism meant to populate them was erroring
-- out silently (cron failures don't surface anywhere but cron.job_run_details).

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-agent-reflect') THEN
    PERFORM cron.unschedule('daily-agent-reflect');
  END IF;
END $$;

SELECT cron.schedule(
  'daily-agent-reflect',
  '0 2 * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_daily_reflect',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || current_setting('app.service_role_key')),
    body := '{"trigger":"cron"}'::jsonb
  ) AS request_id$$
);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'weekly-character-synthesis') THEN
    PERFORM cron.unschedule('weekly-character-synthesis');
  END IF;
END $$;

SELECT cron.schedule(
  'weekly-character-synthesis',
  '0 4 * * 0',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_weekly_character_synthesis',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || current_setting('app.service_role_key')),
    body := '{"trigger":"cron"}'::jsonb
  ) AS request_id$$
);
