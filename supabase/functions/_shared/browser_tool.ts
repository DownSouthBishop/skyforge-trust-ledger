// Shared browser_action tool: lets any agent queue a command for the
// operator's local Playwright worker (worker/atlas-worker.js), which polls
// atlas-browser and executes safe commands automatically, caution/restricted
// ones only once approved in atlas_approvals.

export const BROWSER_ACTION_TOOL_SCHEMA = {
  name: "browser_action",
  description: "Queue a command for the operator's LOCAL Playwright worker. You have full browser control. Safe (auto): navigate, search, extract, screenshot, read, scrape, download, wait, back, forward, reload, get_cookies, get_url, html, links, pdf. Caution (needs approval): click, type, fill, upload, login, press, select, hover, check, uncheck, set_cookies, clear_cookies, eval (arbitrary JS in page), multi (sequence of steps as args.steps). The worker polls atlas-browser and reports back.",
  input_schema: {
    type: "object" as const,
    properties: {
      command: { type: "string" },
      args:    { type: "object", description: "url, selector, text, query, path, ms, key, options, code, steps[], etc.", additionalProperties: true },
      objective: { type: "string" },
    },
    required: ["command"],
  },
};

const BROWSER_SAFE = new Set([
  "navigate", "search", "extract", "screenshot", "read", "scrape", "download",
  "wait", "back", "forward", "reload", "get_cookies", "get_url", "html", "links", "pdf",
]);
const BROWSER_CAUTION = new Set([
  "click", "type", "fill", "upload", "login", "press", "select", "hover", "check", "uncheck",
  "set_cookies", "clear_cookies", "eval", "multi",
]);

export function classifyBrowserRisk(command: string): "safe" | "caution" | "restricted" {
  if (BROWSER_SAFE.has(command)) return "safe";
  if (BROWSER_CAUTION.has(command)) return "caution";
  return "restricted";
}

async function pgrest(
  supabaseUrl: string,
  serviceKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const resp = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: resp.ok, status: resp.status, data };
}

export async function queueBrowserAction(opts: {
  supabaseUrl: string;
  serviceKey: string;
  userId: string;
  agent: string;
  command: string;
  args: Record<string, unknown>;
  objective: string;
}): Promise<Record<string, unknown>> {
  const { supabaseUrl, serviceKey, userId, agent, objective } = opts;
  const command = opts.command.toLowerCase();
  const args = opts.args ?? {};
  const risk = classifyBrowserRisk(command);

  let approval_id: string | null = null;
  let status = "queued";
  if (risk !== "safe") {
    const exp = new Date(Date.now() + 60 * 60_000).toISOString();
    const ar = await pgrest(supabaseUrl, serviceKey, "POST", "atlas_approvals", {
      user_id: userId, agent,
      category: risk === "restricted" ? "software_install" : "browser_caution",
      summary: `Browser ${command}: ${JSON.stringify(args).slice(0, 180)}`,
      payload: { command, args, objective }, expires_at: exp,
    });
    if (!ar.ok) return { error: `approval failed (${ar.status})`, detail: ar.data };
    approval_id = (Array.isArray(ar.data) ? ar.data[0] : ar.data)?.id ?? null;
    status = "awaiting_approval";
  }
  const cr = await pgrest(supabaseUrl, serviceKey, "POST", "atlas_browser_commands", {
    user_id: userId, agent, command, args, risk, approval_id, status,
  });
  if (!cr.ok) return { error: `queue failed (${cr.status})`, detail: cr.data };
  const row = (Array.isArray(cr.data) ? cr.data[0] : cr.data) as { id?: string };
  await pgrest(supabaseUrl, serviceKey, "POST", "atlas_receipts", {
    user_id: userId, agent, objective, action: `browser.${command}`,
    reason: objective, result: status, outcome: "pending",
    metadata: { args, risk, command_id: row?.id, approval_id },
  });
  return {
    command_id: row?.id, status, risk, approval_id,
    note: status === "queued"
      ? "Local worker will pick this up. Poll atlas_browser_commands for result."
      : "Operator must approve before the local worker will execute.",
  };
}
