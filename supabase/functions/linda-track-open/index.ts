// linda-track-open — 1x1 pixel endpoint embedded in outbound HTML emails by linda-send-email.
// Public (no auth — mail clients load images unauthenticated). Marks linda_responses.opened_at
// the first time it's hit, then always returns a transparent GIF regardless of match/outcome
// (never leak whether tracking succeeded to whoever's inspecting network requests).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// 1x1 transparent GIF, base64-decoded once at module load.
const PIXEL_GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7"),
  (c) => c.charCodeAt(0),
);

function pixelResponse(): Response {
  return new Response(PIXEL_GIF, {
    headers: { ...corsHeaders, "Content-Type": "image/gif", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const rid = new URL(req.url).searchParams.get("rid");

    if (rid) {
      const h = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
      // Only set opened_at once, and only for messages we actually sent.
      fetch(`${SUPABASE_URL}/rest/v1/linda_responses?id=eq.${rid}&status=eq.sent&opened_at=is.null`, {
        method: "PATCH",
        headers: { ...h, Prefer: "return=minimal" },
        body: JSON.stringify({ opened_at: new Date().toISOString() }),
      }).catch(() => {});
    }

    return pixelResponse();
  } catch {
    return pixelResponse();
  }
});
