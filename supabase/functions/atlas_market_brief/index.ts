// Atlas Market Brief — morning + EOD briefings
// Generates structured market context + position summary, saves to research_notes
// Phase 2: wire OANDA/Alpha Vantage/FRED for live data

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv } from "../_shared/gateway.ts";

const FAST_MODEL = () => modelEnv("FAST_MODEL", "google/gemini-2.5-flash");

const ATLAS_RISK_RULES = {
  max_risk_per_trade_pct: 0.02,
  max_positions_open: 10,
  forex_max_leverage: 10,
  forex_pairs_approved: ["EUR/USD","GBP/USD","USD/JPY","AUD/USD","USD/CAD","NZD/USD","USD/CHF","EUR/GBP"],
  auto_execute_max_usd: 500,
  daily_loss_limit_pct: 0.05,
  weekly_loss_limit_pct: 0.10,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("LOVABLE_API_KEY");

    const { user_id, brief_type = "morning" } = await req.json();
    if (!user_id) return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });

    // Pull operator data
    const [acctRes, tradesRes, watchRes, notesRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/trading_accounts?user_id=eq.${user_id}&is_active=eq.true&select=broker,account_type,balance_usd,buying_power_usd`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      }),
      fetch(`${SUPABASE_URL}/rest/v1/trade_ledger?user_id=eq.${user_id}&status=eq.open&select=symbol,asset_class,direction,entry_price,quantity,broker,pnl_usd,thesis,opened_at`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      }),
      fetch(`${SUPABASE_URL}/rest/v1/market_watchlist?user_id=eq.${user_id}&is_active=eq.true&select=symbol,asset_class,notes&limit=20`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      }),
      fetch(`${SUPABASE_URL}/rest/v1/research_notes?user_id=eq.${user_id}&order=created_at.desc&limit=3&select=title,note_type,created_at`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      }),
    ]);

    const accounts = acctRes.ok ? await acctRes.json() : [];
    const openTrades = tradesRes.ok ? await tradesRes.json() : [];
    const watchlist = watchRes.ok ? await watchRes.json() : [];
    const recentNotes = notesRes.ok ? await notesRes.json() : [];

    const totalCapital = accounts.reduce((s: number, a: any) => s + Number(a.balance_usd ?? 0), 0);
    const openPnl = openTrades.reduce((s: number, t: any) => s + Number(t.pnl_usd ?? 0), 0);
    const today = new Date().toISOString().split("T")[0];

    // TODO Phase 2: inject live market data here
    // const marketData = await fetchMarketData(watchlist.map(w => w.symbol));
    // const macroData = await fetchFREDData(["DFF", "CPIAUCSL", "GDP"]);

    const prompt = `You are Atlas — autonomous financial intelligence.

Generate a ${brief_type === "morning" ? "morning market brief" : "end-of-day summary"} for this operator. Today: ${today}.

OPERATOR CAPITAL:
${accounts.length > 0 ? accounts.map((a: any) => `- ${a.broker.toUpperCase()} (${a.account_type}): $${Number(a.balance_usd ?? 0).toLocaleString()}`).join("\n") : "No accounts connected yet."}
Total capital: $${totalCapital.toLocaleString()}

OPEN POSITIONS (${openTrades.length}):
${openTrades.length > 0 ? openTrades.map((t: any) => `- ${t.symbol} ${t.direction.toUpperCase()} | entry: ${t.entry_price} | qty: ${t.quantity} | broker: ${t.broker}${t.pnl_usd != null ? ` | P&L: ${t.pnl_usd >= 0 ? "+" : ""}$${t.pnl_usd}` : ""}`).join("\n") : "No open positions."}
Open P&L: ${openPnl >= 0 ? "+" : ""}$${openPnl.toFixed(2)}

WATCHLIST (${watchlist.length} symbols):
${watchlist.slice(0, 10).map((w: any) => `- ${w.symbol} [${w.asset_class}]${w.notes ? `: ${w.notes}` : ""}`).join("\n") || "Empty"}

RISK PARAMETERS:
- Daily loss limit: ${ATLAS_RISK_RULES.daily_loss_limit_pct * 100}% of capital
- Max risk per trade: ${ATLAS_RISK_RULES.max_risk_per_trade_pct * 100}%
- Max open positions: ${ATLAS_RISK_RULES.max_positions_open}

RECENT RESEARCH:
${recentNotes.map((n: any) => `- ${n.title} (${n.note_type})`).join("\n") || "None"}

NOTE: Live market prices will be injected in Phase 2. For now, generate a framework brief based on the operator's current positioning and risk state. Flag what you'd monitor given their watchlist. Be direct. No filler.

Output a structured markdown brief. Include: 1) Position status, 2) Key things to watch today, 3) Any risk flags, 4) One priority action. Under 300 words.`;

    const aiResp = await callGatewayWithRetry(
      { model: FAST_MODEL(), messages: [{ role: "user", content: prompt }], max_tokens: 600 },
      API_KEY,
    );

    const content = aiResp.choices?.[0]?.message?.content ?? "Brief generation failed.";
    const title = brief_type === "morning"
      ? `Morning Brief — ${today}`
      : `EOD Summary — ${today}`;

    // Save to research_notes
    await fetch(`${SUPABASE_URL}/rest/v1/research_notes`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        user_id,
        title,
        content,
        note_type: "morning_brief",
        synced_to_obsidian: false,
      }),
    });

    return new Response(JSON.stringify({ brief: content, title }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});
