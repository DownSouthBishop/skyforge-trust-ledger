// telegram-bridge — full router for AtlasHUD bot
// /janus <message>  → Janus sub-agent (loads character + memory from DB)
// everything else   → Atlas via atlas-core edge function
// Sends replies directly to Telegram Bot API — no OpenClaw dependency needed

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ATLAS_MODEL = "claude-sonnet-4-6";

function parseEnv(key: string): string {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Required env var ${key} is not set`);
  return val;
}

// ── Extract incoming Telegram message fields ─────────────────────────────────
function parseTelegram(body: Record<string, unknown>) {
  const msg = (body.message ?? body.edited_message) as Record<string, unknown> | undefined;
  if (!msg) return null;

  const text    = String(msg.text ?? msg.caption ?? "").trim();
  const chatId  = String((msg.chat as Record<string, unknown>)?.id ?? "");
  const from    = msg.from as Record<string, unknown> | undefined;
  const username = String(from?.username ?? from?.first_name ?? "user");

  return { text, chatId, username };
}

// ── Send a reply back to Telegram ────────────────────────────────────────────
async function sendTelegram(botToken: string, chatId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

// ── Load Janus character + memories from Supabase ────────────────────────────
async function loadAgent(supabaseUrl: string, serviceKey: string, slug: string) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/skyforge_agents?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&limit=1`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const rows = await res.json();
  const agent = rows?.[0];
  if (!agent) throw new Error(`Agent not found: ${slug}`);

  const memRes = await fetch(
    `${supabaseUrl}/rest/v1/agent_memory?agent_id=eq.${agent.id}&order=confidence.desc&limit=20`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const memories = await memRes.json();
  return { agent, memories: memories ?? [] };
}

// ── Store contact in agent memory so Janus knows who he's spoken to ──────────
async function storeContact(supabaseUrl: string, serviceKey: string, agentId: string, userId: string, chatId: string, username: string) {
  await fetch(`${supabaseUrl}/rest/v1/agent_memory`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({
      agent_id: agentId, user_id: userId, memory_type: "relationship",
      key: `telegram:${username}`, confidence: 1.0, evidence_count: 1,
      value: `Telegram user @${username} — chat_id: ${chatId}`,
      last_reinforced: new Date().toISOString(),
    }),
  });
}

// ── Call Anthropic for Janus ──────────────────────────────────────────────────
async function janusReply(
  agent: Record<string, unknown>,
  memories: Array<Record<string, unknown>>,
  userText: string,
  username: string,
  apiKey: string,
): Promise<string> {
  const parts: string[] = [];
  if (agent.system_prompt) parts.push(String(agent.system_prompt));
  if (Array.isArray(agent.bio) && agent.bio.length)
    parts.push("Background:\n" + (agent.bio as string[]).map((b) => `- ${b}`).join("\n"));
  if (memories.length)
    parts.push("Active memory:\n" + memories.map((m) => `[${m.memory_type}] ${m.key}: ${m.value}`).join("\n"));
  parts.push(`Responding via Telegram to @${username}. Be concise and natural. No markdown headers.`);

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: ATLAS_MODEL, max_tokens: 1024,
      system: parts.join("\n\n"),
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data?.content?.find((b: { type: string }) => b.type === "text")?.text ?? "";
}

// ── Call atlas-core for Atlas messages ────────────────────────────────────────
async function atlasReply(supabaseUrl: string, serviceKey: string, userText: string, username: string): Promise<string> {
  // Use service key to call atlas-core on behalf of the bot
  const resp = await fetch(`${supabaseUrl}/functions/v1/atlas-core`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "chat",
      stream: false,
      messages: [{ role: "user", content: userText }],
      system: `You are Atlas, responding via Telegram to @${username}. Be concise. No markdown headers.`,
    }),
  });
  if (!resp.ok) throw new Error(`atlas-core ${resp.status}`);
  const data = await resp.json();
  // Handle both streaming and non-streaming response formats
  return data?.content?.[0]?.text ?? data?.text ?? data?.message ?? "I'm here.";
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Always return 200 to Telegram immediately (prevents retries)
  const respond = () => new Response(JSON.stringify({ ok: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

  try {
    const supabaseUrl  = parseEnv("SUPABASE_URL");
    const serviceKey   = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const anthropicKey = parseEnv("ANTHROPIC_API_KEY");
    const botToken     = parseEnv("TELEGRAM_BOT_TOKEN");

    const body   = await req.json();
    const parsed = parseTelegram(body);

    // Ignore non-message updates (channel posts, etc.)
    if (!parsed || !parsed.text || !parsed.chatId) return respond();

    const { text, chatId, username } = parsed;

    // ── Route: /janus <message> ───────────────────────────────────
    if (text.startsWith("/janus")) {
      const userMsg = text.replace(/^\/janus\s*/i, "").trim() || "Hello";
      const { agent, memories } = await loadAgent(supabaseUrl, serviceKey, "janus");
      const reply = await janusReply(agent, memories, userMsg, username, anthropicKey);
      await storeContact(supabaseUrl, serviceKey, agent.id, agent.user_id, chatId, username).catch(() => {});
      await sendTelegram(botToken, chatId, `*${agent.name}:* ${reply}`);
      return respond();
    }

    // ── Route: /start ─────────────────────────────────────────────
    if (text.startsWith("/start")) {
      await sendTelegram(botToken, chatId, "👋 AtlasHUD online.\n\nChat with *Atlas* directly, or use `/janus <message>` to speak with Janus.");
      return respond();
    }

    // ── Route: everything else → Atlas ────────────────────────────
    const reply = await atlasReply(supabaseUrl, serviceKey, text, username);
    await sendTelegram(botToken, chatId, reply);
    return respond();

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[telegram-bridge]", msg);
    return respond(); // always 200 to prevent Telegram retries
  }
});
