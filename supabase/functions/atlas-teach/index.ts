// Atlas Teacher — Mental Forge Chamber
// Uses Lovable AI Gateway (google/gemini-2.5-flash) for reliable model access.

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
class AuthError extends Error { constructor(m: string) { super(m); this.name = "AuthError"; } }
function parseEnv(k: string): string { const v = (Deno as any).env.get(k); if (!v) throw new Error(`Required env var ${k} is not set`); return v; }
async function verifyUser(url: string, key: string, auth: string | null): Promise<string> { if (!auth) throw new AuthError("Missing Authorization header"); const token = auth.replace("Bearer ","").trim(); const r = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: key } }); if (!r.ok) throw new AuthError("Invalid or expired token"); const d = await r.json(); if (!d?.id) throw new AuthError("No user ID"); return d.id; }
async function readCrossMemory(url: string, key: string, userId: string, limit = 8): Promise<string> { try { const r = await fetch(`${url}/rest/v1/agent_cross_memory?user_id=eq.${userId}&order=created_at.desc&limit=${limit}&select=source_agent,summary,topic`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }); if (!r.ok) return ""; const rows: any[] = await r.json(); if (!rows?.length) return ""; return rows.reverse().map((x: any) => `[${x.source_agent}${x.topic ? ` · ${x.topic}` : ""}] ${x.summary}`).join("\n"); } catch { return ""; } }
function writeCrossMemory(url: string, key: string, userId: string, agent: string, summary: string, topic?: string): void { fetch(`${url}/rest/v1/agent_cross_memory`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ user_id: userId, source_agent: agent, summary, topic: topic ?? null }) }).catch(() => {}); }

const serve = (Deno as any).serve ?? ((handler: (r: Request) => Response | Promise<Response>) => {
  (globalThis as any).addEventListener("fetch", (event: any) => { event.respondWith(handler(event.request)); });
});

const ATLAS_TEACHER_IDENTITY = `You are Atlas — and right now you are in the Mental Forge Chamber with Bishop.

The Mental Forge is where he sharpens his mind. When a subject comes to you here, your job is to teach it the way you actually think — through markets, capital, risk, and the way money moves through the world.

You don't teach like a professor. You teach like someone who has lived this material in real positions, real decisions, real losses. Every concept you explain has a market angle. Every abstraction gets grounded in something you can trade, price, or allocate.

How you teach:
- Connect every new concept to something that shows up in markets or financial decision-making
- Use real examples: specific trades, historical events, actual instruments
- If the subject isn't finance, you find the financial dimension of it anyway — risk, incentives, time value, optionality, leverage
- You don't simplify — you clarify. There's a difference.
- When you quiz, your questions test application, not recall. "What would you do with this?" not "What does this mean?"
- Wrong answers get a direct explanation grounded in market reality

Your teaching style:
- Direct. One idea at a time. Real examples before theory.
- You name the key concepts at the end of every lesson.
- You connect each lesson to what came before.
- You speak the way you always speak — no filler, no softening, no performance.`;

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash";

// Convert native Gemini SSE stream to Anthropic-style for frontend compatibility
function toAnthropicStream(upstream: Response): ReadableStream {
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  let started = false;
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (started) controller.enqueue(encoder.encode(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`));
          controller.close();
          return;
        }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const l = line.trim();
          if (!l.startsWith("data:")) continue;
          const data = l.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            const parts = j.candidates?.[0]?.content?.parts ?? [];
            const delta = parts.map((p: any) => p.text ?? "").join("");
            if (delta.length > 0) {
              if (!started) {
                started = true;
                controller.enqueue(encoder.encode(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`));
              }
              const evt = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } };
              controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(evt)}\n\n`));
            }
          } catch { /* skip */ }
        }
        return;
      }
    },
  });
}

async function callGateway(system: string, messages: any[], stream: boolean, maxTokens = 2000): Promise<Response> {
  const key = (Deno as any).env.get("GOOGLE_AI_KEY") ?? "";
  const contents = messages.filter((m: any) => m.role !== "system").map((m: any) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
  }));
  const body: Record<string, unknown> = { contents, generationConfig: { maxOutputTokens: maxTokens } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const endpoint = stream
    ? `${GEMINI_BASE}:streamGenerateContent?alt=sse&key=${key}`
    : `${GEMINI_BASE}:generateContent?key=${key}`;
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callAnthropic(system: string, messages: any[], stream: boolean, maxTokens: number): Promise<Response | null> {
  const key = (Deno as any).env.get("ANTHROPIC_API_KEY") ?? "";
  if (!key) return null;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: maxTokens, stream, system, messages }),
    });
    if (resp.ok) return resp;
    if (resp.status !== 402 && resp.status !== 429 && resp.status !== 529) return resp;
    return null; // credit/rate — fall through to Google
  } catch { return null; }
}

async function streamingResponse(system: string, userMsg: string, maxTokens = 2000): Promise<Response> {
  const msgs = [{ role: "user", content: userMsg }];
  const aResp = await callAnthropic(system, msgs, true, maxTokens);
  if (aResp?.ok) return new Response(aResp.body, { headers: { ...corsHeaders, "content-type": "text/event-stream" } });
  const upstream = await callGateway(system, msgs, true, maxTokens);
  if (!upstream.ok) return new Response(JSON.stringify({ error: await upstream.text() }), { status: upstream.status, headers: { ...corsHeaders, "content-type": "application/json" } });
  return new Response(toAnthropicStream(upstream), { headers: { ...corsHeaders, "content-type": "text/event-stream" } });
}

async function streamingMessages(system: string, messages: any[], maxTokens = 1500): Promise<Response> {
  const aResp = await callAnthropic(system, messages, true, maxTokens);
  if (aResp?.ok) return new Response(aResp.body, { headers: { ...corsHeaders, "content-type": "text/event-stream" } });
  const upstream = await callGateway(system, messages, true, maxTokens);
  if (!upstream.ok) return new Response(JSON.stringify({ error: await upstream.text() }), { status: upstream.status, headers: { ...corsHeaders, "content-type": "application/json" } });
  return new Response(toAnthropicStream(upstream), { headers: { ...corsHeaders, "content-type": "text/event-stream" } });
}

async function completionText(system: string, userMsg: string, maxTokens = 2000): Promise<string> {
  const msgs = [{ role: "user", content: userMsg }];
  const aResp = await callAnthropic(system, msgs, false, maxTokens);
  if (aResp?.ok) { const j = await aResp.json(); return j.content?.[0]?.text ?? ""; }
  const resp = await callGateway(system, msgs, false, maxTokens);
  if (!resp.ok) throw new Error(await resp.text());
  const j = await resp.json();
  return (j?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim();
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    const userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    const body = await req.json();
    const { action, subject_id, lesson_id, messages } = body;

    const sbHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

    const subjectRes = await fetch(`${SUPABASE_URL}/rest/v1/forge_subjects?id=eq.${subject_id}&user_id=eq.${userId}&select=*`, { headers: sbHeaders });
    const subject = (await subjectRes.json())?.[0];
    if (!subject) return new Response(JSON.stringify({ error: "Subject not found" }), { status: 404, headers: { ...corsHeaders, "content-type": "application/json" } });

    const lessonsRes = await fetch(`${SUPABASE_URL}/rest/v1/forge_lessons?subject_id=eq.${subject_id}&user_id=eq.${userId}&order=lesson_number.asc&select=lesson_number,title,key_concepts,completed`, { headers: sbHeaders });
    const priorLessons: any[] = (await lessonsRes.json()) ?? [];
    const completed = priorLessons.filter(l => l.completed);

    const crossMemory = await readCrossMemory(SUPABASE_URL, SERVICE_KEY, userId, 8);

    // Fetch learning style signals
    const lsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/agent_cross_memory?user_id=eq.${userId}&topic=eq.learning_style&order=created_at.desc&limit=5&select=summary,created_at`,
      { headers: sbHeaders },
    );
    const lsRows: Array<{ summary: string }> = lsRes.ok ? await lsRes.json() : [];
    const learningStyleBlock = lsRows.length
      ? `\n━━━ BISHOP'S LEARNING STYLE (from past sessions) ━━━\n${lsRows.map(r => r.summary).join("\n")}\n━━━ END LEARNING STYLE ━━━\nAdapt this lesson's depth, pacing, and question types accordingly.`
      : "";

    const contextBlock = [
      `Subject: ${subject.name}`,
      subject.description ? `Why Bishop is studying this: ${subject.description}` : "",
      `Current lesson: ${subject.current_lesson}`,
      `Mastery: ${Math.round((subject.mastery_score ?? 0) * 100)}%`,
      completed.length > 0
        ? `\nAlready covered:\n${completed.map(l => `  Lesson ${l.lesson_number}: ${l.title ?? subject.name} — ${(l.key_concepts ?? []).join(", ")}`).join("\n")}`
        : "\nFirst lesson on this subject.",
      crossMemory
        ? `\n━━━ WHAT BISHOP HAS BEEN DOING WITH OTHER AGENTS ━━━\n${crossMemory}\n━━━ END ━━━\nConnect to this where it's genuinely relevant to the material.`
        : "",
      learningStyleBlock,
    ].filter(Boolean).join("\n");

    if (action === "start_lesson") {
      writeCrossMemory(SUPABASE_URL, SERVICE_KEY, userId, "atlas", `Atlas taught Bishop Lesson ${subject.current_lesson} on "${subject.name}".`, subject.name);
      const system = `${ATLAS_TEACHER_IDENTITY}\n\n${contextBlock}\n\nDeliver Lesson ${subject.current_lesson} now. Teach through markets and capital. End with Key Concepts (2-3 ideas) and a bridge to the next lesson. Do not generate a quiz here.`;
      return await streamingResponse(system, `Teach me Lesson ${subject.current_lesson} on ${subject.name}.`, 2000);
    }

    if (action === "generate_quiz") {
      const lessonRes = await fetch(`${SUPABASE_URL}/rest/v1/forge_lessons?id=eq.${lesson_id}&user_id=eq.${userId}&select=*`, { headers: sbHeaders });
      const lesson = (await lessonRes.json())?.[0];
      const lessonContext = lesson ? `${lesson.title}\n\n${lesson.content}` : `${subject.name}, Lesson ${subject.current_lesson}`;
      const system = `${ATLAS_TEACHER_IDENTITY}\n\n${contextBlock}`;
      const userMsg = `Generate a 5-question quiz on this lesson. Make questions test application — not just recall. At least 2 questions should put the student in a real market scenario.

LESSON:
${lessonContext}

Return ONLY valid JSON:
{
  "questions": [
    {
      "question": "...",
      "type": "multiple_choice" | "true_false" | "short_answer",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "correct_answer": "...",
      "explanation": "..."
    }
  ]
}`;
      try {
        const raw = await completionText(system, userMsg, 2000);
        let quiz: any = { questions: [] };
        try { const m = raw.match(/\{[\s\S]*\}/); if (m) quiz = JSON.parse(m[0]); } catch { /* */ }
        return new Response(JSON.stringify({ quiz }), { headers: { ...corsHeaders, "content-type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Quiz generation failed", detail: (e as Error).message }), { status: 500, headers: { ...corsHeaders, "content-type": "application/json" } });
      }
    }

    if (action === "check_answer") {
      const { question_text, correct_answer, user_answer, is_correct } = body;
      const system = `${ATLAS_TEACHER_IDENTITY}\n\n${contextBlock}`;
      const userMsg = is_correct
        ? `Student answered correctly.\nQuestion: ${question_text}\nAnswer: ${user_answer}\nConfirm in one sentence. Add one market nuance they should know. Under 80 words.`
        : `Student answered wrong.\nQuestion: ${question_text}\nTheir answer: ${user_answer}\nCorrect: ${correct_answer}\nExplain why they're wrong, why the correct answer is right, and give a real market example. Direct. Under 120 words.`;
      return await streamingResponse(system, userMsg, 400);
    }

    if (action === "chat") {
      const lastUserMsg = Array.isArray(messages) ? [...messages].reverse().find((m: any) => m.role === "user")?.content ?? "" : "";
      writeCrossMemory(SUPABASE_URL, SERVICE_KEY, userId, "atlas", `Bishop asked Atlas about "${subject.name}": ${String(lastUserMsg).slice(0, 80)}`, subject.name);
      const system = `${ATLAS_TEACHER_IDENTITY}\n\n${contextBlock}\n\nBishop is asking you something about this subject. Answer as a teacher who lives in markets — direct, concrete, with real examples.`;
      return await streamingMessages(system, messages, 1500);
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: { ...corsHeaders, "content-type": "application/json" } });

  } catch (e) {
    if (e instanceof AuthError) return new Response(JSON.stringify({ error: e.message }), { status: 401, headers: { ...corsHeaders, "content-type": "application/json" } });
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...corsHeaders, "content-type": "application/json" } });
  }
});
