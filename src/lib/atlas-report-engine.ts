import { supabase } from "@/integrations/supabase/client";

export interface ReportArchive {
  id: string;
  report_date: string;
  free_content?: string;
  signal_content?: string;
  institutional_content?: string;
  signal_claims: unknown[];
  markets_covered: string[];
  verified_predictions: Record<string, unknown>;
  published_at?: string;
}

export async function generateDailyReport(): Promise<void> {
  const { error } = await supabase.functions.invoke("atlas-report", {
    body: { action: "generate" },
  });
  if (error) {
    console.error("[atlas-report] generateDailyReport error:", error);
    throw error;
  }
}

export async function getLatestReport(
  tier: "FREE" | "SIGNAL" | "INSTITUTIONAL",
): Promise<ReportArchive | null> {
  const { data, error } = await supabase
    .from("atlas_report_archive")
    .select("*")
    .order("report_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[atlas-report] getLatestReport error:", error);
    return null;
  }

  if (!data) return null;

  const report = data as ReportArchive;

  // Strip content the caller isn't entitled to see
  if (tier === "FREE") {
    report.signal_content = undefined;
    report.institutional_content = undefined;
  } else if (tier === "SIGNAL") {
    report.institutional_content = undefined;
  }

  return report;
}

export async function getReportArchive(params: {
  limit?: number;
  offset?: number;
  tier: "FREE" | "SIGNAL" | "INSTITUTIONAL";
}): Promise<ReportArchive[]> {
  const { limit = 20, offset = 0, tier } = params;

  const { data, error } = await supabase
    .from("atlas_report_archive")
    .select("*")
    .order("report_date", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("[atlas-report] getReportArchive error:", error);
    return [];
  }

  return (data ?? []).map((row) => {
    const report = row as ReportArchive;
    if (tier === "FREE") {
      report.signal_content = undefined;
      report.institutional_content = undefined;
    } else if (tier === "SIGNAL") {
      report.institutional_content = undefined;
    }
    return report;
  });
}

export async function getVerificationRate(): Promise<number> {
  const { data, error } = await supabase
    .from("atlas_report_archive")
    .select("verified_predictions")
    .not("verified_predictions", "is", null);

  if (error) {
    console.error("[atlas-report] getVerificationRate error:", error);
    return 0;
  }

  let total = 0;
  let correct = 0;

  for (const row of data ?? []) {
    const vp = row.verified_predictions as Record<string, unknown>;
    if (!vp || typeof vp !== "object") continue;

    for (const val of Object.values(vp)) {
      if (val && typeof val === "object") {
        const entry = val as Record<string, unknown>;
        total += 1;
        if (entry.correct === true || entry.outcome === "correct" || entry.result === "correct") {
          correct += 1;
        }
      }
    }
  }

  if (total === 0) return 0;
  return Math.round((correct / total) * 100);
}
