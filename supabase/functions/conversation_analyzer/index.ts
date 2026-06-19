// conversation_analyzer — reads recent agent chat sessions and extracts
// operator intent, focus areas, decisions, and preference signals.
// Writes structured intelligence to shared_operator_memory.
// Runs hourly via pg_cron.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_MODEL = "gemini-2.5-flash";

async function geminiJSON(apiKey: string, system: string, user: string, maxTokens = 700): Promise<unknown> {
  try {
    const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        max_tokens: maxTokens,
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content ?? "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const GOOGLE_KEY = Deno.env.get("GOOGLE_AI_KEY") ?? "";

    if (!GOOGLE_KEY) {
      return new Response(JSON.stringify({ ok: false, error: "GOOGLE_AI_KEY missing" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const h = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

    // Find threads updated in the last 24 hours that need analysis
    // A thread needs analysis if: last_analyzed_at IS NULL, or updated_at > last_analyzed_at
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const threadsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/agent_chat_threads?updated_at=gte.${since24h}&select=id,user_id,agent_slug,title,updated_at,last_analyzed_at&order=updated_at.asc&limit=15`,
      { headers: h },
    );
    const allThreads = threadsRes.ok ? (await threadsRes.json() as any[]) : [];

    // Filter to only threads with new activity since last analysis
    const threads = allThreads.filter((t: any) =>
      !t.last_analyzed_at || new Date(t.updated_at) > new Date(t.last_analyzed_at)
    );

    let analyzed = 0;
    const results: Array<{ thread_id: string; agent: string; signals: number }> = [];

    const ANALYSIS_SYSTEM = `You are an operator intelligence extractor. You read a conversation between an operator (Bishop) and an AI agent, and extract structured intelligence about the operator.

Return a JSON object:
{
  "focus_topics": ["topic1", "topic2"],
  "decisions_made": ["decision1"],
  "concerns_surfaced": ["concern1"],
  "preferences_revealed": ["preference1"],
  "active_priorities": ["priority1"],
  "summary": "1-2 sentence summary of what the operator was working on and thinking about"
}

Be specific. Extract real signal — not generic summaries. If a topic is discussed multiple times, it's more important.
Output JSON only. No prose.`;

    for (const thread of threads) {
      try {
        const uid = thread.user_id;
        if (!uid) continue;

        // Get messages for this thread (last 40)
        const msgsRes = await fetch(
          `${SUPABASE_URL}/rest/v1/agent_chat_messages?thread_id=eq.${thread.id}&select=role,content,created_at&order=created_at.asc&limit=40`,
          { headers: h },
        );
        const msgs = msgsRes.ok ? (await msgsRes.json() as any[]) : [];

        // Only analyze if there are meaningful messages (at least 2 user messages)
        const userMsgs = msgs.filter((m: any) => m.role === "user");
        if (userMsgs.length < 2) {
          // Still mark as analyzed to avoid re-processing
          await fetch(`${SUPABASE_URL}/rest/v1/agent_chat_threads?id=eq.${thread.id}`, {
            method: "PATCH",
            headers: { ...h, Prefer: "return=minimal" },
            body: JSON.stringify({ last_analyzed_at: new Date().toISOString() }),
          });
          continue;
        }

        const conversation = msgs
          .map((m: any) => `${m.role === "user" ? "Bishop" : (thread.agent_slug ?? "Agent")}: ${(m.content ?? "").slice(0, 400)}`)
          .join("\n\n");

        const USER_PROMPT = `AGENT: ${thread.agent_slug ?? "unknown"}
THREAD TITLE: ${thread.title ?? "(untitled)"}
DATE: ${new Date(thread.updated_at).toISOString().split("T")[0]}

CONVERSATION:
${conversation.slice(0, 4000)}

Extract operator intelligence from this conversation.`;

        const extracted = await geminiJSON(GOOGLE_KEY, ANALYSIS_SYSTEM, USER_PROMPT, 600) as any;
        if (!extracted) continue;

        // Write each signal type to shared_operator_memory
        const now = new Date().toISOString();
        const signals: Array<{ memory_type: string; key: string; value: string }> = [];

        if (extracted.summary) {
          signals.push({
            memory_type: "conversation_signal",
            key: `chat_session_${thread.id.slice(0, 8)}`,
            value: `[${thread.agent_slug} · ${now.split("T")[0]}] ${extracted.summary}`,
          });
        }

        if (Array.isArray(extracted.focus_topics) && extracted.focus_topics.length > 0) {
          signals.push({
            memory_type: "operator_focus",
            key: `focus_${thread.agent_slug}_${now.split("T")[0]}`,
            value: `Topics: ${extracted.focus_topics.join(", ")}`,
          });
        }

        if (Array.isArray(extracted.preferences_revealed) && extracted.preferences_revealed.length > 0) {
          for (const pref of extracted.preferences_revealed.slice(0, 3)) {
            if (!pref || pref.length < 10) continue;
            const prefKey = `pref_${pref.slice(0, 30).toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
            signals.push({
              memory_type: "preference",
              key: prefKey,
              value: String(pref),
            });
          }
        }

        if (Array.isArray(extracted.active_priorities) && extracted.active_priorities.length > 0) {
          signals.push({
            memory_type: "active_priority",
            key: `priority_${thread.agent_slug}_${now.split("T")[0]}`,
            value: extracted.active_priorities.slice(0, 5).join(" · "),
          });
        }

        // Write signals to shared_operator_memory
        for (const signal of signals) {
          await fetch(`${SUPABASE_URL}/rest/v1/shared_operator_memory`, {
            method: "POST",
            headers: { ...h, Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({
              user_id: uid,
              memory_type: signal.memory_type,
              key: signal.key,
              value: signal.value,
              confidence: 0.8,
              source_agent: thread.agent_slug ?? "conversation_analyzer",
            }),
          });
        }

        // Write to cross-agent memory so agents know what was discussed
        if (extracted.summary) {
          await fetch(`${SUPABASE_URL}/rest/v1/agent_cross_memory`, {
            method: "POST",
            headers: { ...h, Prefer: "return=minimal" },
            body: JSON.stringify({
              user_id: uid,
              source_agent: thread.agent_slug ?? "unknown",
              summary: `Chat session: ${extracted.summary}${extracted.active_priorities?.length ? ` Priorities: ${extracted.active_priorities.slice(0, 2).join(", ")}` : ""}`,
              topic: "operator_conversation",
            }),
          });
        }

        // Mark thread as analyzed
        await fetch(`${SUPABASE_URL}/rest/v1/agent_chat_threads?id=eq.${thread.id}`, {
          method: "PATCH",
          headers: { ...h, Prefer: "return=minimal" },
          body: JSON.stringify({ last_analyzed_at: now }),
        });

        analyzed++;
        results.push({ thread_id: thread.id, agent: thread.agent_slug ?? "unknown", signals: signals.length });

      } catch (e) {
        console.error(`[conversation_analyzer] error for thread ${thread.id}:`, e);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, threads_found: threads.length, analyzed, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (e) {
    console.error("[conversation_analyzer]", e);
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
