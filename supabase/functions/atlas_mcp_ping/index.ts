// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";

    // Identify caller
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser();
    const userId = userData?.user?.id;
    if (!userId) return json({ error: "unauthorized" }, 401);

    const { connection_id, confirm_stdio, manual_capabilities } = await req.json();
    if (!connection_id) return json({ error: "connection_id required" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: conn, error: cErr } = await admin
      .from("atlas_mcp_connections")
      .select("*")
      .eq("id", connection_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (cErr || !conn) return json({ error: "not found" }, 404);

    let verified = false;
    let capabilities: any[] = Array.isArray(conn.capabilities) ? conn.capabilities : [];
    let pingError: string | null = null;

    if (conn.transport === "sse") {
      if (!conn.url) return json({ error: "SSE connection missing url" }, 400);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      };
      if (authHeader) headers["Authorization"] = authHeader;
      const envVars = (conn.env_vars ?? {}) as Record<string, string>;
      for (const [k, v] of Object.entries(envVars)) {
        if (/auth|token|key/i.test(k)) headers["Authorization"] = `Bearer ${v}`;
      }

      let tools: any[] = [];
      // 1) Try MCP JSON-RPC tools/list
      try {
        const r = await fetch(conn.url, {
          method: "POST", headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        });
        const ct = r.headers.get("content-type") ?? "";
        let payload: any;
        if (ct.includes("text/event-stream")) {
          const text = await r.text();
          const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
          payload = dataLine ? JSON.parse(dataLine.slice(5).trim()) : null;
        } else {
          payload = await r.json().catch(() => null);
        }
        const t = payload?.result?.tools;
        if (Array.isArray(t)) tools = t;
        else if (payload?.error?.message) pingError = payload.error.message;
      } catch (e: any) { pingError = e?.message ?? "fetch failed"; }

      // 2) Fallback: GET → { tools: [...] } (used by mcp-alpaca/mcp-oanda shims)
      if (tools.length === 0) {
        try {
          const r2 = await fetch(conn.url, { method: "GET", headers });
          if (r2.ok) {
            const p2 = await r2.json().catch(() => null);
            const t2 = p2?.tools ?? p2?.result?.tools;
            if (Array.isArray(t2)) tools = t2;
          } else {
            pingError = `GET ${r2.status}`;
          }
        } catch (e: any) { pingError = e?.message ?? "fetch failed"; }
      }

      if (tools.length > 0) {
        verified = true;
        capabilities = tools.map((t: any) => ({ name: t.name, description: t.description ?? "" }));
        pingError = null;
      } else if (!pingError) {
        pingError = "no tools returned";
      }
    } else {
      // STDIO — auto-confirm local Claude Desktop bridges unless explicitly declined
      if (confirm_stdio === false) {
        pingError = "stdio confirmation declined";
      } else {
        verified = true;
        if (Array.isArray(manual_capabilities)) capabilities = manual_capabilities;
      }
    }

    const { error: uErr } = await admin
      .from("atlas_mcp_connections")
      .update({
        is_verified: verified,
        last_ping_at: new Date().toISOString(),
        capabilities,
      })
      .eq("id", connection_id);
    if (uErr) return json({ error: uErr.message }, 500);

    return json({ ok: true, verified, capabilities, error: pingError });
  } catch (e: any) {
    return json({ error: e?.message ?? "unknown" }, 500);
  }
});
