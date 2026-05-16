// Atlas Watchlist Patrol — monitors watchlist for price threshold breaches
// Fetches live prices from Alpha Vantage (equity), OANDA (forex), CoinGecko (crypto)

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

async function fetchEquityPrice(symbol: string, alphaKey: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${alphaKey}`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    const price = data?.["Global Quote"]?.["05. price"];
    return price ? parseFloat(price) : null;
  } catch {
    return null;
  }
}

async function fetchForexPrice(symbol: string, oandaKey: string): Promise<number | null> {
  const instrument = symbol.replace("/", "_");
  try {
    const res = await fetch(
      `https://api-fxpractice.oanda.com/v3/instruments/${instrument}/candles?count=1&granularity=M1`,
      { headers: { Authorization: `Bearer ${oandaKey}` } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const close = data?.candles?.[0]?.mid?.c;
    return close ? parseFloat(close) : null;
  } catch {
    return null;
  }
}

async function fetchCryptoPrice(symbol: string): Promise<number | null> {
  try {
    const id = symbol.toLowerCase();
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.[id]?.usd ?? null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const ALPHA_KEY    = Deno.env.get("ALPHA_VANTAGE_KEY");
    const OANDA_KEY    = Deno.env.get("OANDA_API_KEY");

    if (!ALPHA_KEY) console.warn("ALPHA_VANTAGE_KEY not set — equity prices unavailable");
    if (!OANDA_KEY) console.warn("OANDA_API_KEY not set — forex prices unavailable");

    const { user_id } = await req.json();
    if (!user_id) return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });

    const watchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/market_watchlist?user_id=eq.${user_id}&is_active=eq.true&select=id,symbol,asset_class,alert_price_high,alert_price_low,notes`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    const watchlist: any[] = watchRes.ok ? await watchRes.json() : [];

    if (watchlist.length === 0) {
      return new Response(JSON.stringify({ status: "ok", alerts_fired: 0, message: "Watchlist is empty.", triggered: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const priceMap: Record<string, number | null> = {};
    const triggered: Array<{ symbol: string; threshold_type: string; current_price: number; threshold_value: number }> = [];

    // Fetch all prices in parallel
    await Promise.all(watchlist.map(async (item) => {
      let price: number | null = null;
      if (item.asset_class === "equity" && ALPHA_KEY) {
        price = await fetchEquityPrice(item.symbol, ALPHA_KEY);
      } else if (item.asset_class === "forex" && OANDA_KEY) {
        price = await fetchForexPrice(item.symbol, OANDA_KEY);
      } else if (item.asset_class === "crypto") {
        price = await fetchCryptoPrice(item.symbol);
      }
      priceMap[item.symbol] = price;
    }));

    // Check thresholds and fire alerts
    for (const item of watchlist) {
      const currentPrice = priceMap[item.symbol];
      if (currentPrice == null) continue;

      const alertHigh = item.alert_price_high != null ? Number(item.alert_price_high) : null;
      const alertLow  = item.alert_price_low  != null ? Number(item.alert_price_low)  : null;

      if (alertHigh != null && currentPrice >= alertHigh) {
        triggered.push({ symbol: item.symbol, threshold_type: "high", current_price: currentPrice, threshold_value: alertHigh });
        await sendTelegramAlert(`*PRICE ALERT: ${item.symbol}*\nHigh threshold breached: ${currentPrice} ≥ ${alertHigh}`);
        await fetch(`${SUPABASE_URL}/rest/v1/atlas_tasks`, {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({
            user_id,
            task_type: "price_alert",
            payload: { symbol: item.symbol, current_price: currentPrice, threshold_type: "high", threshold_value: alertHigh },
            status: "queued",
          }),
        });
      }

      if (alertLow != null && currentPrice <= alertLow) {
        triggered.push({ symbol: item.symbol, threshold_type: "low", current_price: currentPrice, threshold_value: alertLow });
        await sendTelegramAlert(`*PRICE ALERT: ${item.symbol}*\nLow threshold breached: ${currentPrice} ≤ ${alertLow}`);
        await fetch(`${SUPABASE_URL}/rest/v1/atlas_tasks`, {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({
            user_id,
            task_type: "price_alert",
            payload: { symbol: item.symbol, current_price: currentPrice, threshold_type: "low", threshold_value: alertLow },
            status: "queued",
          }),
        });
      }
    }

    return new Response(JSON.stringify({
      status: "ok",
      watchlist_size: watchlist.length,
      alerts_fired: triggered.length,
      triggered,
      prices: priceMap,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});
