// atlas-core — secure Anthropic proxy for Atlas chat
// Verifies user auth, pipes streaming response directly from Anthropic.
// System prompt, tools, and context are built client-side (AtlasPage.tsx).

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
  const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: serviceKey },
  });
  if (!resp.ok) throw new Error(`Auth failed: ${resp.status}`);
  const data = await resp.json();
  if (!data?.id) throw new Error("No user ID in token");
  return data.id as string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const API_KEY      = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

  if (!API_KEY) return json({ error: "ANTHROPIC_API_KEY secret not set on this function" }, 500);

  // Verify user
  try {
    await verifyToken(req.headers.get("Authorization"), SUPABASE_URL, SERVICE_KEY);
  } catch (e) {
    return json({ error: String(e) }, 401);
  }

  // Parse request
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const messages = body.messages ?? [];
  const system   = (typeof body.system === "string" && body.system.trim()) ? body.system : undefined;
  const model    = (typeof body.model  === "string" && body.model.trim())  ? body.model  : "claude-sonnet-4-6";
  const tools    = Array.isArray(body.tools) && body.tools.length > 0 ? body.tools : undefined;

  // Call Anthropic
  const anthropicBody: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    stream: true,
    messages,
  };
  if (system) anthropicBody.system = system;
  if (tools)  anthropicBody.tools  = tools;

  console.log(`[atlas-core] model=${model} msgs=${(messages as unknown[]).length}`);

  let aiResp: Response;
  try {
    aiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(anthropicBody),
    });
  } catch (e) {
    return json({ error: `Anthropic fetch failed: ${String(e)}` }, 502);
  }

  if (!aiResp.ok) {
    const errText = await aiResp.text().catch(() => "");
    console.error(`[atlas-core] Anthropic error ${aiResp.status}:`, errText.slice(0, 400));
    return json({ error: `Anthropic ${aiResp.status}`, detail: errText.slice(0, 400) }, 502);
  }

  if (!aiResp.body) {
    return json({ error: "Anthropic returned empty body" }, 502);
  }

  return new Response(aiResp.body, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
});
