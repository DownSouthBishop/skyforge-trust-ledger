// Atlas ElizaOS Plugin — $FELIX DeFi Monitoring
// Actions: FELIX_STATUS, YIELD_SCAN
// Evaluators: PROTOCOL_HEALTH

import type { Plugin, IAgentRuntime, Memory, State } from "@elizaos/core";

const DEFI_LLAMA_BASE  = "https://api.llama.fi";
const COINGECKO_BASE   = "https://api.coingecko.com/api/v3";

// $FELIX token — update with actual contract address once live
const FELIX_CONTRACT  = process.env.FELIX_CONTRACT  ?? "";
const FELIX_CHAIN     = process.env.FELIX_CHAIN     ?? "ethereum";
const FELIX_COINGECKO = process.env.FELIX_COINGECKO_ID ?? "felix-token";

async function cgGet(path: string) {
  const res = await fetch(`${COINGECKO_BASE}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  return res.json();
}

async function llamaGet(path: string) {
  const res = await fetch(`${DEFI_LLAMA_BASE}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`DeFiLlama ${res.status}`);
  return res.json();
}

// ─── Actions ──────────────────────────────────────────────────────────────────

const felixStatusAction = {
  name: "FELIX_STATUS",
  description: "Get current $FELIX token price, market cap, 24h volume, and protocol metrics.",
  similes: ["FELIX_PRICE", "HOW_IS_FELIX", "CHECK_FELIX", "FELIX_STATUS"],
  examples: [
    [{ user: "user", content: { text: "How is $FELIX doing?" } }],
    [{ user: "user", content: { text: "Check the FELIX price" } }],
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    return /\b(felix|\$felix)\b/i.test(message.content?.text ?? "");
  },
  handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options: unknown, callback: Function) => {
    try {
      if (!FELIX_COINGECKO || FELIX_COINGECKO === "felix-token") {
        callback({
          text: "$FELIX monitoring active. Set FELIX_COINGECKO_ID env var with the CoinGecko token ID once $FELIX is listed to enable live pricing.",
        });
        return true;
      }
      const data = await cgGet(`/coins/${FELIX_COINGECKO}?localization=false&tickers=false&community_data=false&developer_data=false`);
      const price     = data.market_data?.current_price?.usd;
      const mcap      = data.market_data?.market_cap?.usd;
      const vol       = data.market_data?.total_volume?.usd;
      const change24h = data.market_data?.price_change_percentage_24h;
      const status = [
        `$FELIX: $${price?.toFixed(6) ?? "—"}`,
        `24h: ${change24h != null ? (change24h >= 0 ? "+" : "") + change24h.toFixed(2) + "%" : "—"}`,
        `Market cap: $${mcap ? (mcap / 1e6).toFixed(2) + "M" : "—"}`,
        `Volume 24h: $${vol ? (vol / 1e6).toFixed(2) + "M" : "—"}`,
      ].join(" | ");
      callback({ text: status });
    } catch (err) {
      callback({ text: `FELIX status error: ${(err as Error).message}` });
    }
    return true;
  },
};

const yieldScanAction = {
  name: "YIELD_SCAN",
  description: "Scan DeFi protocols for current yield opportunities via DeFiLlama.",
  similes: ["FIND_YIELD", "YIELD_OPPORTUNITIES", "BEST_APY", "DeFi_YIELD", "FARM_SCAN"],
  examples: [
    [{ user: "user", content: { text: "Find the best yield right now" } }],
    [{ user: "user", content: { text: "Scan for APY opportunities" } }],
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    return /\b(yield|apy|apr|farm|stake|liquidity|defi|protocol)\b/i.test(message.content?.text ?? "");
  },
  handler: async (runtime: IAgentRuntime, _message: Memory, _state: State, _options: unknown, callback: Function) => {
    callback({ text: "Scanning DeFi yields…" });
    try {
      const data  = await llamaGet("/pools");
      const pools = Array.isArray(data?.data) ? data.data : [];

      // Filter: APY > 8, TVL > $10M, audits array not empty
      const eligible = pools.filter((p: any) =>
        Number(p.apy ?? 0) > 8 &&
        Number(p.tvlUsd ?? 0) > 10_000_000 &&
        Array.isArray(p.audits) && p.audits.length > 0,
      );

      if (eligible.length === 0) {
        callback({ text: "No qualifying yield opportunities (APY>8%, TVL>$10M, audited). Markets may be quiet." });
        return true;
      }

      // Compute risk-adjusted score = apy / vol_factor
      const scored = eligible.map((p: any) => {
        const ilPenalty  = p.ilRisk === "no" ? 1 : 2;
        const volFactor  = Number(p.volumeUsd7d ?? 0) > 0 ? Math.max(ilPenalty, 1) : 3;
        const riskAdj    = Number(p.apy) / volFactor;
        return { ...p, riskAdj };
      });

      const top5 = scored
        .sort((a: any, b: any) => b.riskAdj - a.riskAdj)
        .slice(0, 5);

      const lines = top5.map((p: any) =>
        `${p.project} ${p.symbol ?? ""} [${p.chain}]: APY ${Number(p.apy).toFixed(1)}% | TVL $${(Number(p.tvlUsd) / 1e6).toFixed(1)}M | Risk-Adj ${p.riskAdj.toFixed(2)}`,
      );

      const resultText = `Top DeFi yields (risk-adjusted, audited, APY>8%):\n${lines.join("\n")}`;
      callback({ text: resultText });

      // Persist to research_notes if Supabase is configured
      const supabaseUrl = runtime.getSetting("SUPABASE_URL");
      const serviceKey  = runtime.getSetting("SUPABASE_SERVICE_ROLE_KEY");
      const userId      = runtime.getSetting("ATLAS_USER_ID");
      if (supabaseUrl && serviceKey && userId) {
        const today = new Date().toISOString().split("T")[0];
        fetch(`${supabaseUrl}/rest/v1/research_notes`, {
          method: "POST",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            user_id: userId,
            symbol: "DEFI_YIELD",
            title: `DeFi Yield Scan — ${today}`,
            content: resultText,
            note_type: "research",
            synced_to_obsidian: false,
          }),
        }).catch((e: Error) => console.error("Failed to save yield scan:", e.message));
      }
    } catch (err) {
      callback({ text: `Yield scan failed: ${(err as Error).message}` });
    }
    return true;
  },
};

// ─── Evaluators ───────────────────────────────────────────────────────────────

const protocolHealthEvaluator = {
  name: "PROTOCOL_HEALTH",
  description: "Checks if mentioned DeFi protocols have notable TVL changes or security alerts.",
  alwaysRun: false,
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    return /\b(protocol|tvl|hack|exploit|rug|defi|yield|farm)\b/i.test(message.content?.text ?? "");
  },
  handler: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Phase 5: wire to DeFiLlama alerts + Rekt.news RSS
    // For now, returns a passive flag so the conversation can proceed
    return { checked: true, alerts: [] };
  },
};

// ─── Plugin export ────────────────────────────────────────────────────────────

const atlasFelix: Plugin = {
  name: "atlas-felix",
  description: "Atlas DeFi monitoring — $FELIX tracking, yield scanning, and protocol health.",
  actions: [felixStatusAction, yieldScanAction],
  providers: [],
  evaluators: [protocolHealthEvaluator],
};

export default atlasFelix;
