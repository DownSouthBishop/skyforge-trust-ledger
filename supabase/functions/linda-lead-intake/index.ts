// Linda lead intake webhook — triggered by PrymalAI form submissions
// Flow: receive form POST → write to linda_leads → Linda qualifies + drafts
//       response → write to linda_responses as pending_approval
//       → flag wig_state with new lead notification

import { corsHeaders, parseEnv, verifyUser, AuthError } from "../_shared/gateway.ts";

const serve = (Deno as any).serve ?? ((handler: (r: Request) => Response | Promise<Response>) => {
  (globalThis as any).addEventListener("fetch", (event: any) => {
    event.respondWith(handler(event.request));
  });
});

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    let userId: string;
    try {
      userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { supabase, anthropicKey } = parseEnv();

    // Verify webhook secret
    const webhookSecret = Deno.env.get("PRYMALAI_WEBHOOK_SECRET");
    if (webhookSecret) {
      const sig = req.headers.get("x-webhook-secret");
      if (sig !== webhookSecret) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "content-type": "application/json" },
        });
      }
    }

    const body = await req.json();
    const {
      full_name, business_name, phone, email, city_region,
      service_requested, notes, source = "prymalai_form",
      utm_source, utm_campaign, user_id,
    } = body;

    if (!full_name || !user_id) {
      return new Response(JSON.stringify({ error: "full_name and user_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }

    // 1. Write the lead
    const { data: lead, error: leadErr } = await supabase
      .from("linda_leads")
      .insert({
        user_id, full_name, business_name, phone, email, city_region,
        service_requested: service_requested ?? "other",
        notes, source, utm_source, utm_campaign,
        status: "new", priority: "normal",
      })
      .select("*")
      .single();

    if (leadErr) throw new Error(leadErr.message);

    // 2. Load Linda's agent record
    const { data: lindaAgent } = await supabase
      .from("skyforge_agents")
      .select("id, system_prompt, confidence_threshold")
      .eq("slug", "linda")
      .eq("user_id", user_id)
      .single();

    if (!lindaAgent) {
      return new Response(JSON.stringify({ lead_id: lead.id, response_drafted: false }), {
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }

    // 3. Ask Linda to qualify and draft a response
    const qualifyPrompt = `New PrymalAI inbound lead. Qualify this lead and draft an email response.

Lead details:
${JSON.stringify(lead, null, 2)}

Return a JSON object with exactly these fields:
{
  "qualification": "hot" | "normal" | "cold",
  "linda_notes": "<your assessment of this lead>",
  "confidence": <0.0-1.0>,
  "email_subject": "<subject line>",
  "email_body": "<full email body, written in a warm, direct, professional tone — not template language>",
  "follow_up_hours": <integer hours until follow-up if no response>
}`;

    const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01", "anthropic-beta": "web-search-2025-03-05",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500, tools: [{ type: "web_search_20250305", name: "web_search" }], 
        system: lindaAgent.system_prompt,
        messages: [{ role: "user", content: qualifyPrompt }],
      }),
    });

    let qualification: any = {};
    if (aiResp.ok) {
      const aiData = await aiResp.json();
      const raw = aiData.content?.[0]?.text ?? "{}";
      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) qualification = JSON.parse(jsonMatch[0]);
      } catch { /* use empty object */ }
    }

    // 4. Update lead with Linda's assessment
    const followUpAt = qualification.follow_up_hours
      ? new Date(Date.now() + qualification.follow_up_hours * 3600000).toISOString()
      : null;

    await supabase
      .from("linda_leads")
      .update({
        priority: qualification.qualification ?? "normal",
        linda_notes: qualification.linda_notes,
        linda_confidence: qualification.confidence,
        follow_up_at: followUpAt,
      })
      .eq("id", lead.id);

    // 5. Write the draft response for approval
    let responseId: string | null = null;
    if (qualification.email_body) {
      const { data: response } = await supabase
        .from("linda_responses")
        .insert({
          user_id,
          lead_id: lead.id,
          channel: "email",
          subject: qualification.email_subject ?? `Re: ${service_requested ?? "Your Inquiry"}`,
          body: qualification.email_body,
          status: "pending_approval",
          linda_confidence: qualification.confidence,
        })
        .select("id")
        .single();
      responseId = response?.id ?? null;
    }

    // 6. Log prediction
    await supabase.from("agent_predictions").insert({
      agent_id: lindaAgent.id,
      user_id,
      action_type: "lead_response",
      action_context: { lead_id: lead.id, service_requested, source },
      predicted_outcome: `Lead qualifies as ${qualification.qualification ?? "normal"}`,
      confidence_score: qualification.confidence ?? 0.5,
      predicted_metric: "lead_converts",
      escalated: (qualification.confidence ?? 0.5) < (lindaAgent.confidence_threshold ?? 0.7),
    });

    // 7. Flag wig_state
    const { data: currentState } = await supabase.rpc("get_wig_state");
    if (currentState) {
      const flags = Array.isArray(currentState.flags) ? currentState.flags : [];
      flags.push({
        type: "new_lead",
        message: `New PrymalAI lead: ${full_name}${business_name ? ` (${business_name})` : ""}`,
        severity: qualification.qualification === "hot" ? "high" : "normal",
        created_at: new Date().toISOString(),
      });
      await supabase.from("wig_state").insert({
        ...currentState,
        id: undefined,
        snapshot_at: undefined,
        created_at: undefined,
        net_monthly: undefined,
        flags,
        updated_by: "linda-lead-intake",
      });
    }

    return new Response(
      JSON.stringify({
        lead_id: lead.id,
        response_id: responseId,
        response_drafted: !!responseId,
        qualification: qualification.qualification ?? "normal",
        confidence: qualification.confidence ?? 0.5,
      }),
      { headers: { ...corsHeaders, "content-type": "application/json" } },
    );

  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }
});
