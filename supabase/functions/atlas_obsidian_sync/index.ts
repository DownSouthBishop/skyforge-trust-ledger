// Atlas Obsidian Sync — pushes unsynced research_notes to Obsidian vault
// Phase 3: wire filesystem MCP server pointing at vault path

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";

const VAULT_PATHS: Record<string, string> = {
  morning_brief: "Daily Briefs",
  thesis: "Research/Equities",
  research: "Research",
  weekly_review: "Weekly Reviews",
  trade_log: "Trades",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    const { user_id, note_id } = await req.json();
    if (!user_id) return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: corsHeaders });

    // Fetch unsynced notes (or specific note)
    const filter = note_id
      ? `id=eq.${note_id}`
      : `user_id=eq.${user_id}&synced_to_obsidian=eq.false`;

    const notesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/research_notes?${filter}&select=id,symbol,title,content,note_type,created_at&limit=50`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    const notes = notesRes.ok ? await notesRes.json() : [];

    if (notes.length === 0) {
      return new Response(JSON.stringify({ status: "ok", synced: 0, message: "No notes pending sync." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const synced: string[] = [];

    for (const note of notes) {
      const folder = VAULT_PATHS[note.note_type] ?? "Research";
      const dateStr = note.created_at.split("T")[0];
      const filename = note.symbol
        ? `${note.symbol}_${dateStr}.md`
        : `${dateStr}_${note.note_type}.md`;
      const obsidianPath = `${folder}/${filename}`;

      // TODO Phase 3: write to Obsidian vault via filesystem MCP
      // const vaultPath = parseEnv("OBSIDIAN_VAULT_PATH");
      // const fullPath = `${vaultPath}/${obsidianPath}`;
      // await Deno.writeTextFile(fullPath, `# ${note.title}\n\n${note.content}`);

      // Mark as synced with path
      await fetch(`${SUPABASE_URL}/rest/v1/research_notes?id=eq.${note.id}`, {
        method: "PATCH",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ synced_to_obsidian: true, obsidian_path: obsidianPath }),
      });

      synced.push(obsidianPath);
    }

    return new Response(JSON.stringify({
      status: "ok",
      synced: synced.length,
      paths: synced,
      note: "File write to vault activates in Phase 3 when filesystem MCP is configured.",
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});
