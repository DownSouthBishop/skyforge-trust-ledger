-- Real estate cron jobs — Phase 3D

-- Deal scan: daily at 07:00 UTC
SELECT cron.schedule(
  'atlas-deal-scan',
  '0 7 * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_deal_scan',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id$$
);

-- Lease monitor: daily at 08:30 UTC
SELECT cron.schedule(
  'atlas-lease-monitor',
  '30 8 * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_lease_monitor',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id$$
);

-- RE brief: first of every month at 07:00 UTC
SELECT cron.schedule(
  'atlas-re-brief',
  '0 7 1 * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_re_brief',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id$$
);
