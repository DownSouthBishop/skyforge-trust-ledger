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

    // Attempt Gmail send via OAuth REST API
    let emailSent = false;
    if (contactEmail) {
      const GMAIL_CLIENT_ID     = Deno.env.get("GMAIL_CLIENT_ID");
      const GMAIL_CLIENT_SECRET = Deno.env.get("GMAIL_CLIENT_SECRET");
      const GMAIL_REFRESH_TOKEN = Deno.env.get("GMAIL_REFRESH_TOKEN");

      if (GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET && GMAIL_REFRESH_TOKEN) {
        try {
          // Exchange refresh token for access token
          const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: GMAIL_CLIENT_ID,
              client_secret: GMAIL_CLIENT_SECRET,
              refresh_token: GMAIL_REFRESH_TOKEN,
              grant_type: "refresh_token",
            }),
          });
          const tokenData = await tokenRes.json() as { access_token?: string };
          const accessToken = tokenData.access_token;

          if (accessToken) {
            // Build RFC 2822 raw email, base64url encoded
            const emailLines = [
              `To: ${contactEmail}`,
              `Subject: ${task.subject}`,
              "Content-Type: text/plain; charset=UTF-8",
              "",
              task.body ?? "",
            ];
            const raw = btoa(emailLines.join("\r\n"))
              .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

            const sendRes = await fetch(
              "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ raw }),
              },
            );
            emailSent = sendRes.ok;
            if (!sendRes.ok) {
              console.warn("[atlas_send_outreach] Gmail API send failed:", sendRes.status, await sendRes.text());
            }
          }
        } catch (e: unknown) {
          console.warn("[atlas_send_outreach] Gmail OAuth error:", e instanceof Error ? e.message : String(e));
        }
      } else {
        console.warn("[atlas_send_outreach] Gmail credentials not configured — skipping email send");
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
