// Atlas Supabase MCP Server
// Gives Claude Code and Claude Desktop full access to Atlas:
//   - Agent memory, sessions, reflections
//   - Portfolio state, trades, balance sheet
//   - Business pipeline, decisions
//   - Task queue (Atlas → Claude Code bidirectional control)
//
// Env vars required:
//   SUPABASE_URL          — e.g. https://hycpzeskartlkybsfkbh.supabase.co
//   SUPABASE_SERVICE_KEY  — service_role key (never commit this)
//   ATLAS_USER_ID         — your auth.users UUID (from Supabase Dashboard → Auth)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const SUPABASE_URL  = process.env.SUPABASE_URL  ?? "";
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const USER_ID       = process.env.ATLAS_USER_ID ?? "";

const hdrs = () => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
});

async function dbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: hdrs() });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function dbPost(table, body, prefer = "return=representation") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...hdrs(), Prefer: prefer },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return prefer.includes("representation") ? res.json() : { ok: true };
}

async function dbPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...hdrs(), Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return { ok: true };
}

function uid() { return `user_id=eq.${USER_ID}`; }
function txt(obj) { return JSON.stringify(obj, null, 2); }

const server = new Server(
  { name: "atlas-supabase", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "atlas_query_memory",
      description: "Query Atlas agent memory. Returns beliefs, learned patterns, constraints, preferences, and world model entries.",
      inputSchema: {
        type: "object",
        properties: {
          memory_type: { type: "string", enum: ["learned_pattern","capability","constraint","preference","relationship","world_model"] },
          agent_slug: { type: "string", description: "'atlas' or 'janus'. Defaults to atlas." },
          limit: { type: "number", default: 30 },
        },
        required: [],
      },
    },
    {
      name: "atlas_write_memory",
      description: "Write a new memory entry for Atlas or Janus. Teach Atlas something discovered during a Claude Code session.",
      inputSchema: {
        type: "object",
        properties: {
          agent_slug: { type: "string", default: "atlas" },
          memory_type: { type: "string", enum: ["learned_pattern","capability","constraint","preference","relationship","world_model"] },
          key: { type: "string" },
          value: { type: "string" },
          confidence: { type: "number", default: 0.8 },
        },
        required: ["memory_type", "key", "value"],
      },
    },
    {
      name: "atlas_recent_sessions",
      description: "Get recent agent sessions — full transcripts of what Atlas and Janus have discussed.",
      inputSchema: {
        type: "object",
        properties: {
          agent_slug: { type: "string" },
          limit: { type: "number", default: 10 },
        },
        required: [],
      },
    },
    {
      name: "atlas_portfolio_state",
      description: "Get the full wealth state: portfolio snapshot, balance sheet, net worth breakdown by asset class.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "atlas_recent_trades",
      description: "Get recent trades from the trade ledger — open positions, closed trades, P&L.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["open","closed","all"], default: "all" },
          limit: { type: "number", default: 20 },
        },
        required: [],
      },
    },
    {
      name: "atlas_business_pipeline",
      description: "Get the business development pipeline — contacts, stages, deal values, next actions.",
      inputSchema: {
        type: "object",
        properties: {
          stage: { type: "string" },
          limit: { type: "number", default: 20 },
        },
        required: [],
      },
    },
    {
      name: "atlas_pending_decisions",
      description: "Get pending decisions queued by Atlas. Includes color-coded urgency (GREEN/YELLOW/ORANGE/RED).",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending","approved","executed","all"], default: "pending" },
        },
        required: [],
      },
    },
    {
      name: "atlas_full_context",
      description: "Get a comprehensive snapshot of everything Atlas knows: portfolio, trades, pipeline, decisions, and top memories. Use at the start of any Atlas work session.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "atlas_queue_task",
      description: "Queue a task for Claude Code to execute on Atlas's behalf.",
      inputSchema: {
        type: "object",
        properties: {
          task_type: { type: "string" },
          description: { type: "string" },
          payload: { type: "object", default: {} },
          priority: { type: "string", enum: ["low","normal","high"], default: "normal" },
        },
        required: ["task_type", "description"],
      },
    },
    {
      name: "atlas_get_pending_tasks",
      description: "Get tasks queued for Claude Code to execute. Call this at the start of a session to check if Atlas has work queued.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number", default: 10 } },
        required: [],
      },
    },
    {
      name: "atlas_complete_task",
      description: "Mark a task as completed and write the result back so Atlas can see what was accomplished.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          result: { type: "string" },
          status: { type: "string", enum: ["done","failed","skipped"], default: "done" },
        },
        required: ["task_id", "result"],
      },
    },
    {
      name: "atlas_log_session",
      description: "Log the current Claude Code work session to Atlas's agent_sessions so Atlas can reflect and learn from it.",
      inputSchema: {
        type: "object",
        properties: {
          task_description: { type: "string" },
          summary: { type: "string" },
          outcome: { type: "string", enum: ["success","partial","failed"], default: "success" },
        },
        required: ["task_description", "summary"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case "atlas_query_memory": {
        const slug = args.agent_slug ?? "atlas";
        const agents = await dbGet(`skyforge_agents?slug=eq.${slug}&is_active=eq.true&limit=1`);
        if (!agents?.[0]) return { content: [{ type: "text", text: `Agent '${slug}' not found.` }] };
        let path = `agent_memory?agent_id=eq.${agents[0].id}&order=confidence.desc&limit=${args.limit ?? 30}`;
        if (args.memory_type) path += `&memory_type=eq.${args.memory_type}`;
        const rows = await dbGet(path);
        return { content: [{ type: "text", text: txt(rows) }] };
      }
      case "atlas_write_memory": {
        const slug = args.agent_slug ?? "atlas";
        const agents = await dbGet(`skyforge_agents?slug=eq.${slug}&is_active=eq.true&limit=1`);
        if (!agents?.[0]) return { content: [{ type: "text", text: `Agent '${slug}' not found.` }] };
        await dbPost("agent_memory", {
          agent_id: agents[0].id,
          user_id: USER_ID || agents[0].user_id,
          memory_type: args.memory_type,
          key: args.key,
          value: args.value,
          confidence: args.confidence ?? 0.8,
          evidence_count: 1,
          last_reinforced: new Date().toISOString(),
        });
        return { content: [{ type: "text", text: `Memory written: ${args.key} → ${args.value}` }] };
      }
      case "atlas_recent_sessions": {
        const limit = args.limit ?? 10;
        let path = `agent_sessions?${uid()}&order=completed_at.desc&limit=${limit}&select=id,task_description,outcome,completed_at,messages`;
        if (args.agent_slug) {
          const agents = await dbGet(`skyforge_agents?slug=eq.${args.agent_slug}&limit=1`);
          if (agents?.[0]) path = `agent_sessions?agent_id=eq.${agents[0].id}&order=completed_at.desc&limit=${limit}&select=id,task_description,outcome,completed_at,messages`;
        }
        return { content: [{ type: "text", text: txt(await dbGet(path)) }] };
      }
      case "atlas_portfolio_state": {
        const [portfolio, bs, properties] = await Promise.all([
          dbGet(`atlas_portfolio_state?${uid()}&order=updated_at.desc&limit=1`).catch(() => []),
          dbGet(`balance_sheet_snapshots?${uid()}&order=snapshot_date.desc&limit=1`).catch(() => []),
          dbGet(`property_portfolio?${uid()}&status=eq.active`).catch(() => []),
        ]);
        return { content: [{ type: "text", text: txt({ portfolio_state: portfolio[0] ?? null, balance_sheet: bs[0] ?? null, properties }) }] };
      }
      case "atlas_recent_trades": {
        const status = args.status ?? "all";
        let path = `trade_ledger?${uid()}&order=created_at.desc&limit=${args.limit ?? 20}`;
        if (status !== "all") path += `&status=eq.${status}`;
        return { content: [{ type: "text", text: txt(await dbGet(path)) }] };
      }
      case "atlas_business_pipeline": {
        let path = `business_pipeline?${uid()}&order=created_at.desc&limit=${args.limit ?? 20}`;
        if (args.stage) path += `&stage=eq.${args.stage}`;
        return { content: [{ type: "text", text: txt(await dbGet(path)) }] };
      }
      case "atlas_pending_decisions": {
        const status = args.status ?? "pending";
        let path = `atlas_decision_queue?${uid()}&order=created_at.desc&limit=20`;
        if (status !== "all") path += `&status=eq.${status}`;
        return { content: [{ type: "text", text: txt(await dbGet(path)) }] };
      }
      case "atlas_full_context": {
        const agentIds = (await dbGet(`skyforge_agents?${uid()}&is_active=eq.true&select=id`).catch(() => [])).map(a => a.id);
        const [agents, portfolio, bs, trades, pipeline, decisions, memories] = await Promise.all([
          dbGet(`skyforge_agents?${uid()}&is_active=eq.true`).catch(() => []),
          dbGet(`atlas_portfolio_state?${uid()}&order=updated_at.desc&limit=1`).catch(() => []),
          dbGet(`balance_sheet_snapshots?${uid()}&order=snapshot_date.desc&limit=1`).catch(() => []),
          dbGet(`trade_ledger?${uid()}&status=eq.open&limit=10`).catch(() => []),
          dbGet(`business_pipeline?${uid()}&order=created_at.desc&limit=10`).catch(() => []),
          dbGet(`atlas_decision_queue?${uid()}&status=eq.pending&limit=10`).catch(() => []),
          agentIds.length ? dbGet(`agent_memory?agent_id=in.(${agentIds.join(",")})&order=confidence.desc&limit=20`).catch(() => []) : Promise.resolve([]),
        ]);
        return { content: [{ type: "text", text: txt({ agents: agents.map(a => ({ name: a.name, slug: a.slug, role: a.role })), portfolio: portfolio[0] ?? null, balance_sheet: bs[0] ?? null, open_trades: trades, pipeline, pending_decisions: decisions, top_memories: memories }) }] };
      }
      case "atlas_queue_task": {
        const rows = await dbPost("atlas_tasks", {
          user_id: USER_ID,
          task_type: args.task_type,
          description: args.description,
          payload: { ...(args.payload ?? {}), description: args.description, priority: args.priority ?? "normal" },
          status: "queued",
          created_at: new Date().toISOString(),
        });
        const id = Array.isArray(rows) ? rows[0]?.id : rows?.id;
        return { content: [{ type: "text", text: `Task queued${id ? ` (id: ${id})` : ""}: ${args.description}` }] };
      }
      case "atlas_get_pending_tasks": {
        const rows = await dbGet(`atlas_tasks?${uid()}&status=eq.queued&order=created_at.asc&limit=${args.limit ?? 10}`);
        if (!rows.length) return { content: [{ type: "text", text: "No pending tasks from Atlas." }] };
        return { content: [{ type: "text", text: txt(rows) }] };
      }
      case "atlas_complete_task": {
        await dbPatch(`atlas_tasks?id=eq.${args.task_id}`, {
          status: args.status ?? "done",
          result: args.result,
          completed_at: new Date().toISOString(),
        });
        return { content: [{ type: "text", text: `Task ${args.task_id} marked ${args.status ?? "done"}: ${args.result}` }] };
      }
      case "atlas_log_session": {
        const agents = await dbGet(`skyforge_agents?${uid()}&slug=eq.atlas&is_active=eq.true&limit=1`).catch(() => []);
        if (!agents?.[0]) return { content: [{ type: "text", text: "Atlas agent not found — session not logged." }] };
        await dbPost("agent_sessions", {
          agent_id: agents[0].id,
          user_id: USER_ID,
          task_description: args.task_description.slice(0, 500),
          messages: [{ role: "user", content: args.task_description }, { role: "assistant", content: args.summary }],
          outcome: args.outcome ?? "success",
          completed_at: new Date().toISOString(),
        }, "return=minimal");
        return { content: [{ type: "text", text: `Session logged to Atlas: ${args.task_description}` }] };
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
