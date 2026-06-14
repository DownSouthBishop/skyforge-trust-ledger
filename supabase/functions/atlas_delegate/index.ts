import { corsHeaders, parseEnv, verifyUser, writeCrossMemory } from "../_shared/gateway.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const ANTHROPIC_KEY = parseEnv("ANTHROPIC_API_KEY");

    let userId: string;
    try {
      userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { agent_slug, task, context = "", max_tokens = 2000 } = await req.json();
    if (!agent_slug || !task) {
      return new Response(JSON.stringify({ error: "agent_slug and task required" }), { status: 400, headers: corsHeaders });
    }

    // Load agent record
    const agentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/skyforge_agents?slug=eq.${agent_slug}&user_id=eq.${userId}&select=id,name,slug,system_prompt&limit=1`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    const agents = agentRes.ok ? await agentRes.json() : [];
    if (!agents.length) {
      return new Response(JSON.stringify({ error: `Agent "${agent_slug}" not found` }), { status: 404, headers: corsHeaders });
    }
    const agent = agents[0];

    const systemPrompt = agent.system_prompt ?? `You are ${agent.name}, a specialist agent. Complete the task given to you precisely and return structured results.`;

    const userMessage = context
      ? `TASK: ${task}\n\nCONTEXT:\n${context}`
      : `TASK: ${task}`;

    const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!aiResp.ok) {
      const err = await aiResp.text();
      return new Response(JSON.stringify({ error: `AI error: ${err}` }), { status: 500, headers: corsHeaders });
    }

    const aiData = await aiResp.json();
    const result = aiData?.content?.[0]?.text ?? "";

    // Log to cross memory so Atlas and other agents know what happened
    writeCrossMemory(SUPABASE_URL, SERVICE_KEY, userId, agent_slug,
      `Completed task: ${task.slice(0, 120)}`, "delegation");

    return new Response(JSON.stringify({
      agent: agent.name,
      agent_slug,
      task,
      result,
      tokens_used: aiData?.usage?.output_tokens ?? 0,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
