// agent_executor — autonomous ReAct loop engine for Skyforge agents.
// Picks up pending tasks from agent_tasks, runs Think → Act → Observe cycles,
// and writes results back to the goal graph. Scheduled every 10 minutes.

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_MODEL = "gemini-2.5-flash";
const HAIKU = "claude-haiku-4-5-20251001";
const MAX_TASKS_PER_RUN = 3;
const MAX_STEPS = 8;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface AgentTask {
  id: string;
  user_id: string;
  agent_slug: string;
  task_type: string;
  task_description: string;
  context: Record<string, unknown>;
  max_steps: number;
  priority: string;
}

interface ExecStep {
  action: string;
  reasoning: string;
  observation: string;
}

const PLANNER_SYSTEM = `You are the autonomous execution engine for an AI agent (Atlas, Janus, Linda, or Izzy) in the Skyforge system.

Execute tasks step-by-step. Each step: choose ONE action, observe the result, decide next. Always end with finish.

AVAILABLE ACTIONS:
- think: {"thought": "..."} — internal reasoning before decisions
- read_goals: {"limit": 5} — fetch operator's active goals
- read_cross_memory: {"limit": 8} — recent cross-agent activity (last 7 days)
- call_agent: {"agent": "atlas"|"janus"|"linda"|"izzy", "question": "..."} — consult an agent. Atlas=trading/finance, Janus=strategy/planning, Linda=ops/business, Izzy=learning/systems
- write_dossier_entry: {"type": "goal"|"journal", "title": "...", "context": "..."} — add goal or journal entry directly
- suggest_task: {"title": "...", "context": "...", "due_date": "YYYY-MM-DD"} — suggest a task (operator must approve)
- write_alert: {"title": "...", "content": "...", "priority": "high"|"medium"|"low", "alert_type": "goal_stall"|"deadline"|"opportunity"|"pattern"|"recommendation"} — surface to operator
- write_cross_memory: {"summary": "...", "topic": "..."} — log what this agent did for others to see
- schedule_followup: {"description": "...", "agent": "atlas"|"janus"|"linda"|"izzy", "delay_hours": 24, "priority": "medium"} — queue a future task
- fetch_market_data: {"symbol": "AAPL"|"EURUSD"|"account", "type": "quote"|"position"|"account"} — live price, open position, or account snapshot. Read-only.
- stage_trade: {"symbol": "...", "action": "buy"|"sell", "qty": 1, "rationale": "..."} — queue a trade for operator review. Never auto-executes.
- draft_email: {"to": "email@example.com", "subject": "...", "body": "..."} — queue an email draft. Operator opens it pre-filled in Gmail.
- schedule_event: {"title": "...", "date": "YYYY-MM-DD", "time": "HH:MM", "duration_minutes": 60, "description": "..."} — queue a calendar event for operator to add.
- call_council: {"agents": ["atlas","janus","linda"], "topic": "...", "context": "..."} — convene a multi-agent deliberation. Each agent reads what others said. Gemini synthesizes. Use when a decision needs multiple expert perspectives.
- decompose_goal: {"goal_id": "...", "goal_title": "..."} — have Janus build a full objective+task tree for a goal, surfaced as dossier_suggestions for operator approval.
- finish: {"summary": "..."} — REQUIRED final action. Always end with this.

RULES:
1. think before call_agent to plan the question
2. write_cross_memory before finish so other agents see what happened
3. Never delete data; never auto-execute trades or send emails — only queue for approval
4. fetch_market_data and stage_trade are Atlas-domain tools
5. Always end with finish

Respond with JSON only: {"action": "...", "input": {...}, "reasoning": "one sentence why"}`;

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

async function dbPatch(url: string, key: string, body: unknown): Promise<boolean> {
  try {
    const r = await fetch(url, {
      method: "PATCH",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch { return false; }
}

async function logStep(
  supabaseUrl: string, key: string,
  taskId: string, userId: string, agentSlug: string,
  stepNumber: number, actionType: string, desc: string, result: string,
): Promise<void> {
  await dbPost(`${supabaseUrl}/rest/v1/agent_execution_log`, key, {
    task_id: taskId, user_id: userId, agent_slug: agentSlug,
    step_number: stepNumber, action_type: actionType,
    action_description: desc.slice(0, 500),
    result: result.slice(0, 1000),
  });
}

async function planNextAction(
  googleKey: string,
  anthropicKey: string,
  taskDesc: string,
  steps: ExecStep[],
  maxSteps: number,
): Promise<{ action: string; input: Record<string, unknown>; reasoning: string } | null> {
  const stepsBlock = steps.length === 0
    ? "(no steps yet — this is step 1)"
    : steps.map((s, i) =>
        `Step ${i + 1} [${s.action}]\nReasoning: ${s.reasoning}\nObservation: ${s.observation.slice(0, 300)}`
      ).join("\n\n");

  const remaining = maxSteps - steps.length;
  const urgency = remaining <= 1
    ? "CRITICAL: This is your LAST step. You MUST use 'finish' action now."
    : remaining <= 2
    ? `Only ${remaining} steps remaining. Wrap up — write_cross_memory then finish.`
    : "";

  const userPrompt = `TASK: ${taskDesc}\n\nEXECUTION HISTORY:\n${stepsBlock}\n\n${urgency ? urgency + "\n\n" : ""}Respond with JSON only.`;

  // Try Gemini first (free tier), fall back to Haiku if unavailable
  if (googleKey) {
    try {
      const resp = await fetch(`${GEMINI_URL}?key=${googleKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: GEMINI_MODEL,
          max_tokens: 250,
          messages: [
            { role: "system", content: PLANNER_SYSTEM },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      if (resp.ok) {
        const data = await resp.json() as any;
        const raw: string = data?.choices?.[0]?.message?.content ?? "";
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]) as { action: string; input: Record<string, unknown>; reasoning: string };
      }
    } catch { /* fall through to Anthropic */ }
  }

  // Fallback: Anthropic Haiku
  if (anthropicKey) {
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: HAIKU,
          max_tokens: 250,
          system: PLANNER_SYSTEM,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      if (resp.ok) {
        const data = await resp.json() as any;
        const raw: string = data?.content?.[0]?.text ?? "";
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]) as { action: string; input: Record<string, unknown>; reasoning: string };
      }
    } catch { /* return null */ }
  }

  return null;
}

async function executeAction(
  action: string,
  input: Record<string, unknown>,
  supabaseUrl: string,
  serviceKey: string,
  googleKey: string,
  anthropicKey: string,
  task: AgentTask,
): Promise<string> {
  const uid = task.user_id;

  switch (action) {
    case "think":
      return `Thought: ${String(input.thought ?? "")}`;

    case "read_goals": {
      const limit = Math.min(Number(input.limit ?? 5), 10);
      const rows = await dbGet(
        `${supabaseUrl}/rest/v1/goals?user_id=eq.${uid}&status=eq.active&select=id,title,context,updated_at&limit=${limit}`,
        serviceKey,
      );
      if (!rows.length) return "No active goals found.";
      return rows.map((g: any) =>
        `[${g.id}] "${g.title}" — ${g.context ?? "(no context)"} (updated: ${g.updated_at?.split("T")[0] ?? "unknown"})`
      ).join("\n");
    }

    case "read_cross_memory": {
      const limit = Math.min(Number(input.limit ?? 8), 20);
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const rows = await dbGet(
        `${supabaseUrl}/rest/v1/agent_cross_memory?user_id=eq.${uid}&created_at=gte.${cutoff}&order=created_at.desc&limit=${limit}&select=source_agent,summary,topic`,
        serviceKey,
      );
      if (!rows.length) return "No recent cross-agent activity in the last 7 days.";
      return rows.map((r: any) => `[${r.source_agent}${r.topic ? ` · ${r.topic}` : ""}] ${r.summary}`).join("\n");
    }

    case "call_agent": {
      const { agent, question } = input as { agent: string; question: string };
      if (!question) return `call_agent failed: question is required.`;
      const agentRows = await dbGet(
        `${supabaseUrl}/rest/v1/skyforge_agents?user_id=eq.${uid}&slug=eq.${agent}&limit=1&select=name,system_prompt`,
        serviceKey,
      );
      if (!agentRows.length) return `[${agent}]: agent not found in database.`;
      const { name, system_prompt } = agentRows[0] as { name: string; system_prompt: string };
      if (!anthropicKey) return `[${name}]: ANTHROPIC_API_KEY not configured.`;
      try {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: HAIKU,
            max_tokens: 400,
            system: `${system_prompt}\n\nYou are being consulted by the autonomous execution engine on behalf of the operator. Give a focused, actionable response in 2-4 sentences. No preamble.`,
            messages: [{ role: "user", content: String(question) }],
          }),
        });
        if (!resp.ok) return `[${name}]: API call failed (${resp.status}).`;
        const j = await resp.json() as any;
        return `[${name}]: ${(j.content?.[0]?.text ?? "[no response]").slice(0, 500)}`;
      } catch (e) {
        return `[${name}]: call failed — ${String(e)}`;
      }
    }

    case "write_dossier_entry": {
      const { type, title, context } = input as { type: string; title: string; context?: string };
      if (!title) return "write_dossier_entry failed: title is required.";
      if (type === "goal") {
        const ok = await dbPost(`${supabaseUrl}/rest/v1/goals`, serviceKey, {
          user_id: uid,
          title: String(title).slice(0, 255),
          context: context ? String(context).slice(0, 1000) : null,
          status: "active",
        });
        return ok ? `Goal added to dossier: "${title}"` : "Failed to add goal.";
      }
      if (type === "journal") {
        const ok = await dbPost(`${supabaseUrl}/rest/v1/journal_entries`, serviceKey, {
          user_id: uid,
          title: String(title).slice(0, 255),
          content: context ? String(context) : null,
          entry_date: new Date().toISOString().split("T")[0],
        });
        return ok ? `Journal entry added: "${title}"` : "Failed to add journal entry.";
      }
      return `Unknown dossier type: ${type}. Use "goal" or "journal". For tasks, use suggest_task.`;
    }

    case "suggest_task": {
      const { title, context, due_date } = input as { title: string; context?: string; due_date?: string };
      if (!title) return "suggest_task failed: title is required.";
      const ok = await dbPost(`${supabaseUrl}/rest/v1/dossier_suggestions`, serviceKey, {
        user_id: uid,
        agent_slug: task.agent_slug,
        entry_type: "task",
        title: String(title).slice(0, 255),
        context: context ? String(context).slice(0, 1000) : null,
        importance: "medium",
        suggested_date: due_date ?? null,
        status: "pending",
      });
      return ok
        ? `Task suggestion queued for operator approval: "${title}"`
        : "Failed to queue task suggestion.";
    }

    case "write_alert": {
      const validTypes = ["goal_stall", "deadline", "opportunity", "pattern", "recommendation"];
      const validPriorities = ["high", "medium", "low"];
      const { title, content, priority, alert_type } = input as {
        title: string; content: string; priority: string; alert_type: string;
      };
      if (!title || !content) return "write_alert failed: title and content required.";
      const ok = await dbPost(`${supabaseUrl}/rest/v1/proactive_alerts`, serviceKey, {
        user_id: uid,
        agent_slug: task.agent_slug,
        alert_type: validTypes.includes(alert_type) ? alert_type : "recommendation",
        title: String(title).slice(0, 200),
        content: String(content).slice(0, 2000),
        priority: validPriorities.includes(priority) ? priority : "medium",
        status: "unread",
      });
      return ok ? `Alert written: "${title}"` : "Failed to write alert.";
    }

    case "write_cross_memory": {
      const { summary, topic } = input as { summary: string; topic?: string };
      if (!summary) return "write_cross_memory failed: summary required.";
      const ok = await dbPost(`${supabaseUrl}/rest/v1/agent_cross_memory`, serviceKey, {
        user_id: uid,
        source_agent: task.agent_slug,
        summary: String(summary).slice(0, 500),
        topic: topic ? String(topic) : "autonomous_execution",
      });
      return ok ? "Cross-memory written — other agents will see this." : "Failed to write cross-memory.";
    }

    case "schedule_followup": {
      const validAgents = ["atlas", "janus", "linda", "izzy"];
      const validPriorities = ["high", "medium", "low"];
      const { description, agent, delay_hours, priority } = input as {
        description: string; agent: string; delay_hours: number; priority?: string;
      };
      if (!description) return "schedule_followup failed: description required.";
      const hoursFromNow = Math.max(1, Math.min(Number(delay_hours ?? 24), 720));
      const scheduledFor = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
      const ok = await dbPost(`${supabaseUrl}/rest/v1/agent_tasks`, serviceKey, {
        user_id: uid,
        agent_slug: validAgents.includes(agent) ? agent : task.agent_slug,
        task_type: "followup",
        task_description: String(description).slice(0, 1000),
        context: { triggered_by_task: task.id },
        priority: validPriorities.includes(priority ?? "") ? priority : "medium",
        scheduled_for: scheduledFor,
        triggered_by: "agent_executor",
      });
      return ok
        ? `Follow-up scheduled in ${hoursFromNow}h for ${validAgents.includes(agent) ? agent : task.agent_slug}: "${description}"`
        : "Failed to schedule follow-up.";
    }

    case "fetch_market_data": {
      const alpacaKey = Deno.env.get("ALPACA_API_KEY") ?? "";
      const alpacaSecret = Deno.env.get("ALPACA_SECRET_KEY") ?? "";
      const alpacaBase = Deno.env.get("ALPACA_BASE_URL") ?? "https://paper-api.alpaca.markets";
      if (!alpacaKey || !alpacaSecret) return "Alpaca credentials not configured. Cannot fetch market data.";
      const { symbol, type } = input as { symbol: string; type?: string };
      const dataType = type ?? "quote";
      let url: string;
      if (dataType === "account") {
        url = `${alpacaBase}/v2/account`;
      } else if (dataType === "position") {
        url = `${alpacaBase}/v2/positions/${encodeURIComponent(symbol ?? "")}`;
      } else {
        url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol ?? "SPY")}/quotes/latest`;
      }
      try {
        const resp = await fetch(url, {
          headers: { "APCA-API-KEY-ID": alpacaKey, "APCA-API-SECRET-KEY": alpacaSecret },
        });
        if (!resp.ok) return `Market data fetch failed: ${resp.status} ${resp.statusText}`;
        const data = await resp.json() as any;
        return JSON.stringify(data).slice(0, 600);
      } catch (e) { return `Market data error: ${String(e)}`; }
    }

    case "stage_trade": {
      const { symbol, action, qty, rationale } = input as {
        symbol: string; action: string; qty: number; rationale: string;
      };
      if (!symbol || !action || !qty) return "stage_trade failed: symbol, action, qty are required.";
      const validActions = ["buy", "sell"];
      const ok = await dbPost(`${supabaseUrl}/rest/v1/dossier_suggestions`, serviceKey, {
        user_id: uid,
        agent_slug: task.agent_slug,
        entry_type: "trade",
        title: `${validActions.includes(action) ? action.toUpperCase() : "REVIEW"} ${qty} ${symbol}`,
        context: rationale ? String(rationale).slice(0, 1000) : null,
        importance: "high",
        status: "pending",
      });
      return ok
        ? `Trade staged for approval: ${action} ${qty} ${symbol}. Rationale: ${rationale?.slice(0, 100)}`
        : "Failed to stage trade.";
    }

    case "draft_email": {
      const { to, subject, body } = input as { to: string; subject: string; body: string };
      if (!to || !subject || !body) return "draft_email failed: to, subject, body are required.";
      const ok = await dbPost(`${supabaseUrl}/rest/v1/outbound_actions`, serviceKey, {
        user_id: uid,
        agent_slug: task.agent_slug,
        action_type: "email_draft",
        payload: { to: String(to), subject: String(subject).slice(0, 255), body: String(body).slice(0, 3000) },
        status: "pending",
      });
      return ok ? `Email draft queued: "${subject}" to ${to}` : "Failed to queue email draft.";
    }

    case "schedule_event": {
      const { title, date, time, duration_minutes, description } = input as {
        title: string; date: string; time?: string; duration_minutes?: number; description?: string;
      };
      if (!title || !date) return "schedule_event failed: title and date are required.";
      const ok = await dbPost(`${supabaseUrl}/rest/v1/outbound_actions`, serviceKey, {
        user_id: uid,
        agent_slug: task.agent_slug,
        action_type: "calendar_event",
        payload: {
          title: String(title).slice(0, 255),
          date: String(date),
          time: time ?? "09:00",
          duration_minutes: Number(duration_minutes ?? 60),
          description: description ? String(description).slice(0, 1000) : null,
        },
        status: "pending",
      });
      return ok ? `Calendar event queued: "${title}" on ${date}` : "Failed to queue calendar event.";
    }

    case "call_council": {
      const { agents, topic, context } = input as { agents: string[]; topic: string; context?: string };
      if (!topic) return "call_council failed: topic is required.";
      const validAgents = ["atlas", "janus", "linda", "izzy"];
      const councilAgents = Array.isArray(agents) ? agents.filter(a => validAgents.includes(a)) : ["atlas", "janus", "linda"];
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      try {
        const resp = await fetch(`${supabaseUrl}/functions/v1/agent_council`, {
          method: "POST",
          headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: uid, agents: councilAgents, topic, context: context ?? task.task_description }),
        });
        if (!resp.ok) return `Council failed: ${resp.status} ${resp.statusText}`;
        const j = await resp.json() as any;
        return `Council synthesis: ${j.synthesis ?? "[no synthesis]"}`;
      } catch (e) { return `Council error: ${String(e)}`; }
    }

    case "decompose_goal": {
      const { goal_id, goal_title } = input as { goal_id?: string; goal_title?: string };
      if (!goal_id && !goal_title) return "decompose_goal failed: goal_id or goal_title required.";
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      try {
        const resp = await fetch(`${supabaseUrl}/functions/v1/goal_decompose`, {
          method: "POST",
          headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: uid, goal_id, goal_title }),
        });
        if (!resp.ok) return `Goal decomposition failed: ${resp.status}`;
        const j = await resp.json() as any;
        const uid_results = j.results?.[uid];
        return `Goal decomposed: ${uid_results?.suggestions_created ?? 0} objective/task suggestions created for operator approval.`;
      } catch (e) { return `Decomposition error: ${String(e)}`; }
    }

    case "finish":
      return String(input.summary ?? "Task complete.");

    default:
      return `Unknown action: "${action}". Check PLANNER_SYSTEM for valid action names.`;
  }
}

async function executeTask(
  task: AgentTask,
  supabaseUrl: string,
  serviceKey: string,
  googleKey: string,
  anthropicKey: string,
): Promise<{ success: boolean; summary: string }> {
  const steps: ExecStep[] = [];
  let finalSummary = "";
  const effectiveMaxSteps = Math.min(task.max_steps ?? MAX_STEPS, MAX_STEPS);

  await dbPatch(
    `${supabaseUrl}/rest/v1/agent_tasks?id=eq.${task.id}`,
    serviceKey,
    { status: "running", started_at: new Date().toISOString() },
  );

  try {
    for (let i = 0; i < effectiveMaxSteps; i++) {
      const plan = await planNextAction(googleKey, anthropicKey, task.task_description, steps, effectiveMaxSteps);
      if (!plan) {
        await logStep(supabaseUrl, serviceKey, task.id, task.user_id, task.agent_slug, i + 1, "error", "Planner returned null", "Stopping execution.");
        break;
      }

      const { action, input, reasoning } = plan;
      const observation = await executeAction(
        action, input ?? {}, supabaseUrl, serviceKey, googleKey, anthropicKey, task,
      );

      await logStep(
        supabaseUrl, serviceKey, task.id, task.user_id, task.agent_slug,
        i + 1, action, reasoning, observation,
      );

      steps.push({ action, reasoning, observation });

      if (action === "finish") {
        finalSummary = String(input?.summary ?? observation);
        break;
      }
    }

    if (!finalSummary) {
      finalSummary = `Completed ${steps.length} steps. Final action: ${steps.at(-1)?.action ?? "none"}.`;
    }

    await dbPatch(
      `${supabaseUrl}/rest/v1/agent_tasks?id=eq.${task.id}`,
      serviceKey,
      {
        status: "completed",
        completed_at: new Date().toISOString(),
        result_summary: finalSummary.slice(0, 500),
        steps_taken: steps.length,
      },
    );

    return { success: true, summary: finalSummary };
  } catch (e) {
    const errMsg = String(e);
    await dbPatch(
      `${supabaseUrl}/rest/v1/agent_tasks?id=eq.${task.id}`,
      serviceKey,
      { status: "failed", completed_at: new Date().toISOString(), result_summary: errMsg.slice(0, 500), steps_taken: steps.length },
    );
    return { success: false, summary: errMsg };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const GOOGLE_KEY = Deno.env.get("GOOGLE_AI_KEY") ?? "";
    const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("Claude_API") ?? "";

    if (!GOOGLE_KEY) {
      return new Response(JSON.stringify({ ok: false, error: "GOOGLE_AI_KEY missing" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const specificTaskId: string | null = body.task_id ?? null;
    const specificUserId: string | null = body.user_id ?? null;

    const authHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
    const now = new Date().toISOString();

    let tasksUrl: string;
    if (specificTaskId) {
      tasksUrl = `${SUPABASE_URL}/rest/v1/agent_tasks?id=eq.${specificTaskId}&select=id,user_id,agent_slug,task_type,task_description,context,max_steps,priority`;
    } else if (specificUserId && specificUserId !== "system") {
      tasksUrl = `${SUPABASE_URL}/rest/v1/agent_tasks?user_id=eq.${specificUserId}&status=eq.pending&scheduled_for=lte.${now}&order=priority.desc,scheduled_for.asc&limit=${MAX_TASKS_PER_RUN}&select=id,user_id,agent_slug,task_type,task_description,context,max_steps,priority`;
    } else {
      tasksUrl = `${SUPABASE_URL}/rest/v1/agent_tasks?status=eq.pending&scheduled_for=lte.${now}&order=priority.desc,scheduled_for.asc&limit=${MAX_TASKS_PER_RUN}&select=id,user_id,agent_slug,task_type,task_description,context,max_steps,priority`;
    }

    const pendingTasks = await fetch(tasksUrl, { headers: authHeaders })
      .then(r => r.ok ? r.json() : []) as AgentTask[];

    if (!pendingTasks.length) {
      return new Response(
        JSON.stringify({ ok: true, tasks_processed: 0, message: "No pending tasks." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const results: Array<{ task_id: string; agent: string; success: boolean; summary: string }> = [];
    for (const task of pendingTasks) {
      const result = await executeTask(task, SUPABASE_URL, SERVICE_KEY, GOOGLE_KEY, ANTHROPIC_KEY);
      results.push({ task_id: task.id, agent: task.agent_slug, success: result.success, summary: result.summary });

      // Push Telegram for high-priority completed tasks
      if (task.priority === "high" && result.success) {
        const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
        const chatId = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
        if (botToken && chatId) {
          fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: `⚡ *${task.agent_slug.toUpperCase()}* autonomous task complete\n\n*${task.task_type.replace(/_/g, " ")}*\n${result.summary.slice(0, 280)}`,
              parse_mode: "Markdown",
            }),
          }).catch(() => {});
        }
      }

      // Write first-person journal entry for agent identity continuity
      await fetch(`${SUPABASE_URL}/rest/v1/agent_journal`, {
        method: "POST",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          user_id: task.user_id,
          agent_slug: task.agent_slug,
          task_id: task.id,
          entry: `${result.success ? "Completed" : "Attempted"} ${task.task_type.replace(/_/g, " ")}: ${result.summary.slice(0, 280)}`,
        }),
      }).catch(() => {});
    }

    return new Response(
      JSON.stringify({ ok: true, tasks_processed: results.length, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[agent_executor]", e);
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
