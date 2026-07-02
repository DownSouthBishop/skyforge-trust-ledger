// notebook-ingest — fetches a URL server-side (avoids browser CORS) and stores
// it as a plain-text notebook_sources row. File uploads and pasted text don't
// need this — the frontend writes those rows directly via the Supabase client.

import { corsHeaders, parseEnv, verifyUser, AuthError } from "../_shared/gateway.ts";

function stripHtml(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? "";
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const text = withoutScripts
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return { title, text };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    const userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    const { notebook_id, url } = await req.json() as { notebook_id: string; url: string };
    if (!notebook_id || !url) {
      return new Response(JSON.stringify({ error: "notebook_id and url are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let parsed: URL;
    try { parsed = new URL(url); } catch {
      return new Response(JSON.stringify({ error: "Invalid URL" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return new Response(JSON.stringify({ error: "Only http/https URLs are supported" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const pageResp = await fetch(parsed.toString(), { headers: { "User-Agent": "Mozilla/5.0 (compatible; NotebookBot/1.0)" } });
    if (!pageResp.ok) {
      return new Response(JSON.stringify({ error: `Fetch failed: HTTP ${pageResp.status}` }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const html = await pageResp.text();
    const { title, text } = stripHtml(html);
    if (!text) {
      return new Response(JSON.stringify({ error: "No readable text found at that URL" }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/notebook_sources`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({
        notebook_id, user_id: userId,
        title: title || parsed.hostname,
        source_type: "url",
        source_url: parsed.toString(),
        content_text: text.slice(0, 100_000), // cap — a full book-length page is not the target use case
      }),
    });
    if (!insertRes.ok) {
      const err = await insertRes.text().catch(() => "");
      return new Response(JSON.stringify({ error: `Failed to save source: ${err.slice(0, 200)}` }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const [source] = await insertRes.json();
    return new Response(JSON.stringify({ source }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.error("[notebook-ingest]", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
