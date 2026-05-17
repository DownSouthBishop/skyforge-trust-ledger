import { supabase } from "@/integrations/supabase/client";

export interface AtlasBusinessPipeline {
  id: string;
  name: string;
  stage: string;
  thesis: string | null;
  business_model: string | null;
  capital_required: number | null;
  projected_monthly_revenue: number | null;
  actual_monthly_revenue: number | null;
  market_size_estimate: number | null;
  evaluation_score: number | null;
  risk_flags: string[] | null;
  next_milestone: string | null;
  initialized_at: string | null;
  last_monitored_at: string | null;
  created_at: string;
  updated_at: string | null;
}

export async function runScoutingCycle(): Promise<void> {
  const { error } = await supabase.functions.invoke("atlas-business", {
    body: { action: "scout" },
  });
  if (error) {
    console.error("[atlas-business] scout error:", error);
    throw error;
  }
}

export async function runEvaluationMemo(businessId: string): Promise<void> {
  const { error } = await supabase.functions.invoke("atlas-business", {
    body: { action: "evaluate", business_id: businessId },
  });
  if (error) {
    console.error("[atlas-business] evaluate error:", error);
    throw error;
  }
}

export async function initializeBusiness(businessId: string): Promise<void> {
  const { error } = await supabase.functions.invoke("atlas-business", {
    body: { action: "initialize", business_id: businessId },
  });
  if (error) {
    console.error("[atlas-business] initialize error:", error);
    throw error;
  }
}

export async function monitorBusiness(businessId: string): Promise<void> {
  const { error } = await supabase.functions.invoke("atlas-business", {
    body: { action: "monitor", business_id: businessId },
  });
  if (error) {
    console.error("[atlas-business] monitor error:", error);
    throw error;
  }
}

export async function getBusinessPipeline(): Promise<AtlasBusinessPipeline[]> {
  const { data, error } = await supabase
    .from("atlas_business_pipeline")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[atlas-business] getBusinessPipeline error:", error);
    return [];
  }

  return (data ?? []) as AtlasBusinessPipeline[];
}
