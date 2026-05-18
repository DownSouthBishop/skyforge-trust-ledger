// telegram-webhook — receives messages from @AtlasHUD_bot and responds via Atlas
// Register this URL with Telegram: POST /setWebhook

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  }).catch(() => {});
}

// Parse "@agentslug message" or "hey agentname, message" from text
function parseAgentMention(text: string): { agentSlug: string | null; message: string } {
  const atMatch = text.match(/^@(\w+)\s+([\s\S]+)$/i);
  if (atMatch) return { agentSlug: atMatch[1].toLowerCase(), message: atMatch[2].trim() };
  const heyMatch = text.match(/^hey\s+(\w+)[,\s]+([\s\S]+)$/i);
  if (heyMatch) return { agentSlug: heyMatch[1].toLowerCase(), message: heyMatch[2].trim() };
  return { agentSlug: null, message: text };
}

async function streamAgentResponse(
  supabaseUrl: string,
  serviceKey: string,
  agentSlug: string,
  userMessage: string,
): Promise<string> {
  const res = await fetch(`${supabaseUrl}/functions/v1/agent-chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent_slug: agentSlug,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok || !res.body) return "Agent unavailable right now.";

  const reader  = res.body.getReader();
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

async function streamAtlasResponse(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  userMessage: string,
): Promise<string> {
  const res = await fetch(`${supabaseUrl}/functions/v1/atlas-core`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "chat",
      messages: [{ role: "user", content: userMessage }],
      user_id: userId,
    }),
  });

  if (!res.ok || !res.body) return "Atlas is unavailable right now.";

  const reader  = res.body.getReader();
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
        if (p.type === "content_block_delta" && p.delta?.type === "text_delta") {
          fullText += p.delta.text;
        }
      } catch { /* */ }
    }
  }

  return fullText.trim() || "…";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const BOT_TOKEN   = parseEnv("TELEGRAM_BOT_TOKEN");
    const OWNER_ID    = parseEnv("TELEGRAM_CHAT_ID");
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    const update = await req.json();
    const message = update?.message;
    if (!message?.text || !message?.chat?.id) {
      return new Response("ok", { headers: corsHeaders });
    }

    const chatId     = String(message.chat.id);
    const text       = message.text as string;
    const senderName = message.from?.first_name ?? "Operator";

    // Only respond to the owner
    if (chatId !== OWNER_ID) {
      await sendTelegram(BOT_TOKEN, chatId, "This is a private assistant.");
      return new Response("ok", { headers: corsHeaders });
    }

    // Send typing indicator
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    }).catch(() => {});

    // Route: @agentslug or "hey agentname" → agent-chat, else → Atlas
    const { agentSlug, message: routedMessage } = parseAgentMention(text);
    const reply = agentSlug
      ? await streamAgentResponse(SUPABASE_URL, SERVICE_KEY, agentSlug, routedMessage)
      : await streamAtlasResponse(SUPABASE_URL, SERVICE_KEY, OWNER_ID, text);

    // Telegram has a 4096 char limit — split if needed
    const chunks = reply.match(/[\s\S]{1,4000}/g) ?? [reply];
    for (const chunk of chunks) {
      await sendTelegram(BOT_TOKEN, chatId, chunk);
    }

    return new Response("ok", { headers: corsHeaders });
  } catch (e) {
    console.error("[telegram-webhook] Error:", e);
    return new Response("ok", { headers: corsHeaders }); // always 200 to Telegram
  }
});
