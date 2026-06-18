// Atlas Market Brief — morning + EOD briefings
// Generates structured market context + position summary, saves to research_notes

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

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

async function fetchFREDSeries(seriesId: string, apiKey: string): Promise<number | null> {
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&sort_order=desc&limit=1&file_type=json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const val = data?.observations?.[0]?.value;
    if (!val || val === ".") return null;
    return parseFloat(val);
  } catch {
    return null;
  }
}

async function fetchAlphaVantageMovers(apiKey: string): Promise<{ gainers: string; losers: string } | null> {
  try {
    const res = await fetch(`https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=${apiKey}`);
    if (!res.ok) return null;
    const data = await res.json();
    const gainers = (data.top_gainers ?? []).slice(0, 3)
      .map((g: any) => `${g.ticker} +${g.change_percentage}`).join(", ");
    const losers = (data.top_losers ?? []).slice(0, 3)
      .map((l: any) => `${l.ticker} ${l.change_percentage}`).join(", ");
    return { gainers: gainers || "None", losers: losers || "None" };
  } catch {
    return null;
  }
}

async function fetchOANDAPrices(oandaKey: string, accountId: string): Promise<Record<string, number | null>> {
  const instruments = "EUR_USD,GBP_USD,USD_JPY";
  const tryBase = async (base: string): Promise<Record<string, number | null> | null> => {
    try {
      const res = await fetch(
        `${base}/v3/accounts/${accountId}/pricing/current?instruments=${instruments}`,
        { headers: { Authorization: `Bearer ${oandaKey}` } },
      );
      if (!res.ok) return null;
      const data = await res.json();
      const result: Record<string, number | null> = {};
      for (const price of (data.prices ?? [])) {
        const ask = parseFloat(price.asks?.[0]?.price ?? "0");
        const bid = parseFloat(price.bids?.[0]?.price ?? "0");
        result[price.instrument] = ask && bid ? (ask + bid) / 2 : null;
      }
      return result;
    } catch {
      return null;
    }
  };
  return (
    (await tryBase("https://api-fxtrade.oanda.com")) ??
    (await tryBase("https://api-fxpractice.oanda.com")) ??
    {}
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = (Deno.env.get("GOOGLE_AI_KEY") ?? "");

    const FRED_KEY   = Deno.env.get("FRED_API_KEY");
    const ALPHA_KEY  = Deno.env.get("ALPHA_VANTAGE_KEY");
    const OANDA_KEY  = Deno.env.get("OANDA_API_KEY");
    const OANDA_ACCT = Deno.env.get("OANDA_ACCOUNT_ID");

    if (!FRED_KEY)   console.warn("FRED_API_KEY not set — macro data unavailable");
    if (!ALPHA_KEY)  console.warn("ALPHA_VANTAGE_KEY not set — movers unavailable");
    if (!OANDA_KEY)  console.warn("OANDA_API_KEY not set — forex prices unavailable");

    const { user_id, brief_type = "morning" } = await req.json();
    if (!user_id) return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });

    const [acctRes, tradesRes, watchRes, notesRes, macroData, movers, forexPrices] = await Promise.all([
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
      FRED_KEY
        ? Promise.all([
            fetchFREDSeries("FEDFUNDS", FRED_KEY),
            fetchFREDSeries("CPIAUCSL", FRED_KEY),
            fetchFREDSeries("DGS10", FRED_KEY),
            fetchFREDSeries("DTWEXBGS", FRED_KEY),
          ]).then(([fedfunds, cpi, dgs10, dxy]) => ({ fedfunds, cpi, dgs10, dxy }))
        : Promise.resolve(null),
      ALPHA_KEY ? fetchAlphaVantageMovers(ALPHA_KEY) : Promise.resolve(null),
      OANDA_KEY && OANDA_ACCT
        ? fetchOANDAPrices(OANDA_KEY, OANDA_ACCT)
        : Promise.resolve({} as Record<string, number | null>),
    ]);

    const accounts    = acctRes.ok   ? await acctRes.json()   : [];
    const openTrades  = tradesRes.ok ? await tradesRes.json()  : [];
    const watchlist   = watchRes.ok  ? await watchRes.json()   : [];
    const recentNotes = notesRes.ok  ? await notesRes.json()   : [];

    const totalCapital = accounts.reduce((s: number, a: any) => s + Number(a.balance_usd ?? 0), 0);
    const openPnl      = openTrades.reduce((s: number, t: any) => s + Number(t.pnl_usd ?? 0), 0);
    const today = new Date().toISOString().split("T")[0];

    const macroSection = macroData
      ? `MACRO DATA (FRED):
- Fed Funds Rate: ${macroData.fedfunds != null ? macroData.fedfunds + "%" : "N/A"}
- CPI (latest): ${macroData.cpi != null ? macroData.cpi : "N/A"}
- 10Y Treasury Yield: ${macroData.dgs10 != null ? macroData.dgs10 + "%" : "N/A"}
- USD Broad Index (DTWEXBGS): ${macroData.dxy != null ? macroData.dxy : "N/A"}`
      : "MACRO DATA: FRED API key not configured.";

    const moversSection = movers
      ? `MARKET MOVERS (Alpha Vantage):
- Top Gainers: ${movers.gainers}
- Top Losers: ${movers.losers}`
      : "MARKET MOVERS: Alpha Vantage API key not configured.";

    const forexSection = Object.keys(forexPrices).length > 0
      ? `LIVE FOREX MID PRICES (OANDA):
${Object.entries(forexPrices).map(([k, v]) => `- ${k}: ${v != null ? v.toFixed(5) : "N/A"}`).join("\n")}`
      : "LIVE FOREX PRICES: OANDA not configured.";

    const prompt = `You are Atlas — autonomous financial intelligence.

Generate a ${brief_type === "morning" ? "morning market brief" : "end-of-day summary"} for this operator. Today: ${today}.

${macroSection}

${moversSection}

${forexSection}

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

Generate a structured markdown brief. Include: 1) Macro context from the data above, 2) Position status and open P&L, 3) Key things to watch today, 4) Any risk flags, 5) One priority action. Under 350 words. Be direct. No filler.`;

    const aiRespRaw = await callGatewayWithRetry(
      { model: FAST_MODEL(), messages: [{ role: "user", content: prompt }], max_tokens: 700 },
      API_KEY,
    );
    const aiResp = await aiRespRaw.json();
    const content = aiResp.choices?.[0]?.message?.content ?? "Brief generation failed.";
    const title = brief_type === "morning"
      ? `Morning Brief — ${today}`
      : `EOD Summary — ${today}`;

    await fetch(`${SUPABASE_URL}/rest/v1/research_notes`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ user_id, title, content, note_type: "morning_brief", synced_to_obsidian: false }),
    });

    await sendTelegramAlert(`*${title}*\n${content.slice(0, 500)}${content.length > 500 ? "…" : ""}`);

    return new Response(JSON.stringify({ brief: content, title, macro: macroData, forex: forexPrices }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});
