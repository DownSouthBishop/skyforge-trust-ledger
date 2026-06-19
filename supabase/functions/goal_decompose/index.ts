// goal_decompose — autonomous goal decomposition engine.
// Finds active goals with no objectives and has Janus decompose them
// into objective trees and task lists, surfaced as dossier_suggestions.
// Scheduled daily at 6am, or triggered by agent_executor.

const HAIKU = "claude-haiku-4-5-20251001";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Goal {
  id: string;
  title: string;
  context: string | null;
  created_at: string;
}

interface DecomposedTask {
  title: string;
  importance: "high" | "medium" | "low";
  due_days: number;
}

interface DecomposedObjective {
  title: string;
  description: string;
  order: number;
  tasks: DecomposedTask[];
}

interface Decomposition {
  objectives: DecomposedObjective[];
}

async function dbGet(url: string, key: string): Promise<any[]> {
  try {
    const r = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    return r.ok ? (await r.json() as any[]) : [];
  } catch { return []; }
}

async function dbPost(url: string, key: string, body: unknown): Promise<boolean> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch { return false; }
}

async function decomposeWithJanus(
  anthropicKey: string,
  janusSystemPrompt: string,
  goal: Goal,
): Promise<Decomposition | null> {
  const today = new Date().toISOString().split("T")[0];
  const prompt = `You are being asked to decompose a goal into a structured action plan.

GOAL: ${goal.title}
CONTEXT: ${goal.context ?? "(no additional context provided)"}
TODAY: ${today}

Return a JSON object with this EXACT structure:
{
  "objectives": [
    {
      "title": "Phase name (short, action-oriented)",
      "description": "What this phase accomplishes",
      "order": 1,
      "tasks": [
        {"title": "Concrete action (start with a verb)", "importance": "high|medium|low", "due_days": 7}
      ]
    }
  ]
}

Rules:
- 2-4 objectives (sequential phases of execution)
- 2-4 tasks per objective
- Task titles start with a verb (Research, Draft, Schedule, Build, etc.)
- due_days is calendar days from today until suggested completion
- Order objectives chronologically — phase 1 before phase 2
- Be specific to this exact goal, not generic
- Output JSON only. No prose, no markdown.`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: HAIKU,
        max_tokens: 700,
        system: `${janusSystemPrompt}\n\nYou are decomposing a goal into a structured action plan. Output JSON only.`,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) return null;
    const j = await r.json() as any;
    const raw: string = j.content?.[0]?.text ?? "";
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as Decomposition;
    if (!Array.isArray(parsed.objectives)) return null;
    return parsed;
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("Claude_API") ?? "";

    if (!ANTHROPIC_KEY) {
      return new Response(JSON.stringify({ ok: false, error: "ANTHROPIC_API_KEY missing" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const specificGoalId: string | null = body.goal_id ?? null;
    const specificGoalTitle: string | null = body.goal_title ?? null;
    const specificUserId: string | null = body.user_id ?? null;

    const authHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    // Resolve user IDs to process
    let userIds: string[] = [];
    if (specificUserId && specificUserId !== "system") {
      userIds = [specificUserId];
    } else {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?select=user_id`, { headers: authHeaders });
      if (r.ok) userIds = ((await r.json()) as Array<{ user_id: string }>).map(x => x.user_id).filter(Boolean);
    }

    // Fetch Janus system prompt (once — shared across all users)
    const janusRows = await dbGet(
      `${SUPABASE_URL}/rest/v1/skyforge_agents?slug=eq.janus&limit=1&select=system_prompt`,
      SERVICE_KEY,
    );
    const janusSystemPrompt: string = janusRows[0]?.system_prompt ?? "You are Janus, strategic architect and planner.";

    const results: Record<string, { goals_decomposed: number; suggestions_created: number }> = {};
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    for (const uid of userIds) {
      let goalsToDecompose: Goal[] = [];

      if (specificGoalId) {
        // Decompose a specific goal
        const rows = await dbGet(
          `${SUPABASE_URL}/rest/v1/goals?id=eq.${specificGoalId}&user_id=eq.${uid}&limit=1&select=id,title,context,created_at`,
          SERVICE_KEY,
        );
        if (rows[0]) goalsToDecompose = [rows[0] as Goal];
      } else if (specificGoalTitle) {
        const rows = await dbGet(
          `${SUPABASE_URL}/rest/v1/goals?user_id=eq.${uid}&title=eq.${encodeURIComponent(specificGoalTitle)}&status=eq.active&limit=1&select=id,title,context,created_at`,
          SERVICE_KEY,
        );
        if (rows[0]) goalsToDecompose = [rows[0] as Goal];
      } else {
        // Find active goals that are at least 1 day old and have no objectives
        const [allGoals, existingObjectives, recentCrossMemory] = await Promise.all([
          dbGet(`${SUPABASE_URL}/rest/v1/goals?user_id=eq.${uid}&status=eq.active&created_at=lte.${cutoff24h}&select=id,title,context,created_at`, SERVICE_KEY),
          dbGet(`${SUPABASE_URL}/rest/v1/objectives?user_id=eq.${uid}&select=goal_id`, SERVICE_KEY),
          dbGet(`${SUPABASE_URL}/rest/v1/agent_cross_memory?user_id=eq.${uid}&topic=eq.goal_decompose&order=created_at.desc&limit=20&select=summary`, SERVICE_KEY),
        ]);

        const goalsWithObjectives = new Set((existingObjectives as any[]).map((o: any) => o.goal_id));
        const recentlyDecomposed = new Set(
          (recentCrossMemory as any[])
            .map((c: any) => {
              const m = c.summary.match(/"([^"]+)" decomposed/);
              return m ? m[1] : null;
            })
            .filter(Boolean)
        );

        goalsToDecompose = (allGoals as Goal[])
          .filter(g => !goalsWithObjectives.has(g.id) && !recentlyDecomposed.has(g.title))
          .slice(0, 3); // Max 3 goals per run
      }

      let goalsDecomposed = 0;
      let suggestionsCreated = 0;

      for (const goal of goalsToDecompose) {
        const decomposition = await decomposeWithJanus(ANTHROPIC_KEY, janusSystemPrompt, goal);
        if (!decomposition?.objectives?.length) continue;

        const validImportance = ["high", "medium", "low"];
        const today = new Date();

        for (const obj of decomposition.objectives) {
          if (!obj.title) continue;

          // Write objective as dossier_suggestion
          const objOk = await dbPost(`${SUPABASE_URL}/rest/v1/dossier_suggestions`, SERVICE_KEY, {
            user_id: uid,
            agent_slug: "janus",
            entry_type: "objective",
            title: String(obj.title).slice(0, 255),
            context: `Phase ${obj.order} of goal "${goal.title}". ${obj.description ?? ""}`.slice(0, 1000),
            importance: "high",
            status: "pending",
          });
          if (objOk) suggestionsCreated++;

          // Write each task under this objective
          for (const task of (obj.tasks ?? [])) {
            if (!task.title) continue;
            const dueDate = new Date(today.getTime() + (Number(task.due_days ?? 14)) * 86400000)
              .toISOString().split("T")[0];

            const taskOk = await dbPost(`${SUPABASE_URL}/rest/v1/dossier_suggestions`, SERVICE_KEY, {
              user_id: uid,
              agent_slug: "janus",
              entry_type: "task",
              title: String(task.title).slice(0, 255),
              context: `Under objective "${obj.title}" → goal "${goal.title}"`.slice(0, 500),
              importance: validImportance.includes(task.importance) ? task.importance : "medium",
              suggested_date: dueDate,
              status: "pending",
            });
            if (taskOk) suggestionsCreated++;
          }
        }

        // Write cross-memory so other agents know this happened
        await dbPost(`${SUPABASE_URL}/rest/v1/agent_cross_memory`, SERVICE_KEY, {
          user_id: uid,
          source_agent: "janus",
          summary: `Goal "${goal.title}" decomposed into ${decomposition.objectives.length} objectives and ${suggestionsCreated} task suggestions pending approval.`,
          topic: "goal_decompose",
        });

        goalsDecomposed++;
      }

      results[uid] = { goals_decomposed: goalsDecomposed, suggestions_created: suggestionsCreated };
    }

    return new Response(
      JSON.stringify({ ok: true, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[goal_decompose]", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
