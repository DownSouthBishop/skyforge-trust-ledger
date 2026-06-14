// atlas-browser — command queue endpoint for the local Playwright worker.
// Worker authenticates with ATLAS_WORKER_TOKEN (shared secret) + a header
// X-Atlas-User identifying which operator's queue to drain.
//
// POST  { action: "claim", limit?: number }                -> claims up to N queued safe commands
// POST  { action: "complete", id, result?, error? }        -> marks command done/failed, writes receipt
// GET                                                      -> health
//
// All other operations (enqueue, list, approve) go through atlas-core's
// existing read_table / write_record / request_approval / browser_action tools.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-atlas-user, x-atlas-worker-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function pg(url: string, key: string, method: string, path: string, body?: unknown, extra: Record<string,string> = {}) {
  const r = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation", ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let d: unknown = null; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  return { ok: r.ok, status: r.status, data: d };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const WORKER_TOKEN = Deno.env.get("ATLAS_WORKER_TOKEN") ?? "";

  if (!WORKER_TOKEN) return json({ error: "ATLAS_WORKER_TOKEN not configured" }, 500);

  const token  = req.headers.get("x-atlas-worker-token") ?? "";
  const userId = req.headers.get("x-atlas-user") ?? "";
  if (token !== WORKER_TOKEN) return json({ error: "unauthorized" }, 401);
  if (!userId) return json({ error: "missing X-Atlas-User" }, 400);

  if (req.method === "GET") return json({ ok: true, ts: Date.now() });

  let body: { action?: string; id?: string; result?: unknown; error?: string; limit?: number } = {};
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  if (body.action === "claim") {
    const limit = Math.min(Math.max(1, Number(body.limit ?? 3) || 3), 10);
    // Fetch queued (safe) and approved-caution commands for this user.
    const q = new URLSearchParams();
    q.set("select", "id,command,args,risk,approval_id,status");
    q.set("user_id", `eq.${userId}`);
    q.set("status", `in.(queued,awaiting_approval)`);
    q.set("order", "created_at.asc");
    q.set("limit", String(limit));
    const list = await pg(SUPABASE_URL, SERVICE_KEY, "GET", `atlas_browser_commands?${q}`);
    if (!list.ok) return json({ error: "fetch failed", detail: list.data }, 500);

    const rows = (list.data as Array<{ id: string; command: string; args: unknown; risk: string; approval_id: string|null; status: string }>) ?? [];
    const claimable: typeof rows = [];
    for (const r of rows) {
      if (r.status === "queued" && r.risk === "safe") { claimable.push(r); continue; }
      if (r.approval_id) {
        const a = await pg(SUPABASE_URL, SERVICE_KEY, "GET",
          `atlas_approvals?select=status&id=eq.${r.approval_id}&limit=1`);
        const approved = Array.isArray(a.data) && (a.data as Array<{status:string}>)[0]?.status === "approved";
        if (approved) claimable.push(r);
      }
    }
    if (claimable.length === 0) return json({ commands: [] });

    const ids = claimable.map(c => c.id);
    await pg(SUPABASE_URL, SERVICE_KEY, "PATCH",
      `atlas_browser_commands?id=in.(${ids.join(",")})`,
      { status: "running", started_at: new Date().toISOString(), worker_id: "local" });

    return json({ commands: claimable });
  }

  if (body.action === "complete") {
    const id = String(body.id || "");
    if (!id) return json({ error: "id required" }, 400);
    const outcome = body.error ? "failed" : "done";
    const upd = await pg(SUPABASE_URL, SERVICE_KEY, "PATCH",
      `atlas_browser_commands?id=eq.${id}&user_id=eq.${userId}`,
      { status: outcome, result: body.result ?? null, error: body.error ?? null, finished_at: new Date().toISOString() });
    if (!upd.ok) return json({ error: "update failed", detail: upd.data }, 500);
    const row = Array.isArray(upd.data) ? (upd.data as Array<Record<string,unknown>>)[0] : null;
    // Write receipt
    await pg(SUPABASE_URL, SERVICE_KEY, "POST", "atlas_receipts", {
      user_id: userId, agent: "atlas",
      action: `browser.${(row as { command?: string } | null)?.command ?? "unknown"}`,
      result: body.error ? body.error : "ok",
      outcome: body.error ? "failure" : "success",
      metadata: { command_id: id, result: body.result ?? null },
    });
    return json({ ok: true });
  }

  return json({ error: "unknown action" }, 400);
});
