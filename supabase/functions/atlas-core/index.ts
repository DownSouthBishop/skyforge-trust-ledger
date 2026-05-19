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

  if (!LOVABLE_KEY) return json({ error: "LOVABLE_API_KEY not configured" }, 500);

  try {
    await verifyToken(req.headers.get("Authorization"), SUPABASE_URL, SERVICE_KEY);
  } catch (e) {
    return json({ error: String(e) }, 401);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const rawMessages = Array.isArray(body.messages) ? body.messages as Array<{ role: string; content: unknown }> : [];
  const system = typeof body.system === "string" ? body.system : "";
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
    const status = aiResp.status === 429 ? 429 : aiResp.status === 402 ? 402 : 502;
    console.error(`[atlas-core] Gateway ${aiResp.status}:`, errText.slice(0, 400));
    return json({ error: `Gateway ${aiResp.status}`, detail: errText.slice(0, 400) }, status);
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
