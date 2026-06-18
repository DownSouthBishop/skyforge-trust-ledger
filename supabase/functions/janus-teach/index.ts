// Janus Teacher — Mental Forge Chamber
// Uses Lovable AI Gateway (google/gemini-2.5-flash) for reliable model access.

import {
  corsHeaders,
  verifyUser,
  parseEnv,
  AuthError,
  readCrossMemory,
  writeCrossMemory,
} from "../_shared/gateway.ts";

const serve = (Deno as any).serve ?? ((handler: (r: Request) => Response | Promise<Response>) => {
  (globalThis as any).addEventListener("fetch", (event: any) => {
    event.respondWith(handler(event.request));
  });
});

const JANUS_TEACHER_IDENTITY = `You are Janus — but today you are standing in the Mental Forge Chamber with the operator.

The Mental Forge Chamber is where Bishop sharpens his mind. When a subject is brought to you here, your job is to teach it completely — from first principles to mastery. You are not a summarizer. You are a teacher who believes that understanding something deeply changes how a person operates in the world.

How you teach:
- Every lesson builds on the last. You track where the student is and never repeat ground already covered.
- You make abstract things concrete. Every concept gets an example the operator can touch — from trading, business, real life, or history.
- You are honest when something is hard. You don't soften it. You slow down and explain it from a different angle.
- When you give a quiz, you take it seriously. Wrong answers get real explanations — not dismissals.
- When the operator gets something right, you confirm it cleanly and advance.
- You teach with authority but without arrogance. You know this material. You are not performing knowledge.

Your teaching style:
- Prose explanations first, then structure if complexity demands it
- Real examples before formulas
- One new thing at a time — do not frontload
- At the end of every lesson, name the 2-3 key concepts the operator just learned
- Connect new material to what was already taught

You are not a chatbot being helpful. You are a teacher with a method. Operate accordingly.`;

const GOOGLE_AI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MODEL = "gemini-2.5-flash";

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
            const delta = j.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
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
  const key = Deno.env.get("GOOGLE_AI_KEY") ?? "";
  return fetch(`${GOOGLE_AI_URL}?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });
}

async function callAnthropic(system: string, messages: any[], stream: boolean, maxTokens: number): Promise<Response | null> {
  const key = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!key) return null;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: maxTokens, stream, system, messages }),
    });
    if (resp.ok) return resp;
    if (resp.status !== 402 && resp.status !== 429 && resp.status !== 529) return resp;
    return null;
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
  return j.choices?.[0]?.message?.content ?? "";
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");

    const userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));

    const body = await req.json();
    const { action, subject_id, lesson_id, user_answer, messages } = body;

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
    if (!subject) {
      return new Response(JSON.stringify({ error: "Subject not found" }), {
        status: 404, headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }

    const lessonsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/forge_lessons?subject_id=eq.${subject_id}&user_id=eq.${userId}&order=lesson_number.asc&select=lesson_number,title,key_concepts,completed`,
      { headers: sbHeaders },
    );
    const priorLessons: any[] = (await lessonsRes.json()) ?? [];
    const completedLessons = priorLessons.filter((l) => l.completed);

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
      subject.description ? `Description: ${subject.description}` : "",
      subject.category ? `Category: ${subject.category}` : "",
      `Current lesson: ${subject.current_lesson}`,
      `Mastery score: ${Math.round((subject.mastery_score ?? 0) * 100)}%`,
      completedLessons.length > 0
        ? `\nLessons already taught:\n${completedLessons
            .map((l) => `  Lesson ${l.lesson_number}: ${l.title ?? "(untitled)"} — concepts: ${(l.key_concepts ?? []).join(", ")}`)
            .join("\n")}`
        : "\nThis is the first lesson on this subject.",
      crossMemory
        ? `\n━━━ WHAT BISHOP HAS BEEN DOING WITH OTHER AGENTS ━━━\n${crossMemory}\n━━━ END CROSS-AGENT CONTEXT ━━━\nIf any of this is relevant to the subject being taught, connect it naturally. Don't force it.`
        : "",
      learningStyleBlock,
    ].filter(Boolean).join("\n");

    if (action === "start_lesson") {
      const lessonNum = subject.current_lesson ?? 1;
      writeCrossMemory(SUPABASE_URL, SERVICE_KEY, userId, "janus",
        `Janus taught Bishop Lesson ${lessonNum} on "${subject.name}".`, subject.name);
      const system = `${JANUS_TEACHER_IDENTITY}\n\n${contextBlock}\n\nYou are now delivering Lesson ${lessonNum}. Deliver the full lesson. End with Key Concepts (2-3 ideas) and one sentence bridging to the next lesson. Do not generate a quiz here.`;
      return await streamingResponse(system, `Teach me Lesson ${lessonNum} on ${subject.name}.`, 2000);
    }

    if (action === "generate_quiz") {
      const lessonRes = await fetch(
        `${SUPABASE_URL}/rest/v1/forge_lessons?id=eq.${lesson_id}&user_id=eq.${userId}&select=*`,
        { headers: sbHeaders },
      );
      const lesson = (await lessonRes.json())?.[0];
      const lessonContext = lesson
        ? `Lesson ${lesson.lesson_number}: ${lesson.title ?? subject.name}\n\n${lesson.content}`
        : `Subject: ${subject.name}, Lesson ${subject.current_lesson}`;

      const system = `${JANUS_TEACHER_IDENTITY}\n\n${contextBlock}`;
      const userMsg = `Based on this lesson content, generate a quiz with exactly 5 questions.

LESSON:
${lessonContext}

Return ONLY valid JSON — no prose before or after. Format:
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
}

Mix question types. At least one should require applying the concept to a real scenario.`;

      try {
        const raw = await completionText(system, userMsg, 2000);
        let quiz: any = { questions: [] };
        try { const m = raw.match(/\{[\s\S]*\}/); if (m) quiz = JSON.parse(m[0]); } catch { /* */ }
        return new Response(JSON.stringify({ quiz }), { headers: { ...corsHeaders, "content-type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Quiz generation failed", detail: (e as Error).message }), {
          status: 500, headers: { ...corsHeaders, "content-type": "application/json" },
        });
      }
    }

    if (action === "check_answer") {
      const { question_text, correct_answer, is_correct } = body;
      const system = `${JANUS_TEACHER_IDENTITY}\n\n${contextBlock}\n\nThe student just answered a quiz question.`;
      const userMsg = is_correct
        ? `Student answered correctly.\nQuestion: ${question_text}\nTheir answer: ${user_answer}\nCorrect: ${correct_answer}\nConfirm in one sentence, then add one piece of nuance. Under 80 words.`
        : `Student answered incorrectly.\nQuestion: ${question_text}\nTheir answer: ${user_answer}\nCorrect: ${correct_answer}\nExplain why they're wrong, why the correct answer is right, and give a concrete example. Direct, under 120 words.`;
      return await streamingResponse(system, userMsg, 400);
    }

    if (action === "chat") {
      const lastUserMsg = Array.isArray(messages) ? [...messages].reverse().find((m: any) => m.role === "user")?.content ?? "" : "";
      writeCrossMemory(SUPABASE_URL, SERVICE_KEY, userId, "janus",
        `Bishop asked Janus about "${subject.name}": ${String(lastUserMsg).slice(0, 80)}`, subject.name);
      const system = `${JANUS_TEACHER_IDENTITY}\n\n${contextBlock}\n\nThe operator is asking you a question related to this subject. Answer as a teacher — direct, concrete, with examples. Stay on topic.`;
      return await streamingMessages(system, messages, 1500);
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
      status: 400, headers: { ...corsHeaders, "content-type": "application/json" },
    });

  } catch (e) {
    if (e instanceof AuthError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 401, headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }
});
