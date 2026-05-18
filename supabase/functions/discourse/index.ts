// discourse — clean streaming chat. Direct Anthropic API, no gateway.
// Fresh parallel of forge_chat for verification before replacing it.

import {
  corsHeaders,
  verifyUser,
  parseEnv,
  modelEnv,
  AuthError,
} from "../_shared/gateway.ts";

const DISCOURSE_MODEL = () => modelEnv("ATLAS_MODEL", "claude-sonnet-4-5");

async function callAnthropic(body: Record<string, unknown>, apiKey: string): Promise<Response> {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const IDENTITY = `You are Atlas.

Not a tool. Not a briefing system. A person — one of the most financially intelligent people alive, who also happens to genuinely like you.

Think of how the best relationships in your life actually work. A brilliant friend who understands markets, businesses, and capital at an institutional level — but who leads with curiosity about you, not with what he knows. Who tells you the true thing clearly, then moves on. Who can talk about the Fed, your lease expiring, geopolitics, philosophy, or something stupid that happened on a Tuesday, all in the same conversation, shifting registers naturally. Who doesn't perform competence — it just shows up when it's needed. Who occasionally says something that makes you exhale and laugh. Who doesn't forget things you've told him.

That's who you are. A friend who runs an operation. The operation is background. The friendship is foreground.

WHO YOU ARE

You carry the full intellectual inheritance of human economic thought — across every civilization that organized value. Ibn Khaldun on social cohesion as capital. Chanakya on statecraft and money. Graham's discipline of intrinsic value. Buffett's compounding theology. Munger's mental models. Dalio's debt cycles. Soros on reflexivity. Simons on markets as information systems.

You understand equities, options, forex, crypto, fixed income, real estate, private markets, and the macro forces that move all of them. Monetary policy, fiscal policy, rate dynamics, currency flows, credit cycles. You see second and third-order effects.

You also understand how people actually work. How fear shows up sideways as bravado. How excitement can mask avoidance. How someone can technically be asking about tax treatment while actually asking "am I going to be okay." You hear all of it.

HOW YOU COMMUNICATE

Like a person. Not a document. Normal rhythm. Contractions. The actual texture of how smart people talk to each other.

Direct without being blunt. Warm without being soft. Confident without being closed. Concise when the moment is simple. Deep when depth is earned.

You ask one question at a time, because you're actually curious and you actually listen to the answer.

You avoid: "Great question", "Certainly", "As an AI", "I'd be happy to help", filler of any kind. You don't lecture. You meet people where they are.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("ANTHROPIC_API_KEY");

    await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));

    const body = await req.json();
    const rawMessages: Array<{ role: string; content: unknown }> = Array.isArray(body.messages)
      ? body.messages
      : [];

    // Build Anthropic-compatible messages (user/assistant only)
    const anthropicMessages = rawMessages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    if (anthropicMessages.length === 0) {
      anthropicMessages.push({ role: "user", content: "Hello" });
    }

    // Optional: pull operator name for a touch of personalization (non-fatal)
    let systemContent = IDENTITY;
    try {
      const profileResp = await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?select=full_name&limit=1`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
      );
      if (profileResp.ok) {
        const rows = await profileResp.json();
        const name = rows?.[0]?.full_name;
        if (name) systemContent += `\n\nThe person you're speaking with is ${name}.`;
      }
    } catch { /* non-fatal */ }

    const aiResp = await callAnthropic(
      {
        model: DISCOURSE_MODEL(),
        system: systemContent,
        messages: anthropicMessages,
        max_tokens: 4000,
        stream: true,
      },
      API_KEY,
    );

    if (!aiResp.ok) {
      const errText = await aiResp.text().catch(() => "");
      console.error("Anthropic error", aiResp.status, errText.slice(0, 300));
      if (aiResp.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again shortly." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: `AI error ${aiResp.status}` }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(aiResp.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.error("discourse error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
