// watchlist_monitor — checks Alpaca quotes against market_watchlist thresholds.
// Fires proactive_alerts when price crosses alert_price_high or alert_price_low.
// Uses Alpaca data API (free tier). Deduplicates: max one alert per symbol per 4h.
// Runs every 30 minutes via pg_cron.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALPACA_DATA_URL = "https://data.alpaca.markets";

async function fetchEquityQuotes(
  symbols: string[],
  key: string,
  secret: string,
): Promise<Record<string, number>> {
  if (!symbols.length) return {};
  try {
    const url = `${ALPACA_DATA_URL}/v2/stocks/quotes/latest?symbols=${encodeURIComponent(symbols.join(","))}&feed=iex`;
    const resp = await fetch(url, {
      headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret },
    });
    if (!resp.ok) return {};
    const data = await resp.json() as { quotes?: Record<string, { ap?: number; bp?: number }> };
    const prices: Record<string, number> = {};
    for (const [sym, q] of Object.entries(data.quotes ?? {})) {
      const ap = q.ap ?? 0;
      const bp = q.bp ?? 0;
      if (ap > 0 && bp > 0) prices[sym] = (ap + bp) / 2;
      else if (ap > 0) prices[sym] = ap;
      else if (bp > 0) prices[sym] = bp;
    }
    return prices;
  } catch { return {}; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ALPACA_KEY = Deno.env.get("ALPACA_API_KEY") ?? "";
    const ALPACA_SECRET = Deno.env.get("ALPACA_SECRET_KEY") ?? "";
    const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
    const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

    if (!ALPACA_KEY || !ALPACA_SECRET) {
      return new Response(JSON.stringify({ ok: false, error: "Alpaca credentials missing" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const h = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    };

    // Resolve operator
    const agentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/skyforge_agents?select=user_id&is_active=eq.true&limit=1`,
      { headers: h },
    );
    const agentRows = agentRes.ok ? (await agentRes.json() as any[]) : [];
    if (!agentRows.length) {
      return new Response(JSON.stringify({ ok: false, error: "No agents found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const uid = agentRows[0].user_id as string;

    // Fetch active watchlist items that have at least one threshold set
    const watchlistRes = await fetch(
      `${SUPABASE_URL}/rest/v1/market_watchlist?user_id=eq.${uid}&is_active=eq.true&select=id,symbol,asset_class,display_name,alert_price_high,alert_price_low,last_alerted_at`,
      { headers: h },
    );
    const watchlist = watchlistRes.ok ? (await watchlistRes.json() as any[]) : [];

    // Filter: only items with at least one threshold, equity only for now
    const eligibleItems = watchlist.filter((w: any) =>
      (w.alert_price_high != null || w.alert_price_low != null) &&
      (w.asset_class === "equity" || w.asset_class === "stock")
    );

    if (!eligibleItems.length) {
      return new Response(
        JSON.stringify({ ok: true, checked: 0, alerts_fired: 0, message: "No watchlist items with thresholds" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Dedup cutoff: don't alert same symbol within 4 hours
    const cutoff4h = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Filter out items alerted within 4h (last_alerted_at check)
    const itemsToCheck = eligibleItems.filter((w: any) =>
      !w.last_alerted_at || w.last_alerted_at < cutoff4h
    );

    if (!itemsToCheck.length) {
      return new Response(
        JSON.stringify({ ok: true, checked: 0, alerts_fired: 0, message: "All items within 4h cooldown" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Fetch Alpaca quotes in one batch
    const symbols = itemsToCheck.map((w: any) => String(w.symbol).toUpperCase());
    const prices = await fetchEquityQuotes(symbols, ALPACA_KEY, ALPACA_SECRET);

    let alertsFired = 0;

    for (const item of itemsToCheck) {
      const sym = String(item.symbol).toUpperCase();
      const price = prices[sym];
      if (price == null) continue;

      const displayName = item.display_name ?? sym;
      const high = item.alert_price_high != null ? parseFloat(item.alert_price_high) : null;
      const low = item.alert_price_low != null ? parseFloat(item.alert_price_low) : null;

      let breachType: "high" | "low" | null = null;
      if (high != null && price >= high) breachType = "high";
      else if (low != null && price <= low) breachType = "low";

      if (!breachType) continue;

      const alertTitle = breachType === "high"
        ? `${displayName} crossed above $${high?.toFixed(2)} — now $${price.toFixed(2)}`
        : `${displayName} dropped below $${low?.toFixed(2)} — now $${price.toFixed(2)}`;

      const alertContent = breachType === "high"
        ? `${sym} is trading at $${price.toFixed(2)}, crossing the high alert threshold of $${high?.toFixed(2)}. Consider whether this is a breakout to act on or a short opportunity.`
        : `${sym} is trading at $${price.toFixed(2)}, falling below the low alert threshold of $${low?.toFixed(2)}. Consider whether this is a buy-the-dip opportunity or a breakdown to avoid.`;

      const dedup_key = `watchlist_${breachType}:${sym.toLowerCase()}`;

      // Check dedup against proactive_alerts (24h window)
      const dedupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/proactive_alerts?user_id=eq.${uid}&dedup_key=eq.${encodeURIComponent(dedup_key)}&created_at=gte.${cutoff24h}&select=id&limit=1`,
        { headers: h },
      );
      if (dedupRes.ok) {
        const existing = await dedupRes.json() as any[];
        if (existing.length > 0) continue;
      }

      // Write alert
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/proactive_alerts`, {
        method: "POST",
        headers: { ...h, Prefer: "return=minimal" },
        body: JSON.stringify({
          user_id: uid,
          agent_slug: "atlas",
          alert_type: "opportunity",
          title: alertTitle.slice(0, 200),
          content: alertContent,
          priority: "high",
          dedup_key,
        }),
      });

      if (!insertRes.ok) continue;

      // Update last_alerted_at on watchlist item
      await fetch(
        `${SUPABASE_URL}/rest/v1/market_watchlist?id=eq.${item.id}`,
        {
          method: "PATCH",
          headers: { ...h, Prefer: "return=minimal" },
          body: JSON.stringify({ last_alerted_at: new Date().toISOString() }),
        },
      );

      // Telegram push for high-priority watchlist breach
      if (BOT_TOKEN && CHAT_ID) {
        const emoji = breachType === "high" ? "📈" : "📉";
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            text: `${emoji} *Watchlist Alert — ${sym}*\n\n${alertTitle}\n\n${alertContent}`,
            parse_mode: "Markdown",
          }),
        }).catch(() => {});
      }

      // Write to cross_memory
      await fetch(`${SUPABASE_URL}/rest/v1/agent_cross_memory`, {
        method: "POST",
        headers: { ...h, Prefer: "return=minimal" },
        body: JSON.stringify({
          user_id: uid,
          source_agent: "atlas",
          summary: `Watchlist alert: ${alertTitle}`,
          topic: "market_alert",
        }),
      }).catch(() => {});

      alertsFired++;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        checked: itemsToCheck.length,
        prices_fetched: Object.keys(prices).length,
        alerts_fired: alertsFired,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (e) {
    console.error("[watchlist_monitor]", e);
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
