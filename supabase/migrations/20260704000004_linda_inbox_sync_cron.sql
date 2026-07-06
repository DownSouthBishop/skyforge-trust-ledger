-- Schedules linda-inbox-sync (IMAP reply polling) every 15 minutes.
-- Uses the vault.decrypted_secrets pattern from 20260703000004_reflect_cron_vault_secrets.sql
-- (confirmed working), not the older current_setting('app.supabase_url') pattern that
-- migration's own comments document as silently broken on this managed instance.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'linda-inbox-sync') THEN
    PERFORM cron.unschedule('linda-inbox-sync');
  END IF;
END $$;

SELECT cron.schedule(
  'linda-inbox-sync',
  '*/15 * * * *',
  $$SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'app_supabase_url') || '/functions/v1/linda-inbox-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'app_service_role_key')),
    body := '{"trigger":"cron"}'::jsonb
  ) AS request_id$$
);
