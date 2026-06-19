// goal_scorer — recalculates progress_score for each active goal.
// Progress = completed tasks / total tasks across all objectives for that goal.
// Falls back to objective completion if no tasks exist.
// Runs daily 6:50am (before daily_brief at 7am) via pg_cron.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const h = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    };

    // Resolve operator
    const agentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/skyforge_agents?select=user_id&is_active=eq.true&limit=1`,
      { headers: h },
    );
    const agentRows = agentRes.ok ? (await agentRes.json() as any[]) : [];
    if (!agentRows.length) {
      return new Response(JSON.stringify({ ok: false, error: "No agents found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const uid = agentRows[0].user_id as string;

    // Fetch active goals, objectives, and tasks in parallel
    const [goalsRes, objectivesRes, tasksRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/goals?user_id=eq.${uid}&status=eq.active&select=id,title`,
        { headers: h },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/objectives?user_id=eq.${uid}&select=id,goal_id,status`,
        { headers: h },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/tasks?user_id=eq.${uid}&select=id,objective_id,status`,
        { headers: h },
      ),
    ]);

    const goals = goalsRes.ok ? (await goalsRes.json() as any[]) : [];
    const objectives = objectivesRes.ok ? (await objectivesRes.json() as any[]) : [];
    const tasks = tasksRes.ok ? (await tasksRes.json() as any[]) : [];

    if (!goals.length) {
      return new Response(
        JSON.stringify({ ok: true, goals_scored: 0, message: "No active goals" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Build lookup maps
    const objectivesByGoal = new Map<string, any[]>();
    for (const obj of objectives) {
      if (!objectivesByGoal.has(obj.goal_id)) objectivesByGoal.set(obj.goal_id, []);
      objectivesByGoal.get(obj.goal_id)!.push(obj);
    }

    const tasksByObjective = new Map<string, any[]>();
    for (const task of tasks) {
      if (!tasksByObjective.has(task.objective_id)) tasksByObjective.set(task.objective_id, []);
      tasksByObjective.get(task.objective_id)!.push(task);
    }

    const DONE_STATUSES = new Set(["done", "completed", "complete", "finished"]);

    let goalsScored = 0;
    const updates: Array<{ id: string; score: number }> = [];

    for (const goal of goals) {
      const goalObjectives = objectivesByGoal.get(goal.id) ?? [];

      if (!goalObjectives.length) {
        // No objectives yet — score stays 0
        continue;
      }

      // Try to score by tasks first
      let totalTasks = 0;
      let doneTasks = 0;

      for (const obj of goalObjectives) {
        const objTasks = tasksByObjective.get(obj.id) ?? [];
        totalTasks += objTasks.length;
        doneTasks += objTasks.filter(t => DONE_STATUSES.has(String(t.status).toLowerCase())).length;
      }

      let score: number;
      if (totalTasks > 0) {
        score = Math.round((doneTasks / totalTasks) * 100 * 10) / 10;
      } else {
        // Fall back to objective completion
        const doneObjectives = goalObjectives.filter(o => DONE_STATUSES.has(String(o.status).toLowerCase())).length;
        score = Math.round((doneObjectives / goalObjectives.length) * 100 * 10) / 10;
      }

      updates.push({ id: goal.id, score });
    }

    // Apply score updates
    for (const { id, score } of updates) {
      await fetch(
        `${SUPABASE_URL}/rest/v1/goals?id=eq.${id}&user_id=eq.${uid}`,
        {
          method: "PATCH",
          headers: { ...h, Prefer: "return=minimal" },
          body: JSON.stringify({
            progress_score: score,
            updated_at: new Date().toISOString(),
          }),
        },
      );
      goalsScored++;
    }

    // Write to cross_memory if meaningful progress exists
    const avgScore = updates.length > 0
      ? Math.round(updates.reduce((s, u) => s + u.score, 0) / updates.length)
      : 0;

    if (updates.length > 0) {
      await fetch(`${SUPABASE_URL}/rest/v1/agent_cross_memory`, {
        method: "POST",
        headers: { ...h, Prefer: "return=minimal" },
        body: JSON.stringify({
          user_id: uid,
          source_agent: "atlas",
          summary: `Goal progress scored: ${goalsScored} goals updated. Average progress: ${avgScore}%. Scores ready for morning brief.`,
          topic: "goal_progress",
        }),
      }).catch(() => {});
    }

    return new Response(
      JSON.stringify({
        ok: true,
        goals_total: goals.length,
        goals_scored: goalsScored,
        average_progress: avgScore,
        scores: updates,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (e) {
    console.error("[goal_scorer]", e);
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
