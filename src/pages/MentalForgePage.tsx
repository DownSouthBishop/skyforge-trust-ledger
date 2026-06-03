import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import {
  Plus, X, BookOpen, Loader2, ChevronRight, CheckCircle2,
  RotateCcw, Send, Brain, Award, Flame, MessageSquare,
} from "lucide-react";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

interface Subject {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  status: string;
  current_lesson: number;
  lesson_count: number;
  mastery_score: number;
  created_at: string;
}

interface Lesson {
  id: string;
  subject_id: string;
  lesson_number: number;
  title: string | null;
  content: string;
  key_concepts: string[];
  completed: boolean;
}

interface QuizQuestion {
  question: string;
  type: "multiple_choice" | "true_false" | "short_answer";
  options: string[];
  correct_answer: string;
  explanation: string;
}

interface QuizState {
  id: string;
  questions: QuizQuestion[];
  currentIndex: number;
  answers: Record<number, { answer: string; is_correct: boolean; explanation: string; streaming: boolean }>;
  completed: boolean;
  score: number;
}

type Mode = "subjects" | "lesson" | "quiz" | "chat" | "review";

const categoryColor: Record<string, string> = {
  trading: "#22c55e",
  finance: "#3b82f6",
  philosophy: "#a855f7",
  history: "#f97316",
  science: "#14b8a6",
  business: "#f59e0b",
  psychology: "#ec4899",
};

export default function MentalForgePage() {
  const { user } = useAuth();

  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [selected, setSelected] = useState<Subject | null>(null);
  const [mode, setMode] = useState<Mode>("subjects");
  const [loading, setLoading] = useState(true);

  // Lesson state
  const [lessonContent, setLessonContent] = useState("");
  const [lessonStreaming, setLessonStreaming] = useState(false);
  const [currentLesson, setCurrentLesson] = useState<Lesson | null>(null);
  const [lessonSaved, setLessonSaved] = useState(false);

  // Quiz state
  const [quiz, setQuiz] = useState<QuizState | null>(null);
  const [quizLoading, setQuizLoading] = useState(false);
  const [selectedOption, setSelectedOption] = useState<string>("");
  const [shortAnswer, setShortAnswer] = useState("");

  // Chat state
  const [chatMessages, setChatMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatStreaming, setChatStreaming] = useState(false);

  // Add subject form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newSubjectName, setNewSubjectName] = useState("");
  const [newSubjectDesc, setNewSubjectDesc] = useState("");
  const [newSubjectCategory, setNewSubjectCategory] = useState("");
  const [addingSubject, setAddingSubject] = useState(false);

  const lessonBottomRef = useRef<HTMLDivElement>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadSubjects = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data } = await supabase
      .from("forge_subjects")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    setSubjects(data ?? []);
    setLoading(false);
  }, [user]);

  useEffect(() => { loadSubjects(); }, [loadSubjects]);
  useEffect(() => { lessonBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [lessonContent]);
  useEffect(() => { chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages]);

  const addSubject = async () => {
    if (!newSubjectName.trim() || !user) return;
    setAddingSubject(true);
    await supabase.from("forge_subjects").insert({
      user_id: user.id,
      name: newSubjectName.trim(),
      description: newSubjectDesc.trim() || null,
      category: newSubjectCategory.trim() || null,
      status: "active",
      current_lesson: 1,
      lesson_count: 0,
      mastery_score: 0,
    });
    setNewSubjectName("");
    setNewSubjectDesc("");
    setNewSubjectCategory("");
    setShowAddForm(false);
    setAddingSubject(false);
    await loadSubjects();
  };

  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? "";
  };

  const streamFromJanus = async (
    body: Record<string, unknown>,
    onChunk: (text: string) => void,
    onDone: () => void,
  ) => {
    const token = await getToken();
    abortRef.current = new AbortController();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/janus-teach`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: abortRef.current.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.startsWith("data: ")) continue;
        const json = line.slice(6).trim();
        if (json === "[DONE]") break;
        try {
          const p = JSON.parse(json);
          if (p.type === "content_block_delta" && p.delta?.type === "text_delta") {
            onChunk(p.delta.text);
          }
        } catch { /* */ }
      }
    }
    onDone();
  };

  const startLesson = async (subject: Subject) => {
    setSelected(subject);
    setMode("lesson");
    setLessonContent("");
    setLessonSaved(false);
    setLessonStreaming(true);
    setCurrentLesson(null);

    let full = "";
    try {
      await streamFromJanus(
        { action: "start_lesson", subject_id: subject.id },
        (text) => { full += text; setLessonContent(full); },
        async () => {
          setLessonStreaming(false);
          // Save lesson to DB
          const lessonNum = subject.current_lesson ?? 1;
          const { data: saved } = await supabase
            .from("forge_lessons")
            .upsert({
              user_id: user!.id,
              subject_id: subject.id,
              lesson_number: lessonNum,
              content: full,
              title: `Lesson ${lessonNum}: ${subject.name}`,
            }, { onConflict: "subject_id,lesson_number" })
            .select("*")
            .single();
          if (saved) setCurrentLesson(saved);
          setLessonSaved(true);
        },
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setLessonContent(full + "\n\n[Error loading lesson]");
        setLessonStreaming(false);
      }
    }
  };

  const markLessonComplete = async () => {
    if (!currentLesson || !selected) return;
    // Mark lesson complete
    await supabase.from("forge_lessons")
      .update({ completed: true, completed_at: new Date().toISOString() })
      .eq("id", currentLesson.id);
    // Advance subject
    const nextLesson = (selected.current_lesson ?? 1) + 1;
    await supabase.from("forge_subjects")
      .update({ current_lesson: nextLesson, lesson_count: nextLesson - 1 })
      .eq("id", selected.id);
    setSelected({ ...selected, current_lesson: nextLesson });
    await loadSubjects();
  };

  const generateQuiz = async () => {
    if (!selected || !currentLesson) return;
    setQuizLoading(true);
    setMode("quiz");
    const token = await getToken();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/janus-teach`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "generate_quiz", subject_id: selected.id, lesson_id: currentLesson.id }),
    });
    if (res.ok) {
      const { quiz: q } = await res.json();
      if (q?.questions?.length) {
        // Save quiz to DB
        const { data: saved } = await supabase.from("forge_quizzes").insert({
          user_id: user!.id,
          subject_id: selected.id,
          lesson_id: currentLesson.id,
          quiz_type: "lesson_check",
          questions: q.questions,
        }).select("id").single();

        setQuiz({
          id: saved?.id ?? crypto.randomUUID(),
          questions: q.questions,
          currentIndex: 0,
          answers: {},
          completed: false,
          score: 0,
        });
      }
    }
    setQuizLoading(false);
  };

  const submitAnswer = async (answer: string) => {
    if (!quiz || !selected) return;
    const q = quiz.questions[quiz.currentIndex];
    const isCorrect = answer.trim().toLowerCase() === q.correct_answer.trim().toLowerCase()
      || answer.trim() === q.correct_answer.trim();

    // Mark as streaming explanation
    setQuiz(prev => prev ? {
      ...prev,
      answers: { ...prev.answers, [prev.currentIndex]: { answer, is_correct: isCorrect, explanation: "", streaming: true } },
    } : prev);

    // Stream explanation from Janus
    let explanation = "";
    try {
      await streamFromJanus(
        {
          action: "check_answer",
          subject_id: selected.id,
          question_text: q.question,
          user_answer: answer,
          correct_answer: q.correct_answer,
          is_correct: isCorrect,
        },
        (text) => {
          explanation += text;
          setQuiz(prev => prev ? {
            ...prev,
            answers: { ...prev.answers, [prev.currentIndex]: { answer, is_correct: isCorrect, explanation, streaming: true } },
          } : prev);
        },
        async () => {
          setQuiz(prev => prev ? {
            ...prev,
            answers: { ...prev.answers, [prev.currentIndex]: { answer, is_correct: isCorrect, explanation, streaming: false } },
          } : prev);
          // Save response
          if (quiz.id) {
            await supabase.from("forge_quiz_responses").insert({
              user_id: user!.id,
              quiz_id: quiz.id,
              question_index: quiz.currentIndex,
              question_text: q.question,
              user_answer: answer,
              correct_answer: q.correct_answer,
              is_correct: isCorrect,
              janus_explanation: explanation,
            });
          }
        },
      );
    } catch { /* skip on abort */ }

    setSelectedOption("");
    setShortAnswer("");
  };

  const nextQuestion = () => {
    if (!quiz) return;
    if (quiz.currentIndex + 1 >= quiz.questions.length) {
      // Quiz complete — calculate score
      const answers = { ...quiz.answers };
      const correct = Object.values(answers).filter(a => a.is_correct).length;
      const score = correct / quiz.questions.length;
      const passed = score >= 0.7;
      setQuiz({ ...quiz, completed: true, score });

      supabase.from("forge_quizzes").update({
        score, passed, completed: true, completed_at: new Date().toISOString(),
      }).eq("id", quiz.id);

      if (passed && selected) {
        const newMastery = Math.min(1, (selected.mastery_score ?? 0) + 0.1);
        supabase.from("forge_subjects").update({ mastery_score: newMastery }).eq("id", selected.id);
        setSelected({ ...selected, mastery_score: newMastery });
      }
    } else {
      setQuiz({ ...quiz, currentIndex: quiz.currentIndex + 1 });
    }
  };

  const sendChat = async () => {
    const text = chatInput.trim();
    if (!text || chatStreaming || !selected || !user) return;
    const newMsg = { role: "user" as const, content: text };
    const history = [...chatMessages, newMsg];
    setChatMessages([...history, { role: "assistant", content: "" }]);
    setChatInput("");
    setChatStreaming(true);

    // Persist user message immediately
    supabase.from("forge_subject_chats").insert({
      user_id: user.id, subject_id: selected.id, role: "user", content: text,
    });

    let full = "";
    try {
      await streamFromJanus(
        { action: "chat", subject_id: selected.id, messages: history },
        (text) => { full += text; setChatMessages([...history, { role: "assistant", content: full }]); },
        () => {
          setChatStreaming(false);
          if (full.trim()) {
            supabase.from("forge_subject_chats").insert({
              user_id: user.id, subject_id: selected.id, role: "assistant", content: full,
            });
          }
        },
      );
    } catch {
      setChatStreaming(false);
    }
  };

  const loadSubjectState = async (s: Subject) => {
    if (!user) return;
    const { data: lessons } = await supabase
      .from("forge_lessons")
      .select("*")
      .eq("user_id", user.id)
      .eq("subject_id", s.id)
      .order("lesson_number", { ascending: false })
      .limit(1);
    const latest = lessons?.[0] ?? null;
    if (latest) {
      setCurrentLesson(latest);
      setLessonContent(latest.content ?? "");
      setLessonSaved(true);
    }
    const { data: msgs } = await supabase
      .from("forge_subject_chats")
      .select("role,content")
      .eq("user_id", user.id)
      .eq("subject_id", s.id)
      .order("created_at", { ascending: true });
    setChatMessages((msgs ?? []) as { role: "user" | "assistant"; content: string }[]);
  };

  const selectSubject = (s: Subject) => {
    setSelected(s);
    setMode("lesson");
    setLessonContent("");
    setCurrentLesson(null);
    setLessonSaved(false);
    setQuiz(null);
    setChatMessages([]);
    loadSubjectState(s);
  };

  // ── RENDER ──────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background flex overflow-hidden" style={{ height: "100vh" }}>

      {/* ── Left: Subject List ── */}
      <div className="w-72 border-r border-border/30 flex flex-col shrink-0 overflow-hidden">
        <div className="px-5 py-5 border-b border-border/20 shrink-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <Brain className="w-4 h-4 text-purple-400" />
              <span className="text-sm font-semibold text-white">Mental Forge</span>
            </div>
            <button onClick={() => setShowAddForm(true)}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-purple-400 hover:text-purple-300 transition-colors"
              style={{ background: "rgba(168,85,247,0.1)", border: "1px solid rgba(168,85,247,0.2)" }}>
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="text-xs text-zinc-600">Janus teaches. You master.</p>
        </div>

        {/* Add subject form */}
        {showAddForm && (
          <div className="mx-4 my-3 p-3 rounded-xl border border-purple-500/20 bg-purple-500/5">
            <input
              autoFocus
              value={newSubjectName}
              onChange={e => setNewSubjectName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") addSubject(); if (e.key === "Escape") setShowAddForm(false); }}
              placeholder="Subject name…"
              className="w-full bg-transparent text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none mb-2"
            />
            <input
              value={newSubjectDesc}
              onChange={e => setNewSubjectDesc(e.target.value)}
              placeholder="Short description (optional)"
              className="w-full bg-transparent text-xs text-zinc-400 placeholder:text-zinc-700 focus:outline-none mb-2"
            />
            <input
              value={newSubjectCategory}
              onChange={e => setNewSubjectCategory(e.target.value)}
              placeholder="Category: trading, finance, philosophy…"
              className="w-full bg-transparent text-xs text-zinc-400 placeholder:text-zinc-700 focus:outline-none mb-3"
            />
            <div className="flex gap-2">
              <button onClick={addSubject} disabled={addingSubject || !newSubjectName.trim()}
                className="flex-1 py-1.5 rounded-lg text-xs font-medium text-purple-300 disabled:opacity-40 transition-all"
                style={{ background: "rgba(168,85,247,0.15)", border: "1px solid rgba(168,85,247,0.25)" }}>
                {addingSubject ? "Adding…" : "Add Subject"}
              </button>
              <button onClick={() => setShowAddForm(false)}
                className="px-2 py-1.5 rounded-lg text-xs text-zinc-500 hover:text-zinc-300"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}

        {/* Subject list */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
          {loading ? (
            <div className="flex items-center justify-center h-20">
              <Loader2 className="w-4 h-4 text-zinc-600 animate-spin" />
            </div>
          ) : subjects.length === 0 ? (
            <div className="text-center py-12 px-4">
              <BookOpen className="w-6 h-6 text-zinc-700 mx-auto mb-3" />
              <div className="text-xs text-zinc-600">No subjects yet.</div>
              <div className="text-xs text-zinc-700 mt-1">Add something to study.</div>
            </div>
          ) : subjects.map(s => {
            const color = categoryColor[s.category ?? ""] ?? "#a855f7";
            const isActive = selected?.id === s.id;
            return (
              <button key={s.id} onClick={() => selectSubject(s)}
                className="w-full text-left rounded-xl p-3 transition-all"
                style={{
                  background: isActive ? "rgba(168,85,247,0.08)" : "rgba(255,255,255,0.02)",
                  border: `1px solid ${isActive ? "rgba(168,85,247,0.25)" : "rgba(255,255,255,0.06)"}`,
                }}>
                <div className="flex items-center gap-2 mb-1.5">
                  <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
                  <span className="text-xs font-medium text-zinc-200 truncate">{s.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(s.mastery_score ?? 0) * 100}%`, background: color }} />
                  </div>
                  <span className="text-[10px] text-zinc-600 shrink-0">L{s.current_lesson}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Right: Main Chamber ── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {!selected ? (
          <div className="flex-1 flex items-center justify-center flex-col gap-4 text-center px-8">
            <div className="text-5xl">🔮</div>
            <div className="text-sm font-medium text-zinc-300">Select a subject to begin.</div>
            <div className="text-xs text-zinc-600 max-w-xs">Janus will teach you systematically — lesson by lesson, quiz by quiz, until you own the material.</div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border/20 shrink-0">
              <div>
                <div className="text-sm font-semibold text-white">{selected.name}</div>
                <div className="text-xs text-zinc-500">
                  Lesson {selected.current_lesson} · {Math.round((selected.mastery_score ?? 0) * 100)}% mastery
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* Mode tabs */}
                {[
                  { key: "lesson", icon: BookOpen, label: "Lesson" },
                  { key: "quiz", icon: Award, label: "Quiz" },
                  { key: "chat", icon: MessageSquare, label: "Ask" },
                ].map(({ key, icon: Icon, label }) => (
                  <button key={key} onClick={() => {
                    if (key === "quiz" && !currentLesson) return;
                    if (key === "quiz" && !quiz) { generateQuiz(); return; }
                    setMode(key as Mode);
                  }}
                    disabled={key === "quiz" && !lessonSaved}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all disabled:opacity-30"
                    style={mode === key
                      ? { background: "rgba(168,85,247,0.15)", color: "#a855f7", border: "1px solid rgba(168,85,247,0.25)" }
                      : { background: "rgba(255,255,255,0.04)", color: "#71717a", border: "1px solid rgba(255,255,255,0.06)" }}>
                    <Icon className="w-3 h-3" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* ── LESSON MODE ── */}
            {mode === "lesson" && (
              <div className="flex-1 flex flex-col overflow-hidden">
                {!lessonContent && !lessonStreaming ? (
                  <div className="flex-1 flex items-center justify-center flex-col gap-5">
                    <div className="text-4xl">🔮</div>
                    <div className="text-sm text-zinc-400">Ready for Lesson {selected.current_lesson}?</div>
                    <button onClick={() => startLesson(selected)}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium text-purple-300"
                      style={{ background: "rgba(168,85,247,0.12)", border: "1px solid rgba(168,85,247,0.2)" }}>
                      <Flame className="w-4 h-4" />
                      Begin Lesson {selected.current_lesson}
                    </button>
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto px-8 py-6">
                    <div className="max-w-2xl mx-auto">
                      {/* Lesson header */}
                      <div className="flex items-center gap-2 mb-6">
                        <div className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                          style={{ background: "rgba(168,85,247,0.1)", color: "#a855f7", border: "1px solid rgba(168,85,247,0.2)" }}>
                          Lesson {selected.current_lesson}
                        </div>
                        {lessonStreaming && <Loader2 className="w-3 h-3 text-zinc-600 animate-spin" />}
                      </div>

                      {/* Lesson content */}
                      <div className="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap font-[inherit]">
                        {lessonContent}
                        {lessonStreaming && <span className="inline-block w-1.5 h-4 bg-purple-400 animate-pulse ml-0.5 align-text-bottom rounded-sm" />}
                      </div>

                      {/* Actions after lesson loads */}
                      {!lessonStreaming && lessonSaved && (
                        <div className="mt-8 flex items-center gap-3 border-t border-border/20 pt-6">
                          <button onClick={() => { markLessonComplete(); generateQuiz(); }}
                            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-purple-300"
                            style={{ background: "rgba(168,85,247,0.12)", border: "1px solid rgba(168,85,247,0.2)" }}>
                            <Award className="w-4 h-4" />
                            Take the Quiz
                          </button>
                          <button onClick={() => { setChatMessages([]); setMode("chat"); }}
                            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-zinc-400"
                            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
                            <MessageSquare className="w-4 h-4" />
                            Ask Janus
                          </button>
                          <button onClick={() => startLesson(selected)}
                            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-zinc-500"
                            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }}>
                            <RotateCcw className="w-4 h-4" />
                            Re-read
                          </button>
                        </div>
                      )}
                      <div ref={lessonBottomRef} />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── QUIZ MODE ── */}
            {mode === "quiz" && (
              <div className="flex-1 flex flex-col overflow-hidden">
                {quizLoading ? (
                  <div className="flex-1 flex items-center justify-center gap-3 flex-col">
                    <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />
                    <div className="text-xs text-zinc-500">Janus is writing your quiz…</div>
                  </div>
                ) : !quiz ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-xs text-zinc-600">No quiz yet — finish a lesson first.</div>
                  </div>
                ) : quiz.completed ? (
                  // Quiz complete screen
                  <div className="flex-1 flex items-center justify-center flex-col gap-5 px-8">
                    <div className="text-5xl">{quiz.score >= 0.7 ? "🔮" : "📖"}</div>
                    <div className="text-lg font-bold" style={{ color: quiz.score >= 0.7 ? "#22c55e" : "#f97316" }}>
                      {Math.round(quiz.score * 100)}%
                    </div>
                    <div className="text-sm text-zinc-400">
                      {quiz.score >= 0.9 ? "Excellent. The material is yours." :
                       quiz.score >= 0.7 ? "Solid. You passed. Keep going." :
                       "Needs work. Re-read the lesson and try again."}
                    </div>
                    <div className="flex gap-3">
                      <button onClick={() => { setMode("lesson"); startLesson(selected); }}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-purple-300"
                        style={{ background: "rgba(168,85,247,0.12)", border: "1px solid rgba(168,85,247,0.2)" }}>
                        <ChevronRight className="w-4 h-4" />
                        Next Lesson
                      </button>
                      <button onClick={() => generateQuiz()}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-zinc-400"
                        style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
                        <RotateCcw className="w-4 h-4" />
                        Retry Quiz
                      </button>
                    </div>
                  </div>
                ) : (
                  // Active quiz
                  <div className="flex-1 overflow-y-auto px-8 py-6">
                    <div className="max-w-xl mx-auto">
                      {/* Progress */}
                      <div className="flex items-center justify-between mb-6">
                        <div className="text-xs text-zinc-500">
                          Question {quiz.currentIndex + 1} of {quiz.questions.length}
                        </div>
                        <div className="flex gap-1">
                          {quiz.questions.map((_, i) => (
                            <div key={i} className="w-2 h-2 rounded-full" style={{
                              background: i < quiz.currentIndex
                                ? (quiz.answers[i]?.is_correct ? "#22c55e" : "#ef4444")
                                : i === quiz.currentIndex
                                  ? "#a855f7"
                                  : "rgba(255,255,255,0.1)",
                            }} />
                          ))}
                        </div>
                      </div>

                      {(() => {
                        const q = quiz.questions[quiz.currentIndex];
                        const answered = quiz.answers[quiz.currentIndex];

                        return (
                          <div>
                            <div className="text-sm font-medium text-zinc-100 mb-5 leading-relaxed">{q.question}</div>

                            {/* Multiple choice */}
                            {q.type === "multiple_choice" && (
                              <div className="space-y-2 mb-5">
                                {q.options.map((opt) => {
                                  let borderColor = "rgba(255,255,255,0.08)";
                                  let bg = "rgba(255,255,255,0.02)";
                                  let textColor = "#a1a1aa";
                                  if (answered) {
                                    if (opt === q.correct_answer) { borderColor = "rgba(34,197,94,0.4)"; bg = "rgba(34,197,94,0.08)"; textColor = "#86efac"; }
                                    else if (opt === answered.answer && !answered.is_correct) { borderColor = "rgba(239,68,68,0.4)"; bg = "rgba(239,68,68,0.08)"; textColor = "#fca5a5"; }
                                  } else if (selectedOption === opt) { borderColor = "rgba(168,85,247,0.4)"; bg = "rgba(168,85,247,0.08)"; textColor = "#d8b4fe"; }
                                  return (
                                    <button key={opt} disabled={!!answered}
                                      onClick={() => setSelectedOption(opt)}
                                      className="w-full text-left px-4 py-3 rounded-xl text-sm transition-all"
                                      style={{ background: bg, border: `1px solid ${borderColor}`, color: textColor }}>
                                      {opt}
                                    </button>
                                  );
                                })}
                              </div>
                            )}

                            {/* True/False */}
                            {q.type === "true_false" && (
                              <div className="flex gap-3 mb-5">
                                {["True", "False"].map((opt) => {
                                  let borderColor = "rgba(255,255,255,0.08)";
                                  let bg = "rgba(255,255,255,0.02)";
                                  let textColor = "#a1a1aa";
                                  if (answered) {
                                    if (opt === q.correct_answer) { borderColor = "rgba(34,197,94,0.4)"; bg = "rgba(34,197,94,0.08)"; textColor = "#86efac"; }
                                    else if (opt === answered.answer) { borderColor = "rgba(239,68,68,0.4)"; bg = "rgba(239,68,68,0.08)"; textColor = "#fca5a5"; }
                                  } else if (selectedOption === opt) { borderColor = "rgba(168,85,247,0.4)"; bg = "rgba(168,85,247,0.08)"; textColor = "#d8b4fe"; }
                                  return (
                                    <button key={opt} disabled={!!answered}
                                      onClick={() => setSelectedOption(opt)}
                                      className="flex-1 py-3 rounded-xl text-sm font-medium transition-all"
                                      style={{ background: bg, border: `1px solid ${borderColor}`, color: textColor }}>
                                      {opt}
                                    </button>
                                  );
                                })}
                              </div>
                            )}

                            {/* Short answer */}
                            {q.type === "short_answer" && !answered && (
                              <div className="mb-5">
                                <textarea
                                  value={shortAnswer}
                                  onChange={e => setShortAnswer(e.target.value)}
                                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAnswer(shortAnswer); } }}
                                  placeholder="Write your answer…"
                                  rows={3}
                                  className="w-full resize-none rounded-xl px-4 py-3 text-sm bg-white/5 border border-white/10 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/40 transition-colors"
                                />
                              </div>
                            )}

                            {/* Janus explanation */}
                            {answered && (
                              <div className="mb-5 rounded-xl p-4 border"
                                style={{
                                  background: answered.is_correct ? "rgba(34,197,94,0.05)" : "rgba(239,68,68,0.05)",
                                  borderColor: answered.is_correct ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)",
                                }}>
                                <div className="flex items-center gap-2 mb-2">
                                  <div className="text-sm">{answered.is_correct ? "✓" : "✗"}</div>
                                  <span className="text-xs font-medium" style={{ color: answered.is_correct ? "#22c55e" : "#ef4444" }}>
                                    {answered.is_correct ? "Correct" : "Incorrect"}
                                  </span>
                                  {answered.streaming && <Loader2 className="w-3 h-3 text-zinc-600 animate-spin" />}
                                </div>
                                <div className="text-xs text-zinc-300 leading-relaxed">
                                  {answered.explanation}
                                  {answered.streaming && <span className="inline-block w-1 h-3 bg-purple-400 animate-pulse ml-0.5 align-text-bottom" />}
                                </div>
                              </div>
                            )}

                            {/* Action buttons */}
                            {!answered ? (
                              <button
                                onClick={() => submitAnswer(q.type === "short_answer" ? shortAnswer : selectedOption)}
                                disabled={q.type === "short_answer" ? !shortAnswer.trim() : !selectedOption}
                                className="w-full py-2.5 rounded-xl text-sm font-medium text-purple-300 disabled:opacity-40 transition-all"
                                style={{ background: "rgba(168,85,247,0.12)", border: "1px solid rgba(168,85,247,0.2)" }}>
                                Submit Answer
                              </button>
                            ) : !answered.streaming ? (
                              <button onClick={nextQuestion}
                                className="w-full py-2.5 rounded-xl text-sm font-medium text-zinc-300 transition-all"
                                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}>
                                {quiz.currentIndex + 1 < quiz.questions.length ? "Next Question →" : "See Results"}
                              </button>
                            ) : null}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── CHAT MODE ── */}
            {mode === "chat" && (
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
                  {chatMessages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-center py-16">
                      <div className="text-4xl mb-4">🔮</div>
                      <div className="text-sm text-zinc-400">Ask Janus anything about {selected.name}.</div>
                      <div className="text-xs text-zinc-600 mt-1">He'll answer like a teacher who expects you to understand it.</div>
                    </div>
                  )}
                  {chatMessages.map((m, i) => (
                    <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[80%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                        m.role === "user"
                          ? "bg-purple-500/15 border border-purple-500/25 text-purple-100"
                          : "bg-white/5 border border-white/10 text-zinc-200"
                      }`}>
                        {m.content}
                        {m.role === "assistant" && chatStreaming && i === chatMessages.length - 1 && (
                          <span className="inline-block w-1 h-4 bg-purple-400 animate-pulse ml-0.5 align-text-bottom" />
                        )}
                      </div>
                    </div>
                  ))}
                  <div ref={chatBottomRef} />
                </div>

                <div className="px-6 pb-6 shrink-0">
                  <div className="flex gap-2 items-end">
                    <textarea
                      value={chatInput}
                      onChange={e => setChatInput(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendChat(); } }}
                      placeholder={`Ask Janus about ${selected.name}…`}
                      rows={2}
                      disabled={chatStreaming}
                      className="flex-1 resize-none rounded-xl px-4 py-3 text-sm bg-white/5 border border-white/10 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/40 transition-colors"
                    />
                    <button onClick={() => void sendChat()} disabled={chatStreaming || !chatInput.trim()}
                      className="shrink-0 p-3 rounded-xl transition-all disabled:opacity-40"
                      style={{ background: "rgba(168,85,247,0.15)", color: "#a855f7", border: "1px solid rgba(168,85,247,0.2)" }}>
                      {chatStreaming ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
