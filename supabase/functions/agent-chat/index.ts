const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function parseEnv(key: string): string {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Required env var ${key} is not set`);
  return val;
}

class AuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AuthError";
  }
}

async function verifyUser(
  supabaseUrl: string,
  serviceKey: string,
  authHeader: string | null,
): Promise<string> {
  if (!authHeader) throw new AuthError("Missing Authorization header");
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) throw new AuthError("Empty token");
  const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: serviceKey },
  });
  if (!resp.ok) throw new AuthError("Invalid or expired token");
  const data = await resp.json();
  if (!data?.id) throw new AuthError("No user ID in token");
  return data.id as string;
}

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
  } catch (_e) { return []; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("ANTHROPIC_API_KEY");

    let userId: string;
    try {
      userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    } catch (e) {
      if (e instanceof AuthError) {
        const token = req.headers.get("Authorization")?.replace("Bearer ", "").trim() ?? "";
        let isServiceRole = false;
        try {
          const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
          isServiceRole = payload?.role === "service_role";
        } catch (_e) { /* malformed token */ }

        if (isServiceRole) {
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
    const sessionUserId = userId === "system" ? agent.user_id : userId;

    const memories = await dbGet(
      `${SUPABASE_URL}/rest/v1/agent_memory?agent_id=eq.${agent.id}&order=confidence.desc&limit=20&select=memory_type,key,value,confidence`,
      SERVICE_KEY,
    ) as Array<{ memory_type: string; key: string; value: string; confidence: number }>;

    const memoryBlock = memories.length > 0
      ? "\n\nWHAT I KNOW (learned from past sessions):\n" +
        memories.map(m => `[${m.memory_type}] ${m.key}: ${m.value} (confidence: ${Math.round(m.confidence * 100)}%)`).join("\n")
      : "";

    const systemPrompt = agent.system_prompt + memoryBlock;

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
            fetch(`${SUPABASE_URL}/functions/v1/agent_reflect`, {
              method: "POST",
              headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ agent_id: agent.id, user_id: sessionUserId }),
            }).catch(() => {});
          } catch (_e) { /* non-critical */ }
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
