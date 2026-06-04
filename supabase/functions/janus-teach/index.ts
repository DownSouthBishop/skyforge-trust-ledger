// Janus Teacher — Mental Forge Chamber
// Actions:
//   start_lesson   — deliver the next lesson for a subject (streaming)
//   generate_quiz  — create a quiz for the current lesson (JSON)
//   check_answer   — grade one answer + stream explanation (streaming)
//   chat           — freeform chat with Janus about the subject (streaming)

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

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = parseEnv("SUPABASE_URL");
    const SERVICE_KEY  = parseEnv("SUPABASE_SERVICE_ROLE_KEY");
    const API_KEY      = parseEnv("ANTHROPIC_API_KEY");

    const userId = await verifyUser(SUPABASE_URL, SERVICE_KEY, req.headers.get("Authorization"));

    const body = await req.json();
    const { action, subject_id, lesson_id, quiz_id, question_index, user_answer, messages } = body;

    const sbHeaders = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    };

    // ── Load subject ──────────────────────────────────────────────
    const subjectRes = await fetch(
      `${SUPABASE_URL}/rest/v1/forge_subjects?id=eq.${subject_id}&user_id=eq.${userId}&select=*`,
      { headers: sbHeaders },
    );
    const subjects = await subjectRes.json();
    const subject = subjects?.[0];
    if (!subject) {
      return new Response(JSON.stringify({ error: "Subject not found" }), {
        status: 404, headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }

    // ── Load prior lessons for context ────────────────────────────
    const lessonsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/forge_lessons?subject_id=eq.${subject_id}&user_id=eq.${userId}&order=lesson_number.asc&select=lesson_number,title,key_concepts,completed`,
      { headers: sbHeaders },
    );
    const priorLessons: any[] = (await lessonsRes.json()) ?? [];
    const completedLessons = priorLessons.filter((l) => l.completed);

    // ── CROSS-AGENT CONTEXT ────────────────────────────────────────
    const crossMemory = await readCrossMemory(SUPABASE_URL, SERVICE_KEY, userId, 8);

    // ── BUILD CONTEXT BLOCK ───────────────────────────────────────
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
    ]
      .filter(Boolean)
      .join("\n");

    // ─────────────────────────────────────────────────────────────
    // ACTION: start_lesson
    // ─────────────────────────────────────────────────────────────
    if (action === "start_lesson") {
      const lessonNum = subject.current_lesson ?? 1;

      writeCrossMemory(SUPABASE_URL, SERVICE_KEY, userId, "janus",
        `Janus taught Bishop Lesson ${lessonNum} on "${subject.name}".`,
        subject.name,
      );

      const systemPrompt = `${JANUS_TEACHER_IDENTITY}

${contextBlock}

You are now delivering Lesson ${lessonNum}.

Deliver the full lesson. Cover one clear topic appropriate for where the student is in the progression. End the lesson with:
1. A "Key Concepts" summary (name the 2-3 main ideas from this lesson)
2. A single sentence bridging to what the next lesson will cover

Do not generate a quiz in this response. Just teach.`;

      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 2000,
          stream: true,
          system: systemPrompt,
          messages: [{ role: "user", content: `Teach me Lesson ${lessonNum} on ${subject.name}.` }],
        }),
      });

      if (!upstream.ok) {
        const err = await upstream.text();
        return new Response(JSON.stringify({ error: err }), {
          status: upstream.status, headers: { ...corsHeaders, "content-type": "application/json" },
        });
      }

      return new Response(upstream.body, {
        headers: { ...corsHeaders, "content-type": "text/event-stream" },
      });
    }

    // ─────────────────────────────────────────────────────────────
    // ACTION: generate_quiz
    // ─────────────────────────────────────────────────────────────
    if (action === "generate_quiz") {
      // Load the lesson content
      const lessonRes = await fetch(
        `${SUPABASE_URL}/rest/v1/forge_lessons?id=eq.${lesson_id}&user_id=eq.${userId}&select=*`,
        { headers: sbHeaders },
      );
      const lessons = await lessonRes.json();
      const lesson = lessons?.[0];

      const lessonContext = lesson
        ? `Lesson ${lesson.lesson_number}: ${lesson.title ?? subject.name}\n\n${lesson.content}`
        : `Subject: ${subject.name}, Lesson ${subject.current_lesson}`;

      const systemPrompt = `${JANUS_TEACHER_IDENTITY}

${contextBlock}`;

      const userPrompt = `Based on this lesson content, generate a quiz with exactly 5 questions.

LESSON:
${lessonContext}

Return ONLY valid JSON — no prose before or after. Format:
{
  "questions": [
    {
      "question": "<clear question text>",
      "type": "multiple_choice" | "true_false" | "short_answer",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "correct_answer": "<exact text of correct option or short answer>",
      "explanation": "<2-3 sentence explanation of why this is correct and what it teaches>"
    }
  ]
}

Mix question types. Make them test genuine understanding, not memorization. At least one question should require applying the concept to a real scenario.`;

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 2000,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });

      if (!resp.ok) {
        return new Response(JSON.stringify({ error: "Quiz generation failed" }), {
          status: 500, headers: { ...corsHeaders, "content-type": "application/json" },
        });
      }

      const data = await resp.json();
      const raw = data.content?.[0]?.text ?? "{}";
      let quiz: any = { questions: [] };
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) quiz = JSON.parse(match[0]);
      } catch { /* empty quiz */ }

      return new Response(JSON.stringify({ quiz }), {
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }

    // ─────────────────────────────────────────────────────────────
    // ACTION: check_answer — stream Janus's explanation
    // ─────────────────────────────────────────────────────────────
    if (action === "check_answer") {
      const { question_text, correct_answer, is_correct } = body;

      const systemPrompt = `${JANUS_TEACHER_IDENTITY}

${contextBlock}

The student just answered a quiz question.`;

      const userPrompt = is_correct
        ? `The student answered correctly.

Question: ${question_text}
Their answer: ${user_answer}
Correct answer: ${correct_answer}

Confirm they got it right in one sentence. Then briefly deepen their understanding — add one piece of context or nuance about this concept that the question didn't cover. Keep it under 80 words total.`
        : `The student answered incorrectly.

Question: ${question_text}
Their answer: ${user_answer}
Correct answer: ${correct_answer}

Explain clearly why their answer was wrong and why the correct answer is right. Then give a concrete example that makes the correct concept stick. Be direct — don't soften it, but don't shame them. Under 120 words.`;

      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 400,
          stream: true,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });

      if (!upstream.ok) {
        const err = await upstream.text();
        return new Response(JSON.stringify({ error: err }), {
          status: upstream.status, headers: { ...corsHeaders, "content-type": "application/json" },
        });
      }

      return new Response(upstream.body, {
        headers: { ...corsHeaders, "content-type": "text/event-stream" },
      });
    }

    // ─────────────────────────────────────────────────────────────
    // ACTION: chat — freeform Janus conversation about the subject
    // ─────────────────────────────────────────────────────────────
    if (action === "chat") {
      const lastUserMsg = Array.isArray(messages) ? [...messages].reverse().find((m: any) => m.role === "user")?.content ?? "" : "";
      writeCrossMemory(SUPABASE_URL, SERVICE_KEY, userId, "janus",
        `Bishop asked Janus about "${subject.name}": ${String(lastUserMsg).slice(0, 80)}`,
        subject.name,
      );
      const systemPrompt = `${JANUS_TEACHER_IDENTITY}

${contextBlock}

The operator is asking you a question or exploring an idea related to this subject. Answer as a teacher — direct, concrete, with examples. Stay on topic unless they deliberately change it.`;

      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1500,
          stream: true,
          system: systemPrompt,
          messages,
        }),
      });

      if (!upstream.ok) {
        const err = await upstream.text();
        return new Response(JSON.stringify({ error: err }), {
          status: upstream.status, headers: { ...corsHeaders, "content-type": "application/json" },
        });
      }

      return new Response(upstream.body, {
        headers: { ...corsHeaders, "content-type": "text/event-stream" },
      });
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
