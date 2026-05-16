// Atlas Play Tracker — Phase 6
// Checks active atlas_plays against completed opportunity tasks and updates ROI + status.

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";

interface AtlasPlay {
  id: string;
  user_id: string;
  play_type: string;
  title: string;
  status: string;
  capital_deployed: number | null;
  expected_roi_pct: number | null;
  actual_roi_pct: number | null;
  opened_at: string;
  closed_at: string | null;
  outcome_notes: string | null;
  source: string | null;
  legal_basis: string | null;
}

interface AtlasTask {
  id: string;
  user_id: string;
  task_type: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  completed_at: string | null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

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

    // ── 1. Fetch all active plays ────────────────────────────────────────────
    const playsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/atlas_plays?user_id=eq.${user_id}&status=eq.active`,
      { headers: authHeaders },
    );
    const activePlays: AtlasPlay[] = playsRes.ok ? await playsRes.json() : [];

    // ── 2. Fetch completed opportunity tasks for this user ───────────────────
    const tasksRes = await fetch(
      `${SUPABASE_URL}/rest/v1/atlas_tasks?user_id=eq.${user_id}&task_type=eq.opportunity_candidate&status=eq.completed`,
      { headers: authHeaders },
    );
    const completedTasks: AtlasTask[] = tasksRes.ok ? await tasksRes.json() : [];

    // ── 3. Match plays to completed tasks and update ─────────────────────────
    let playsChecked = 0;
    let playsCompleted = 0;

    for (const play of activePlays) {
      playsChecked++;

      const matchingTask = completedTasks.find(
        (task) => (task.payload?.title as string | undefined) === play.title,
      );

      if (!matchingTask) continue;

      const payload    = matchingTask.payload;
      const capitalNum = play.capital_deployed ?? 0;
      const actualReturn = Number(payload?.actual_return ?? 0);
      const actualRoi: number = capitalNum > 0
        ? (actualReturn / capitalNum) * 100
        : 0;

      const outcomeNotes: string =
        typeof matchingTask.result?.result === "string"
          ? matchingTask.result.result
          : (matchingTask.result?.result !== undefined
            ? JSON.stringify(matchingTask.result.result)
            : "");

      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/atlas_plays?id=eq.${play.id}`,
        {
          method: "PATCH",
          headers: { ...authHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({
            actual_roi_pct: actualRoi,
            status: "completed",
            closed_at: new Date().toISOString(),
            outcome_notes: outcomeNotes,
          }),
        },
      );

      if (patchRes.ok || patchRes.status === 204) {
        playsCompleted++;
      } else {
        console.warn(`Failed to update play ${play.id}:`, patchRes.status);
      }
    }

    // ── 4. Return all plays for this user ────────────────────────────────────
    const allPlaysRes = await fetch(
      `${SUPABASE_URL}/rest/v1/atlas_plays?user_id=eq.${user_id}&order=created_at.desc`,
      { headers: authHeaders },
    );
    const plays: AtlasPlay[] = allPlaysRes.ok ? await allPlaysRes.json() : [];

    return new Response(
      JSON.stringify({ plays_checked: playsChecked, plays_completed: playsCompleted, plays }),
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
