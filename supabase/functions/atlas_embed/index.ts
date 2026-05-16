// Atlas Embed — generates and stores pgvector embeddings for research_notes

import { corsHeaders, parseEnv } from "../_shared/gateway.ts";

const EMBED_MODEL = "text-embedding-3-small";
const GATEWAY_BASE = "https://ai.gateway.lovable.dev/v1";

interface ResearchNote {
  id: string;
  content: string;
}

async function getEmbedding(text: string, apiKey: string): Promise<number[]> {
  const input = text.slice(0, 8000);
  try {
    const resp = await fetch(`${GATEWAY_BASE}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBED_MODEL, input }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Embeddings API error ${resp.status}: ${errText}`);
    }
    const data = await resp.json();
    const embedding: number[] = data?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error("Empty or invalid embedding returned");
    }
    return embedding;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[atlas_embed] Embedding call failed, using zero fallback: ${msg}`);
    return new Array(1536).fill(0);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("LOVABLE_API_KEY");

    const { user_id, note_id } = await req.json();
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const baseHeaders = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    };

    let notes: ResearchNote[] = [];

    if (note_id) {
      // Fetch single note
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/research_notes?id=eq.${note_id}&user_id=eq.${user_id}&select=id,content&limit=1`,
        { headers: baseHeaders },
      );
      if (!resp.ok) throw new Error(`Failed to fetch note: ${resp.status}`);
      notes = await resp.json();
    } else {
      // Fetch up to 50 notes with no embedding
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/research_notes?user_id=eq.${user_id}&embedding=is.null&select=id,content&limit=50`,
        { headers: baseHeaders },
      );
      if (!resp.ok) throw new Error(`Failed to fetch notes: ${resp.status}`);
      notes = await resp.json();
    }

    let embedded = 0;
    let failed = 0;

    for (const note of notes) {
      try {
        const embedding = await getEmbedding(note.content, API_KEY);

        const patchResp = await fetch(
          `${SUPABASE_URL}/rest/v1/research_notes?id=eq.${note.id}`,
          {
            method: "PATCH",
            headers: {
              ...baseHeaders,
              "Content-Type": "application/json",
              Prefer: "return=minimal",
            },
            body: JSON.stringify({ embedding }),
          },
        );

        if (!patchResp.ok) {
          const errText = await patchResp.text();
          console.error(`[atlas_embed] PATCH failed for note ${note.id}: ${errText}`);
          failed++;
        } else {
          embedded++;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[atlas_embed] Failed to embed note ${note.id}: ${msg}`);
        failed++;
      }
    }

    return new Response(JSON.stringify({ embedded, failed }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
