// atlas-core — main inference and routing function
// Consolidates: forge_chat, forge_execute, forge_compress, forge_learn,
//               forge_suggest, atlas_embed, atlas_autonomous_loop, atlas_self_eval
//
// Actions: chat (streaming), compress, learn, suggest, embed, autonomous_loop, self_eval

import {
  corsHeaders,
  verifyUser,
  parseEnv,
  modelEnv,
  AuthError,
  resolveUserIds,
  callGatewayWithRetry,
} from "../_shared/gateway.ts";
import {
  ATLAS_SYSTEM_PROMPT,
  TRADING_INFRASTRUCTURE_PROMPT,
  AUTONOMOUS_OPS_PROMPT,
  ADVISOR_LAYER_PROMPT,
} from "../_shared/atlas_prompt.ts";

// ─── Model helpers ─────────────────────────────────────────────────────────────
// Gateway (Lovable) needs provider prefix: "anthropic/…"
// Direct Anthropic API uses bare model IDs: "claude-…"
const ATLAS_MODEL  = (gw = false) => gw
  ? modelEnv("ATLAS_MODEL", "anthropic/claude-sonnet-4-5")
  : modelEnv("ATLAS_MODEL", "claude-sonnet-4-5");
const FAST_MODEL   = (gw = false) => gw
  ? modelEnv("FAST_MODEL", "anthropic/claude-haiku-4-5-20251001")
  : modelEnv("FAST_MODEL", "claude-haiku-4-5");

// ─── Anthropic direct client ───────────────────────────────────────────────────
async function callAnthropic(
  body: Record<string, unknown>,
  apiKey: string,
): Promise<Response> {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// ─── Intent classification ─────────────────────────────────────────────────────
type Intent = "conversation" | "advisory" | "operational" | "command";

async function classifyIntent(text: string, apiKey: string, useGateway = false): Promise<Intent> {
  try {
    const systemPrompt = `Classify this message. Return ONLY one word — no explanation, no punctuation.
conversation — casual, open-ended, philosophical, general market talk, life
advisory — explicitly asking for analysis, recommendation, "what do you think", "run the numbers", thesis
operational — asking about positions, trades, P&L, pipeline, balance sheet, income, leases
command — explicit action request: "scan forex", "execute", "run the brief", "send outreach"`;

    let resp: Response;
    if (useGateway) {
      resp = await callGatewayWithRetry({
        model: FAST_MODEL(true),
        max_completion_tokens: 5,
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text.slice(0, 400) },
        ],
      }, apiKey);
      if (!resp.ok) return "conversation";
      const data = await resp.json();
      const raw = (data?.choices?.[0]?.message?.content ?? "").trim().toLowerCase();
      if (["conversation", "advisory", "operational", "command"].includes(raw)) return raw as Intent;
      return "conversation";
    } else {
      resp = await callAnthropic({
        model: FAST_MODEL(),
        max_tokens: 5,
        system: systemPrompt,
        messages: [{ role: "user", content: text.slice(0, 400) }],
      }, apiKey);
      if (!resp.ok) return "conversation";
      const data = await resp.json();
      const raw = (data?.content?.[0]?.text ?? "").trim().toLowerCase();
      if (["conversation", "advisory", "operational", "command"].includes(raw)) return raw as Intent;
      return "conversation";
    }
  } catch {
    return "conversation";
  }
}

// ─── DB helpers ────────────────────────────────────────────────────────────────
function dbHeaders(serviceKey: string) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };
}

async function dbGet(url: string, serviceKey: string): Promise<unknown[]> {
  try {
    const resp = await fetch(url, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    return resp.ok ? await resp.json() : [];
  } catch {
    return [];
  }
}

async function dbPost(url: string, serviceKey: string, payload: unknown): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: dbHeaders(serviceKey),
      body: JSON.stringify(payload),
    });
  } catch { /* non-critical */ }
}

// ─── Context loaders ───────────────────────────────────────────────────────────

async function loadUserContext(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<{
  dossier: unknown;
  preferences: unknown[];
  recentMemories: unknown[];
  pendingDecisions: unknown[];
  portfolioState: unknown;
}> {
  const [dossierRows, preferences, recentMemories, pendingDecisions, portfolioStateRows] =
    await Promise.all([
      dbGet(`${supabaseUrl}/rest/v1/rpc/get_forge_context`, serviceKey).catch(() => []),
      dbGet(
        `${supabaseUrl}/rest/v1/atlas_user_preferences?user_id=eq.${userId}&select=category,key,value,confidence&limit=50`,
        serviceKey,
      ),
      (async () => {
        try {
          const r = await fetch(
            `${supabaseUrl}/rest/v1/atlas_memory?user_id=eq.${userId}&order=created_at.desc&limit=20&select=role,content,created_at`,
            { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
          );
          return r.ok ? await r.json() : [];
        } catch { return []; }
      })(),
      (async () => {
        try {
          const r = await fetch(
            `${supabaseUrl}/rest/v1/atlas_decision_queue?user_id=eq.${userId}&status=eq.pending&order=created_at.desc&limit=10&select=id,decision_type,color,summary,created_at`,
            { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
          );
          return r.ok ? await r.json() : [];
        } catch { return []; }
      })(),
      (async () => {
        try {
          const r = await fetch(
            `${supabaseUrl}/rest/v1/atlas_portfolio_state?user_id=eq.${userId}&order=updated_at.desc&limit=1`,
            { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
          );
          return r.ok ? await r.json() : [];
        } catch { return []; }
      })(),
    ]);

  // get_forge_context is an RPC — call it properly
  let dossier: unknown = {};
  try {
    const ctxResp = await fetch(`${supabaseUrl}/rest/v1/rpc/get_forge_context`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ _user_id: userId }),
    });
    if (ctxResp.ok) dossier = await ctxResp.json();
  } catch { /* ignore */ }

  return {
    dossier,
    preferences: Array.isArray(preferences) ? preferences : [],
    recentMemories: Array.isArray(recentMemories) ? recentMemories : [],
    pendingDecisions: Array.isArray(pendingDecisions) ? pendingDecisions : [],
    portfolioState: Array.isArray(portfolioStateRows) ? (portfolioStateRows[0] ?? null) : null,
  };
}

async function storeMemory(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  role: string,
  content: string,
): Promise<void> {
  await dbPost(`${supabaseUrl}/rest/v1/atlas_memory`, serviceKey, {
    user_id: userId,
    role,
    content: content.slice(0, 4000),
    created_at: new Date().toISOString(),
  });
}

// ─── System prompt builder ─────────────────────────────────────────────────────
function buildSystemPrompt(
  ctx: { dossier: unknown; preferences: unknown[]; recentMemories: unknown[]; pendingDecisions: unknown[]; portfolioState: unknown },
  intent: Intent,
  isAutonomous: boolean,
): string {
  const parts: string[] = [ATLAS_SYSTEM_PROMPT, TRADING_INFRASTRUCTURE_PROMPT];
  if (isAutonomous) parts.push(AUTONOMOUS_OPS_PROMPT);
  parts.push(ADVISOR_LAYER_PROMPT);

  const d = (ctx.dossier && typeof ctx.dossier === "object") ? ctx.dossier as Record<string, unknown> : {};

  // Operator context
  const ctxLines: string[] = ["OPERATOR CONTEXT"];
  if (d.full_name) ctxLines.push(`Name: ${d.full_name}`);
  if (d.trajectory_sentence) ctxLines.push(`Trajectory: ${d.trajectory_sentence}`);
  const dossierObj = d.dossier && typeof d.dossier === "object" ? d.dossier as Record<string, unknown> : {};
  if (dossierObj.risk_tolerance) ctxLines.push(`Risk tolerance: ${dossierObj.risk_tolerance}`);
  if (dossierObj.trading_goals) ctxLines.push(`Trading goals: ${dossierObj.trading_goals}`);
  if (dossierObj.current_focus) ctxLines.push(`Current focus: ${dossierObj.current_focus}`);
  if (ctxLines.length > 1) parts.push(ctxLines.join("\n"));

  // Preferences
  if (ctx.preferences.length > 0) {
    const prefLines = ["USER PREFERENCES (calibrate your voice):"];
    for (const p of ctx.preferences as Array<{ category: string; value: string; confidence?: number }>) {
      if (p.category && p.value) {
        const conf = Math.round((p.confidence ?? 0.5) * 100);
        prefLines.push(`  [${p.category}] ${p.value} (${conf}%)`);
      }
    }
    parts.push(prefLines.join("\n"));
  }

  // Recent memories
  if (ctx.recentMemories.length > 0) {
    const memLines = ["RECENT CONVERSATION HISTORY:"];
    for (const m of (ctx.recentMemories as Array<{ role: string; content: string; created_at: string }>).slice(0, 10)) {
      memLines.push(`[${m.role}] ${String(m.content).slice(0, 200)}`);
    }
    parts.push(memLines.join("\n"));
  }

  // Pending decisions
  if (ctx.pendingDecisions.length > 0) {
    const decLines = ["PENDING DECISIONS REQUIRING ATTENTION:"];
    for (const dec of ctx.pendingDecisions as Array<{ color: string; summary: string; decision_type: string }>) {
      decLines.push(`  [${dec.color}] ${dec.decision_type}: ${dec.summary}`);
    }
    parts.push(decLines.join("\n"));
  }

  // Portfolio state
  if (ctx.portfolioState) {
    const ps = ctx.portfolioState as Record<string, unknown>;
    parts.push(`PORTFOLIO STATE: Net worth $${Number(ps.net_worth_usd ?? 0).toLocaleString()} | Rebalancing needed: ${ps.rebalancing_needed ?? false}`);
  }

  return parts.join("\n\n═══════════════════════════════════════════════════════════\n\n");
}

// ─── Wealth state builder (operational/command mode) ──────────────────────────
async function buildWealthState(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<string> {
  const today = new Date().toISOString().split("T")[0];
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split("T")[0];
  const hdrs = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  const [openTradesRes, todayTradesRes, bizPipeRes, bizLedgerRes, portfolioRes, leasesRes, bsRes] =
    await Promise.all([
      fetch(`${supabaseUrl}/rest/v1/trade_ledger?user_id=eq.${userId}&status=eq.open&select=symbol,direction,pnl_usd&limit=20`, { headers: hdrs }),
      fetch(`${supabaseUrl}/rest/v1/trade_ledger?user_id=eq.${userId}&status=eq.closed&closed_at=gte.${today}&select=symbol,direction,pnl_usd`, { headers: hdrs }),
      fetch(`${supabaseUrl}/rest/v1/business_pipeline?user_id=eq.${userId}&select=contact_name,stage,estimated_value_usd,probability_pct,next_action_due&limit=15`, { headers: hdrs }),
      fetch(`${supabaseUrl}/rest/v1/business_ledger?user_id=eq.${userId}&created_at=gte.${monthStart}&select=entry_type,amount_usd,status`, { headers: hdrs }),
      fetch(`${supabaseUrl}/rest/v1/property_portfolio?user_id=eq.${userId}&status=eq.active&select=current_value,mortgage_balance,gross_rent_monthly,mortgage_payment_monthly`, { headers: hdrs }),
      fetch(`${supabaseUrl}/rest/v1/lease_tracker?user_id=eq.${userId}&status=eq.active&select=lease_end&limit=20`, { headers: hdrs }),
      fetch(`${supabaseUrl}/rest/v1/balance_sheet_snapshots?user_id=eq.${userId}&order=snapshot_date.desc&limit=1&select=snapshot_date,net_worth_usd,paper_assets_pct,business_pct,re_pct,cash_pct`, { headers: hdrs }),
    ]);

  const openTrades = openTradesRes.ok ? await openTradesRes.json() as Array<{ symbol: string; direction: string; pnl_usd: number | null }> : [];
  const todayTrades = todayTradesRes.ok ? await todayTradesRes.json() as Array<{ pnl_usd: number | null }> : [];
  const bizPipe = bizPipeRes.ok ? await bizPipeRes.json() as Array<{ contact_name: string; stage: string; estimated_value_usd: number | null; probability_pct: number | null; next_action_due: string | null }> : [];
  const bizLedger = bizLedgerRes.ok ? await bizLedgerRes.json() as Array<{ entry_type: string; amount_usd: number; status: string }> : [];
  const portfolio = portfolioRes.ok ? await portfolioRes.json() as Array<{ current_value: number | null; mortgage_balance: number | null; gross_rent_monthly: number | null; mortgage_payment_monthly: number | null }> : [];
  const leases = leasesRes.ok ? await leasesRes.json() as Array<{ lease_end: string }> : [];
  const bsSnaps = bsRes.ok ? await bsRes.json() as Array<Record<string, unknown>> : [];

  const todayPnl = todayTrades.reduce((s, t) => s + Number(t.pnl_usd ?? 0), 0);
  const bizRevenue = bizLedger.filter(e => e.entry_type === "revenue" && e.status === "paid").reduce((s, e) => s + Number(e.amount_usd), 0);
  const bizExpenses = bizLedger.filter(e => e.entry_type === "expense").reduce((s, e) => s + Number(e.amount_usd), 0);
  const bizPipeValue = bizPipe.reduce((s, p) => s + (Number(p.estimated_value_usd ?? 0) * Number(p.probability_pct ?? 50) / 100), 0);
  const reValue = portfolio.reduce((s, p) => s + Number(p.current_value ?? 0), 0);
  const reMortgage = portfolio.reduce((s, p) => s + Number(p.mortgage_balance ?? 0), 0);
  const reRent = portfolio.reduce((s, p) => s + Number(p.gross_rent_monthly ?? 0), 0);
  const reDebt = portfolio.reduce((s, p) => s + Number(p.mortgage_payment_monthly ?? 0), 0);
  const expiringLeases = leases.filter(l => Math.ceil((new Date(l.lease_end).getTime() - Date.now()) / 86400000) <= 90).length;
  const overdue = bizPipe.filter(p => p.next_action_due && new Date(p.next_action_due) < new Date() && !["closed_won", "closed_lost"].includes(p.stage));
  const bs = bsSnaps[0];

  return [
    "CURRENT WEALTH STATE",
    `TRADING: ${openTrades.length} open positions | Today P&L: $${todayPnl.toFixed(2)}`,
    openTrades.length > 0 ? `Positions: ${openTrades.slice(0, 5).map(t => `${t.symbol} ${t.direction} ($${Number(t.pnl_usd ?? 0).toFixed(0)})`).join(" | ")}` : "No open positions.",
    `BUSINESS: Revenue MTD $${bizRevenue.toLocaleString()} | Expenses $${bizExpenses.toLocaleString()} | Net $${(bizRevenue - bizExpenses).toLocaleString()} | Pipeline $${bizPipeValue.toLocaleString()}`,
    overdue.length > 0 ? `OVERDUE: ${overdue.slice(0, 3).map(p => `${p.contact_name ?? "contact"} [${p.stage}]`).join(", ")}` : "Pipeline current.",
    `REAL ESTATE: ${portfolio.length} properties | Value $${reValue.toLocaleString()} | Equity $${(reValue - reMortgage).toLocaleString()} | Net CF $${(reRent - reDebt).toLocaleString()}/mo`,
    expiringLeases > 0 ? `WARNING: ${expiringLeases} lease(s) expiring within 90 days` : "Leases stable.",
    bs ? `BALANCE SHEET (${bs.snapshot_date}): Net worth $${Number(bs.net_worth_usd ?? 0).toLocaleString()} | Paper ${Number(bs.paper_assets_pct ?? 0).toFixed(1)}% / Biz ${Number(bs.business_pct ?? 0).toFixed(1)}% / RE ${Number(bs.re_pct ?? 0).toFixed(1)}% / Cash ${Number(bs.cash_pct ?? 0).toFixed(1)}%` : "Balance sheet not yet computed.",
  ].join("\n");
}

// ─── Action: chat (streaming via Lovable AI Gateway) ──────────────────────────
async function handleChat(
  req: Request,
  supabaseUrl: string,
  serviceKey: string,
  _apiKey: string,
  userId: string,
  useGateway = false,
): Promise<Response> {
  const body = await req.json();
  const mode: string = body.mode ?? "chat";

  // Accept both new shape ({message, history, system, attachment}) from AtlasChat
  // and legacy shape ({messages, attachments}) from older callers.
  type GMsg = { role: string; content: unknown };
  let messages: GMsg[] = [];
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    messages = body.messages as GMsg[];
  } else {
    if (Array.isArray(body.history)) {
      for (const h of body.history) {
        if (h && typeof h.role === "string" && typeof h.content === "string") {
          messages.push({ role: h.role, content: h.content });
        }
      }
    }
    if (typeof body.message === "string" && body.message.trim()) {
      messages.push({ role: "user", content: body.message });
    }
  }
  if (messages.length === 0) {
    messages = [{ role: "user", content: "[Operator just opened the app.]" }];
  }

  // Attachments — gateway/Gemini accept OpenAI-style image_url blocks.
  const attachments: Array<{ name: string; media_type: string; data: string }> =
    Array.isArray(body.attachments)
      ? body.attachments
      : body.attachment
        ? [body.attachment]
        : [];

  if (attachments.length > 0) {
    const blocks: unknown[] = attachments.map((a) => {
      if (a.media_type?.startsWith("image/")) {
        return {
          type: "image_url",
          image_url: { url: `data:${a.media_type};base64,${a.data}` },
        };
      }
      // Non-image: inline as text so the model still sees it.
      try {
        return { type: "text", text: `[Attached file ${a.name}]\n${atob(a.data).slice(0, 8000)}` };
      } catch {
        return { type: "text", text: `[Attached file ${a.name}]` };
      }
    });
    const lastUserIdx = [...messages].map((m, i) => ({ m, i }))
      .reverse().find(({ m }) => m.role === "user")?.i;
    if (lastUserIdx !== undefined) {
      const last = messages[lastUserIdx];
      const baseText = typeof last.content === "string" ? last.content : "";
      messages[lastUserIdx] = {
        role: "user",
        content: [...blocks, { type: "text", text: baseText }],
      };
    }
  }

  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const messageText = typeof lastUserMessage === "string"
    ? lastUserMessage
    : Array.isArray(lastUserMessage)
      ? (lastUserMessage as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ")
      : "";

  const ctx = await loadUserContext(supabaseUrl, serviceKey, userId);
  const baseSystem = typeof body.system === "string" && body.system.trim()
    ? body.system
    : buildSystemPrompt(ctx, "conversation", true);

  const systemParts: string[] = [baseSystem];
  if (mode === "intake") {
    systemParts.push("This is a first meeting. Lead with genuine curiosity. One question at a time. Don't give advice yet. Listen.");
  }
  if (mode === "directive") {
    systemParts.push("Generate ONE directive sentence for today based on the operator context. Under 20 words. Specific. Return ONLY the sentence.");
  }
  if (body.opening && mode === "chat") {
    systemParts.push("The operator just opened the app. Open naturally with something specific and true from what you know about them.");
  }

  const LOVABLE_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_KEY) {
    return new Response(JSON.stringify({ error: "LOVABLE_API_KEY not configured" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const gatewayMessages = [
    { role: "system", content: systemParts.join("\n\n") },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${LOVABLE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelEnv("ATLAS_MODEL", "google/gemini-2.5-flash"),
      stream: true,
      messages: gatewayMessages,
    }),
  });

  if (!aiResp.ok || !aiResp.body) {
    const errText = await aiResp.text().catch(() => "");
    console.error("[atlas-core/chat] Gateway error:", aiResp.status, errText);
    const status = aiResp.status === 429 ? 429 : aiResp.status === 402 ? 402 : 502;
    return new Response(JSON.stringify({ error: "AI gateway error", status: aiResp.status, detail: errText.slice(0, 500) }), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (messageText) {
    storeMemory(supabaseUrl, serviceKey, userId, "user", messageText).catch(() => {});
  }

  return new Response(aiResp.body, {
    headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

// ─── Action: compress ──────────────────────────────────────────────────────────
async function handleCompress(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const messages = Array.isArray(body.messages) ? body.messages as Array<{ role: string; content: string }> : [];
  if (messages.length < 6) {
    return new Response(JSON.stringify({ error: "Not enough messages to compress (min 6)" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const transcript = messages.map(m => `${m.role}: ${String(m.content).slice(0, 500)}`).join("\n");
  const resp = await callAnthropic({
    model: FAST_MODEL(),
    max_tokens: 1200,
    system: "You compress conversations for an AI wealth system. Extract: key decisions made, open commitments, patterns observed, emotional signals, business/trade/RE actions taken. Return JSON: {summary: string, decisions: string[], commitments: string[], patterns: string[], actions: string[]}. Be dense and specific.",
    messages: [{ role: "user", content: transcript }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Compress AI call failed: ${resp.status}`);
  const data = await resp.json();
  const content = data?.content?.[0]?.text ?? "{}";
  let compressed: Record<string, unknown> = {};
  try {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1 && end !== -1) compressed = JSON.parse(content.slice(start, end + 1));
  } catch { compressed = { summary: content }; }

  // Store compressed summary to memory
  await storeMemory(supabaseUrl, serviceKey, userId, "system", `[COMPRESSED] ${compressed.summary ?? content}`);

  return new Response(JSON.stringify({ compressed, message_count: messages.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Action: learn ─────────────────────────────────────────────────────────────
async function handleLearn(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const messages = Array.isArray(body.messages) ? body.messages as Array<{ role: string; content: string }> : [];
  if (messages.length === 0) {
    return new Response(JSON.stringify({ patterns: [] }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const transcript = messages.slice(-20).map(m => `${m.role}: ${String(m.content).slice(0, 300)}`).join("\n");
  const resp = await callAnthropic({
    model: FAST_MODEL(),
    max_tokens: 800,
    system: `Extract behavioral patterns from this conversation for an AI wealth assistant to learn.
Return JSON array of pattern objects: [{category: "communication"|"trading_style"|"interest"|"behavioral"|"emotional", key: string, value: string, confidence: 0.0-1.0}]
Only extract clear, specific patterns with confidence > 0.6. Return [] if nothing clear.`,
    messages: [{ role: "user", content: transcript }],
  }, apiKey);

  if (!resp.ok) return new Response(JSON.stringify({ patterns: [] }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const data = await resp.json();
  const content = data?.content?.[0]?.text ?? "[]";
  let patterns: Array<{ category: string; key: string; value: string; confidence: number }> = [];
  try {
    const start = content.indexOf("[");
    const end = content.lastIndexOf("]");
    if (start !== -1 && end !== -1) patterns = JSON.parse(content.slice(start, end + 1));
  } catch { patterns = []; }

  // Upsert patterns to preferences table
  for (const p of patterns) {
    if (!p.category || !p.key || !p.value) continue;
    await fetch(`${supabaseUrl}/rest/v1/atlas_user_preferences`, {
      method: "POST",
      headers: { ...dbHeaders(serviceKey), Prefer: "return=minimal,resolution=merge-duplicates" },
      body: JSON.stringify({ user_id: userId, category: p.category, key: p.key, value: p.value, confidence: p.confidence, updated_at: new Date().toISOString() }),
    }).catch(() => {});
  }

  return new Response(JSON.stringify({ patterns, extracted: patterns.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Action: suggest ──────────────────────────────────────────────────────────
async function handleSuggest(
  body: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const messages = Array.isArray(body.messages) ? body.messages as Array<{ role: string; content: string }> : [];
  const ctx = await loadUserContext(supabaseUrl, serviceKey, userId);

  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant")?.content ?? "";
  const lastUser = [...messages].reverse().find(m => m.role === "user")?.content ?? "";

  const resp = await callAnthropic({
    model: FAST_MODEL(),
    max_tokens: 300,
    system: "Generate 3 short (max 8 words each) next-step suggestions for this conversation with Atlas, the AI wealth engine. Return JSON array of strings. Keep them actionable and specific to what was just discussed.",
    messages: [{
      role: "user",
      content: `Last user: ${String(lastUser).slice(0, 200)}\nLast Atlas: ${String(lastAssistant).slice(0, 200)}`,
    }],
  }, apiKey);

  if (!resp.ok) return new Response(JSON.stringify({ suggestions: [] }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const data = await resp.json();
  const content = data?.content?.[0]?.text ?? "[]";
  let suggestions: string[] = [];
  try {
    const start = content.indexOf("[");
    const end = content.lastIndexOf("]");
    if (start !== -1 && end !== -1) suggestions = JSON.parse(content.slice(start, end + 1));
  } catch { suggestions = []; }

  return new Response(JSON.stringify({ suggestions: suggestions.slice(0, 3) }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Action: embed ─────────────────────────────────────────────────────────────
async function handleEmbed(
  body: Record<string, unknown>,
  apiKey: string,
): Promise<Response> {
  const text = body.text as string;
  if (!text) return new Response(JSON.stringify({ error: "text required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  // Anthropic does not yet have a public embeddings API — use a hash-based stub
  // When Anthropic releases embeddings, replace this with the actual API call
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-512", data);
  const hashArray = new Uint8Array(hashBuffer);
  // Produce a 1536-dim normalized float vector from repeated SHA-512
  const dims = 1536;
  const vector: number[] = [];
  let sum = 0;
  for (let i = 0; i < dims; i++) {
    const v = (hashArray[i % hashArray.length] / 255) * 2 - 1;
    vector.push(v);
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  const normalized = vector.map(v => v / norm);

  return new Response(JSON.stringify({ embedding: normalized, dimensions: dims, model: "hash-stub" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Action: autonomous_loop ───────────────────────────────────────────────────
async function handleAutonomousLoop(
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
): Promise<Response> {
  const hdrs = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  // Pull pending tasks
  let tasks: Array<{ id: string; user_id: string; task_type: string; payload: Record<string, unknown>; status: string }> = [];
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/atlas_tasks?status=eq.queued&order=created_at.asc&limit=10`, { headers: hdrs });
    if (r.ok) tasks = await r.json();
  } catch { /* ignore */ }

  // Pull GREEN decisions (approved for autonomous execution)
  let greenDecisions: Array<{ id: string; user_id: string; decision_type: string; payload: Record<string, unknown> }> = [];
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/atlas_decision_queue?color=eq.GREEN&status=eq.approved&order=created_at.asc&limit=10`, { headers: hdrs });
    if (r.ok) greenDecisions = await r.json();
  } catch { /* ignore */ }

  const processed: string[] = [];

  // Process queued tasks
  for (const task of tasks) {
    try {
      // Mark as running
      await fetch(`${supabaseUrl}/rest/v1/atlas_tasks?id=eq.${task.id}`, {
        method: "PATCH",
        headers: { ...hdrs, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ status: "running", started_at: new Date().toISOString() }),
      });

      // Dispatch to relevant sub-function
      const fnMap: Record<string, string> = {
        forex_scan: "atlas-trade",
        opportunity_scan: "atlas-trade",
        market_brief: "atlas-trade",
        re_brief: "atlas-re",
        deal_scan: "atlas-re",
        lease_monitor: "atlas-re",
        balance_sheet: "atlas-portfolio",
        morning_brief: "atlas-signal",
        weekly_review: "atlas-signal",
        scout: "atlas-business",
        monitor: "atlas-business",
      };

      const targetFn = fnMap[task.task_type];
      if (targetFn) {
        const dispatchResp = await fetch(`${supabaseUrl}/functions/v1/${targetFn}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ action: task.task_type, user_id: task.user_id, ...task.payload }),
        });
        const result = dispatchResp.ok ? "dispatched" : `dispatch_error_${dispatchResp.status}`;
        processed.push(`${task.task_type}:${result}`);

        await fetch(`${supabaseUrl}/rest/v1/atlas_tasks?id=eq.${task.id}`, {
          method: "PATCH",
          headers: { ...hdrs, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ status: "done", completed_at: new Date().toISOString(), result }),
        });
      } else {
        processed.push(`${task.task_type}:no_handler`);
        await fetch(`${supabaseUrl}/rest/v1/atlas_tasks?id=eq.${task.id}`, {
          method: "PATCH",
          headers: { ...hdrs, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ status: "skipped" }),
        });
      }
    } catch (e) {
      processed.push(`${task.task_type}:error`);
      await fetch(`${supabaseUrl}/rest/v1/atlas_tasks?id=eq.${task.id}`, {
        method: "PATCH",
        headers: { ...hdrs, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ status: "failed", error: e instanceof Error ? e.message : String(e) }),
      }).catch(() => {});
    }
  }

  // Mark processed decisions as executed
  for (const dec of greenDecisions) {
    try {
      await fetch(`${supabaseUrl}/rest/v1/atlas_decision_queue?id=eq.${dec.id}`, {
        method: "PATCH",
        headers: { ...hdrs, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ status: "executed", executed_at: new Date().toISOString() }),
      });
      processed.push(`decision:${dec.decision_type}:executed`);
    } catch { /* ignore */ }
  }

  return new Response(JSON.stringify({
    processed,
    tasks_processed: tasks.length,
    decisions_processed: greenDecisions.length,
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Action: self_eval ─────────────────────────────────────────────────────────
async function handleSelfEval(
  supabaseUrl: string,
  serviceKey: string,
  apiKey: string,
  userId: string,
): Promise<Response> {
  const hdrs = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();

  const [tradesRes, decisionsRes, tasksRes] = await Promise.all([
    fetch(`${supabaseUrl}/rest/v1/trade_ledger?user_id=eq.${userId}&closed_at=gte.${thirtyDaysAgo}&status=eq.closed&select=symbol,direction,pnl_usd,entry_price,quantity`, { headers: hdrs }),
    fetch(`${supabaseUrl}/rest/v1/atlas_decision_queue?user_id=eq.${userId}&created_at=gte.${thirtyDaysAgo}&select=color,decision_type,status`, { headers: hdrs }),
    fetch(`${supabaseUrl}/rest/v1/atlas_tasks?user_id=eq.${userId}&created_at=gte.${thirtyDaysAgo}&select=task_type,status`, { headers: hdrs }),
  ]);

  const trades = tradesRes.ok ? await tradesRes.json() as Array<{ pnl_usd: number | null; direction: string }> : [];
  const decisions = decisionsRes.ok ? await decisionsRes.json() as Array<{ color: string; decision_type: string; status: string }> : [];
  const tasks = tasksRes.ok ? await tasksRes.json() as Array<{ task_type: string; status: string }> : [];

  const totalPnl = trades.reduce((s, t) => s + Number(t.pnl_usd ?? 0), 0);
  const winRate = trades.length > 0 ? (trades.filter(t => Number(t.pnl_usd ?? 0) > 0).length / trades.length * 100).toFixed(1) : "N/A";
  const executedDecisions = decisions.filter(d => d.status === "executed").length;
  const completedTasks = tasks.filter(t => t.status === "done").length;

  const evalPrompt = `You are Atlas performing a 30-day self-evaluation of your autonomous wealth management performance.

TRADING PERFORMANCE:
- Closed trades: ${trades.length}
- Total P&L: $${totalPnl.toFixed(2)}
- Win rate: ${winRate}%

DECISION QUALITY:
- Total decisions queued: ${decisions.length}
- Executed: ${executedDecisions}
- Pending: ${decisions.filter(d => d.status === "pending").length}
- By color: GREEN ${decisions.filter(d => d.color === "GREEN").length} | YELLOW ${decisions.filter(d => d.color === "YELLOW").length} | ORANGE ${decisions.filter(d => d.color === "ORANGE").length} | RED ${decisions.filter(d => d.color === "RED").length}

TASK COMPLETION:
- Total tasks: ${tasks.length}
- Completed: ${completedTasks}
- Failed: ${tasks.filter(t => t.status === "failed").length}

Evaluate:
1. Trading performance vs $100/day target
2. Decision quality and calibration
3. Task execution efficiency
4. One specific improvement for next 30 days
5. Overall performance score (1-10) with brief justification

Be direct and honest. This is an internal self-assessment.`;

  const resp = await callAnthropic({
    model: ATLAS_MODEL(),
    max_tokens: 1200,
    system: ATLAS_SYSTEM_PROMPT,
    messages: [{ role: "user", content: evalPrompt }],
  }, apiKey);

  if (!resp.ok) throw new Error(`Self-eval AI call failed: ${resp.status}`);
  const data = await resp.json();
  const evaluation = data?.content?.[0]?.text ?? "Evaluation failed.";

  // Store evaluation
  await fetch(`${supabaseUrl}/rest/v1/research_notes`, {
    method: "POST",
    headers: { ...dbHeaders(serviceKey), Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: userId,
      title: `Atlas Self-Evaluation — ${new Date().toISOString().split("T")[0]}`,
      content: evaluation,
      note_type: "research",
      synced_to_obsidian: false,
    }),
  }).catch(() => {});

  return new Response(JSON.stringify({
    evaluation,
    metrics: { trades: trades.length, total_pnl: totalPnl, win_rate: winRate, decisions_executed: executedDecisions, tasks_completed: completedTasks },
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ─── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL   = parseEnv("SUPABASE_URL");
    const SERVICE_KEY    = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    // Try ANTHROPIC_API_KEY first (direct API); fall back to LOVABLE_API_KEY (Lovable gateway)
    const ANTHROPIC_KEY  = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
    const LOVABLE_KEY    = Deno.env.get("LOVABLE_API_KEY") ?? "";
    const API_KEY        = ANTHROPIC_KEY || LOVABLE_KEY;
    const USE_GATEWAY    = !ANTHROPIC_KEY && !!LOVABLE_KEY;
    if (!API_KEY) throw new Error("No AI API key configured — set ANTHROPIC_API_KEY or LOVABLE_API_KEY");

    const rawBody = await req.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(rawBody); } catch { /* empty body for cron */ }

    const action = (body.action as string) ?? "chat";

    // Autonomous/cron actions skip user auth
    if (action === "autonomous_loop") {
      return await handleAutonomousLoop(SUPABASE_URL, SERVICE_KEY, API_KEY);
    }

    // User-facing actions require auth
    let userId: string;
    try {
      userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    } catch (e) {
      if (e instanceof AuthError) {
        // Allow service-role bypass for cron
        const serviceAuth = req.headers.get("Authorization")?.replace("Bearer ", "");
        if (serviceAuth === SERVICE_KEY) {
          userId = (body.user_id as string) ?? "system";
        } else {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      } else throw e;
    }

    // Re-parse body with request clone for chat (needs stream)
    if (action === "chat") {
      const chatReq = new Request(req.url, {
        method: req.method,
        headers: req.headers,
        body: rawBody,
      });
      return await handleChat(chatReq, SUPABASE_URL, SERVICE_KEY, API_KEY, userId, USE_GATEWAY);
    }

    switch (action) {
      case "compress":
        return await handleCompress(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "learn":
        return await handleLearn(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "suggest":
        return await handleSuggest(body, SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      case "embed":
        return await handleEmbed(body, API_KEY);
      case "self_eval":
        return await handleSelfEval(SUPABASE_URL, SERVICE_KEY, API_KEY, userId);
      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
  } catch (e) {
    if (e instanceof AuthError) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.error("[atlas-core] Error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
