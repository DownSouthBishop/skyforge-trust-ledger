// Daily silence detector — for operators absent 48h+ with an open directive,
// generate a personal "noticed you were gone" message stored on the profile.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const FAST_MODEL = "google/gemini-2.5-flash";

async function generateReengagement(
  hoursAway: number,
  directive: string,
  apiKey: string,
): Promise<string | null> {
  const prompt = `The operator hasn't opened the app in ${hoursAway} hours. They have an open directive: "${directive}". Write one message — under 25 words — that sounds like it came from someone who noticed they were gone and genuinely cares whether they come back. Reference their open directive specifically. No pressure. No system language.`;

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
    console.error("reengagement ai error", resp.status, await resp.text());
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

  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - 48);
  const cutoffStr = cutoff.toISOString();

  // Operators silent 48h+ (last_seen_at null OR < cutoff)
  const profilesResp = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?select=user_id,last_seen_at&or=(last_seen_at.is.null,last_seen_at.lt.${cutoffStr})`,
    {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    },
  );
  const profiles: { user_id: string; last_seen_at: string | null }[] = await profilesResp.json();

  let queued = 0;
  for (const p of profiles) {
    try {
      // Need an open undismissed directive
      const dResp = await fetch(
        `${SUPABASE_URL}/rest/v1/forge_directives?user_id=eq.${p.user_id}&dismissed=eq.false&select=directive&order=generated_at.desc&limit=1`,
        {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        },
      );
      const dRows: { directive: string }[] = await dResp.json();
      if (!Array.isArray(dRows) || dRows.length === 0) continue;
      const directive = dRows[0].directive;

      const hoursAway = p.last_seen_at
        ? Math.floor((Date.now() - new Date(p.last_seen_at).getTime()) / 3_600_000)
        : 72;

      const message = await generateReengagement(hoursAway, directive, LOVABLE_API_KEY);
      if (!message) continue;

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
          body: JSON.stringify({ atlas_reengagement_message: message }),
        },
      );
      queued++;
    } catch (e) {
      console.error("reengagement user error", p.user_id, e);
    }
  }

  return new Response(JSON.stringify({ queued, total: profiles.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
