-- ══════════════════════════════════════════════════════════════════
-- FINANCIAL ENHANCEMENTS
-- 1. Add flow direction to spend_transactions (income vs expense)
-- 2. Budget targets per category
-- 3. Net worth snapshots over time
-- ══════════════════════════════════════════════════════════════════

-- 1. Income / expense direction on transactions
ALTER TABLE public.spend_transactions
  ADD COLUMN IF NOT EXISTS flow text NOT NULL DEFAULT 'out'
  CHECK (flow IN ('out', 'in'));

-- 2. Monthly budget targets per category
CREATE TABLE IF NOT EXISTS public.budget_targets (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category     text        NOT NULL,
  monthly_limit numeric(14,2) NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, category)
);

ALTER TABLE public.budget_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their budget targets"
  ON public.budget_targets FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role manages budget targets"
  ON public.budget_targets FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.budget_targets TO authenticated;
GRANT ALL ON public.budget_targets TO service_role;

-- 3. Net worth history (snapshot per balance change)
CREATE TABLE IF NOT EXISTS public.net_worth_snapshots (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  net_worth       numeric(14,2) NOT NULL,
  cash            numeric(14,2) NOT NULL DEFAULT 0,
  credit_available numeric(14,2) NOT NULL DEFAULT 0,
  assets          numeric(14,2) NOT NULL DEFAULT 0,
  liabilities     numeric(14,2) NOT NULL DEFAULT 0,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.net_worth_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their net worth snapshots"
  ON public.net_worth_snapshots FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role manages net worth snapshots"
  ON public.net_worth_snapshots FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_nw_snapshots_user_time
  ON public.net_worth_snapshots (user_id, recorded_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.net_worth_snapshots TO authenticated;
GRANT ALL ON public.net_worth_snapshots TO service_role;
