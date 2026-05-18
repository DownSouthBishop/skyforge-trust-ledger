// openclaw-proxy — forwards requests to the OpenClaw instance
// Set OPENCLAW_URL as a Supabase secret pointing to your running OpenClaw server

import { corsHeaders, verifyUser, parseEnv, AuthError } from "../_shared/gateway.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL  = parseEnv("SUPABASE_URL");
    const SERVICE_KEY   = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const OPENCLAW_URL  = parseEnv("OPENCLAW_URL");

    // Verify caller is an authenticated user
    try {
      await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    } catch (e) {
      if (e instanceof AuthError) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw e;
    }

    // Build the forwarded URL — preserve path and query string after /openclaw-proxy
    const incomingUrl = new URL(req.url);
    const forwardPath = incomingUrl.searchParams.get("path") ?? "/";
    const targetUrl   = `${OPENCLAW_URL.replace(/\/$/, "")}${forwardPath}`;

    // Forward the request, stripping Supabase auth headers
    const forwardHeaders = new Headers();
    forwardHeaders.set("Content-Type", req.headers.get("Content-Type") ?? "application/json");
    const clawToken = Deno.env.get("OPENCLAW_TOKEN") ?? "";
    if (clawToken) forwardHeaders.set("Authorization", `Bearer ${clawToken}`);

    const body = req.method !== "GET" && req.method !== "HEAD"
      ? await req.text()
      : undefined;

    const upstream = await fetch(targetUrl, {
      method:  req.method,
      headers: forwardHeaders,
      body,
    });

    const responseBody = await upstream.text();

    return new Response(responseBody, {
      status:  upstream.status,
      headers: {
        ...corsHeaders,
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
      },
    });

  } catch (e) {
    console.error("[openclaw-proxy] Error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
