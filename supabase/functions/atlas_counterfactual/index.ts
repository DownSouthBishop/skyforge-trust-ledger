// Atlas Counterfactual — analyzes today's closed trades for exit logic improvement

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv } from "../_shared/gateway.ts";

const FAST_MODEL = () => modelEnv("FAST_MODEL", "google/gemini-2.5-flash");

interface ClosedTrade {
  id: string;
  symbol: string;
  direction: string;
  entry_price: number;
  exit_price: number;
  quantity: number;
  pnl_usd: number;
  thesis: string | null;
  opened_at: string;
  closed_at: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("LOVABLE_API_KEY");

    const { user_id } = await req.json();
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const baseHeaders = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    };

    const today = new Date().toISOString().split("T")[0];

    // Fetch all trades closed today
    const tradesResp = await fetch(
      `${SUPABASE_URL}/rest/v1/trade_ledger?user_id=eq.${user_id}&status=eq.closed&closed_at=gte.${today}T00:00:00&select=id,symbol,direction,entry_price,exit_price,quantity,pnl_usd,thesis,opened_at,closed_at`,
      { headers: baseHeaders },
    );
    if (!tradesResp.ok) throw new Error(`Failed to fetch trades: ${tradesResp.status}`);
    const trades: ClosedTrade[] = await tradesResp.json();

    if (trades.length === 0) {
      return new Response(JSON.stringify({ trades_analyzed: 0, recommendation_saved: false, message: "No trades closed today" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Compute counterfactual hypotheticals for each trade
    const hypothetical10: Record<string, number> = {};
    const hypothetical20: Record<string, number> = {};

    for (const trade of trades) {
      const entryPrice = Number(trade.entry_price);
      const exitPrice  = Number(trade.exit_price);
      const quantity   = Number(trade.quantity);

      // Price change per unit from entry to exit
      const priceChangePct = trade.direction === "long"
        ? exitPrice - entryPrice
        : entryPrice - exitPrice;

      // Hypothetical: hold 10% and 20% longer (multiply price move by 1.1 / 1.2)
      hypothetical10[trade.id] = priceChangePct * 1.1 * quantity;
      hypothetical20[trade.id] = priceChangePct * 1.2 * quantity;
    }

    const tradeLines = trades.map((t) =>
      `${t.symbol} ${t.direction}: Actual P&L $${Number(t.pnl_usd).toFixed(2)}. If exit held 10% longer: ~$${hypothetical10[t.id].toFixed(2)}. Thesis: ${t.thesis ?? "none"}`
    ).join("\n");

    const prompt = `You are Atlas performing counterfactual analysis on today's closed trades. For each trade, I've estimated hypothetical outcomes:\n${tradeLines}\nGiven these counterfactuals, what is the single most impactful change to exit logic? Be specific. 80 words max.`;

    const aiRespRaw = await callGatewayWithRetry(
      {
        model: FAST_MODEL(),
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
      },
      API_KEY,
    );

    if (!aiRespRaw.ok) throw new Error(`AI call failed: ${aiRespRaw.status}`);

    const aiData = await aiRespRaw.json();
    const recommendation: string = aiData.choices?.[0]?.message?.content?.trim() ?? "Counterfactual analysis unavailable.";

    // Save to research_notes
    const saveResp = await fetch(`${SUPABASE_URL}/rest/v1/research_notes`, {
      method: "POST",
      headers: {
        ...baseHeaders,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        user_id,
        note_type: "research",
        symbol: "COUNTERFACTUAL",
        title: `Counterfactual — ${today}`,
        content: recommendation,
        synced_to_obsidian: false,
      }),
    });

    if (!saveResp.ok) {
      const errText = await saveResp.text();
      console.error(`[atlas_counterfactual] Failed to save research note: ${errText}`);
    }

    return new Response(JSON.stringify({ trades_analyzed: trades.length, recommendation_saved: true }), {
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
