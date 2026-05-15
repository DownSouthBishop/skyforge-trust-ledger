-- Atlas Trading Schema — Phase 0
-- Adds trading infrastructure tables. Existing tables remain intact.

-- trade_ledger: core financial ledger for all trades
CREATE TABLE IF NOT EXISTS public.trade_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('forex', 'equity', 'crypto', 'options', 'futures')),
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  entry_price NUMERIC(18,8) NOT NULL,
  exit_price NUMERIC(18,8),
  quantity NUMERIC(18,8) NOT NULL,
  broker TEXT NOT NULL CHECK (broker IN ('ibkr', 'oanda', 'alpaca', 'manual')),
  broker_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  pnl_usd NUMERIC(12,2),
  pnl_pct NUMERIC(8,4),
  thesis TEXT,
  tags TEXT[],
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.trade_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their trades"
  ON public.trade_ledger FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_trade_ledger_user_status
  ON public.trade_ledger(user_id, status);
CREATE INDEX IF NOT EXISTS idx_trade_ledger_user_symbol
  ON public.trade_ledger(user_id, symbol);
CREATE INDEX IF NOT EXISTS idx_trade_ledger_closed_at
  ON public.trade_ledger(user_id, closed_at DESC);

-- market_watchlist: symbols Atlas monitors
CREATE TABLE IF NOT EXISTS public.market_watchlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  display_name TEXT,
  notes TEXT,
  alert_price_high NUMERIC(18,8),
  alert_price_low NUMERIC(18,8),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.market_watchlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their watchlist"
  ON public.market_watchlist FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_market_watchlist_user_symbol
  ON public.market_watchlist(user_id, symbol)
  WHERE is_active = true;

-- research_notes: Atlas-generated research, synced to Obsidian vault
CREATE TABLE IF NOT EXISTS public.research_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  note_type TEXT NOT NULL CHECK (note_type IN ('thesis', 'morning_brief', 'weekly_review', 'research', 'trade_log')),
  obsidian_path TEXT,
  synced_to_obsidian BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.research_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their research"
  ON public.research_notes FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_research_notes_user_type
  ON public.research_notes(user_id, note_type, created_at DESC);

-- trading_accounts: registered broker accounts
CREATE TABLE IF NOT EXISTS public.trading_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  broker TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('live', 'paper')),
  currency TEXT NOT NULL DEFAULT 'USD',
  balance_usd NUMERIC(12,2),
  buying_power_usd NUMERIC(12,2),
  last_sync_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.trading_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their trading accounts"
  ON public.trading_accounts FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_accounts_user_broker
  ON public.trading_accounts(user_id, broker, account_id);

-- atlas_tasks: autonomous agent task queue
CREATE TABLE IF NOT EXISTS public.atlas_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL CHECK (task_type IN ('research', 'patrol', 'morning_brief', 'trade_check', 'forex_scan', 'watchlist_patrol')),
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  result JSONB,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.atlas_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their tasks"
  ON public.atlas_tasks FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_atlas_tasks_user_status
  ON public.atlas_tasks(user_id, status, scheduled_for);
