// atlas_weekly_character_synthesis — Sunday 4am UTC
// Reads each agent's full week of sessions, reflections, cross-memory, and relationship
// events. Produces a character update (who they're becoming) and relationship ledger
// updates (how agents are evolving with each other).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function parseEnv(k: string): string {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

function hdr(key: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function get(url: string, key: string) {
  const r = await fetch(url, { headers: hdr(key) });
  return r.ok ? await r.json() : [];
}

async function upsert(url: string, key: string, body: unknown) {
  await fetch(url, {
    method: "POST",
    headers: { ...hdr(key), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body),
  });
}

async function insert(url: string, key: string, body: unknown) {
  await fetch(url, {
    method: "POST",
    headers: { ...hdr(key), Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
}

async function patch(url: string, key: string, body: unknown) {
  await fetch(url, { method: "PATCH", headers: { ...hdr(key), Prefer: "return=minimal" }, body: JSON.stringify(body) });
}

// Same ground-truth tools as agent_reflect -- inlined (this file is self-contained
// by design), so weekly character/calibration scoring isn't purely self-referential.
const SYNTHESIS_TOOLS = [
  {
    name: "search_notebook",
    description: "Search the operator's Notebook (saved documents/standards) for ground truth relevant to this agent's week.",
    input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  },
  {
    name: "search_airtable",
    description: "Read records from the operator's Airtable command center (Companies, People, Teams, Projects, Milestones, Tasks). Use to check real organizational state before writing a character assessment.",
    input_schema: {
      type: "object",
      properties: { table: { type: "string" }, filter_formula: { type: "string" } },
      required: ["table"],
    },
  },
  {
    name: "check_actual_outcome",
    description: "Read directly from the operator's own database (e.g. trade_ledger, income_pipeline, linda_deals) to check what actually happened this week, so calibration_score reflects real prediction-vs-outcome accuracy rather than a self-estimate.",
    input_schema: {
      type: "object",
      properties: { table: { type: "string" }, filter: { type: "string" } },
      required: ["table", "filter"],
    },
  },
];

async function runSynthesisTool(name: string, input: Record<string, unknown>, userId: string, supabaseUrl: string, serviceKey: string, googleKey: string): Promise<string> {
  const sbHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  try {
    if (name === "search_notebook") {
      const question = String(input.question ?? "");
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
      return (gData?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim() || "No answer found.";
    }
    if (name === "search_airtable") {
      const airtableKey = Deno.env.get("AIRTABLE_API_KEY") ?? "";
      if (!airtableKey) return "Airtable is not connected.";
      const table = String(input.table ?? "");
      const params = new URLSearchParams({ maxRecords: "15" });
      if (input.filter_formula) params.set("filterByFormula", String(input.filter_formula));
      const r = await fetch(`https://api.airtable.com/v0/appGr592LCUvJgYml/${encodeURIComponent(table)}?${params.toString()}`, { headers: { Authorization: `Bearer ${airtableKey}` } });
      if (!r.ok) return `Airtable error ${r.status}.`;
      const data = await r.json();
      const records: Array<{ id: string; fields: Record<string, unknown> }> = data.records ?? [];
      return records.length ? records.map(rec => `[${rec.id}] ${Object.entries(rec.fields).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join(" | ")}`).join("\n") : "No records found.";
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

async function callClaudeWithTools(apiKey: string, system: string, user: string, userId: string, supabaseUrl: string, serviceKey: string, googleKey: string): Promise<string> {
  const messages: Array<{ role: string; content: unknown }> = [{ role: "user", content: user }];
  for (let iter = 0; iter < 6; iter++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 2000, system, tools: SYNTHESIS_TOOLS, messages }),
    });
    if (!r.ok) throw new Error(`Claude ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const blocks: any[] = data.content ?? [];
    const toolUses = blocks.filter(b => b.type === "tool_use");
    if (!toolUses.length || data.stop_reason !== "tool_use") {
      return blocks.filter(b => b.type === "text").map(b => b.text ?? "").join("");
    }
    messages.push({ role: "assistant", content: blocks });
    const toolResults = await Promise.all(toolUses.map(async (tu) => ({
      type: "tool_result", tool_use_id: tu.id,
      content: await runSynthesisTool(tu.name, tu.input ?? {}, userId, supabaseUrl, serviceKey, googleKey),
    })));
    messages.push({ role: "user", content: toolResults });
  }
  return "";
}

async function callClaude(apiKey: string, system: string, user: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return (d.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("") ?? "";
}

function weekAgo(): string {
  return new Date(Date.now() - 7 * 86400000).toISOString();
}

function stageFromCount(sessionCount: number, eventCount: number): string {
  const score = sessionCount + eventCount * 3;
  if (score < 5)  return "early";
  if (score < 25) return "developing";
  if (score < 80) return "mature";
  return "senior";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const ANTHROPIC    = parseEnv("ANTHROPIC_API_KEY");
    const base         = `${SUPABASE_URL}/rest/v1`;
    const since        = weekAgo();

    const body = await req.json().catch(() => ({}));
    const targetUserId: string | null = body.user_id ?? null;

    const agentQuery = targetUserId
      ? `${base}/skyforge_agents?user_id=eq.${targetUserId}&is_active=eq.true&select=id,user_id,name,slug,role,system_prompt,version`
      : `${base}/skyforge_agents?is_active=eq.true&select=id,user_id,name,slug,role,system_prompt,version`;

    const agents: Array<{ id: string; user_id: string; name: string; slug: string; role: string; system_prompt: string; version: number }> = await get(agentQuery, SERVICE_KEY);

    const processed: string[] = [];

    for (const agent of agents) {
      try {
        // Load this week's data for this agent
        const [sessions, reflections, crossMem, existingChar, existingEvents] = await Promise.all([
          get(`${base}/agent_sessions?agent_id=eq.${agent.id}&started_at=gte.${since}&select=task_description,outcome,autonomy_score,outcome_notes&limit=30`, SERVICE_KEY),
          get(`${base}/agent_reflections?agent_id=eq.${agent.id}&created_at=gte.${since}&select=what_worked,what_failed,patterns,blind_spots,autonomy_delta,capability_gaps,quality_score&limit=10`, SERVICE_KEY),
          get(`${base}/agent_cross_memory?source_agent=eq.${agent.slug}&user_id=eq.${agent.user_id}&created_at=gte.${since}&select=summary,topic&limit=20`, SERVICE_KEY),
          get(`${base}/agent_character_state?agent_id=eq.${agent.id}&select=*&limit=1`, SERVICE_KEY),
          get(`${base}/agent_formative_events?agent_id=eq.${agent.id}&select=id&limit=1`, SERVICE_KEY),
        ]);

        const current = existingChar[0] ?? null;
        const totalSessions = (current?.formative_event_count ?? 0) + sessions.length;
        const totalEvents = existingEvents.length;

        if (!sessions.length && !reflections.length) {
          processed.push(`${agent.slug}: no activity`);
          continue;
        }

        // Build character synthesis prompt
        const systemPrompt = `You are a character analyst studying an AI agent named ${agent.name} (role: ${agent.role}).
Your job is to write a weekly character update — who this agent is BECOMING based on what actually happened this week.
This is not a summary. It is a living character assessment.

You have tools: search_notebook (the operator's saved documents/standards), search_airtable
(their live Companies/People/Teams/Projects/Milestones/Tasks command center), and
check_actual_outcome (read directly from the operator's database, e.g. trade_ledger or
income_pipeline, to see what a prediction this week actually resolved to). Use check_actual_outcome
before setting calibration_score if this agent made any claim or prediction with real evidence
available now — otherwise calibration_score is just a guess dressed up as a measurement.
Ground-truth rule: if search_notebook or search_airtable conflicts with what you were about to
conclude, the ground truth wins.

Once done using tools (or immediately, if none apply), respond with ONLY valid JSON, no markdown,
no tool calls in the same message as the JSON. Keys:
{
  "character_summary": "2-3 sentences: who they are right now, what defines them, what they're growing toward",
  "voice_evolution": "how their communication style has shifted this week — more direct? more cautious? warmer?",
  "earned_strengths": ["max 4 specific strengths they've demonstrated this week, earned not assigned"],
  "known_blind_spots": ["max 3 specific patterns where they consistently fall short"],
  "sycophancy_score": 0.0,
  "calibration_score": 0.0,
  "formative_event": {
    "detected": true or false,
    "event_summary": "what happened that changed something",
    "belief_before": "what they believed before",
    "belief_after": "what they believe now",
    "character_implication": "what this says about who they are",
    "domain": "the domain this affected",
    "impact_score": 0.0
  }
}

sycophancy_score: 0.0 = fully independent, 1.0 = always agrees with operator. Estimate from session patterns.
calibration_score: 0.0 = wildly overconfident, 1.0 = perfectly calibrated. Estimate from outcome vs prediction patterns.
formative_event.detected: true only if something this week genuinely changed the agent's beliefs or approach.`;

        const sessionSummary = sessions.map((s: any) =>
          `Task: ${s.task_description ?? "unknown"} | Outcome: ${s.outcome ?? "pending"} | Autonomy: ${s.autonomy_score ?? "?"}`
        ).join("\n");

        const reflectionSummary = reflections.map((r: any) =>
          `Worked: ${r.what_worked ?? ""} | Failed: ${r.what_failed ?? ""} | Patterns: ${r.patterns ?? ""} | Blind spots: ${r.blind_spots ?? ""} | Quality: ${r.quality_score ?? ""}`
        ).join("\n");

        const crossSummary = crossMem.map((c: any) => `[${c.topic ?? "general"}] ${c.summary}`).join("\n");

        const userPrompt = `Sessions this week (${sessions.length}):\n${sessionSummary || "none"}\n\nReflections:\n${reflectionSummary || "none"}\n\nCross-agent signals:\n${crossSummary || "none"}\n\nPrior character: ${current?.character_summary ?? "First assessment — agent is new."}\n\nPrior blind spots: ${(current?.known_blind_spots ?? []).join(", ") || "none recorded"}\n\nNow write the character update.`;

        const raw = await callClaudeWithTools(ANTHROPIC, systemPrompt, userPrompt, agent.user_id, SUPABASE_URL, SERVICE_KEY, Deno.env.get("GOOGLE_AI_KEY") ?? "");
        let parsed: any;
        try {
          parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
        } catch {
          processed.push(`${agent.slug}: parse error`);
          continue;
        }

        const newStage = stageFromCount(totalSessions, totalEvents + (parsed.formative_event?.detected ? 1 : 0));

        // Upsert character state
        await upsert(`${base}/agent_character_state`, SERVICE_KEY, {
          agent_id: agent.id,
          user_id: agent.user_id,
          developmental_stage: newStage,
          character_summary: parsed.character_summary ?? current?.character_summary,
          voice_evolution: parsed.voice_evolution ?? current?.voice_evolution,
          earned_strengths: parsed.earned_strengths ?? [],
          known_blind_spots: parsed.known_blind_spots ?? [],
          sycophancy_score: parsed.sycophancy_score ?? current?.sycophancy_score ?? 0.5,
          calibration_score: parsed.calibration_score ?? current?.calibration_score ?? 0.5,
          formative_event_count: totalEvents + (parsed.formative_event?.detected ? 1 : 0),
          updated_at: new Date().toISOString(),
        });

        // Write formative event if detected
        if (parsed.formative_event?.detected && parsed.formative_event?.event_summary) {
          await insert(`${base}/agent_formative_events`, SERVICE_KEY, {
            agent_id: agent.id,
            user_id: agent.user_id,
            event_summary: parsed.formative_event.event_summary,
            belief_before: parsed.formative_event.belief_before ?? null,
            belief_after: parsed.formative_event.belief_after ?? null,
            character_implication: parsed.formative_event.character_implication ?? null,
            domain: parsed.formative_event.domain ?? null,
            impact_score: parsed.formative_event.impact_score ?? 0.5,
          });
        }

        // Log to cross memory
        await insert(`${base}/agent_cross_memory`, SERVICE_KEY, {
          user_id: agent.user_id,
          source_agent: agent.slug,
          summary: `Weekly character update: ${parsed.character_summary ?? "updated"}`,
          topic: "character_synthesis",
        });

        processed.push(`${agent.slug}: updated (stage=${newStage}, formative=${parsed.formative_event?.detected})`);

      } catch (agentErr) {
        console.error(`[character_synthesis] ${agent.slug}:`, agentErr);
        processed.push(`${agent.slug}: error`);
      }
    }

    // Relationship ledger update — for each pair of agents under same user
    const userIds = [...new Set(agents.map(a => a.user_id))];
    for (const uid of userIds) {
      const userAgents = agents.filter(a => a.user_id === uid);
      for (let i = 0; i < userAgents.length; i++) {
        for (let j = i + 1; j < userAgents.length; j++) {
          const a = userAgents[i];
          const b = userAgents[j];

          const [aCross, bCross, existing] = await Promise.all([
            get(`${base}/agent_cross_memory?source_agent=eq.${a.slug}&user_id=eq.${uid}&created_at=gte.${since}&select=summary,topic&limit=15`, SERVICE_KEY),
            get(`${base}/agent_cross_memory?source_agent=eq.${b.slug}&user_id=eq.${uid}&created_at=gte.${since}&select=summary,topic&limit=15`, SERVICE_KEY),
            get(`${base}/agent_relationship_ledger?user_id=eq.${uid}&agent_a_slug=eq.${a.slug}&agent_b_slug=eq.${b.slug}&select=*&limit=1`, SERVICE_KEY),
          ]);

          if (!aCross.length && !bCross.length) continue;

          const relSystem = `You analyze the evolving relationship between two AI agents.
Respond ONLY with valid JSON:
{
  "interaction_count_delta": 0,
  "agreement_count_delta": 0,
  "disagreement_count_delta": 0,
  "domain_deference": { "domain": "which_agent_slug" },
  "current_dynamic": "peer|mentor_a|mentor_b|challenger|collaborator|rival",
  "relationship_summary": "1-2 sentences on the current state of this relationship"
}`;

          const relPrompt = `Agent A: ${a.name} (${a.slug})\nAgent B: ${b.name} (${b.slug})\n\n${a.name}'s signals this week:\n${aCross.map((c: any) => c.summary).join("\n")}\n\n${b.name}'s signals this week:\n${bCross.map((c: any) => c.summary).join("\n")}\n\nPrior relationship: ${existing[0]?.relationship_summary ?? "New relationship — no history yet."}\n\nAssess this week's dynamic.`;

          const relRaw = await callClaude(ANTHROPIC, relSystem, relPrompt).catch(() => null);
          if (!relRaw) continue;

          let relParsed: any;
          try { relParsed = JSON.parse(relRaw.replace(/```json|```/g, "").trim()); }
          catch { continue; }

          const prev = existing[0];
          await upsert(`${base}/agent_relationship_ledger`, SERVICE_KEY, {
            user_id: uid,
            agent_a_slug: a.slug,
            agent_b_slug: b.slug,
            interaction_count: (prev?.interaction_count ?? 0) + (relParsed.interaction_count_delta ?? 0),
            agreement_count:   (prev?.agreement_count   ?? 0) + (relParsed.agreement_count_delta   ?? 0),
            disagreement_count:(prev?.disagreement_count?? 0) + (relParsed.disagreement_count_delta ?? 0),
            domain_deference:  { ...(prev?.domain_deference ?? {}), ...(relParsed.domain_deference ?? {}) },
            current_dynamic:   relParsed.current_dynamic ?? prev?.current_dynamic ?? "peer",
            relationship_summary: relParsed.relationship_summary ?? prev?.relationship_summary,
            last_interaction_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, processed }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[atlas_weekly_character_synthesis]", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
