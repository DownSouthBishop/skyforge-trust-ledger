// Sunday auto-brief — Atlas writes a full week review waiting Monday morning.
// Stored in user_profiles.atlas_weekly_review + atlas_weekly_review_at.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ATLAS_MODEL = "openai/gpt-5";

function buildWeeklyReviewPrompt(ctx: any, weeklyData: any): string {
  const name = ctx.full_name ?? "Operator";
  const incomeWeek = Number(weeklyData.income_week ?? 0);
  const incomeLastWeek = Number(weeklyData.income_last_week ?? 0);
  const jobsThisWeek = Number(weeklyData.jobs_this_week ?? 0);
  const trend = incomeWeek > incomeLastWeek ? "up" : incomeWeek < incomeLastWeek ? "down" : "flat";
  const trendDelta = Math.abs(incomeWeek - incomeLastWeek);

  const trajectory = ctx.trajectory ?? {};
  const monthlyGoal = Number(trajectory.monthly_goal ?? 0);
  const incomeMonth = Number(ctx.income_month ?? 0);
  const onPace = trajectory.on_pace ?? false;
  const daysRemaining = Number(trajectory.days_remaining ?? 0);

  const dossier = ctx.dossier ?? {};
  const businesses = Array.isArray(dossier.businesses) ? dossier.businesses : [];
  const breakdown = Array.isArray(ctx.business_breakdown) ? ctx.business_breakdown : [];
  const openCommitments = Array.isArray(ctx.open_commitments) ? ctx.open_commitments : [];
  const missedCommitments = Array.isArray(ctx.missed_commitments) ? ctx.missed_commitments : [];
  const pipeline = Array.isArray(ctx.pipeline) ? ctx.pipeline : [];
  const goals = Array.isArray(ctx.active_goals) ? ctx.active_goals : [];
  const streak = Number(ctx.current_streak ?? 0);

  const keptThisWeek = Number(weeklyData.commitments_kept ?? 0);
  const missedThisWeek = Number(weeklyData.commitments_missed ?? 0);
  const followThrough = (keptThisWeek + missedThisWeek) > 0
    ? Math.round((keptThisWeek / (keptThisWeek + missedThisWeek)) * 100)
    : null;

  const topPipeline = pipeline.sort((a: any, b: any) =>
    (b.estimated_value ?? 0) - (a.estimated_value ?? 0)
  )[0];

  const businessLines = businesses.length > 0
    ? businesses.map((b: any) =>
        `  ${b.name}${b.phase ? " [" + b.phase + "]" : ""}${b.current_focus ? ": " + b.current_focus : ""}`
      ).join("\n")
    : "  No businesses tracked.";

  const breakdownLines = breakdown.slice(0, 5).map((b: any) =>
    `  ${b.vertical}: $${Number(b.total ?? 0).toLocaleString()} (${b.job_count} jobs)`
  ).join("\n");

  const goalLines = goals.map((g: any) => {
    const pct = g.target_amount > 0 ? Math.round((g.current_amount / g.target_amount) * 100) : 0;
    return `  ${g.label}: ${pct}% ($${Number(g.current_amount).toLocaleString()} of $${Number(g.target_amount).toLocaleString()})`;
  }).join("\n");

  const openCommitLines = openCommitments.slice(0, 5).map((c: any) => {
    const age = Math.floor((Date.now() - new Date(c.made_at).getTime()) / 86400000);
    return `  "${c.description}" — ${age}d open`;
  }).join("\n");

  return `You are Atlas. It's Sunday evening. Write ${name}'s weekly review brief — honest, specific, short. This is what they'll read Monday morning to orient themselves.

THE WEEK IN NUMBERS:
Income this week: $${incomeWeek.toLocaleString()} (${jobsThisWeek} jobs) | Last week: $${incomeLastWeek.toLocaleString()} — ${trend}${trendDelta > 0 ? ` $${trendDelta.toLocaleString()}` : ""}
Month-to-date: $${incomeMonth.toLocaleString()}${monthlyGoal > 0 ? ` vs $${monthlyGoal.toLocaleString()} goal (${onPace ? "on pace" : "behind"}, ${daysRemaining}d left)` : ""}
Streak: ${streak}d

30-day income breakdown:
${breakdownLines || "  No vertical data."}

Active businesses:
${businessLines}

${goalLines ? "Goals:\n" + goalLines : ""}

Follow-through this week: ${followThrough !== null ? followThrough + "%" : "No commitments resolved"}
${missedThisWeek > 0 ? `Missed: ${missedThisWeek} commitment(s)` : ""}
${openCommitLines ? "Still open:\n" + openCommitLines : "No open commitments."}

${topPipeline ? `Highest pipeline item: "${topPipeline.description}" — $${Number(topPipeline.estimated_value ?? 0).toLocaleString()} [${topPipeline.stage}]` : ""}

${dossier.avoidance_pattern ? "Avoidance pattern: " + dossier.avoidance_pattern : ""}
${dossier.current_focus ? "Current focus: " + dossier.current_focus : ""}

Write a weekly brief with these sections (no headers, just short paragraphs):
1. What the week said — interpret the numbers honestly. Not cheerleading, not doom. What actually happened?
2. What needs attention Monday — one or two specific things. Name them.
3. One strategic observation — something you notice about the arc, not just this week.

Keep it under 150 words total. Atlas voice: direct, grounded, no filler. Write to someone who can handle the truth.

Return raw JSON only: {"review": "..."}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

  if (!LOVABLE_API_KEY) {
    return new Response(JSON.stringify({ error: "LOVABLE_API_KEY missing" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const profilesResp = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?select=user_id`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  const profiles: { user_id: string }[] = await profilesResp.json();

  let generated = 0;

  for (const p of profiles) {
    try {
      // Fetch full context
      const ctxResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_forge_context`, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ _user_id: p.user_id }),
      });
      const ctx = await ctxResp.json();

      // Fetch week-specific data
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - 7);
      const weekStartStr = weekStart.toISOString();
      const twoWeeksAgoStr = new Date(weekStart.getTime() - 7 * 86400000).toISOString();

      const [incomeThisWeekResp, incomeLastWeekResp, commitsResp] = await Promise.all([
        fetch(
          `${SUPABASE_URL}/rest/v1/receipts_ledger?provider_id=eq.${p.user_id}&created_at=gte.${weekStartStr}&select=action_value_usd`,
          { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
        ),
        fetch(
          `${SUPABASE_URL}/rest/v1/receipts_ledger?provider_id=eq.${p.user_id}&created_at=gte.${twoWeeksAgoStr}&created_at=lt.${weekStartStr}&select=action_value_usd`,
          { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
        ),
        fetch(
          `${SUPABASE_URL}/rest/v1/forge_commitments?user_id=eq.${p.user_id}&resolved_at=gte.${weekStartStr}&select=resolution_status`,
          { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
        ),
      ]);

      const thisWeekRows: any[] = await incomeThisWeekResp.json();
      const lastWeekRows: any[] = await incomeLastWeekResp.json();
      const commitsRows: any[] = await commitsResp.json();

      const income_week = thisWeekRows.reduce((s: number, r: any) => s + Number(r.action_value_usd ?? 0), 0);
      const income_last_week = lastWeekRows.reduce((s: number, r: any) => s + Number(r.action_value_usd ?? 0), 0);
      const commitments_kept = commitsRows.filter((c: any) => c.resolution_status === "kept").length;
      const commitments_missed = commitsRows.filter((c: any) => c.resolution_status === "missed").length;

      const weeklyData = {
        income_week,
        income_last_week,
        jobs_this_week: thisWeekRows.length,
        commitments_kept,
        commitments_missed,
      };

      const prompt = buildWeeklyReviewPrompt(ctx, weeklyData);

      const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: ATLAS_MODEL,
          messages: [{ role: "user", content: prompt }],
          max_completion_tokens: 400,
        }),
      });

      if (!resp.ok) {
        console.error("weekly review AI error", resp.status, await resp.text());
        continue;
      }

      const data = await resp.json();
      const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
      let review: string | null = null;
      try {
        const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
        review = JSON.parse(cleaned).review ?? null;
      } catch {
        review = null;
      }

      if (!review) continue;

      // Store on user_profiles
      await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?user_id=eq.${p.user_id}`,
        {
          method: "PATCH",
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            atlas_weekly_review: review,
            atlas_weekly_review_at: new Date().toISOString(),
          }),
        },
      );

      generated++;
    } catch (e) {
      console.error("weekly review user error", p.user_id, e);
    }
  }

  return new Response(JSON.stringify({ generated, total: profiles.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
