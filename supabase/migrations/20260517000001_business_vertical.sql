-- Business Vertical — Phase 2A
-- Pipeline, ledger, and task tables for the business intelligence vertical

CREATE TABLE IF NOT EXISTS public.business_pipeline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_name TEXT NOT NULL,
  contact_email TEXT,
  company TEXT,
  opportunity TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'prospect' CHECK (stage IN ('prospect','outreach','follow_up','proposal','negotiation','closed_won','closed_lost')),
  estimated_value_usd NUMERIC(12,2),
  probability_pct NUMERIC(5,2),
  last_contact_at TIMESTAMPTZ,
  next_action TEXT,
  next_action_due TIMESTAMPTZ,
  notes TEXT,
  tags TEXT[],
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.business_pipeline ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their pipeline" ON public.business_pipeline FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_business_pipeline_user_stage ON public.business_pipeline(user_id, stage);
CREATE INDEX IF NOT EXISTS idx_business_pipeline_next_action ON public.business_pipeline(user_id, next_action_due);

CREATE TABLE IF NOT EXISTS public.business_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('revenue','expense','transfer')),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_usd NUMERIC(12,2) NOT NULL,
  counterparty TEXT,
  invoice_id TEXT,
  stripe_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','overdue','cancelled')),
  due_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  recurring BOOLEAN NOT NULL DEFAULT false,
  recurrence_interval TEXT CHECK (recurrence_interval IN ('weekly','monthly','quarterly','annual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.business_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their business ledger" ON public.business_ledger FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_business_ledger_user_type ON public.business_ledger(user_id, entry_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_ledger_status ON public.business_ledger(user_id, status, due_at);

CREATE TABLE IF NOT EXISTS public.business_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL CHECK (task_type IN ('outreach','follow_up','invoice','payment','audit','report')),
  pipeline_id UUID REFERENCES public.business_pipeline(id),
  ledger_id UUID REFERENCES public.business_ledger(id),
  subject TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','approved','sent','done','cancelled')),
  requires_approval BOOLEAN NOT NULL DEFAULT true,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.business_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their business tasks" ON public.business_tasks FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_business_tasks_user_status ON public.business_tasks(user_id, status, scheduled_for);
