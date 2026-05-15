// Atlas Portfolio Sync — pulls live account data from brokers
// Updates trading_accounts balances and open positions in trade_ledger
// Phase 2: wire OANDA REST, Alpaca REST, IBKR bridge service

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    const { user_id } = await req.json();
    if (!user_id) return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });

    const acctRes = await fetch(
      `${SUPABASE_URL}/rest/v1/trading_accounts?user_id=eq.${user_id}&is_active=eq.true`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    const accounts = acctRes.ok ? await acctRes.json() : [];

    const results: any[] = [];

    for (const account of accounts) {
      try {
        let syncedData: any = null;

        if (account.broker === "oanda") {
          // Phase 2: OANDA v20 REST API
          // const OANDA_API_KEY = parseEnv("OANDA_API_KEY");
          // const res = await fetch(`https://api-fxpractice.oanda.com/v3/accounts/${account.account_id}/summary`, {
          //   headers: { Authorization: `Bearer ${OANDA_API_KEY}` },
          // });
          // const data = await res.json();
          // syncedData = { balance_usd: data.account.balance, buying_power_usd: data.account.marginAvailable };
          results.push({ broker: "oanda", status: "phase_2_pending", account_id: account.account_id });
          continue;
        }

        if (account.broker === "alpaca") {
          // Phase 2: Alpaca REST API
          // const ALPACA_KEY = parseEnv("ALPACA_API_KEY");
          // const ALPACA_SECRET = parseEnv("ALPACA_SECRET_KEY");
          // const res = await fetch("https://paper-api.alpaca.markets/v2/account", {
          //   headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET },
          // });
          // const data = await res.json();
          // syncedData = { balance_usd: parseFloat(data.portfolio_value), buying_power_usd: parseFloat(data.buying_power) };
          results.push({ broker: "alpaca", status: "phase_2_pending", account_id: account.account_id });
          continue;
        }

        if (account.broker === "ibkr") {
          // Phase 2: IBKR Client Portal / TWS bridge
          // Requires local TWS running with API enabled, connect via ibkr-bridge service
          results.push({ broker: "ibkr", status: "phase_2_pending", account_id: account.account_id });
          continue;
        }

        if (syncedData) {
          await fetch(`${SUPABASE_URL}/rest/v1/trading_accounts?id=eq.${account.id}`, {
            method: "PATCH",
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify({ ...syncedData, last_sync_at: new Date().toISOString() }),
          });
          results.push({ broker: account.broker, status: "synced", account_id: account.account_id, data: syncedData });
        }
      } catch (err: any) {
        results.push({ broker: account.broker, status: "error", error: err.message });
      }
    }

    return new Response(JSON.stringify({
      synced_at: new Date().toISOString(),
      accounts_checked: accounts.length,
      results,
      note: "Live sync requires Phase 2 broker MCP servers. Register accounts in Profile to track manually.",
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});
