// atlas_search — free web search via DuckDuckGo (no API key required)
// Returns top results with title, URL, and snippet.

import { corsHeaders, parseEnv, verifyUser } from "../_shared/gateway.ts";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// Parse DuckDuckGo HTML results page
function parseDDGResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // Match result blocks: <div class="result__body"> ... </div>
  const resultPattern = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;

  while ((m = resultPattern.exec(html)) !== null && results.length < 10) {
    const url     = m[1].trim();
    const title   = m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'").trim();
    const snippet = m[3].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'").trim();

    if (url && title && !url.startsWith("//duckduckgo")) {
      results.push({ title, url, snippet });
    }
  }

  // Fallback: broader pattern if first pass got nothing
  if (results.length === 0) {
    const urlPat   = /class="result__a"[^>]*href="([^"]+)"/g;
    const titlePat = /class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
    const snipPat  = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|span)>/g;

    const urls: string[]    = [];
    const titles: string[]  = [];
    const snips: string[]   = [];

    let u: RegExpExecArray | null;
    while ((u = urlPat.exec(html)) !== null)   urls.push(u[1].trim());
    while ((u = titlePat.exec(html)) !== null)  titles.push(u[1].replace(/<[^>]+>/g, "").trim());
    while ((u = snipPat.exec(html)) !== null)   snips.push(u[1].replace(/<[^>]+>/g, "").trim());

    const count = Math.min(urls.length, titles.length, 10);
    for (let i = 0; i < count; i++) {
      if (urls[i] && titles[i] && !urls[i].startsWith("//duckduckgo")) {
        results.push({ title: titles[i], url: urls[i], snippet: snips[i] ?? "" });
      }
    }
  }

  return results;
}

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

    const { query, max_results = 8 } = await req.json();
    if (!query || typeof query !== "string") {
      return new Response(JSON.stringify({ error: "query required" }), { status: 400, headers: corsHeaders });
    }

    const encoded = encodeURIComponent(query.trim());

    // 1. Try DDG instant answer API first (good for factual queries)
    let instantAnswer = "";
    try {
      const iaResp = await fetch(
        `https://api.duckduckgo.com/?q=${encoded}&format=json&no_redirect=1&no_html=1&skip_disambig=1`,
        { headers: { "User-Agent": "Atlas-Search/1.0" }, signal: AbortSignal.timeout(5000) },
      );
      if (iaResp.ok) {
        const ia = await iaResp.json();
        if (ia.AbstractText) instantAnswer = ia.AbstractText;
        else if (ia.Answer)   instantAnswer = String(ia.Answer);
      }
    } catch { /* skip */ }

    // 2. Scrape DDG HTML for full web results
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encoded}&kl=us-en`;
    const htmlResp = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Atlas-Search/1.0)",
        Accept: "text/html,*/*",
      },
      signal: AbortSignal.timeout(12000),
    });

    let results: SearchResult[] = [];
    if (htmlResp.ok) {
      const html = await htmlResp.text();
      results = parseDDGResults(html).slice(0, max_results);
    }

    const formatted = results.length > 0
      ? results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`).join("\n\n")
      : "No results found.";

    return new Response(JSON.stringify({
      query,
      instant_answer: instantAnswer || null,
      results,
      formatted,
      result_count: results.length,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
