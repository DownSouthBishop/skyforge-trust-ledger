// Telegram bridge — Atlas, Janus, Linda with shared cross-agent memory.
// Uses direct Telegram Bot API and Anthropic — no Lovable gateway dependency.
//
// Commands:
//   /atlas  @atlas  → Atlas (full forge_chat experience)
//   /janus  @janus  → Janus (scholar)
//   /linda  @linda  → Linda (chief of staff)
//   /start          → greeting + agent list
//   (bare message)  → routes to active agent (default: Atlas, resets after 24h)

import { corsHeaders, parseEnv, readCrossMemory, writeCrossMemory } from "../_shared/gateway.ts";

const BOT_API = "https://api.telegram.org/bot";

async function send(token: string, chatId: string, text: string): Promise<void> {
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

async function getSession(supabaseUrl: string, serviceKey: string, chatId: string): Promise<string> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/telegram_sessions?chat_id=eq.${chatId}&limit=1`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const rows = await res.json().catch(() => []);
  const s = rows?.[0];
  if (!s) return "atlas";
  if (s.last_message_at && Date.now() - new Date(s.last_message_at).getTime() > 86400000) return "atlas";
  return s.agent_slug ?? "atlas";
}

async function setSession(supabaseUrl: string, serviceKey: string, chatId: string, slug: string): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/telegram_sessions`, {
    method: "POST",
    headers: {
      apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ chat_id: chatId, agent_slug: slug, last_message_at: new Date().toISOString() }),
  }).catch(() => {});
}

function detectMention(text: string): { slug: string | null; message: string } {
  const single = text.trim().match(/^\/(atlas|janus|linda)$/i);
  if (single) return { slug: single[1].toLowerCase(), message: "" };
  const m = text.match(/^[@\/](atlas|janus|linda)\s+([\s\S]+)$/i);
  if (m) return { slug: m[1].toLowerCase(), message: m[2].trim() };
  const hey = text.match(/^hey\s+(atlas|janus|linda)[,\s]+([\s\S]+)$/i);
  if (hey) return { slug: hey[1].toLowerCase(), message: hey[2].trim() };
  return { slug: null, message: text };
}

async function getUserId(supabaseUrl: string, serviceKey: string): Promise<string> {
  const envId = Deno.env.get("ATLAS_USER_ID");
  if (envId) return envId;
  const res = await fetch(
    `${supabaseUrl}/rest/v1/skyforge_agents?is_active=eq.true&limit=1&select=user_id`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const rows = await res.json().catch(() => []);
  return rows?.[0]?.user_id ?? "";
}

async function callAtlas(supabaseUrl: string, serviceKey: string, userId: string, message: string): Promise<string> {
  const res = await fetch(`${supabaseUrl}/functions/v1/forge_chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: message }], user_id: userId }),
  });
  if (!res.ok || !res.body) return "Atlas unavailable.";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      let line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.startsWith("data: ")) continue;
      const json = line.slice(6).trim();
      if (json === "[DONE]") break;
      try { const p = JSON.parse(json); if (p.type === "content_block_delta" && p.delta?.type === "text_delta") full += p.delta.text; } catch { /* */ }
    }
  }
  return full.trim() || "...";
}

async function callAgent(
  supabaseUrl: string, serviceKey: string, apiKey: string,
  slug: string, message: string, crossMemory: string,
): Promise<string> {
  // Try the deployed edge function first (janus-teach for janus, linda-chat for linda)
  const fnMap: Record<string, string> = { janus: "janus-teach", linda: "linda-chat" };
  const fn = fnMap[slug];
  if (fn) {
    const action = slug === "janus" || slug === "linda-teach" ? "chat" : "chat";
    const res = await fetch(`${supabaseUrl}/functions/v1/${fn}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "chat", messages: [{ role: "user", content: message }] }),
    });
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", full = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          let line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (json === "[DONE]") break;
          try { const p = JSON.parse(json); if (p.type === "content_block_delta" && p.delta?.type === "text_delta") full += p.delta.text; } catch { /* */ }
        }
      }
      if (full.trim()) return full.trim();
    }
  }

  // Fallback: call Anthropic directly with agent identity
  const identities: Record<string, string> = {
    janus: "You are Janus — scholar, first principles thinker. Teach and explain anything from the ground up. Direct, concrete, no filler. Responding via Telegram — keep it tight.",
    linda: "You are Linda — Chief of Staff for WIG. Business, ops, people, persuasion. Plain language, actionable. Responding via Telegram — keep it tight.",
  };
  const systemParts = [identities[slug] ?? `You are ${slug}.`];
  if (crossMemory) systemParts.push(`WHAT BISHOP HAS BEEN DOING WITH OTHER AGENTS:\n${crossMemory}`);
  systemParts.push("Telegram response. No markdown headers. Lead with the answer.");

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022", max_tokens: 1024,
      system: systemParts.join("\n\n"),
      messages: [{ role: "user", content: message }],
    }),
  });
  if (!resp.ok) return `${slug} unavailable.`;
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

    const update = await req.json();
    const msg = update?.message ?? update?.edited_message;
    if (!msg?.text || !msg?.chat?.id) return new Response("ok", { headers: corsHeaders });

    const chatId = String(msg.chat.id);
    const text   = msg.text as string;

    if (chatId !== OWNER_ID) {
      await send(BOT_TOKEN, chatId, "Private assistant.");
      return new Response("ok", { headers: corsHeaders });
    }

    await typing(BOT_TOKEN, chatId);

    if (text.trim() === "/start") {
      await send(BOT_TOKEN, chatId, "WIG Command.\n\nAtlas online — your default.\n\n/janus or @janus — Scholar\n/linda or @linda — Chief of Staff\n/atlas to come back\n\nJust talk to switch.");
      await setSession(SUPABASE_URL, SERVICE_KEY, chatId, "atlas");
      return new Response("ok", { headers: corsHeaders });
    }

    const { slug: mentioned, message: routed } = detectMention(text);

    if (mentioned && !routed) {
      await setSession(SUPABASE_URL, SERVICE_KEY, chatId, mentioned);
      await send(BOT_TOKEN, chatId, { atlas: "Atlas.", janus: "Janus.", linda: "Linda." }[mentioned] ?? `${mentioned}.`);
      return new Response("ok", { headers: corsHeaders });
    }

    const active = mentioned ?? await getSession(SUPABASE_URL, SERVICE_KEY, chatId);
    const message = routed || text;
    const userId  = await getUserId(SUPABASE_URL, SERVICE_KEY);
    const crossMem = await readCrossMemory(SUPABASE_URL, SERVICE_KEY, userId, 8);

    let reply: string;
    if (active === "atlas") {
      reply = await callAtlas(SUPABASE_URL, SERVICE_KEY, userId, message);
    } else {
      reply = await callAgent(SUPABASE_URL, SERVICE_KEY, API_KEY, active, message, crossMem);
    }

    await setSession(SUPABASE_URL, SERVICE_KEY, chatId, active);
    await send(BOT_TOKEN, chatId, reply);
    writeCrossMemory(SUPABASE_URL, SERVICE_KEY, userId, active,
      `${active} and Bishop discussed via Telegram: ${message.slice(0, 80)}`,
    );

    return new Response("ok", { headers: corsHeaders });
  } catch (e) {
    console.error("[telegram-bridge]", e);
    return new Response("ok", { headers: corsHeaders });
  }
});
