// Atlas Telegram Gateway — Atlas, Janus, Linda with shared cross-agent memory.
//
// Commands:
//   /atlas  or @atlas <msg>  → Atlas
//   /janus  or @janus <msg>  → Janus
//   /linda  or @linda <msg>  → Linda
//   /start                   → greeting
//   (no mention)             → routes to active agent (default: Atlas)

import { corsHeaders, parseEnv, verifyUser, AuthError, readCrossMemory, writeCrossMemory } from "../_shared/gateway.ts";

const BOT_API = "https://api.telegram.org/bot";

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const chunks = text.match(/[\s\S]{1,4000}/g) ?? [text];
  for (const chunk of chunks) {
    await fetch(`${BOT_API}${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    }).catch(() => {});
  }
}

async function typing(token: string, chatId: string): Promise<void> {
  await fetch(`${BOT_API}${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

async function getActiveAgent(supabaseUrl: string, serviceKey: string, chatId: string): Promise<string> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/telegram_sessions?chat_id=eq.${chatId}&limit=1`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const rows = await res.json().catch(() => []);
  const session = rows?.[0];
  if (!session) return "atlas";
  // Reset to Atlas after 24h idle
  if (session.last_message_at) {
    const ageMs = Date.now() - new Date(session.last_message_at).getTime();
    if (ageMs > 24 * 3600 * 1000) return "atlas";
  }
  return session.active_agent ?? "atlas";
}

async function setActiveAgent(supabaseUrl: string, serviceKey: string, chatId: string, slug: string): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/telegram_sessions`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ chat_id: chatId, active_agent: slug, last_message_at: new Date().toISOString() }),
  }).catch(() => {});
}

function detectMention(text: string): { slug: string | null; message: string } {
  // /switch commands: /atlas /janus /linda (standalone)
  const single = text.trim().match(/^\/(atlas|janus|linda)$/i);
  if (single) return { slug: single[1].toLowerCase(), message: "" };
  // @mention or /command with message
  const m = text.match(/^[@\/](atlas|janus|linda)\s+([\s\S]+)$/i);
  if (m) return { slug: m[1].toLowerCase(), message: m[2].trim() };
  // "hey atlas ..." natural language
  const hey = text.match(/^hey\s+(atlas|janus|linda)[,\s]+([\s\S]+)$/i);
  if (hey) return { slug: hey[1].toLowerCase(), message: hey[2].trim() };
  return { slug: null, message: text };
}

async function callForgeChat(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  message: string,
): Promise<string> {
  const res = await fetch(`${supabaseUrl}/functions/v1/forge_chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: message }], user_id: userId }),
  });
  if (!res.ok || !res.body) return "Atlas unavailable right now.";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
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
        if (p.type === "content_block_delta" && p.delta?.type === "text_delta") full += p.delta.text;
      } catch { /* */ }
    }
  }
  return full.trim() || "...";
}

async function callTeacher(
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  agentSlug: string,
  userId: string,
  message: string,
  crossMemory: string,
): Promise<string> {
  // Load agent system prompt from registry
  const agentRes = await fetch(
    `${supabaseUrl}/rest/v1/skyforge_agents?slug=eq.${agentSlug}&is_active=eq.true&limit=1`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const agents = await agentRes.json().catch(() => []);
  const agent = agents?.[0];

  const identities: Record<string, string> = {
    janus: "You are Janus. Scholar. First principles. Deep understanding of any subject. Respond via Telegram — direct, concrete, no filler. No markdown headers.",
    linda: "You are Linda. Chief of Staff for WIG. Business, ops, people, persuasion. Respond via Telegram — plain language, actionable, no filler.",
  };

  const systemParts: string[] = [
    agent?.system_prompt ?? identities[agentSlug] ?? `You are ${agentSlug}.`,
  ];

  if (crossMemory) {
    systemParts.push(`WHAT BISHOP HAS BEEN DOING WITH OTHER AGENTS:\n${crossMemory}\nReference this where naturally relevant.`);
  }

  systemParts.push("You are responding via Telegram. Keep it tight. No markdown headers. Lead with the answer.");

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemParts.join("\n\n"),
      messages: [{ role: "user", content: message }],
    }),
  });

  if (!resp.ok) return `${agentSlug} unavailable.`;
  const data = await resp.json();
  return (data?.content as Array<{ type: string; text: string }>)?.find(b => b.type === "text")?.text?.trim() ?? "...";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const BOT_TOKEN    = parseEnv("TELEGRAM_BOT_TOKEN");
    const OWNER_ID     = parseEnv("TELEGRAM_CHAT_ID");
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("ANTHROPIC_API_KEY");

    // Auto-detect user ID from any agent record — no ATLAS_USER_ID secret needed
    let USER_ID = Deno.env.get("ATLAS_USER_ID") ?? "";
    if (!USER_ID) {
      const agentRes = await fetch(
        `${SUPABASE_URL}/rest/v1/skyforge_agents?is_active=eq.true&limit=1&select=user_id`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
      );
      const agents = await agentRes.json().catch(() => []);
      USER_ID = agents?.[0]?.user_id ?? "";
    }
    if (!USER_ID) return new Response("ok", { headers: corsHeaders }); // no user configured yet

    const update = await req.json();
    const msg = update?.message ?? update?.edited_message;
    if (!msg?.text || !msg?.chat?.id) return new Response("ok", { headers: corsHeaders });

    const chatId = String(msg.chat.id);
    const text   = msg.text as string;

    // Only respond to owner
    if (chatId !== OWNER_ID) {
      await sendTelegram(BOT_TOKEN, chatId, "Private assistant. Unauthorized.");
      return new Response("ok", { headers: corsHeaders });
    }

    await typing(BOT_TOKEN, chatId);

    // /start
    if (text.trim() === "/start") {
      await sendTelegram(BOT_TOKEN, chatId, "WIG Command. Atlas online.\n\n/atlas /janus /linda to switch agents.\n@atlas, @janus, @linda to mention directly.");
      await setActiveAgent(SUPABASE_URL, SERVICE_KEY, chatId, "atlas");
      return new Response("ok", { headers: corsHeaders });
    }

    const { slug: mentioned, message: routedMessage } = detectMention(text);

    // Single switch command — no message
    if (mentioned && !routedMessage) {
      await setActiveAgent(SUPABASE_URL, SERVICE_KEY, chatId, mentioned);
      const ack: Record<string, string> = { atlas: "Atlas.", janus: "Janus.", linda: "Linda." };
      await sendTelegram(BOT_TOKEN, chatId, ack[mentioned] ?? `${mentioned}.`);
      return new Response("ok", { headers: corsHeaders });
    }

    const activeSlug = mentioned ?? await getActiveAgent(SUPABASE_URL, SERVICE_KEY, chatId);
    const finalMessage = routedMessage || text;

    // Read cross-agent memory for context
    const crossMemory = await readCrossMemory(SUPABASE_URL, SERVICE_KEY, USER_ID, 8);

    let reply: string;
    if (activeSlug === "atlas") {
      reply = await callForgeChat(SUPABASE_URL, SERVICE_KEY, USER_ID, finalMessage);
    } else {
      reply = await callTeacher(SUPABASE_URL, SERVICE_KEY, API_KEY, activeSlug, USER_ID, finalMessage, crossMemory);
    }

    await setActiveAgent(SUPABASE_URL, SERVICE_KEY, chatId, activeSlug);
    await sendTelegram(BOT_TOKEN, chatId, reply);

    // Write to cross-agent memory
    writeCrossMemory(SUPABASE_URL, SERVICE_KEY, USER_ID, activeSlug,
      `${activeSlug} and Bishop discussed via Telegram: ${finalMessage.slice(0, 80)}`,
    );

    return new Response("ok", { headers: corsHeaders });

  } catch (e) {
    console.error("[telegram-webhook]", e);
    return new Response("ok", { headers: corsHeaders });
  }
});
