import { corsHeaders, parseEnv, verifyUser } from "../_shared/gateway.ts";

const RAILWAY_URL = "https://openclaw-production-18a2.up.railway.app";

async function clawFetch(
  clawToken: string,
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: unknown,
) {
  const resp = await fetch(`${RAILWAY_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${clawToken}`,
      "X-Access-Token": clawToken,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const ct = resp.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await resp.json() : { raw: await resp.text() };
  if (!resp.ok) throw new Error(`OpenClaw ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = parseEnv("SUPABASE_URL");
    const serviceKey  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const clawToken   = parseEnv("OPENCLAW_API_TOKEN");

    await verifyUser(supabaseUrl, serviceKey, req.headers.get("Authorization"));

    const body = await req.json();
    const { action = "status", ...payload } = body;

    // ── Register an agent character with OpenClaw ──────────────────
    if (action === "register_agent") {
      const { character } = payload as { character: Record<string, unknown> };
      const data = await clawFetch(clawToken, "/api/agents", "POST", character);
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Link an OpenClaw agent to a channel ────────────────────────
    if (action === "link_channel") {
      const { agent_id, channel, webhook_url } = payload as {
        agent_id: string;
        channel: string;
        webhook_url?: string;
      };
      const data = await clawFetch(clawToken, `/api/agents/${agent_id}/channels`, "POST", {
        channel,
        webhook_url,
      });
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Get agent status / channel links ───────────────────────────
    if (action === "agent_status") {
      const { agent_id } = payload as { agent_id: string };
      const data = await clawFetch(clawToken, `/api/agents/${agent_id}`, "GET");
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Standard routing ───────────────────────────────────────────
    const endpointMap: Record<string, { path: string; method: "GET" | "POST" }> = {
      status:   { path: "/api/status",   method: "GET"  },
      health:   { path: "/health",        method: "GET"  },
      agents:   { path: "/api/agents",    method: "GET"  },
      channels: { path: "/api/channels",  method: "GET"  },
      skills:   { path: "/api/skills",    method: "GET"  },
      execute:  { path: "/api/execute",   method: "POST" },
      message:  { path: "/api/message",   method: "POST" },
      doctor:   { path: "/api/doctor",    method: "GET"  },
      sessions: { path: "/api/sessions",  method: "GET"  },
    };

    const route = endpointMap[action] ?? { path: "/api/status", method: "GET" as const };
    const data = await clawFetch(
      clawToken,
      route.path,
      route.method,
      route.method === "POST" ? payload : undefined,
    );

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isOffline = msg.includes("connection") || msg.includes("ECONNREFUSED") || msg.includes("fetch");
    return new Response(
      JSON.stringify({ error: isOffline ? "OpenClaw Railway service unreachable" : msg, offline: isOffline }),
      {
        status: isOffline ? 503 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
