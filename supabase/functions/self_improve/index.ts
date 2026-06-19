// self_improve — weekly function that reads each agent's performance metrics,
// analyzes patterns in completions/failures/noise, and generates proposed
// system prompt refinements queued as dossier_suggestions for operator approval.
// Runs Sunday 3am via pg_cron.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_MODEL = "gemini-2.5-flash";

const AGENTS = ["atlas", "janus", "linda", "izzy"] as const;
type AgentSlug = typeof AGENTS[number];

async function gemini(apiKey: string, system: string, user: string, maxTokens = 800): Promise<string> {
  try {
    const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        max_tokens: maxTokens,
      }),
    });
    if (!resp.ok) return "";
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content ?? "";
  } catch { return ""; }
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

    const h = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

    // Resolve operator via skyforge_agents (guaranteed to have rows from seed migrations)
    const agentRes = await fetch(`${SUPABASE_URL}/rest/v1/skyforge_agents?select=user_id&is_active=eq.true&limit=1`, { headers: h });
    const agentRows = agentRes.ok ? (await agentRes.json() as any[]) : [];
    if (!agentRows.length) {
      return new Response(JSON.stringify({ ok: false, error: "No agents found — cannot resolve operator" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const uid = agentRows[0].user_id as string;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const refinementsQueued: Array<{ agent: string; refinement: string }> = [];

    for (const slug of AGENTS) {
      try {
        // Fetch agent record
        const agentRes = await fetch(
          `${SUPABASE_URL}/rest/v1/skyforge_agents?user_id=eq.${uid}&slug=eq.${slug}&select=name,system_prompt,role&limit=1`,
          { headers: h },
        );
        const agents = agentRes.ok ? (await agentRes.json() as any[]) : [];
        if (!agents.length) continue;
        const { name, system_prompt, role } = agents[0] as { name: string; system_prompt: string; role: string };

        // Fetch performance data (last 30 days)
        const [tasksRes, suggestionsRes, alertsRes, journalRes] = await Promise.all([
          fetch(`${SUPABASE_URL}/rest/v1/agent_tasks?user_id=eq.${uid}&agent_slug=eq.${slug}&created_at=gte.${thirtyDaysAgo}&select=status,task_type,task_description,steps_taken,retry_count`, { headers: h }),
          fetch(`${SUPABASE_URL}/rest/v1/dossier_suggestions?user_id=eq.${uid}&agent_slug=eq.${slug}&created_at=gte.${thirtyDaysAgo}&select=status,entry_type,title`, { headers: h }),
          fetch(`${SUPABASE_URL}/rest/v1/proactive_alerts?user_id=eq.${uid}&agent_slug=eq.${slug}&created_at=gte.${thirtyDaysAgo}&select=alert_type,priority,feedback`, { headers: h }),
          fetch(`${SUPABASE_URL}/rest/v1/agent_journal?user_id=eq.${uid}&agent_slug=eq.${slug}&created_at=gte.${thirtyDaysAgo}&select=entry&order=created_at.desc&limit=10`, { headers: h }),
        ]);

        const tasks = tasksRes.ok ? (await tasksRes.json() as any[]) : [];
        const suggestions = suggestionsRes.ok ? (await suggestionsRes.json() as any[]) : [];
        const alerts = alertsRes.ok ? (await alertsRes.json() as any[]) : [];
        const journal = journalRes.ok ? (await journalRes.json() as any[]) : [];

        // Only generate refinements if there's meaningful data to analyze
        if (tasks.length < 3 && alerts.length < 3) continue;

        // Compute metrics
        const completed = tasks.filter(t => t.status === "completed");
        const failed = tasks.filter(t => t.status === "failed");
        const retried = tasks.filter(t => (t.retry_count ?? 0) > 0);
        const approvedSugg = suggestions.filter(s => s.status === "approved");
        const dismissedSugg = suggestions.filter(s => s.status === "dismissed");
        const noisyAlerts = alerts.filter(a => a.feedback === "noise");
        const usefulAlerts = alerts.filter(a => a.feedback === "useful");

        const failedTypes = [...new Set(failed.map((t: any) => t.task_type).filter(Boolean))].slice(0, 5);
        const noisyTypes = [...new Set(noisyAlerts.map((a: any) => a.alert_type).filter(Boolean))].slice(0, 5);
        const recentJournal = journal.map((j: any) => j.entry?.slice(0, 150) ?? "").filter(Boolean).slice(0, 3).join(" | ");

        const metricsBlock = `AGENT: ${name} (${role})
TASK COMPLETION: ${completed.length}/${tasks.length} completed, ${failed.length} failed, ${retried.length} retried
FAILED TASK TYPES: ${failedTypes.join(", ") || "none"}
SUGGESTION APPROVAL: ${approvedSugg.length} approved, ${dismissedSugg.length} dismissed of ${suggestions.length} total
ALERT NOISE: ${noisyAlerts.length} marked noise, ${usefulAlerts.length} marked useful of ${alerts.length} total
NOISY ALERT TYPES: ${noisyTypes.join(", ") || "none"}
RECENT JOURNAL ENTRIES: ${recentJournal || "none"}

CURRENT SYSTEM PROMPT (first 800 chars):
${(system_prompt ?? "").slice(0, 800)}`;

        const SYSTEM = `You are a system prompt improvement analyst for an AI agent in a sovereign AI stack.

Based on agent performance metrics, identify 2-4 specific, actionable refinements to improve the agent's system prompt. Focus on:
- Reducing failure patterns (failed tasks of specific types)
- Reducing noise in alerts (if certain alert types are consistently marked "noise")
- Improving suggestion quality (high dismissal rate = something is off)
- Reinforcing what's working (high approval rate = keep doing that)

Format your response as a numbered list. Each refinement must be:
1. Specific (not generic like "be more accurate")
2. Actionable (could be added as a sentence or instruction to the system prompt)
3. Evidence-based (reference the actual metric that motivated it)

Example: "1. Add instruction to avoid generating deadline alerts for tasks that have no explicit due_date field set, as these are consistently marked noise (5/6 deadline alerts noise-rated)."

Write the refinements only. No preamble. No conclusion. Max 4 refinements.`;

        const refinement = await gemini(GOOGLE_KEY, SYSTEM, metricsBlock, 600);
        if (!refinement || refinement.length < 20) continue;

        // Queue as dossier_suggestion type prompt_refinement
        await fetch(`${SUPABASE_URL}/rest/v1/dossier_suggestions`, {
          method: "POST",
          headers: { ...h, Prefer: "return=minimal" },
          body: JSON.stringify({
            user_id: uid,
            agent_slug: slug,
            entry_type: "prompt_refinement",
            title: `Weekly self-improvement: ${name} system prompt refinements`,
            context: `Based on last 30 days: ${tasks.length} tasks (${completed.length} completed, ${failed.length} failed), ${noisyAlerts.length}/${alerts.length} alerts marked noise, ${approvedSugg.length}/${suggestions.length} suggestions approved.\n\n${refinement}`,
            importance: "medium",
            status: "pending",
          }),
        });

        // Write cross-memory so other agents know refinement was generated
        await fetch(`${SUPABASE_URL}/rest/v1/agent_cross_memory`, {
          method: "POST",
          headers: { ...h, Prefer: "return=minimal" },
          body: JSON.stringify({
            user_id: uid,
            source_agent: slug,
            summary: `Weekly self-review complete. Performance: ${completed.length}/${tasks.length} tasks completed, ${noisyAlerts.length} noise alerts. Refinement proposals queued for operator review.`,
            topic: "self_improvement",
          }),
        });

        refinementsQueued.push({ agent: slug, refinement: refinement.slice(0, 200) });

      } catch (e) {
        console.error(`[self_improve] error for ${slug}:`, e);
      }
    }

    // Push Telegram summary if refinements were generated
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
    const chatId = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
    if (botToken && chatId && refinementsQueued.length > 0) {
      const lines = refinementsQueued.map(r => `• *${r.agent.toUpperCase()}*: refinements queued`).join("\n");
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `🔧 *Weekly Agent Self-Improvement*\n\n${lines}\n\nReview and approve in Dossier → Suggestions.`,
          parse_mode: "Markdown",
        }),
      }).catch(() => {});
    }

    return new Response(
      JSON.stringify({ ok: true, agents_analyzed: AGENTS.length, refinements_queued: refinementsQueued.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (e) {
    console.error("[self_improve]", e);
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
