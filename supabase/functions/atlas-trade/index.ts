// atlas-trade — all trading operations
// Consolidates: atlas_execute_trade, atlas_forex_scan, atlas_risk_check,
//   atlas_market_brief, atlas_trade_thesis, atlas_watchlist_patrol,
//   atlas_options_scan, atlas_play_ranker, atlas_play_tracker,
//   atlas_regime_detector, atlas_opportunity_scan, atlas_counterfactual,
//   atlas_news_scan, get_live_prices
//
// Actions: execute_trade, risk_check, forex_scan, market_brief, trade_thesis,
//   watchlist_patrol, options_scan, rank_plays, track_play, detect_regime,
//   opportunity_scan, counterfactual, news_scan, live_prices

import {
  corsHeaders,
  verifyUser,
  parseEnv,
  modelEnv,
  AuthError,
  oandaBaseUrl,
} from "../_shared/gateway.ts";
import { ATLAS_SYSTEM_PROMPT } from "../_shared/atlas_prompt.ts";

const ATLAS_MODEL = () => modelEnv("ATLAS_MODEL", "claude-sonnet-4-5");
const FAST_MODEL  = () => modelEnv("FAST_MODEL",  "claude-haiku-4-5");
const AUTO_EXECUTE_MAX = 200;

// ─── Anthropic direct client ───────────────────────────────────────────────────
async function callAnthropic(body: Record<string, unknown>, apiKey: string): Promise<Response> {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-beta": "web-search-2025-03-05", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function dbHeaders(serviceKey: string) {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" };
}

async function dbGet(url: string, serviceKey: string): Promise<unknown[]> {
  try {
    const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
    return r.ok ? await r.json() : [];
  } catch { return []; }
}

async function insertDecision(
  supabaseUrl: string, serviceKey: string, userId: string,
  color: string, decisionType: string, summary: string, payload: unknown = {},
): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/atlas_decision_queue`, {
    method: "POST",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({ user_id: userId, color, decision_type: decisionType, summary, payload, status: "pending", created_at: new Date().toISOString() }),
  }).catch(() => {});
}

async function sendAlert(supabaseUrl: string, serviceKey: string, userId: string, signalType: string, message: string): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/forge_alerts`, {
    method: "POST",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({ user_id: userId, signal_type: signalType, message }),
  }).catch(() => {});
}

// ─── Broker execution ──────────────────────────────────────────────────────────
interface BrokerResult { broker_order_id: string; status: string; raw_response: unknown }

async function placeOandaOrder(params: { symbol: string; direction: string; quantity: number; entry_price: number }): Promise<BrokerResult> {
  const oandaKey = Deno.env.get("OANDA_API_KEY");
  const accountId = Deno.env.get("OANDA_ACCOUNT_ID");
  if (!oandaKey || !accountId) return { broker_order_id: "", status: "skipped — OANDA not configured", raw_response: null };
  const instrument = params.symbol.replace("/", "_").toUpperCase();
  const units = params.direction === "long" ? params.quantity : -params.quantity;
  try {
    const res = await fetch(`${oandaBaseUrl()}/v3/accounts/${accountId}/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${oandaKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ order: { type: "MARKET", instrument, units: String(units) } }),
    });
    const raw = await res.json();
    return {
      broker_order_id: raw?.orderFillTransaction?.id ?? raw?.orderCreateTransaction?.id ?? "",
      status: res.ok ? "filled" : `error_${res.status}`,
      raw_response: raw,
    };
  } catch (e) { return { broker_order_id: "", status: `exception: ${e instanceof Error ? e.message : e}`, raw_response: null }; }
}

async function placeAlpacaOrder(params: { symbol: string; direction: string; quantity: number }): Promise<BrokerResult> {
  const key = Deno.env.get("ALPACA_API_KEY");
  const secret = Deno.env.get("ALPACA_SECRET_KEY") ?? Deno.env.get("ALPACA_API_SECRET");
  if (!key || !secret) return { broker_order_id: "", status: "skipped — Alpaca not configured", raw_response: null };
  try {
    const res = await fetch("https://api.alpaca.markets/v2/orders", {
      method: "POST",
      headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret, "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: params.symbol.toUpperCase(), qty: params.quantity, side: params.direction === "long" ? "buy" : "sell", type: "market", time_in_force: "day" }),
    });
    const raw = await res.json();
    return { broker_order_id: raw?.id ?? "", status: res.ok ? raw?.status ?? "accepted" : `error_${res.status}`, raw_response: raw };
  } catch (e) { return { broker_order_id: "", status: `exception: ${e instanceof Error ? e.message : e}`, raw_response: null }; }
}

async function placeIbkrOrder(params: { symbol: string; direction: string; quantity: number; entry_price: number }): Promise<BrokerResult> {
  const ibkrBase = Deno.env.get("IBKR_BASE_URL") ?? "http://localhost:5000";
  const accountId = Deno.env.get("IBKR_ACCOUNT_ID");
  if (!accountId) return { broker_order_id: "", status: "skipped — IBKR not configured", raw_response: null };
  try {
    const res = await fetch(`${ibkrBase}/iserver/account/${accountId}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orders: [{ conid: 0, symbol: params.symbol.toUpperCase(), secType: "STK", orderType: "MKT", side: params.direction === "long" ? "BUY" : "SELL", quantity: params.quantity, tif: "DAY" }] }),
    });
    const raw = await res.json();
    const first = Array.isArray(raw) ? raw[0] : raw;
    return { broker_order_id: String(first?.order_id ?? first?.orderId ?? ""), status: res.ok ? first?.order_status ?? "submitted" : `error_${res.status}`, raw_response: raw };
  } catch (e) { return { broker_order_id: "", status: `exception: ${e instanceof Error ? e.message : e}`, raw_response: null }; }
}

// ─── Risk check ────────────────────────────────────────────────────────────────
async function handleRiskCheck(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<Response> {
  const { symbol, asset_class, direction, entry_price, quantity, broker } = body;
  if (!symbol || !entry_price || !quantity) {
    return new Response(JSON.stringify({ go: false, violations: ["Missing required params: symbol, entry_price, quantity"] }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const uid = (body.user_id as string) ?? userId;
  const tradeValue = Number(entry_price) * Number(quantity);
  const violations: string[] = [];

  // Pull account capital and open positions
  const [accountsRes, openTradesRes, todayTradesRes] = await Promise.all([
    fetch(`${supabaseUrl}/rest/v1/trading_accounts?user_id=eq.${uid}&is_active=eq.true&select=balance_usd`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/trade_ledger?user_id=eq.${uid}&status=eq.open&select=id,entry_price,quantity`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/trade_ledger?user_id=eq.${uid}&status=eq.closed&closed_at=gte.${new Date().toISOString().split("T")[0]}&select=pnl_usd`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
  ]);

  const accounts = accountsRes.ok ? await accountsRes.json() as Array<{ balance_usd: number }> : [];
  const openTrades = openTradesRes.ok ? await openTradesRes.json() as Array<{ id: string; entry_price: number; quantity: number }> : [];
  const todayTrades = todayTradesRes.ok ? await todayTradesRes.json() as Array<{ pnl_usd: number | null }> : [];

  const totalCapital = accounts.reduce((s, a) => s + Number(a.balance_usd ?? 0), 0);
  const todayPnl = todayTrades.reduce((s, t) => s + Number(t.pnl_usd ?? 0), 0);

  // Risk rules
  if (totalCapital > 0 && tradeValue / totalCapital > 0.02) {
    violations.push(`Trade size $${tradeValue.toFixed(0)} exceeds 2% capital limit ($${(totalCapital * 0.02).toFixed(0)})`);
  }
  if (openTrades.length >= 10) {
    violations.push(`Position limit reached: ${openTrades.length}/10 open positions`);
  }
  if (totalCapital > 0 && Math.abs(todayPnl) / totalCapital > 0.05 && todayPnl < 0) {
    violations.push(`Daily loss limit breached: -$${Math.abs(todayPnl).toFixed(0)} (${(Math.abs(todayPnl) / totalCapital * 100).toFixed(1)}%)`);
  }

  // Forex specific
  if (asset_class === "forex") {
    const approvedPairs = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "NZD/USD", "USD/CHF", "EUR/GBP"];
    if (!approvedPairs.includes(String(symbol).toUpperCase())) {
      violations.push(`Forex pair ${symbol} not in approved list`);
    }
  }

  // Weekly loss check
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  try {
    const weekTradesRes = await fetch(
      `${supabaseUrl}/rest/v1/trade_ledger?user_id=eq.${uid}&status=eq.closed&closed_at=gte.${weekAgo}&select=pnl_usd`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (weekTradesRes.ok) {
      const weekTrades = await weekTradesRes.json() as Array<{ pnl_usd: number | null }>;
      const weekPnl = weekTrades.reduce((s, t) => s + Number(t.pnl_usd ?? 0), 0);
      if (totalCapital > 0 && weekPnl < 0 && Math.abs(weekPnl) / totalCapital > 0.10) {
        violations.push(`Weekly loss limit breached: -$${Math.abs(weekPnl).toFixed(0)}`);
      }
    }
  } catch { /* non-critical */ }

  return new Response(JSON.stringify({
    go: violations.length === 0,
    violations,
    trade_value: tradeValue,
    open_positions: openTrades.length,
    total_capital: totalCapital,
    today_pnl: todayPnl,
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Execute trade ─────────────────────────────────────────────────────────────
async function handleExecuteTrade(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const { symbol, asset_class, direction, entry_price, quantity, broker, thesis } = body;
  const uid = (body.user_id as string) ?? userId;

  if (!symbol || !asset_class || !direction || !entry_price || !quantity || !broker) {
    return new Response(JSON.stringify({ error: "Missing required params: symbol, asset_class, direction, entry_price, quantity, broker" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Risk check
  const riskBody = { user_id: uid, symbol, asset_class, direction, entry_price, quantity, broker };
  const riskResp = await handleRiskCheck(riskBody, supabaseUrl, serviceKey, uid);
  const risk = await riskResp.json() as { go: boolean; violations: string[] };

  if (!risk.go) {
    await sendAlert(supabaseUrl, serviceKey, uid, "trade_blocked",
      `Trade blocked: ${symbol} ${direction} — ${risk.violations.join("; ")}`);
    return new Response(JSON.stringify({ status: "blocked", reason: risk.violations, risk }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const tradeValue = Number(entry_price) * Number(quantity);
  const needsApproval = tradeValue > AUTO_EXECUTE_MAX;

  // Log to atlas_trade_audit
  const tradeRecord = {
    user_id: uid,
    symbol: String(symbol).toUpperCase(),
    asset_class,
    direction,
    entry_price: Number(entry_price),
    quantity: Number(quantity),
    broker,
    status: needsApproval ? "pending_approval" : "open",
    thesis: thesis ?? null,
    trade_value_usd: tradeValue,
    opened_at: new Date().toISOString(),
  };

  let tradeId: string | null = null;
  try {
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/atlas_trade_audit`, {
      method: "POST",
      headers: { ...dbHeaders(serviceKey), Prefer: "return=representation" },
      body: JSON.stringify(tradeRecord),
    });
    if (insertRes.ok) {
      const inserted = await insertRes.json() as Array<{ id: string }>;
      tradeId = inserted?.[0]?.id ?? null;
    }
  } catch { /* also write to trade_ledger as fallback */ }

  // Fallback: also write to trade_ledger for compatibility
  const legacyInsert = await fetch(`${supabaseUrl}/rest/v1/trade_ledger`, {
    method: "POST",
    headers: { ...dbHeaders(serviceKey), Prefer: "return=representation" },
    body: JSON.stringify({ ...tradeRecord, status: needsApproval ? "open" : "open" }),
  }).catch(() => null);
  if (!tradeId && legacyInsert?.ok) {
    const rows = await legacyInsert.json() as Array<{ id: string }>;
    tradeId = rows?.[0]?.id ?? null;
  }

  if (needsApproval) {
    await insertDecision(supabaseUrl, serviceKey, uid, "ORANGE", "trade_approval",
      `Approval needed: ${symbol} ${direction} $${tradeValue.toFixed(0)} via ${broker}`,
      tradeRecord);
    await sendAlert(supabaseUrl, serviceKey, uid, "trade_approval",
      `Approval needed: ${symbol} ${String(direction).toUpperCase()} $${tradeValue.toFixed(0)} via ${String(broker).toUpperCase()}.`);
    return new Response(JSON.stringify({
      status: "pending_approval",
      message: `Trade logged. $${tradeValue.toFixed(0)} exceeds auto-execute limit of $${AUTO_EXECUTE_MAX}. Approval required.`,
      trade_id: tradeId,
      risk,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Execute via broker
  let brokerResult: BrokerResult | null = null;
  if (broker === "oanda") {
    brokerResult = await placeOandaOrder({ symbol: String(symbol), direction: String(direction), quantity: Number(quantity), entry_price: Number(entry_price) });
  } else if (broker === "alpaca") {
    brokerResult = await placeAlpacaOrder({ symbol: String(symbol), direction: String(direction), quantity: Number(quantity) });
  } else if (broker === "ibkr") {
    brokerResult = await placeIbkrOrder({ symbol: String(symbol), direction: String(direction), quantity: Number(quantity), entry_price: Number(entry_price) });
  }

  if (brokerResult?.broker_order_id && tradeId) {
    await fetch(`${supabaseUrl}/rest/v1/atlas_trade_audit?id=eq.${tradeId}`, {
      method: "PATCH",
      headers: dbHeaders(serviceKey),
      body: JSON.stringify({ broker_order_id: brokerResult.broker_order_id }),
    }).catch(() => {});
  }

  await sendAlert(supabaseUrl, serviceKey, uid, "trade_executed",
    `Trade executed: ${symbol} ${String(direction).toUpperCase()} ${quantity} @ ${entry_price} via ${String(broker).toUpperCase()}. $${tradeValue.toFixed(0)}.`);

  return new Response(JSON.stringify({
    status: "executed",
    trade_id: tradeId,
    broker_result: brokerResult,
    message: `${symbol} ${String(direction).toUpperCase()} executed via ${String(broker).toUpperCase()}.`,
    risk,
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Forex scan ────────────────────────────────────────────────────────────────
async function handleForexScan(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const oandaKey = Deno.env.get("OANDA_API_KEY");
  const accountId = Deno.env.get("OANDA_ACCOUNT_ID");

  const approvedPairs = ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "USD_CAD", "NZD_USD", "USD_CHF", "EUR_GBP"];
  const priceData: Record<string, unknown> = {};

  if (oandaKey && accountId) {
    try {
      const res = await fetch(
        `${oandaBaseUrl()}/v3/accounts/${accountId}/pricing?instruments=${approvedPairs.join(",")}`,
        { headers: { Authorization: `Bearer ${oandaKey}`, "Content-Type": "application/json" } },
      );
      if (res.ok) {
        const data = await res.json() as { prices: Array<{ instrument: string; bids: Array<{ price: string }>; asks: Array<{ price: string }> }> };
        for (const p of data.prices ?? []) {
          priceData[p.instrument] = { bid: p.bids?.[0]?.price, ask: p.asks?.[0]?.price };
        }
      }
    } catch { /* non-critical */ }
  }

  const priceLines = Object.entries(priceData).map(([pair, prices]) => {
    const p = prices as { bid: string; ask: string };
    return `${pair}: bid ${p.bid} / ask ${p.ask}`;
  }).join("\n") || "Live prices unavailable.";

  const resp = await callAnthropic({
    model: ATLAS_MODEL(),
    max_tokens: 1500, tools: [{ type: "web_search_20250305", name: "web_search" }], 
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Scan these forex pairs for trading opportunities. For each viable setup, provide: pair, direction, entry rationale, key risk.

LIVE PRICES:
${priceLines}

Focus on high-probability setups with clear technicals or macro catalysts. Return JSON: {opportunities: [{pair, direction, entry_price, stop_loss, take_profit, rationale, confidence}], summary: string}`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Forex scan AI failed: ${resp.status}`);
  const data = await resp.json();
  const content = data?.content?.[0]?.text ?? "{}";

  let result: { opportunities?: unknown[]; summary?: string } = {};
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1) result = JSON.parse(content.slice(start, end + 1));
  } catch { result = { summary: content }; }

  // Store opportunities as YELLOW decisions
  for (const opp of (result.opportunities ?? []) as Array<{ pair: string; direction: string; rationale: string; confidence: number }>) {
    if (opp.confidence > 0.65) {
      await insertDecision(supabaseUrl, serviceKey, uid, "YELLOW", "forex_opportunity",
        `${opp.pair} ${opp.direction}: ${opp.rationale}`, opp);
    }
  }

  return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Market brief ─────────────────────────────────────────────────────────────
async function handleMarketBrief(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const briefType = (body.brief_type as string) ?? "morning"; // morning | eod

  const [openTradesRes, regimeRes] = await Promise.all([
    fetch(`${supabaseUrl}/rest/v1/trade_ledger?user_id=eq.${uid}&status=eq.open&select=symbol,direction,entry_price,pnl_usd&limit=20`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/atlas_state?user_id=eq.${uid}&order=updated_at.desc&limit=1&select=regime,regime_confidence,updated_at`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
  ]);

  const openTrades = openTradesRes.ok ? await openTradesRes.json() as Array<{ symbol: string; direction: string; entry_price: number; pnl_usd: number | null }> : [];
  const regimeRows = regimeRes.ok ? await regimeRes.json() as Array<{ regime: string; regime_confidence: number; updated_at: string }> : [];
  const regime = regimeRows[0] ?? null;

  const positionsText = openTrades.length > 0
    ? openTrades.map(t => `${t.symbol} ${t.direction} P&L: $${Number(t.pnl_usd ?? 0).toFixed(2)}`).join("\n")
    : "No open positions.";

  const resp = await callAnthropic({
    model: ATLAS_MODEL(),
    max_tokens: 1500, tools: [{ type: "web_search_20250305", name: "web_search" }], 
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Generate the ${briefType === "morning" ? "morning" : "end-of-day"} market brief.

CURRENT REGIME: ${regime ? `${regime.regime} (${(regime.regime_confidence * 100).toFixed(0)}% confidence)` : "Unknown"}

OPEN POSITIONS:
${positionsText}

Brief type: ${briefType === "morning" ? "Pre-market setup — what to watch, opportunities, risks" : "EOD summary — P&L, notable events, tomorrow's setup"}

Be direct. State what the data shows.`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Market brief AI failed: ${resp.status}`);
  const data = await resp.json();
  const brief = data?.content?.[0]?.text ?? "Brief unavailable.";

  await fetch(`${supabaseUrl}/rest/v1/research_notes`, {
    method: "POST",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({
      user_id: uid,
      title: `${briefType === "morning" ? "Morning" : "EOD"} Brief — ${new Date().toISOString().split("T")[0]}`,
      content: brief,
      note_type: "research",
      synced_to_obsidian: false,
    }),
  }).catch(() => {});

  return new Response(JSON.stringify({ brief, brief_type: briefType, open_positions: openTrades.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Trade thesis ──────────────────────────────────────────────────────────────
async function handleTradeThesis(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const symbol = body.symbol as string;
  const uid = (body.user_id as string) ?? userId;
  if (!symbol) return new Response(JSON.stringify({ error: "symbol required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const resp = await callAnthropic({
    model: ATLAS_MODEL(),
    max_tokens: 2000, tools: [{ type: "web_search_20250305", name: "web_search" }], 
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Generate a deep trade thesis for ${symbol}.

Cover:
1. Fundamental drivers — what moves this asset
2. Technical picture — key levels, trend, momentum
3. Macro context — relevant macro forces
4. Risk factors — what kills the thesis
5. Entry/exit framework — specific levels
6. Position sizing recommendation — % of capital
7. Verdict: GO / NO-GO / WAIT with one-sentence reason

Be specific and data-grounded. No filler.`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Trade thesis AI failed: ${resp.status}`);
  const data = await resp.json();
  const thesis = data?.content?.[0]?.text ?? "Thesis unavailable.";

  await fetch(`${supabaseUrl}/rest/v1/research_notes`, {
    method: "POST",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({
      user_id: uid,
      title: `Trade Thesis: ${symbol} — ${new Date().toISOString().split("T")[0]}`,
      content: thesis,
      note_type: "thesis",
      synced_to_obsidian: false,
    }),
  }).catch(() => {});

  return new Response(JSON.stringify({ symbol, thesis }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Watchlist patrol ──────────────────────────────────────────────────────────
async function handleWatchlistPatrol(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const watchlist = await dbGet(
    `${supabaseUrl}/rest/v1/market_watchlist?user_id=eq.${uid}&is_active=eq.true&select=symbol,asset_class,alert_price_high,alert_price_low&limit=50`,
    serviceKey,
  ) as Array<{ symbol: string; asset_class: string; alert_price_high: number | null; alert_price_low: number | null }>;

  if (watchlist.length === 0) return new Response(JSON.stringify({ alerts: [], message: "Empty watchlist" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  // Fetch prices for each symbol — use Alpha Vantage if available
  const alphaKey = Deno.env.get("ALPHA_VANTAGE_API_KEY");
  const alerts: Array<{ symbol: string; type: string; price: number; threshold: number }> = [];

  for (const item of watchlist.slice(0, 10)) {
    try {
      let currentPrice: number | null = null;
      if (alphaKey) {
        const r = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${item.symbol}&apikey=${alphaKey}`);
        if (r.ok) {
          const d = await r.json() as { "Global Quote": { "05. price": string } };
          currentPrice = parseFloat(d["Global Quote"]?.["05. price"] ?? "0") || null;
        }
      }
      if (currentPrice && item.alert_price_high && currentPrice >= item.alert_price_high) {
        alerts.push({ symbol: item.symbol, type: "HIGH", price: currentPrice, threshold: item.alert_price_high });
      }
      if (currentPrice && item.alert_price_low && currentPrice <= item.alert_price_low) {
        alerts.push({ symbol: item.symbol, type: "LOW", price: currentPrice, threshold: item.alert_price_low });
      }
    } catch { /* skip this symbol */ }
  }

  for (const alert of alerts) {
    await sendAlert(supabaseUrl, serviceKey, uid, "watchlist_alert",
      `${alert.symbol} hit ${alert.type} threshold: $${alert.price.toFixed(4)} (threshold $${alert.threshold})`);
    await insertDecision(supabaseUrl, serviceKey, uid, "YELLOW", "watchlist_alert",
      `${alert.symbol} ${alert.type} alert: $${alert.price.toFixed(4)}`, alert);
  }

  return new Response(JSON.stringify({ alerts, symbols_checked: watchlist.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Options scan ─────────────────────────────────────────────────────────────
async function handleOptionsScan(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const symbols = Array.isArray(body.symbols) ? body.symbols as string[] : ["SPY", "QQQ", "AAPL", "TSLA"];

  const resp = await callAnthropic({
    model: ATLAS_MODEL(),
    max_tokens: 1500, tools: [{ type: "web_search_20250305", name: "web_search" }], 
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Scan these symbols for options strategies: ${symbols.join(", ")}

For each symbol, identify the best options strategy given current market conditions:
- Covered calls (for yield generation)
- Cash-secured puts (for acquisition at discount)
- Spreads (for defined risk directional plays)
- Iron condors (for range-bound markets)

Return JSON: {strategies: [{symbol, strategy_type, direction, rationale, estimated_premium, risk_level, recommended_expiry}], summary: string}`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Options scan AI failed: ${resp.status}`);
  const data = await resp.json();
  const content = data?.content?.[0]?.text ?? "{}";
  let result: { strategies?: unknown[]; summary?: string } = {};
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1) result = JSON.parse(content.slice(start, end + 1));
  } catch { result = { summary: content }; }

  return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Rank plays ───────────────────────────────────────────────────────────────
async function handleRankPlays(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const plays = await dbGet(
    `${supabaseUrl}/rest/v1/atlas_plays?user_id=eq.${uid}&status=eq.active&select=id,symbol,asset_class,direction,thesis,entry_price,atlas_score&limit=20`,
    serviceKey,
  ) as Array<{ id: string; symbol: string; asset_class: string; direction: string; thesis: string; entry_price: number; atlas_score: number }>;

  if (plays.length === 0) return new Response(JSON.stringify({ ranked: [], message: "No active plays" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const resp = await callAnthropic({
    model: FAST_MODEL(),
    max_tokens: 1000, tools: [{ type: "web_search_20250305", name: "web_search" }], 
    system: "You rank trading plays by expected value and risk-adjusted return. Return JSON with ranked array.",
    messages: [{
      role: "user",
      content: `Rank these plays by priority (highest conviction first):
${plays.map(p => `${p.symbol} ${p.direction} — ${p.thesis ?? "no thesis"} [score: ${p.atlas_score ?? "?"}]`).join("\n")}

Return JSON: {ranked: [{id, symbol, rank, score_adjustment, rationale}]}`,
    }],
  }, apiKey);

  if (!resp.ok) return new Response(JSON.stringify({ ranked: plays }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const data = await resp.json();
  const content = data?.content?.[0]?.text ?? "{}";
  let result: { ranked?: unknown[] } = {};
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1) result = JSON.parse(content.slice(start, end + 1));
  } catch { result = { ranked: plays }; }

  // Update scores in atlas_plays
  for (const r of (result.ranked ?? []) as Array<{ id: string; score_adjustment: number }>) {
    if (r.id && r.score_adjustment) {
      const play = plays.find(p => p.id === r.id);
      if (play) {
        await fetch(`${supabaseUrl}/rest/v1/atlas_plays?id=eq.${r.id}`, {
          method: "PATCH",
          headers: dbHeaders(serviceKey),
          body: JSON.stringify({ atlas_score: (play.atlas_score ?? 50) + (r.score_adjustment ?? 0), updated_at: new Date().toISOString() }),
        }).catch(() => {});
      }
    }
  }

  return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Track play ───────────────────────────────────────────────────────────────
async function handleTrackPlay(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const { play_id, outcome, actual_roi_pct, notes } = body;
  if (!play_id || !outcome) return new Response(JSON.stringify({ error: "play_id and outcome required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  await fetch(`${supabaseUrl}/rest/v1/atlas_plays?id=eq.${play_id}`, {
    method: "PATCH",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({ status: outcome, actual_roi_pct: actual_roi_pct ?? null, notes: notes ?? null, closed_at: new Date().toISOString() }),
  }).catch(() => {});

  return new Response(JSON.stringify({ status: "tracked", play_id, outcome }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Detect regime ────────────────────────────────────────────────────────────
async function handleDetectRegime(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;

  const recentTradesRes = await fetch(
    `${supabaseUrl}/rest/v1/trade_ledger?user_id=eq.${uid}&order=closed_at.desc&limit=30&select=symbol,direction,pnl_usd,closed_at`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const recentTrades = recentTradesRes.ok ? await recentTradesRes.json() as Array<{ symbol: string; direction: string; pnl_usd: number | null; closed_at: string }> : [];

  const resp = await callAnthropic({
    model: FAST_MODEL(),
    max_tokens: 400, tools: [{ type: "web_search_20250305", name: "web_search" }], 
    system: "Classify the current market regime from trading data. Return JSON only.",
    messages: [{
      role: "user",
      content: `Recent trades: ${recentTrades.slice(0, 15).map(t => `${t.symbol} ${t.direction} $${Number(t.pnl_usd ?? 0).toFixed(0)}`).join(", ")}

Classify regime: {regime: "trending_bull"|"trending_bear"|"ranging"|"volatile"|"uncertain", confidence: 0.0-1.0, rationale: string, recommended_strategy: string}`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Regime detect AI failed: ${resp.status}`);
  const data = await resp.json();
  const content = data?.content?.[0]?.text ?? "{}";
  let result: { regime?: string; confidence?: number; rationale?: string; recommended_strategy?: string } = {};
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1) result = JSON.parse(content.slice(start, end + 1));
  } catch { result = { regime: "uncertain", confidence: 0.5 }; }

  // Store to atlas_state
  await fetch(`${supabaseUrl}/rest/v1/atlas_state`, {
    method: "POST",
    headers: { ...dbHeaders(serviceKey), Prefer: "return=minimal,resolution=merge-duplicates" },
    body: JSON.stringify({
      user_id: uid,
      regime: result.regime ?? "uncertain",
      regime_confidence: result.confidence ?? 0.5,
      regime_rationale: result.rationale ?? "",
      recommended_strategy: result.recommended_strategy ?? "",
      updated_at: new Date().toISOString(),
    }),
  }).catch(() => {});

  return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Opportunity scan ─────────────────────────────────────────────────────────
async function handleOpportunityScan(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;

  const [regimeRows, openTradesRes] = await Promise.all([
    dbGet(`${supabaseUrl}/rest/v1/atlas_state?user_id=eq.${uid}&order=updated_at.desc&limit=1&select=regime,recommended_strategy`, serviceKey),
    dbGet(`${supabaseUrl}/rest/v1/trade_ledger?user_id=eq.${uid}&status=eq.open&select=symbol&limit=10`, serviceKey),
  ]);

  const regime = (regimeRows as Array<{ regime: string; recommended_strategy: string }>)[0] ?? null;
  const openSymbols = (openTradesRes as Array<{ symbol: string }>).map(t => t.symbol);

  const resp = await callAnthropic({
    model: ATLAS_MODEL(),
    max_tokens: 1500, tools: [{ type: "web_search_20250305", name: "web_search" }], 
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Scan for high-priority trading opportunities.

Current regime: ${regime?.regime ?? "unknown"}
Recommended strategy: ${regime?.recommended_strategy ?? ""}
Open positions (avoid): ${openSymbols.join(", ") || "none"}

Identify 5-7 specific opportunities across forex, equities, and commodities.
Return JSON: {opportunities: [{asset_class, symbol, direction, rationale, confidence, urgency: "high"|"medium"|"low"}], market_summary: string}`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Opportunity scan AI failed: ${resp.status}`);
  const data = await resp.json();
  const content = data?.content?.[0]?.text ?? "{}";
  let result: { opportunities?: unknown[]; market_summary?: string } = {};
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1) result = JSON.parse(content.slice(start, end + 1));
  } catch { result = { market_summary: content }; }

  // Log scan timestamp
  await fetch(`${supabaseUrl}/rest/v1/atlas_opportunity_signals`, {
    method: "POST",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({ user_id: uid, scanned_at: new Date().toISOString(), opportunity_count: (result.opportunities ?? []).length }),
  }).catch(() => {});

  // High-urgency opportunities → YELLOW decisions
  for (const opp of (result.opportunities ?? []) as Array<{ symbol: string; direction: string; rationale: string; urgency: string; confidence: number }>) {
    if (opp.urgency === "high" && opp.confidence > 0.7) {
      await insertDecision(supabaseUrl, serviceKey, uid, "YELLOW", "trading_opportunity",
        `${opp.symbol} ${opp.direction}: ${opp.rationale}`, opp);
    }
  }

  return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Counterfactual ───────────────────────────────────────────────────────────
async function handleCounterfactual(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const { trade_id, scenario } = body;

  let tradeData: Record<string, unknown> = {};
  if (trade_id) {
    const rows = await dbGet(`${supabaseUrl}/rest/v1/trade_ledger?id=eq.${trade_id}&select=*`, serviceKey);
    tradeData = (rows as Array<Record<string, unknown>>)[0] ?? {};
  }

  const resp = await callAnthropic({
    model: ATLAS_MODEL(),
    max_tokens: 1200, tools: [{ type: "web_search_20250305", name: "web_search" }], 
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Run a counterfactual analysis.

${trade_id ? `Trade data: ${JSON.stringify(tradeData)}` : ""}
${scenario ? `Scenario: ${scenario}` : ""}

Analyze:
1. What actually happened and why
2. What alternative decision would have produced a better outcome
3. What the key decision point was
4. What to do differently next time
5. Expected value of the alternative approach

Be specific. Trace to the actual data.`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Counterfactual AI failed: ${resp.status}`);
  const data = await resp.json();
  const analysis = data?.content?.[0]?.text ?? "Analysis unavailable.";

  return new Response(JSON.stringify({ analysis, trade_id: trade_id ?? null }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── News scan ────────────────────────────────────────────────────────────────
async function handleNewsScan(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const symbols = Array.isArray(body.symbols) ? body.symbols as string[] : [];

  // Fetch news from Alpha Vantage if available
  const alphaKey = Deno.env.get("ALPHA_VANTAGE_API_KEY");
  let newsSummary = "Live news unavailable.";
  if (alphaKey && symbols.length > 0) {
    try {
      const r = await fetch(`https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${symbols.slice(0, 5).join(",")}&limit=10&apikey=${alphaKey}`);
      if (r.ok) {
        const d = await r.json() as { feed?: Array<{ title: string; summary: string; overall_sentiment_label: string }> };
        newsSummary = (d.feed ?? []).slice(0, 5).map(n => `[${n.overall_sentiment_label}] ${n.title}`).join("\n");
      }
    } catch { /* ignore */ }
  }

  const resp = await callAnthropic({
    model: FAST_MODEL(),
    max_tokens: 800, tools: [{ type: "web_search_20250305", name: "web_search" }], 
    system: "You analyze market news for trading relevance. Be concise and actionable.",
    messages: [{
      role: "user",
      content: `Analyze this news for trading impact${symbols.length > 0 ? ` on ${symbols.join(", ")}` : ""}:

${newsSummary}

Return JSON: {sentiment: "bullish"|"bearish"|"neutral", key_events: string[], trading_implications: string[], urgency: "high"|"medium"|"low"}`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`News scan AI failed: ${resp.status}`);
  const data = await resp.json();
  const content = data?.content?.[0]?.text ?? "{}";
  let result: { sentiment?: string; key_events?: string[]; trading_implications?: string[]; urgency?: string } = {};
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1) result = JSON.parse(content.slice(start, end + 1));
  } catch { result = { sentiment: "neutral", key_events: [newsSummary] }; }

  if (result.urgency === "high") {
    await insertDecision(supabaseUrl, serviceKey, uid, "ORANGE", "news_alert",
      `${result.sentiment} news signal: ${(result.key_events ?? []).slice(0, 1).join(", ")}`, result);
  }

  return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Live prices ──────────────────────────────────────────────────────────────
async function handleLivePrices(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
): Promise<Response> {
  const symbols = Array.isArray(body.symbols) ? body.symbols as string[] : [];
  const assetClass = (body.asset_class as string) ?? "equity";
  const prices: Record<string, unknown> = {};

  if (assetClass === "forex") {
    const oandaKey = Deno.env.get("OANDA_API_KEY");
    const accountId = Deno.env.get("OANDA_ACCOUNT_ID");
    if (oandaKey && accountId && symbols.length > 0) {
      try {
        const instruments = symbols.map(s => s.replace("/", "_").toUpperCase()).join(",");
        const r = await fetch(`${oandaBaseUrl()}/v3/accounts/${accountId}/pricing?instruments=${instruments}`, {
          headers: { Authorization: `Bearer ${oandaKey}` },
        });
        if (r.ok) {
          const d = await r.json() as { prices: Array<{ instrument: string; bids: Array<{ price: string }>; asks: Array<{ price: string }> }> };
          for (const p of d.prices ?? []) {
            prices[p.instrument] = { bid: p.bids?.[0]?.price, ask: p.asks?.[0]?.price };
          }
        }
      } catch { /* ignore */ }
    }
  } else {
    const alphaKey = Deno.env.get("ALPHA_VANTAGE_API_KEY");
    if (alphaKey) {
      for (const symbol of symbols.slice(0, 5)) {
        try {
          const r = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${alphaKey}`);
          if (r.ok) {
            const d = await r.json() as { "Global Quote": { "05. price": string; "09. change": string; "10. change percent": string } };
            const q = d["Global Quote"];
            prices[symbol] = { price: q?.["05. price"], change: q?.["09. change"], change_pct: q?.["10. change percent"] };
          }
        } catch { /* skip */ }
      }
    }
  }

  return new Response(JSON.stringify({ prices, symbols, asset_class: assetClass }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("ANTHROPIC_API_KEY");

    const body: Record<string, unknown> = await req.json().catch(() => ({}));
    const action = (body.action as string) ?? "risk_check";

    // Determine userId — allow service-role bypass
    let userId = "system";
    try {
      userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    } catch {
      const authHeader = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (authHeader === SERVICE_KEY) {
        userId = (body.user_id as string) ?? "system";
      } else if (!(body.user_id as string)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } else {
        userId = body.user_id as string;
      }
    }

    switch (action) {
      case "execute_trade":   return await handleExecuteTrade(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "risk_check":      return await handleRiskCheck(body, SUPABASE_URL, SERVICE_KEY, userId);
      case "forex_scan":      return await handleForexScan(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "market_brief":    return await handleMarketBrief(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "trade_thesis":    return await handleTradeThesis(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "watchlist_patrol": return await handleWatchlistPatrol(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "options_scan":    return await handleOptionsScan(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "rank_plays":      return await handleRankPlays(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "track_play":      return await handleTrackPlay(body, SUPABASE_URL, SERVICE_KEY, userId);
      case "detect_regime":   return await handleDetectRegime(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "opportunity_scan": return await handleOpportunityScan(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "counterfactual":  return await handleCounterfactual(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "news_scan":       return await handleNewsScan(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "live_prices":     return await handleLivePrices(body, SUPABASE_URL, SERVICE_KEY);
      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
  } catch (e) {
    if (e instanceof AuthError) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.error("[atlas-trade] Error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
