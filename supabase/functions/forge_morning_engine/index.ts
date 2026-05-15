// Daily 6am engine — generates a morning directive per operator.
// Stage 1: data-grounded, shows you looked at the numbers.
// Stage 2: references observed patterns and open items.
// Stage 3: a genuine strategic brief from someone who knows you.
// Uses ON CONFLICT DO NOTHING for deduplication — safe under concurrent execution.

import {
  corsHeaders,
  callGatewayWithRetry,
  parseEnv,
  modelEnv,
} from "../_shared/gateway.ts";

const FAST_MODEL = () => modelEnv("FAST_MODEL", "google/gemini-2.5-flash");

function buildMorningPrompt(context: any, stage: number): string {
  const name = context.full_name ?? "Operator";
  const bottleneck = context.bottleneck ?? "unknown";
  const streak = context.current_streak ?? 0;
  const incomeToday = Number(context.income_today ?? 0);
  const incomeWeek = Number(context.income_week ?? 0);
  const incomeMonth = Number(context.income_month ?? 0);
  const trajectory = context.trajectory_sentence ?? "";

  const pipeline = Array.isArray(context.pipeline) ? context.pipeline : [];
  const goals = Array.isArray(context.active_goals) ? context.active_goals : [];
  const crm = Array.isArray(context.crm_opportunities) ? context.crm_opportunities : [];
  const openCommitments = Array.isArray(context.open_commitments) ? context.open_commitments : [];
  const missedCommitments = Array.isArray(context.missed_commitments) ? context.missed_commitments : [];
  const dossier = context.dossier ?? {};
  const businesses = Array.isArray(dossier.businesses) ? dossier.businesses : [];
  const ideas = Array.isArray(dossier.active_ideas) ? dossier.active_ideas : [];
  const breakdown = Array.isArray(context.business_breakdown) ? context.business_breakdown : [];

  const atRiskGoal = goals.find((g: any) => g.target_amount > 0 && (g.current_amount / g.target_amount) < 0.5);
  const topPipeline = [...pipeline].sort((a: any, b: any) => (b.estimated_value ?? 0) - (a.estimated_value ?? 0))[0];
  const topCrm = [...crm].sort((a: any, b: any) => (b.days_since_contact ?? 0) - (a.days_since_contact ?? 0))[0];
  const oldestCommitment = [...openCommitments].sort((a: any, b: any) =>
    new Date(a.made_at).getTime() - new Date(b.made_at).getTime()
  )[0];

  if (stage === 1) {
    const statLine = [
      `Income this week: $${incomeWeek.toLocaleString()}`,
      incomeMonth > 0 ? `month: $${incomeMonth.toLocaleString()}` : null,
      streak > 0 ? `streak: ${streak}d` : null,
      `bottleneck: ${bottleneck}`,
    ].filter(Boolean).join(" | ");

    const oppLine = topCrm
      ? `Top follow-up: ${topCrm.client_name} — ${topCrm.days_since_contact ?? "?"} days since last contact.`
      : topPipeline
      ? `Pipeline: "${topPipeline.description}" — $${Number(topPipeline.estimated_value ?? 0).toLocaleString()} at ${topPipeline.stage}.`
      : "";

    return `You are Atlas. Generate one directive sentence for today based on this operator's data.

${statLine}
${oppLine}
${trajectory ? `Trajectory: ${trajectory}` : ""}

Return raw JSON only: {"directive": "...", "confidence": 75}
The directive must be specific to their actual numbers — not generic advice. Under 20 words. Direct.`;
  }

  if (stage === 2) {
    const patterns = [
      dossier.avoidance_pattern ? `Avoidance pattern: ${dossier.avoidance_pattern}` : null,
      dossier.follow_through_pattern ? `Follow-through: ${dossier.follow_through_pattern}` : null,
      dossier.current_focus ? `Current focus: ${dossier.current_focus}` : null,
    ].filter(Boolean).join("\n");

    const commitmentLine = oldestCommitment
      ? `Open commitment (${Math.floor((Date.now() - new Date(oldestCommitment.made_at).getTime()) / 86400000)}d): "${oldestCommitment.description}"`
      : "";

    const businessLine = businesses.length > 0
      ? `Businesses: ${businesses.map((b: any) => b.name).join(", ")}`
      : "";

    return `You are Atlas. You've been working with ${name} for a while. Generate one directive for today that shows you've been paying attention — not a stat dump, something that connects to their pattern.

Stats: income this week $${incomeWeek.toLocaleString()}, month $${incomeMonth.toLocaleString()}, bottleneck: ${bottleneck}
${patterns}
${commitmentLine}
${businessLine}
${atRiskGoal ? `Goal at risk: ${atRiskGoal.label} — ${Math.round((atRiskGoal.current_amount / atRiskGoal.target_amount) * 100)}% of target` : ""}
${topPipeline ? `Top pipeline: "${topPipeline.description}" $${Number(topPipeline.estimated_value ?? 0).toLocaleString()} [${topPipeline.stage}]` : ""}

Return raw JSON only: {"directive": "...", "confidence": 80}
Under 25 words. Reference something specific — a pattern, an open item, what's actually in motion. Not generic.`;
  }

  // Stage 3
  const businessLines = businesses.length > 0
    ? businesses.map((b: any) =>
        `  ${b.name}${b.phase ? " [" + b.phase + "]" : ""}${b.current_focus ? ": " + b.current_focus : ""}`
      ).join("\n")
    : "  No businesses tracked yet.";

  const ideaLines = ideas.length > 0
    ? ideas.map((i: any) => `  "${i.name}" [${i.stage ?? "raw"}]${i.notes ? ": " + i.notes : ""}`).join("\n")
    : "";

  const commitmentLines = openCommitments.slice(0, 3).map((c: any) => {
    const days = Math.floor((Date.now() - new Date(c.made_at).getTime()) / 86400000);
    return `  "${c.description}" — ${days}d open`;
  }).join("\n");

  const missedLine = missedCommitments.length > 0
    ? `Didn't follow through on: "${missedCommitments[0].description}"`
    : "";

  const breakdownLine = breakdown.slice(0, 3).map((b: any) =>
    `  ${b.vertical}: $${Number(b.total).toLocaleString()} (${b.job_count} jobs)`
  ).join("\n");

  return `You are Atlas. You know ${name} well. This is your morning brief — write a directive that sounds like it came from someone who thought about them specifically before they woke up.

WHAT YOU KNOW:
Income this week: $${incomeWeek.toLocaleString()} | month: $${incomeMonth.toLocaleString()} | today: $${incomeToday.toLocaleString()}
Bottleneck: ${bottleneck} | Streak: ${streak}d
${trajectory ? "Trajectory: " + trajectory : ""}

30-day breakdown by business:
${breakdownLine || "  No vertical data yet."}

Active businesses:
${businessLines}

${ideaLines ? "Ideas in motion:\n" + ideaLines + "\n" : ""}
${dossier.current_emotional_signal ? "Current emotional signal: " + dossier.current_emotional_signal : ""}
${dossier.avoidance_pattern ? "Avoidance pattern: " + dossier.avoidance_pattern : ""}
${dossier.follow_through_pattern ? "Follow-through pattern: " + dossier.follow_through_pattern : ""}
${dossier.money_beliefs ? "Money posture: " + dossier.money_beliefs : ""}

${commitmentLines ? "Open commitments:\n" + commitmentLines : ""}
${missedLine}

${atRiskGoal ? "Goal at risk: " + atRiskGoal.label + " — " + Math.round((atRiskGoal.current_amount / atRiskGoal.target_amount) * 100) + "% of target" : ""}
${topPipeline ? "Highest pipeline item: \"" + topPipeline.description + "\" $" + Number(topPipeline.estimated_value ?? 0).toLocaleString() + " [" + topPipeline.stage + "]" : ""}

Return raw JSON only: {"directive": "...", "confidence": 90}
Under 30 words. Draw from something specific above. This should feel like it came from someone who was thinking about them.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = parseEnv("SUPABASE_URL");
  const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
  const API_KEY      = parseEnv("LOVABLE_API_KEY");

  const profilesResp = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?select=user_id,atlas_relationship_stage`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  const profiles: { user_id: string; atlas_relationship_stage: number }[] = await profilesResp.json();

  let generated = 0;

  for (const p of profiles) {
    try {
      const ctxResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_forge_context`, {
        method: "POST",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ _user_id: p.user_id }),
      });
      const context = await ctxResp.json();
      const stage = p.atlas_relationship_stage ?? Number(context?.relationship_stage ?? 1);

      // Pull trading context to inject alongside income context
      const [acctResp, tradesResp] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/trading_accounts?user_id=eq.${p.user_id}&is_active=eq.true&select=broker,account_type,balance_usd`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        }),
        fetch(`${SUPABASE_URL}/rest/v1/trade_ledger?user_id=eq.${p.user_id}&status=eq.open&select=symbol,direction,entry_price,pnl_usd&limit=5`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        }),
      ]);
      const tradingAccounts = acctResp.ok ? await acctResp.json() : [];
      const openPositions = tradesResp.ok ? await tradesResp.json() : [];
      const totalCapital = tradingAccounts.reduce((s: number, a: any) => s + Number(a.balance_usd ?? 0), 0);
      const openPnl = openPositions.reduce((s: number, t: any) => s + Number(t.pnl_usd ?? 0), 0);

      const tradingContext = tradingAccounts.length > 0
        ? `\nTRADING ACCOUNTS: $${totalCapital.toLocaleString()} across ${tradingAccounts.length} broker(s). ` +
          (openPositions.length > 0
            ? `Open positions: ${openPositions.map((t: any) => `${t.symbol} ${t.direction}`).join(", ")}. Open P&L: ${openPnl >= 0 ? "+" : ""}$${openPnl.toFixed(2)}.`
            : "No open positions.")
        : "";

      const basePrompt = buildMorningPrompt(context, stage);
      const fullPrompt = tradingContext ? basePrompt.replace("Return raw JSON only:", tradingContext + "\n\nReturn raw JSON only:") : basePrompt;

      const result = await (async () => {
        const resp = await callGatewayWithRetry(
          {
            model: FAST_MODEL(),
            messages: [{ role: "user", content: fullPrompt }],
            max_completion_tokens: 200,
          },
          API_KEY,
        );
        if (!resp.ok) { console.error("morning engine AI error", resp.status); return null; }
        const data = await resp.json();
        const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
        try {
          return JSON.parse(raw.replace(/```json\s*|\s*```/g, "").trim());
        } catch { return null; }
      })();

      if (!result?.directive) continue;

      // ON CONFLICT DO NOTHING via unique index on (user_id, generated_date)
      await fetch(`${SUPABASE_URL}/rest/v1/forge_directives`, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=ignore-duplicates,return=minimal",
        },
        body: JSON.stringify({
          user_id:          p.user_id,
          directive:        result.directive,
          confidence_score: result.confidence ?? 75,
          generated_date:   new Date().toISOString().slice(0, 10),
        }),
      });
      generated++;
    } catch (e) {
      console.error("morning engine user error", p.user_id, e);
    }
  }

  return new Response(JSON.stringify({ generated, total: profiles.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
