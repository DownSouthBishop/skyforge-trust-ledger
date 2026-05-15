// Atlas Execute Trade — risk-gated trade execution
// Checks risk rules, logs to trade_ledger, fires approval alert if above threshold
// Phase 2: wire actual broker API calls (OANDA REST, Alpaca REST, IBKR bridge)

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";

const AUTO_EXECUTE_MAX = 500; // USD — trades above this go to approval queue

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
      // Create a blocked alert
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
    const tradeRecord: any = {
      user_id,
      symbol: symbol.toUpperCase(),
      asset_class,
      direction,
      entry_price: Number(entry_price),
      quantity: Number(quantity),
      broker,
      status: needsApproval ? "open" : "open",
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
      // Create approval alert
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
        trade_id: inserted?.[0]?.id,
        risk,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Phase 2: broker API execution
    // if (broker === "oanda") await placeOandaOrder({ symbol, direction, quantity, entry_price });
    // if (broker === "alpaca") await placeAlpacaOrder({ symbol, direction, quantity });
    // if (broker === "ibkr") await placeIbkrOrder({ symbol, direction, quantity, entry_price });

    // Execution alert
    await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id,
        signal_type: "trade_executed",
        message: `Trade logged: ${symbol} ${direction.toUpperCase()} ${quantity} @ ${entry_price} via ${broker.toUpperCase()}. $${tradeValue.toFixed(0)}.`,
      }),
    });

    return new Response(JSON.stringify({
      status: "executed",
      trade_id: inserted?.[0]?.id,
      message: `${symbol} ${direction.toUpperCase()} logged to trade ledger. Broker execution in Phase 2.`,
      risk,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});
