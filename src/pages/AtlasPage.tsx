import { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Send, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// ── Types ──────────────────────────────────────────────────────────────────────

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

const ENV_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY as string ?? "";
const MODEL   = "claude-sonnet-4-5";

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
];

// ── Tool executor ──────────────────────────────────────────────────────────────

async function executeTool(name: string, input: Record<string, unknown>, userId: string): Promise<string> {
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

// ── Streaming pass ─────────────────────────────────────────────────────────────

interface StreamResult {
  text: string;
  toolUseBlocks: ToolUseBlock[];
  stopReason: string;
  assistantContent: ApiContentBlock[];
}

async function streamPass(
  messages: ApiMsg[],
  system: string,
  apiKey: string,
  onDelta: (text: string) => void,
  signal: AbortSignal,
  withTools = true,
): Promise<StreamResult> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key":                              apiKey,
      "anthropic-version":                      "2023-06-01",
      "content-type":                           "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model:      MODEL,
      system,
      messages,
      ...(withTools ? { tools: ATLAS_TOOLS } : {}),
      max_tokens: 4096,
      stream:     true,
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.error?.message ?? `HTTP ${res.status}`);
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
// Fires silently after each exchange — uses Haiku to extract 0-2 insights worth
// saving to the knowledge vault. Never blocks or affects the UI.

async function extractInsights(
  userMsg: string,
  assistantMsg: string,
  userId: string,
  apiKey: string,
  existingTitles: string[],
): Promise<void> {
  try {
    const titlesHint = existingTitles.slice(0, 30).join(", ");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key":           apiKey,
        "anthropic-version":   "2023-06-01",
        "content-type":        "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 1024,
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
    if (!res.ok) return;
    const j = await res.json();
    const raw = (j.content?.[0]?.text ?? "").trim().replace(/^```json\n?/, "").replace(/\n?```$/, "");
    const insights: Array<{title:string;content:string;node_type:string;tags:string[];links:string[]}> = JSON.parse(raw);
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

  const apiKey = ENV_KEY;

  const [messages,    setMessages]    = useState<DisplayMsg[]>([]);
  const [apiHistory,  setApiHistory]  = useState<ApiMsg[]>([]);
  const [input,       setInput]       = useState("");
  const [streaming,   setStreaming]   = useState(false);
  const [streamText,  setStreamText]  = useState("");
  const [toolStatus,  setToolStatus]  = useState<string | null>(null);
  const [error,       setError]       = useState<string | null>(null);

  const bottomRef   = useRef<HTMLDivElement>(null);
  const abortRef    = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText, toolStatus]);

  const send = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || streaming || !apiKey || !user) return;

    setError(null);
    setInput("");
    setStreaming(true);
    setStreamText("");
    setToolStatus(null);

    const userDisplay: DisplayMsg = { id: crypto.randomUUID(), role: "user", content: text };
    setMessages(prev => [...prev, userDisplay]);

    const newApiHistory: ApiMsg[] = [...apiHistory, { role: "user", content: text }];

    let systemContent = ATLAS_IDENTITY;
    try {
      const ctx = await buildContext(user.id);
      if (ctx) systemContent = `${ATLAS_IDENTITY}\n\n${ctx}`;
    } catch { /* non-fatal — proceed without context */ }

    abortRef.current = new AbortController();

    try {
      // First streaming pass
      const { text: responseText, toolUseBlocks, stopReason, assistantContent } =
        await streamPass(newApiHistory, systemContent, apiKey, setStreamText, abortRef.current.signal);

      if (stopReason !== "tool_use" || toolUseBlocks.length === 0) {
        // Simple response — done
        setMessages(prev => [...prev, { id: crypto.randomUUID(), role: "assistant", content: responseText || "…" }]);
        setApiHistory([...newApiHistory, { role: "assistant", content: responseText }]);
        setStreamText("");
        // Background extraction — fire-and-forget
        void (async () => {
          const { data: existing } = await supabase.from("atlas_knowledge").select("title").eq("user_id", user.id);
          void extractInsights(text, responseText, user.id, apiKey, (existing ?? []).map((r: {title:string}) => r.title));
        })();
        return;
      }

      // Tool use: execute tools
      setStreamText("");
      const toolNames = toolUseBlocks.map(t => t.name.replace(/_/g, " "));
      setToolStatus(`Running: ${toolNames.join(", ")}…`);

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (tb) => {
          let toolInput: Record<string, unknown> = {};
          try { toolInput = JSON.parse(tb.inputJson || "{}"); } catch { /* */ }
          const result = await executeTool(tb.name, toolInput, user.id);
          return { type: "tool_result" as const, tool_use_id: tb.id, content: result };
        }),
      );

      setToolStatus(null);

      // Build follow-up history with tool results
      const afterToolHistory: ApiMsg[] = [
        ...newApiHistory,
        { role: "assistant", content: assistantContent },
        { role: "user",      content: toolResults },
      ];

      // Second streaming pass — final response after tool execution
      const { text: finalText } = await streamPass(
        afterToolHistory, systemContent, apiKey,
        setStreamText, abortRef.current.signal, false,
      );

      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: finalText || "Done.",
        toolsUsed: toolNames,
      }]);
      setApiHistory(afterToolHistory);
      setStreamText("");
      // Background extraction after tool-use exchange
      void (async () => {
        const { data: existing } = await supabase.from("atlas_knowledge").select("title").eq("user_id", user.id);
        void extractInsights(text, finalText, user.id, apiKey, (existing ?? []).map((r: {title:string}) => r.title));
      })();

    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") { setStreamText(""); setToolStatus(null); return; }
      setError(e instanceof Error ? e.message : "Unknown error");
      setStreamText("");
      setToolStatus(null);
    } finally {
      setStreaming(false);
    }
  }, [input, streaming, apiKey, user, apiHistory]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  // ── Chat ──────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Header */}
      <div className="h-10 flex items-center px-4 border-b border-border/30 shrink-0">
        <span className="text-xs font-display tracking-widest text-primary">ATLAS</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6 min-h-0">

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

        {/* Tool execution status */}
        {toolStatus && (
          <div className="flex items-center gap-2 text-xs text-accent/70 pl-10">
            <Wrench className="h-3 w-3 animate-spin" />
            {toolStatus}
          </div>
        )}

        {/* Streaming bubble */}
        {streaming && streamText && (
          <div className="flex gap-3 max-w-3xl">
            <Avatar />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">{streamText}</p>
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
      </div>

      {/* Input */}
      <div className="border-t border-border/30 p-4 shrink-0">
        <div className="flex gap-2 items-end max-w-3xl mx-auto">
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
            onClick={() => void send()}
            disabled={!input.trim() || streaming}
            size="icon"
            className="shrink-0 rounded-xl bg-accent hover:bg-accent/90 text-accent-foreground disabled:opacity-30 mb-0.5"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-center text-[10px] text-muted-foreground/30 mt-2">Enter to send · Shift+Enter for new line</p>
      </div>
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

function MessageBubble({ msg }: { msg: DisplayMsg }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex gap-3 max-w-3xl ${isUser ? "ml-auto flex-row-reverse" : ""}`}>
      {!isUser && <Avatar />}
      <div className={`flex-1 min-w-0 ${isUser ? "flex flex-col items-end" : ""}`}>
        <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? "bg-accent/15 border border-accent/25 text-foreground max-w-[85%]"
            : "text-foreground/90"
        }`}>
          {msg.content}
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
