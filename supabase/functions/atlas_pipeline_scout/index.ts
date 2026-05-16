// Atlas Pipeline Scout — generates outreach drafts for prospects due for contact
// Phase 2B: runs daily

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv, resolveUserIds } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

const ATLAS_MODEL = () => modelEnv("ATLAS_MODEL", "openai/gpt-4o");

interface PipelineRecord {
  id: string;
  contact_name: string;
  company: string | null;
  opportunity: string;
  stage: string;
  last_contact_at: string | null;
  next_action: string | null;
  next_action_due: string | null;
  notes: string | null;
}

interface OutreachDraft {
  subject: string;
  body: string;
  tone_note: string;
}

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
      return new Response(JSON.stringify({ message: "No users found to process" }), { headers: corsHeaders });
    }
    const user_id = userIds[0];

    const baseHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

    // Pull qualifying prospects: prospect/follow_up stage with action due in past or next 24hrs
    const pipelineRes = await fetch(
      `${SUPABASE_URL}/rest/v1/business_pipeline?user_id=eq.${user_id}&stage=in.(prospect,follow_up)&next_action_due=lte.${tomorrow}&select=id,contact_name,company,opportunity,stage,last_contact_at,next_action,next_action_due,notes`,
      { headers: baseHeaders },
    );
    if (!pipelineRes.ok) throw new Error(`Failed to fetch pipeline: ${pipelineRes.status}`);
    const qualifying: PipelineRecord[] = await pipelineRes.json();

    if (qualifying.length === 0) {
      return new Response(JSON.stringify({ status: "ok", drafted: 0, message: "No prospects due for outreach." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let drafted = 0;

    for (const prospect of qualifying) {
      // Phase 2B: run business risk check before drafting
      const riskRes = await fetch(`${SUPABASE_URL}/functions/v1/atlas_business_risk_check`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id, action_type: "outreach", amount: 0 }),
      });
      const risk = riskRes.ok ? await riskRes.json() : { go: true };
      if (!risk.go) continue;

      const prompt = `You are Atlas. Draft a precise, high-signal outreach message for this prospect.

Contact: ${prospect.contact_name}${prospect.company ? " at " + prospect.company : ""}
Opportunity: ${prospect.opportunity}
Stage: ${prospect.stage}
Last contact: ${prospect.last_contact_at ? prospect.last_contact_at.split("T")[0] : "never"}
Notes: ${prospect.notes ?? "none"}

Operator instruction: ${prospect.next_action ?? "Follow up"}

Draft a message that is:
- Direct and specific — reference the actual opportunity
- Value-forward — lead with what's in it for them
- Short — under 150 words
- No hollow openers, no "I hope this finds you well"
- End with one clear ask

Return JSON: { subject: string, body: string, tone_note: string }`;

      try {
        const aiResp = await callGatewayWithRetry(
          { model: ATLAS_MODEL(), messages: [{ role: "user", content: prompt }], max_tokens: 600 },
          API_KEY,
        );
        if (!aiResp.ok) continue;

        const aiData = await aiResp.json();
        const rawContent: string = aiData.choices?.[0]?.message?.content?.trim() ?? "{}";

        let draft: OutreachDraft = { subject: "", body: "", tone_note: "" };
        try {
          const cleaned = rawContent.replace(/```json\s*|\s*```/g, "").trim();
          draft = JSON.parse(cleaned) as OutreachDraft;
        } catch {
          const match = rawContent.match(/\{[\s\S]*\}/);
          if (match) draft = JSON.parse(match[0]) as OutreachDraft;
        }

        if (!draft.subject || !draft.body) continue;

        await fetch(`${SUPABASE_URL}/rest/v1/business_tasks`, {
          method: "POST",
          headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({
            user_id,
            task_type: "outreach",
            pipeline_id: prospect.id,
            subject: draft.subject,
            body: draft.body,
            status: "queued",
            requires_approval: true,
            scheduled_for: new Date().toISOString(),
          }),
        });

        drafted++;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[atlas_pipeline_scout] Error drafting for ${prospect.contact_name}:`, msg);
      }
    }

    if (drafted > 0) {
      await sendTelegramAlert(`*PIPELINE SCOUT*\n${drafted} outreach draft${drafted !== 1 ? "s" : ""} queued for approval.\nCheck Business → Tasks to review and send.`);
    }

    return new Response(JSON.stringify({ status: "ok", prospects_checked: qualifying.length, drafted }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[atlas_pipeline_scout] Error:", msg);
    try {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
      const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (SUPABASE_URL && SERVICE_KEY) {
        const body = await req.clone().json().catch(() => ({}));
        await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: (body as { user_id?: string }).user_id ?? "system", signal_type: "function_error", message: `atlas_pipeline_scout error: ${msg}` }),
        });
      }
    } catch { /* ignore */ }
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
