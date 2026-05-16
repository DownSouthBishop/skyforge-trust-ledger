// Atlas Autonomous Loop — runs every 30 minutes during market hours (Mon-Fri 13-21 UTC)
// Processes queued atlas_tasks and executes overdue pipeline actions without human input.

import { corsHeaders, parseEnv, resolveUserIds } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    const { user_id: rawUserId } = await req.json();
    if (!rawUserId) {
      return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });
    }

    const userIds = await resolveUserIds(SUPABASE_URL, SERVICE_KEY, rawUserId);
    if (userIds.length === 0) {
      return new Response(JSON.stringify({ message: "No users found" }), { headers: corsHeaders });
    }

    const baseHdrs = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
    const summary: string[] = [];
    let actionsTotal = 0;

    for (const user_id of userIds) {
      const actions: string[] = [];

      // 1. Process queued opportunity_candidate tasks
      const tasksRes = await fetch(
        `${SUPABASE_URL}/rest/v1/atlas_tasks?user_id=eq.${user_id}&task_type=eq.opportunity_candidate&status=eq.queued&order=created_at.asc&limit=10`,
        { headers: baseHdrs },
      );
      const tasks: Array<{ id: string; payload: Record<string, unknown> }> = tasksRes.ok ? await tasksRes.json() : [];

      for (const task of tasks) {
        const p = task.payload;

        // Forex signals with confidence >= 70 → attempt execution
        if (p.asset_class === "forex" && p.symbol && p.direction && Number(p.confidence_pct ?? 0) >= 70) {
          try {
            const oandaKey = Deno.env.get("OANDA_API_KEY");
            const oandaEnv = Deno.env.get("OANDA_ENV") ?? "practice";
            const oandaBase = oandaEnv === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
            const instrument = (p.symbol as string).replace("/", "_").toUpperCase();
            let entryPrice: number | null = null;

            if (oandaKey) {
              const priceRes = await fetch(
                `${oandaBase}/v3/instruments/${instrument}/candles?count=1&granularity=S5&price=M`,
                { headers: { Authorization: `Bearer ${oandaKey}` } },
              );
              if (priceRes.ok) {
                const priceData = await priceRes.json();
                const close = priceData?.candles?.[0]?.mid?.c;
                if (close) entryPrice = parseFloat(close);
              }
            }

            if (entryPrice) {
              // 0.01 lot — stays under $200 auto-execute limit for major pairs
              const execRes = await fetch(`${SUPABASE_URL}/functions/v1/atlas_execute_trade`, {
                method: "POST",
                headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  user_id,
                  symbol: p.symbol,
                  asset_class: "forex",
                  direction: p.direction,
                  entry_price: entryPrice,
                  quantity: 0.01,
                  broker: "oanda",
                  thesis: `Autonomous — ${p.source} signal, confidence ${p.confidence_pct}%`,
                }),
              });
              const execData = execRes.ok ? await execRes.json() : { status: "error" };
              actions.push(`forex ${p.symbol} ${p.direction}: ${(execData as { status: string }).status}`);
            }
          } catch (e) {
            console.warn(`[atlas_autonomous_loop] Forex execution failed for ${p.symbol}:`, e);
          }
        }

        // Options opportunities → log to atlas_plays
        if (p.asset_class === "options" && p.symbol && p.strategy) {
          await fetch(`${SUPABASE_URL}/rest/v1/atlas_plays`, {
            method: "POST",
            headers: { ...baseHdrs, "Content-Type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify({
              user_id,
              symbol: p.symbol,
              asset_class: "options",
              direction: "long",
              thesis: `${p.strategy}: est. premium $${p.premium_estimate ?? "?"}`,
              atlas_score: 65,
              status: "active",
            }),
          });
          actions.push(`options ${p.symbol} ${p.strategy}: logged to plays`);
        }

        // Mark done regardless of execution result
        await fetch(`${SUPABASE_URL}/rest/v1/atlas_tasks?id=eq.${task.id}`, {
          method: "PATCH",
          headers: { ...baseHdrs, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ status: "done", completed_at: new Date().toISOString() }),
        });
      }

      // 2. Overdue pipeline contacts → queue outreach (avoid duplicates)
      const overdueRes = await fetch(
        `${SUPABASE_URL}/rest/v1/business_pipeline?user_id=eq.${user_id}&next_action_due=lt.${new Date().toISOString()}&stage=in.(outreach,follow_up)&select=id,contact_name,company,stage,opportunity&limit=5`,
        { headers: baseHdrs },
      );
      const overdue: Array<{ id: string; contact_name: string; company: string | null; stage: string; opportunity: string | null }> =
        overdueRes.ok ? await overdueRes.json() : [];

      for (const contact of overdue) {
        const existingRes = await fetch(
          `${SUPABASE_URL}/rest/v1/business_tasks?user_id=eq.${user_id}&pipeline_id=eq.${contact.id}&status=in.(queued,approved,sent)&limit=1`,
          { headers: baseHdrs },
        );
        const existing = existingRes.ok ? await existingRes.json() : [];
        if ((existing as unknown[]).length > 0) continue;

        const isFollowUp = contact.stage === "follow_up";
        const subject = `${isFollowUp ? "Following up" : "Quick note"} — ${contact.opportunity ?? "opportunity"}`;
        const body = `Hi ${contact.contact_name},\n\nI wanted to reach out regarding ${contact.opportunity ?? "our potential work together"}${contact.company ? ` at ${contact.company}` : ""}.\n\nWould you be open to a brief conversation this week?\n\nBest regards`;

        await fetch(`${SUPABASE_URL}/rest/v1/business_tasks`, {
          method: "POST",
          headers: { ...baseHdrs, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({
            user_id,
            task_type: "outreach",
            pipeline_id: contact.id,
            subject,
            body,
            status: "approved",
            scheduled_for: new Date().toISOString(),
          }),
        });
        actions.push(`queued ${contact.stage} for ${contact.contact_name}`);
      }

      // 3. Advance pipeline for contacts where outreach was sent
      const sentRes = await fetch(
        `${SUPABASE_URL}/rest/v1/business_tasks?user_id=eq.${user_id}&status=eq.sent&pipeline_id=not.is.null&select=id,pipeline_id&limit=10`,
        { headers: baseHdrs },
      );
      const sent: Array<{ id: string; pipeline_id: string }> = sentRes.ok ? await sentRes.json() : [];

      const stageMap: Record<string, string> = { prospect: "outreach", outreach: "follow_up", follow_up: "proposal" };

      for (const task of sent) {
        const pipeRes = await fetch(
          `${SUPABASE_URL}/rest/v1/business_pipeline?id=eq.${task.pipeline_id}&select=stage`,
          { headers: baseHdrs },
        );
        const pipeRows: Array<{ stage: string }> = pipeRes.ok ? await pipeRes.json() : [];
        if (pipeRows.length === 0 || !stageMap[pipeRows[0].stage]) continue;

        await fetch(`${SUPABASE_URL}/rest/v1/business_pipeline?id=eq.${task.pipeline_id}`, {
          method: "PATCH",
          headers: { ...baseHdrs, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ stage: stageMap[pipeRows[0].stage], last_contact_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
        });
        await fetch(`${SUPABASE_URL}/rest/v1/business_tasks?id=eq.${task.id}`, {
          method: "PATCH",
          headers: { ...baseHdrs, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ status: "done", completed_at: new Date().toISOString() }),
        });
        actions.push(`advanced pipeline → ${stageMap[pipeRows[0].stage]}`);
      }

      if (actions.length > 0) {
        actionsTotal += actions.length;
        summary.push(`${user_id.slice(0, 8)}: ${actions.join(", ")}`);
        await sendTelegramAlert(
          `*ATLAS LOOP*\n${actions.length} action${actions.length !== 1 ? "s" : ""}:\n${actions.map(a => `• ${a}`).join("\n")}`,
        );
      }
    }

    return new Response(JSON.stringify({ status: "ok", users_processed: userIds.length, actions_total: actionsTotal, summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
