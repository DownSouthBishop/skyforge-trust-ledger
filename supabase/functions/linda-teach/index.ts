// Linda Teacher — Mental Forge Chamber
// Linda teaches through business, operations, people, and persuasion.
// Same action interface as janus-teach: start_lesson, generate_quiz, check_answer, chat

import { corsHeaders, verifyUser, parseEnv, AuthError } from "../_shared/gateway.ts";

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

    const contextBlock = [
      `Subject: ${subject.name}`,
      subject.description ? `Why Bishop is studying this: ${subject.description}` : "",
      `Current lesson: ${subject.current_lesson}`,
      `Mastery: ${Math.round((subject.mastery_score ?? 0) * 100)}%`,
      completed.length > 0
        ? `\nAlready covered:\n${completed.map(l => `  Lesson ${l.lesson_number}: ${l.title ?? subject.name} — ${(l.key_concepts ?? []).join(", ")}`).join("\n")}`
        : "\nFirst lesson on this subject.",
    ].filter(Boolean).join("\n");

    const callClaude = (system: string, userMsg: string, stream: boolean, maxTokens = 2000) =>
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, stream, system, messages: [{ role: "user", content: userMsg }] }),
      });

    const callClaudeMessages = (system: string, msgs: any[], stream: boolean, maxTokens = 1500) =>
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, stream, system, messages: msgs }),
      });

    if (action === "start_lesson") {
      const system = `${LINDA_TEACHER_IDENTITY}\n\n${contextBlock}\n\nDeliver Lesson ${subject.current_lesson} now. Teach through business and operations. End with Key Concepts (2-3 ideas) and a bridge to the next lesson. Do not generate a quiz here.`;
      const upstream = await callClaude(system, `Teach me Lesson ${subject.current_lesson} on ${subject.name}.`, true);
      if (!upstream.ok) return new Response(JSON.stringify({ error: await upstream.text() }), { status: upstream.status, headers: { ...corsHeaders, "content-type": "application/json" } });
      return new Response(upstream.body, { headers: { ...corsHeaders, "content-type": "text/event-stream" } });
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
      if (!resp.ok) return new Response(JSON.stringify({ error: "Quiz generation failed" }), { status: 500, headers: { ...corsHeaders, "content-type": "application/json" } });
      const raw = (await resp.json()).content?.[0]?.text ?? "{}";
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
      if (!upstream.ok) return new Response(JSON.stringify({ error: await upstream.text() }), { status: upstream.status, headers: { ...corsHeaders, "content-type": "application/json" } });
      return new Response(upstream.body, { headers: { ...corsHeaders, "content-type": "text/event-stream" } });
    }

    if (action === "chat") {
      const system = `${LINDA_TEACHER_IDENTITY}\n\n${contextBlock}\n\nBishop is asking you something. Answer as a teacher who lives in business and operations — plain, concrete, with real examples.`;
      const upstream = await callClaudeMessages(system, messages, true);
      if (!upstream.ok) return new Response(JSON.stringify({ error: await upstream.text() }), { status: upstream.status, headers: { ...corsHeaders, "content-type": "application/json" } });
      return new Response(upstream.body, { headers: { ...corsHeaders, "content-type": "text/event-stream" } });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: { ...corsHeaders, "content-type": "application/json" } });

  } catch (e) {
    if (e instanceof AuthError) return new Response(JSON.stringify({ error: e.message }), { status: 401, headers: { ...corsHeaders, "content-type": "application/json" } });
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...corsHeaders, "content-type": "application/json" } });
  }
});
