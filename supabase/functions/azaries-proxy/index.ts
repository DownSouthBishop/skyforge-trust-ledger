import { corsHeaders, parseEnv, verifyUser } from "../_shared/gateway.ts";

const AZARIES_ENDPOINT = "https://api.azaries.ai/v1/spark/validate";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = parseEnv("SUPABASE_URL");
    const serviceKey = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const azariesKey = parseEnv("AZARIES_API_KEY");

    await verifyUser(supabaseUrl, serviceKey, req.headers.get("Authorization"));

    const body = await req.json();

    const upstream = await fetch(AZARIES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Azaries-Key": azariesKey,
      },
      body: JSON.stringify(body),
    });

    const data = await upstream.json();

    return new Response(JSON.stringify(data), {
      status: upstream.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
