# Atlas Environment Setup

All secrets are set as Supabase Edge Function secrets via:
```
supabase secrets set KEY=value
```

---

## Core (Required for all functions)

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL (auto-injected in Edge Functions) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key — full DB access (auto-injected) |
| `LOVABLE_API_KEY` | AI gateway key for all Atlas LLM calls |
| `ATLAS_MODEL` | Model string override (default: `openai/gpt-4o`) |
| `FAST_MODEL` | Fast model override (default: `google/gemini-2.5-flash-lite`) |

---

## Phase 1 — Paper Assets

### Telegram Alerts
| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your chat or channel ID |

### Market Data
| Variable | Description |
|---|---|
| `POLYGON_API_KEY` | Polygon.io API key — primary price source for equity + forex |
| `ALPHA_VANTAGE_API_KEY` | Alpha Vantage key — equity fallback |

### Brokers
| Variable | Description |
|---|---|
| `OANDA_API_KEY` | OANDA REST API key |
| `OANDA_ACCOUNT_ID` | OANDA account ID |
| `OANDA_ENV` | `practice` or `live` |
| `ALPACA_API_KEY` | Alpaca API key |
| `ALPACA_SECRET_KEY` | Alpaca secret key |
| `ALPACA_BASE_URL` | `https://paper-api.alpaca.markets` (paper) or `https://api.alpaca.markets` (live) |
| `IBKR_BASE_URL` | IBKR Client Portal Gateway base URL (e.g., `https://localhost:5000`) |
| `IBKR_ACCOUNT_ID` | IBKR account ID |

---

## Phase 2 — Business Vertical

| Variable | Description |
|---|---|
| `GMAIL_CLIENT_ID` | Google OAuth client ID (for `atlas_send_outreach` Gmail integration) |
| `GMAIL_CLIENT_SECRET` | Google OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | Gmail OAuth refresh token (offline access) |

---

## Phase 3 — Real Estate Vertical

| Variable | Description |
|---|---|
| `RENTCAST_API_KEY` | Rentcast API key — rental comps and AVM estimates for deal scanning |

---

## Phase 4 — Unified Balance Sheet

No additional secrets required beyond Core + vertical keys above.

---

## Supabase App Settings (pg_cron)

Set these in the Supabase SQL editor so cron jobs can call edge functions:

```sql
ALTER DATABASE postgres SET app.supabase_url = 'https://YOUR_PROJECT.supabase.co';
ALTER DATABASE postgres SET app.service_role_key = 'YOUR_SERVICE_ROLE_KEY';
```

---

## Cron Schedule Reference

| Job | Schedule | Function |
|---|---|---|
| `atlas-morning-brief` | `0 10 * * 1-5` | atlas_market_brief |
| `atlas-eod-summary` | `0 21 * * 1-5` | atlas_eod_summary |
| `atlas-watchlist-patrol` | `*/30 13-21 * * 1-5` | atlas_watchlist_patrol |
| `atlas-regime-detector` | `0 12 * * 1-5` | atlas_regime_detector |
| `atlas-forex-scan` | `0 13 * * 1-5` | atlas_forex_scan |
| `atlas-options-scan` | `0 14 * * 1,3` | atlas_options_scan |
| `atlas-business-brief` | `0 9 * * 1` | atlas_business_brief |
| `atlas-pipeline-scout-weekday` | `0 8 * * 1-5` | atlas_pipeline_scout |
| `atlas-pipeline-scout-weekend` | `0 10 * * 6,0` | atlas_pipeline_scout |
| `atlas-expense-audit` | `0 6 1 * *` | atlas_expense_audit |
| `atlas-deal-scan` | `0 7 * * *` | atlas_deal_scan |
| `atlas-lease-monitor` | `30 8 * * *` | atlas_lease_monitor |
| `atlas-re-brief` | `0 7 1 * *` | atlas_re_brief |
| `atlas-balance-sheet` | `0 20 * * 0` | atlas_balance_sheet |

---

## MCP Configuration (Claude Desktop)

See `mcp-config.json`. Google OAuth tokens are obtained via the Google OAuth 2.0 Playground:
1. Enable Gmail API, Calendar API, Drive API in Google Cloud Console
2. Create OAuth 2.0 credentials (Desktop app)
3. Use the Playground to generate refresh tokens with offline access scopes

Required scopes:
- Gmail: `https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly`
- Calendar: `https://www.googleapis.com/auth/calendar`
- Drive: `https://www.googleapis.com/auth/drive`
