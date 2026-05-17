-- Unified Balance Sheet — Phase 4A

CREATE TABLE IF NOT EXISTS public.balance_sheet_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  -- Paper Assets
  trading_cash_usd NUMERIC(12,2) DEFAULT 0,
  trading_positions_value_usd NUMERIC(12,2) DEFAULT 0,
  trading_pnl_mtd NUMERIC(12,2) DEFAULT 0,
  -- Business
  business_cash_usd NUMERIC(12,2) DEFAULT 0,
  business_revenue_mtd NUMERIC(12,2) DEFAULT 0,
  business_expenses_mtd NUMERIC(12,2) DEFAULT 0,
  business_pipeline_value_usd NUMERIC(12,2) DEFAULT 0,
  -- Real Estate
  re_portfolio_value_usd NUMERIC(12,2) DEFAULT 0,
  re_mortgage_balance_usd NUMERIC(12,2) DEFAULT 0,
  re_equity_usd NUMERIC(12,2) DEFAULT 0,
  re_cash_flow_mtd NUMERIC(12,2) DEFAULT 0,
  -- Totals
  total_assets_usd NUMERIC(12,2) GENERATED ALWAYS AS (
    trading_cash_usd + trading_positions_value_usd + business_cash_usd + re_portfolio_value_usd
  ) STORED,
  total_liabilities_usd NUMERIC(12,2) DEFAULT 0,
  net_worth_usd NUMERIC(12,2) GENERATED ALWAYS AS (
    trading_cash_usd + trading_positions_value_usd + business_cash_usd + re_portfolio_value_usd - total_liabilities_usd
  ) STORED,
  -- Allocation
  paper_assets_pct NUMERIC(5,2),
  business_pct NUMERIC(5,2),
  re_pct NUMERIC(5,2),
  cash_pct NUMERIC(5,2),
  -- Atlas narrative
  atlas_summary TEXT,
  atlas_recommendation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.balance_sheet_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their snapshots" ON public.balance_sheet_snapshots FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_balance_sheet_user_date ON public.balance_sheet_snapshots(user_id, snapshot_date DESC);
