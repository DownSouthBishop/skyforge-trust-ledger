import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import {
  Plus, X, BookOpen, Loader2, RotateCcw, Send, Award, Flame, MessageSquare,
} from "lucide-react";
import ProjectSelector from "@/components/ProjectSelector";
import { AgentVoiceToggle, speakAs, speakChunked, isAgentVoiceOn } from "@/lib/agent-voice";
import { useVoiceInput, MicButton } from "@/lib/voice-input";

const SUPABASE_URL = "https://hycpzeskartlkybsfkbh.supabase.co";


// ── Teacher definitions ────────────────────────────────────────────
type TeacherKey = "janus" | "atlas" | "linda" | "izzy";

const TEACHERS: Record<TeacherKey, {
  name: string;
  emoji: string;
  role: string;
  tagline: string;
  color: string;
  border: string;
  bg: string;
  subjectPlaceholder: string;
  functionSlug: string;
}> = {
  janus: {
    name: "Janus",
    emoji: "🔮",
    role: "Scholar",
    tagline: "First principles. Pure understanding.",
    color: "#a855f7",
    border: "rgba(168,85,247,0.25)",
    bg: "rgba(168,85,247,0.08)",
    subjectPlaceholder: "e.g. Options Theory, Stoicism, Thermodynamics…",
    functionSlug: "janus-teach",
  },
  atlas: {
    name: "Atlas",
    emoji: "⚡",
    role: "Capital Operator",
    tagline: "Everything through markets and money.",
    color: "#f97316",
    border: "rgba(249,115,22,0.25)",
    bg: "rgba(249,115,22,0.08)",
    subjectPlaceholder: "e.g. Technical Analysis, Risk Management, Macro…",
    functionSlug: "atlas-teach",
  },
  linda: {
    name: "Linda",
    emoji: "👁",
    role: "Chief of Staff",
    tagline: "Business, ops, and how people actually work.",
    color: "#14b8a6",
    border: "rgba(20,184,166,0.25)",
    bg: "rgba(20,184,166,0.08)",
    subjectPlaceholder: "e.g. Persuasion, Marketing, Sales Psychology…",
    functionSlug: "linda-teach",
  },
  izzy: {
    name: "Izzy",
    emoji: "⚙️",
    role: "Chief Technology Intelligence",
    tagline: "Systems, AI, and the machine underneath everything.",
    color: "#38bdf8",
    border: "rgba(56,189,248,0.25)",
    bg: "rgba(56,189,248,0.08)",
    subjectPlaceholder: "e.g. AI Architecture, Embedded Systems, Quantum Computing…",
    functionSlug: "izzy-teach",
  },
};

// ── Types ──────────────────────────────────────────────────────────
interface Subject {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  status: string;
  current_lesson: number;
  lesson_count: number;
  mastery_score: number;
  teacher: TeacherKey;
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

type Mode = "lesson" | "quiz" | "chat";

const FORGE_SESSION_KEY = "forge_session";
function saveForgeSession(teacher: TeacherKey | null, subjectId: string | null) {
  try { sessionStorage.setItem(FORGE_SESSION_KEY, JSON.stringify({ teacher, subjectId })); } catch { /* */ }
}
function loadForgeSession(): { teacher: TeacherKey | null; subjectId: string | null } {
  try { return JSON.parse(sessionStorage.getItem(FORGE_SESSION_KEY) || "{}"); } catch { return { teacher: null, subjectId: null }; }
}

// ── Main page ──────────────────────────────────────────────────────
export default function MentalForgePage() {
  const { user } = useAuth();

  // Teacher selection — restored from sessionStorage on mount
  const [teacher, setTeacher] = useState<TeacherKey | null>(() => loadForgeSession().teacher);

  // Subjects
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [selected, setSelected] = useState<Subject | null>(null);
  const [loadingSubjects, setLoadingSubjects] = useState(false);

  // Add subject form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [adding, setAdding] = useState(false);

  // Lesson
  const [mode, setMode] = useState<Mode>("lesson");
  const [lessonContent, setLessonContent] = useState("");
  const [lessonStreaming, setLessonStreaming] = useState(false);
  const [currentLesson, setCurrentLesson] = useState<Lesson | null>(null);
  const [lessonSaved, setLessonSaved] = useState(false);
  const [lessonLoadingFromDb, setLessonLoadingFromDb] = useState(false);

  // Quiz
  const [quiz, setQuiz] = useState<QuizState | null>(null);
  const [quizLoading, setQuizLoading] = useState(false);
  const [selectedOption, setSelectedOption] = useState("");
  const [shortAnswer, setShortAnswer] = useState("");

  // Chat
  const [chatMessages, setChatMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const { recording: micRec, toggle: toggleMic } = useVoiceInput(setChatInput, () => chatInput);
  const { recording: quizMicRec, toggle: toggleQuizMic } = useVoiceInput(setShortAnswer, () => shortAnswer);
  const [chatStreaming, setChatStreaming] = useState(false);

  const lessonBottomRef = useRef<HTMLDivElement>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lessonStartRef = useRef<number>(0);
  const [reReadCount, setReReadCount] = useState(0);

  // Persist teacher + subject so a page reload drops back to the same context
  useEffect(() => { saveForgeSession(teacher, selected?.id ?? null); }, [teacher, selected?.id]);

  // On mount: if a teacher was saved and we have a user, reload their subjects
  // and restore the previously selected subject from the DB
  useEffect(() => {
    const { teacher: savedTeacher, subjectId: savedSubjectId } = loadForgeSession();
    if (!savedTeacher || !user) return;
    // loadSubjects isn't available yet at this point — call directly
    const doRestore = async () => {
      setLoadingSubjects(true);
      const sb = (await import("@/integrations/supabase/client")).supabase as any;
      const query = sb.from("forge_subjects").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
      const { data } = await (savedTeacher === "janus" ? query.or("teacher.eq.janus,teacher.is.null") : query.eq("teacher", savedTeacher));
      setSubjects(data ?? []);
      setLoadingSubjects(false);
      if (savedSubjectId && data?.length) {
        const match = (data as Subject[]).find(s => s.id === savedSubjectId);
        if (match) {
          setSelected(match);
          // Load the most recent saved lesson for this subject
          setLessonLoadingFromDb(true);
          const { data: existing } = await sb.from("forge_lessons").select("*").eq("subject_id", match.id).order("lesson_number", { ascending: false }).limit(1).single();
          setLessonLoadingFromDb(false);
          if (existing) { setLessonContent(existing.content); setCurrentLesson(existing); setLessonSaved(true); }
        }
      }
    };
    doRestore();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => { lessonBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [lessonContent]);
  useEffect(() => { chatBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages]);

  useEffect(() => {
    if (!quiz || quiz.completed || !teacher) return;
    const q = quiz.questions[quiz.currentIndex];
    if (!q) return;
    const opts = q.options?.length ? " Options: " + q.options.join(". ") + "." : "";
    speakAs(teacher, q.question + opts);
  }, [quiz?.currentIndex, quiz?.completed]);

  useEffect(() => {
    if (!quiz || !teacher) return;
    const ans = quiz.answers[quiz.currentIndex];
    if (ans && !ans.streaming && ans.explanation) {
      speakAs(teacher, ans.explanation);
    }
  }, [JSON.stringify(quiz?.answers[quiz?.currentIndex ?? -1])]);

  const loadSubjects = useCallback(async (t: TeacherKey) => {
    if (!user) return;
    setLoadingSubjects(true);
    try {
      const query = supabase.from("forge_subjects").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
      const { data, error } = await (t === "janus" ? query.or("teacher.eq.janus,teacher.is.null") : query.eq("teacher", t));
      if (error?.message?.includes("teacher")) {
        const { data: all } = await supabase.from("forge_subjects").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
        setSubjects(all ?? []);
      } else {
        setSubjects(data ?? []);
      }
    } catch { setSubjects([]); }
    setLoadingSubjects(false);
  }, [user]);

  const selectTeacher = (t: TeacherKey) => {
    setTeacher(t);
    setSelected(null);
    setLessonContent("");
    setCurrentLesson(null);
    setLessonSaved(false);
    setQuiz(null);
    setChatMessages([]);
    saveForgeSession(t, null);
    loadSubjects(t);
  };

  const addSubject = async () => {
    if (!newName.trim() || !user || !teacher) return;
    setAdding(true);
    await supabase.from("forge_subjects").insert({
      user_id: user.id,
      name: newName.trim(),
      description: newDesc.trim() || null,
      teacher,
      status: "active",
      current_lesson: 1,
      lesson_count: 0,
      mastery_score: 0,
    });
    setNewName("");
    setNewDesc("");
    setShowAddForm(false);
    setAdding(false);
    await loadSubjects(teacher);
  };

  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? "";
  };

  const stream = async (
    slug: string,
    body: Record<string, unknown>,
    onChunk: (t: string) => void,
    onDone: () => void | Promise<void>,
  ) => {
    const token = await getToken();
    abortRef.current = new AbortController();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${slug}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: abortRef.current.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${errText ? ": " + errText.slice(0, 200) : ""}`);
    }
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
          if (p.type === "content_block_delta" && p.delta?.type === "text_delta") onChunk(p.delta.text);
        } catch { /* */ }
      }
    }
    await onDone();
  };

  const startLesson = async (subject: Subject) => {
    if (!teacher) return;
    const t = TEACHERS[teacher];
    setSelected(subject);
    setMode("lesson");
    setLessonContent("");
    setLessonSaved(false);
    setCurrentLesson(null);
    setQuiz(null);
    speakAs(teacher, `Let's get into ${subject.name}.`);
    lessonStartRef.current = Date.now();
    setLessonStreaming(true);

    let full = "";
    try {
      await stream(
        t.functionSlug,
        { action: "start_lesson", subject_id: subject.id, teacher },
        (chunk) => { full += chunk; setLessonContent(full); },
        async () => {
          setLessonStreaming(false);
          const lessonNum = subject.current_lesson ?? 1;
          let savedLesson: Lesson | null = null;
          try {
            const { data: upserted, error: upsertErr } = await supabase.from("forge_lessons").upsert({ user_id: user!.id, subject_id: subject.id, lesson_number: lessonNum, content: full, title: `Lesson ${lessonNum}: ${subject.name}` }, { onConflict: "subject_id,lesson_number" }).select("*").single();
            if (upserted) { savedLesson = upserted; }
            else if (upsertErr) { const { data: existing } = await supabase.from("forge_lessons").select("*").eq("subject_id", subject.id).eq("lesson_number", lessonNum).single(); savedLesson = existing ?? null; }
          } catch { }
          setCurrentLesson(savedLesson ?? ({ id: crypto.randomUUID(), subject_id: subject.id, lesson_number: lessonNum, title: `Lesson ${lessonNum}: ${subject.name}`, content: full, key_concepts: [], completed: false } as Lesson));
          setLessonSaved(true);
          speakChunked(teacher!, full);
        },
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error("[atlas-teach] lesson stream failed:", e);
        setLessonContent(full + `\n\n[Error: ${(e as Error).message}]`);
        setLessonStreaming(false);
      }
    }
  };

  const markLessonComplete = async () => {
    if (!currentLesson || !selected || !teacher) return;
    const T = TEACHERS[teacher];
    await supabase.from("forge_lessons")
      .update({ completed: true, completed_at: new Date().toISOString() })
      .eq("id", currentLesson.id);
    const next = (selected.current_lesson ?? 1) + 1;
    await supabase.from("forge_subjects")
      .update({ current_lesson: next, lesson_count: next - 1 })
      .eq("id", selected.id);
    const updated = { ...selected, current_lesson: next };
    setSelected(updated);
    setSubjects(prev => prev.map(s => s.id === selected.id ? updated : s));
    // Write to cross-agent memory so other agents know what was studied
    supabase.from("agent_cross_memory").insert({
      user_id: user!.id,
      source_agent: T.name.toLowerCase(),
      summary: `Bishop completed Lesson ${selected.current_lesson} on "${selected.name}" with ${T.name}.`,
      topic: selected.name,
    }).then(() => {}).catch(() => {});
  };

  const generateQuiz = async () => {
    if (!selected || !currentLesson || !teacher) return;
    setQuizLoading(true);
    setMode("quiz");
    setQuiz(null);
    const t = TEACHERS[teacher];
    const token = await getToken();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${t.functionSlug}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "generate_quiz", subject_id: selected.id, lesson_id: currentLesson.id, teacher }),
    });
    if (res.ok) {
      const { quiz: q } = await res.json();
      if (q?.questions?.length) {
        const { data: saved } = await supabase.from("forge_quizzes").insert({
          user_id: user!.id,
          subject_id: selected.id,
          lesson_id: currentLesson.id,
          quiz_type: "lesson_check",
          questions: q.questions,
        }).select("id").single();
        setQuiz({ id: saved?.id ?? crypto.randomUUID(), questions: q.questions, currentIndex: 0, answers: {}, completed: false, score: 0 });
      }
    }
    setQuizLoading(false);
  };

  const submitAnswer = async (answer: string) => {
    if (!quiz || !selected || !teacher) return;
    const q = quiz.questions[quiz.currentIndex];
    const isCorrect = answer.trim().toLowerCase() === q.correct_answer.trim().toLowerCase();
    const idx = quiz.currentIndex;
    const t = TEACHERS[teacher];

    setQuiz(prev => prev ? { ...prev, answers: { ...prev.answers, [idx]: { answer, is_correct: isCorrect, explanation: "", streaming: true } } } : prev);

    let explanation = "";
    try {
      await stream(
        t.functionSlug,
        { action: "check_answer", subject_id: selected.id, question_text: q.question, user_answer: answer, correct_answer: q.correct_answer, is_correct: isCorrect, teacher },
        (chunk) => {
          explanation += chunk;
          setQuiz(prev => prev ? { ...prev, answers: { ...prev.answers, [idx]: { answer, is_correct: isCorrect, explanation, streaming: true } } } : prev);
        },
        async () => {
          setQuiz(prev => prev ? { ...prev, answers: { ...prev.answers, [idx]: { answer, is_correct: isCorrect, explanation, streaming: false } } } : prev);
          await supabase.from("forge_quiz_responses").insert({
            user_id: user!.id,
            quiz_id: quiz.id,
            question_index: idx,
            question_text: q.question,
            user_answer: answer,
            correct_answer: q.correct_answer,
            is_correct: isCorrect,
            janus_explanation: explanation,
          });
        },
      );
    } catch { /* */ }

    setSelectedOption("");
    setShortAnswer("");
  };

  const nextQuestion = () => {
    if (!quiz) return;
    if (quiz.currentIndex + 1 >= quiz.questions.length) {
      const correct = Object.values(quiz.answers).filter(a => a.is_correct).length;
      const score = correct / quiz.questions.length;
      setQuiz({ ...quiz, completed: true, score });
      if (teacher) {
        const verdict = score >= 0.9 ? "Excellent. You own it." : score >= 0.7 ? "Solid. Keep going." : "Re-read the lesson and try again.";
        speakAs(teacher, `You scored ${Math.round(score * 100)} percent. ${verdict}`);
      }
      supabase.from("forge_quizzes").update({ score, passed: score >= 0.7, completed: true, completed_at: new Date().toISOString() }).eq("id", quiz.id);
      const missedTypes = Object.entries(quiz.answers)
        .filter(([, a]) => !a.is_correct)
        .map(([i]) => quiz.questions[parseInt(i)]?.type ?? "unknown");
      const durationMin = Math.round((Date.now() - lessonStartRef.current) / 60000);
      const summary = `Bishop scored ${Math.round(score * 100)}% on the Lesson ${selected?.current_lesson ?? "?"} quiz for "${selected?.name}". Missed question types: ${missedTypes.length ? missedTypes.join(", ") : "none"}. Session duration: ~${durationMin} min. Re-reads: ${reReadCount}. Voice enabled: ${isAgentVoiceOn(teacher!)}.`;
      supabase.from("agent_cross_memory").insert({
        user_id: user!.id,
        source_agent: teacher,
        summary,
        topic: "learning_style",
      }).then(() => {}).catch(() => {});
      if (score >= 0.7 && selected) {
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
    if (!text || chatStreaming || !selected || !teacher) return;
    const t = TEACHERS[teacher];
    const newMsg = { role: "user" as const, content: text };
    const history = [...chatMessages, newMsg];
    setChatMessages([...history, { role: "assistant", content: "" }]);
    setChatInput("");
    setChatStreaming(true);
    let full = "";
    try {
      await stream(
        t.functionSlug,
        { action: "chat", subject_id: selected.id, messages: history, teacher },
        (chunk) => { full += chunk; setChatMessages([...history, { role: "assistant", content: full }]); },
        () => { setChatStreaming(false); speakAs(teacher, full); },
      );
    } catch { setChatStreaming(false); }
  };

  // ── TEACHER SELECTION SCREEN ───────────────────────────────────
  if (!teacher) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-6">
        <div className="w-full max-w-2xl">
          <div className="text-center mb-12">
            <div className="text-3xl mb-4">🧠</div>
            <h1 className="text-xl font-semibold text-white mb-2">Mental Forge</h1>
            <p className="text-sm text-zinc-500">Choose your teacher. Then choose what you want to master.</p>
          </div>

          <div className="grid gap-4">
            {(Object.entries(TEACHERS) as [TeacherKey, typeof TEACHERS[TeacherKey]][]).map(([key, t]) => (
              <button
                key={key}
                onClick={() => selectTeacher(key)}
                className="w-full text-left rounded-2xl p-6 transition-all hover:scale-[1.01]"
                style={{ background: t.bg, border: `1px solid ${t.border}` }}
              >
                <div className="flex items-center gap-4">
                  <div className="text-4xl shrink-0">{t.emoji}</div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-base font-semibold" style={{ color: t.color }}>{t.name}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${t.color}20`, color: t.color }}>{t.role}</span>
                      <AgentVoiceToggle slug={key} />
                    </div>
                    <div className="text-sm text-zinc-400">{t.tagline}</div>
                  </div>
                  <div className="text-zinc-600 shrink-0">→</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const T = TEACHERS[teacher];

  // ── MAIN CHAMBER ───────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background flex overflow-hidden relative" style={{ height: "100vh" }}>
      <div className="absolute top-2 right-3 z-30"><ProjectSelector /></div>

      {/* ── Left: Subject List ── */}
      <div className="w-72 border-r border-border/30 flex flex-col shrink-0 overflow-hidden">

        {/* Teacher header */}
        <div className="px-5 py-4 border-b border-border/20 shrink-0 flex items-center gap-2">
          <button onClick={() => setTeacher(null)} className="flex items-center gap-3 flex-1 group">
            <div className="text-2xl">{T.emoji}</div>
            <div className="flex-1 text-left">
              <div className="text-sm font-semibold" style={{ color: T.color }}>{T.name}</div>
              <div className="text-[10px] text-zinc-600">{T.role} · tap to switch</div>
            </div>
          </button>
          <AgentVoiceToggle slug={teacher} />
        </div>

        {/* Add subject */}
        <div className="px-4 py-3 border-b border-border/15 shrink-0">
          {!showAddForm ? (
            <button onClick={() => setShowAddForm(true)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs transition-all"
              style={{ background: `${T.color}10`, border: `1px solid ${T.color}25`, color: T.color }}>
              <Plus className="w-3.5 h-3.5" />
              Add Subject
            </button>
          ) : (
            <div className="space-y-2">
              <input
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") addSubject(); if (e.key === "Escape") setShowAddForm(false); }}
                placeholder={T.subjectPlaceholder}
                className="w-full bg-transparent text-xs text-zinc-200 placeholder:text-zinc-700 focus:outline-none border-b border-border/20 pb-1"
              />
              <input
                value={newDesc}
                onChange={e => setNewDesc(e.target.value)}
                placeholder="Why are you learning this? (optional)"
                className="w-full bg-transparent text-xs text-zinc-500 placeholder:text-zinc-700 focus:outline-none"
              />
              <div className="flex gap-2 pt-1">
                <button onClick={addSubject} disabled={adding || !newName.trim()}
                  className="flex-1 py-1.5 rounded-lg text-xs font-medium disabled:opacity-40"
                  style={{ background: `${T.color}20`, color: T.color, border: `1px solid ${T.color}30` }}>
                  {adding ? "Adding…" : "Add"}
                </button>
                <button onClick={() => setShowAddForm(false)}
                  className="px-3 py-1.5 rounded-lg text-xs text-zinc-600 hover:text-zinc-400"
                  style={{ background: "rgba(255,255,255,0.04)" }}>
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Subject list */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
          {loadingSubjects ? (
            <div className="flex items-center justify-center h-16">
              <Loader2 className="w-4 h-4 animate-spin text-zinc-600" />
            </div>
          ) : subjects.length === 0 ? (
            <div className="text-center py-10 px-4">
              <div className="text-zinc-700 text-xs">No subjects yet.</div>
              <div className="text-zinc-700 text-xs mt-1">Add something to study.</div>
            </div>
          ) : subjects.map(s => {
            const isActive = selected?.id === s.id;
            return (
              <button key={s.id} onClick={async () => {
                setSelected(s);
                setMode("lesson");
                setLessonContent("");
                setCurrentLesson(null);
                setLessonSaved(false);
                setQuiz(null);
                setChatMessages([]);
                // Load the most recent saved lesson for this subject
                setLessonLoadingFromDb(true);
                const { data: existing } = await supabase
                  .from("forge_lessons")
                  .select("*")
                  .eq("subject_id", s.id)
                  .order("lesson_number", { ascending: false })
                  .limit(1)
                  .single();
                setLessonLoadingFromDb(false);
                if (existing) {
                  setLessonContent(existing.content);
                  setCurrentLesson(existing);
                  setLessonSaved(true);
                  if (teacher) speakChunked(teacher, existing.content);
                }
              }}
                className="w-full text-left rounded-xl p-3 transition-all"
                style={{
                  background: isActive ? T.bg : "rgba(255,255,255,0.02)",
                  border: `1px solid ${isActive ? T.border : "rgba(255,255,255,0.06)"}`,
                }}>
                <div className="text-xs font-medium text-zinc-200 mb-1.5 truncate">{s.name}</div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1 rounded-full bg-white/8 overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${(s.mastery_score ?? 0) * 100}%`, background: T.color }} />
                  </div>
                  <span className="text-[10px] text-zinc-600 shrink-0">L{s.current_lesson}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Right: Chamber ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center flex-col gap-4 text-center px-8">
            <div className="text-5xl">{T.emoji}</div>
            <div className="text-sm text-zinc-400">{T.name} is ready.</div>
            <div className="text-xs text-zinc-600 max-w-xs">Add a subject and {T.name} will teach you — lesson by lesson, quiz by quiz.</div>
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
                {([
                  { key: "lesson", icon: BookOpen, label: "Lesson" },
                  { key: "quiz", icon: Award, label: "Quiz" },
                  { key: "chat", icon: MessageSquare, label: "Ask" },
                ] as const).map(({ key, icon: Icon, label }) => (
                  <button key={key}
                    onClick={() => {
                      if (key === "quiz" && !quiz) { generateQuiz(); return; }
                      setMode(key);
                    }}
                    disabled={key === "quiz" && !lessonSaved}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all disabled:opacity-30"
                    style={mode === key
                      ? { background: T.bg, color: T.color, border: `1px solid ${T.border}` }
                      : { background: "rgba(255,255,255,0.04)", color: "#71717a", border: "1px solid rgba(255,255,255,0.06)" }}>
                    <Icon className="w-3 h-3" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* ── LESSON ── */}
            {mode === "lesson" && (
              <div className="flex-1 flex flex-col overflow-hidden">
                {lessonLoadingFromDb ? (
                  <div className="flex-1 flex items-center justify-center flex-col gap-3">
                    <Loader2 className="w-4 h-4 animate-spin text-zinc-600" />
                    <div className="text-xs text-zinc-600">Loading your lessons…</div>
                  </div>
                ) : !lessonContent && !lessonStreaming ? (
                  <div className="flex-1 flex items-center justify-center flex-col gap-5">
                    <div className="text-5xl">{T.emoji}</div>
                    <div className="text-sm text-zinc-400">Ready for Lesson {selected.current_lesson}?</div>
                    <button onClick={() => startLesson(selected)}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium"
                      style={{ background: T.bg, color: T.color, border: `1px solid ${T.border}` }}>
                      <Flame className="w-4 h-4" />
                      Begin Lesson {selected.current_lesson}
                    </button>
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto px-8 py-6">
                    <div className="max-w-2xl mx-auto">
                      <div className="flex items-center gap-2 mb-6">
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                          style={{ background: T.bg, color: T.color, border: `1px solid ${T.border}` }}>
                          {T.emoji} Lesson {selected.current_lesson}
                        </span>
                        {lessonStreaming && <Loader2 className="w-3 h-3 text-zinc-600 animate-spin" />}
                      </div>

                      <div className="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap">
                        {lessonContent}
                        {lessonStreaming && (
                          <span className="inline-block w-1.5 h-4 animate-pulse ml-0.5 align-text-bottom rounded-sm"
                            style={{ background: T.color }} />
                        )}
                      </div>

                      {!lessonStreaming && !lessonSaved && lessonContent && (
                        <div className="mt-6 flex items-center gap-3 border-t border-border/20 pt-5">
                          <button onClick={() => { setLessonContent(""); }}
                            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium"
                            style={{ background: T.bg, color: T.color, border: `1px solid ${T.border}` }}>
                            <RotateCcw className="w-4 h-4" />
                            Try Again
                          </button>
                        </div>
                      )}
                      {!lessonStreaming && lessonSaved && (
                        <div className="mt-8 flex items-center gap-3 border-t border-border/20 pt-6">
                          {currentLesson?.completed ? (
                            // Already completed — start the next lesson
                            <button onClick={() => startLesson(selected)}
                              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium"
                              style={{ background: T.bg, color: T.color, border: `1px solid ${T.border}` }}>
                              <Flame className="w-4 h-4" />
                              Start Lesson {selected.current_lesson}
                            </button>
                          ) : (
                            // Fresh lesson — take quiz
                            <button onClick={() => { markLessonComplete(); generateQuiz(); }}
                              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium"
                              style={{ background: T.bg, color: T.color, border: `1px solid ${T.border}` }}>
                              <Award className="w-4 h-4" />
                              Take the Quiz
                            </button>
                          )}
                          <button onClick={() => { setChatMessages([]); setMode("chat"); }}
                            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-zinc-400"
                            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
                            <MessageSquare className="w-4 h-4" />
                            Ask {T.name}
                          </button>
                          <button onClick={() => { setReReadCount(c => c + 1); startLesson(selected); }}
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

            {/* ── QUIZ ── */}
            {mode === "quiz" && (
              <div className="flex-1 flex flex-col overflow-hidden">
                {quizLoading ? (
                  <div className="flex-1 flex items-center justify-center flex-col gap-3">
                    <Loader2 className="w-5 h-5 animate-spin" style={{ color: T.color }} />
                    <div className="text-xs text-zinc-500">{T.name} is writing your quiz…</div>
                  </div>
                ) : !quiz ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-xs text-zinc-600">Finish a lesson first.</div>
                  </div>
                ) : quiz.completed ? (
                  <div className="flex-1 flex items-center justify-center flex-col gap-5 px-8">
                    <div className="text-5xl">{quiz.score >= 0.7 ? T.emoji : "📖"}</div>
                    <div className="text-2xl font-bold" style={{ color: quiz.score >= 0.7 ? "#22c55e" : "#f97316" }}>
                      {Math.round(quiz.score * 100)}%
                    </div>
                    <div className="text-sm text-zinc-400">
                      {quiz.score >= 0.9 ? "Excellent. You own it." : quiz.score >= 0.7 ? "Solid. Keep going." : "Re-read the lesson and try again."}
                    </div>
                    <div className="flex gap-3">
                      <button onClick={() => { setMode("lesson"); startLesson(selected); }}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium"
                        style={{ background: T.bg, color: T.color, border: `1px solid ${T.border}` }}>
                        Next Lesson →
                      </button>
                      <button onClick={generateQuiz}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-zinc-400"
                        style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
                        <RotateCcw className="w-4 h-4" />
                        Retry
                      </button>
                    </div>
                  </div>
                ) : (() => {
                  const q = quiz.questions[quiz.currentIndex];
                  const answered = quiz.answers[quiz.currentIndex];
                  return (
                    <div className="flex-1 overflow-y-auto px-8 py-6">
                      <div className="max-w-xl mx-auto">
                        {/* Progress dots */}
                        <div className="flex items-center justify-between mb-6">
                          <div className="text-xs text-zinc-500">Question {quiz.currentIndex + 1} / {quiz.questions.length}</div>
                          <div className="flex gap-1">
                            {quiz.questions.map((_, i) => (
                              <div key={i} className="w-2 h-2 rounded-full transition-all" style={{
                                background: i < quiz.currentIndex
                                  ? (quiz.answers[i]?.is_correct ? "#22c55e" : "#ef4444")
                                  : i === quiz.currentIndex ? T.color : "rgba(255,255,255,0.1)",
                              }} />
                            ))}
                          </div>
                        </div>

                        <div className="text-sm font-medium text-zinc-100 mb-5 leading-relaxed">{q.question}</div>

                        {/* Multiple choice */}
                        {q.type === "multiple_choice" && (
                          <div className="space-y-2 mb-5">
                            {q.options.map(opt => {
                              let bg = "rgba(255,255,255,0.02)";
                              let border = "rgba(255,255,255,0.08)";
                              let color = "#a1a1aa";
                              if (answered) {
                                if (opt === q.correct_answer) { bg = "rgba(34,197,94,0.08)"; border = "rgba(34,197,94,0.4)"; color = "#86efac"; }
                                else if (opt === answered.answer && !answered.is_correct) { bg = "rgba(239,68,68,0.08)"; border = "rgba(239,68,68,0.4)"; color = "#fca5a5"; }
                              } else if (selectedOption === opt) { bg = T.bg; border = T.border; color = T.color; }
                              return (
                                <button key={opt} disabled={!!answered} onClick={() => setSelectedOption(opt)}
                                  className="w-full text-left px-4 py-3 rounded-xl text-sm transition-all"
                                  style={{ background: bg, border: `1px solid ${border}`, color }}>
                                  {opt}
                                </button>
                              );
                            })}
                          </div>
                        )}

                        {/* True/False */}
                        {q.type === "true_false" && (
                          <div className="flex gap-3 mb-5">
                            {["True", "False"].map(opt => {
                              let bg = "rgba(255,255,255,0.02)";
                              let border = "rgba(255,255,255,0.08)";
                              let color = "#a1a1aa";
                              if (answered) {
                                if (opt === q.correct_answer) { bg = "rgba(34,197,94,0.08)"; border = "rgba(34,197,94,0.4)"; color = "#86efac"; }
                                else if (opt === answered.answer) { bg = "rgba(239,68,68,0.08)"; border = "rgba(239,68,68,0.4)"; color = "#fca5a5"; }
                              } else if (selectedOption === opt) { bg = T.bg; border = T.border; color = T.color; }
                              return (
                                <button key={opt} disabled={!!answered} onClick={() => setSelectedOption(opt)}
                                  className="flex-1 py-3 rounded-xl text-sm font-medium transition-all"
                                  style={{ background: bg, border: `1px solid ${border}`, color }}>
                                  {opt}
                                </button>
                              );
                            })}
                          </div>
                        )}

                        {/* Short answer */}
                        {q.type === "short_answer" && !answered && (
                          <div className="mb-5">
                            <textarea value={shortAnswer} onChange={e => setShortAnswer(e.target.value)}
                              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAnswer(shortAnswer); } }}
                              placeholder="Write your answer…" rows={3}
                              className="w-full resize-none rounded-xl px-4 py-3 text-sm bg-white/5 border border-white/10 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/40 transition-colors" />
                            <div className="mt-2 flex justify-end">
                              <MicButton recording={quizMicRec} onToggle={toggleQuizMic} />
                            </div>
                          </div>
                        )}

                        {/* Explanation */}
                        {answered && (
                          <div className="mb-5 rounded-xl p-4 border" style={{
                            background: answered.is_correct ? "rgba(34,197,94,0.05)" : "rgba(239,68,68,0.05)",
                            borderColor: answered.is_correct ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)",
                          }}>
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-sm">{answered.is_correct ? "✓" : "✗"}</span>
                              <span className="text-xs font-medium" style={{ color: answered.is_correct ? "#22c55e" : "#ef4444" }}>
                                {answered.is_correct ? "Correct" : "Incorrect"}
                              </span>
                              {answered.streaming && <Loader2 className="w-3 h-3 text-zinc-600 animate-spin" />}
                            </div>
                            <div className="text-xs text-zinc-300 leading-relaxed">
                              {answered.explanation}
                              {answered.streaming && <span className="inline-block w-1 h-3 animate-pulse ml-0.5 align-text-bottom" style={{ background: T.color }} />}
                            </div>
                          </div>
                        )}

                        {/* Actions */}
                        {!answered ? (
                          <button
                            onClick={() => submitAnswer(q.type === "short_answer" ? shortAnswer : selectedOption)}
                            disabled={q.type === "short_answer" ? !shortAnswer.trim() : !selectedOption}
                            className="w-full py-2.5 rounded-xl text-sm font-medium disabled:opacity-40 transition-all"
                            style={{ background: T.bg, color: T.color, border: `1px solid ${T.border}` }}>
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
                    </div>
                  );
                })()}
              </div>
            )}

            {/* ── CHAT ── */}
            {mode === "chat" && (
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
                  {chatMessages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-center py-16">
                      <div className="text-4xl mb-4">{T.emoji}</div>
                      <div className="text-sm text-zinc-400">Ask {T.name} anything about {selected.name}.</div>
                    </div>
                  )}
                  {chatMessages.map((m, i) => (
                    <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                      <div className="max-w-[80%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap"
                        style={m.role === "user"
                          ? { background: T.bg, border: `1px solid ${T.border}`, color: "#f1f5f9" }
                          : { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e4e7" }}>
                        {m.content}
                        {m.role === "assistant" && chatStreaming && i === chatMessages.length - 1 && (
                          <span className="inline-block w-1 h-4 animate-pulse ml-0.5 align-text-bottom"
                            style={{ background: T.color }} />
                        )}
                      </div>
                    </div>
                  ))}
                  <div ref={chatBottomRef} />
                </div>

                <div className="px-6 pb-6 shrink-0">
                  <div className="flex gap-2 items-end">
                    <textarea value={chatInput} onChange={e => setChatInput(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendChat(); } }}
                      placeholder={`Ask ${T.name} about ${selected.name}…`} rows={2} disabled={chatStreaming}
                      className="flex-1 resize-none rounded-xl px-4 py-3 text-sm bg-white/5 border border-white/10 text-zinc-200 placeholder:text-zinc-600 focus:outline-none transition-colors"
                      style={{ focusBorderColor: T.color } as any} />
                    <MicButton recording={micRec} onToggle={toggleMic} />
                    <button onClick={() => void sendChat()} disabled={chatStreaming || !chatInput.trim()}
                      className="shrink-0 p-3 rounded-xl transition-all disabled:opacity-40"
                      style={{ background: T.bg, color: T.color, border: `1px solid ${T.border}` }}>
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
