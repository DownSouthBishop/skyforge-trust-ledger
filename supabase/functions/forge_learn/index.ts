// forge_learn — extract and persist what Atlas learns from each conversation turn
// Called fire-and-forget after each response. Never blocks the chat.

import { corsHeaders, callGatewayWithRetry, verifyUser, parseEnv, modelEnv, AuthError } from "../_shared/gateway.ts";

const FAST_MODEL = () => modelEnv("FAST_MODEL", "google/gemini-2.5-flash-lite");

const EXTRACT_PROMPT = `You are extracting learning signals from a single conversation turn between a user and Atlas (an AI advisor).

Extract ONLY what is clearly observable from THIS turn. Do not invent or speculate.

Return valid JSON only — no markdown, no explanation, just the JSON object.

Schema:
{
  "preferences": [
    {
      "category": "communication" | "trading_style" | "interest" | "dislike" | "behavioral" | "emotional",
      "key": "snake_case_key",
      "value": "human readable description of what was observed",
      "confidence": 0.3-0.9,
      "evidence": "brief quote or paraphrase of what triggered this"
    }
  ],
  "emotional_signal": "one sentence describing current emotional state, or null if nothing notable",
  "dossier_update": {
    "current_focus": "text or null",
    "current_emotional_signal": "text or null"
  }
}

Rules:
- Only include preferences with genuine evidence from this turn
- Keep confidence <= 0.6 for single-turn observations (needs reinforcement)
- Emotional signal: only if the user's tone, urgency, or content signals something specific
- Return empty arrays/null if nothing clear was observed — better to return nothing than to invent
- communication examples: prefers_brevity, wants_direct_answers, dislikes_bullet_points, likes_examples, prefers_numbered_steps, hates_jargon, wants_more_context
- trading_style examples: risk_averse, prefers_forex, interested_in_crypto, short_term_focus, patient_with_positions, dislikes_leverage
- interest examples: interested_in_defi, follows_macro, interested_in_earnings, likes_technical_analysis
- dislike examples: dislikes_long_explanations, frustrated_by_vague_answers, dislikes_unsolicited_advice
- behavioral examples: acts_quickly_on_signals, asks_for_confirmation, double_checks_before_acting
- emotional examples: operates_well_under_pressure, gets_anxious_with_losses, motivated_by_progress_metrics`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("LOVABLE_API_KEY");

    const userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));

    const { user_message, atlas_message } = await req.json();
    if (!user_message && !atlas_message) {
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const turnText = [
      user_message ? `USER: ${user_message}` : null,
      atlas_message ? `ATLAS: ${atlas_message}` : null,
    ].filter(Boolean).join("\n\n");

    const aiResp = await callGatewayWithRetry(
      {
        model: FAST_MODEL(),
        messages: [
          { role: "system", content: EXTRACT_PROMPT },
          { role: "user", content: `Analyze this conversation turn:\n\n${turnText}` },
        ],
        max_completion_tokens: 800,
        stream: false,
      },
      API_KEY,
    );

    if (!aiResp.ok) {
      console.error("forge_learn: AI call failed", aiResp.status);
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const aiData = await aiResp.json();
    const raw = aiData?.choices?.[0]?.message?.content ?? "";

    let extracted: any = { preferences: [], emotional_signal: null, dossier_update: {} };
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) extracted = JSON.parse(jsonMatch[0]);
    } catch {
      console.error("forge_learn: JSON parse failed", raw.slice(0, 200));
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Upsert preferences
    const prefs = Array.isArray(extracted.preferences) ? extracted.preferences : [];
    for (const p of prefs) {
      if (!p.category || !p.key || !p.value) continue;
      if (typeof p.confidence !== "number" || p.confidence < 0.1 || p.confidence > 1) continue;

      await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_atlas_preference`, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          _user_id: userId,
          _category: p.category,
          _key: p.key,
          _value: p.value,
          _confidence: p.confidence,
          _evidence: p.evidence ?? null,
        }),
      }).catch((e: Error) => console.error("forge_learn: upsert pref failed", e.message));
    }

    // Update dossier emotional signal if present
    const du = extracted.dossier_update ?? {};
    const emotionalSignal = extracted.emotional_signal ?? du.current_emotional_signal ?? null;
    if (emotionalSignal) {
      await fetch(`${SUPABASE_URL}/rest/v1/forge_dossier?user_id=eq.${userId}`, {
        method: "PATCH",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ current_emotional_signal: emotionalSignal }),
      }).catch(() => {});
    }

    return new Response(JSON.stringify({ ok: true, prefs_extracted: prefs.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    if (e instanceof AuthError) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.error("forge_learn error:", e);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
