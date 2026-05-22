// telegram-bridge — Atlas (default) + Janus via @mention with sticky session.
//
// Routing:
//   • @atlas <msg>  → Atlas, set active_agent=atlas
//   • @janus <msg>  → Janus, set active_agent=janus
//   • /atlas, /janus single-word → switch active agent
//   • no mention   → route to whichever agent is active for this chat
//   • Atlas is the permanent default; sessions older than 24h reset to atlas
//
// Shared memory: every turn fires agent_remember.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MODEL = "google/gemini-2.5-flash";
const TELEGRAM_GATEWAY = "https://connector-gateway.lovable.dev/telegram";

function envOrThrow(k: string): string {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
}

function telegramHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${envOrThrow("LOVABLE_API_KEY")}`,
    "X-Connection-Api-Key": envOrThrow("TELEGRAM_API_KEY"),
    "Content-Type": "application/json",
  };
}

function parseTelegram(body: Record<string, unknown>) {
  const msg = (body.message ?? body.edited_message) as Record<string, unknown> | undefined;
  if (!msg) return null;
  const text = String(msg.text ?? msg.caption ?? "").trim();
  const chatId = String((msg.chat as Record<string, unknown>)?.id ?? "");
  const from = msg.from as Record<string, unknown> | undefined;
  const username = String(from?.username ?? from?.first_name ?? "user");
  return { text, chatId, username };
}

async function sendTelegram(chatId: string, text: string) {
  const chunks = text.match(/[\s\S]{1,4000}/g) ?? [text];
  for (const chunk of chunks) {
    const r = await fetch(`${TELEGRAM_GATEWAY}/sendMessage`, {
      method: "POST",
      headers: telegramHeaders(),
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!r.ok) console.error("[telegram-bridge] sendMessage", r.status, await r.text());
  }
}

// ── Session state ──────────────────────────────────────────────────────────
async function getSession(supabaseUrl: string, serviceKey: string, chatId: string): Promise<{ active_agent: string; user_id: string | null; last_message_at: string } | null> {
  const r = await fetch(
    `${supabaseUrl}/rest/v1/telegram_sessions?chat_id=eq.${encodeURIComponent(chatId)}&limit=1`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  if (!r.ok) return null;
  const rows = await r.json();
  return rows?.[0] ?? null;
}

async function upsertSession(supabaseUrl: string, serviceKey: string, chatId: string, agent: string, userId: string | null) {
  await fetch(`${supabaseUrl}/rest/v1/telegram_sessions`, {
    method: "POST",
    headers: {
      apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      chat_id: chatId,
      user_id: userId,
      active_agent: agent,
      last_message_at: new Date().toISOString(),
    }),
  });
}

// ── Agent + memory loading ─────────────────────────────────────────────────
async function loadAgent(supabaseUrl: string, serviceKey: string, slug: string) {
  const r = await fetch(
    `${supabaseUrl}/rest/v1/skyforge_agents?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&limit=1`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const rows = await r.json();
  const agent = rows?.[0];
  if (!agent) throw new Error(`Agent not found: ${slug}`);
  return agent;
}

async function loadSharedMemory(supabaseUrl: string, serviceKey: string, userId: string) {
  const r = await fetch(
    `${supabaseUrl}/rest/v1/shared_operator_memory?user_id=eq.${userId}&order=updated_at.desc&limit=40&select=memory_type,key,value,source_agent`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  if (!r.ok) return [];
  return await r.json() as Array<{ memory_type: string; key: string; value: string; source_agent: string }>;
}

function buildSystemPrompt(agent: Record<string, unknown>, agentSlug: string, memories: Array<{ memory_type: string; value: string; source_agent: string }>, username: string): string {
  const parts: string[] = [];
  parts.push(String(agent.system_prompt ?? ""));

  if (memories.length) {
    const grouped: Record<string, string[]> = {};
    for (const m of memories) (grouped[m.memory_type] ||= []).push(`- ${m.value}`);
    parts.push("WHAT I KNOW ABOUT YOU:\n" +
      Object.entries(grouped).map(([t, lines]) => `${t.toUpperCase()}\n${lines.slice(0, 10).join("\n")}`).join("\n\n"));

    const otherSlug = agentSlug === "atlas" ? "janus" : "atlas";
    const otherMems = memories.filter(m => m.source_agent === otherSlug).slice(0, 10);
    if (otherMems.length) {
      parts.push("WHAT THE OTHER AGENT KNOWS (factor in silently, do not attribute):\n" +
        otherMems.map(m => `- [${m.memory_type}] ${m.value}`).join("\n"));
    }
  }

  if (agentSlug === "janus") {
    parts.push("If the operator asks for execution (place a trade, run the brief, check positions), give your advisory read and note that Atlas handles execution. Do not attempt to execute.");
  }

  parts.push(`You are responding via Telegram to @${username}. Keep replies tight. No markdown headers. Never reference any memory system — just know what you know.`);
  return parts.join("\n\n");
}

async function llmReply(apiKey: string, systemPrompt: string, userText: string): Promise<string> {
  const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
    }),
  });
  if (!r.ok) throw new Error(`AI gateway ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

async function fireRemember(supabaseUrl: string, userId: string, sourceAgent: string, userMsg: string, assistantMsg: string) {
  try {
    await fetch(`${supabaseUrl}/functions/v1/agent_remember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        source_agent: sourceAgent,
        user_message: userMsg,
        assistant_message: assistantMsg,
        context: "telegram",
      }),
    });
  } catch { /* non-critical */ }
}

// ── Routing helpers ────────────────────────────────────────────────────────
function detectMention(text: string): { slug: string | null; stripped: string } {
  const single = text.trim().match(/^\/(atlas|janus)$/i);
  if (single) return { slug: single[1].toLowerCase(), stripped: "" };
  const m = text.match(/@(atlas|janus)\b/i);
  if (m) {
    const slug = m[1].toLowerCase();
    const stripped = text.replace(new RegExp(`@${slug}\\b`, "ig"), "").trim();
    return { slug, stripped };
  }
  const slash = text.match(/^\/(atlas|janus)\s+([\s\S]+)$/i);
  if (slash) return { slug: slash[1].toLowerCase(), stripped: slash[2].trim() };
  return { slug: null, stripped: text };
}

// ── Main handler ───────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const url = new URL(req.url);

  if (url.pathname.endsWith("/register-webhook")) {
    try {
      const supaUrl = envOrThrow("SUPABASE_URL");
      const r = await fetch(`${TELEGRAM_GATEWAY}/setWebhook`, {
        method: "POST", headers: telegramHeaders(),
        body: JSON.stringify({ url: `${supaUrl}/functions/v1/telegram-bridge`, allowed_updates: ["message", "edited_message"] }),
      });
      return new Response(await r.text(), { status: r.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }

  if (url.pathname.endsWith("/webhook-info")) {
    const r = await fetch(`${TELEGRAM_GATEWAY}/getWebhookInfo`, { method: "POST", headers: telegramHeaders(), body: "{}" });
    return new Response(await r.text(), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const respond = () => new Response(JSON.stringify({ ok: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

  try {
    const supabaseUrl = envOrThrow("SUPABASE_URL");
    const serviceKey  = envOrThrow("SUPABASE_SERVICE_ROLE_KEY");
    const lovableKey  = envOrThrow("LOVABLE_API_KEY");

    const body = await req.json();
    const parsed = parseTelegram(body);
    if (!parsed || !parsed.text || !parsed.chatId) return respond();
    const { text, chatId, username } = parsed;

    if (text === "/start") {
      await sendTelegram(chatId, "Atlas online. Default agent. Mention @janus for Janus, or send /janus to switch sessions. /atlas to come back.");
      await upsertSession(supabaseUrl, serviceKey, chatId, "atlas", null);
      return respond();
    }

    // Determine active agent
    let session = await getSession(supabaseUrl, serviceKey, chatId);
    let activeAgent = session?.active_agent ?? "atlas";

    // 24h reset to atlas
    if (session?.last_message_at) {
      const ageMs = Date.now() - new Date(session.last_message_at).getTime();
      if (ageMs > 24 * 3600 * 1000) activeAgent = "atlas";
    }

    const { slug: mentioned, stripped } = detectMention(text);
    let messageBody = text;
    if (mentioned) {
      activeAgent = mentioned;
      messageBody = stripped || "Hello";
    }

    // Load the agent record to get the owning user_id
    const agent = await loadAgent(supabaseUrl, serviceKey, activeAgent);
    const userId = String(agent.user_id);

    // Single-word switch acknowledgement
    if (mentioned && !stripped) {
      await upsertSession(supabaseUrl, serviceKey, chatId, activeAgent, userId);
      await sendTelegram(chatId, activeAgent === "janus" ? "Janus." : "Atlas.");
      return respond();
    }

    const sharedMem = await loadSharedMemory(supabaseUrl, serviceKey, userId);
    const sysPrompt = buildSystemPrompt(agent as Record<string, unknown>, activeAgent, sharedMem, username);
    const reply = await llmReply(lovableKey, sysPrompt, messageBody);

    await upsertSession(supabaseUrl, serviceKey, chatId, activeAgent, userId);
    await sendTelegram(chatId, reply);

    // Fire-and-forget memory extraction
    void fireRemember(supabaseUrl, userId, activeAgent, messageBody, reply);

    return respond();
  } catch (err) {
    console.error("[telegram-bridge]", err);
    return respond();
  }
});
