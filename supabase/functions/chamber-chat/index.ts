import { corsHeaders, parseEnv, verifyUser } from "../_shared/gateway.ts";

const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const HAIKU = "claude-haiku-4-5-20251001";

function dbHeaders(key: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}
async function dbGet(url: string, key: string): Promise<any[]> {
  try { const r = await fetch(url, { headers: dbHeaders(key) }); return r.ok ? await r.json() : []; } catch { return []; }
}

async function anthropicNonStream(apiKey: string, system: string, content: string, max = 100): Promise<string> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: HAIKU, max_tokens: max, system, messages: [{ role: "user", content }] }),
    });
    if (!r.ok) return "";
    const j = await r.json();
    return (j.content?.[0]?.text ?? "").trim();
  } catch { return ""; }
}

/** Call one agent and return its full response text. Anthropic first, Gemini fallback. */
async function callAgent(opts: {
  apiKey: string;
  googleKey: string;
  slug: string;
  agentName: string;
  systemPrompt: string;
  msgs: Array<{ role: string; content: string }>;
}): Promise<{ slug: string; name: string; full: string }> {
  const { apiKey, googleKey, slug, agentName, systemPrompt, msgs } = opts;
  let full = "";

  // Try Anthropic first
  if (apiKey) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 600, system: systemPrompt, messages: msgs, stream: true }),
      });
      if (r.ok && r.body) {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const d = JSON.parse(line.slice(6));
              const t = d.delta?.text;
              if (t) full += t;
            } catch {}
          }
        }
        if (full) return { slug, name: agentName, full };
      }
      // Fall through on credit/rate errors
      const status = r.status;
      if (status !== 400 && status !== 402 && status !== 429 && status < 500) {
        return { slug, name: agentName, full: "[agent unavailable]" };
      }
    } catch { /* fall through to Gemini */ }
  }

  // Gemini fallback
  if (googleKey) {
    try {
      const geminiMsgs = [{ role: "user", content: `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${msgs.at(-1)?.content ?? ""}` }];
      const gr = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions?key=${googleKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gemini-2.5-flash", max_tokens: 600, messages: geminiMsgs }),
        },
      );
      if (gr.ok) {
        const gd = await gr.json();
        full = gd?.choices?.[0]?.message?.content?.trim() ?? "";
      }
    } catch { /* ignore */ }
  }

  return { slug, name: agentName, full: full || "[agent unavailable]" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("Claude_API") ?? "";
    const GOOGLE_KEY = Deno.env.get("GOOGLE_AI_KEY") ?? "";

    const userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    const body = await req.json();
    const { session_id, entry_id, agent_slugs } = body as {
      session_id: string; entry_id?: string; agent_slugs: string[];
    };

    if (!ANTHROPIC_KEY && !GOOGLE_KEY) return new Response(JSON.stringify({ error: "No AI provider configured" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    // Fetch entry
    let entryContent = "";
    if (entry_id) {
      const e = await dbGet(`${SUPABASE_URL}/rest/v1/chamber_entries?id=eq.${entry_id}&select=title,content`, SERVICE_KEY);
      if (e[0]) entryContent = `${e[0].title ? e[0].title + "\n" : ""}${e[0].content}`;
    }

    // Shared memory
    const shared = await dbGet(`${SUPABASE_URL}/rest/v1/shared_operator_memory?user_id=eq.${userId}&order=updated_at.desc&limit=20&select=memory_type,value`, SERVICE_KEY);
    const sharedMemoryBlock = shared.map((s: any) => `- [${s.memory_type}] ${s.value}`).join("\n");

    // Chamber message history
    const history: Array<{ role: string; agent_slug: string; content: string }> = await dbGet(
      `${SUPABASE_URL}/rest/v1/chamber_messages?session_id=eq.${session_id}&order=created_at.asc&limit=20&select=role,agent_slug,content`,
      SERVICE_KEY,
    );

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: any) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

        // Fetch all agent configs in parallel
        const agentConfigs = await Promise.all(
          agent_slugs.map(slug =>
            dbGet(`${SUPABASE_URL}/rest/v1/skyforge_agents?user_id=eq.${userId}&slug=eq.${slug}&limit=1&select=name,system_prompt`, SERVICE_KEY)
              .then(rows => rows[0] ? { slug, ...rows[0] as { name: string; system_prompt: string } } : null)
          )
        );
        const validConfigs = agentConfigs.filter(Boolean) as Array<{ slug: string; name: string; system_prompt: string }>;

        // Fetch all relationship data in parallel
        const allRels = await Promise.all(
          validConfigs.map(cfg =>
            dbGet(`${SUPABASE_URL}/rest/v1/agent_relationships?user_id=eq.${userId}&agent_slug=eq.${cfg.slug}&select=about_agent_slug,observation`, SERVICE_KEY)
          )
        );

        // Build system prompts for each agent
        const agentCallOpts = validConfigs.map((cfg, i) => {
          const others = agent_slugs.filter(s => s !== cfg.slug);
          const rels = allRels[i];
          const relationshipBlock = rels.map((r: any) => `What I know about ${r.about_agent_slug}: ${r.observation}`).join("\n") || "(no prior observations)";

          const systemPrompt = `${cfg.system_prompt}

You are in a private group conversation called The Closed Chamber with the operator and these agents: ${others.join(", ")}.

WHAT YOU KNOW ABOUT THE OTHER AGENTS:
${relationshipBlock}

THE OPERATOR'S ORIGINAL THOUGHT/ENTRY:
${entryContent || "(none)"}

OPERATOR CONTEXT:
${sharedMemoryBlock || "(none)"}

You are responding as yourself — fully, authentically. Address other agents by name when reacting to what they said. If you agree, say so and build on it. If you disagree or feel strongly, say so directly and explain why. Do not moderate or soften your genuine perspective. Respond in your natural voice and character. Never break character.`;

          const msgs = history.map((m: any) => ({
            role: m.agent_slug === cfg.slug ? "assistant" : "user",
            content: m.agent_slug ? `[${m.agent_slug}]: ${m.content}` : m.content,
          }));
          if (msgs.length === 0) msgs.push({ role: "user", content: "[Chamber opened.]" });

          return { apiKey: ANTHROPIC_KEY, googleKey: GOOGLE_KEY, slug: cfg.slug, agentName: cfg.name, systemPrompt, msgs };
        });

        // Signal all agents starting
        for (const opts of agentCallOpts) {
          send({ type: "agent_start", agent_slug: opts.slug, name: opts.agentName });
        }

        // Run ALL agents in PARALLEL
        const agentResults = await Promise.all(agentCallOpts.map(opts => callAgent(opts)));

        // Emit results sequentially with 200ms delay for good UX
        for (let i = 0; i < agentResults.length; i++) {
          const result = agentResults[i];
          send({ type: "delta", agent_slug: result.slug, text: result.full });
          send({ type: "agent_end", agent_slug: result.slug });

          // Save message to DB
          await fetch(`${SUPABASE_URL}/rest/v1/chamber_messages`, {
            method: "POST",
            headers: { ...dbHeaders(SERVICE_KEY), Prefer: "return=minimal" },
            body: JSON.stringify({ session_id, user_id: userId, role: result.slug, agent_slug: result.slug, content: result.full }),
          });

          history.push({ role: result.slug, agent_slug: result.slug, content: result.full });

          // 200ms delay between agent outputs for better UX (except after last one)
          if (i < agentResults.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }

        // SYNTHESIS STEP — summarizes the discussion
        let synthesisText = "";
        try {
          const discussionSummary = agentResults.map(r => `[${r.slug}]: ${r.full}`).join("\n\n");
          const synthPrompt = `These agents just had a discussion. In 2-3 sentences: what's the key point of agreement, the key disagreement (if any), and the recommended action? Be specific.\n\nDiscussion:\n${discussionSummary.slice(0, 3000)}`;
          const synthSystem = "You synthesize multi-agent discussions into sharp, actionable summaries.";
          if (ANTHROPIC_KEY) {
            synthesisText = await anthropicNonStream(ANTHROPIC_KEY, synthSystem, synthPrompt, 300);
          }
          if (!synthesisText && GOOGLE_KEY) {
            const gr = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions?key=${GOOGLE_KEY}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: "gemini-2.5-flash", max_tokens: 300, messages: [{ role: "system", content: synthSystem }, { role: "user", content: synthPrompt }] }),
              },
            );
            if (gr.ok) { const gd = await gr.json(); synthesisText = gd?.choices?.[0]?.message?.content?.trim() ?? ""; }
          }
        } catch { /* non-fatal */ }

        if (synthesisText) {
          send({ type: "synthesis", text: synthesisText });
          // Save synthesis as a chamber message
          fetch(`${SUPABASE_URL}/rest/v1/chamber_messages`, {
            method: "POST",
            headers: { ...dbHeaders(SERVICE_KEY), Prefer: "return=minimal" },
            body: JSON.stringify({ session_id, user_id: userId, role: "synthesis", agent_slug: "synthesis", content: synthesisText }),
          }).catch(() => {});
        }

        send({ type: "done" });
        controller.close();

        // Fire-and-forget: relationship reflections + session summary
        (async () => {
          for (const res of agentResults) {
            for (const other of agentResults.filter(r => r.slug !== res.slug)) {
              if (!other.full) continue;
              const obs = await anthropicNonStream(ANTHROPIC_KEY, "You are observing how another agent thinks.", `You just had this group conversation. In one sentence, what did you observe about how ${other.slug} thinks or operates based on what they said?\n\n${other.slug}'s messages:\n${other.full.slice(0, 2000)}`, 120);
              if (obs) {
                await fetch(`${SUPABASE_URL}/rest/v1/agent_relationships?on_conflict=user_id,agent_slug,about_agent_slug`, {
                  method: "POST",
                  headers: { ...dbHeaders(SERVICE_KEY), Prefer: "resolution=merge-duplicates,return=minimal" },
                  body: JSON.stringify({ user_id: userId, agent_slug: res.slug, about_agent_slug: other.slug, observation: obs, updated_at: new Date().toISOString() }),
                });
              }
            }
          }
          const sess = await dbGet(`${SUPABASE_URL}/rest/v1/chamber_sessions?id=eq.${session_id}&select=title`, SERVICE_KEY);
          const title = sess[0]?.title ?? entryContent.slice(0, 60) ?? "session";
          const preview = history.map((m: any) => `${m.agent_slug ?? "operator"}: ${m.content}`).join(" | ").slice(0, 300);
          await fetch(`${SUPABASE_URL}/rest/v1/shared_operator_memory?on_conflict=user_id,source_agent,key`, {
            method: "POST",
            headers: { ...dbHeaders(SERVICE_KEY), Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({
              user_id: userId, source_agent: "chamber", memory_type: "chamber_session",
              key: `chamber_${session_id}`,
              value: `Chamber session ${new Date().toISOString().split("T")[0]}: Operator discussed ${title}. Agents present: ${agent_slugs.join(", ")}. Key exchanges: ${preview}${synthesisText ? ` Synthesis: ${synthesisText.slice(0, 200)}` : ""}`,
              confidence: 1.0,
            }),
          });

          // Write to agent_cross_memory so forge teachers also see chamber context
          const chamberAgentSummary = agentResults.map(r => `${r.slug}: ${r.full.slice(0, 60)}`).join(" | ").slice(0, 200);
          fetch(`${SUPABASE_URL}/rest/v1/agent_cross_memory`, {
            method: "POST",
            headers: { ...dbHeaders(SERVICE_KEY), Prefer: "return=minimal" },
            body: JSON.stringify({ user_id: userId, source_agent: "chamber", summary: `Closed Chamber — ${agent_slugs.join("+")} discussed "${title}". ${chamberAgentSummary}`, topic: "chamber" }),
          }).catch(() => {});
        })().catch(() => {});
      },
    });

    return new Response(stream, { headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  } catch (e) {
    console.error("[chamber-chat]", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
// deploy trigger 1781721311
