// Daily silence detector — for operators absent 48h+ with an open directive,
// generate a personal re-engagement message stored on the profile.
// Stage 2+ operators get a message that draws on their dossier and open commitments.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const FAST_MODEL = "google/gemini-2.5-flash";

async function generateReengagement(
  hoursAway: number,
  directive: string,
  stage: number,
  dossier: any,
  openCommitments: any[],
  apiKey: string,
): Promise<string | null> {
  // For Stage 1: reference the directive, keep it simple
  // For Stage 2+: draw on what Atlas actually knows — dossier and open commitments
  let contextLine = `Open directive: "${directive}"`;

  if (stage >= 2 && openCommitments.length > 0) {
    const oldest = openCommitments.sort((a: any, b: any) =>
      new Date(a.made_at).getTime() - new Date(b.made_at).getTime()
    )[0];
    const daysOpen = Math.floor((Date.now() - new Date(oldest.made_at).getTime()) / 86400000);
    contextLine += `\nOldest open commitment: "${oldest.description}" — ${daysOpen} days open.`;
  }

  if (stage >= 2 && dossier?.current_emotional_signal) {
    contextLine += `\nLast known emotional state: ${dossier.current_emotional_signal}`;
  }

  const stageInstruction = stage >= 3
    ? `You know this operator well. Write as someone who genuinely noticed their absence and thought about them specifically — not as a notification system. Reference what you know is on their plate, not just the directive.`
    : stage === 2
    ? `You've been working together for a while. Sound like someone who noticed they were gone, not a system alert.`
    : `Sound like someone who genuinely cares whether they come back, not a reminder.`;

  const prompt = `The operator hasn't opened the app in ${hoursAway} hours.

${contextLine}

${stageInstruction}

Write one message — under 30 words. No pressure. No urgency. No system language. Something that sounds like it came from someone who was thinking about them.`;

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

  // Operators silent 48h+ — pull stage alongside
  const profilesResp = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?select=user_id,last_seen_at,atlas_relationship_stage&or=(last_seen_at.is.null,last_seen_at.lt.${cutoffStr})`,
    {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    },
  );
  const profiles: { user_id: string; last_seen_at: string | null; atlas_relationship_stage: number }[] = await profilesResp.json();

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

      const stage = p.atlas_relationship_stage ?? 1;

      // For Stage 2+: pull dossier and open commitments to personalize
      let dossier: any = {};
      let openCommitments: any[] = [];

      if (stage >= 2) {
        const [dossierResp, commitmentsResp] = await Promise.all([
          fetch(
            `${SUPABASE_URL}/rest/v1/forge_dossier?user_id=eq.${p.user_id}&select=current_emotional_signal,current_focus,avoidance_pattern&limit=1`,
            { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
          ),
          fetch(
            `${SUPABASE_URL}/rest/v1/forge_commitments?user_id=eq.${p.user_id}&resolution_status=eq.open&select=description,made_at&order=made_at.asc&limit=3`,
            { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
          ),
        ]);
        const dossierRows = dossierResp.ok ? await dossierResp.json() : [];
        dossier = Array.isArray(dossierRows) && dossierRows.length > 0 ? dossierRows[0] : {};
        openCommitments = commitmentsResp.ok ? await commitmentsResp.json() : [];
        if (!Array.isArray(openCommitments)) openCommitments = [];
      }

      const message = await generateReengagement(hoursAway, directive, stage, dossier, openCommitments, LOVABLE_API_KEY);
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
