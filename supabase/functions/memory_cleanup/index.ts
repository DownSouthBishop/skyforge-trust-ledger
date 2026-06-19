// memory_cleanup — weekly pruning of agent_cross_memory and agent_journal.
// Keeps: cross_memory entries < 30 days old, or in structural topics.
// Keeps: journal entries < 90 days old.
// Does NOT touch shared_operator_memory (memory_prune handles that separately).
// Runs Sunday 1am via pg_cron.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Topics that are always preserved (structural, not ephemeral)
const PRESERVED_CROSS_MEMORY_TOPICS = [
  "self_improvement",
  "daily_brief",
  "operator_conversation",
  "market_alert",
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
    const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

    const h = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };

    const hMin = { ...h, Prefer: "return=minimal" };

    // Resolve operator
    const agentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/skyforge_agents?select=user_id&is_active=eq.true&limit=1`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    const agentRows = agentRes.ok ? (await agentRes.json() as any[]) : [];
    if (!agentRows.length) {
      return new Response(JSON.stringify({ ok: false, error: "No agents found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const uid = agentRows[0].user_id as string;

    const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const cutoff90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    // Count before deletion for reporting
    const [crossMemCountRes, journalCountRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/agent_cross_memory?user_id=eq.${uid}&created_at=lt.${cutoff30d}&topic=not.in.(${PRESERVED_CROSS_MEMORY_TOPICS.join(",")})&select=id`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "count=exact" } },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/agent_journal?user_id=eq.${uid}&created_at=lt.${cutoff90d}&select=id`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: "count=exact" } },
      ),
    ]);

    const crossMemCount = parseInt(crossMemCountRes.headers.get("content-range")?.split("/")[1] ?? "0");
    const journalCount = parseInt(journalCountRes.headers.get("content-range")?.split("/")[1] ?? "0");

    // Delete stale agent_cross_memory (skip preserved topics)
    await fetch(
      `${SUPABASE_URL}/rest/v1/agent_cross_memory?user_id=eq.${uid}&created_at=lt.${cutoff30d}&topic=not.in.(${PRESERVED_CROSS_MEMORY_TOPICS.join(",")})`,
      { method: "DELETE", headers: hMin },
    );

    // Delete old agent_journal entries (keep 90 days)
    await fetch(
      `${SUPABASE_URL}/rest/v1/agent_journal?user_id=eq.${uid}&created_at=lt.${cutoff90d}`,
      { method: "DELETE", headers: hMin },
    );

    const totalDeleted = crossMemCount + journalCount;

    // Write cleanup record to cross_memory
    await fetch(`${SUPABASE_URL}/rest/v1/agent_cross_memory`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: uid,
        source_agent: "izzy",
        summary: `Weekly memory cleanup: removed ${crossMemCount} stale cross_memory entries (>30d) and ${journalCount} old journal entries (>90d). Memory layer is clean.`,
        topic: "self_improvement",
      }),
    });

    // Telegram report
    if (BOT_TOKEN && CHAT_ID && totalDeleted > 0) {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: `🧹 *Weekly Memory Cleanup*\n\n• Cross-memory pruned: ${crossMemCount} entries (>30 days)\n• Journal pruned: ${journalCount} entries (>90 days)\n\nPreserved: self-improvement logs, daily briefs, operator conversations, market alerts.`,
          parse_mode: "Markdown",
        }),
      }).catch(() => {});
    }

    return new Response(
      JSON.stringify({
        ok: true,
        cross_memory_deleted: crossMemCount,
        journal_deleted: journalCount,
        total_deleted: totalDeleted,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (e) {
    console.error("[memory_cleanup]", e);
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
