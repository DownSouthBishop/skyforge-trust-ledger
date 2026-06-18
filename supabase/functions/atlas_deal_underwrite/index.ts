// Atlas Deal Underwrite — deep underwriting on a specific property pipeline deal
// Phase 3B: called manually or when stage advances from scanning→analyzing

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv } from "../_shared/gateway.ts";

const ATLAS_MODEL = () => modelEnv("ATLAS_MODEL", "openai/gpt-4o");

interface PropertyDeal {
  id: string;
  address: string;
  city: string;
  state: string;
  property_type: string;
  list_price: number | null;
  purchase_price: number | null;
  gross_rent_monthly: number | null;
  vacancy_pct: number | null;
  operating_expense_pct: number | null;
  down_payment_pct: number | null;
  loan_rate: number | null;
  loan_term_years: number | null;
  notes: string | null;
}

function calcMonthlyMortgage(principal: number, annualRate: number, termYears: number): number {
  if (annualRate === 0) return principal / (termYears * 12);
  const monthlyRate = annualRate / 100 / 12;
  const numPayments = termYears * 12;
  return principal * (monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = (Deno.env.get("GOOGLE_AI_KEY") ?? "");
    const RENTCAST_KEY = Deno.env.get("RENTCAST_API_KEY");

    const { user_id, deal_id } = await req.json();
    if (!user_id || !deal_id) {
      return new Response(JSON.stringify({ error: "user_id and deal_id required" }), { status: 400, headers: corsHeaders });
    }

    const baseHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    // Fetch the deal
    const dealRes = await fetch(
      `${SUPABASE_URL}/rest/v1/property_pipeline?id=eq.${deal_id}&user_id=eq.${user_id}&select=*`,
      { headers: baseHeaders },
    );
    if (!dealRes.ok) throw new Error(`Failed to fetch deal: ${dealRes.status}`);
    const deals: PropertyDeal[] = await dealRes.json();
    if (deals.length === 0) {
      return new Response(JSON.stringify({ error: "Deal not found" }), { status: 404, headers: corsHeaders });
    }
    const deal = deals[0];

    // Use list_price as purchase_price if not set
    const purchasePrice   = Number(deal.purchase_price ?? deal.list_price ?? 0);
    const grossRent       = Number(deal.gross_rent_monthly ?? 0);
    const vacancyPct      = Number(deal.vacancy_pct ?? 8) / 100;
    const opExpPct        = Number(deal.operating_expense_pct ?? 40) / 100;
    const downPayPct      = Number(deal.down_payment_pct ?? 20) / 100;
    const loanRate        = Number(deal.loan_rate ?? 7.0);
    const loanTermYears   = Number(deal.loan_term_years ?? 30);

    const downPayment     = purchasePrice * downPayPct;
    const loanAmount      = purchasePrice - downPayment;

    // Full underwriting model
    const effectiveGrossIncome  = grossRent * 12 * (1 - vacancyPct);
    const noi                   = effectiveGrossIncome * (1 - opExpPct);
    const capRate               = purchasePrice > 0 ? (noi / purchasePrice) * 100 : 0;
    const monthlyMortgage       = loanAmount > 0 ? calcMonthlyMortgage(loanAmount, loanRate, loanTermYears) : 0;
    const annualDebtService     = monthlyMortgage * 12;
    const annualCashFlow        = noi - annualDebtService;
    const cashOnCash            = downPayment > 0 ? (annualCashFlow / downPayment) * 100 : 0;
    const dscr                  = annualDebtService > 0 ? noi / annualDebtService : 0;

    // 5-Year IRR estimate (3% appreciation, exit after 5 years)
    const annualAppreciation    = 0.03;
    const exitValue             = purchasePrice * Math.pow(1 + annualAppreciation, 5);
    const remainingBalance      = loanAmount * 0.92; // approximate
    const totalCashFlow5yr      = annualCashFlow * 5;
    const equity5yr             = exitValue - remainingBalance;
    const totalReturn           = totalCashFlow5yr + (equity5yr - downPayment);
    const irr5yr                = downPayment > 0 ? (Math.pow(1 + totalReturn / downPayment, 0.2) - 1) * 100 : 0;

    // Fetch additional Rentcast data if available
    let marketData = "";
    if (RENTCAST_KEY && deal.address) {
      try {
        const rentRes = await fetch(
          `https://api.rentcast.io/v1/avm/rent/long-term?address=${encodeURIComponent(deal.address)}`,
          { headers: { "X-Api-Key": RENTCAST_KEY } },
        );
        if (rentRes.ok) {
          const rentData = await rentRes.json() as { rent?: number; rentRangeLow?: number; rentRangeHigh?: number };
          marketData = `\nRentcast Market Rent: $${rentData.rent ?? grossRent}/mo (range: $${rentData.rentRangeLow ?? "N/A"} – $${rentData.rentRangeHigh ?? "N/A"})`;
        }
      } catch { /* skip */ }
    }

    const prompt = `You are Atlas. Generate a structured real estate deal thesis.

PROPERTY:
Address: ${deal.address}, ${deal.city}, ${deal.state}
Type: ${deal.property_type}
Purchase Price: $${purchasePrice.toLocaleString()}
Down Payment: ${(downPayPct * 100).toFixed(0)}% ($${downPayment.toLocaleString()})
Loan: $${loanAmount.toLocaleString()} @ ${loanRate}% / ${loanTermYears}yr | Monthly: $${monthlyMortgage.toFixed(0)}
Gross Rent: $${grossRent}/mo | Vacancy: ${(vacancyPct * 100).toFixed(0)}% | OpEx: ${(opExpPct * 100).toFixed(0)}%
${marketData}

UNDERWRITING MODEL:
NOI: $${noi.toFixed(0)}/yr
Cap Rate: ${capRate.toFixed(2)}%
Annual Debt Service: $${annualDebtService.toFixed(0)}
Annual Cash Flow: $${annualCashFlow.toFixed(0)}
Cash-on-Cash: ${cashOnCash.toFixed(2)}%
DSCR: ${dscr.toFixed(2)}
5-Year IRR (est.): ${irr5yr.toFixed(1)}%

OPERATOR NOTES: ${deal.notes ?? "none"}

Sections:
1. Deal Overview — property, market, why it matters
2. Bull Case — the investment thesis and upside scenario
3. Bear Case — what kills this deal
4. Key Numbers — cap rate, CoC, DSCR, 5yr IRR
5. Risk Parameters — what vacancy rate / expense ratio breaks the deal
6. Verdict — Buy / Pass / Negotiate, with one-sentence rationale

Be direct. State the thesis like you've already done the analysis.`;

    const aiResp = await callGatewayWithRetry(
      { model: ATLAS_MODEL(), messages: [{ role: "user", content: prompt }], max_tokens: 2000 },
      API_KEY,
    );
    if (!aiResp.ok) throw new Error(`AI call failed: ${aiResp.status}`);

    const aiData = await aiResp.json();
    const thesis: string = aiData.choices?.[0]?.message?.content ?? "Underwriting failed.";

    // Save thesis to Vault
    await fetch(`${SUPABASE_URL}/rest/v1/research_notes`, {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id,
        title: `Deal Thesis — ${deal.address}`,
        content: thesis,
        note_type: "thesis",
        synced_to_obsidian: false,
      }),
    });

    // Update pipeline record with calculated metrics
    await fetch(`${SUPABASE_URL}/rest/v1/property_pipeline?id=eq.${deal_id}`, {
      method: "PATCH",
      headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        purchase_price: purchasePrice,
        cap_rate: parseFloat(capRate.toFixed(2)),
        cash_on_cash_return: parseFloat(cashOnCash.toFixed(2)),
        irr_5yr: parseFloat(irr5yr.toFixed(2)),
        thesis: thesis.slice(0, 500),
        stage: "analyzing",
        updated_at: new Date().toISOString(),
      }),
    });

    return new Response(JSON.stringify({
      status: "ok",
      underwriting: { cap_rate: capRate, cash_on_cash: cashOnCash, dscr, irr_5yr: irr5yr, noi, annual_cash_flow: annualCashFlow },
      thesis_saved: true,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[atlas_deal_underwrite] Error:", msg);
    try {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
      const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (SUPABASE_URL && SERVICE_KEY) {
        const body = await req.clone().json().catch(() => ({}));
        await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: (body as { user_id?: string }).user_id ?? "system", signal_type: "function_error", message: `atlas_deal_underwrite error: ${msg}` }),
        });
      }
    } catch { /* ignore */ }
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
