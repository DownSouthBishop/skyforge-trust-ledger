// proactive_monitor — scheduled edge function that analyzes user activity and
// writes actionable alerts to proactive_alerts table.
// Triggered by pg_cron every 30 minutes, or manually for a specific user.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GOOGLE_AI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MODEL = "gemini-2.5-flash";

async function geminiJSON(apiKey: string, system: string, user: string, maxTokens = 600): Promise<unknown> {
  try {
    const resp = await fetch(`${GOOGLE_AI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        max_tokens: maxTokens,
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content ?? "";
    const match = raw.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const GOOGLE_KEY = Deno.env.get("GOOGLE_AI_KEY") ?? "";

    if (!GOOGLE_KEY) {
      return new Response(JSON.stringify({ ok: false, error: "GOOGLE_AI_KEY missing" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const requestedUserId: string | null = body.user_id ?? null;

    const authHeaders = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    };

    // Resolve which users to process
    let userIds: string[] = [];
    if (requestedUserId && requestedUserId !== "system") {
      userIds = [requestedUserId];
    } else {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/skyforge_agents?select=user_id&is_active=eq.true`, { headers: authHeaders });
      if (r.ok) {
        const rows = (await r.json()) as Array<{ user_id: string }>;
        userIds = [...new Set(rows.map(x => x.user_id).filter(Boolean))];
      }
    }

    const alertsCreated: Array<{ user_id: string; alert_type: string; title: string }> = [];
    let tasksQueued = 0;
    let alertsDeduplicated = 0;
    const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const next7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    for (const uid of userIds) {
      try {
        // ── Priority decay: demote stale high-priority alerts ────────
        // High alerts unread for 48h+ get demoted to medium so they stop dominating the view
        await fetch(`${SUPABASE_URL}/rest/v1/proactive_alerts?user_id=eq.${uid}&status=eq.unread&priority=eq.high&created_at=lt.${cutoff48h}`, {
          method: "PATCH",
          headers: { ...authHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({ priority: "medium" }),
        }).catch(() => {});

        // Fetch all context in parallel
        const [goalsRows, tasksRows, crossMemRows, sharedMemRows, objectivesRows] = await Promise.all([
          fetch(
            `${SUPABASE_URL}/rest/v1/goals?user_id=eq.${uid}&status=eq.active&select=id,title,context,created_at,updated_at`,
            { headers: authHeaders },
          ).then(r => r.ok ? r.json() : []),

          fetch(
            `${SUPABASE_URL}/rest/v1/tasks?user_id=eq.${uid}&status=eq.pending&due_date=lte.${next7Days}&order=due_date.asc&limit=15&select=id,title,due_date,importance,status`,
            { headers: authHeaders },
          ).then(r => r.ok ? r.json() : []),

          fetch(
            `${SUPABASE_URL}/rest/v1/agent_cross_memory?user_id=eq.${uid}&created_at=gte.${cutoff48h}&order=created_at.desc&limit=20&select=source_agent,summary,topic,created_at`,
            { headers: authHeaders },
          ).then(r => r.ok ? r.json() : []),

          fetch(
            `${SUPABASE_URL}/rest/v1/shared_operator_memory?user_id=eq.${uid}&order=updated_at.desc&limit=20&select=memory_type,key,value,source_agent,updated_at`,
            { headers: authHeaders },
          ).then(r => r.ok ? r.json() : []),
          fetch(
            `${SUPABASE_URL}/rest/v1/objectives?user_id=eq.${uid}&select=goal_id`,
            { headers: authHeaders },
          ).then(r => r.ok ? r.json() : []),
        ]);

        const goals = goalsRows as Array<{ id: string; title: string; context: string | null; created_at: string; updated_at: string }>;
        const tasks = tasksRows as Array<{ id: string; title: string; due_date: string; importance: string; status: string }>;
        const crossMem = crossMemRows as Array<{ source_agent: string; summary: string; topic: string | null; created_at: string }>;
        const sharedMem = sharedMemRows as Array<{ memory_type: string; key: string; value: string; source_agent: string; updated_at: string }>;
        const objectives = objectivesRows as Array<{ goal_id: string }>;

        if (!goals.length && !tasks.length && !crossMem.length) continue;

        // Goal decompose detection — queue decompose tasks for goals with no objectives
        const goalsWithObjectives = new Set(objectives.map((o: any) => o.goal_id));
        const dayOld = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const recentDecomposeTitles = new Set(
          crossMem
            .filter(c => c.topic === "goal_decompose")
            .map(c => { const m = c.summary.match(/"([^"]+)" decomposed/); return m ? m[1] : null; })
            .filter(Boolean) as string[]
        );
        const goalsNeedingDecompose = goals
          .filter(g => !goalsWithObjectives.has(g.id) && !recentDecomposeTitles.has(g.title) && g.created_at < dayOld)
          .slice(0, 2);

        for (const g of goalsNeedingDecompose) {
          fetch(`${SUPABASE_URL}/rest/v1/agent_tasks`, {
            method: "POST",
            headers: { ...authHeaders, Prefer: "return=minimal" },
            body: JSON.stringify({
              user_id: uid,
              agent_slug: "janus",
              task_type: "goal_decomposition",
              task_description: `Decompose goal "${g.title}" into a full objective tree with tasks. Context: ${g.context ?? "No context provided."}`,
              context: { goal_id: g.id, goal_title: g.title },
              priority: "medium",
              triggered_by: "proactive_monitor",
            }),
          }).catch(() => {});
        }

        const goalsBlock = goals.map(g => `- [${g.id}] "${g.title}" (last updated: ${g.updated_at?.split("T")[0] ?? "unknown"})${g.context ? ` — ${g.context}` : ""}`).join("\n") || "(no active goals)";
        const tasksBlock = tasks.map(t => `- "${t.title}" due ${t.due_date} [${t.importance}]`).join("\n") || "(no tasks due this week)";
        const crossBlock = crossMem.map(c => `[${c.source_agent}${c.topic ? ` · ${c.topic}` : ""}] ${c.summary}`).join("\n") || "(no recent agent activity)";
        const memBlock = sharedMem.map(m => `[${m.memory_type}] ${m.value}`).join("\n") || "(no patterns stored)";

        const ANALYSIS_SYSTEM = `You are a proactive AI advisor analyzing an operator's goals, tasks, and recent activity to surface important alerts.

Return a JSON array of alert objects. Each alert:
{
  "agent_slug": "atlas|janus|linda|izzy",
  "alert_type": "goal_stall|deadline|opportunity|pattern|recommendation",
  "title": "concise title (max 80 chars)",
  "content": "actionable detail explaining why this matters and what to do (2-3 sentences)",
  "priority": "high|medium|low"
}

Return [] if nothing significant to flag.

Guidelines:
- goal_stall: goal hasn't been worked on in 5+ days AND there's no recent agent activity about it
- deadline: task due within 3 days
- opportunity: emerging pattern suggests a good time to act on something
- pattern: recurring theme across agent conversations worth noting
- recommendation: specific actionable suggestion based on current situation

Only flag things with genuine importance. Quality over quantity. Max 5 alerts.
Output JSON array only. No prose, no markdown.`;

        const ANALYSIS_USER = `ACTIVE GOALS (with last-updated timestamps):
${goalsBlock}

TASKS DUE THIS WEEK:
${tasksBlock}

RECENT AGENT ACTIVITY (last 48 hours):
${crossBlock}

STORED OPERATOR PATTERNS:
${memBlock}

Today's date: ${new Date().toISOString().split("T")[0]}

Analyze and return alerts JSON array.`;

        const alerts = await geminiJSON(GOOGLE_KEY, ANALYSIS_SYSTEM, ANALYSIS_USER, 800) as Array<{
          agent_slug: string;
          alert_type: string;
          title: string;
          content: string;
          priority: string;
        }> | null;

        if (!Array.isArray(alerts) || alerts.length === 0) continue;

        // Write each valid alert to the DB
        for (const alert of alerts) {
          if (!alert?.alert_type || !alert?.title || !alert?.content) continue;

          const validTypes = ["goal_stall", "deadline", "opportunity", "pattern", "recommendation"];
          const validPriorities = ["high", "medium", "low"];
          const validAgents = ["atlas", "janus", "linda", "izzy"];

          const alertToWrite = {
            user_id: uid,
            agent_slug: validAgents.includes(alert.agent_slug) ? alert.agent_slug : "atlas",
            alert_type: validTypes.includes(alert.alert_type) ? alert.alert_type : "recommendation",
            title: String(alert.title).slice(0, 200),
            content: String(alert.content).slice(0, 2000),
            priority: validPriorities.includes(alert.priority) ? alert.priority : "medium",
            dedup_key: `${alert.alert_type}:${String(alert.title).slice(0, 60).toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
          };

          // Deduplication: skip if same dedup_key exists in the last 24 hours
          const dedupCheck = await fetch(
            `${SUPABASE_URL}/rest/v1/proactive_alerts?user_id=eq.${uid}&dedup_key=eq.${encodeURIComponent(alertToWrite.dedup_key)}&created_at=gte.${cutoff24h}&select=id&limit=1`,
            { headers: authHeaders },
          );
          if (dedupCheck.ok) {
            const existing = await dedupCheck.json() as any[];
            if (existing.length > 0) {
              alertsDeduplicated++;
              continue;
            }
          }

          const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/proactive_alerts`, {
            method: "POST",
            headers: { ...authHeaders, Prefer: "return=minimal" },
            body: JSON.stringify(alertToWrite),
          });

          if (insertResp.ok) {
            alertsCreated.push({ user_id: uid, alert_type: alertToWrite.alert_type, title: alertToWrite.title });

            // Push Telegram for high-priority alerts
            if (alertToWrite.priority === "high") {
              const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
              const chatId = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
              if (botToken && chatId) {
                fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    chat_id: chatId,
                    text: `🔔 *${alertToWrite.agent_slug.toUpperCase()}* [${alertToWrite.alert_type.replace(/_/g, " ")}]\n\n*${alertToWrite.title}*\n${alertToWrite.content.slice(0, 200)}`,
                    parse_mode: "Markdown",
                  }),
                }).catch(() => {});
              }
            }

            // Queue an executor task for high-value alerts that benefit from autonomous action
            const shouldQueue = (
              (alertToWrite.alert_type === "goal_stall" && alertToWrite.priority !== "low") ||
              (alertToWrite.alert_type === "opportunity" && alertToWrite.priority === "high") ||
              (alertToWrite.alert_type === "deadline" && alertToWrite.priority === "high")
            );

            if (shouldQueue) {
              const taskDesc = alertToWrite.alert_type === "goal_stall"
                ? `Goal stall recovery: "${alertToWrite.title}". ${alertToWrite.content} Analyze why this goal stalled, consult the appropriate specialist agent, and create concrete next steps as task suggestions in the dossier.`
                : alertToWrite.alert_type === "opportunity"
                ? `Opportunity analysis: "${alertToWrite.title}". ${alertToWrite.content} Analyze this opportunity with the appropriate agent and write an action plan alert for the operator.`
                : `Deadline preparation: "${alertToWrite.title}". ${alertToWrite.content} Create a preparation checklist as task suggestions so the operator can review and approve each step.`;

              fetch(`${SUPABASE_URL}/rest/v1/agent_tasks`, {
                method: "POST",
                headers: { ...authHeaders, Prefer: "return=minimal" },
                body: JSON.stringify({
                  user_id: uid,
                  agent_slug: alertToWrite.agent_slug,
                  task_type: alertToWrite.alert_type,
                  task_description: taskDesc,
                  context: { alert_title: alertToWrite.title, alert_content: alertToWrite.content },
                  priority: alertToWrite.priority,
                  triggered_by: "proactive_monitor",
                }),
              }).then(r => { if (r.ok) tasksQueued++; }).catch(() => {});
            }
          }
        }
      } catch (e) {
        console.error(`[proactive_monitor] error for user ${uid}:`, e);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, alerts_created: alertsCreated.length, tasks_queued: tasksQueued, alerts_deduplicated: alertsDeduplicated, alerts: alertsCreated }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[proactive_monitor]", e);
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
