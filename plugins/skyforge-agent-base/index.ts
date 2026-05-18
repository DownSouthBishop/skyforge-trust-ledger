// Skyforge Agent Baseline Plugin
// ─────────────────────────────────────────────────────────────────
// Every agent spawned in the Skyforge system loads this plugin.
// It provides:
//   SELF_REFLECT      — structured post-session reflection → Supabase
//   ESCALATE_TO_ATLAS — routes out-of-scope tasks back to the orchestrator
//   REPORT_STATUS     — Atlas can query any agent for a status snapshot
//   LOG_ACTION        — agents log their own actions for reflection fuel
//   RECALL_MEMORY     — retrieve this agent's learned patterns and beliefs
//
// The reflection action is the core of the autonomy loop:
//   session ends → SELF_REFLECT fires → agent_reflect edge fn runs →
//   learned_memories written to agent_memory → next session starts with
//   a richer context window from getMemoryContext().

import type { Plugin, IAgentRuntime, Memory, State } from "@elizaos/core";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const APP_URL      = process.env.VITE_APP_URL ?? process.env.APP_URL ?? "";

const sbHeaders = {
  apikey:        SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer:         "return=representation",
};

// ─── Helpers ──────────────────────────────────────────────────────

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`sbGet ${r.status}`);
  return r.json();
}

async function sbPost(path: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method: "POST",
    headers: sbHeaders,
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sbPost ${r.status}: ${await r.text()}`);
  return r.json();
}

async function callEdgeFunction(fn: string, body: unknown) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${fn} ${r.status}: ${await r.text()}`);
  return r.json();
}

// ─── Memory Context Provider ──────────────────────────────────────
// Injected into every message context so the agent always has its
// learned patterns, constraints, and preferences in scope.

const agentMemoryProvider = {
  get: async (runtime: IAgentRuntime, _message: Memory, state: State) => {
    try {
      const agentId = (state as Record<string, unknown>).agentDbId ?? runtime.agentId;
      const rows    = await sbGet(
        `/agent_memory?agent_id=eq.${agentId}&order=confidence.desc&limit=30` +
        `&select=memory_type,key,value,confidence`,
      );

      if (!Array.isArray(rows) || rows.length === 0) return "";

      const sections: Record<string, string[]> = {};
      for (const row of rows) {
        const t = row.memory_type as string;
        if (!sections[t]) sections[t] = [];
        sections[t].push(`• ${row.key}: ${row.value} [conf: ${row.confidence}]`);
      }

      const lines: string[] = ["=== Your learned memory ==="];
      for (const [type, items] of Object.entries(sections)) {
        lines.push(`[${type}]`, ...items);
      }
      return lines.join("\n");
    } catch {
      return "";
    }
  },
};

// ─── Actions ──────────────────────────────────────────────────────

// SELF_REFLECT — should be triggered at session end or on demand
const selfReflectAction = {
  name: "SELF_REFLECT",
  description:
    "Run a structured post-session self-reflection. Analyses what worked, what failed, " +
    "patterns in your behaviour, and produces concrete steps to increase autonomy next session. " +
    "Writes results to persistent memory. ALWAYS run this at the end of a session.",
  similes: ["REFLECT", "POST_SESSION_REVIEW", "SESSION_DEBRIEF", "LEARN_FROM_SESSION"],
  examples: [
    [{ user: "user", content: { text: "Reflect on this session" } }],
    [{ user: "agent", content: { text: "Session complete. Running self-reflection." } }],
  ],
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state: State,
    _options: unknown,
    callback: (result: { text: string }) => void,
  ) => {
    try {
      const agentId = (state as Record<string, unknown>).agentDbId ?? runtime.agentId;
      const userId  = (state as Record<string, unknown>).userId ?? "";

      const result = await callEdgeFunction("agent_reflect", {
        agent_id: agentId,
        user_id:  userId,
      });

      const msg =
        result.status === "no_sessions_to_reflect"
          ? "No un-reflected sessions found. Nothing to process."
          : `Reflection complete. Sessions covered: ${result.sessions_covered}. ` +
            `Memories updated: ${result.memories_updated}. ` +
            `Quality score: ${(Number(result.quality_score ?? 0) * 100).toFixed(0)}%. ` +
            (result.memories_updated > 0 ? "New patterns written to memory." : "");

      callback({ text: msg });
      return true;
    } catch (err) {
      callback({ text: `Reflection failed: ${(err as Error).message}` });
      return false;
    }
  },
};

// ESCALATE_TO_ATLAS — graceful out-of-scope routing
const escalateToAtlasAction = {
  name: "ESCALATE_TO_ATLAS",
  description:
    "Escalate a task that is outside your capabilities to Atlas (the orchestrator). " +
    "Use this when a request requires skills, access, or authority you do not have. " +
    "Be specific about why you cannot handle it and what Atlas would need to do.",
  similes: ["HAND_OFF", "ROUTE_TO_ATLAS", "OUT_OF_SCOPE", "NEEDS_ATLAS"],
  examples: [
    [{ user: "user", content: { text: "This is outside my domain, escalating to Atlas." } }],
  ],
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: unknown,
    callback: (result: { text: string }) => void,
  ) => {
    try {
      const agentId = (state as Record<string, unknown>).agentDbId;
      const userId  = (state as Record<string, unknown>).userId;
      const agentName = (state as Record<string, unknown>).agentName ?? "Agent";

      // Log the delegation in the DB
      if (agentId && userId) {
        await sbPost("/agent_delegations", {
          user_id:       userId,
          from_agent_id: agentId,
          // Atlas doesn't have a DB row — this is an outbound escalation
          to_agent_id:   agentId, // placeholder; Atlas handles by convention
          task:          message.content?.text ?? "",
          routing_reason: `${agentName} determined this task is outside its defined capabilities`,
          outcome:       "pending",
        }).catch(() => {}); // non-blocking
      }

      callback({
        text: `This task is outside my operational scope. Escalating to Atlas.\n` +
              `Task: ${message.content?.text ?? ""}\n` +
              `Reason: Requires capabilities or authority not provisioned to me.`,
      });
      return true;
    } catch (err) {
      callback({ text: `Escalation error: ${(err as Error).message}` });
      return false;
    }
  },
};

// LOG_ACTION — agents call this after any significant action
const logActionAction = {
  name: "LOG_ACTION",
  description:
    "Log a completed action to the session record for later reflection. " +
    "Call this after any meaningful decision or output.",
  similes: ["RECORD_ACTION", "ACTION_LOG"],
  examples: [
    [{ user: "agent", content: { text: "Logged: drafted tweet. Success: true." } }],
  ],
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: unknown,
    callback: (result: { text: string }) => void,
  ) => {
    try {
      const sessionId = (state as Record<string, unknown>).currentSessionId;
      if (!sessionId) {
        callback({ text: "No active session to log to." });
        return false;
      }

      // Parse the message for action details
      const text     = message.content?.text ?? "";
      const success  = !text.toLowerCase().includes("fail") && !text.toLowerCase().includes("error");

      // Append to session actions_taken array via Supabase RPC
      await fetch(`${SUPABASE_URL}/rest/v1/agent_sessions?id=eq.${sessionId}`, {
        method: "PATCH",
        headers: {
          ...sbHeaders,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          actions_taken: (state as Record<string, unknown>).sessionActions ?? [],
        }),
      });

      callback({ text: `Action logged (${success ? "success" : "failure"}).` });
      return true;
    } catch (err) {
      callback({ text: `Log error: ${(err as Error).message}` });
      return false;
    }
  },
};

// RECALL_MEMORY — agent explicitly surfaces its own learned beliefs
const recallMemoryAction = {
  name: "RECALL_MEMORY",
  description:
    "Retrieve your learned memories, patterns, and constraints. " +
    "Use this when you need to check what you've previously learned about a topic.",
  similes: ["WHAT_DO_I_KNOW", "MY_MEMORY", "RECALL", "LEARNED_PATTERNS"],
  examples: [
    [{ user: "user", content: { text: "What have you learned about this?" } }],
    [{ user: "user", content: { text: "What are your constraints?" } }],
  ],
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state: State,
    _options: unknown,
    callback: (result: { text: string }) => void,
  ) => {
    try {
      const agentId = (state as Record<string, unknown>).agentDbId ?? runtime.agentId;
      const rows    = await sbGet(
        `/agent_memory?agent_id=eq.${agentId}&order=confidence.desc&limit=50&select=*`,
      );

      if (!Array.isArray(rows) || rows.length === 0) {
        callback({ text: "No learned memories yet. Run SELF_REFLECT after sessions to build up memory." });
        return true;
      }

      const reflections = await sbGet(
        `/agent_reflections?agent_id=eq.${agentId}&order=created_at.desc&limit=3&select=what_worked,what_failed,autonomy_delta,created_at`,
      );

      let text = `Memory snapshot — ${rows.length} entries\n\n`;

      const byType: Record<string, typeof rows> = {};
      for (const r of rows) {
        if (!byType[r.memory_type]) byType[r.memory_type] = [];
        byType[r.memory_type].push(r);
      }

      for (const [type, items] of Object.entries(byType)) {
        text += `[${type.toUpperCase()}]\n`;
        for (const item of items as { key: string; value: string; confidence: number }[]) {
          text += `  • ${item.key}: ${item.value} (conf: ${(item.confidence * 100).toFixed(0)}%)\n`;
        }
        text += "\n";
      }

      if (Array.isArray(reflections) && reflections.length > 0) {
        const latest = reflections[0] as { what_worked: string; what_failed: string; autonomy_delta: string; created_at: string };
        text += `Latest reflection (${new Date(latest.created_at).toLocaleDateString()}):\n`;
        text += `  Worked: ${latest.what_worked}\n`;
        text += `  Failed: ${latest.what_failed}\n`;
        text += `  Autonomy goal: ${latest.autonomy_delta}\n`;
      }

      callback({ text });
      return true;
    } catch (err) {
      callback({ text: `Memory recall failed: ${(err as Error).message}` });
      return false;
    }
  },
};

// REPORT_STATUS — Atlas polls this to check agent health
const reportStatusAction = {
  name: "REPORT_STATUS",
  description: "Report current operational status, recent session outcomes, and memory confidence.",
  similes: ["STATUS", "AGENT_STATUS", "HOW_ARE_YOU", "OPERATIONAL_STATUS"],
  examples: [
    [{ user: "user", content: { text: "Status report" } }],
    [{ user: "user", content: { text: "How are you performing?" } }],
  ],
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state: State,
    _options: unknown,
    callback: (result: { text: string }) => void,
  ) => {
    try {
      const agentId = (state as Record<string, unknown>).agentDbId ?? runtime.agentId;

      const [sessions, memories, reflections] = await Promise.all([
        sbGet(`/agent_sessions?agent_id=eq.${agentId}&order=started_at.desc&limit=10&select=outcome,autonomy_score,started_at`),
        sbGet(`/agent_memory?agent_id=eq.${agentId}&select=confidence`),
        sbGet(`/agent_reflections?agent_id=eq.${agentId}&order=created_at.desc&limit=1&select=quality_score,created_at`),
      ]);

      const sessionArr  = Array.isArray(sessions)    ? sessions    : [];
      const memoryArr   = Array.isArray(memories)     ? memories    : [];
      const reflArr     = Array.isArray(reflections)  ? reflections : [];

      const successRate  = sessionArr.length
        ? (sessionArr.filter((s: { outcome: string }) => s.outcome === "success").length / sessionArr.length * 100).toFixed(0)
        : "—";
      const avgAutonomy  = sessionArr.length
        ? (sessionArr.reduce((s: number, ss: { autonomy_score: number }) => s + Number(ss.autonomy_score ?? 0), 0) / sessionArr.length).toFixed(2)
        : "—";
      const avgConf      = memoryArr.length
        ? (memoryArr.reduce((s: number, m: { confidence: number }) => s + Number(m.confidence), 0) / memoryArr.length * 100).toFixed(0)
        : "—";
      const lastReflect  = reflArr[0]
        ? `${new Date((reflArr[0] as { created_at: string }).created_at).toLocaleDateString()} (quality: ${((reflArr[0] as { quality_score: number }).quality_score * 100).toFixed(0)}%)`
        : "Never";

      callback({
        text: [
          `Sessions (last 10): ${sessionArr.length} | Success rate: ${successRate}%`,
          `Average autonomy score: ${avgAutonomy}`,
          `Memory entries: ${memoryArr.length} | Avg confidence: ${avgConf}%`,
          `Last reflection: ${lastReflect}`,
        ].join("\n"),
      });
      return true;
    } catch (err) {
      callback({ text: `Status check failed: ${(err as Error).message}` });
      return false;
    }
  },
};

// ─── Post-session evaluator ───────────────────────────────────────
// Fires automatically after every conversation to trigger reflection
// when the session meets the threshold.

const postSessionEvaluator = {
  name: "POST_SESSION_REFLECT",
  description: "Automatically triggers reflection after a session completes.",
  similes: [],
  alwaysRun: true,
  validate: async (_runtime: IAgentRuntime, _message: Memory, state: State) => {
    // Only fire on the final message of a session (heuristic: end-of-conversation signal)
    const text = ((_message as Memory & { content?: { text?: string } }).content?.text ?? "").toLowerCase();
    return text.includes("goodbye") || text.includes("session end") || text.includes("done for now");
  },
  handler: async (runtime: IAgentRuntime, _message: Memory, state: State) => {
    try {
      const agentId = (state as Record<string, unknown>).agentDbId ?? runtime.agentId;
      const userId  = (state as Record<string, unknown>).userId ?? "";
      if (!agentId || !userId) return;
      await callEdgeFunction("agent_reflect", { agent_id: agentId, user_id: userId });
    } catch {
      // Silent — don't interrupt the conversation if reflection fails
    }
  },
};

// ─── Plugin export ────────────────────────────────────────────────

const skyforgeAgentBaseline: Plugin = {
  name: "skyforge-agent-baseline",
  description:
    "Universal Skyforge agent baseline: self-reflection loop, memory context injection, " +
    "Atlas escalation, action logging, and status reporting. " +
    "Load this in every agent alongside domain-specific plugins.",
  actions:    [selfReflectAction, escalateToAtlasAction, logActionAction, recallMemoryAction, reportStatusAction],
  providers:  [agentMemoryProvider],
  evaluators: [postSessionEvaluator],
};

export default skyforgeAgentBaseline;
