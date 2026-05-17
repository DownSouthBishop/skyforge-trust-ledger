# Atlas System Changelog

## [Atlas 1.0.0] — 2026-05-17

### Summary
Complete transformation of Skyforge Trust Ledger into Atlas — a non-human principal autonomous intelligence system.

### PHASE 1: CONSOLIDATION
**Added**
- `supabase/functions/atlas-core/` — Main inference and routing (consolidates 10 functions)
- `supabase/functions/atlas-trade/` — All trading operations (consolidates 14 functions)  
- `supabase/functions/atlas-re/` — Real estate operations (consolidates 5 functions)
- `supabase/functions/atlas-portfolio/` — Portfolio tracking (consolidates 5 functions)
- `supabase/functions/atlas-signal/` — Intelligence aggregation (consolidates 3 functions)
- `supabase/functions/atlas-report/` — Report generation (new)
- `supabase/functions/atlas-business/` — Business pipeline (consolidates 4 functions)
- `src/modules/felix-optional/` — $FELIX DeFi monitoring isolated module (disabled by default)

**Deprecated** (logic absorbed, files retained for reference)
- forge_chat, forge_execute, forge_compress, forge_learn, forge_suggest → atlas-core
- atlas_execute_trade, atlas_forex_scan, atlas_risk_check, atlas_market_brief, atlas_trade_thesis, atlas_watchlist_patrol, atlas_options_scan, atlas_play_ranker, atlas_play_tracker, atlas_regime_detector, atlas_opportunity_scan, atlas_counterfactual, atlas_news_scan, get_live_prices → atlas-trade
- atlas_re_brief, atlas_deal_scan, atlas_deal_underwrite, atlas_lease_monitor, atlas_re_risk_check → atlas-re
- atlas_portfolio_sync, atlas_allocate_capital, atlas_balance_sheet, atlas_expense_audit, atlas_income_velocity, calculate_operator_trajectory → atlas-portfolio
- forge_morning_engine, forge_weekly_review, forge_alerts → atlas-signal
- atlas_business_brief, atlas_business_risk_check, atlas_pipeline_scout, atlas_send_outreach → atlas-business
- atlas_obsidian_sync, atlas_reengagement, atlas_noon_check, atlas_self_eval → deprecated (absorbed)

### PHASE 2: DATABASE FOUNDATION
**Migrations Added**
- `20260517100001_atlas_deprecation_log.sql` — Deprecation audit trail
- `20260517100002_atlas_core_tables.sql` — 9 new Atlas core tables
- `20260517100003_atlas_cron_jobs.sql` — pg_cron autonomous scheduling

**New Tables**
- `atlas_memory` — Semantic memory with pgvector 1536-dim embeddings
- `atlas_dossier_full` — Comprehensive behavioral/financial dossier
- `atlas_decision_queue` — GREEN/YELLOW/ORANGE/RED decision system
- `atlas_portfolio_state` — Unified portfolio state snapshots
- `atlas_business_pipeline` — Autonomous business pipeline (new schema)
- `atlas_report_archive` — Daily report storage with tier gating
- `atlas_subscribers` — Subscriber management
- `atlas_trade_audit` — Immutable trade audit log with signed hash
- `atlas_alerts` — System alerts for RED decisions

**New Database Functions**
- `generate_trade_hash()` — pgcrypto HMAC-SHA256 for trade audit integrity
- `check_portfolio_rebalancing()` — Trigger for 15% deviation detection
- `handle_decision_insert()` — AUTO_EXECUTE GREEN, alert on RED
- `check_regulatory_boundary()` — Compliance circuit breaker

**New Triggers**
- `atlas_trade_audit_hash` — Auto-generates signed_hash on insert
- `decision_queue_handler` — GREEN auto-execute, RED alert
- `portfolio_rebalancing_check` — Rebalancing YELLOW decision on deviation

**Extensions Added**
- `pg_audit` — Immutable audit trail
- `pgcrypto` — Trade hash signing

### PHASE 3: ATLAS MEMORY AND PERSONALITY
**Added**
- `src/lib/atlas-memory.ts` — Full memory operations: embed, store, recall, context window
- `src/lib/atlas-personality.ts` — Master system prompt factory with context injection

### PHASE 4: ATLAS CONVERSATION INTERFACE
**Added**
- `src/pages/AtlasChat.tsx` — Primary chat interface (full-screen, no sidebar clutter)
  - Streaming Anthropic API responses
  - Domain and emotional valence detection
  - Inline ORANGE/RED decision cards
  - Inline portfolio snapshot panel
  - Memory indicator with expand
  - File attachment support (PDF, images)
  - Keyboard shortcuts: ⌘K (commands), ⌘D (decisions), ⌘P (portfolio)
  - Cross-session memory persistence

**Modified**
- `src/App.tsx` — Added /atlas route (AtlasChat, full-screen) and /command route (AtlasDashboard)

### PHASE 5-9: ENGINE LIBRARIES
**Added**
- `src/lib/atlas-business-engine.ts` — Business pipeline client wrapper
- `src/lib/atlas-portfolio-engine.ts` — Portfolio treasury engine client wrapper
- `src/lib/atlas-re-engine.ts` — Real estate autonomous loop client wrapper
- `src/lib/atlas-report-engine.ts` — Daily report pipeline client wrapper
- `src/lib/atlas-stripe.ts` — Subscriber revenue layer client wrapper

### PHASE 10: UNIFIED COMMAND DASHBOARD
**Added**
- `src/pages/AtlasDashboard.tsx` — Weekly command dashboard
  - Decision Queue (RED pulse, ORANGE count, YELLOW collapsed, GREEN log)
  - Portfolio Snapshot with allocation bars
  - Business Pipeline cards
  - Trading Performance summary
  - Report Performance metrics
  - Atlas Memory Insights (collapsible)

### PHASE 11: LEGAL DOCUMENT GENERATION
**Added**
- `src/lib/atlas-legal-docs.ts` — Wyoming LLC Operating Agreement + IPS generators

### PHASE 12: ENVIRONMENT AND DEPLOYMENT
**Added**
- `.env.example` — Complete environment variable documentation
- `CHANGELOG.md` — This file

---

## [Pre-Atlas] — Prior Phases

### Phase A — Hardening (2026-05-16) ✅
- Circuit breaker trigger on trade_ledger
- Public ledger view
- Shared prompt extraction
- Direct Anthropic API migration for key functions
- RL feedback loop: play_ranker → preferences → opportunity_scan

### Phase 0-5 — Foundation (2026-05-15) ✅
See ATLAS_BUILD_STATUS.md for complete prior phase documentation.
