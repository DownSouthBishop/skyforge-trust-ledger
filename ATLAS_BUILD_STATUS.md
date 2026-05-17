# Atlas Build Status

Last updated: 2026-05-16

---

## Phase A — Hardening ✅ COMPLETE

### Migrations added
- [x] `20260516120000_circuit_breaker.sql` — Postgres trigger on `trade_ledger`, enforces 5% daily loss limit at DB level. An LLM cannot override this.
- [x] `20260516120001_public_ledger.sql` — `atlas_public_ledger` view: read-only anon-accessible view of closed trades (no PII), enables public track record.
- [x] `20260516120002_atlas_preferences_weights.sql` — `atlas_preferences` table with `play_type_weights` JSONB for RL feedback loop.

### Shared prompt extracted
- [x] `supabase/functions/_shared/atlas_prompt.ts` — `ATLAS_SYSTEM_PROMPT`, `TRADING_INFRASTRUCTURE_PROMPT`, `AUTONOMOUS_OPS_PROMPT`, `ADVISOR_LAYER_PROMPT` all exported from single source of truth.

### Anthropic API migration (direct — no gateway)
- [x] `forge_execute` — migrated from `callGatewayWithRetry` + `LOVABLE_API_KEY` → direct Anthropic API + `ANTHROPIC_API_KEY`. Uses full Atlas system prompt.
- [x] `atlas_opportunity_scan` — migrated to Anthropic API. Reads `play_type_weights` from `atlas_preferences` at start of each run and applies multipliers to feasibility scoring.
- [x] `atlas_play_ranker` — migrated to Anthropic API. After ranking, writes Sharpe-normalised `play_type_weights` to `atlas_preferences`. RL feedback loop is now wired end-to-end.

### RL Feedback Loop — wired
- `atlas_play_ranker` → computes Sharpe per play_type → writes weights to `atlas_preferences`
- `atlas_opportunity_scan` → reads weights → applies multiplier to feasibility score
- Proven play types get up to 1.5× feasibility boost. Underperformers get down to 0.5×.

### What's needed to activate
- Set `ANTHROPIC_API_KEY` in Supabase: `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...`
- Apply all three new migrations in Supabase SQL editor
- `LOVABLE_API_KEY` / gateway still needed for `forge_chat` (do not change — it's stable)

---

## Phase 0 — Foundation ✅ COMPLETE

### Database
- [x] Migration `20260515000001_atlas_trading_schema.sql` — 5 new tables
  - `trade_ledger` (replaces receipts as financial core)
  - `market_watchlist`
  - `research_notes` (Vault)
  - `trading_accounts`
  - `atlas_tasks`
- [x] Types.ts updated with all new table definitions

### UI — Surgical Removal
- [x] `ClientsPage.tsx` → deleted
- [x] `DashboardPage.tsx` → deleted
- [x] `HudPage.tsx` → Command Center (income log removed, market pulse added)
- [x] `IntelPage.tsx` → P&L charts (receipts_ledger removed)
- [x] `AppSidebar.tsx` → Atlas nav (Positions, Markets, Strategies, Vault)
- [x] `MobileNav.tsx` → updated
- [x] `App.tsx` → new routing (/positions, /markets, /vault, redirects)
- [x] `ForgePage.tsx` → receipt directive removed

### New Pages
- [x] `MarketsPage.tsx` — watchlist, forex universe, add/remove symbols
- [x] `PositionsPage.tsx` — trade ledger, P&L, manual entry, close trade
- [x] `VaultPage.tsx` — research notes viewer
- [x] `ProfilePage.tsx` — broker connections, trade stats, API setup guide

### Repurposed Pages
- [x] `ArsenalPage.tsx` → StrategiesPage (categories: setups, playbooks, risk-rules, thesis, criteria)

### Edge Functions (Atlas Infrastructure)
- [x] `atlas_market_brief` — morning + EOD briefings, saves to Vault
- [x] `atlas_trade_thesis` — deep symbol research, saves to Vault
- [x] `atlas_risk_check` — pre-trade risk gate (2% rule, position limits, daily loss limit)
- [x] `atlas_execute_trade` — risk-gated trade logging, approval alerts above $500
- [x] `atlas_portfolio_sync` — broker sync scaffold (Phase 2 API stubs)
- [x] `atlas_forex_scan` — approved pairs scan, saves to Vault
- [x] `atlas_watchlist_patrol` — price threshold monitoring (Phase 2 price feed stubs)
- [x] `atlas_obsidian_sync` — vault sync scaffold (Phase 3 filesystem stubs)

### forge_chat
- [x] `TRADING_INFRASTRUCTURE_PROMPT` added to system messages
- [x] Trajectory fallback updated (no receipts reference)

### forge_morning_engine
- [x] Trading accounts + open positions injected into morning brief prompt

### ElizaOS
- [x] `atlas.character.json` — full character with plugins, actions, risk rules, style

---

## Phase 2 — Broker Connectivity ✅ COMPLETE (code layer)

### MCP Servers built:
- [x] `mcp-servers/oanda/` — OANDA v20 REST MCP (get_account, get_positions, get_price, get_candles, place_order, close_trade)
- [x] `mcp-servers/alpaca/` — Alpaca REST MCP (account, positions, orders, quote, bars, place_order, close_position)
- [x] `mcp-servers/ibkr/` — IBKR TWS MCP (account_summary, positions, market_data, place_order, pnl)
- [x] `mcp-config.json` — Claude Desktop MCP config template

### UI upgrades:
- [x] `PositionsPage.tsx` — Pending trade approval cards (Approve / Decline)
- [x] `HudPage.tsx` — "Run Brief" button → calls `atlas_market_brief`
- [x] `VaultPage.tsx` — "Research Symbol" input + "Forex Scan" button
- [x] `ForgePage.tsx` — Trading chips: Run Brief, Forex Scan, Check Positions
- [x] `forge_weekly_review` — Upgraded to trading P&L (removed receipts_ledger)
- [x] `DossierPage.tsx` — Trading profile fields: asset classes, risk tolerance, goals, max drawdown, pairs

### Wiring still needed (requires API keys):
- [ ] Wire `atlas_portfolio_sync` with real OANDA/Alpaca/IBKR APIs
- [ ] Wire `atlas_watchlist_patrol` with Alpha Vantage / OANDA price feeds
- [ ] Live P&L column on PositionsPage (Phase 2+ real-time prices)
- [ ] Live price column on MarketsPage

### API keys needed (get these now):
- [ ] `OANDA_API_KEY` + `OANDA_ACCOUNT_ID` → oanda.com → My Account → Manage API Access
- [ ] `ALPACA_API_KEY` + `ALPACA_SECRET_KEY` → alpaca.markets → Dashboard → API Keys
- [ ] `ALPHA_VANTAGE_API_KEY` → alphavantage.co (free tier)
- [ ] `POLYGON_API_KEY` → polygon.io (free tier)
- [ ] IBKR TWS running locally with API enabled (port 7497)

---

## Phase 3 — Market Intelligence ⏳

- [ ] Wire `atlas_trade_thesis` with web search MCP + SEC EDGAR
- [ ] Wire `atlas_forex_scan` with OANDA live candles (replace Phase 2 stubs)
- [ ] `atlas_obsidian_sync` → filesystem MCP → actual vault write
- [ ] Create Obsidian vault folder: Atlas/Daily Briefs, Research, Trades, Weekly Reviews
- [ ] Morning brief with real macro data (FRED API)

---

## Phase 4 — Autonomous Execution ✅ COMPLETE (code layer)

- [x] `plugins/atlas-trading/` — PLACE_TRADE, CHECK_POSITIONS, CLOSE_POSITION, ACCOUNT_SUMMARY
- [x] `plugins/atlas-market-data/` — MARKET_BRIEF, TRADE_THESIS, FOREX_SCAN + PRICE_ALERT evaluator
- [x] Trade approval UI in PositionsPage (pending approvals with Approve/Decline)
- [ ] Telegram bot for trade alerts (Phase 4 deployment)
- [ ] Cron: forex scan every hour during market hours
- [ ] Cron: watchlist patrol every 15min

---

## Phase 5 — Flywheel ✅ COMPLETE (code layer)

- [x] `plugins/atlas-felix/` — FELIX_STATUS, YIELD_SCAN, PROTOCOL_HEALTH evaluator
- [x] DeFiLlama API integration (in atlas-felix plugin)
- [ ] Set FELIX_COINGECKO_ID env once $FELIX is listed
- [ ] Llama 3.1 70B via Ollama (local reasoning fallback)
- [ ] VPS deployment for always-on Atlas

---

## Next Action (Right Now)

1. Apply both migrations to Supabase SQL editor:
   - `20260515000001_atlas_trading_schema.sql` — core trading tables
   - `20260515000002_dossier_trading_fields.sql` — dossier trading profile columns

2. Open broker accounts:
   - OANDA practice: oanda.com → My Account → Manage API Access → Generate token
   - Alpaca paper: alpaca.markets → Dashboard → API Keys → Generate
   - IBKR: ibkr.com (24-48hr verification)

3. Configure MCP servers:
   - Run `npm install` in `mcp-servers/oanda/`, `mcp-servers/alpaca/`, `mcp-servers/ibkr/`
   - Fill in API keys in `mcp-config.json`
   - Merge config into Claude Desktop settings and restart

4. Test the full loop:
   - Open Claude Desktop → ask "Check my OANDA account" → should return live data
   - Run a market brief from HudPage → check Vault for the note
   - Research a symbol from VaultPage → thesis should appear in Vault
