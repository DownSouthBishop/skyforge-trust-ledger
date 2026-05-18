import { corsHeaders, parseEnv, verifyUser } from "../_shared/gateway.ts";

const RAILWAY_URL = "https://openclaw-production-18a2.up.railway.app";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = parseEnv("SUPABASE_URL");
    const serviceKey = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const clawToken = parseEnv("OPENCLAW_API_TOKEN");

    await verifyUser(supabaseUrl, serviceKey, req.headers.get("Authorization"));

    const body = await req.json();
    const { action = "status", ...payload } = body;

    const endpointMap: Record<string, { path: string; method: string }> = {
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

    const route = endpointMap[action] ?? { path: "/api/status", method: "GET" };

    const upstream = await fetch(`${RAILWAY_URL}${route.path}`, {
      method: route.method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${clawToken}`,
        "X-Access-Token": clawToken,
      },
      ...(route.method === "POST" ? { body: JSON.stringify(payload) } : {}),
    });

    const contentType = upstream.headers.get("content-type") ?? "";
    const isJson = contentType.includes("application/json");
    const data = isJson ? await upstream.json() : { raw: await upstream.text() };

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({ error: `OpenClaw error ${upstream.status}`, detail: data }),
        { status: upstream.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify(data), {
      status: 200,
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
