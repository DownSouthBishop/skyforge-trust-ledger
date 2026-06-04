// Linda streaming chat — mirrors forge_chat pattern exactly
// Reads Linda's system prompt from skyforge_agents table
// Injects WIG world state + pending leads + escalations before first token

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
class AuthError extends Error { constructor(m: string) { super(m); this.name = "AuthError"; } }
function parseEnv(k: string): string { const v = (Deno as any).env.get(k); if (!v) throw new Error(`Required env var ${k} is not set`); return v; }
async function verifyUser(url: string, key: string, auth: string | null): Promise<string> { if (!auth) throw new AuthError("Missing Authorization header"); const token = auth.replace("Bearer ","").trim(); const r = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: key } }); if (!r.ok) throw new AuthError("Invalid or expired token"); const d = await r.json(); if (!d?.id) throw new AuthError("No user ID"); return d.id; }
async function readCrossMemory(url: string, key: string, userId: string, limit = 8): Promise<string> { try { const r = await fetch(`${url}/rest/v1/agent_cross_memory?user_id=eq.${userId}&order=created_at.desc&limit=${limit}&select=source_agent,summary,topic`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }); if (!r.ok) return ""; const rows: any[] = await r.json(); if (!rows?.length) return ""; return rows.reverse().map((x: any) => `[${x.source_agent}${x.topic ? ` · ${x.topic}` : ""}] ${x.summary}`).join("\n"); } catch { return ""; } }
function writeCrossMemory(url: string, key: string, userId: string, agent: string, summary: string, topic?: string): void { fetch(`${url}/rest/v1/agent_cross_memory`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ user_id: userId, source_agent: agent, summary, topic: topic ?? null }) }).catch(() => {}); }

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

    // 6. Cross-agent memory — what has Bishop been doing with other agents
    const crossMemory = await readCrossMemory(SUPABASE_URL, SERVICE_KEY, userId, 8);

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
`;

    const systemPrompt = (agent.system_prompt as string).replace(
      "[CONTEXT_INJECTION]",
      contextBlock,
    );

    // 6. Stream to Anthropic
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        stream: true,
        system: systemPrompt,
        messages,
      }),
    });

    if (!upstream.ok) {
      const err = await upstream.text();
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
