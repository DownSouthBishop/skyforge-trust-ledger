// system_health — weekly system status report pushed to Telegram.
// Checks: agent task completion rates, alert noise, dossier approval rates,
// journal activity, whether daily_brief has been running.
// Runs Sunday 4am via pg_cron.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const AGENTS = ["atlas", "janus", "linda", "izzy"] as const;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
    const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

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

    const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const cutoff2d = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    // Fetch all health data in parallel
    const [tasksRes, alertsRes, suggestionsRes, journalRes, briefRes, retryRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/agent_tasks?user_id=eq.${uid}&created_at=gte.${cutoff7d}&select=agent_slug,status,retry_count`,
        { headers: h },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/proactive_alerts?user_id=eq.${uid}&created_at=gte.${cutoff7d}&select=agent_slug,alert_type,feedback,priority`,
        { headers: h },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/dossier_suggestions?user_id=eq.${uid}&created_at=gte.${cutoff7d}&select=agent_slug,entry_type,status`,
        { headers: h },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/agent_journal?user_id=eq.${uid}&created_at=gte.${cutoff7d}&select=agent_slug`,
        { headers: h },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/dossier_suggestions?user_id=eq.${uid}&entry_type=eq.market_brief&created_at=gte.${cutoff2d}&select=id&limit=1`,
        { headers: h },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/agent_tasks?user_id=eq.${uid}&created_at=gte.${cutoff7d}&retry_count=gte.1&select=agent_slug,retry_count,status`,
        { headers: h },
      ),
    ]);

    const tasks = tasksRes.ok ? (await tasksRes.json() as any[]) : [];
    const alerts = alertsRes.ok ? (await alertsRes.json() as any[]) : [];
    const suggestions = suggestionsRes.ok ? (await suggestionsRes.json() as any[]) : [];
    const journal = journalRes.ok ? (await journalRes.json() as any[]) : [];
    const briefCheck = briefRes.ok ? (await briefRes.json() as any[]) : [];
    const retriedTasks = retryRes.ok ? (await retryRes.json() as any[]) : [];

    // Compute health metrics
    const taskTotal = tasks.length;
    const taskCompleted = tasks.filter(t => t.status === "completed").length;
    const taskFailed = tasks.filter(t => t.status === "failed").length;
    const taskCompletionRate = taskTotal > 0 ? Math.round((taskCompleted / taskTotal) * 100) : 0;

    const alertTotal = alerts.length;
    const alertNoise = alerts.filter(a => a.feedback === "noise").length;
    const alertUseful = alerts.filter(a => a.feedback === "useful").length;
    const noiseRate = alertTotal > 0 ? Math.round((alertNoise / alertTotal) * 100) : 0;

    const suggTotal = suggestions.length;
    const suggApproved = suggestions.filter(s => s.status === "approved").length;
    const suggDismissed = suggestions.filter(s => s.status === "dismissed").length;
    const approvalRate = suggTotal > 0 ? Math.round((suggApproved / suggTotal) * 100) : 0;

    const journalCount = journal.length;
    const journalByAgent = AGENTS.reduce((acc, slug) => {
      acc[slug] = journal.filter(j => j.agent_slug === slug).length;
      return acc;
    }, {} as Record<string, number>);

    const briefRunning = briefCheck.length > 0;
    const retryCount = retriedTasks.length;

    // Task breakdown by agent
    const taskByAgent = AGENTS.map(slug => {
      const agentTasks = tasks.filter(t => t.agent_slug === slug);
      const done = agentTasks.filter(t => t.status === "completed").length;
      return `  ${slug}: ${done}/${agentTasks.length}`;
    }).join("\n");

    // Build health report
    const statusIcon = (rate: number) => rate >= 80 ? "✅" : rate >= 50 ? "⚠️" : "❌";

    const report = [
      `📊 *Weekly System Health — ${new Date().toISOString().split("T")[0]}*`,
      "",
      `*AGENT TASKS* (last 7 days)`,
      `${statusIcon(taskCompletionRate)} Completion: ${taskCompleted}/${taskTotal} (${taskCompletionRate}%)`,
      `  Failed: ${taskFailed} | Retried: ${retryCount}`,
      taskByAgent,
      "",
      `*ALERT QUALITY*`,
      `${alertTotal > 0 ? (noiseRate < 30 ? "✅" : noiseRate < 60 ? "⚠️" : "❌") : "—"} Noise rate: ${alertNoise}/${alertTotal} alerts marked noise (${noiseRate}%)`,
      `  Useful: ${alertUseful} | Unrated: ${alertTotal - alertNoise - alertUseful}`,
      "",
      `*DOSSIER SUGGESTIONS*`,
      `${suggTotal > 0 ? statusIcon(approvalRate) : "—"} Approval rate: ${suggApproved}/${suggTotal} (${approvalRate}%)`,
      `  Dismissed: ${suggDismissed} | Pending: ${suggTotal - suggApproved - suggDismissed}`,
      "",
      `*AGENT JOURNALS* (last 7 days)`,
      `${journalCount > 0 ? "✅" : "⚠️"} ${journalCount} entries total`,
      AGENTS.map(s => `  ${s}: ${journalByAgent[s]}`).join(" | "),
      "",
      `*DAILY BRIEF*`,
      briefRunning ? "✅ Fired in last 48 hours" : "❌ No brief in last 48 hours — check cron",
    ].join("\n");

    if (BOT_TOKEN && CHAT_ID) {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: report.slice(0, 4096),
          parse_mode: "Markdown",
        }),
      }).catch(() => {});
    }

    // Write to cross_memory
    await fetch(`${SUPABASE_URL}/rest/v1/agent_cross_memory`, {
      method: "POST",
      headers: { ...h, Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: uid,
        source_agent: "atlas",
        summary: `Weekly health report: ${taskCompleted}/${taskTotal} tasks completed (${taskCompletionRate}%), ${noiseRate}% alert noise, ${approvalRate}% dossier approval, daily brief ${briefRunning ? "active" : "MISSING"}.`,
        topic: "system_health",
      }),
    }).catch(() => {});

    return new Response(
      JSON.stringify({
        ok: true,
        metrics: {
          task_completion_rate: taskCompletionRate,
          alert_noise_rate: noiseRate,
          suggestion_approval_rate: approvalRate,
          journal_entries: journalCount,
          brief_running: briefRunning,
          tasks_retried: retryCount,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (e) {
    console.error("[system_health]", e);
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
