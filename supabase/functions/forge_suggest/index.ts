// forge_suggest — chip suggestion generation.
// Split from forge_chat to isolate failure domains.

import {
  corsHeaders,
  verifyUser,
  parseEnv,
  modelEnv,
  AuthError,
} from "../_shared/gateway.ts";

const FAST_MODEL = () => modelEnv("FAST_MODEL", "claude-haiku-4-5-20251001");

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("ANTHROPIC_API_KEY");

    await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));

    const { lastUser, lastAssistant } = await req.json();

    const resp = await callAnthropic(
      {
        model: FAST_MODEL(),
        max_tokens: 200,
        system: "Generate 3 short natural follow-up questions an operator might want to ask their AI wealth advisor. Maximum 6 words each. Plain conversational language. If the operator's message contained emotional content — stress, doubt, frustration, excitement — include one chip that acknowledges that register naturally. Return as JSON array of 3 strings. Return only the JSON array, nothing else.",
        messages: [{
          role: "user",
          content: `OPERATOR: ${lastUser ?? ""}\nATLAS: ${lastAssistant ?? ""}`,
        }],
      },
      API_KEY,
    );

    if (!resp.ok) {
      return new Response(JSON.stringify({ suggestions: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const j = await resp.json();
    const raw = j.content?.[0]?.text?.trim() ?? "[]";
    let suggestions: string[] = [];
    try {
      const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) suggestions = parsed.slice(0, 3).map((s: unknown) => String(s));
    } catch { suggestions = []; }

    return new Response(JSON.stringify({ suggestions }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.error("forge_suggest error:", e);
    return new Response(JSON.stringify({ suggestions: [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
