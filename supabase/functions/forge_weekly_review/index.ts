// Sunday auto-brief — Atlas writes a full week review waiting Monday morning.
// Trading-focused: realized P&L, win rate, capital, commitments.

import {
  corsHeaders,
  callGatewayWithRetry,
  parseEnv,
  modelEnv,
} from "../_shared/gateway.ts";

const ATLAS_MODEL = () => modelEnv("ATLAS_MODEL", "openai/gpt-4o");

interface TradeDetailRow {
  pnl_usd: string | number;
  symbol: string;
  direction: string;
  thesis: string | null;
}

interface ExtraData {
  sharpe: number | null;
  bestTrade: TradeDetailRow | null;
  worstTrade: TradeDetailRow | null;
  winRateDelta: number | null;
  avgRR: { this: number | null; prior: number | null };
  defiSummary: string | null;
}

function buildWeeklyReviewPrompt(ctx: any, weeklyData: any, extraData?: ExtraData): string {
  const name = ctx.full_name ?? "Operator";
  const tradePnlWeek     = Number(weeklyData.trade_pnl_week ?? 0);
  const tradePnlLastWeek = Number(weeklyData.trade_pnl_last_week ?? 0);
  const tradesThisWeek   = Number(weeklyData.trades_this_week ?? 0);
  const winsThisWeek     = Number(weeklyData.wins_this_week ?? 0);
  const winRate          = tradesThisWeek > 0 ? Math.round((winsThisWeek / tradesThisWeek) * 100) : null;
  const trend            = tradePnlWeek > tradePnlLastWeek ? "up" : tradePnlWeek < tradePnlLastWeek ? "down" : "flat";
  const trendDelta       = Math.abs(tradePnlWeek - tradePnlLastWeek);
  const totalCapital     = Number(weeklyData.total_capital ?? 0);
  const accountCount     = Number(weeklyData.account_count ?? 0);

  const dossier          = ctx.dossier ?? {};
  const goals            = Array.isArray(ctx.active_goals) ? ctx.active_goals : [];
  const openCommitments  = Array.isArray(ctx.open_commitments) ? ctx.open_commitments : [];
  const pipeline         = Array.isArray(ctx.pipeline) ? ctx.pipeline : [];
  const streak           = Number(ctx.current_streak ?? 0);

  const keptThisWeek     = Number(weeklyData.commitments_kept ?? 0);
  const missedThisWeek   = Number(weeklyData.commitments_missed ?? 0);
  const followThrough    = (keptThisWeek + missedThisWeek) > 0
    ? Math.round((keptThisWeek / (keptThisWeek + missedThisWeek)) * 100)
    : null;

  const goalLines = goals.map((g: any) => {
    const pct = g.target_amount > 0 ? Math.round((g.current_amount / g.target_amount) * 100) : 0;
    return `  ${g.label}: ${pct}% ($${Number(g.current_amount).toLocaleString()} of $${Number(g.target_amount).toLocaleString()})`;
  }).join("\n");

  const openCommitLines = openCommitments.slice(0, 5).map((c: any) => {
    const age = Math.floor((Date.now() - new Date(c.made_at).getTime()) / 86400000);
    return `  "${c.description}" — ${age}d open`;
  }).join("\n");

  const topPipeline = [...pipeline].sort((a: any, b: any) =>
    (b.estimated_value ?? 0) - (a.estimated_value ?? 0)
  )[0];

  const pnlSign = (n: number) => `${n >= 0 ? "+" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  const advancedMetrics = `ADVANCED METRICS:
Sharpe ratio (weekly): ${extraData?.sharpe != null ? extraData.sharpe.toFixed(2) : "N/A"}
Best trade: ${extraData?.bestTrade ? `${extraData.bestTrade.symbol} ${extraData.bestTrade.direction} +$${extraData.bestTrade.pnl_usd}` : "N/A"}
Worst trade: ${extraData?.worstTrade ? `${extraData.worstTrade.symbol} ${extraData.worstTrade.direction} $${extraData.worstTrade.pnl_usd}` : "N/A"}
Win rate delta WoW: ${extraData?.winRateDelta != null ? (extraData.winRateDelta >= 0 ? "+" : "") + extraData.winRateDelta.toFixed(0) + "%" : "N/A"}
Avg R/R this week: ${extraData?.avgRR?.this != null ? extraData.avgRR.this.toFixed(2) : "N/A"} | Prior: ${extraData?.avgRR?.prior != null ? extraData.avgRR.prior.toFixed(2) : "N/A"}
${extraData?.defiSummary ? `\nDEFI YIELD SUMMARY:\n${extraData.defiSummary.slice(0, 400)}` : ""}`;

  return `You are Atlas. It's Sunday evening. Write ${name}'s weekly review brief — honest, specific, short. This is what they'll read Monday morning to orient themselves.

THE WEEK IN TRADING:
Realized P&L this week: ${pnlSign(tradePnlWeek)} (${tradesThisWeek} trade${tradesThisWeek !== 1 ? "s" : ""}) | Last week: ${pnlSign(tradePnlLastWeek)} — ${trend}${trendDelta > 0 ? ` $${trendDelta.toLocaleString()}` : ""}
Win rate: ${winRate !== null ? winRate + "% (" + winsThisWeek + "/" + tradesThisWeek + " wins)" : "No closed trades this week"}
Capital: ${accountCount > 0 ? `$${totalCapital.toLocaleString()} across ${accountCount} account${accountCount !== 1 ? "s" : ""}` : "No broker accounts connected yet"}
Streak: ${streak}d

${goalLines ? "Goals:\n" + goalLines : ""}

Follow-through this week: ${followThrough !== null ? followThrough + "%" : "No commitments resolved"}
${missedThisWeek > 0 ? `Missed: ${missedThisWeek} commitment(s)` : ""}
${openCommitLines ? "Still open:\n" + openCommitLines : "No open commitments."}

${topPipeline ? `Top pipeline: "${topPipeline.description}" — $${Number(topPipeline.estimated_value ?? 0).toLocaleString()} [${topPipeline.stage}]` : ""}

${dossier.avoidance_pattern ? "Avoidance pattern: " + dossier.avoidance_pattern : ""}
${dossier.current_focus ? "Current focus: " + dossier.current_focus : ""}
${dossier.trading_goals ? "Trading goals: " + dossier.trading_goals : ""}

${advancedMetrics}

Write a weekly brief with these sections (no headers, just short paragraphs):
1. What the week said — interpret the trading performance honestly. Not cheerleading, not doom. What actually happened?
2. What needs attention Monday — one or two specific things. Name them.
3. One strategic observation — something you notice about the arc, not just this week.

Keep it under 150 words total. Atlas voice: direct, grounded, no filler. Write to someone who can handle the truth.

Return raw JSON only: {"review": "..."}`;
}

/** Compute daily PnL sums grouped by date from closed_at, then annualized Sharpe. */
function computeSharpe(rows: Array<{ pnl_usd: string | number; closed_at?: string }>): number | null {
  const byDay: Record<string, number> = {};
  for (const r of rows) {
    const day = r.closed_at ? (r.closed_at as string).slice(0, 10) : "unknown";
    byDay[day] = (byDay[day] ?? 0) + Number(r.pnl_usd ?? 0);
  }
  const dailySums = Object.values(byDay);
  if (dailySums.length < 2) return null;
  const count = dailySums.length;
  const mean = dailySums.reduce((s, v) => s + v, 0) / count;
  const variance = dailySums.reduce((s, v) => s + (v - mean) ** 2, 0) / count;
  const stddev = Math.sqrt(variance);
  return stddev > 0 ? (mean / stddev) * Math.sqrt(52) : null;
}

/** Compute average R/R: avg(winning pnl) / abs(avg(losing pnl)). */
function computeAvgRR(rows: Array<{ pnl_usd: string | number }>): number | null {
  const wins  = rows.filter(r => Number(r.pnl_usd ?? 0) > 0).map(r => Number(r.pnl_usd));
  const loses = rows.filter(r => Number(r.pnl_usd ?? 0) < 0).map(r => Number(r.pnl_usd));
  if (wins.length === 0 || loses.length === 0) return null;
  const avgWin  = wins.reduce((s, v) => s + v, 0) / wins.length;
  const avgLoss = Math.abs(loses.reduce((s, v) => s + v, 0) / loses.length);
  return avgLoss > 0 ? avgWin / avgLoss : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = parseEnv("SUPABASE_URL");
  const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
  const API_KEY      = parseEnv("LOVABLE_API_KEY");

  const profilesResp = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?select=user_id`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  const profiles: { user_id: string }[] = await profilesResp.json();

  let generated = 0;

  for (const p of profiles) {
    try {
      const ctxResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_forge_context`, {
        method: "POST",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ _user_id: p.user_id }),
      });
      const ctx = await ctxResp.json();

      const weekStart      = new Date();
      weekStart.setDate(weekStart.getDate() - 7);
      const weekStartStr   = weekStart.toISOString();
      const twoWeeksAgoStr = new Date(weekStart.getTime() - 7 * 86400000).toISOString();

      const [tradeWeekResp, tradePrevResp, commitsResp, accountsResp] = await Promise.all([
        fetch(
          `${SUPABASE_URL}/rest/v1/trade_ledger?user_id=eq.${p.user_id}&status=eq.closed&closed_at=gte.${weekStartStr}&select=pnl_usd,closed_at`,
          { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
        ),
        fetch(
          `${SUPABASE_URL}/rest/v1/trade_ledger?user_id=eq.${p.user_id}&status=eq.closed&closed_at=gte.${twoWeeksAgoStr}&closed_at=lt.${weekStartStr}&select=pnl_usd`,
          { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
        ),
        fetch(
          `${SUPABASE_URL}/rest/v1/forge_commitments?user_id=eq.${p.user_id}&resolved_at=gte.${weekStartStr}&select=resolution_status`,
          { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
        ),
        fetch(
          `${SUPABASE_URL}/rest/v1/trading_accounts?user_id=eq.${p.user_id}&is_active=eq.true&select=balance_usd`,
          { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
        ),
      ]);

      const tradeWeekRows: Array<{ pnl_usd: string | number; closed_at: string }> = await tradeWeekResp.json();
      const tradePrevRows: Array<{ pnl_usd: string | number }>                    = await tradePrevResp.json();
      const commitsRows: Array<{ resolution_status: string }>                     = await commitsResp.json();
      const accountRows: Array<{ balance_usd: string | number }>                  = await accountsResp.json();

      const weeklyData = {
        trade_pnl_week:      tradeWeekRows.reduce((s: number, r) => s + Number(r.pnl_usd ?? 0), 0),
        trade_pnl_last_week: tradePrevRows.reduce((s: number, r) => s + Number(r.pnl_usd ?? 0), 0),
        trades_this_week:    tradeWeekRows.length,
        wins_this_week:      tradeWeekRows.filter(r => Number(r.pnl_usd ?? 0) > 0).length,
        total_capital:       accountRows.reduce((s: number, a) => s + Number(a.balance_usd ?? 0), 0),
        account_count:       accountRows.length,
        commitments_kept:    commitsRows.filter(c => c.resolution_status === "kept").length,
        commitments_missed:  commitsRows.filter(c => c.resolution_status === "missed").length,
      };

      // Fetch trade detail for best/worst
      const tradeWeekDetailResp = await fetch(
        `${SUPABASE_URL}/rest/v1/trade_ledger?user_id=eq.${p.user_id}&status=eq.closed&closed_at=gte.${weekStartStr}&select=pnl_usd,symbol,direction,thesis`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
      );
      const tradeWeekDetailRows: TradeDetailRow[] = tradeWeekDetailResp.ok ? await tradeWeekDetailResp.json() : [];

      // Fetch latest DeFi research note
      const defiResp = await fetch(
        `${SUPABASE_URL}/rest/v1/research_notes?note_type=eq.research&symbol=eq.DEFI_YIELD&order=created_at.desc&limit=1&select=content`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
      );
      const defiRows: Array<{ content: string }> = defiResp.ok ? await defiResp.json() : [];
      const defiSummary: string | null = defiRows[0]?.content ? (defiRows[0].content as string) : null;

      // Sharpe ratio
      const sharpe = computeSharpe(tradeWeekRows);

      // Best and worst trade
      let bestTrade: TradeDetailRow | null = null;
      let worstTrade: TradeDetailRow | null = null;
      if (tradeWeekDetailRows.length > 0) {
        bestTrade  = tradeWeekDetailRows.reduce((best, t) =>
          Number(t.pnl_usd) > Number(best.pnl_usd) ? t : best, tradeWeekDetailRows[0]);
        worstTrade = tradeWeekDetailRows.reduce((worst, t) =>
          Number(t.pnl_usd) < Number(worst.pnl_usd) ? t : worst, tradeWeekDetailRows[0]);
      }

      // Win rate delta WoW
      const thisWinRate = weeklyData.trades_this_week > 0
        ? (weeklyData.wins_this_week / weeklyData.trades_this_week) * 100
        : null;
      const priorWinRate = tradePrevRows.length > 0
        ? (tradePrevRows.filter(r => Number(r.pnl_usd ?? 0) > 0).length / tradePrevRows.length) * 100
        : null;
      const winRateDelta: number | null =
        thisWinRate !== null && priorWinRate !== null ? thisWinRate - priorWinRate : null;

      // Avg R/R this week and prior
      const avgRRThis  = computeAvgRR(tradeWeekDetailRows);
      const avgRRPrior = computeAvgRR(tradePrevRows);

      const extraData: ExtraData = {
        sharpe,
        bestTrade,
        worstTrade,
        winRateDelta,
        avgRR: { this: avgRRThis, prior: avgRRPrior },
        defiSummary,
      };

      const resp = await callGatewayWithRetry(
        {
          model: ATLAS_MODEL(),
          messages: [{ role: "user", content: buildWeeklyReviewPrompt(ctx, weeklyData, extraData) }],
          max_completion_tokens: 400,
        },
        API_KEY,
      );

      if (!resp.ok) { console.error("weekly review AI error", resp.status); continue; }

      const data = await resp.json();
      const raw  = data.choices?.[0]?.message?.content?.trim() ?? "";
      let review: string | null = null;
      try {
        review = JSON.parse(raw.replace(/```json\s*|\s*```/g, "").trim()).review ?? null;
      } catch { review = null; }

      if (!review) continue;

      const now = new Date().toISOString();

      // Patch user_profiles (existing behaviour)
      await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?user_id=eq.${p.user_id}`,
        {
          method: "PATCH",
          headers: {
            apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json", Prefer: "return=minimal",
          },
          body: JSON.stringify({ atlas_weekly_review: review, atlas_weekly_review_at: now }),
        },
      );

      // Also save to research_notes
      await fetch(
        `${SUPABASE_URL}/rest/v1/research_notes`,
        {
          method: "POST",
          headers: {
            apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json", Prefer: "return=minimal",
          },
          body: JSON.stringify({
            user_id: p.user_id,
            note_type: "weekly_review",
            symbol: null,
            content: review,
            created_at: now,
          }),
        },
      );

      generated++;
    } catch (e) {
      console.error("weekly review user error", p.user_id, e);
    }
  }

  return new Response(JSON.stringify({ generated, total: profiles.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
