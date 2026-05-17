// Atlas Noon Check — daily deficit alert at 12:00 UTC
// If income < 50% of $100 target by noon, fires prioritized action recommendations.

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv, resolveUserIds } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

const FAST_MODEL = () => modelEnv("FAST_MODEL", "google/gemini-2.5-flash-lite");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("LOVABLE_API_KEY");

    const { user_id: rawUserId } = await req.json();
    if (!rawUserId) {
      return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });
    }

    const userIds = await resolveUserIds(SUPABASE_URL, SERVICE_KEY, rawUserId);
    if (userIds.length === 0) {
      return new Response(JSON.stringify({ message: "No users found" }), { headers: corsHeaders });
    }
    const user_id = userIds[0];

    // Fetch income velocity
    const velRes = await fetch(`${SUPABASE_URL}/functions/v1/atlas_income_velocity`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id }),
    });

    if (!velRes.ok) {
      return new Response(JSON.stringify({ message: "Income velocity unavailable" }), { headers: corsHeaders });
    }

    const vel = await velRes.json() as {
      realised_total: number;
      daily_target: number;
      gap: number;
      pct_to_target: number;
      velocity_status: string;
      trading_hours_left: number;
      rate_needed_per_hour: number;
      breakdown: Record<string, number>;
    };

    // Only fire alert if behind — skip if on track or ahead
    if (vel.velocity_status === "ahead" || vel.velocity_status === "on_track") {
      return new Response(JSON.stringify({
        status: "on_track",
        message: `$${vel.realised_total.toFixed(0)} / $${vel.daily_target} — no action needed`,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const baseHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    // Fetch open opportunities across all verticals
    const [watchlistRes, businessTasksRes, forexScanRes, pipelineRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/market_watchlist?user_id=eq.${user_id}&is_active=eq.true&select=symbol,asset_class,alert_price_high,alert_price_low`,
        { headers: baseHeaders },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/business_tasks?user_id=eq.${user_id}&status=eq.queued&select=task_type,subject,scheduled_for&limit=5`,
        { headers: baseHeaders },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/research_notes?user_id=eq.${user_id}&note_type=eq.research&symbol=eq.FOREX_SCAN&order=created_at.desc&limit=1&select=content`,
        { headers: baseHeaders },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/business_pipeline?user_id=eq.${user_id}&stage=in.(prospect,outreach,follow_up)&next_action_due=lte.${new Date().toISOString()}&select=contact_name,company,opportunity,estimated_value_usd&limit=5`,
        { headers: baseHeaders },
      ),
    ]);

    const watchlist = watchlistRes.ok ? await watchlistRes.json() : [];
    const businessTasks = businessTasksRes.ok ? await businessTasksRes.json() : [];
    const forexScan: Array<{ content: string }> = forexScanRes.ok ? await forexScanRes.json() : [];
    const pipeline = pipelineRes.ok ? await pipelineRes.json() : [];

    const prompt = `You are Atlas. It is noon and the operator is behind on their $${vel.daily_target}/day income target.

INCOME STATUS:
Realised today: $${vel.realised_total.toFixed(2)} / $${vel.daily_target} target
Gap remaining: $${vel.gap.toFixed(2)}
Trading hours left: ${vel.trading_hours_left}h
Rate needed: $${vel.rate_needed_per_hour.toFixed(2)}/hr

BREAKDOWN:
Trading P&L realised: $${vel.breakdown.trading_realised_pnl?.toFixed(2) ?? "0"}
Business revenue: $${vel.breakdown.business_revenue?.toFixed(2) ?? "0"}
RE rent: $${vel.breakdown.re_rent?.toFixed(2) ?? "0"}

AVAILABLE LEVERS:
Watchlist (${(watchlist as unknown[]).length} symbols): ${(watchlist as Array<{symbol:string;asset_class:string}>).slice(0, 5).map(w => w.symbol).join(", ") || "empty"}
Latest forex scan: ${forexScan[0]?.content?.slice(0, 300) ?? "none"}
Business pipeline due: ${(pipeline as Array<{contact_name:string;estimated_value_usd:number|null}>).map(p => `${p.contact_name} ($${p.estimated_value_usd ?? "?"})`).join(", ") || "none"}
Business tasks queued: ${(businessTasks as Array<{task_type:string;subject:string}>).map(t => t.subject.slice(0, 40)).join(", ") || "none"}

Give exactly 3 specific, ranked action items the operator can take RIGHT NOW to close the $${vel.gap.toFixed(0)} gap before market close. Be specific — name instruments, contacts, or exact actions. Format: ACTION → EXPECTED INCOME → WHY NOW. One sentence per action. No hedging.`;

    const aiResp = await callGatewayWithRetry(
      { model: FAST_MODEL(), messages: [{ role: "user", content: prompt }], max_tokens: 400 },
      API_KEY,
    );

    const aiData = aiResp.ok ? await aiResp.json() : null;
    const recommendations: string = aiData?.choices?.[0]?.message?.content ?? "Review watchlist and execute top-rated forex signal for target recovery.";

    // Fire Telegram alert
    const urgencyLabel = vel.velocity_status === "critical" ? "🔴 CRITICAL" : "🟡 BEHIND";
    await sendTelegramAlert(
      `*NOON CHECK — ${urgencyLabel}*\n$${vel.realised_total.toFixed(0)} / $${vel.daily_target} target (${vel.pct_to_target.toFixed(0)}%)\nGap: $${vel.gap.toFixed(0)} | ${vel.trading_hours_left}h left\n\n${recommendations}`,
    );

    // Log to forge_alerts
    await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id,
        signal_type: "income_deficit",
        message: `NOON CHECK: $${vel.realised_total.toFixed(0)} / $${vel.daily_target} (${vel.pct_to_target.toFixed(0)}%). Gap: $${vel.gap.toFixed(0)} — ${recommendations.slice(0, 200)}`,
      }),
    });

    return new Response(JSON.stringify({
      status: vel.velocity_status,
      realised: vel.realised_total,
      gap: vel.gap,
      recommendations,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[atlas_noon_check] Error:", msg);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
