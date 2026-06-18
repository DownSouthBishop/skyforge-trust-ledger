-- ══════════════════════════════════════════════════════════════════
-- Izzy Workspace Tables
-- Stack Watch · Audit Queue · Forecasts · Automation Candidates
-- ══════════════════════════════════════════════════════════════════

-- Stack Watch — tech Izzy is actively monitoring
CREATE TABLE IF NOT EXISTS public.izzy_stack_watch (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  category      text NOT NULL DEFAULT 'platform', -- platform | model | tool | infrastructure
  status        text NOT NULL DEFAULT 'stable',   -- stable | shifting | breaking | deprecated
  notes         text,
  last_checked  timestamptz DEFAULT now(),
  created_at    timestamptz DEFAULT now()
);
ALTER TABLE public.izzy_stack_watch ENABLE ROW LEVEL SECURITY;
CREATE POLICY "izzy_stack_watch_owner" ON public.izzy_stack_watch
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS izzy_stack_watch_user_idx ON public.izzy_stack_watch(user_id);

-- Audit Queue — stack audits requested or in progress
CREATE TABLE IF NOT EXISTS public.izzy_audit_queue (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope       text NOT NULL,
  status      text NOT NULL DEFAULT 'queued', -- queued | in_progress | done
  findings    text,
  priority    text NOT NULL DEFAULT 'normal', -- high | normal | low
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
ALTER TABLE public.izzy_audit_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "izzy_audit_queue_owner" ON public.izzy_audit_queue
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS izzy_audit_queue_user_idx ON public.izzy_audit_queue(user_id);

-- Forecasts — probability-weighted technical forecasts
CREATE TABLE IF NOT EXISTS public.izzy_forecasts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  topic           text NOT NULL,
  forecast        text NOT NULL,
  confidence_pct  integer NOT NULL DEFAULT 70 CHECK (confidence_pct BETWEEN 0 AND 100),
  horizon         text NOT NULL DEFAULT '6 months', -- time horizon string
  status          text NOT NULL DEFAULT 'open',     -- open | resolved | expired
  resolution      text,
  created_at      timestamptz DEFAULT now(),
  resolved_at     timestamptz
);
ALTER TABLE public.izzy_forecasts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "izzy_forecasts_owner" ON public.izzy_forecasts
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS izzy_forecasts_user_idx ON public.izzy_forecasts(user_id);

-- Automation Candidates — things Izzy has flagged to automate across WIG
CREATE TABLE IF NOT EXISTS public.izzy_automation_candidates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  description  text NOT NULL,
  source       text,               -- which agent / page / workflow it came from
  priority     text NOT NULL DEFAULT 'normal', -- high | normal | low
  status       text NOT NULL DEFAULT 'candidate', -- candidate | in_progress | done | rejected
  notes        text,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
ALTER TABLE public.izzy_automation_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "izzy_automation_candidates_owner" ON public.izzy_automation_candidates
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS izzy_automation_candidates_user_idx ON public.izzy_automation_candidates(user_id);
