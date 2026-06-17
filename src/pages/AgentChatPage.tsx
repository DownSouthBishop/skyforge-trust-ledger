import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as _sb } from "@/integrations/supabase/client";
const supabase = _sb as any;
import { Send, ChevronDown, Plus, Trash2, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import ProjectSelector from "@/components/ProjectSelector";
import { AgentVoiceToggle, speakAs } from "@/lib/agent-voice";
import { useVoiceInput, MicButton } from "@/lib/voice-input";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatar_emoji: string;
}

interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface Thread {
  id: string;
  agent_slug: string;
  title: string;
  updated_at: string;
}

const db = supabase as any;

// ── Helpers ────────────────────────────────────────────────────────────────────

const SUPABASE_FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
const CONCISE_DIRECTIVE = "Be extremely concise in your response and changes — minimal explanation, no extra commentary.";

async function streamAgentResponse(
  agentSlug: string,
  messages: Omit<Msg, "id">[],
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token ?? "";

  const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/agent-chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ agent_slug: agentSlug, messages }),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }

  const reader  = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let fullText = "";

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
          fullText += p.delta.text;
          onDelta(fullText);
        }
      } catch { /* */ }
    }
  }

  return fullText;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function AgentChatPage() {
  const { slug } = useParams<{ slug?: string }>();
  const navigate  = useNavigate();
  const { user }  = useAuth();

  const [agents,     setAgents]     = useState<Agent[]>([]);
  const [activeSlug, setActiveSlug] = useState<string>(slug ?? "");
  const [showPicker, setShowPicker] = useState(false);

  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [showAllAgents, setShowAllAgents] = useState(false);

  const [messages,   setMessages]   = useState<Msg[]>([]);
  const [input,      setInput]      = useState("");
  const [streaming,  setStreaming]  = useState(false);
  const [streamText, setStreamText] = useState("");
  const [error,      setError]      = useState<string | null>(null);

  const bottomRef   = useRef<HTMLDivElement>(null);
  const abortRef    = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { recording, toggle: toggleMic } = useVoiceInput(setInput, () => input);

  // Load agents
  useEffect(() => {
    if (!user) return;
    db
      .from("skyforge_agents")
      .select("id,name,slug,role,avatar_emoji")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .order("created_at")
      .then(({ data }: { data: Agent[] | null }) => {
        if (data?.length) {
          setAgents(data);
          if (!activeSlug) setActiveSlug(data[0].slug);
        }
      });
  }, [user]);

  // Sync slug param → state
  useEffect(() => {
    if (slug && slug !== activeSlug) {
      setActiveSlug(slug);
      setActiveThreadId(null);
      setMessages([]);
    }
  }, [slug]);

  // Load threads for active agent
  const loadThreads = useCallback(async () => {
    if (!user || !activeSlug) return;
    let q = db
      .from("agent_chat_threads")
      .select("id,agent_slug,title,updated_at")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false });
    if (!showAllAgents) q = q.eq("agent_slug", activeSlug);
    const { data } = await q;
    setThreads((data ?? []) as Thread[]);
  }, [user, activeSlug, showAllAgents]);

  useEffect(() => { void loadThreads(); }, [loadThreads]);

  // Load messages when thread changes
  useEffect(() => {
    if (!activeThreadId) { setMessages([]); return; }
    db.from("agent_chat_messages")
      .select("id,role,content")
      .eq("thread_id", activeThreadId)
      .order("created_at", { ascending: true })
      .then(({ data }: { data: Msg[] | null }) => {
        setMessages((data ?? []) as Msg[]);
      });
  }, [activeThreadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  const activeAgent = agents.find(a => a.slug === activeSlug);

  const switchAgent = (a: Agent) => {
    setActiveSlug(a.slug);
    setActiveThreadId(null);
    setMessages([]);
    setShowPicker(false);
    navigate(`/agent-chat/${a.slug}`, { replace: true });
  };

  const newThread = () => {
    setActiveThreadId(null);
    setMessages([]);
    setInput("");
    setError(null);
  };

  const openThread = (t: Thread) => {
    setActiveThreadId(t.id);
    setError(null);
    if (t.agent_slug !== activeSlug) {
      setActiveSlug(t.agent_slug);
      navigate(`/agent-chat/${t.agent_slug}`, { replace: true });
    }
  };

  const deleteThread = async (e: React.MouseEvent, t: Thread) => {
    e.stopPropagation();
    await db.from("agent_chat_threads").delete().eq("id", t.id);
    if (activeThreadId === t.id) {
      setActiveThreadId(null);
      setMessages([]);
    }
    void loadThreads();
  };

  const send = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || streaming || !activeSlug || !user) return;

    setError(null);
    setInput("");
    setStreaming(true);
    setStreamText("");

    // Ensure thread exists
    let threadId = activeThreadId;
    if (!threadId) {
      const title = text.slice(0, 60);
      const { data: created, error: cerr } = await db
        .from("agent_chat_threads")
        .insert({ user_id: user.id, agent_slug: activeSlug, title })
        .select("id")
        .single();
      if (cerr || !created) {
        setError("Couldn't start conversation");
        setStreaming(false);
        return;
      }
      threadId = created.id as string;
      setActiveThreadId(threadId);
    }

    const userMsg: Msg = { id: crypto.randomUUID(), role: "user", content: text };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);

    // Persist user message
    await db.from("agent_chat_messages").insert({
      thread_id: threadId,
      user_id: user.id,
      role: "user",
      content: text,
    });

    const apiHistory: Omit<Msg, "id">[] = nextMessages.map((m, i) => ({
      role: m.role,
      content: i === nextMessages.length - 1 && m.role === "user" ? `${m.content}\n\n${CONCISE_DIRECTIVE}` : m.content,
    }));
    abortRef.current = new AbortController();

    try {
      const reply = await streamAgentResponse(
        activeSlug,
        apiHistory,
        setStreamText,
        abortRef.current.signal,
      );

      const assistantMsg: Msg = { id: crypto.randomUUID(), role: "assistant", content: reply || "…" };
      setMessages(prev => [...prev, assistantMsg]);
      setStreamText("");

      // Per-agent voice toggle
      speakAs(activeSlug, assistantMsg.content);


      await db.from("agent_chat_messages").insert({
        thread_id: threadId,
        user_id: user.id,
        role: "assistant",
        content: assistantMsg.content,
      });
      await db.from("agent_chat_threads")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", threadId);
      void loadThreads();

      // Fire-and-forget memory extraction
      void fetch(`${SUPABASE_FUNCTIONS_URL}/agent_remember`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({
          user_id: user.id,
          source_agent: activeSlug,
          user_message: text,
          assistant_message: reply,
          context: "agent_chat",
        }),
      }).catch(() => { /* non-critical */ });
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") { setStreamText(""); return; }
      setError(e instanceof Error ? e.message : "Something went wrong");
      setStreamText("");
    } finally {
      setStreaming(false);
    }
  }, [input, streaming, activeSlug, user, activeThreadId, messages, loadThreads]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  if (!agents.length) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 px-4 text-center">
        <p className="text-2xl">🤖</p>
        <p className="text-sm text-muted-foreground/60">No agents yet.</p>
        <Button size="sm" variant="outline" onClick={() => navigate("/agents")}>
          Create your first agent
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden relative">
      <div className="absolute top-2 right-3 z-20"><ProjectSelector /></div>

      {/* Thread sidebar */}
      <aside className="hidden md:flex flex-col w-64 shrink-0 border-r border-border/30 bg-background/50">
        <div className="p-3 border-b border-border/20 space-y-2">
          <Button
            size="sm"
            variant="outline"
            onClick={newThread}
            className="w-full justify-start gap-2 text-xs"
          >
            <Plus className="h-3.5 w-3.5" />
            New conversation
          </Button>
          <div className="flex rounded-md border border-border/30 overflow-hidden text-[10px]">
            <button
              onClick={() => setShowAllAgents(false)}
              className={`flex-1 py-1.5 transition-colors ${!showAllAgents ? "bg-secondary/30 text-accent" : "text-muted-foreground/60 hover:bg-secondary/10"}`}
            >
              This agent
            </button>
            <button
              onClick={() => setShowAllAgents(true)}
              className={`flex-1 py-1.5 transition-colors ${showAllAgents ? "bg-secondary/30 text-accent" : "text-muted-foreground/60 hover:bg-secondary/10"}`}
            >
              All agents
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-2 min-h-0">
          {threads.length === 0 && (
            <p className="px-4 py-6 text-xs text-muted-foreground/40 text-center">
              No saved conversations yet.
            </p>
          )}
          {threads.map(t => {
            const tAgent = agents.find(a => a.slug === t.agent_slug);
            return (
            <button
              key={t.id}
              onClick={() => openThread(t)}
              className={`group w-full flex items-start gap-2 px-3 py-2 text-left text-xs hover:bg-secondary/20 transition-colors ${
                activeThreadId === t.id ? "bg-secondary/30 text-accent" : "text-foreground/80"
              }`}
            >
              <span className="text-sm shrink-0 mt-0.5">{tAgent?.avatar_emoji ?? "💬"}</span>
              <span className="flex-1 truncate">{t.title}</span>
              <Trash2
                onClick={(e) => deleteThread(e, t)}
                className="h-3.5 w-3.5 opacity-0 group-hover:opacity-60 hover:opacity-100 hover:text-destructive transition-opacity shrink-0"
              />
            </button>
            );
          })}
        </div>
      </aside>

      {/* Main chat column */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">

      {/* Header — agent selector */}
      <div className="h-12 flex items-center px-4 border-b border-border/30 shrink-0 relative gap-2">
        <button
          onClick={() => setShowPicker(v => !v)}
          className="flex items-center gap-2 text-sm font-medium hover:text-primary transition-colors"
        >
          <span>{activeAgent?.avatar_emoji ?? "🤖"}</span>
          <span className="font-display tracking-wider text-primary">
            {activeAgent?.name ?? "Select Agent"}
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground/50" />
        </button>
        {activeAgent && (
          <>
            <span className="ml-1 text-xs text-muted-foreground/40">{activeAgent.role}</span>
            <AgentVoiceToggle slug={activeAgent.slug} />
          </>
        )}
        <div className="ml-auto md:hidden">
          <Button size="sm" variant="ghost" onClick={newThread} className="h-7 text-xs gap-1">
            <Plus className="h-3.5 w-3.5" /> New
          </Button>
        </div>

        {/* Dropdown */}
        {showPicker && (
          <div className="absolute top-12 left-4 z-50 bg-background border border-border/50 rounded-lg shadow-lg min-w-56 py-1">
            {agents.map(a => (
              <button
                key={a.id}
                onClick={() => switchAgent(a)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-secondary/20 transition-colors ${
                  a.slug === activeSlug ? "text-accent" : "text-foreground"
                }`}
              >
                <span>{a.avatar_emoji}</span>
                <div>
                  <div className="font-medium">{a.name}</div>
                  <div className="text-xs text-muted-foreground/50">{a.role}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6 min-h-0">
        {messages.length === 0 && !streaming && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center py-20">
            <p className="text-4xl">{activeAgent?.avatar_emoji ?? "🤖"}</p>
            <div className="space-y-1">
              <p className="text-lg font-display text-primary tracking-wider">{activeAgent?.name}</p>
              <p className="text-sm text-muted-foreground/50 max-w-xs">{activeAgent?.role}</p>
            </div>
          </div>
        )}

        {messages.map(m => (
          <div key={m.id} className={`flex gap-3 max-w-3xl ${m.role === "user" ? "ml-auto flex-row-reverse" : ""}`}>
            {m.role === "assistant" && (
              <div className="w-7 h-7 rounded-full bg-secondary/30 flex items-center justify-center text-sm shrink-0 mt-0.5">
                {activeAgent?.avatar_emoji ?? "🤖"}
              </div>
            )}
            <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed max-w-[80%] whitespace-pre-wrap ${
              m.role === "user"
                ? "bg-accent/10 text-foreground"
                : "bg-secondary/10 text-foreground/90"
            }`}>
              {m.content}
            </div>
          </div>
        ))}

        {/* Streaming bubble */}
        {streaming && streamText && (
          <div className="flex gap-3 max-w-3xl">
            <div className="w-7 h-7 rounded-full bg-secondary/30 flex items-center justify-center text-sm shrink-0 mt-0.5">
              {activeAgent?.avatar_emoji ?? "🤖"}
            </div>
            <div className="bg-secondary/10 rounded-2xl px-4 py-2.5 text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap max-w-[80%]">
              {streamText}
              <span className="inline-block w-1.5 h-4 bg-accent animate-pulse ml-0.5 align-text-bottom" />
            </div>
          </div>
        )}

        {error && (
          <p className="text-xs text-destructive text-center">{error}</p>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-4 pb-4 pt-2 border-t border-border/20">
        <div className="flex gap-2 items-end max-w-3xl mx-auto">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Message ${activeAgent?.name ?? "agent"}…`}
            rows={1}
            className="resize-none min-h-[44px] max-h-40 bg-secondary/10 border-border/30 text-sm"
            style={{ height: "auto" }}
            onInput={e => {
              const t = e.currentTarget;
              t.style.height = "auto";
              t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
            }}
          />
          <Button
            size="icon"
            onClick={() => void send()}
            disabled={!input.trim() || streaming}
            className="h-11 w-11 shrink-0 bg-accent hover:bg-accent/90"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
      </div>
    </div>
  );
}
