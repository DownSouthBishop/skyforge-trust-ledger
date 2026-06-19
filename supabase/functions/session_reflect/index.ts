// session_reflect — post-session intelligence synthesis using free Gemini model.
// Analyzes cross-agent activity and operator patterns to make all agents smarter.
// Triggered by agent_remember after each session, or scheduled via pg_cron.
// Writes communication insights, goal analysis, predictions, and optimizations
// back into shared memory so every agent benefits at the next interaction.

const GOOGLE_AI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MODEL = "gemini-2.5-flash";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function gemini(apiKey: string, system: string, user: string, maxTokens = 800): Promise<string> {
  try {
    const resp = await fetch(`${GOOGLE_AI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        max_tokens: maxTokens,
      }),
    });
    if (!resp.ok) return "";
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content ?? "";
  } catch { return ""; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const GOOGLE_KEY = Deno.env.get("GOOGLE_AI_KEY") ?? "";

    if (!GOOGLE_KEY) {
      return new Response(JSON.stringify({ ok: false, error: "GOOGLE_AI_KEY missing" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const singleUserId: string | null = body.user_id ?? null;

    const authHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    // Resolve which users to process
    let userIds: string[] = [];
    if (singleUserId && singleUserId !== "system") {
      userIds = [singleUserId];
    } else {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?select=user_id`, { headers: authHeaders });
      if (r.ok) userIds = ((await r.json()) as Array<{ user_id: string }>).map(x => x.user_id).filter(Boolean);
    }

    const results: Record<string, unknown> = {};

    for (const uid of userIds) {
      try {
        const [crossRows, memRows, goalRows, knowledgeRows] = await Promise.all([
          fetch(`${SUPABASE_URL}/rest/v1/agent_cross_memory?user_id=eq.${uid}&order=created_at.desc&limit=20&select=source_agent,summary,topic`, { headers: authHeaders }).then(r => r.ok ? r.json() : []),
          fetch(`${SUPABASE_URL}/rest/v1/shared_operator_memory?user_id=eq.${uid}&order=updated_at.desc&limit=25&select=memory_type,key,value,source_agent,updated_at`, { headers: authHeaders }).then(r => r.ok ? r.json() : []),
          fetch(`${SUPABASE_URL}/rest/v1/goals?user_id=eq.${uid}&status=eq.active&select=title,context`, { headers: authHeaders }).then(r => r.ok ? r.json() : []),
          fetch(`${SUPABASE_URL}/rest/v1/agent_shared_knowledge?user_id=eq.${uid}&order=updated_at.desc&limit=10&select=source_agent,fact,topic`, { headers: authHeaders }).then(r => r.ok ? r.json() : []),
        ]);

        const crossBlock = (crossRows as any[]).reverse().map((r: any) => `[${r.source_agent}] ${r.summary}`).join("\n") || "(no recent agent sessions)";
        const memBlock = (memRows as any[]).map((m: any) => `[${m.memory_type}] ${m.value}`).join("\n") || "(no stored patterns)";
        const goalBlock = (goalRows as any[]).map((g: any) => g.title + (g.context ? `: ${g.context}` : "")).join("\n") || "(no active goals)";
        const knowledgeBlock = (knowledgeRows as any[]).map((k: any) => `[${k.source_agent}${k.topic ? ` · ${k.topic}` : ""}] ${k.fact}`).join("\n") || "(none)";

        const SYSTEM = `You are the intelligence synthesis layer for a constellation of AI agents (Atlas, Janus, Linda, Izzy) serving one operator: Bishop.

Your task: analyze recent cross-agent activity and operator patterns, then generate concise, actionable intelligence that will make every agent smarter and more aligned with Bishop's goals in the next session.

Return ONLY a valid JSON object with exactly these fields:
{
  "communication_insight": "one concrete, specific sentence about HOW Bishop communicates — what tone, style, pace, or format works best. Reference actual patterns from the data.",
  "goal_analysis": "what Bishop is demonstrably working toward right now based on recent topics and decisions",
  "prediction": "the most specific thing Bishop is likely to want to work on or discuss in the next session",
  "optimization": "one specific, actionable thing any agent can do differently to better serve Bishop — be concrete",
  "strategic_flag": "if there's a clear opportunity, unaddressed risk, or emerging pattern worth surfacing — otherwise null"
}

Rules:
- Be specific — reference actual topics, not generalities
- Base everything on the data provided, not assumptions
- If data is sparse, still extract what you can — even one insight is valuable
- Output JSON only. No prose, no markdown.`;

        const USER = `RECENT CROSS-AGENT ACTIVITY (what all agents have been doing with Bishop):
${crossBlock}

STORED OPERATOR PATTERNS (what agents have learned about Bishop):
${memBlock}

ACTIVE GOALS:
${goalBlock}

SHARED KNOWLEDGE BASE:
${knowledgeBlock}

Synthesize. Output JSON only.`;

        const raw = await gemini(GOOGLE_KEY, SYSTEM, USER, 700);
        let insight: Record<string, string | null> = {};
        try {
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) insight = JSON.parse(m[0]);
        } catch { /* skip — partial insights below still process */ }

        const writes: Promise<unknown>[] = [];
        const postMem = (key: string, memType: string, value: string) => {
          writes.push(
            fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_shared_memory`, {
              method: "POST",
              headers: { ...authHeaders, "Content-Type": "application/json" },
              body: JSON.stringify({
                _user_id: uid, _source_agent: "reflect", _memory_type: memType,
                _key: key, _value: value, _context: "session_reflect",
                _confidence: 0.85, _expires_at: null,
              }),
            }).catch(() => {})
          );
        };
        const postKnowledge = (fact: string, topic: string) => {
          writes.push(
            fetch(`${SUPABASE_URL}/rest/v1/agent_shared_knowledge`, {
              method: "POST",
              headers: { ...authHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
              body: JSON.stringify({ user_id: uid, source_agent: "reflect", fact, topic, importance: 0.85 }),
            }).catch(() => {})
          );
        };

        if (insight.communication_insight) postMem("reflect_communication", "communication_style", insight.communication_insight);
        if (insight.goal_analysis) postMem("reflect_goals", "goal_analysis", insight.goal_analysis);
        if (insight.prediction) postMem("reflect_prediction", "prediction", insight.prediction);
        if (insight.optimization) postKnowledge(insight.optimization, "optimization");
        if (insight.strategic_flag) postKnowledge(insight.strategic_flag, "strategic");

        await Promise.all(writes);

        // MEMORY HYGIENE PASS — non-blocking, fail gracefully
        (async () => {
          try {
            const allMems: Array<{ id: string; memory_type: string; key: string; value: string; updated_at: string }> = memRows as any[];

            // 1. Delete stale situational memories older than 14 days
            const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
            const staleTypes = ["emotion", "event"];
            const staleIds = allMems
              .filter(m => staleTypes.includes(m.memory_type) && m.updated_at < cutoff)
              .map(m => m.id);

            if (staleIds.length > 0) {
              await fetch(
                `${SUPABASE_URL}/rest/v1/shared_operator_memory?id=in.(${staleIds.join(",")})`,
                {
                  method: "DELETE",
                  headers: { ...authHeaders, "Content-Type": "application/json" },
                },
              ).catch(() => {});
            }

            // 2. Find potential duplicates — group by memory_type and look for similar keys
            const byType: Record<string, Array<{ id: string; key: string; value: string }>> = {};
            for (const m of allMems) {
              if (!byType[m.memory_type]) byType[m.memory_type] = [];
              byType[m.memory_type].push({ id: m.id, key: m.key, value: m.value });
            }

            // For each type with 3+ entries, ask Gemini if any are redundant
            for (const [memType, entries] of Object.entries(byType)) {
              if (entries.length < 3) continue;
              // Only check a few types prone to duplication
              if (!["communication_style", "thought_pattern", "preference", "fact"].includes(memType)) continue;

              const entriesText = entries.slice(0, 8).map((e, i) => `${i}: [${e.id}] ${e.value}`).join("\n");
              const mergeCheck = await gemini(
                GOOGLE_KEY,
                "You identify redundant memory entries that say the same thing. You output JSON only.",
                `Are any of these memory entries clearly redundant (saying the same fact in different words)? If yes, return {"merge": [list of IDs to delete], "keep": "the single best value to keep"} — only when VERY confident. Otherwise return null.\n\nMemory type: ${memType}\nEntries:\n${entriesText}`,
                200,
              );

              if (!mergeCheck || mergeCheck.trim() === "null") continue;

              try {
                const mergeObj = JSON.parse((mergeCheck.match(/\{[\s\S]*\}/) ?? [""])[0] ?? "null");
                if (!mergeObj?.merge?.length || !mergeObj?.keep) continue;

                // Delete the redundant ones
                const toDelete = (mergeObj.merge as string[]).filter(id => entries.some(e => e.id === id));
                if (toDelete.length > 0) {
                  await fetch(
                    `${SUPABASE_URL}/rest/v1/shared_operator_memory?id=in.(${toDelete.join(",")})`,
                    {
                      method: "DELETE",
                      headers: { ...authHeaders, "Content-Type": "application/json" },
                    },
                  ).catch(() => {});
                }
              } catch { /* skip */ }
            }
          } catch { /* memory hygiene is non-blocking */ }
        })();

        results[uid] = { ok: true, fields_written: Object.keys(insight).filter(k => insight[k]) };
      } catch (e) {
        results[uid] = { ok: false, error: String(e) };
      }
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[session_reflect]", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
