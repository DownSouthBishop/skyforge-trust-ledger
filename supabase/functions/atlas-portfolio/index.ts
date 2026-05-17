// atlas-portfolio — portfolio tracking and allocation
// Consolidates: atlas_portfolio_sync, atlas_allocate_capital, atlas_balance_sheet,
//               atlas_expense_audit, atlas_income_velocity
//
// Actions: sync, allocate, balance_sheet, expense_audit, income_velocity,
//          allocation_check, self_funding_status

import {
  corsHeaders,
  verifyUser,
  parseEnv,
  modelEnv,
  AuthError,
  resolveUserIds,
} from "../_shared/gateway.ts";
import { ATLAS_SYSTEM_PROMPT } from "../_shared/atlas_prompt.ts";

const ATLAS_MODEL = () => modelEnv("ATLAS_MODEL", "claude-sonnet-4-5");

const TARGET_ALLOCATION = { paper_assets: 40, business: 30, re: 25, cash: 5 };
const REBALANCE_THRESHOLD_PCT = 15;
const DAILY_INCOME_TARGET = 100;

async function callAnthropic(body: Record<string, unknown>, apiKey: string): Promise<Response> {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
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

// ─── Portfolio sync ────────────────────────────────────────────────────────────
async function handleSync(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const results: Record<string, unknown> = {};

  // Sync Alpaca
  const alpacaKey = Deno.env.get("ALPACA_API_KEY");
  const alpacaSecret = Deno.env.get("ALPACA_SECRET_KEY") ?? Deno.env.get("ALPACA_API_SECRET");
  if (alpacaKey && alpacaSecret) {
    try {
      const [accountRes, positionsRes] = await Promise.all([
        fetch("https://api.alpaca.markets/v2/account", {
          headers: { "APCA-API-KEY-ID": alpacaKey, "APCA-API-SECRET-KEY": alpacaSecret },
        }),
        fetch("https://api.alpaca.markets/v2/positions", {
          headers: { "APCA-API-KEY-ID": alpacaKey, "APCA-API-SECRET-KEY": alpacaSecret },
        }),
      ]);
      if (accountRes.ok) {
        const acct = await accountRes.json() as { buying_power: string; portfolio_value: string; cash: string };
        await fetch(`${supabaseUrl}/rest/v1/trading_accounts?user_id=eq.${uid}&broker=eq.alpaca`, {
          method: "PATCH",
          headers: dbHeaders(serviceKey),
          body: JSON.stringify({
            balance_usd: parseFloat(acct.portfolio_value ?? "0"),
            buying_power_usd: parseFloat(acct.buying_power ?? "0"),
            cash_usd: parseFloat(acct.cash ?? "0"),
            last_synced_at: new Date().toISOString(),
          }),
        }).catch(() => {});
        results.alpaca = { balance: parseFloat(acct.portfolio_value ?? "0"), status: "synced" };
      }
    } catch (e) {
      results.alpaca = { status: "error", error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Sync OANDA
  const oandaKey = Deno.env.get("OANDA_API_KEY");
  const oandaAccountId = Deno.env.get("OANDA_ACCOUNT_ID");
  if (oandaKey && oandaAccountId) {
    try {
      const oandaBase = (Deno.env.get("OANDA_ENV") ?? "practice") === "live"
        ? "https://api-fxtrade.oanda.com"
        : "https://api-fxpractice.oanda.com";
      const res = await fetch(`${oandaBase}/v3/accounts/${oandaAccountId}/summary`, {
        headers: { Authorization: `Bearer ${oandaKey}` },
      });
      if (res.ok) {
        const data = await res.json() as { account: { balance: string; NAV: string; unrealizedPL: string } };
        await fetch(`${supabaseUrl}/rest/v1/trading_accounts?user_id=eq.${uid}&broker=eq.oanda`, {
          method: "PATCH",
          headers: dbHeaders(serviceKey),
          body: JSON.stringify({
            balance_usd: parseFloat(data.account?.NAV ?? "0"),
            buying_power_usd: parseFloat(data.account?.balance ?? "0"),
            last_synced_at: new Date().toISOString(),
          }),
        }).catch(() => {});
        results.oanda = { balance: parseFloat(data.account?.NAV ?? "0"), status: "synced" };
      }
    } catch (e) {
      results.oanda = { status: "error", error: e instanceof Error ? e.message : String(e) };
    }
  }

  return new Response(JSON.stringify({ status: "ok", synced: results, timestamp: new Date().toISOString() }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Balance sheet ────────────────────────────────────────────────────────────
async function handleBalanceSheet(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [
    tradingAccountsRes, openTradesRes,
    businessLedgerRes, businessPipelineRes,
    rePortfolioRes, reLedgerRes,
    prevSnapshotRes,
  ] = await Promise.all([
    fetch(`${supabaseUrl}/rest/v1/trading_accounts?user_id=eq.${uid}&is_active=eq.true&select=balance_usd,buying_power_usd`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/trade_ledger?user_id=eq.${uid}&status=eq.open&select=entry_price,quantity,pnl_usd`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/business_ledger?user_id=eq.${uid}&created_at=gte.${monthStart}&select=entry_type,amount_usd,status`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/business_pipeline?user_id=eq.${uid}&stage=neq.closed_won&stage=neq.closed_lost&select=estimated_value_usd,probability_pct`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/property_portfolio?user_id=eq.${uid}&status=eq.active&select=current_value,mortgage_balance`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/property_ledger?user_id=eq.${uid}&created_at=gte.${monthStart}&select=entry_type,amount_usd,status`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/balance_sheet_snapshots?user_id=eq.${uid}&order=snapshot_date.desc&limit=1&select=net_worth_usd,snapshot_date`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
  ]);

  const tradingAccounts = tradingAccountsRes.ok ? await tradingAccountsRes.json() as Array<{ balance_usd: number | null; buying_power_usd: number | null }> : [];
  const openTrades = openTradesRes.ok ? await openTradesRes.json() as Array<{ entry_price: number; quantity: number; pnl_usd: number | null }> : [];
  const businessLedger = businessLedgerRes.ok ? await businessLedgerRes.json() as Array<{ entry_type: string; amount_usd: number; status: string }> : [];
  const businessPipeline = businessPipelineRes.ok ? await businessPipelineRes.json() as Array<{ estimated_value_usd: number | null; probability_pct: number | null }> : [];
  const rePortfolio = rePortfolioRes.ok ? await rePortfolioRes.json() as Array<{ current_value: number | null; mortgage_balance: number | null }> : [];
  const reLedger = reLedgerRes.ok ? await reLedgerRes.json() as Array<{ entry_type: string; amount_usd: number; status: string }> : [];
  const prevSnapshots = prevSnapshotRes.ok ? await prevSnapshotRes.json() as Array<{ net_worth_usd: number | null; snapshot_date: string }> : [];

  const tradingCash = tradingAccounts.reduce((s, a) => s + Number(a.balance_usd ?? 0), 0);
  const positionValues = openTrades.reduce((s, t) => s + Number(t.entry_price) * Number(t.quantity), 0);
  const tradingPnlMtd = openTrades.reduce((s, t) => s + Number(t.pnl_usd ?? 0), 0);

  const businessRevenueMtd = businessLedger.filter(e => e.entry_type === "revenue" && e.status === "paid").reduce((s, e) => s + Number(e.amount_usd), 0);
  const businessExpensesMtd = businessLedger.filter(e => e.entry_type === "expense").reduce((s, e) => s + Number(e.amount_usd), 0);
  const businessCash = Math.max(businessRevenueMtd - businessExpensesMtd, 0);
  const businessPipelineValue = businessPipeline.reduce((s, p) => s + (Number(p.estimated_value_usd ?? 0) * Number(p.probability_pct ?? 50) / 100), 0);

  const rePortfolioValue = rePortfolio.reduce((s, p) => s + Number(p.current_value ?? 0), 0);
  const reMortgageBalance = rePortfolio.reduce((s, p) => s + Number(p.mortgage_balance ?? 0), 0);
  const reEquity = rePortfolioValue - reMortgageBalance;
  const reRentMtd = reLedger.filter(e => e.entry_type === "rent" && e.status === "paid").reduce((s, e) => s + Number(e.amount_usd), 0);
  const reMortgagesMtd = reLedger.filter(e => e.entry_type === "mortgage").reduce((s, e) => s + Number(e.amount_usd), 0);
  const reCashFlowMtd = reRentMtd - reMortgagesMtd;

  const totalAssets = tradingCash + positionValues + businessCash + rePortfolioValue;
  const totalLiabilities = reMortgageBalance;
  const netWorth = totalAssets - totalLiabilities;

  const paperAssetsPct = totalAssets > 0 ? ((tradingCash + positionValues) / totalAssets * 100) : 0;
  const businessPct = totalAssets > 0 ? (businessCash / totalAssets * 100) : 0;
  const rePct = totalAssets > 0 ? (rePortfolioValue / totalAssets * 100) : 0;
  const cashPct = totalAssets > 0 ? (tradingCash / totalAssets * 100) : 0;

  const prevNetWorth = prevSnapshots.length > 0 ? Number(prevSnapshots[0].net_worth_usd ?? 0) : 0;
  const netWorthChange = netWorth - prevNetWorth;
  const dateStr = now.toISOString().split("T")[0];

  const prompt = `Generate the unified balance sheet report.

NET WORTH STATEMENT:
Total Assets: $${totalAssets.toLocaleString()} | Liabilities: $${totalLiabilities.toLocaleString()} | Net Worth: $${netWorth.toLocaleString()}
Change from last snapshot: ${netWorthChange >= 0 ? "+" : ""}$${netWorthChange.toLocaleString()}

ALLOCATION (actual vs target):
Paper Assets: ${paperAssetsPct.toFixed(1)}% actual vs ${TARGET_ALLOCATION.paper_assets}% target ($${(tradingCash + positionValues).toLocaleString()})
Business: ${businessPct.toFixed(1)}% vs ${TARGET_ALLOCATION.business}% ($${businessCash.toLocaleString()} cash + $${businessPipelineValue.toLocaleString()} pipeline)
Real Estate: ${rePct.toFixed(1)}% vs ${TARGET_ALLOCATION.re}% ($${rePortfolioValue.toLocaleString()} value, $${reEquity.toLocaleString()} equity)
Cash: ${cashPct.toFixed(1)}% vs ${TARGET_ALLOCATION.cash}%

MTD PERFORMANCE:
Trading P&L: $${tradingPnlMtd.toLocaleString()} | Business Net: $${(businessRevenueMtd - businessExpensesMtd).toLocaleString()} | RE Cash Flow: $${reCashFlowMtd.toLocaleString()}

Sections: 1) Net Worth Statement 2) Allocation Analysis 3) Rebalancing Signal 4) Capital Opportunity 5) Verdict
If any vertical is >${REBALANCE_THRESHOLD_PCT}% off target, specify exactly what to move where.`;

  const resp = await callAnthropic({
    model: ATLAS_MODEL(), max_tokens: 2000,
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Balance sheet AI failed: ${resp.status}`);
  const aiData = await resp.json();
  const narrative = aiData?.content?.[0]?.text ?? "Balance sheet generation failed.";

  // Save snapshot
  await fetch(`${supabaseUrl}/rest/v1/balance_sheet_snapshots`, {
    method: "POST",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({
      user_id: uid,
      snapshot_date: dateStr,
      trading_cash_usd: parseFloat(tradingCash.toFixed(2)),
      trading_positions_value_usd: parseFloat(positionValues.toFixed(2)),
      trading_pnl_mtd: parseFloat(tradingPnlMtd.toFixed(2)),
      business_cash_usd: parseFloat(businessCash.toFixed(2)),
      business_revenue_mtd: parseFloat(businessRevenueMtd.toFixed(2)),
      business_expenses_mtd: parseFloat(businessExpensesMtd.toFixed(2)),
      business_pipeline_value_usd: parseFloat(businessPipelineValue.toFixed(2)),
      re_portfolio_value_usd: parseFloat(rePortfolioValue.toFixed(2)),
      re_mortgage_balance_usd: parseFloat(reMortgageBalance.toFixed(2)),
      re_equity_usd: parseFloat(reEquity.toFixed(2)),
      re_cash_flow_mtd: parseFloat(reCashFlowMtd.toFixed(2)),
      total_assets_usd: parseFloat(totalAssets.toFixed(2)),
      total_liabilities_usd: parseFloat(totalLiabilities.toFixed(2)),
      net_worth_usd: parseFloat(netWorth.toFixed(2)),
      paper_assets_pct: parseFloat(paperAssetsPct.toFixed(2)),
      business_pct: parseFloat(businessPct.toFixed(2)),
      re_pct: parseFloat(rePct.toFixed(2)),
      cash_pct: parseFloat(cashPct.toFixed(2)),
      atlas_summary: narrative.slice(0, 1500),
    }),
  }).catch(() => {});

  // Write to atlas_portfolio_state
  await fetch(`${supabaseUrl}/rest/v1/atlas_portfolio_state`, {
    method: "POST",
    headers: { ...dbHeaders(serviceKey), Prefer: "return=minimal,resolution=merge-duplicates" },
    body: JSON.stringify({
      user_id: uid,
      net_worth_usd: parseFloat(netWorth.toFixed(2)),
      total_assets_usd: parseFloat(totalAssets.toFixed(2)),
      paper_assets_pct: parseFloat(paperAssetsPct.toFixed(2)),
      business_pct: parseFloat(businessPct.toFixed(2)),
      re_pct: parseFloat(rePct.toFixed(2)),
      cash_pct: parseFloat(cashPct.toFixed(2)),
      rebalancing_needed: false,
      updated_at: new Date().toISOString(),
    }),
  }).catch(() => {});

  // Save to Vault
  await fetch(`${supabaseUrl}/rest/v1/research_notes`, {
    method: "POST",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({ user_id: uid, title: `Balance Sheet — ${dateStr}`, content: narrative, note_type: "weekly_review", synced_to_obsidian: false }),
  }).catch(() => {});

  return new Response(JSON.stringify({
    status: "ok",
    date: dateStr,
    net_worth: netWorth,
    net_worth_change: netWorthChange,
    allocation: { paper_assets: paperAssetsPct, business: businessPct, re: rePct, cash: cashPct },
    targets: TARGET_ALLOCATION,
    narrative,
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Allocation check ──────────────────────────────────────────────────────────
async function handleAllocationCheck(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const stateRows = await dbGet(
    `${supabaseUrl}/rest/v1/atlas_portfolio_state?user_id=eq.${uid}&order=updated_at.desc&limit=1`,
    serviceKey,
  ) as Array<{ paper_assets_pct: number; business_pct: number; re_pct: number; cash_pct: number }>;

  if (stateRows.length === 0) {
    return new Response(JSON.stringify({ message: "No portfolio state. Run balance_sheet first." }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const state = stateRows[0];
  const deviations: Array<{ vertical: string; actual: number; target: number; deviation: number }> = [
    { vertical: "paper_assets", actual: state.paper_assets_pct, target: TARGET_ALLOCATION.paper_assets, deviation: state.paper_assets_pct - TARGET_ALLOCATION.paper_assets },
    { vertical: "business",     actual: state.business_pct,     target: TARGET_ALLOCATION.business,     deviation: state.business_pct - TARGET_ALLOCATION.business },
    { vertical: "re",           actual: state.re_pct,           target: TARGET_ALLOCATION.re,           deviation: state.re_pct - TARGET_ALLOCATION.re },
    { vertical: "cash",         actual: state.cash_pct,         target: TARGET_ALLOCATION.cash,         deviation: state.cash_pct - TARGET_ALLOCATION.cash },
  ];

  const breaches = deviations.filter(d => Math.abs(d.deviation) > REBALANCE_THRESHOLD_PCT);
  const rebalancingNeeded = breaches.length > 0;

  if (rebalancingNeeded) {
    const summary = breaches.map(b =>
      `${b.vertical}: ${b.actual.toFixed(1)}% actual vs ${b.target}% target (${b.deviation > 0 ? "+" : ""}${b.deviation.toFixed(1)}%)`
    ).join("; ");

    await insertDecision(supabaseUrl, serviceKey, uid, "YELLOW", "allocation_rebalance",
      `Portfolio rebalancing needed: ${summary}`, { deviations, rebalancing_needed: true });

    // Set rebalancing_needed flag
    await fetch(`${supabaseUrl}/rest/v1/atlas_portfolio_state?user_id=eq.${uid}`, {
      method: "PATCH",
      headers: dbHeaders(serviceKey),
      body: JSON.stringify({ rebalancing_needed: true, updated_at: new Date().toISOString() }),
    }).catch(() => {});
  }

  return new Response(JSON.stringify({
    rebalancing_needed: rebalancingNeeded,
    deviations,
    breaches,
    threshold_pct: REBALANCE_THRESHOLD_PCT,
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Allocate capital ─────────────────────────────────────────────────────────
async function handleAllocate(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const capitalToAllocate = Number(body.capital_usd ?? 0);
  if (capitalToAllocate <= 0) return new Response(JSON.stringify({ error: "capital_usd required and must be positive" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const stateRows = await dbGet(
    `${supabaseUrl}/rest/v1/atlas_portfolio_state?user_id=eq.${uid}&order=updated_at.desc&limit=1`,
    serviceKey,
  ) as Array<Record<string, unknown>>;
  const state = stateRows[0] ?? { paper_assets_pct: 0, business_pct: 0, re_pct: 0, cash_pct: 0 };

  const resp = await callAnthropic({
    model: ATLAS_MODEL(),
    max_tokens: 1000,
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Advise on capital allocation for $${capitalToAllocate.toLocaleString()}.

CURRENT ALLOCATION:
Paper Assets: ${Number(state.paper_assets_pct ?? 0).toFixed(1)}% (target ${TARGET_ALLOCATION.paper_assets}%)
Business: ${Number(state.business_pct ?? 0).toFixed(1)}% (target ${TARGET_ALLOCATION.business}%)
Real Estate: ${Number(state.re_pct ?? 0).toFixed(1)}% (target ${TARGET_ALLOCATION.re}%)
Cash: ${Number(state.cash_pct ?? 0).toFixed(1)}% (target ${TARGET_ALLOCATION.cash}%)

Context: ${body.context ?? "General allocation"}

Recommend how to allocate $${capitalToAllocate.toLocaleString()} across the three verticals. Be specific about amounts and prioritization. Consider which vertical is most underweight and has best risk-adjusted return potential right now.`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Allocate AI failed: ${resp.status}`);
  const aiData = await resp.json();
  const recommendation = aiData?.content?.[0]?.text ?? "Recommendation unavailable.";

  return new Response(JSON.stringify({ recommendation, capital_usd: capitalToAllocate, current_allocation: state }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Expense audit ────────────────────────────────────────────────────────────
async function handleExpenseAudit(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

  const [bizLedgerRes, reLedgerRes] = await Promise.all([
    fetch(`${supabaseUrl}/rest/v1/business_ledger?user_id=eq.${uid}&created_at=gte.${monthStart}&entry_type=eq.expense&select=category,description,amount_usd,recurring`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/property_ledger?user_id=eq.${uid}&created_at=gte.${monthStart}&entry_type=neq.rent&select=property_id,entry_type,amount_usd`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
  ]);

  const bizExpenses = bizLedgerRes.ok ? await bizLedgerRes.json() as Array<{ category: string; description: string; amount_usd: number; recurring: boolean }> : [];
  const reExpenses = reLedgerRes.ok ? await reLedgerRes.json() as Array<{ entry_type: string; amount_usd: number }> : [];

  const bizTotal = bizExpenses.reduce((s, e) => s + Number(e.amount_usd), 0);
  const reTotal = reExpenses.reduce((s, e) => s + Number(e.amount_usd), 0);
  const totalExpenses = bizTotal + reTotal;

  const expensesByCategory = bizExpenses.reduce((acc, e) => {
    const cat = e.category ?? "uncategorized";
    acc[cat] = (acc[cat] ?? 0) + Number(e.amount_usd);
    return acc;
  }, {} as Record<string, number>);

  const resp = await callAnthropic({
    model: ATLAS_MODEL(),
    max_tokens: 1000,
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Audit expenses for this month.

BUSINESS EXPENSES (total $${bizTotal.toFixed(0)}):
By category: ${Object.entries(expensesByCategory).map(([k, v]) => `${k}: $${v.toFixed(0)}`).join(", ") || "None"}
Top items: ${bizExpenses.slice(0, 5).map(e => `${e.description} $${e.amount_usd}${e.recurring ? " (recurring)" : ""}`).join(", ") || "None"}

REAL ESTATE EXPENSES (total $${reTotal.toFixed(0)}):
By type: ${reExpenses.slice(0, 5).map(e => `${e.entry_type} $${e.amount_usd}`).join(", ") || "None"}

TOTAL EXPENSES: $${totalExpenses.toFixed(0)} this month

Identify:
1. Expenses that look anomalous or should be questioned
2. Recurring expenses worth renegotiating
3. Categories that are running high vs expected
4. Specific cuts that would improve monthly net by the most

Be specific about dollar amounts.`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Expense audit AI failed: ${resp.status}`);
  const aiData = await resp.json();
  const audit = aiData?.content?.[0]?.text ?? "Audit unavailable.";

  return new Response(JSON.stringify({ audit, total_expenses: totalExpenses, biz_expenses: bizTotal, re_expenses: reTotal, by_category: expensesByCategory }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Income velocity ──────────────────────────────────────────────────────────
async function handleIncomeVelocity(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const today = new Date().toISOString().split("T")[0];
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split("T")[0];

  const [todayTradesRes, mtdBizRes, mtdReRes] = await Promise.all([
    fetch(`${supabaseUrl}/rest/v1/trade_ledger?user_id=eq.${uid}&status=eq.closed&closed_at=gte.${today}&select=pnl_usd`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/business_ledger?user_id=eq.${uid}&created_at=gte.${monthStart}&entry_type=eq.revenue&status=eq.paid&select=amount_usd`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/property_ledger?user_id=eq.${uid}&created_at=gte.${monthStart}&entry_type=eq.rent&status=eq.paid&select=amount_usd`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
  ]);

  const todayTrades = todayTradesRes.ok ? await todayTradesRes.json() as Array<{ pnl_usd: number | null }> : [];
  const mtdBiz = mtdBizRes.ok ? await mtdBizRes.json() as Array<{ amount_usd: number }> : [];
  const mtdRe = mtdReRes.ok ? await mtdReRes.json() as Array<{ amount_usd: number }> : [];

  const tradingPnlToday = todayTrades.reduce((s, t) => s + Number(t.pnl_usd ?? 0), 0);
  const bizRevenueMtd = mtdBiz.reduce((s, e) => s + Number(e.amount_usd), 0);
  const reRentMtd = mtdRe.reduce((s, e) => s + Number(e.amount_usd), 0);

  const nowDate = new Date();
  const dayOfMonth = nowDate.getDate();
  const daysInMonth = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 0).getDate();
  const dailyBizAvg = bizRevenueMtd / dayOfMonth;
  const dailyReAvg = reRentMtd / dayOfMonth;
  const realisedTotal = tradingPnlToday + (bizRevenueMtd / daysInMonth) + (reRentMtd / daysInMonth);

  const gap = DAILY_INCOME_TARGET - realisedTotal;
  const pctToTarget = (realisedTotal / DAILY_INCOME_TARGET * 100);
  const now = new Date();
  const marketCloseHour = 17;
  const tradingHoursLeft = Math.max(0, marketCloseHour - now.getUTCHours() - 5);
  const rateNeededPerHour = tradingHoursLeft > 0 ? Math.max(0, gap) / tradingHoursLeft : 0;

  let velocityStatus: string;
  if (realisedTotal >= DAILY_INCOME_TARGET) velocityStatus = "ahead";
  else if (pctToTarget >= 75) velocityStatus = "on_track";
  else if (pctToTarget >= 40) velocityStatus = "behind";
  else velocityStatus = "critical";

  return new Response(JSON.stringify({
    realised_total: parseFloat(realisedTotal.toFixed(2)),
    daily_target: DAILY_INCOME_TARGET,
    gap: parseFloat(gap.toFixed(2)),
    pct_to_target: parseFloat(pctToTarget.toFixed(1)),
    velocity_status: velocityStatus,
    trading_hours_left: tradingHoursLeft,
    rate_needed_per_hour: parseFloat(rateNeededPerHour.toFixed(2)),
    breakdown: {
      trading_realised_pnl: parseFloat(tradingPnlToday.toFixed(2)),
      business_revenue: parseFloat(dailyBizAvg.toFixed(2)),
      re_rent: parseFloat(dailyReAvg.toFixed(2)),
    },
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Self-funding status ───────────────────────────────────────────────────────
async function handleSelfFundingStatus(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

  const [tradingPnlRes, bizRes, reRes, expensesRes] = await Promise.all([
    fetch(`${supabaseUrl}/rest/v1/trade_ledger?user_id=eq.${uid}&status=eq.closed&closed_at=gte.${monthStart}&select=pnl_usd`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/business_ledger?user_id=eq.${uid}&created_at=gte.${monthStart}&entry_type=eq.revenue&status=eq.paid&select=amount_usd`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/property_ledger?user_id=eq.${uid}&created_at=gte.${monthStart}&entry_type=eq.rent&status=eq.paid&select=amount_usd`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/business_ledger?user_id=eq.${uid}&created_at=gte.${monthStart}&entry_type=eq.expense&select=amount_usd`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
  ]);

  const tradingPnl = tradingPnlRes.ok ? (await tradingPnlRes.json() as Array<{ pnl_usd: number | null }>).reduce((s, t) => s + Number(t.pnl_usd ?? 0), 0) : 0;
  const bizRevenue = bizRes.ok ? (await bizRes.json() as Array<{ amount_usd: number }>).reduce((s, e) => s + Number(e.amount_usd), 0) : 0;
  const reRent = reRes.ok ? (await reRes.json() as Array<{ amount_usd: number }>).reduce((s, e) => s + Number(e.amount_usd), 0) : 0;
  const expenses = expensesRes.ok ? (await expensesRes.json() as Array<{ amount_usd: number }>).reduce((s, e) => s + Number(e.amount_usd), 0) : 0;

  const totalIncome = tradingPnl + bizRevenue + reRent;
  const netPosition = totalIncome - expenses;
  const isSelfFunding = netPosition >= 0;
  const coverageRatio = expenses > 0 ? totalIncome / expenses : 1;

  return new Response(JSON.stringify({
    is_self_funding: isSelfFunding,
    total_income_mtd: parseFloat(totalIncome.toFixed(2)),
    total_expenses_mtd: parseFloat(expenses.toFixed(2)),
    net_position_mtd: parseFloat(netPosition.toFixed(2)),
    coverage_ratio: parseFloat(coverageRatio.toFixed(3)),
    breakdown: {
      trading_pnl: parseFloat(tradingPnl.toFixed(2)),
      business_revenue: parseFloat(bizRevenue.toFixed(2)),
      re_rent: parseFloat(reRent.toFixed(2)),
    },
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("ANTHROPIC_API_KEY");

    const body: Record<string, unknown> = await req.json().catch(() => ({}));
    const action = (body.action as string) ?? "balance_sheet";

    let userId = "system";
    try {
      userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    } catch {
      const authHeader = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (authHeader === SERVICE_KEY) {
        userId = (body.user_id as string) ?? "system";
      } else if (body.user_id) {
        userId = body.user_id as string;
      } else {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (userId === "system") {
      const resolved = await resolveUserIds(SUPABASE_URL, SERVICE_KEY, "system");
      if (resolved.length > 0) userId = resolved[0];
    }

    switch (action) {
      case "sync":               return await handleSync(body, SUPABASE_URL, SERVICE_KEY, userId);
      case "balance_sheet":      return await handleBalanceSheet(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "allocate":           return await handleAllocate(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "expense_audit":      return await handleExpenseAudit(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "income_velocity":    return await handleIncomeVelocity(body, SUPABASE_URL, SERVICE_KEY, userId);
      case "allocation_check":   return await handleAllocationCheck(body, SUPABASE_URL, SERVICE_KEY, userId);
      case "self_funding_status": return await handleSelfFundingStatus(body, SUPABASE_URL, SERVICE_KEY, userId);
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
    console.error("[atlas-portfolio] Error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
