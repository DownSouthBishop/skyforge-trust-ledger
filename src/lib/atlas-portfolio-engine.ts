import { supabase } from "@/integrations/supabase/client";

export interface PortfolioState {
  id: string;
  snapshot_date: string;
  total_value: number | null;
  monthly_cashflow: number | null;
  annual_return_rate: number | null;
  rebalancing_needed: boolean | null;
  liquid_trading_pct: number | null;
  real_assets_pct: number | null;
  venture_allocation_pct: number | null;
  operating_reserve_pct: number | null;
  monthly_income: number | null;
  monthly_operating_cost: number | null;
  is_self_funding: boolean | null;
  months_until_self_funding: number | null;
  created_at: string;
  updated_at: string | null;
}

export async function getCurrentPortfolioState(): Promise<PortfolioState | null> {
  const { data, error } = await supabase
    .from("atlas_portfolio_state")
    .select("*")
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[atlas-portfolio] getCurrentPortfolioState error:", error);
    return null;
  }

  return data as PortfolioState | null;
}

export async function runAllocationCheck(): Promise<void> {
  const { error } = await supabase.functions.invoke("atlas-portfolio", {
    body: { action: "allocation_check" },
  });
  if (error) {
    console.error("[atlas-portfolio] runAllocationCheck error:", error);
    throw error;
  }
}

export async function computeSelfFundingStatus(): Promise<{
  isSelfFunding: boolean;
  monthlyIncome: number;
  monthlyOperatingCost: number;
  monthsUntilSelfFunding: number;
}> {
  const { data, error } = await supabase.functions.invoke("atlas-portfolio", {
    body: { action: "self_funding_status" },
  });

  if (error) {
    console.error("[atlas-portfolio] computeSelfFundingStatus error:", error);
    return {
      isSelfFunding: false,
      monthlyIncome: 0,
      monthlyOperatingCost: 0,
      monthsUntilSelfFunding: 0,
    };
  }

  return {
    isSelfFunding: data?.is_self_funding ?? false,
    monthlyIncome: data?.monthly_income ?? 0,
    monthlyOperatingCost: data?.monthly_operating_cost ?? 0,
    monthsUntilSelfFunding: data?.months_until_self_funding ?? 0,
  };
}

export async function generateInvestmentPolicyUpdate(): Promise<void> {
  const { error } = await supabase.functions.invoke("atlas-portfolio", {
    body: { action: "generate_policy_update" },
  });
  if (error) {
    console.error("[atlas-portfolio] generateInvestmentPolicyUpdate error:", error);
    throw error;
  }
}
