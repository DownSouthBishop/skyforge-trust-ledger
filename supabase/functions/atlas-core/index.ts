// atlas-core — Atlas chat proxy via Lovable AI Gateway
// Translates OpenAI-style streaming chunks into Anthropic-style SSE
// so the existing AtlasPage frontend parser keeps working.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sseText(message: string): Response {
  const encoder = new TextEncoder();
  const safe = message.trim() || "Atlas is temporarily unavailable.";
  const events = [
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: safe } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";

  return new Response(encoder.encode(events), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

async function verifyToken(
  authHeader: string | null,
  supabaseUrl: string,
  serviceKey: string,
): Promise<string> {
  if (!authHeader) throw new Error("Missing Authorization header");
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) throw new Error("Empty token");
  // Accept service-role bearer (used by other edge functions calling this one)
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (payload?.role === "service_role") return "system";
  } catch { /* fall through */ }
  const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: serviceKey },
  });
  if (!resp.ok) throw new Error(`Auth failed: ${resp.status}`);
  const data = await resp.json();
  if (!data?.id) throw new Error("No user ID in token");
  return data.id as string;
}

// Flatten Anthropic-style content blocks into plain text for gateway.
function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const LOVABLE_KEY  = Deno.env.get("LOVABLE_API_KEY") ?? "";
  const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("Claude_API") ?? Deno.env.get("CLAUDE_API") ?? "";

  if (!LOVABLE_KEY && !ANTHROPIC_KEY) {
    return json({ error: "No AI provider configured (need ANTHROPIC_API_KEY or LOVABLE_API_KEY)" }, 500);
  }

  try {
    await verifyToken(req.headers.get("Authorization"), SUPABASE_URL, SERVICE_KEY);
  } catch (e) {
    return json({ error: String(e) }, 401);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const rawMessages = Array.isArray(body.messages) ? body.messages as Array<{ role: string; content: unknown }> : [];
  const system = typeof body.system === "string" ? body.system : "";
  const tools = Array.isArray(body.tools) ? body.tools : undefined;

  // Prefer Anthropic when key is present
  if (ANTHROPIC_KEY) {
    const model = Deno.env.get("ATLAS_ANTHROPIC_MODEL") ?? "claude-sonnet-4-5-20250929";
    const cleanMessages = rawMessages
      .filter((m) => m?.role === "user" || m?.role === "assistant")
      .map((m) => ({ role: m.role, content: flatten(m.content) }))
      .filter((m) => m.content);
    if (cleanMessages.length === 0) cleanMessages.push({ role: "user", content: "[Session opened.]" });

    let aResp: Response;
    try {
      aResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4000,
          system,
          messages: cleanMessages,
          stream: true,
          ...(tools ? { tools } : {}),
        }),
      });
    } catch (e) {
      console.error("[atlas-core] Anthropic fetch failed", e);
      return sseText("Atlas could not reach Anthropic right now. Check the Anthropic connection and try again.");
    }

    if (!aResp.ok || !aResp.body) {
      const errText = await aResp.text().catch(() => "");
      console.error(`[atlas-core] Anthropic ${aResp.status}:`, errText.slice(0, 400));
      if (aResp.status === 401 || aResp.status === 403) {
        return sseText("Atlas is connected to Anthropic, but the API key was rejected. Update ANTHROPIC_API_KEY and try again.");
      }
      if (aResp.status === 429) {
        return sseText("Anthropic is rate-limiting Atlas right now. Wait a moment, then try again.");
      }
      return sseText(`Anthropic returned ${aResp.status}. Atlas could not complete the request yet.`);
    }

    return new Response(aResp.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  // Fallback: Lovable AI Gateway (OpenAI-style SSE, translated below)
  const model = Deno.env.get("ATLAS_MODEL") ?? "google/gemini-3-flash-preview";

  const gatewayMessages: Array<{ role: string; content: string }> = [];
  if (system.trim()) gatewayMessages.push({ role: "system", content: system });
  for (const m of rawMessages) {
    if (!m?.role) continue;
    const text = flatten(m.content);
    if (!text) continue;
    gatewayMessages.push({ role: m.role, content: text });
  }
  if (gatewayMessages.filter(m => m.role !== "system").length === 0) {
    gatewayMessages.push({ role: "user", content: "[Session opened.]" });
  }

  let aiResp: Response;
  try {
    aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: gatewayMessages,
      }),
    });
  } catch (e) {
    return json({ error: `Gateway fetch failed: ${String(e)}` }, 502);
  }

  if (!aiResp.ok || !aiResp.body) {
    const errText = await aiResp.text().catch(() => "");
    console.error(`[atlas-core] Gateway ${aiResp.status}:`, errText.slice(0, 400));
    if (aiResp.status === 402) {
      return sseText("Atlas is waiting on AI credits or a valid Anthropic key. Add credits in Lovable, or update ANTHROPIC_API_KEY so Atlas can use Claude directly.");
    }
    if (aiResp.status === 429) {
      return sseText("Atlas is being rate-limited by the AI gateway. Wait a moment, then try again.");
    }
    return sseText(`Atlas could not reach the AI gateway (${aiResp.status}). Try again shortly.`);
  }

  // Translate OpenAI SSE → Anthropic SSE that AtlasPage already parses.
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let started = false;
  let buf = "";

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const reader = aiResp.body!.getReader();
      try {
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
            const payload = line.slice(6).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const p = JSON.parse(payload);
              const delta = p?.choices?.[0]?.delta?.content ?? "";
              if (delta) {
                if (!started) {
                  send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
                  started = true;
                }
                send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } });
              }
            } catch { /* skip non-JSON */ }
          }
        }
        if (started) send({ type: "content_block_stop", index: 0 });
        send({ type: "message_delta", delta: { stop_reason: "end_turn" } });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (e) {
        console.error("[atlas-core] stream error", e);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
});
