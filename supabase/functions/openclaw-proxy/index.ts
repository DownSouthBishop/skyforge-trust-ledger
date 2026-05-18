import { corsHeaders, parseEnv, verifyUser } from "../_shared/gateway.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = parseEnv("SUPABASE_URL");
    const serviceKey = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const clawUrl = parseEnv("OPENCLAW_GATEWAY_URL");

    await verifyUser(supabaseUrl, serviceKey, req.headers.get("Authorization"));

    const body = await req.json();
    const { action = "status", ...payload } = body;

    // action → OpenClaw gateway path
    const endpointMap: Record<string, string> = {
      status: "/api/status",
      doctor: "/api/doctor",
      sessions: "/api/sessions",
      skills: "/api/skills",
      execute: "/api/execute",
      channels: "/api/channels",
    };

    const path = endpointMap[action] ?? "/api/status";

    const upstream = await fetch(`${clawUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return new Response(
        JSON.stringify({ error: `OpenClaw error ${upstream.status}`, detail: errText }),
        { status: upstream.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const data = await upstream.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isOffline = msg.includes("connection") || msg.includes("ECONNREFUSED") || msg.includes("fetch");
    return new Response(
      JSON.stringify({ error: isOffline ? "OpenClaw offline — check tunnel" : msg, offline: isOffline }),
      {
        status: isOffline ? 503 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
