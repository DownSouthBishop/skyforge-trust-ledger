// get_live_prices — lightweight price resolver for UI components
// Primary: Polygon.io — Fallback: Alpha Vantage (equity) / OANDA (forex)

import { corsHeaders, oandaBaseUrl } from "../_shared/gateway.ts";

type PriceRequest = { symbol: string; asset_class: string };

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
  // Polygon forex ticker format: C:EURUSD (no slash, C: prefix)
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

async function fetchEquityPriceAlphaVantage(symbol: string, apiKey: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`,
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

async function fetchForexPriceOanda(symbol: string, oandaKey: string): Promise<number | null> {
  const instrument = symbol.replace("/", "_");
  try {
    const res = await fetch(
      `${oandaBaseUrl()}/v3/instruments/${instrument}/candles?count=1&granularity=M1`,
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
    const POLYGON_KEY  = Deno.env.get("POLYGON_API_KEY");
    const ALPHA_KEY    = Deno.env.get("ALPHA_VANTAGE_API_KEY") ?? Deno.env.get("ALPHA_VANTAGE_KEY");
    const OANDA_KEY    = Deno.env.get("OANDA_API_KEY");

    const { symbols }: { symbols: PriceRequest[] } = await req.json();
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return new Response(JSON.stringify({ prices: {} }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const prices: Record<string, number | null> = {};

    await Promise.all(
      symbols.map(async ({ symbol, asset_class }) => {
        let price: number | null = null;

        if (asset_class === "equity") {
          if (POLYGON_KEY) price = await fetchEquityPricePolygon(symbol, POLYGON_KEY);
          if (price == null && ALPHA_KEY) price = await fetchEquityPriceAlphaVantage(symbol, ALPHA_KEY);
        } else if (asset_class === "forex") {
          if (POLYGON_KEY) price = await fetchForexPricePolygon(symbol, POLYGON_KEY);
          if (price == null && OANDA_KEY) price = await fetchForexPriceOanda(symbol, OANDA_KEY);
        } else if (asset_class === "crypto") {
          price = await fetchCryptoPrice(symbol);
        }

        prices[symbol] = price;
      }),
    );

    return new Response(JSON.stringify({ prices }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
