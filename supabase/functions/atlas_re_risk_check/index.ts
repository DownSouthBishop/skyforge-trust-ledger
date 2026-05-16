// Atlas RE Risk Check — pre-offer gate for real estate actions
// Phase 3B: every offer must pass through here — no auto-execute on RE, ever

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

const RE_RISK_RULES = {
  min_dscr: 1.2,
  max_re_allocation_pct: 40,
  max_mortgage_to_rent_ratio: 0.70,
  max_down_payment_of_liquid_pct: 35,
  default_min_cap_rate: 6,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    const { user_id, deal_id, down_payment, purchase_price, dscr, cap_rate, monthly_mortgage, gross_rent_monthly } = await req.json();
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });
    }

    const violations: string[] = [];
    const warnings: string[] = [];
    const baseHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    // Rule: every offer always requires human approval
    const requiresApproval = true;

    // Rule: DSCR must be >= 1.2
    if (dscr != null && Number(dscr) < RE_RISK_RULES.min_dscr) {
      violations.push(`DSCR ${Number(dscr).toFixed(2)} below minimum ${RE_RISK_RULES.min_dscr}. Deal does not service debt adequately.`);
    }

    // Rule: cap rate must meet minimum
    let minCapRate = RE_RISK_RULES.default_min_cap_rate;
    try {
      const critRes = await fetch(
        `${SUPABASE_URL}/rest/v1/atlas_user_preferences?user_id=eq.${user_id}&category=eq.trading_style&key=eq.re_acquisition_criteria&select=value&limit=1`,
        { headers: baseHeaders },
      );
      if (critRes.ok) {
        const rows: Array<{ value: string }> = await critRes.json();
        if (rows.length > 0) {
          const crit = JSON.parse(rows[0].value) as { min_cap_rate?: number };
          minCapRate = crit.min_cap_rate ?? RE_RISK_RULES.default_min_cap_rate;
        }
      }
    } catch { /* use default */ }

    if (cap_rate != null && Number(cap_rate) < minCapRate) {
      violations.push(`Cap rate ${Number(cap_rate).toFixed(1)}% below minimum ${minCapRate}% from acquisition criteria.`);
    }

    // Rule: mortgage payment must not exceed 70% of gross rent
    if (monthly_mortgage != null && gross_rent_monthly != null && Number(gross_rent_monthly) > 0) {
      const mortgageToRentRatio = Number(monthly_mortgage) / Number(gross_rent_monthly);
      if (mortgageToRentRatio > RE_RISK_RULES.max_mortgage_to_rent_ratio) {
        violations.push(`Mortgage-to-rent ratio ${(mortgageToRentRatio * 100).toFixed(0)}% exceeds 70% threshold. Negative cash flow risk.`);
      }
    }

    // Rule: down payment must not exceed 35% of liquid capital
    if (down_payment != null) {
      try {
        const [tradingRes, businessRes] = await Promise.all([
          fetch(`${SUPABASE_URL}/rest/v1/trading_accounts?user_id=eq.${user_id}&is_active=eq.true&select=balance_usd`, { headers: baseHeaders }),
          fetch(`${SUPABASE_URL}/rest/v1/business_ledger?user_id=eq.${user_id}&entry_type=eq.revenue&status=eq.paid&created_at=gte.${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}&select=amount_usd`, { headers: baseHeaders }),
        ]);

        const tradingAccounts: Array<{ balance_usd: number | null }> = tradingRes.ok ? await tradingRes.json() : [];
        const businessRevenue: Array<{ amount_usd: number }> = businessRes.ok ? await businessRes.json() : [];

        const liquidCapital = tradingAccounts.reduce((s, a) => s + Number(a.balance_usd ?? 0), 0)
          + businessRevenue.reduce((s, r) => s + Number(r.amount_usd), 0);

        if (liquidCapital > 0) {
          const downPct = Number(down_payment) / liquidCapital * 100;
          if (downPct > RE_RISK_RULES.max_down_payment_of_liquid_pct) {
            violations.push(`Down payment $${Number(down_payment).toLocaleString()} is ${downPct.toFixed(0)}% of liquid capital — exceeds 35% threshold.`);
          }
        }
      } catch { /* skip capital check */ }
    }

    if (violations.length > 0) {
      await sendTelegramAlert(`*RE RISK ALERT*\nDeal ${deal_id ?? "pending"}: ${violations.length} violation${violations.length !== 1 ? "s" : ""}\n${violations.slice(0, 2).join("\n")}`);
    }

    return new Response(JSON.stringify({
      go: violations.length === 0,
      requires_approval: requiresApproval,
      violations,
      warnings,
      rules: RE_RISK_RULES,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
