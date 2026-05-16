// get_live_prices — lightweight price resolver for UI components
// Accepts array of { symbol, asset_class } items, returns price map

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";

type PriceRequest = { symbol: string; asset_class: string };

async function fetchEquityPrice(symbol: string, apiKey: string): Promise<number | null> {
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
    const ALPHA_KEY = Deno.env.get("ALPHA_VANTAGE_KEY");
    const OANDA_KEY = Deno.env.get("OANDA_API_KEY");

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
        if (asset_class === "equity" && ALPHA_KEY) {
          price = await fetchEquityPrice(symbol, ALPHA_KEY);
        } else if (asset_class === "forex" && OANDA_KEY) {
          price = await fetchForexPrice(symbol, OANDA_KEY);
        } else if (asset_class === "crypto") {
          price = await fetchCryptoPrice(symbol);
        }
        prices[symbol] = price;
      }),
    );

    return new Response(JSON.stringify({ prices }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
