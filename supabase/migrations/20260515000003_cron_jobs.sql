-- Enable pg_cron for scheduled edge function calls
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Forex scan every hour on weekdays
SELECT cron.schedule(
  'atlas-forex-scan',
  '0 * * * 1-5',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_forex_scan',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id$$
);

-- Watchlist patrol every 15 minutes on weekdays
SELECT cron.schedule(
  'atlas-watchlist-patrol',
  '*/15 * * * 1-5',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_watchlist_patrol',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id$$
);

-- Morning brief at 10:00 UTC on weekdays
SELECT cron.schedule(
  'atlas-market-brief-morning',
  '0 10 * * 1-5',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_market_brief',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system","brief_type":"morning"}'
  ) AS request_id$$
);

-- EOD brief at 21:00 UTC on weekdays
SELECT cron.schedule(
  'atlas-market-brief-eod',
  '0 21 * * 1-5',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_market_brief',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system","brief_type":"eod"}'
  ) AS request_id$$
);

-- Obsidian sync every 30 minutes
SELECT cron.schedule(
  'atlas-obsidian-sync',
  '*/30 * * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_obsidian_sync',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id$$
);

-- News scan every 60 minutes on weekdays
SELECT cron.schedule(
  'atlas-news-scan',
  '0 * * * 1-5',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_news_scan',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id$$
);
