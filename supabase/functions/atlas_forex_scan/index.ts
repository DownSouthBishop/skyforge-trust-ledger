// Atlas Forex Scan — hourly scan of approved pairs using OANDA H4 candles + technical indicators
// Phase 1D: reads market regime from atlas_user_preferences to gate strategy selection

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv } from "../_shared/gateway.ts";

const FAST_MODEL = () => modelEnv("FAST_MODEL", "google/gemini-2.5-flash");

const APPROVED_PAIRS = ["EUR/USD","GBP/USD","USD/JPY","AUD/USD","USD/CAD","NZD/USD","USD/CHF","EUR/GBP"];

function calcEMA(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const seed = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const emas: number[] = [seed];
  for (let i = period; i < closes.length; i++) {
    emas.push(closes[i] * k + emas[emas.length - 1] * (1 - k));
  }
  return emas;
}

function calcRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  let avgGain = changes.slice(0, period).reduce((a, c) => a + Math.max(c, 0), 0) / period;
  let avgLoss = changes.slice(0, period).reduce((a, c) => a + Math.abs(Math.min(c, 0)), 0) / period;
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + Math.max(changes[i], 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.abs(Math.min(changes[i], 0))) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcATR(candles: Array<{ mid?: { h?: string; l?: string; c?: string } }>, period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i].mid?.h ?? "0");
    const low  = parseFloat(candles[i].mid?.l ?? "0");
    const prev = parseFloat(candles[i - 1].mid?.c ?? "0");
    if (!high || !low || !prev) continue;
    trs.push(Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)));
  }
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function detectCrossover(ema20: number[], ema50: number[]): string {
  if (ema20.length < 2 || ema50.length < 2) return "insufficient data";
  for (let back = 1; back <= Math.min(3, ema20.length - 1, ema50.length - 1); back++) {
    const c20 = ema20[ema20.length - back];
    const p20 = ema20[ema20.length - back - 1];
    const c50 = ema50[ema50.length - back];
    const p50 = ema50[ema50.length - back - 1];
    if (p20 <= p50 && c20 > c50) return "bullish crossover (EMA20 crossed above EMA50)";
    if (p20 >= p50 && c20 < c50) return "bearish crossover (EMA20 crossed below EMA50)";
  }
  const last20 = ema20[ema20.length - 1];
  const last50 = ema50[ema50.length - 1];
  return last20 > last50 ? "EMA20 above EMA50 (bullish structure)" : "EMA20 below EMA50 (bearish structure)";
}

async function analyzePair(pair: string, oandaKey: string): Promise<string> {
  const instrument = pair.replace("/", "_");
  try {
    const res = await fetch(
      `https://api-fxpractice.oanda.com/v3/instruments/${instrument}/candles?count=50&granularity=H4`,
      { headers: { Authorization: `Bearer ${oandaKey}` } },
    );
    if (!res.ok) return `${pair}: OANDA error ${res.status}`;
    const data = await res.json();
    const candles: Array<{ mid?: { h?: string; l?: string; c?: string } }> = data.candles ?? [];
    if (candles.length < 20) return `${pair}: insufficient candle data (${candles.length} bars)`;

    const closes = candles.map((c) => parseFloat(c.mid?.c ?? "0")).filter(Boolean);
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);
    const rsi   = calcRSI(closes, 14);
    const atr   = calcATR(candles, 14);
    const cross = detectCrossover(ema20, ema50);

    const last    = closes[closes.length - 1];
    const high50  = Math.max(...closes);
    const low50   = Math.min(...closes);
    const flags: string[] = [];
    if (rsi != null && rsi < 30) flags.push("OVERSOLD");
    if (rsi != null && rsi > 70) flags.push("OVERBOUGHT");
    if (last >= high50 * 0.999) flags.push("AT 50-BAR HIGH");
    if (last <= low50 * 1.001)  flags.push("AT 50-BAR LOW");
    if (cross.includes("crossover")) flags.push(cross.toUpperCase());

    return `${pair}: close=${last.toFixed(5)} | EMA20=${ema20[ema20.length-1]?.toFixed(5) ?? "N/A"} | EMA50=${ema50[ema50.length-1]?.toFixed(5) ?? "N/A"} | RSI=${rsi != null ? rsi.toFixed(1) : "N/A"} | ATR=${atr != null ? atr.toFixed(5) : "N/A"} | ${cross}${flags.length ? " | FLAGS: " + flags.join(", ") : ""}`;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `${pair}: error — ${msg}`;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("LOVABLE_API_KEY");
    const OANDA_KEY    = Deno.env.get("OANDA_API_KEY");

    if (!OANDA_KEY) console.warn("OANDA_API_KEY not set — technical indicators unavailable");

    const { user_id } = await req.json();
    if (!user_id) return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });

    const baseHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    // Phase 1D: Read current market regime from atlas_user_preferences
    let currentRegime = "unknown";
    try {
      const regimeResp = await fetch(
        `${SUPABASE_URL}/rest/v1/atlas_user_preferences?user_id=eq.${user_id}&category=eq.trading_style&key=eq.market_regime&select=value&limit=1`,
        { headers: baseHeaders },
      );
      if (regimeResp.ok) {
        const regimeRows: Array<{ value: string }> = await regimeResp.json();
        if (regimeRows.length > 0) {
          const parsed = JSON.parse(regimeRows[0].value) as { regime?: string };
          currentRegime = parsed.regime ?? "unknown";
        }
      }
    } catch {
      console.warn("[atlas_forex_scan] Could not read regime preference, proceeding without it");
    }

    // Build regime strategy gate context
    const regimeContext = currentRegime !== "unknown"
      ? `\nCurrent Market Regime: ${currentRegime}\nRegime Strategy Gate:\n- Risk-On Trending: favor momentum setups, trend continuation\n- Risk-Off Trending: reduce size, favor safe-haven flows, defensive only\n- Range-Bound Low Vol: favor mean reversion at extremes, tighter risk\n- Range-Bound High Vol: widen stops, reduce size, wait for clear breakouts\nOnly recommend setups aligned with the current regime.`
      : "";

    const watchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/market_watchlist?user_id=eq.${user_id}&asset_class=eq.forex&is_active=eq.true&select=symbol,notes`,
      { headers: baseHeaders },
    );
    const watchlist: Array<{ symbol: string }> = watchRes.ok ? await watchRes.json() : [];
    const watchedPairs: string[] = watchlist.map((w) => w.symbol);
    const pairsToScan = [...new Set([...APPROVED_PAIRS, ...watchedPairs])];

    const today = new Date().toISOString().split("T")[0];
    const hour  = new Date().getUTCHours();

    let scanData = "H4 TECHNICAL SCAN:\n";
    if (OANDA_KEY) {
      const results = await Promise.all(pairsToScan.map(pair => analyzePair(pair, OANDA_KEY)));
      scanData += results.join("\n");
    } else {
      scanData += "OANDA API key not configured. Framework scan only.";
    }

    const prompt = `You are Atlas — autonomous forex analyst. Scan these pairs for H4 setups.

Date/Time: ${today} ${hour}:00 UTC
Pairs: ${pairsToScan.join(", ")}
${regimeContext}

${scanData}

Interpret the technical data. For each pair with a notable setup, output:
**[PAIR]**: [setup description based on indicators] — [Bullish/Bearish/Neutral] [H4]

Only flag pairs with clear signals (RSI extreme, EMA crossover, range break). Skip pairs with no setup.
End with: ONE highest-priority pair and one-sentence rationale.

Risk rules: max 10:1 leverage, 2% risk per trade, 5% daily loss limit.`;

    const aiRespRaw = await callGatewayWithRetry(
      { model: FAST_MODEL(), messages: [{ role: "user", content: prompt }], max_tokens: 800 },
      API_KEY,
    );
    const aiResp   = await aiRespRaw.json();
    const scanResult = aiResp.choices?.[0]?.message?.content ?? "Scan failed.";
    const title      = `Forex Scan — ${today} ${hour}:00 UTC`;

    await fetch(`${SUPABASE_URL}/rest/v1/research_notes`, {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ user_id, title, content: scanResult, note_type: "research", symbol: "FOREX_SCAN", synced_to_obsidian: false }),
    });

    await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id,
        signal_type: "forex_scan",
        message: `Forex scan complete [${currentRegime} regime] — ${pairsToScan.length} pairs reviewed. Check Vault for setups.`,
      }),
    });

    return new Response(JSON.stringify({ scan: scanResult, pairs_scanned: pairsToScan.length, title, regime: currentRegime }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
