-- Phase 5: Income velocity infrastructure
-- Noon deficit check + daily income target preference default + options scan daily

-- Noon deficit check — every weekday at 12:00 UTC (7am EST = prime action window)
SELECT cron.schedule(
  'atlas-noon-check',
  '0 12 * * 1-5',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_noon_check',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id$$
);

-- Upgrade options scan from Mon/Wed to every weekday (more yield income opportunities)
SELECT cron.unschedule('atlas-options-scan');
SELECT cron.schedule(
  'atlas-options-scan',
  '0 14 * * 1-5',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_options_scan',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id$$
);

-- Watchlist patrol: tighten to every 15 minutes during market hours (was 30 min)
-- (existing 'atlas-watchlist-patrol' schedule stays — already 15 min in original cron)
