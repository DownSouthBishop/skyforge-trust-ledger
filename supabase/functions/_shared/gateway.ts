// Shared gateway utility for all forge edge functions.
// Provides retry with exponential backoff and centralised auth.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

// callGatewayWithRetry: retries on 429/5xx with exponential backoff.
// On 429 it respects the Retry-After header when present.
export async function callGatewayWithRetry(
  body: Record<string, unknown>,
  apiKey: string,
  maxRetries = 3,
): Promise<Response> {
  let attempt = 0;
  let lastResp: Response | null = null;

  while (attempt <= maxRetries) {
    const resp = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (resp.ok) return resp;

    // Don't retry auth failures — they won't resolve
    if (resp.status === 401 || resp.status === 402 || resp.status === 403) {
      return resp;
    }

    lastResp = resp.clone();
    attempt++;
    if (attempt > maxRetries) break;

    let delayMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s

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
