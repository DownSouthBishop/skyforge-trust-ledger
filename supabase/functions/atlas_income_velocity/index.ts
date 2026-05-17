// Atlas Income Velocity — cross-vertical real-time income aggregation
// Returns today's income across all verticals vs the $100/day target.
// Called by forge_chat, HudPage, and atlas_noon_check.

import { corsHeaders, parseEnv, resolveUserIds } from "../_shared/gateway.ts";

const DAILY_TARGET_DEFAULT = 100;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    const { user_id: rawUserId } = await req.json();
    if (!rawUserId) {
      return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });
    }

    const userIds = await resolveUserIds(SUPABASE_URL, SERVICE_KEY, rawUserId);
    if (userIds.length === 0) {
      return new Response(JSON.stringify({ message: "No users found" }), { headers: corsHeaders });
    }
    const user_id = userIds[0];

    const baseHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const todayDate  = now.toISOString().split("T")[0];

    // Read custom daily target from preferences
    let dailyTarget = DAILY_TARGET_DEFAULT;
    try {
      const prefRes = await fetch(
        `${SUPABASE_URL}/rest/v1/atlas_user_preferences?user_id=eq.${user_id}&category=eq.trading_style&key=eq.daily_income_target_usd&select=value&limit=1`,
        { headers: baseHeaders },
      );
      if (prefRes.ok) {
        const rows: Array<{ value: string }> = await prefRes.json();
        if (rows.length > 0) dailyTarget = parseFloat(rows[0].value) || DAILY_TARGET_DEFAULT;
      }
    } catch { /* use default */ }

    // Fetch all income sources in parallel
    const [
      closedTradesRes,   // trading P&L realised today
      businessLedgerRes, // business revenue paid today
      reLedgerRes,       // RE rent received today
      legacyReceiptsRes, // old receipts_ledger income
      openTradesRes,     // unrealised trading P&L (context only)
    ] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/trade_ledger?user_id=eq.${user_id}&status=eq.closed&closed_at=gte.${todayStart}&select=pnl_usd`,
        { headers: baseHeaders },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/business_ledger?user_id=eq.${user_id}&entry_type=eq.revenue&status=eq.paid&created_at=gte.${todayStart}&select=amount_usd,category`,
        { headers: baseHeaders },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/property_ledger?user_id=eq.${user_id}&entry_type=eq.rent&status=eq.paid&paid_date=eq.${todayDate}&select=amount_usd`,
        { headers: baseHeaders },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/receipts_ledger?provider_id=eq.${user_id}&created_at=gte.${todayStart}&select=action_value_usd`,
        { headers: baseHeaders },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/trade_ledger?user_id=eq.${user_id}&status=eq.open&select=pnl_usd`,
        { headers: baseHeaders },
      ),
    ]);

    const closedTrades: Array<{ pnl_usd: number | null }>       = closedTradesRes.ok   ? await closedTradesRes.json()   : [];
    const businessItems: Array<{ amount_usd: number; category: string }> = businessLedgerRes.ok ? await businessLedgerRes.json() : [];
    const reItems: Array<{ amount_usd: number }>                = reLedgerRes.ok       ? await reLedgerRes.json()       : [];
    const legacyItems: Array<{ action_value_usd: number }>      = legacyReceiptsRes.ok ? await legacyReceiptsRes.json() : [];
    const openTrades: Array<{ pnl_usd: number | null }>         = openTradesRes.ok     ? await openTradesRes.json()     : [];

    // Sum each vertical
    const tradingRealisedPnl  = closedTrades.reduce((s, t) => s + Number(t.pnl_usd ?? 0), 0);
    const tradingUnrealisedPnl = openTrades.reduce((s, t) => s + Number(t.pnl_usd ?? 0), 0);
    const businessRevenue      = businessItems.reduce((s, e) => s + Number(e.amount_usd), 0);
    const reRent               = reItems.reduce((s, e) => s + Number(e.amount_usd), 0);
    const legacyIncome         = legacyItems.reduce((s, r) => s + Number(r.action_value_usd), 0);

    // Realised total (what actually hit the account today)
    const realisedTotal = tradingRealisedPnl + businessRevenue + reRent + legacyIncome;
    const gap           = dailyTarget - realisedTotal;
    const pctToTarget   = dailyTarget > 0 ? Math.min(100, (realisedTotal / dailyTarget) * 100) : 100;

    // Time-weighted urgency: how many trading hours left today?
    const hourUTC = now.getUTCHours();
    const marketClose = 21; // approx 21:00 UTC (NY close)
    const tradingHoursLeft = Math.max(0, marketClose - hourUTC);
    const rateNeeded = tradingHoursLeft > 0 ? gap / tradingHoursLeft : gap;

    let velocityStatus: "ahead" | "on_track" | "behind" | "critical";
    if (realisedTotal >= dailyTarget) velocityStatus = "ahead";
    else if (pctToTarget >= 70) velocityStatus = "on_track";
    else if (pctToTarget >= 30) velocityStatus = "behind";
    else velocityStatus = "critical";

    return new Response(JSON.stringify({
      date: todayDate,
      daily_target: dailyTarget,
      realised_total: parseFloat(realisedTotal.toFixed(2)),
      gap: parseFloat(gap.toFixed(2)),
      pct_to_target: parseFloat(pctToTarget.toFixed(1)),
      velocity_status: velocityStatus,
      trading_hours_left: tradingHoursLeft,
      rate_needed_per_hour: parseFloat(rateNeeded.toFixed(2)),
      breakdown: {
        trading_realised_pnl: parseFloat(tradingRealisedPnl.toFixed(2)),
        trading_unrealised_pnl: parseFloat(tradingUnrealisedPnl.toFixed(2)),
        business_revenue: parseFloat(businessRevenue.toFixed(2)),
        re_rent: parseFloat(reRent.toFixed(2)),
        legacy_income: parseFloat(legacyIncome.toFixed(2)),
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
