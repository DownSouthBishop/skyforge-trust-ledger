// memory_consolidate — weekly operator profile distillation.
// Reads entire memory corpus and agent journal, distills into a compressed
// operator profile that agents use as primary context. Scheduled weekly.

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_MODEL = "gemini-2.5-flash";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function gemini(apiKey: string, system: string, user: string, maxTokens = 800): Promise<string> {
  try {
    const r = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        max_tokens: maxTokens,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!r.ok) return "";
    const data = await r.json() as any;
    return data?.choices?.[0]?.message?.content ?? "";
  } catch { return ""; }
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

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const singleUserId: string | null = body.user_id ?? null;

    const authHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

    let userIds: string[] = [];
    if (singleUserId && singleUserId !== "system") {
      userIds = [singleUserId];
    } else {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?select=user_id`, { headers: authHeaders });
      if (r.ok) userIds = ((await r.json()) as Array<{ user_id: string }>).map(x => x.user_id).filter(Boolean);
    }

    const results: Record<string, unknown> = {};
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    for (const uid of userIds) {
      try {
        // Read full memory corpus in parallel
        const [memRows, crossRows, goalRows, journalRows, taskRows] = await Promise.all([
          fetch(`${SUPABASE_URL}/rest/v1/shared_operator_memory?user_id=eq.${uid}&order=confidence.desc,updated_at.desc&limit=80&select=memory_type,key,value,confidence,source_agent`, { headers: authHeaders }).then(r => r.ok ? r.json() : []),
          fetch(`${SUPABASE_URL}/rest/v1/agent_cross_memory?user_id=eq.${uid}&created_at=gte.${thirtyDaysAgo}&order=created_at.desc&limit=40&select=source_agent,summary,topic`, { headers: authHeaders }).then(r => r.ok ? r.json() : []),
          fetch(`${SUPABASE_URL}/rest/v1/goals?user_id=eq.${uid}&select=title,context,status`, { headers: authHeaders }).then(r => r.ok ? r.json() : []),
          fetch(`${SUPABASE_URL}/rest/v1/agent_journal?user_id=eq.${uid}&created_at=gte.${thirtyDaysAgo}&order=created_at.desc&limit=25&select=agent_slug,entry`, { headers: authHeaders }).then(r => r.ok ? r.json() : []),
          fetch(`${SUPABASE_URL}/rest/v1/agent_tasks?user_id=eq.${uid}&created_at=gte.${thirtyDaysAgo}&select=agent_slug,task_type,status,result_summary`, { headers: authHeaders }).then(r => r.ok ? r.json() : []),
        ]);

        const memBlock = (memRows as any[]).map((m: any) => `[${m.memory_type}|conf:${m.confidence?.toFixed(1)}] ${m.value}`).join("\n");
        const crossBlock = (crossRows as any[]).map((c: any) => `[${c.source_agent}] ${c.summary}`).join("\n");
        const goalBlock = (goalRows as any[]).map((g: any) => `[${g.status}] ${g.title}${g.context ? `: ${g.context}` : ""}`).join("\n");
        const journalBlock = (journalRows as any[]).map((j: any) => `[${j.agent_slug}] ${j.entry}`).join("\n");
        const taskBlock = (taskRows as any[]).map((t: any) => `[${t.agent_slug}·${t.status}] ${t.task_type}${t.result_summary ? `: ${t.result_summary.slice(0, 80)}` : ""}`).join("\n");

        if (!memBlock && !crossBlock) {
          results[uid] = { ok: true, skipped: true, reason: "insufficient data" };
          continue;
        }

        const SYSTEM = `You are building a comprehensive profile of an operator (Bishop) from everything their AI agents have learned about them over time. This profile will be the primary context every agent reads at the start of each session.

Return a JSON object with exactly:
{
  "profile_text": "A 250-300 word first-person narrative profile of Bishop — who he is, how he thinks, what he's building, what he values, how he makes decisions, and what drives him. Written as if briefing a new agent who has never met him. Be specific and concrete.",
  "key_facts": [
    {"fact": "one concrete, specific thing about Bishop", "category": "goals|mindset|communication|preferences|patterns", "confidence": 0.0-1.0}
  ]
}

Rules:
- key_facts: 8-12 entries, only what's clearly evidenced in the data
- profile_text: specific and personal, not generic
- Integrate all data sources — don't just summarize one
- Higher confidence for facts that appear repeatedly across multiple sources
- Output JSON only. No prose, no markdown.`;

        const USER = `ALL STORED MEMORIES (${(memRows as any[]).length} entries):
${memBlock || "(none)"}

RECENT AGENT ACTIVITY — 30 DAYS (${(crossRows as any[]).length} sessions):
${crossBlock || "(none)"}

GOALS (all):
${goalBlock || "(none)"}

AGENT AUTONOMOUS ACTIONS — 30 DAYS:
${taskBlock || "(none)"}

AGENT JOURNAL — 30 DAYS:
${journalBlock || "(none)"}

Build the operator profile. JSON only.`;

        const raw = await gemini(GOOGLE_KEY, SYSTEM, USER, 900);
        if (!raw) {
          results[uid] = { ok: false, error: "Gemini returned empty" };
          continue;
        }

        let profile: { profile_text: string; key_facts: Array<{ fact: string; category: string; confidence: number }> } | null = null;
        try {
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) profile = JSON.parse(m[0]);
        } catch { /* skip */ }

        if (!profile?.profile_text) {
          results[uid] = { ok: false, error: "Failed to parse profile" };
          continue;
        }

        // Upsert to operator_profile table
        await fetch(`${SUPABASE_URL}/rest/v1/operator_profile?on_conflict=user_id`, {
          method: "POST",
          headers: { ...authHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            user_id: uid,
            profile_text: profile.profile_text.slice(0, 3000),
            key_facts: profile.key_facts ?? [],
            generated_at: new Date().toISOString(),
          }),
        }).catch(() => {});

        // Also write profile as a high-confidence shared_operator_memory entry
        // so agents pick it up automatically from existing reads
        await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_shared_memory`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            _user_id: uid,
            _source_agent: "consolidate",
            _memory_type: "core_profile",
            _key: "bishop_core_profile",
            _value: profile.profile_text.slice(0, 2000),
            _context: "weekly_consolidation",
            _confidence: 0.95,
            _expires_at: null,
          }),
        }).catch(() => {});

        // Write each key fact as a high-confidence memory
        const validCategories = ["goals", "mindset", "communication", "preferences", "patterns"];
        for (const fact of (profile.key_facts ?? []).slice(0, 12)) {
          if (!fact.fact) continue;
          await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_shared_memory`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({
              _user_id: uid,
              _source_agent: "consolidate",
              _memory_type: validCategories.includes(fact.category) ? fact.category : "fact",
              _key: `consolidate_${fact.fact.slice(0, 40).replace(/\s+/g, "_").toLowerCase()}`,
              _value: fact.fact.slice(0, 500),
              _context: "weekly_consolidation",
              _confidence: Math.min(1.0, Math.max(0.5, Number(fact.confidence ?? 0.8))),
              _expires_at: null,
            }),
          }).catch(() => {});
        }

        results[uid] = {
          ok: true,
          profile_length: profile.profile_text.length,
          key_facts_written: (profile.key_facts ?? []).length,
        };
      } catch (e) {
        results[uid] = { ok: false, error: String(e) };
      }
    }

    return new Response(
      JSON.stringify({ ok: true, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[memory_consolidate]", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
