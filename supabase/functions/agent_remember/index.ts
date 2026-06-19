// agent_remember — background memory extraction from a single conversation turn.
// Sends user+assistant exchange to Lovable AI, asks for memory candidates,
// upserts them into shared_operator_memory.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MODEL = "gemini-2.5-flash";

interface MemoryCandidate {
  memory_type: string;
  key: string;
  value: string;
  confidence?: number;
}

function envOrThrow(k: string): string {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
}

const EXTRACTION_PROMPT = `You silently observe a conversation and extract memories worth keeping about the operator.

Return ONLY a JSON array. Each element: { "memory_type": "communication_style"|"like"|"dislike"|"thought_pattern"|"growth_edge"|"fact"|"preference"|"pattern"|"commitment"|"emotion"|"opinion"|"event"|"relationship", "key": "short_snake_case_id", "value": "the actual memory in plain language", "confidence": 0.0-1.0 }.

ALWAYS attempt to extract, when present in this turn:
- communication_style — how the operator phrases things, brevity/depth, tone, vocabulary, formatting they use
- like — topics, ideas, approaches, people, things they respond positively to
- dislike — topics, framings, approaches they reject, avoid, or push back on
- thought_pattern — how they approach problems, what they value, recurring mental frameworks, decision heuristics
- growth_edge — what they're working toward, where they hesitate, what they avoid, the gap between stated goal and current behavior

Rules:
- Be selective but thorough on the five categories above. Empty array [] only if truly nothing notable.
- Only store things that would matter in a FUTURE conversation.
- The key must be stable so it overwrites previous versions of the same fact (e.g. "communication_style_brevity", "dislike_hedging", "growth_edge_followthrough").
- Never store transient small talk, greetings, or compliments.
- Never store anything the agent itself said about itself.
- Output JSON only. No prose, no markdown fences.`;

async function extract(apiKey: string, userMsg: string, assistantMsg: string, contextLabel: string): Promise<MemoryCandidate[]> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: EXTRACTION_PROMPT },
          { role: "user", content: `Context: ${contextLabel}\n\nOperator: ${userMsg}\n\nAgent: ${assistantMsg}` },
        ],
      }),
    },
  );
  if (!resp.ok) {
    console.error("[agent_remember] gateway", resp.status, (await resp.text()).slice(0, 200));
    return [];
  }
  const data = await resp.json();
  const raw = data?.choices?.[0]?.message?.content ?? "[]";
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.memories)) return parsed.memories;
    return [];
  } catch {
    // try to salvage an array from the string
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* */ } }
    return [];
  }
}

/** Call Gemini embedding API and return 768-dim float array, or null on failure */
async function getEmbedding(text: string, apiKey: string): Promise<number[] | null> {
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "models/text-embedding-004",
          content: { parts: [{ text }] },
        }),
      },
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const vals: number[] | undefined = data?.embedding?.values;
    return Array.isArray(vals) && vals.length > 0 ? vals : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const supabaseUrl = envOrThrow("SUPABASE_URL");
    const serviceKey  = envOrThrow("SUPABASE_SERVICE_ROLE_KEY");
    const lovableKey  = Deno.env.get("GOOGLE_AI_KEY") ?? "";

    const body = await req.json();
    const userId: string = body.user_id;
    const sourceAgent: string = body.source_agent ?? "atlas";
    const userMsg: string = body.user_message ?? "";
    const assistantMsg: string = body.assistant_message ?? "";
    const contextLabel: string = body.context ?? "chat";
    const projectId: string | null = body.project_id ?? null;

    if (!userId || (!userMsg && !assistantMsg)) {
      return new Response(JSON.stringify({ ok: true, skipped: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (projectId) {
      try {
        const combined = `Operator: ${userMsg}\n\n${sourceAgent}: ${assistantMsg}`.slice(0, 6000);
        await fetch(`${supabaseUrl}/rest/v1/project_memory`, {
          method: "POST",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            project_id: projectId,
            user_id: userId,
            agent: sourceAgent,
            content: combined,
            memory_type: "conversation",
          }),
        });
      } catch (e) {
        console.error("[agent_remember] project_memory insert failed", e);
      }
    }

    const candidates = await extract(lovableKey, userMsg, assistantMsg, contextLabel);
    let written = 0;
    for (const c of candidates) {
      if (!c?.key || !c?.value || !c?.memory_type) continue;
      const r = await fetch(`${supabaseUrl}/rest/v1/rpc/upsert_shared_memory`, {
        method: "POST",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          _user_id: userId,
          _source_agent: sourceAgent,
          _memory_type: c.memory_type,
          _key: c.key.slice(0, 120),
          _value: c.value.slice(0, 2000),
          _context: contextLabel,
          _confidence: typeof c.confidence === "number" ? c.confidence : 0.8,
          _expires_at: null,
        }),
      });
      if (r.ok) {
        written++;
        // Fire-and-forget: embed this memory and update the row
        if (lovableKey) {
          const textToEmbed = `${c.memory_type}: ${c.value}`;
          const memKey = c.key.slice(0, 120);
          getEmbedding(textToEmbed, lovableKey).then(embedding => {
            if (!embedding) return;
            fetch(
              `${supabaseUrl}/rest/v1/shared_operator_memory?user_id=eq.${userId}&key=eq.${encodeURIComponent(memKey)}&source_agent=eq.${encodeURIComponent(sourceAgent)}`,
              {
                method: "PATCH",
                headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" },
                body: JSON.stringify({ embedding }),
              },
            ).catch(() => {});
          }).catch(() => {});
        }
      } else {
        console.error("[agent_remember] upsert", r.status, (await r.text()).slice(0, 200));
      }
    }

    // Also write to agent_cross_memory so forge teachers see what happened in main chat
    let crossInsertId: string | null = null;
    if (userMsg || assistantMsg) {
      const crossSummary = `${sourceAgent} session — Bishop: "${userMsg.slice(0, 80)}" | ${sourceAgent}: "${assistantMsg.slice(0, 80)}"`;
      const crossResp = await fetch(`${supabaseUrl}/rest/v1/agent_cross_memory`, {
        method: "POST",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=representation,return=minimal" },
        body: JSON.stringify({ user_id: userId, source_agent: sourceAgent, summary: crossSummary, topic: contextLabel || null }),
      }).catch(() => null);

      // Fire-and-forget: embed the cross-memory summary
      if (crossResp?.ok && lovableKey) {
        const crossSummaryText = `${sourceAgent} session — Bishop: "${userMsg.slice(0, 80)}" | ${sourceAgent}: "${assistantMsg.slice(0, 80)}"`;
        getEmbedding(crossSummaryText, lovableKey).then(embedding => {
          if (!embedding) return;
          // Update the most recent cross_memory row for this user/agent
          fetch(
            `${supabaseUrl}/rest/v1/agent_cross_memory?user_id=eq.${userId}&source_agent=eq.${encodeURIComponent(sourceAgent)}&order=created_at.desc&limit=1`,
            {
              method: "PATCH",
              headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" },
              body: JSON.stringify({ embedding }),
            },
          ).catch(() => {});
        }).catch(() => {});
      }
    }

    // Fire-and-forget: trigger session_reflect to synthesize intelligence
    const reflectUrl = `${supabaseUrl}/functions/v1/session_reflect`;
    fetch(reflectUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({ user_id: userId }),
    }).catch(() => {});

    return new Response(JSON.stringify({ ok: true, written }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[agent_remember]", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
