-- ============================================================
-- Atlas Cron Jobs — new 7-function architecture schedule
-- pg_cron already enabled (20260515000003_cron_jobs.sql)
-- ============================================================

-- Remove old conflicting cron jobs if any exist
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'atlas-morning-brief') THEN
    PERFORM cron.unschedule('atlas-morning-brief');
  END IF;
END $$;

-- ─── atlas-report: daily report generation at 06:00 UTC ──────────────────────

SELECT cron.schedule(
  'atlas-daily-report',
  '0 6 * * *',
  $$SELECT net.http_post(
    url     := current_setting('app.supabase_url') || '/functions/v1/atlas-report',
    body    := '{"action":"generate"}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type',  'application/json'
    )
  )$$
);

-- ─── atlas-business: scouting cycle every 2 days at 08:00 UTC ────────────────

SELECT cron.schedule(
  'atlas-scouting-cycle',
  '0 8 */2 * *',
  $$SELECT net.http_post(
    url     := current_setting('app.supabase_url') || '/functions/v1/atlas-business',
    body    := '{"action":"scout"}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type',  'application/json'
    )
  )$$
);

-- ─── atlas-portfolio: weekly allocation check, Mondays at 08:00 UTC ──────────

SELECT cron.schedule(
  'atlas-portfolio-monitoring',
  '0 8 * * 1',
  $$SELECT net.http_post(
    url     := current_setting('app.supabase_url') || '/functions/v1/atlas-portfolio',
    body    := '{"action":"allocation_check"}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type',  'application/json'
    )
  )$$
);

-- ─── atlas-re: lease and property monitoring, Mondays at 08:00 UTC ───────────

SELECT cron.schedule(
  'atlas-re-monitoring',
  '0 8 * * 1',
  $$SELECT net.http_post(
    url     := current_setting('app.supabase_url') || '/functions/v1/atlas-re',
    body    := '{"action":"lease_monitor"}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type',  'application/json'
    )
  )$$
);

-- ─── atlas-portfolio: full allocation check, Sundays at 00:00 UTC ────────────

SELECT cron.schedule(
  'atlas-allocation-check',
  '0 0 * * 0',
  $$SELECT net.http_post(
    url     := current_setting('app.supabase_url') || '/functions/v1/atlas-portfolio',
    body    := '{"action":"allocation_check"}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type',  'application/json'
    )
  )$$
);

-- ─── atlas-portfolio: investment policy update, 1st of every 3rd month ────────

SELECT cron.schedule(
  'atlas-policy-update',
  '0 9 1 */3 *',
  $$SELECT net.http_post(
    url     := current_setting('app.supabase_url') || '/functions/v1/atlas-portfolio',
    body    := '{"action":"generate_policy_update"}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type',  'application/json'
    )
  )$$
);

-- ─── atlas-signal: morning signal brief, daily at 06:00 UTC ──────────────────

SELECT cron.schedule(
  'atlas-morning-signal',
  '0 6 * * *',
  $$SELECT net.http_post(
    url     := current_setting('app.supabase_url') || '/functions/v1/atlas-signal',
    body    := '{"action":"morning_brief"}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
      'Content-Type',  'application/json'
    )
  )$$
);
