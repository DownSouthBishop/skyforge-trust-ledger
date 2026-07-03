// Shared helper so any agent (Atlas, Linda, Janus/agent-chat) can answer a
// question grounded in a user's Notebook sources, without duplicating the
// Gemini inline_data logic notebook-chat itself uses for file sources.

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
  if (source.content_text) return [{ text: `[Source: ${source.title}]\n\n${source.content_text}` }];
  return [];
}

export async function answerFromNotebook(opts: {
  supabaseUrl: string;
  serviceKey: string;
  googleKey: string;
  userId: string;
  notebookTitle?: string;
  question: string;
}): Promise<string> {
  const dbHeaders = { apikey: opts.serviceKey, Authorization: `Bearer ${opts.serviceKey}` };

  const nbUrl = opts.notebookTitle
    ? `${opts.supabaseUrl}/rest/v1/notebooks?user_id=eq.${opts.userId}&title=ilike.*${encodeURIComponent(opts.notebookTitle)}*&limit=1&select=id,title`
    : `${opts.supabaseUrl}/rest/v1/notebooks?user_id=eq.${opts.userId}&order=updated_at.desc&limit=1&select=id,title`;
  const nbRes = await fetch(nbUrl, { headers: dbHeaders });
  const nbRows: Array<{ id: string; title: string }> = nbRes.ok ? await nbRes.json() : [];
  if (!nbRows.length) {
    return opts.notebookTitle ? `No notebook matching "${opts.notebookTitle}" found.` : "The operator has no notebooks yet.";
  }
  const notebook = nbRows[0];

  const sourcesRes = await fetch(
    `${opts.supabaseUrl}/rest/v1/notebook_sources?notebook_id=eq.${notebook.id}&select=title,source_type,storage_path,media_type,content_text`,
    { headers: dbHeaders },
  );
  const sources = sourcesRes.ok ? await sourcesRes.json() : [];
  if (!sources.length) return `Notebook "${notebook.title}" has no sources yet.`;

  if (!opts.googleKey) return "Notebook search is unavailable (no GOOGLE_AI_KEY configured).";

  const parts = (await Promise.all(sources.map((s: any) => sourceToParts(s, opts.supabaseUrl, opts.serviceKey)))).flat();
  const gResp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${opts.googleKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [...parts, { text: opts.question }] }],
        systemInstruction: { parts: [{ text: "Answer using ONLY the attached sources. If the answer isn't in them, say so plainly." }] },
        generationConfig: { maxOutputTokens: 1500 },
      }),
    },
  );
  if (!gResp.ok) return `Notebook search failed (Gemini ${gResp.status}).`;
  const gData = await gResp.json();
  const text = (gData?.candidates?.[0]?.content?.parts ?? [])
    .filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("").trim();
  return `From notebook "${notebook.title}": ${text || "No answer found in the sources."}`;
}
