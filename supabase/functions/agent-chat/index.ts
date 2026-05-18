// agent-chat — streaming chat with a spawned Skyforge agent
// Loads the agent's system prompt + memory, streams via Anthropic,
// stores the session to agent_sessions.

import { corsHeaders, verifyUser, parseEnv, AuthError } from "../_shared/gateway.ts";

const MODEL = "claude-sonnet-4-6";

function dbHeaders(key: string) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function dbGet(url: string, key: string): Promise<unknown[]> {
  try {
    const r = await fetch(url, { headers: dbHeaders(key) });
    return r.ok ? await r.json() : [];
  } catch { return []; }
}

async function dbPost(url: string, key: string, body: unknown): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { ...dbHeaders(key), Prefer: "return=minimal" },
      body: JSON.stringify(body),
    });
  } catch { /* non-critical */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("ANTHROPIC_API_KEY");

    // Auth
    let userId: string;
    try {
      userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    } catch (e) {
      if (e instanceof AuthError) {
        const serviceAuth = req.headers.get("Authorization")?.replace("Bearer ", "");
        if (serviceAuth === SERVICE_KEY) {
          userId = "system";
        } else {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      } else throw e;
    }

    const body = await req.json();
    const agentSlug: string = body.agent_slug ?? "";
    const messages: Array<{ role: string; content: string }> = body.messages ?? [];
    const sessionId: string | null = body.session_id ?? null;

    if (!agentSlug) {
      return new Response(JSON.stringify({ error: "agent_slug required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load agent — service role (Telegram) searches by slug only; user requests scope to their own agents
    const agentQuery = userId === "system"
      ? `${SUPABASE_URL}/rest/v1/skyforge_agents?slug=eq.${agentSlug}&is_active=eq.true&limit=1`
      : `${SUPABASE_URL}/rest/v1/skyforge_agents?user_id=eq.${userId}&slug=eq.${agentSlug}&is_active=eq.true&limit=1`;

    const agents = await dbGet(agentQuery, SERVICE_KEY) as Array<{
      id: string; user_id: string; name: string; system_prompt: string; model?: string;
    }>;

    if (!agents.length) {
      return new Response(JSON.stringify({ error: `Agent '${agentSlug}' not found` }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const agent = agents[0];
    // When called via service role, use the agent's owner for session attribution
    const sessionUserId = userId === "system" ? agent.user_id : userId;

    // Load agent memory for context
    const memories = await dbGet(
      `${SUPABASE_URL}/rest/v1/agent_memory?agent_id=eq.${agent.id}&order=confidence.desc&limit=20&select=memory_type,key,value,confidence`,
      SERVICE_KEY,
    ) as Array<{ memory_type: string; key: string; value: string; confidence: number }>;

    // Build system prompt
    const memoryBlock = memories.length > 0
      ? "\n\nWHAT I KNOW (learned from past sessions):\n" +
        memories.map(m => `[${m.memory_type}] ${m.key}: ${m.value} (confidence: ${Math.round(m.confidence * 100)}%)`).join("\n")
      : "";

    const systemPrompt = agent.system_prompt + memoryBlock;

    // Stream from Anthropic
    const anthropicMessages = messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role, content: m.content }));

    if (anthropicMessages.length === 0) {
      anthropicMessages.push({ role: "user", content: "[Session opened.]" });
    }

    const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: agent.model ?? MODEL,
        system: systemPrompt,
        max_tokens: 4000,
        stream: true,
        messages: anthropicMessages,
      }),
    });

    if (!aiResp.ok || !aiResp.body) {
      const err = await aiResp.text().catch(() => "");
      return new Response(JSON.stringify({ error: "AI error", detail: err.slice(0, 200) }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fire-and-forget: create session then trigger reflection, or update existing session
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user")?.content ?? "";
    if (lastUserMsg) {
      if (!sessionId) {
        (async () => {
          try {
            await fetch(`${SUPABASE_URL}/rest/v1/agent_sessions`, {
              method: "POST",
              headers: { ...dbHeaders(SERVICE_KEY), Prefer: "return=minimal" },
              body: JSON.stringify({
                agent_id: agent.id,
                user_id: sessionUserId,
                task_description: lastUserMsg.slice(0, 200),
                messages: messages,
                outcome: "pending",
                started_at: new Date().toISOString(),
              }),
            });
            // Session committed — trigger reflection
            fetch(`${SUPABASE_URL}/functions/v1/agent_reflect`, {
              method: "POST",
              headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ agent_id: agent.id, user_id: sessionUserId }),
            }).catch(() => {});
          } catch { /* non-critical */ }
        })();
      } else {
        fetch(`${SUPABASE_URL}/rest/v1/agent_sessions?id=eq.${sessionId}`, {
          method: "PATCH",
          headers: { ...dbHeaders(SERVICE_KEY), Prefer: "return=minimal" },
          body: JSON.stringify({ messages, outcome: "pending" }),
        }).catch(() => {});
      }
    }

    return new Response(aiResp.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });

  } catch (e) {
    console.error("[agent-chat]", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
