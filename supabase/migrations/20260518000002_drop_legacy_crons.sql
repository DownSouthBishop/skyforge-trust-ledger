-- Drop all legacy cron jobs pointing to deprecated edge functions.
-- New autonomous schedule is managed by 20260517100003_atlas_cron_jobs.sql.
-- This migration is idempotent — unschedule is a no-op if the job doesn't exist.

SELECT cron.unschedule('atlas-forex-scan');
SELECT cron.unschedule('atlas-watchlist-patrol');
SELECT cron.unschedule('atlas-market-brief-morning');
SELECT cron.unschedule('atlas-market-brief-eod');
SELECT cron.unschedule('atlas-obsidian-sync');
SELECT cron.unschedule('atlas-news-scan');
SELECT cron.unschedule('atlas-business-brief');
SELECT cron.unschedule('atlas-pipeline-scout-weekday');
SELECT cron.unschedule('atlas-pipeline-scout-weekend');
SELECT cron.unschedule('atlas-expense-audit');
SELECT cron.unschedule('atlas-deal-scan');
SELECT cron.unschedule('atlas-lease-monitor');
SELECT cron.unschedule('atlas-re-brief');
SELECT cron.unschedule('atlas-balance-sheet');
SELECT cron.unschedule('atlas-noon-check');
SELECT cron.unschedule('atlas-options-scan');
