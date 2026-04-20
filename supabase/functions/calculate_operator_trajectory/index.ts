// Weekly trajectory engine — projects where each operator's business will be in 90 days.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const FAST_MODEL = "google/gemini-2.5-flash";

async function generateTrajectory(
  inputs: {
    full_name: string;
    velocity_90d: number;
    avg_value_trend: "up" | "down" | "flat";
    streak_consistency: number;
    bottleneck: string;
  },
  apiKey: string,
): Promise<string | null> {
  const prompt = `Operator: ${inputs.full_name}
Receipt velocity (last 90 days): ${inputs.velocity_90d} verified jobs
Average job value trend: ${inputs.avg_value_trend}
Streak consistency score (0-100): ${inputs.streak_consistency}
Bottleneck: ${inputs.bottleneck}

In one sentence describe where this operator's business will be in 90 days if their current pattern continues. Be specific. Be honest. No hedging.`;

  const resp = await fetch(
    "https://ai.gateway.lovable.dev/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: FAST_MODEL,
        messages: [{ role: "user", content: prompt }],
      }),
    },
  );
  if (!resp.ok) {
    console.error("trajectory ai error", resp.status, await resp.text());
    return null;
  }
  const j = await resp.json();
  const text = j.choices?.[0]?.message?.content?.trim() ?? "";
  return text || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) {
    return new Response(JSON.stringify({ error: "LOVABLE_API_KEY missing" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const profilesResp = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?select=user_id,full_name`,
    {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    },
  );
  const profiles: { user_id: string; full_name: string }[] = await profilesResp.json();

  let updated = 0;

  for (const p of profiles) {
    try {
      // Pull last 90 days of receipts
      const since = new Date();
      since.setDate(since.getDate() - 90);
      const sinceStr = since.toISOString();

      const rResp = await fetch(
        `${SUPABASE_URL}/rest/v1/receipts_ledger?provider_id=eq.${p.user_id}&created_at=gte.${sinceStr}&select=action_value_usd,verification_state,created_at&order=created_at.desc`,
        {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        },
      );
      const receipts: any[] = await rResp.json();
      const verified = receipts.filter((r) => r.verification_state === "VERIFIED");
      const velocity_90d = verified.length;

      // Avg value trend: split into halves
      let avg_value_trend: "up" | "down" | "flat" = "flat";
      if (verified.length >= 4) {
        const mid = Math.floor(verified.length / 2);
        const recent = verified.slice(0, mid);
        const older = verified.slice(mid);
        const avg = (arr: any[]) =>
          arr.reduce((s, r) => s + Number(r.action_value_usd ?? 0), 0) / arr.length;
        const aR = avg(recent), aO = avg(older);
        if (aR > aO * 1.1) avg_value_trend = "up";
        else if (aR < aO * 0.9) avg_value_trend = "down";
      }

      // Streak consistency: % of last 30 days with at least one verified receipt
      const days = new Set(
        verified
          .filter((r) => {
            const d = new Date(r.created_at);
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - 30);
            return d >= cutoff;
          })
          .map((r) => new Date(r.created_at).toISOString().slice(0, 10)),
      );
      const streak_consistency = Math.round((days.size / 30) * 100);

      // Get bottleneck via context RPC
      const ctxResp = await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/get_forge_context`,
        {
          method: "POST",
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ _user_id: p.user_id }),
        },
      );
      const context = await ctxResp.json();
      const bottleneck = context?.bottleneck ?? "unknown";

      const sentence = await generateTrajectory(
        {
          full_name: p.full_name || "Operator",
          velocity_90d,
          avg_value_trend,
          streak_consistency,
          bottleneck,
        },
        LOVABLE_API_KEY,
      );
      if (!sentence) continue;

      await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?user_id=eq.${p.user_id}`,
        {
          method: "PATCH",
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ trajectory_sentence: sentence }),
        },
      );
      updated++;
    } catch (e) {
      console.error("trajectory user error", p.user_id, e);
    }
  }

  return new Response(JSON.stringify({ updated, total: profiles.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
