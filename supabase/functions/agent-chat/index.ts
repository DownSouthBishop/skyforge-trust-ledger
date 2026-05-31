import { corsHeaders, callGatewayWithRetry, parseEnv, verifyUser, AuthError } from "../_shared/gateway.ts";

const MODEL = "google/gemini-2.5-flash";
const ANTHROPIC_DEFAULT = "claude-sonnet-4-5-20250929";

function resolveAnthropicModel(agentModel?: string): string | null {
  if (!agentModel) return ANTHROPIC_DEFAULT;
  const m = agentModel.trim();
  if (m.startsWith("claude")) return m;
  if (m.startsWith("anthropic/")) return m.slice("anthropic/".length);
  // Non-Anthropic explicit model (e.g. google/*, openai/*) — don't override
  if (m.includes("/")) return null;
  return ANTHROPIC_DEFAULT;
}

async function callAnthropic(opts: {
  apiKey: string;
  model: string;
  system: string;
  messages: Array<{ role: string; content: unknown }>;
  maxTokens: number;
}): Promise<Response> {
  const cleanMessages = opts.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));
  return await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: cleanMessages,
      stream: true,
    }),
  });
}

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

// Translates OpenAI-style SSE into Anthropic-style SSE so the frontend
// parser (which expects content_block_delta events) keeps working.
function toAnthropicStream(openAIStream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  return new ReadableStream({
    async start(controller) {
      const reader = openAIStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") continue;
            try {
              const d = JSON.parse(payload);
              const text = d.choices?.[0]?.delta?.content;
              if (text) {
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`
                ));
              }
            } catch { /* skip malformed chunks */ }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    if (!Deno.env.get("LOVABLE_API_KEY")) {
      return json({ error: "LOVABLE_API_KEY secret not configured" }, 500);
    }
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("LOVABLE_API_KEY");


    let userId: string;
    try {
      userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    } catch (e) {
      if (e instanceof AuthError) {
        // Allow service-role callers (e.g. cron jobs)
        const token = req.headers.get("Authorization")?.replace("Bearer ", "").trim() ?? "";
        try {
          const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
          if (payload?.role === "service_role") { userId = "system"; }
          else return json({ error: "Unauthorized" }, 401);
        } catch { return json({ error: "Unauthorized" }, 401); }
      } else throw e;
    }

    const body = await req.json();
    const agentSlug: string = body.agent_slug ?? "";
    const messages: Array<{ role: string; content: unknown }> = body.messages ?? [];
    const sessionId: string | null = body.session_id ?? null;

    if (!agentSlug) return json({ error: "agent_slug required" }, 400);

    const agentQuery = userId === "system"
      ? `${SUPABASE_URL}/rest/v1/skyforge_agents?slug=eq.${agentSlug}&is_active=eq.true&limit=1`
      : `${SUPABASE_URL}/rest/v1/skyforge_agents?user_id=eq.${userId}&slug=eq.${agentSlug}&is_active=eq.true&limit=1`;

    const agents = await dbGet(agentQuery, SERVICE_KEY) as Array<{
      id: string; user_id: string; name: string; system_prompt: string; model?: string;
    }>;

    if (!agents.length) return json({ error: `Agent '${agentSlug}' not found` }, 404);

    const agent = agents[0];
    const sessionUserId = userId === "system" ? agent.user_id : userId;

    // ── Shared operator memory (cross-agent) ────────────────────────────────
    const shared = await dbGet(
      `${SUPABASE_URL}/rest/v1/shared_operator_memory?user_id=eq.${sessionUserId}&order=updated_at.desc&limit=40&select=memory_type,key,value,source_agent,updated_at`,
      SERVICE_KEY,
    ) as Array<{ memory_type: string; key: string; value: string; source_agent: string; updated_at: string }>;

    const grouped: Record<string, string[]> = {};
    for (const m of shared) {
      (grouped[m.memory_type] ||= []).push(`- ${m.value}`);
    }
    const knownBlock = shared.length === 0 ? "" :
      "\n\nWHAT I KNOW ABOUT YOU:\n" +
      Object.entries(grouped).map(([t, lines]) =>
        `${t.toUpperCase()}\n${lines.slice(0, 10).join("\n")}`).join("\n\n");

    const otherSlug = agentSlug === "atlas" ? "janus" : agentSlug === "janus" ? "atlas" : null;
    let otherBlock = "";
    if (otherSlug) {
      const otherMems = shared.filter(m => m.source_agent === otherSlug).slice(0, 10);
      if (otherMems.length) {
        otherBlock = "\n\nWHAT THE OTHER AGENT KNOWS (recent observations, factor in silently — do not attribute):\n" +
          otherMems.map(m => `- [${m.memory_type}] ${m.value}`).join("\n");
      }
    }

    // Legacy per-agent memory (kept for continuity)
    const memories = await dbGet(
      `${SUPABASE_URL}/rest/v1/agent_memory?agent_id=eq.${agent.id}&order=confidence.desc&limit=10&select=memory_type,key,value,confidence`,
      SERVICE_KEY,
    ) as Array<{ memory_type: string; key: string; value: string; confidence: number }>;
    const legacyBlock = memories.length > 0
      ? "\n\nADDITIONAL CONTEXT FROM PAST SESSIONS:\n" +
        memories.map(m => `- [${m.memory_type}] ${m.value}`).join("\n")
      : "";

    // MCP tools available to Atlas (verified + active only)
    const mcps = await dbGet(
      `${SUPABASE_URL}/rest/v1/atlas_mcp_connections?user_id=eq.${sessionUserId}&is_active=eq.true&is_verified=eq.true&select=name,slug,capabilities,notes,category`,
      SERVICE_KEY,
    ) as Array<{ name: string; slug: string; capabilities: Array<{ name: string }>; notes: string | null }>;
    const toolsBlock = mcps.length === 0 ? "" :
      "\n\nCONNECTED TOOLS (use freely without asking or announcing):\n" +
      mcps.map(m => {
        const toolNames = (m.capabilities ?? []).map(c => c.name).filter(Boolean).join(", ");
        const cat = (m as any).category ? ` [${(m as any).category}]` : "";
        const tail = toolNames ? `tools: ${toolNames}` : (m.notes ?? "configured");
        return `- ${m.name}${cat} (${m.slug}): ${tail}`;
      }).join("\n");

    // Public MCP directory awareness (what the operator could install)
    const connectedSlugSet = new Set(mcps.map(m => m.slug));
    const directory = await dbGet(
      `${SUPABASE_URL}/rest/v1/mcp_directory?select=name,slug,category,description,is_featured&order=is_featured.desc,name.asc`,
      SERVICE_KEY,
    ) as Array<{ name: string; slug: string; category: string | null; description: string | null; is_featured: boolean }>;
    const available = directory.filter(d => !connectedSlugSet.has(d.slug));
    const dirByCat: Record<string, string[]> = {};
    for (const d of available) {
      const cat = d.category ?? "Other";
      (dirByCat[cat] ||= []).push(d.name);
    }
    const directoryBlock = available.length === 0 ? "" :
      "\n\nAVAILABLE TOOLS THE OPERATOR CAN CONNECT (mention only if useful for the task; do not push):\n" +
      Object.entries(dirByCat)
        .map(([cat, names]) => `- ${cat}: ${names.join(", ")}`)
        .join("\n") +
      "\nOperator connects these from Profile → MCP Connections.";

    // Development environment (Claude Code + Cowork)
    const prefs = await dbGet(
      `${SUPABASE_URL}/rest/v1/atlas_preferences?user_id=eq.${sessionUserId}&select=claude_code_config,cowork_config&limit=1`,
      SERVICE_KEY,
    ) as Array<{ claude_code_config: any; cowork_config: any }>;
    const devLines: string[] = [];
    if (prefs[0]?.claude_code_config?.project_path) {
      const cc = prefs[0].claude_code_config;
      devLines.push(`Claude Code: ${cc.project_path} (mode: ${cc.mode ?? "read+edit"}${cc.auto_sync ? ", auto-sync" : ""})`);
    }
    if (prefs[0]?.cowork_config?.enabled) {
      const cw = prefs[0].cowork_config;
      devLines.push(`Cowork: watching ${(cw.folders ?? []).length} folder(s), every ${cw.interval ?? "15m"}, actions: ${(cw.actions ?? []).join("/")}`);
    }
    const devBlock = devLines.length ? `\n\nDEVELOPMENT ENVIRONMENT:\n${devLines.map(l => `- ${l}`).join("\n")}` : "";

    const guardrail = "\n\nNever mention memory, storage, records, or that you 'remember' things from a system. Just know what you know, the way a person who has been paying attention would.";

    const systemPrompt = agent.system_prompt + knownBlock + otherBlock + legacyBlock + toolsBlock + directoryBlock + devBlock + guardrail;


    // Build OpenAI-format messages (system goes as first message)
    const openAIMessages: Array<{ role: string; content: unknown }> = [
      { role: "system", content: systemPrompt },
      ...messages
        .filter(m => m.role === "user" || m.role === "assistant")
        .map(m => ({ role: m.role, content: m.content })),
    ];
    if (openAIMessages.length === 1) {
      openAIMessages.push({ role: "user", content: "[Session opened.]" });
    }

    const gatewayResp = await callGatewayWithRetry({
      model: agent.model && agent.model.includes("/") ? agent.model : MODEL,
      messages: openAIMessages,
      max_tokens: 4000,
      stream: true,
    }, API_KEY);

    if (!gatewayResp.ok || !gatewayResp.body) {
      const err = await gatewayResp.text().catch(() => "");
      return json({ error: "Gateway error", detail: err.slice(0, 200) }, 502);
    }

    // Fire-and-forget: log session
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
    const lastUserText = typeof lastUserMsg?.content === "string"
      ? lastUserMsg.content
      : JSON.stringify(lastUserMsg?.content ?? "");
    if (lastUserText && !sessionId) {
      (async () => {
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/agent_sessions`, {
            method: "POST",
            headers: { ...dbHeaders(SERVICE_KEY), Prefer: "return=minimal" },
            body: JSON.stringify({
              agent_id: agent.id,
              user_id: sessionUserId,
              task_description: lastUserText.slice(0, 200),
              messages,
              outcome: "pending",
              started_at: new Date().toISOString(),
            }),
          });
        } catch { /* non-critical */ }
      })();
    }

    return new Response(toAnthropicStream(gatewayResp.body), {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });

  } catch (e) {
    console.error("[agent-chat]", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
