// Atlas Send Outreach — sends approved outreach emails via Gmail MCP
// Phase 2C: triggered when a business_tasks record transitions to status='approved'

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

const STAGE_PROGRESSION: Record<string, string> = {
  prospect: "outreach",
  follow_up: "proposal",
  outreach: "follow_up",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    const { task_id, user_id } = await req.json();
    if (!task_id || !user_id) {
      return new Response(JSON.stringify({ error: "task_id and user_id required" }), { status: 400, headers: corsHeaders });
    }

    const baseHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    // Fetch the task
    const taskRes = await fetch(
      `${SUPABASE_URL}/rest/v1/business_tasks?id=eq.${task_id}&user_id=eq.${user_id}&status=eq.approved&select=id,task_type,pipeline_id,subject,body,status`,
      { headers: baseHeaders },
    );
    if (!taskRes.ok) throw new Error(`Failed to fetch task: ${taskRes.status}`);
    const tasks: Array<{ id: string; task_type: string; pipeline_id: string | null; subject: string; body: string | null; status: string }> = await taskRes.json();

    if (tasks.length === 0) {
      return new Response(JSON.stringify({ error: "Task not found or not in approved status" }), { status: 404, headers: corsHeaders });
    }

    const task = tasks[0];

    // Fetch pipeline contact details for email target
    let contactEmail: string | null = null;
    let contactName: string | null = null;
    let currentStage: string | null = null;
    if (task.pipeline_id) {
      const prospectRes = await fetch(
        `${SUPABASE_URL}/rest/v1/business_pipeline?id=eq.${task.pipeline_id}&select=contact_email,contact_name,stage`,
        { headers: baseHeaders },
      );
      if (prospectRes.ok) {
        const prospects: Array<{ contact_email: string | null; contact_name: string; stage: string }> = await prospectRes.json();
        if (prospects.length > 0) {
          contactEmail = prospects[0].contact_email;
          contactName = prospects[0].contact_name;
          currentStage = prospects[0].stage;
        }
      }
    }

    // Attempt Gmail MCP send if email is available
    let emailSent = false;
    if (contactEmail) {
      try {
        const gmailRes = await fetch("https://gmailmcp.googleapis.com/mcp/v1", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SERVICE_KEY}`,
          },
          body: JSON.stringify({
            method: "gmail.send",
            params: {
              to: contactEmail,
              subject: task.subject,
              body: task.body ?? "",
            },
          }),
        });
        emailSent = gmailRes.ok;
        if (!gmailRes.ok) {
          console.warn("[atlas_send_outreach] Gmail MCP send failed:", gmailRes.status);
        }
      } catch (e: unknown) {
        console.warn("[atlas_send_outreach] Gmail MCP unavailable:", e instanceof Error ? e.message : String(e));
      }
    }

    // Update task to sent/done
    await fetch(`${SUPABASE_URL}/rest/v1/business_tasks?id=eq.${task_id}`, {
      method: "PATCH",
      headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        status: emailSent ? "sent" : "done",
        completed_at: new Date().toISOString(),
      }),
    });

    // Log to forge_alerts
    await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id,
        signal_type: "outreach_sent",
        message: `Outreach ${emailSent ? "sent" : "marked done"}: "${task.subject}"${contactName ? " → " + contactName : ""}`,
      }),
    });

    // Advance pipeline stage if applicable
    if (task.pipeline_id && currentStage && STAGE_PROGRESSION[currentStage]) {
      const nextStage = STAGE_PROGRESSION[currentStage];
      await fetch(`${SUPABASE_URL}/rest/v1/business_pipeline?id=eq.${task.pipeline_id}`, {
        method: "PATCH",
        headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          last_contact_at: new Date().toISOString(),
          stage: nextStage,
          updated_at: new Date().toISOString(),
        }),
      });
    }

    if (emailSent) {
      await sendTelegramAlert(`*OUTREACH SENT*\nTo: ${contactName ?? contactEmail}\nSubject: ${task.subject}`);
    }

    return new Response(JSON.stringify({
      status: "ok",
      email_sent: emailSent,
      task_status: emailSent ? "sent" : "done",
      stage_advanced: !!(task.pipeline_id && currentStage && STAGE_PROGRESSION[currentStage]),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[atlas_send_outreach] Error:", msg);
    try {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
      const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (SUPABASE_URL && SERVICE_KEY) {
        const body = await req.clone().json().catch(() => ({}));
        await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: (body as { user_id?: string }).user_id ?? "system", signal_type: "function_error", message: `atlas_send_outreach error: ${msg}` }),
        });
      }
    } catch { /* ignore */ }
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
