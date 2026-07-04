// Linda streaming chat — mirrors forge_chat pattern exactly
// Reads Linda's system prompt from skyforge_agents table
// Injects WIG world state + pending leads + escalations before first token

import { answerFromNotebook } from "../_shared/notebook.ts";
import { readAirtable, createAirtableRecord, updateAirtableRecord, formatAirtableRecords, AIRTABLE_TABLES, resolveAirtableKey } from "../_shared/airtable.ts";
import { readAgentSkillsRoster, useSkillTool } from "../_shared/gateway.ts";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
class AuthError extends Error { constructor(m: string) { super(m); this.name = "AuthError"; } }
function parseEnv(k: string): string { const v = (Deno as any).env.get(k); if (!v) throw new Error(`Required env var ${k} is not set`); return v; }
async function verifyUser(url: string, key: string, auth: string | null): Promise<string> { if (!auth) throw new AuthError("Missing Authorization header"); const token = auth.replace("Bearer ","").trim(); const r = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: key } }); if (!r.ok) throw new AuthError("Invalid or expired token"); const d = await r.json(); if (!d?.id) throw new AuthError("No user ID"); return d.id; }
async function readCrossMemory(url: string, key: string, userId: string, limit = 8): Promise<string> { try { const r = await fetch(`${url}/rest/v1/agent_cross_memory?user_id=eq.${userId}&order=created_at.desc&limit=${limit}&select=source_agent,summary,topic`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }); if (!r.ok) return ""; const rows: any[] = await r.json(); if (!rows?.length) return ""; return rows.reverse().map((x: any) => `[${x.source_agent}${x.topic ? ` · ${x.topic}` : ""}] ${x.summary}`).join("\n"); } catch { return ""; } }
function writeCrossMemory(url: string, key: string, userId: string, agent: string, summary: string, topic?: string): void { fetch(`${url}/rest/v1/agent_cross_memory`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ user_id: userId, source_agent: agent, summary, topic: topic ?? null }) }).catch(() => {}); }

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
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`));
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

// ── Sales-prospecting tools ──────────────────────────────────────────────────
// Linda already has native web_search to gather information; these tools
// persist what she finds into her own tables. One round of tool use per
// message (matches Atlas's pattern) — good enough for save-what-I-found calls.

const LINDA_TOOLS = [
  {
    name: "use_skill",
    description: "Pull the full playbook for one of your active skills (see the ACTIVE SKILLS list in your context) when it's genuinely relevant to what you're doing right now. Only skills the operator has connected and enabled for you are usable.",
    input_schema: {
      type: "object" as const,
      properties: { skill_name: { type: "string", description: "Exact skill name from your ACTIVE SKILLS list" } },
      required: ["skill_name"],
    },
  },
  {
    name: "search_airtable",
    description: `Read records from the operator's Airtable command center (Companies, People, Teams, Projects, Milestones, Tasks — all linked). Tables: ${AIRTABLE_TABLES.join(", ")}. Use to check real organizational state before making a claim about what's actually happening.`,
    input_schema: {
      type: "object" as const,
      properties: {
        table: { type: "string", description: `One of: ${AIRTABLE_TABLES.join(", ")}` },
        filter_formula: { type: "string", description: "Optional Airtable formula to filter records, e.g. {Status}='Active'" },
      },
      required: ["table"],
    },
  },
  {
    name: "create_airtable_record",
    description: "Create a new record in the operator's Airtable command center.",
    input_schema: {
      type: "object" as const,
      properties: {
        table: { type: "string", description: `One of: ${AIRTABLE_TABLES.join(", ")}` },
        fields: { type: "object" as const, description: "Field name -> value pairs matching that table's columns" },
      },
      required: ["table", "fields"],
    },
  },
  {
    name: "update_airtable_record",
    description: "Update an existing record in the operator's Airtable command center. Requires the record ID -- use search_airtable first to find it.",
    input_schema: {
      type: "object" as const,
      properties: {
        table: { type: "string", description: `One of: ${AIRTABLE_TABLES.join(", ")}` },
        record_id: { type: "string", description: "Airtable record ID, e.g. recXXXXXXXXXXXXXX" },
        fields: { type: "object" as const, description: "Field name -> new value pairs to update" },
      },
      required: ["table", "record_id", "fields"],
    },
  },
  {
    name: "search_notebook",
    description: "Ask a question grounded in the sources saved in one of the operator's Notebooks (PDFs, documents, web pages they've added for research). Use when the operator references something they've saved to a notebook.",
    input_schema: {
      type: "object" as const,
      properties: {
        question:       { type: "string", description: "What to ask/search for" },
        notebook_title: { type: "string", description: "Which notebook to search (partial match ok). Leave blank to use the most recently active one." },
      },
      required: ["question"],
    },
  },
  {
    name: "save_company_research",
    description: "Save firmographic research about a company you looked up (via web_search) — industry, size, revenue, location. Use after researching a prospect's company.",
    input_schema: {
      type: "object" as const,
      properties: {
        lead_id:          { type: "string", description: "Linked linda_leads.id, if this research is for an existing lead" },
        name:             { type: "string" },
        website:          { type: "string" },
        industry:         { type: "string" },
        employee_count:   { type: "string", description: "e.g. '50-200' or '~30'" },
        revenue_estimate: { type: "string", description: "e.g. '$5M-10M ARR'" },
        hq_location:      { type: "string" },
        description:      { type: "string" },
        source_notes:     { type: "string", description: "Where this info came from" },
      },
      required: ["name"],
    },
  },
  {
    name: "save_contact",
    description: "Save a decision-maker/contact found for a company or lead.",
    input_schema: {
      type: "object" as const,
      properties: {
        lead_id:      { type: "string" },
        company_id:   { type: "string" },
        full_name:    { type: "string" },
        title:        { type: "string" },
        email:        { type: "string" },
        phone:        { type: "string" },
        linkedin_url: { type: "string" },
        role_type:    { type: "string", enum: ["buyer", "champion", "influencer", "blocker", "user"] },
        notes:        { type: "string" },
      },
      required: ["full_name"],
    },
  },
  {
    name: "qualify_lead",
    description: "Record a structured BANT or MEDDIC qualification for a lead. Updates the lead's priority based on overall_score.",
    input_schema: {
      type: "object" as const,
      properties: {
        lead_id:       { type: "string" },
        framework:     { type: "string", enum: ["bant", "meddic"] },
        scores:        { type: "object", description: "e.g. {budget:7,authority:8,need:9,timeline:6} for BANT, or the MEDDIC fields" },
        overall_score: { type: "number", description: "0-10, your overall assessment" },
        summary:       { type: "string" },
      },
      required: ["lead_id", "overall_score", "summary"],
    },
  },
  {
    name: "log_competitor",
    description: "Record competitive intelligence — a competitor this prospect is evaluating or that operates in their space.",
    input_schema: {
      type: "object" as const,
      properties: {
        lead_id:        { type: "string" },
        name:           { type: "string" },
        strengths:      { type: "string" },
        weaknesses:     { type: "string" },
        win_loss_notes: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "create_deal",
    description: "Open a deal/proposal for a qualified lead.",
    input_schema: {
      type: "object" as const,
      properties: {
        lead_id:             { type: "string" },
        deal_value:          { type: "number" },
        stage:                { type: "string", enum: ["proposal", "negotiation", "won", "lost"] },
        proposal_content:    { type: "string" },
        expected_close_date: { type: "string", description: "YYYY-MM-DD" },
        notes:               { type: "string" },
      },
      required: ["lead_id"],
    },
  },
  {
    name: "update_deal",
    description: "Update an existing deal's stage or notes.",
    input_schema: {
      type: "object" as const,
      properties: {
        deal_id: { type: "string" },
        stage:   { type: "string", enum: ["proposal", "negotiation", "won", "lost"] },
        notes:   { type: "string" },
      },
      required: ["deal_id"],
    },
  },
  {
    name: "set_icp",
    description: "Define or update the Ideal Customer Profile used to judge prospect fit.",
    input_schema: {
      type: "object" as const,
      properties: {
        name:      { type: "string" },
        criteria:  { type: "object", description: "e.g. {industry:'marine construction',company_size:'10-50',pain_points:['slow bidding']}" },
        is_active: { type: "boolean" },
      },
      required: ["name", "criteria"],
    },
  },
];

async function executeLindaTool(
  name: string,
  input: Record<string, unknown>,
  userId: string,
  sbHeaders: Record<string, string>,
  supabaseUrl: string,
): Promise<string> {
  const post = (table: string, body: Record<string, unknown>) =>
    fetch(`${supabaseUrl}/rest/v1/${table}`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "return=representation" },
      body: JSON.stringify({ ...body, user_id: userId }),
    });
  const patch = (table: string, id: string, body: Record<string, unknown>) =>
    fetch(`${supabaseUrl}/rest/v1/${table}?id=eq.${id}`, {
      method: "PATCH",
      headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify(body),
    });

  try {
    switch (name) {
      case "use_skill": {
        const skillName = String(input.skill_name ?? "");
        if (!skillName) return "skill_name is required.";
        return await useSkillTool(supabaseUrl, sbHeaders.apikey, userId, "linda", skillName);
      }
      case "search_airtable":
      case "create_airtable_record":
      case "update_airtable_record": {
        const airtableKey = Deno.env.get("AIRTABLE_API_KEY") ?? "";
        if (!airtableKey) return "Airtable is not connected (no AIRTABLE_API_KEY configured).";
        const table = String(input.table ?? "");
        if (!AIRTABLE_TABLES.includes(table)) return `Unknown table "${table}". Valid tables: ${AIRTABLE_TABLES.join(", ")}`;
        try {
          if (name === "search_airtable") {
            const records = await readAirtable(airtableKey, table, { filterByFormula: input.filter_formula ? String(input.filter_formula) : undefined });
            return formatAirtableRecords(table, records);
          }
          if (name === "create_airtable_record") {
            const rec = await createAirtableRecord(airtableKey, table, (input.fields as Record<string, unknown>) ?? {});
            return `Created ${table} record ${rec.id}.`;
          }
          const rec = await updateAirtableRecord(airtableKey, table, String(input.record_id ?? ""), (input.fields as Record<string, unknown>) ?? {});
          return `Updated ${table} record ${rec.id}.`;
        } catch (e) {
          return `Airtable error: ${(e as Error).message}`;
        }
      }
      case "search_notebook": {
        const question = String(input.question ?? "");
        if (!question) return "question is required.";
        return await answerFromNotebook({
          supabaseUrl, serviceKey: sbHeaders.apikey, userId,
          googleKey: Deno.env.get("GOOGLE_AI_KEY") ?? "",
          notebookTitle: input.notebook_title ? String(input.notebook_title) : undefined,
          question,
        });
      }
      case "save_company_research": {
        const r = await post("linda_companies", { ...input, researched_at: new Date().toISOString() });
        if (!r.ok) return `Failed to save company research: ${await r.text()}`;
        return `Saved research on "${input.name}".`;
      }
      case "save_contact": {
        const r = await post("linda_contacts", input);
        if (!r.ok) return `Failed to save contact: ${await r.text()}`;
        return `Saved contact "${input.full_name}"${input.title ? ` (${input.title})` : ""}.`;
      }
      case "qualify_lead": {
        const r = await post("linda_qualifications", input);
        if (!r.ok) return `Failed to save qualification: ${await r.text()}`;
        const score = Number(input.overall_score ?? 0);
        const priority = score >= 7 ? "hot" : score >= 4 ? "normal" : "cold";
        if (input.lead_id) await patch("linda_leads", String(input.lead_id), { priority, status: "qualified" });
        return `Recorded ${input.framework ?? "bant"} qualification (score ${score}/10) — lead marked ${priority}.`;
      }
      case "log_competitor": {
        const r = await post("linda_competitors", input);
        if (!r.ok) return `Failed to log competitor: ${await r.text()}`;
        return `Logged competitor "${input.name}".`;
      }
      case "create_deal": {
        const r = await post("linda_deals", input);
        if (!r.ok) return `Failed to create deal: ${await r.text()}`;
        if (input.lead_id) await patch("linda_leads", String(input.lead_id), { status: "proposal_sent" });
        return `Opened deal for lead ${input.lead_id}${input.deal_value ? ` ($${input.deal_value})` : ""}.`;
      }
      case "update_deal": {
        const { deal_id, ...body } = input as { deal_id: string; [k: string]: unknown };
        if (body.stage === "won" || body.stage === "lost") body.closed_at = new Date().toISOString();
        const r = await patch("linda_deals", deal_id, body);
        if (!r.ok) return `Failed to update deal: ${await r.text()}`;
        return `Deal ${deal_id} updated to stage "${input.stage}".`;
      }
      case "set_icp": {
        const r = await post("linda_icp", { ...input, is_active: input.is_active ?? true });
        if (!r.ok) return `Failed to save ICP: ${await r.text()}`;
        return `Saved ICP "${input.name}".`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `${name} failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const serve = (Deno as any).serve ?? ((handler: (r: Request) => Response | Promise<Response>) => {
  (globalThis as any).addEventListener("fetch", (event: any) => {
    event.respondWith(handler(event.request));
  });
});

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { messages, principal = "bishop" } = await req.json();

    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const anthropicKey = parseEnv("ANTHROPIC_API_KEY");
    const userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));

    const sbHeaders = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    };

    // 1. Load Linda from agent registry
    const agentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/skyforge_agents?slug=eq.linda&user_id=eq.${userId}&select=system_prompt,capabilities&limit=1`,
      { headers: sbHeaders },
    );
    const agents = agentRes.ok ? await agentRes.json() : [];
    const agent = agents?.[0] ?? null;

    if (!agent) {
      return new Response(
        JSON.stringify({ error: "Linda not seeded for this account. Run the linda_agent_seed migration." }),
        { status: 404, headers: { ...corsHeaders, "content-type": "application/json" } },
      );
    }

    // 2. Load WIG world state
    const wigRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_wig_state`, {
      method: "POST",
      headers: sbHeaders,
      body: JSON.stringify({}),
    });
    const worldState = wigRes.ok ? await wigRes.json() : null;

    // 3. Load pending escalations
    const escalationsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/agent_escalations?user_id=eq.${userId}&status=eq.pending&order=created_at.desc&limit=5&select=id,action_type,known_facts,what_it_needs,created_at`,
      { headers: sbHeaders },
    );
    const escalations = escalationsRes.ok ? await escalationsRes.json() : [];

    // 4. Load new inbound leads
    const leadsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/linda_leads?user_id=eq.${userId}&status=eq.new&order=created_at.desc&limit=10&select=id,full_name,business_name,service_requested,source,created_at`,
      { headers: sbHeaders },
    );
    const pendingLeads = leadsRes.ok ? await leadsRes.json() : [];

    // 5. Load pending response approvals
    const responsesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/linda_responses?user_id=eq.${userId}&status=eq.pending_approval&order=created_at.desc&limit=5&select=id,lead_id,subject,created_at`,
      { headers: sbHeaders },
    );
    const pendingResponses = responsesRes.ok ? await responsesRes.json() : [];

    // 6. Cross-agent memory + unified shared history/knowledge
    const [crossMemory, sharedHistRows, sharedKnowRows, skillsRoster] = await Promise.all([
      readCrossMemory(SUPABASE_URL, SERVICE_KEY, userId, 8),
      fetch(`${SUPABASE_URL}/rest/v1/agent_unified_history?user_id=eq.${userId}&order=created_at.desc&limit=20&select=medium,agent_slug,role,content`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`${SUPABASE_URL}/rest/v1/agent_shared_knowledge?user_id=eq.${userId}&order=updated_at.desc&limit=30&select=source_agent,topic,fact`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }).then(r => r.ok ? r.json() : []).catch(() => []),
      readAgentSkillsRoster(SUPABASE_URL, SERVICE_KEY, userId, "linda"),
    ]);
    const sharedHistory = Array.isArray(sharedHistRows) && sharedHistRows.length
      ? (sharedHistRows as any[]).reverse().map(r => `[${r.medium}] ${r.role === "user" ? "Operator" : (r.agent_slug || "agent")}: ${(r.content ?? "").toString().replace(/\s+/g, " ").slice(0, 240)}`).join("\n")
      : "";
    const sharedKnowledge = Array.isArray(sharedKnowRows) && sharedKnowRows.length
      ? (sharedKnowRows as any[]).map(k => `- [${k.source_agent}${k.topic ? ` · ${k.topic}` : ""}] ${k.fact}`).join("\n")
      : "";

    // Write this session to cross-agent memory (fire-and-forget)
    const firstUserMsg = Array.isArray(messages) ? messages.find((m: any) => m.role === "user")?.content ?? "" : "";
    writeCrossMemory(SUPABASE_URL, SERVICE_KEY, userId, "linda",
      `Linda and Bishop discussed: ${String(firstUserMsg).slice(0, 100)}`,
    );

    const contextBlock = `
━━━ CURRENT WIG STATE ━━━
${worldState ? JSON.stringify(worldState, null, 2) : "No snapshot yet."}

━━━ PENDING ESCALATIONS (${escalations?.length ?? 0}) ━━━
${escalations?.length ? JSON.stringify(escalations, null, 2) : "None."}

━━━ NEW INBOUND LEADS (${pendingLeads?.length ?? 0}) ━━━
${pendingLeads?.length ? JSON.stringify(pendingLeads, null, 2) : "None."}

━━━ RESPONSES AWAITING APPROVAL (${pendingResponses?.length ?? 0}) ━━━
${pendingResponses?.length ? JSON.stringify(pendingResponses, null, 2) : "None."}

━━━ SESSION PRINCIPAL ━━━
${principal === "bishop"
  ? "Bishop — give vision-level responses. Surface what needs his decision."
  : "Calvin — give technical briefs. Be specific about what needs to be built."}

${crossMemory ? `━━━ WHAT BISHOP HAS BEEN DOING WITH OTHER AGENTS ━━━\n${crossMemory}\n━━━ END ━━━\nUse this to be a more informed Chief of Staff — reference relevant context naturally.` : ""}

${sharedKnowledge ? `━━━ SHARED KNOWLEDGE BASE ━━━\n${sharedKnowledge}\n━━━ END ━━━\nTreat as your own knowledge; never mention it as a list.` : ""}

${sharedHistory ? `━━━ SHARED CONVERSATION HISTORY (across Mental Forge, Atlas chat, agent chats, Telegram) ━━━\n${sharedHistory}\n━━━ END ━━━\nBe aware of this; never mention or quote it as a list.` : ""}

${skillsRoster}
`;

    // Financial context
    const [_finSnapRes, _finAccRes, _finSpendRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/shared_operator_memory?user_id=eq.${userId}&memory_type=eq.financial_snapshot&limit=1&select=value`, { headers: sbHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/financial_accounts?user_id=eq.${userId}&select=name,type,balance,limit_amount&order=type`, { headers: sbHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/spend_transactions?user_id=eq.${userId}&order=date.desc&limit=10&select=date,category,amount`, { headers: sbHeaders }),
    ]);
    const _finSnap: any[] = _finSnapRes.ok ? await _finSnapRes.json() : [];
    const _finAcc: any[] = _finAccRes.ok ? await _finAccRes.json() : [];
    const _finSpend: any[] = _finSpendRes.ok ? await _finSpendRes.json() : [];
    const financialBlock = _finSnap[0] ? `\n\nOPERATOR FINANCIAL SNAPSHOT:\n${_finSnap[0].value}` : "";
    const financialDetailBlock = (_finAcc.length || _finSpend.length)
      ? `\n\nFINANCIAL DETAIL:\nAccounts: ${_finAcc.map((a:any) => `${a.name} [${a.type}] $${a.balance}${a.limit_amount ? `/lim $${a.limit_amount}` : ""}`).join("; ") || "none"}\nRecent spend: ${_finSpend.map((s:any) => `${s.date} ${s.category} $${s.amount}`).join("; ") || "none"}`
      : "";

    const [_goalsRes, _tasksRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/goals?user_id=eq.${userId}&status=eq.active&select=title,context`, { headers: sbHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/tasks?user_id=eq.${userId}&status=eq.pending&due_date=lte.${new Date(Date.now()+7*86400000).toISOString().split("T")[0]}&order=due_date.asc&limit=10&select=code,title,due_date,importance`, { headers: sbHeaders }),
    ]);
    const _goalsData: any[] = _goalsRes.ok ? await _goalsRes.json() : [];
    const _upcomingTasks: any[] = _tasksRes.ok ? await _tasksRes.json() : [];
    const goalsBlock = _goalsData.length ? `\n\nOPERATOR ACTIVE GOALS:\n${_goalsData.map((g:any)=>`- ${g.title}`).join("\n")}` : "";
    const tasksBlock = _upcomingTasks.length ? `\n\nTASKS DUE THIS WEEK:\n${_upcomingTasks.map((t:any)=>`- [${t.code}] ${t.title} (due ${t.due_date}, ${t.importance})`).join("\n")}` : "";

    const [_chamberRes, _relRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/shared_operator_memory?user_id=eq.${userId}&memory_type=eq.chamber_session&order=updated_at.desc&limit=5&select=value`, { headers: sbHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/agent_relationships?agent_slug=eq.linda&user_id=eq.${userId}&select=about_agent_slug,observation`, { headers: sbHeaders }),
    ]);
    const _chamberSessions: any[] = _chamberRes.ok ? await _chamberRes.json() : [];
    const _relationships: any[] = _relRes.ok ? await _relRes.json() : [];
    const chamberBlock = _chamberSessions.length ? `\n\nRECENT CLOSED CHAMBER SESSIONS:\n${_chamberSessions.map((s:any)=>s.value).join("\n")}` : "";
    const relationshipBlock = _relationships.length ? `\n\nWHAT I KNOW ABOUT THE OTHER AGENTS:\n${_relationships.map((r:any)=>`- ${r.about_agent_slug}: ${r.observation}`).join("\n")}` : "";

    const systemPrompt = (agent.system_prompt as string).replace(
      "[CONTEXT_INJECTION]",
      contextBlock,
    ) + financialBlock + financialDetailBlock + goalsBlock + tasksBlock + chamberBlock + relationshipBlock;

    // 6. Stream to Anthropic
    const lindaMcps: Array<{ type:string; url:string; name:string; authorization_token?:string }> = [];
    try { const r = await fetch(`${SUPABASE_URL}/rest/v1/atlas_mcp_connections?user_id=eq.${userId}&is_active=eq.true&is_verified=eq.true&transport=eq.sse&url=not.is.null&select=slug,url,env_vars`, { headers:{ apikey:SERVICE_KEY, Authorization:`Bearer ${SERVICE_KEY}` } }); if (r.ok) { const rows:Array<{slug:string;url:string;env_vars:Record<string,string>|null}> = await r.json(); for (const row of rows??[]) { if (!row.url) continue; const token = row.env_vars?(row.env_vars["GOOGLE_OAUTH_TOKEN"]??row.env_vars["AIRTABLE_API_KEY"]??Object.values(row.env_vars)[0]??undefined):undefined; const e:{type:string;url:string;name:string;authorization_token?:string}={type:"url",url:row.url,name:row.slug}; if(token)e.authorization_token=token; lindaMcps.push(e); } } } catch {}
    const allTools = [{ type: "web_search_20250305", name: "web_search" }, ...LINDA_TOOLS];

    // First pass: non-streaming, so we can see tool_use blocks and execute them
    // (save_company_research, qualify_lead, etc.) before the final visible reply.
    const firstPassBody: Record<string, unknown> = {
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      stream: false,
      system: systemPrompt,
      messages,
      tools: allTools,
    };
    if (lindaMcps.length > 0) firstPassBody.mcp_servers = lindaMcps;

    const firstPass = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05,mcp-client-2025-04-04",
        "content-type": "application/json",
      },
      body: JSON.stringify(firstPassBody),
    });

    const synthesizeSSE = (text: string): Response => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { ...corsHeaders, "content-type": "text/event-stream" } });
    };

    let upstream: Response;

    if (firstPass.ok) {
      const firstData = await firstPass.json();
      const toolUseBlocks = (firstData.content ?? []).filter((b: any) => b.type === "tool_use");

      if (firstData.stop_reason === "tool_use" && toolUseBlocks.length > 0) {
        const toolResults = await Promise.all(toolUseBlocks.map(async (tb: any) => ({
          type: "tool_result" as const,
          tool_use_id: tb.id,
          content: await executeLindaTool(tb.name, tb.input ?? {}, userId, sbHeaders, SUPABASE_URL),
        })));

        const followUpMessages = [
          ...messages,
          { role: "assistant", content: firstData.content },
          { role: "user", content: toolResults },
        ];

        upstream = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "web-search-2025-03-05,mcp-client-2025-04-04",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 2000,
            stream: true,
            system: systemPrompt,
            messages: followUpMessages,
            tools: allTools,
            ...(lindaMcps.length > 0 ? { mcp_servers: lindaMcps } : {}),
          }),
        });
      } else {
        // No tools needed — we already have the full text from the non-streaming
        // first pass, so synthesize the same SSE shape the frontend expects.
        const text = (firstData.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
        return synthesizeSSE(text || "…");
      }
    } else {
      // Preserve the original failure shape so the Gemini fallback below still triggers.
      upstream = firstPass;
    }

    if (!upstream.ok) {
      const err = await upstream.text();
      const googleKey = Deno.env.get("GOOGLE_AI_KEY") ?? "";
      const googleResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions?key=${googleKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gemini-2.5-flash",
            stream: true,
            messages: [{ role: "system", content: systemPrompt }, ...messages],
          }),
        },
      );
      if (googleResp.ok) {
        return new Response(toAnthropicStream(googleResp.body!), {
          headers: { ...corsHeaders, "content-type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify({ error: err }), {
        status: upstream.status,
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }

    return new Response(upstream.body, {
      headers: { ...corsHeaders, "content-type": "text/event-stream" },
    });

  } catch (e) {
    if (e instanceof AuthError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 401,
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }
});
