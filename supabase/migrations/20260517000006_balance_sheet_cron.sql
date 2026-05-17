-- Balance sheet cron — Phase 4D
-- Every Sunday at 20:00 UTC
SELECT cron.schedule(
  'atlas-balance-sheet',
  '0 20 * * 0',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_balance_sheet',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id$$
);
