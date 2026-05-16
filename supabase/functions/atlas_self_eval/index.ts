// Atlas Self Eval — evaluates thesis accuracy and calibrates confidence over the last 30 days

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv } from "../_shared/gateway.ts";

const FAST_MODEL = () => modelEnv("FAST_MODEL", "google/gemini-2.5-flash");

interface ThesisNote {
  id: string;
  symbol: string;
  title: string;
  content: string;
  created_at: string;
}

interface ClosedTradeResult {
  pnl_usd: number;
  closed_at: string;
}

interface TradeForThesis {
  opened_at: string;
  pnl_usd: number;
}

const SETUP_KEYWORDS = [
  "earnings play",
  "breakout",
  "trend follow",
  "reversal",
  "momentum",
  "swing",
  "catalyst",
  "mean reversion",
];

function extractVerdict(content: string): "Long" | "Short" | "Wait" | null {
  const verdictMatch = content.match(/\*\*Verdict\*\*[:\s]+([A-Za-z]+)/i);
  if (!verdictMatch) return null;
  const v = verdictMatch[1].trim();
  if (/long/i.test(v)) return "Long";
  if (/short/i.test(v)) return "Short";
  if (/wait|neutral|hold/i.test(v)) return "Wait";
  return null;
}

function extractSetupType(content: string): string {
  const lower = content.toLowerCase();
  for (const kw of SETUP_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  return "general";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("LOVABLE_API_KEY");

    const { user_id } = await req.json();
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const baseHeaders = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    };

    const today = new Date().toISOString().split("T")[0];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    // 1. Fetch thesis notes from last 30 days
    const thesesResp = await fetch(
      `${SUPABASE_URL}/rest/v1/research_notes?user_id=eq.${user_id}&note_type=eq.thesis&created_at=gte.${thirtyDaysAgo}&select=id,symbol,title,content,created_at`,
      { headers: baseHeaders },
    );
    if (!thesesResp.ok) throw new Error(`Failed to fetch thesis notes: ${thesesResp.status}`);
    const theses: ThesisNote[] = await thesesResp.json();

    let correctCount = 0;
    let totalWithTrades = 0;
    const timesToTrade: number[] = [];
    const setupCounts: Record<string, { correct: number; total: number }> = {};

    // 2. For each thesis, check for closed trades on that symbol
    for (const thesis of theses) {
      const tradesResp = await fetch(
        `${SUPABASE_URL}/rest/v1/trade_ledger?user_id=eq.${user_id}&symbol=eq.${encodeURIComponent(thesis.symbol)}&status=eq.closed&select=pnl_usd,closed_at,opened_at`,
        { headers: baseHeaders },
      );
      if (!tradesResp.ok) continue;

      const trades: (ClosedTradeResult & { opened_at: string })[] = await tradesResp.json();
      if (trades.length === 0) continue;

      totalWithTrades++;

      // 3. Extract verdict and determine correctness
      const verdict = extractVerdict(thesis.content);
      const avgPnl = trades.reduce((sum, t) => sum + Number(t.pnl_usd), 0) / trades.length;

      let isCorrect = false;
      if (verdict === "Long" && avgPnl > 0) isCorrect = true;
      else if (verdict === "Short" && avgPnl < 0) isCorrect = true;
      else if (verdict === "Wait") isCorrect = true; // neutral always correct

      if (isCorrect) correctCount++;

      // 4. Avg time from thesis created_at to earliest trade opened_at
      const thesisDate = new Date(thesis.created_at).getTime();
      const earliestTrade = trades.reduce((earliest: TradeForThesis | null, t) => {
        if (!earliest) return t;
        return new Date(t.opened_at).getTime() < new Date(earliest.opened_at).getTime() ? t : earliest;
      }, null);

      if (earliestTrade) {
        const tradeDate = new Date(earliestTrade.opened_at).getTime();
        const daysToTrade = (tradeDate - thesisDate) / (1000 * 60 * 60 * 24);
        if (daysToTrade >= 0) timesToTrade.push(daysToTrade);
      }

      // 5. Group by setup type
      const setupType = extractSetupType(thesis.content);
      if (!setupCounts[setupType]) setupCounts[setupType] = { correct: 0, total: 0 };
      setupCounts[setupType].total++;
      if (isCorrect) setupCounts[setupType].correct++;
    }

    // Compute aggregate metrics
    const accuracyRate = totalWithTrades > 0 ? correctCount / totalWithTrades : null;
    const avgDaysToTrade = timesToTrade.length > 0
      ? timesToTrade.reduce((a, b) => a + b, 0) / timesToTrade.length
      : null;

    const accuracyPct = accuracyRate !== null ? (accuracyRate * 100).toFixed(1) : "N/A";
    const avgDaysStr = avgDaysToTrade !== null ? avgDaysToTrade.toFixed(1) : "N/A";

    const breakdownLines = Object.entries(setupCounts).map(([setup, counts]) => {
      const pct = counts.total > 0 ? ((counts.correct / counts.total) * 100).toFixed(0) : "0";
      return `${setup}: ${counts.correct}/${counts.total} (${pct}% correct)`;
    });
    const breakdownStr = breakdownLines.length > 0 ? breakdownLines.join(", ") : "no data";

    // 6. Build AI prompt
    const prompt = `Atlas self-evaluation report:
Thesis accuracy (last 30 days): ${accuracyPct}% (${correctCount}/${totalWithTrades} theses with matching closed trades)
Avg time from thesis to trade: ${avgDaysStr} days
Setup type breakdown: ${breakdownStr}
Based on this track record, how should Atlas calibrate his confidence when presenting trade theses? What types of setups should be stated with more or less conviction? 100 words max.`;

    const aiRespRaw = await callGatewayWithRetry(
      {
        model: FAST_MODEL(),
        messages: [{ role: "user", content: prompt }],
        max_tokens: 250,
      },
      API_KEY,
    );

    if (!aiRespRaw.ok) throw new Error(`AI call failed: ${aiRespRaw.status}`);

    const aiData = await aiRespRaw.json();
    const recommendation: string = aiData.choices?.[0]?.message?.content?.trim() ?? "Self-evaluation unavailable.";

    // 7. Save result to research_notes
    const saveResp = await fetch(`${SUPABASE_URL}/rest/v1/research_notes`, {
      method: "POST",
      headers: {
        ...baseHeaders,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        user_id,
        note_type: "weekly_review",
        symbol: "SELF_EVAL",
        title: `Self Evaluation — ${today}`,
        content: recommendation,
        synced_to_obsidian: false,
      }),
    });

    if (!saveResp.ok) {
      const errText = await saveResp.text();
      console.error(`[atlas_self_eval] Failed to save research note: ${errText}`);
    }

    return new Response(
      JSON.stringify({
        theses_evaluated: theses.length,
        accuracy_rate: accuracyRate,
        recommendation_saved: true,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
