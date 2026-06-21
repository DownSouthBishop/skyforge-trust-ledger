const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = (Deno as any).env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY  = (Deno as any).env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

async function verifyUser(auth: string | null): Promise<boolean> {
  if (!auth) return false;
  const token = auth.replace("Bearer ", "").trim();
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SERVICE_KEY },
  });
  return r.ok;
}

(Deno as any).serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authed = await verifyUser(req.headers.get("Authorization"));
  if (!authed) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });

  const anthropicKey = (Deno as any).env.get("ANTHROPIC_API_KEY") ?? "";
  const geminiKey    = (Deno as any).env.get("GOOGLE_AI_KEY") ?? "";

  // --- Check Anthropic (live probe — Anthropic has no RPD cap on probes) ---
  let anthropicStatus: "ok" | "credits" | "quota" | "error" = "error";
  let anthropicMessage = "";

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    if (r.ok) {
      anthropicStatus = "ok";
    } else {
      const t = await r.text();
      if (r.status === 402 || r.status === 400 || t.includes("credit") || t.includes("billing") || t.includes("payment")) {
        anthropicStatus = "credits";
        anthropicMessage = "Credits exhausted — all agents using Gemini.";
      } else if (r.status === 429) {
        anthropicStatus = "quota";
        anthropicMessage = "Rate limited — try again shortly.";
      } else {
        anthropicStatus = "error";
        anthropicMessage = `HTTP ${r.status}`;
      }
    }
  } catch {
    anthropicStatus = "error";
    anthropicMessage = "Network error";
  }

  // --- Gemini status — NO live probe (would burn daily quota just to check status) ---
  // Instead: key present = assumed ok. Status updates when chat functions surface real errors.
  let geminiStatus: "ok" | "quota" | "error" = "error";
  let geminiMessage = "";
  const geminiKeyTail = geminiKey.length > 6 ? `…${geminiKey.slice(-6)}` : "(not set)";

  if (!geminiKey) {
    geminiStatus = "error";
    geminiMessage = "GOOGLE_AI_KEY not configured.";
  } else {
    // Read last-known status from shared_operator_memory (written by atlas-core on 429)
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/shared_operator_memory?source_agent=eq.system&key=eq.gemini_status&order=updated_at.desc&limit=1&select=value,updated_at`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
      );
      if (r.ok) {
        const rows = await r.json();
        const row = rows?.[0];
        if (row) {
          const ageMs = Date.now() - new Date(row.updated_at).getTime();
          const ageHours = ageMs / 3_600_000;
          if (row.value === "quota" && ageHours < 25) {
            // Quota hit within the last 25h — still likely exhausted
            geminiStatus = "quota";
            geminiMessage = "Daily quota exceeded (1,500 req/day free tier). Resets at midnight UTC.";
          } else {
            geminiStatus = "ok";
          }
        } else {
          geminiStatus = "ok";
        }
      } else {
        // Can't read table — assume ok if key is present
        geminiStatus = "ok";
      }
    } catch {
      geminiStatus = "ok";
    }
  }

  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const secondsUntilReset = geminiStatus === "quota"
    ? Math.max(0, Math.floor((midnight.getTime() - now.getTime()) / 1000))
    : null;

  return new Response(
    JSON.stringify({
      checked_at: now.toISOString(),
      seconds_until_gemini_reset: secondsUntilReset,
      providers: {
        anthropic: { status: anthropicStatus, message: anthropicMessage },
        gemini: { status: geminiStatus, message: geminiMessage, key_tail: geminiKeyTail },
      },
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
