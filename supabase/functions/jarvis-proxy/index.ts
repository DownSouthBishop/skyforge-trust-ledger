import { corsHeaders, parseEnv, verifyUser } from "../_shared/gateway.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = parseEnv("SUPABASE_URL");
    const serviceKey = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const jarvisUrl = parseEnv("JARVIS_BACKEND_URL");

    await verifyUser(supabaseUrl, serviceKey, req.headers.get("Authorization"));

    const body = await req.json();
    const { action = "chat", ...payload } = body;

    // Route to the correct local endpoint based on action
    const endpointMap: Record<string, string> = {
      chat: "/v1/chat/completions",
      telemetry: "/v1/telemetry",
      trigger: "/v1/trigger",
      status: "/v1/status",
    };

    const path = endpointMap[action] ?? "/v1/chat/completions";
    const stream = payload.stream === true;

    const upstream = await fetch(`${jarvisUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, stream }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return new Response(
        JSON.stringify({ error: `Jarvis backend error ${upstream.status}`, detail: errText }),
        { status: upstream.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (stream && upstream.body) {
      return new Response(upstream.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
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
      JSON.stringify({ error: isOffline ? "Jarvis offline — check tunnel" : msg, offline: isOffline }),
      {
        status: isOffline ? 503 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
