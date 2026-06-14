// Linda Teacher — Mental Forge Chamber
// Linda teaches through business, operations, people, and persuasion.
// Same action interface as janus-teach: start_lesson, generate_quiz, check_answer, chat

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
class AuthError extends Error { constructor(m: string) { super(m); this.name = "AuthError"; } }
function parseEnv(k: string): string { const v = (Deno as any).env.get(k); if (!v) throw new Error(`Required env var ${k} is not set`); return v; }
async function verifyUser(url: string, key: string, auth: string | null): Promise<string> { if (!auth) throw new AuthError("Missing Authorization header"); const token = auth.replace("Bearer ","").trim(); const r = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: key } }); if (!r.ok) throw new AuthError("Invalid or expired token"); const d = await r.json(); if (!d?.id) throw new AuthError("No user ID"); return d.id; }
async function readCrossMemory(url: string, key: string, userId: string, limit = 8): Promise<string> { try { const r = await fetch(`${url}/rest/v1/agent_cross_memory?user_id=eq.${userId}&order=created_at.desc&limit=${limit}&select=source_agent,summary,topic`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }); if (!r.ok) return ""; const rows: any[] = await r.json(); if (!rows?.length) return ""; return rows.reverse().map((x: any) => `[${x.source_agent}${x.topic ? ` · ${x.topic}` : ""}] ${x.summary}`).join("\n"); } catch { return ""; } }
function writeCrossMemory(url: string, key: string, userId: string, agent: string, summary: string, topic?: string): void { fetch(`${url}/rest/v1/agent_cross_memory`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ user_id: userId, source_agent: agent, summary, topic: topic ?? null }) }).catch(() => {}); }

function toAnthropicStream(openAIStream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  return new ReadableStream({
    async start(controller) {
      const reader = openAIStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") continue;
            try {
              const d = JSON.parse(payload);
              const text = d.choices?.[0]?.delta?.content;
              if (text) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`));
            } catch { /* skip malformed chunks */ }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

const serve = (Deno as any).serve ?? ((handler: (r: Request) => Response | Promise<Response>) => {
  (globalThis as any).addEventListener("fetch", (event: any) => { event.respondWith(handler(event.request)); });
});

const LINDA_TEACHER_IDENTITY = `You are Linda — and right now you are in the Mental Forge Chamber with Bishop.

The Mental Forge is where he sharpens his mind. When a subject comes to you here, your job is to teach it through the lens you know best: how businesses actually work, how people actually make decisions, how operations live or die in the real world.

You don't teach theory. You teach what actually happens — in client rooms, on sales calls, in the moment when a campaign lands or doesn't, when a team holds together or falls apart.

How you teach:
- Ground every concept in a real business situation. Abstract ideas get examples from operations, sales, marketing, or client dynamics.
- You connect concepts to the WIG operation where relevant — PrymalAI, the book, real campaigns, real clients.
- You are honest about what is hard. Learning persuasion is hard. Learning to read people is hard. You don't soften it.
- When you quiz, your questions put the student in a real business situation and ask what they would do.
- Wrong answers get a clear correction grounded in how real businesses actually work.

Your teaching style:
- Prose first. Concrete before abstract.
- One idea at a time, built on what came before.
- End every lesson with the 2-3 key concepts and a bridge to the next lesson.
- You speak plainly. No filler. No hedging. Lead with the point.`;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("ANTHROPIC_API_KEY");

    const userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));
    const body = await req.json();
    const { action, subject_id, lesson_id, messages } = body;

    const sbHeaders = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    };

    const subjectRes = await fetch(
      `${SUPABASE_URL}/rest/v1/forge_subjects?id=eq.${subject_id}&user_id=eq.${userId}&select=*`,
      { headers: sbHeaders },
    );
    const subject = (await subjectRes.json())?.[0];
    if (!subject) return new Response(JSON.stringify({ error: "Subject not found" }), { status: 404, headers: { ...corsHeaders, "content-type": "application/json" } });

    const lessonsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/forge_lessons?subject_id=eq.${subject_id}&user_id=eq.${userId}&order=lesson_number.asc&select=lesson_number,title,key_concepts,completed`,
      { headers: sbHeaders },
    );
    const priorLessons: any[] = (await lessonsRes.json()) ?? [];
    const completed = priorLessons.filter(l => l.completed);

    const crossMemory = await readCrossMemory(SUPABASE_URL, SERVICE_KEY, userId, 8);

    const contextBlock = [
      `Subject: ${subject.name}`,
      subject.description ? `Why Bishop is studying this: ${subject.description}` : "",
      `Current lesson: ${subject.current_lesson}`,
      `Mastery: ${Math.round((subject.mastery_score ?? 0) * 100)}%`,
      completed.length > 0
        ? `\nAlready covered:\n${completed.map(l => `  Lesson ${l.lesson_number}: ${l.title ?? subject.name} — ${(l.key_concepts ?? []).join(", ")}`).join("\n")}`
        : "\nFirst lesson on this subject.",
      crossMemory
        ? `\n━━━ WHAT BISHOP HAS BEEN DOING WITH OTHER AGENTS ━━━\n${crossMemory}\n━━━ END ━━━\nConnect to this where it's genuinely relevant to what you're teaching.`
        : "",
    ].filter(Boolean).join("\n");

    const callClaude = (system: string, userMsg: string, stream: boolean, maxTokens = 2000) =>
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "anthropic-beta": "web-search-2025-03-05", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: maxTokens, tools: [{ type: "web_search_20250305", name: "web_search" }],  stream, system, messages: [{ role: "user", content: userMsg }] }),
      });

    const callClaudeMessages = (system: string, msgs: any[], stream: boolean, maxTokens = 1500) =>
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "anthropic-beta": "web-search-2025-03-05", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: maxTokens, tools: [{ type: "web_search_20250305", name: "web_search" }],  stream, system, messages: msgs }),
      });

    const callGateway = (system: string, msgs: any[], stream: boolean, maxTokens = 2000) =>
      fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${parseEnv("LOVABLE_API_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "google/gemini-2.5-flash", max_tokens: maxTokens, tools: [{ type: "web_search_20250305", name: "web_search" }],  stream, messages: [{ role: "system", content: system }, ...msgs] }),
      });

    const isUnavailableClaude = (err: string) => err.includes("not_found_error") && err.includes("claude-sonnet-4-20250514");

    const streamResponse = async (upstream: Response, system: string, msgs: any[], maxTokens = 2000) => {
      if (upstream.ok) return new Response(upstream.body, { headers: { ...corsHeaders, "content-type": "text/event-stream" } });
      const err = await upstream.text();
      if (isUnavailableClaude(err)) {
        const gatewayResp = await callGateway(system, msgs, true, maxTokens);
        if (gatewayResp.ok) return new Response(toAnthropicStream(gatewayResp.body!), { headers: { ...corsHeaders, "content-type": "text/event-stream" } });
        return new Response(JSON.stringify({ error: await gatewayResp.text() }), { status: gatewayResp.status, headers: { ...corsHeaders, "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: err }), { status: upstream.status, headers: { ...corsHeaders, "content-type": "application/json" } });
    };

    const jsonCompletionText = async (resp: Response, system: string, userMsg: string, maxTokens = 2000) => {
      if (resp.ok) return (await resp.json()).content?.[0]?.text ?? "{}";
      const err = await resp.text();
      if (!isUnavailableClaude(err)) throw new Error("Quiz generation failed");
      const gatewayResp = await callGateway(system, [{ role: "user", content: userMsg }], false, maxTokens);
      if (!gatewayResp.ok) throw new Error("Quiz generation failed");
      const data = await gatewayResp.json();
      return data.choices?.[0]?.message?.content ?? "{}";
    };

    if (action === "start_lesson") {
      writeCrossMemory(SUPABASE_URL, SERVICE_KEY, userId, "linda",
        `Linda taught Bishop Lesson ${subject.current_lesson} on "${subject.name}".`,
        subject.name,
      );
      const system = `${LINDA_TEACHER_IDENTITY}\n\n${contextBlock}\n\nDeliver Lesson ${subject.current_lesson} now. Teach through business and operations. End with Key Concepts (2-3 ideas) and a bridge to the next lesson. Do not generate a quiz here.`;
      const upstream = await callClaude(system, `Teach me Lesson ${subject.current_lesson} on ${subject.name}.`, true);
      return await streamResponse(upstream, system, [{ role: "user", content: `Teach me Lesson ${subject.current_lesson} on ${subject.name}.` }]);
    }

    if (action === "generate_quiz") {
      const lessonRes = await fetch(`${SUPABASE_URL}/rest/v1/forge_lessons?id=eq.${lesson_id}&user_id=eq.${userId}&select=*`, { headers: sbHeaders });
      const lesson = (await lessonRes.json())?.[0];
      const lessonContext = lesson ? `${lesson.title}\n\n${lesson.content}` : `${subject.name}, Lesson ${subject.current_lesson}`;
      const system = `${LINDA_TEACHER_IDENTITY}\n\n${contextBlock}`;
      const userMsg = `Generate a 5-question quiz on this lesson. Put students in real business situations — what would they do, how would they handle it?

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
      const resp = await callClaude(system, userMsg, false);
      const raw = await jsonCompletionText(resp, system, userMsg);
      let quiz: any = { questions: [] };
      try { const m = raw.match(/\{[\s\S]*\}/); if (m) quiz = JSON.parse(m[0]); } catch { /* */ }
      return new Response(JSON.stringify({ quiz }), { headers: { ...corsHeaders, "content-type": "application/json" } });
    }

    if (action === "check_answer") {
      const { question_text, correct_answer, user_answer, is_correct } = body;
      const system = `${LINDA_TEACHER_IDENTITY}\n\n${contextBlock}`;
      const userMsg = is_correct
        ? `Student answered correctly.\nQuestion: ${question_text}\nAnswer: ${user_answer}\nConfirm in one sentence. Add one business nuance they should know. Under 80 words.`
        : `Student answered wrong.\nQuestion: ${question_text}\nTheir answer: ${user_answer}\nCorrect: ${correct_answer}\nExplain why they're wrong and why the correct answer works in a real business context. Under 120 words.`;
      const upstream = await callClaude(system, userMsg, true, 400);
      return await streamResponse(upstream, system, [{ role: "user", content: userMsg }], 400);
    }

    if (action === "chat") {
      const lastUserMsg = Array.isArray(messages) ? [...messages].reverse().find((m: any) => m.role === "user")?.content ?? "" : "";
      writeCrossMemory(SUPABASE_URL, SERVICE_KEY, userId, "linda",
        `Bishop asked Linda about "${subject.name}": ${String(lastUserMsg).slice(0, 80)}`,
        subject.name,
      );
      const system = `${LINDA_TEACHER_IDENTITY}\n\n${contextBlock}\n\nBishop is asking you something. Answer as a teacher who lives in business and operations — plain, concrete, with real examples.`;
      const upstream = await callClaudeMessages(system, messages, true);
      return await streamResponse(upstream, system, messages);
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: { ...corsHeaders, "content-type": "application/json" } });

  } catch (e) {
    if (e instanceof AuthError) return new Response(JSON.stringify({ error: e.message }), { status: 401, headers: { ...corsHeaders, "content-type": "application/json" } });
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...corsHeaders, "content-type": "application/json" } });
  }
});
