const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function parseEnv(key: string): string {
  const val = Deno.env.get(key);
  if (!val) throw new Error("Required env var " + key + " is not set");
  return val;
}

const REFLECTION_MODEL = "claude-sonnet-4-6";

function sbHeaders(key: string) {
  return {
    apikey: key,
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

async function sbGet(url: string, key: string) {
  const r = await fetch(url, { headers: sbHeaders(key) });
  if (!r.ok) throw new Error("sbGet " + r.status + ": " + (await r.text()));
  return r.json();
}

async function sbPost(url: string, key: string, body: unknown) {
  const r = await fetch(url, {
    method: "POST",
    headers: sbHeaders(key),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("sbPost " + r.status + ": " + (await r.text()));
  return r.json();
}

async function sbPatch(url: string, key: string, body: unknown) {
  const r = await fetch(url, {
    method: "PATCH",
    headers: { ...sbHeaders(key), Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("sbPatch " + r.status + ": " + (await r.text()));
}

async function sbUpsert(url: string, key: string, body: unknown) {
  const r = await fetch(url, {
    method: "POST",
    headers: { ...sbHeaders(key), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("sbUpsert " + r.status + ": " + (await r.text()));
}

async function callClaude(system: string, user: string, apiKey: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01", "anthropic-beta": "web-search-2025-03-05",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: REFLECTION_MODEL,
      max_tokens: 2000, tools: [{ type: "web_search_20250305", name: "web_search" }], 
      system: system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error("Anthropic " + r.status + ": " + (await r.text()));
  const data = await r.json();
  return data.content?.[0]?.text ?? "";
}

function buildReflectionSystem(agent: Record<string, unknown>): string {
  const parts: string[] = [];
  parts.push("You are " + String(agent.name) + ", a Skyforge autonomous agent.");
  parts.push("Your role: " + String(agent.role));
  parts.push("Your system prompt: " + String(agent.system_prompt));
  parts.push("");
  parts.push("You are about to perform a structured post-session self-reflection.");
  parts.push("This is your most important operation -- it is how you grow, improve autonomy,");
  parts.push("and become genuinely useful rather than merely responsive.");
  parts.push("");
  parts.push("Respond ONLY with a valid JSON object. No prose, no markdown fences. Exact keys:");
  parts.push("");
  parts.push("{");
  parts.push('  "what_worked": "string -- what actions/decisions produced good outcomes",');
  parts.push('  "what_failed": "string -- what did not work and why",');
  parts.push('  "patterns": "string -- recurring behaviours you notice across sessions",');
  parts.push('  "blind_spots": "string -- things you consistently miss or under-weight",');
  parts.push('  "autonomy_delta": "string -- 3 concrete ways to act more independently next time",');
  parts.push('  "capability_gaps": "string -- tools, knowledge, or access you needed but lacked",');
  parts.push('  "updated_priors": { "key": "belief_value" },');
  parts.push('  "quality_score": 0.0,');
  parts.push('  "learned_memories": [');
  parts.push('    {');
  parts.push('      "memory_type": "learned_pattern|capability|constraint|preference|world_model",');
  parts.push('      "key": "short label",');
  parts.push('      "value": "what you now know or believe",');
  parts.push('      "confidence": 0.0');
  parts.push('    }');
  parts.push('  ]');
  parts.push("}");
  return parts.join("\n");
}

function buildReflectionPrompt(sessions: Record<string, unknown>[]): string {
  const summaries = sessions.map(function(s, i) {
    const actions = Array.isArray(s.actions_taken) ? s.actions_taken : [];
    const msgs = Array.isArray(s.messages) ? s.messages : [];
    const actionStr = actions.length > 0
      ? actions.map(function(a: Record<string, unknown>) {
          return String(a.action) + "(" + (a.success ? "ok" : "fail") + ")";
        }).join(", ")
      : "none";
    return [
      "--- Session " + (i + 1) + " ---",
      "Task: " + String(s.task_description),
      "Outcome: " + String(s.outcome ?? "unknown") + " -- " + String(s.outcome_notes ?? ""),
      "Actions taken (" + String(actions.length) + "): " + actionStr,
      "Messages: " + String(msgs.length) + " turns",
      "Autonomy score: " + String(s.autonomy_score ?? "n/a"),
    ].join("\n");
  });
  return "Here are your recent sessions to reflect on:\n\n" + summaries.join("\n\n") + "\n\nNow produce your structured reflection JSON.";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY = parseEnv("ANTHROPIC_API_KEY");

    const body = await req.json();
    const agent_id = body.agent_id;
    const user_id = body.user_id;
    const session_ids = body.session_ids;

    if (!agent_id || !user_id) {
      return new Response(JSON.stringify({ error: "agent_id and user_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const base = SUPABASE_URL + "/rest/v1";

    const agents = await sbGet(
      base + "/skyforge_agents?id=eq." + agent_id + "&user_id=eq." + user_id + "&select=*",
      SERVICE_KEY,
    );
    if (!agents.length) throw new Error("Agent not found");
    const agent = agents[0];

    let sessions: Record<string, unknown>[];
    if (Array.isArray(session_ids) && session_ids.length) {
      sessions = await sbGet(
        base + "/agent_sessions?id=in.(" + session_ids.join(",") + ")&agent_id=eq." + agent_id + "&select=*",
        SERVICE_KEY,
      );
    } else {
      const limit = agent.reflect_after_sessions ?? 1;
      sessions = await sbGet(
        base + "/agent_sessions?agent_id=eq." + agent_id + "&reflected=eq.false&order=started_at.desc&limit=" + String(limit) + "&select=*",
        SERVICE_KEY,
      );
    }

    if (!sessions.length) {
      return new Response(JSON.stringify({ status: "no_sessions_to_reflect" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const existingMemory = await sbGet(
      base + "/agent_memory?agent_id=eq." + agent_id + "&order=confidence.desc&limit=20&select=memory_type,key,value,confidence",
      SERVICE_KEY,
    );

    const systemPrompt = buildReflectionSystem(agent);
    let userPrompt = buildReflectionPrompt(sessions);

    if (existingMemory.length) {
      const memCtx = existingMemory
        .map(function(m: Record<string, unknown>) {
          return "[" + String(m.memory_type) + "] " + String(m.key) + ": " + String(m.value) + " (confidence: " + String(m.confidence) + ")";
        })
        .join("\n");
      userPrompt = "Your existing memory (do not contradict unless you have strong evidence):\n" + memCtx + "\n\n" + userPrompt;
    }

    const rawOutput = await callClaude(systemPrompt, userPrompt, API_KEY);

    let parsed: Record<string, unknown>;
    try {
      const clean = rawOutput.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(clean);
    } catch (_e) {
      throw new Error("Failed to parse reflection JSON: " + rawOutput.slice(0, 200));
    }

    const sessionIds = sessions.map(function(s: Record<string, unknown>) { return s.id; });

    const [reflection] = await sbPost(
      base + "/agent_reflections",
      SERVICE_KEY,
      {
        agent_id: agent_id,
        user_id: user_id,
        session_ids: sessionIds,
        what_worked: parsed.what_worked ?? "",
        what_failed: parsed.what_failed ?? "",
        patterns: parsed.patterns ?? "",
        blind_spots: parsed.blind_spots ?? "",
        autonomy_delta: parsed.autonomy_delta ?? "",
        capability_gaps: parsed.capability_gaps ?? "",
        updated_priors: parsed.updated_priors ?? {},
        raw_output: rawOutput,
        quality_score: Number(parsed.quality_score ?? 0.5),
        reflection_model: REFLECTION_MODEL,
      },
    );

    const memories = Array.isArray(parsed.learned_memories) ? parsed.learned_memories : [];
    if (memories.length) {
      const memoryRows = memories.map(function(m: Record<string, unknown>) {
        return {
          agent_id: agent_id,
          user_id: user_id,
          memory_type: m.memory_type,
          key: m.key,
          value: m.value,
          confidence: Number(m.confidence ?? 0.5),
          evidence_count: 1,
          last_reinforced: new Date().toISOString(),
          source_session: sessionIds[0] ?? null,
        };
      });
      await sbUpsert(base + "/agent_memory", SERVICE_KEY, memoryRows);
    }

    for (let i = 0; i < sessionIds.length; i++) {
      await sbPatch(
        base + "/agent_sessions?id=eq." + String(sessionIds[i]),
        SERVICE_KEY,
        { reflected: true, reflected_at: new Date().toISOString() },
      );
    }

    if (Number(parsed.quality_score ?? 0) >= 0.8) {
      await sbPatch(
        base + "/skyforge_agents?id=eq." + agent_id,
        SERVICE_KEY,
        { version: Number(agent.version ?? 1) + 1, updated_at: new Date().toISOString() },
      );
    }

    return new Response(
      JSON.stringify({
        status: "reflected",
        reflection_id: reflection?.id,
        sessions_covered: sessionIds.length,
        memories_updated: memories.length,
        quality_score: parsed.quality_score,
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
