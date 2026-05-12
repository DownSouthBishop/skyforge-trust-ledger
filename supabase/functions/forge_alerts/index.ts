// Daily proactive signal engine.
// Runs once a day, checks for deviations, writes Atlas-voice alerts.
// Signals: velocity_drop, aging_pipeline, goal_behind, missed_pattern,
//          crm_overdue, week_zero, on_pace, streak_risk

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const FAST_MODEL = "google/gemini-2.5-flash-lite";

interface Signal {
  type: string;
  data: Record<string, unknown>;
  prompt_context: string;
}

function detectSignals(ctx: any): Signal[] {
  const signals: Signal[] = [];

  const incomeWeek = Number(ctx.income_week ?? 0);
  const incomeMonth = Number(ctx.income_month ?? 0);
  const trajectory = ctx.trajectory ?? {};
  const monthlyGoal = Number(trajectory.monthly_goal ?? 0);
  const onPace = trajectory.on_pace ?? false;
  const gap = Number(trajectory.gap ?? 0);
  const perDayNeeded = Number(trajectory.per_day_needed ?? 0);
  const daysRemaining = Number(trajectory.days_remaining ?? 0);
  const openCommitments = Array.isArray(ctx.open_commitments) ? ctx.open_commitments : [];
  const missedCommitments = Array.isArray(ctx.missed_commitments) ? ctx.missed_commitments : [];
  const pipeline = Array.isArray(ctx.pipeline) ? ctx.pipeline : [];
  const crm = Array.isArray(ctx.crm_opportunities) ? ctx.crm_opportunities : [];
  const streak = Number(ctx.current_streak ?? 0);
  const goals = Array.isArray(ctx.active_goals) ? ctx.active_goals : [];

  // week_zero: no income logged this week at all and it's past Monday
  const dayOfWeek = new Date().getDay(); // 0=Sun, 1=Mon ...
  if (incomeWeek === 0 && dayOfWeek >= 2) {
    signals.push({
      type: "week_zero",
      data: { income_week: 0, day_of_week: dayOfWeek },
      prompt_context: `Zero income logged this week. It is ${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][dayOfWeek]}.`,
    });
  }

  // goal_behind: monthly goal exists, not on pace, gap significant, time running out
  if (monthlyGoal > 0 && !onPace && gap > 0 && daysRemaining <= 20) {
    const pct = Math.round((incomeMonth / monthlyGoal) * 100);
    signals.push({
      type: "goal_behind",
      data: { monthly_goal: monthlyGoal, income_month: incomeMonth, gap, per_day_needed: perDayNeeded, days_remaining: daysRemaining, pct },
      prompt_context: `Monthly goal: $${monthlyGoal.toLocaleString()}. Current: $${incomeMonth.toLocaleString()} (${pct}%). Gap: $${gap.toLocaleString()} in ${daysRemaining} days = $${Math.round(perDayNeeded)}/day needed.`,
    });
  }

  // on_pace: monthly goal exists and projected to exceed it — worth calling out
  if (monthlyGoal > 0 && onPace && daysRemaining <= 15) {
    const projected = Number(trajectory.projected_end ?? 0);
    signals.push({
      type: "on_pace",
      data: { monthly_goal: monthlyGoal, projected_end: projected, days_remaining: daysRemaining },
      prompt_context: `On pace to hit monthly goal. Projected: $${Math.round(projected).toLocaleString()} vs $${monthlyGoal.toLocaleString()} goal. ${daysRemaining} days remaining.`,
    });
  }

  // aging_pipeline: pipeline item older than 21 days with no movement
  const agingItems = pipeline.filter((p: any) => {
    const age = Math.floor((Date.now() - new Date(p.created_at).getTime()) / 86400000);
    return age >= 21 && p.stage !== "won" && p.stage !== "lost";
  });
  if (agingItems.length > 0) {
    const oldest = agingItems.sort((a: any, b: any) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )[0];
    const age = Math.floor((Date.now() - new Date(oldest.created_at).getTime()) / 86400000);
    signals.push({
      type: "aging_pipeline",
      data: { item: oldest.description, stage: oldest.stage, value: oldest.estimated_value, age_days: age, count: agingItems.length },
      prompt_context: `${agingItems.length} pipeline item(s) stale. Oldest: "${oldest.description}" — $${Number(oldest.estimated_value ?? 0).toLocaleString()} at ${oldest.stage}, ${age} days with no movement.`,
    });
  }

  // missed_pattern: 2+ missed commitments in last 30 days
  if (missedCommitments.length >= 2) {
    signals.push({
      type: "missed_pattern",
      data: { count: missedCommitments.length, recent: missedCommitments.slice(0, 2).map((c: any) => c.description) },
      prompt_context: `${missedCommitments.length} missed commitments in the last 30 days. Recent: "${missedCommitments[0]?.description}", "${missedCommitments[1]?.description}".`,
    });
  }

  // crm_overdue: someone hasn't been contacted in 30+ days
  const overdueContact = crm.find((c: any) => Number(c.days_since_contact ?? 0) >= 30);
  if (overdueContact) {
    signals.push({
      type: "crm_overdue",
      data: { client: overdueContact.client_name, days: overdueContact.days_since_contact },
      prompt_context: `${overdueContact.client_name} hasn't been contacted in ${overdueContact.days_since_contact} days.`,
    });
  }

  // streak_risk: streak >= 3 but no income logged today
  const incomeToday = Number(ctx.income_today ?? 0);
  if (streak >= 3 && incomeToday === 0) {
    const hour = new Date().getHours();
    if (hour >= 15) { // only flag after 3pm
      signals.push({
        type: "streak_risk",
        data: { streak, income_today: 0 },
        prompt_context: `${streak}-day streak at risk — nothing logged today and it's past 3pm.`,
      });
    }
  }

  return signals;
}

async function generateAlertMessage(
  signal: Signal,
  ctx: any,
  apiKey: string,
): Promise<string | null> {
  const name = ctx.full_name ?? "Operator";
  const bottleneck = ctx.bottleneck ?? "unknown";

  const prompt = `You are Atlas. Generate one short, direct alert message for ${name}.

Signal: ${signal.type}
Context: ${signal.prompt_context}
Bottleneck: ${bottleneck}

Rules:
- Under 20 words
- Atlas voice: direct, grounded, no fluff
- Reference the specific number or situation
- No generic advice
- Do not start with "You" or "Hey"
- Return raw JSON only: {"message": "..."}`;

  const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: FAST_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 100,
    }),
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
  try {
    const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return parsed.message ?? null;
  } catch {
    return null;
  }
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
      // Skip if alerts already generated today
      const today = new Date().toISOString().slice(0, 10);
      const existingResp = await fetch(
        `${SUPABASE_URL}/rest/v1/forge_alerts?user_id=eq.${p.user_id}&created_at=gte.${today}T00:00:00&select=id`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
      );
      const existing = await existingResp.json();
      if (Array.isArray(existing) && existing.length > 0) continue;

      // Get full context
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

      const signals = detectSignals(ctx);
      if (signals.length === 0) continue;

      // Generate messages in parallel (up to 3 signals)
      const top = signals.slice(0, 3);
      const messages = await Promise.all(
        top.map((s) => generateAlertMessage(s, ctx, LOVABLE_API_KEY))
      );

      // Insert alerts
      const toInsert = top
        .map((s, i) => ({
          user_id: p.user_id,
          signal_type: s.type,
          message: messages[i] ?? s.prompt_context,
          data: s.data,
        }))
        .filter((a) => a.message);

      if (toInsert.length > 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
          method: "POST",
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify(toInsert),
        });
        generated += toInsert.length;
      }
    } catch (e) {
      console.error("forge_alerts user error", p.user_id, e);
    }
  }

  return new Response(JSON.stringify({ generated, total: profiles.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
