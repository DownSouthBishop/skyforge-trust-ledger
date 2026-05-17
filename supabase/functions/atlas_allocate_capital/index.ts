// Atlas Allocate Capital — on-demand capital allocation advisor
// Phase 4B: purely advisory — no auto-execution, every capital movement requires explicit approval

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv } from "../_shared/gateway.ts";

const ATLAS_MODEL = () => modelEnv("ATLAS_MODEL", "openai/gpt-4o");

const DEFAULT_TARGETS = { paper_assets: 40, business: 30, re: 25, cash: 5, rebalance_threshold_pct: 10 };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("LOVABLE_API_KEY");

    const { user_id } = await req.json();
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });
    }

    const baseHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    // Fetch latest balance sheet snapshot
    const snapshotRes = await fetch(
      `${SUPABASE_URL}/rest/v1/balance_sheet_snapshots?user_id=eq.${user_id}&order=snapshot_date.desc&limit=1&select=*`,
      { headers: baseHeaders },
    );
    const snapshots: Array<Record<string, unknown>> = snapshotRes.ok ? await snapshotRes.json() : [];

    // Fetch allocation targets
    const prefRes = await fetch(
      `${SUPABASE_URL}/rest/v1/atlas_user_preferences?user_id=eq.${user_id}&category=eq.trading_style&key=eq.capital_allocation_targets&select=value&limit=1`,
      { headers: baseHeaders },
    );
    const prefRows: Array<{ value: string }> = prefRes.ok ? await prefRes.json() : [];
    const targets = prefRows.length > 0 ? { ...DEFAULT_TARGETS, ...JSON.parse(prefRows[0].value) } : DEFAULT_TARGETS;

    // Fetch current opportunity queues
    const [tradesRes, businessTasksRes, rePipelineRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/forge_alerts?user_id=eq.${user_id}&signal_type=eq.trade_approval&read_at=is.null&select=message&limit=5`, { headers: baseHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/business_tasks?user_id=eq.${user_id}&status=eq.queued&select=task_type,subject&limit=5`, { headers: baseHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/property_pipeline?user_id=eq.${user_id}&stage=in.(analyzing,offer_pending)&select=address,stage,cap_rate,cash_on_cash_return&limit=5`, { headers: baseHeaders }),
    ]);

    const pendingTrades = tradesRes.ok ? await tradesRes.json() : [];
    const businessTasks = businessTasksRes.ok ? await businessTasksRes.json() : [];
    const rePipeline    = rePipelineRes.ok    ? await rePipelineRes.json()    : [];

    const snapshot = snapshots.length > 0 ? snapshots[0] : null;

    if (!snapshot) {
      return new Response(JSON.stringify({
        error: "No balance sheet snapshot found. Run the balance sheet first.",
        available_capital: 0,
        current_allocation: {},
        target_allocation: targets,
        gap: {},
        recommendations: [],
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const availableCapital = Number(snapshot.trading_cash_usd ?? 0) + Number(snapshot.business_cash_usd ?? 0);
    const currentAllocation = {
      paper_assets: Number(snapshot.paper_assets_pct ?? 0),
      business: Number(snapshot.business_pct ?? 0),
      re: Number(snapshot.re_pct ?? 0),
      cash: Number(snapshot.cash_pct ?? 0),
    };

    const gap = {
      paper_assets: targets.paper_assets - currentAllocation.paper_assets,
      business: targets.business - currentAllocation.business,
      re: targets.re - currentAllocation.re,
      cash: targets.cash - currentAllocation.cash,
    };

    const prompt = `You are Atlas. Provide a capital allocation recommendation.

CURRENT POSITION:
Available Liquid Capital: $${availableCapital.toLocaleString()}
Net Worth: $${Number(snapshot.net_worth_usd ?? 0).toLocaleString()}

CURRENT vs TARGET ALLOCATION:
Paper Assets: ${currentAllocation.paper_assets.toFixed(1)}% (target: ${targets.paper_assets}%, gap: ${gap.paper_assets > 0 ? "+" : ""}${gap.paper_assets.toFixed(1)}%)
Business: ${currentAllocation.business.toFixed(1)}% (target: ${targets.business}%, gap: ${gap.business > 0 ? "+" : ""}${gap.business.toFixed(1)}%)
Real Estate: ${currentAllocation.re.toFixed(1)}% (target: ${targets.re}%, gap: ${gap.re > 0 ? "+" : ""}${gap.re.toFixed(1)}%)
Cash: ${currentAllocation.cash.toFixed(1)}% (target: ${targets.cash}%, gap: ${gap.cash > 0 ? "+" : ""}${gap.cash.toFixed(1)}%)

PENDING OPPORTUNITIES:
Trading: ${(pendingTrades as Array<{ message: string }>).map(t => t.message.slice(0, 80)).join(" | ") || "None"}
Business: ${(businessTasks as Array<{ task_type: string; subject: string }>).map(t => t.subject.slice(0, 60)).join(" | ") || "None"}
Real Estate: ${(rePipeline as Array<{ address: string; stage: string; cap_rate: number | null }>).map(d => `${d.address} [${d.stage}] cap:${d.cap_rate ?? "?"}%`).join(" | ") || "None"}

Provide 3 specific capital deployment recommendations, each with: action, amount, rationale, expected_return. Rank by expected ROI.
State clearly that all capital movements require explicit operator approval.`;

    const aiResp = await callGatewayWithRetry(
      { model: ATLAS_MODEL(), messages: [{ role: "user", content: prompt }], max_tokens: 1000 },
      API_KEY,
    );
    if (!aiResp.ok) throw new Error(`AI call failed: ${aiResp.status}`);

    const aiData = await aiResp.json();
    const narrative: string = aiData.choices?.[0]?.message?.content ?? "Capital allocation analysis unavailable.";

    return new Response(JSON.stringify({
      available_capital: availableCapital,
      current_allocation: currentAllocation,
      target_allocation: targets,
      gap,
      narrative,
      disclaimer: "Advisory only. All capital movements require explicit operator approval.",
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[atlas_allocate_capital] Error:", msg);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
