import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Send, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

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

// ── Helpers ────────────────────────────────────────────────────────────────────

const SUPABASE_FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

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
  const [messages,   setMessages]   = useState<Msg[]>([]);
  const [apiHistory, setApiHistory] = useState<Omit<Msg, "id">[]>([]);
  const [input,      setInput]      = useState("");
  const [streaming,  setStreaming]  = useState(false);
  const [streamText, setStreamText] = useState("");
  const [error,      setError]      = useState<string | null>(null);

  const bottomRef   = useRef<HTMLDivElement>(null);
  const abortRef    = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load agents
  useEffect(() => {
    if (!user) return;
    supabase
      .from("skyforge_agents")
      .select("id,name,slug,role,avatar_emoji")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .order("created_at")
      .then(({ data }) => {
        if (data?.length) {
          setAgents(data as Agent[]);
          if (!activeSlug) setActiveSlug(data[0].slug);
        }
      });
  }, [user]);

  // Sync slug param → state, reset conversation on agent switch
  useEffect(() => {
    if (slug && slug !== activeSlug) {
      setActiveSlug(slug);
      setMessages([]);
      setApiHistory([]);
    }
  }, [slug]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  const activeAgent = agents.find(a => a.slug === activeSlug);

  const switchAgent = (a: Agent) => {
    setActiveSlug(a.slug);
    setMessages([]);
    setApiHistory([]);
    setShowPicker(false);
    navigate(`/agent-chat/${a.slug}`, { replace: true });
  };

  const send = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || streaming || !activeSlug || !user) return;

    setError(null);
    setInput("");
    setStreaming(true);
    setStreamText("");

    const userMsg: Msg = { id: crypto.randomUUID(), role: "user", content: text };
    setMessages(prev => [...prev, userMsg]);

    const newHistory: Omit<Msg, "id">[] = [...apiHistory, { role: "user", content: text }];
    abortRef.current = new AbortController();

    try {
      const reply = await streamAgentResponse(
        activeSlug,
        newHistory,
        setStreamText,
        abortRef.current.signal,
      );

      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: "assistant", content: reply || "…" }]);
      setApiHistory([...newHistory, { role: "assistant", content: reply }]);
      setStreamText("");
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") { setStreamText(""); return; }
      setError(e instanceof Error ? e.message : "Something went wrong");
      setStreamText("");
    } finally {
      setStreaming(false);
    }
  }, [input, streaming, activeSlug, user, apiHistory]);

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
    <div className="flex flex-col h-full overflow-hidden">

      {/* Header — agent selector */}
      <div className="h-12 flex items-center px-4 border-b border-border/30 shrink-0 relative">
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
          <span className="ml-3 text-xs text-muted-foreground/40">{activeAgent.role}</span>
        )}

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
  );
}
