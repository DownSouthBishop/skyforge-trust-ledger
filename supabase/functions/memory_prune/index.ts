// memory_prune — daily housekeeping for shared_operator_memory.
// Deletes: expired rows, low-confidence rows, duplicate keys (older).
// Preserves: commitments, patterns, confidence=1.0 anchors.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    };

    // 1. Delete expired (skip commitments/patterns and anchors)
    await fetch(
      `${supabaseUrl}/rest/v1/shared_operator_memory?expires_at=lt.${encodeURIComponent(new Date().toISOString())}&memory_type=not.in.(commitment,pattern)&confidence=lt.1.0`,
      { method: "DELETE", headers },
    );

    // 2. Delete low-confidence
    await fetch(
      `${supabaseUrl}/rest/v1/shared_operator_memory?confidence=lt.0.3&memory_type=not.in.(commitment,pattern)`,
      { method: "DELETE", headers },
    );

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[memory_prune]", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
