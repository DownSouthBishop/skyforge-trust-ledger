// Atlas Watchlist Patrol — monitors watchlist for price/volume/news triggers
// Phase 2: wire Alpha Vantage + Polygon.io for live quotes

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    const { user_id } = await req.json();
    if (!user_id) return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });

    const watchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/market_watchlist?user_id=eq.${user_id}&is_active=eq.true&select=id,symbol,asset_class,alert_price_high,alert_price_low,notes`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    const watchlist = watchRes.ok ? await watchRes.json() : [];

    if (watchlist.length === 0) {
      return new Response(JSON.stringify({ status: "ok", alerts_fired: 0, message: "Watchlist is empty." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const alertsFired: string[] = [];

    for (const item of watchlist) {
      // TODO Phase 2: fetch live price per symbol
      // let currentPrice: number | null = null;
      // if (item.asset_class === "equity") {
      //   const ALPHA_KEY = parseEnv("ALPHA_VANTAGE_API_KEY");
      //   const res = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${item.symbol}&apikey=${ALPHA_KEY}`);
      //   const data = await res.json();
      //   currentPrice = parseFloat(data["Global Quote"]["05. price"]);
      // } else if (item.asset_class === "forex") {
      //   const OANDA_KEY = parseEnv("OANDA_API_KEY");
      //   const instrument = item.symbol.replace("/","_");
      //   const res = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/${instrument}/candles?count=1&granularity=M1`, {
      //     headers: { Authorization: `Bearer ${OANDA_KEY}` },
      //   });
      //   const data = await res.json();
      //   currentPrice = parseFloat(data.candles[0]?.mid?.c ?? "0");
      // } else if (item.asset_class === "crypto") {
      //   const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${item.symbol.toLowerCase()}&vs_currencies=usd`);
      //   const data = await res.json();
      //   currentPrice = data[item.symbol.toLowerCase()]?.usd;
      // }

      // With live price, check thresholds:
      // if (currentPrice && item.alert_price_high && currentPrice >= item.alert_price_high) {
      //   await fireAlert(user_id, item.symbol, `Hit high alert: ${currentPrice} >= ${item.alert_price_high}`);
      //   alertsFired.push(item.symbol + " HIGH");
      // }
      // if (currentPrice && item.alert_price_low && currentPrice <= item.alert_price_low) {
      //   await fireAlert(user_id, item.symbol, `Hit low alert: ${currentPrice} <= ${item.alert_price_low}`);
      //   alertsFired.push(item.symbol + " LOW");
      // }
    }

    return new Response(JSON.stringify({
      status: "ok",
      watchlist_size: watchlist.length,
      alerts_fired: alertsFired.length,
      triggered: alertsFired,
      note: "Live price feed connects in Phase 2. Alert thresholds are set and ready.",
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});
