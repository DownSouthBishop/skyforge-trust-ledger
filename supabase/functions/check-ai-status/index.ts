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

  // --- Check Anthropic ---
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
        anthropicMessage = "Credits exhausted — all agents using Gemini fallback.";
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

  // --- Check Google Gemini ---
  let geminiStatus: "ok" | "quota" | "error" = "error";
  let geminiMessage = "";
  let geminiKeyTail = geminiKey.length > 6 ? `…${geminiKey.slice(-6)}` : "(not set)";

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Hi" }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      },
    );

    if (r.ok) {
      geminiStatus = "ok";
    } else {
      const t = await r.text();
      const isZeroLimit = t.includes("limit: 0") || t.includes('"limit":0');
      if (isZeroLimit) {
        geminiStatus = "error";
        geminiMessage = "API key has no quota (limit: 0). Generate a fresh key at aistudio.google.com — key must start with AIza, not AQ.";
      } else if (r.status === 429 || t.includes("quota") || t.includes("exceeded")) {
        geminiStatus = "quota";
        geminiMessage = "Daily quota exceeded (1,500 req/day free tier). Resets at midnight UTC.";
      } else if (r.status === 400 || r.status === 403) {
        geminiStatus = "error";
        geminiMessage = `Key rejected (HTTP ${r.status}) — key tail: ${geminiKeyTail}`;
      } else {
        geminiStatus = "error";
        geminiMessage = `HTTP ${r.status}`;
      }
    }
  } catch {
    geminiStatus = "error";
    geminiMessage = "Network error";
  }

  // Only show reset countdown for actual daily quota exhaustion
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
