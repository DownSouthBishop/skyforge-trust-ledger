// telegram-bridge — standalone Telegram webhook endpoint for Janus
// Receives Telegram updates, routes to Janus (or any @slug agent), replies via bot API.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function parseEnv(key: string): string {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Required env var ${key} is not set`);
  return val;
}

function parseAgentMention(text: string): { agentSlug: string; message: string } {
  const atMatch = text.match(/^@(\w+)\s+([\s\S]+)$/i);
  if (atMatch) return { agentSlug: atMatch[1].toLowerCase(), message: atMatch[2].trim() };
  const heyMatch = text.match(/^hey\s+(\w+)[,\s]+([\s\S]+)$/i);
  if (heyMatch) return { agentSlug: heyMatch[1].toLowerCase(), message: heyMatch[2].trim() };
  return { agentSlug: "janus", message: text };
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {});
}

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
    const BOT_TOKEN    = parseEnv("TELEGRAM_BOT_TOKEN");
    const OWNER_ID     = parseEnv("TELEGRAM_CHAT_ID");
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("ANTHROPIC_API_KEY");
    const MODEL        = Deno.env.get("ATLAS_MODEL") ?? "claude-sonnet-4-6";

    const body = await req.json();

    // Handle Telegram webhook updates
    if (body?.message?.text) {
      const chatId = String(body.message.chat.id);
      const text   = body.message.text as string;

      if (chatId !== OWNER_ID) {
        await sendTelegram(BOT_TOKEN, chatId, "This is a private assistant.");
        return new Response("ok", { headers: corsHeaders });
      }

      // Typing indicator
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action: "typing" }),
      }).catch(() => {});

      const { agentSlug, message: userText } = parseAgentMention(text);

      const { agent, memories } = await loadAgent(SUPABASE_URL, SERVICE_KEY, agentSlug);
      const system = buildSystem(agent, memories);
      const reply  = await generateReply(system, userText, API_KEY, MODEL);

      const chunks = reply.match(/[\s\S]{1,4000}/g) ?? [reply];
      for (const chunk of chunks) {
        await sendTelegram(BOT_TOKEN, chatId, chunk);
      }

      return new Response("ok", { headers: corsHeaders });
    }

    // Internal API call: { agent_slug, message } → { reply }
    const agentSlug = body.agent_slug ?? "janus";
    const userText  = body.message ?? body.text ?? body.content ?? "";

    if (!userText) {
      return new Response(JSON.stringify({ reply: "" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { agent, memories } = await loadAgent(SUPABASE_URL, SERVICE_KEY, agentSlug);
    const system = buildSystem(agent, memories);
    const reply  = await generateReply(system, userText, API_KEY, MODEL);

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
