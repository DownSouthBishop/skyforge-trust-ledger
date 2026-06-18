// Atlas Balance Sheet — unified capital intelligence across all three verticals
// Phase 4B: runs every Sunday at 20:00 UTC

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv, resolveUserIds } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

const ATLAS_MODEL = () => modelEnv("ATLAS_MODEL", "openai/gpt-4o");

const DEFAULT_ALLOCATION_TARGETS = {
  paper_assets: 40,
  business: 30,
  re: 25,
  cash: 5,
  rebalance_threshold_pct: 10,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = (Deno.env.get("GOOGLE_AI_KEY") ?? "");

    const { user_id: rawUserId } = await req.json();
    if (!rawUserId) {
      return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });
    }

    const userIds = await resolveUserIds(SUPABASE_URL, SERVICE_KEY, rawUserId);
    if (userIds.length === 0) {
      return new Response(JSON.stringify({ message: "No users found to process" }), { headers: corsHeaders });
    }
    const user_id = userIds[0];

    const baseHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // ─── Pull all data in parallel ───────────────────────────────────────────

    const [
      tradingAccountsRes, openTradesRes,
      businessLedgerRes, businessPipelineRes,
      rePortfolioRes, reLedgerRes,
      prevSnapshotRes, allocationPrefRes,
    ] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/trading_accounts?user_id=eq.${user_id}&is_active=eq.true&select=balance_usd,buying_power_usd`, { headers: baseHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/trade_ledger?user_id=eq.${user_id}&status=eq.open&select=entry_price,quantity,direction,pnl_usd`, { headers: baseHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/business_ledger?user_id=eq.${user_id}&created_at=gte.${monthStart}&select=entry_type,amount_usd,status`, { headers: baseHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/business_pipeline?user_id=eq.${user_id}&stage=neq.closed_won&stage=neq.closed_lost&select=estimated_value_usd,probability_pct`, { headers: baseHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/property_portfolio?user_id=eq.${user_id}&status=eq.active&select=current_value,mortgage_balance`, { headers: baseHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/property_ledger?user_id=eq.${user_id}&created_at=gte.${monthStart}&select=entry_type,amount_usd,status`, { headers: baseHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/balance_sheet_snapshots?user_id=eq.${user_id}&order=snapshot_date.desc&limit=1&select=net_worth_usd,snapshot_date`, { headers: baseHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/atlas_user_preferences?user_id=eq.${user_id}&category=eq.trading_style&key=eq.capital_allocation_targets&select=value&limit=1`, { headers: baseHeaders }),
    ]);

    // ─── Parse data ───────────────────────────────────────────────────────────

    const tradingAccounts: Array<{ balance_usd: number | null; buying_power_usd: number | null }> = tradingAccountsRes.ok ? await tradingAccountsRes.json() : [];
    const openTrades: Array<{ entry_price: number; quantity: number; direction: string; pnl_usd: number | null }> = openTradesRes.ok ? await openTradesRes.json() : [];
    const businessLedger: Array<{ entry_type: string; amount_usd: number; status: string }> = businessLedgerRes.ok ? await businessLedgerRes.json() : [];
    const businessPipeline: Array<{ estimated_value_usd: number | null; probability_pct: number | null }> = businessPipelineRes.ok ? await businessPipelineRes.json() : [];
    const rePortfolio: Array<{ current_value: number | null; mortgage_balance: number | null }> = rePortfolioRes.ok ? await rePortfolioRes.json() : [];
    const reLedger: Array<{ entry_type: string; amount_usd: number; status: string }> = reLedgerRes.ok ? await reLedgerRes.json() : [];
    const prevSnapshots: Array<{ net_worth_usd: number | null; snapshot_date: string }> = prevSnapshotRes.ok ? await prevSnapshotRes.json() : [];
    const allocationPrefRows: Array<{ value: string }> = allocationPrefRes.ok ? await allocationPrefRes.json() : [];

    let allocationTargets = { ...DEFAULT_ALLOCATION_TARGETS };
    if (allocationPrefRows.length > 0) {
      try {
        allocationTargets = { ...DEFAULT_ALLOCATION_TARGETS, ...JSON.parse(allocationPrefRows[0].value) };
      } catch { /* use defaults */ }
    }

    // ─── Compute metrics ──────────────────────────────────────────────────────

    const tradingCash = tradingAccounts.reduce((s, a) => s + Number(a.balance_usd ?? 0), 0);
    const positionValues = openTrades.reduce((s, t) => s + (Number(t.entry_price) * Number(t.quantity)), 0);
    const tradingPnlMtd = openTrades.reduce((s, t) => s + Number(t.pnl_usd ?? 0), 0);

    const businessRevenueMtd = businessLedger.filter(e => e.entry_type === "revenue" && e.status === "paid").reduce((s, e) => s + Number(e.amount_usd), 0);
    const businessExpensesMtd = businessLedger.filter(e => e.entry_type === "expense").reduce((s, e) => s + Number(e.amount_usd), 0);
    const businessCash = businessRevenueMtd - businessExpensesMtd;
    const businessPipelineValue = businessPipeline.reduce((s, p) => s + (Number(p.estimated_value_usd ?? 0) * Number(p.probability_pct ?? 50) / 100), 0);

    const rePortfolioValue = rePortfolio.reduce((s, p) => s + Number(p.current_value ?? 0), 0);
    const reMortgageBalance = rePortfolio.reduce((s, p) => s + Number(p.mortgage_balance ?? 0), 0);
    const reEquity = rePortfolioValue - reMortgageBalance;
    const reRentMtd = reLedger.filter(e => e.entry_type === "rent" && e.status === "paid").reduce((s, e) => s + Number(e.amount_usd), 0);
    const reMortgagesMtd = reLedger.filter(e => e.entry_type === "mortgage").reduce((s, e) => s + Number(e.amount_usd), 0);
    const reCashFlowMtd = reRentMtd - reMortgagesMtd;

    const totalAssets = tradingCash + positionValues + Math.max(businessCash, 0) + rePortfolioValue;
    const totalLiabilities = reMortgageBalance;
    const netWorth = totalAssets - totalLiabilities;

    // Allocation percentages
    const paperAssetsPct = totalAssets > 0 ? ((tradingCash + positionValues) / totalAssets * 100) : 0;
    const businessPct    = totalAssets > 0 ? (Math.max(businessCash, 0) / totalAssets * 100) : 0;
    const rePct          = totalAssets > 0 ? (rePortfolioValue / totalAssets * 100) : 0;
    const cashPct        = totalAssets > 0 ? (tradingCash / totalAssets * 100) : 0;

    const prevNetWorth = prevSnapshots.length > 0 ? Number(prevSnapshots[0].net_worth_usd ?? 0) : 0;
    const netWorthChange = netWorth - prevNetWorth;

    const prompt = `You are Atlas. Generate the unified balance sheet report and capital allocation recommendation.

NET WORTH STATEMENT:
Total Assets: $${totalAssets.toLocaleString()}
Total Liabilities: $${totalLiabilities.toLocaleString()}
Net Worth: $${netWorth.toLocaleString()}
Change from last snapshot: ${netWorthChange >= 0 ? "+" : ""}$${netWorthChange.toLocaleString()}

VERTICAL BREAKDOWN:
Paper Assets: $${(tradingCash + positionValues).toLocaleString()} (${paperAssetsPct.toFixed(1)}% actual vs ${allocationTargets.paper_assets}% target)
Business: $${Math.max(businessCash, 0).toLocaleString()} (${businessPct.toFixed(1)}% actual vs ${allocationTargets.business}% target) | Pipeline: $${businessPipelineValue.toLocaleString()} weighted
Real Estate: $${rePortfolioValue.toLocaleString()} (${rePct.toFixed(1)}% actual vs ${allocationTargets.re}% target) | Equity: $${reEquity.toLocaleString()}
Cash: $${tradingCash.toLocaleString()} (${cashPct.toFixed(1)}% actual vs ${allocationTargets.cash}% target)

MTD PERFORMANCE:
Trading P&L: $${tradingPnlMtd.toLocaleString()}
Business Net: $${(businessRevenueMtd - businessExpensesMtd).toLocaleString()} ($${businessRevenueMtd.toLocaleString()} revenue - $${businessExpensesMtd.toLocaleString()} expenses)
RE Cash Flow: $${reCashFlowMtd.toLocaleString()}

REBALANCE THRESHOLD: ${allocationTargets.rebalance_threshold_pct}% deviation triggers action

Sections:
1. Net Worth Statement — total assets, liabilities, net worth, change from last snapshot
2. Vertical Breakdown — paper assets, business, real estate, cash: current vs. target allocation
3. Capital Efficiency — which vertical generated the best return on capital this period
4. Rebalancing Signal — if any vertical is >${allocationTargets.rebalance_threshold_pct}% off target, specific recommendation on what to move where
5. Opportunity Assessment — given current capital position, what is the single highest-ROI capital deployment right now
6. Verdict — one sentence on capital position health

Be direct. State the numbers and the recommendation without hedging.`;

    const aiResp = await callGatewayWithRetry(
      { model: ATLAS_MODEL(), messages: [{ role: "user", content: prompt }], max_tokens: 2000 },
      API_KEY,
    );
    if (!aiResp.ok) throw new Error(`AI call failed: ${aiResp.status}`);

    const aiData = await aiResp.json();
    const narrative: string = aiData.choices?.[0]?.message?.content ?? "Balance sheet generation failed.";

    const dateStr = now.toISOString().split("T")[0];

    // Save snapshot
    const snapshotRes = await fetch(`${SUPABASE_URL}/rest/v1/balance_sheet_snapshots`, {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id,
        snapshot_date: dateStr,
        trading_cash_usd: parseFloat(tradingCash.toFixed(2)),
        trading_positions_value_usd: parseFloat(positionValues.toFixed(2)),
        trading_pnl_mtd: parseFloat(tradingPnlMtd.toFixed(2)),
        business_cash_usd: parseFloat(Math.max(businessCash, 0).toFixed(2)),
        business_revenue_mtd: parseFloat(businessRevenueMtd.toFixed(2)),
        business_expenses_mtd: parseFloat(businessExpensesMtd.toFixed(2)),
        business_pipeline_value_usd: parseFloat(businessPipelineValue.toFixed(2)),
        re_portfolio_value_usd: parseFloat(rePortfolioValue.toFixed(2)),
        re_mortgage_balance_usd: parseFloat(reMortgageBalance.toFixed(2)),
        re_equity_usd: parseFloat(reEquity.toFixed(2)),
        re_cash_flow_mtd: parseFloat(reCashFlowMtd.toFixed(2)),
        total_liabilities_usd: parseFloat(totalLiabilities.toFixed(2)),
        paper_assets_pct: parseFloat(paperAssetsPct.toFixed(2)),
        business_pct: parseFloat(businessPct.toFixed(2)),
        re_pct: parseFloat(rePct.toFixed(2)),
        cash_pct: parseFloat(cashPct.toFixed(2)),
        atlas_summary: narrative.slice(0, 1500),
        atlas_recommendation: narrative.slice(1500, 3000),
      }),
    });

    if (!snapshotRes.ok) {
      console.error("[atlas_balance_sheet] Failed to save snapshot:", await snapshotRes.text());
    }

    // Save to Vault
    await fetch(`${SUPABASE_URL}/rest/v1/research_notes`, {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id,
        title: `Balance Sheet — ${dateStr}`,
        content: narrative,
        note_type: "weekly_review",
        synced_to_obsidian: false,
      }),
    });

    await sendTelegramAlert(`*BALANCE SHEET — ${dateStr}*\nNet Worth: $${netWorth.toLocaleString()} (${netWorthChange >= 0 ? "+" : ""}$${netWorthChange.toLocaleString()})\nPaper: ${paperAssetsPct.toFixed(0)}% | Business: ${businessPct.toFixed(0)}% | RE: ${rePct.toFixed(0)}% | Cash: ${cashPct.toFixed(0)}%\nCheck Vault for allocation analysis.`);

    return new Response(JSON.stringify({
      status: "ok",
      date: dateStr,
      net_worth: netWorth,
      net_worth_change: netWorthChange,
      allocation: { paper_assets: paperAssetsPct, business: businessPct, re: rePct, cash: cashPct },
      targets: allocationTargets,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[atlas_balance_sheet] Error:", msg);
    try {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
      const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (SUPABASE_URL && SERVICE_KEY) {
        const body = await req.clone().json().catch(() => ({}));
        await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: (body as { user_id?: string }).user_id ?? "system", signal_type: "function_error", message: `atlas_balance_sheet error: ${msg}` }),
        });
      }
    } catch { /* ignore */ }
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
