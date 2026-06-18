// Atlas Deal Scan — market scanning for real estate acquisition opportunities
// Phase 3B: runs daily at 07:00 UTC

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv, resolveUserIds } from "../_shared/gateway.ts";
import { sendTelegramAlert } from "../forge_alerts/telegram.ts";

const ATLAS_MODEL = () => modelEnv("ATLAS_MODEL", "openai/gpt-4o");

const DEFAULT_CRITERIA = {
  min_cap_rate: 6,
  min_cash_on_cash: 8,
  max_price: 500000,
  markets: [] as Array<{ city: string; state: string }>,
  property_types: ["sfr", "multi"] as string[],
};

interface DealScore {
  score: number;
  summary: string;
  risk: string;
  opportunity: string;
  pipeline: boolean;
  rationale: string;
}

interface RentcastListing {
  id: string;
  formattedAddress: string;
  city: string;
  state: string;
  zipCode: string;
  propertyType: string;
  price: number;
  bedrooms: number;
  bathrooms: number;
  squareFootage: number;
}

interface RentcastRentEstimate {
  rent: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL  = parseEnv("SUPABASE_URL");
    const SERVICE_KEY   = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY       = (Deno.env.get("GOOGLE_AI_KEY") ?? "");
    const RENTCAST_KEY  = Deno.env.get("RENTCAST_API_KEY");

    const { user_id: rawUserId } = await req.json();
    if (!rawUserId) {
      return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });
    }

    const userIds = await resolveUserIds(SUPABASE_URL, SERVICE_KEY, rawUserId);
    if (userIds.length === 0) {
      return new Response(JSON.stringify({ message: "No users found to process" }), { headers: corsHeaders });
    }
    const user_id = userIds[0];

    if (!RENTCAST_KEY) {
      return new Response(JSON.stringify({ error: "RENTCAST_API_KEY not configured — deal scan unavailable" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const baseHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

    // Read acquisition criteria from atlas_user_preferences
    let criteria = { ...DEFAULT_CRITERIA };
    try {
      const prefRes = await fetch(
        `${SUPABASE_URL}/rest/v1/atlas_user_preferences?user_id=eq.${user_id}&category=eq.trading_style&key=eq.re_acquisition_criteria&select=value&limit=1`,
        { headers: baseHeaders },
      );
      if (prefRes.ok) {
        const rows: Array<{ value: string }> = await prefRes.json();
        if (rows.length > 0) {
          criteria = { ...DEFAULT_CRITERIA, ...JSON.parse(rows[0].value) };
        }
      }
    } catch {
      console.warn("[atlas_deal_scan] Could not read acquisition criteria, using defaults.");
    }

    const markets = criteria.markets.length > 0 ? criteria.markets : [{ city: "Austin", state: "TX" }, { city: "Tampa", state: "FL" }];
    let totalScanned = 0;
    let totalQueued = 0;

    for (const market of markets.slice(0, 3)) {
      for (const propType of criteria.property_types.slice(0, 2)) {
        try {
          const listingsRes = await fetch(
            `https://api.rentcast.io/v1/listings/sale?city=${encodeURIComponent(market.city)}&state=${encodeURIComponent(market.state)}&propertyType=${encodeURIComponent(propType)}&limit=20`,
            { headers: { "X-Api-Key": RENTCAST_KEY } },
          );
          if (!listingsRes.ok) continue;

          const listings: RentcastListing[] = await listingsRes.json();
          totalScanned += listings.length;

          for (const listing of listings) {
            if (Number(listing.price) > criteria.max_price) continue;

            // Get rent estimate
            let estimatedRent = 0;
            try {
              const rentRes = await fetch(
                `https://api.rentcast.io/v1/avm/rent/long-term?address=${encodeURIComponent(listing.formattedAddress)}`,
                { headers: { "X-Api-Key": RENTCAST_KEY } },
              );
              if (rentRes.ok) {
                const rentData: RentcastRentEstimate = await rentRes.json();
                estimatedRent = Number(rentData.rent ?? 0);
              }
            } catch { /* skip rent estimate */ }

            if (estimatedRent === 0) continue;

            // Preliminary cap rate: (annual_rent * 0.6) / list_price * 100
            const prelimCapRate = (estimatedRent * 12 * 0.6) / listing.price * 100;
            if (prelimCapRate < criteria.min_cap_rate) continue;

            // Ask Atlas to score the deal
            const prompt = `You are Atlas. Evaluate this property as an investment acquisition.

Address: ${listing.formattedAddress}
List Price: $${listing.price.toLocaleString()}
Estimated Rent: $${estimatedRent}/mo
Preliminary Cap Rate: ${prelimCapRate.toFixed(1)}%
Market: ${market.city}, ${market.state}
Property Type: ${propType}
Bedrooms: ${listing.bedrooms ?? "N/A"} | Bathrooms: ${listing.bathrooms ?? "N/A"}

Score this deal 1-10 and explain your reasoning in 3 sentences. Identify the one biggest risk and the one biggest opportunity. Would you put this in the pipeline for deeper underwriting? Yes/No with one-sentence rationale.

Return JSON: { score: number, summary: string, risk: string, opportunity: string, pipeline: boolean, rationale: string }`;

            try {
              const aiResp = await callGatewayWithRetry(
                { model: ATLAS_MODEL(), messages: [{ role: "user", content: prompt }], max_tokens: 500 },
                API_KEY,
              );
              if (!aiResp.ok) continue;

              const aiData = await aiResp.json();
              const rawContent: string = aiData.choices?.[0]?.message?.content?.trim() ?? "{}";

              let dealScore: DealScore;
              try {
                const cleaned = rawContent.replace(/```json\s*|\s*```/g, "").trim();
                dealScore = JSON.parse(cleaned) as DealScore;
              } catch {
                const match = rawContent.match(/\{[\s\S]*\}/);
                if (!match) continue;
                dealScore = JSON.parse(match[0]) as DealScore;
              }

              if (dealScore.score >= 6 && dealScore.pipeline) {
                await fetch(`${SUPABASE_URL}/rest/v1/property_pipeline`, {
                  method: "POST",
                  headers: { ...baseHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
                  body: JSON.stringify({
                    user_id,
                    address: listing.formattedAddress,
                    city: market.city,
                    state: market.state,
                    zip: listing.zipCode ?? null,
                    property_type: propType === "sfr" ? "sfr" : "multi",
                    list_price: listing.price,
                    gross_rent_monthly: estimatedRent,
                    cap_rate: parseFloat(prelimCapRate.toFixed(2)),
                    stage: "scanning",
                    source: "rentcast",
                    notes: `Atlas score: ${dealScore.score}/10. ${dealScore.summary}`,
                    thesis: dealScore.rationale,
                  }),
                });
                totalQueued++;
              }
            } catch (e: unknown) {
              console.error("[atlas_deal_scan] AI scoring error:", e instanceof Error ? e.message : String(e));
            }
          }
        } catch (e: unknown) {
          console.error(`[atlas_deal_scan] Error scanning ${market.city}:`, e instanceof Error ? e.message : String(e));
        }
      }
    }

    if (totalQueued > 0) {
      await sendTelegramAlert(`*DEAL SCAN COMPLETE*\n${totalScanned} listings scanned across ${markets.length} market${markets.length !== 1 ? "s" : ""}.\n${totalQueued} deal${totalQueued !== 1 ? "s" : ""} added to pipeline. Check Real Estate → Pipeline.`);
    }

    return new Response(JSON.stringify({ status: "ok", listings_scanned: totalScanned, deals_queued: totalQueued }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[atlas_deal_scan] Error:", msg);
    try {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
      const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (SUPABASE_URL && SERVICE_KEY) {
        const body = await req.clone().json().catch(() => ({}));
        await fetch(`${SUPABASE_URL}/rest/v1/forge_alerts`, {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: (body as { user_id?: string }).user_id ?? "system", signal_type: "function_error", message: `atlas_deal_scan error: ${msg}` }),
        });
      }
    } catch { /* ignore */ }
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: corsHeaders });
  }
});
