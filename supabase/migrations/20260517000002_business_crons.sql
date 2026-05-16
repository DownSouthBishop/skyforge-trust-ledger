-- Business vertical cron jobs — Phase 2E

-- Weekly business brief: every Monday at 09:00 UTC
SELECT cron.schedule(
  'atlas-business-brief',
  '0 9 * * 1',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_business_brief',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id$$
);

-- Pipeline scout: weekdays at 08:00 UTC
SELECT cron.schedule(
  'atlas-pipeline-scout-weekday',
  '0 8 * * 1-5',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_pipeline_scout',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id$$
);

-- Pipeline scout: weekends at 10:00 UTC
SELECT cron.schedule(
  'atlas-pipeline-scout-weekend',
  '0 10 * * 6,0',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_pipeline_scout',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id$$
);

-- Expense audit: first of every month at 06:00 UTC
SELECT cron.schedule(
  'atlas-expense-audit',
  '0 6 1 * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/atlas_expense_audit',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer ' || current_setting('app.service_role_key') || '"}',
    body := '{"user_id":"system"}'
  ) AS request_id$$
);
