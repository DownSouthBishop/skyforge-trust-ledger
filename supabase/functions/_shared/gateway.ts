// Shared gateway utility for all forge edge functions.
// Provides retry with exponential backoff and centralised auth.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const GEMINI_NATIVE_BASE = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash";

// callGatewayWithRetry: Anthropic first, Google AI free-tier fallback.
// Priority: ANTHROPIC_API_KEY → GOOGLE_AI_KEY
// Falls through to Google on 402 (credits) or 429 (rate limit) from Anthropic.
// The apiKey param is ignored — keys are read from env directly.
export async function callGatewayWithRetry(
  body: Record<string, unknown>,
  _apiKey: string,
  maxRetries = 3,
): Promise<Response> {
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  const googleKey = Deno.env.get("GOOGLE_AI_KEY") ?? "";

  // 1. Try Anthropic (Haiku — fast, low-cost for background tasks)
  if (anthropicKey) {
    try {
      const msgs: any[] = [...((body.messages as any[]) ?? [])];
      const sysIdx = msgs.findIndex((m) => m.role === "system");
      let systemText = "";
      if (sysIdx >= 0) { systemText = msgs[sysIdx].content; msgs.splice(sysIdx, 1); }

      const aResp = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: (body.max_tokens as number) ?? 2000,
          ...(systemText ? { system: systemText } : {}),
          messages: msgs,
        }),
      });

      if (aResp.ok) {
        const data = await aResp.json();
        const text = data.content?.[0]?.text ?? "";
        return new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Only fall through on credit exhaustion or rate limit — hard errors return immediately
      if (aResp.status !== 402 && aResp.status !== 429 && aResp.status !== 529) return aResp;
    } catch { /* network error — fall through to Google */ }
  }

  // 2. Fall back to Google AI (native generateContent endpoint — works with AQ. key format)
  const msgs: any[] = [...((body.messages as any[]) ?? [])];
  const sysIdx2 = msgs.findIndex((m) => m.role === "system");
  let googleSystem = "";
  if (sysIdx2 >= 0) { googleSystem = msgs[sysIdx2].content; msgs.splice(sysIdx2, 1); }

  const contents = msgs.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
  }));
  const geminiBody: Record<string, unknown> = {
    contents,
    generationConfig: { maxOutputTokens: (body.max_tokens as number) ?? 2000 },
  };
  if (googleSystem) geminiBody.systemInstruction = { parts: [{ text: googleSystem }] };

  let attempt = 0;
  let lastResp: Response | null = null;
  const nativeUrl = `${GEMINI_NATIVE_BASE}:generateContent?key=${googleKey}`;

  while (attempt <= maxRetries) {
    const resp = await fetch(nativeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody),
    });

    if (resp.ok) {
      const data = await resp.json();
      const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim();
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (resp.status === 401 || resp.status === 402 || resp.status === 403) {
      return resp;
    }

    lastResp = resp.clone();
    attempt++;
    if (attempt > maxRetries) break;

    let delayMs = Math.pow(2, attempt) * 1000;

    if (resp.status === 429) {
      const retryAfter = resp.headers.get("Retry-After");
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) delayMs = seconds * 1000;
      }
    }

    await new Promise((r) => setTimeout(r, delayMs));
  }

  return lastResp!;
}

// verifyUser: validates the JWT and returns the user ID.
// Throws with a descriptive message on failure.
export async function verifyUser(
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

export class AuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AuthError";
  }
}

// parseEnv: reads a required env var, throws clearly if missing.
export function parseEnv(key: string): string {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Required env var ${key} is not set`);
  return val;
}

// modelEnv: reads a model name from env with a fallback.
export function modelEnv(envKey: string, fallback: string): string {
  return Deno.env.get(envKey) ?? fallback;
}

// resolveUserIds: when crons pass user_id="system", look up all real users.
// Returns an array of valid UUIDs to process.
export async function resolveUserIds(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<string[]> {
  if (userId !== "system") return [userId];
  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/user_profiles?select=user_id`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!resp.ok) return [];
    const rows: Array<{ user_id: string }> = await resp.json();
    return rows.map((r) => r.user_id).filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Cross-agent shared memory ────────────────────────────────────────────────
// readCrossMemory: returns a formatted string of recent cross-agent activity.
// Used by every agent to gain awareness of what Bishop has been doing elsewhere.
export async function readCrossMemory(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  limit = 8,
): Promise<string> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/agent_cross_memory?user_id=eq.${userId}&order=created_at.desc&limit=${limit}&select=source_agent,summary,topic,created_at`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!res.ok) return "";
    const rows: Array<{ source_agent: string; summary: string; topic: string | null; created_at: string }> = await res.json();
    if (!rows?.length) return "";
    return rows
      .reverse()
      .map(r => `[${r.source_agent}${r.topic ? ` · ${r.topic}` : ""}] ${r.summary}`)
      .join("\n");
  } catch {
    return "";
  }
}

// ─── Notebook material (proactive context, not a callable tool) ───────────────
// readUserNotebooks: formatted block of recent notebooks + their text-source
// content, capped so a handful of long sources can't dominate every request.
// File sources are named but not inlined here — this is static context
// injection for Mental Forge / Chamber, not the on-demand search_notebook tool.
export async function readUserNotebooks(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  notebookLimit = 3,
  sourcesPerNotebook = 5,
): Promise<string> {
  try {
    const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
    const nbRes = await fetch(
      `${supabaseUrl}/rest/v1/notebooks?user_id=eq.${userId}&order=updated_at.desc&limit=${notebookLimit}&select=id,title`,
      { headers },
    );
    if (!nbRes.ok) return "";
    const notebooks: Array<{ id: string; title: string }> = await nbRes.json();
    if (!notebooks.length) return "";

    const blocks: string[] = [];
    for (const nb of notebooks) {
      const srcRes = await fetch(
        `${supabaseUrl}/rest/v1/notebook_sources?notebook_id=eq.${nb.id}&order=created_at.desc&limit=${sourcesPerNotebook}&select=title,source_type,content_text`,
        { headers },
      );
      if (!srcRes.ok) continue;
      const sources: Array<{ title: string; source_type: string; content_text: string | null }> = await srcRes.json();
      if (!sources.length) continue;
      const lines = sources.map(s => {
        if (s.content_text) {
          const capped = s.content_text.length > 800 ? `${s.content_text.slice(0, 800).trimEnd()}…` : s.content_text;
          return `- [${s.title}] ${capped}`;
        }
        return `- [${s.title}] (file source — reference by name, full content not inlined here)`;
      });
      blocks.push(`Notebook "${nb.title}":\n${lines.join("\n")}`);
    }
    if (!blocks.length) return "";
    return `NOTEBOOK MATERIAL (the operator's saved research — reference naturally when relevant, don't announce it as a list):\n${blocks.join("\n\n")}`;
  } catch {
    return "";
  }
}

// ─── Agent skills roster ───────────────────────────────────────────────────
// readAgentSkillsRoster: compact list (name + description) of skills the
// operator has toggled on for this specific agent. This alone shapes how the
// agent communicates (it's in every system prompt); the full skill content
// is only pulled in on demand via the use_skill tool, not injected here.
export async function readAgentSkillsRoster(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  agentSlug: string,
): Promise<string> {
  try {
    const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
    const res = await fetch(
      `${supabaseUrl}/rest/v1/agent_skills?user_id=eq.${userId}&agent_slug=eq.${agentSlug}&enabled=eq.true&select=skill_name,description`,
      { headers },
    );
    if (!res.ok) return "";
    const rows: Array<{ skill_name: string; description: string }> = await res.json();
    if (!rows.length) return "";
    const lines = rows.map(r => `- ${r.skill_name}: ${r.description.slice(0, 200)}`);
    return `ACTIVE SKILLS (the operator has connected these to you — let them genuinely shape how you approach relevant work; call use_skill(skill_name) for the full playbook when one is actually relevant to what you're doing):\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

export async function useSkillTool(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  agentSlug: string,
  skillName: string,
): Promise<string> {
  try {
    const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
    const res = await fetch(
      `${supabaseUrl}/rest/v1/agent_skills?user_id=eq.${userId}&agent_slug=eq.${agentSlug}&enabled=eq.true&skill_name=eq.${encodeURIComponent(skillName)}&select=content&limit=1`,
      { headers },
    );
    if (!res.ok) return "Could not look up that skill.";
    const rows: Array<{ content: string }> = await res.json();
    if (!rows.length) return `"${skillName}" isn't currently connected and enabled for you. Only skills the operator has toggled on for you are usable.`;
    return rows[0].content;
  } catch (e) {
    return `Skill lookup failed: ${(e as Error).message}`;
  }
}

// ─── Shared conversation history (across all mediums + agents) ────────────────
// readSharedHistory: returns a formatted block of the most recent turns from
// every conversation surface (Mental Forge, Atlas chat, per-agent chats).
// Backed by the public.agent_unified_history view.
export async function readSharedHistory(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  limit = 20,
): Promise<string> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/agent_unified_history?user_id=eq.${userId}&order=created_at.desc&limit=${limit}&select=medium,agent_slug,role,content,created_at`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!res.ok) return "";
    const rows: Array<{ medium: string; agent_slug: string; role: string; content: string; created_at: string }> = await res.json();
    if (!rows?.length) return "";
    return rows
      .reverse()
      .map(r => {
        const who = r.role === "user" ? "Operator" : (r.agent_slug || "agent");
        const snippet = (r.content ?? "").toString().replace(/\s+/g, " ").slice(0, 240);
        return `[${r.medium}] ${who}: ${snippet}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

// readSharedKnowledge: persistent facts written by any agent, visible to all.
export async function readSharedKnowledge(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  limit = 30,
): Promise<string> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/agent_shared_knowledge?user_id=eq.${userId}&order=updated_at.desc&limit=${limit}&select=source_agent,topic,fact,importance`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!res.ok) return "";
    const rows: Array<{ source_agent: string; topic: string | null; fact: string; importance: number }> = await res.json();
    if (!rows?.length) return "";
    return rows
      .map(r => `- [${r.source_agent}${r.topic ? ` · ${r.topic}` : ""}] ${r.fact}`)
      .join("\n");
  } catch {
    return "";
  }
}

// writeSharedKnowledge: fire-and-forget persist a fact any agent can later read.
export function writeSharedKnowledge(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  sourceAgent: string,
  fact: string,
  topic?: string,
  importance = 0.5,
): void {
  fetch(`${supabaseUrl}/rest/v1/agent_shared_knowledge`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ user_id: userId, source_agent: sourceAgent, fact, topic: topic ?? null, importance }),
  }).catch(() => {});
}

export async function readMcpServers(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<Array<{ type: string; url: string; name: string; authorization_token?: string }>> {
  const servers: Array<{ type: string; url: string; name: string; authorization_token?: string }> = [];
  const funcBase = supabaseUrl + "/functions/v1";
  const oandaKey = Deno.env.get("OANDA_API_KEY");
  const alpacaKey = Deno.env.get("ALPACA_API_KEY");
  if (oandaKey) servers.push({ type: "url", url: `${funcBase}/mcp-oanda`, name: "oanda" });
  if (alpacaKey) servers.push({ type: "url", url: `${funcBase}/mcp-alpaca`, name: "alpaca" });
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/atlas_mcp_connections?user_id=eq.${userId}&is_active=eq.true&is_verified=eq.true&transport=eq.sse&url=not.is.null&select=slug,url,env_vars`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (res.ok) {
      const rows: Array<{ slug: string; url: string; env_vars: Record<string,string> | null }> = await res.json();
      for (const row of (rows ?? [])) {
        if (!row.url) continue;
        const token = row.env_vars ? (row.env_vars["GOOGLE_OAUTH_TOKEN"] ?? row.env_vars["AIRTABLE_API_KEY"] ?? row.env_vars["NOTION_API_KEY"] ?? row.env_vars["LINEAR_API_KEY"] ?? row.env_vars["ASANA_TOKEN"] ?? Object.values(row.env_vars)[0] ?? undefined) : undefined;
        const entry: { type: string; url: string; name: string; authorization_token?: string } = { type: "url", url: row.url, name: row.slug };
        if (token) entry.authorization_token = token;
        servers.push(entry);
      }
    }
  } catch {}
  return servers;
}

// writeCrossMemory: fire-and-forget — logs what this agent just did so other
// agents can reference it. Self-heals: if the table doesn't exist yet it creates
// it on first write, then retries. Never blocks or throws.
export function writeCrossMemory(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  sourceAgent: string,
  summary: string,
  topic?: string,
): void {
  const hdrs = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };
  const body = JSON.stringify({ user_id: userId, source_agent: sourceAgent, summary, topic: topic ?? null });

  (async () => {
    const res = await fetch(`${supabaseUrl}/rest/v1/agent_cross_memory`, {
      method: "POST", headers: hdrs, body,
    });
    if (res.status === 404 || res.status === 400) {
      const text = await res.text().catch(() => "");
      if (text.includes("does not exist") || text.includes("42P01") || text.includes("not found")) {
        await _bootstrapCrossMemoryTable();
        await fetch(`${supabaseUrl}/rest/v1/agent_cross_memory`, {
          method: "POST", headers: hdrs, body,
        }).catch(() => {});
      }
    }
  })().catch(() => {});
}

async function _bootstrapCrossMemoryTable(): Promise<void> {
  try {
    const dbUrl = (Deno as any).env.get("SUPABASE_DB_URL");
    if (!dbUrl) return;
    const { Client } = await import("https://deno.land/x/postgres@v0.17.0/mod.ts");
    const client = new Client(dbUrl);
    await client.connect();
    await client.queryArray(`
      CREATE TABLE IF NOT EXISTS public.agent_cross_memory (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        source_agent text NOT NULL,
        summary text NOT NULL,
        topic text,
        created_at timestamptz DEFAULT now()
      )
    `);
    await client.queryArray(`
      CREATE INDEX IF NOT EXISTS idx_cross_memory_user_time
        ON public.agent_cross_memory (user_id, created_at DESC)
    `);
    await client.queryArray(`ALTER TABLE public.agent_cross_memory ENABLE ROW LEVEL SECURITY`);
    await client.queryArray(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agent_cross_memory' AND policyname='Users manage own cross memory') THEN
          CREATE POLICY "Users manage own cross memory" ON public.agent_cross_memory FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
        END IF;
      END $$
    `).catch(() => {});
    await client.queryArray(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agent_cross_memory' AND policyname='Service role manages cross memory') THEN
          CREATE POLICY "Service role manages cross memory" ON public.agent_cross_memory FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
        END IF;
      END $$
    `).catch(() => {});
    await client.end();
  } catch { /* silently fail — writes just won't persist until next call */ }
}

// oandaBaseUrl: returns the correct OANDA REST endpoint based on OANDA_ENV.
export function oandaBaseUrl(): string {
  const env = Deno.env.get("OANDA_ENV") ?? "practice";
  return env === "live"
    ? "https://api-fxtrade.oanda.com"
    : "https://api-fxpractice.oanda.com";
}
