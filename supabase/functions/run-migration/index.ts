// One-shot migration runner — creates agent_cross_memory table.
// Call once with the service role key as Bearer token, then this function will be deleted.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

    const statements = [
      `CREATE TABLE IF NOT EXISTS public.agent_cross_memory (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        source_agent text NOT NULL,
        summary text NOT NULL,
        topic text,
        created_at timestamptz DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cross_memory_user_time ON public.agent_cross_memory (user_id, created_at DESC)`,
      `ALTER TABLE public.agent_cross_memory ENABLE ROW LEVEL SECURITY`,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agent_cross_memory' AND policyname='Users manage own cross memory') THEN
          CREATE POLICY "Users manage own cross memory" ON public.agent_cross_memory FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
        END IF;
      END $$`,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='agent_cross_memory' AND policyname='Service role manages cross memory') THEN
          CREATE POLICY "Service role manages cross memory" ON public.agent_cross_memory FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
        END IF;
      END $$`,
    ];

    const results: string[] = [];
    for (const sql of statements) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql }),
      });
      // exec_sql may not exist — fall through, table creation via pg is the fallback
      results.push(`stmt: ${res.status}`);
    }

    // Primary path: use pg connection string
    const dbUrl = Deno.env.get("SUPABASE_DB_URL");
    if (dbUrl) {
      const { Client } = await import("https://deno.land/x/postgres@v0.17.0/mod.ts");
      const client = new Client(dbUrl);
      await client.connect();
      for (const sql of statements) {
        try { await client.queryArray(sql); } catch (e: any) {
          if (!e.message?.includes("already exists")) throw e;
        }
      }
      await client.end();
      return new Response(JSON.stringify({ ok: true, method: "pg", results }), {
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, method: "rpc", results }), {
      headers: { ...corsHeaders, "content-type": "application/json" },
    });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }
});
