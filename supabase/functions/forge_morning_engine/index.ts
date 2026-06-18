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

const FAST_MODEL = () => modelEnv("FAST_MODEL", "google/gemini-2.0-flash-lite");

function buildMorningPrompt(context: any, stage: number): string {
  const name = context.full_name ?? "Operator";
  const dossier = context.dossier ?? {};
  const openCommitments = Array.isArray(context.open_commitments) ? context.open_commitments : [];
  const businesses = Array.isArray(dossier.businesses) ? dossier.businesses : [];
  const tradingGoals = dossier.trading_goals ?? "";
  const currentFocus = dossier.current_focus ?? "";
  const trajectory = context.trajectory_sentence ?? "";
  const avoidance = dossier.avoidance_pattern ?? "";

  const oldestCommitment = [...openCommitments].sort((a: any, b: any) =>
    new Date(a.made_at).getTime() - new Date(b.made_at).getTime()
  )[0];

  const contextLines = [
    trajectory ? `Trajectory: ${trajectory}` : "",
    tradingGoals ? `Trading goals: ${tradingGoals}` : "",
    currentFocus ? `Current focus: ${currentFocus}` : "",
    businesses.length > 0 ? `Businesses: ${businesses.map((b: any) => b.name).join(", ")}` : "",
    oldestCommitment
      ? `Oldest open commitment (${Math.floor((Date.now() - new Date(oldestCommitment.made_at).getTime()) / 86400000)}d): "${oldestCommitment.description}"`
      : "",
    avoidance && stage >= 2 ? `Avoidance pattern: ${avoidance}` : "",
    dossier.decision_pattern && stage >= 2 ? `Decision pattern: ${dossier.decision_pattern}` : "",
  ].filter(Boolean).join("\n");

  return `You are Atlas. Generate one directive sentence for ${name}'s day.

${contextLines}

Return raw JSON only: {"directive": "...", "confidence": 75}
Under 20 words. Specific to what's actually true about this person. Reference a commitment, a goal, a pattern, or what's in motion. Not generic advice.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = parseEnv("SUPABASE_URL");
  const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
  const API_KEY      = (Deno.env.get("GOOGLE_AI_KEY") ?? "");

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
