-- Add the columns the PositionsPage app expects on trade_ledger.
-- The original migration (20260519000002) created the MCP-facing columns
-- (side, qty, alpaca_order_id). These add the app-facing columns so both
-- the UI and the MCP tools work against the same table.

alter table public.trade_ledger
  add column if not exists asset_class  text not null default 'equity',
  add column if not exists direction    text check (direction in ('long','short')),
  add column if not exists quantity     numeric,
  add column if not exists opened_at   timestamptz default now(),
  add column if not exists closed_at   timestamptz,
  add column if not exists pnl_usd     numeric,
  add column if not exists pnl_pct     numeric,
  add column if not exists thesis      text,
  add column if not exists broker      text not null default 'alpaca';
