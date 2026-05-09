// Daily 6am engine — generates a directive per active user, saves silently.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function confidenceLevel(verifiedCount: number): "LOW" | "MEDIUM" | "HIGH" {
  if (verifiedCount < 10) return "LOW";
  if (verifiedCount <= 50) return "MEDIUM";
  return "HIGH";
}

async function generateDirective(
  context: any,
  topOpportunity: any | null,
  apiKey: string,
): Promise<{ directive: string; confidence: number } | null> {
  const level = confidenceLevel(context.verified_count ?? 0);
  const oppLine = topOpportunity
    ? `Top re-engagement: ${topOpportunity.client_name} — last job ${topOpportunity.last_job ?? "unknown"}, ${topOpportunity.days_since_contact ?? "?"} days since contact.`
    : "No re-engagement opportunities pending.";
  const prompt = `Operator: ${context.full_name}
Trust: ${context.trust_score} | Verified: ${context.verified_count} | Volume: $${context.total_volume}
Completion: ${context.completion_rate}% | Dispute: ${context.dispute_rate}% | Streak: ${context.current_streak}d
Bottleneck: ${context.bottleneck}
${oppLine}
Confidence: ${level}
Recent: ${JSON.stringify(context.recent_receipts)}
CRM: ${JSON.stringify(context.crm_opportunities)}

Generate one directive sentence for today based on this operator's data. If a re-engagement opportunity is strong, the directive may center on it.`;

  const resp = await fetch(
    "https://ai.gateway.lovable.dev/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content:
              "You are Forge. Generate one directive sentence for today based on the operator's data. Respond with raw JSON only, no markdown, no explanation: {\\"directive\\": \\"...\\", \\"confidence\\": 75}",
          },
          { role: "user", content: prompt },
        ],
        max_completion_tokens: 300,
        tools: [
          {
            type: "function",
            function: {
              name: "emit_directive",
              description: "Emit one directive and a confidence score 0-100",
              parameters: {
                type: "object",
                properties: {
                  directive: { type: "string" },
                  confidence: { type: "integer", minimum: 0, maximum: 100 },
                },
                required: ["directive", "confidence"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "emit_directive" } },
      }),
    },
  );
  if (!resp.ok) {
    console.error("AI error", resp.status, await resp.text());
    return null;
  }
  const data = await resp.json();
  const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) return null;
  try {
    return JSON.parse(args);
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) {
    return new Response(JSON.stringify({ error: "LOVABLE_API_KEY missing" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // List all profiles (= active operators)
  const profilesResp = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?select=user_id`,
    {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    },
  );
  const profiles: { user_id: string }[] = await profilesResp.json();

  let generated = 0;
  for (const p of profiles) {
    try {
      // Skip if directive already exists today
      const today = new Date().toISOString().slice(0, 10);
      const existing = await fetch(
        `${SUPABASE_URL}/rest/v1/forge_directives?user_id=eq.${p.user_id}&generated_at=gte.${today}T00:00:00&select=id`,
        {
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
          },
        },
      );
      const existingRows = await existing.json();
      if (Array.isArray(existingRows) && existingRows.length > 0) continue;

      const ctxResp = await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/get_forge_context`,
        {
          method: "POST",
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ _user_id: p.user_id }),
        },
      );
      const context = await ctxResp.json();

      // Pull CRM opportunities for this operator
      const oppResp = await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/get_crm_opportunities`,
        {
          method: "POST",
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ _user_id: p.user_id }),
        },
      );
      const opps = oppResp.ok ? await oppResp.json() : [];
      const top = Array.isArray(opps) && opps.length > 0
        ? {
            client_name: opps[0].client_name,
            last_job: opps[0].last_job_type,
            days_since_contact: opps[0].last_job_date
              ? Math.floor((Date.now() - new Date(opps[0].last_job_date).getTime()) / 86400000)
              : null,
          }
        : null;

      const result = await generateDirective(context, top, LOVABLE_API_KEY);
      if (!result) continue;

      await fetch(`${SUPABASE_URL}/rest/v1/forge_directives`, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          user_id: p.user_id,
          directive: result.directive,
          confidence_score: result.confidence,
        }),
      });
      generated++;
    } catch (e) {
      console.error("user error", p.user_id, e);
    }
  }

  return new Response(JSON.stringify({ generated, total: profiles.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
