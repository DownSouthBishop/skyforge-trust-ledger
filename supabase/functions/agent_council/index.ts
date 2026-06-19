// agent_council — autonomous multi-agent deliberation without human initiation.
// Convenes agents sequentially (each reads what previous agents said),
// then Gemini synthesizes into a single actionable recommendation.
// Called by agent_executor via call_council action, or directly.

const HAIKU = "claude-haiku-4-5-20251001";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_MODEL = "gemini-2.5-flash";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function dbGet(url: string, key: string): Promise<any[]> {
  try {
    const r = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    return r.ok ? (await r.json() as any[]) : [];
  } catch { return []; }
}

async function dbPost(url: string, key: string, body: unknown): Promise<boolean> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch { return false; }
}

async function callHaiku(
  apiKey: string,
  systemPrompt: string,
  userContent: string,
  maxTokens = 400,
): Promise<string> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: HAIKU, max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    if (!r.ok) return "[unavailable]";
    const j = await r.json() as any;
    return (j.content?.[0]?.text ?? "[no response]").trim();
  } catch { return "[unavailable]"; }
}

async function geminiSynthesize(googleKey: string, topic: string, responses: Array<{ agent: string; text: string }>): Promise<string> {
  const responseBlock = responses.map(r => `[${r.agent.toUpperCase()}]: ${r.text}`).join("\n\n");
  try {
    const r = await fetch(`${GEMINI_URL}?key=${googleKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        max_tokens: 400,
        messages: [
          {
            role: "system",
            content: "You synthesize multi-agent deliberations into single, sharp recommendations. Be specific. 2-4 sentences max. Output plain text only.",
          },
          {
            role: "user",
            content: `TOPIC: ${topic}\n\nAGENT RESPONSES:\n${responseBlock}\n\nSynthesize the key point of agreement, any significant tension, and the recommended action. Plain text only.`,
          },
        ],
      }),
    });
    if (!r.ok) return responses.map(r => `${r.agent}: ${r.text.slice(0, 100)}`).join(" | ");
    const data = await r.json() as any;
    return (data?.choices?.[0]?.message?.content ?? "").trim();
  } catch { return "[synthesis failed]"; }
}

async function pushTelegram(botToken: string, chatId: string, text: string): Promise<void> {
  if (!botToken || !chatId) return;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  }).catch(() => {});
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("Claude_API") ?? "";
    const GOOGLE_KEY = Deno.env.get("GOOGLE_AI_KEY") ?? "";
    const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
    const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

    const body = await req.json().catch(() => ({}));
    const { user_id, agents, topic, context } = body as {
      user_id: string;
      agents: string[];
      topic: string;
      context?: string;
    };

    if (!user_id || !topic || !Array.isArray(agents) || agents.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "user_id, topic, and agents are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const validAgents = ["atlas", "janus", "linda", "izzy"];
    const agentList = agents.filter(a => validAgents.includes(a)).slice(0, 4);
    if (agentList.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "No valid agents specified" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch system prompts for all agents in parallel
    const agentConfigs = await Promise.all(
      agentList.map(slug =>
        dbGet(`${SUPABASE_URL}/rest/v1/skyforge_agents?user_id=eq.${user_id}&slug=eq.${slug}&limit=1&select=name,system_prompt`, SERVICE_KEY)
          .then(rows => rows[0] ? { slug, name: rows[0].name as string, system_prompt: rows[0].system_prompt as string } : null)
      )
    );
    const configs = agentConfigs.filter(Boolean) as Array<{ slug: string; name: string; system_prompt: string }>;

    if (configs.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "No agent configs found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Sequential deliberation — each agent reads what previous agents said
    const responses: Array<{ agent: string; name: string; text: string }> = [];

    for (const cfg of configs) {
      const prevBlock = responses.length === 0
        ? "(You are the first to speak.)"
        : responses.map(r => `${r.name.toUpperCase()}: ${r.text}`).join("\n\n");

      const councilPrompt = `${cfg.system_prompt}

You are participating in a private council deliberation. The topic requires your honest expert perspective.

COUNCIL TOPIC: ${topic}
${context ? `\nADDITIONAL CONTEXT:\n${context}` : ""}

WHAT THE OTHER AGENTS HAVE SAID SO FAR:
${prevBlock}

Respond in your authentic voice. Be specific and direct — this is internal deliberation, not a performance. 2-4 sentences. Address the topic and, if others have spoken, either build on or challenge their position with your expert reasoning. No preamble.`;

      const response = await callHaiku(ANTHROPIC_KEY, cfg.system_prompt, councilPrompt, 350);
      responses.push({ agent: cfg.slug, name: cfg.name, text: response });
    }

    // Gemini synthesis
    const synthesis = GOOGLE_KEY
      ? await geminiSynthesize(GOOGLE_KEY, topic, responses.map(r => ({ agent: r.name, text: r.text })))
      : responses.map(r => `${r.name}: ${r.text.slice(0, 80)}`).join(" | ");

    // Write to council_log
    await dbPost(`${SUPABASE_URL}/rest/v1/council_log`, SERVICE_KEY, {
      user_id,
      topic: topic.slice(0, 500),
      agents: agentList,
      synthesis: synthesis.slice(0, 2000),
    });

    // Write synthesis to proactive_alerts
    await dbPost(`${SUPABASE_URL}/rest/v1/proactive_alerts`, SERVICE_KEY, {
      user_id,
      agent_slug: "atlas",
      alert_type: "recommendation",
      title: `Council: ${topic.slice(0, 80)}`,
      content: `Agents: ${configs.map(c => c.name).join(", ")}\n\n${synthesis}`,
      priority: "high",
      status: "unread",
    });

    // Write cross-memory for each participating agent
    const crossSummary = `Council on "${topic.slice(0, 60)}" — ${configs.map(c => c.name).join(", ")} deliberated. Synthesis: ${synthesis.slice(0, 120)}`;
    await Promise.all(
      agentList.map(agent =>
        dbPost(`${SUPABASE_URL}/rest/v1/agent_cross_memory`, SERVICE_KEY, {
          user_id, source_agent: agent, summary: crossSummary, topic: "council",
        })
      )
    );

    // Push Telegram — council results are always high-value
    await pushTelegram(
      TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
      `🏛 *Council deliberation complete*\n\n*Topic:* ${topic.slice(0, 80)}\n*Agents:* ${configs.map(c => c.name).join(", ")}\n\n${synthesis.slice(0, 300)}`,
    );

    return new Response(
      JSON.stringify({ ok: true, synthesis, responses: responses.map(r => ({ agent: r.agent, text: r.text })) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[agent_council]", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
