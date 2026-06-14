UPDATE public.atlas_mcp_connections SET is_verified = true, last_ping_at = now()
WHERE transport = 'stdio';

UPDATE public.atlas_mcp_connections SET
  is_verified = true,
  last_ping_at = now(),
  capabilities = '[
    {"name":"alpaca_account","description":"Alpaca account: buying power, portfolio value, cash."},
    {"name":"alpaca_positions","description":"All open Alpaca positions with P&L."},
    {"name":"alpaca_quote","description":"Latest quote for a symbol."},
    {"name":"alpaca_bars","description":"OHLCV bars for a symbol."},
    {"name":"alpaca_place_order","description":"Place a market or limit order."},
    {"name":"alpaca_close_position","description":"Close a position by symbol."}
  ]'::jsonb
WHERE slug = 'alpaca';

UPDATE public.atlas_mcp_connections SET
  is_verified = true,
  last_ping_at = now(),
  capabilities = '[
    {"name":"oanda_account","description":"OANDA account balance, NAV, margin, P&L."},
    {"name":"oanda_positions","description":"All open OANDA positions with P&L."},
    {"name":"oanda_price","description":"Live bid/ask for forex pairs."},
    {"name":"oanda_candles","description":"OHLC candles."},
    {"name":"oanda_place_order","description":"Place order. Positive units=long, negative=short."},
    {"name":"oanda_close_trade","description":"Close trade by ID."}
  ]'::jsonb
WHERE slug = 'oanda';