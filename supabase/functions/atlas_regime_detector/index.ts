// Atlas Regime Detector — classifies current market regime and closes the feedback loop
// Phase 1D: writes regime to atlas_user_preferences so other functions can gate strategy

import { corsHeaders, callGatewayWithRetry, parseEnv, modelEnv } from "../_shared/gateway.ts";

const FAST_MODEL = () => modelEnv("FAST_MODEL", "google/gemini-2.5-flash");

interface ForexScanNote {
  content: string;
}

interface RegimeResult {
  regime: string;
  confidence: number;
  rationale: string;
  key_indicators: string[];
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

    // Fetch last 3 forex scan notes
    const scansResp = await fetch(
      `${SUPABASE_URL}/rest/v1/research_notes?user_id=eq.${user_id}&note_type=eq.research&symbol=eq.FOREX_SCAN&order=created_at.desc&limit=3&select=content`,
      { headers: baseHeaders },
    );
    if (!scansResp.ok) throw new Error(`Failed to fetch forex scans: ${scansResp.status}`);
    const scans: ForexScanNote[] = await scansResp.json();

    const scanContent = scans.length > 0
      ? scans.map((s, i) => `Scan ${i + 1}:\n${s.content}`).join("\n\n")
      : "No recent forex scans available.";

    const prompt = `Analyze these recent forex scan results and classify the current market regime into exactly ONE of: Risk-On Trending, Risk-Off Trending, Range-Bound Low Vol, Range-Bound High Vol. Provide a confidence score 0-1. Return JSON: { regime: string, confidence: number, rationale: string, key_indicators: string[] }. Recent scans:\n${scanContent}`;

    const aiRespRaw = await callGatewayWithRetry(
      {
        model: FAST_MODEL(),
        messages: [{ role: "user", content: prompt }],
        max_tokens: 600,
      },
      API_KEY,
    );

    if (!aiRespRaw.ok) throw new Error(`AI call failed: ${aiRespRaw.status}`);

    const aiData = await aiRespRaw.json();
    const rawContent: string = aiData.choices?.[0]?.message?.content?.trim() ?? "{}";

    let parsed: RegimeResult;
    try {
      parsed = JSON.parse(rawContent.replace(/```json\s*|\s*```/g, "").trim());
    } catch {
      const match = rawContent.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error("Failed to parse regime JSON from AI response");
      }
    }

    const regime: string          = parsed.regime ?? "Range-Bound Low Vol";
    const confidence: number      = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;
    const rationale: string       = parsed.rationale ?? "";
    const keyIndicators: string[] = Array.isArray(parsed.key_indicators) ? parsed.key_indicators : [];

    // Write to atlas_state (existing)
    const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/atlas_state`, {
      method: "POST",
      headers: {
        ...baseHeaders,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        user_id,
        regime,
        confidence_score: confidence,
        indicators_json: { rationale, key_indicators: keyIndicators },
      }),
    });

    if (!insertResp.ok) {
      const errText = await insertResp.text();
      console.error(`[atlas_regime_detector] Failed to insert atlas_state: ${errText}`);
    }

    // Phase 1D: Write regime to atlas_user_preferences so other functions can read it
    const regimeValue = JSON.stringify({ regime, confidence, detected_at: new Date().toISOString() });
    const prefResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_atlas_preference`, {
      method: "POST",
      headers: {
        ...baseHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        _user_id: user_id,
        _category: "trading_style",
        _key: "market_regime",
        _value: regimeValue,
        _confidence: confidence,
        _evidence: `Regime detection from forex scan: ${rationale.slice(0, 200)}`,
      }),
    });

    if (!prefResp.ok) {
      const prefErr = await prefResp.text();
      console.error(`[atlas_regime_detector] Failed to upsert regime preference: ${prefErr}`);
    }

    return new Response(JSON.stringify({ regime, confidence, rationale, key_indicators: keyIndicators }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
