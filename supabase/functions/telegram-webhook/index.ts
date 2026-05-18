// telegram-webhook — routes Telegram messages to Atlas or any Skyforge agent
// Bare message / @atlas → atlas-core (SSE)
// @janus (or any slug) → telegram-bridge (JSON)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function parseEnv(key: string): string {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Required env var ${key} is not set`);
  return val;
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {});
}

function parseAgentMention(text: string): { agentSlug: string | null; message: string } {
  const atMatch = text.match(/^@(\w+)\s+([\s\S]+)$/i);
  if (atMatch) return { agentSlug: atMatch[1].toLowerCase(), message: atMatch[2].trim() };
  const heyMatch = text.match(/^hey\s+(\w+)[,\s]+([\s\S]+)$/i);
  if (heyMatch) return { agentSlug: heyMatch[1].toLowerCase(), message: heyMatch[2].trim() };
  return { agentSlug: null, message: text };
}

async function callAtlas(supabaseUrl: string, serviceKey: string, userId: string, message: string): Promise<string> {
  const res = await fetch(`${supabaseUrl}/functions/v1/atlas-core`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "chat", messages: [{ role: "user", content: message }], user_id: userId }),
  });

  if (!res.ok || !res.body) return "Atlas unavailable.";

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let fullText = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.startsWith("data: ")) continue;
      const json = line.slice(6).trim();
      if (json === "[DONE]") break;
      try {
        const p = JSON.parse(json);
        if (p.type === "content_block_delta" && p.delta?.type === "text_delta") fullText += p.delta.text;
      } catch { /* */ }
    }
  }
  return fullText.trim() || "…";
}

async function callAgent(supabaseUrl: string, serviceKey: string, slug: string, message: string): Promise<string> {
  const res = await fetch(`${supabaseUrl}/functions/v1/telegram-bridge`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agent_slug: slug, message }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    return `Error ${res.status}: ${err.slice(0, 200) || `Agent '${slug}' not found`}`;
  }
  const data = await res.json().catch(() => ({}));
  return data.reply || `${slug} returned empty response.`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const BOT_TOKEN    = parseEnv("TELEGRAM_BOT_TOKEN");
    const OWNER_ID     = parseEnv("TELEGRAM_CHAT_ID");
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    const update = await req.json();
    const msg = update?.message;
    if (!msg?.text || !msg?.chat?.id) return new Response("ok", { headers: corsHeaders });

    const chatId = String(msg.chat.id);
    const text   = msg.text as string;

    if (chatId !== OWNER_ID) {
      await sendTelegram(BOT_TOKEN, chatId, "This is a private assistant.");
      return new Response("ok", { headers: corsHeaders });
    }

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    }).catch(() => {});

    const { agentSlug, message: routedMessage } = parseAgentMention(text);

    let reply: string;
    if (!agentSlug || agentSlug === "atlas") {
      reply = await callAtlas(SUPABASE_URL, SERVICE_KEY, OWNER_ID, routedMessage);
    } else {
      reply = await callAgent(SUPABASE_URL, SERVICE_KEY, agentSlug, routedMessage);
    }

    const chunks = reply.match(/[\s\S]{1,4000}/g) ?? [reply];
    for (const chunk of chunks) {
      await sendTelegram(BOT_TOKEN, chatId, chunk);
    }

    return new Response("ok", { headers: corsHeaders });
  } catch (e) {
    console.error("[telegram-webhook] Error:", e);
    return new Response("ok", { headers: corsHeaders });
  }
});
