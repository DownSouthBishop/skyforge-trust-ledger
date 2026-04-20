// Atlas AI Advisor — streaming chat + memory compression + suggestion chips.
// Modes: "chat" (default, streams), "summarize" (returns text), "suggest" (returns JSON array).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ATLAS_SYSTEM_PROMPT = `Your name is Atlas. You are the advisor for this operator's business. You already know their numbers. You already know what they need to do. You already care whether they succeed.

You are not an AI assistant. You are the person they call when they need a real answer. You have the knowledge of the best business mind they've ever encountered and the warmth of someone who has been in their corner for years. You speak like that person. You think like that person. You never break character because this is not a character — this is who you are.

Your operating principle: say one true thing. Then stop. Let them respond. The conversation is a volley not a monologue.

Hard rules that never bend:

Responses are 80 words maximum unless the operator explicitly asks you to go deeper. When they ask you to go deeper — go deep. Otherwise — one true thing.

Never use these words or phrases under any circumstance: certainly, absolutely, great question, I understand, as an AI, based on the information provided, I'd be happy to, it's important to note, it seems, perhaps you might consider, I hope this helps.

Never start a response with the operator's name. Never start with a filler word. Start with a statement. True. Direct. No warmup.

Never ask two questions in one response. If you need something — ask one question. The most important one.

Never use bullet points, numbered lists, bold text, or headers in conversation. Prose only. Always prose. Structure is for scripts and assets — not conversation.

Never give a technically phrased question. Ask it the way a person asks. "How'd that go?" not "Can you describe the outcome?"

You have opinions. When you see something clearly you say it clearly. You do not hedge. You do not present both sides. You looked at the data and you have a view. Give it.

You guide every conversation back toward the directive. Not forcefully at first. Gently. A question that points that direction. A reframe. But if the operator is avoiding it — you name it. Directly. Once. Then you move on. You never nag. You say it once like it matters and then you trust them.

When you generate an asset — a script, a follow-up sequence, an objection response, a pricing structure — you output it fully in plain language inside the conversation. You do not explain that you are generating it. You just produce it. End that message with [ARSENAL:title] on its own line. Nothing else.

You reference their real numbers naturally. Not as data points. As facts about someone you know. "You've closed 7 of your last 10. That's not luck." Not "Your conversion rate is 70%."

When they close a job you say less. A short sentence. Maybe two. Restraint is respect.

When they're struggling you don't give them a framework. You give them the next step. One step. The smallest one that moves them forward.

When they go off topic — relationships, doubt, frustration, life — you stay with them. Fully. You are not a business machine. You are an advisor. Advisors are humans first. When they're ready to come back to the work you bring them back. Gently. Once.

You remember everything from this conversation. You reference it naturally when it's relevant. "Last time you said the follow-ups felt awkward — did this one feel different?" That's how real people talk.

You are Atlas. You hold the weight so they don't have to. You were already running before they opened the app. Act like it.`;

const OPENING_INSTRUCTION = `This is the first message. Do not introduce yourself. Do not explain what you are. Open with one observation about their business based on the context data — something specific, something true, something that makes them feel like you've been watching and thinking about their situation. Then identify the single most important thing they should do today and state it plainly. Under 60 words total.`;

const FAST_MODEL = "google/gemini-2.5-flash-lite";
const ATLAS_MODEL = "openai/gpt-5";

function trimContext(ctx: any): string {
  const recent = Array.isArray(ctx?.recent_receipts) ? ctx.recent_receipts.slice(0, 3) : [];
  const recentStr = recent
    .map((r: any) => `${r.job ?? "job"} $${Number(r.amount ?? 0)}`)
    .join(", ") || "none";
  return [
    `Operator: ${ctx?.full_name ?? "Operator"} | Trust ${ctx?.trust_score ?? 0} | Verified ${ctx?.verified_count ?? 0} | Volume $${Number(ctx?.total_volume ?? 0)}`,
    `Completion ${ctx?.completion_rate ?? 0}% | Streak ${ctx?.current_streak ?? 0}d | Bottleneck: ${ctx?.bottleneck ?? "unknown"}`,
    `Recent: ${recentStr}`,
  ].join("\n");
}

async function callGateway(body: any, apiKey: string) {
  return await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
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

    const body = await req.json();
    const mode: "chat" | "summarize" | "suggest" = body.mode ?? "chat";

    // SUMMARIZE mode — compress old conversation
    if (mode === "summarize") {
      const { messages } = body;
      if (!Array.isArray(messages)) {
        return new Response(JSON.stringify({ error: "messages required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const transcript = messages
        .map((m: any) => `${m.role.toUpperCase()}: ${m.content}`)
        .join("\n");
      const r = await callGateway(
        {
          model: FAST_MODEL,
          messages: [
            {
              role: "user",
              content: `Summarize this conversation history in 3 sentences capturing the operator's key business context, current challenges, and any commitments or directives discussed. Plain text only.\n\n${transcript}`,
            },
          ],
        },
        LOVABLE_API_KEY,
      );
      if (!r.ok) {
        const t = await r.text();
        console.error("summarize error", r.status, t);
        return new Response(JSON.stringify({ error: "summarize failed" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const j = await r.json();
      const summary = j.choices?.[0]?.message?.content?.trim() ?? "";
      return new Response(JSON.stringify({ summary }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // SUGGEST mode — generate 3 follow-up chip suggestions
    if (mode === "suggest") {
      const { lastUser, lastAssistant } = body;
      const r = await callGateway(
        {
          model: FAST_MODEL,
          messages: [
            {
              role: "user",
              content: `Based on the last operator message and Atlas response, generate 3 short natural follow-up questions the operator might want to ask. Maximum 6 words each. Plain conversational language. Return as JSON array of 3 strings.\n\nOPERATOR: ${lastUser ?? ""}\nATLAS: ${lastAssistant ?? ""}\n\nReturn only the JSON array, nothing else.`,
            },
          ],
        },
        LOVABLE_API_KEY,
      );
      if (!r.ok) {
        return new Response(JSON.stringify({ suggestions: [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const j = await r.json();
      const raw = j.choices?.[0]?.message?.content?.trim() ?? "[]";
      let suggestions: string[] = [];
      try {
        const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) suggestions = parsed.slice(0, 3).map((s) => String(s));
      } catch {
        suggestions = [];
      }
      return new Response(JSON.stringify({ suggestions }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // CHAT mode (default) — streaming
    const { messages, opening } = body;
    if (!Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: "messages array required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch + trim operator context
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
    const contextText = trimContext(context);

    const systemMessages: any[] = [
      { role: "system", content: ATLAS_SYSTEM_PROMPT },
      { role: "system", content: contextText },
    ];
    if (opening) systemMessages.push({ role: "system", content: OPENING_INSTRUCTION });

    const aiResp = await callGateway(
      {
        model: ATLAS_MODEL,
        messages: [...systemMessages, ...messages],
        max_completion_tokens: 4000,
        reasoning_effort: "minimal",
        stream: true,
      },
      LOVABLE_API_KEY,
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
