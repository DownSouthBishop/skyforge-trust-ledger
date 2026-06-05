import { corsHeaders, callGatewayWithRetry, parseEnv, verifyUser, AuthError } from "../_shared/gateway.ts";

const MODEL = "google/gemini-2.5-flash";
const ANTHROPIC_DEFAULT = "claude-sonnet-4-5-20250929";

function resolveAnthropicModel(agentModel?: string): string | null {
  if (!agentModel) return ANTHROPIC_DEFAULT;
  const m = agentModel.trim();
  if (m.startsWith("claude")) return m;
  if (m.startsWith("anthropic/")) return m.slice("anthropic/".length);
  // If Anthropic is configured, keep every current/future agent off the paid gateway
  // unless this function is explicitly changed to support provider-specific routing.
  if (m.includes("/")) return ANTHROPIC_DEFAULT;
  return ANTHROPIC_DEFAULT;
}

function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

async function callAnthropic(opts: {
  apiKey: string;
  model: string;
  system: string;
  messages: Array<{ role: string; content: unknown }>;
  maxTokens: number;
  mcpServers?: Array<{ type: string; url: string; name: string; authorization_token?: string }>;
}): Promise<Response> {
  const cleanMessages = opts.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role,
      content: flatten(m.content),
    }))
    .filter((m) => m.content);
  if (cleanMessages.length === 0) cleanMessages.push({ role: "user", content: "[Session opened.]" });
  return await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": opts.mcpServers?.length ? "web-search-2025-03-05,mcp-client-2025-04-04" : "web-search-2025-03-05",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model, max_tokens: opts.maxTokens, system: opts.system, messages: cleanMessages, stream: true,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      ...(opts.mcpServers?.length ? { mcp_servers: opts.mcpServers } : {}),
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

function sseText(message: string): Response {
  const encoder = new TextEncoder();
  const safe = message.trim() || "The agent is temporarily unavailable.";
  const events = [
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: safe } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";

  return new Response(encoder.encode(events), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
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
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = Deno.env.get("LOVABLE_API_KEY") ?? "";


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

    const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("Claude_API") ?? Deno.env.get("CLAUDE_API") ?? "";
    const anthropicModel = ANTHROPIC_KEY ? resolveAnthropicModel(agent.model) : null;

    let upstreamResp: Response;
    let upstreamIsAnthropic = false;

    if (ANTHROPIC_KEY && anthropicModel) {
      upstreamResp = await callAnthropic({
        apiKey: ANTHROPIC_KEY,
        model: anthropicModel,
        system: systemPrompt,
        messages,
        maxTokens: 4000,
      });
      upstreamIsAnthropic = true;
    } else if (API_KEY) {
      upstreamResp = await callGatewayWithRetry({
        model: agent.model && agent.model.includes("/") ? agent.model : MODEL,
        messages: openAIMessages,
        max_tokens: 4000,
        stream: true,
      }, API_KEY);
    } else {
      return sseText("No AI provider is configured yet. Add ANTHROPIC_API_KEY so this agent can use Claude directly.");
    }

    if (!upstreamResp.ok || !upstreamResp.body) {
      const err = await upstreamResp.text().catch(() => "");
      const provider = upstreamIsAnthropic ? "Anthropic" : "Gateway";
      console.error(`[agent-chat] ${provider} ${upstreamResp.status}:`, err.slice(0, 400));
      if (upstreamIsAnthropic) {
        if (upstreamResp.status === 401 || upstreamResp.status === 403) {
          return sseText("The agent is connected to Anthropic, but the API key was rejected. Update ANTHROPIC_API_KEY and try again.");
        }
        if (upstreamResp.status === 429) {
          return sseText("Anthropic is rate-limiting this agent right now. Wait a moment, then try again.");
        }
        return sseText(`Anthropic returned ${upstreamResp.status}. The agent could not complete the request yet.`);
      }
      if (upstreamResp.status === 402 || err.includes("payment_required") || err.includes("Not enough credits")) {
        return sseText("The AI gateway is out of credits, so this agent is waiting on a valid Anthropic key. Update ANTHROPIC_API_KEY so agents can use Claude directly.");
      }
      if (upstreamResp.status === 429) {
        return sseText("The AI gateway is rate-limiting this agent right now. Wait a moment, then try again.");
      }
      return sseText(`${provider} returned ${upstreamResp.status}. The agent could not complete the request yet.`);
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

    // Anthropic already emits content_block_delta SSE; gateway needs translation.
    const streamBody = upstreamIsAnthropic ? upstreamResp.body : toAnthropicStream(upstreamResp.body);
    return new Response(streamBody, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });

  } catch (e) {
    console.error("[agent-chat]", e);
    return sseText("The agent hit an unexpected runtime issue, but the chat is still stable. Try again in a moment.");
  }
});
