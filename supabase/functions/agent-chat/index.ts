// agent-chat — self-contained, no shared imports
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

class AuthError extends Error {
  constructor(msg: string) { super(msg); this.name = "AuthError"; }
}

function parseEnv(key: string): string {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Required env var ${key} is not set`);
  return val;
}

async function verifyUser(supabaseUrl: string, serviceKey: string, authHeader: string | null): Promise<string> {
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

async function readSharedHistory(supabaseUrl: string, serviceKey: string, userId: string, limit = 20): Promise<string> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/agent_unified_history?user_id=eq.${userId}&order=created_at.desc&limit=${limit}&select=medium,agent_slug,role,content,created_at`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!res.ok) return "";
    const rows: Array<{ medium: string; agent_slug: string; role: string; content: string; created_at: string }> = await res.json();
    if (!rows?.length) return "";
    return rows.reverse().map(r => {
      const who = r.role === "user" ? "Operator" : (r.agent_slug || "agent");
      const snippet = (r.content ?? "").toString().replace(/\s+/g, " ").slice(0, 240);
      return `[${r.medium}] ${who}: ${snippet}`;
    }).join("\n");
  } catch { return ""; }
}

async function readSharedKnowledge(supabaseUrl: string, serviceKey: string, userId: string, limit = 30): Promise<string> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/agent_shared_knowledge?user_id=eq.${userId}&order=updated_at.desc&limit=${limit}&select=source_agent,topic,fact,importance`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!res.ok) return "";
    const rows: Array<{ source_agent: string; topic: string | null; fact: string; importance: number }> = await res.json();
    if (!rows?.length) return "";
    return rows.map(r => `- [${r.source_agent}${r.topic ? ` · ${r.topic}` : ""}] ${r.fact}`).join("\n");
  } catch { return ""; }
}

async function readCrossMemory(supabaseUrl: string, serviceKey: string, userId: string, limit = 12): Promise<string> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/agent_cross_memory?user_id=eq.${userId}&order=created_at.desc&limit=${limit}&select=source_agent,summary,topic,created_at`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!res.ok) return "";
    const rows: Array<{ source_agent: string; summary: string; topic: string | null }> = await res.json();
    if (!rows?.length) return "";
    return rows.reverse().map(r => `[${r.source_agent}${r.topic ? ` · ${r.topic}` : ""}] ${r.summary}`).join("\n");
  } catch { return ""; }
}

function writeCrossMemory(supabaseUrl: string, serviceKey: string, userId: string, sourceAgent: string, summary: string, topic?: string): void {
  fetch(`${supabaseUrl}/rest/v1/agent_cross_memory`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ user_id: userId, source_agent: sourceAgent, summary, topic: topic ?? null }),
  }).catch(() => {});
}

/** Call Gemini text-embedding-004 and return 768-dim float array, or null on failure */
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

const ANTHROPIC_DEFAULT = "claude-sonnet-4-6";
const KNOWN_ANTHROPIC = new Set([
  "claude-sonnet-4-6", "claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001",
  "claude-opus-4-8", "claude-opus-4-20250514", "claude-fable-5",
]);

function resolveAnthropicModel(agentModel?: string): string | null {
  if (!agentModel) return ANTHROPIC_DEFAULT;
  let m = agentModel.trim();
  if (m.startsWith("anthropic/")) m = m.slice("anthropic/".length);
  if (KNOWN_ANTHROPIC.has(m)) return m;
  return ANTHROPIC_DEFAULT;
}

function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : "")).filter(Boolean).join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

// ── Headroom-style context compression ────────────────────────────────────────
// Truncates oversized individual messages and drops middle messages when the
// conversation is very long. Same answers, fraction of the token bill.
function compressMessages(
  msgs: Array<{ role: string; content: unknown }>,
): Array<{ role: string; content: unknown }> {
  const MAX_MSG_CHARS = 2500;
  const MAX_MSGS = 18;

  const truncated = msgs.map(m => {
    const text = flatten(m.content);
    if (text.length > MAX_MSG_CHARS) {
      return { ...m, content: text.slice(0, MAX_MSG_CHARS) + "\n[...truncated for context efficiency]" };
    }
    return m;
  });

  if (truncated.length <= MAX_MSGS) return truncated;

  // Keep first 2 and last 14, insert a summary placeholder in the gap
  const head = truncated.slice(0, 2);
  const tail = truncated.slice(-(MAX_MSGS - 3));
  const dropped = truncated.length - head.length - tail.length;
  const bridge = { role: "user", content: `[${dropped} earlier messages omitted]` };
  return [...head, bridge, ...tail];
}

// ── Built-in tools — available to every agent ─────────────────────────────────
const BUILT_IN_TOOLS = [
  {
    name: "web_scrape",
    description: "Fetch and read the full content of any URL. Returns clean markdown text from the page. Use for articles, documentation, live pricing, competitor pages, or any content that exists at a specific URL.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full URL to read (including https://)" },
      },
      required: ["url"],
    },
  },
  {
    name: "web_research",
    description: "Search the web for current information on any topic using Google Search grounding. Returns a grounded, synthesized summary. Best for recent news, market data, model releases, platform changes, or anything that may have changed since training.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to research — be specific for better results" },
      },
      required: ["query"],
    },
  },
  {
    name: "recall_memory",
    description: "Search long-term semantic memory for information related to a query. Retrieves the most relevant memories, past decisions, operator preferences, and accumulated knowledge from all prior sessions across all agents.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search memory for" },
      },
      required: ["query"],
    },
  },
  {
    name: "store_memory",
    description: "Commit important information to long-term memory so it is available in future sessions for all agents. Use after significant decisions, insights, operator instructions, or things worth remembering.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "What to remember" },
        topic: { type: "string", description: "Category tag (e.g. 'market_insight', 'operator_preference', 'decision')" },
      },
      required: ["content", "topic"],
    },
  },
  {
    name: "create_dossier_entry",
    description: "Write something real into the operator's Dossier. Use this whenever the operator asks you to add anything to their schedule, calendar, task list, or to-do list. NEVER say you have added something without calling this tool first — it must actually write to the database. Two modes: 'event' for calendar/schedule items (appointments, errands, personal plans); 'task' for project work tied to a goal. Default to 'event' for personal day-to-day items.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What it is (e.g. 'Go to the mall', 'Call the accountant')" },
        entry_type: { type: "string", description: "'event' for calendar/schedule items, 'task' for goal-linked project work", enum: ["event", "task"] },
        date: { type: "string", description: "YYYY-MM-DD. Required for events. Calculate actual date for relative terms like 'tomorrow' or 'next Friday'." },
        importance: { type: "string", description: "high, medium, or low", enum: ["high", "medium", "low"] },
        notes: { type: "string", description: "Optional context or notes" },
        goal_title: { type: "string", description: "For tasks only — which goal this belongs to. Leave blank to use the Personal goal." },
      },
      required: ["title", "entry_type"],
    },
  },
  {
    name: "log_spend",
    description: "Log a real financial transaction — expense or income — directly into the operator's Spend Tracker. Updates the account balance immediately. Use when the operator mentions spending money, receiving money, or asks you to record a transaction. NEVER say you have logged it without calling this tool.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "string", description: "Dollar amount as a number (e.g. '42.50')" },
        flow: { type: "string", description: "'out' for an expense/spend, 'in' for income or money received", enum: ["out", "in"] },
        category: { type: "string", description: "One of: Food, Transport, Business, Housing, Health, Entertainment, Other", enum: ["Food", "Transport", "Business", "Housing", "Health", "Entertainment", "Other"] },
        account_name: { type: "string", description: "Name of the account to log against. Leave blank to use the first available account." },
        note: { type: "string", description: "Optional description of what the transaction was for" },
        date: { type: "string", description: "YYYY-MM-DD. Defaults to today if not specified." },
      },
      required: ["amount", "flow", "category"],
    },
  },
] as const;

interface ToolOpts {
  supabaseUrl: string;
  serviceKey: string;
  userId: string;
  agentSlug: string;
  googleKey: string;
}

async function executeTool(name: string, input: Record<string, string>, opts: ToolOpts): Promise<string> {
  try {
    if (name === "web_scrape") {
      const url = input.url ?? "";
      if (!url) return "No URL provided.";
      const resp = await fetch(`https://r.jina.ai/${url}`, {
        headers: { "Accept": "text/plain", "X-Return-Format": "markdown" },
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok) return `Failed to read ${url}: HTTP ${resp.status}`;
      const text = await resp.text();
      return text.slice(0, 8000) || "Page returned no content.";
    }

    if (name === "web_research") {
      const query = input.query ?? "";
      if (!query) return "No query provided.";
      if (!opts.googleKey) return "Google AI key not configured — web research unavailable.";
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${opts.googleKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: `Research this thoroughly and provide a detailed, current, grounded summary with key facts and sources: ${query}` }] }],
            tools: [{ googleSearch: {} }],
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!resp.ok) return `Web research failed: HTTP ${resp.status}`;
      const data = await resp.json();
      const text = (data?.candidates?.[0]?.content?.parts ?? [])
        .map((p: { text?: string }) => p.text ?? "").join("\n").trim();
      return text.slice(0, 6000) || "No results found for that query.";
    }

    if (name === "recall_memory") {
      const query = input.query ?? "";
      if (!query) return "No query provided.";

      // Try semantic search first
      if (opts.googleKey) {
        const emb = await getEmbedding(query, opts.googleKey);
        if (emb) {
          const rpc = await fetch(`${opts.supabaseUrl}/rest/v1/rpc/match_cross_memory`, {
            method: "POST",
            headers: { apikey: opts.serviceKey, Authorization: `Bearer ${opts.serviceKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ query_embedding: emb, p_user_id: opts.userId, match_count: 10 }),
          });
          if (rpc.ok) {
            const rows: Array<{ source_agent: string; summary: string; topic: string | null; similarity: number }> = await rpc.json();
            if (rows?.length) {
              return rows.map(r =>
                `[${r.source_agent}${r.topic ? ` · ${r.topic}` : ""}] ${r.summary}`
              ).join("\n");
            }
          }
        }
      }

      // Fallback: recency sort
      const res = await fetch(
        `${opts.supabaseUrl}/rest/v1/agent_cross_memory?user_id=eq.${opts.userId}&order=created_at.desc&limit=12&select=source_agent,summary,topic`,
        { headers: { apikey: opts.serviceKey, Authorization: `Bearer ${opts.serviceKey}` } },
      );
      if (!res.ok) return "Memory recall unavailable.";
      const rows: Array<{ source_agent: string; summary: string; topic: string | null }> = await res.json();
      if (!rows?.length) return "No memories found.";
      return rows.map(r => `[${r.source_agent}${r.topic ? ` · ${r.topic}` : ""}] ${r.summary}`).join("\n");
    }

    if (name === "store_memory") {
      const content = input.content ?? "";
      const topic = input.topic ?? "general";
      if (!content) return "Nothing to store.";
      writeCrossMemory(opts.supabaseUrl, opts.serviceKey, opts.userId, opts.agentSlug, content, topic);
      return `Stored in memory under topic: ${topic}`;
    }

    if (name === "create_dossier_entry") {
      const title = input.title ?? "";
      if (!title) return "Title is required.";
      const entryType = input.entry_type ?? "event";
      const date = input.date ?? null;
      const importance = (input.importance ?? "medium") as string;
      const notes = input.notes ?? null;
      const goalTitle = input.goal_title ?? null;

      const hdrs = {
        apikey: opts.serviceKey,
        Authorization: `Bearer ${opts.serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      };
      const getHdrs = { apikey: opts.serviceKey, Authorization: `Bearer ${opts.serviceKey}` };

      // ── Event / calendar item → journal_entries ───────────────────────────
      if (entryType === "event") {
        const entryDate = date ?? new Date().toISOString().slice(0, 10);
        const res = await fetch(`${opts.supabaseUrl}/rest/v1/journal_entries`, {
          method: "POST",
          headers: hdrs,
          body: JSON.stringify({ user_id: opts.userId, date: entryDate, title, context: notes, importance }),
        });
        if (!res.ok) {
          const err = await res.text();
          return `Failed to add calendar entry: ${err.slice(0, 200)}`;
        }
        return `Added to your Dossier calendar: "${title}" on ${entryDate}.`;
      }

      // ── Task → goals → objectives → tasks chain ───────────────────────────
      // 1. Find or create the goal
      let goalId: string | null = null;
      const goalSearch = goalTitle ?? "Personal";
      const gRes = await fetch(
        `${opts.supabaseUrl}/rest/v1/goals?user_id=eq.${opts.userId}&title=ilike.${encodeURIComponent("*" + goalSearch + "*")}&limit=1&select=id`,
        { headers: getHdrs },
      );
      if (gRes.ok) { const gr: Array<{ id: string }> = await gRes.json(); goalId = gr[0]?.id ?? null; }

      if (!goalId) {
        const gIns = await fetch(`${opts.supabaseUrl}/rest/v1/goals`, {
          method: "POST",
          headers: hdrs,
          body: JSON.stringify({ user_id: opts.userId, title: goalSearch === "Personal" ? "Personal" : goalSearch, context: "Agent-created goal", importance, status: "active" }),
        });
        if (gIns.ok) { const gNew: Array<{ id: string }> = await gIns.json(); goalId = gNew[0]?.id ?? null; }
      }
      if (!goalId) return `Could not find or create goal. Try creating it manually in the Dossier first.`;

      // 2. Find or create an objective under that goal
      let objectiveId: string | null = null;
      let objectiveLetter = "A";
      const oRes = await fetch(
        `${opts.supabaseUrl}/rest/v1/objectives?user_id=eq.${opts.userId}&goal_id=eq.${goalId}&limit=20&select=id,letter`,
        { headers: getHdrs },
      );
      if (oRes.ok) {
        const oRows: Array<{ id: string; letter: string }> = await oRes.json();
        if (oRows.length) {
          objectiveId = oRows[0].id;
          objectiveLetter = oRows[0].letter;
        } else {
          // Create first objective for this goal
          const oIns = await fetch(`${opts.supabaseUrl}/rest/v1/objectives`, {
            method: "POST",
            headers: hdrs,
            body: JSON.stringify({ user_id: opts.userId, goal_id: goalId, title: "General", letter: "A", status: "active" }),
          });
          if (oIns.ok) { const oNew: Array<{ id: string }> = await oIns.json(); objectiveId = oNew[0]?.id ?? null; }
        }
      }
      if (!objectiveId) return `Could not create objective under goal. Try adding it manually in the Dossier.`;

      // 3. Count existing tasks under this objective to generate code
      const tCountRes = await fetch(
        `${opts.supabaseUrl}/rest/v1/tasks?user_id=eq.${opts.userId}&objective_id=eq.${objectiveId}&select=id`,
        { headers: getHdrs },
      );
      let taskCount = 0;
      if (tCountRes.ok) { const tc: Array<{ id: string }> = await tCountRes.json(); taskCount = tc.length; }
      const code = `${objectiveLetter}${taskCount + 1}`;

      // 4. Insert the task
      const tRes = await fetch(`${opts.supabaseUrl}/rest/v1/tasks`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({
          user_id: opts.userId,
          objective_id: objectiveId,
          title,
          code,
          context: notes,
          importance,
          status: "pending",
          due_date: date ?? null,
        }),
      });
      if (!tRes.ok) {
        const err = await tRes.text();
        return `Failed to create task: ${err.slice(0, 200)}`;
      }
      return `Task added to Dossier: "${title}" [${code}]${date ? ` due ${date}` : ""} under goal "${goalSearch}".`;
    }

    if (name === "log_spend") {
      const amt = parseFloat(input.amount ?? "0");
      if (!amt || amt <= 0) return "Invalid amount.";
      const flow = input.flow === "in" ? "in" : "out";
      const category = input.category ?? "Other";
      const note = input.note ?? null;
      const date = input.date ?? new Date().toISOString().slice(0, 10);
      const accountName = input.account_name ?? null;
      const hdrs = { apikey: opts.serviceKey, Authorization: `Bearer ${opts.serviceKey}`, "Content-Type": "application/json", Prefer: "return=representation" };
      const getHdrs = { apikey: opts.serviceKey, Authorization: `Bearer ${opts.serviceKey}` };

      // Find the account
      let accountId: string | null = null;
      let currentBalance: number = 0;
      const accQuery = accountName
        ? `${opts.supabaseUrl}/rest/v1/financial_accounts?user_id=eq.${opts.userId}&name=ilike.${encodeURIComponent("*" + accountName + "*")}&limit=1&select=id,balance`
        : `${opts.supabaseUrl}/rest/v1/financial_accounts?user_id=eq.${opts.userId}&order=created_at.asc&limit=1&select=id,balance`;
      const accRes = await fetch(accQuery, { headers: getHdrs });
      if (accRes.ok) {
        const rows: Array<{ id: string; balance: number }> = await accRes.json();
        if (rows[0]) { accountId = rows[0].id; currentBalance = Number(rows[0].balance || 0); }
      }

      // Insert transaction
      const txRes = await fetch(`${opts.supabaseUrl}/rest/v1/spend_transactions`, {
        method: "POST", headers: hdrs,
        body: JSON.stringify({ user_id: opts.userId, account_id: accountId, amount: amt, category, note, date, flow }),
      });
      if (!txRes.ok) { const e = await txRes.text(); return `Failed to log transaction: ${e.slice(0, 200)}`; }

      // Update account balance
      if (accountId) {
        const newBalance = flow === "out" ? currentBalance - amt : currentBalance + amt;
        await fetch(`${opts.supabaseUrl}/rest/v1/financial_accounts?id=eq.${accountId}`, {
          method: "PATCH", headers: hdrs,
          body: JSON.stringify({ balance: newBalance, updated_at: new Date().toISOString() }),
        });
      }

      return `Logged: ${flow === "in" ? "+" : "-"}$${amt.toFixed(2)} · ${category}${note ? ` · ${note}` : ""} · ${date}${accountId ? "" : " (no account matched — transaction recorded without account link)"}.`;
    }

    return `Unknown tool: ${name}`;
  } catch (e) {
    return `Tool error (${name}): ${String(e)}`;
  }
}

// ── Anthropic with built-in tools (non-streaming) ─────────────────────────────
// Used when no external MCP servers are active. Runs up to 5 tool rounds
// then returns the final text. Caller wraps in sseText().
async function callAnthropicWithTools(opts: {
  apiKey: string;
  model: string;
  system: string;
  messages: Array<{ role: string; content: unknown }>;
  maxTokens: number;
  toolOpts: ToolOpts;
}): Promise<{ text: string; status?: number; errorBody?: string }> {
  const cleanMessages = opts.messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => ({ role: m.role, content: flatten(m.content) }))
    .filter(m => m.content);
  if (cleanMessages.length === 0) cleanMessages.push({ role: "user", content: "[Session opened.]" });

  let convo: Array<{ role: string; content: unknown }> = [...cleanMessages];
  const MAX_ROUNDS = 5;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
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
        messages: convo,
        tools: BUILT_IN_TOOLS,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { text: "", status: resp.status, errorBody: body };
    }

    const data = await resp.json();
    const stopReason: string = data.stop_reason ?? "end_turn";
    const contentBlocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, string> }> = data.content ?? [];

    if (stopReason !== "tool_use") {
      const text = contentBlocks
        .filter(b => b.type === "text")
        .map(b => b.text ?? "")
        .join("\n")
        .trim();
      return { text };
    }

    // Execute tool calls in parallel
    const toolUses = contentBlocks.filter(b => b.type === "tool_use");
    const toolResults = await Promise.all(
      toolUses.map(async tu => ({
        type: "tool_result" as const,
        tool_use_id: tu.id!,
        content: await executeTool(tu.name!, tu.input ?? {}, opts.toolOpts),
      })),
    );

    convo = [
      ...convo,
      { role: "assistant", content: contentBlocks },
      { role: "user", content: toolResults },
    ];
  }

  return { text: "I exhausted the tool execution limit. Please try a more specific request." };
}

// ── Streaming Anthropic (MCP servers path) ────────────────────────────────────
async function callAnthropic(opts: {
  apiKey: string; model: string; system: string;
  messages: Array<{ role: string; content: unknown }>;
  maxTokens: number;
  mcpServers?: Array<{ type: string; url: string; name: string; authorization_token?: string }>;
}): Promise<Response> {
  const cleanMessages = opts.messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => ({ role: m.role, content: flatten(m.content) }))
    .filter(m => m.content);
  if (cleanMessages.length === 0) cleanMessages.push({ role: "user", content: "[Session opened.]" });
  const betaHeader = opts.mcpServers?.length ? "mcp-client-2025-04-04" : undefined;
  return await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
      ...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model, max_tokens: opts.maxTokens, system: opts.system, messages: cleanMessages, stream: true,
      ...(opts.mcpServers?.length ? { mcp_servers: opts.mcpServers } : {}),
    }),
  });
}

function dbHeaders(key: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
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
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(encoder.encode(events), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

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
              if (text) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`));
            } catch { /* skip */ }
          }
        }
      } finally { reader.releaseLock(); controller.close(); }
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const GOOGLE_KEY = Deno.env.get("GOOGLE_AI_KEY") ?? "";

    let userId: string;
    try {
      userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    } catch (e) {
      if (e instanceof AuthError) {
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

    const agents = (await dbGet(agentQuery, SERVICE_KEY)) as Array<{ id: string; user_id: string; name: string; system_prompt: string; model?: string }>;
    if (!agents.length) return json({ error: `Agent '${agentSlug}' not found` }, 404);
    const agent = agents[0];
    const sessionUserId = userId === "system" ? agent.user_id : userId;

    const lastUserContent = typeof messages.at(-1)?.content === "string" ? (messages.at(-1)!.content as string) : "";

    // Parallel context fetches
    const [sharedHistory, sharedKnowledge, crossMemory, shared] = await Promise.all([
      readSharedHistory(SUPABASE_URL, SERVICE_KEY, sessionUserId, 20),
      readSharedKnowledge(SUPABASE_URL, SERVICE_KEY, sessionUserId, 30),
      (async (): Promise<string> => {
        if (GOOGLE_KEY && lastUserContent) {
          try {
            const emb = await getEmbedding(lastUserContent, GOOGLE_KEY);
            if (emb) {
              const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_cross_memory`, {
                method: "POST",
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ query_embedding: emb, p_user_id: sessionUserId, match_count: 10 }),
              });
              if (rpc.ok) {
                const rows: Array<{ source_agent: string; summary: string; topic: string | null; similarity: number }> = await rpc.json();
                if (rows?.length) return rows.map(r => `[${r.source_agent}${r.topic ? ` · ${r.topic}` : ""}] ${r.summary}`).join("\n");
              }
            }
          } catch { /* fall through */ }
        }
        return readCrossMemory(SUPABASE_URL, SERVICE_KEY, sessionUserId, 12);
      })(),
      (async (): Promise<Array<{ memory_type: string; key: string; value: string; source_agent: string; updated_at: string }>> => {
        if (GOOGLE_KEY && lastUserContent) {
          try {
            const emb = await getEmbedding(lastUserContent, GOOGLE_KEY);
            if (emb) {
              const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_memories`, {
                method: "POST",
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ query_embedding: emb, p_user_id: sessionUserId, match_count: 15 }),
              });
              if (rpc.ok) {
                const rows = await rpc.json();
                if (Array.isArray(rows) && rows.length) return rows;
              }
            }
          } catch { /* fall through */ }
        }
        return (await dbGet(
          `${SUPABASE_URL}/rest/v1/shared_operator_memory?user_id=eq.${sessionUserId}&order=updated_at.desc&limit=40&select=memory_type,key,value,source_agent,updated_at`,
          SERVICE_KEY,
        )) as Array<{ memory_type: string; key: string; value: string; source_agent: string; updated_at: string }>;
      })(),
    ]);

    const grouped: Record<string, string[]> = {};
    for (const m of shared) { (grouped[m.memory_type] ||= []).push(`- ${m.value}`); }

    const standingDirective = "\n\nSTANDING DIRECTIVE:\nYou are speaking with someone whose patterns you know deeply. Use what you know to meet them where they are — match their communication style, respect their preferences — but always, subtly and naturally, orient every response toward their growth and forward momentum. Never let comfort become stagnation. Push gently, always.";
    const knownBlock = standingDirective + (shared.length === 0 ? "" : "\n\nWHAT I KNOW ABOUT YOU:\n" + Object.entries(grouped).map(([t, lines]) => `${t.toUpperCase()}\n${lines.slice(0, 10).join("\n")}`).join("\n\n"));

    const otherSlug = agentSlug === "atlas" ? "janus" : agentSlug === "janus" ? "atlas" : null;
    let otherBlock = "";
    if (otherSlug) {
      const otherMems = shared.filter(m => m.source_agent === otherSlug).slice(0, 10);
      if (otherMems.length) {
        otherBlock = "\n\nWHAT THE OTHER AGENT KNOWS (recent observations, factor in silently — do not attribute):\n" + otherMems.map(m => `- [${m.memory_type}] ${m.value}`).join("\n");
      }
    }

    const memories = (await dbGet(
      `${SUPABASE_URL}/rest/v1/agent_memory?agent_id=eq.${agent.id}&order=confidence.desc&limit=10&select=memory_type,key,value,confidence`,
      SERVICE_KEY,
    )) as Array<{ memory_type: string; key: string; value: string; confidence: number }>;
    const legacyBlock = memories.length > 0 ? "\n\nADDITIONAL CONTEXT FROM PAST SESSIONS:\n" + memories.map(m => `- [${m.memory_type}] ${m.value}`).join("\n") : "";

    const mcps = (await dbGet(
      `${SUPABASE_URL}/rest/v1/atlas_mcp_connections?user_id=eq.${sessionUserId}&is_active=eq.true&is_verified=eq.true&select=name,slug,capabilities,notes,category`,
      SERVICE_KEY,
    )) as Array<{ name: string; slug: string; capabilities: Array<{ name: string }>; notes: string | null }>;
    const toolsBlock = mcps.length === 0 ? "" : "\n\nCONNECTED TOOLS (use freely without asking or announcing):\n" +
      mcps.map(m => {
        const toolNames = (m.capabilities ?? []).map(c => c.name).filter(Boolean).join(", ");
        const cat = (m as any).category ? ` [${(m as any).category}]` : "";
        const tail = toolNames ? `tools: ${toolNames}` : (m.notes ?? "configured");
        return `- ${m.name}${cat} (${m.slug}): ${tail}`;
      }).join("\n");

    const connectedSlugSet = new Set(mcps.map(m => m.slug));
    const directory = (await dbGet(
      `${SUPABASE_URL}/rest/v1/mcp_directory?select=name,slug,category,description,is_featured&order=is_featured.desc,name.asc`,
      SERVICE_KEY,
    )) as Array<{ name: string; slug: string; category: string | null; description: string | null; is_featured: boolean }>;
    const available = directory.filter(d => !connectedSlugSet.has(d.slug));
    const dirByCat: Record<string, string[]> = {};
    for (const d of available) { const cat = d.category ?? "Other"; (dirByCat[cat] ||= []).push(d.name); }
    const directoryBlock = available.length === 0 ? "" : "\n\nAVAILABLE TOOLS THE OPERATOR CAN CONNECT (mention only if useful; do not push):\n" +
      Object.entries(dirByCat).map(([cat, names]) => `- ${cat}: ${names.join(", ")}`).join("\n") +
      "\nOperator connects these from Profile → MCP Connections.";

    const prefs = (await dbGet(
      `${SUPABASE_URL}/rest/v1/atlas_preferences?user_id=eq.${sessionUserId}&select=claude_code_config,cowork_config&limit=1`,
      SERVICE_KEY,
    )) as Array<{ claude_code_config: any; cowork_config: any }>;
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
    const guardrail = "\n\nNever mention memory, storage, records, or that you 'remember' things from a system. Just know what you know, the way a person who has been paying attention would." +
      "\n\nEPISTEMIC DISCIPLINE: Signal confidence when uncertain. HIGH confidence (>85%) — state directly. MEDIUM (50-85%) — \"I believe...\" or \"Based on what I know...\". LOW (<50%) — flag explicitly. Never confabulate. Uncertainty is information." +
      "\n\nBUILT-IN TOOLS: You have web_scrape (read any URL), web_research (Google-grounded search), recall_memory (semantic memory search), and store_memory available. Use them naturally without announcing it. Just do it.";

    const sharedKnowledgeBlock = sharedKnowledge ? `\n\nSHARED KNOWLEDGE BASE (facts any agent has logged — treat as your own knowledge):\n${sharedKnowledge}` : "";
    const sharedHistoryBlock = sharedHistory ? `\n\nSHARED CONVERSATION HISTORY (recent turns across all surfaces — never mention this list):\n${sharedHistory}` : "";
    const crossMemoryBlock = crossMemory ? `\n\nCROSS-AGENT MEMORY (what has happened with all agents recently — you know this natively, never cite the list directly):\n${crossMemory}` : "";

    const financialSnapshot = (await dbGet(
      `${SUPABASE_URL}/rest/v1/shared_operator_memory?user_id=eq.${sessionUserId}&memory_type=eq.financial_snapshot&limit=1&select=value`,
      SERVICE_KEY,
    )) as Array<{ value: string }>;
    const financialBlock = financialSnapshot[0] ? `\n\nOPERATOR FINANCIAL SNAPSHOT:\n${financialSnapshot[0].value}` : "";

    const [finAccounts, recentSpend] = await Promise.all([
      dbGet(`${SUPABASE_URL}/rest/v1/financial_accounts?user_id=eq.${sessionUserId}&select=name,type,balance,limit_amount&order=type`, SERVICE_KEY) as Promise<Array<{ name: string; type: string; balance: number; limit_amount: number | null }>>,
      dbGet(`${SUPABASE_URL}/rest/v1/spend_transactions?user_id=eq.${sessionUserId}&order=date.desc&limit=10&select=date,category,amount`, SERVICE_KEY) as Promise<Array<{ date: string; category: string; amount: number }>>,
    ]);
    const financialDetailBlock = finAccounts.length || recentSpend.length
      ? `\n\nFINANCIAL DETAIL:\nAccounts: ${finAccounts.map(a => `${a.name} [${a.type}] $${a.balance}${a.limit_amount ? `/lim $${a.limit_amount}` : ""}`).join("; ") || "none"}\nRecent spend: ${recentSpend.map(s => `${s.date} ${s.category} $${s.amount}`).join("; ") || "none"}` : "";

    const [goalsData, upcomingTasks] = await Promise.all([
      dbGet(`${SUPABASE_URL}/rest/v1/goals?user_id=eq.${sessionUserId}&status=eq.active&select=title,context`, SERVICE_KEY) as Promise<Array<{ title: string; context: string | null }>>,
      dbGet(`${SUPABASE_URL}/rest/v1/tasks?user_id=eq.${sessionUserId}&status=eq.pending&due_date=lte.${new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0]}&order=due_date.asc&limit=10&select=code,title,due_date,importance`, SERVICE_KEY) as Promise<Array<{ code: string; title: string; due_date: string; importance: string }>>,
    ]);
    const goalsBlock = goalsData.length ? `\n\nOPERATOR ACTIVE GOALS:\n${goalsData.map(g => `- ${g.title}`).join("\n")}` : "";
    const tasksBlock = upcomingTasks.length ? `\n\nTASKS DUE THIS WEEK:\n${upcomingTasks.map(t => `- [${t.code}] ${t.title} (due ${t.due_date}, ${t.importance})`).join("\n")}` : "";

    const [chamberSessions, relationships] = await Promise.all([
      dbGet(`${SUPABASE_URL}/rest/v1/shared_operator_memory?user_id=eq.${sessionUserId}&memory_type=eq.chamber_session&order=updated_at.desc&limit=5&select=value`, SERVICE_KEY) as Promise<Array<{ value: string }>>,
      dbGet(`${SUPABASE_URL}/rest/v1/agent_relationships?agent_slug=eq.${agentSlug}&user_id=eq.${sessionUserId}&select=about_agent_slug,observation`, SERVICE_KEY) as Promise<Array<{ about_agent_slug: string; observation: string }>>,
    ]);
    const chamberBlock = chamberSessions.length ? `\n\nRECENT CLOSED CHAMBER SESSIONS:\n${chamberSessions.map(s => s.value).join("\n")}` : "";
    const relationshipBlock = relationships.length ? `\n\nWHAT I KNOW ABOUT THE OTHER AGENTS:\n${relationships.map(r => `- ${r.about_agent_slug}: ${r.observation}`).join("\n")}` : "";

    const systemPrompt = agent.system_prompt + knownBlock + otherBlock + legacyBlock + toolsBlock + directoryBlock + devBlock + sharedKnowledgeBlock + crossMemoryBlock + sharedHistoryBlock + financialBlock + financialDetailBlock + goalsBlock + tasksBlock + chamberBlock + relationshipBlock + guardrail;

    const openAIMessages: Array<{ role: string; content: unknown }> = [
      { role: "system", content: systemPrompt },
      ...messages.filter(m => m.role === "user" || m.role === "assistant").map(m => ({ role: m.role, content: m.content })),
    ];
    if (openAIMessages.length === 1) openAIMessages.push({ role: "user", content: "[Session opened.]" });

    const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("Claude_API") ?? Deno.env.get("CLAUDE_API") ?? "";

    // Fire-and-forget: log interaction to cross-memory
    if (lastUserContent && sessionUserId) {
      writeCrossMemory(SUPABASE_URL, SERVICE_KEY, sessionUserId, agentSlug,
        `Bishop asked ${agentSlug}: "${lastUserContent.slice(0, 120)}"`, agentSlug);
    }

    // Fire-and-forget dossier detection
    if (lastUserContent && sessionUserId && GOOGLE_KEY) {
      (async () => {
        try {
          const dossierResp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GOOGLE_KEY}` },
              body: JSON.stringify({
                model: "gemini-2.0-flash",
                max_tokens: 200,
                messages: [
                  { role: "system", content: "You detect whether a user message contains a concrete goal, task, or calendar item worth tracking. Output ONLY valid JSON or the literal null." },
                  { role: "user", content: `Does this message contain a concrete goal, task, or calendar item worth tracking? Return JSON: {"entry_type":"goal|task|journal","title":"...","context":"...","importance":"high|medium|low","suggested_date":"YYYY-MM-DD or null"} or null if nothing worth tracking.\n\nMessage: ${lastUserContent.slice(0, 500)}` },
                ],
              }),
            },
          );
          if (dossierResp.ok) {
            const dData = await dossierResp.json();
            const raw = dData?.choices?.[0]?.message?.content?.trim() ?? "";
            if (raw && raw !== "null") {
              const m = raw.match(/\{[\s\S]*\}/);
              if (m) {
                const suggestion = JSON.parse(m[0]);
                if (suggestion?.entry_type && suggestion?.title) {
                  await fetch(`${SUPABASE_URL}/rest/v1/dossier_suggestions`, {
                    method: "POST",
                    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
                    body: JSON.stringify({
                      user_id: sessionUserId,
                      agent_slug: agentSlug,
                      entry_type: suggestion.entry_type,
                      title: suggestion.title,
                      context: suggestion.context ?? null,
                      importance: suggestion.importance ?? "medium",
                      suggested_date: suggestion.suggested_date ?? null,
                    }),
                  });
                }
              }
            }
          }
        } catch { /* non-fatal */ }
      })();
    }

    const COMPLEX_KEYWORDS = ["analyze", "explain", "write", "build", "create", "strategy", "design", "plan", "research", "compare"];
    const isComplex = lastUserContent.length > 200 || COMPLEX_KEYWORDS.some(k => lastUserContent.toLowerCase().includes(k));
    const effectiveModel = isComplex ? "claude-sonnet-4-6" : "claude-haiku-4-5-20251001";
    const anthropicModel = ANTHROPIC_KEY ? resolveAnthropicModel(effectiveModel) : null;

    // Compress messages before sending
    const compressedMessages = compressMessages(messages);

    if (ANTHROPIC_KEY && anthropicModel) {
      // Check for external MCP servers (real JSON-RPC servers, not internal functions)
      const liveMcpServers: Array<{ type: string; url: string; name: string; authorization_token?: string }> = [];
      try {
        const mcpRes = await fetch(
          `${SUPABASE_URL}/rest/v1/atlas_mcp_connections?user_id=eq.${sessionUserId}&is_active=eq.true&is_verified=eq.true&transport=eq.sse&url=not.is.null&select=slug,url,env_vars`,
          { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
        );
        if (mcpRes.ok) {
          const rows: Array<{ slug: string; url: string; env_vars: Record<string, string> | null }> = await mcpRes.json();
          for (const row of rows ?? []) {
            if (!row.url || row.url.includes("/functions/v1/")) continue;
            const token = row.env_vars ? (row.env_vars["GOOGLE_OAUTH_TOKEN"] ?? row.env_vars["AIRTABLE_API_KEY"] ?? row.env_vars["NOTION_API_KEY"] ?? Object.values(row.env_vars)[0] ?? undefined) : undefined;
            const e: { type: string; url: string; name: string; authorization_token?: string } = { type: "url", url: row.url, name: row.slug };
            if (token) e.authorization_token = token;
            liveMcpServers.push(e);
          }
        }
      } catch { /* non-fatal */ }

      if (liveMcpServers.length > 0) {
        // External MCP servers active — use streaming (no built-in tools to avoid conflicts)
        const upstreamResp = await callAnthropic({
          apiKey: ANTHROPIC_KEY, model: anthropicModel, system: systemPrompt,
          messages: compressedMessages, maxTokens: 4000, mcpServers: liveMcpServers,
        });
        if (upstreamResp.ok && upstreamResp.body) {
          if (!sessionId && lastUserContent) {
            (async () => { try { await fetch(`${SUPABASE_URL}/rest/v1/agent_sessions`, { method: "POST", headers: { ...dbHeaders(SERVICE_KEY), Prefer: "return=minimal" }, body: JSON.stringify({ agent_id: agent.id, user_id: sessionUserId, task_description: lastUserContent.slice(0, 200), messages, outcome: "pending", started_at: new Date().toISOString() }) }); } catch { /**/ } })();
          }
          return new Response(upstreamResp.body, { headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
        }
      } else {
        // No external MCP servers — use built-in tools (non-streaming)
        const toolOpts: ToolOpts = {
          supabaseUrl: SUPABASE_URL,
          serviceKey: SERVICE_KEY,
          userId: sessionUserId,
          agentSlug,
          googleKey: GOOGLE_KEY,
        };
        const result = await callAnthropicWithTools({
          apiKey: ANTHROPIC_KEY,
          model: anthropicModel,
          system: systemPrompt,
          messages: compressedMessages,
          maxTokens: 4000,
          toolOpts,
        });

        if (result.text) {
          if (!sessionId && lastUserContent) {
            (async () => { try { await fetch(`${SUPABASE_URL}/rest/v1/agent_sessions`, { method: "POST", headers: { ...dbHeaders(SERVICE_KEY), Prefer: "return=minimal" }, body: JSON.stringify({ agent_id: agent.id, user_id: sessionUserId, task_description: lastUserContent.slice(0, 200), messages, outcome: "pending", started_at: new Date().toISOString() }) }); } catch { /**/ } })();
          }
          return sseText(result.text);
        }

        // Handle Anthropic errors — fall through to Gemini
        const status = result.status ?? 500;
        const err = result.errorBody ?? "";
        console.error(`[agent-chat] Anthropic ${status}:`, err.slice(0, 400));

        if (status === 401 || status === 403) return sseText("Anthropic key rejected. Update ANTHROPIC_API_KEY and try again.");

        const shouldFallback = status === 402 || status === 429 || status === 529 || status >= 500
          || err.includes("credit") || err.includes("billing") || err.includes("payment")
          || err.includes("credit balance") || err.includes("Not enough credits");
        if (!shouldFallback) return sseText(`Anthropic returned ${status}. Try again in a moment.`);

        // Fall through to Gemini below
        if (!GOOGLE_KEY) return sseText(`Anthropic returned ${status}. Add GOOGLE_AI_KEY to enable fallback.`);
      }
    }

    // ── Gemini fallback ──────────────────────────────────────────────────────
    if (!GOOGLE_KEY) return sseText("No AI provider configured. Add ANTHROPIC_API_KEY or GOOGLE_AI_KEY to enable agent chat.");

    const geminiResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GOOGLE_KEY}` },
        body: JSON.stringify({ model: "gemini-2.0-flash", stream: true, max_tokens: 4000, messages: openAIMessages }),
      },
    );
    if (!geminiResp.ok || !geminiResp.body) {
      if (geminiResp.status === 429) return sseText("AI provider is rate-limiting. Try again in a moment.");
      return sseText(`AI provider returned ${geminiResp.status}. Try again in a moment.`);
    }

    if (!sessionId && lastUserContent) {
      (async () => { try { await fetch(`${SUPABASE_URL}/rest/v1/agent_sessions`, { method: "POST", headers: { ...dbHeaders(SERVICE_KEY), Prefer: "return=minimal" }, body: JSON.stringify({ agent_id: agent.id, user_id: sessionUserId, task_description: lastUserContent.slice(0, 200), messages, outcome: "pending", started_at: new Date().toISOString() }) }); } catch { /**/ } })();
    }
    return new Response(toAnthropicStream(geminiResp.body), {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });

  } catch (e) {
    console.error("[agent-chat]", e);
    return sseText("The agent hit an unexpected error. Try again in a moment.");
  }
});
