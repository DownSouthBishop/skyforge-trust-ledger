const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { system_prompt = "", style_notes = [], role = "", voices = [], voice_baseline = "", count = 5 } = await req.json();
    const voiceList = (voices as { name: string; lang: string }[]).map((v, i) => `${i}. ${v.name} (${v.lang})`).join("\n");
    const baselineBlock = voice_baseline ? `\nDESIRED VOICE BASELINE (highest priority — match this timbre, cadence, gender, and energy):\n${voice_baseline}\n` : "";
    const prompt = `You are a forensic voice-casting analyst. Profile this agent and pick the closest matches from the available browser voices.

AGENT ROLE: ${role}
STYLE NOTES: ${(Array.isArray(style_notes) ? style_notes.join("; ") : style_notes)}
SYSTEM PROMPT EXCERPT:
${(system_prompt as string).slice(0, 600)}
${baselineBlock}
AVAILABLE BROWSER VOICES:
${voiceList}

Pick the ${count} best matches. If a voice baseline is provided, gender and timbre of the baseline are mandatory — never recommend a voice of the wrong gender. Return ONLY a JSON array: [{"index": number, "name": string, "reason": string}]`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
    });
    if (!resp.ok) return new Response(JSON.stringify({ error: await resp.text() }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
    const data = await resp.json();
    const text: string = data?.content?.[0]?.text ?? "[]";
    const m = text.match(/\[[\s\S]*\]/);
    const recs = m ? JSON.parse(m[0]) : [];
    return new Response(JSON.stringify({ recommendations: recs }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
