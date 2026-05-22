// telegram-bridge — full router for AtlasHUD bot
// /janus <message>  → Janus sub-agent
// everything else   → Atlas
// Sends replies via Telegram connector gateway. LLM via Lovable AI Gateway.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MODEL = "google/gemini-2.5-flash";
const TELEGRAM_GATEWAY = "https://connector-gateway.lovable.dev/telegram";

function parseEnv(key: string): string {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Required env var ${key} is not set`);
  return val;
}

function telegramHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${parseEnv("LOVABLE_API_KEY")}`,
    "X-Connection-Api-Key": parseEnv("TELEGRAM_API_KEY"),
    "Content-Type": "application/json",
  };
}

function parseTelegram(body: Record<string, unknown>) {
  const msg = (body.message ?? body.edited_message) as Record<string, unknown> | undefined;
  if (!msg) return null;
  const text     = String(msg.text ?? msg.caption ?? "").trim();
  const chatId   = String((msg.chat as Record<string, unknown>)?.id ?? "");
  const from     = msg.from as Record<string, unknown> | undefined;
  const username = String(from?.username ?? from?.first_name ?? "user");
  return { text, chatId, username };
}

async function sendTelegram(chatId: string, text: string) {
  const r = await fetch(`${TELEGRAM_GATEWAY}/sendMessage`, {
    method: "POST",
    headers: telegramHeaders(),
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  if (!r.ok) console.error("[telegram-bridge] sendMessage failed", r.status, await r.text());
}

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

async function loadConversationHistory(
  supabaseUrl: string, serviceKey: string, agentId: string, limit = 10,
): Promise<Array<{ role: string; content: string }>> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/agent_sessions?agent_id=eq.${agentId}&order=completed_at.desc&limit=${limit}&select=messages`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!res.ok) return [];
    const sessions = await res.json() as Array<{ messages: Array<{ role: string; content: string }> }>;
    const history: Array<{ role: string; content: string }> = [];
    for (const session of sessions.reverse()) {
      if (Array.isArray(session.messages)) {
        for (const m of session.messages) {
          if ((m.role === "user" || m.role === "assistant") && m.content) {
            history.push({ role: m.role, content: String(m.content) });
          }
        }
      }
    }
    return history.slice(-20);
  } catch { return []; }
}

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

async function logSession(
  supabaseUrl: string, serviceKey: string, agentId: string, userId: string,
  taskDescription: string,
  messages: Array<{ role: string; content: string }>,
  outcome: "success" | "failed",
): Promise<string | null> {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/agent_sessions`, {
      method: "POST",
      headers: {
        apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json", Prefer: "return=representation",
      },
      body: JSON.stringify({
        agent_id: agentId, user_id: userId,
        task_description: taskDescription.slice(0, 500),
        messages, outcome, completed_at: new Date().toISOString(),
      }),
    });
    const rows = await res.json();
    return rows?.[0]?.id ?? null;
  } catch { return null; }
}

// ── Find or create Atlas agent record ────────────────────────────────────────
async function findOrCreateAtlasAgentForTelegram(supabaseUrl: string, serviceKey: string) {
  try {
    const hdrs = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
    const res = await fetch(
      `${supabaseUrl}/rest/v1/skyforge_agents?slug=eq.atlas&is_active=eq.true&limit=1`,
      { headers: hdrs },
    );
    const rows = await res.json();
    if (rows?.[0]?.id) return { id: rows[0].id, user_id: rows[0].user_id, system_prompt: rows[0].system_prompt, name: rows[0].name, reflect_after_sessions: rows[0].reflect_after_sessions ?? 5 };
    return null;
  } catch { return null; }
}

// ── Call Lovable AI Gateway ──────────────────────────────────────────────────
async function llmReply(
  apiKey: string,
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  userText: string,
): Promise<string> {
  const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userText },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`AI Gateway ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);

  // Register webhook via gateway
  if (url.pathname.endsWith("/register-webhook")) {
    try {
      const supaUrl = parseEnv("SUPABASE_URL");
      const webhookUrl = `${supaUrl}/functions/v1/telegram-bridge`;
      const r = await fetch(`${TELEGRAM_GATEWAY}/setWebhook`, {
        method: "POST",
        headers: telegramHeaders(),
        body: JSON.stringify({
          url: webhookUrl,
          allowed_updates: ["message", "edited_message"],
        }),
      });
      const result = await r.json();
      return new Response(JSON.stringify(result), {
        status: r.ok ? 200 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // Webhook info
  if (url.pathname.endsWith("/webhook-info")) {
    const r = await fetch(`${TELEGRAM_GATEWAY}/getWebhookInfo`, {
      method: "POST", headers: telegramHeaders(), body: "{}",
    });
    return new Response(await r.text(), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Always 200 to Telegram
  const respond = () => new Response(JSON.stringify({ ok: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

  try {
    const supabaseUrl  = parseEnv("SUPABASE_URL");
    const serviceKey   = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const lovableKey   = parseEnv("LOVABLE_API_KEY");

    const body   = await req.json();
    const parsed = parseTelegram(body);
    if (!parsed || !parsed.text || !parsed.chatId) return respond();

    const { text, chatId, username } = parsed;

    // ── /janus or @janus ──────────────────────────────
    const janusMatch = text.match(/^(?:\/janus|@janus\w*)\s*/i);
    if (janusMatch) {
      const userMsg = text.slice(janusMatch[0].length).trim() || "Hello";
      const { agent, memories } = await loadAgent(supabaseUrl, serviceKey, "janus");
      const history = await loadConversationHistory(supabaseUrl, serviceKey, String(agent.id));
      const parts: string[] = [];
      if (agent.system_prompt) parts.push(String(agent.system_prompt));
      if (Array.isArray(agent.bio) && agent.bio.length)
        parts.push("Background:\n" + (agent.bio as string[]).map((b) => `- ${b}`).join("\n"));
      if (memories.length)
        parts.push("Active memory:\n" + memories.map((m: Record<string, unknown>) => `[${m.memory_type}] ${m.key}: ${m.value}`).join("\n"));
      parts.push(`Responding via Telegram to @${username}. Be concise and natural. No markdown headers.`);

      const reply = await llmReply(lovableKey, parts.join("\n\n"), history, userMsg);
      await storeContact(supabaseUrl, serviceKey, agent.id, agent.user_id, chatId, username).catch(() => {});
      await sendTelegram(chatId, `*${agent.name}:* ${reply}`);
      (async () => {
        await logSession(
          supabaseUrl, serviceKey, String(agent.id), String(agent.user_id),
          userMsg,
          [{ role: "user", content: `@${username}: ${userMsg}` }, { role: "assistant", content: reply }],
          "success",
        );
      })().catch(() => {});
      return respond();
    }

    // ── /start ─────────────────────────────────────────
    if (text.startsWith("/start")) {
      await sendTelegram(chatId, "👋 *AtlasHUD* online.\n\n• Send any message to talk to *Atlas*\n• Use `/janus <message>` or `@janus <message>` to talk to *Janus*");
      return respond();
    }

    // ── Atlas (default) ────────────────────────────────
    const atlasAgent = await findOrCreateAtlasAgentForTelegram(supabaseUrl, serviceKey);
    const history = atlasAgent ? await loadConversationHistory(supabaseUrl, serviceKey, atlasAgent.id) : [];
    const sys = atlasAgent?.system_prompt
      ? `${atlasAgent.system_prompt}\n\nResponding via Telegram to @${username}. Be concise. No markdown headers.`
      : `You are Atlas. Responding via Telegram to @${username}. Be concise and direct.`;
    const reply = await llmReply(lovableKey, sys, history, text);
    await sendTelegram(chatId, reply);
    (async () => {
      if (atlasAgent) {
        await logSession(
          supabaseUrl, serviceKey, atlasAgent.id, atlasAgent.user_id,
          text,
          [{ role: "user", content: `@${username}: ${text}` }, { role: "assistant", content: reply }],
          "success",
        );
      }
    })().catch(() => {});
    return respond();

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[telegram-bridge]", msg);
    return respond();
  }
});
