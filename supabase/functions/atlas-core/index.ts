// atlas-core — Atlas chat proxy with full read/write tool access across every tab.
// Streams Anthropic-style SSE so the existing AtlasPage parser keeps working.

import { answerFromNotebook } from "../_shared/notebook.ts";
import { readAirtable, createAirtableRecord, updateAirtableRecord, formatAirtableRecords, AIRTABLE_TABLES } from "../_shared/airtable.ts";

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

function streamOpenAIToAnthropic(openAIBody: ReadableStream<Uint8Array>): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buf = "";
  let started = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const reader = openAIBody.getReader();
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
                if (!started) { send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }); started = true; }
                send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } });
              }
            } catch { /* skip */ }
          }
        }
      } finally {
        send({ type: "content_block_stop", index: 0 });
        send({ type: "message_delta", delta: { stop_reason: "end_turn" } });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        reader.releaseLock();
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 200, headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
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

// Claude's Messages API doesn't accept video or audio content blocks (and this app
// doesn't build PDF document blocks for it either) — any message carrying one of those
// must route to Gemini regardless of which provider is otherwise primary.
function hasGeminiOnlyContent(messages: Array<{ role: string; content: unknown }>): boolean {
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content as Array<{ type?: string; media_type?: string }>) {
      if (b?.type === "file" && typeof b.media_type === "string" &&
          (b.media_type.startsWith("video/") || b.media_type.startsWith("audio/") || b.media_type === "application/pdf")) {
        return true;
      }
    }
  }
  return false;
}

// Converts one message's content (plain string, or the block array the frontend sends
// for images/files) into Gemini `parts`. Images/video/audio/PDF become inline_data;
// text blocks stay text. Unknown block types are dropped rather than silently stringified.
function blocksToGeminiParts(content: unknown): Array<{ text: string } | { inline_data: { mime_type: string; data: string } }> {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }> = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (b?.type === "text" && typeof b.text === "string" && b.text) {
      parts.push({ text: b.text });
    } else if (b?.type === "image" && (b.source as { data?: string })?.data) {
      const source = b.source as { media_type?: string; data: string };
      parts.push({ inline_data: { mime_type: source.media_type ?? "image/png", data: source.data } });
    } else if (b?.type === "file" && typeof b.data === "string") {
      parts.push({ inline_data: { mime_type: (b.media_type as string) ?? "application/octet-stream", data: b.data } });
    } else if (b?.type === "tool_result" && typeof b.content === "string") {
      parts.push({ text: b.content });
    }
  }
  return parts;
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
  atlas_browser_commands: { userCol: "user_id",     allowWrite: false },
  atlas_tasks:            { userCol: "user_id",     allowWrite: true },
};

// Action categories that always require explicit user approval before execution.
const RESTRICTED_CATEGORIES = new Set([
  "purchase","payment","email","account_create","account_delete",
  "credential_change","file_delete","software_install","capability_install",
]);
// Browser commands that are auto-executable vs require approval.
const BROWSER_SAFE = new Set([
  "navigate","search","extract","screenshot","read","scrape","download",
  "wait","back","forward","reload","get_cookies","get_url","html","links","pdf",
]);
const BROWSER_CAUTION = new Set([
  "click","type","fill","upload","login","press","select","hover","check","uncheck",
  "set_cookies","clear_cookies","eval","multi",
]);
// HTTP verbs Atlas can hit directly. Mutating verbs require approval.
const HTTP_SAFE = new Set(["GET","HEAD","OPTIONS"]);

const TOOLS = [
  {
    name: "search_airtable",
    description: `Read records from the operator's Airtable command center (Companies, People, Teams, Projects, Milestones, Tasks — all linked). Tables: ${AIRTABLE_TABLES.join(", ")}. Use to check real organizational state — who's on what, project status, task deadlines — before making a claim about what's actually happening in the business.`,
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: `One of: ${AIRTABLE_TABLES.join(", ")}` },
        filter_formula: { type: "string", description: "Optional Airtable formula to filter records, e.g. {Status}='Active'" },
      },
      required: ["table"],
    },
  },
  {
    name: "create_airtable_record",
    description: "Create a new record in the operator's Airtable command center. Use when the operator asks you to log a new company, person, team, project, milestone, or task there.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: `One of: ${AIRTABLE_TABLES.join(", ")}` },
        fields: { type: "object", description: "Field name -> value pairs matching that table's columns", additionalProperties: true },
      },
      required: ["table", "fields"],
    },
  },
  {
    name: "update_airtable_record",
    description: "Update an existing record in the operator's Airtable command center (e.g. change a task's status, update a project's dates). Requires the record ID — use search_airtable first to find it.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: `One of: ${AIRTABLE_TABLES.join(", ")}` },
        record_id: { type: "string", description: "Airtable record ID, e.g. recXXXXXXXXXXXXXX" },
        fields: { type: "object", description: "Field name -> new value pairs to update", additionalProperties: true },
      },
      required: ["table", "record_id", "fields"],
    },
  },
  {
    name: "search_notebook",
    description: "Ask a question grounded in the sources saved in one of the operator's Notebooks (PDFs, documents, web pages they've added for research). Use when the operator references something they've saved to a notebook, or when their question is better answered from their own research materials than general knowledge.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "What to ask/search for" },
        notebook_title: { type: "string", description: "Which notebook to search (partial match ok). Leave blank to use the operator's most recently active notebook." },
      },
      required: ["question"],
    },
  },
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
    name: "request_input",
    description: "Pause and ask the operator to provide values Atlas needs to continue (usernames, passwords, OTPs, 2FA codes, a URL, a confirmation, a missing detail). Creates an approval of category 'input_request' with a fields schema. Atlas MUST STOP and not retry the underlying step until check_approval returns status=approved with payload.response present. Mark sensitive fields with secret:true.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why Atlas is pausing — what task this unblocks." },
        fields: {
          type: "array",
          description: "Values requested from the operator.",
          items: {
            type: "object",
            properties: {
              name:   { type: "string" },
              label:  { type: "string" },
              type:   { type: "string", description: "text|password|otp|email|url|number|confirm" },
              secret: { type: "boolean" },
            },
            required: ["name"],
          },
        },
        expires_minutes: { type: "number" },
      },
      required: ["reason","fields"],
    },
  },
  {
    name: "check_approval",
    description: "Look up the current status of an approval or input_request by id. Returns { status, category, payload, response }. Poll this after request_approval / request_input before continuing the task.",
    input_schema: {
      type: "object",
      properties: { approval_id: { type: "string" } },
      required: ["approval_id"],
    },
  },
  {
    name: "browser_action",
    description: "Queue a command for the operator's LOCAL Playwright worker. Atlas has full browser control. Safe (auto): navigate, search, extract, screenshot, read, scrape, download, wait, back, forward, reload, get_cookies, get_url, html, links, pdf. Caution (needs approval): click, type, fill, upload, login, press, select, hover, check, uncheck, set_cookies, clear_cookies, eval (arbitrary JS in page), multi (sequence of steps as args.steps). The worker polls atlas-browser and reports back.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        args:    { type: "object", description: "url, selector, text, query, path, ms, key, options, code, steps[], etc.", additionalProperties: true },
        objective: { type: "string" },
      },
      required: ["command"],
    },
  },
  {
    name: "http_request",
    description: "Make an arbitrary HTTP/REST/MCP request from the edge function. Use this to call any public API or remote MCP server (JSON-RPC over HTTP). GET/HEAD/OPTIONS run immediately. POST/PUT/PATCH/DELETE auto-create an approval. Returns {status, headers, body}. Body is parsed as JSON when possible, else returned as text (truncated to 16KB).",
    input_schema: {
      type: "object",
      properties: {
        url:     { type: "string" },
        method:  { type: "string", description: "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS (default GET)" },
        headers: { type: "object", additionalProperties: true },
        body:    { description: "Object (JSON.stringify'd) or string." },
        objective: { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: "install_mcp",
    description: "Register a new MCP server connection for the operator. Persists to atlas_mcp_connections with is_active=true. Use this when the operator asks Atlas to 'grab' or 'connect to' an MCP. For OAuth-required servers, also create an approval so the operator can finish auth.",
    input_schema: {
      type: "object",
      properties: {
        name:        { type: "string" },
        slug:        { type: "string", description: "lowercase identifier, e.g. 'linear', 'notion'." },
        endpoint:    { type: "string", description: "MCP server URL." },
        transport:   { type: "string", description: "http|sse|stdio (default http)." },
        auth_type:   { type: "string", description: "none|bearer|oauth|api_key (default none)." },
        auth_secret_name: { type: "string", description: "Name of an existing secret containing the token, if applicable." },
        capabilities: { type: "array", items: { type: "object" }, description: "Tools the MCP exposes, if known." },
        notes:       { type: "string" },
      },
      required: ["name","endpoint"],
    },
  },
  // log_receipt removed — write receipts directly via write_record({table:"atlas_receipts"}).
  {
    name: "google",
    description: `Call any Google Workspace, Maps, or Gemini AI API. OAuth-based services require the operator to have connected their Google account (Profile → Google tab). Gemini and Maps use API keys and do NOT require OAuth.

SERVICES & KEY ACTIONS:
- gemini: generate_content (prompt, system?, model?, messages?, maxOutputTokens?), embed_content (text, model?), list_models. Uses GOOGLE_AI_KEY — no OAuth needed.
- gmail: list_threads, list_messages, get_message, get_thread, send (to/subject/body), create_draft, trash, list_labels, get_profile
- calendar: list_calendars, list_events (timeMin/timeMax/query), create_event (event object), update_event, delete_event, quick_add (text)
- drive: list_files, search (query), get_file, read_file, get_storage, create_folder, copy_file, move_file, delete_file
- sheets: get_values (spreadsheetId/range), update_values, append_values, create_spreadsheet, get_spreadsheet
- docs: get_document, create_document, insert_text, batch_update
- slides: get_presentation, create_presentation
- forms: get_form, list_responses
- contacts: list_contacts, search_contacts (query), get_contact, create_contact, update_contact
- tasks: list_tasklists, list_tasks, create_task, complete_task, update_task
- youtube: get_my_channel, search (query), get_video, list_playlists, list_subscriptions
- search_console: list_sites, query_search_analytics (siteUrl/startDate/endDate)
- analytics: list_accounts, list_properties (accountId), run_report (propertyId), run_realtime_report (propertyId)
- chat: list_spaces, list_messages (spaceName), send_message (spaceName/text)
- maps: geocode (address), search_places (query), get_directions (origin/destination), nearby_search (location)

Sending email, deleting files/events, and creating contacts require request_approval first.`,
    input_schema: {
      type: "object",
      properties: {
        service: { type: "string", description: "gemini | gmail | calendar | drive | sheets | docs | slides | forms | contacts | tasks | youtube | search_console | analytics | chat | maps" },
        action:  { type: "string", description: "The action to perform (see tool description for full list per service)." },
        params:  { type: "object", description: "Action-specific parameters (e.g. query, maxResults, to, subject, body, spreadsheetId, range, etc.).", additionalProperties: true },
      },
      required: ["service", "action"],
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
    if (name === "search_airtable" || name === "create_airtable_record" || name === "update_airtable_record") {
      const airtableKey = Deno.env.get("AIRTABLE_API_KEY") ?? "";
      if (!airtableKey) return { error: "Airtable is not connected (no AIRTABLE_API_KEY configured)." };
      const table = String(input.table ?? "");
      if (!AIRTABLE_TABLES.includes(table)) return { error: `Unknown table "${table}". Valid tables: ${AIRTABLE_TABLES.join(", ")}` };
      try {
        if (name === "search_airtable") {
          const records = await readAirtable(airtableKey, table, { filterByFormula: input.filter_formula ? String(input.filter_formula) : undefined });
          return { records: formatAirtableRecords(table, records) };
        }
        if (name === "create_airtable_record") {
          const rec = await createAirtableRecord(airtableKey, table, (input.fields as Record<string, unknown>) ?? {});
          return { created: rec.id, fields: rec.fields };
        }
        const rec = await updateAirtableRecord(airtableKey, table, String(input.record_id ?? ""), (input.fields as Record<string, unknown>) ?? {});
        return { updated: rec.id, fields: rec.fields };
      } catch (e) {
        return { error: (e as Error).message };
      }
    }

    if (name === "search_notebook") {
      const question = String(input.question ?? "");
      if (!question) return { error: "question is required" };
      const answer = await answerFromNotebook({
        supabaseUrl, serviceKey, userId,
        googleKey: Deno.env.get("GOOGLE_AI_KEY") ?? "",
        notebookTitle: input.notebook_title ? String(input.notebook_title) : undefined,
        question,
      });
      return { answer };
    }

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

    if (name === "request_input") {
      const reason = String(input.reason || "");
      const fields = Array.isArray(input.fields) ? input.fields : [];
      const mins = Math.max(1, Math.min(Number(input.expires_minutes ?? 30) || 30, 1440));
      const expires_at = new Date(Date.now() + mins * 60_000).toISOString();
      const summary = `Input required: ${reason}`.slice(0, 200);
      const r = await pgrest(supabaseUrl, serviceKey, "POST", "atlas_approvals", {
        user_id: userId, agent: "atlas",
        category: "input_request",
        summary,
        payload: { reason, fields, kind: "input_request" },
        expires_at,
      });
      if (!r.ok) return { error: `input request failed (${r.status})`, detail: r.data };
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      return { pending: true, approval_id: (row as { id?: string })?.id, summary, expires_at,
               note: "STOP. Wait for the operator to submit values. Poll check_approval(approval_id); once status=approved, read payload.response and continue." };
    }

    if (name === "check_approval") {
      const id = String(input.approval_id || "");
      if (!id) return { error: "approval_id required" };
      const r = await pgrest(supabaseUrl, serviceKey, "GET",
        `atlas_approvals?select=id,status,category,summary,payload,decided_at,decided_note,expires_at&id=eq.${id}&user_id=eq.${userId}&limit=1`);
      if (!r.ok) return { error: `lookup failed (${r.status})`, detail: r.data };
      const row = Array.isArray(r.data) ? (r.data as Array<Record<string, unknown>>)[0] : null;
      if (!row) return { error: "not found" };
      return { ...row, response: (row.payload as { response?: unknown } | null)?.response ?? null };
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

    if (name === "http_request") {
      const url = String(input.url || "");
      if (!/^https?:\/\//i.test(url)) return { error: "url must be http(s)://" };
      const method = String(input.method || "GET").toUpperCase();
      const headers = (input.headers ?? {}) as Record<string, string>;
      const objective = String(input.objective || "");
      const rawBody = input.body;
      const bodyStr = rawBody === undefined || rawBody === null
        ? undefined
        : (typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody));

      if (!HTTP_SAFE.has(method)) {
        const exp = new Date(Date.now() + 60 * 60_000).toISOString();
        const ar = await pgrest(supabaseUrl, serviceKey, "POST", "atlas_approvals", {
          user_id: userId, agent: "atlas", category: "other",
          summary: `HTTP ${method} ${url.slice(0, 160)}`,
          payload: { url, method, headers, body: bodyStr, objective }, expires_at: exp,
        });
        const approval_id = (Array.isArray(ar.data) ? ar.data[0] : ar.data)?.id ?? null;
        return { pending: true, approval_id, note: "Mutating HTTP verb requires operator approval. Re-invoke http_request after the approval row is set to 'approved'." };
      }

      try {
        const resp = await fetch(url, { method, headers, body: bodyStr });
        const text = await resp.text();
        const truncated = text.length > 16000 ? text.slice(0, 16000) + "…[truncated]" : text;
        let parsed: unknown = truncated;
        try { parsed = JSON.parse(text); } catch { /* keep text */ }
        const hdrs: Record<string,string> = {};
        resp.headers.forEach((v,k) => { hdrs[k] = v; });
        await pgrest(supabaseUrl, serviceKey, "POST", "atlas_receipts", {
          user_id: userId, agent: "atlas", objective, action: `http.${method.toLowerCase()}`,
          reason: objective, result: `status ${resp.status}`,
          outcome: resp.ok ? "success" : "failure",
          metadata: { url, status: resp.status },
        });
        return { status: resp.status, ok: resp.ok, headers: hdrs, body: parsed };
      } catch (e) {
        return { error: `fetch failed: ${String(e)}` };
      }
    }

    if (name === "install_mcp") {
      const row: Record<string, unknown> = {
        user_id: userId,
        name: String(input.name || ""),
        slug: String(input.slug || String(input.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_")),
        endpoint: String(input.endpoint || ""),
        transport: String(input.transport || "http"),
        auth_type: String(input.auth_type || "none"),
        auth_secret_name: input.auth_secret_name ? String(input.auth_secret_name) : null,
        capabilities: input.capabilities ?? [],
        notes: input.notes ? String(input.notes) : null,
        is_active: true,
        is_verified: false,
      };
      const r = await pgrest(supabaseUrl, serviceKey, "POST",
        "atlas_mcp_connections?on_conflict=user_id,slug", row,
        { Prefer: "return=representation,resolution=merge-duplicates" });
      if (!r.ok) return { error: `install failed (${r.status})`, detail: r.data };
      return { installed: r.data, note: "MCP registered. If auth_type is oauth/bearer, request_approval so the operator can paste the token." };
    }

    if (name === "google") {
      const service = String(input.service || "");
      const action  = String(input.action  || "");
      const params  = (input.params ?? {}) as Record<string, unknown>;

      // Destructive actions require a prior approval — agent must call request_approval first.
      const DESTRUCTIVE_CATEGORIES: Record<string, string> = {
        send: "email",
        trash: "email",
        delete_file: "file_delete",
        delete_event: "other",
        delete_contact: "other",
        delete_task: "other",
        send_message: "other",
      };
      if (DESTRUCTIVE_CATEGORIES[action] !== undefined) {
        const category = DESTRUCTIVE_CATEGORIES[action];
        const cutoff = new Date(Date.now() - 60 * 60_000).toISOString();
        const ar = await pgrest(supabaseUrl, serviceKey, "GET",
          `atlas_approvals?user_id=eq.${userId}&category=eq.${category}&status=eq.approved&created_at=gte.${cutoff}&order=created_at.desc&limit=1`);
        const approved = Array.isArray(ar.data) && ar.data.length > 0;
        if (!approved) {
          return { error: `Action '${action}' requires operator approval. Call request_approval({category:'${category}', summary:'...'}) first, then re-call google() after approval.` };
        }
      }

      const googleApiUrl = `${supabaseUrl}/functions/v1/google-api`;
      try {
        const resp = await fetch(googleApiUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceKey}`,
            apikey: serviceKey,
            "Content-Type": "application/json",
            "x-atlas-user-id": userId,
          },
          body: JSON.stringify({ service, action, ...params }),
        });
        const data = await resp.json().catch(() => null);
        if (!resp.ok) {
          const msg = (data as { error?: string })?.error ?? `Google API error ${resp.status}`;
          if (resp.status === 401) return { error: "Google account not connected. Tell the operator to go to Profile → Google tab and connect their account." };
          return { error: msg };
        }
        return data;
      } catch (e) {
        return { error: `Google API call failed: ${String(e)}` };
      }
    }

    return { error: `unknown tool '${name}'` };
  } catch (e) {
    return { error: String(e) };
  }
}

// Prepare messages for Gemini: truncate to last 30 turns + merge consecutive same-role (Gemini requires strict user/model alternation)
function buildGeminiContents(msgs: Array<{ role: string; content: unknown }>) {
  const recent = msgs.filter(m => m.role !== "system").slice(-30);
  const merged: Array<{ role: string; parts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }> }> = [];
  for (const m of recent) {
    const parts = blocksToGeminiParts(m.content);
    if (parts.length === 0) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.parts.push(...parts);
    } else {
      merged.push({ role: m.role, parts });
    }
  }
  if (merged.length === 0) merged.push({ role: "user", parts: [{ text: "[Session opened.]" }] });
  return merged.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: m.parts,
  }));
}

// Write Gemini quota-exceeded signal so check-ai-status can report accurate status without a live probe
async function signalGeminiQuota(userId: string, supabaseUrl: string, serviceKey: string) {
  try {
    await fetch(
      `${supabaseUrl}/rest/v1/shared_operator_memory?on_conflict=user_id,source_agent,key`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({
          user_id: userId,
          source_agent: "system",
          memory_type: "status",
          key: "gemini_status",
          value: "quota",
          context: `Gemini 429 at ${new Date().toISOString()}`,
        }),
      },
    );
  } catch { /* fire-and-forget — don't break the response on write failure */ }
}

// ============ HTTP entry ============

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const ANTHROPIC_KEY    = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("Claude_API") ?? Deno.env.get("CLAUDE_API") ?? "";
  const BACKUP_ANTH_KEY  = Deno.env.get("ANTROPIC_API_KEY") ?? ""; // tier 2: personal backup Anthropic key
  const GOOGLE_KEY       = Deno.env.get("GOOGLE_AI_KEY") ?? "";

  if (!ANTHROPIC_KEY && !GOOGLE_KEY) {
    return json({ error: "No AI provider configured (need ANTHROPIC_API_KEY or GOOGLE_AI_KEY)" }, 500);
  }

  let userId: string;
  try { userId = await verifyToken(req.headers.get("Authorization"), SUPABASE_URL, SERVICE_KEY); }
  catch (e) { return json({ error: String(e) }, 401); }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const rawMessages = Array.isArray(body.messages) ? body.messages as Array<{ role: string; content: unknown }> : [];
  let system = typeof body.system === "string" ? body.system : "";

  // Inject unified shared knowledge + recent cross-medium conversation
  if (userId !== "system") {
    try {
      const [hist, knowl] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/agent_unified_history?user_id=eq.${userId}&order=created_at.desc&limit=20&select=medium,agent_slug,role,content`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`${SUPABASE_URL}/rest/v1/agent_shared_knowledge?user_id=eq.${userId}&order=updated_at.desc&limit=30&select=source_agent,topic,fact`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }).then(r => r.ok ? r.json() : []).catch(() => []),
      ]);
      const blocks: string[] = [];
      if (Array.isArray(knowl) && knowl.length) {
        blocks.push("SHARED KNOWLEDGE BASE (facts any agent has logged — treat as your own knowledge):\n" +
          knowl.map((k: { source_agent: string; topic: string | null; fact: string }) => `- [${k.source_agent}${k.topic ? ` · ${k.topic}` : ""}] ${k.fact}`).join("\n"));
      }
      if (Array.isArray(hist) && hist.length) {
        blocks.push("SHARED CONVERSATION HISTORY (recent turns across Mental Forge, Atlas chat, agent chats, Telegram — never mention this list):\n" +
          (hist as Array<{ medium: string; agent_slug: string; role: string; content: string }>).reverse().map(r => {
            const who = r.role === "user" ? "Operator" : (r.agent_slug || "agent");
            return `[${r.medium}] ${who}: ${(r.content ?? "").toString().replace(/\s+/g, " ").slice(0, 240)}`;
          }).join("\n"));
      }
      if (blocks.length) system = `${system}\n\n${blocks.join("\n\n")}`;
    } catch { /* non-fatal */ }
  }

  // ============ Anthropic path with tool loop ============
  // Anthropic is primary whenever available — it's the only path with tool support
  // (save_knowledge, log_trade, etc.). It has its own internal fallback to a backup
  // Anthropic key and then to Gemini on failure. The one exception: video/audio/PDF
  // content, which Claude's API can't accept at all — that always routes to Gemini.
  const geminiOnly = GOOGLE_KEY && hasGeminiOnlyContent(rawMessages);
  if (ANTHROPIC_KEY && !geminiOnly) {
    const model = Deno.env.get("ATLAS_ANTHROPIC_MODEL") ?? "claude-sonnet-4-6";

    // Build conversation: keep tool blocks if present; otherwise flatten.
    const convo: Array<{ role: string; content: unknown }> = rawMessages
      .filter((m) => m?.role === "user" || m?.role === "assistant")
      .map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content : flatten(m.content)) }))
      .filter((m) => {
        if (typeof m.content === "string") return m.content.length > 0;
        return Array.isArray(m.content) && m.content.length > 0;
      });
    if (convo.length === 0) convo.push({ role: "user", content: "[Session opened.]" });

    const callAnthropic = async (stream: boolean, key = ANTHROPIC_KEY) => fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        system,
        messages: convo,
        tools: [...TOOLS, { type: "web_search_20250305", name: "web_search" }],
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
        // Tier 2: try personal backup Anthropic key on auth/credit errors
        const isAuthErr = resp.status === 401 || resp.status === 403;
        if (isAuthErr && BACKUP_ANTH_KEY && BACKUP_ANTH_KEY !== ANTHROPIC_KEY) {
          console.log(`[atlas-core] Primary key rejected (${resp.status}) — trying backup Anthropic key (tier 2)`);
          const br2 = await callAnthropic(false, BACKUP_ANTH_KEY).catch(() => null);
          if (br2?.ok) {
            const bd2 = await br2.json();
            const bt2 = (bd2?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join("").trim();
            if (bt2) return sseText(bt2);
          }
        }
        if (isAuthErr) return sseText("Anthropic key was rejected. Update ANTHROPIC_API_KEY.");
        // Fall back for credit exhaustion (402/400), overload (529), any 5xx, or billing keywords in body
        const shouldFallback = resp.status === 402 || resp.status === 400 || resp.status === 529 || resp.status >= 500
          || t.includes("credit") || t.includes("billing") || t.includes("payment") || t.includes("quota");
        if (!shouldFallback) return sseText(`Anthropic ${resp.status}: ${t.slice(0, 200)}`);
        // Tier 2: try backup Anthropic key before Gemini on quota/credit errors
        if (BACKUP_ANTH_KEY && BACKUP_ANTH_KEY !== ANTHROPIC_KEY) {
          console.log(`[atlas-core] Primary Anthropic ${resp.status} — trying backup Anthropic key (tier 2)`);
          const br = await callAnthropic(false, BACKUP_ANTH_KEY).catch(() => null);
          if (br?.ok) {
            const bd = await br.json();
            const bt = (bd?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join("").trim();
            if (bt) return sseText(bt);
          }
        }
        // Tier 3: Google Gemini
        const googleKey = Deno.env.get("GOOGLE_AI_KEY") ?? "";
        if (!googleKey) return sseText("All AI providers are currently unavailable. Please try again shortly.");
        console.log(`[atlas-core] Anthropic ${resp.status} — falling back to Google AI (tier 3)`);
        const googleMessages: Array<{ role: string; content: unknown }> = [];
        if (system.trim()) googleMessages.push({ role: "system", content: system });
        for (const m of convo) {
          if (!m?.role) continue;
          googleMessages.push({ role: m.role as string, content: m.content });
        }
        try {
          const gSystem = String(googleMessages.find(m => m.role === "system")?.content ?? "");
          const gContents = buildGeminiContents(googleMessages);
          const gBody: Record<string, unknown> = { contents: gContents, generationConfig: { maxOutputTokens: 4000 } };
          if (gSystem) gBody.systemInstruction = { parts: [{ text: gSystem }] };
          const gResp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${googleKey}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(gBody) },
          );
          if (gResp.ok) {
            const gd = await gResp.json();
            // Filter out thinking blocks (thought:true) — only keep visible text parts
            const gText = (gd?.candidates?.[0]?.content?.parts ?? [])
              .filter((p: any) => !p.thought)
              .map((p: any) => p.text ?? "").join("").trim();
            return sseText(gText || "Atlas is temporarily unavailable.");
          }
          const gErr = await gResp.text().catch(() => "");
          console.error(`[atlas-core] Gemini fallback ${gResp.status}:`, gErr.slice(0, 400));
          if (gResp.status === 429) {
            void signalGeminiQuota(userId, SUPABASE_URL, SERVICE_KEY);
            return sseText("Atlas is temporarily rate-limited. Wait a moment and try again.");
          }
          return sseText(`Gemini ${gResp.status} (key ends: ...${googleKey.slice(-6)}): ${gErr.slice(0, 200)}`);
        } catch (e) {
          console.error("[atlas-core] Gemini fallback exception:", e);
          return sseText(`Gemini error: ${String(e).slice(0, 200)}`);
        }
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

  // ============ Gemini path (no Anthropic key, or Gemini-only content like video/audio/PDF) ============
  const googleMessages: Array<{ role: string; content: unknown }> = [];
  if (system.trim()) googleMessages.push({ role: "system", content: system });
  for (const m of rawMessages) {
    if (!m?.role) continue;
    googleMessages.push({ role: m.role, content: m.content });
  }
  if (googleMessages.filter(m => m.role !== "system").length === 0) {
    googleMessages.push({ role: "user", content: "[Session opened.]" });
  }

  try {
    const gSystem = String(googleMessages.find(m => m.role === "system")?.content ?? "");
    const gContents = buildGeminiContents(googleMessages);
    const gBody: Record<string, unknown> = { contents: gContents, generationConfig: { maxOutputTokens: 4000 } };
    if (gSystem) gBody.systemInstruction = { parts: [{ text: gSystem }] };
    const gResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(gBody) },
    );
    if (gResp.ok) {
      const gd = await gResp.json();
      // Filter out thinking blocks (thought:true) — only keep visible text parts
      const gText = (gd?.candidates?.[0]?.content?.parts ?? [])
        .filter((p: any) => !p.thought)
        .map((p: any) => p.text ?? "").join("").trim();
      return sseText(gText || "Atlas is temporarily unavailable.");
    }
    const gErr = await gResp.text().catch(() => "");
    console.error(`[atlas-core] Gemini primary ${gResp.status}:`, gErr.slice(0, 400));
    if (gResp.status === 429) {
      void signalGeminiQuota(userId, SUPABASE_URL, SERVICE_KEY);
      return sseText("Gemini daily quota exhausted. Go to aistudio.google.com, create a key under a different Google account, and update GOOGLE_AI_KEY in Supabase secrets.");
    }
    return sseText(`Google AI ${gResp.status}: ${gErr.slice(0, 200)}`);
  } catch (e) {
    console.error("[atlas-core] Gemini primary exception:", e);
    return sseText(`Google AI error: ${String(e).slice(0, 200)}`);
  }
});
