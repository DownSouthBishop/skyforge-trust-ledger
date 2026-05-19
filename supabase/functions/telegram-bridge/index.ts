// telegram-bridge — full router for AtlasHUD bot
// /janus <message>  → Janus sub-agent (loads character + memory from DB)
// everything else   → Atlas (calls Anthropic directly with conversation history)
// Sends replies directly to Telegram Bot API

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

  const text     = String(msg.text ?? msg.caption ?? "").trim();
  const chatId   = String((msg.chat as Record<string, unknown>)?.id ?? "");
  const from     = msg.from as Record<string, unknown> | undefined;
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

// ── Load recent conversation history from agent_sessions ─────────────────────
async function loadConversationHistory(
  supabaseUrl: string,
  serviceKey: string,
  agentId: string,
  limit: number = 10,
): Promise<Array<{ role: string; content: string }>> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/agent_sessions?agent_id=eq.${agentId}&order=completed_at.desc&limit=${limit}&select=messages`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!res.ok) return [];
    const sessions = await res.json() as Array<{ messages: Array<{ role: string; content: string }> }>;
    const history: Array<{ role: string; content: string }> = [];
    // Reverse so oldest session is first (chronological order)
    for (const session of sessions.reverse()) {
      if (Array.isArray(session.messages)) {
        for (const m of session.messages) {
          if ((m.role === "user" || m.role === "assistant") && m.content) {
            history.push({ role: m.role, content: String(m.content) });
          }
        }
      }
    }
    // Keep last 20 turns to stay well within context
    return history.slice(-20);
  } catch {
    return [];
  }
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

// ── Session logging & reflection helpers ─────────────────────────────────────

async function logSession(
  supabaseUrl: string,
  serviceKey: string,
  agentId: string,
  userId: string,
  taskDescription: string,
  messages: Array<{ role: string; content: string }>,
  outcome: "success" | "failed",
): Promise<string | null> {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/agent_sessions`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        agent_id: agentId,
        user_id: userId,
        task_description: taskDescription.slice(0, 500),
        messages,
        outcome,
        completed_at: new Date().toISOString(),
      }),
    });
    const rows = await res.json();
    return rows?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function maybeAutoReflect(
  supabaseUrl: string,
  serviceKey: string,
  agentId: string,
  userId: string,
  reflectAfterN: number,
): Promise<void> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/agent_sessions?agent_id=eq.${agentId}&reflected=eq.false&select=id`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          Prefer: "count=exact",
          "Range-Unit": "items",
          Range: "0-0",
        },
      },
    );
    const rangeHeader = res.headers.get("content-range") ?? "";
    const total = parseInt(rangeHeader.split("/")[1] ?? "0") || 0;
    if (total >= reflectAfterN) {
      await fetch(`${supabaseUrl}/functions/v1/agent_reflect`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, user_id: userId }),
      });
    }
  } catch { /* non-critical */ }
}

// ── Find or create Atlas agent record ────────────────────────────────────────
async function findOrCreateAtlasAgentForTelegram(
  supabaseUrl: string,
  serviceKey: string,
): Promise<{ id: string; user_id: string; reflect_after_sessions: number } | null> {
  try {
    const hdrs = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
    const res = await fetch(
      `${supabaseUrl}/rest/v1/skyforge_agents?slug=eq.atlas&is_active=eq.true&limit=1`,
      { headers: hdrs },
    );
    const rows = await res.json();
    if (rows?.[0]?.id) return { id: rows[0].id, user_id: rows[0].user_id, reflect_after_sessions: rows[0].reflect_after_sessions ?? 5 };

    // Get owner from any active agent
    const anyRes = await fetch(
      `${supabaseUrl}/rest/v1/skyforge_agents?is_active=eq.true&limit=1`,
      { headers: hdrs },
    );
    const anyRows = await anyRes.json();
    if (!anyRows?.[0]) return null;
    const ownerId = anyRows[0].user_id;

    const createRes = await fetch(`${supabaseUrl}/rest/v1/skyforge_agents`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        user_id: ownerId,
        name: "Atlas",
        slug: "atlas",
        role: "AI wealth engine and primary assistant",
        system_prompt: "You are Atlas, an AI wealth engine and primary assistant. You help the operator build wealth through trading, real estate, and business.",
        is_active: true,
        reflect_after_sessions: 5,
      }),
    });
    const created = await createRes.json();
    if (created?.[0]?.id) return { id: created[0].id, user_id: created[0].user_id, reflect_after_sessions: 5 };
    return null;
  } catch {
    return null;
  }
}

// ── Call Anthropic for Janus (with conversation history) ─────────────────────
async function janusReply(
  agent: Record<string, unknown>,
  memories: Array<Record<string, unknown>>,
  history: Array<{ role: string; content: string }>,
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

  const messages = [
    ...history,
    { role: "user", content: userText },
  ];

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: ATLAS_MODEL, max_tokens: 1024,
      system: parts.join("\n\n"),
      messages,
    }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data?.content?.find((b: { type: string }) => b.type === "text")?.text ?? "";
}

// ── Call Anthropic for Atlas (with conversation history) ─────────────────────
// Calls Anthropic directly (not via atlas-core) so we can pass history and avoid
// the SSE streaming mismatch that caused Atlas to reset context mid-conversation.
async function atlasReply(
  history: Array<{ role: string; content: string }>,
  userText: string,
  username: string,
  apiKey: string,
): Promise<string> {
  const messages = [
    ...history,
    { role: "user", content: userText },
  ];

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: ATLAS_MODEL,
      max_tokens: 1024,
      system: `You are Atlas, an AI wealth engine and primary assistant. You are responding via Telegram to @${username}. Be concise and direct. No markdown headers. Remember everything discussed in this conversation.`,
      messages,
    }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data?.content?.find((b: { type: string }) => b.type === "text")?.text ?? "I'm here.";
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

    // ── Route: /janus <msg>  OR  @janus <msg> ────────────────────
    const janusMatch = text.match(/^(?:\/janus|@janus\w*)\s*/i);
    if (janusMatch) {
      const userMsg = text.slice(janusMatch[0].length).trim() || "Hello";
      const { agent, memories } = await loadAgent(supabaseUrl, serviceKey, "janus");
      // Load Janus conversation history so he remembers prior exchanges
      const history = await loadConversationHistory(supabaseUrl, serviceKey, String(agent.id));
      const reply = await janusReply(agent, memories, history, userMsg, username, anthropicKey);
      await storeContact(supabaseUrl, serviceKey, agent.id, agent.user_id, chatId, username).catch(() => {});
      await sendTelegram(botToken, chatId, `*${agent.name}:* ${reply}`);
      // Fire-and-forget: log session + maybe reflect
      (async () => {
        const sessionId = await logSession(
          supabaseUrl, serviceKey, String(agent.id), String(agent.user_id),
          userMsg,
          [{ role: "user", content: `@${username}: ${userMsg}` }, { role: "assistant", content: reply }],
          "success",
        );
        if (sessionId) {
          await maybeAutoReflect(supabaseUrl, serviceKey, String(agent.id), String(agent.user_id), Number(agent.reflect_after_sessions ?? 5));
        }
      })().catch(() => {});
      return respond();
    }

    // ── Route: /start ─────────────────────────────────────────────
    if (text.startsWith("/start")) {
      await sendTelegram(botToken, chatId, "👋 *AtlasHUD* online.\n\n• Send any message to talk to *Atlas*\n• Use `/janus <message>` or `@janus <message>` to talk to *Janus*");
      return respond();
    }

    // ── Route: everything else → Atlas ───────────────────────────
    // Load Atlas agent + history before replying so Atlas remembers the conversation
    const atlasAgent = await findOrCreateAtlasAgentForTelegram(supabaseUrl, serviceKey);
    const history = atlasAgent ? await loadConversationHistory(supabaseUrl, serviceKey, atlasAgent.id) : [];
    const reply = await atlasReply(history, text, username, anthropicKey);
    await sendTelegram(botToken, chatId, reply);
    // Fire-and-forget: log session + maybe reflect
    (async () => {
      if (atlasAgent) {
        const sessionId = await logSession(
          supabaseUrl, serviceKey, atlasAgent.id, atlasAgent.user_id,
          text,
          [{ role: "user", content: `@${username}: ${text}` }, { role: "assistant", content: reply }],
          "success",
        );
        if (sessionId) {
          await maybeAutoReflect(supabaseUrl, serviceKey, atlasAgent.id, atlasAgent.user_id, atlasAgent.reflect_after_sessions);
        }
      }
    })().catch(() => {});
    return respond();

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[telegram-bridge]", msg);
    return respond(); // always 200 to prevent Telegram retries
  }
});
