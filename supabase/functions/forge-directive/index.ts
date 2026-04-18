// Generates today's directive on demand for the calling user.
// Used by the Forge page when no directive exists for today.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
      Deno.env.get("SUPABASE_ANON_KEY")!;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(
        JSON.stringify({ error: "LOVABLE_API_KEY not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    // Check for today's directive
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { data: existing } = await supabase
      .from("forge_directives")
      .select("*")
      .eq("user_id", userId)
      .gte("generated_at", todayStart.toISOString())
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      return new Response(JSON.stringify({ directive: existing }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: ctx } = await supabase.rpc("get_forge_context", {
      _user_id: userId,
    });

    const prompt = `You are Forge. Based on this operator's data, generate ONE directive sentence for today. Be direct and specific. Reference their numbers when relevant.

Operator data:
${JSON.stringify(ctx, null, 2)}

Return ONLY a JSON object: {"directive": "...", "confidence": 0-100}`;

    const aiResp = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          max_tokens: 200,
          messages: [
            {
              role: "system",
              content:
                "You output only valid JSON. No prose, no markdown fences.",
            },
            { role: "user", content: prompt },
          ],
        }),
      },
    );

    if (!aiResp.ok) {
      const t = await aiResp.text();
      console.error("AI error", aiResp.status, t);
      return new Response(
        JSON.stringify({ error: "AI request failed" }),
        {
          status: aiResp.status === 429 || aiResp.status === 402
            ? aiResp.status
            : 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const aiData = await aiResp.json();
    let raw: string = aiData?.choices?.[0]?.message?.content ?? "";
    raw = raw.replace(/```json|```/g, "").trim();
    let parsed: { directive: string; confidence: number };
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { directive: raw.slice(0, 240), confidence: 50 };
    }

    const { data: inserted, error: insErr } = await supabase
      .from("forge_directives")
      .insert({
        user_id: userId,
        directive: parsed.directive,
        confidence_score: Math.max(0, Math.min(100, parsed.confidence ?? 50)),
      })
      .select()
      .single();

    if (insErr) {
      console.error("insert directive error", insErr);
      return new Response(JSON.stringify({ error: insErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ directive: inserted }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("forge-directive error", e);
    return new Response(
      JSON.stringify({
        error: e instanceof Error ? e.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
