// linda_pipeline — daily stale lead detection for Linda.
// Finds leads that haven't been contacted in 3+ days (or are brand new and uncontacted),
// drafts follow-up outreach per lead, queues as outbound_actions for operator approval.
// Runs daily 8am via pg_cron.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_MODEL = "gemini-2.5-flash";

async function gemini(apiKey: string, system: string, user: string, maxTokens = 600): Promise<string> {
  try {
    const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        max_tokens: maxTokens,
      }),
    });
    if (!resp.ok) return "";
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content ?? "";
  } catch { return ""; }
}

const LINDA_SYSTEM = `You are Linda — Chief of Staff for WIG (Watkins Investment Group). You manage leads for PrymalAI, a local business AI agency.

Write a short, professional follow-up email for a lead. The tone is warm, direct, and focused on their specific need. Do NOT be salesy. Do NOT use generic greetings like "I hope this email finds you well."

Format:
SUBJECT: [subject line]
---
[email body — 3-5 sentences max]

Lead context will be provided. Match the stage of their journey.`;

const stageContext: Record<string, string> = {
  new: "This is the initial outreach — introduce PrymalAI briefly and ask if they're still interested in exploring what AI can do for their business.",
  responded: "They responded to an initial message. Follow up to qualify their needs and schedule a discovery call.",
  qualified: "They're qualified. Follow up to present a proposal or ask about their timeline.",
  proposal_sent: "A proposal was sent. Follow up to check if they have questions or are ready to move forward.",
  negotiating: "In negotiation. Follow up to keep momentum and address any outstanding concerns.",
  nurturing: "Long-term nurture. Check in and share a relevant insight or update about AI for their industry.",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const GOOGLE_KEY = Deno.env.get("GOOGLE_AI_KEY") ?? "";
    const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
    const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

    if (!GOOGLE_KEY) {
      return new Response(JSON.stringify({ ok: false, error: "GOOGLE_AI_KEY missing" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const h = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    };

    // Resolve operator
    const agentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/skyforge_agents?select=user_id&is_active=eq.true&limit=1`,
      { headers: h },
    );
    const agentRows = agentRes.ok ? (await agentRes.json() as any[]) : [];
    if (!agentRows.length) {
      return new Response(JSON.stringify({ ok: false, error: "No agents found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const uid = agentRows[0].user_id as string;

    const cutoff3d = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const cutoff1d = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Fetch stale leads: active status, not contacted in 3+ days OR new and uncontacted after 24h
    // Exclude won, lost, cold
    const leadsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/linda_leads?user_id=eq.${uid}&status=not.in.(won,lost,cold)&select=id,full_name,business_name,email,phone,service_requested,status,notes,last_contacted_at,follow_up_at,created_at,priority&order=priority.desc,created_at.asc&limit=10`,
      { headers: h },
    );
    const allLeads = leadsRes.ok ? (await leadsRes.json() as any[]) : [];

    // Filter stale: either follow_up_at has passed, OR not contacted in 3+ days, OR new > 24h with no contact
    const staleLeads = allLeads.filter((lead: any) => {
      const hasPassedFollowup = lead.follow_up_at && lead.follow_up_at <= new Date().toISOString();
      const notContactedRecently = !lead.last_contacted_at || lead.last_contacted_at < cutoff3d;
      const newAndUncontacted = lead.status === "new" && !lead.last_contacted_at && lead.created_at < cutoff1d;
      return hasPassedFollowup || notContactedRecently || newAndUncontacted;
    }).slice(0, 5);

    if (!staleLeads.length) {
      return new Response(
        JSON.stringify({ ok: true, drafts_queued: 0, message: "No stale leads to follow up on" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Check which leads already have a pending outbound_action (don't double-draft)
    const pendingActionsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/outbound_actions?user_id=eq.${uid}&agent_slug=eq.linda&action_type=eq.email_draft&status=eq.pending&select=payload`,
      { headers: h },
    );
    const pendingActions = pendingActionsRes.ok ? (await pendingActionsRes.json() as any[]) : [];
    const alreadyDraftedLeadIds = new Set(
      pendingActions.map((a: any) => a.payload?.lead_id).filter(Boolean)
    );

    const leadsToProcess = staleLeads.filter((lead: any) => !alreadyDraftedLeadIds.has(lead.id));

    if (!leadsToProcess.length) {
      return new Response(
        JSON.stringify({ ok: true, drafts_queued: 0, message: "All stale leads already have pending drafts" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const draftsQueued: string[] = [];

    for (const lead of leadsToProcess) {
      try {
        const stage = lead.status as string;
        const stageInstructions = stageContext[stage] ?? stageContext.nurturing;

        const leadContext = [
          `Name: ${lead.full_name}`,
          lead.business_name ? `Business: ${lead.business_name}` : null,
          lead.email ? `Email: ${lead.email}` : null,
          `Service interest: ${lead.service_requested ?? "general AI inquiry"}`,
          `Stage: ${stage}`,
          `Priority: ${lead.priority}`,
          lead.notes ? `Notes: ${lead.notes}` : null,
          lead.last_contacted_at ? `Last contacted: ${lead.last_contacted_at.split("T")[0]}` : "Never contacted",
        ].filter(Boolean).join("\n");

        const userPrompt = `${stageInstructions}

LEAD:
${leadContext}

Write the follow-up email.`;

        const draft = await gemini(GOOGLE_KEY, LINDA_SYSTEM, userPrompt, 400);
        if (!draft || draft.length < 30) continue;

        // Parse subject and body from draft
        const subjectMatch = draft.match(/^SUBJECT:\s*(.+)/m);
        const subject = subjectMatch ? subjectMatch[1].trim() : `Following up — ${lead.full_name}`;
        const bodyStart = draft.indexOf("---");
        const body = bodyStart !== -1 ? draft.slice(bodyStart + 3).trim() : draft;

        // Queue as outbound_action
        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/outbound_actions`, {
          method: "POST",
          headers: { ...h, Prefer: "return=minimal" },
          body: JSON.stringify({
            user_id: uid,
            agent_slug: "linda",
            action_type: "email_draft",
            payload: {
              to: lead.email ?? "",
              to_name: lead.full_name,
              subject,
              body,
              lead_id: lead.id,
              lead_status: stage,
              business_name: lead.business_name ?? "",
            },
            status: "pending",
          }),
        });

        if (!insertRes.ok) continue;

        draftsQueued.push(lead.full_name);

      } catch (e) {
        console.error(`[linda_pipeline] error for lead ${lead.id}:`, e);
      }
    }

    if (!draftsQueued.length) {
      return new Response(
        JSON.stringify({ ok: true, drafts_queued: 0, message: "Draft generation failed for all leads" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Write to cross_memory
    await fetch(`${SUPABASE_URL}/rest/v1/agent_cross_memory`, {
      method: "POST",
      headers: { ...h, Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: uid,
        source_agent: "linda",
        summary: `Lead pipeline: ${draftsQueued.length} follow-up drafts queued for approval. Leads: ${draftsQueued.slice(0, 3).join(", ")}${draftsQueued.length > 3 ? "..." : ""}`,
        topic: "lead_pipeline",
      }),
    }).catch(() => {});

    // Telegram notification
    if (BOT_TOKEN && CHAT_ID) {
      const leadList = draftsQueued.map(n => `• ${n}`).join("\n");
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: `👁 *Linda — Lead Pipeline*\n\n${draftsQueued.length} follow-up draft(s) queued for your review:\n${leadList}\n\nApprove in Outbound Actions.`,
          parse_mode: "Markdown",
        }),
      }).catch(() => {});
    }

    return new Response(
      JSON.stringify({
        ok: true,
        drafts_queued: draftsQueued.length,
        leads: draftsQueued,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (e) {
    console.error("[linda_pipeline]", e);
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
