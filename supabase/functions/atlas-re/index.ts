// atlas-re — all real estate operations
// Consolidates: atlas_re_brief, atlas_deal_scan, atlas_deal_underwrite,
//               atlas_lease_monitor, atlas_re_risk_check
//
// Actions: re_brief, deal_scan, underwrite, lease_monitor, risk_check

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

// ─── RE Brief ─────────────────────────────────────────────────────────────────
async function handleReBrief(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
  const monthEnd   = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const monthLabel = new Date(monthStart).toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const [portfolioRes, ledgerRes, pipelineRes, leasesRes] = await Promise.all([
    fetch(`${supabaseUrl}/rest/v1/property_portfolio?user_id=eq.${uid}&status=eq.active&select=id,address,city,state,property_type,current_value,mortgage_balance,mortgage_payment_monthly,gross_rent_monthly`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/property_ledger?user_id=eq.${uid}&created_at=gte.${monthStart}&created_at=lt.${monthEnd}&select=property_id,entry_type,amount_usd,status`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/property_pipeline?user_id=eq.${uid}&stage=in.(analyzing,offer_pending)&select=address,city,state,stage,cap_rate,cash_on_cash_return&limit=10`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${supabaseUrl}/rest/v1/lease_tracker?user_id=eq.${uid}&status=eq.active&select=property_id,tenant_name,lease_end,monthly_rent,renewal_offered`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
  ]);

  type Property = { id: string; address: string; city: string; state: string; property_type: string; current_value: number | null; mortgage_balance: number | null; mortgage_payment_monthly: number | null; gross_rent_monthly: number | null };
  type LedgerEntry = { property_id: string; entry_type: string; amount_usd: number; status: string };

  const portfolio: Property[] = portfolioRes.ok ? await portfolioRes.json() : [];
  const ledger: LedgerEntry[] = ledgerRes.ok ? await ledgerRes.json() : [];
  const pipeline = pipelineRes.ok ? await pipelineRes.json() as Array<{ address: string; stage: string; cap_rate: number | null; cash_on_cash_return: number | null }> : [];
  const leases = leasesRes.ok ? await leasesRes.json() as Array<{ tenant_name: string; lease_end: string; renewal_offered: boolean }> : [];

  const totalPortfolioValue = portfolio.reduce((s, p) => s + Number(p.current_value ?? 0), 0);
  const totalMortgageBalance = portfolio.reduce((s, p) => s + Number(p.mortgage_balance ?? 0), 0);
  const totalEquity = totalPortfolioValue - totalMortgageBalance;
  const avgLTV = totalPortfolioValue > 0 ? (totalMortgageBalance / totalPortfolioValue * 100).toFixed(0) : "N/A";
  const monthlyRent = ledger.filter(e => e.entry_type === "rent" && e.status === "paid").reduce((s, e) => s + Number(e.amount_usd), 0);
  const monthlyMortgages = portfolio.reduce((s, p) => s + Number(p.mortgage_payment_monthly ?? 0), 0);
  const monthlyExpenses = ledger.filter(e => e.entry_type !== "rent").reduce((s, e) => s + Number(e.amount_usd), 0);
  const netCashFlow = monthlyRent - monthlyMortgages - monthlyExpenses;
  const now90 = new Date(now.getTime() + 90 * 86400000).toISOString().split("T")[0];
  const expiringLeases = leases.filter(l => l.lease_end <= now90);

  const perPropertyStatus = portfolio.map(p => {
    const propRent = ledger.filter(e => e.property_id === p.id && e.entry_type === "rent" && e.status === "paid").reduce((s, e) => s + Number(e.amount_usd), 0);
    const propMaint = ledger.filter(e => e.property_id === p.id && e.entry_type === "maintenance").reduce((s, e) => s + Number(e.amount_usd), 0);
    return `${p.address} (${p.city}, ${p.state}): Rent $${propRent.toFixed(0)} | Maintenance $${propMaint.toFixed(0)} | ${propRent > 0 ? "Paid" : "No payment logged"}`;
  }).join("\n");

  const prompt = `Generate the monthly real estate portfolio brief.

PORTFOLIO SUMMARY:
Properties: ${portfolio.length} active | Total Value: $${totalPortfolioValue.toLocaleString()} | Equity: $${totalEquity.toLocaleString()} | LTV: ${avgLTV}%

CASH FLOW — ${monthLabel}:
Rent Collected: $${monthlyRent.toFixed(0)} | Mortgage Payments: $${monthlyMortgages.toFixed(0)} | Total Expenses: $${monthlyExpenses.toFixed(0)} | Net Cash Flow: $${netCashFlow.toFixed(0)}

PER-PROPERTY STATUS:
${perPropertyStatus || "No properties in portfolio."}

LEASES EXPIRING WITHIN 90 DAYS (${expiringLeases.length}):
${expiringLeases.map(l => `${l.tenant_name}: ${l.lease_end} | Renewal: ${l.renewal_offered ? "Yes" : "No"}`).join("\n") || "None."}

ACQUISITION PIPELINE (${pipeline.length} active):
${pipeline.map(d => `${d.address} [${d.stage}] Cap: ${d.cap_rate ?? "?"}% CoC: ${d.cash_on_cash_return ?? "?"}%`).join("\n") || "Empty."}

Sections: 1) Cash Flow 2) Per-Property Status 3) Leases Expiring 4) Acquisition Pipeline 5) Capital Position
Verdict: one sentence on portfolio health.`;

  const resp = await callAnthropic({
    model: ATLAS_MODEL(), max_tokens: 2000,
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  }, apiKey);

  if (!resp.ok) throw new Error(`RE brief AI failed: ${resp.status}`);
  const data = await resp.json();
  const brief = data?.content?.[0]?.text ?? "Brief unavailable.";

  await fetch(`${supabaseUrl}/rest/v1/research_notes`, {
    method: "POST",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({ user_id: uid, title: `Real Estate Brief — ${monthLabel}`, content: brief, note_type: "research", synced_to_obsidian: false }),
  }).catch(() => {});

  // Store to atlas_re_portfolio summary
  await fetch(`${supabaseUrl}/rest/v1/atlas_re_portfolio`, {
    method: "POST",
    headers: { ...dbHeaders(serviceKey), Prefer: "return=minimal,resolution=merge-duplicates" },
    body: JSON.stringify({ user_id: uid, total_value: totalPortfolioValue, total_equity: totalEquity, net_cash_flow_monthly: netCashFlow, property_count: portfolio.length, updated_at: new Date().toISOString() }),
  }).catch(() => {});

  return new Response(JSON.stringify({ status: "ok", month: monthLabel, properties: portfolio.length, net_cash_flow: netCashFlow, total_equity: totalEquity, brief }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Deal scan ────────────────────────────────────────────────────────────────
async function handleDealScan(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const market = (body.market as string) ?? "national";
  const propertyType = (body.property_type as string) ?? "residential";
  const maxPrice = Number(body.max_price ?? 500000);

  // Try Rentcast API first
  const rentcastKey = Deno.env.get("RENTCAST_API_KEY");
  let listingsText = "Live listings unavailable — using AI to identify opportunities based on market conditions.";

  if (rentcastKey && body.zip_code) {
    try {
      const r = await fetch(`https://api.rentcast.io/v1/listings/sale?zipCode=${body.zip_code}&propertyType=${propertyType}&limit=10`, {
        headers: { "X-Api-Key": rentcastKey, "Accept": "application/json" },
      });
      if (r.ok) {
        const listings = await r.json() as Array<{ address: string; price: number; bedrooms: number; squareFootage: number }>;
        listingsText = listings.slice(0, 5).map(l =>
          `${l.address}: $${l.price?.toLocaleString()} | ${l.bedrooms}bd | ${l.squareFootage}sqft`
        ).join("\n");
      }
    } catch { /* use AI fallback */ }
  }

  const resp = await callAnthropic({
    model: ATLAS_MODEL(),
    max_tokens: 1500,
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Scan for real estate deal opportunities.

Market: ${market} | Property type: ${propertyType} | Max price: $${maxPrice.toLocaleString()}

Available listings / market intelligence:
${listingsText}

Identify 5-7 opportunities with strong investment potential. For each:
- Address/location (or market area if no specifics)
- Estimated cap rate
- Estimated cash-on-cash return
- Key investment rationale
- Risk factors

Return JSON: {opportunities: [{address, market, property_type, estimated_price, estimated_cap_rate, estimated_coc, rationale, risk_factors, conviction: "high"|"medium"|"low"}], market_summary: string}`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Deal scan AI failed: ${resp.status}`);
  const data = await resp.json();
  const content = data?.content?.[0]?.text ?? "{}";
  let result: { opportunities?: unknown[]; market_summary?: string } = {};
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1) result = JSON.parse(content.slice(start, end + 1));
  } catch { result = { market_summary: content }; }

  // Insert top opportunities as ORANGE decisions
  for (const opp of ((result.opportunities ?? []) as Array<{ address: string; market: string; estimated_cap_rate: number; conviction: string; rationale: string }>).slice(0, 3)) {
    if (opp.conviction === "high") {
      await insertDecision(supabaseUrl, serviceKey, uid, "ORANGE", "re_deal_opportunity",
        `Deal opportunity: ${opp.address ?? opp.market} | Cap: ${opp.estimated_cap_rate ?? "?"}% — ${opp.rationale}`, opp);

      // Also insert into atlas_re_deals
      await fetch(`${supabaseUrl}/rest/v1/atlas_re_deals`, {
        method: "POST",
        headers: dbHeaders(serviceKey),
        body: JSON.stringify({ user_id: uid, ...opp, status: "scouted", created_at: new Date().toISOString() }),
      }).catch(() => {});
    }
  }

  return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Underwrite ───────────────────────────────────────────────────────────────
async function handleUnderwrite(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const {
    address, purchase_price, gross_rent_monthly, vacancy_rate = 0.05,
    operating_expenses_monthly, mortgage_rate = 0.07, loan_to_value = 0.80,
    loan_term_years = 30, closing_costs_pct = 0.03, hold_years = 5,
    appreciation_rate = 0.03,
  } = body;

  if (!purchase_price || !gross_rent_monthly) {
    return new Response(JSON.stringify({ error: "purchase_price and gross_rent_monthly required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const pp = Number(purchase_price);
  const grm = Number(gross_rent_monthly);
  const vac = Number(vacancy_rate);
  const opex = Number(operating_expenses_monthly ?? grm * 0.35);
  const ltv = Number(loan_to_value);
  const rate = Number(mortgage_rate);
  const termYears = Number(loan_term_years);
  const closingCostsPct = Number(closing_costs_pct);
  const holdYears = Number(hold_years);
  const appRate = Number(appreciation_rate);

  // NOI
  const effectiveGrossRent = grm * (1 - vac) * 12;
  const annualOpex = opex * 12;
  const noi = effectiveGrossRent - annualOpex;
  const capRate = (noi / pp * 100);

  // Mortgage / Debt service
  const loanAmount = pp * ltv;
  const monthlyRate = rate / 12;
  const numPayments = termYears * 12;
  const monthlyMortgage = loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1);
  const annualDebtService = monthlyMortgage * 12;
  const dscr = noi / annualDebtService;

  // Cash-on-cash
  const downPayment = pp * (1 - ltv);
  const closingCosts = pp * closingCostsPct;
  const totalCashIn = downPayment + closingCosts;
  const annualCashFlow = noi - annualDebtService;
  const cocReturn = (annualCashFlow / totalCashIn * 100);

  // IRR (simplified using annual cash flows + terminal value)
  const cashFlows: number[] = [-totalCashIn];
  for (let y = 1; y <= holdYears; y++) {
    cashFlows.push(annualCashFlow);
  }
  // Terminal value = appreciated value minus remaining mortgage balance
  const exitValue = pp * Math.pow(1 + appRate, holdYears);
  let remainingLoan = loanAmount;
  for (let m = 0; m < holdYears * 12; m++) {
    const interest = remainingLoan * monthlyRate;
    const principal = monthlyMortgage - interest;
    remainingLoan -= principal;
  }
  cashFlows[holdYears] += exitValue - Math.max(remainingLoan, 0);

  // Newton's method for IRR
  let irr = 0.1;
  for (let iter = 0; iter < 100; iter++) {
    let npv = 0, dnpv = 0;
    for (let t = 0; t < cashFlows.length; t++) {
      npv += cashFlows[t] / Math.pow(1 + irr, t);
      dnpv -= t * cashFlows[t] / Math.pow(1 + irr, t + 1);
    }
    const newIrr = irr - npv / dnpv;
    if (Math.abs(newIrr - irr) < 0.0001) { irr = newIrr; break; }
    irr = newIrr;
  }

  const metrics = {
    noi: parseFloat(noi.toFixed(2)),
    cap_rate_pct: parseFloat(capRate.toFixed(2)),
    dscr: parseFloat(dscr.toFixed(3)),
    cash_on_cash_pct: parseFloat(cocReturn.toFixed(2)),
    irr_pct: parseFloat((irr * 100).toFixed(2)),
    monthly_cash_flow: parseFloat((annualCashFlow / 12).toFixed(2)),
    total_cash_in: parseFloat(totalCashIn.toFixed(2)),
    loan_amount: parseFloat(loanAmount.toFixed(2)),
    monthly_mortgage: parseFloat(monthlyMortgage.toFixed(2)),
  };

  // Generate memo via AI
  const resp = await callAnthropic({
    model: ATLAS_MODEL(),
    max_tokens: 1200,
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Generate an investment memo for this real estate deal.

PROPERTY: ${address ?? "Address not provided"}
PURCHASE PRICE: $${pp.toLocaleString()}

COMPUTED METRICS:
NOI: $${metrics.noi.toLocaleString()}/yr
Cap Rate: ${metrics.cap_rate_pct}%
DSCR: ${metrics.dscr}
Cash-on-Cash: ${metrics.cash_on_cash_pct}%
IRR (${holdYears}yr hold): ${metrics.irr_pct}%
Monthly Cash Flow: $${metrics.monthly_cash_flow.toFixed(0)}
Total Cash In: $${metrics.total_cash_in.toLocaleString()}

ASSUMPTIONS:
Vacancy: ${(vac * 100).toFixed(0)}% | OpEx: $${opex.toFixed(0)}/mo | Rate: ${(rate * 100).toFixed(1)}% | LTV: ${(ltv * 100).toFixed(0)}%

Assess: 1) Deal quality vs market benchmarks 2) Key risks 3) Upside scenarios 4) Go/No-Go verdict with one-sentence reason.`,
    }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Underwrite AI failed: ${resp.status}`);
  const aiData = await resp.json();
  const memo = aiData?.content?.[0]?.text ?? "Memo unavailable.";

  // GO if cap rate > 6%, DSCR > 1.2, CoC > 8%
  const verdict = (metrics.cap_rate_pct > 6 && metrics.dscr > 1.2 && metrics.cash_on_cash_pct > 8) ? "GO" : (metrics.dscr > 1.0 ? "CONDITIONAL" : "NO-GO");

  // Store deal
  await fetch(`${supabaseUrl}/rest/v1/atlas_re_deals`, {
    method: "POST",
    headers: dbHeaders(serviceKey),
    body: JSON.stringify({
      user_id: uid,
      address: address ?? "Unknown",
      purchase_price: pp,
      ...metrics,
      verdict,
      memo: memo.slice(0, 2000),
      status: "underwritten",
      created_at: new Date().toISOString(),
    }),
  }).catch(() => {});

  if (verdict === "GO") {
    await insertDecision(supabaseUrl, serviceKey, uid, "GREEN", "re_deal_underwritten",
      `GO: ${address ?? "Deal"} | Cap ${metrics.cap_rate_pct}% | CoC ${metrics.cash_on_cash_pct}% | IRR ${metrics.irr_pct}%`,
      { ...metrics, address, purchase_price: pp });
  } else if (verdict === "CONDITIONAL") {
    await insertDecision(supabaseUrl, serviceKey, uid, "YELLOW", "re_deal_underwritten",
      `CONDITIONAL: ${address ?? "Deal"} | Cap ${metrics.cap_rate_pct}% | CoC ${metrics.cash_on_cash_pct}%`,
      { ...metrics, address, purchase_price: pp });
  }

  return new Response(JSON.stringify({ metrics, verdict, memo, address: address ?? "Unknown" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Lease monitor ────────────────────────────────────────────────────────────
async function handleLeaseMonitor(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const leasesRes = await fetch(
    `${supabaseUrl}/rest/v1/lease_tracker?user_id=eq.${uid}&status=eq.active&select=id,property_id,tenant_name,lease_end,monthly_rent,renewal_offered&order=lease_end.asc`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const leases = leasesRes.ok ? await leasesRes.json() as Array<{ id: string; property_id: string; tenant_name: string; lease_end: string; monthly_rent: number; renewal_offered: boolean }> : [];

  const now = Date.now();
  const alerts: Array<{ tenant: string; days_remaining: number; color: string }> = [];

  for (const lease of leases) {
    const daysRemaining = Math.ceil((new Date(lease.lease_end).getTime() - now) / 86400000);
    if (daysRemaining <= 0) {
      await insertDecision(supabaseUrl, serviceKey, uid, "RED", "lease_expired",
        `EXPIRED lease: ${lease.tenant_name} (${Math.abs(daysRemaining)} days past end) — $${lease.monthly_rent}/mo at risk`,
        { lease_id: lease.id, tenant_name: lease.tenant_name, monthly_rent: lease.monthly_rent });
      alerts.push({ tenant: lease.tenant_name, days_remaining: daysRemaining, color: "RED" });
    } else if (daysRemaining <= 30) {
      await insertDecision(supabaseUrl, serviceKey, uid, "ORANGE", "lease_expiring_soon",
        `${lease.tenant_name}: ${daysRemaining} days remaining | Renewal offered: ${lease.renewal_offered ? "Yes" : "No"}`,
        { lease_id: lease.id, tenant_name: lease.tenant_name, days_remaining: daysRemaining, monthly_rent: lease.monthly_rent });
      alerts.push({ tenant: lease.tenant_name, days_remaining: daysRemaining, color: "ORANGE" });
    } else if (daysRemaining <= 90) {
      await insertDecision(supabaseUrl, serviceKey, uid, "YELLOW", "lease_expiring",
        `${lease.tenant_name}: ${daysRemaining} days to expiry | $${lease.monthly_rent}/mo`,
        { lease_id: lease.id, tenant_name: lease.tenant_name, days_remaining: daysRemaining });
      alerts.push({ tenant: lease.tenant_name, days_remaining: daysRemaining, color: "YELLOW" });
    }
  }

  return new Response(JSON.stringify({ alerts, leases_checked: leases.length, alerts_generated: alerts.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── RE risk check ────────────────────────────────────────────────────────────
async function handleReRiskCheck(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<Response> {
  const uid = (body.user_id as string) ?? userId;
  const { purchase_price, dscr, cap_rate, ltv, noi } = body;
  const violations: string[] = [];
  const warnings: string[] = [];

  if (purchase_price) {
    // Check against existing portfolio leverage
    const portfolioRes = await fetch(
      `${supabaseUrl}/rest/v1/property_portfolio?user_id=eq.${uid}&status=eq.active&select=current_value,mortgage_balance`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    const portfolio = portfolioRes.ok ? await portfolioRes.json() as Array<{ current_value: number | null; mortgage_balance: number | null }> : [];
    const totalPortfolioValue = portfolio.reduce((s, p) => s + Number(p.current_value ?? 0), 0);
    const dealConcentration = totalPortfolioValue > 0 ? Number(purchase_price) / (totalPortfolioValue + Number(purchase_price)) : 1;
    if (dealConcentration > 0.40) {
      warnings.push(`Deal would represent ${(dealConcentration * 100).toFixed(0)}% of portfolio (concentration risk)`);
    }
  }

  if (dscr !== undefined) {
    if (Number(dscr) < 1.0) violations.push(`DSCR ${dscr} < 1.0 — deal is cash flow negative`);
    else if (Number(dscr) < 1.15) warnings.push(`DSCR ${dscr} < 1.15 — thin coverage ratio`);
  }

  if (cap_rate !== undefined && Number(cap_rate) < 4) {
    warnings.push(`Cap rate ${cap_rate}% is below 4% — limited upside unless appreciation play`);
  }

  if (ltv !== undefined && Number(ltv) > 0.80) {
    violations.push(`LTV ${(Number(ltv) * 100).toFixed(0)}% exceeds 80% threshold`);
  }

  return new Response(JSON.stringify({
    go: violations.length === 0,
    violations,
    warnings,
    risk_summary: violations.length > 0 ? "BLOCKED" : warnings.length > 0 ? "CAUTION" : "CLEAR",
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
    const action = (body.action as string) ?? "re_brief";

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

    // Resolve user_id for cron/system calls
    if (userId === "system" || body.user_id === "system") {
      const resolved = await resolveUserIds(SUPABASE_URL, SERVICE_KEY, "system");
      if (resolved.length > 0) userId = resolved[0];
    }

    switch (action) {
      case "re_brief":       return await handleReBrief(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "deal_scan":      return await handleDealScan(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "underwrite":     return await handleUnderwrite(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "lease_monitor":  return await handleLeaseMonitor(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "risk_check":     return await handleReRiskCheck(body, SUPABASE_URL, SERVICE_KEY, userId);
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
    console.error("[atlas-re] Error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
