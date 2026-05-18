import { parseEnv } from "../_shared/gateway.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-openclaw-signature",
};

const SUPABASE_URL_KEY = "SUPABASE_URL";
const SERVICE_KEY      = "SUPABASE_SERVICE_ROLE_KEY";
const ANTHROPIC_KEY    = "ANTHROPIC_API_KEY";
const ATLAS_MODEL      = "claude-sonnet-4-6";

// ── Extract message text from any incoming payload format ────────────────────
// Handles: raw Telegram update, OpenClaw simplified payload, and direct calls
function extractText(body: Record<string, unknown>): string {
  // Raw Telegram update: { message: { text: "..." } }
  if (body.message && typeof body.message === "object") {
    const msg = body.message as Record<string, unknown>;
    if (typeof msg.text === "string") return msg.text;
    if (typeof msg.caption === "string") return msg.caption;
  }
  // OpenClaw simplified: { text: "..." } or { content: "..." } or { message: "..." }
  if (typeof body.text === "string") return body.text;
  if (typeof body.content === "string") return body.content;
  if (typeof body.message === "string") return body.message;
  return "";
}

// ── Extract chat_id for sending replies ──────────────────────────────────────
function extractChatId(body: Record<string, unknown>): string | null {
  // Raw Telegram: { message: { chat: { id: 123 } } }
  if (body.message && typeof body.message === "object") {
    const msg = body.message as Record<string, unknown>;
    if (msg.chat && typeof msg.chat === "object") {
      const chat = msg.chat as Record<string, unknown>;
      if (chat.id) return String(chat.id);
    }
    if (msg.from && typeof msg.from === "object") {
      const from = msg.from as Record<string, unknown>;
      if (from.id) return String(from.id);
    }
  }
  // OpenClaw simplified: { chat_id: "..." }
  if (body.chat_id) return String(body.chat_id);
  if (body.user_id) return String(body.user_id);
  return null;
}

// ── Extract sender username ──────────────────────────────────────────────────
function extractUsername(body: Record<string, unknown>): string {
  if (body.message && typeof body.message === "object") {
    const msg = body.message as Record<string, unknown>;
    if (msg.from && typeof msg.from === "object") {
      const from = msg.from as Record<string, unknown>;
      return String(from.username ?? from.first_name ?? "user");
    }
  }
  return String(body.username ?? body.user ?? "user");
}

// ── Load agent record + memories from Supabase ──────────────────────────────
async function loadAgent(supabaseUrl: string, serviceKey: string, agentSlug: string) {
  const agentResp = await fetch(
    `${supabaseUrl}/rest/v1/skyforge_agents?slug=eq.${encodeURIComponent(agentSlug)}&is_active=eq.true&limit=1`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const agents = await agentResp.json();
  const agent = agents?.[0];
  if (!agent) throw new Error(`Agent not found: ${agentSlug}`);

  const memResp = await fetch(
    `${supabaseUrl}/rest/v1/agent_memory?agent_id=eq.${agent.id}&order=confidence.desc&limit=20`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const memories = await memResp.json();

  return { agent, memories: memories ?? [] };
}

// ── Build system prompt ──────────────────────────────────────────────────────
function buildSystem(
  agent: Record<string, unknown>,
  memories: Array<Record<string, unknown>>,
  username: string,
): string {
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

  parts.push(
    `You are responding via Telegram to @${username}. ` +
    "Keep replies concise and conversational. No markdown headers or bullet walls. " +
    "Respond naturally as yourself.",
  );

  return parts.join("\n\n");
}

// ── Call Anthropic ────────────────────────────────────────────────────────────
async function generateReply(system: string, userText: string, apiKey: string): Promise<string> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ATLAS_MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const text = data?.content?.find((b: { type: string }) => b.type === "text")?.text ?? "";
  if (!text) throw new Error("Empty response from Anthropic");
  return text;
}

// ── Store session so Janus can send proactive messages later ─────────────────
async function storeTelegramSession(
  supabaseUrl: string,
  serviceKey: string,
  agentId: string,
  userId: string,
  chatId: string,
  username: string,
) {
  // Upsert into agent_memory so the agent knows its active Telegram contacts
  await fetch(`${supabaseUrl}/rest/v1/agent_memory`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({
      agent_id:        agentId,
      user_id:         userId,
      memory_type:     "relationship",
      key:             `telegram:${username}`,
      value:           `Telegram user @${username} — chat_id: ${chatId}`,
      confidence:      1.0,
      evidence_count:  1,
      last_reinforced: new Date().toISOString(),
    }),
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl  = parseEnv(SUPABASE_URL_KEY);
    const serviceKey   = parseEnv(SERVICE_KEY);
    const anthropicKey = parseEnv(ANTHROPIC_KEY);

    const body = await req.json();

    // Resolve agent slug: ?agent= query param → body.agent_slug → default "janus"
    const url       = new URL(req.url);
    const agentSlug = url.searchParams.get("agent") ?? String(body.agent_slug ?? "janus");
    const userText  = extractText(body);
    const chatId    = extractChatId(body);
    const username  = extractUsername(body);

    if (!userText) {
      return new Response(JSON.stringify({ reply: "" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { agent, memories } = await loadAgent(supabaseUrl, serviceKey, agentSlug);
    const system = buildSystem(agent, memories, username);
    const reply  = await generateReply(system, userText, anthropicKey);

    // Store the chat_id so Janus can reach back later
    if (chatId) {
      await storeTelegramSession(
        supabaseUrl, serviceKey, agent.id, agent.user_id, chatId, username,
      ).catch(() => { /* non-fatal */ });
    }

    // Return in the format OpenClaw expects
    return new Response(
      JSON.stringify({ reply, agent: agent.name, chat_id: chatId }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[telegram-bridge]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

