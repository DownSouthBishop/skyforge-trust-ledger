// Atlas Business Risk Check — pre-action gate for all business vertical actions
// Phase 2B: mirrors atlas_risk_check structure for business domain

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

const BUSINESS_RISK_RULES = {
  auto_send_outreach: false,        // outreach always requires approval
  auto_pay_invoice_max: 200,        // auto-pay invoices up to $200
  expense_commitment_max: 500,      // recurring expense above $500/month requires approval
  burn_rate_warning_pct: 0.70,      // flag if burn exceeds 70% of trailing 3-month avg revenue
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    const { user_id, action_type, amount, recurring_monthly } = await req.json();
    if (!user_id || !action_type) {
      return new Response(JSON.stringify({ error: "user_id and action_type required" }), { status: 400, headers: corsHeaders });
    }

    const violations: string[] = [];
    const warnings: string[] = [];
    const baseHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    // Rule 1: outreach always requires approval
    if (action_type === "outreach") {
      return new Response(JSON.stringify({
        go: true,
        requires_approval: true,
        violations: [],
        warnings: ["Outreach always requires human approval before sending."],
        rules: BUSINESS_RISK_RULES,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Rule 2: invoice auto-pay threshold
    if (action_type === "invoice_payment" && Number(amount) > BUSINESS_RISK_RULES.auto_pay_invoice_max) {
      violations.push(`Invoice payment $${Number(amount).toFixed(0)} exceeds auto-pay limit of $${BUSINESS_RISK_RULES.auto_pay_invoice_max}. Approval required.`);
    }

    // Rule 3: recurring expense commitment
    if (action_type === "expense_commitment" && Number(recurring_monthly ?? amount) > BUSINESS_RISK_RULES.expense_commitment_max) {
      violations.push(`Recurring expense $${Number(recurring_monthly ?? amount).toFixed(0)}/month exceeds $${BUSINESS_RISK_RULES.expense_commitment_max} limit. Approval required.`);
    }

    // Rule 4: burn rate check — compare against trailing 3-month avg revenue
    try {
      const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const [revenueRes, expenseRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/business_ledger?user_id=eq.${user_id}&entry_type=eq.revenue&status=eq.paid&created_at=gte.${threeMonthsAgo}&select=amount_usd`, { headers: baseHeaders }),
        fetch(`${SUPABASE_URL}/rest/v1/business_ledger?user_id=eq.${user_id}&entry_type=eq.expense&created_at=gte.${threeMonthsAgo}&select=amount_usd`, { headers: baseHeaders }),
      ]);

      const revenues: Array<{ amount_usd: number }> = revenueRes.ok ? await revenueRes.json() : [];
      const expenseEntries: Array<{ amount_usd: number }> = expenseRes.ok ? await expenseRes.json() : [];

      const avgMonthlyRevenue = revenues.reduce((s, r) => s + Number(r.amount_usd), 0) / 3;
      const avgMonthlyExpense = expenseEntries.reduce((s, e) => s + Number(e.amount_usd), 0) / 3;

      if (avgMonthlyRevenue > 0 && avgMonthlyExpense / avgMonthlyRevenue > BUSINESS_RISK_RULES.burn_rate_warning_pct) {
        const burnPct = ((avgMonthlyExpense / avgMonthlyRevenue) * 100).toFixed(0);
        warnings.push(`Burn rate ${burnPct}% of trailing 3-month average revenue ($${avgMonthlyExpense.toFixed(0)}/mo expenses on $${avgMonthlyRevenue.toFixed(0)}/mo revenue).`);
        await sendTelegramAlert(`*BUSINESS RISK*\nBurn rate at ${burnPct}% — approaching unsustainable territory.`);
      }
    } catch {
      console.warn("[atlas_business_risk_check] Could not compute burn rate.");
    }

    const go = violations.length === 0;
    const requiresApproval = !go || action_type === "outreach" ||
      (action_type === "invoice_payment" && Number(amount) > BUSINESS_RISK_RULES.auto_pay_invoice_max);

    return new Response(JSON.stringify({
      go,
      requires_approval: requiresApproval,
      violations,
      warnings,
      rules: BUSINESS_RISK_RULES,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
