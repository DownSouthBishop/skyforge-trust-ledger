// telegram_webhook — receives incoming Telegram messages from Bishop and
// routes them as agent tasks. Closes the Telegram loop: output AND input.
//
// Message routing:
//   "atlas: analyze AAPL"  → Atlas task
//   "janus: should I take this deal?"  → Janus task
//   "linda: PrymalAI lead came in"  → Linda task
//   "izzy: what dropped this week in AI?"  → Izzy task
//   "council: [topic]"  → multi-agent council session
//   (anything else)  → Atlas (default)
//
// Special commands:
//   /status  → report recent task completions to Telegram
//   /setup   → register this function as Telegram webhook (run once after deploy)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  }).catch(() => {});
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

  try {
    const body = await req.json().catch(() => ({}));

    // ── Setup: register webhook with Telegram ──────────────────────
    if (body?.action === "setup") {
      if (!BOT_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: "TELEGRAM_BOT_TOKEN not set" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const webhookUrl = `${SUPABASE_URL}/functions/v1/telegram_webhook`;
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl, allowed_updates: ["message"] }),
      });
      const result = await res.json();
      return new Response(JSON.stringify({ ok: result.ok, description: result.description, webhook_url: webhookUrl }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Status: report recent tasks ────────────────────────────────
    if (body?.action === "status") {
      if (BOT_TOKEN && CHAT_ID) {
        const h = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
        const agentRes2 = await fetch(`${SUPABASE_URL}/rest/v1/skyforge_agents?select=user_id&is_active=eq.true&limit=1`, { headers: h });
        const agentRows2 = agentRes2.ok ? (await agentRes2.json() as any[]) : [];
        const statusUid = agentRows2[0]?.user_id ?? "";
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/agent_tasks?${statusUid ? `user_id=eq.${statusUid}&` : ""}created_at=gte.${cutoff}&order=created_at.desc&limit=5&select=agent_slug,task_description,status,steps_taken`,
          { headers: h },
        );
        const tasks = res.ok ? (await res.json() as any[]) : [];
        if (tasks.length > 0) {
          const lines = tasks.map((t: any) =>
            `• *${t.agent_slug.toUpperCase()}* [${t.status}] ${(t.task_description ?? "").slice(0, 60)}`
          ).join("\n");
          await sendTelegram(BOT_TOKEN, CHAT_ID, `🧠 *Last 24h Agent Activity*\n\n${lines}`);
        } else {
          await sendTelegram(BOT_TOKEN, CHAT_ID, "No agent tasks in the last 24h.");
        }
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Telegram webhook update ────────────────────────────────────
    const update = body;
    const message = update?.message;
    if (!message?.text) {
      // Not a text message — ignore silently
      return new Response("ok", { headers: corsHeaders });
    }

    const incomingChatId = String(message.chat?.id ?? "");
    const text = (message.text as string).trim();

    // Reject messages from unknown chats (security: only accept from known chat)
    if (CHAT_ID && incomingChatId !== CHAT_ID) {
      return new Response("ok", { headers: corsHeaders });
    }

    // Get operator user ID via skyforge_agents (guaranteed populated from seed)
    const h = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
    const agentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/skyforge_agents?select=user_id&is_active=eq.true&limit=1`,
      { headers: h },
    );
    const agentRows = agentRes.ok ? (await agentRes.json() as any[]) : [];
    const userId = agentRows[0]?.user_id ?? null;
    if (!userId) {
      if (BOT_TOKEN && incomingChatId) {
        await sendTelegram(BOT_TOKEN, incomingChatId, "⚠️ No operator profile found. Cannot route task.");
      }
      return new Response("ok", { headers: corsHeaders });
    }

    // ── Parse routing prefix ───────────────────────────────────────
    const VALID_AGENTS = ["atlas", "janus", "linda", "izzy"] as const;
    type AgentSlug = typeof VALID_AGENTS[number];

    let agentSlug: AgentSlug = "atlas";
    let taskText = text;
    let isCouncil = false;
    let councilTopic = "";

    const lower = text.toLowerCase();

    if (lower.startsWith("/status")) {
      // /status command — return recent activity
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/agent_tasks?user_id=eq.${userId}&created_at=gte.${cutoff}&order=created_at.desc&limit=5&select=agent_slug,task_description,status`,
        { headers: h },
      );
      const tasks = res.ok ? (await res.json() as any[]) : [];
      if (tasks.length === 0) {
        await sendTelegram(BOT_TOKEN, incomingChatId, "No agent tasks in the last 24h.");
      } else {
        const lines = tasks.map((t: any) =>
          `• *${t.agent_slug.toUpperCase()}* [${t.status}] ${(t.task_description ?? "").slice(0, 70)}`
        ).join("\n");
        await sendTelegram(BOT_TOKEN, incomingChatId, `🧠 *Last 24h*\n\n${lines}`);
      }
      return new Response("ok", { headers: corsHeaders });
    }

    if (lower.startsWith("council:") || lower.startsWith("council ")) {
      isCouncil = true;
      councilTopic = text.slice(text.indexOf(":") !== -1 && lower.startsWith("council:") ? 8 : 8).trim();
    } else {
      for (const slug of VALID_AGENTS) {
        if (lower.startsWith(`${slug}:`) || lower.startsWith(`${slug} `)) {
          const colonIdx = lower.indexOf(":");
          const spaceIdx = lower.indexOf(" ");
          const splitIdx = colonIdx === slug.length ? colonIdx : spaceIdx;
          agentSlug = slug;
          taskText = text.slice(splitIdx + 1).trim();
          break;
        }
      }
    }

    if (!taskText && !councilTopic) {
      await sendTelegram(BOT_TOKEN, incomingChatId, "⚠️ Empty message — nothing to queue.");
      return new Response("ok", { headers: corsHeaders });
    }

    // ── Queue as agent task ────────────────────────────────────────
    if (isCouncil) {
      // Queue a council session via agent_executor
      const ok = await dbPost(`${SUPABASE_URL}/rest/v1/agent_tasks`, SERVICE_KEY, {
        user_id: userId,
        agent_slug: "atlas",
        task_type: "council_session",
        task_description: `Bishop requested a council session via Telegram. Topic: "${councilTopic}". Convene a council with janus and linda (and izzy if technical). Synthesize and report back.`,
        context: { source: "telegram", topic: councilTopic, original_message: text },
        priority: "high",
        triggered_by: "telegram_input",
      });
      if (BOT_TOKEN && incomingChatId) {
        await sendTelegram(
          BOT_TOKEN, incomingChatId,
          ok
            ? `🏛 *Council queued*\n\n_Topic: ${councilTopic.slice(0, 100)}_\n\nAtlas, Janus, Linda and Izzy will deliberate. Result pushed when complete.`
            : "⚠️ Failed to queue council session.",
        );
      }
    } else {
      const ok = await dbPost(`${SUPABASE_URL}/rest/v1/agent_tasks`, SERVICE_KEY, {
        user_id: userId,
        agent_slug: agentSlug,
        task_type: "telegram_input",
        task_description: taskText.slice(0, 1000),
        context: { source: "telegram", original_message: text },
        priority: "high",
        triggered_by: "telegram_input",
      });
      if (BOT_TOKEN && incomingChatId) {
        const emoji: Record<string, string> = { atlas: "⚡", janus: "🔮", linda: "👁", izzy: "⚙️" };
        await sendTelegram(
          BOT_TOKEN, incomingChatId,
          ok
            ? `${emoji[agentSlug] ?? "🤖"} *${agentSlug.charAt(0).toUpperCase() + agentSlug.slice(1)}* is on it.\n\n_"${taskText.slice(0, 120)}"_\n\nResult pushed when complete.`
            : `⚠️ Failed to queue task for ${agentSlug}.`,
        );
      }
    }

    return new Response("ok", { headers: corsHeaders });

  } catch (e) {
    console.error("[telegram_webhook]", e);
    // Always return 200 to Telegram so it doesn't retry
    return new Response("ok", { headers: corsHeaders });
  }
});
