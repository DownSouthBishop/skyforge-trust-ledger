// Atlas News Scan — Alpha Vantage news sentiment + SEC EDGAR 24hr filing check

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

async function fetchNewsForSymbol(symbol: string, alphaKey: string): Promise<any[]> {
  try {
    const res = await fetch(
      `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(symbol)}&apikey=${alphaKey}&limit=10`,
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.feed ?? [];
  } catch {
    return [];
  }
}

async function fetchEDGARFilings(symbol: string): Promise<Array<{ form: string; date: string; cik: string; accession: string }>> {
  try {
    // Get CIK for symbol
    const searchRes = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(symbol)}&entity=true`,
      { headers: { "User-Agent": "AtlasIntel/1.0 admin@atlas.finance" } },
    );
    if (!searchRes.ok) return [];
    const searchData = await searchRes.json();
    const cik = searchData?.hits?.hits?.[0]?._source?.entity_id;
    if (!cik) return [];

    const paddedCik = String(cik).padStart(10, "0");
    const subRes = await fetch(
      `https://data.sec.gov/submissions/CIK${paddedCik}.json`,
      { headers: { "User-Agent": "AtlasIntel/1.0 admin@atlas.finance" } },
    );
    if (!subRes.ok) return [];
    const subData = await subRes.json();

    const recent = subData?.filings?.recent;
    if (!recent) return [];

    const forms    = recent.form        as string[];
    const dates    = recent.filingDate  as string[];
    const accNums  = recent.accessionNumber as string[];

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const results: Array<{ form: string; date: string; cik: string; accession: string }> = [];

    for (let i = 0; i < forms.length; i++) {
      if ((forms[i] === "8-K" || forms[i] === "10-Q") && dates[i] >= yesterday) {
        results.push({ form: forms[i], date: dates[i], cik: paddedCik, accession: accNums[i] });
      }
    }
    return results;
  } catch {
    return [];
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const ALPHA_KEY    = Deno.env.get("ALPHA_VANTAGE_KEY");

    if (!ALPHA_KEY) {
      console.warn("ALPHA_VANTAGE_KEY not set — news scan unavailable");
      return new Response(JSON.stringify({ status: "ok", message: "ALPHA_VANTAGE_KEY not configured" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { user_id } = await req.json();
    if (!user_id) return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });

    // Fetch equity symbols from watchlist
    const watchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/market_watchlist?user_id=eq.${user_id}&asset_class=eq.equity&is_active=eq.true&select=symbol`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    const watchlist: any[] = watchRes.ok ? await watchRes.json() : [];
    const symbols = watchlist.map((w: any) => w.symbol as string);

    if (symbols.length === 0) {
      return new Response(JSON.stringify({ status: "ok", alerts_fired: 0, message: "No equity symbols on watchlist." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let totalAlerts = 0;
    const today = new Date().toISOString().split("T")[0];

    for (const symbol of symbols) {
      // News sentiment scan
      const articles = await fetchNewsForSymbol(symbol, ALPHA_KEY);
      for (const article of articles) {
        const tickerSentiment = (article.ticker_sentiment ?? []).find((ts: any) => ts.ticker === symbol);
        const relevance = parseFloat(tickerSentiment?.relevance_score ?? "0");
        const sentiment = parseFloat(article.overall_sentiment_score ?? "0");
        if (relevance > 0.7 && Math.abs(sentiment) > 0.35) {
          const headline = (article.title ?? "").slice(0, 100);
          const url      = article.url ?? "";
          const summary  = article.summary ?? headline;

          await fetch(`${SUPABASE_URL}/rest/v1/atlas_tasks`, {
            method: "POST",
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify({
              user_id,
              task_type: "news_alert",
              payload: { symbol, headline, url, sentiment_score: sentiment },
              status: "queued",
            }),
          });

          await fetch(`${SUPABASE_URL}/rest/v1/research_notes`, {
            method: "POST",
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify({
              user_id,
              symbol,
              title: headline,
              content: summary,
              note_type: "research",
              synced_to_obsidian: false,
            }),
          });

          const direction = sentiment > 0 ? "📈 Positive" : "📉 Negative";
          await sendTelegramAlert(`*NEWS ALERT: ${symbol}*\n${headline}\nSentiment: ${direction} (${sentiment.toFixed(2)})\n${url}`);
          totalAlerts++;
        }
      }

      // EDGAR 24-hour filing check
      const filings = await fetchEDGARFilings(symbol);
      for (const filing of filings) {
        const edgarUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${filing.cik}&type=${filing.form}`;

        // Trigger a thesis for the symbol on significant filing
        const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
        fetch(`${supabaseUrl}/functions/v1/atlas_trade_thesis`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SERVICE_KEY}`,
            apikey: SERVICE_KEY,
          },
          body: JSON.stringify({ user_id, symbol, asset_class: "equity", context: `New ${filing.form} filing on ${filing.date}` }),
        }).catch(() => {});

        await sendTelegramAlert(`*SEC FILING: ${symbol}*\nForm: ${filing.form}\nDate: ${filing.date}\n${edgarUrl}`);
        totalAlerts++;
      }
    }

    return new Response(JSON.stringify({ status: "ok", symbols_scanned: symbols.length, alerts_fired: totalAlerts }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});
