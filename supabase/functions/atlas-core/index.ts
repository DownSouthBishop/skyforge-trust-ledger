// atlas-core — Atlas chat proxy with full read/write tool access across every tab.
// Streams Anthropic-style SSE so the existing AtlasPage parser keeps working.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sseText(message: string): Response {
  const encoder = new TextEncoder();
  const safe = message.trim() || "Atlas is temporarily unavailable.";
  const events = [
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: safe } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";

  return new Response(encoder.encode(events), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

async function verifyToken(authHeader: string | null, supabaseUrl: string, serviceKey: string): Promise<string> {
  if (!authHeader) throw new Error("Missing Authorization header");
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) throw new Error("Empty token");
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (payload?.role === "service_role") return "system";
  } catch { /* ignore */ }
  const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: serviceKey },
  });
  if (!resp.ok) throw new Error(`Auth failed: ${resp.status}`);
  const data = await resp.json();
  if (!data?.id) throw new Error("No user ID in token");
  return data.id as string;
}

function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// ============ Atlas tool surface — full read/write across every tab ============

// Whitelist of tables Atlas can touch. user_id column is auto-scoped to the caller.
const TABLES: Record<string, { userCol?: string; allowWrite: boolean }> = {
  receipts_ledger:        { userCol: "provider_id", allowWrite: true },
  skyforge_clients:       { userCol: "user_id",     allowWrite: true },
  forge_dossier:          { userCol: "user_id",     allowWrite: true },
  forge_commitments:      { userCol: "user_id",     allowWrite: true },
  forge_sticky_memory:    { userCol: "user_id",     allowWrite: true },
  forge_messages:         { userCol: "user_id",     allowWrite: true },
  forge_directives:       { userCol: "user_id",     allowWrite: true },
  forge_alerts:           { userCol: "user_id",     allowWrite: true },
  arsenal_items:          { userCol: "user_id",     allowWrite: true },
  arsenal_results:        { userCol: "user_id",     allowWrite: true },
  market_watchlist:       { userCol: "user_id",     allowWrite: true },
  trade_ledger:           { userCol: "user_id",     allowWrite: true },
  trading_accounts:       { userCol: "user_id",     allowWrite: true },
  directives_daily:       { userCol: "user_id",     allowWrite: true },
  income_goals:           { userCol: "user_id",     allowWrite: true },
  income_pipeline:        { userCol: "user_id",     allowWrite: true },
  research_notes:         { userCol: "user_id",     allowWrite: true },
  skyforge_agents:        { userCol: "user_id",     allowWrite: true },
  atlas_mcp_connections:  { userCol: "user_id",     allowWrite: true },
  shared_operator_memory: { userCol: "user_id",     allowWrite: true },
  agent_chat_messages:    { userCol: "user_id",     allowWrite: true },
  agent_chat_threads:     { userCol: "user_id",     allowWrite: true },
  user_profiles:          { userCol: "user_id",     allowWrite: true },
  atlas_capabilities:     { userCol: "user_id",     allowWrite: true },
  atlas_vault:            { userCol: "user_id",     allowWrite: true },
  atlas_receipts:         { userCol: "user_id",     allowWrite: true },
  atlas_approvals:        { userCol: "user_id",     allowWrite: true },
  // atlas_browser_commands intentionally NOT whitelisted — the worker queue
  // (atlas-browser endpoint) is the single source of truth for browser execution.
};

// Action categories that always require explicit user approval before execution.
const RESTRICTED_CATEGORIES = new Set([
  "purchase","payment","email","account_create","account_delete",
  "credential_change","file_delete","software_install","capability_install",
]);
// Browser commands that are auto-executable vs require approval.
const BROWSER_SAFE = new Set(["navigate","search","extract","screenshot","read","scrape","download"]);
const BROWSER_CAUTION = new Set(["click","type","fill","upload","login"]);

const TOOLS = [
  {
    name: "read_table",
    description: "Read rows from any operator data table. Always scoped to the current operator. Use for receipts, clients, dossier, commitments, arsenal, watchlist, trades, directives, agents, MCP connections, shared memory, etc.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name (e.g. receipts_ledger, skyforge_clients, forge_dossier, arsenal_items, market_watchlist, trade_ledger, directives_daily, skyforge_agents, atlas_mcp_connections, shared_operator_memory)." },
        filter: { type: "object", description: "Optional column=value equality filters.", additionalProperties: true },
        order_by: { type: "string", description: "Column to order by, e.g. 'created_at.desc'." },
        limit: { type: "number", description: "Row limit (default 50, max 200)." },
      },
      required: ["table"],
    },
  },
  {
    name: "write_record",
    description: "Insert, update, or delete a row in any operator data table. user_id is auto-set. Use for logging receipts, updating the dossier, creating commitments, dismissing alerts, adding arsenal items, watchlist entries, trades, directives, agents, MCP connections, etc.",
    input_schema: {
      type: "object",
      properties: {
        table:  { type: "string" },
        action: { type: "string", enum: ["insert", "update", "delete", "upsert"] },
        data:   { type: "object", description: "Row payload for insert/update/upsert.", additionalProperties: true },
        match:  { type: "object", description: "Equality filters for update/delete (e.g. {id: '...'}).", additionalProperties: true },
        on_conflict: { type: "string", description: "Comma-separated columns for upsert conflict target." },
      },
      required: ["table", "action"],
    },
  },
  {
    name: "update_dossier_field",
    description: "Quick helper: set a single field on the operator's forge_dossier (e.g. risk_posture, current_focus, money_beliefs).",
    input_schema: {
      type: "object",
      properties: {
        field: { type: "string" },
        value: { type: "string" },
      },
      required: ["field", "value"],
    },
  },
  {
    name: "request_approval",
    description: "Open a pending approval the operator must accept before Atlas can run a restricted action (purchases, payments, emails, account create/delete, credential changes, file deletion, software install, capability install). Returns the approval id. Atlas must NOT execute the underlying action itself — wait for the operator.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "One of: purchase, payment, email, account_create, account_delete, credential_change, file_delete, software_install, capability_install, browser_caution, other." },
        summary:  { type: "string", description: "One-line operator-facing summary of what will happen if approved." },
        payload:  { type: "object", description: "Structured details (target, amount, recipient, url, etc).", additionalProperties: true },
        expires_minutes: { type: "number", description: "How long the approval stays valid (default 60)." },
      },
      required: ["category","summary"],
    },
  },
  {
    name: "browser_action",
    description: "Queue a command for the operator's LOCAL Playwright worker. Safe commands (navigate, search, extract, screenshot, read, scrape, download) run immediately. Caution commands (click, type, fill, upload, login) auto-create an approval and wait. The worker polls atlas-browser and reports back. Returns command id + status.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "navigate|search|extract|screenshot|click|type|fill|upload|login|download" },
        args:    { type: "object", description: "Command arguments (url, selector, text, query, path, etc).", additionalProperties: true },
        objective: { type: "string", description: "Why this command is being run — saved on the receipt." },
      },
      required: ["command"],
    },
  },
  {
    name: "log_receipt",
    description: "Append a persistent receipt for an Atlas action. Use after every meaningful action (capability install, browser session, approval decided, trade placed, message sent). Always include objective + reason + outcome.",
    input_schema: {
      type: "object",
      properties: {
        objective: { type: "string" },
        action:    { type: "string" },
        reason:    { type: "string" },
        result:    { type: "string" },
        outcome:   { type: "string", enum: ["success","failure","partial","pending","denied"] },
        financial_impact: { type: "number" },
        metadata:  { type: "object", additionalProperties: true },
      },
      required: ["action","outcome"],
    },
  },
] as const;

async function pgrest(
  supabaseUrl: string,
  serviceKey: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const resp = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  const text = await resp.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: resp.ok, status: resp.status, data };
}

async function runTool(
  name: string,
  input: Record<string, unknown>,
  userId: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<unknown> {
  try {
    if (name === "read_table") {
      const table = String(input.table || "");
      const cfg = TABLES[table];
      if (!cfg) return { error: `Table '${table}' not allowed.` };
      const params = new URLSearchParams();
      params.set("select", "*");
      if (cfg.userCol) params.set(cfg.userCol, `eq.${userId}`);
      const filter = (input.filter ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(filter)) {
        if (v === null) params.append(k, "is.null");
        else params.append(k, `eq.${String(v)}`);
      }
      if (input.order_by) params.set("order", String(input.order_by));
      const limit = Math.min(Number(input.limit ?? 50) || 50, 200);
      params.set("limit", String(limit));
      const r = await pgrest(supabaseUrl, serviceKey, "GET", `${table}?${params.toString()}`);
      return r.ok ? { rows: r.data } : { error: `read failed (${r.status})`, detail: r.data };
    }

    if (name === "write_record") {
      const table = String(input.table || "");
      const cfg = TABLES[table];
      if (!cfg || !cfg.allowWrite) return { error: `Table '${table}' not writable.` };
      const action = String(input.action || "");
      const data = (input.data ?? {}) as Record<string, unknown>;
      const match = (input.match ?? {}) as Record<string, unknown>;
      if (cfg.userCol) data[cfg.userCol] = userId;

      if (action === "insert") {
        const r = await pgrest(supabaseUrl, serviceKey, "POST", table, data);
        return r.ok ? { inserted: r.data } : { error: `insert failed (${r.status})`, detail: r.data };
      }
      if (action === "upsert") {
        const headers: Record<string, string> = { Prefer: "return=representation,resolution=merge-duplicates" };
        const path = input.on_conflict ? `${table}?on_conflict=${encodeURIComponent(String(input.on_conflict))}` : table;
        const r = await pgrest(supabaseUrl, serviceKey, "POST", path, data, headers);
        return r.ok ? { upserted: r.data } : { error: `upsert failed (${r.status})`, detail: r.data };
      }
      if (action === "update" || action === "delete") {
        const params = new URLSearchParams();
        if (cfg.userCol) params.set(cfg.userCol, `eq.${userId}`);
        for (const [k, v] of Object.entries(match)) params.append(k, `eq.${String(v)}`);
        if (!params.toString()) return { error: "match filters required for update/delete" };
        const method = action === "update" ? "PATCH" : "DELETE";
        const r = await pgrest(supabaseUrl, serviceKey, method, `${table}?${params.toString()}`, action === "update" ? data : undefined);
        return r.ok ? { [action + "d"]: r.data } : { error: `${action} failed (${r.status})`, detail: r.data };
      }
      return { error: `unknown action '${action}'` };
    }

    if (name === "update_dossier_field") {
      const field = String(input.field || "");
      const value = String(input.value ?? "");
      // ensure row exists
      await pgrest(supabaseUrl, serviceKey, "POST", "forge_dossier?on_conflict=user_id", { user_id: userId }, { Prefer: "resolution=ignore-duplicates,return=minimal" });
      const r = await pgrest(supabaseUrl, serviceKey, "PATCH", `forge_dossier?user_id=eq.${userId}`, { [field]: value, updated_at: new Date().toISOString() });
      return r.ok ? { updated: r.data } : { error: `dossier update failed (${r.status})`, detail: r.data };
    }

    if (name === "request_approval") {
      const category = String(input.category || "other");
      const summary  = String(input.summary || "");
      const payload  = (input.payload ?? {}) as Record<string, unknown>;
      const mins = Math.max(1, Math.min(Number(input.expires_minutes ?? 60) || 60, 1440));
      const expires_at = new Date(Date.now() + mins * 60_000).toISOString();
      const r = await pgrest(supabaseUrl, serviceKey, "POST", "atlas_approvals",
        { user_id: userId, agent: "atlas", category, summary, payload, expires_at });
      if (!r.ok) return { error: `approval failed (${r.status})`, detail: r.data };
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      return { pending: true, approval_id: (row as { id?: string })?.id, summary, category, expires_at,
               note: "Do NOT proceed with this action. Wait for the operator to approve or deny." };
    }

    if (name === "browser_action") {
      const command = String(input.command || "").toLowerCase();
      const args = (input.args ?? {}) as Record<string, unknown>;
      const objective = String(input.objective || "");
      let risk: "safe"|"caution"|"restricted" = "safe";
      if (BROWSER_SAFE.has(command)) risk = "safe";
      else if (BROWSER_CAUTION.has(command)) risk = "caution";
      else risk = "restricted";

      let approval_id: string | null = null;
      let status = "queued";
      if (risk !== "safe") {
        const exp = new Date(Date.now() + 60 * 60_000).toISOString();
        const ar = await pgrest(supabaseUrl, serviceKey, "POST", "atlas_approvals", {
          user_id: userId, agent: "atlas",
          category: risk === "restricted" ? "software_install" : "browser_caution",
          summary: `Browser ${command}: ${JSON.stringify(args).slice(0,180)}`,
          payload: { command, args, objective }, expires_at: exp,
        });
        if (!ar.ok) return { error: `approval failed (${ar.status})`, detail: ar.data };
        approval_id = (Array.isArray(ar.data) ? ar.data[0] : ar.data)?.id ?? null;
        status = "awaiting_approval";
      }
      const cr = await pgrest(supabaseUrl, serviceKey, "POST", "atlas_browser_commands", {
        user_id: userId, command, args, risk, approval_id, status,
      });
      if (!cr.ok) return { error: `queue failed (${cr.status})`, detail: cr.data };
      const row = (Array.isArray(cr.data) ? cr.data[0] : cr.data) as { id?: string };
      // Log objective as receipt with pending outcome.
      await pgrest(supabaseUrl, serviceKey, "POST", "atlas_receipts", {
        user_id: userId, agent: "atlas", objective, action: `browser.${command}`,
        reason: objective, result: status, outcome: status === "queued" ? "pending" : "pending",
        metadata: { args, risk, command_id: row?.id, approval_id },
      });
      return { command_id: row?.id, status, risk, approval_id,
               note: status === "queued"
                 ? "Local worker will pick this up. Poll atlas_browser_commands for result."
                 : "Operator must approve before the local worker will execute." };
    }

    if (name === "log_receipt") {
      const r = await pgrest(supabaseUrl, serviceKey, "POST", "atlas_receipts", {
        user_id: userId, agent: "atlas",
        objective: input.objective ?? null,
        action: String(input.action || ""),
        reason: input.reason ?? null,
        result: input.result ?? null,
        outcome: input.outcome ?? "success",
        financial_impact: input.financial_impact ?? 0,
        metadata: input.metadata ?? {},
      });
      return r.ok ? { receipt: r.data } : { error: `receipt failed (${r.status})`, detail: r.data };
    }

    return { error: `unknown tool '${name}'` };
  } catch (e) {
    return { error: String(e) };
  }
}

// ============ HTTP entry ============

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const LOVABLE_KEY  = Deno.env.get("LOVABLE_API_KEY") ?? "";
  const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("Claude_API") ?? Deno.env.get("CLAUDE_API") ?? "";

  if (!LOVABLE_KEY && !ANTHROPIC_KEY) {
    return json({ error: "No AI provider configured (need ANTHROPIC_API_KEY or LOVABLE_API_KEY)" }, 500);
  }

  let userId: string;
  try { userId = await verifyToken(req.headers.get("Authorization"), SUPABASE_URL, SERVICE_KEY); }
  catch (e) { return json({ error: String(e) }, 401); }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const rawMessages = Array.isArray(body.messages) ? body.messages as Array<{ role: string; content: unknown }> : [];
  const system = typeof body.system === "string" ? body.system : "";

  // ============ Anthropic path with tool loop ============
  if (ANTHROPIC_KEY && userId !== "system") {
    const model = Deno.env.get("ATLAS_ANTHROPIC_MODEL") ?? "claude-sonnet-4-5-20250929";

    // Build conversation: keep tool blocks if present; otherwise flatten.
    const convo: Array<{ role: string; content: unknown }> = rawMessages
      .filter((m) => m?.role === "user" || m?.role === "assistant")
      .map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content : flatten(m.content)) }))
      .filter((m) => {
        if (typeof m.content === "string") return m.content.length > 0;
        return Array.isArray(m.content) && m.content.length > 0;
      });
    if (convo.length === 0) convo.push({ role: "user", content: "[Session opened.]" });

    const callAnthropic = async (stream: boolean) => fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        system,
        messages: convo,
        tools: TOOLS,
        stream,
      }),
    });

    // Tool loop (non-streaming) up to N iterations
    for (let iter = 0; iter < 8; iter++) {
      const resp = await callAnthropic(false).catch((e) => { console.error("[atlas-core] anthropic err", e); return null; });
      if (!resp) return sseText("Atlas could not reach Anthropic right now.");
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        console.error(`[atlas-core] Anthropic ${resp.status}`, t.slice(0, 400));
        if (resp.status === 401 || resp.status === 403) return sseText("Anthropic key was rejected. Update ANTHROPIC_API_KEY.");
        if (resp.status === 429) return sseText("Anthropic is rate-limiting Atlas. Try again in a moment.");
        return sseText(`Anthropic returned ${resp.status}.`);
      }
      const data = await resp.json();
      const blocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> = data?.content ?? [];
      const stopReason: string = data?.stop_reason ?? "end_turn";

      if (stopReason === "tool_use") {
        // Append assistant turn (with tool_use blocks) and execute every tool_use
        convo.push({ role: "assistant", content: blocks });
        const toolResults: unknown[] = [];
        for (const b of blocks) {
          if (b.type !== "tool_use") continue;
          const result = await runTool(b.name ?? "", b.input ?? {}, userId, SUPABASE_URL, SERVICE_KEY);
          toolResults.push({
            type: "tool_result",
            tool_use_id: b.id,
            content: JSON.stringify(result).slice(0, 8000),
          });
        }
        convo.push({ role: "user", content: toolResults });
        continue; // loop for next model turn
      }

      // No more tools — stream final answer
      const finalText = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      return sseText(finalText || "Done.");
    }
    return sseText("Atlas reached the tool-loop limit. Try a smaller request.");
  }

  // ============ Lovable Gateway fallback (no tools) ============
  const model = Deno.env.get("ATLAS_MODEL") ?? "google/gemini-3-flash-preview";
  const gatewayMessages: Array<{ role: string; content: string }> = [];
  if (system.trim()) gatewayMessages.push({ role: "system", content: system });
  for (const m of rawMessages) {
    if (!m?.role) continue;
    const text = flatten(m.content);
    if (!text) continue;
    gatewayMessages.push({ role: m.role, content: text });
  }
  if (gatewayMessages.filter(m => m.role !== "system").length === 0) {
    gatewayMessages.push({ role: "user", content: "[Session opened.]" });
  }

  let aiResp: Response;
  try {
    aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: true, messages: gatewayMessages }),
    });
  } catch (e) {
    return json({ error: `Gateway fetch failed: ${String(e)}` }, 502);
  }

  if (!aiResp.ok || !aiResp.body) {
    const errText = await aiResp.text().catch(() => "");
    console.error(`[atlas-core] Gateway ${aiResp.status}:`, errText.slice(0, 400));
    if (aiResp.status === 402) return sseText("Atlas is waiting on AI credits or a valid Anthropic key.");
    if (aiResp.status === 429) return sseText("Atlas is being rate-limited by the AI gateway.");
    return sseText(`Atlas could not reach the AI gateway (${aiResp.status}).`);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let started = false;
  let buf = "";

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const reader = aiResp.body!.getReader();
      try {
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
            const payload = line.slice(6).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const p = JSON.parse(payload);
              const delta = p?.choices?.[0]?.delta?.content ?? "";
              if (delta) {
                if (!started) {
                  send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
                  started = true;
                }
                send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } });
              }
            } catch { /* skip */ }
          }
        }
        if (started) send({ type: "content_block_stop", index: 0 });
        send({ type: "message_delta", delta: { stop_reason: "end_turn" } });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (e) {
        console.error("[atlas-core] stream error", e);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
});
