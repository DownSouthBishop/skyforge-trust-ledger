// Forge AI Advisor — chat endpoint
// Uses Lovable AI Gateway (LOVABLE_API_KEY auto-provisioned)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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

function confidenceLevel(verifiedCount: number) {
  if (verifiedCount < 10) return "LOW";
  if (verifiedCount <= 50) return "MEDIUM";
  return "HIGH";
}

function buildContextMessage(ctx: any) {
  const level = confidenceLevel(ctx.verified_count ?? 0);
  const recent = (ctx.recent_receipts ?? [])
    .map((r: any) => `- ${r.job} ($${r.amount ?? 0}) [${r.state}]`)
    .join("\n") || "- none yet";
  const crm = (ctx.crm_opportunities ?? [])
    .map((o: any) =>
      `- ${o.client_name} — last job: ${o.last_job ?? "n/a"} — ${
        o.days_since_contact ?? "?"
      } days since contact — est. re-engagement value $${
        o.estimated_value ?? 0
      }`
    )
    .join("\n") || "- none";
  return `OPERATOR CONTEXT
Name: ${ctx.full_name}
Trust score: ${ctx.trust_score}
Verified actions: ${ctx.verified_count}
Total volume: $${ctx.total_volume}
Completion rate: ${ctx.completion_rate}%
Dispute rate: ${ctx.dispute_rate}%
Current streak: ${ctx.current_streak} days
Bottleneck: ${ctx.bottleneck}
Recent receipts:
${recent}
CRM re-engagement opportunities (top 3):
${crm}

FORGE_CONFIDENCE_LEVEL: ${level}

When you generate an outreach message for a CRM opportunity, end the message with [ARSENAL:client outreach — <client name>] so it saves automatically.`;
}

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

    const { messages = [] } = await req.json();

    // Fetch live context
    const { data: ctx, error: ctxErr } = await supabase.rpc(
      "get_forge_context",
      { _user_id: userId },
    );
    if (ctxErr) {
      console.error("ctx error", ctxErr);
    }

    const systemContext = buildContextMessage(ctx ?? {});

    const aiResp = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-pro",
          max_tokens: 1000,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "system", content: systemContext },
            ...messages,
          ],
        }),
      },
    );

    if (!aiResp.ok) {
      const t = await aiResp.text();
      console.error("AI gateway error", aiResp.status, t);
      if (aiResp.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limited. Try again shortly." }),
          {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      if (aiResp.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI credits exhausted." }),
          {
            status: 402,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ error: "AI request failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiResp.json();
    const reply: string = aiData?.choices?.[0]?.message?.content ?? "";

    // Parse [ARSENAL:title]
    let arsenalTitle: string | null = null;
    let cleaned = reply;
    const arsenalMatch = reply.match(/\[ARSENAL:\s*([^\]]+)\]/i);
    if (arsenalMatch) {
      arsenalTitle = arsenalMatch[1].trim();
      cleaned = reply.replace(arsenalMatch[0], "").trim();
    }

    // Parse [RESULT_CHECK:id]
    let resultCheckId: string | null = null;
    const rcMatch = cleaned.match(/\[RESULT_CHECK:\s*([^\]]+)\]/i);
    if (rcMatch) {
      resultCheckId = rcMatch[1].trim();
      cleaned = cleaned.replace(rcMatch[0], "").trim();
    }

    // Save arsenal item
    let arsenalItemId: string | null = null;
    if (arsenalTitle) {
      const { data: ins, error: insErr } = await supabase
        .from("arsenal_items")
        .insert({
          user_id: userId,
          type: "asset",
          title: arsenalTitle,
          content: cleaned || reply,
          source: "forge_generated",
          confidence_score: 0,
        })
        .select("id")
        .single();
      if (insErr) console.error("arsenal insert error", insErr);
      else arsenalItemId = ins?.id ?? null;
    }

    return new Response(
      JSON.stringify({
        reply: cleaned,
        arsenal_saved: arsenalTitle
          ? { id: arsenalItemId, title: arsenalTitle }
          : null,
        result_check_for: resultCheckId,
        bottleneck: ctx?.bottleneck ?? null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("forge-chat error", e);
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
