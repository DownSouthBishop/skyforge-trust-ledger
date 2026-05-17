// Atlas RE Brief — monthly real estate portfolio performance report
// Phase 3B: runs first of every month at 07:00 UTC

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv, resolveUserIds } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

const ATLAS_MODEL = () => modelEnv("ATLAS_MODEL", "openai/gpt-4o");

interface Property {
  id: string;
  address: string;
  city: string;
  state: string;
  property_type: string;
  current_value: number | null;
  mortgage_balance: number | null;
  mortgage_payment_monthly: number | null;
  gross_rent_monthly: number | null;
  status: string;
}

interface LedgerEntry {
  property_id: string;
  entry_type: string;
  amount_usd: number;
  status: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("LOVABLE_API_KEY");

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
    const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
    const monthEnd   = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthLabel = new Date(monthStart).toLocaleDateString("en-US", { month: "long", year: "numeric" });

    // Pull portfolio and ledger data
    const [portfolioRes, ledgerRes, pipelineRes, leasesRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/property_portfolio?user_id=eq.${user_id}&status=eq.active&select=id,address,city,state,property_type,current_value,mortgage_balance,mortgage_payment_monthly,gross_rent_monthly,status`, { headers: baseHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/property_ledger?user_id=eq.${user_id}&created_at=gte.${monthStart}&created_at=lt.${monthEnd}&select=property_id,entry_type,amount_usd,status`, { headers: baseHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/property_pipeline?user_id=eq.${user_id}&stage=in.(analyzing,offer_pending)&select=address,city,state,stage,cap_rate,cash_on_cash_return&limit=10`, { headers: baseHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/lease_tracker?user_id=eq.${user_id}&status=eq.active&select=property_id,tenant_name,lease_end,monthly_rent,renewal_offered`, { headers: baseHeaders }),
    ]);

    const portfolio: Property[] = portfolioRes.ok ? await portfolioRes.json() : [];
    const ledger: LedgerEntry[] = ledgerRes.ok ? await ledgerRes.json() : [];
    const pipeline = pipelineRes.ok ? await pipelineRes.json() : [];
    const leases = leasesRes.ok ? await leasesRes.json() : [];

    // Compute aggregate metrics
    const totalPortfolioValue = portfolio.reduce((s, p) => s + Number(p.current_value ?? 0), 0);
    const totalMortgageBalance = portfolio.reduce((s, p) => s + Number(p.mortgage_balance ?? 0), 0);
    const totalEquity = totalPortfolioValue - totalMortgageBalance;
    const avgLTV = totalPortfolioValue > 0 ? (totalMortgageBalance / totalPortfolioValue * 100).toFixed(0) : "N/A";

    const monthlyRent = ledger.filter(e => e.entry_type === "rent" && e.status === "paid").reduce((s, e) => s + Number(e.amount_usd), 0);
    const monthlyMortgages = portfolio.reduce((s, p) => s + Number(p.mortgage_payment_monthly ?? 0), 0);
    const monthlyMaintenance = ledger.filter(e => e.entry_type === "maintenance").reduce((s, e) => s + Number(e.amount_usd), 0);
    const monthlyExpenses = ledger.filter(e => !["rent"].includes(e.entry_type)).reduce((s, e) => s + Number(e.amount_usd), 0);
    const netCashFlow = monthlyRent - monthlyMortgages - monthlyExpenses;

    const now90daysOut = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const expiringLeases = (leases as Array<{ tenant_name: string; lease_end: string; renewal_offered: boolean }>).filter(l => l.lease_end <= now90daysOut);

    const perPropertyStatus = portfolio.map((p) => {
      const propRent = ledger.filter(e => e.property_id === p.id && e.entry_type === "rent" && e.status === "paid").reduce((s, e) => s + Number(e.amount_usd), 0);
      const propMaint = ledger.filter(e => e.property_id === p.id && e.entry_type === "maintenance").reduce((s, e) => s + Number(e.amount_usd), 0);
      return `${p.address} (${p.city}, ${p.state}): Rent collected $${propRent.toFixed(0)} | Maintenance $${propMaint.toFixed(0)} | ${propRent > 0 ? "✓ Paid" : "⚠ No payment logged"}`;
    }).join("\n");

    const prompt = `You are Atlas. Generate the monthly real estate portfolio brief.

PORTFOLIO SUMMARY:
Properties: ${portfolio.length} active
Total Value: $${totalPortfolioValue.toLocaleString()}
Mortgage Balance: $${totalMortgageBalance.toLocaleString()}
Total Equity: $${totalEquity.toLocaleString()}
Portfolio LTV: ${avgLTV}%

CASH FLOW — ${monthLabel}:
Rent Collected: $${monthlyRent.toFixed(0)}
Mortgage Payments: $${monthlyMortgages.toFixed(0)}
Total Expenses: $${monthlyExpenses.toFixed(0)}
Net Cash Flow: $${netCashFlow.toFixed(0)}
Maintenance Spend: $${monthlyMaintenance.toFixed(0)}

PER-PROPERTY STATUS:
${perPropertyStatus || "No properties in portfolio."}

LEASES EXPIRING WITHIN 90 DAYS (${expiringLeases.length}):
${expiringLeases.map(l => `${l.tenant_name}: ${l.lease_end} | Renewal offered: ${l.renewal_offered ? "Yes" : "No"}`).join("\n") || "None."}

ACQUISITION PIPELINE (${(pipeline as unknown[]).length} active):
${(pipeline as Array<{ address: string; stage: string; cap_rate: number | null; cash_on_cash_return: number | null }>).map(d => `${d.address} [${d.stage}] Cap: ${d.cap_rate ?? "?"}% CoC: ${d.cash_on_cash_return ?? "?"}%`).join("\n") || "Empty."}

Sections:
1. Portfolio Cash Flow — total NOI, total debt service, net cash flow this month
2. Per-Property Status — one line per property: rent collected Y/N, any issues
3. Leases Expiring — within 90 days, renewal status
4. Maintenance Watch — any unresolved or high-cost maintenance items
5. Acquisition Pipeline — deals in pipeline, deals worth advancing
6. Capital Position — estimated total equity across portfolio, LTV

Verdict: one sentence on portfolio health.`;

    const aiResp = await callGatewayWithRetry(
      { model: ATLAS_MODEL(), messages: [{ role: "user", content: prompt }], max_tokens: 2000 },
      API_KEY,
    );
    if (!aiResp.ok) throw new Error(`AI call failed: ${aiResp.status}`);

    const aiData = await aiResp.json();
    const brief: string = aiData.choices?.[0]?.message?.content ?? "Brief generation failed.";

    await fetch(`${SUPABASE_URL}/rest/v1/research_notes`, {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id,
        title: `Real Estate Brief — ${monthLabel}`,
        content: brief,
        note_type: "research",
        synced_to_obsidian: false,
      }),
    });

    await sendTelegramAlert(`*RE BRIEF — ${monthLabel}*\n${portfolio.length} properties | Equity: $${totalEquity.toLocaleString()} | Net CF: $${netCashFlow.toFixed(0)}/mo\nCheck Vault for full report.`);

    return new Response(JSON.stringify({
      status: "ok",
      month: monthLabel,
      properties: portfolio.length,
      net_cash_flow: netCashFlow,
      total_equity: totalEquity,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[atlas_re_brief] Error:", msg);
    try {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
      const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (SUPABASE_URL && SERVICE_KEY) {
        const body = await req.clone().json().catch(() => ({}));
        await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: (body as { user_id?: string }).user_id ?? "system", signal_type: "function_error", message: `atlas_re_brief error: ${msg}` }),
        });
      }
    } catch { /* ignore */ }
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
