// Atlas Watchlist Patrol — monitors watchlist for price threshold breaches
// Primary: Polygon.io — Fallback: Alpha Vantage (equity) / OANDA (forex)

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

// ─── Polygon helpers ──────────────────────────────────────────────────────────

async function fetchEquityPricePolygon(symbol: string, apiKey: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol.toUpperCase())}?apiKey=${apiKey}`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    const price = data?.ticker?.day?.c ?? data?.ticker?.lastTrade?.p ?? data?.ticker?.prevDay?.c;
    return price ? Number(price) : null;
  } catch {
    return null;
  }
}

async function fetchForexPricePolygon(symbol: string, apiKey: string): Promise<number | null> {
  const polygonTicker = "C:" + symbol.replace("/", "").toUpperCase();
  try {
    const res = await fetch(
      `https://api.polygon.io/v2/snapshot/locale/global/markets/forex/tickers?tickers=${encodeURIComponent(polygonTicker)}&apiKey=${apiKey}`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    const ticker = Array.isArray(data?.tickers) ? data.tickers[0] : null;
    const price = ticker?.day?.c ?? ticker?.prevDay?.c;
    return price ? Number(price) : null;
  } catch {
    return null;
  }
}

// ─── Alpha Vantage fallback (equity) ─────────────────────────────────────────

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

// ─── OANDA fallback (forex) ───────────────────────────────────────────────────

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

// ─── CoinGecko (crypto) ───────────────────────────────────────────────────────

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

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const POLYGON_KEY  = Deno.env.get("POLYGON_API_KEY");
    const ALPHA_KEY    = Deno.env.get("ALPHA_VANTAGE_API_KEY") ?? Deno.env.get("ALPHA_VANTAGE_KEY");
    const OANDA_KEY    = Deno.env.get("OANDA_API_KEY");

    if (!POLYGON_KEY) console.warn("POLYGON_API_KEY not set — falling back to Alpha Vantage / OANDA");
    if (!ALPHA_KEY)   console.warn("ALPHA_VANTAGE_API_KEY not set — equity prices may be unavailable");
    if (!OANDA_KEY)   console.warn("OANDA_API_KEY not set — forex prices may be unavailable");

    const { user_id } = await req.json();
    if (!user_id) return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });

    const watchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/market_watchlist?user_id=eq.${user_id}&is_active=eq.true&select=id,symbol,asset_class,alert_price_high,alert_price_low,notes`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    const watchlist: Array<{
      id: string;
      symbol: string;
      asset_class: string;
      alert_price_high: number | null;
      alert_price_low: number | null;
    }> = watchRes.ok ? await watchRes.json() : [];

    if (watchlist.length === 0) {
      return new Response(JSON.stringify({ status: "ok", alerts_fired: 0, message: "Watchlist is empty.", triggered: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const priceMap: Record<string, number | null> = {};
    const triggered: Array<{ symbol: string; threshold_type: string; current_price: number; threshold_value: number }> = [];

    // Fetch all prices in parallel — Polygon primary, fallback as needed
    await Promise.all(watchlist.map(async (item) => {
      let price: number | null = null;

      if (item.asset_class === "equity") {
        if (POLYGON_KEY) price = await fetchEquityPricePolygon(item.symbol, POLYGON_KEY);
        if (price == null && ALPHA_KEY) price = await fetchEquityPrice(item.symbol, ALPHA_KEY);
      } else if (item.asset_class === "forex") {
        if (POLYGON_KEY) price = await fetchForexPricePolygon(item.symbol, POLYGON_KEY);
        if (price == null && OANDA_KEY) price = await fetchForexPrice(item.symbol, OANDA_KEY);
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

        await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({
            user_id,
            signal_type: "price_alert",
            message: `PRICE ALERT — ${item.symbol}: ${currentPrice} breached high threshold ${alertHigh}`,
          }),
        });

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

        await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({
            user_id,
            signal_type: "price_alert",
            message: `PRICE ALERT — ${item.symbol}: ${currentPrice} breached low threshold ${alertLow}`,
          }),
        });

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

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
