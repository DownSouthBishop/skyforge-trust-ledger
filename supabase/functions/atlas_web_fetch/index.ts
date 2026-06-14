import { corsHeaders, parseEnv, verifyUser } from "../_shared/gateway.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    let userId: string;
    try {
      userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { url, max_chars = 8000 } = await req.json();
    if (!url || typeof url !== "string") {
      return new Response(JSON.stringify({ error: "url required" }), { status: 400, headers: corsHeaders });
    }

    // Validate URL
    let parsedUrl: URL;
    try { parsedUrl = new URL(url); } catch {
      return new Response(JSON.stringify({ error: "Invalid URL" }), { status: 400, headers: corsHeaders });
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return new Response(JSON.stringify({ error: "Only http/https URLs allowed" }), { status: 400, headers: corsHeaders });
    }

    const resp = await fetch(url, {
      headers: { "User-Agent": "Atlas-Scout/1.0 (skyforge research agent)", Accept: "text/html,application/json,text/plain,*/*" },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      return new Response(JSON.stringify({ error: `HTTP ${resp.status} from ${url}` }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const contentType = resp.headers.get("content-type") ?? "";
    let text = await resp.text();

    // If HTML, strip tags to get readable text
    if (contentType.includes("text/html")) {
      // Remove scripts, styles, nav, footer
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<nav[\s\S]*?<\/nav>/gi, "")
        .replace(/<footer[\s\S]*?<\/footer>/gi, "")
        .replace(/<header[\s\S]*?<\/header>/gi, "")
        // Convert block elements to newlines
        .replace(/<\/?(p|div|h[1-6]|li|br|tr)[^>]*>/gi, "\n")
        // Strip remaining tags
        .replace(/<[^>]+>/g, "")
        // Decode common HTML entities
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
        // Collapse whitespace
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    // If JSON, pretty print
    if (contentType.includes("application/json")) {
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
    }

    const truncated = text.length > max_chars;
    const content = truncated ? text.slice(0, max_chars) + `\n\n[... truncated at ${max_chars} chars, full length: ${text.length}]` : text;

    return new Response(JSON.stringify({
      url,
      content_type: contentType,
      content,
      truncated,
      char_count: text.length,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
