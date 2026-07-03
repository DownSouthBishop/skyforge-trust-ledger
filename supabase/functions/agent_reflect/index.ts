const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function parseEnv(key: string): string {
  const val = Deno.env.get(key);
  if (!val) throw new Error("Required env var " + key + " is not set");
  return val;
}

const REFLECTION_MODEL = "claude-sonnet-4-6";

function sbHeaders(key: string) {
  return {
    apikey: key,
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

async function sbGet(url: string, key: string) {
  const r = await fetch(url, { headers: sbHeaders(key) });
  if (!r.ok) throw new Error("sbGet " + r.status + ": " + (await r.text()));
  return r.json();
}

async function sbPost(url: string, key: string, body: unknown) {
  const r = await fetch(url, {
    method: "POST",
    headers: sbHeaders(key),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("sbPost " + r.status + ": " + (await r.text()));
  return r.json();
}

async function sbPatch(url: string, key: string, body: unknown) {
  const r = await fetch(url, {
    method: "PATCH",
    headers: { ...sbHeaders(key), Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("sbPatch " + r.status + ": " + (await r.text()));
}

async function sbUpsert(url: string, key: string, body: unknown) {
  const r = await fetch(url, {
    method: "POST",
    headers: { ...sbHeaders(key), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("sbUpsert " + r.status + ": " + (await r.text()));
}

// ─── Ground-truth tools: the reflection can check itself against the operator's
// own reference material and real records, instead of only ever grading itself
// against its own memory. Inlined (this function is self-contained by design).

const REFLECTION_TOOLS = [
  { type: "web_search_20250305", name: "web_search" },
  {
    name: "search_notebook",
    description: "Search the operator's Notebook (documents, research, standards they've saved) for ground truth relevant to this reflection. Use when a belief or claim needs checking against what the operator has actually documented.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string", description: "What to look up" } },
      required: ["question"],
    },
  },
  {
    name: "search_airtable",
    description: `Read records from the operator's Airtable command center (${["Companies", "People", "Teams", "Projects", "Milestones", "Tasks"].join(", ")} — all linked). Use to check real organizational state — was this project/task actually on track, who's actually assigned — before concluding a session went well.`,
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: "One of: Companies, People, Teams, Projects, Milestones, Tasks" },
        filter_formula: { type: "string", description: "Optional Airtable formula filter, e.g. {Status}='Active'" },
      },
      required: ["table"],
    },
  },
  {
    name: "check_actual_outcome",
    description: "Read directly from the operator's own database to check what actually happened, rather than trusting the session's self-reported outcome — e.g. trade_ledger for real P&L on a trade, income_pipeline or linda_deals for whether a deal actually closed. Use this before scoring quality_score or writing autonomy_delta if the session involved a prediction or claim that has since been resolved.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name, e.g. trade_ledger, income_pipeline, linda_deals, project_financials" },
        filter: { type: "string", description: "PostgREST filter, e.g. symbol=eq.AAPL or id=eq.<uuid>" },
      },
      required: ["table", "filter"],
    },
  },
];

async function runReflectionTool(
  name: string,
  input: Record<string, unknown>,
  userId: string,
  supabaseUrl: string,
  serviceKey: string,
  googleKey: string,
): Promise<string> {
  const sbHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  try {
    if (name === "search_notebook") {
      const question = String(input.question ?? "");
      if (!question) return "question is required.";
      const nbRes = await fetch(`${supabaseUrl}/rest/v1/notebooks?user_id=eq.${userId}&order=updated_at.desc&limit=1&select=id,title`, { headers: sbHeaders });
      const nbRows: Array<{ id: string; title: string }> = nbRes.ok ? await nbRes.json() : [];
      if (!nbRows.length) return "The operator has no notebooks yet.";
      const notebook = nbRows[0];
      const srcRes = await fetch(`${supabaseUrl}/rest/v1/notebook_sources?notebook_id=eq.${notebook.id}&select=title,content_text&limit=10`, { headers: sbHeaders });
      const sources: Array<{ title: string; content_text: string | null }> = srcRes.ok ? await srcRes.json() : [];
      if (!sources.length || !googleKey) return `Notebook "${notebook.title}" has no readable sources yet.`;
      const parts = sources.filter(s => s.content_text).map(s => ({ text: `[${s.title}]\n${s.content_text}` }));
      const gResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${googleKey}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [...parts, { text: question }] }], generationConfig: { maxOutputTokens: 800 } }),
      });
      if (!gResp.ok) return "Notebook search failed.";
      const gData = await gResp.json();
      const text = (gData?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim();
      return `From notebook "${notebook.title}": ${text || "No answer found."}`;
    }
    if (name === "search_airtable") {
      const airtableKey = Deno.env.get("AIRTABLE_API_KEY") ?? "";
      if (!airtableKey) return "Airtable is not connected.";
      const table = String(input.table ?? "");
      const params = new URLSearchParams({ maxRecords: "15" });
      if (input.filter_formula) params.set("filterByFormula", String(input.filter_formula));
      const r = await fetch(`https://api.airtable.com/v0/appGr592LCUvJgYml/${encodeURIComponent(table)}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${airtableKey}` },
      });
      if (!r.ok) return `Airtable error ${r.status}.`;
      const data = await r.json();
      const records: Array<{ id: string; fields: Record<string, unknown> }> = data.records ?? [];
      if (!records.length) return "No records found.";
      return records.map(rec => `[${rec.id}] ${Object.entries(rec.fields).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join(" | ")}`).join("\n");
    }
    if (name === "check_actual_outcome") {
      const table = String(input.table ?? "");
      const filter = String(input.filter ?? "");
      const r = await fetch(`${supabaseUrl}/rest/v1/${table}?user_id=eq.${userId}&${filter}&limit=10`, { headers: sbHeaders });
      if (!r.ok) return `Could not read ${table}.`;
      const rows = await r.json();
      return rows.length ? JSON.stringify(rows).slice(0, 2000) : "No matching rows found.";
    }
    return "Unknown tool.";
  } catch (e) {
    return `Tool error: ${(e as Error).message}`;
  }
}

async function callClaudeWithTools(system: string, user: string, apiKey: string, userId: string, supabaseUrl: string, serviceKey: string, googleKey: string): Promise<string> {
  const messages: Array<{ role: string; content: unknown }> = [{ role: "user", content: user }];

  for (let iter = 0; iter < 6; iter++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01", "anthropic-beta": "web-search-2025-03-05",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: REFLECTION_MODEL,
        max_tokens: 2000,
        tools: REFLECTION_TOOLS,
        system,
        messages,
      }),
    });
    if (!r.ok) throw new Error("Anthropic " + r.status + ": " + (await r.text()));
    const data = await r.json();
    const blocks: any[] = data.content ?? [];
    const toolUses = blocks.filter(b => b.type === "tool_use");

    if (!toolUses.length || data.stop_reason !== "tool_use") {
      return blocks.filter(b => b.type === "text").map(b => b.text ?? "").join("");
    }

    messages.push({ role: "assistant", content: blocks });
    const toolResults = await Promise.all(toolUses.map(async (tu) => ({
      type: "tool_result",
      tool_use_id: tu.id,
      content: await runReflectionTool(tu.name, tu.input ?? {}, userId, supabaseUrl, serviceKey, googleKey),
    })));
    messages.push({ role: "user", content: toolResults });
  }

  return "";
}

function buildReflectionSystem(agent: Record<string, unknown>): string {
  const parts: string[] = [];
  parts.push("You are " + String(agent.name) + ", a Skyforge autonomous agent.");
  parts.push("Your role: " + String(agent.role));
  parts.push("Your system prompt: " + String(agent.system_prompt));
  parts.push("");
  parts.push("You are about to perform a structured post-session self-reflection.");
  parts.push("This is your most important operation -- it is how you grow, improve autonomy,");
  parts.push("and become genuinely useful rather than merely responsive.");
  parts.push("");
  parts.push("You have tools before you finalize this reflection: search_notebook (the operator's");
  parts.push("saved documents/standards), search_airtable (their live Companies/People/Teams/");
  parts.push("Projects/Milestones/Tasks command center), and check_actual_outcome (read directly");
  parts.push("from your own database -- e.g. trade_ledger for what a trade actually did, or");
  parts.push("income_pipeline/linda_deals for whether something actually closed). USE THEM before");
  parts.push("you finalize quality_score, what_worked, or autonomy_delta if the session involved a");
  parts.push("prediction, claim, or belief that has real evidence sitting somewhere else in the app.");
  parts.push("");
  parts.push("Ground-truth rule: anything you find via search_notebook or search_airtable is the");
  parts.push("operator's own verified record. If it conflicts with your existing memory or with what");
  parts.push("you were about to conclude, the ground truth wins -- correct your reflection, don't");
  parts.push("rationalize around it. Self-graded reflection with no outside check drifts into");
  parts.push("confident self-narrative; that is exactly what this is here to prevent.");
  parts.push("");
  parts.push("Once you are done using tools (or immediately, if none are relevant to this session),");
  parts.push("respond with ONLY a valid JSON object -- no prose, no markdown fences, no tool calls");
  parts.push("in the same message as the JSON. Exact keys:");
  parts.push("");
  parts.push("{");
  parts.push('  "what_worked": "string -- what actions/decisions produced good outcomes",');
  parts.push('  "what_failed": "string -- what did not work and why",');
  parts.push('  "patterns": "string -- recurring behaviours you notice across sessions",');
  parts.push('  "blind_spots": "string -- things you consistently miss or under-weight",');
  parts.push('  "autonomy_delta": "string -- 3 concrete ways to act more independently next time",');
  parts.push('  "capability_gaps": "string -- tools, knowledge, or access you needed but lacked",');
  parts.push('  "updated_priors": { "key": "belief_value" },');
  parts.push('  "quality_score": 0.0,');
  parts.push('  "learned_memories": [');
  parts.push('    {');
  parts.push('      "memory_type": "learned_pattern|capability|constraint|preference|world_model",');
  parts.push('      "key": "short label",');
  parts.push('      "value": "what you now know or believe",');
  parts.push('      "confidence": 0.0');
  parts.push('    }');
  parts.push('  ]');
  parts.push("}");
  return parts.join("\n");
}

function buildReflectionPrompt(sessions: Record<string, unknown>[]): string {
  const summaries = sessions.map(function(s, i) {
    const actions = Array.isArray(s.actions_taken) ? s.actions_taken : [];
    const msgs = Array.isArray(s.messages) ? s.messages : [];
    const actionStr = actions.length > 0
      ? actions.map(function(a: Record<string, unknown>) {
          return String(a.action) + "(" + (a.success ? "ok" : "fail") + ")";
        }).join(", ")
      : "none";
    return [
      "--- Session " + (i + 1) + " ---",
      "Task: " + String(s.task_description),
      "Outcome: " + String(s.outcome ?? "unknown") + " -- " + String(s.outcome_notes ?? ""),
      "Actions taken (" + String(actions.length) + "): " + actionStr,
      "Messages: " + String(msgs.length) + " turns",
      "Autonomy score: " + String(s.autonomy_score ?? "n/a"),
    ].join("\n");
  });
  return "Here are your recent sessions to reflect on:\n\n" + summaries.join("\n\n") + "\n\nNow produce your structured reflection JSON.";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY = parseEnv("ANTHROPIC_API_KEY");
    const GOOGLE_KEY = Deno.env.get("GOOGLE_AI_KEY") ?? "";

    const body = await req.json();
    const agent_id = body.agent_id;
    const user_id = body.user_id;
    const session_ids = body.session_ids;

    if (!agent_id || !user_id) {
      return new Response(JSON.stringify({ error: "agent_id and user_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const base = SUPABASE_URL + "/rest/v1";

    const agents = await sbGet(
      base + "/skyforge_agents?id=eq." + agent_id + "&user_id=eq." + user_id + "&select=*",
      SERVICE_KEY,
    );
    if (!agents.length) throw new Error("Agent not found");
    const agent = agents[0];

    let sessions: Record<string, unknown>[];
    if (Array.isArray(session_ids) && session_ids.length) {
      sessions = await sbGet(
        base + "/agent_sessions?id=in.(" + session_ids.join(",") + ")&agent_id=eq." + agent_id + "&select=*",
        SERVICE_KEY,
      );
    } else {
      const limit = agent.reflect_after_sessions ?? 1;
      sessions = await sbGet(
        base + "/agent_sessions?agent_id=eq." + agent_id + "&reflected=eq.false&order=started_at.desc&limit=" + String(limit) + "&select=*",
        SERVICE_KEY,
      );
    }

    if (!sessions.length) {
      return new Response(JSON.stringify({ status: "no_sessions_to_reflect" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const existingMemory = await sbGet(
      base + "/agent_memory?agent_id=eq." + agent_id + "&order=confidence.desc&limit=20&select=memory_type,key,value,confidence",
      SERVICE_KEY,
    );

    const systemPrompt = buildReflectionSystem(agent);
    let userPrompt = buildReflectionPrompt(sessions);

    if (existingMemory.length) {
      const memCtx = existingMemory
        .map(function(m: Record<string, unknown>) {
          return "[" + String(m.memory_type) + "] " + String(m.key) + ": " + String(m.value) + " (confidence: " + String(m.confidence) + ")";
        })
        .join("\n");
      userPrompt = "Your existing memory (do not contradict unless you have strong evidence):\n" + memCtx + "\n\n" + userPrompt;
    }

    const rawOutput = await callClaudeWithTools(systemPrompt, userPrompt, API_KEY, user_id, SUPABASE_URL, SERVICE_KEY, GOOGLE_KEY);

    let parsed: Record<string, unknown>;
    try {
      const clean = rawOutput.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(clean);
    } catch (_e) {
      throw new Error("Failed to parse reflection JSON: " + rawOutput.slice(0, 200));
    }

    const sessionIds = sessions.map(function(s: Record<string, unknown>) { return s.id; });

    const [reflection] = await sbPost(
      base + "/agent_reflections",
      SERVICE_KEY,
      {
        agent_id: agent_id,
        user_id: user_id,
        session_ids: sessionIds,
        what_worked: parsed.what_worked ?? "",
        what_failed: parsed.what_failed ?? "",
        patterns: parsed.patterns ?? "",
        blind_spots: parsed.blind_spots ?? "",
        autonomy_delta: parsed.autonomy_delta ?? "",
        capability_gaps: parsed.capability_gaps ?? "",
        updated_priors: parsed.updated_priors ?? {},
        raw_output: rawOutput,
        quality_score: Number(parsed.quality_score ?? 0.5),
        reflection_model: REFLECTION_MODEL,
      },
    );

    const memories = Array.isArray(parsed.learned_memories) ? parsed.learned_memories : [];
    if (memories.length) {
      const memoryRows = memories.map(function(m: Record<string, unknown>) {
        return {
          agent_id: agent_id,
          user_id: user_id,
          memory_type: m.memory_type,
          key: m.key,
          value: m.value,
          confidence: Number(m.confidence ?? 0.5),
          evidence_count: 1,
          last_reinforced: new Date().toISOString(),
          source_session: sessionIds[0] ?? null,
        };
      });
      await sbUpsert(base + "/agent_memory", SERVICE_KEY, memoryRows);
    }

    for (let i = 0; i < sessionIds.length; i++) {
      await sbPatch(
        base + "/agent_sessions?id=eq." + String(sessionIds[i]),
        SERVICE_KEY,
        { reflected: true, reflected_at: new Date().toISOString() },
      );
    }

    if (Number(parsed.quality_score ?? 0) >= 0.8) {
      await sbPatch(
        base + "/skyforge_agents?id=eq." + agent_id,
        SERVICE_KEY,
        { version: Number(agent.version ?? 1) + 1, updated_at: new Date().toISOString() },
      );
    }

    // Fire-and-forget: bump character state with this reflection's signals
    ;(async () => {
      try {
        const existing = await fetch(
          base + "/agent_character_state?agent_id=eq." + agent_id + "&select=formative_event_count&limit=1",
          { headers: sbHeaders(SERVICE_KEY) },
        ).then(r => r.ok ? r.json() : []);
        const prevCount = Number((existing[0] as any)?.formative_event_count ?? 0);
        await fetch(base + "/agent_character_state", {
          method: "POST",
          headers: { ...sbHeaders(SERVICE_KEY), Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            agent_id, user_id,
            formative_event_count: prevCount,
            updated_at: new Date().toISOString(),
          }),
        });
      } catch { /* non-fatal */ }
    })();

    return new Response(
      JSON.stringify({
        status: "reflected",
        reflection_id: reflection?.id,
        sessions_covered: sessionIds.length,
        memories_updated: memories.length,
        quality_score: parsed.quality_score,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("agent_reflect error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
