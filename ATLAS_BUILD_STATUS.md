# Atlas Build Status

Last updated: 2026-05-15

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

## Phase 2 — Broker Connectivity ⏳ NEXT

### To build:
- [ ] `mcp-servers/oanda/` — OANDA v20 REST MCP server
- [ ] `mcp-servers/alpaca/` — Alpaca REST MCP server
- [ ] `services/ibkr-bridge/` — IBKR TWS bridge service
- [ ] Wire `atlas_portfolio_sync` with real broker APIs
- [ ] Wire `atlas_watchlist_patrol` with Alpha Vantage / OANDA prices
- [ ] Live P&L on PositionsPage (real-time position prices)
- [ ] Live price column on MarketsPage

### API keys needed:
- [ ] `OANDA_API_KEY` + `OANDA_ACCOUNT_ID` → oanda.com practice account
- [ ] `ALPACA_API_KEY` + `ALPACA_SECRET_KEY` → alpaca.markets
- [ ] `ALPHA_VANTAGE_API_KEY` → alphavantage.co (free)
- [ ] `POLYGON_API_KEY` → polygon.io (free tier)
- [ ] IBKR TWS running locally with API enabled

---

## Phase 3 — Market Intelligence ⏳

- [ ] Wire `atlas_trade_thesis` with web search + SEC EDGAR
- [ ] Wire `atlas_forex_scan` with OANDA live candles
- [ ] `atlas_obsidian_sync` → filesystem MCP → vault write
- [ ] Obsidian vault folder structure created
- [ ] Morning brief with real macro data (FRED API)

---

## Phase 4 — Autonomous Execution ⏳

- [ ] ElizaOS `atlas-trading` plugin (PLACE_TRADE, CHECK_POSITIONS, CLOSE_POSITION)
- [ ] ElizaOS `atlas-market-data` plugin (MARKET_BRIEF, TRADE_THESIS, FOREX_SCAN)
- [ ] Telegram bot for trade alerts
- [ ] Trade approval UI in PositionsPage (tap to confirm Atlas's pending trades)
- [ ] Cron: forex scan every hour during market hours
- [ ] Cron: watchlist patrol every 15min

---

## Phase 5 — Flywheel ⏳

- [ ] ElizaOS `atlas-felix` plugin ($FELIX monitoring, yield scanning)
- [ ] DeFiLlama API integration
- [ ] Llama 3.1 70B via Ollama (local reasoning fallback)
- [ ] Weekly review upgrade — trading performance + DeFi
- [ ] VPS deployment for always-on Atlas

---

## Next Action (Right Now)

1. Apply migration to Supabase:
   ```
   supabase db push
   ```
   or paste `20260515000001_atlas_trading_schema.sql` into Supabase SQL editor

2. Open broker accounts (parallel with coding):
   - OANDA practice: oanda.com → My Account → Manage API Access → Generate
   - Alpaca paper: alpaca.markets → Dashboard → API Keys
   - IBKR: ibkr.com (24-48hr verification)

3. Register accounts in Profile page once keys are ready

4. Start Phase 2: build OANDA MCP server first (fastest to wire, most impactful for forex)
