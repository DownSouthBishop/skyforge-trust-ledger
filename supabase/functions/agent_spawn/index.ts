// agent_spawn — Creates a new Skyforge agent with full baseline capabilities.
//
// Takes a raw description + role and uses Claude to:
//   1. Extract structured character fields
//   2. Generate initial capabilities list
//   3. Write the agent record
//   4. Seed baseline memory with domain knowledge
//
// POST { user_id, name, role, description, clients?, plugins? }

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";

const SPAWN_MODEL = "claude-sonnet-4-6";

function sbHeaders(key: string) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
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

async function sbGet(url: string, key: string) {
  const r = await fetch(url, { headers: sbHeaders(key) });
  return r.json();
}

async function callClaude(system: string, user: string, apiKey: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: SPAWN_MODEL,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.content?.[0]?.text ?? "";
}

const SPAWN_SYSTEM = `You are the Skyforge Agent Architect.
Your job is to take a brief agent description and produce a complete, production-ready
ElizaOS character definition plus a set of seed memories.

Every agent you create shares this baseline:
- It will self-reflect after every session, identifying what worked and what didn't.
- It will try to increase its own autonomy after each reflection cycle.
- It will route tasks to itself confidently when they match its domain.
- It will escalate to Atlas (the orchestrator) when a task is out of scope.
- It will never attempt tasks it is not equipped for.

Respond ONLY with valid JSON. No prose, no markdown. Keys:

{
  "slug": "url-safe-lowercase-handle",
  "avatar_emoji": "single emoji representing this agent",
  "system_prompt": "complete system prompt — identity, mission, operating rules, escalation rules",
  "bio": ["bullet 1", "bullet 2", "bullet 3"],
  "topics": ["topic1", "topic2"],
  "style_notes": ["style note 1", "style note 2"],
  "capabilities": [
    {
      "name": "ACTION_NAME",
      "description": "what this action does",
      "examples": ["example trigger 1", "example trigger 2"]
    }
  ],
  "seed_memories": [
    {
      "memory_type": "capability|constraint|world_model|preference",
      "key": "short label",
      "value": "what the agent should know from day one",
      "confidence": 0.9
    }
  ]
}`;

function buildSpawnPrompt(
  name: string,
  role: string,
  description: string,
  existingAgents: string[],
): string {
  const peers = existingAgents.length
    ? `\nExisting agents the new agent can delegate to or receive from: ${existingAgents.join(", ")}`
    : "";

  return `Create a complete agent definition for the following:

Name: ${name}
Role: ${role}
Description: ${description}
${peers}

Important: 
- The system prompt must explicitly instruct the agent to self-reflect after every session.
- Include an ESCALATE_TO_ATLAS capability for tasks outside its domain.
- Include a SELF_REFLECT capability that the agent invokes at session end.
- Include a REPORT_STATUS capability so Atlas can query it.
- The agent must be able to decide independently which of its capabilities to use for a given task.
- Design capabilities around what this specific role genuinely needs.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("ANTHROPIC_API_KEY");

    const { user_id, name, role, description, clients, plugins } = await req.json();
    if (!user_id || !name || !role || !description) {
      return new Response(JSON.stringify({ error: "user_id, name, role, description required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const base = `${SUPABASE_URL}/rest/v1`;

    // 1. Load existing agents so the new agent knows its peers
    const existing = await sbGet(
      `${base}/skyforge_agents?user_id=eq.${user_id}&is_active=eq.true&select=name,role`,
      SERVICE_KEY,
    );
    const peerList: string[] = Array.isArray(existing)
      ? existing.map((a: Record<string, unknown>) => `${a.name} (${a.role})`)
      : [];

    // 2. Generate character definition
    const rawOutput = await callClaude(
      SPAWN_SYSTEM,
      buildSpawnPrompt(name, role, description, peerList),
      API_KEY,
    );

    let parsed: Record<string, unknown>;
    try {
      const clean = rawOutput.replace(/```json|```/g, "").trim();
      parsed      = JSON.parse(clean);
    } catch {
      throw new Error(`Failed to parse spawn JSON: ${rawOutput.slice(0, 300)}`);
    }

    // 3. Write agent record
    let agent: Record<string, unknown>;
    try {
      const result = await sbPost(
        `${base}/skyforge_agents`,
        SERVICE_KEY,
        {
          user_id,
          name,
          slug:             parsed.slug,
          role,
          avatar_emoji:     parsed.avatar_emoji ?? "🤖",
          system_prompt:    parsed.system_prompt,
          bio:              parsed.bio ?? [],
          topics:           parsed.topics ?? [],
          style_notes:      parsed.style_notes ?? [],
          clients:          clients ?? [],
          plugins:          plugins ?? [],
          capabilities:     parsed.capabilities ?? [],
          reflect_after_sessions: 1,
          auto_execute:     false,
          is_active:        true,
          model:            SPAWN_MODEL,
        },
      );
      agent = result[0];
    } catch (insertErr: unknown) {
      const msg = (insertErr as Error).message ?? "";
      if (msg.includes("23505") || msg.includes("unique")) {
        return new Response(
          JSON.stringify({ error: `An agent named "${name}" already exists. Choose a different name.` }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      throw insertErr;
    }

    // 4. Seed baseline memories
    const seedMemories = Array.isArray(parsed.seed_memories) ? parsed.seed_memories : [];

    // Always add the self-reflection baseline memory
    seedMemories.push({
      memory_type:  "constraint",
      key:          "always_reflect",
      value:        "After every session, invoke SELF_REFLECT. Record what worked, what failed, what to do differently. This is non-negotiable.",
      confidence:   1.0,
    });
    seedMemories.push({
      memory_type:  "constraint",
      key:          "know_your_scope",
      value:        "When a task is outside your defined capabilities, escalate to Atlas immediately rather than attempting it poorly.",
      confidence:   1.0,
    });
    seedMemories.push({
      memory_type:  "preference",
      key:          "autonomy_default",
      value:        "Prefer to act autonomously on tasks within scope rather than asking for confirmation. Ask only when the action is irreversible or costly.",
      confidence:   0.9,
    });

    if (seedMemories.length) {
      const memRows = seedMemories.map((m: Record<string, unknown>) => ({
        agent_id:        agent.id,
        user_id,
        memory_type:     m.memory_type,
        key:             m.key,
        value:           m.value,
        confidence:      Number(m.confidence ?? 0.7),
        evidence_count:  1,
        last_reinforced: new Date().toISOString(),
      }));

      // Fire and forget — don't block the response on seed memory write
      fetch(`${base}/agent_memory`, {
        method: "POST",
        headers: { ...sbHeaders(SERVICE_KEY), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(memRows),
      }).catch(console.error);
    }

    return new Response(
      JSON.stringify({
        status:      "spawned",
        agent_id:    agent.id,
        name:        agent.name,
        slug:        agent.slug,
        capabilities: (parsed.capabilities as unknown[])?.length ?? 0,
        seed_memories: seedMemories.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("agent_spawn error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
