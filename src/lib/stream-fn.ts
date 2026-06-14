// Streams an SSE response from a Lovable Cloud edge function and returns the
// concatenated assistant text. Handles Anthropic-style text_delta events used by
// both forge_chat and agent-chat.
export async function streamFunctionToText(
  fnName: string,
  payload: Record<string, unknown>,
  accessToken: string,
): Promise<string> {
  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
  const base = import.meta.env.VITE_SUPABASE_URL ?? `https://${projectId}.supabase.co`;
  const resp = await fetch(`${base}/functions/v1/${fnName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok || !resp.body) {
    const t = await resp.text().catch(() => "");
    throw new Error(`${fnName} ${resp.status}: ${t.slice(0, 200)}`);
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const ln of lines) {
      if (!ln.startsWith("data:")) continue;
      const data = ln.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const ev = JSON.parse(data);
        const t = ev?.delta?.text ?? ev?.delta?.partial_json ?? ev?.text ?? "";
        if (ev?.type === "content_block_delta" && ev?.delta?.type === "text_delta") {
          out += ev.delta.text ?? "";
        } else if (typeof t === "string" && ev?.type !== "content_block_delta") {
          // tolerate alternate shapes
        }
      } catch { /* ignore */ }
    }
  }
  return out.trim();
}
