// linda-send-email — actually dispatches an approved linda_responses row.
// Until now "Approve & Send" only flipped status to "sent" without sending anything.
// Sends via the operator's own Gmail account over SMTP (denomailer) — $0, no new SaaS vendor,
// matches WIG's self-hosted/no-subscription standard. Requires GMAIL_ADDRESS + GMAIL_APP_PASSWORD
// (Google App Password, not the account password) set as Supabase edge function secrets.

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
import { corsHeaders, verifyUser, AuthError } from "../_shared/gateway.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const GMAIL_ADDRESS = Deno.env.get("GMAIL_ADDRESS") ?? "";
    const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";

    let userId: string;
    try {
      userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof AuthError ? e.message : "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { response_id } = await req.json().catch(() => ({}));
    if (!response_id) {
      return new Response(JSON.stringify({ error: "response_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const h = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

    const respRes = await fetch(
      `${SUPABASE_URL}/rest/v1/linda_responses?id=eq.${response_id}&user_id=eq.${userId}&select=*`,
      { headers: h },
    );
    const response = respRes.ok ? (await respRes.json() as any[])[0] : null;
    if (!response) {
      return new Response(JSON.stringify({ error: "Response not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!["pending_approval", "draft"].includes(response.status)) {
      return new Response(JSON.stringify({ error: `Cannot send a response in status "${response.status}"` }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (response.channel !== "email") {
      return new Response(JSON.stringify({ error: `linda-send-email only handles the "email" channel (got "${response.channel}")` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let toEmail = "";
    let toName = "";
    if (response.lead_id) {
      const leadRes = await fetch(
        `${SUPABASE_URL}/rest/v1/linda_leads?id=eq.${response.lead_id}&select=email,full_name`,
        { headers: h },
      );
      const lead = leadRes.ok ? (await leadRes.json() as any[])[0] : null;
      toEmail = lead?.email ?? "";
      toName = lead?.full_name ?? "";
    }

    if (!toEmail) {
      return new Response(JSON.stringify({ error: "This lead has no email address on file" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!GMAIL_ADDRESS || !GMAIL_APP_PASSWORD) {
      return new Response(JSON.stringify({ error: "GMAIL_ADDRESS / GMAIL_APP_PASSWORD not configured as edge function secrets" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const client = new SMTPClient({
      connection: {
        hostname: "smtp.gmail.com",
        port: 465,
        tls: true,
        auth: { username: GMAIL_ADDRESS, password: GMAIL_APP_PASSWORD },
      },
    });

    // HTML alternative with a 1x1 open-tracking pixel (self-hosted, $0 — no third-party mail-tracking SaaS).
    const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const htmlBody = `<div>${escapeHtml(response.body).replace(/\n/g, "<br>")}</div>`
      + `<img src="${SUPABASE_URL}/functions/v1/linda-track-open?rid=${response_id}" width="1" height="1" alt="" style="display:none">`;

    try {
      await client.send({
        from: `Linda (WIG) <${GMAIL_ADDRESS}>`,
        to: toName ? `${toName} <${toEmail}>` : toEmail,
        subject: response.subject ?? "(no subject)",
        content: response.body,
        html: htmlBody,
      });
      await client.close();
    } catch (sendErr) {
      await fetch(`${SUPABASE_URL}/rest/v1/linda_responses?id=eq.${response_id}`, {
        method: "PATCH", headers: { ...h, Prefer: "return=minimal" },
        body: JSON.stringify({ status: "failed" }),
      });
      return new Response(JSON.stringify({ error: `SMTP send failed: ${String(sendErr)}` }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sentAt = new Date().toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/linda_responses?id=eq.${response_id}`, {
      method: "PATCH", headers: { ...h, Prefer: "return=minimal" },
      body: JSON.stringify({ status: "sent", sent_at: sentAt, approved_by: "bishop" }),
    });

    // Keep linda_pipeline's stale-lead detection accurate — it drafts follow-ups
    // off last_contacted_at, which was never being touched while sends were fake.
    if (response.lead_id) {
      await fetch(`${SUPABASE_URL}/rest/v1/linda_leads?id=eq.${response.lead_id}`, {
        method: "PATCH", headers: { ...h, Prefer: "return=minimal" },
        body: JSON.stringify({ last_contacted_at: sentAt }),
      }).catch(() => {});
    }

    return new Response(JSON.stringify({ ok: true, sent_at: sentAt }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[linda-send-email]", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
