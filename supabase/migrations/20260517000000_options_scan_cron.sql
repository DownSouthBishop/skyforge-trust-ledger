-- Phase 1C: Options scan cron — Monday and Wednesday at 14:00 UTC
SELECT cron.schedule(
  'atlas-options-scan',
  '0 14 * * 1,3',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_options_scan',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id$$
);
