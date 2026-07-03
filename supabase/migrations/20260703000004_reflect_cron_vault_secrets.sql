-- Follow-up to 20260703000003_fix_reflect_cron_jobs.sql: that migration fixed
-- the jsonb-cast bug, but running it revealed a second, previously-masked
-- issue -- `current_setting('app.supabase_url')` / `app.service_role_key`
-- were never actually set anywhere on this database (confirmed via
-- pg_settings), and this managed instance doesn't allow ALTER DATABASE ...
-- SET for custom GUCs (permission denied). The original error masked this:
-- Postgres resolves function-overload types at parse time, before argument
-- expressions actually execute, so the net.http_post argument-type mismatch
-- fired before current_setting() was ever evaluated.
--
-- Fixed properly via Supabase Vault instead -- the correct place for a
-- credential like this. The two secrets (app_supabase_url,
-- app_service_role_key) were already created directly against the live
-- database (not via this migration, since a migration file is git-tracked
-- and must never contain the actual secret value). This migration only
-- re-points the cron jobs at vault.decrypted_secrets by name.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-agent-reflect') THEN
    PERFORM cron.unschedule('daily-agent-reflect');
  END IF;
END $$;

SELECT cron.schedule(
  'daily-agent-reflect',
  '0 2 * * *',
  $$SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'app_supabase_url') || '/functions/v1/atlas_daily_reflect',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'app_service_role_key')),
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
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'app_supabase_url') || '/functions/v1/atlas_weekly_character_synthesis',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'app_service_role_key')),
    body := '{"trigger":"cron"}'::jsonb
  ) AS request_id$$
);
