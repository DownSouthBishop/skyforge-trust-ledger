# Felix Optional Module

The Felix module provides DeFi monitoring capabilities for the Atlas system. It is **disabled by default** and will not load, execute, or make any network calls unless explicitly enabled.

## Status: Disabled by default

This module is isolated from the core Atlas architecture. It will not activate unless the `ENABLE_FELIX` environment variable is set to `true`.

## Enabling the module

Set the following environment variable before starting the edge function or runtime:

```
ENABLE_FELIX=true
```

In Supabase, add this to your edge function secrets via the dashboard or CLI:

```bash
supabase secrets set ENABLE_FELIX=true
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ENABLE_FELIX` | Yes (to enable) | `false` | Master switch. Must be exactly `true` to activate the module. |
| `FELIX_COINGECKO_ID` | No | `felix-token` | CoinGecko token ID for live $FELIX price data. Update once $FELIX is listed. |
| `FELIX_CONTRACT` | No | `` (empty) | On-chain contract address for $FELIX token. |
| `FELIX_CHAIN` | No | `ethereum` | Chain where $FELIX is deployed (e.g. `ethereum`, `base`, `solana`). |

## What this module contains

### API integrations

- **CoinGecko** (`https://api.coingecko.com/api/v3`) — $FELIX token price, market cap, 24h volume, and price change data.
- **DeFiLlama** (`https://api.llama.fi`) — DeFi pool yield scanning across all major protocols. Filters for APY > 8%, TVL > $10M, and audited protocols only.

### Actions

- **FELIX_STATUS** — Fetches current $FELIX price and market metrics. Triggered by messages mentioning "felix" or "$felix".
- **YIELD_SCAN** — Scans DeFiLlama for top risk-adjusted yield opportunities. Triggered by messages mentioning yield, APY, farming, staking, or DeFi protocols. Persists results to `research_notes` in Supabase.

### Evaluators

- **PROTOCOL_HEALTH** — Passive evaluator that flags conversations mentioning DeFi protocols, TVL changes, hacks, or exploits. Phase 5 will wire this to DeFiLlama alerts and Rekt.news RSS.

## Usage in code

```typescript
import { isFelixEnabled, getFelixModule } from "./src/modules/felix-optional/index.ts";

if (isFelixEnabled()) {
  const felixPlugin = getFelixModule();
  // register felixPlugin with your ElizaOS agent runtime
}
```

The `getFelixModule()` function returns `null` when disabled, so it is safe to call without checking `isFelixEnabled()` first as long as you guard the return value.

## Why it is disabled by default

The Felix module makes outbound API calls to CoinGecko and DeFiLlama on every relevant message. Enabling it unconditionally would:

1. Add latency to all conversations mentioning financial terms.
2. Hit CoinGecko rate limits in environments where $FELIX is not yet listed.
3. Introduce DeFi-specific context into workflows where it is not relevant.

The module is designed to be opt-in so that the core Atlas system remains lean and focused on its primary verticals (trading, real estate, business, portfolio).
