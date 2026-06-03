// Linda streaming chat — mirrors forge_chat pattern exactly
// Reads Linda's system prompt from skyforge_agents table
// Injects WIG world state + pending leads + escalations before first token

import {
  corsHeaders,
  verifyUser,
  parseEnv,
  AuthError,
} from "../_shared/gateway.ts";

const serve = (Deno as any).serve ?? ((handler: (r: Request) => Response | Promise<Response>) => {
  (globalThis as any).addEventListener("fetch", (event: any) => {
    event.respondWith(handler(event.request));
  });
});

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { messages, principal = "bishop" } = await req.json();

    const { supabase, anthropicKey } = parseEnv();
    const user = await verifyUser(req, supabase);

    // 1. Load Linda from agent registry
    const { data: agent } = await supabase
      .from("skyforge_agents")
      .select("system_prompt, capabilities, confidence_threshold")
      .eq("slug", "linda")
      .eq("user_id", user.id)
      .single();

    if (!agent) {
      return new Response(
        JSON.stringify({ error: "Linda not seeded for this account. Run the linda_agent_seed migration." }),
        { status: 404, headers: { ...corsHeaders, "content-type": "application/json" } },
      );
    }

    // 2. Load WIG world state
    const { data: worldState } = await supabase.rpc("get_wig_state");

    // 3. Load pending escalations
    const { data: escalations } = await supabase
      .from("agent_escalations")
      .select("id, action_type, known_facts, what_it_needs, created_at")
      .eq("status", "pending")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(5);

    // 4. Load new inbound leads
    const { data: pendingLeads } = await supabase
      .from("linda_leads")
      .select("id, full_name, business_name, service_requested, source, created_at")
      .eq("user_id", user.id)
      .eq("status", "new")
      .order("created_at", { ascending: false })
      .limit(10);

    // 5. Load pending response approvals
    const { data: pendingResponses } = await supabase
      .from("linda_responses")
      .select("id, lead_id, subject, created_at")
      .eq("user_id", user.id)
      .eq("status", "pending_approval")
      .order("created_at", { ascending: false })
      .limit(5);

    const contextBlock = `
━━━ CURRENT WIG STATE ━━━
${worldState ? JSON.stringify(worldState, null, 2) : "No snapshot yet."}

━━━ PENDING ESCALATIONS (${escalations?.length ?? 0}) ━━━
${escalations?.length ? JSON.stringify(escalations, null, 2) : "None."}

━━━ NEW INBOUND LEADS (${pendingLeads?.length ?? 0}) ━━━
${pendingLeads?.length ? JSON.stringify(pendingLeads, null, 2) : "None."}

━━━ RESPONSES AWAITING APPROVAL (${pendingResponses?.length ?? 0}) ━━━
${pendingResponses?.length ? JSON.stringify(pendingResponses, null, 2) : "None."}

━━━ SESSION PRINCIPAL ━━━
${principal === "bishop"
  ? "Bishop — give vision-level responses. Surface what needs his decision."
  : "Calvin — give technical briefs. Be specific about what needs to be built."}
`;

    const systemPrompt = (agent.system_prompt as string).replace(
      "[CONTEXT_INJECTION]",
      contextBlock,
    );

    // 6. Stream to Anthropic — same pattern as forge_chat
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        stream: true,
        system: systemPrompt,
        messages,
      }),
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      return new Response(JSON.stringify({ error: err }), {
        status: upstream.status,
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }

    return new Response(upstream.body, {
      headers: { ...corsHeaders, "content-type": "text/event-stream" },
    });

  } catch (e) {
    if (e instanceof AuthError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 401,
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }
});
