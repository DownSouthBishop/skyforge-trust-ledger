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
  if (apiKey) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: HAIKU, max_tokens: max, system, messages: [{ role: "user", content }] }),
      });
      if (r.ok) {
        const j = await r.json();
        return (j.content?.[0]?.text ?? "").trim();
      }
      // Only fall through on credit/rate/overload errors
      if (r.status === 401 || r.status === 403) return "";
    } catch { /* fall through to Gemini */ }
  }
  // Gemini fallback
  const googleKey = Deno.env.get("GOOGLE_AI_KEY") ?? "";
  if (!googleKey) return "";
  try {
    const gr = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${googleKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: content }] }], systemInstruction: system ? { parts: [{ text: system }] } : undefined, generationConfig: { maxOutputTokens: max } }) },
    );
    if (gr.ok) { const gd = await gr.json(); return ((gd?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("")).trim(); }
  } catch {}
  return "";
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
      // Fall through to Gemini on any Anthropic failure
    } catch { /* fall through to Gemini */ }
  }

  // Gemini fallback
  if (googleKey) {
    try {
      const lastUserText = msgs.at(-1)?.content ?? "";
      const gr = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${googleKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: lastUserText }] }], systemInstruction: { parts: [{ text: systemPrompt }] }, generationConfig: { maxOutputTokens: 600 } }),
        },
      );
      if (gr.ok) {
        const gd = await gr.json();
        full = (gd?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim();
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

        // ROUND-TABLE: agents take turns based on how strongly they feel.
        // Each round: every remaining agent rates their urgency to speak (0-10) given current discussion.
        // Highest urgency speaks next, sees prior responses, then we re-score. Skip pass (<3) ends agent's turn.
        const agentResults: Array<{ slug: string; name: string; full: string }> = [];
        const turnTranscript: string[] = []; // running record of this turn's exchange
        const remaining = new Map(agentCallOpts.map(o => [o.slug, o]));

        for (const opts of agentCallOpts) {
          send({ type: "agent_start", agent_slug: opts.slug, name: opts.agentName });
        }

        const lastUserMsg = history.filter(h => !h.agent_slug).slice(-1)[0]?.content ?? entryContent ?? "";

        const scoreInterest = async (opts: typeof agentCallOpts[number]): Promise<number> => {
          const discussionSoFar = turnTranscript.join("\n\n") || "(no one has spoken yet)";
          const prompt = `Operator said: "${lastUserMsg.slice(0, 800)}"\n\nDiscussion so far this turn:\n${discussionSoFar.slice(0, 1500)}\n\nOn a scale of 0-10, how strongly do you (${opts.agentName}) want to speak next? Consider: do you have something genuinely new or important to add? Is there something you must respond to? Reply with ONLY a single integer 0-10, nothing else.`;
          let raw = "";
          if (ANTHROPIC_KEY) raw = await anthropicNonStream(ANTHROPIC_KEY, opts.systemPrompt, prompt, 8);
          if (!raw && GOOGLE_KEY) {
            try {
              const gr = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_KEY}`,
                { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], systemInstruction: { parts: [{ text: opts.systemPrompt }] }, generationConfig: { maxOutputTokens: 8 } }) },
              );
              if (gr.ok) { const gd = await gr.json(); raw = (gd?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join(""); }
            } catch {}
          }
          const n = parseInt((raw.match(/\d+/)?.[0] ?? "5"), 10);
          return isNaN(n) ? 5 : Math.max(0, Math.min(10, n));
        };

        let turnIdx = 0;
        const maxTurns = agentCallOpts.length + 2; // allow up to 2 extra responses for back-and-forth
        while (remaining.size > 0 && turnIdx < maxTurns) {
          turnIdx++;
          // Score interest for all remaining agents in parallel
          const entries = Array.from(remaining.values());
          const scores = await Promise.all(entries.map(scoreInterest));
          let bestIdx = -1, bestScore = -1;
          for (let i = 0; i < scores.length; i++) {
            if (scores[i] > bestScore) { bestScore = scores[i]; bestIdx = i; }
          }
          // If everyone passes (score<3) and at least one agent has spoken, end the round
          if (bestScore < 3 && agentResults.length > 0) break;
          const chosen = entries[bestIdx];
          remaining.delete(chosen.slug);

          // Inject the running turn transcript so this agent sees what was just said
          const updatedMsgs = [...chosen.msgs];
          if (turnTranscript.length > 0) {
            updatedMsgs.push({ role: "user", content: `[Live chamber discussion this turn — respond addressing what was just said]\n\n${turnTranscript.join("\n\n")}` });
          }

          const result = await callAgent({ ...chosen, msgs: updatedMsgs });
          agentResults.push(result);
          turnTranscript.push(`[${result.slug}]: ${result.full}`);

          send({ type: "delta", agent_slug: result.slug, text: result.full });
          send({ type: "agent_end", agent_slug: result.slug });

          await fetch(`${SUPABASE_URL}/rest/v1/chamber_messages`, {
            method: "POST",
            headers: { ...dbHeaders(SERVICE_KEY), Prefer: "return=minimal" },
            body: JSON.stringify({ session_id, user_id: userId, role: result.slug, agent_slug: result.slug, content: result.full }),
          });
          history.push({ role: result.slug, agent_slug: result.slug, content: result.full });

          await new Promise(r => setTimeout(r, 250));
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
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_KEY}`,
              { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: synthPrompt }] }], systemInstruction: { parts: [{ text: synthSystem }] }, generationConfig: { maxOutputTokens: 300 } }) },
            );
            if (gr.ok) { const gd = await gr.json(); synthesisText = (gd?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim(); }
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
