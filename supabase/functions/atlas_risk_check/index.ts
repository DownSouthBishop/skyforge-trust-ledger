// Atlas Risk Check — pre-trade risk gate
// Returns go/no-go with specific rule violations and position sizing

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

const RISK_RULES = {
  max_risk_per_trade_pct: 0.02,
  max_positions_open: 10,
  max_correlated_exposure: 0.15,
  forex_max_leverage: 10,
  forex_pairs_approved: ["EUR/USD","GBP/USD","USD/JPY","AUD/USD","USD/CAD","NZD/USD","USD/CHF","EUR/GBP"],
  equity_max_single_position_pct: 0.10,
  auto_execute_max_usd: 500,
  requires_approval_above_usd: 500,
  daily_loss_limit_pct: 0.05,
  weekly_loss_limit_pct: 0.10,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    const { user_id, symbol, asset_class, direction, entry_price, quantity, broker, sector } = await req.json();
    if (!user_id || !symbol || !asset_class || !direction || !entry_price || !quantity) {
      return new Response(JSON.stringify({ error: "Missing required trade parameters" }), { status: 400, headers: corsHeaders });
    }

    const violations: string[] = [];
    const warnings: string[] = [];

    // Pull account data
    const [acctRes, openRes, closedTodayRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/trading_accounts?user_id=eq.${user_id}&is_active=eq.true&select=balance_usd`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      }),
      fetch(`${SUPABASE_URL}/rest/v1/trade_ledger?user_id=eq.${user_id}&status=eq.open&select=symbol,asset_class,pnl_usd,notes`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      }),
      fetch(`${SUPABASE_URL}/rest/v1/trade_ledger?user_id=eq.${user_id}&status=eq.closed&closed_at=gte.${new Date().toISOString().split("T")[0]}&select=pnl_usd`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      }),
    ]);

    const accounts = acctRes.ok ? await acctRes.json() : [];
    const openTrades = openRes.ok ? await openRes.json() : [];
    const closedToday = closedTodayRes.ok ? await closedTodayRes.json() : [];

    const totalCapital = accounts.reduce((s: number, a: any) => s + Number(a.balance_usd ?? 0), 0);
    const tradeValue = Number(entry_price) * Number(quantity);

    // 1. Open positions limit
    if (openTrades.length >= RISK_RULES.max_positions_open) {
      violations.push(`Position limit reached: ${openTrades.length}/${RISK_RULES.max_positions_open} open.`);
    }

    // 2. Daily loss limit
    const todayPnl = closedToday.reduce((s: number, t: any) => s + Number(t.pnl_usd ?? 0), 0);
    if (totalCapital > 0 && todayPnl < 0 && Math.abs(todayPnl) / totalCapital >= RISK_RULES.daily_loss_limit_pct) {
      violations.push(`Daily loss limit hit: ${(Math.abs(todayPnl) / totalCapital * 100).toFixed(1)}% of capital lost today. No new trades.`);
    }

    // Telegram alert when daily loss approaches 80% of daily limit
    if (totalCapital > 0 && Math.abs(todayPnl) / totalCapital >= RISK_RULES.daily_loss_limit_pct * 0.8) {
      await sendTelegramAlert(`*RISK ALERT*\nDaily loss ${(Math.abs(todayPnl)/totalCapital*100).toFixed(1)}% approaching ${RISK_RULES.daily_loss_limit_pct*100}% limit.`);
    }

    // 3. Risk per trade (2% rule)
    if (totalCapital > 0) {
      const riskPct = tradeValue / totalCapital;
      if (riskPct > RISK_RULES.max_risk_per_trade_pct) {
        violations.push(`Trade size ${(riskPct * 100).toFixed(1)}% of capital exceeds 2% rule. Reduce to $${(totalCapital * 0.02).toFixed(0)}.`);
      }
    }

    // 4. Forex pair approval
    if (asset_class === "forex" && !RISK_RULES.forex_pairs_approved.includes(symbol.toUpperCase())) {
      violations.push(`${symbol} not in approved forex pairs list.`);
    }

    // 5. Equity concentration
    if (asset_class === "equity" && totalCapital > 0) {
      const existingInSymbol = openTrades.filter((t: any) => t.symbol === symbol).length;
      if (existingInSymbol > 0) warnings.push(`Already have open ${symbol} position. Watch concentration.`);
    }

    // 6. Correlation exposure check
    let base = "";
    let quote = "";

    if (asset_class === "forex") {
      const parts = symbol.toUpperCase().split("/");
      base  = parts[0] ?? "";
      quote = parts[1] ?? "";
    }

    const correlatedTrades = openTrades.filter((t: any) => {
      if (asset_class === "forex") {
        if (t.asset_class !== "forex") return false;
        const tParts = (t.symbol as string).toUpperCase().split("/");
        const tBase  = tParts[0] ?? "";
        const tQuote = tParts[1] ?? "";
        return (base && tBase === base) || (quote && tQuote === quote);
      }
      if (asset_class === "crypto") {
        return t.asset_class === "crypto";
      }
      if (asset_class === "equity") {
        if (t.asset_class !== "equity") return false;
        if (!sector) return false;
        return typeof t.notes === "string" && t.notes.includes(sector as string);
      }
      return false;
    });

    const correlatedCount = correlatedTrades.length;
    const correlated_exposure_pct = correlatedCount / RISK_RULES.max_positions_open;

    if (correlated_exposure_pct > RISK_RULES.max_correlated_exposure) {
      const groupLabel = asset_class === "forex"
        ? `${base}/${quote} currency`
        : asset_class as string;
      violations.push(
        `Correlated exposure ${(correlated_exposure_pct * 100).toFixed(0)}% would exceed 15% limit. Adding ${symbol} over-concentrates ${groupLabel} risk.`
      );
    }

    const correlation_groups = {
      proposed: { symbol, asset_class, ...(asset_class === "forex" ? { base, quote } : {}), ...(asset_class === "equity" && sector ? { sector } : {}) },
      correlated_open_count: correlatedCount,
    };

    // Approval threshold
    const requiresApproval = tradeValue > RISK_RULES.requires_approval_above_usd;

    const go = violations.length === 0;

    // Calculate proper position size
    const suggestedRisk = totalCapital > 0 ? totalCapital * RISK_RULES.max_risk_per_trade_pct : 0;
    const suggestedQty = entry_price > 0 ? (suggestedRisk / Number(entry_price)).toFixed(4) : null;

    return new Response(JSON.stringify({
      go,
      requires_approval: requiresApproval,
      violations,
      warnings,
      trade_value_usd: tradeValue,
      suggested_max_risk_usd: suggestedRisk,
      suggested_quantity: suggestedQty,
      correlation_groups,
      correlated_exposure_pct,
      rules: {
        max_risk_pct: `${RISK_RULES.max_risk_per_trade_pct * 100}%`,
        max_positions: RISK_RULES.max_positions_open,
        daily_loss_limit_pct: `${RISK_RULES.daily_loss_limit_pct * 100}%`,
        auto_execute_limit: `$${RISK_RULES.auto_execute_max_usd}`,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});
