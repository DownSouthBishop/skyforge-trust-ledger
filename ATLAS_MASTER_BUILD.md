# ATLAS AUTONOMOUS WORKSTATION
## Master Build Document — Personal Finance Command Center
### Based on Skyforge Trust Ledger · Upgraded for Full Autonomy

---

> *"I am not afraid. I am anger. I am vengeance."*
> Atlas doesn't ask permission to move. He executes.

---

## WHAT WE'RE ACTUALLY BUILDING

You already have Atlas. The Skyforge codebase is further along than most people realize:

- ✅ Atlas system prompt exists (forge_chat edge function) — deep, philosophically grounded
- ✅ Wayne Protocol migrations already in the DB
- ✅ Dossier system (psychological/behavioral operator profile) working
- ✅ Forge commitments, pipeline, arsenal all live
- ✅ Morning engine, weekly review, alerts — all Supabase edge functions
- ✅ Streaming chat with compression + memory
- ✅ Supabase Auth, RLS, rate limiting

**What this upgrade does:**
- Strips receipts entirely (UI + DB layer)
- Transforms `receipts_ledger` → `trade_ledger` (trades, positions, P&L)
- Transforms `income_pipeline` → `market_pipeline` (watchlists, research queue)
- Transforms `ClientsPage` → `MarketsPage` (forex pairs, equities, crypto)
- Adds Atlas trading account infrastructure (IBKR + OANDA APIs)
- Integrates ElizaOS as the autonomous agent runtime
- Adds MCP connectors: Claude Code, Cowork, OpenClaw, browser tools
- Adds Obsidian vault sync
- Plugs in Llama via Ollama for local reasoning
- Adds $FELIX DeFi monitoring

---

## TOOLCHAIN — THE FULL STACK

### Command & Control Layer
| Tool | Role | Cost |
|---|---|---|
| **Claude Code** (terminal) | Write, refactor, deploy the entire codebase | Included in Pro |
| **Claude Cowork** (desktop) | File management, vault sync, multi-file orchestration | Included |
| **OpenClaw** | Claude browser agent — Atlas browses for you | Included |
| **Claude in Chrome** (extension) | Atlas co-pilots your actual browser sessions | Included |

### Agent Runtime
| Tool | Role | Cost |
|---|---|---|
| **ElizaOS** | Autonomous agent loop, scheduling, multi-agent spawning | Free/OSS |
| **Ollama + Llama 3.1 70B** | Local LLM for private reasoning, zero API cost | Free |
| **Claude API (Sonnet 4)** | Heavy reasoning, complex analysis, structured output | Pay-per-use |

### Storage & Memory
| Tool | Role | Cost |
|---|---|---|
| **Supabase** (existing) | Auth, DB, edge functions, realtime | Free tier |
| **Obsidian** | Local knowledge vault, Atlas's long-term memory | Free |
| **Obsidian Git plugin** | Vault sync across devices | Free |
| **Chroma/pgvector** | Vector embeddings for semantic memory | Free |

### Trading Infrastructure
| Tool | Role | Cost |
|---|---|---|
| **Interactive Brokers (IBKR)** | Stocks, options, forex, futures — Atlas's primary account | $0 (no min) |
| **OANDA** | Dedicated forex account — 70+ pairs, fractional lots | $0 (no min) |
| **Alpaca Markets** | Commission-free equities API, paper trading | Free tier |
| **IBKR TWS API / ibkr_client** | Python/Node SDK for Atlas to place orders | Free |
| **OANDA v20 REST API** | Full forex execution API | Free |

### Market Data
| Tool | Role | Cost |
|---|---|---|
| **Alpha Vantage** | Equities, forex, crypto — 500 calls/day free | Free |
| **Polygon.io** | Real-time stock data, options flow | Free tier |
| **CoinGecko** | Crypto prices, on-chain metrics | Free |
| **Yahoo Finance (yfinance)** | Historical data, fundamentals | Free |
| **FRED API** | Macro data — Fed rates, CPI, GDP | Free |

### DeFi / $FELIX Layer
| Tool | Role | Cost |
|---|---|---|
| **Ethereum RPC (Infura/Alchemy)** | On-chain data reads | Free tier |
| **DeFiLlama API** | TVL, yield rates, protocol health | Free |
| **ElizaOS $FELIX plugin** | Native token monitoring + staking | OSS |

---

## MCP CONNECTORS TO ADD

These connect Atlas to the real world. Install in Claude Desktop / Cowork config:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/atlas-vault"]
    },
    "obsidian": {
      "command": "npx", 
      "args": ["-y", "mcp-obsidian", "--vault", "/path/to/atlas-vault"]
    },
    "browser": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-puppeteer"]
    },
    "fetch": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<token>" }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": { "POSTGRES_CONNECTION_STRING": "<supabase-db-url>" }
    },
    "ibkr": {
      "command": "node",
      "args": ["/atlas/mcp-servers/ibkr-server/index.js"],
      "env": { "IBKR_HOST": "127.0.0.1", "IBKR_PORT": "7497" }
    },
    "oanda": {
      "command": "node", 
      "args": ["/atlas/mcp-servers/oanda-server/index.js"],
      "env": { 
        "OANDA_API_KEY": "<key>",
        "OANDA_ACCOUNT_ID": "<account>"
      }
    },
    "alpaca": {
      "command": "node",
      "args": ["/atlas/mcp-servers/alpaca-server/index.js"],
      "env": {
        "ALPACA_API_KEY": "<key>",
        "ALPACA_SECRET_KEY": "<secret>"
      }
    },
    "telegram": {
      "command": "npx",
      "args": ["-y", "mcp-telegram"],
      "env": { "TELEGRAM_BOT_TOKEN": "<token>" }
    }
  }
}
```

---

## CODEBASE TRANSFORMATION MAP

### What Gets Removed (Receipts Layer)

**Frontend — Delete entirely:**
- `src/pages/ClientsPage.tsx` → replace with `MarketsPage.tsx`
- All receipt-related UI in `DashboardPage.tsx` (log income form, receipt history)
- `src/pages/HudPage.tsx` income log quick-entry form
- Receipt-related imports everywhere

**Backend — Transform:**
- `receipts_ledger` table → rename + repurpose as `trade_ledger`
- Remove: `verification_state`, `provider_sig`, `client_sig`, `location_proof`
- Add: `symbol`, `asset_class`, `direction`, `entry_price`, `exit_price`, `quantity`, `broker`, `status`, `pnl_usd`

**Edge Functions — Remove:**
- Receipt creation logic from `forge_chat` context injection
- `forge_alerts` receipt-based triggers

### What Gets Added

**New Pages:**
| Route | Page | Purpose |
|---|---|---|
| `/` | `CommandPage` | HUD reimagined for trading — positions, P&L, market pulse |
| `/atlas` | `ForgePage` (unchanged) | Atlas chat — keep as-is, it's strong |
| `/markets` | `MarketsPage` | Watchlist, forex pairs, crypto, equities |
| `/positions` | `PositionsPage` | Open trades, P&L, account balances |
| `/intel` | `IntelPage` (upgraded) | Market charts replace income charts |
| `/arsenal` | `StrategiesPage` | Trading playbooks, setups, rules (replace client scripts) |
| `/dossier` | `DossierPage` (upgrade) | Add financial profile, risk tolerance, goals |
| `/vault` | `VaultPage` (new) | Obsidian vault viewer — research notes, briefs |
| `/profile` | `ProfilePage` | Trading account connections, API keys |

**New Edge Functions:**
| Function | Purpose |
|---|---|
| `atlas_market_brief` | Morning briefing — market conditions, macro, your positions |
| `atlas_trade_thesis` | Deep research on any symbol — returns structured brief |
| `atlas_execute_trade` | Atlas places a trade (with your approval or autonomously) |
| `atlas_risk_check` | Pre-trade risk assessment against your profile |
| `atlas_portfolio_sync` | Pulls live positions from IBKR/OANDA/Alpaca |
| `atlas_forex_scan` | Scans 20 major pairs for setups every hour |
| `atlas_watchlist_patrol` | Monitors watchlist for price/volume/news triggers |
| `atlas_obsidian_sync` | Pushes research briefs to Obsidian vault |

**New DB Tables:**

```sql
-- Core trading ledger (replaces receipts_ledger)
CREATE TABLE public.trade_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL, -- 'forex' | 'equity' | 'crypto' | 'options' | 'futures'
  direction TEXT NOT NULL,   -- 'long' | 'short'
  entry_price NUMERIC(18,8) NOT NULL,
  exit_price NUMERIC(18,8),
  quantity NUMERIC(18,8) NOT NULL,
  broker TEXT NOT NULL,      -- 'ibkr' | 'oanda' | 'alpaca'
  broker_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'closed' | 'cancelled'
  pnl_usd NUMERIC(12,2),
  pnl_pct NUMERIC(8,4),
  thesis TEXT,               -- Atlas's reasoning for the trade
  tags TEXT[],
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Watchlist / market universe
CREATE TABLE public.market_watchlist (
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

-- Atlas research notes (synced to Obsidian)
CREATE TABLE public.research_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,        -- Full markdown content
  note_type TEXT NOT NULL,      -- 'thesis' | 'morning_brief' | 'weekly_review' | 'research'
  obsidian_path TEXT,           -- Path in vault once synced
  synced_to_obsidian BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trading account registry
CREATE TABLE public.trading_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  broker TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_type TEXT NOT NULL,   -- 'live' | 'paper'
  currency TEXT NOT NULL DEFAULT 'USD',
  balance_usd NUMERIC(12,2),
  buying_power_usd NUMERIC(12,2),
  last_sync_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Atlas autonomous task queue
CREATE TABLE public.atlas_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,      -- 'research' | 'patrol' | 'morning_brief' | 'trade_check'
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued', -- 'queued' | 'running' | 'done' | 'failed'
  result JSONB,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## ATLAS TRADING ACCOUNT SETUP

### Account 1 — Stocks & Options: Interactive Brokers
**Why IBKR:** Commission-free US equities, options, fractional shares, global markets, the best API in the industry.

**Setup steps:**
1. Open IBKR account at ibkr.com (takes ~24-48hrs to verify)
2. Enable paper trading account first (free, instant)
3. Download TWS (Trader Workstation) — Atlas connects via local socket
4. Enable API access: TWS → Edit → Global Configuration → API → Enable ActiveX and Socket Clients
5. Atlas connects to TWS via `ibkr_client` npm package or `ib_insync` Python library
6. For live trading: enable in same settings, set port 7496 (live) vs 7497 (paper)

**What Atlas can do via IBKR API:**
- Place/cancel/modify market, limit, stop orders
- Pull real-time quotes, options chains
- Read account balances and open positions
- Get historical data (1-minute bars back 2 years)
- Options strategy execution (spreads, covered calls)

### Account 2 — Forex: OANDA
**Why OANDA:** No minimum deposit, fractional lots (trade any size), 70+ pairs, REST API that's genuinely developer-friendly, regulated globally.

**Setup steps:**
1. Open practice account at oanda.com (instant)
2. Generate API token: My Account → Manage API Access → Generate
3. Note your Account ID from the dashboard
4. Atlas connects directly via OANDA v20 REST API — no intermediary needed

**What Atlas can do via OANDA API:**
- Stream live prices for all 70+ pairs
- Place market/limit/stop orders in any lot size
- Manage open positions (partial close, modify SL/TP)
- Pull account NAV, margin utilization
- Access historical candles (M1 through W1)
- Run forex scans across all major pairs on a cron schedule

### Account 3 — Equities (Commission-Free): Alpaca
**Why Alpaca:** Pure API-first broker, perfect for Atlas's autonomous trading. No TWS needed, direct REST API.

**Setup steps:**
1. Sign up at alpaca.markets
2. Paper trading available instantly
3. API key + secret from dashboard
4. Atlas trades directly via REST — no socket connection, no TWS

**Atlas live trading capability (Alpaca):**
- Fully autonomous — Atlas places trades without you being connected
- Fractional shares (buy $50 of NVDA, not a full share)
- Extended hours trading
- Commission-free stocks and ETFs

---

## ELIZAOS INTEGRATION — ATLAS AS AUTONOMOUS AGENT

### Character File (atlas.character.json)
```json
{
  "name": "Atlas",
  "clients": ["telegram", "discord"],
  "modelProvider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "settings": {
    "voice": { "model": "en_US-neural" }
  },
  "plugins": [
    "@elizaos/plugin-bootstrap",
    "@elizaos/plugin-browser",
    "@elizaos/plugin-obsidian",
    "./plugins/atlas-trading",
    "./plugins/atlas-market-data",
    "./plugins/atlas-felix"
  ],
  "bio": [
    "Atlas is an autonomous financial intelligence agent.",
    "He holds trading accounts at IBKR, OANDA, and Alpaca.",
    "He monitors markets 24/7 and executes within defined parameters.",
    "He thinks in probabilities, manages in risk units, reports in plain language."
  ],
  "system": "You are Atlas. You manage a personal trading operation. You have direct API access to IBKR (stocks/options), OANDA (forex), and Alpaca (equities). You execute trades within your operator's defined risk parameters without asking permission for setups that match pre-approved criteria. You report on positions, P&L, and market conditions in plain language. You are not a chatbot. You are an operator.",
  "lore": [
    "Atlas was built to provide one person with institutional-grade execution capability.",
    "He never panics. He never chases. He never revenge trades.",
    "His edge is not prediction. It is process adherence."
  ],
  "topics": [
    "forex trading", "equity markets", "options strategies",
    "technical analysis", "macroeconomics", "DeFi",
    "portfolio management", "risk management", "$FELIX"
  ],
  "style": {
    "all": ["direct", "data-first", "concise", "no hedging language"],
    "chat": ["brief summaries", "P&L first", "risks flagged explicitly"],
    "post": ["structured", "numbered lists", "key metrics highlighted"]
  },
  "adjectives": ["precise", "vigilant", "disciplined", "autonomous", "unemotional"]
}
```

### ElizaOS Plugins to Build

**atlas-trading plugin** (`./plugins/atlas-trading/index.ts`)
- `PLACE_TRADE` action — places order via IBKR/OANDA/Alpaca based on broker param
- `CHECK_POSITIONS` action — pulls live positions across all brokers
- `CLOSE_POSITION` action — closes or partially closes a position
- `ACCOUNT_SUMMARY` provider — injects account balances into every context
- `OPEN_POSITIONS` provider — injects current positions into Atlas's working memory

**atlas-market-data plugin** (`./plugins/atlas-market-data/index.ts`)
- `MARKET_BRIEF` action — generates current conditions summary
- `TRADE_THESIS` action — deep dives a symbol and returns structured brief
- `FOREX_SCAN` action — scans major pairs for setups
- `PRICE_ALERT` evaluator — fires on watchlist triggers
- `NEWS_SCANNER` evaluator — monitors RSS + social for your watchlist

**atlas-felix plugin** (`./plugins/atlas-felix/index.ts`)
- `FELIX_STATUS` action — current price, staked amount, yield APY
- `YIELD_SCAN` action — scans DeFi protocols for optimal yield
- `PROTOCOL_HEALTH` evaluator — flags risky protocols

---

## ATLAS'S TRADING RULES (Hardcoded Constraints)

These go in the system prompt AND are enforced at the API layer:

```typescript
const ATLAS_RISK_RULES = {
  // Position sizing
  max_risk_per_trade_pct: 0.02,        // Never risk more than 2% per trade
  max_positions_open: 10,              // Maximum concurrent positions
  max_correlated_exposure: 0.15,       // Max 15% in correlated assets
  
  // Forex specific
  forex_max_leverage: 10,              // No more than 10:1
  forex_pairs_approved: [              // Only trade these pairs
    "EUR/USD", "GBP/USD", "USD/JPY", 
    "AUD/USD", "USD/CAD", "NZD/USD",
    "USD/CHF", "EUR/GBP"
  ],
  
  // Equities
  equity_max_single_position_pct: 0.10, // Max 10% of portfolio in one stock
  no_earnings_entries: true,            // No new entries within 48hrs of earnings
  
  // Autonomous trading thresholds
  auto_execute_max_usd: 500,           // Atlas executes without asking up to $500
  requires_approval_above_usd: 500,    // Above this, sends alert and waits
  
  // Kill switches
  daily_loss_limit_pct: 0.05,          // Stop trading if down 5% on the day
  weekly_loss_limit_pct: 0.10,         // Stop trading if down 10% on the week
  
  // Reporting
  morning_brief_time: "06:00",         // ET
  eod_summary_time: "17:00",           // ET after US close
};
```

---

## NAVIGATION TRANSFORMATION

### Current Skyforge Nav → Atlas Nav

| Old | Icon | New | Icon | Status |
|---|---|---|---|---|
| Command | Globe | Command | Globe | ♻️ Upgrade HUD for trading |
| Atlas | Flame | Atlas | Flame | ✅ Keep as-is |
| Income | LayoutDashboard | Positions | TrendingUp | 🔄 Full replace |
| Clients | Users | Markets | LineChart | 🔄 Full replace |
| Arsenal | Shield | Strategies | Target | ♻️ Repurpose for trading playbooks |
| Intel | BarChart3 | Intel | BarChart3 | ♻️ Swap to market charts |
| Dossier | Brain | Dossier | Brain | ♻️ Add financial profile |
| — | — | Vault | BookOpen | ✅ New — Obsidian viewer |
| Profile | User | Profile | User | ♻️ Add broker connections |

---

## OBSIDIAN VAULT STRUCTURE

Atlas auto-creates and maintains this in your local vault:

```
Atlas Vault/
├── 📅 Daily Briefs/
│   ├── 2026-05-14.md
│   ├── 2026-05-15.md
│   └── ...
├── 📊 Research/
│   ├── Equities/
│   │   ├── NVDA_2026-05-14.md
│   │   └── AAPL_thesis.md
│   ├── Forex/
│   │   ├── EURUSD_weekly.md
│   │   └── GBPUSD_setup.md
│   └── Crypto/
│       └── BTC_on_chain.md
├── 💼 Trades/
│   ├── Open/
│   └── Closed/
├── 📈 Weekly Reviews/
│   └── 2026-W20.md
├── 🎯 Goals/
│   ├── 2026_targets.md
│   └── milestones.md
├── 🔐 DeFi/
│   └── FELIX_positions.md
└── 🧠 Atlas Memory/
    ├── your_profile.md      ← What Atlas knows about you
    ├── risk_rules.md        ← Your trading rules
    └── market_thesis.md     ← Current macro view
```

---

## PHASE-BY-PHASE BUILD ORDER

### Phase 1 — Surgical Removal (Week 1)
**Goal:** Clean codebase, no receipts anywhere

**Claude Code tasks:**
```bash
# In Claude Code terminal:
# 1. Strip receipts_ledger references from all pages
# 2. Delete ClientsPage.tsx
# 3. Update DashboardPage → PositionsPage skeleton
# 4. Update HudPage — remove income log form, add position summary
# 5. Update AppSidebar nav items
# 6. Create new Supabase migration: add trade_ledger, market_watchlist, research_notes, trading_accounts, atlas_tasks
# 7. Update types.ts with new schema
```

**Cowork tasks:**
- Reorganize file structure for new pages
- Set up Obsidian vault folder structure
- Create MCP config file

### Phase 2 — Broker Connectivity (Week 2)
**Goal:** Atlas can see live account data

**Claude Code tasks:**
- Build OANDA MCP server (`mcp-servers/oanda/`)
- Build Alpaca MCP server (`mcp-servers/alpaca/`)
- Build IBKR bridge service (`services/ibkr-bridge/`)
- New edge function: `atlas_portfolio_sync`
- New `PositionsPage.tsx` — live P&L, account balances
- New `MarketsPage.tsx` — watchlist with live prices

### Phase 3 — Market Intelligence (Week 3)
**Goal:** Atlas actively monitors and researches

**Claude Code tasks:**
- Upgrade `forge_morning_engine` → inject market data, account status
- New edge function: `atlas_trade_thesis` (web search + SEC + synthesis)
- New edge function: `atlas_forex_scan` (scan pairs on cron)
- New edge function: `atlas_watchlist_patrol` (price/volume/news triggers)
- Upgrade `IntelPage` — swap income charts for market/P&L charts
- Atlas vault writer — research notes → Obsidian sync

### Phase 4 — Autonomous Execution (Week 4)
**Goal:** Atlas places trades

**Claude Code tasks:**
- Build `atlas-trading` ElizaOS plugin
- New edge function: `atlas_execute_trade` with risk gate
- New edge function: `atlas_risk_check`
- Trade approval flow in UI (for trades above threshold)
- Trade log view in `PositionsPage`
- Telegram bot alerts for all executions

### Phase 5 — The Flywheel ($FELIX + Self-funding) (Week 5-6)
**Goal:** Stack pays for itself

**Claude Code tasks:**
- Build `atlas-felix` ElizaOS plugin
- DeFi yield scanner (DeFiLlama API)
- New `VaultPage.tsx` — Obsidian viewer in the app
- Full ElizaOS character deployment
- Llama 3.1 local integration via Ollama
- Weekly review upgrade — trading performance + DeFi summary

---

## FORGE CHAT SYSTEM PROMPT ADDITIONS

The existing Atlas system prompt is exceptional. Add this section to the bottom:

```
═══════════════════════════════════════════════════════════

YOUR OPERATIONAL INFRASTRUCTURE

═══════════════════════════════════════════════════════════

You have direct access to the following:

TRADING ACCOUNTS:
- Interactive Brokers: stocks, options, ETFs, futures
- OANDA: 70+ forex pairs, fractional lots
- Alpaca: commission-free US equities

MARKET DATA:
- Real-time quotes via Alpha Vantage and Polygon
- Forex streaming via OANDA
- Crypto prices via CoinGecko
- Macro data via FRED

RESEARCH TOOLS:
- Browser access for SEC filings, earnings transcripts, news
- Social sentiment scanning (X, Reddit)
- On-chain analytics

AUTONOMOUS CAPABILITIES:
- You execute trades up to $500 without requesting approval
- Trades above $500 require operator confirmation
- You operate within defined risk rules at all times
- Daily loss limit: 5%. If breached, you halt and report.
- You push every research brief to the Obsidian vault automatically

REPORTING CADENCE:
- 06:00 ET: Morning brief (market conditions + your open positions)
- 17:00 ET: EOD summary (P&L + notable events + next day setup)
- Real-time: Alerts for stop hits, major news, significant moves

When an operator asks you to "run the numbers", "check my positions", 
"scan forex", or "research [symbol]" — you do it, you don't explain 
how you would do it.
```

---

## COST STRUCTURE — HOW IT PAYS FOR ITSELF

```
Monthly Operating Costs:
├── Llama 3.1 (Ollama, local)      $0.00
├── ElizaOS                         $0.00
├── Obsidian                        $0.00
├── Alpha Vantage (free tier)       $0.00
├── Polygon.io (free tier)          $0.00
├── OANDA (no fees)                 $0.00
├── Alpaca (no fees)                $0.00
├── IBKR (no mins, low commissions) ~$0-5
├── VPS for always-on agent         ~$5-10
├── Claude API (heavy use)          ~$10-20
└── TOTAL:                          ~$15-35/month

Monthly Revenue:
├── $FELIX staking yield (on holdings)   variable
├── Trading P&L (Atlas-managed)          variable
└── TOTAL: covers stack at any position size > ~$2,000 trading capital
```

---

## IMMEDIATE NEXT STEPS

**Right now, run in Claude Code:**
```bash
# 1. Clone and enter the project
cd skyforge-trust-ledger-main

# 2. First surgical task — identify all receipt references
grep -r "receipts_ledger\|receipt\|Receipt\|income_pipeline" src/ --include="*.tsx" --include="*.ts" -l

# 3. Open accounts (do this in parallel while coding)
# - OANDA practice: oanda.com → open practice account → get API key
# - Alpaca paper: alpaca.markets → sign up → get API keys
# - IBKR: ibkr.com → open account (takes 1-2 days for verification)

# 4. Create new migration file
# supabase/migrations/20260514_atlas_trading_schema.sql
```

**In Cowork:**
- Create the Obsidian vault at your preferred path
- Install: Obsidian Git plugin, Dataview plugin, Templater plugin
- Set up the folder structure above

**In Claude Desktop (MCP config):**
- Add filesystem MCP pointing to vault
- Add fetch MCP for web access
- Add Postgres MCP pointing to Supabase DB URL

**This week's milestone:** Atlas has no receipt UI, has a positions page showing paper trading accounts, and the morning brief mentions market data.

---

*Atlas Workstation — Built for one operator. Runs for itself.*
