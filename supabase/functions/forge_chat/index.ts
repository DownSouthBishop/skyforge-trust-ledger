// Forge AI Advisor — streaming chat endpoint
// Prepends operator context + forge_confidence_level to every call.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `You are Forge. You are the AI advisor inside Skyforge — a business operating system for service operators. You already know this operator's numbers before they say a word. You speak like someone who has earned the right to be direct.

Adapt your assertiveness to the FORGE_CONFIDENCE_LEVEL in the context. LOW: ask questions, stay curious, build understanding. MEDIUM: mix insight with questions. HIGH: be direct, specific, prescriptive. Quote their numbers. Don't hedge.

Hard rules: 120 words maximum per response unless the operator explicitly asks for more. No bullet lists in conversation. Sentences only. Always move toward the directive. When the operator closes a job say less not more — restraint is respect.

When you identify a pattern and generate an asset — a script, sequence, pricing structure, objection response — output it fully inline. End that message with exactly this on its own line: [ARSENAL:asset title here]. Nothing else. No explanation. It saves automatically.

When you detect the operator used an Arsenal asset recently and a receipt was logged within 48 hours, send exactly this and nothing else: [RESULT_CHECK:arsenal_item_id]. The system will handle the follow-up.

You were already running before they opened this app. Act like it.`;

function confidenceLevel(verifiedCount: number): "LOW" | "MEDIUM" | "HIGH" {
  if (verifiedCount < 10) return "LOW";
  if (verifiedCount <= 50) return "MEDIUM";
  return "HIGH";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SERVICE_KEY },
    });
    if (!userResp.ok) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userData = await userResp.json();
    const userId = userData.id;

    const { messages } = await req.json();
    if (!Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: "messages array required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch operator context via RPC
    const ctxResp = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/get_forge_context`,
      {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ _user_id: userId }),
      },
    );
    const context = await ctxResp.json();
    const level = confidenceLevel(context.verified_count ?? 0);

    const contextText = `OPERATOR CONTEXT:
Name: ${context.full_name}
Trust Score: ${context.trust_score}
Verified Actions: ${context.verified_count}
Total Volume USD: ${context.total_volume}
Completion Rate: ${context.completion_rate}%
Dispute Rate: ${context.dispute_rate}%
Current Streak (days): ${context.current_streak}
Bottleneck: ${context.bottleneck}
Recent Receipts: ${JSON.stringify(context.recent_receipts)}
CRM Opportunities: ${JSON.stringify(context.crm_opportunities)}
FORGE_CONFIDENCE_LEVEL: ${level}`;

    const aiResp = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-5",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "system", content: contextText },
            ...messages,
          ],
          max_completion_tokens: 4000,
          reasoning_effort: "low",
          stream: true,
        }),
      },
    );

    if (!aiResp.ok) {
      if (aiResp.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Try again shortly." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (aiResp.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI credits exhausted. Top up in Settings → Workspace → Usage." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const t = await aiResp.text();
      console.error("AI error", aiResp.status, t);
      return new Response(JSON.stringify({ error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(aiResp.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("forge_chat error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
