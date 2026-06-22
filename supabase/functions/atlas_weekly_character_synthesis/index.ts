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

Respond ONLY with valid JSON, no markdown. Keys:
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

        const raw = await callClaude(ANTHROPIC, systemPrompt, userPrompt);
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
