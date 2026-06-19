-- ══════════════════════════════════════════════════════════════════
-- FINANCIAL HQ + SPEND TRACKER
-- Creates financial_accounts and spend_transactions tables.
-- These back the Financial HQ (balance sheet) and Spend Tracker
-- (transaction log) pages, and feed the agent financial snapshot.
-- ══════════════════════════════════════════════════════════════════

-- financial_accounts: balance sheet — cash, cards, assets, liabilities
CREATE TABLE IF NOT EXISTS public.financial_accounts (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type           text        NOT NULL CHECK (type IN ('cash', 'credit', 'debit', 'asset', 'liability')),
  name           text        NOT NULL,
  balance        numeric(14,2) NOT NULL DEFAULT 0,
  limit_amount   numeric(14,2),
  notes          text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.financial_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their financial accounts"
  ON public.financial_accounts FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role manages financial accounts"
  ON public.financial_accounts FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_fin_accounts_user
  ON public.financial_accounts (user_id, type);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.financial_accounts TO authenticated;
GRANT ALL ON public.financial_accounts TO service_role;

-- spend_transactions: outflow log — deducts from account balance on insert
CREATE TABLE IF NOT EXISTS public.spend_transactions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id     uuid        REFERENCES public.financial_accounts(id) ON DELETE SET NULL,
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  category       text        NOT NULL DEFAULT 'Other',
  note           text,
  date           date        NOT NULL DEFAULT CURRENT_DATE,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.spend_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their spend transactions"
  ON public.spend_transactions FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role manages spend transactions"
  ON public.spend_transactions FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_spend_txs_user_date
  ON public.spend_transactions (user_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_spend_txs_account
  ON public.spend_transactions (account_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.spend_transactions TO authenticated;
GRANT ALL ON public.spend_transactions TO service_role;
