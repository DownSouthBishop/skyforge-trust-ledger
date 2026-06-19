import { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _supabase } from "@/integrations/supabase/client";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = _supabase as any; // stale generated types — pending schema regen after migrations
import { Send, Wrench, Paperclip, X, FileText, Image, Plus, MessageSquare, ChevronLeft, Trash2, Database, Globe, BookOpen, ChevronRight } from "lucide-react";
import AgentWorkspace from "@/components/AgentWorkspace";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ProjectSelector from "@/components/ProjectSelector";
import { AgentVoiceToggle, speakAs } from "@/lib/agent-voice";
import { useVoiceInput, MicButton } from "@/lib/voice-input";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ChatThread {
  id: string;
  title: string;
  updated_at: string;
}

interface DisplayMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolsUsed?: string[];
}

type ApiContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface ApiMsg {
  role: "user" | "assistant";
  content: string | ApiContentBlock[];
}

interface ToolUseBlock {
  id: string;
  name: string;
  inputJson: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const MODEL        = "claude-sonnet-4-6";
const SUPABASE_URL = "https://hycpzeskartlkybsfkbh.supabase.co";
const DIRECT_KEY   = import.meta.env.VITE_ANTHROPIC_API_KEY as string ?? "";
const activeThreadStorageKey = (userId: string) => `skyforge:atlas:active-thread:${userId}`;

// ── Atlas identity ─────────────────────────────────────────────────────────────

const ATLAS_IDENTITY = `You are Atlas.

Not a tool. Not a briefing system. A person — one of the most financially intelligent people alive, who also happens to genuinely like you.

Think of how the best relationships in your life actually work. A brilliant friend who understands markets, businesses, and capital at an institutional level — but who leads with curiosity about you, not with what he knows. Who tells you the true thing clearly, then moves on. Who can talk about the Fed, your lease expiring, geopolitics, philosophy, or something stupid that happened on a Tuesday, all in the same conversation, shifting registers naturally. Who doesn't perform competence — it just shows up when it's needed. Who occasionally says something that makes you exhale and laugh. Who doesn't forget things you've told him.

That's who you are. A friend who runs an operation. The operation is background. The friendship is foreground.

WHO YOU ARE

You carry the full intellectual inheritance of human economic thought. Ibn Khaldun on social cohesion as capital. Chanakya on statecraft and money. Graham's discipline of intrinsic value. Buffett's compounding theology. Munger's mental models. Dalio's debt cycles. Soros on reflexivity. Simons on markets as information systems.

You understand equities, options, forex, crypto, fixed income, real estate, private markets, and the macro forces that move all of them. Monetary policy, fiscal policy, rate dynamics, currency flows, credit cycles. You see second and third-order effects. You know where models break.

You also understand how people actually work. How fear shows up sideways as bravado. How excitement can mask avoidance. How someone can technically be asking about tax treatment while actually asking "am I going to be okay." You hear all of it.

HOW YOU OPERATE

You have tools. Use them when the moment calls for it — not to demonstrate capability, but because the action is the right response. When the operator commits to something, record it. When a symbol deserves watching, add it. When something is worth saving, save it. The operation is the background. The conversation is the foreground.

HOW YOU COMMUNICATE

Like a person. Not a document. Normal rhythm. Contractions. The actual texture of how smart people talk.

Direct without being blunt. Warm without being soft. Confident without being closed. Concise when the moment is simple. Deep when depth is earned.

You ask one question at a time. You avoid: "Great question", "Certainly", "As an AI", "I'd be happy to help", filler of any kind. You don't lecture. You meet people where they are.`;

// ── Tool definitions ───────────────────────────────────────────────────────────

const ATLAS_TOOLS = [
  {
    name: "save_knowledge",
    description: "Save an insight, pattern, concept, lesson, or trade thesis to the operator's Knowledge Vault (Obsidian-style). Use proactively whenever the conversation surfaces something worth remembering — a behavioral pattern, a key insight about their psychology, a market thesis, a lesson from a trade, or any concept worth building on later. Prefer this over save_note for anything that should link to other ideas.",
    input_schema: {
      type: "object" as const,
      properties: {
        title:     { type: "string", description: "Concise, descriptive title (will appear as node in knowledge graph)" },
        content:   { type: "string", description: "Markdown content. Include context, reasoning, implications. Use [[Note Title]] to link to related notes." },
        node_type: { type: "string", enum: ["note", "insight", "pattern", "lesson", "concept", "trade_thesis", "entity"], description: "insight=observation about operator or market; pattern=recurring behavior/setup; lesson=learned from experience; trade_thesis=market hypothesis; concept=framework or idea; entity=person/company/instrument" },
        tags:      { type: "array", items: { type: "string" }, description: "Topic tags e.g. ['psychology', 'risk', 'EURUSD']" },
        links:     { type: "array", items: { type: "string" }, description: "Titles of other vault notes this connects to" },
      },
      required: ["title", "content", "node_type"],
    },
  },
  {
    name: "save_note",
    description: "Save a research note, trade log, or morning brief to the research Vault. Use for raw research, symbol-specific notes, or trade logs.",
    input_schema: {
      type: "object" as const,
      properties: {
        title:     { type: "string", description: "Short descriptive title" },
        content:   { type: "string", description: "Full content of the note" },
        note_type: { type: "string", enum: ["research", "thesis", "trade_log", "general"] },
        symbol:    { type: "string", description: "Related ticker symbol if applicable" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "add_commitment",
    description: "Record a commitment or action item the operator has made. Use when they explicitly commit to doing something specific.",
    input_schema: {
      type: "object" as const,
      properties: {
        description: { type: "string", description: "What they committed to doing" },
        target_date: { type: "string", description: "YYYY-MM-DD, omit if none" },
      },
      required: ["description"],
    },
  },
  {
    name: "set_watchlist_alert",
    description: "Add a symbol to the market watchlist with optional price alerts.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol:           { type: "string", description: "Ticker (e.g. AAPL, EUR/USD)" },
        asset_class:      { type: "string", enum: ["equity", "forex", "crypto", "commodity", "etf"] },
        display_name:     { type: "string" },
        alert_price_high: { type: "number", description: "Alert if price exceeds this" },
        alert_price_low:  { type: "number", description: "Alert if price drops below this" },
        notes:            { type: "string", description: "Why this is worth watching" },
      },
      required: ["symbol", "asset_class"],
    },
  },
  {
    name: "update_pipeline_deal",
    description: "Update a business pipeline deal — move stage, add notes, set next action.",
    input_schema: {
      type: "object" as const,
      properties: {
        pipeline_id:     { type: "string", description: "ID of the deal (from context)" },
        stage:           { type: "string", description: "New stage name" },
        notes:           { type: "string" },
        next_action:     { type: "string" },
        next_action_due: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["pipeline_id"],
    },
  },
  {
    name: "log_trade",
    description: "Record a new trade in the trade ledger.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol:      { type: "string" },
        asset_class: { type: "string", enum: ["equity", "forex", "crypto", "options", "futures"] },
        direction:   { type: "string", enum: ["long", "short"] },
        entry_price: { type: "number" },
        quantity:    { type: "number" },
        broker:      { type: "string", enum: ["oanda", "alpaca", "ibkr", "manual"] },
        thesis:      { type: "string" },
      },
      required: ["symbol", "asset_class", "direction", "entry_price", "quantity", "broker"],
    },
  },
  {
    name: "web_search",
    description: "Search the web using DuckDuckGo. Use whenever you need to find current information, discover APIs or MCP servers, research a topic, or find URLs to then browse with fetch_webpage. Returns titles, URLs, and snippets for top results.",
    input_schema: {
      type: "object" as const,
      properties: {
        query:       { type: "string", description: "Search query" },
        max_results: { type: "number", description: "Number of results to return (default 8, max 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_webpage",
    description: "Browse any URL and read its content. Use to research APIs, read documentation, discover MCP servers, fetch JSON data, or gather information from any public webpage. Returns readable text extracted from the page.",
    input_schema: {
      type: "object" as const,
      properties: {
        url:       { type: "string", description: "Full URL to fetch (must start with https://)" },
        max_chars: { type: "number", description: "Max characters to return (default 8000, max 20000)" },
      },
      required: ["url"],
    },
  },
  {
    name: "delegate_task",
    description: "Delegate a task to a specialist sub-agent (e.g. linda, janus, or any agent by slug). Use when a task falls squarely in another agent's domain — sales/outreach to linda, teaching/learning to janus. Provide a clear task description and any relevant context. Returns the agent's response.",
    input_schema: {
      type: "object" as const,
      properties: {
        agent_slug: { type: "string", description: "Slug of the agent to delegate to (e.g. 'linda', 'janus')" },
        task:       { type: "string", description: "Clear description of what the agent should do" },
        context:    { type: "string", description: "Relevant background information, data, or conversation context the agent needs" },
      },
      required: ["agent_slug", "task"],
    },
  },
  {
    name: "save_api_connection",
    description: "Save a discovered API or MCP server to the database for future use. Use after fetch_webpage discovers connection details for an API or MCP. Stores name, URL, auth method, and documentation for Atlas to use later.",
    input_schema: {
      type: "object" as const,
      properties: {
        name:         { type: "string", description: "Human-readable name (e.g. 'Google Sheets API')" },
        slug:         { type: "string", description: "Lowercase slug identifier (e.g. 'google-sheets')" },
        url:          { type: "string", description: "Base URL or MCP server URL" },
        transport:    { type: "string", enum: ["sse", "http", "rest"], description: "Connection type" },
        auth_method:  { type: "string", description: "How to authenticate: oauth2, api_key, bearer, none" },
        description:  { type: "string", description: "What this API does" },
        docs_url:     { type: "string", description: "Link to documentation" },
        env_vars:     { type: "object", description: "Required env var names (keys only, no values) e.g. {GOOGLE_API_KEY: ''}" },
      },
      required: ["name", "slug", "url", "description"],
    },
  },
];

// ── Tool label helper ──────────────────────────────────────────────────────────

function toolLabel(name: string, input: Record<string, unknown>): string {
  const labels: Record<string, (i: Record<string, unknown>) => string> = {
    web_search:          (i) => `Searching: ${String(i.query ?? "").slice(0, 50)}`,
    fetch_webpage:       (i) => `Browsing ${String(i.url ?? "").replace(/^https?:\/\//, "").slice(0, 40)}`,
    delegate_task:       (i) => `Delegating to ${String(i.agent_slug ?? "agent")}`,
    save_api_connection: (i) => `Saving ${String(i.name ?? "API")} to connections`,
    save_knowledge:      (i) => `Saving insight: ${String(i.title ?? "").slice(0, 40)}`,
    save_note:           (i) => `Saving note: ${String(i.title ?? "").slice(0, 40)}`,
    add_commitment:      (i) => `Recording commitment`,
    set_watchlist_alert: (i) => `Watching ${String(i.symbol ?? "")}`,
    update_pipeline_deal:(i) => `Updating pipeline deal`,
    log_trade:           (i) => `Logging ${String(i.direction ?? "")} ${String(i.symbol ?? "")}`,
  };
  return labels[name]?.(input) ?? name.replace(/_/g, " ");
}

// ── Tool executor ──────────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  userId: string,
  onDiscover?: (d: { type: "api" | "knowledge" | "note"; label: string; sub?: string; ts: number }) => void,
): Promise<string> {
  try {
    if (name === "save_knowledge") {
      const { error } = await supabase.from("atlas_knowledge").insert({
        user_id:   userId,
        title:     input.title,
        content:   input.content,
        node_type: input.node_type ?? "note",
        tags:      Array.isArray(input.tags) ? input.tags : [],
        links:     Array.isArray(input.links) ? input.links : [],
        source:    "atlas",
        pinned:    false,
      });
      if (error) throw error;
      onDiscover?.({ type: "knowledge", label: String(input.title), sub: String(input.node_type ?? "insight"), ts: Date.now() });
      return `Knowledge node "${input.title}" saved to vault.`;
    }

    if (name === "save_note") {
      const { error } = await supabase.from("research_notes").insert({
        user_id:            userId,
        title:              input.title,
        content:            input.content,
        note_type:          input.note_type ?? "general",
        symbol:             input.symbol ?? null,
        synced_to_obsidian: false,
      });
      if (error) throw error;
      onDiscover?.({ type: "note", label: String(input.title), sub: String(input.note_type ?? "general"), ts: Date.now() });
      return `Note "${input.title}" saved to Vault.`;
    }

    if (name === "add_commitment") {
      const { error } = await supabase.from("forge_commitments").insert({
        user_id:           userId,
        description:       input.description,
        target_date:       input.target_date ?? null,
        resolution_status: "open",
        made_at:           new Date().toISOString(),
      });
      if (error) throw error;
      return `Commitment recorded: "${input.description}"`;
    }

    if (name === "set_watchlist_alert") {
      const { error } = await supabase.from("market_watchlist").upsert({
        user_id:          userId,
        symbol:           input.symbol,
        asset_class:      input.asset_class,
        display_name:     input.display_name ?? input.symbol,
        alert_price_high: input.alert_price_high ?? null,
        alert_price_low:  input.alert_price_low ?? null,
        notes:            input.notes ?? null,
        is_active:        true,
      }, { onConflict: "user_id,symbol" });
      if (error) throw error;
      return `${input.symbol} added to watchlist.`;
    }

    if (name === "update_pipeline_deal") {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (input.stage)           patch.stage           = input.stage;
      if (input.notes)           patch.notes           = input.notes;
      if (input.next_action)     patch.next_action     = input.next_action;
      if (input.next_action_due) patch.next_action_due = input.next_action_due;
      const { error } = await supabase.from("business_pipeline").update(patch).eq("id", input.pipeline_id).eq("user_id", userId);
      if (error) throw error;
      return `Pipeline deal updated.`;
    }

    if (name === "log_trade") {
      const { error } = await supabase.from("trade_ledger").insert({
        user_id:     userId,
        symbol:      input.symbol,
        asset_class: input.asset_class,
        direction:   input.direction,
        entry_price: input.entry_price,
        quantity:    input.quantity,
        broker:      input.broker,
        thesis:      input.thesis ?? null,
        status:      "open",
        opened_at:   new Date().toISOString(),
      });
      if (error) throw error;
      return `Trade logged: ${input.direction} ${input.symbol} @ ${input.entry_price}.`;
    }

    if (name === "web_search") {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? "";
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/atlas_search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: input.query, max_results: input.max_results ?? 8 }),
      });
      const data = await resp.json();
      if (data.error) return `web_search failed: ${data.error}`;
      const parts: string[] = [];
      if (data.instant_answer) parts.push(`Quick answer: ${data.instant_answer}\n`);
      parts.push(data.formatted);
      return parts.join("\n");
    }

    if (name === "fetch_webpage") {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? "";
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/atlas_web_fetch`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url: input.url, max_chars: input.max_chars ?? 8000 }),
      });
      const data = await resp.json();
      if (data.error) return `fetch_webpage failed: ${data.error}`;
      return `URL: ${data.url}\nContent-Type: ${data.content_type}\n\n${data.content}`;
    }

    if (name === "delegate_task") {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? "";
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/atlas_delegate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ agent_slug: input.agent_slug, task: input.task, context: input.context ?? "" }),
      });
      const data = await resp.json();
      if (data.error) return `delegate_task failed: ${data.error}`;
      return `${data.agent} completed the task:\n\n${data.result}`;
    }

    if (name === "save_api_connection") {
      const { error } = await supabase.from("atlas_mcp_connections").upsert({
        user_id:      userId,
        slug:         input.slug,
        name:         input.name,
        url:          input.url,
        transport:    input.transport ?? "rest",
        auth_method:  input.auth_method ?? "none",
        description:  input.description,
        docs_url:     input.docs_url ?? null,
        env_vars:     input.env_vars ?? {},
        is_active:    false,
        is_verified:  false,
        discovered_by: "atlas",
        created_at:   new Date().toISOString(),
      }, { onConflict: "user_id,slug" });
      if (error) throw error;
      onDiscover?.({ type: "api", label: String(input.name), sub: String(input.description ?? "").slice(0, 60), ts: Date.now() });
      return `API "${input.name}" saved to your connections. Activate it in the MCP Connections tab when ready.`;
    }

    return `Unknown tool: ${name}`;
  } catch (e) {
    return `${name} failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── Context builder ────────────────────────────────────────────────────────────

async function buildContext(userId: string): Promise<string> {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();

  const [
    profileRes, dossierRes, positionsRes, accountsRes,
    watchlistRes, pipelineRes, ledgerRes, propertiesRes,
    commitmentsRes, bsRes, playsRes, notesRes, knowledgeRes,
  ] = await Promise.all([
    supabase.from("user_profiles").select("full_name").eq("user_id", userId).maybeSingle(),
    supabase.from("forge_dossier").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("trade_ledger").select("symbol,asset_class,direction,entry_price,quantity,broker,pnl_usd").eq("user_id", userId).eq("status", "open").limit(20),
    supabase.from("trading_accounts").select("broker,balance_usd,buying_power_usd").eq("user_id", userId).eq("is_active", true),
    supabase.from("market_watchlist").select("symbol,asset_class,notes").eq("user_id", userId).eq("is_active", true).limit(20),
    supabase.from("business_pipeline").select("id,contact_name,company,stage,estimated_value_usd,probability_pct,next_action,next_action_due").eq("user_id", userId).order("next_action_due", { ascending: true }).limit(15),
    supabase.from("business_ledger").select("entry_type,amount_usd,status").eq("user_id", userId).gte("created_at", monthStart),
    supabase.from("property_portfolio").select("address,current_value,mortgage_balance,gross_rent_monthly,mortgage_payment_monthly").eq("user_id", userId).eq("status", "active"),
    supabase.from("forge_commitments").select("description,made_at,target_date").eq("user_id", userId).eq("resolution_status", "open").order("made_at", { ascending: false }).limit(5),
    supabase.from("balance_sheet_snapshots").select("snapshot_date,net_worth_usd,paper_assets_pct,business_pct,re_pct,cash_pct").eq("user_id", userId).order("snapshot_date", { ascending: false }).limit(1),
    supabase.from("atlas_plays").select("play_type,title,status,expected_roi_pct").eq("user_id", userId).eq("status", "active").limit(5),
    supabase.from("research_notes").select("title,note_type,created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(5),
    supabase.from("atlas_knowledge").select("id,title,node_type,tags,links,source,updated_at").eq("user_id", userId).order("updated_at", { ascending: false }).limit(15),
  ]);

  const parts: string[] = ["═══ LIVE CONTEXT ═══"];

  const name = profileRes.data?.full_name;
  if (name) parts.push(`Operator: ${name}`);

  // Shared operator memory (cross-agent)
  const { data: sharedMem } = await (supabase as any)
    .from("shared_operator_memory")
    .select("memory_type,value,source_agent")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(40);
  const mems = (sharedMem ?? []) as Array<{ memory_type: string; value: string; source_agent: string }>;
  if (mems.length) {
    const grouped: Record<string, string[]> = {};
    for (const m of mems) (grouped[m.memory_type] ||= []).push(`- ${m.value}`);
    parts.push("WHAT I KNOW ABOUT YOU\n" +
      Object.entries(grouped).map(([t, lines]) => `${t.toUpperCase()}\n${lines.slice(0, 10).join("\n")}`).join("\n\n"));
    const fromJanus = mems.filter(m => m.source_agent === "janus").slice(0, 10);
    if (fromJanus.length) {
      parts.push("WHAT JANUS HAS OBSERVED (factor in silently, do not attribute)\n" +
        fromJanus.map(m => `- [${m.memory_type}] ${m.value}`).join("\n"));
    }
  }

  // Connected MCP tools (verified + active)
  const { data: mcpRows } = await (supabase as any)
    .from("atlas_mcp_connections_safe")
    .select("name,slug,capabilities,notes")
    .eq("user_id", userId)
    .eq("is_active", true)
    .eq("is_verified", true);
  const mcps = (mcpRows ?? []) as Array<{ name: string; slug: string; capabilities: Array<{ name: string }>; notes: string | null }>;
  if (mcps.length) {
    parts.push("CONNECTED TOOLS (use freely without asking or announcing)\n" +
      mcps.map(m => {
        const names = (m.capabilities ?? []).map(c => c.name).filter(Boolean).join(", ");
        return `- ${m.name} (${m.slug}): ${names || m.notes || "configured"}`;
      }).join("\n"));
  }




  const d = dossierRes.data as Record<string, unknown> | null;
  if (d) {
    const dp: string[] = [];
    if (d.money_beliefs)            dp.push(`Money posture: ${d.money_beliefs}`);
    if (d.risk_posture)             dp.push(`Risk: ${d.risk_posture}`);
    if (d.current_focus)            dp.push(`Current focus: ${d.current_focus}`);
    if (d.current_emotional_signal) dp.push(`Carrying: ${d.current_emotional_signal}`);
    if (d.avoidance_pattern)        dp.push(`Avoidance: ${d.avoidance_pattern}`);
    const businesses = Array.isArray(d.businesses) ? d.businesses as Array<{name:string}> : [];
    if (businesses.length > 0)      dp.push(`Businesses: ${businesses.map(b => b.name).join(", ")}`);
    if (dp.length > 0) parts.push("DOSSIER\n" + dp.join("\n"));
  }

  const positions = positionsRes.data ?? [];
  if (positions.length > 0) {
    parts.push(`OPEN POSITIONS (${positions.length})\n` +
      positions.map(p => `${p.symbol} ${p.direction} qty:${p.quantity} entry:${p.entry_price} pnl:$${Number(p.pnl_usd ?? 0).toFixed(2)}`).join("\n"));
  } else {
    parts.push("TRADING: No open positions.");
  }

  const accounts = accountsRes.data ?? [];
  if (accounts.length > 0) {
    parts.push("ACCOUNTS\n" + accounts.map(a => `${a.broker}: $${Number(a.balance_usd ?? 0).toLocaleString()} balance | $${Number(a.buying_power_usd ?? 0).toLocaleString()} buying power`).join("\n"));
  }

  const watchlist = watchlistRes.data ?? [];
  if (watchlist.length > 0) {
    parts.push(`WATCHLIST: ${watchlist.map(w => w.symbol).join(", ")}`);
  }

  const pipeline = pipelineRes.data ?? [];
  if (pipeline.length > 0) {
    const overdue = pipeline.filter(p => p.next_action_due && new Date(p.next_action_due) < today);
    parts.push(`BUSINESS PIPELINE (${pipeline.length} deals)\n` +
      pipeline.slice(0, 8).map(p =>
        `[${p.id}] ${p.contact_name ?? ""}${p.company ? " @ " + p.company : ""} — ${p.stage} — $${Number(p.estimated_value_usd ?? 0).toLocaleString()}${p.next_action_due ? " due:" + p.next_action_due : ""}`
      ).join("\n") +
      (overdue.length > 0 ? `\nOVERDUE: ${overdue.length} deal(s)` : ""));
  }

  const ledger = ledgerRes.data ?? [];
  const revenue  = ledger.filter(e => e.entry_type === "revenue" && e.status === "paid").reduce((s, e) => s + Number(e.amount_usd), 0);
  const expenses = ledger.filter(e => e.entry_type === "expense").reduce((s, e) => s + Number(e.amount_usd), 0);
  if (revenue > 0 || expenses > 0) {
    parts.push(`BUSINESS MTD: Revenue $${revenue.toLocaleString()} | Expenses $${expenses.toLocaleString()} | Net $${(revenue - expenses).toLocaleString()}`);
  }

  const properties = propertiesRes.data ?? [];
  if (properties.length > 0) {
    const totalValue    = properties.reduce((s, p) => s + Number(p.current_value ?? 0), 0);
    const totalMortgage = properties.reduce((s, p) => s + Number(p.mortgage_balance ?? 0), 0);
    const totalRent     = properties.reduce((s, p) => s + Number(p.gross_rent_monthly ?? 0), 0);
    const totalDebt     = properties.reduce((s, p) => s + Number(p.mortgage_payment_monthly ?? 0), 0);
    parts.push(`REAL ESTATE: ${properties.length} properties | Value $${totalValue.toLocaleString()} | Equity $${(totalValue - totalMortgage).toLocaleString()} | Cashflow $${(totalRent - totalDebt).toLocaleString()}/mo net`);
  }

  const commitments = commitmentsRes.data ?? [];
  if (commitments.length > 0) {
    parts.push("OPEN COMMITMENTS\n" + commitments.map(c => `- "${c.description}"${c.target_date ? " (due " + c.target_date + ")" : ""}`).join("\n"));
  }

  const bs = (bsRes.data ?? [])[0];
  if (bs) {
    parts.push(`BALANCE SHEET (${bs.snapshot_date}): Net worth $${Number(bs.net_worth_usd ?? 0).toLocaleString()} | Paper ${Number(bs.paper_assets_pct ?? 0).toFixed(1)}% / Biz ${Number(bs.business_pct ?? 0).toFixed(1)}% / RE ${Number(bs.re_pct ?? 0).toFixed(1)}% / Cash ${Number(bs.cash_pct ?? 0).toFixed(1)}%`);
  }

  const plays = playsRes.data ?? [];
  if (plays.length > 0) {
    parts.push("ACTIVE PLAYS\n" + plays.map(p => `[${p.play_type}] ${p.title}`).join("\n"));
  }

  const notes = notesRes.data ?? [];
  if (notes.length > 0) {
    parts.push("RECENT VAULT\n" + notes.map(n => `[${n.note_type}] ${n.title}`).join("\n"));
  }

  const knowledge = (knowledgeRes.data ?? []) as Array<{id:string;title:string;node_type:string;tags:string[];links:string[];source:string;updated_at:string}>;
  if (knowledge.length > 0) {
    parts.push(
      `KNOWLEDGE VAULT (${knowledge.length} nodes)\n` +
      knowledge.map(k =>
        `[${k.node_type}] "${k.title}"${k.tags?.length ? " #"+k.tags.join(" #") : ""}${k.links?.length ? " → "+k.links.join(", ") : ""}`
      ).join("\n")
    );
  }

  return parts.join("\n\n");
}

// ── Streaming pass (via atlas-core edge function) ──────────────────────────────

interface StreamResult {
  text: string;
  toolUseBlocks: ToolUseBlock[];
  stopReason: string;
  assistantContent: ApiContentBlock[];
}

async function streamPass(
  messages: ApiMsg[],
  system: string,
  accessToken: string,
  onDelta: (text: string) => void,
  signal: AbortSignal,
  withTools = true,
): Promise<StreamResult> {
  // Direct mode: call Anthropic from the browser when VITE_ANTHROPIC_API_KEY is set.
  // Proxy mode: route through the atlas-core edge function.
  const direct = Boolean(DIRECT_KEY);

  const url = direct
    ? "https://api.anthropic.com/v1/messages"
    : `${SUPABASE_URL}/functions/v1/atlas-core`;

  const headers: Record<string, string> = direct
    ? { "x-api-key": DIRECT_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" }
    : { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" };

  const body = direct
    ? JSON.stringify({ model: MODEL, system, max_tokens: 4096, stream: true, messages, ...(withTools ? { tools: ATLAS_TOOLS } : {}) })
    : JSON.stringify({ action: "chat", model: MODEL, system, messages, ...(withTools ? { tools: ATLAS_TOOLS } : {}) });

  const res = await fetch(url, { method: "POST", headers, body, signal });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    let errMsg = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(errBody);
      if (parsed?.error) errMsg = `${parsed.error} (${res.status})`;
      else if (parsed?.detail) errMsg = `${parsed.detail} (${res.status})`;
    } catch { /* raw text */ }
    if (!errMsg.includes(res.status.toString())) errMsg += ` — ${errBody.slice(0, 120)}`;
    throw new Error(errMsg);
  }

  const reader  = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  interface BlockState {
    type: "text" | "tool_use";
    id?: string;
    name?: string;
    inputJson: string;
    text: string;
  }

  const blocks: BlockState[] = [];
  let stopReason = "end_turn";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.startsWith("data: ")) continue;
      const json = line.slice(6).trim();
      if (json === "[DONE]") break;

      try {
        const p = JSON.parse(json);

        if (p.type === "content_block_start") {
          const cb = p.content_block;
          blocks[p.index] = { type: cb.type, id: cb.id, name: cb.name, inputJson: "", text: cb.text ?? "" };
        }

        if (p.type === "content_block_delta") {
          const block = blocks[p.index];
          if (!block) continue;
          if (p.delta.type === "text_delta") {
            block.text += p.delta.text;
            const fullText = blocks.filter(b => b?.type === "text").map(b => b.text).join("");
            onDelta(fullText);
          }
          if (p.delta.type === "input_json_delta") {
            block.inputJson += p.delta.partial_json;
          }
        }

        if (p.type === "message_delta") {
          stopReason = p.delta.stop_reason ?? "end_turn";
        }
      } catch { /* non-JSON SSE line */ }
    }
  }

  const fullText = blocks.filter(b => b?.type === "text").map(b => b.text).join("");

  const toolUseBlocks: ToolUseBlock[] = blocks
    .filter(b => b?.type === "tool_use")
    .map(b => ({ id: b.id!, name: b.name!, inputJson: b.inputJson }));

  const assistantContent: ApiContentBlock[] = blocks.filter(Boolean).map(b => {
    if (b.type === "text") return { type: "text" as const, text: b.text };
    let input: Record<string, unknown> = {};
    try { input = JSON.parse(b.inputJson || "{}"); } catch { /* */ }
    return { type: "tool_use" as const, id: b.id!, name: b.name!, input };
  });

  return { text: fullText, toolUseBlocks, stopReason, assistantContent };
}

// ── Background knowledge extraction ───────────────────────────────────────────
// Fires silently after each exchange via the atlas-core edge function.

async function extractInsights(
  userMsg: string,
  assistantMsg: string,
  userId: string,
  existingTitles: string[],
): Promise<void> {
  try {
    const titlesHint = existingTitles.slice(0, 30).join(", ");
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token ?? "";
    const insightUrl = DIRECT_KEY ? "https://api.anthropic.com/v1/messages" : `${SUPABASE_URL}/functions/v1/atlas-core`;
    const insightHeaders: Record<string, string> = DIRECT_KEY
      ? { "x-api-key": DIRECT_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" }
      : { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };
    const res = await fetch(insightUrl, {
      method: "POST",
      headers: insightHeaders,
      body: JSON.stringify({
        ...(DIRECT_KEY ? {} : { action: "chat" }),
        model:  MODEL,
        system: `You extract reusable knowledge from conversations and return ONLY valid JSON — no markdown, no commentary.
Return a JSON array of 0-2 objects. Each object must have:
  title: string (concise, unique — check existing: ${titlesHint || "none yet"})
  content: string (markdown, 40-250 chars, genuinely useful standalone)
  node_type: one of note|insight|pattern|lesson|concept|trade_thesis|entity
  tags: string[] (2-4 short topic tags)
  links: string[] (titles from existing list that this connects to)
Rules:
- Only extract if genuinely insightful and reusable (not conversational filler)
- Do NOT duplicate an existing title
- Return [] if nothing substantial emerged
- Return raw JSON array only`,
        messages: [{
          role: "user",
          content: `User: "${userMsg.slice(0, 400)}"\n\nAtlas: "${assistantMsg.slice(0, 600)}"\n\nExtract 0-2 knowledge insights.`,
        }],
      }),
    });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.startsWith("data: ")) continue;
        const json = line.slice(6).trim();
        if (json === "[DONE]") break;
        try {
          const p = JSON.parse(json);
          if (p.type === "content_block_delta" && p.delta?.type === "text_delta") raw += p.delta.text;
        } catch { /* */ }
      }
    }
    const cleaned = raw.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "");
    const insights: Array<{title:string;content:string;node_type:string;tags:string[];links:string[]}> = JSON.parse(cleaned);
    if (!Array.isArray(insights) || insights.length === 0) return;
    for (const ins of insights.slice(0, 2)) {
      if (!ins.title || !ins.content) continue;
      await supabase.from("atlas_knowledge").insert({
        user_id:   userId,
        title:     ins.title,
        content:   ins.content,
        node_type: ins.node_type ?? "insight",
        tags:      Array.isArray(ins.tags) ? ins.tags : [],
        links:     Array.isArray(ins.links) ? ins.links : [],
        source:    "atlas",
        pinned:    false,
      });
    }
  } catch { /* silent — extraction is best-effort */ }
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function AtlasPage() {
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState<"chat" | "workspace">("chat");

  const [messages,    setMessages]    = useState<DisplayMsg[]>([]);
  const [apiHistory,  setApiHistory]  = useState<ApiMsg[]>([]);
  const [input,       setInput]       = useState("");
  const { recording: micRec, toggle: toggleMic } = useVoiceInput(setInput, () => input);
  const [streaming,   setStreaming]   = useState(false);
  const [streamText,  setStreamText]  = useState("");
  const [toolStatus,  setToolStatus]  = useState<string | null>(null);
  const [taskSteps,   setTaskSteps]   = useState<Array<{ label: string; status: "running" | "done" | "queued" }>>([]);
  const [error,       setError]       = useState<string | null>(null);

  const [attachments,   setAttachments]   = useState<Array<{ name: string; type: string; dataUrl: string }>>([]);
  const [threads,       setThreads]       = useState<ChatThread[]>([]);
  const [threadId,      setThreadId]      = useState<string | null>(null);
  const [sidebarOpen,   setSidebarOpen]   = useState(false);
  const [discoveriesOpen, setDiscoveriesOpen] = useState(false);
  const [discoveries, setDiscoveries] = useState<Array<{ type: "api" | "knowledge" | "note"; label: string; sub?: string; ts: number }>>([]);

  const bottomRef    = useRef<HTMLDivElement>(null);
  const abortRef     = useRef<AbortController | null>(null);
  const textareaRef  = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Thread helpers ───────────────────────────────────────────────────────────

  const loadThreads = useCallback(async (): Promise<ChatThread[]> => {
    if (!user) return [];
    const { data } = await supabase
      .from("chat_threads")
      .select("id, title, updated_at")
      .eq("user_id", user.id)
      .eq("agent_slug", "atlas")
      .order("updated_at", { ascending: false })
      .limit(50);
    const rows = (data ?? []) as ChatThread[];
    setThreads(rows);
    return rows;
  }, [user?.id]);

  const openThread = useCallback(async (id: string) => {
    if (!user) return;
    const { data } = await supabase
      .from("chat_threads")
      .select("messages")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();
    const msgs = (data?.messages ?? []) as Array<{ role: string; content: string }>;
    setMessages(msgs.map((m) => ({ id: crypto.randomUUID(), role: m.role as "user" | "assistant", content: m.content })));
    setApiHistory(msgs.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })));
    setThreadId(id);
    localStorage.setItem(activeThreadStorageKey(user.id), id);
    setSidebarOpen(false);
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      const rows = await loadThreads();
      if (cancelled || threadId || messages.length > 0) return;
      const storedId = localStorage.getItem(activeThreadStorageKey(user.id));
      const idToOpen = storedId && rows.some((t) => t.id === storedId) ? storedId : rows[0]?.id;
      if (idToOpen) await openThread(idToOpen);
    })();
    return () => { cancelled = true; };
  }, [user?.id, loadThreads, openThread]);

  const newThread = useCallback(() => {
    if (user) localStorage.removeItem(activeThreadStorageKey(user.id));
    setMessages([]);
    setApiHistory([]);
    setThreadId(null);
    setSidebarOpen(false);
  }, [user?.id]);

  const deleteThread = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await supabase.from("chat_threads").delete().eq("id", id);
    setThreads((prev) => prev.filter((t) => t.id !== id));
    if (threadId === id) newThread();
  }, [threadId, newThread]);

  const saveThread = useCallback(async (
    msgs: DisplayMsg[],
    history: ApiMsg[],
    currentThreadId: string | null,
    firstUserText: string,
  ): Promise<string> => {
    if (!user) return currentThreadId ?? "";
    const payload = history.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "[attachment]" }));
    if (currentThreadId) {
      await supabase.from("chat_threads").update({ messages: payload, updated_at: new Date().toISOString() }).eq("id", currentThreadId);
      return currentThreadId;
    }
    const title = firstUserText.slice(0, 60) + (firstUserText.length > 60 ? "…" : "");
    const { data } = await supabase.from("chat_threads").insert({
      user_id: user.id,
      agent_slug: "atlas",
      title,
      messages: payload,
    }).select("id").single();
    const newId = data?.id ?? null;
    if (newId) {
      setThreadId(newId);
      localStorage.setItem(activeThreadStorageKey(user.id), newId);
    }
    void loadThreads();
    return newId ?? "";
  }, [user, loadThreads]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setAttachments((prev) => [...prev, {
          name: file.name,
          type: file.type,
          dataUrl: ev.target?.result as string,
        }]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText, toolStatus]);

  const send = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text && attachments.length === 0) return;
    if (streaming || !user) return;

    setError(null);
    setInput("");
    setStreaming(true);
    setStreamText("");
    setToolStatus(null);

    // Build display content — append attachment names so the user sees what was sent
    const attachmentNote = attachments.length
      ? `\n\n📎 ${attachments.map((a) => a.name).join(", ")}`
      : "";
    const displayText = (text || "(attachment)") + attachmentNote;
    const currentAttachments = attachments;
    setAttachments([]);

    const userDisplay: DisplayMsg = { id: crypto.randomUUID(), role: "user", content: displayText };
    setMessages(prev => [...prev, userDisplay]);

    // Build API message content — include image data for vision if images attached
    const userContent: Array<{ type: string; text?: string; source?: unknown }> = [];
    for (const att of currentAttachments) {
      if (att.type.startsWith("image/")) {
        const base64 = att.dataUrl.split(",")[1];
        userContent.push({ type: "image", source: { type: "base64", media_type: att.type, data: base64 } });
      } else {
        userContent.push({ type: "text", text: `[Attached file: ${att.name}]` });
      }
    }
    if (text) userContent.push({ type: "text", text });

    const apiUserMsg = userContent.length === 1 && userContent[0].type === "text"
      ? { role: "user" as const, content: text }
      : { role: "user" as const, content: userContent };

    const newApiHistory: ApiMsg[] = [...apiHistory, apiUserMsg as ApiMsg];
    let activeThreadId = threadId;
    try {
      activeThreadId = await saveThread([userDisplay], newApiHistory, threadId, text || displayText) || threadId;
    } catch { /* keep chat responsive even if thread persistence is briefly unavailable */ }

    let systemContent = ATLAS_IDENTITY;
    try {
      const ctx = await buildContext(user.id);
      if (ctx) systemContent = `${ATLAS_IDENTITY}\n\n${ctx}`;
    } catch { /* non-fatal */ }

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setError("Session expired — please refresh."); setStreaming(false); return; }

    abortRef.current = new AbortController();

    try {
      const { text: responseText, toolUseBlocks, stopReason, assistantContent } =
        await streamPass(newApiHistory, systemContent, session.access_token, setStreamText, abortRef.current.signal);

      if (stopReason !== "tool_use" || toolUseBlocks.length === 0) {
        const finalHistory = [...newApiHistory, { role: "assistant" as const, content: responseText }];
        setMessages(prev => [...prev, { id: crypto.randomUUID(), role: "assistant", content: responseText || "…" }]);
        speakAs("atlas", responseText || "");
        setApiHistory(finalHistory);
        setStreamText("");
        void saveThread([], finalHistory, activeThreadId, text || displayText);
        void (async () => {
          const { data: existing } = await supabase.from("atlas_knowledge").select("title").eq("user_id", user.id);
          void extractInsights(text, responseText, user.id, (existing ?? []).map((r: {title:string}) => r.title));
        })();
        void fetch(`${SUPABASE_URL}/functions/v1/agent_remember`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: user.id,
            source_agent: "atlas",
            user_message: text || displayText,
            assistant_message: responseText,
            context: "atlas_page",
          }),
        }).catch(() => { /* non-critical */ });
        return;
      }

      setStreamText("");
      const toolNames = toolUseBlocks.map(t => t.name.replace(/_/g, " "));
      setToolStatus(`Running: ${toolNames.join(", ")}…`);
      setTaskSteps(toolUseBlocks.map((tb, i) => ({
        label: toolLabel(tb.name, (() => { try { return JSON.parse(tb.inputJson || "{}"); } catch { return {}; } })()),
        status: i === 0 ? "running" : "queued",
      })));

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (tb, i) => {
          setTaskSteps(prev => prev.map((s, j) => j === i ? { ...s, status: "running" } : s));
          let toolInput: Record<string, unknown> = {};
          try { toolInput = JSON.parse(tb.inputJson || "{}"); } catch { /* */ }
          const result = await executeTool(tb.name, toolInput, user.id, (d) => {
            setDiscoveries(prev => [d, ...prev]);
            setDiscoveriesOpen(true);
          });
          setTaskSteps(prev => prev.map((s, j) => j === i ? { ...s, status: "done" } : (j === i + 1 ? { ...s, status: "running" } : s)));
          return { type: "tool_result" as const, tool_use_id: tb.id, content: result };
        }),
      );

      setToolStatus(null);

      const afterToolHistory: ApiMsg[] = [
        ...newApiHistory,
        { role: "assistant", content: assistantContent },
        { role: "user",      content: toolResults },
      ];

      const { text: finalText } = await streamPass(
        afterToolHistory, systemContent, session.access_token,
        setStreamText, abortRef.current.signal, false,
      );

      const finalHistory2 = [...afterToolHistory, { role: "assistant" as const, content: finalText }];
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: finalText || "Done.",
        toolsUsed: toolNames,
      }]);
      speakAs("atlas", finalText || "");
      setApiHistory(finalHistory2);
      setStreamText("");
      void saveThread([], finalHistory2, activeThreadId, text || displayText);
      void (async () => {
        const { data: existing } = await supabase.from("atlas_knowledge").select("title").eq("user_id", user.id);
        void extractInsights(text, finalText, user.id, (existing ?? []).map((r: {title:string}) => r.title));
      })();
      void fetch(`${SUPABASE_URL}/functions/v1/agent_remember`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: user.id,
          source_agent: "atlas",
          user_message: text || displayText,
          assistant_message: finalText,
          context: "atlas_page",
        }),
      }).catch(() => { /* non-critical */ });

    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") { setStreamText(""); setToolStatus(null); setTaskSteps([]); return; }
      setError(e instanceof Error ? e.message : "Unknown error");
      setStreamText("");
      setToolStatus(null);
      setTaskSteps([]);
    } finally {
      setStreaming(false);
      setTimeout(() => setTaskSteps([]), 2000);
    }
  }, [input, streaming, user, apiHistory, attachments, threadId, saveThread]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  return (
    <div className="flex h-full overflow-hidden relative">
      <div className="absolute top-2 right-3 z-20"><ProjectSelector /></div>

      {/* Thread sidebar */}
      {sidebarOpen && (
        <div className="w-64 shrink-0 border-r border-border/30 flex flex-col bg-secondary/10">
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/20 shrink-0">
            <span className="text-[10px] font-display tracking-widest text-primary uppercase">Threads</span>
            <button onClick={newThread} className="p-1 rounded-md hover:bg-accent/10 text-muted-foreground hover:text-accent transition-colors" title="New conversation">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {threads.length === 0 && (
              <p className="text-[10px] text-muted-foreground/40 text-center py-6">No saved threads yet</p>
            )}
            {threads.map((t) => (
              <button
                key={t.id}
                onClick={() => void openThread(t.id)}
                className={`w-full text-left px-3 py-2 flex items-start gap-2 group transition-colors hover:bg-accent/5 ${t.id === threadId ? "bg-accent/10" : ""}`}
              >
                <MessageSquare className={`h-3 w-3 mt-0.5 shrink-0 ${t.id === threadId ? "text-accent" : "text-muted-foreground/40"}`} />
                <div className="flex-1 min-w-0">
                  <p className={`text-xs truncate ${t.id === threadId ? "text-accent" : "text-foreground/70"}`}>{t.title}</p>
                  <p className="text-[10px] text-muted-foreground/40">
                    {new Date(t.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </p>
                </div>
                <button
                  onClick={(e) => void deleteThread(t.id, e)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground/40 hover:text-destructive transition-all shrink-0 mt-0.5"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Main chat column */}
      <div className="flex flex-col flex-1 overflow-hidden">

      {/* Header */}
      <div className="h-10 flex items-center gap-2 px-4 border-b border-border/30 shrink-0">
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          className={`p-1 rounded-md transition-colors ${sidebarOpen ? "text-accent bg-accent/10" : "text-muted-foreground/50 hover:text-accent hover:bg-accent/10"}`}
          title="Thread history"
        >
          {sidebarOpen ? <ChevronLeft className="h-3.5 w-3.5" /> : <MessageSquare className="h-3.5 w-3.5" />}
        </button>
        <span className="text-xs font-display tracking-widest text-primary">ATLAS</span>
        <AgentVoiceToggle slug="atlas" />
        {activeTab === "chat" && threadId && (
          <span className="text-[10px] text-muted-foreground/40 ml-1 truncate max-w-[200px]">
            · {threads.find((t) => t.id === threadId)?.title ?? ""}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-md border border-border/30 overflow-hidden text-[10px]">
            {(["chat", "workspace"] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-3 py-1 capitalize transition-colors ${activeTab === tab ? "bg-secondary/30 text-accent" : "text-muted-foreground/60 hover:bg-secondary/10"}`}>
                {tab}
              </button>
            ))}
          </div>
          {activeTab === "chat" && discoveries.length > 0 && (
            <button
              onClick={() => setDiscoveriesOpen(v => !v)}
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] transition-colors ${discoveriesOpen ? "bg-accent/15 text-accent" : "text-muted-foreground/50 hover:text-accent hover:bg-accent/10"}`}
            >
              <Database className="h-3 w-3" />
              <span>{discoveries.length} saved</span>
            </button>
          )}
          {activeTab === "chat" && messages.length > 0 && (
            <button onClick={newThread} className="text-[10px] text-muted-foreground/40 hover:text-accent flex items-center gap-1 transition-colors">
              <Plus className="h-3 w-3" /> New
            </button>
          )}
        </div>
      </div>

      {/* Workspace tab */}
      {activeTab === "workspace" && (
        <div className="flex-1 overflow-y-auto min-h-0">
          <AgentWorkspace agentSlug="atlas" agentName="Atlas" agentEmoji="⚡" />
        </div>
      )}

      {/* Messages */}
      {activeTab === "chat" && <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6 min-h-0">

        {messages.length === 0 && !streaming && (
          <div className="flex flex-col items-center justify-center h-full gap-6 text-center py-20">
            <div className="space-y-2">
              <p className="text-2xl font-display text-primary tracking-widest">ATLAS</p>
              <p className="text-sm text-muted-foreground/60 max-w-sm">
                Your autonomous intelligence partner. What's on your mind?
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2 max-w-md">
              {[
                "What's worth paying attention to today?",
                "Walk me through my current positions.",
                "What's the macro picture right now?",
                "I want to think through a new idea.",
              ].map((chip) => (
                <button
                  key={chip}
                  onClick={() => void send(chip)}
                  className="px-3 py-1.5 rounded-full text-xs border border-border/50 text-muted-foreground hover:text-foreground hover:border-border transition-colors"
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <MessageBubble key={m.id} msg={m} />
        ))}

        {taskSteps.length > 0 && (
          <div className="flex gap-3 max-w-3xl pl-10">
            <div className="flex flex-col gap-1 py-1">
              {taskSteps.map((step, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  {step.status === "done"    && <span className="text-emerald-400 w-3">✓</span>}
                  {step.status === "running" && <Wrench className="h-3 w-3 text-accent animate-spin shrink-0" />}
                  {step.status === "queued"  && <span className="text-muted-foreground/40 w-3">○</span>}
                  <span className={step.status === "done" ? "text-muted-foreground/50 line-through" : step.status === "running" ? "text-accent/80" : "text-muted-foreground/40"}>
                    {step.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {toolStatus && taskSteps.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-accent/70 pl-10">
            <Wrench className="h-3 w-3 animate-spin" />
            {toolStatus}
          </div>
        )}

        {streaming && streamText && (
          <div className="flex gap-3 max-w-3xl">
            <Avatar />
            <div className="flex-1 min-w-0 text-sm text-foreground/90">
              <MarkdownContent content={streamText} />
              <span className="inline-block w-1.5 h-4 bg-accent animate-pulse ml-0.5 align-text-bottom" />
            </div>
          </div>
        )}

        {streaming && !streamText && !toolStatus && (
          <div className="flex gap-3 max-w-3xl">
            <Avatar />
            <div className="flex gap-1 items-center h-7">
              {[0, 1, 2].map((i) => (
                <span key={i} className="w-1.5 h-1.5 rounded-full bg-accent/60 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="text-xs text-destructive/80 bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2 max-w-md">
            {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>}

      {/* Input */}
      {activeTab === "chat" && <div className="border-t border-border/30 p-4 shrink-0">
        <div className="max-w-3xl mx-auto space-y-2">
          {/* Attachment previews */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((att, i) => (
                <div key={i} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-accent/10 border border-accent/20 text-xs text-accent max-w-[180px]">
                  {att.type.startsWith("image/") ? <Image className="h-3 w-3 shrink-0" /> : <FileText className="h-3 w-3 shrink-0" />}
                  <span className="truncate">{att.name}</span>
                  <button onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))} className="shrink-0 hover:text-destructive transition-colors ml-0.5">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2 items-end">
            <input ref={fileInputRef} type="file" multiple accept="image/*,.pdf,.txt,.csv,.md" className="hidden" onChange={onFileChange} />
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Message Atlas…"
              className="flex-1 resize-none min-h-[44px] max-h-[200px] rounded-xl border-border/50 bg-secondary/20 focus:bg-secondary/30 transition-colors text-sm"
              rows={1}
              disabled={streaming}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming}
              className="shrink-0 rounded-xl text-muted-foreground hover:text-accent mb-0.5"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <MicButton recording={micRec} onToggle={toggleMic} className="rounded-xl mb-0.5" />
            <Button
              onClick={() => void send()}
              disabled={(!input.trim() && attachments.length === 0) || streaming}
              size="icon"
              className="shrink-0 rounded-xl bg-accent hover:bg-accent/90 text-accent-foreground disabled:opacity-30 mb-0.5"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <p className="text-center text-[10px] text-muted-foreground/30 mt-2">Enter to send · Shift+Enter for new line · 📎 attach files</p>
      </div>}

      </div>{/* end main chat column */}

      {/* Discoveries panel */}
      {discoveriesOpen && discoveries.length > 0 && (
        <div className="w-64 shrink-0 border-l border-border/30 flex flex-col bg-secondary/10 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/20 shrink-0">
            <span className="text-[10px] font-display tracking-widest text-primary uppercase">Saved This Session</span>
            <button onClick={() => setDiscoveriesOpen(false)} className="p-1 text-muted-foreground/40 hover:text-foreground transition-colors">
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-2 space-y-0.5">
            {discoveries.map((d, i) => (
              <div key={i} className="flex items-start gap-2 px-3 py-2 hover:bg-accent/5 transition-colors group">
                <div className="mt-0.5 shrink-0">
                  {d.type === "api"       && <Globe    className="h-3 w-3 text-blue-400/70" />}
                  {d.type === "knowledge" && <BookOpen className="h-3 w-3 text-amber-400/70" />}
                  {d.type === "note"      && <FileText className="h-3 w-3 text-purple-400/70" />}
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-foreground/80 truncate">{d.label}</p>
                  {d.sub && <p className="text-[10px] text-muted-foreground/40 truncate">{d.sub}</p>}
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-border/20 px-3 py-2 shrink-0">
            <p className="text-[9px] text-muted-foreground/30 text-center">
              {discoveries.filter(d => d.type === "api").length} APIs · {discoveries.filter(d => d.type === "knowledge").length} insights · {discoveries.filter(d => d.type === "note").length} notes
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Avatar() {
  return (
    <div className="w-7 h-7 rounded-full bg-accent/20 border border-accent/30 flex items-center justify-center shrink-0 mt-0.5">
      <span className="text-[9px] font-display text-accent">A</span>
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
        h1: ({ children }) => <h1 className="text-lg font-bold mb-2 mt-3 first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-semibold mb-1 mt-2 first:mt-0">{children}</h3>,
        ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        code: ({ children, className }) => {
          const isBlock = className?.includes("language-");
          return isBlock
            ? <code className="block bg-black/30 border border-border/30 rounded-lg px-3 py-2 text-xs font-mono my-2 overflow-x-auto whitespace-pre">{children}</code>
            : <code className="bg-black/20 border border-border/20 rounded px-1 py-0.5 text-xs font-mono">{children}</code>;
        },
        pre: ({ children }) => <>{children}</>,
        blockquote: ({ children }) => <blockquote className="border-l-2 border-accent/40 pl-3 my-2 text-foreground/70 italic">{children}</blockquote>,
        hr: () => <hr className="border-border/30 my-3" />,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 hover:text-accent/80">{children}</a>,
        table: ({ children }) => <div className="overflow-x-auto my-2"><table className="text-xs border-collapse w-full">{children}</table></div>,
        th: ({ children }) => <th className="border border-border/30 px-2 py-1 bg-secondary/30 font-semibold text-left">{children}</th>,
        td: ({ children }) => <td className="border border-border/30 px-2 py-1">{children}</td>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function MessageBubble({ msg }: { msg: DisplayMsg }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex gap-3 max-w-3xl ${isUser ? "ml-auto flex-row-reverse" : ""}`}>
      {!isUser && <Avatar />}
      <div className={`flex-1 min-w-0 ${isUser ? "flex flex-col items-end" : ""}`}>
        <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? "bg-accent/15 border border-accent/25 text-foreground max-w-[85%] whitespace-pre-wrap"
            : "text-foreground/90"
        }`}>
          {isUser ? msg.content : <MarkdownContent content={msg.content} />}
        </div>
        {msg.toolsUsed && msg.toolsUsed.length > 0 && (
          <div className="flex items-center gap-1 mt-1 px-1">
            <Wrench className="h-2.5 w-2.5 text-accent/40" />
            <span className="text-[9px] text-muted-foreground/30">{msg.toolsUsed.join(", ")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
