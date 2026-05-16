// Atlas Options Scan — scans equity holdings for covered call and cash-secured put opportunities
// Phase 1C: runs Monday and Wednesday at 14:00 UTC

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

const ATLAS_MODEL = () => modelEnv("ATLAS_MODEL", "openai/gpt-4o");

interface OptionsOpportunity {
  symbol: string;
  strategy: string;
  strike: number;
  expiry: string;
  premium_estimate: number;
  rationale: string;
  risk_note: string;
}

interface OpenTrade {
  id: string;
  symbol: string;
  asset_class: string;
  quantity: number;
  entry_price: number;
  direction: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL  = parseEnv("SUPABASE_URL");
    const SERVICE_KEY   = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY       = parseEnv("LOVABLE_API_KEY");
    const POLYGON_KEY   = Deno.env.get("POLYGON_API_KEY");

    const { user_id } = await req.json();
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });
    }

    if (!POLYGON_KEY) {
      return new Response(JSON.stringify({ error: "POLYGON_API_KEY not configured — options scan unavailable" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const baseHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    // Pull open equity positions
    const posRes = await fetch(
      `${SUPABASE_URL}/rest/v1/trade_ledger?user_id=eq.${user_id}&asset_class=eq.equity&status=eq.open&select=id,symbol,quantity,entry_price,direction`,
      { headers: baseHeaders },
    );
    if (!posRes.ok) throw new Error(`Failed to fetch positions: ${posRes.status}`);
    const positions: OpenTrade[] = posRes.ok ? await posRes.json() : [];

    if (positions.length === 0) {
      return new Response(JSON.stringify({ message: "No open equity positions to scan for options.", opportunities: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];
    const thirtyDaysOut = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    // Fetch options chain for each equity position — only long positions support covered calls
    const chainData: string[] = [];
    for (const pos of positions) {
      if (pos.direction !== "long") {
        chainData.push(`${pos.symbol}: skipped — covered calls require long position (held ${pos.direction})`);
        continue;
      }
      try {
        // Covered call scan: sell calls against long stock position
        const res = await fetch(
          `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${encodeURIComponent(pos.symbol)}&contract_type=call&expiration_date.gte=${todayStr}&expiration_date.lte=${thirtyDaysOut}&limit=10&sort=expiration_date&apiKey=${POLYGON_KEY}`,
        );
        if (!res.ok) {
          chainData.push(`${pos.symbol}: options data unavailable (${res.status})`);
          continue;
        }
        const data = await res.json();
        const contracts: Array<{ ticker: string; strike_price: number; expiration_date: string; contract_type: string }> =
          data?.results ?? [];

        if (contracts.length === 0) {
          chainData.push(`${pos.symbol}: no options contracts found in 30-day window`);
          continue;
        }

        const contractSummary = contracts
          .slice(0, 5)
          .map((c) => `  ${c.ticker}: strike=${c.strike_price} exp=${c.expiration_date}`)
          .join("\n");

        chainData.push(
          `${pos.symbol} (held ${pos.quantity} shares @ $${pos.entry_price}, ${pos.direction}):\n${contractSummary}`,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        chainData.push(`${pos.symbol}: error fetching options — ${msg}`);
      }
    }

    const prompt = `You are Atlas. Analyze this options chain for yield-generating opportunities on held equity positions.

For covered calls: identify the optimal strike (10-15% OTM, 21-45 DTE) that maximizes premium without capping meaningful upside.
For cash-secured puts: identify the optimal strike (5-10% OTM) that generates premium while targeting an acceptable acquisition price.

OPTIONS CHAIN DATA:
${chainData.join("\n\n")}

Return JSON: { opportunities: [{ symbol, strategy, strike, expiry, premium_estimate, rationale, risk_note }] }`;

    const aiResp = await callGatewayWithRetry(
      {
        model: ATLAS_MODEL(),
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1200,
      },
      API_KEY,
    );

    if (!aiResp.ok) throw new Error(`AI call failed: ${aiResp.status}`);

    const aiData = await aiResp.json();
    const rawContent: string = aiData.choices?.[0]?.message?.content?.trim() ?? "{}";

    let opportunities: OptionsOpportunity[] = [];
    try {
      const cleaned = rawContent.replace(/```json\s*|\s*```/g, "").trim();
      const parsed = JSON.parse(cleaned) as { opportunities?: OptionsOpportunity[] };
      opportunities = parsed.opportunities ?? [];
    } catch {
      const match = rawContent.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as { opportunities?: OptionsOpportunity[] };
        opportunities = parsed.opportunities ?? [];
      }
    }

    const noteContent = `# Options Scan — ${todayStr}\n\n## Holdings Scanned\n${positions.map((p) => `- ${p.symbol}: ${p.quantity} shares @ $${p.entry_price}`).join("\n")}\n\n## Opportunities\n${opportunities.map((o) => `### ${o.symbol} — ${o.strategy}\n- Strike: $${o.strike}\n- Expiry: ${o.expiry}\n- Est. Premium: $${o.premium_estimate}\n- Rationale: ${o.rationale}\n- Risk: ${o.risk_note}`).join("\n\n")}\n\n${opportunities.length === 0 ? "_No qualifying opportunities identified._" : ""}`;

    // Save to Vault
    const noteRes = await fetch(`${SUPABASE_URL}/rest/v1/research_notes`, {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id,
        title: `Options Scan — ${todayStr}`,
        content: noteContent,
        note_type: "research",
        symbol: "OPTIONS_SCAN",
        synced_to_obsidian: false,
      }),
    });

    if (!noteRes.ok) {
      console.error("[atlas_options_scan] Failed to save research note:", await noteRes.text());
    }

    if (opportunities.length > 0) {
      await sendTelegramAlert(
        `*OPTIONS SCAN — ${todayStr}*\n${opportunities.length} opportunity${opportunities.length !== 1 ? "ies" : ""} identified.\n${opportunities.slice(0, 3).map((o) => `• ${o.symbol} ${o.strategy}: ${o.rationale.slice(0, 80)}`).join("\n")}`,
      );
    }

    await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id,
        signal_type: "research",
        message: `Options scan complete — ${opportunities.length} opportunity${opportunities.length !== 1 ? "ies" : ""} found. Check Vault.`,
      }),
    });

    // Queue each opportunity for Atlas's autonomous loop
    for (const opp of opportunities) {
      await fetch(`${SUPABASE_URL}/rest/v1/atlas_tasks`, {
        method: "POST",
        headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          user_id,
          task_type: "opportunity_candidate",
          payload: {
            asset_class: "options",
            symbol: opp.symbol,
            strategy: opp.strategy,
            strike: opp.strike,
            expiry: opp.expiry,
            premium_estimate: opp.premium_estimate,
            rationale: opp.rationale,
            source: "options_scan",
            scan_date: todayStr,
          },
          status: "queued",
        }),
      });
    }

    return new Response(JSON.stringify({ opportunities, positions_scanned: positions.length, date: todayStr }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[atlas_options_scan] Error:", msg);

    try {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
      const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (SUPABASE_URL && SERVICE_KEY) {
        const body = await req.clone().json().catch(() => ({}));
        await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({
            user_id: (body as { user_id?: string }).user_id ?? "system",
            signal_type: "function_error",
            message: `atlas_options_scan error: ${msg}`,
          }),
        });
      }
    } catch { /* ignore error logging failures */ }

    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
