// telegram-bridge — called by telegram-webhook to run any Skyforge agent
// Loads agent + memories from DB, calls Anthropic directly, returns { reply }
// No streaming — Telegram only needs the final text.

import { parseEnv } from "../_shared/gateway.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function loadAgent(supabaseUrl: string, serviceKey: string, slug: string) {
  const agentResp = await fetch(
    `${supabaseUrl}/rest/v1/skyforge_agents?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&limit=1`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const agents = await agentResp.json();
  const agent = agents?.[0];
  if (!agent) throw new Error(`Agent not found: ${slug}`);

  const memResp = await fetch(
    `${supabaseUrl}/rest/v1/agent_memory?agent_id=eq.${agent.id}&order=confidence.desc&limit=20`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const memories = await memResp.json();
  return { agent, memories: memories ?? [] };
}

function buildSystem(agent: Record<string, unknown>, memories: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  if (agent.system_prompt) parts.push(String(agent.system_prompt));
  if (Array.isArray(agent.bio) && agent.bio.length) {
    parts.push("Background:\n" + (agent.bio as string[]).map((b) => `- ${b}`).join("\n"));
  }
  if (memories.length) {
    parts.push(
      "Your active memory (highest confidence first):\n" +
      memories.map((m) => `[${m.memory_type}] ${m.key}: ${m.value}`).join("\n"),
    );
  }
  parts.push("You are responding via Telegram. Keep replies concise and direct. No markdown headers.");
  return parts.join("\n\n");
}

async function generateReply(system: string, userText: string, apiKey: string, model: string): Promise<string> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  const text = data?.content?.find((b: { type: string }) => b.type === "text")?.text ?? "";
  if (!text) throw new Error("Empty response from Anthropic");
  return text;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl  = parseEnv("SUPABASE_URL");
    const serviceKey   = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const anthropicKey = parseEnv("ANTHROPIC_API_KEY");
    const model        = Deno.env.get("ATLAS_MODEL") ?? "claude-sonnet-4-6";

    const body      = await req.json();
    const url       = new URL(req.url);
    const agentSlug = url.searchParams.get("agent") ?? body.agent_slug ?? "janus";
    const userText  = body.message ?? body.text ?? body.content ?? "";

    if (!userText) {
      return new Response(JSON.stringify({ reply: "" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { agent, memories } = await loadAgent(supabaseUrl, serviceKey, agentSlug);
    const system = buildSystem(agent, memories);
    const reply  = await generateReply(system, userText, anthropicKey, model);

    return new Response(JSON.stringify({ reply, agent: agent.name }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[telegram-bridge]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
