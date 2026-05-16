// Atlas Play Ranker — Phase 6
// Groups completed plays by type, computes Sharpe-based rankings, and generates AI analysis.

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

interface CompletedPlay {
  id: string;
  user_id: string;
  play_type: string;
  title: string;
  status: string;
  capital_deployed: number | null;
  actual_roi_pct: number | null;
  opened_at: string;
  closed_at: string | null;
}

interface PlayTypeStats {
  play_type: string;
  count: number;
  mean_roi: number;
  stddev_roi: number;
  sharpe: number | null;
  success_rate: number;
  avg_capital: number;
  avg_duration_days: number;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance =
    values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function durationDays(opened: string, closed: string | null): number {
  if (!closed) return 0;
  const ms = new Date(closed).getTime() - new Date(opened).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    const GATEWAY_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? Deno.env.get("GATEWAY_API_KEY");
    const atlasModel  = modelEnv("ATLAS_MODEL", "openai/gpt-4o");

    const body = await req.json();
    const user_id: string | undefined = body?.user_id;
    if (!user_id) {
      return new Response(
        JSON.stringify({ error: "user_id required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const authHeaders: Record<string, string> = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    };

    // ── 1. Fetch all completed plays ─────────────────────────────────────────
    const playsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/atlas_plays?user_id=eq.${user_id}&status=eq.completed`,
      { headers: authHeaders },
    );
    const completedPlays: CompletedPlay[] = playsRes.ok ? await playsRes.json() : [];

    if (completedPlays.length < 3) {
      return new Response(
        JSON.stringify({ message: "Not enough data to rank" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── 2. Group by play_type and compute stats ──────────────────────────────
    const groups = new Map<string, CompletedPlay[]>();
    for (const play of completedPlays) {
      const existing = groups.get(play.play_type) ?? [];
      existing.push(play);
      groups.set(play.play_type, existing);
    }

    const stats: PlayTypeStats[] = [];
    for (const [play_type, plays] of groups) {
      const roiValues: number[] = plays
        .map((p) => p.actual_roi_pct ?? 0);

      const capitalValues: number[] = plays
        .map((p) => p.capital_deployed ?? 0);

      const durationValues: number[] = plays
        .map((p) => durationDays(p.opened_at, p.closed_at));

      const mean_roi       = mean(roiValues);
      const stddev_roi     = stddev(roiValues, mean_roi);
      const sharpe: number | null = stddev_roi > 0
        ? (mean_roi / stddev_roi) * Math.sqrt(52)
        : null;
      const success_rate   = roiValues.filter((r) => r > 0).length / roiValues.length;
      const avg_capital    = mean(capitalValues);
      const avg_duration_days = mean(durationValues);

      stats.push({
        play_type,
        count: plays.length,
        mean_roi,
        stddev_roi,
        sharpe,
        success_rate,
        avg_capital,
        avg_duration_days,
      });
    }

    // ── 3. Sort by sharpe descending (null last) ─────────────────────────────
    stats.sort((a, b) => {
      if (a.sharpe === null && b.sharpe === null) return 0;
      if (a.sharpe === null) return 1;
      if (b.sharpe === null) return -1;
      return b.sharpe - a.sharpe;
    });

    // ── 4. Format rankings string ────────────────────────────────────────────
    const rankingsLines: string[] = stats.map((s, i) => {
      const sharpeStr = s.sharpe !== null ? s.sharpe.toFixed(2) : "N/A";
      return (
        `#${i + 1} ${s.play_type} — Sharpe: ${sharpeStr} | Mean ROI: ${s.mean_roi.toFixed(1)}% | ` +
        `Success: ${(s.success_rate * 100).toFixed(0)}% | Plays: ${s.count} | ` +
        `Avg Capital: $${s.avg_capital.toFixed(0)} | Avg Duration: ${s.avg_duration_days.toFixed(1)}d`
      );
    });
    const rankings_string = rankingsLines.join("\n");

    // ── 5. AI analysis ───────────────────────────────────────────────────────
    let aiResponse = "";
    if (GATEWAY_KEY) {
      const prompt =
        `Given these play type performance rankings for an autonomous trading system:\n${rankings_string}\nWhich play types should Atlas increase capital allocation to, which should be paused, and what patterns emerge about which market conditions favor which play types?\nRespond in 150 words max.`;

      try {
        const aiResp = await callGatewayWithRetry(
          {
            model: atlasModel,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
          },
          GATEWAY_KEY,
        );
        if (aiResp.ok) {
          const aiData = await aiResp.json();
          aiResponse = aiData?.choices?.[0]?.message?.content ?? "";
        } else {
          console.warn("AI analysis call failed:", aiResp.status);
        }
      } catch (e) {
        console.warn("AI analysis error:", e);
      }
    } else {
      console.warn("No AI gateway key — AI analysis skipped");
    }

    // ── 6. Save to research_notes ────────────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    const noteContent =
      rankings_string +
      (aiResponse ? `\n\nATLAS ANALYSIS:\n${aiResponse}` : "");

    await fetch(`${SUPABASE_URL}/rest/v1/research_notes`, {
      method: "POST",
      headers: { ...authHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id,
        note_type: "research",
        symbol: "PLAY_RANKINGS",
        title: `Play Rankings — ${today}`,
        content: noteContent,
        synced_to_obsidian: false,
      }),
    });

    // ── 7. Telegram alert ────────────────────────────────────────────────────
    const top3 = stats.slice(0, 3);
    const sortedBySuccess = [...stats].sort((a, b) => a.success_rate - b.success_rate);
    const bottom3 = sortedBySuccess.slice(0, Math.min(3, sortedBySuccess.length));

    const top3Lines = top3
      .map((s) => `• ${s.play_type}: Sharpe ${s.sharpe !== null ? s.sharpe.toFixed(2) : "N/A"}, ROI ${s.mean_roi.toFixed(1)}%`)
      .join("\n");

    const bottom3Lines = bottom3
      .map((s) => `• ${s.play_type}: ${(s.success_rate * 100).toFixed(0)}% success rate`)
      .join("\n");

    await sendTelegramAlert(
      `*PLAY RANKINGS — ${today}*\n\n*Top by Sharpe:*\n${top3Lines}\n\n*Lowest Success Rate:*\n${bottom3Lines}`,
    );

    return new Response(
      JSON.stringify({ play_types_ranked: stats.length, rankings_saved: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
