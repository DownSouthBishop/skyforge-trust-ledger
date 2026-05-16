// Atlas Execute Trade — risk-gated trade execution with live broker wiring
// Phase 1: OANDA REST, Alpaca REST, IBKR TWS bridge

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";

const AUTO_EXECUTE_MAX = 500; // USD — trades above this go to approval queue

interface BrokerResult {
  broker_order_id: string;
  status: string;
  raw_response: unknown;
}

async function logBrokerResponse(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  result: BrokerResult & { symbol: string; broker: string },
): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/rest/v1/forge_alerts`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        user_id: userId,
        signal_type: "broker_response",
        message: `${result.broker.toUpperCase()} order ${result.broker_order_id ?? "?"} — ${result.status} — ${result.symbol}`,
      }),
    });
  } catch (e) {
    console.error("[atlas_execute_trade] Failed to log broker response:", e);
  }
}

async function placeOandaOrder(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  params: { symbol: string; direction: string; quantity: number; entry_price: number },
): Promise<BrokerResult> {
  const oandaKey = Deno.env.get("OANDA_API_KEY");
  const accountId = Deno.env.get("OANDA_ACCOUNT_ID");

  if (!oandaKey || !accountId) {
    return { broker_order_id: "", status: "skipped — OANDA credentials not configured", raw_response: null };
  }

  const instrument = params.symbol.replace("/", "_").toUpperCase();
  const units = params.direction === "long" ? params.quantity : -params.quantity;

  try {
    const res = await fetch(
      `https://api-fxtrade.oanda.com/v3/accounts/${accountId}/orders`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${oandaKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          order: {
            type: "MARKET",
            instrument,
            units: String(units),
          },
        }),
      },
    );
    const raw = await res.json();
    const result: BrokerResult = {
      broker_order_id: raw?.orderFillTransaction?.id ?? raw?.orderCreateTransaction?.id ?? "",
      status: res.ok ? "filled" : `error_${res.status}`,
      raw_response: raw,
    };
    await logBrokerResponse(supabaseUrl, serviceKey, userId, { ...result, symbol: params.symbol, broker: "oanda" });
    return result;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { broker_order_id: "", status: `exception: ${msg}`, raw_response: null };
  }
}

async function placeAlpacaOrder(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  params: { symbol: string; direction: string; quantity: number },
): Promise<BrokerResult> {
  const alpacaKey = Deno.env.get("ALPACA_API_KEY");
  const alpacaSecret = Deno.env.get("ALPACA_SECRET_KEY") ?? Deno.env.get("ALPACA_API_SECRET");

  if (!alpacaKey || !alpacaSecret) {
    return { broker_order_id: "", status: "skipped — Alpaca credentials not configured", raw_response: null };
  }

  try {
    const res = await fetch("https://api.alpaca.markets/v2/orders", {
      method: "POST",
      headers: {
        "APCA-API-KEY-ID": alpacaKey,
        "APCA-API-SECRET-KEY": alpacaSecret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        symbol: params.symbol.toUpperCase(),
        qty: params.quantity,
        side: params.direction === "long" ? "buy" : "sell",
        type: "market",
        time_in_force: "day",
      }),
    });
    const raw = await res.json();
    const result: BrokerResult = {
      broker_order_id: raw?.id ?? "",
      status: res.ok ? raw?.status ?? "accepted" : `error_${res.status}`,
      raw_response: raw,
    };
    await logBrokerResponse(supabaseUrl, serviceKey, userId, { ...result, symbol: params.symbol, broker: "alpaca" });
    return result;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { broker_order_id: "", status: `exception: ${msg}`, raw_response: null };
  }
}

async function placeIbkrOrder(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  params: { symbol: string; direction: string; quantity: number; entry_price: number },
): Promise<BrokerResult> {
  const ibkrBase = Deno.env.get("IBKR_BASE_URL") ?? "http://localhost:5000";
  const ibkrAccountId = Deno.env.get("IBKR_ACCOUNT_ID");

  if (!ibkrAccountId) {
    return { broker_order_id: "", status: "skipped — IBKR_ACCOUNT_ID not configured", raw_response: null };
  }

  try {
    const res = await fetch(`${ibkrBase}/iserver/account/${ibkrAccountId}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orders: [{
          conid: 0, // 0 triggers symbol-based lookup in the IBKR bridge
          symbol: params.symbol.toUpperCase(),
          secType: "STK",
          orderType: "MKT",
          side: params.direction === "long" ? "BUY" : "SELL",
          quantity: params.quantity,
          tif: "DAY",
        }],
      }),
    });
    const raw = await res.json();
    const firstOrder = Array.isArray(raw) ? raw[0] : raw;
    const result: BrokerResult = {
      broker_order_id: String(firstOrder?.order_id ?? firstOrder?.orderId ?? ""),
      status: res.ok ? firstOrder?.order_status ?? "submitted" : `error_${res.status}`,
      raw_response: raw,
    };
    await logBrokerResponse(supabaseUrl, serviceKey, userId, { ...result, symbol: params.symbol, broker: "ibkr" });
    return result;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { broker_order_id: "", status: `exception: ${msg}`, raw_response: null };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    const body = await req.json();
    const { user_id, symbol, asset_class, direction, entry_price, quantity, broker, thesis } = body;

    if (!user_id || !symbol || !asset_class || !direction || !entry_price || !quantity || !broker) {
      return new Response(JSON.stringify({ error: "Missing required trade parameters" }), { status: 400, headers: corsHeaders });
    }

    // Step 1: Risk check
    const riskResp = await fetch(`${SUPABASE_URL}/functions/v1/atlas_risk_check`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id, symbol, asset_class, direction, entry_price, quantity, broker }),
    });
    const risk = riskResp.ok ? await riskResp.json() : { go: false, violations: ["Risk check unavailable"] };

    if (!risk.go) {
      await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
        method: "POST",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          user_id,
          signal_type: "trade_blocked",
          message: `Trade blocked: ${symbol} ${direction.toUpperCase()} — ${risk.violations.join("; ")}`,
        }),
      });
      return new Response(JSON.stringify({ status: "blocked", reason: risk.violations, risk }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tradeValue = Number(entry_price) * Number(quantity);
    const needsApproval = tradeValue > AUTO_EXECUTE_MAX;

    // Step 2: Log to trade_ledger
    const tradeRecord = {
      user_id,
      symbol: symbol.toUpperCase(),
      asset_class,
      direction,
      entry_price: Number(entry_price),
      quantity: Number(quantity),
      broker,
      status: "open",
      thesis: thesis ?? null,
      opened_at: new Date().toISOString(),
    };

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/trade_ledger`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(tradeRecord),
    });
    const inserted = insertRes.ok ? await insertRes.json() : null;

    if (needsApproval) {
      await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
        method: "POST",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          user_id,
          signal_type: "trade_approval",
          message: `Approval needed: ${symbol} ${direction.toUpperCase()} $${tradeValue.toFixed(0)} via ${broker.toUpperCase()}. Trade logged — awaiting confirmation.`,
        }),
      });

      return new Response(JSON.stringify({
        status: "pending_approval",
        message: `Trade logged. $${tradeValue.toFixed(0)} exceeds auto-execute limit of $${AUTO_EXECUTE_MAX}. Approval required.`,
        trade_id: (inserted as Array<{ id: string }>)?.[0]?.id,
        risk,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Step 3: Execute via broker
    let brokerResult: BrokerResult | null = null;
    if (broker === "oanda") {
      brokerResult = await placeOandaOrder(SUPABASE_URL, SERVICE_KEY, user_id, { symbol, direction, quantity: Number(quantity), entry_price: Number(entry_price) });
    } else if (broker === "alpaca") {
      brokerResult = await placeAlpacaOrder(SUPABASE_URL, SERVICE_KEY, user_id, { symbol, direction, quantity: Number(quantity) });
    } else if (broker === "ibkr") {
      brokerResult = await placeIbkrOrder(SUPABASE_URL, SERVICE_KEY, user_id, { symbol, direction, quantity: Number(quantity), entry_price: Number(entry_price) });
    }

    // Update trade record with broker order ID if available
    if (brokerResult?.broker_order_id && inserted?.[0]?.id) {
      await fetch(`${SUPABASE_URL}/rest/v1/trade_ledger?id=eq.${inserted[0].id}`, {
        method: "PATCH",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ broker_order_id: brokerResult.broker_order_id }),
      });
    }

    await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id,
        signal_type: "trade_executed",
        message: `Trade executed: ${symbol} ${direction.toUpperCase()} ${quantity} @ ${entry_price} via ${broker.toUpperCase()}. $${tradeValue.toFixed(0)}.`,
      }),
    });

    return new Response(JSON.stringify({
      status: "executed",
      trade_id: (inserted as Array<{ id: string }>)?.[0]?.id,
      broker_result: brokerResult,
      message: `${symbol} ${direction.toUpperCase()} executed via ${broker.toUpperCase()}.`,
      risk,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
