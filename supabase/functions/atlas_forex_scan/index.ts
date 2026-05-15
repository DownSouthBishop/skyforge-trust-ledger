// Atlas Forex Scan — hourly scan of approved pairs for setups
// Phase 2: wire OANDA streaming prices + technical indicators
// Runs on cron: every hour during market hours

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv } from "../_shared/gateway.ts";

const FAST_MODEL = () => modelEnv("FAST_MODEL", "google/gemini-2.5-flash");

const APPROVED_PAIRS = ["EUR/USD","GBP/USD","USD/JPY","AUD/USD","USD/CAD","NZD/USD","USD/CHF","EUR/GBP"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("LOVABLE_API_KEY");

    const { user_id } = await req.json();
    if (!user_id) return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });

    // Pull user's watchlist forex pairs
    const watchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/market_watchlist?user_id=eq.${user_id}&asset_class=eq.forex&is_active=eq.true&select=symbol,notes`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    const watchlist = watchRes.ok ? await watchRes.json() : [];
    const watchedPairs = watchlist.map((w: any) => w.symbol);

    // Combine approved + watchlisted forex pairs (dedup)
    const pairsToScan = [...new Set([...APPROVED_PAIRS, ...watchedPairs])];

    // TODO Phase 2: fetch live OANDA candle data for each pair
    // const OANDA_KEY = parseEnv("OANDA_API_KEY");
    // const priceData = await Promise.all(pairsToScan.map(async (pair) => {
    //   const instrument = pair.replace("/", "_");
    //   const res = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/${instrument}/candles?count=50&granularity=H1`, {
    //     headers: { Authorization: `Bearer ${OANDA_KEY}` },
    //   });
    //   return { pair, candles: await res.json() };
    // }));

    const today = new Date().toISOString().split("T")[0];
    const hour = new Date().getUTCHours();

    const prompt = `You are Atlas — autonomous forex analyst. Scan these pairs for current setups.

Date/Time: ${today} ${hour}:00 UTC
Pairs to scan: ${pairsToScan.join(", ")}

NOTE: Live price data will be injected in Phase 2 via OANDA streaming API.
For now, generate a framework scan based on current macro context and pair characteristics.

For each pair, output a brief setup note (1-2 sentences). Only flag pairs where there's something worth noting — skip pairs with no clear setup. Format:

**[PAIR]**: [setup description] — [bias: Bullish/Bearish/Neutral] [timeframe]

End with: ONE pair that is highest priority right now and why (1 sentence).

Risk rules: max 10:1 leverage, 2% risk per trade, 5% daily loss limit.`;

    const aiResp = await callGatewayWithRetry(
      { model: FAST_MODEL(), messages: [{ role: "user", content: prompt }], max_tokens: 800 },
      API_KEY,
    );

    const scanResult = aiResp.choices?.[0]?.message?.content ?? "Scan failed.";
    const title = `Forex Scan — ${today} ${hour}:00 UTC`;

    // Save scan result
    await fetch(`${SUPABASE_URL}/rest/v1/research_notes`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ user_id, title, content: scanResult, note_type: "research", synced_to_obsidian: false }),
    });

    // Create alert if scan found setups
    await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id,
        signal_type: "forex_scan",
        message: `Forex scan complete — ${pairsToScan.length} pairs reviewed. Check Vault for setups.`,
      }),
    });

    return new Response(JSON.stringify({ scan: scanResult, pairs_scanned: pairsToScan.length, title }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});
