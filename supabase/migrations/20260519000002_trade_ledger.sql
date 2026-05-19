-- trade_ledger: records every position Atlas opens or closes
-- Referenced by atlas_log_trade / atlas_close_trade MCP tools and telegram-bridge reporting

create table if not exists public.trade_ledger (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references auth.users(id) on delete cascade,
  symbol           text not null,
  side             text not null check (side in ('buy','sell')),
  qty              numeric not null,
  order_type       text not null default 'market' check (order_type in ('market','limit','stop','stop_limit')),
  status           text not null default 'open' check (status in ('open','closed','cancelled')),
  entry_price      numeric,
  exit_price       numeric,
  alpaca_order_id  text,
  notes            text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

alter table public.trade_ledger enable row level security;

create policy "Users see own trades"
  on public.trade_ledger
  for all
  using (auth.uid() = user_id);

-- keep updated_at current automatically (requires moddatetime extension)
create trigger set_trade_updated_at
  before update on public.trade_ledger
  for each row execute function moddatetime(updated_at);
