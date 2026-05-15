// Atlas ElizaOS Plugin — Market Intelligence
// Actions: MARKET_BRIEF, TRADE_THESIS, FOREX_SCAN
// Evaluators: PRICE_ALERT, NEWS_SCANNER

import type { Plugin, IAgentRuntime, Memory, State } from "@elizaos/core";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const fnHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function callEdgeFunction(name: string, body: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: fnHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${name} failed: ${res.status}`);
  return res.json();
}

// ─── Actions ──────────────────────────────────────────────────────────────────

const marketBriefAction = {
  name: "MARKET_BRIEF",
  description: "Generate a market brief covering positions, watchlist, and key setups. Saves to Vault.",
  similes: ["RUN_BRIEF", "MORNING_BRIEF", "MARKET_UPDATE", "BRIEF_ME", "WHAT_IS_THE_MARKET_DOING"],
  examples: [
    [{ user: "user", content: { text: "Run my market brief" } }],
    [{ user: "user", content: { text: "What's the market doing?" } }],
  ],
  validate: async () => true,
  handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options: unknown, callback: Function) => {
    const userId = (state as any).userId ?? runtime.agentId;
    callback({ text: "Generating market brief…" });
    try {
      const result = await callEdgeFunction("atlas_market_brief", { user_id: userId });
      callback({ text: result.summary ?? "Market brief generated and saved to your Vault." });
    } catch (err) {
      callback({ text: `Brief failed: ${(err as Error).message}` });
    }
    return true;
  },
};

const tradeThesisAction = {
  name: "TRADE_THESIS",
  description: "Research a symbol and generate a structured trade thesis. Saves to Vault.",
  similes: ["RESEARCH", "ANALYZE", "THESIS", "DEEP_DIVE", "RESEARCH_SYMBOL"],
  examples: [
    [{ user: "user", content: { text: "Research NVDA for me" } }],
    [{ user: "user", content: { text: "Build a thesis on EUR/USD" } }],
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    return /\b([A-Z]{1,6}\/[A-Z]{1,6}|[A-Z]{2,5})\b/.test(message.content?.text ?? "");
  },
  handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options: unknown, callback: Function) => {
    const userId = (state as any).userId ?? runtime.agentId;
    const text   = message.content?.text ?? "";
    const symMatch = text.match(/\b([A-Z]{1,6}\/[A-Z]{1,6}|[A-Z]{2,5})\b/);
    if (!symMatch) {
      callback({ text: "Which symbol should I research?" });
      return false;
    }
    const symbol     = symMatch[1];
    const assetClass = symbol.includes("/") ? "forex" : "equity";
    callback({ text: `Researching ${symbol}…` });
    try {
      const result = await callEdgeFunction("atlas_trade_thesis", {
        user_id: userId, symbol, asset_class: assetClass, context: text,
      });
      callback({ text: result.summary ?? `Thesis for ${symbol} saved to your Vault.` });
    } catch (err) {
      callback({ text: `Research failed: ${(err as Error).message}` });
    }
    return true;
  },
};

const forexScanAction = {
  name: "FOREX_SCAN",
  description: "Scan all approved forex pairs for setups. Saves findings to Vault.",
  similes: ["SCAN_FOREX", "FOREX_SCAN", "SCAN_PAIRS", "WHAT_PAIRS_LOOK_GOOD"],
  examples: [
    [{ user: "user", content: { text: "Scan forex for setups" } }],
    [{ user: "user", content: { text: "Any forex opportunities right now?" } }],
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    return /\b(forex|pairs?|scan|eur|gbp|usd|jpy|aud|cad|nzd|chf)\b/i.test(message.content?.text ?? "");
  },
  handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options: unknown, callback: Function) => {
    const userId = (state as any).userId ?? runtime.agentId;
    callback({ text: "Scanning forex pairs…" });
    try {
      const result = await callEdgeFunction("atlas_forex_scan", { user_id: userId });
      const count  = result.pairs_scanned ?? "all";
      callback({ text: `Forex scan complete — ${count} pairs analyzed. Check your Vault for the setups.` });
    } catch (err) {
      callback({ text: `Forex scan failed: ${(err as Error).message}` });
    }
    return true;
  },
};

// ─── Evaluators ───────────────────────────────────────────────────────────────

const priceAlertEvaluator = {
  name: "PRICE_ALERT",
  description: "Monitors if a user mentions specific price levels that should trigger watchlist alerts.",
  similes: ["ALERT_ME", "NOTIFY_ME", "WATCH_PRICE"],
  alwaysRun: false,
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    return /\b(alert|notify|watch|when.*hits?|if.*reaches?)\b/i.test(message.content?.text ?? "");
  },
  handler: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Price alert extraction is handled by forge_chat's context extraction
    // This evaluator signals the runtime to forward to atlas_watchlist_patrol
    return { didAlert: false };
  },
};

const newsScannerEvaluator = {
  name: "NEWS_SCANNER",
  description: "Detects when the conversation would benefit from current market news or macro data.",
  similes: ["CURRENT_NEWS", "LATEST_NEWS", "MACRO_DATA"],
  alwaysRun: false,
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    return /\b(news|earnings?|fed|fomc|cpi|nfp|macro|data|report|announcement)\b/i.test(message.content?.text ?? "");
  },
  handler: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Phase 3: wire to web search MCP + FRED API
    return { shouldSearch: true };
  },
};

// ─── Plugin export ────────────────────────────────────────────────────────────

const atlasMarketData: Plugin = {
  name: "atlas-market-data",
  description: "Atlas market intelligence — briefs, trade theses, and forex scanning.",
  actions: [marketBriefAction, tradeThesisAction, forexScanAction],
  providers: [],
  evaluators: [priceAlertEvaluator, newsScannerEvaluator],
};

export default atlasMarketData;
