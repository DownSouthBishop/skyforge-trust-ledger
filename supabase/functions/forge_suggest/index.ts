// forge_suggest — chip suggestion generation.
// Split from forge_chat to isolate failure domains.

import {
  corsHeaders,
  callGatewayWithRetry,
  verifyUser,
  parseEnv,
  modelEnv,
  AuthError,
} from "../_shared/gateway.ts";

const FAST_MODEL = () => modelEnv("FAST_MODEL", "google/gemini-2.5-flash-lite");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("LOVABLE_API_KEY");

    await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));

    const { lastUser, lastAssistant } = await req.json();

    const resp = await callGatewayWithRetry(
      {
        model: FAST_MODEL(),
        messages: [{
          role: "user",
          content: `Based on the last operator message and Atlas response, generate 3 short natural follow-up questions the operator might want to ask. Maximum 6 words each. Plain conversational language. If the operator's message contained emotional content — stress, doubt, frustration, excitement — include one chip that acknowledges that register naturally. Return as JSON array of 3 strings.\n\nOPERATOR: ${lastUser ?? ""}\nATLAS: ${lastAssistant ?? ""}\n\nReturn only the JSON array, nothing else.`,
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
    const raw = j.choices?.[0]?.message?.content?.trim() ?? "[]";
    let suggestions: string[] = [];
    try {
      const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) suggestions = parsed.slice(0, 3).map((s) => String(s));
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
