// daily_brief — Atlas morning intelligence brief, 7am daily.
// Reads: Alpaca account state, active goals, cross-memory, proactive alerts.
// Writes: dossier_suggestion (market_brief type) + Telegram push.
// No positions = honest accounting, not hallucination.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_MODEL = "gemini-2.5-flash";

async function gemini(apiKey: string, anthropicKey: string, system: string, user: string, maxTokens = 800): Promise<string> {
  // Try Gemini first
  if (apiKey) {
    try {
      const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: GEMINI_MODEL,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          max_tokens: maxTokens,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content ?? "";
        if (text.length > 20) return text;
      }
    } catch { /* fall through */ }
  }
  // Fallback: Anthropic Haiku
  if (anthropicKey) {
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        return data?.content?.[0]?.text ?? "";
      }
    } catch { /* fall through */ }
  }
  return "";
}

async function alpacaGet(base: string, key: string, secret: string, path: string): Promise<unknown> {
  try {
    const r = await fetch(`${base}${path}`, {
      headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret },
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const GOOGLE_KEY = Deno.env.get("GOOGLE_AI_KEY") ?? "";
    const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("Claude_API") ?? "";
    const ALPACA_KEY = Deno.env.get("ALPACA_API_KEY") ?? "";
    const ALPACA_SECRET = Deno.env.get("ALPACA_SECRET_KEY") ?? "";
    const ALPACA_BASE = Deno.env.get("ALPACA_BASE_URL") ?? "https://paper-api.alpaca.markets";
    const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
    const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

    if (!GOOGLE_KEY) {
      return new Response(JSON.stringify({ ok: false, error: "GOOGLE_AI_KEY missing" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const h = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    // Resolve operator via skyforge_agents (guaranteed to have rows from seed migrations)
    const agentRes = await fetch(`${SUPABASE_URL}/rest/v1/skyforge_agents?select=user_id&is_active=eq.true&limit=1`, { headers: h });
    const agentRows = agentRes.ok ? (await agentRes.json() as any[]) : [];
    if (!agentRows.length) return new Response(JSON.stringify({ ok: false, error: "No agents found — cannot resolve operator" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
    const uid = agentRows[0].user_id as string;

    const today = new Date().toISOString().split("T")[0];

    // Fetch all context in parallel
    const [goalsRes, crossMemRes, alertsRes, tasksRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/goals?user_id=eq.${uid}&status=eq.active&select=title,context,updated_at&limit=8`, { headers: h }),
      fetch(`${SUPABASE_URL}/rest/v1/agent_cross_memory?user_id=eq.${uid}&order=created_at.desc&limit=15&select=source_agent,summary,topic,created_at`, { headers: h }),
      fetch(`${SUPABASE_URL}/rest/v1/proactive_alerts?user_id=eq.${uid}&status=eq.unread&priority=in.(high,medium)&order=created_at.desc&limit=5&select=agent_slug,alert_type,title,priority`, { headers: h }),
      fetch(`${SUPABASE_URL}/rest/v1/agent_tasks?user_id=eq.${uid}&status=in.(pending,running)&select=agent_slug,task_description,priority&limit=5`, { headers: h }),
    ]);

    const goals = goalsRes.ok ? (await goalsRes.json() as any[]) : [];
    const crossMem = crossMemRes.ok ? (await crossMemRes.json() as any[]) : [];
    const alerts = alertsRes.ok ? (await alertsRes.json() as any[]) : [];
    const pendingTasks = tasksRes.ok ? (await tasksRes.json() as any[]) : [];

    // Fetch Alpaca account state
    let accountBlock = "Alpaca account: not connected or no credentials.";
    let positionsBlock = "No positions deployed.";

    if (ALPACA_KEY && ALPACA_SECRET) {
      const [account, positions] = await Promise.all([
        alpacaGet(ALPACA_BASE, ALPACA_KEY, ALPACA_SECRET, "/v2/account"),
        alpacaGet(`${ALPACA_BASE}`, ALPACA_KEY, ALPACA_SECRET, "/v2/positions"),
      ]);

      if (account) {
        const a = account as any;
        accountBlock = `Portfolio value: $${parseFloat(a.portfolio_value ?? "0").toLocaleString("en-US", { minimumFractionDigits: 2 })} | Cash: $${parseFloat(a.cash ?? "0").toLocaleString("en-US", { minimumFractionDigits: 2 })} | Buying power: $${parseFloat(a.buying_power ?? "0").toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
      }

      if (Array.isArray(positions) && positions.length > 0) {
        positionsBlock = (positions as any[]).map((p: any) =>
          `${p.symbol}: ${p.qty} shares @ $${parseFloat(p.avg_entry_price ?? "0").toFixed(2)} | Current: $${parseFloat(p.current_price ?? "0").toFixed(2)} | P&L: $${parseFloat(p.unrealized_pl ?? "0").toFixed(2)} (${parseFloat(p.unrealized_plpc ?? "0") * 100 > 0 ? "+" : ""}${(parseFloat(p.unrealized_plpc ?? "0") * 100).toFixed(2)}%)`
        ).join("\n");
      }
    }

    const goalsBlock = goals.length > 0
      ? goals.map((g: any) => `• ${g.title} (last updated: ${g.updated_at?.split("T")[0] ?? "unknown"})`).join("\n")
      : "No active goals.";

    const agentBlock = crossMem.length > 0
      ? crossMem.slice(0, 8).map((m: any) => `[${m.source_agent}] ${m.summary}`).join("\n")
      : "No recent agent activity.";

    const alertsBlock = alerts.length > 0
      ? alerts.map((a: any) => `[${a.priority.toUpperCase()}] ${a.agent_slug}: ${a.title}`).join("\n")
      : "No unread alerts.";

    const pendingBlock = pendingTasks.length > 0
      ? pendingTasks.map((t: any) => `${t.agent_slug}: ${(t.task_description ?? "").slice(0, 80)}`).join("\n")
      : "No tasks in queue.";

    const BRIEF_SYSTEM = `You are Atlas — capital operator and strategic principal for WIG (Watkins Investment Group).

Write a concise morning intelligence brief for Bishop. This brief is delivered daily at 7am. It should be direct and useful — no filler, no greetings.

Structure:
1. CAPITAL STATE: honest accounting of where money is deployed (or not)
2. ACTIVE FRONT: the 1-2 most important goals or situations right now
3. AGENT INTELLIGENCE: notable patterns or actions from the agent team
4. TODAY'S FOCUS: 1-2 specific things Bishop should do or decide today

Keep the entire brief under 200 words. Lead with what matters. No bullet lists for items that can be stated directly.`;

    const USER_PROMPT = `DATE: ${today}

ALPACA ACCOUNT:
${accountBlock}

OPEN POSITIONS:
${positionsBlock}

ACTIVE GOALS:
${goalsBlock}

UNREAD ALERTS:
${alertsBlock}

RECENT AGENT ACTIVITY:
${agentBlock}

PENDING TASKS IN QUEUE:
${pendingBlock}

Write the morning brief.`;

    const brief = await gemini(GOOGLE_KEY, ANTHROPIC_KEY, BRIEF_SYSTEM, USER_PROMPT, 500);
    if (!brief) {
      return new Response(JSON.stringify({ ok: false, error: "Brief generation failed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Write to dossier_suggestions as market_brief
    await fetch(`${SUPABASE_URL}/rest/v1/dossier_suggestions`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: uid,
        agent_slug: "atlas",
        entry_type: "market_brief",
        title: `Morning Brief — ${today}`,
        context: brief,
        importance: "high",
        status: "pending",
      }),
    });

    // Write cross-memory
    await fetch(`${SUPABASE_URL}/rest/v1/agent_cross_memory`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: uid,
        source_agent: "atlas",
        summary: `Daily brief written for ${today}. Capital state: ${accountBlock.slice(0, 120)}. ${positionsBlock === "No positions deployed." ? "No positions deployed." : "Positions active."}`,
        topic: "daily_brief",
      }),
    });

    // Push to Telegram
    if (BOT_TOKEN && CHAT_ID) {
      const telegramText = `⚡ *Atlas Morning Brief — ${today}*\n\n${brief}`;
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: telegramText.slice(0, 4096),
          parse_mode: "Markdown",
        }),
      }).catch(() => {});
    }

    return new Response(
      JSON.stringify({ ok: true, brief_length: brief.length, date: today }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (e) {
    console.error("[daily_brief]", e);
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
