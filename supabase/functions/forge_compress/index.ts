// forge_compress — conversation compression + atomic dossier extraction.
// Split from forge_chat to isolate failure domains.
// Uses merge_dossier_updates() RPC for atomic, race-free JSONB merging.

import {
  corsHeaders,
  callGatewayWithRetry,
  verifyUser,
  parseEnv,
  modelEnv,
  AuthError,
} from "../_shared/gateway.ts";

const FAST_MODEL    = () => modelEnv("FAST_MODEL",    "google/gemini-2.5-flash-lite");
const EXTRACT_MODEL = () => modelEnv("EXTRACT_MODEL", "google/gemini-2.5-flash");

// ─── Dossier extraction prompt ────────────────────────────────────────────────

function buildDossierExtractPrompt(currentDossier: any, transcript: string): string {
  const scalarFields = [
    "money_beliefs", "risk_posture", "decision_pattern", "follow_through_pattern",
    "avoidance_pattern", "current_phase", "current_focus", "emotional_baseline",
    "current_emotional_signal", "last_heavy_exchange",
  ].map((k) => `${k}: ${(currentDossier as any)[k] ?? "(unknown)"}`).join("\n");

  const existingBusinesses = Array.isArray(currentDossier.businesses) && currentDossier.businesses.length > 0
    ? JSON.stringify(currentDossier.businesses, null, 2)
    : "None tracked yet.";

  const existingIdeas = Array.isArray(currentDossier.active_ideas) && currentDossier.active_ideas.length > 0
    ? JSON.stringify(currentDossier.active_ideas, null, 2)
    : "None tracked yet.";

  return `You are extracting durable knowledge about an entrepreneur from their conversation with Atlas, their financial advisor.

CURRENT DOSSIER — scalar fields (only add new or corrected info):
${scalarFields}

CURRENT BUSINESSES (known):
${existingBusinesses}

CURRENT IDEAS IN MOTION (known):
${existingIdeas}

CONVERSATION:
${transcript}

Return ONLY valid JSON. Omit any field/array where this conversation added nothing new:
{
  "dossier_updates": {
    "money_beliefs": "how they actually relate to money — observed, not stated",
    "risk_posture": "conservative / aggressive / avoidant / calculated — from behavior",
    "decision_pattern": "how they actually make decisions beneath the stated process",
    "follow_through_pattern": "do they execute on commitments? what does the pattern look like?",
    "avoidance_pattern": "what do they reliably defer, avoid, rationalize away?",
    "current_phase": "growing / stabilizing / rebuilding / first hire / transition",
    "current_focus": "what is genuinely consuming their attention right now",
    "emotional_baseline": "their default register in conversation",
    "current_emotional_signal": "what they seem to be carrying right now",
    "last_heavy_exchange": "1-2 sentences only if there was real emotional weight this conversation"
  },
  "businesses_updates": [
    {
      "name": "business name — required",
      "trade": "what this business does",
      "phase": "growing / stabilizing / rebuilding / new / winding down",
      "current_focus": "what's consuming attention in this business right now",
      "revenue_pattern": "how this business generates money — observed pattern"
    }
  ],
  "ideas_updates": [
    {
      "name": "idea name or short description — required",
      "stage": "raw | exploring | testing | executing",
      "notes": "1-2 sentence summary of where this idea stands"
    }
  ],
  "new_commitments": [
    { "description": "specific thing the operator committed to doing", "target_date": "YYYY-MM-DD or null" }
  ],
  "had_heavy_exchange": false
}

Rules:
- dossier_updates: observations not transcriptions
- businesses_updates: merge by name — only include fields that are new or updated
- new_commitments: only explicit operator commitments — not Atlas suggestions
- Be conservative: empty is better than fabricated
- had_heavy_exchange: true only for real emotional weight
- Return pure JSON only — no markdown, no explanation`;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL  = parseEnv("SUPABASE_URL");
    const SERVICE_KEY   = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY       = parseEnv("LOVABLE_API_KEY");

    const userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));

    const body = await req.json();
    const { messages } = body;
    if (!Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: "messages required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const transcript = messages
      .map((m: any) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n");

    // Fetch current dossier once, then fire summary + extraction in parallel
    const dossierFetchResp = await fetch(
      `${SUPABASE_URL}/rest/v1/forge_dossier?user_id=eq.${userId}&select=*&limit=1`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    const dossierRows = dossierFetchResp.ok ? await dossierFetchResp.json() : [];
    const currentDossier = Array.isArray(dossierRows) && dossierRows.length > 0 ? dossierRows[0] : {};

    const summaryPrompt = `Summarize this conversation history in 3 sentences capturing the operator's key business context, current challenges, and any commitments or directives discussed. Plain text only.\n\nThen, on three separate following lines extract these three preserved facts (use empty string if not present):\nGOAL: <operator's most recently stated goal>\nOBSTACLE: <operator's most recently stated obstacle>\nCOMMITMENT: <any commitment they made to Atlas>\n\n${transcript}`;

    const [summaryResp, extractResp] = await Promise.all([
      callGatewayWithRetry(
        { model: FAST_MODEL(), messages: [{ role: "user", content: summaryPrompt }] },
        API_KEY,
      ),
      callGatewayWithRetry(
        { model: EXTRACT_MODEL(), messages: [{ role: "user", content: buildDossierExtractPrompt(currentDossier, transcript) }] },
        API_KEY,
      ),
    ]);

    if (!summaryResp.ok) {
      if (summaryResp.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again shortly." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (summaryResp.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "summarize failed" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sj = await summaryResp.json();
    const rawSummary = sj.choices?.[0]?.message?.content?.trim() ?? "";

    const goalMatch      = rawSummary.match(/GOAL:\s*(.+)/i);
    const obstacleMatch  = rawSummary.match(/OBSTACLE:\s*(.+)/i);
    const commitmentMatch = rawSummary.match(/COMMITMENT:\s*(.+)/i);
    const goal       = goalMatch?.[1]?.trim() || null;
    const obstacle   = obstacleMatch?.[1]?.trim() || null;
    const commitment = commitmentMatch?.[1]?.trim() || null;

    const summary = rawSummary
      .replace(/^\s*GOAL:.*$/gim, "")
      .replace(/^\s*OBSTACLE:.*$/gim, "")
      .replace(/^\s*COMMITMENT:.*$/gim, "")
      .trim();

    // Persist sticky memory
    if (goal || obstacle || commitment) {
      const patch: Record<string, string> = { user_id: userId };
      if (goal)       patch.goal = goal;
      if (obstacle)   patch.obstacle = obstacle;
      if (commitment) patch.commitment = commitment;
      await fetch(`${SUPABASE_URL}/rest/v1/forge_sticky_memory`, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(patch),
      });
    }

    // Atomic dossier merge via PL/pgSQL — eliminates the race condition
    let extractionOk = false;
    try {
      if (extractResp.ok) {
        const ej = await extractResp.json();
        const rawExtract = ej.choices?.[0]?.message?.content?.trim() ?? "";
        const cleaned = rawExtract.replace(/```json\s*|\s*```/g, "").trim();
        const extracted = JSON.parse(cleaned);

        const mergeResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/merge_dossier_updates`, {
          method: "POST",
          headers: {
            apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            _user_id:        userId,
            _scalar_updates: extracted.dossier_updates ?? {},
            _businesses:     extracted.businesses_updates ?? [],
            _ideas:          extracted.ideas_updates ?? [],
            _commitments:    extracted.new_commitments ?? [],
            _extraction_ok:  true,
          }),
        });
        extractionOk = mergeResp.ok;
        if (!mergeResp.ok) {
          console.error("merge_dossier_updates failed", mergeResp.status, await mergeResp.text());
        }
      }
    } catch (e) {
      // Extraction is best-effort — never fail the compress response
      console.error("dossier extraction error", e);
    }

    // Record extraction failure if it didn't succeed
    if (!extractionOk) {
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/merge_dossier_updates`, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          _user_id: userId, _extraction_ok: false,
        }),
      }).catch(() => {/* truly best-effort */});
    }

    return new Response(
      JSON.stringify({ summary, sticky: { goal, obstacle, commitment } }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    if (e instanceof AuthError) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.error("forge_compress error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
