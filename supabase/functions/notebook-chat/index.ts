// notebook-chat — chat grounded in a notebook's attached sources.
// Uses Gemini directly (not Anthropic) because file sources are sent as native
// inline_data (PDF/image/etc.) — the same technique atlas-core uses for Atlas's
// video/PDF attachments. Streams back Anthropic-style SSE so the existing
// frontend event parser (content_block_delta / text_delta) works unchanged.

import { corsHeaders, parseEnv, verifyUser, AuthError } from "../_shared/gateway.ts";

function dbHeaders(key: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}
async function dbGet(url: string, key: string): Promise<any[]> {
  try { const r = await fetch(url, { headers: dbHeaders(key) }); return r.ok ? await r.json() : []; } catch { return []; }
}

function sseText(message: string): Response {
  const encoder = new TextEncoder();
  const safe = message.trim() || "Notebook is temporarily unavailable.";
  const events = [
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: safe } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(encoder.encode(events), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

async function sourceToParts(
  source: { title: string; source_type: string; storage_path: string | null; media_type: string | null; content_text: string | null },
  supabaseUrl: string,
  serviceKey: string,
): Promise<GeminiPart[]> {
  if (source.source_type === "file" && source.storage_path) {
    try {
      const r = await fetch(`${supabaseUrl}/storage/v1/object/notebook-sources/${source.storage_path}`, {
        headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
      });
      if (!r.ok) return [{ text: `[Source "${source.title}" could not be loaded]` }];
      const buf = await r.arrayBuffer();
      return [
        { text: `[Source: ${source.title}]` },
        { inline_data: { mime_type: source.media_type ?? "application/octet-stream", data: arrayBufferToBase64(buf) } },
      ];
    } catch {
      return [{ text: `[Source "${source.title}" failed to load]` }];
    }
  }
  if (source.content_text) {
    return [{ text: `[Source: ${source.title}]\n\n${source.content_text}` }];
  }
  return [];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const GOOGLE_KEY = parseEnv("GOOGLE_AI_KEY");

    const userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    const { notebook_id, message } = await req.json() as { notebook_id: string; message: string };
    if (!notebook_id || !message?.trim()) {
      return new Response(JSON.stringify({ error: "notebook_id and message are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Confirm the notebook belongs to this user (RLS also enforces this on every query below).
    const notebooks = await dbGet(
      `${SUPABASE_URL}/rest/v1/notebooks?id=eq.${notebook_id}&user_id=eq.${userId}&select=id&limit=1`,
      SERVICE_KEY,
    );
    if (!notebooks.length) return new Response(JSON.stringify({ error: "Notebook not found" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

    const [sources, history] = await Promise.all([
      dbGet(`${SUPABASE_URL}/rest/v1/notebook_sources?notebook_id=eq.${notebook_id}&order=created_at.asc&select=title,source_type,storage_path,media_type,content_text`, SERVICE_KEY),
      dbGet(`${SUPABASE_URL}/rest/v1/notebook_messages?notebook_id=eq.${notebook_id}&order=created_at.asc&limit=30&select=role,content`, SERVICE_KEY),
    ]);

    // Persist the user's message immediately so it's not lost if the model call fails.
    await fetch(`${SUPABASE_URL}/rest/v1/notebook_messages`, {
      method: "POST",
      headers: { ...dbHeaders(SERVICE_KEY), Prefer: "return=minimal" },
      body: JSON.stringify({ notebook_id, user_id: userId, role: "user", content: message }),
    });

    const sourceParts = (await Promise.all(sources.map((s: any) => sourceToParts(s, SUPABASE_URL, SERVICE_KEY)))).flat();

    const systemInstruction = sources.length
      ? "You are a research assistant. Answer using ONLY the attached sources below. If the answer isn't in them, say so plainly — don't guess. When relevant, mention which source you're drawing from by title."
      : "You are a research assistant, but no sources are attached to this notebook yet. Tell the operator to add a source before asking questions about it.";

    const contents: Array<{ role: string; parts: GeminiPart[] }> = [];
    if (sourceParts.length) contents.push({ role: "user", parts: sourceParts });
    for (const h of history as Array<{ role: string; content: string }>) {
      contents.push({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.content }] });
    }
    contents.push({ role: "user", parts: [{ text: message }] });

    const gResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: systemInstruction }] },
          generationConfig: { maxOutputTokens: 4000 },
        }),
      },
    );

    if (!gResp.ok) {
      const errText = await gResp.text().catch(() => "");
      console.error(`[notebook-chat] Gemini ${gResp.status}:`, errText.slice(0, 400));
      return sseText(`Notebook couldn't reach Gemini (${gResp.status}). Try again shortly.`);
    }

    const gData = await gResp.json();
    const text = (gData?.candidates?.[0]?.content?.parts ?? [])
      .filter((p: any) => !p.thought)
      .map((p: any) => p.text ?? "").join("").trim();
    const finalText = text || "I couldn't find an answer in the attached sources.";

    await fetch(`${SUPABASE_URL}/rest/v1/notebook_messages`, {
      method: "POST",
      headers: { ...dbHeaders(SERVICE_KEY), Prefer: "return=minimal" },
      body: JSON.stringify({ notebook_id, user_id: userId, role: "assistant", content: finalText }),
    });

    return sseText(finalText);
  } catch (e) {
    if (e instanceof AuthError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.error("[notebook-chat]", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
