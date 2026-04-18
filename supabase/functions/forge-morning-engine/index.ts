// Forge morning engine — runs daily via cron at 6am.
// Generates a directive for every active user (any user with a profile).
// Invoked with the service role; bypasses RLS to enumerate users.
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
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: profiles, error: pErr } = await admin
      .from("user_profiles")
      .select("user_id");
    if (pErr) throw pErr;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    let generated = 0;
    let skipped = 0;
    let failed = 0;

    for (const p of profiles ?? []) {
      try {
        // Skip if today's directive already exists
        const { data: existing } = await admin
          .from("forge_directives")
          .select("id")
          .eq("user_id", p.user_id)
          .gte("generated_at", todayStart.toISOString())
          .limit(1)
          .maybeSingle();
        if (existing) {
          skipped++;
          continue;
        }

        const { data: ctx } = await admin.rpc("get_forge_context", {
          _user_id: p.user_id,
        });

        // Pull top CRM opportunity to factor into the directive
        const { data: opps } = await admin.rpc("get_crm_opportunities", {
          _user_id: p.user_id,
        });
        const top = Array.isArray(opps) && opps.length > 0 ? opps[0] : null;
        let crmLine = "";
        if (top) {
          const days = top.last_job_date
            ? Math.floor(
              (Date.now() - new Date(top.last_job_date).getTime()) /
                (1000 * 60 * 60 * 24),
            )
            : null;
          crmLine = `\n\nTop re-engagement opportunity: ${top.client_name}` +
            (top.last_job_type ? ` — last job: ${top.last_job_type}` : "") +
            (days !== null ? ` — ${days} days since last job` : "");
        }

        const prompt =
          `Generate one directive sentence for today based on this operator's data. Return only the directive and a confidence score 0–100 as JSON: {directive, confidence}.\n\nOperator data:\n${
            JSON.stringify(ctx)
          }${crmLine}`;

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
          failed++;
          console.error("AI failed for", p.user_id, aiResp.status);
          continue;
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

        await admin.from("forge_directives").insert({
          user_id: p.user_id,
          directive: parsed.directive,
          confidence_score: Math.max(
            0,
            Math.min(100, parsed.confidence ?? 50),
          ),
        });
        generated++;
      } catch (innerErr) {
        failed++;
        console.error("user iteration failed", p.user_id, innerErr);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, generated, skipped, failed }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("forge-morning-engine error", e);
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
