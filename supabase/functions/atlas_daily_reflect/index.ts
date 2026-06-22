// atlas_daily_reflect — nightly sweep: reflects all agents with unreflected sessions,
// then writes a cross-agent synthesis to agent_cross_memory.

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

async function post(url: string, key: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { ...hdr(key), Prefer: "return=representation" }, body: JSON.stringify(body) });
  return r.ok ? await r.json() : null;
}

async function callClaude(apiKey: string, system: string, user: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1200, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return (d.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("") ?? "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const ANTHROPIC    = parseEnv("ANTHROPIC_API_KEY");
    const base         = `${SUPABASE_URL}/rest/v1`;

    const body = await req.json().catch(() => ({}));
    const targetUserId: string | null = body.user_id ?? null;

    // 1. Load all active agents
    const agentQuery = targetUserId
      ? `${base}/skyforge_agents?user_id=eq.${targetUserId}&is_active=eq.true&select=id,user_id,name,slug`
      : `${base}/skyforge_agents?is_active=eq.true&select=id,user_id,name,slug`;
    const agents: Array<{ id: string; user_id: string; name: string; slug: string }> = await get(agentQuery, SERVICE_KEY);

    const results: Array<{ agent: string; status: string; sessions: number }> = [];
    const synthesisParts: string[] = [];

    // 2. For each agent, invoke agent_reflect if unreflected sessions exist
    for (const agent of agents) {
      const sessions: Array<{ id: string }> = await get(
        `${base}/agent_sessions?agent_id=eq.${agent.id}&reflected=eq.false&select=id&limit=20`,
        SERVICE_KEY,
      );

      if (!sessions.length) {
        results.push({ agent: agent.slug, status: "no_sessions", sessions: 0 });
        continue;
      }

      const reflectResp = await fetch(`${SUPABASE_URL}/functions/v1/agent_reflect`, {
        method: "POST",
        headers: { ...hdr(SERVICE_KEY), Authorization: `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({ agent_id: agent.id, user_id: agent.user_id }),
      });

      const reflectData = reflectResp.ok ? await reflectResp.json() : null;
      const status = reflectData?.status ?? (reflectResp.ok ? "reflected" : "error");
      results.push({ agent: agent.slug, status, sessions: sessions.length });

      if (reflectData?.what_worked || reflectData?.patterns) {
        synthesisParts.push(`[${agent.slug}] worked: ${reflectData.what_worked ?? ""} | patterns: ${reflectData.patterns ?? ""} | gaps: ${reflectData.capability_gaps ?? ""}`);
      }
    }

    // 3. Cross-agent synthesis — what did ALL agents collectively learn today?
    if (synthesisParts.length >= 2) {
      const synthesis = await callClaude(
        ANTHROPIC,
        "You synthesize learnings across a network of AI agents. Be concise, direct, and specific. Output 2–3 sentences max.",
        `Today's individual agent learnings:\n${synthesisParts.join("\n")}\n\nWhat do these agents collectively understand about the operator and their work that no single agent has fully articulated? What pattern spans all of them?`,
      ).catch(() => null);

      if (synthesis) {
        const userIds = [...new Set(agents.map(a => a.user_id))];
        for (const uid of userIds) {
          await post(`${base}/agent_cross_memory`, SERVICE_KEY, {
            user_id: uid,
            source_agent: "system",
            summary: synthesis,
            topic: "daily_synthesis",
          });
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, agents_processed: agents.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[atlas_daily_reflect]", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
