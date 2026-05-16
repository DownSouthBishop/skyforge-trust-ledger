// Atlas Business Brief — weekly business intelligence report
// Phase 2B: runs every Monday at 09:00 UTC

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

const ATLAS_MODEL = () => modelEnv("ATLAS_MODEL", "openai/gpt-4o");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("LOVABLE_API_KEY");

    const { user_id } = await req.json();
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });
    }

    const baseHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const weekLabel = `${now.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

    // Pull data from all three tables
    const [pipelineRes, ledgerRes, tasksRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/business_pipeline?user_id=eq.${user_id}&stage=neq.closed_won&stage=neq.closed_lost&select=contact_name,company,opportunity,stage,estimated_value_usd,probability_pct,next_action_due,last_contact_at`,
        { headers: baseHeaders },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/business_ledger?user_id=eq.${user_id}&created_at=gte.${thirtyDaysAgo}&select=entry_type,category,description,amount_usd,status,recurring`,
        { headers: baseHeaders },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/business_tasks?user_id=eq.${user_id}&status=eq.queued&select=task_type,subject,scheduled_for`,
        { headers: baseHeaders },
      ),
    ]);

    const pipeline = pipelineRes.ok ? await pipelineRes.json() : [];
    const ledger   = ledgerRes.ok   ? await ledgerRes.json()   : [];
    const tasks    = tasksRes.ok    ? await tasksRes.json()    : [];

    // Compute financials
    const revenue  = (ledger as Array<{ entry_type: string; amount_usd: number; status: string }>)
      .filter((e) => e.entry_type === "revenue" && e.status === "paid")
      .reduce((s: number, e) => s + Number(e.amount_usd), 0);
    const expenses = (ledger as Array<{ entry_type: string; amount_usd: number }>)
      .filter((e) => e.entry_type === "expense")
      .reduce((s: number, e) => s + Number(e.amount_usd), 0);

    const overdueTasks = (tasks as Array<{ task_type: string; subject: string; scheduled_for: string }>)
      .filter((t) => new Date(t.scheduled_for) < now);

    const pipelineValue = (pipeline as Array<{ estimated_value_usd: number | null; probability_pct: number | null }>)
      .reduce((s, p) => s + (Number(p.estimated_value_usd ?? 0) * Number(p.probability_pct ?? 50) / 100), 0);

    const prompt = `You are Atlas. Generate a structured weekly business brief.

BUSINESS DATA:
Revenue (30d paid): $${revenue.toFixed(0)}
Expenses (30d): $${expenses.toFixed(0)}
Net: $${(revenue - expenses).toFixed(0)}

Pipeline (${(pipeline as unknown[]).length} active deals):
${(pipeline as Array<{ contact_name: string; company?: string; opportunity: string; stage: string; estimated_value_usd?: number; probability_pct?: number; next_action_due?: string }>).map((p) => `- ${p.contact_name}${p.company ? " @ " + p.company : ""}: ${p.opportunity} [${p.stage}] $${p.estimated_value_usd ?? 0}${p.next_action_due ? " due " + p.next_action_due.split("T")[0] : ""}`).join("\n") || "No active pipeline."}

Weighted Pipeline Value: $${pipelineValue.toFixed(0)}

Overdue Tasks (${overdueTasks.length}):
${overdueTasks.map((t) => `- ${t.task_type}: ${t.subject} (due ${t.scheduled_for.split("T")[0]})`).join("\n") || "None."}

Sections:
1. Revenue Position — month-to-date revenue vs. expenses, net position, trend
2. Pipeline Health — deals by stage, total pipeline value, conversion rate, stalled deals
3. Overdue Actions — what needed to happen and didn't, with urgency assessment
4. This Week's Priorities — 3 specific actions ranked by expected ROI
5. Verdict — one sentence on the state of the business

Be direct. No filler. State what the data shows.`;

    const aiResp = await callGatewayWithRetry(
      { model: ATLAS_MODEL(), messages: [{ role: "user", content: prompt }], max_tokens: 1500 },
      API_KEY,
    );
    if (!aiResp.ok) throw new Error(`AI call failed: ${aiResp.status}`);

    const aiData = await aiResp.json();
    const brief: string = aiData.choices?.[0]?.message?.content ?? "Brief generation failed.";

    await fetch(`${SUPABASE_URL}/rest/v1/research_notes`, {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id,
        title: `Business Brief — ${weekLabel}`,
        content: brief,
        note_type: "research",
        synced_to_obsidian: false,
      }),
    });

    await sendTelegramAlert(`*BUSINESS BRIEF — ${weekLabel}*\n\nRevenue: $${revenue.toFixed(0)} | Expenses: $${expenses.toFixed(0)} | Net: $${(revenue - expenses).toFixed(0)}\nPipeline: ${(pipeline as unknown[]).length} deals | $${pipelineValue.toFixed(0)} weighted\n\nCheck Vault for full brief.`);

    return new Response(JSON.stringify({ status: "ok", week: weekLabel, revenue, expenses, pipeline_count: (pipeline as unknown[]).length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[atlas_business_brief] Error:", msg);
    try {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
      const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (SUPABASE_URL && SERVICE_KEY) {
        const body = await req.clone().json().catch(() => ({}));
        await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: (body as { user_id?: string }).user_id ?? "system", signal_type: "function_error", message: `atlas_business_brief error: ${msg}` }),
        });
      }
    } catch { /* ignore */ }
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
