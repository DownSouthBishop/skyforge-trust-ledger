import { supabase as supabaseTyped } from "@/integrations/supabase/client";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = supabaseTyped;

export async function runDealScouting(): Promise<void> {
  const { error } = await supabase.functions.invoke("atlas-re", {
    body: { action: "deal_scan" },
  });
  if (error) {
    console.error("[atlas-re] runDealScouting error:", error);
    throw error;
  }
}

export async function runPortfolioMonitoring(): Promise<void> {
  const { error } = await supabase.functions.invoke("atlas-re", {
    body: { action: "lease_monitor" },
  });
  if (error) {
    console.error("[atlas-re] runPortfolioMonitoring error:", error);
    throw error;
  }
}

export async function coordinateContractor(params: {
  propertyId: string;
  workType: string;
  urgency: "routine" | "urgent" | "emergency";
}): Promise<void> {
  const { error } = await supabase.functions.invoke("atlas-re", {
    body: {
      action: "coordinate_contractor",
      property_id: params.propertyId,
      work_type: params.workType,
      urgency: params.urgency,
    },
  });
  if (error) {
    console.error("[atlas-re] coordinateContractor error:", error);
    throw error;
  }
}

export async function getREPortfolio(): Promise<unknown[]> {
  const { data, error } = await supabase
    .from("atlas_re_portfolio")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[atlas-re] getREPortfolio error:", error);
    return [];
  }

  return data ?? [];
}
