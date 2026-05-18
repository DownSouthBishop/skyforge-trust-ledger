// agent_reflect — Post-session self-reflection for any Skyforge agent.
//
// Called automatically after a session completes (or manually).
// Reads the last N un-reflected sessions, runs a structured reflection
// via Claude, writes the result to agent_reflections, and upserts
// learned patterns into agent_memory.
//
// POST { agent_id, session_ids? }

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";

const REFLECTION_MODEL = "claude-sonnet-4-6";

// ─── Supabase helpers ─────────────────────────────────────────────

function sbHeaders(key: string) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

async function sbGet(url: string, key: string) {
  const r = await fetch(url, { headers: sbHeaders(key) });
  if (!r.ok) throw new Error(`sbGet ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sbPost(url: string, key: string, body: unknown) {
  const r = await fetch(url, {
    method: "POST",
    headers: sbHeaders(key),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sbPost ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sbPatch(url: string, key: string, body: unknown) {
  const r = await fetch(url, {
    method: "PATCH",
    headers: { ...sbHeaders(key), Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sbPatch ${r.status}: ${await r.text()}`);
}

async function sbUpsert(url: string, key: string, body: unknown) {
  const r = await fetch(url, {
    method: "POST",
    headers: { ...sbHeaders(key), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sbUpsert ${r.status}: ${await r.text()}`);
}

// ─── Anthropic call ───────────────────────────────────────────────

async function callClaude(systemPrompt: string, userMessage: string, apiKey: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: REFLECTION_MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.content?.[0]?.text ?? "";
}

// ─── Reflection prompt ────────────────────────────────────────────

function buildReflectionSystem(agent: Record<string, unknown>): string {
  return `You are ${agent.name}, a Skyforge autonomous agent.
Your role: ${agent.role}
Your system prompt: ${agent.system_prompt}

You are about to perform a structured post-session self-reflection.
This is your most important operation — it is how you grow, improve autonomy,
and become genuinely useful rather than merely responsive.

Respond ONLY with a valid JSON object. No prose, no markdown fences. Exact keys:

{
  "what_worked": "string — what actions/decisions produced good outcomes",
  "what_failed": "string — what didn't work and why",
  "patterns": "string — recurring behaviours you notice in yourself across sessions",
  "blind_spots": "string — things you consistently miss or under-weight",
  "autonomy_delta": "string — 3 concrete ways to act more independently next time without asking unnecessarily",
  "capability_gaps": "string — tools, knowledge, or access you needed but lacked",
  "updated_priors": {
    "key": "belief_value"
  },
  "quality_score": 0.0,
  "learned_memories": [
    {
      "memory_type": "learned_pattern|capability|constraint|preference|relationship|world_model",
      "key": "short label",
      "value": "what you now know or believe",
      "confidence": 0.0
    }
  ]
}`;
}

function buildReflectionPrompt(sessions: Record<string, unknown>[]): string {
  const summaries = sessions.map((s, i) => {
    const actions = Array.isArray(s.actions_taken) ? s.actions_taken : [];
    const msgs    = Array.isArray(s.messages) ? s.messages : [];
    return `--- Session ${i + 1} ---
Task: ${s.task_description}
Outcome: ${s.outcome ?? "unknown"} — ${s.outcome_notes ?? ""}
Actions taken (${actions.length}): ${actions.map((a: Record<string, unknown>) => `${a.action}(${a.success ? "✓" : "✗"})`).join(", ") || "none"}
Messages: ${msgs.length} turns
Autonomy score: ${s.autonomy_score ?? "n/a"}`;
  });

  return `Here are your recent sessions to reflect on:\n\n${summaries.join("\n\n")}\n\nNow produce your structured reflection JSON.`;
}

// ─── Main handler ─────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("ANTHROPIC_API_KEY");

    const { agent_id, session_ids, user_id } = await req.json();
    if (!agent_id || !user_id) {
      return new Response(JSON.stringify({ error: "agent_id and user_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const base = `${SUPABASE_URL}/rest/v1`;

    // 1. Load agent definition
    const agents = await sbGet(
      `${base}/skyforge_agents?id=eq.${agent_id}&user_id=eq.${user_id}&select=*`,
      SERVICE_KEY,
    );
    if (!agents.length) throw new Error("Agent not found");
    const agent = agents[0];

    // 2. Load sessions to reflect on
    let sessions: Record<string, unknown>[];
    if (session_ids?.length) {
      sessions = await sbGet(
        `${base}/agent_sessions?id=in.(${session_ids.join(",")})&agent_id=eq.${agent_id}&select=*`,
        SERVICE_KEY,
      );
    } else {
      // Auto: grab last N un-reflected sessions
      const limit = agent.reflect_after_sessions ?? 1;
      sessions = await sbGet(
        `${base}/agent_sessions?agent_id=eq.${agent_id}&reflected=eq.false&order=started_at.desc&limit=${limit}&select=*`,
        SERVICE_KEY,
      );
    }

    if (!sessions.length) {
      return new Response(JSON.stringify({ status: "no_sessions_to_reflect" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Load existing memory to give the reflection model context
    const existingMemory = await sbGet(
      `${base}/agent_memory?agent_id=eq.${agent_id}&order=confidence.desc&limit=20&select=memory_type,key,value,confidence`,
      SERVICE_KEY,
    );

    const systemPrompt = buildReflectionSystem(agent);
    let userPrompt     = buildReflectionPrompt(sessions);

    if (existingMemory.length) {
      const memoryContext = existingMemory
        .map((m: Record<string, unknown>) => `[${m.memory_type}] ${m.key}: ${m.value} (confidence: ${m.confidence})`)
        .join("\n");
      userPrompt = `Your existing memory (do not contradict unless you have strong evidence):\n${memoryContext}\n\n${userPrompt}`;
    }

    // 4. Run reflection
    const rawOutput = await callClaude(systemPrompt, userPrompt, API_KEY);

    // 5. Parse JSON output
    let parsed: Record<string, unknown>;
    try {
      const clean = rawOutput.replace(/```json|```/g, "").trim();
      parsed      = JSON.parse(clean);
    } catch {
      throw new Error(`Failed to parse reflection JSON: ${rawOutput.slice(0, 200)}`);
    }

    const sessionIds = sessions.map((s: Record<string, unknown>) => s.id);

    // 6. Write reflection record
    const [reflection] = await sbPost(
      `${base}/agent_reflections`,
      SERVICE_KEY,
      {
        agent_id,
        user_id,
        session_ids:       sessionIds,
        what_worked:       parsed.what_worked ?? "",
        what_failed:       parsed.what_failed ?? "",
        patterns:          parsed.patterns ?? "",
        blind_spots:       parsed.blind_spots ?? "",
        autonomy_delta:    parsed.autonomy_delta ?? "",
        capability_gaps:   parsed.capability_gaps ?? "",
        updated_priors:    parsed.updated_priors ?? {},
        raw_output:        rawOutput,
        quality_score:     Number(parsed.quality_score ?? 0.5),
        reflection_model:  REFLECTION_MODEL,
      },
    );

    // 7. Upsert learned memories
    const memories = Array.isArray(parsed.learned_memories) ? parsed.learned_memories : [];
    if (memories.length) {
      const memoryRows = memories.map((m: Record<string, unknown>) => ({
        agent_id,
        user_id,
        memory_type:      m.memory_type,
        key:              m.key,
        value:            m.value,
        confidence:       Number(m.confidence ?? 0.5),
        evidence_count:   1,
        last_reinforced:  new Date().toISOString(),
        source_session:   sessionIds[0] ?? null,
      }));
      await sbUpsert(`${base}/agent_memory`, SERVICE_KEY, memoryRows);
    }

    // 8. Mark sessions as reflected
    for (const sid of sessionIds) {
      await sbPatch(
        `${base}/agent_sessions?id=eq.${sid}`,
        SERVICE_KEY,
        { reflected: true, reflected_at: new Date().toISOString() },
      );
    }

    // 9. If the reflection surfaced strong new priors, optionally bump the
    //    agent version so operators know the character has evolved.
    if (Number(parsed.quality_score ?? 0) >= 0.8) {
      await sbPatch(
        `${base}/skyforge_agents?id=eq.${agent_id}`,
        SERVICE_KEY,
        { version: (agent.version ?? 1) + 1, updated_at: new Date().toISOString() },
      );
    }

    return new Response(
      JSON.stringify({
        status:           "reflected",
        reflection_id:    reflection?.id,
        sessions_covered: sessionIds.length,
        memories_updated: memories.length,
        quality_score:    parsed.quality_score,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("agent_reflect error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
