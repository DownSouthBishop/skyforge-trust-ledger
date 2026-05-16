// Atlas Trade Thesis — deep research on any symbol
// Generates structured trade thesis, saves to research_notes (Vault)

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv } from "../_shared/gateway.ts";

const ATLAS_MODEL = () => modelEnv("ATLAS_MODEL", "openai/gpt-4o");

async function fetchSECFilings(symbol: string): Promise<string> {
  try {
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().split("T")[0];
    const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(symbol)}&dateRange=custom&startdt=${fmt(thirtyDaysAgo)}&enddt=${fmt(today)}&forms=10-K,10-Q,8-K`;
    const res = await fetch(url, { headers: { "User-Agent": "AtlasIntel/1.0 admin@atlas.finance" } });
    if (!res.ok) return "No recent SEC filings found.";
    const data = await res.json();
    const hits = data.hits?.hits ?? [];
    if (hits.length === 0) return "No recent SEC filings found.";
    const lines = hits.slice(0, 5).map((h: any) => {
      const src = h._source ?? {};
      return `- ${src.form_type ?? "?"} filed ${src.file_date ?? "?"} by ${(src.display_names ?? []).join(", ")} | period: ${src.period_of_report ?? "N/A"}`;
    });
    return `Recent SEC filings (last 30 days):\n${lines.join("\n")}`;
  } catch {
    return "No recent SEC filings found.";
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("LOVABLE_API_KEY");

    const { user_id, symbol, asset_class = "equity", context: userContext = "" } = await req.json();
    if (!user_id || !symbol) {
      return new Response(JSON.stringify({ error: "user_id and symbol required" }), { status: 400, headers: corsHeaders });
    }

    const sym = symbol.trim().toUpperCase();
    const today = new Date().toISOString().split("T")[0];

    const [existingRes, posRes, secFilings] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/research_notes?user_id=eq.${user_id}&symbol=eq.${encodeURIComponent(sym)}&order=created_at.desc&limit=3&select=title,content,created_at`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/trade_ledger?user_id=eq.${user_id}&symbol=eq.${encodeURIComponent(sym)}&status=eq.open&select=direction,entry_price,quantity,broker,opened_at`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
      ),
      asset_class === "equity" ? fetchSECFilings(sym) : Promise.resolve("SEC filings not applicable for this asset class."),
    ]);

    const existing  = existingRes.ok ? await existingRes.json() : [];
    const positions = posRes.ok      ? await posRes.json()      : [];

    const prompt = `You are Atlas — autonomous financial intelligence. Generate a structured trade thesis for ${sym}.

Asset class: ${asset_class}
Date: ${today}
${userContext ? `Operator context: ${userContext}` : ""}
${positions.length > 0 ? `\nCurrent position: ${positions[0].direction.toUpperCase()} ${positions[0].quantity} @ ${positions[0].entry_price} via ${positions[0].broker}` : "No current position in this symbol."}
${existing.length > 0 ? `\nPrevious research:\n${existing.map((n: any) => `- ${n.title} (${n.created_at.split("T")[0]})`).join("\n")}` : ""}

SEC FILINGS:
${secFilings}

Generate a structured markdown thesis with these sections:
1. **Symbol Overview** — what this is, why it matters
2. **Bull Case** — the setup, catalyst, and target
3. **Bear Case** — what invalidates the thesis
4. **Key Levels** — support, resistance, entry zone
5. **Risk Parameters** — suggested stop, max position size at 2% account risk
6. **Verdict** — Long / Short / Wait, with one-sentence rationale

Be direct. No hedging language. State the thesis like you've already done the research.`;

    const aiRespRaw = await callGatewayWithRetry(
      {
        model: ATLAS_MODEL(),
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1200,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      },
      API_KEY,
    );
    const aiResp = await aiRespRaw.json();
    const content = aiResp.choices?.[0]?.message?.content ?? "Thesis generation failed.";
    const title = `${sym} Trade Thesis — ${today}`;

    await fetch(`${SUPABASE_URL}/rest/v1/research_notes`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ user_id, symbol: sym, title, content, note_type: "thesis", synced_to_obsidian: false }),
    });

    await fetch(`${SUPABASE_URL}/rest/v1/atlas_tasks`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ user_id, task_type: "research", payload: { symbol: sym, action: "obsidian_sync" }, status: "queued" }),
    });

    return new Response(JSON.stringify({ thesis: content, title }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});
